/**
 * OptimAI Dashboard 脚本
 * 直接打开指定扩展页面并点击 "Go to Dashboard" 按钮
 */

const puppeteer = require('puppeteer-core');
const axios = require('axios');

// 扩展 ID 和地址
const EXTENSION_ID = 'njlfcjdojmopagogfpjgcbnpmiknapnd';
const EXTENSION_URL = `chrome-extension://${EXTENSION_ID}/popup/index.html#/home`;

module.exports = async function execute(context) {
  const { wsUrl, debugPort, log } = context;

  let browser;
  let extensionPage = null;
  let dashboardPage = null;
  let hasError = false;

  const delay = (ms) => new Promise((res) => setTimeout(res, ms));

  async function resolveWsEndpoint(portOrUrl) {
    if (typeof portOrUrl === 'string' && portOrUrl.startsWith('ws://')) return portOrUrl;
    const port = typeof portOrUrl === 'number' ? portOrUrl : parseInt(portOrUrl, 10);
    if (Number.isNaN(port)) throw new Error('未提供有效的 debugPort');
    const url = `http://127.0.0.1:${port}/json/version`;
    try {
      const res = await axios.get(url, { timeout: 3000 });
      if (res.data && res.data.webSocketDebuggerUrl) return res.data.webSocketDebuggerUrl;
    } catch (_) {
      return `ws://127.0.0.1:${port}/devtools/browser`;
    }
  }

  async function openExtension() {
    log('开始打开扩展...', 'info');
    log(`扩展地址: ${EXTENSION_URL}`, 'info');
    
    try {
      // 检查是否已有扩展页面打开
      const existingPages = await browser.pages();
      for (const page of existingPages) {
        const url = page.url();
        if (url.startsWith(`chrome-extension://${EXTENSION_ID}/`)) {
          log(`✅ 发现已打开的扩展页面: ${url}`, 'success');
          extensionPage = page;
          await page.setViewport({ width: 400, height: 600 });
          return true;
        }
      }
      
      // 创建新的扩展页面
      log('创建新的扩展页面...', 'info');
      const page = await browser.newPage();
      await page.setViewport({ width: 400, height: 600 });
      
      log(`导航到扩展地址: ${EXTENSION_URL}`, 'info');
      await page.goto(EXTENSION_URL, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await delay(3000); // 等待页面加载
      
      const pageUrl = page.url();
      if (pageUrl.startsWith(`chrome-extension://${EXTENSION_ID}/`)) {
        log(`✅ 成功打开扩展: ${pageUrl}`, 'success');
        extensionPage = page;
        return true;
      } else {
        log(`⚠️ 页面 URL 不匹配: ${pageUrl}`, 'warning');
        return false;
      }
    } catch (e) {
      log(`打开扩展失败: ${e.message}`, 'error');
      return false;
    }
  }

  async function clickGoToDashboard() {
    if (!extensionPage) return false;
    
    log('查找 "Go to Dashboard" 按钮...', 'info');
    
    // 按钮的类名选择器（根据你提供的 HTML）
    // 注意：CSS选择器中的类名如果包含空格或其他特殊字符，需要正确处理。这里简化选择器以提高匹配率
    const buttonSelector = 'button.bg-main.text-primary-foreground';
    
    try {
      // 等待按钮出现
      const button = await extensionPage.waitForSelector(buttonSelector, { timeout: 10000 }).catch(() => null);
      
      if (button) {
        const buttonText = await extensionPage.evaluate(btn => btn.textContent, button);
        log(`找到可能的目标按钮，文本内容: "${buttonText}"`, 'info');
        
        if (buttonText.includes('Go to Dashboard')) {
            log(`✅ 确认按钮文本匹配`, 'success');
            
            // 点击按钮
            await button.click();
            log('✅ 已点击 "Go to Dashboard" 按钮', 'success');
            return true;
        }
      }
      
      // 如果 selector 找不到，尝试通过文本查找 (备用方案)
      log('尝试通过文本查找按钮...', 'info');
      const foundByText = await extensionPage.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button'));
        const targetBtn = buttons.find(b => b.textContent.includes('Go to Dashboard'));
        if (targetBtn) {
          targetBtn.click();
          return true;
        }
        return false;
      });
      
      if (foundByText) {
        log('✅ 通过文本找到并点击了按钮', 'success');
        return true;
      }
      
      log('❌ 未找到 "Go to Dashboard" 按钮', 'warning');
      return false;
      
    } catch (e) {
      log(`点击按钮失败: ${e.message}`, 'error');
      return false;
    }
  }

  try {
    log('解析浏览器 ws 端点...', 'info');
    const wsEndpoint = await resolveWsEndpoint(debugPort || wsUrl);
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
    await delay(4000);

    // 1. 打开扩展
    const extensionOpened = await openExtension();
    
    if (extensionOpened && extensionPage) {
      // 2. 点击按钮
      const clicked = await clickGoToDashboard();
      
      if (clicked) {
        log('等待新页面打开...', 'info');
        await delay(8000); // 等待页面打开
        
        // 尝试找到新打开的 Dashboard 页面
        const pages = await browser.pages();
        const newDashboardPage = pages.find(p => p.url().includes('dashboard'));
        
        if (newDashboardPage) {
            dashboardPage = newDashboardPage;
            log(`✅ Dashboard 页面已打开: ${dashboardPage.url()}`, 'success');
        } else {
            log('⚠️ 未检测到新打开的 Dashboard 页面，请手动检查', 'warning');
        }
      }
    } else {
      log('⚠️ 扩展未能打开', 'error');
    }

    log('OptimAI Dashboard 任务完成', 'success');
    log('注意: 扩展页面和 Dashboard 页面将保持打开状态', 'info');

  } catch (error) {
    hasError = true;
    log(`❌ 任务失败: ${error.message}`, 'error');
    if (error.stack) {
      log(`错误堆栈: ${error.stack}`, 'error');
    }
    throw error;
  } finally {
    if (hasError) {
      log('发生错误，保留浏览器窗口以便查看问题', 'warning');
      if (browser) {
        await browser.disconnect();
      }
    } else {
      log('已断开浏览器连接（窗口由控制器关闭）', 'info');
      if (browser) {
        await browser.disconnect();
      }
    }
  }
};
