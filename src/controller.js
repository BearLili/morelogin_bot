const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');

class ScriptController extends EventEmitter {
  constructor(client, maxConcurrent = 3) {
    super();
    this.client = client;
    this.maxConcurrent = maxConcurrent;
    this.runningTasks = new Map();
    this.taskQueue = [];
    this.isStopped = false;
    this.stats = {
      running: 0,
      completed: 0,
      failed: 0
    };
  }

  /**
   * 执行脚本
   * @param {string} scriptPath - 脚本文件路径
   * @param {Array} environments - 环境列表（可选，如果不提供则自动获取）
   */
  async executeScript(scriptPath, environments = null) {
    this.isStopped = false;
    
    // 加载脚本模块
    const scriptModule = this.loadScript(scriptPath);
    
    // 获取环境列表
    if (!environments) {
      this.emit('log', '正在获取环境列表...', 'info');
      const envListResult = await this.client.getEnvironments();
      // API返回格式: {dataList: [...], total: ...}
      environments = envListResult.dataList || [];
      
      if (envListResult.total) {
        this.emit('log', `共找到 ${envListResult.total} 个环境`, 'info');
      }
    }

    if (environments.length === 0) {
      throw new Error('没有可用的环境');
    }

    this.emit('log', `开始执行 ${environments.length} 个环境...`, 'info');

    // 创建任务队列
    this.taskQueue = environments.map((env, index) => ({
      id: env.Id || env.id || env.environment_id || index,
      environment: env,
      index: index + 1,
      total: environments.length
    }));

    // 开始执行任务
    await this.processQueue(scriptModule);

    // 汇总日志
    this.emit('log', `执行完成：成功 ${this.stats.completed} 个，失败 ${this.stats.failed} 个`, this.stats.failed > 0 ? 'warning' : 'success');
  }

  /**
   * 加载脚本模块
   */
  loadScript(scriptPath) {
    try {
      // 清除require缓存，确保每次都是最新代码
      delete require.cache[require.resolve(path.resolve(scriptPath))];
      const scriptModule = require(path.resolve(scriptPath));
      
      if (typeof scriptModule !== 'function' && typeof scriptModule.execute !== 'function') {
        throw new Error('脚本必须导出execute函数或作为默认导出函数');
      }

      return scriptModule;
    } catch (error) {
      throw new Error(`加载脚本失败: ${error.message}`);
    }
  }

  /**
   * 处理任务队列
   */
  async processQueue(scriptModule) {
    const promises = [];

    while (this.taskQueue.length > 0 || this.runningTasks.size > 0) {
      if (this.isStopped) {
        this.emit('log', '收到停止信号，正在停止...', 'warning');
        break;
      }

      // 启动新任务直到达到最大并发数
      while (this.runningTasks.size < this.maxConcurrent && this.taskQueue.length > 0) {
        const task = this.taskQueue.shift();
        this.startTask(task, scriptModule);
      }

      // 等待至少一个任务完成
      if (this.runningTasks.size > 0) {
        await Promise.race(Array.from(this.runningTasks.values()));
      }
    }

    // 等待所有剩余任务完成
    if (this.runningTasks.size > 0) {
      await Promise.all(Array.from(this.runningTasks.values()));
    }
  }

  /**
   * 启动单个任务
   */
  async startTask(task, scriptModule) {
    this.stats.running++;
    this.updateStats();

    const taskPromise = this.runTask(task, scriptModule)
      .finally(() => {
        this.runningTasks.delete(task.id);
        this.stats.running--;
        this.updateStats();
      });

    this.runningTasks.set(task.id, taskPromise);
  }

  /**
   * 运行任务
   * 注意：启动环境后才占用并发槽位，关闭环境后才释放槽位
   */
  async runTask(task, scriptModule) {
    const { environment, index, total } = task;
    const envId = environment.Id || environment.id || environment.environment_id;
    const envName = environment.envName || environment.name || '';
    let isEnvironmentStarted = false;

    try {
      this.emit('log', `[${index}/${total}] 开始执行环境: ${envName || envId} (ID: ${envId})`, 'info');
      this.emit('log', `[${index}/${total}] 等待可用窗口槽位... (当前运行: ${this.runningTasks.size}/${this.maxConcurrent})`, 'info');

      // 启动环境窗口（这里会占用一个并发槽位）
      this.emit('log', `[${index}/${total}] 正在启动环境窗口...`, 'info');
      const startResult = await this.client.startEnvironment(envId);
      isEnvironmentStarted = true;
      
      // 从启动结果获取debugPort和webdriver
      const debugPort = startResult.debugPort;
      const webdriver = startResult.webdriver;
      
      if (!debugPort) {
        throw new Error('启动环境失败：未返回debugPort');
      }

      // 构建WebSocket连接地址（用于Puppeteer）。脚本内部会再解析 /json/version，避免404。
      const wsUrl = `ws://127.0.0.1:${debugPort}/devtools/browser`;
      
      this.emit('log', `[${index}/${total}] 环境窗口已打开 (debugPort: ${debugPort}, 运行中: ${this.runningTasks.size}/${this.maxConcurrent})`, 'success');

      // 执行脚本
      const executeFn = typeof scriptModule === 'function' 
        ? scriptModule 
        : scriptModule.execute;

      await executeFn({
        environmentId: envId,
        environment: environment,
        wsUrl: wsUrl,
        debugPort: debugPort,
        webdriver: webdriver,
        client: this.client,
        log: (message, type = 'info') => {
          this.emit('log', `[${index}/${total}] ${message}`, type);
        }
      });

      this.stats.completed++;
      this.updateStats();
      this.emit('log', `[${index}/${total}] 环境 ${envName || envId} 执行完成`, 'success');

    } catch (error) {
      this.stats.failed++;
      this.updateStats();
      this.emit('log', `[${index}/${total}] 环境 ${envName || envId} 执行失败: ${error.message}`, 'error');
    } finally {
      // 无论成功失败，都要关闭环境窗口（释放并发槽位）
      if (isEnvironmentStarted) {
        const maxCloseRetry = 3;
        let closed = false;
        for (let i = 1; i <= maxCloseRetry && !closed; i++) {
          try {
            this.emit('log', `[${index}/${total}] 正在关闭环境窗口... (第${i}/${maxCloseRetry}次)`, 'info');
            await this.client.closeEnvironment(envId);
            closed = true;
            this.emit('log', `[${index}/${total}] 环境窗口已关闭 (释放槽位，当前运行: ${this.runningTasks.size - 1}/${this.maxConcurrent})`, 'info');
          } catch (closeError) {
            if (i === maxCloseRetry) {
              this.emit('log', `[${index}/${total}] 关闭环境窗口失败（已重试${maxCloseRetry}次）: ${closeError.message}。请在 MoreLogin 客户端手动检查该环境是否仍在运行。`, 'warning');
            } else {
              await new Promise(res => setTimeout(res, 1500));
            }
          }
        }
      }
    }
  }

  /**
   * 更新统计信息
   */
  updateStats() {
    this.emit('status', { ...this.stats });
  }

  /**
   * 停止执行
   */
  stop() {
    this.isStopped = true;
    this.taskQueue = []; // 清空队列
  }
}

module.exports = ScriptController;

