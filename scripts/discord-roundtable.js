/**
 * Discord 多角色回合制对话（环境数 = 剧本中出现的角色数）
 *
 * 约定：
 * - 角色 = 行首单个英文字母（A–Z）+ 冒号；需要几个角色就起几行不同字母（解析逻辑见 src/roundtable-parse.js）
 * - 「开始执行」里勾选的环境数量须等于上述角色数；环境顺序 = 这些角色在剧本里首次出现的顺序
 * - 所有窗口进同一频道后，先「全员就位」再开聊；本地状态文件串行「抢麦」
 * - 同角色连续两句之间、换角色之间：秒级随机间隔（UI 可配，默认 10–30s / 30–60s）
 * - 可选 scriptInput：roundtableSameSpeakerSettleMs（同角色连发前 UI 稳定等待，默认 2200）
 *   roundtableMaxWallClockMin（整段最长分钟，默认 180，最少 35）
 *
 * 依赖：puppeteer-core、axios（与项目一致）
 */

const puppeteer = require('puppeteer-core');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const {
  parseRoundtableLines,
  getRoleOrderFromDialogueText,
  getRoleOrderFromLines
} = require('../src/roundtable-parse');

module.exports = async function execute(context) {
  const { wsUrl, debugPort, log, scriptInput = {} } = context;
  const role = String(scriptInput.roundtableRole || '').toUpperCase().trim();
  const sessionId = String(scriptInput.roundtableSessionId || '').trim();
  const channelUrl = String(scriptInput.roundtableChannelUrl || scriptInput.channelUrl || '').trim();
  const dialogueText = String(scriptInput.roundtableDialogueText || scriptInput.dialogueText || '').trim();

  const pageStabilityWait = 4000;
  const channelOpenWaitMs = 3500;
  const pollMsMin = 600;
  const pollMsMax = 1400;
  /** 整段剧本墙钟上限（含故意等待）；过短会导致长剧本后半段被误判超时 */
  const wallClockMin = Math.max(
    35,
    parseInt(String(scriptInput.roundtableMaxWallClockMin || '180'), 10) || 180
  );
  const maxIdleMs = wallClockMin * 60 * 1000;
  const sameSpeakerSettleMs = Math.max(
    800,
    parseInt(String(scriptInput.roundtableSameSpeakerSettleMs || '2200'), 10) || 2200
  );

  let browser;
  let page;

  const delay = (ms) => new Promise((res) => setTimeout(res, ms));
  const randomDelay = (min, max) => delay(Math.floor(Math.random() * (max - min + 1)) + min);

  /** 返回 [minSec, maxSec] 正整数；支持 "10-30"、"10～30"、单个数字 */
  function parseSecRange(text, defaultMin, defaultMax) {
    const t = String(text || '').trim();
    const m = t.match(/^(\d+)\s*[-~～]\s*(\d+)$/);
    if (m) {
      let a = parseInt(m[1], 10);
      let b = parseInt(m[2], 10);
      if (Number.isNaN(a) || Number.isNaN(b)) return [defaultMin, defaultMax];
      if (a > b) [a, b] = [b, a];
      return [a, b];
    }
    const n = parseInt(t, 10);
    if (!Number.isNaN(n) && n > 0) return [n, n];
    return [defaultMin, defaultMax];
  }

  function randomDelaySecRangeLoHi(minSec, maxSec) {
    const lo = Math.min(minSec, maxSec) * 1000;
    const hi = Math.max(minSec, maxSec) * 1000;
    const ms = lo + Math.floor(Math.random() * (hi - lo + 1));
    return delay(ms);
  }

  if (!/^[A-Z]$/.test(role)) {
    throw new Error(`回合制脚本缺少有效角色（应为单个大写字母 A-Z），当前: ${role || '(空)'}`);
  }
  if (!sessionId) {
    throw new Error('缺少 roundtableSessionId（请从控制器注入）');
  }
  if (!channelUrl || !channelUrl.includes('discord.com/channels/')) {
    throw new Error('请填写有效的 Discord 频道链接（https://discord.com/channels/...）');
  }
  if (!dialogueText) {
    throw new Error('请粘贴剧本对话内容');
  }

  const logsDir = path.join(process.cwd(), 'logs');
  const statePath = path.join(logsDir, `dc-roundtable-${sessionId}.json`);

  function readState() {
    const raw = fs.readFileSync(statePath, 'utf8');
    return JSON.parse(raw);
  }

  function writeState(obj) {
    fs.writeFileSync(statePath, JSON.stringify(obj, null, 2), 'utf8');
  }

  function initStateFile(lines, expectedRoles) {
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }
    const initial = {
      version: 2,
      phase: 'waiting_ready',
      expectedRoles,
      readyRoles: [],
      nextIndex: 0,
      lines
    };
    try {
      fs.writeFileSync(statePath, JSON.stringify(initial, null, 2), { flag: 'wx' });
      log(`已创建回合状态文件: ${statePath}`, 'info');
    } catch (err) {
      if (err && err.code === 'EEXIST') {
        log('回合状态文件已存在（由其他窗口创建）', 'info');
      } else {
        throw err;
      }
    }
  }

  function assertStateMatchesLocal(expectedRoles) {
    const st = readState();
    const er = st.expectedRoles;
    if (!Array.isArray(er) || er.length === 0) {
      throw new Error(
        '状态文件缺少 expectedRoles（可能为旧版），请重新点击「开始」以生成新会话，或删除对应 logs/dc-roundtable-*.json'
      );
    }
    if (JSON.stringify(er) !== JSON.stringify(expectedRoles)) {
      throw new Error(
        '状态文件中的角色顺序与当前剧本不一致，请确保各窗口使用同一份剧本并重新启动任务'
      );
    }
    const localLineRoles = getRoleOrderFromLines(st.lines || []);
    if (JSON.stringify(localLineRoles) !== JSON.stringify(expectedRoles)) {
      throw new Error('状态文件内台词与角色列表不一致，请换新会话重试');
    }
  }

  async function waitUntilAllWindowsReady(expectedRolesParam) {
    const readyTimeoutMin = Math.max(1, parseInt(String(scriptInput.roundtableReadyTimeoutMin || '15'), 10) || 15);
    const maxWaitMs = readyTimeoutMin * 60 * 1000;
    const waitStarted = Date.now();
    let lastMissingLog = 0;

    while (Date.now() - waitStarted < maxWaitMs) {
      const st0 = readState();
      if (st0.phase === 'dialogue') {
        log('全体窗口已就位，开始按剧本发言', 'success');
        return;
      }
      if (st0.phase !== 'waiting_ready') {
        throw new Error(`回合状态异常 phase=${st0.phase || '(空)'}`);
      }

      const exp = st0.expectedRoles || expectedRolesParam;
      const mergedSet = new Set([...(st0.readyRoles || []), role]);
      const merged = [...mergedSet].sort();
      const allReady = exp.length > 0 && exp.every((r) => mergedSet.has(r));
      const nextPhase = allReady ? 'dialogue' : 'waiting_ready';
      const prevSorted = JSON.stringify([...(st0.readyRoles || [])].sort());
      const nextSorted = JSON.stringify(merged);
      const needWrite = prevSorted !== nextSorted || st0.phase !== nextPhase;

      if (needWrite) {
        const st1 = readState();
        if (st1.phase === 'dialogue') {
          log('全体窗口已就位，开始按剧本发言', 'success');
          return;
        }
        if (
          JSON.stringify(st0.readyRoles || []) !== JSON.stringify(st1.readyRoles || []) ||
          st0.phase !== st1.phase
        ) {
          await randomDelay(80, 350);
          continue;
        }
        writeState({ ...st1, readyRoles: merged, phase: nextPhase });
        if (nextPhase === 'dialogue') {
          log('全体窗口已就位，开始按剧本发言', 'success');
          return;
        }
      }

      const stPoll = readState();
      if (stPoll.phase === 'dialogue') {
        log('全体窗口已就位，开始按剧本发言', 'success');
        return;
      }
      const rs = new Set(stPoll.readyRoles || []);
      const missing = (stPoll.expectedRoles || []).filter((r) => !rs.has(r));
      if (Date.now() - lastMissingLog > 12000) {
        lastMissingLog = Date.now();
        log(`等待全体就位（最长 ${readyTimeoutMin} 分钟）：未到 ${missing.join('、')}`, 'info');
      }
      await randomDelay(pollMsMin, pollMsMax);
    }

    const stFinal = readState();
    const readySet = new Set(stFinal.readyRoles || []);
    const missing = (stFinal.expectedRoles || []).filter((r) => !readySet.has(r));
    throw new Error(
      `等待全体就位超时（${readyTimeoutMin} 分钟），仍缺角色：${missing.join('、') || '未知'}。需所有环境都进频道并跑起来后才会开聊。`
    );
  }

  async function resolveWsEndpoint(portOrUrl) {
    if (typeof portOrUrl === 'string' && portOrUrl.startsWith('ws://')) {
      return portOrUrl;
    }
    const port = typeof portOrUrl === 'number' ? portOrUrl : parseInt(portOrUrl, 10);
    if (Number.isNaN(port)) {
      throw new Error('未提供有效的 debugPort');
    }
    const url = `http://127.0.0.1:${port}/json/version`;
    try {
      const res = await axios.get(url, { timeout: 3000 });
      if (res.data && res.data.webSocketDebuggerUrl) {
        return res.data.webSocketDebuggerUrl;
      }
    } catch (_) {}
    return `ws://127.0.0.1:${port}/devtools/browser`;
  }

  async function waitForPageStability(p) {
    log('等待页面稳定...', 'info');
    await p.waitForSelector('[data-list-id="guildsnav"]', { timeout: 15000 }).catch(() => {});
    await delay(pageStabilityWait);
    log('页面已稳定', 'success');
  }

  async function sendMessage(p, content) {
    if (!content) return false;
    const normalize = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    const shortNeedle = normalize(content).slice(0, 28);

    async function waitForMessageEcho(needle, timeoutMs = 6500) {
      const startedAt = Date.now();
      while (Date.now() - startedAt < timeoutMs) {
        try {
          const hit = await p.evaluate((n) => {
            const normalizeText = (x) => String(x || '').replace(/\s+/g, ' ').trim().toLowerCase();
            const needle = normalizeText(n);
            if (!needle) return false;
            const selectors = [
              '[id^="message-content-"]',
              '[data-list-item-id^="chat-messages"] [class*="messageContent"]',
              '[data-list-item-id^="chat-messages"] [class*="markup"]'
            ];
            const nodes = selectors.flatMap((sel) => Array.from(document.querySelectorAll(sel)));
            const tail = nodes.slice(-14);
            return tail.some((el) => normalizeText(el.textContent).includes(needle));
          }, needle);
          if (hit) return true;
        } catch (_) {}
        await delay(260 + Math.floor(Math.random() * 220));
      }
      return false;
    }

    async function trySendOnce() {
      const editableSelectors = [
        '[role="textbox"][contenteditable="true"]',
        'div[contenteditable="true"][data-slate-editor="true"]',
        'main form div[contenteditable="true"]'
      ];
      let selectorFound = null;
      for (const sel of editableSelectors) {
        const el = await p.$(sel);
        if (el) {
          selectorFound = sel;
          break;
        }
      }
      if (!selectorFound) {
        log('未找到聊天输入框', 'warning');
        return false;
      }
      await p.click(selectorFound, { clickCount: 1 });
      await delay(180 + Math.random() * 220);
      const modKey = process.platform === 'darwin' ? 'Meta' : 'Control';
      await p.keyboard.down(modKey);
      await p.keyboard.press('KeyA');
      await p.keyboard.up(modKey);
      await p.keyboard.press('Backspace');
      await delay(80 + Math.random() * 120);
      await p.keyboard.type(content, { delay: 18 + Math.floor(Math.random() * 28) });
      await delay(200 + Math.random() * 260);
      await p.keyboard.press('Enter');
      return true;
    }

    for (let attempt = 1; attempt <= 2; attempt++) {
      const sent = await trySendOnce();
      if (!sent) return false;
      // Discord 连续发第二条时，上一条若未落盘/输入框未清空，极易吞消息
      await delay(1200 + Math.random() * 900);
      const echoed = await waitForMessageEcho(shortNeedle, 6200);
      if (echoed) {
        log(`[${role}] 已发送(确认落地): ${content}`, 'info');
        return true;
      }
      if (attempt < 2) {
        log(`[${role}] 第 ${attempt} 次发送未确认落地，准备重试`, 'warning');
        await delay(800 + Math.floor(Math.random() * 600));
      }
    }

    log(`[${role}] 发送后未能确认消息落地: ${content}`, 'warning');
    return false;
  }

  const lines = parseRoundtableLines(dialogueText);
  if (lines.length === 0) {
    throw new Error('剧本解析结果为空，请检查行首是否为「英文字母 + ：」且冒号后有正文');
  }
  const speakersInScript = new Set(lines.map((l) => l.speaker));
  if (!speakersInScript.has(role)) {
    throw new Error(`当前窗口角色「${role}」在剧本台词中未出现，请检查环境顺序是否与剧本角色首次出现顺序一致`);
  }

  const expectedRoles = getRoleOrderFromDialogueText(dialogueText);
  initStateFile(lines, expectedRoles);
  assertStateMatchesLocal(expectedRoles);

  const [sameLo, sameHi] = parseSecRange(scriptInput.roundtableSameSpeakerDelaySecRange, 10, 30);
  const [betweenLo, betweenHi] = parseSecRange(scriptInput.roundtableBetweenSpeakersDelaySecRange, 30, 60);

  try {
    log(
      `回合制对话开始，角色 ${role}，共 ${lines.length} 条台词；同角色间隔 ${sameLo}-${sameHi}s，换人间隔 ${betweenLo}-${betweenHi}s`,
      'info'
    );
    const wsEndpoint = await resolveWsEndpoint(debugPort || wsUrl);
    browser = await puppeteer.connect({ browserWSEndpoint: wsEndpoint });
    await delay(2000);
    page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });
    await page.goto(channelUrl, { waitUntil: 'networkidle2', timeout: 60000 });
    await delay(2000);
    await waitForPageStability(page);
    await delay(channelOpenWaitMs);

    log(`本窗口已进入频道，正在等待全部 ${expectedRoles.length} 个角色就位…`, 'info');
    await waitUntilAllWindowsReady(expectedRoles);

    const started = Date.now();
    let myTurnCount = 0;

    while (true) {
      if (Date.now() - started > maxIdleMs) {
        throw new Error('等待回合超时，请检查其他窗口是否在运行');
      }

      const st0 = readState();
      if (st0.phase === 'waiting_ready') {
        await waitUntilAllWindowsReady(expectedRoles);
        continue;
      }
      if (st0.nextIndex >= st0.lines.length) {
        log(`剧本已全部完成（共 ${st0.lines.length} 条），角色 ${role} 退出`, 'success');
        break;
      }

      const cur = st0.lines[st0.nextIndex];
      if (cur.speaker !== role) {
        await randomDelay(pollMsMin, pollMsMax);
        continue;
      }

      const st1 = readState();
      if (st1.nextIndex !== st0.nextIndex) {
        await randomDelay(80, 220);
        continue;
      }
      if (st1.lines[st1.nextIndex].speaker !== role) {
        await randomDelay(pollMsMin, pollMsMax);
        continue;
      }

      const idx = st1.nextIndex;
      const nextIdx = idx + 1;
      const sent = await sendMessage(page, cur.text);
      if (!sent) {
        throw new Error('发送失败，本句未推进回合（下一名请勿抢跑）');
      }
      myTurnCount += 1;

      const following = nextIdx < st1.lines.length ? st1.lines[nextIdx] : null;
      if (following) {
        if (following.speaker === role) {
          log(`同角色连续：等待频道/UI 稳定 ${Math.round(sameSpeakerSettleMs / 100) / 10}s…`, 'info');
          await delay(sameSpeakerSettleMs + Math.floor(Math.random() * 400));
          log(`同角色连续发言，再等待 ${sameLo}-${sameHi}s（随机）…`, 'info');
          await randomDelaySecRangeLoHi(sameLo, sameHi);
        } else {
          log(`下一条由其他角色发送，间隔等待 ${betweenLo}-${betweenHi}s（随机）…`, 'info');
          await randomDelaySecRangeLoHi(betweenLo, betweenHi);
        }
      }

      let advanced = false;
      for (let att = 0; att < 8000 && !advanced; att++) {
        const sa = readState();
        if (sa.nextIndex === nextIdx) {
          advanced = true;
          break;
        }
        if (sa.nextIndex > nextIdx) {
          throw new Error(
            `回合索引异常：本句刚发完应推进到 ${nextIdx}，当前为 ${sa.nextIndex}，请检查是否多环境误配同一角色或手动改过状态文件`
          );
        }
        if (sa.nextIndex < idx) {
          throw new Error('回合索引倒退，状态文件异常');
        }
        if (sa.nextIndex !== idx) {
          await randomDelay(80, 280);
          continue;
        }
        if (!sa.lines[idx] || sa.lines[idx].speaker !== role) {
          throw new Error('回合状态与刚发送的一句不一致');
        }
        const sb = readState();
        if (sb.nextIndex !== sa.nextIndex) continue;
        if (sa.nextIndex !== idx) continue;
        writeState({ ...sa, nextIndex: nextIdx });
        advanced = true;
      }
      if (!advanced) {
        throw new Error('推进回合索引失败（并发冲突），请重试');
      }
    }

    log(`角色 ${role} 本窗口共发送 ${myTurnCount} 条`, 'info');
  } catch (err) {
    log(`任务失败: ${err.message}`, 'error');
    throw err;
  } finally {
    if (browser) {
      try {
        await browser.disconnect();
        log('已断开浏览器连接', 'info');
      } catch (_) {}
    }
  }
};
