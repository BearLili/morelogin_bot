// metamask_wallet_utils.js - MetaMask Wallet 通用操作模块 (V3.0 - 稳定版)

const CONFIG = {
    EXTENSION_ID: 'nkbihfbeogaeaoehlefnkodbefgpgknn',
    PASSWORD: '' 
};

// 用于文本匹配的授权/确认关键词
const CONFIRM_KEYWORDS = [
    'Connect', '连接', 'Confirm', '确认',
    'Approve', '批准', 'Sign', '签名', 
    'Unlock', '解锁', 'Next', '下一步'
];

// ---------------------------------------------------
// 通用工具与配置
// ---------------------------------------------------

// 默认日志函数 (将被外部 setLogFunction 覆盖)
let customLogFunction = (message, level) => {
    const timestamp = new Date().toISOString().split('T')[1].slice(0, 12);
    console.log(`[${timestamp}] [MetaMask-UTIL - ${level.toUpperCase()}] ${message}`);
};

// 统一的日志调用接口
function log(message, level = 'info') {
    customLogFunction(message, level);
}

/**
 * 注入外部的日志函数，确保所有日志都被主脚本捕获。
 * @param {Function} logFunc - 主脚本提供的日志函数 (即 context.log)
 */
function setLogFunction(logFunc) {
    customLogFunction = (message, level) => {
        // 使用外部 logFunc，并加上工具类的前缀
        logFunc(`[MetaMask-UTIL] ${message}`, level.toLowerCase()); 
    };
    log(`日志系统已切换到主脚本代理模式`, 'INFO');
}

function setConfig(extensionId, password) {
    CONFIG.EXTENSION_ID = extensionId;
    CONFIG.PASSWORD = password;
    log(`钱包配置已设置: extensionId=${extensionId}`, 'SUCCESS');
}

const delay = (ms) => new Promise((res) => setTimeout(res, ms));

// ---------------------------------------------------
// 核心处理逻辑
// ---------------------------------------------------

/**
 * 查找、等待可用性并点击授权/签名按钮。
 * 包含规避 LavaMoat 的轮询等待逻辑。
 * @param {Page|Frame} context - Puppeteer 的 Page 或 Frame 对象
 * @param {string} description - 上下文描述（例如：'弹窗主页面' 或 'IFRAME'）
 */
async function findAndClickButton(context, description) {
    // 常用授权按钮的选择器
    const APPROVE_BUTTON_SELECTORS = [
        'button[data-testid="confirm-btn"]',
        'button[data-testid="page-container-footer-next"]',
        'button.btn-primary',
        'button.button--primary',
        'button[type="submit"]',
    ];
    // 常用取消/次要按钮的选择器 (避免误点)
    const CANCEL_BUTTON_SELECTORS = [
        'button[data-testid="cancel-btn"]',
        'button[data-testid="page-container-footer-cancel"]',
        'button.btn-secondary'
    ];
    
    const TIMEOUT = 15000; 
    let approveButton = null;
    let buttonText = 'N/A';
    
    log(`[${description}] 尝试通过选择器查找主按钮...`, 'INFO'); 
    
    // 1. 尝试通过选择器查找主操作按钮 (Quick Check)
    for (const selector of APPROVE_BUTTON_SELECTORS) {
        try {
            // 查找可见的按钮，500ms 快速超时
            const elementHandle = await context.waitForSelector(selector, { visible: true, timeout: 500 });
            if (elementHandle) {
                // 确保它不是一个取消按钮
                const isCancel = await context.evaluate((btn, selectors) => {
                    return selectors.some(sel => btn.matches(sel));
                }, elementHandle, CANCEL_BUTTON_SELECTORS);
                
                if (!isCancel) {
                     approveButton = elementHandle;
                     buttonText = await context.evaluate(btn => btn.textContent.trim(), approveButton);
                     log(`✅ [${description}] 通过选择器找到按钮 (Selector: ${selector}, Text: "${buttonText}")`, 'SUCCESS'); 
                     break;
                }
            }
        } catch (e) {
            // 快速查找失败，静默处理
        }
    }

    // 2. 如果未通过选择器找到，尝试通过文本匹配
    if (!approveButton) {
        log(`[${description}] 选择器查找失败，尝试进行文本匹配...`, 'WARNING');
        const buttons = await context.$$('button');
        
        for (const btn of buttons) {
            const text = await context.evaluate(el => el.textContent.trim(), btn);
            const isMatch = CONFIRM_KEYWORDS.some(keyword => text.includes(keyword));
            
            // 再次确保不是取消按钮
            const isCancel = await context.evaluate((btn, selectors) => {
                return selectors.some(sel => btn.matches(sel));
            }, btn, CANCEL_BUTTON_SELECTORS);

            if (isMatch && !isCancel) {
                approveButton = btn;
                buttonText = text;
                log(`✅ [${description}] 通过文本匹配找到按钮: "${buttonText}"`, 'SUCCESS'); 
                break;
            }
        }
    }

    if (!approveButton) {
        throw new Error(`致命错误：未在 ${description} 中找到授权/签名按钮。`);
    }

    // 3. 等待按钮可用性 (LavaMoat 规避轮询)
    log(`[${description}] 等待按钮 "${buttonText}" 可用 (最多 ${TIMEOUT/1000} 秒)...`, 'INFO');

    const START_TIME = Date.now();
    const MAX_WAIT_TIME = TIMEOUT;
    let buttonAvailable = false;

    while (Date.now() - START_TIME < MAX_WAIT_TIME) {
        // 使用简单的 evaluate 检查禁用状态，避免 LavaMoat 冲突
        const isEnabled = await approveButton.evaluate(btn => {
            // 检查 disabled 属性和 aria-disabled 属性
            return !btn.disabled && btn.getAttribute('aria-disabled') !== 'true';
        }).catch(() => false);
        
        if (isEnabled) {
            buttonAvailable = true;
            log(`✅ [${description}] 按钮已变为可用状态。`, 'SUCCESS');
            break;
        }

        await delay(500); // 每 500ms 检查一次
    }

    if (!buttonAvailable) {
        log(`⚠️ [${description}] 在 ${MAX_WAIT_TIME / 1000} 秒内按钮仍不可用，尝试强制点击。`, 'WARNING');
    }

    // 4. 拟人化点击
    const clickDelay = 50 + Math.random() * 150; // 50ms 到 200ms 的随机点击延迟
    await approveButton.click({ delay: clickDelay }).catch(e => {
        log(`❌ [${description}] 强制点击失败: ${e.message}`, 'ERROR');
        throw new Error(`无法点击按钮: ${e.message}`);
    });

    log(`✅ [${description}] 授权/签名按钮 "${buttonText}" 已点击。`, 'SUCCESS');
}

/**
 * 处理 MetaMask 授权/签名/连接的弹窗页面 (包含 IFRAME 鲁棒性)
 */
async function processPopupPage(popupPage) {
    const popupUrl = popupPage.url();
    log(`--- 开始处理 MetaMask 独立钱包弹窗: ${popupUrl} ---`, 'WARNING');
    
    try {
        // 1. 等待页面导航完成，确保内容加载 (容错捕获)
        await popupPage.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
        await delay(1500); // 增加加载后等待时间

        let targetContexts = [popupPage]; 
        
        // 2. 尝试穿透 IFRAME，增加上下文
        const iframeHandles = await popupPage.$$('iframe');
        if (iframeHandles.length > 0) {
            log(`检测到 ${iframeHandles.length} 个 IFRAME，将尝试穿透查找。`, 'INFO');
            for (const handle of iframeHandles) {
                const frame = await handle.contentFrame();
                if (frame) {
                    targetContexts.push(frame); 
                }
            }
        } else {
            log('未检测到 IFRAME，仅在弹窗主页面查找。', 'INFO');
        }
        
        // 3. 遍历主页面和所有 IFRAME 查找并点击
        let foundButton = false;
        for (const context of targetContexts) {
            const description = context === popupPage ? '弹窗主页面' : 'IFRAME';
            try {
                await findAndClickButton(context, description);
                foundButton = true;
                break; // 找到并点击成功即跳出
            } catch (e) {
                log(`在 ${description} 中查找按钮失败: ${e.message}。继续尝试下一个上下文...`, 'INFO'); 
            }
        }
        
        if (!foundButton) {
            throw new Error('致命错误：未在任何页面或 IFRAME 中找到可点击的授权/签名按钮。');
        }

        log('授权/签名按钮已点击，等待弹窗关闭...', 'INFO');
        await delay(5000); // 等待扩展程序处理点击
        
    } catch (error) {
        log(`❌ 处理 MetaMask 授权弹窗失败: ${error.message}`, 'ERROR');
        throw error; 
    }
}

/**
 * 钱包解锁流程 (精简，移除不必要的 checkConfig 调用)
 */
async function unlockWallet(page) {
    const UNLOCK_URL = `chrome-extension://${CONFIG.EXTENSION_ID}/home.html#unlock`;
    log('--- 开始执行钱包解锁流程 ---', 'INFO');
    
    // 导航到解锁页面
    try {
        await page.goto(UNLOCK_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
    } catch (e) {
        throw new Error(`无法打开 MetaMask 解锁页面: ${e.message}`);
    }

    await delay(2000);

    // 查找密码输入框
    const passwordInput = await page.waitForSelector('input[type="password"]', { visible: true, timeout: 15000 }).catch(() => null);

    if (!passwordInput) {
        log('未找到密码输入框，假设钱包已解锁或页面结构不同', 'WARNING');
        return; 
    }

    // 输入密码
    await passwordInput.type(CONFIG.PASSWORD, { delay: 50 });
    await delay(500);

    // 查找解锁按钮
    const unlockButton = await page.evaluateHandle(() => {
        const buttons = Array.from(document.querySelectorAll('button'));
        return buttons.find(btn => {
            const text = btn.textContent.trim().toLowerCase();
            return text.includes('unlock') || text.includes('解锁') || text.includes('登录');
        });
    });

    if (!unlockButton || !unlockButton.asElement()) {
        throw new Error('未找到解锁按钮');
    }
    const buttonElement = unlockButton.asElement();

    // 拟人化点击
    await buttonElement.click({ delay: 50 + Math.random() * 150 });
    log('已点击解锁按钮', 'SUCCESS');

    await delay(3000);
    log('钱包解锁流程完成', 'SUCCESS');
}

// ---------------------------------------------------
// 导出接口
// ---------------------------------------------------

module.exports = {
    setConfig,
    setLogFunction,
    unlockWallet,
    processPopupPage,
};