const { ipcRenderer } = require('electron');
const path = require('path');
const crypto = require('crypto');
const ScriptController = require('./src/controller');
const MoreLoginClient = require('./src/morelogin-client');
const { getRoleOrderFromDialogueText } = require('./src/roundtable-parse');

/** 一次「开始执行」内，所有窗口共享；每条话术全局仅用一次，用尽后中止整批任务 */
function shuffleInPlace(arr) {
  const a = arr;
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function messagePoolFingerprint(poolLines) {
  const unique = [...new Set(poolLines.map((s) => String(s).trim()).filter(Boolean))].sort();
  return crypto.createHash('sha256').update(unique.join('\u0001')).digest('hex').slice(0, 24);
}

function createGlobalMessagePoolSession() {
  const session = {
    _chain: Promise.resolve(),
    pools: {},
    globalUsed: new Set(),
    /**
     * 串行领取下一条未使用话术（跨窗口、跨并发安全）
     */
    claim(poolLines) {
      const unique = [...new Set(poolLines.map((s) => String(s).trim()).filter(Boolean))];
      if (unique.length === 0) {
        session._chain = session._chain.then(() => null);
        return session._chain;
      }
      const fp = messagePoolFingerprint(unique);
      session._chain = session._chain.then(() => {
        if (!session.pools[fp]) {
          session.pools[fp] = {
            remaining: shuffleInPlace([...unique])
          };
        }
        const state = session.pools[fp];
        while (state.remaining.length > 0) {
          const candidate = state.remaining.shift();
          if (!session.globalUsed.has(candidate)) {
            session.globalUsed.add(candidate);
            return candidate;
          }
        }
        return null;
      });
      return session._chain;
    },
    /** 当前指纹下是否已领完（仅在同一会话、同一话术库下有效） */
    isExhausted(poolLines) {
      const unique = [...new Set(poolLines.map((s) => String(s).trim()).filter(Boolean))];
      if (unique.length === 0) return false;
      const fp = messagePoolFingerprint(unique);
      if (!session.pools[fp]) return false;
      return !session.pools[fp].remaining || session.pools[fp].remaining.length === 0;
    }
  };
  return session;
}

let controller = null;
let selectedScripts = new Map(); // key: script.path, value: script object
let scriptInputs = new Map(); // key: script.path, value: runtime input object
let isRunning = false;
let allEnvironments = [];
let selectedEnvironmentIds = new Set();
let executionMode = 'perEnv'; // perEnv: 单窗口执行所有脚本；perScript: 所有窗口先跑脚本1，再脚本2
let loopWaitTimer = null;

// 初始化
async function init() {
  await loadConfig();
  await loadScripts();
}

// 加载配置
async function loadConfig() {
  const config = await ipcRenderer.invoke('get-config');
  document.getElementById('port').value = config.port || 35000;
  document.getElementById('apiId').value = config.apiId || '';
  document.getElementById('apiKey').value = config.apiKey || '';
  document.getElementById('maxConcurrent').value = config.maxConcurrent || 3;
}

// 保存配置（已绑定保存按钮）
async function saveConfig() {
  const config = {
    port: parseInt(document.getElementById('port').value),
    apiId: document.getElementById('apiId').value,
    apiKey: document.getElementById('apiKey').value,
    maxConcurrent: parseInt(document.getElementById('maxConcurrent').value)
  };

  const result = await ipcRenderer.invoke('save-config', config);
  if (result.success) {
    addLog('配置已保存', 'success');
  } else {
    addLog('保存配置失败: ' + result.error, 'error');
  }
}

// 绑定保存按钮事件（若有保存按钮）
window.addEventListener('DOMContentLoaded', () => {
  const saveBtn = document.getElementById('saveBtn');
  if (saveBtn) {
    saveBtn.onclick = () => {
      saveConfig().catch(err => addLog('保存配置失败: ' + err.message, 'error'));
    };
  }

  // 创建/绑定执行模式下拉
  let modeSelect = document.getElementById('executionMode');
  if (!modeSelect) {
    const startBtn = document.getElementById('startBtn');
    const container = document.createElement('div');
    container.style.display = 'flex';
    container.style.alignItems = 'center';
    container.style.gap = '8px';
    container.style.margin = '8px 0';
    container.innerHTML = `
      <label style="font-weight:600; font-size:13px;"></label>
      <select id="executionMode" style="padding:6px 8px; border:1px solid #ccc; border-radius:4px; font-size:13px;">
        <option value="perEnv">单窗口依次执行选中脚本</option>
        <option value="perScript">按脚本轮次执行所有窗口</option>
      </select>
    `;
    if (startBtn && startBtn.parentNode) {
      startBtn.parentNode.insertBefore(container, startBtn);
    } else {
      document.body.prepend(container);
    }
    modeSelect = container.querySelector('#executionMode');
  }
  if (modeSelect) {
    modeSelect.value = executionMode;
    modeSelect.onchange = (e) => setExecutionMode(e.target.value);
  }
});

// 加载脚本列表
async function loadScripts() {
  const scripts = await ipcRenderer.invoke('list-scripts');
  const scriptList = document.getElementById('scriptList');
  scriptList.innerHTML = '';

  if (scripts.length === 0) {
    scriptList.innerHTML = '<li style="padding: 10px; color: #999;">暂无可用脚本<br><small>在scripts目录下创建.js文件</small></li>';
    return;
  }

  scripts.forEach(script => {
    const li = document.createElement('li');
    li.className = 'script-item';
    
    // 转义路径中的特殊字符，确保在 HTML 属性中正确传递
    const escapedPath = script.path.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '&quot;');
    const escapedName = script.name.replace(/'/g, "\\'");
    const escapedDisplayName = (script.displayName || script.name).replace(/'/g, "\\'");
    
    li.innerHTML = `
      <label style="display:flex; align-items:center; gap:8px; cursor:pointer; padding:6px 8px;">
        <input type="checkbox" style="width:16px;height:16px;" onchange="toggleScript('${escapedPath}', '${escapedName}', '${escapedDisplayName}')">
        <div style="display:flex;flex-direction:column;gap:2px;">
          <span style="font-weight:600;">${script.displayName || script.name}</span>
          <span style="font-size:12px;color:#666;">${script.name}</span>
        </div>
      </label>
    `;
    scriptList.appendChild(li);
  });
  
  addLog(`已加载 ${scripts.length} 个脚本`, 'info');
}

// 切换脚本选择
function toggleScript(path, name, displayName) {
  if (selectedScripts.has(path)) {
    selectedScripts.delete(path);
    scriptInputs.delete(path);
  } else {
    selectedScripts.set(path, { path, name, displayName });
    if (!scriptInputs.has(path)) {
      const base = {
        waitSecondsText: '12',
        randomizeLinkOrder: false,
        groupConfigs: [],
        groupConfigText: '',
        roundtableChannelUrl: '',
        roundtableDialogueText: '',
        roundtableSameSpeakerDelaySecRange: '10-30',
        roundtableBetweenSpeakersDelaySecRange: '30-60',
        roundtableReadyTimeoutMin: '15'
      };
      scriptInputs.set(path, base);
    }
  }
  renderScriptParamsForm();
  const count = selectedScripts.size;
  addLog(`已选择脚本数: ${count}`, 'info');
}

function scriptSupportsUrlInput(script) {
  const key = `${script.name || ''} ${script.displayName || ''}`.toLowerCase();
  const pathKey = String(script.path || '').toLowerCase();
  return (
    key.includes('discord') ||
    key.includes('dc') ||
    key.includes('roundtable') ||
    pathKey.includes('discord-roundtable') ||
    key.includes('tg') ||
    key.includes('telegram')
  );
}

function scriptIsRoundtable(script) {
  const n = String(script.name || '').toLowerCase();
  const p = String(script.path || '').toLowerCase();
  return n.includes('roundtable') || p.includes('discord-roundtable');
}

function getFirstRoundtableDialogueText() {
  for (const s of selectedScripts.values()) {
    if (!scriptIsRoundtable(s)) continue;
    const input = scriptInputs.get(s.path) || {};
    return String(input.roundtableDialogueText || '').trim();
  }
  return '';
}

function getEnvironmentExecutionPreviewList() {
  const manualEnvIds = String(document.getElementById('manualEnvIds')?.value || '').trim();
  if (manualEnvIds) {
    const ids = manualEnvIds
      .split('\n')
      .map((id) => id.trim())
      .filter((id) => id.length > 0);
    return ids.map((envId) => {
      const found = allEnvironments.find((env) => String(env.Id || env.id) === envId);
      const envName = found ? (found.envName || found.name || `环境 ${envId}`) : `环境 ${envId}`;
      return { envId: String(envId), envName: String(envName) };
    });
  }
  return allEnvironments
    .filter((env) => selectedEnvironmentIds.has(String(env.Id || env.id || '')))
    .map((env) => ({
      envId: String(env.Id || env.id || ''),
      envName: String(env.envName || env.name || `环境 ${env.Id || env.id || ''}`)
    }));
}

function updateScriptInput(path, key, value) {
  const prev = scriptInputs.get(path) || {};
  scriptInputs.set(path, { ...prev, [key]: value });
}

function normalizeGroupConfigs(input) {
  const list = Array.isArray(input) ? input : [];
  return list.map((g, idx) => ({
    id: g?.id || `g_${Date.now()}_${idx}`,
    urlsText: String(g?.urlsText || ''),
    messagesText: String(g?.messagesText || '')
  }));
}

function buildGroupConfigText(groupConfigs) {
  return normalizeGroupConfigs(groupConfigs)
    .map((g, idx) => `group_${idx + 1}::${g.urlsText}::${g.messagesText}`)
    .join('\n');
}

function ensureGroupConfigs(path) {
  const prev = scriptInputs.get(path) || {};
  const groupConfigs = normalizeGroupConfigs(prev.groupConfigs);
  const next = {
    ...prev,
    groupConfigs,
    groupConfigText: buildGroupConfigText(groupConfigs)
  };
  scriptInputs.set(path, next);
  return next;
}

function addGroupRow(path) {
  const next = ensureGroupConfigs(path);
  next.groupConfigs.push({
    id: `g_${Date.now()}_${Math.floor(Math.random() * 10000)}`,
    urlsText: '',
    messagesText: ''
  });
  next.groupConfigText = buildGroupConfigText(next.groupConfigs);
  scriptInputs.set(path, next);
  renderScriptParamsForm();
}

function removeGroupRow(path, groupId) {
  const next = ensureGroupConfigs(path);
  next.groupConfigs = next.groupConfigs.filter((g) => g.id !== groupId);
  next.groupConfigText = buildGroupConfigText(next.groupConfigs);
  scriptInputs.set(path, next);
  renderScriptParamsForm();
}

function updateGroupRow(path, groupId, field, value) {
  const next = ensureGroupConfigs(path);
  next.groupConfigs = next.groupConfigs.map((g) => {
    if (g.id !== groupId) return g;
    return { ...g, [field]: String(value || '') };
  });
  next.groupConfigText = buildGroupConfigText(next.groupConfigs);
  scriptInputs.set(path, next);
}

function renderScriptParamsForm() {
  const container = document.getElementById('scriptParamsContainer');
  if (!container) return;

  if (selectedScripts.size === 0) {
    container.innerHTML = '<div style="color:#999; font-size:12px;">勾选脚本后，可在这里输入该脚本专属参数</div>';
    return;
  }

  const blocks = Array.from(selectedScripts.values()).map((script, idx) => {
    const input = ensureGroupConfigs(script.path) || {
      waitSecondsText: '12',
      randomizeLinkOrder: false,
      groupConfigs: [],
      groupConfigText: '',
      roundtableChannelUrl: '',
      roundtableDialogueText: '',
      roundtableSameSpeakerDelaySecRange: '10-30',
      roundtableBetweenSpeakersDelaySecRange: '30-60',
      roundtableReadyTimeoutMin: '15'
    };
    const escapedPath = script.path.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '&quot;');
    const title = script.displayName || script.name;

    if (!scriptSupportsUrlInput(script)) {
      return `
        <div style="border:1px solid #e5e5e5; border-radius:6px; background:#fff; padding:10px;">
          <div style="font-weight:600; margin-bottom:6px;">${idx + 1}. ${title}</div>
          <div style="font-size:12px; color:#888;">这个脚本暂不需要频道分组配置，保持默认执行即可。</div>
        </div>
      `;
    }

    if (scriptIsRoundtable(script)) {
      const roleOrderPreview = getRoleOrderFromDialogueText(String(input.roundtableDialogueText || ''));
      const envPreview = getEnvironmentExecutionPreviewList();
      const mappingRows = roleOrderPreview.map((role, i) => {
        const env = envPreview[i];
        if (!env) return `<li>${role} → （待选择环境）</li>`;
        return `<li>${role} → ${env.envName} (${env.envId})</li>`;
      }).join('');
      const mappingHint = roleOrderPreview.length === 0
        ? '先填写剧本后才会生成角色映射预览。'
        : (envPreview.length === roleOrderPreview.length
          ? '映射数量已匹配，可直接启动。'
          : `当前映射数量不匹配：角色 ${roleOrderPreview.length} / 环境 ${envPreview.length}`);
      return `
        <div style="border:1px solid #d9edf7; border-radius:6px; background:#fff; padding:10px;">
          <div style="font-weight:600; margin-bottom:8px;">${idx + 1}. ${title}</div>
          <div style="font-size:12px; color:#666; margin-bottom:8px;">
            需要的环境数 = 剧本里出现的<strong>不同角色</strong>个数（行首单个字母 A–Z + 冒号）。勾选顺序 = 这些字母在剧本里<strong>从上到下首次出现</strong>的顺序。所有窗口进同一频道后<strong>全员就位</strong>才开聊；发完一句再按配置等待后才会推进到下一句（避免下一名抢跑）。
          </div>
          <div style="font-size:12px; color:#666; margin-bottom:4px;">频道链接（各窗口相同）</div>
          <input
            type="text"
            value="${String(input.roundtableChannelUrl || '').replace(/"/g, '&quot;')}"
            placeholder="https://discord.com/channels/服务器ID/频道ID"
            oninput="updateScriptInput('${escapedPath}', 'roundtableChannelUrl', this.value)"
          />
          <div style="font-size:12px; color:#666; margin:10px 0 4px;">剧本（每行以单个字母 + ：开头，如 A：…、F：…，只发送冒号后的内容）</div>
          <textarea
            style="width:100%; min-height:140px; border:1px solid #ddd; border-radius:4px; padding:8px; font-family:monospace; font-size:12px;"
            placeholder="A：第一句&#10;B：第二句"
            oninput="updateScriptInput('${escapedPath}', 'roundtableDialogueText', this.value)"
          >${input.roundtableDialogueText || ''}</textarea>
          <div style="font-size:12px; color:#666; margin:12px 0 4px;">同角色连续两句之间随机等待（秒，如 10-30）</div>
          <input
            type="text"
            style="width:100%; max-width:220px;"
            value="${String(input.roundtableSameSpeakerDelaySecRange || '10-30').replace(/"/g, '&quot;')}"
            placeholder="10-30"
            oninput="updateScriptInput('${escapedPath}', 'roundtableSameSpeakerDelaySecRange', this.value)"
          />
          <div style="font-size:12px; color:#666; margin:10px 0 4px;">换角色（轮到别人下一句）前随机等待（秒，如 30-60）</div>
          <input
            type="text"
            style="width:100%; max-width:220px;"
            value="${String(input.roundtableBetweenSpeakersDelaySecRange || '30-60').replace(/"/g, '&quot;')}"
            placeholder="30-60"
            oninput="updateScriptInput('${escapedPath}', 'roundtableBetweenSpeakersDelaySecRange', this.value)"
          />
          <div style="font-size:12px; color:#666; margin:10px 0 4px;">全员就位超时（分钟，少一个窗口不开聊）</div>
          <input
            type="text"
            style="width:100%; max-width:120px;"
            value="${String(input.roundtableReadyTimeoutMin || '15').replace(/"/g, '&quot;')}"
            placeholder="15"
            oninput="updateScriptInput('${escapedPath}', 'roundtableReadyTimeoutMin', this.value)"
          />
          <div style="font-size:12px; color:#666; margin:10px 0 4px;">角色→环境映射预览（按当前执行顺序）</div>
          <div style="font-size:12px; color:#555; background:#f7fbff; border:1px solid #dbeffd; border-radius:4px; padding:8px;">
            <div style="margin-bottom:6px;">${mappingHint}</div>
            <ul style="margin:0; padding-left:18px;">${mappingRows || '<li>暂无</li>'}</ul>
          </div>
        </div>
      `;
    }

    const groupRows = (input.groupConfigs || []).map((group, gi) => {
      const gid = String(group.id || '').replace(/"/g, '&quot;');
      return `
        <div style="border:1px solid #e6e6e6; border-radius:6px; padding:10px; background:#fcfcfc; margin-top:8px;">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
            <div style="font-size:12px; font-weight:600; color:#333;">分组 ${gi + 1}</div>
            <button type="button" style="padding:4px 8px; font-size:12px; background:#e74c3c;" onclick="removeGroupRow('${escapedPath}', '${gid}')">删除</button>
          </div>
          <div style="font-size:12px; color:#666; margin:8px 0 4px;">链接列表（逗号或换行分隔）</div>
          <textarea
            style="width:100%; min-height:58px; border:1px solid #ddd; border-radius:4px; padding:8px; font-family:monospace; font-size:12px;"
            placeholder="https://discord.com/channels/a/1, https://discord.com/channels/a/2"
            oninput="updateGroupRow('${escapedPath}', '${gid}', 'urlsText', this.value)"
          >${group.urlsText || ''}</textarea>
          <div style="font-size:12px; color:#666; margin:8px 0 4px;">话术池（使用 | 或 ｜ 分隔）</div>
          <textarea
            style="width:100%; min-height:52px; border:1px solid #ddd; border-radius:4px; padding:8px; font-family:monospace; font-size:12px;"
            placeholder="你好|早上好|在吗"
            oninput="updateGroupRow('${escapedPath}', '${gid}', 'messagesText', this.value)"
          >${group.messagesText || ''}</textarea>
        </div>
      `;
    }).join('');

    return `
      <div style="border:1px solid #d9edf7; border-radius:6px; background:#fff; padding:10px;">
        <div style="font-weight:600; margin-bottom:8px;">${idx + 1}. ${title}</div>
        <div style="font-size:12px; color:#666; margin-bottom:6px;">按分组配置频道和话术：不同语言放不同组，执行更自然。</div>

        <div style="font-size:12px; color:#666; margin:8px 0 4px;">每个链接发送后等待秒数（支持区间，如 10-20）</div>
        <input
          type="text"
          value="${String(input.waitSecondsText || '12').replace(/"/g, '&quot;')}"
          placeholder="例如：12 或 10-20"
          oninput="updateScriptInput('${escapedPath}', 'waitSecondsText', this.value)"
        />
        <label style="display:flex; align-items:center; gap:6px; margin-top:8px; font-size:12px; color:#555;">
          <input
            type="checkbox"
            style="width:16px; height:16px;"
            ${input.randomizeLinkOrder ? 'checked' : ''}
            onchange="updateScriptInput('${escapedPath}', 'randomizeLinkOrder', this.checked)"
          />
          <span>组内链接随机顺序（每轮会重新打乱）</span>
        </label>
        <div style="display:flex; justify-content:space-between; align-items:center; margin-top:10px;">
          <div style="font-size:12px; color:#666;">分组列表</div>
          <button type="button" style="padding:4px 8px; font-size:12px; background:#2e86de;" onclick="addGroupRow('${escapedPath}')">新增分组</button>
        </div>
        ${groupRows || '<div style="font-size:12px; color:#999; margin-top:8px;">还没有分组，点击“新增分组”开始配置。</div>'}
      </div>
    `;
  });

  container.innerHTML = blocks.join('');
}

// 切换执行模式
function setExecutionMode(mode) {
  executionMode = mode;
  addLog(`执行模式: ${mode === 'perEnv' ? '单窗口顺序执行所有脚本' : '按脚本轮次执行所有窗口'}`, 'info');
}

// 加载环境列表
async function loadEnvironments() {
  const config = {
    port: parseInt(document.getElementById('port').value),
    apiId: document.getElementById('apiId').value,
    apiKey: document.getElementById('apiKey').value
  };

  if (!config.apiId || !config.apiKey) {
    addLog('请先配置API ID和API Key', 'error');
    return;
  }

  try {
    addLog('正在加载环境列表...', 'info');
    const client = new MoreLoginClient(config);
    
    // 获取所有环境（分页获取）
    let allEnvs = [];
    let pageNo = 1;
    const pageSize = 100;
    let hasMore = true;

    while (hasMore) {
      const result = await client.getEnvironments({ pageNo, pageSize });
      const envs = result.dataList || [];
      allEnvs = allEnvs.concat(envs);
      
      if (envs.length < pageSize || allEnvs.length >= result.total) {
        hasMore = false;
      } else {
        pageNo++;
      }
    }

    allEnvironments = allEnvs;
    renderEnvironmentList();
    addLog(`成功加载 ${allEnvironments.length} 个环境`, 'success');
  } catch (error) {
    addLog(`加载环境列表失败: ${error.message}`, 'error');
    document.getElementById('environmentList').innerHTML = `<div style="color: #e74c3c;">加载失败: ${error.message}</div>`;
  }
}

// 渲染环境列表
function renderEnvironmentList() {
  const container = document.getElementById('environmentList');
  const searchTerm = document.getElementById('envSearch').value.toLowerCase();
  
  // 筛选环境
  const filteredEnvs = allEnvironments.filter(env => {
    if (!searchTerm) return true;
    const envId = String(env.Id || env.id || '');
    const envName = (env.envName || env.name || '').toLowerCase();
    return envId.includes(searchTerm) || envName.includes(searchTerm);
  });

  if (filteredEnvs.length === 0) {
    container.innerHTML = '<div style="color: #999; text-align: center; padding: 20px;">没有找到匹配的环境</div>';
    updateSelectedCount();
    return;
  }

  container.innerHTML = filteredEnvs.map(env => {
    const envId = String(env.Id || env.id || '');
    const envName = env.envName || env.name || '未命名';
    const isSelected = selectedEnvironmentIds.has(envId);
    return `
      <label style="display: flex; align-items: center; padding: 6px 8px; margin-bottom: 4px; border-radius: 4px; cursor: pointer; transition: background 0.2s; background: ${isSelected ? '#e3f2fd' : 'transparent'};" 
             onmouseover="this.style.background='${isSelected ? '#bbdefb' : '#f5f5f5'}'" 
             onmouseout="this.style.background='${isSelected ? '#e3f2fd' : 'transparent'}'">
        <input type="checkbox" value="${envId}" ${isSelected ? 'checked' : ''} 
               onchange="toggleEnvironment('${envId}')" 
               style="margin-right: 6px; width: 16px; height: 16px; cursor: pointer; flex-shrink: 0;">
        <div style="flex: 1; min-width: 0;">
          <div style="font-weight: 500; font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${envName}">${envName}</div>
          <div style="font-size: 11px; color: #666; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="ID: ${envId}">ID: ${envId}</div>
        </div>
      </label>
    `;
  }).join('');

  updateSelectedCount();
}

// 切换环境选择
function toggleEnvironment(envId) {
  if (selectedEnvironmentIds.has(envId)) {
    selectedEnvironmentIds.delete(envId);
  } else {
    selectedEnvironmentIds.add(envId);
  }
  renderEnvironmentList();
}

// 筛选环境
function filterEnvironments() {
  renderEnvironmentList();
}

// 清除筛选
function clearEnvFilter() {
  document.getElementById('envSearch').value = '';
  renderEnvironmentList();
}

// 全选
function selectAllEnvs() {
  const searchTerm = document.getElementById('envSearch').value.toLowerCase();
  const filteredEnvs = allEnvironments.filter(env => {
    if (!searchTerm) return true;
    const envId = String(env.Id || env.id || '');
    const envName = (env.envName || env.name || '').toLowerCase();
    return envId.includes(searchTerm) || envName.includes(searchTerm);
  });
  
  filteredEnvs.forEach(env => {
    const envId = String(env.Id || env.id || '');
    selectedEnvironmentIds.add(envId);
  });
  renderEnvironmentList();
}

// 取消全选
function deselectAllEnvs() {
  const searchTerm = document.getElementById('envSearch').value.toLowerCase();
  const filteredEnvs = allEnvironments.filter(env => {
    if (!searchTerm) return true;
    const envId = String(env.Id || env.id || '');
    const envName = (env.envName || env.name || '').toLowerCase();
    return envId.includes(searchTerm) || envName.includes(searchTerm);
  });
  
  filteredEnvs.forEach(env => {
    const envId = String(env.Id || env.id || '');
    selectedEnvironmentIds.delete(envId);
  });
  renderEnvironmentList();
}

// 更新选中数量
function updateSelectedCount() {
  document.getElementById('selectedEnvCount').textContent = selectedEnvironmentIds.size;
}

// 开始执行
async function startExecution() {
  if (selectedScripts.size === 0) {
    addLog('请至少选择一个脚本', 'warning');
    return;
  }

  const modeSelect = document.getElementById('executionMode');
  if (modeSelect) {
    executionMode = modeSelect.value || executionMode;
  }

  const config = {
    port: parseInt(document.getElementById('port').value),
    apiId: document.getElementById('apiId').value,
    apiKey: document.getElementById('apiKey').value,
    maxConcurrent: parseInt(document.getElementById('maxConcurrent').value)
  };

  if (!config.apiId || !config.apiKey) {
    addLog('请先配置API ID和API Key', 'error');
    return;
  }

  // 获取选中的环境
  let environments = [];
  
  // 优先使用手动输入的环境ID
  const manualEnvIds = document.getElementById('manualEnvIds').value.trim();
  if (manualEnvIds) {
    const envIds = manualEnvIds.split('\n')
      .map(id => id.trim())
      .filter(id => id.length > 0);
    
    if (envIds.length > 0) {
      addLog(`使用手动输入的环境ID: ${envIds.length} 个`, 'info');
      // 从已加载的环境列表中查找，如果找不到就创建一个简单的环境对象
      environments = envIds.map(envId => {
        const found = allEnvironments.find(env => String(env.Id || env.id) === envId);
        if (found) {
          return found;
        }
        // 如果找不到，创建一个简单的环境对象
        return { Id: envId, id: envId, envName: `环境 ${envId}`, name: `环境 ${envId}` };
      });
    }
  } else if (selectedEnvironmentIds.size > 0) {
    // 使用勾选的环境
    environments = allEnvironments.filter(env => {
      const envId = String(env.Id || env.id || '');
      return selectedEnvironmentIds.has(envId);
    });
    addLog(`使用勾选的环境: ${environments.length} 个`, 'info');
  } else {
    addLog('请先选择环境或输入环境ID', 'error');
    return;
  }

  if (environments.length === 0) {
    addLog('没有可执行的环境', 'error');
    return;
  }

  const hasRoundtable = Array.from(selectedScripts.values()).some(scriptIsRoundtable);
  let roundtableRoleOrder = null;
  if (hasRoundtable) {
    const dialoguePreview = getFirstRoundtableDialogueText();
    roundtableRoleOrder = getRoleOrderFromDialogueText(dialoguePreview);
    if (roundtableRoleOrder.length === 0) {
      addLog(
        '已选择「Discord 多角色回合对话」：请先在剧本中写上至少一行「字母：正文」（如 A：你好），字母为单个 A–Z。',
        'error'
      );
      return;
    }
    if (environments.length !== roundtableRoleOrder.length) {
      addLog(
        `回合对话：剧本中共有 ${roundtableRoleOrder.length} 个角色（按首次出现顺序：${roundtableRoleOrder.join(' → ')}），需要勾选同样数量的环境，当前为 ${environments.length} 个。`,
        'error'
      );
      return;
    }
    if (config.maxConcurrent < environments.length) {
      addLog(
        `回合对话要求所有角色窗口同时就位：请把最大并发调到至少 ${environments.length}（当前 ${config.maxConcurrent}）。`,
        'error'
      );
      return;
    }
  }

  if (environments.length > config.maxConcurrent) {
    addLog(`注意: 选择了 ${environments.length} 个环境，但最大并发数为 ${config.maxConcurrent}，将按顺序执行`, 'warning');
  }

  const loopMode = !!document.getElementById('loopMode')?.checked;
  const loopIntervalMinutes = Math.max(1, parseInt(document.getElementById('loopIntervalMinutes')?.value || '10', 10));

  isRunning = true;
  updateStatus('running');
  document.getElementById('startBtn').disabled = true;
  document.getElementById('stopBtn').disabled = false;

  try {
    const client = new MoreLoginClient(config);
    
    // 检查连接
    addLog('正在检查MoreLogin服务连接...', 'info');
    addLog(`连接地址: http://127.0.0.1:${config.port}`, 'info');
    const connectionResult = await client.checkConnection();
    
    if (!connectionResult.success) {
      addLog(`连接失败: ${connectionResult.message}`, 'error');
      if (connectionResult.details) {
        if (connectionResult.details.suggestion) {
          addLog(`建议: ${connectionResult.details.suggestion}`, 'warning');
        }
        if (connectionResult.details.error) {
          addLog(`错误详情: ${connectionResult.details.error}`, 'error');
        }
      }
      throw new Error(connectionResult.message);
    }
    addLog('MoreLogin服务连接成功', 'success');

    const globalMessagePoolSession = createGlobalMessagePoolSession();

    // 执行脚本（传入选中的环境列表及脚本列表+模式）
    const selectedScriptsWithInput = Array.from(selectedScripts.values()).map((script) => {
      const input = scriptInputs.get(script.path) || {};
      return {
        ...script,
        scriptInput: { ...input, globalMessagePoolSession }
      };
    });

    const roundtableEnvRoleMap = {};
    if (hasRoundtable && roundtableRoleOrder) {
      roundtableRoleOrder.forEach((letter, i) => {
        const e = environments[i];
        const eid = String(e.Id || e.id || '');
        roundtableEnvRoleMap[eid] = letter;
      });
      const mappingText = environments
        .map((e, i) => {
          const eid = String(e.Id || e.id || '');
          const ename = String(e.envName || e.name || `环境 ${eid}`);
          const role = roundtableRoleOrder[i] || '?';
          return `${role}->${ename}(${eid})`;
        })
        .join(' | ');
      addLog(`回合角色映射预览: ${mappingText}`, 'info');
    }

    let round = 1;
    do {
      if (!isRunning) break;
      addLog(`开始第 ${round} 轮执行`, 'info');

      let roundtableSessionId = null;
      if (hasRoundtable) {
        roundtableSessionId = `rt_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
        addLog(
          `回合对话本轮会话 ID: ${roundtableSessionId}（环境顺序 = ${roundtableRoleOrder.join(' / ')}）`,
          'info'
        );
      }

      controller = new ScriptController(client, config.maxConcurrent);

      // 设置事件监听
      controller.on('log', (message, type) => {
        addLog(message, type);
      });

      controller.on('status', (status) => {
        updateStatus(status.running > 0 ? 'running' : 'idle');
        document.getElementById('runningCount').textContent = status.running;
        document.getElementById('completedCount').textContent = status.completed;
        document.getElementById('failedCount').textContent = status.failed;
      });

      await controller.executeScripts(selectedScriptsWithInput, environments, executionMode, {
        globalMessagePoolSession,
        roundtableSessionId,
        roundtableEnvRoleMap: hasRoundtable ? roundtableEnvRoleMap : null
      });

      if (controller.poolExhaustedStop) {
        addLog('话术池已用尽，本次点击启动的完整流程已结束（含后续循环）', 'warning');
        isRunning = false;
        break;
      }

      addLog(`第 ${round} 轮执行完成`, 'success');
      round++;

      if (!loopMode || !isRunning) break;

      const waitMs = loopIntervalMinutes * 60 * 1000;
      addLog(`循环模式已启用，等待 ${loopIntervalMinutes} 分钟后开始下一轮`, 'info');
      await waitForNextRound(waitMs);
    } while (isRunning);

    if (isRunning) {
      addLog('所有任务执行完成', 'success');
    } else {
      addLog('执行已停止', 'warning');
    }
  } catch (error) {
    addLog('执行出错: ' + error.message, 'error');
    console.error(error);
  } finally {
    isRunning = false;
    updateStatus('idle');
    document.getElementById('startBtn').disabled = false;
    document.getElementById('stopBtn').disabled = true;
  }
}

function waitForNextRound(waitMs) {
  return new Promise((resolve) => {
    if (!isRunning || waitMs <= 0) {
      resolve();
      return;
    }
    loopWaitTimer = setTimeout(() => {
      loopWaitTimer = null;
      resolve();
    }, waitMs);
  });
}

// 停止执行
async function stopExecution() {
  isRunning = false;
  if (loopWaitTimer) {
    clearTimeout(loopWaitTimer);
    loopWaitTimer = null;
  }
  if (controller) {
    addLog('正在停止执行...', 'warning');
    try {
      await controller.stop();
      addLog('已停止所有任务', 'warning');
    } catch (error) {
      addLog(`停止失败: ${error.message}`, 'error');
    }
  }
}

// 更新状态
function updateStatus(status) {
  const indicator = document.getElementById('statusIndicator');
  const statusText = document.getElementById('statusText');
  
  indicator.className = 'status-indicator status-' + status;
  statusText.textContent = status === 'running' ? '运行中' : '空闲';
}

// 添加日志
function addLog(message, type = 'info') {
  const logContainer = document.getElementById('logContainer');
  const timestamp = new Date().toLocaleTimeString();
  const logEntry = document.createElement('div');
  logEntry.className = 'log-entry log-' + type;
  logEntry.textContent = `[${timestamp}] ${message}`;
  logContainer.appendChild(logEntry);
  logContainer.scrollTop = logContainer.scrollHeight;
  
  // 限制日志条数，避免内存占用过大
  const maxLogs = 1000;
  while (logContainer.children.length > maxLogs) {
    logContainer.removeChild(logContainer.firstChild);
  }
}

// 测试连接
async function testConnection() {
  const config = {
    port: parseInt(document.getElementById('port').value),
    apiId: document.getElementById('apiId').value,
    apiKey: document.getElementById('apiKey').value,
    maxConcurrent: parseInt(document.getElementById('maxConcurrent').value)
  };

  if (!config.apiId || !config.apiKey) {
    addLog('请先配置API ID和API Key', 'error');
    return;
  }

  addLog('=== 开始连接测试 ===', 'info');
  addLog(`端口: ${config.port}`, 'info');
  addLog(`API ID: ${config.apiId.substring(0, 8)}...`, 'info');
  addLog(`API Key: ${config.apiKey.substring(0, 8)}...`, 'info');
  addLog('正在尝试连接...', 'info');

  try {
    const client = new MoreLoginClient(config);
    const connectionResult = await client.checkConnection();

    if (connectionResult.success) {
      addLog('✓ 连接测试成功！', 'success');
      
      // 尝试获取环境列表
      try {
        addLog('正在获取环境列表...', 'info');
        const envListResult = await client.getEnvironments({ pageNo: 1, pageSize: 10 });
        const environments = envListResult.dataList || [];
        const total = envListResult.total || 0;
        
        if (total > 0) {
          addLog(`✓ 找到 ${total} 个环境（显示前 ${environments.length} 个）`, 'success');
          
          if (environments.length > 0) {
            addLog('环境列表:', 'info');
            environments.forEach((env, index) => {
              const envId = env.Id || env.id || 'N/A';
              const envName = env.envName || env.name || 'N/A';
              addLog(`  ${index + 1}. ${envName} (ID: ${envId})`, 'info');
            });
            if (total > environments.length) {
              addLog(`  ... 还有 ${total - environments.length} 个环境`, 'info');
            }
          }
        } else {
          addLog('✓ 连接成功，但没有找到环境', 'warning');
          addLog('提示: 请在MoreLogin客户端中创建环境', 'info');
        }
      } catch (envError) {
        addLog(`获取环境列表失败: ${envError.message}`, 'warning');
      }
    } else {
      addLog('✗ 连接测试失败', 'error');
      addLog(`错误: ${connectionResult.message}`, 'error');
      if (connectionResult.details) {
        if (connectionResult.details.suggestion) {
          addLog(`建议: ${connectionResult.details.suggestion}`, 'warning');
        }
        if (connectionResult.details.error) {
          addLog(`详情: ${connectionResult.details.error}`, 'error');
        }
      }
      addLog('', 'info');
      addLog('排查建议:', 'warning');
      addLog('1. 确认MoreLogin客户端已启动', 'info');
      addLog('2. 确认已启用本地API功能', 'info');
      addLog('3. 检查端口号是否正确（默认35000）', 'info');
      addLog('4. 确认API ID和API Key正确（区分大小写）', 'info');
      addLog('5. 如果仍失败，可能是API路径不匹配，请查看MoreLogin API文档', 'info');
    }
  } catch (error) {
    addLog(`连接测试出错: ${error.message}`, 'error');
  }
  
  addLog('=== 连接测试完成 ===', 'info');
}

// 页面加载时初始化
init();

