/**
 * Outlook 访问脚本
 *
 * 行为：
 * 1. 打开 https://outlook.live.com/mail/0/
 * 2. 等待页面加载完成
 * 3. 额外等待 10 秒
 * 4. 断开连接（窗口由控制器关闭）
 */

const puppeteer = require('puppeteer-core');
const axios = require('axios');

module.exports = async function execute(context) {
  const { wsUrl, debugPort, log } = context;

  const targetUrl = 'https://outlook.live.com/mail/0/';
  const waitAfterLoadMs = 10000;

  let browser;
  let page;

  const delay = (ms) => new Promise((res) => setTimeout(res, ms));

  // 解析 WebSocket 端点
  async function resolveWsEndpoint(portOrUrl) {
    if (typeof portOrUrl === 'string' && portOrUrl.startsWith('ws://')) return portOrUrl;
    const port = typeof portOrUrl === 'number' ? portOrUrl : parseInt(portOrUrl, 10);
    if (Number.isNaN(port)) throw new Error('未提供有效的 debugPort');
    const url = `http://127.0.0.1:${port}/json/version`;
    try {
      const res = await axios.get(url, { timeout: 3000 });
      if (res.data && res.data.webSocketDebuggerUrl) return res.data.webSocketDebuggerUrl;
    } catch (_) {
      // ignore, fallback
    }
    return `ws://127.0.0.1:${port}/devtools/browser`;
  }

  try {
    log('开始 Outlook 访问任务', 'info');
    const wsEndpoint = await resolveWsEndpoint(debugPort || wsUrl);

    // 连接浏览器（最多 8 次重试）
    let lastErr;
    for (let i = 1; i <= 8; i++) {
      try {
        log(`连接浏览器 (第${i}/8次)...`, 'info');
        browser = await puppeteer.connect({ browserWSEndpoint: wsEndpoint });
        break;
      } catch (err) {
        lastErr = err;
        log(`连接失败: ${err.message}`, 'warning');
        if (i < 8) await delay(4000);
      }
    }
    if (!browser) throw lastErr || new Error('无法连接到浏览器 ws 端点');

    log('等待浏览器初始化...', 'info');
    await delay(3000);

    page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });

    log(`正在打开 ${targetUrl}...`, 'info');
    await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 60000 });

    // 等待页面主要区域（如果有）
    await page.waitForSelector('[role="main"]', { timeout: 15000 }).catch(() => {});

    log(`页面加载完成，等待 ${waitAfterLoadMs / 1000} 秒...`, 'info');
    await delay(waitAfterLoadMs);

    log('Outlook 访问任务完成', 'success');
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


