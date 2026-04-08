/**
 * Discord 浏览交互脚本
 *
 * 行为：
 * 1. 打开 https://discord.com/channels/@me
 * 2. 等待页面稳定
 * 3. （可选）按配置访问指定频道列表
 * 4. （可选）聚焦到指定频道并发送聊天消息
 * 5. 无配置或失败时，回退随机浏览（原行为）
 *
 * 依赖：puppeteer-core（已在 package.json 声明）
 */

const puppeteer = require('puppeteer-core');
const axios = require('axios');

module.exports = async function execute(context) {
  const { wsUrl, debugPort, log } = context;
  const runtimeInput = context.scriptInput || {};
  const poolSession = context.globalMessagePoolSession || null;

  // 可调参数
  const targetUrl = 'https://discord.com/channels/@me';
  const maxLoops = 10; // 主循环次数
  const minScrollDelay = 2500;
  const maxScrollDelay = 8000;
  const minReadTime = 4000;
  const maxReadTime = 15000;
  const minDeepReadTime = 8000;
  const maxDeepReadTime = 25000;
  const clickServerProbability = 0.6; // 点击左侧服务器/私信列表概率
  const clickChannelProbability = 0.7; // 点击频道概率
  const pageStabilityWait = 5000;
  const channelOpenWaitMs = 3500;

  // 默认配置：仅走 UI 输入，不读取外部 JSON
  const defaultScenarioConfig = {
    enabled: true,
    visitTargets: [
      // 建议优先填 guildId + channelId，最稳定
      // { guildId: '1234567890', channelId: '2345678901', name: 'general' },
      // 仅 name 可用，但稳定性低于 ID 跳转
      // { name: 'general' },
    ],
    focusTarget: {
      // guildId: '1234567890',
      // channelId: '3456789012',
      // name: 'chat'
    },
    navigationMode: 'url_first', // url_first | pinned_first
    visitReadMinMs: 3000,
    visitReadMaxMs: 9000,
    sendChanceInVisit: 0.25, // 访问目标频道时，概率发送一条
  };

  const defaultChatConfig = {
    enabled: true,
    rounds: 4,
    minIntervalMs: 7000,
    maxIntervalMs: 18000,
    source: 'array', // array | api
    messages: [
      '准备吃猪脚饭了'
    ],
    avoidRecentCount: 5,
    api: {
      endpoint: '',
      method: 'POST',
      timeoutMs: 10000,
      headers: {},
      payload: {},
      responsePath: 'message', // 支持 data.message 这种路径
    },
  };

  const defaultLinkSequenceConfig = {
    enabled: false,
    stopOnError: false,
    closeTabOnFinish: true,
    randomizeOrder: false,
    defaultWaitAfterSendMs: 12000,
    defaultWaitAfterSendMinMs: 12000,
    defaultWaitAfterSendMaxMs: 12000,
    links: [
      // {
      //   url: 'https://discord.com/channels/1234567890/2345678901',
      //   messages: ['hello channel A'],
      //   waitAfterSendMs: 12000
      // }
    ],
  };

  let scenarioConfig = { ...defaultScenarioConfig };
  let chatConfig = { ...defaultChatConfig };
  let linkSequenceConfig = { ...defaultLinkSequenceConfig };

  let browser;
  let page;

  /** 话术库去重条目（与 UI 配置一致，全局共享见 globalMessagePoolSession） */
  let uniquePool = [];
  /** 无全局会话时的单脚本兜底（不推荐多窗口并行） */
  let localPoolRemaining = null;

  const delay = (ms) => new Promise((res) => setTimeout(res, ms));
  const randomDelay = (min, max) => delay(Math.floor(Math.random() * (max - min + 1)) + min);

  function makePoolExhaustedError() {
    const e = new Error('MESSAGE_POOL_EXHAUSTED');
    e.code = 'POOL_EXHAUSTED';
    return e;
  }

  function initUniquePool() {
    uniquePool = [
      ...new Set(
        (Array.isArray(chatConfig.messages) ? chatConfig.messages : [])
          .map((s) => String(s).trim())
          .filter(Boolean)
      )
    ];
  }

  function shuffleArray(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  async function claimFromGlobalPool() {
    if (uniquePool.length === 0) return null;
    if (poolSession) {
      return poolSession.claim(uniquePool);
    }
    if (!localPoolRemaining || localPoolRemaining.length === 0) {
      localPoolRemaining = shuffleArray(uniquePool);
    }
    return localPoolRemaining.shift() || null;
  }

  function parseUrlText(urlsText) {
    if (!urlsText || typeof urlsText !== 'string') return [];
    return urlsText
      .split(/[\n,，]+/)
      .map((s) => String(s || '').trim())
      .filter((s) => s.length > 0);
  }

  function parseMessageText(messageText) {
    if (!messageText || typeof messageText !== 'string') return [];
    return messageText
      .split(/[|｜]+/)
      .map((s) => String(s || '').trim())
      .filter((s) => s.length > 0);
  }

  function parseWaitSecondsRange(raw) {
    const txt = String(raw == null ? '' : raw).trim();
    if (!txt) return null;
    const m = txt.match(/^(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)$/);
    if (m) {
      let min = Number(m[1]);
      let max = Number(m[2]);
      if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
      if (min > max) [min, max] = [max, min];
      min = Math.max(1, min);
      max = Math.max(min, max);
      return { minMs: Math.round(min * 1000), maxMs: Math.round(max * 1000) };
    }
    const single = Number(txt);
    if (!Number.isFinite(single) || single <= 0) return null;
    const ms = Math.round(single * 1000);
    return { minMs: ms, maxMs: ms };
  }

  function resolveWaitMs(item) {
    const itemMin = Number(item?.waitAfterSendMinMs);
    const itemMax = Number(item?.waitAfterSendMaxMs);
    if (Number.isFinite(itemMin) && Number.isFinite(itemMax) && itemMin > 0 && itemMax > 0) {
      const min = Math.min(itemMin, itemMax);
      const max = Math.max(itemMin, itemMax);
      return safeRandomInt(min, max);
    }
    const itemSingle = Number(item?.waitAfterSendMs);
    if (Number.isFinite(itemSingle) && itemSingle > 0) return itemSingle;

    const min = Number(linkSequenceConfig.defaultWaitAfterSendMinMs || linkSequenceConfig.defaultWaitAfterSendMs || 12000);
    const max = Number(linkSequenceConfig.defaultWaitAfterSendMaxMs || linkSequenceConfig.defaultWaitAfterSendMs || 12000);
    const fixedMin = Number.isFinite(min) && min > 0 ? min : 12000;
    const fixedMax = Number.isFinite(max) && max > 0 ? max : fixedMin;
    return safeRandomInt(Math.min(fixedMin, fixedMax), Math.max(fixedMin, fixedMax));
  }

  function applyRuntimeInputOverrides() {
    const urls = parseUrlText(runtimeInput.urlsText);
    const waitRange = parseWaitSecondsRange(runtimeInput.waitSecondsText ?? runtimeInput.waitSeconds);
    const messageText = String(runtimeInput.messageText || '').trim();
    const messageList = parseMessageText(messageText);
    const randomizeOrder = !!runtimeInput.randomizeLinkOrder;

    if (urls.length > 0) {
      linkSequenceConfig.enabled = true;
      linkSequenceConfig.randomizeOrder = randomizeOrder;
      linkSequenceConfig.links = urls.map((u) => ({
        url: u,
        messages: messageList.length > 0 ? messageList : undefined,
      }));
      log(`已应用 UI 输入链接，共 ${urls.length} 条${randomizeOrder ? '（随机顺序）' : '（顺序执行）'}`, 'info');
    }

    if (messageList.length > 0) {
      chatConfig.source = 'array';
      chatConfig.messages = messageList;
      log(`已应用 UI 发言数组，共 ${messageList.length} 条`, 'info');
    }

    if (waitRange) {
      linkSequenceConfig.defaultWaitAfterSendMinMs = waitRange.minMs;
      linkSequenceConfig.defaultWaitAfterSendMaxMs = waitRange.maxMs;
      linkSequenceConfig.defaultWaitAfterSendMs = waitRange.minMs;
    }
  }

  // 解析 WebSocket 端点
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
    } catch (_) {
      // ignore
    }
    return `ws://127.0.0.1:${port}/devtools/browser`;
  }

  async function waitForPageStability(page) {
    log('等待页面稳定加载...', 'info');
    try {
      // 等待主 UI 元素加载
      await page.waitForSelector('[data-list-id="guildsnav"]', { timeout: 15000 }).catch(() => {});
      await page.waitForSelector('[data-list-id="private-channels"]', { timeout: 15000 }).catch(() => {});
    } catch (_) {
      // ignore
    }
    await delay(pageStabilityWait);
    await delay(2000);
    log('页面已稳定', 'success');
  }

  async function smoothScrollInElement(page, selector) {
    const distance = Math.floor(Math.random() * 900) + 300;
    await page.evaluate(
      (sel, dist) => {
        const el = document.querySelector(sel);
        if (el) {
          el.scrollBy({ top: dist, behavior: 'smooth' });
        } else {
          window.scrollBy({ top: dist, behavior: 'smooth' });
        }
      },
      selector,
      distance
    );
    await delay(800 + Math.random() * 400);
  }

  function getChannelUrl(target) {
    if (!target || !target.guildId || !target.channelId) return null;
    return `https://discord.com/channels/${target.guildId}/${target.channelId}`;
  }

  function safeRandomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  function getValueByPath(obj, path) {
    if (!obj || !path) return null;
    const parts = String(path).split('.');
    let cur = obj;
    for (const key of parts) {
      if (cur == null || typeof cur !== 'object') return null;
      cur = cur[key];
    }
    return cur == null ? null : cur;
  }

  async function pickMessageFromApi() {
    const endpoint = chatConfig.api?.endpoint;
    if (!endpoint) return null;
    try {
      const method = String(chatConfig.api?.method || 'POST').toUpperCase();
      const timeout = Number(chatConfig.api?.timeoutMs || 10000);
      const headers = chatConfig.api?.headers || {};
      const payload = chatConfig.api?.payload || {};
      const response = await axios({
        url: endpoint,
        method,
        timeout,
        headers,
        data: method === 'GET' ? undefined : payload,
        params: method === 'GET' ? payload : undefined,
      });
      const path = chatConfig.api?.responsePath || 'message';
      const msg = getValueByPath(response?.data, path);
      if (!msg) return null;
      return String(msg).trim();
    } catch (err) {
      log(`API 取消息失败: ${err.message}`, 'warning');
      return null;
    }
  }

  async function getNextMessage() {
    let msg = null;
    if (chatConfig.source === 'api') {
      msg = await pickMessageFromApi();
      if (!msg && uniquePool.length > 0) {
        msg = await claimFromGlobalPool();
      }
    } else if (uniquePool.length > 0) {
      msg = await claimFromGlobalPool();
    }
    if (!msg) return null;
    return msg.slice(0, 350);
  }

  async function clickRandomGuildOrDM(page) {
    // 左侧服务器栏（圆形图标），或私信列表
    const clicked = await page.evaluate(() => {
      const servers = Array.from(document.querySelectorAll('[data-list-id="guildsnav"] [role="treeitem"]'));
      const dms = Array.from(document.querySelectorAll('[data-list-id="private-channels"] [role="treeitem"]'));
      const all = [...servers, ...dms];
      if (all.length === 0) return false;
      const target = all[Math.floor(Math.random() * all.length)];
      target.click();
      return true;
    });
    if (clicked) {
      log('已点击左侧服务器/私信', 'info');
      await delay(2000 + Math.random() * 2000);
    }
  }

  async function clickRandomChannel(page) {
    // 频道列表 role="treeitem"
    const clicked = await page.evaluate(() => {
      const channels = Array.from(document.querySelectorAll('nav [role="treeitem"]'));
      if (channels.length === 0) return false;
      const target = channels[Math.floor(Math.random() * channels.length)];
      target.click();
      return true;
    });
    if (clicked) {
      log('已点击频道', 'info');
      await delay(2000 + Math.random() * 2000);
    }
  }

  async function clickChannelByName(page, channelName) {
    if (!channelName) return false;
    const clicked = await page.evaluate((name) => {
      const nodes = Array.from(document.querySelectorAll('nav [role="treeitem"]'));
      const normalized = String(name).trim().toLowerCase();
      const target = nodes.find((el) => {
        const text = (el.textContent || '').trim().toLowerCase();
        return text.includes(normalized);
      });
      if (!target) return false;
      target.scrollIntoView({ block: 'center' });
      target.click();
      return true;
    }, channelName);
    if (clicked) {
      log(`已按名称点击频道: ${channelName}`, 'info');
      await delay(channelOpenWaitMs);
    }
    return clicked;
  }

  async function openChannelByTarget(page, target) {
    if (!target) return false;

    if (scenarioConfig.navigationMode === 'url_first') {
      const url = getChannelUrl(target);
      if (url) {
        try {
          await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
          await delay(channelOpenWaitMs);
          log(`已通过 URL 打开频道: ${url}`, 'info');
          return true;
        } catch (err) {
          log(`URL 打开频道失败，尝试名称匹配: ${err.message}`, 'warning');
        }
      }
      return clickChannelByName(page, target.name);
    }

    // pinned_first: 先名称点击，失败再 URL
    const byName = await clickChannelByName(page, target.name);
    if (byName) return true;
    const url = getChannelUrl(target);
    if (!url) return false;
    try {
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
      await delay(channelOpenWaitMs);
      log(`名称匹配失败，已通过 URL 打开频道: ${url}`, 'info');
      return true;
    } catch (err) {
      log(`URL 兜底也失败: ${err.message}`, 'warning');
      return false;
    }
  }

  async function sendMessage(page, content) {
    if (!content) return false;
    const editableSelectors = [
      '[role="textbox"][contenteditable="true"]',
      'div[contenteditable="true"][data-slate-editor="true"]',
      'main form div[contenteditable="true"]'
    ];

    let selectorFound = null;
    for (const sel of editableSelectors) {
      const el = await page.$(sel);
      if (el) {
        selectorFound = sel;
        break;
      }
    }

    if (!selectorFound) {
      log('未找到可输入的聊天框，跳过发送', 'warning');
      return false;
    }

    // 使用真实键盘输入，避免 execCommand 在 Slate/React 输入框中不同步
    await page.click(selectorFound, { clickCount: 1 });
    await delay(180 + Math.random() * 220);

    const modKey = process.platform === 'darwin' ? 'Meta' : 'Control';
    await page.keyboard.down(modKey);
    await page.keyboard.press('KeyA');
    await page.keyboard.up(modKey);
    await page.keyboard.press('Backspace');
    await delay(80 + Math.random() * 120);

    await page.keyboard.type(content, { delay: 22 + Math.floor(Math.random() * 36) });
    await delay(220 + Math.random() * 280);
    await page.keyboard.press('Enter');
    await delay(900 + Math.random() * 1000);

    // 若 Enter 未触发发送，尝试点击发送按钮兜底
    const stillHasDraft = await page.evaluate((msg) => {
      const box = document.querySelector('[role="textbox"][contenteditable="true"]')
        || document.querySelector('div[contenteditable="true"][data-slate-editor="true"]')
        || document.querySelector('main form div[contenteditable="true"]');
      if (!box) return false;
      const text = (box.textContent || '').trim();
      return text.length > 0 && (text === msg.trim() || text.includes(msg.trim()));
    }, content);

    if (stillHasDraft) {
      const clickedSendBtn = await page.evaluate(() => {
        const byAria = Array.from(document.querySelectorAll('button[aria-label], div[role="button"][aria-label]'));
        const sendBtn = byAria.find((el) => {
          const label = (el.getAttribute('aria-label') || '').toLowerCase();
          return label.includes('send') || label.includes('发送');
        });
        if (sendBtn) {
          sendBtn.click();
          return true;
        }
        const formSubmit = document.querySelector('form button[type="submit"]');
        if (formSubmit) {
          formSubmit.click();
          return true;
        }
        return false;
      });
      if (clickedSendBtn) {
        await delay(800 + Math.random() * 900);
      }
    }

    log(`已发送消息: ${content}`, 'info');
    return true;
  }

  async function runVisitTargets(page) {
    const targets = Array.isArray(scenarioConfig.visitTargets) ? scenarioConfig.visitTargets : [];
    if (targets.length === 0) return false;

    log(`开始访问指定频道，共 ${targets.length} 个`, 'info');
    let openedAny = false;
    for (const t of targets) {
      const opened = await openChannelByTarget(page, t);
      if (!opened) {
        log('目标频道打开失败，继续下一个', 'warning');
        continue;
      }
      openedAny = true;
      const mainSelector = await findScrollableMainSelector(page);
      await smoothScrollInElement(page, mainSelector);
      const readMs = safeRandomInt(scenarioConfig.visitReadMinMs, scenarioConfig.visitReadMaxMs);
      log(`阅读频道中... (${Math.floor(readMs / 1000)}秒)`, 'info');
      await delay(readMs);

      if (chatConfig.enabled && Math.random() < scenarioConfig.sendChanceInVisit) {
        const msg = await getNextMessage();
        if (!msg && uniquePool.length > 0 && chatConfig.source === 'array') {
          throw makePoolExhaustedError();
        }
        if (msg) {
          await sendMessage(page, msg);
        }
      }
    }
    return openedAny;
  }

  async function runFocusChat(page) {
    if (!chatConfig.enabled) return false;
    const focus = scenarioConfig.focusTarget;
    if (!focus || (!focus.channelId && !focus.name)) {
      log('未配置 focusTarget，跳过聚焦聊天', 'info');
      return false;
    }

    const opened = await openChannelByTarget(page, focus);
    if (!opened) {
      log('聚焦频道打开失败，跳过聊天', 'warning');
      return false;
    }

    const rounds = Math.max(1, Number(chatConfig.rounds || 1));
    log(`开始聚焦频道聊天，共 ${rounds} 轮`, 'info');
    for (let i = 0; i < rounds; i++) {
      const msg = await getNextMessage();
      if (!msg) {
        if (uniquePool.length > 0 && chatConfig.source === 'array') {
          throw makePoolExhaustedError();
        }
        log('未拿到可发送消息，提前结束聊天循环', 'warning');
        break;
      }
      await sendMessage(page, msg);
      const gap = safeRandomInt(chatConfig.minIntervalMs, chatConfig.maxIntervalMs);
      await delay(gap);
    }
    return true;
  }

  async function runLinkSequence(page) {
    if (!linkSequenceConfig.enabled) return false;
    const links = Array.isArray(linkSequenceConfig.links) ? linkSequenceConfig.links : [];
    if (links.length === 0) {
      log('linkSequence 已启用但 links 为空，跳过', 'warning');
      return false;
    }

    const workLinks = linkSequenceConfig.randomizeOrder ? shuffleArray(links) : [...links];
    log(`开始执行链接顺序聊天，共 ${workLinks.length} 个链接${linkSequenceConfig.randomizeOrder ? '（本轮已随机打乱）' : ''}`, 'info');
    let successCount = 0;

    for (let i = 0; i < workLinks.length; i++) {
      const item = workLinks[i];
      const url = String(item?.url || '').trim();
      if (!url) {
        log(`第 ${i + 1} 个链接为空，跳过`, 'warning');
        if (linkSequenceConfig.stopOnError) break;
        continue;
      }

      try {
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
        await delay(channelOpenWaitMs);
        log(`已打开链接(${i + 1}/${workLinks.length}): ${url}`, 'info');

        let msg = null;
        if (uniquePool.length > 0) {
          msg = await claimFromGlobalPool();
          if (!msg) {
            throw makePoolExhaustedError();
          }
        } else {
          msg = await getNextMessage();
          if (!msg) {
            log('当前链接未配置话术且无默认内容，跳过发送', 'warning');
          }
        }

        if (msg) {
          const sent = await sendMessage(page, msg);
          if (sent) successCount += 1;
        }

        const waitMs = resolveWaitMs(item);
        log(`链接停留等待 ${Math.floor(waitMs / 1000)} 秒`, 'info');
        await delay(waitMs);
      } catch (err) {
        if (err?.code === 'POOL_EXHAUSTED' || err?.message === 'MESSAGE_POOL_EXHAUSTED') {
          throw err;
        }
        log(`链接流程失败(${i + 1}/${workLinks.length}): ${err.message}`, 'warning');
        if (linkSequenceConfig.stopOnError) break;
      }
    }

    log(`链接顺序聊天完成，成功发送 ${successCount} 条`, 'success');
    return true;
  }

  async function findScrollableMainSelector(page) {
    // 优先聊天区滚动容器
    const selCandidates = [
      '[data-list-id="chat-messages"]',
      '[class*="scroller-"]',
      '[role="main"]'
    ];
    for (const sel of selCandidates) {
      const has = await page.$(sel);
      if (has) return sel;
    }
    return 'body';
  }

  try {
    log('开始 Discord 浏览任务', 'info');
    applyRuntimeInputOverrides();
    initUniquePool();

    const linkCount = Array.isArray(linkSequenceConfig.links) ? linkSequenceConfig.links.length : 0;
    if (
      linkSequenceConfig.enabled &&
      linkCount > 0 &&
      uniquePool.length > 0 &&
      poolSession &&
      poolSession.isExhausted(uniquePool)
    ) {
      log('话术池已在其他窗口用尽，本窗口不再执行 Discord', 'warning');
      throw makePoolExhaustedError();
    }

    const wsEndpoint = await resolveWsEndpoint(debugPort || wsUrl);

    // 连接浏览器（重试 8 次）
    const connectAttempts = 8;
    let lastErr;
    for (let i = 1; i <= connectAttempts; i++) {
      try {
        log(`连接浏览器 (第${i}/${connectAttempts}次)...`, 'info');
        browser = await puppeteer.connect({ browserWSEndpoint: wsEndpoint });
        break;
      } catch (err) {
        lastErr = err;
        log(`连接失败: ${err.message}`, 'warning');
        if (i < connectAttempts) await delay(4000);
      }
    }
    if (!browser) {
      throw lastErr || new Error('无法连接到浏览器 ws 端点');
    }

    log('等待浏览器初始化...', 'info');
    await delay(4000);

    const pages = await browser.pages();
    log(`浏览器已连接，当前有 ${pages.length} 个标签页`, 'info');

    page = await browser.newPage();
    await delay(2000);

    await page.setViewport({ width: 1920, height: 1080 });

    log(`正在打开 ${targetUrl}...`, 'info');
    await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 60000 });
    await delay(2000);

    await waitForPageStability(page);

    let scenarioWorked = false;
    const linkSequenceWorked = await runLinkSequence(page);
    if (linkSequenceWorked) {
      scenarioWorked = true;
    } else if (scenarioConfig.enabled) {
      log('开始执行指定频道场景...', 'info');
      const visited = await runVisitTargets(page);
      const chatted = await runFocusChat(page);
      scenarioWorked = visited || chatted;
    }

    if (!scenarioWorked) {
      log('指定频道场景未生效，回退到随机浏览模式', 'warning');
      const mainSelector = await findScrollableMainSelector(page);
      for (let i = 0; i < maxLoops; i++) {
        log(`浏览进度: ${i + 1}/${maxLoops}`, 'info');

        if (Math.random() < clickServerProbability) {
          await clickRandomGuildOrDM(page);
        }

        if (Math.random() < clickChannelProbability) {
          await clickRandomChannel(page);
        }

        // 滚动阅读
        await smoothScrollInElement(page, mainSelector);
        const readTime = Math.floor(Math.random() * (maxReadTime - minReadTime + 1)) + minReadTime;
        log(`阅读中... (${Math.floor(readTime / 1000)}秒)`, 'info');
        await delay(readTime);

        // 偶尔深度阅读
        if (Math.random() < 0.15) {
          const deepRead = Math.floor(Math.random() * (maxDeepReadTime - minDeepReadTime + 1)) + minDeepReadTime;
          log(`深度阅读... (${Math.floor(deepRead / 1000)}秒)`, 'info');
          // 深度阅读时也滚动几次内容区
          const deepScrolls = Math.max(2, Math.floor(deepRead / 5000)); // 大约每5秒滚一次
          for (let j = 0; j < deepScrolls; j++) {
            await smoothScrollInElement(page, mainSelector);
            const segment = deepRead / deepScrolls;
            await delay(segment);
          }
        }

        await randomDelay(minScrollDelay, maxScrollDelay);
      }
    }

    log('Discord 浏览任务完成', 'success');

    if (linkSequenceConfig.enabled && linkSequenceConfig.closeTabOnFinish && page && !page.isClosed()) {
      await page.close({ runBeforeUnload: false }).catch(() => {});
      log('链接任务完成，已关闭当前标签页', 'info');
    }
  } catch (error) {
    log(`任务失败: ${error.message}`, 'error');
    throw error;
  } finally {
    if (browser) {
      try {
        // 仅断开 Puppeteer 连接，不关闭窗口或标签页，窗口由控制器统一关闭
        await browser.disconnect();
        log('已断开浏览器连接（窗口由控制器关闭）', 'info');
      } catch (err) {
        log(`断开浏览器连接时出错: ${err.message}`, 'warning');
      }
    }
  }
};


