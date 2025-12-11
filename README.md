# MoreLogin Bot - 脚本控制器

一个基于Electron的MoreLogin脚本控制器，用于统一调度和管理自动化脚本的执行。

## 功能特性

- 🔌 连接MoreLogin本地API服务
- 🎯 统一调度脚本执行（控制并发数量、执行顺序）
- 📝 脚本模块化系统，易于扩展
- ⚙️ 图形化配置界面（端口、API Key等）
- 📊 实时执行日志和状态监控
- 💻 跨平台支持（macOS、Windows）

## 安装

### 开发环境

```bash
# 安装依赖
npm install

# 启动应用
npm start
```

### 打包应用

```bash
# 打包macOS应用
npm run build:mac

# 打包Windows应用
npm run build:win
```

打包后的应用在 `dist` 目录中。

## 配置

首次运行需要在应用中配置：

1. **端口**: MoreLogin本地API端口（默认35000）
2. **API ID**: MoreLogin API ID（在MoreLogin客户端中获取）
3. **API Key**: MoreLogin API Key（在MoreLogin客户端中获取）
4. **最大并发数**: 同时执行的任务数量（默认3）

## 编写脚本

在 `scripts` 目录下创建 `.js` 文件，脚本需要导出一个 `execute` 函数或作为默认导出函数。

### 脚本模板

```javascript
module.exports = async function execute(context) {
  const { environmentId, environment, wsUrl, client, log } = context;

  try {
    log('开始执行脚本...', 'info');
    
    // 你的脚本逻辑
    // 可以使用 wsUrl 连接浏览器进行自动化操作
    
    log('脚本执行完成', 'success');
  } catch (error) {
    log(`脚本执行出错: ${error.message}`, 'error');
    throw error;
  }
};
```

### 使用Puppeteer控制浏览器

如果需要控制浏览器，可以在脚本中使用 `puppeteer-core`：

```javascript
const puppeteer = require('puppeteer-core');

module.exports = async function execute(context) {
  const { wsUrl, log } = context;

  const browser = await puppeteer.connect({
    browserWSEndpoint: wsUrl
  });

  const page = await browser.newPage();
  await page.goto('https://www.example.com');
  
  // 执行你的操作
  await page.click('button');
  
  await browser.close();
};
```

注意：使用Puppeteer需要在项目中安装 `puppeteer-core`：
```bash
npm install puppeteer-core
```

## 项目结构

```
morelogin_bot/
├── main.js              # Electron主进程
├── index.html           # 应用界面
├── renderer.js          # 渲染进程逻辑
├── package.json         # 项目配置
├── src/
│   ├── morelogin-client.js  # MoreLogin API客户端
│   ├── controller.js        # 脚本控制器
│   └── script-base.js       # 脚本基类
└── scripts/             # 脚本目录
    └── example.js       # 示例脚本
```

## 使用说明

1. 启动应用
2. 配置MoreLogin连接参数（端口、API ID、API Key）
3. 选择要执行的脚本
4. 点击"开始执行"按钮
5. 在日志区域查看执行情况

## API说明

### MoreLoginClient

- `getEnvironments()` - 获取环境列表
- `openEnvironment(environmentId, options)` - 打开环境窗口
- `closeEnvironment(environmentId)` - 关闭环境窗口
- `getWebSocketUrl(environmentId)` - 获取WebSocket连接地址
- `createEnvironment(config)` - 创建新环境
- `checkConnection()` - 检查服务连接

### ScriptController

- `executeScript(scriptPath, environments)` - 执行脚本
- `stop()` - 停止执行

## 注意事项

- 确保MoreLogin客户端已启动并启用本地API
- API ID和API Key在MoreLogin客户端的"环境管理"->"API"中查看
- 脚本执行时会自动打开和关闭环境窗口
- 建议根据实际情况调整最大并发数，避免资源占用过高

## 许可证

MIT

