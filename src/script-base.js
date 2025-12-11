/**
 * 脚本基类
 * 所有脚本都应该继承这个类或遵循相同的接口
 */
class ScriptBase {
  constructor() {
    this.name = 'Base Script';
    this.description = '脚本基类';
  }

  /**
   * 执行脚本
   * @param {object} context - 执行上下文
   * @param {string} context.environmentId - 环境ID
   * @param {object} context.environment - 环境信息
   * @param {string} context.wsUrl - WebSocket连接地址
   * @param {object} context.client - MoreLogin客户端实例
   * @param {function} context.log - 日志函数
   */
  async execute(context) {
    throw new Error('execute方法必须被实现');
  }

  /**
   * 使用Puppeteer连接到浏览器
   * @param {string} wsUrl - WebSocket连接地址
   */
  async connectBrowser(wsUrl) {
    // 注意：需要在脚本中安装puppeteer-core
    // const puppeteer = require('puppeteer-core');
    // const browser = await puppeteer.connect({
    //   browserWSEndpoint: wsUrl
    // });
    // return browser;
    throw new Error('需要在脚本中实现浏览器连接逻辑');
  }
}

module.exports = ScriptBase;

