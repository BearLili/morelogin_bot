/**
 * Discord 浏览交互脚本
 *
 * 行为：
 * 1. 打开 https://discord.com/channels/@me
 * 2. 等待页面稳定
 * 3. 随机点击左侧服务器/私信条目
 * 4. 随机点击频道/会话
 * 5. 在聊天区域滚动、停顿阅读，模拟活跃
 *
 * 依赖：puppeteer-core（已在 package.json 声明）
 */

const puppeteer = require('puppeteer-core');
const axios = require('axios');

module.exports = async function execute(context) {
  const { wsUrl, debugPort, log } = context;

  // 可调参数
  const targetUrl = 'https://discord.com/channels/@me';
  const maxLoops = 5; // 主循环次数
  const minScrollDelay = 2500;
  const maxScrollDelay = 8000;
  const minReadTime = 4000;
  const maxReadTime = 15000;
  const minDeepReadTime = 8000;
  const maxDeepReadTime = 25000;
  const clickServerProbability = 0.6; // 点击左侧服务器/私信列表概率
  const clickChannelProbability = 0.7; // 点击频道概率
  const pageStabilityWait = 5000;

  let browser;
  let page;

  const delay = (ms) => new Promise((res) => setTimeout(res, ms));
  const randomDelay = (min, max) => delay(Math.floor(Math.random() * (max - min + 1)) + min);

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

    log('开始模拟浏览行为...', 'info');

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
        await delay(deepRead);
      }

      await randomDelay(minScrollDelay, maxScrollDelay);
    }

    log('Discord 浏览任务完成', 'success');
  } catch (error) {
    log(`任务失败: ${error.message}`, 'error');
    throw error;
  } finally {
    if (browser) {
      try {
        const pages = await browser.pages();
        for (const p of pages) {
          try {
            await p.close();
          } catch (_) {}
        }
        browser.disconnect();
        log('已断开浏览器连接（窗口由控制器关闭）', 'info');
      } catch (err) {
        log(`断开浏览器连接时出错: ${err.message}`, 'warning');
        try {
          await browser.close();
        } catch (_) {}
      }
    }
  }
};


