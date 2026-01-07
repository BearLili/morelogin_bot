// okx_wallet_utils.js - OKX Wallet 通用操作模块 (V2.5 - IFRAME 深度穿透版)

// 内部配置对象
const CONFIG = {
    EXTENSION_ID: 'mcohilncbfahbmgdjkbpemcciiolgcge',
    PASSWORD: 'sd3181940'
};

const LISTENER_HANDLERS = {};
const PROCESSING_TARGETS = new Set(); 

const CONFIRM_KEYWORDS = [
    'Connect', '连接', 'Confirm', '确认',
    'Approve', '批准', 'Sign', '签名', 
    'Verbinden', 'Bestätigen', 'Conectar', 'Confirmar'
];

// ---------------------------------------------------
// 通用工具与配置
// ---------------------------------------------------

function log(message, level = 'info') {
    const timestamp = new Date().toISOString().split('T')[1].slice(0, 12);
    let colorCode = '';

    switch (level) {
        case 'success': colorCode = '\x1b[32m'; break; // Green
        case 'warning': colorCode = '\x1b[33m'; break; // Yellow
        case 'error': colorCode = '\x1b[31m'; break; // Red
        case 'debug': colorCode = '\x1b[35m'; break; // Magenta
        default: colorCode = '\x1b[36m'; // Cyan for info
    }
    console.log(`${colorCode}[${timestamp}] [OKX-UTIL] ${message}\x1b[0m`);
}

function setConfig(extensionId, password) {
    CONFIG.EXTENSION_ID = extensionId;
    CONFIG.PASSWORD = password;
    log('钱包配置已设置。', 'success');
}

function checkConfig() {
    if (!CONFIG.EXTENSION_ID || !CONFIG.PASSWORD) {
        throw new Error("OKX Wallet 工具类配置错误：请先调用 setConfig(extensionId, password) 设置 ID 和密码。");
    }
}

const delay = (ms) => new Promise((res) => setTimeout(res, ms));


// ---------------------------------------------------
// Target 追踪管理
// ---------------------------------------------------

function isTargetProcessing(url) {
    return PROCESSING_TARGETS.has(url);
}

function markTargetProcessing(url) {
    PROCESSING_TARGETS.add(url);
    log(`[Target Tracker] 标记处理中: ${url}`, 'debug');
}

function unmarkTargetProcessing(url) {
    PROCESSING_TARGETS.delete(url);
    log(`[Target Tracker] 移除处理标记: ${url}`, 'debug');
}

// ---------------------------------------------------
// 核心处理逻辑 (独立弹窗页面)
// ---------------------------------------------------

async function findAndClickButton(context, description) {
    const APPROVE_BUTTON_SELECTORS = [
        'button[data-testid="okd-button-primary"]', 
        'button[data-testid="okd-button"]',         
        'button[type="submit"]',                    
    ];
    const TIMEOUT = 15000; 

    let approveButton = null;
    let buttonText = 'N/A';
    
    for (const selector of APPROVE_BUTTON_SELECTORS) {
        try {
            approveButton = await context.waitForSelector(selector, { 
                visible: true, 
                timeout: 3000 
            });
            if (approveButton) {
                buttonText = await context.evaluate(btn => btn.textContent.trim(), approveButton);
                log(`✅ 在 ${description} 中找到按钮 (Selector: ${selector}, Text: "${buttonText}")`, 'info');
                break;
            }
        } catch (e) {
            log(`选择器 ${selector} 查找失败。`, 'debug');
        }
    }

    if (!approveButton) {
        log(`❌ 选择器未找到，尝试在 ${description} 中进行文本匹配...`, 'warning');
        const buttons = await context.$$('button');
        for (const btn of buttons) {
            const text = await context.evaluate(el => el.textContent.trim(), btn);
            const isMatch = CONFIRM_KEYWORDS.some(keyword => text.includes(keyword));
            
            if (isMatch) {
                approveButton = btn;
                buttonText = text;
                log(`✅ 通过文本匹配找到按钮: "${buttonText}"`, 'info');
                break;
            }
        }
    }

    if (!approveButton) {
        throw new Error(`致命错误：未在 ${description} 中找到授权/签名按钮。`);
    }

    log(`等待按钮 "${buttonText}" 可用 (最多 ${TIMEOUT/1000} 秒)...`, 'info');
    await context.waitForFunction(
        (btn) => !btn.disabled && btn.getAttribute('aria-disabled') !== 'true' && btn.offsetWidth > 0,
        { timeout: TIMEOUT },
        approveButton
    ).catch((e) => {
         log(`⚠️ 按钮可用性检查超时，尝试强制点击: ${e.message}`, 'warning');
    });

    await approveButton.click();
    log(`✅ 授权/签名按钮 "${buttonText}" 已点击。`, 'success');
}


async function processPopupPage(popupPage) {
    const popupUrl = popupPage.url();
    log(`🚨 开始处理独立钱包弹窗: ${popupUrl}`, 'warning');
    
    try {
        log('等待弹窗页面加载完毕...', 'info');
        await popupPage.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
        await delay(3000); 

        let targetContexts = [popupPage]; 
        let foundButton = false;
        
        log('尝试查找并穿透所有 IFRAME...', 'info');
        const iframeHandles = await popupPage.$$('iframe');
        
        if (iframeHandles.length > 0) {
            log(`找到 ${iframeHandles.length} 个 IFRAME，尝试逐一穿透。`, 'debug');
            for (const handle of iframeHandles) {
                const frame = await handle.contentFrame();
                if (frame) {
                    targetContexts.push(frame); 
                }
            }
        } else {
             log('未找到 IFRAME，仅在弹窗主页面查找。', 'warning');
        }

        for (const context of targetContexts) {
            const description = context === popupPage ? '弹窗主页面' : 'IFRAME';
            try {
                await findAndClickButton(context, description);
                foundButton = true;
                break; 
            } catch (e) {
                log(`在 ${description} 中查找失败: ${e.message}`, 'debug');
            }
        }
        
        if (!foundButton) {
            throw new Error('致命错误：未在任何页面或 IFRAME 中找到可点击的授权/签名按钮。');
        }

        log('等待弹窗关闭或页面变化...', 'info');
        await popupPage.waitForNavigation({ timeout: 10000 }).catch(() => {
            log('弹窗可能已自动关闭或完成操作。', 'info');
        });
        
    } catch (error) {
        log(`❌ 处理授权弹窗失败: ${error.message}`, 'error');
        throw error; 
    }
}

// ---------------------------------------------------
// 其他模块逻辑 (解锁、Overlay、监听器)
// ---------------------------------------------------

async function unlockWallet(page) {
    checkConfig(); 
    const UNLOCK_URL = `chrome-extension://${CONFIG.EXTENSION_ID}/popup.html#/unlock`;
    log('--- [Wallet Unlock] 开始执行钱包解锁流程 ---', 'info');
    try {
        await page.goto(UNLOCK_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
        log('导航到解锁页成功。', 'info');
    } catch (e) {
        log(`导航到 ${UNLOCK_URL} 失败: ${e.message}`, 'error');
        throw new Error("无法打开钱包解锁页面，请检查扩展ID或钱包状态。");
    }
    log('等待 5 秒，确保页面稳定。', 'warning');
    await delay(5000); 
    try {
        await page.focus('input[type="password"], input[data-testid*="password"]');
        log('显式设置密码输入框焦点成功。', 'info');
    } catch (e) {
        log('无法显式设置焦点，依赖自动焦点。', 'warning');
    }
    await page.keyboard.type(CONFIG.PASSWORD, { delay: 50 }); 
    log('密码填充完成。', 'info');
    await page.keyboard.press('Enter');
    log('模拟按下 Enter 键解锁钱包。', 'info');
    await delay(3000); 
    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {
        log('解锁后的导航等待结束或未发生主页面跳转。', 'info');
    });
    log('✅ [Wallet Unlock] 钱包已解锁。', 'success');
    setupUnlockPageConnectionListener(page);
}

function setupUnlockPageConnectionListener(page) {
    if (LISTENER_HANDLERS.unlockPageInterval) clearInterval(LISTENER_HANDLERS.unlockPageInterval);
    const checkUnlockConnectionButton = async () => {
        try {
            const currentUrl = page.url();
            if (currentUrl.includes('/connect/') || currentUrl.includes('#/connect/')) {
                const buttonSelector = 'button[data-testid="okd-button"]';
                const button = await page.$(buttonSelector).catch(() => null);
                if (button) {
                    const buttonText = await page.evaluate(btn => btn.textContent.trim(), button);
                    const isConnectionButton = CONFIRM_KEYWORDS.some(keyword => buttonText.includes(keyword));
                    if (isConnectionButton || currentUrl.includes('/connect/')) {
                        const isEnabled = await page.evaluate((btn) => !btn.disabled && btn.getAttribute('aria-disabled') !== 'true' && btn.offsetWidth > 0, button).catch(() => false);
                        if (isEnabled) {
                            await button.click();
                            log(`✅ 已在解锁页面点击连接确认按钮: "${buttonText}"`, 'success');
                            clearInterval(LISTENER_HANDLERS.unlockPageInterval); 
                            delete LISTENER_HANDLERS.unlockPageInterval;
                            return true;
                        } else {
                            log('⚠️ 连接确认按钮找到，但尚未可用。', 'debug');
                        }
                    }
                }
            }
        } catch (e) {
            log(`[Check Unlock Error] ${e.message}`, 'debug');
        }
        return false;
    };
    LISTENER_HANDLERS.unlockPageInterval = setInterval(checkUnlockConnectionButton, 500);
    log('✅ 解锁页面连接确认监听已设置（500ms 检查）。', 'info');
}

async function processOverlayPopup(mainPage) {
    log('🔍 尝试在主页面 DOM 中查找全屏覆盖的 OKX 授权窗口...', 'warning');
    const OVERLAY_CONTAINER_SELECTORS = [
        '#okx-wallet-root',
        'div[id^="okx-extension-content"]',
        'div[data-testid="extension-overlay"]',
        'div[aria-modal="true"][role="dialog"]' 
    ];
    let container = null;
    for (const selector of OVERLAY_CONTAINER_SELECTORS) {
        try {
            container = await mainPage.waitForSelector(selector, { visible: true, timeout: 1000 }); 
            if (container) {
                log(`✅ 找到 OKX 弹窗容器: ${selector}`, 'info');
                break;
            }
        } catch (e) {}
    }
    if (!container) throw new Error("未找到全屏覆盖的 OKX 授权容器。");

    const APPROVE_BUTTON_SELECTORS = [
        'button[data-testid="okd-button-primary"]', 
        'button[data-testid="okd-button"]',         
        'button[type="submit"]',
        'button' 
    ];
    let clicked = false;
    for (const selector of APPROVE_BUTTON_SELECTORS) {
        try {
            const buttons = await container.$$(selector); 
            for (const btn of buttons) {
                const text = await mainPage.evaluate(el => el.textContent.trim(), btn);
                const isMatch = CONFIRM_KEYWORDS.some(keyword => text.includes(keyword));
                if (isMatch || (text && (selector.includes('primary') || selector.includes('submit')))) {
                    const isEnabled = await mainPage.evaluate(el => !el.disabled && el.offsetWidth > 0 && el.offsetHeight > 0, btn);
                    if (isEnabled) {
                        log(`✅ 在 Overlay 中找到并点击按钮: "${text}" (Selector: ${selector})`, 'success');
                        await btn.click({ delay: 100 });
                        clicked = true;
                        await delay(3000); 
                        return true; 
                    }
                }
            }
        } catch (e) {}
    }
    if (!clicked) throw new Error("在 OKX 容器中未找到可点击的授权/签名按钮。");
    return false;
}

async function handleWalletPopups(browser) {
    checkConfig(); 
    if (LISTENER_HANDLERS.targetCreated) return;
    const targetCreatedListener = async (target) => {
        const targetUrl = target.url();
        const targetType = target.type();
        if (targetUrl.startsWith(`chrome-extension://${CONFIG.EXTENSION_ID}/`) && targetType === 'page') {
            log(`🚨 捕获到 Target Created 钱包弹窗: ${targetUrl}`, 'warning');
            try {
                const popupPage = await target.page();
                if (popupPage) {
                    if (!isTargetProcessing(targetUrl)) {
                        markTargetProcessing(targetUrl);
                        await processPopupPage(popupPage);
                        unmarkTargetProcessing(targetUrl);
                    }
                }
            } catch (error) {
                log(`❌ Target 捕获处理失败: ${error.message}`, 'error');
            }
        }
    };
    browser.on('targetcreated', targetCreatedListener);
    LISTENER_HANDLERS.targetCreated = targetCreatedListener;
    log('✅ 弹窗监听机制已设置 (后台兜底)。', 'success');
}

function stopHandlers(browser) {
    log('--- [Cleanup] 清理所有钱包工具监听器和定时器 ---', 'info');
    if (LISTENER_HANDLERS.targetCreated) {
        browser.off('targetcreated', LISTENER_HANDLERS.targetCreated);
        delete LISTENER_HANDLERS.targetCreated;
    }
    if (LISTENER_HANDLERS.unlockPageInterval) {
        clearInterval(LISTENER_HANDLERS.unlockPageInterval);
        delete LISTENER_HANDLERS.unlockPageInterval;
    }
    log('✅ 所有监听器和定时器清理完成。', 'success');
}

module.exports = {
    setConfig,
    unlockWallet,
    handleWalletPopups,
    stopHandlers,
    processPopupPage,
    processOverlayPopup,
    isTargetProcessing,
    markTargetProcessing,
    unmarkTargetProcessing
};