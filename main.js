const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

let mainWindow;

// 错误日志文件路径
const logPath = path.join(app.getPath('userData'), 'error.log');

function logError(message, error) {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] ${message}\n${error ? error.stack || error.toString() : ''}\n\n`;
  try {
    fs.appendFileSync(logPath, logMessage, 'utf8');
  } catch (e) {
    console.error('Failed to write log:', e);
  }
  console.error(message, error);
}

function createWindow() {
  try {
    mainWindow = new BrowserWindow({
      width: 1200,
      height: 800,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false
      },
      show: false // 先不显示，等加载完成后再显示
    });

    // 确定index.html的路径
    // 打包后文件在 app.asar 中，__dirname 会指向 app.asar 内的路径
    const indexPath = path.join(__dirname, 'index.html');

    logError('Starting application', null);
    logError(`__dirname: ${__dirname}`, null);
    logError(`Index path: ${indexPath}`, null);
    logError(`File exists: ${fs.existsSync(indexPath)}`, null);

    mainWindow.loadFile(indexPath).then(() => {
      logError('Window loaded successfully', null);
      mainWindow.show();
    }).catch((error) => {
      logError('Failed to load window', error);
      dialog.showErrorBox('启动失败', `无法加载应用界面:\n${error.message}\n\n错误日志已保存到: ${logPath}`);
    });

    // 监听窗口错误
    mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
      logError(`Failed to load: ${errorCode} - ${errorDescription}`, null);
      dialog.showErrorBox('加载失败', `无法加载页面:\n错误代码: ${errorCode}\n${errorDescription}\n\n错误日志已保存到: ${logPath}`);
    });

    // 开发时或打包后都打开开发者工具以便调试
    if (process.env.NODE_ENV === 'development' || process.env.DEBUG === '1') {
      mainWindow.webContents.openDevTools();
    }

  } catch (error) {
    logError('Failed to create window', error);
    dialog.showErrorBox('启动失败', `无法创建窗口:\n${error.message}\n\n错误日志已保存到: ${logPath}`);
  }
}

// 全局错误处理
process.on('uncaughtException', (error) => {
  logError('Uncaught Exception', error);
  dialog.showErrorBox('应用错误', `发生未捕获的错误:\n${error.message}\n\n错误日志已保存到: ${logPath}`);
});

process.on('unhandledRejection', (reason, promise) => {
  logError('Unhandled Rejection', reason);
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.whenReady().then(() => {
  try {
    // 修复macOS安全编码警告
    if (process.platform === 'darwin') {
      app.applicationSupportsSecureRestorableState = () => true;
    }
    createWindow();
  } catch (error) {
    logError('Failed in whenReady', error);
    dialog.showErrorBox('启动失败', `应用启动时出错:\n${error.message}\n\n错误日志已保存到: ${logPath}`);
  }
}).catch((error) => {
  logError('whenReady rejected', error);
  dialog.showErrorBox('启动失败', `应用准备失败:\n${error.message}\n\n错误日志已保存到: ${logPath}`);
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    try {
      createWindow();
    } catch (error) {
      logError('Failed to create window on activate', error);
    }
  }
});

// IPC handlers
ipcMain.handle('get-config', async () => {
  const configPath = path.join(app.getPath('userData'), 'config.json');
  try {
    if (fs.existsSync(configPath)) {
      const data = fs.readFileSync(configPath, 'utf8');
      return JSON.parse(data);
    }
  } catch (error) {
    console.error('Error reading config:', error);
  }
  return {
    port: 35000,
    apiId: '',
    apiKey: '',
    maxConcurrent: 3
  };
});

ipcMain.handle('save-config', async (event, config) => {
  const configPath = path.join(app.getPath('userData'), 'config.json');
  try {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
    return { success: true };
  } catch (error) {
    console.error('Error saving config:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('list-scripts', async () => {
  // 打包后文件在 app.asar 中，__dirname 会指向 app.asar 内的路径
  // 开发环境中，__dirname 指向项目根目录
  let scriptsPath = path.join(__dirname, 'scripts');

  // 如果 asar 内不存在，尝试 app.asar.unpacked（处理 asarUnpack 的情况）
  if (!fs.existsSync(scriptsPath)) {
    const unpacked = path.join(__dirname.replace(/app\.asar$/, 'app.asar.unpacked'), 'scripts');
    if (fs.existsSync(unpacked)) {
      scriptsPath = unpacked;
    }
  }

  const aliasPath = path.join(scriptsPath, 'script-alias.json');
  let aliasMap = {};

  try {
    if (fs.existsSync(aliasPath)) {
      const raw = fs.readFileSync(aliasPath, 'utf8');
      aliasMap = JSON.parse(raw);
    }
  } catch (error) {
    logError('Error reading script-alias.json', error);
  }
  
  try {
    if (!fs.existsSync(scriptsPath)) {
      fs.mkdirSync(scriptsPath, { recursive: true });
    }
    const files = fs.readdirSync(scriptsPath);
    return files.filter(f => f.endsWith('.js')).map(f => ({
      name: f.replace('.js', ''),
      displayName: aliasMap[f] || aliasMap[f.replace('.js', '')] || f.replace('.js', ''),
      path: path.join(scriptsPath, f)
    }));
  } catch (error) {
    console.error('Error listing scripts:', error);
    logError('Error listing scripts', error);
    return [];
  }
});

