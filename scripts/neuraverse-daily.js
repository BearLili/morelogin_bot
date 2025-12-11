/**
 * Neuraverse 日常任务脚本
 *
 * 步骤：
 * 1. 打开 https://neuraverse.neuraprotocol.io/?section=leaderboard
 * 2. 从 cookie 中提取 privy-id-token 作为 Bearer Token（或监听 sessions 接口）
 * 3. 每日打卡：POST /api/tasks/daily_login/claim
 * 4. 收集脉冲：依次调用 pulse:1~pulse:7 的 collect 接口（逐个、可重试）
 * 5. 收集完成后调用 /api/tasks/collect_all_pulses/claim
 * 6. 记录全部成功/失败结果
 *
 * 依赖：puppeteer-core（已在 package.json 声明）
 */

const puppeteer = require('puppeteer-core');
const axios = require('axios');

module.exports = async function execute(context) {
  const { wsUrl, debugPort, log } = context;

  // 可调参数
  const baseUrl = 'https://neuraverse.neuraprotocol.io/?section=leaderboard';
  const apiBase = 'https://neuraverse-testnet.infra.neuraprotocol.io/api';
  const maxAttempts = 3;
  const retryDelayMs = 5000; // 全局重试延时（更稳妥）
  const pulseIds = ['pulse:1', 'pulse:2', 'pulse:3', 'pulse:4', 'pulse:5', 'pulse:6', 'pulse:7'];

  let browser;

  const delay = (ms) => new Promise((res) => setTimeout(res, ms));

  async function resolveWsEndpoint(portOrUrl) {
    // 如果已经是 ws:// 直接返回
    if (typeof portOrUrl === 'string' && portOrUrl.startsWith('ws://')) {
      return portOrUrl;
    }
    const port = typeof portOrUrl === 'number' ? portOrUrl : parseInt(portOrUrl, 10);
    if (Number.isNaN(port)) {
      throw new Error('未提供有效的 debugPort');
    }
    // 优先通过 /json/version 获取完整 ws 端点
    const url = `http://127.0.0.1:${port}/json/version`;
    try {
      const res = await axios.get(url, { timeout: 3000 });
      if (res.data && res.data.webSocketDebuggerUrl) {
        return res.data.webSocketDebuggerUrl;
      }
    } catch (err) {
      // 忽略，走兜底
    }
    // 兜底：直接拼接（有些版本可用）
    return `ws://127.0.0.1:${port}/devtools/browser`;
  }

  async function withRetry(fn, label, attempts = maxAttempts) {
    let lastErr;
    for (let i = 1; i <= attempts; i++) {
      try {
        return await fn(i);
      } catch (err) {
        lastErr = err;
        log(`${label} 第${i}/${attempts}次失败: ${err.message}`, 'warning');
        if (i < attempts) {
          await delay(retryDelayMs);
        }
      }
    }
    throw lastErr;
  }

  async function getAuthToken(page) {
    // 优先从 cookie 中取 privy-id-token
    const cookies = await page.cookies();
    const privyCookie = cookies.find((c) => c.name === 'privy-id-token');
    if (privyCookie && privyCookie.value) {
      return privyCookie.value;
    }

    // 备用方案：尝试调用 sessions 接口获取 identity_token
    try {
      const sessionRes = await page.evaluate(async () => {
        const res = await fetch('https://privy.neuraprotocol.io/api/v1/sessions', {
          credentials: 'include',
        });
        return res.ok ? res.json() : null;
      });
      if (sessionRes && sessionRes.identity_token) {
        return sessionRes.identity_token;
      }
    } catch (err) {
      log(`获取 identity_token 失败: ${err.message}`, 'warning');
    }
    return null;
  }

  async function apiPost(page, endpoint, token, body = null) {
    return page.evaluate(
      async ({ url, token, body }) => {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            accept: 'application/json, text/plain, */*',
            authorization: `Bearer ${token}`,
            'content-type': body ? 'application/json' : undefined,
          },
          body: body ? JSON.stringify(body) : null,
          credentials: 'include',
        });
        const text = await res.text();
        let data;
        try {
          data = JSON.parse(text);
        } catch (_) {
          data = text;
        }
        if (!res.ok) {
          const msg = data?.message || res.statusText || '请求失败';
          throw new Error(`${res.status} ${msg}`);
        }
        return data;
      },
      { url: endpoint, token, body }
    );
  }

  try {
    log('解析浏览器 ws 端点...', 'info');
    const wsEndpoint = await resolveWsEndpoint(debugPort || wsUrl);

    // 多次重试连接 ws 端点（处理环境刚启动时的 404/连接拒绝）
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
        if (i < connectAttempts) {
          await delay(2500);
        }
      }
    }
    if (!browser) {
      throw lastErr || new Error('无法连接到浏览器 ws 端点');
    }
    
    // 等待浏览器完全初始化
    log('等待浏览器初始化...', 'info');
    await delay(2000);
    
    // 获取所有页面，确保浏览器已准备好
    const pages = await browser.pages();
    log(`浏览器已连接，当前有 ${pages.length} 个标签页`, 'info');

    // 创建新标签页
    log('创建新标签页...', 'info');
    const page = await browser.newPage();
    
    // 等待新标签页完全加载
    await delay(1500);

    log('在新标签页打开 Neuraverse 页面...', 'info');
    await page.goto(baseUrl, { waitUntil: 'networkidle2', timeout: 60000 });

    log('等待页面稳定并获取 token...', 'info');
    await delay(6000); // 更长等待，确保页面和登录态完全就绪
    const token = await getAuthToken(page);
    if (!token) {
      throw new Error('未获取到 privy-id-token，请确认已登录');
    }
    log('获取 token 成功', 'success');

    // Step 1: 每日打卡
    const dailyClaimUrl = `${apiBase}/tasks/daily_login/claim`;
    await withRetry(
      async (i) => {
        log(`每日打卡 第${i}次尝试...`, 'info');
        const res = await apiPost(page, dailyClaimUrl, token);
        log(`每日打卡成功: ${JSON.stringify(res).slice(0, 200)}`, 'success');
      },
      '每日打卡'
    );

    // Step 2: 收集脉冲
    const collectUrl = `${apiBase}/events`;
    for (const pid of pulseIds) {
      await withRetry(
        async (i) => {
          log(`收集 ${pid} 第${i}次尝试...`, 'info');
          const payload = { type: 'pulse:collectPulse', payload: { id: pid } };
          const res = await apiPost(page, collectUrl, token, payload);
          log(`收集 ${pid} 成功: ${JSON.stringify(res).slice(0, 200)}`, 'success');
        },
        `收集 ${pid}`
      );
      await delay(2000); // 控制节奏，避免过快
    }

    // Step 3: 收集完成后 claim
    const claimAllUrl = `${apiBase}/tasks/collect_all_pulses/claim`;
    await withRetry(
      async (i) => {
        log(`收集完成 Claim 第${i}次尝试...`, 'info');
        const res = await apiPost(page, claimAllUrl, token);
        log(`收集完成 Claim 成功: ${JSON.stringify(res).slice(0, 200)}`, 'success');
      },
      '收集完成 Claim'
    );

    log('Neuraverse 日常任务全部完成', 'success');
  } catch (error) {
    log(`任务失败: ${error.message}`, 'error');
    throw error;
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch (_) {
        // ignore
      }
    }
  }
};

