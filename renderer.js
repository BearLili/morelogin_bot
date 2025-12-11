const { ipcRenderer } = require('electron');
const ScriptController = require('./src/controller');
const MoreLoginClient = require('./src/morelogin-client');

let controller = null;
let selectedScript = null;
let isRunning = false;
let allEnvironments = [];
let selectedEnvironmentIds = new Set();

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

// 保存配置
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
    li.textContent = script.name;
    li.onclick = (e) => selectScript(script, e.target);
    scriptList.appendChild(li);
  });
  
  addLog(`已加载 ${scripts.length} 个脚本`, 'info');
}

// 选择脚本
function selectScript(script, element) {
  selectedScript = script;
  
  // 更新UI
  document.querySelectorAll('.script-item').forEach(item => {
    item.classList.remove('selected');
  });
  if (element) {
    element.classList.add('selected');
  }
  
  addLog(`已选择脚本: ${script.name}`, 'info');
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
  if (!selectedScript) {
    addLog('请先选择一个脚本', 'warning');
    return;
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

  if (environments.length > config.maxConcurrent) {
    addLog(`注意: 选择了 ${environments.length} 个环境，但最大并发数为 ${config.maxConcurrent}，将按顺序执行`, 'warning');
  }

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

    // 执行脚本（传入选中的环境列表）
    await controller.executeScript(selectedScript.path, environments);
    
    addLog('所有任务执行完成', 'success');
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

// 停止执行
function stopExecution() {
  if (controller) {
    controller.stop();
    addLog('正在停止执行...', 'warning');
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

