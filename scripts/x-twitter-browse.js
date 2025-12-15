/**
 * X.com (Twitter) 日常浏览脚本
 *
 * 模拟真实用户浏览行为：
 * 1. 打开 x.com/home
 * 2. 等待页面稳定加载
 * 3. 滚动页面，停顿假装阅读
 * 4. 随机点击文章查看详情
 * 5. 继续滚动和浏览
 * 6. 模拟真实的人类浏览模式
 *
 * 依赖：puppeteer-core（已在 package.json 声明）
 */

const puppeteer = require('puppeteer-core');

module.exports = async function execute(context) {
  const { wsUrl, debugPort, log } = context;

  // 可调参数
  const targetUrl = 'https://x.com/home';
  const maxScrollAttempts = 30; // 最大滚动次数（增加到30次，更真实的浏览时长）
  const minScrollDelay = 3000; // 最小滚动间隔（毫秒）- 增加到3秒
  const maxScrollDelay = 10000; // 最大滚动间隔（毫秒）- 增加到10秒
  const minReadTime = 5000; // 最小阅读时间（毫秒）- 增加到5秒
  const maxReadTime = 20000; // 最大阅读时间（毫秒）- 增加到20秒
  const articleClickProbability = 0.4; // 点击文章的概率（40%，更频繁的互动）
  const minArticleViewTime = 10000; // 查看文章的最小时间（毫秒）- 增加到10秒
  const maxArticleViewTime = 45000; // 查看文章的最大时间（毫秒）- 增加到45秒
  const pageStabilityWait = 5000; // 页面稳定等待时间（毫秒）

  let browser;
  let page;

  const delay = (ms) => new Promise((res) => setTimeout(res, ms));

  // 随机延迟
  const randomDelay = (min, max) => delay(Math.floor(Math.random() * (max - min + 1)) + min);

  // 随机滚动距离
  const randomScrollDistance = () => {
    // 随机滚动 200-800 像素
    return Math.floor(Math.random() * 600) + 200;
  };

  // 解析 WebSocket 端点
  async function resolveWsEndpoint(portOrUrl) {
    // 如果已经是完整的 ws:// URL，直接返回
    if (typeof portOrUrl === 'string' && portOrUrl.startsWith('ws://')) {
      return portOrUrl;
    }
    // 如果提供了 wsUrl，优先使用
    if (wsUrl && wsUrl.startsWith('ws://')) {
      return wsUrl;
    }
    // 否则从 debugPort 构建
    const port = typeof portOrUrl === 'number' ? portOrUrl : parseInt(debugPort, 10);
    if (Number.isNaN(port)) {
      throw new Error('未提供有效的 debugPort');
    }
    return `ws://127.0.0.1:${port}/devtools/browser`;
  }

  // 等待页面稳定
  async function waitForPageStability(page, timeout = 10000) {
    log('等待页面稳定加载...', 'info');
    
    // 等待主要内容加载
    try {
      await page.waitForSelector('article', { timeout: 10000 }).catch(() => {});
    } catch (e) {
      // 忽略，可能页面结构不同
    }
    
    // 等待网络空闲
    await delay(pageStabilityWait);
    
    // 额外等待确保稳定
    await delay(2000);
    log('页面已稳定', 'success');
  }

  // 平滑滚动
  async function smoothScroll(page, distance) {
    await page.evaluate((dist) => {
      window.scrollBy({
        top: dist,
        behavior: 'smooth'
      });
    }, distance);
    
    // 等待滚动动画完成
    await delay(800 + Math.random() * 400);
  }

  // 查找可点击的文章/推文
  async function findClickableArticles(page) {
    try {
      const articles = await page.evaluate(() => {
        // 查找所有文章容器（X.com 的推文通常在 article 标签中）
        const articleElements = Array.from(document.querySelectorAll('article'));
        const clickable = [];
        
        articleElements.forEach((article, index) => {
          // 查找文章内的链接（通常是推文详情链接）
          const link = article.querySelector('a[href*="/status/"]');
          if (link && link.href) {
            clickable.push({
              index,
              href: link.href,
              text: link.textContent?.substring(0, 50) || '推文'
            });
          }
        });
        
        return clickable;
      });
      
      return articles;
    } catch (error) {
      log(`查找文章失败: ${error.message}`, 'warning');
      return [];
    }
  }

  // 点击并查看文章
  async function viewArticle(page, article) {
    try {
      log(`点击查看文章: ${article.text}...`, 'info');
      
      // 点击文章链接（X.com 通常在当前页面打开详情）
      const currentUrl = page.url();
      
      // 查找并点击链接
      await page.evaluate((href) => {
        const link = Array.from(document.querySelectorAll('a[href*="/status/"]'))
          .find(a => a.href === href || a.href.includes(href.split('/status/')[1]?.split('?')[0]));
        if (link) {
          link.click();
        }
      }, article.href);
      
      // 等待页面跳转或内容加载
      await delay(3000);
      
      // 检查是否跳转到新页面
      const newUrl = page.url();
      const isNewPage = newUrl !== currentUrl;
      
      if (isNewPage) {
        log('正在查看文章详情...', 'info');
        
        // 等待文章内容加载
        await delay(2000);
        
        // 随机滚动查看文章内容（更真实的阅读行为）
        const viewTime = Math.floor(Math.random() * (maxArticleViewTime - minArticleViewTime + 1)) + minArticleViewTime;
        log(`预计查看时间: ${Math.floor(viewTime / 1000)}秒`, 'info');
        
        // 先停留一段时间阅读（30%的时间）
        await delay(Math.floor(viewTime * 0.3));
        
        // 然后滚动查看评论和回复（70%的时间）
        const scrollTime = Math.floor(viewTime * 0.7);
        const scrollCount = Math.floor(scrollTime / 3000); // 每3秒滚动一次
        
        for (let i = 0; i < scrollCount; i++) {
          await smoothScroll(page, randomScrollDistance());
          // 每次滚动后停留更长时间（2-5秒）
          await randomDelay(2000, 5000);
        }
        
        // 最后再停留一段时间（模拟看完后的思考）
        await delay(Math.floor(Math.random() * 5000) + 2000);
        
        // 返回主页
        log('返回主页...', 'info');
        await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 30000 });
        await delay(2000);
        await waitForPageStability(page);
        
        log('已返回主页', 'info');
      } else {
        // 如果是在当前页面显示详情（模态框等），等待一段时间后继续
        log('查看推文详情（模态框）...', 'info');
        const modalViewTime = Math.floor(Math.random() * (maxArticleViewTime - minArticleViewTime + 1)) + minArticleViewTime;
        log(`预计查看时间: ${Math.floor(modalViewTime / 1000)}秒`, 'info');
        
        // 在模态框中滚动查看（如果有滚动条）
        const scrollCount = Math.floor(modalViewTime / 4000);
        for (let i = 0; i < scrollCount; i++) {
          await smoothScroll(page, Math.floor(Math.random() * 300) + 100);
          await randomDelay(2000, 4000);
        }
        
        // 最后停留一段时间
        await delay(Math.floor(modalViewTime * 0.3));
        
        // 尝试关闭详情（按 ESC 或点击背景）
        try {
          await page.keyboard.press('Escape');
          await delay(1500);
        } catch (e) {
          // 忽略
        }
      }
    } catch (error) {
      log(`查看文章失败: ${error.message}`, 'warning');
      // 如果出错，尝试返回主页
      try {
        if (page.url() !== targetUrl) {
          await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 30000 });
          await delay(2000);
        }
      } catch (e) {
        // 忽略
      }
    }
  }

  try {
    log('开始 X.com 浏览任务', 'info');

    // 连接浏览器
    log('连接浏览器...', 'info');
    const wsEndpoint = await resolveWsEndpoint(debugPort);
    
    let connectAttempts = 0;
    const maxConnectAttempts = 8;
    while (connectAttempts < maxConnectAttempts) {
      try {
        browser = await puppeteer.connect({
          browserWSEndpoint: wsEndpoint,
          defaultViewport: null
        });
        log('浏览器连接成功', 'success');
        break;
      } catch (error) {
        connectAttempts++;
        if (connectAttempts >= maxConnectAttempts) {
          throw new Error(`连接浏览器失败（已重试${maxConnectAttempts}次）: ${error.message}`);
        }
        log(`连接浏览器失败，重试 ${connectAttempts}/${maxConnectAttempts}...`, 'warning');
        await delay(2500);
      }
    }

    // 获取或创建页面
    const pages = await browser.pages();
    if (pages.length > 0) {
      page = pages[0];
      log('使用现有页面', 'info');
    } else {
      page = await browser.newPage();
      log('创建新页面', 'info');
    }

    // 设置视口大小（模拟真实设备）
    await page.setViewport({
      width: 1920,
      height: 1080
    });

    // 导航到目标页面
    log(`正在打开 ${targetUrl}...`, 'info');
    await page.goto(targetUrl, {
      waitUntil: 'networkidle2',
      timeout: 60000
    });
    
    await delay(2000);

    // 等待页面稳定
    await waitForPageStability(page);

    log('开始模拟浏览行为...', 'info');

    // 主浏览循环
    for (let scrollCount = 0; scrollCount < maxScrollAttempts; scrollCount++) {
      log(`浏览进度: ${scrollCount + 1}/${maxScrollAttempts}`, 'info');

      // 随机决定是否点击文章
      const shouldClickArticle = Math.random() < articleClickProbability;
      
      if (shouldClickArticle) {
        // 查找可点击的文章
        const articles = await findClickableArticles(page);
        
        if (articles.length > 0) {
          // 随机选择一篇文章
          const randomArticle = articles[Math.floor(Math.random() * articles.length)];
          await viewArticle(page, randomArticle);
          
          // 查看文章后，继续滚动
          await randomDelay(minScrollDelay, maxScrollDelay);
        }
      }

      // 滚动页面
      const scrollDistance = randomScrollDistance();
      log(`向下滚动 ${scrollDistance}px...`, 'info');
      await smoothScroll(page, scrollDistance);

      // 停顿假装阅读
      const readTime = Math.floor(Math.random() * (maxReadTime - minReadTime + 1)) + minReadTime;
      log(`阅读中... (${Math.floor(readTime / 1000)}秒)`, 'info');
      await delay(readTime);

      // 随机决定是否向上滚动一点（模拟回看）- 增加概率到30%
      if (Math.random() < 0.3) {
        const backScroll = Math.floor(Math.random() * 400) + 150;
        log(`向上回看 ${backScroll}px...`, 'info');
        await smoothScroll(page, -backScroll);
        // 回看时停留更长时间（3-8秒）
        await randomDelay(3000, 8000);
      }

      // 随机决定是否长时间停留（模拟深度阅读）- 10%概率
      if (Math.random() < 0.1) {
        const deepReadTime = Math.floor(Math.random() * 15000) + 10000; // 10-25秒
        log(`深度阅读中... (${Math.floor(deepReadTime / 1000)}秒)`, 'info');
        await delay(deepReadTime);
      }

      // 滚动间隔（增加随机性，有时快速滚动，有时慢速）
      await randomDelay(minScrollDelay, maxScrollDelay);
    }

    log('浏览任务完成', 'success');

  } catch (error) {
    log(`任务失败: ${error.message}`, 'error');
    throw error;
  } finally {
    // 断开浏览器连接（不关闭窗口，由控制器管理）
    if (browser) {
      try {
        await browser.disconnect();
        log('已断开浏览器连接（窗口由控制器关闭）', 'info');
      } catch (error) {
        log(`断开连接失败: ${error.message}`, 'warning');
      }
    }
  }
};

