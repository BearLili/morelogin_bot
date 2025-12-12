const axios = require('axios');

class MoreLoginClient {
  constructor(config) {
    this.port = config.port || 35000;
    this.apiId = config.apiId;
    this.apiKey = config.apiKey;
    this.baseUrl = `http://127.0.0.1:${this.port}`;
  }

  /**
   * 获取请求头
   */
  getHeaders() {
    return {
      'X-API-ID': this.apiId,
      'X-API-KEY': this.apiKey,
      'Content-Type': 'application/json'
    };
  }

  /**
   * 检查API响应
   */
  checkResponse(response) {
    if (response.data.code !== 0) {
      throw new Error(response.data.msg || `API返回错误: code=${response.data.code}`);
    }
    return response.data;
  }

  /**
   * 获取环境列表
   * @param {object} options - 查询选项
   * @param {number} options.pageNo - 当前页，默认1
   * @param {number} options.pageSize - 每页条数，默认100
   * @param {string} options.envName - 按环境名称查询
   * @param {number} options.groupId - 按分组ID查询
   * @param {number} options.envId - 按环境ID查询
   */
  async getEnvironments(options = {}) {
    try {
      const params = {
        pageNo: options.pageNo || 1,
        pageSize: options.pageSize || 100,
        ...(options.envName && { envName: options.envName }),
        ...(options.groupId !== undefined && { groupId: options.groupId }),
        ...(options.envId && { envId: options.envId })
      };

      const response = await axios.post(
        `${this.baseUrl}/api/env/page`,
        params,
        {
          headers: this.getHeaders(),
          timeout: 10000
        }
      );

      const result = this.checkResponse(response);
      return result.data || { dataList: [], total: 0 };
    } catch (error) {
      let errorMsg = `获取环境列表失败: ${error.message}`;
      if (error.response) {
        if (error.response.data && error.response.data.msg) {
          errorMsg = `获取环境列表失败: ${error.response.data.msg}`;
        } else {
          errorMsg += ` (状态码: ${error.response.status})`;
        }
      } else if (error.code === 'ECONNREFUSED') {
        errorMsg = `连接被拒绝，请确保MoreLogin客户端已启动，端口: ${this.port}`;
      } else if (error.code === 'ETIMEDOUT') {
        errorMsg = `连接超时，请检查MoreLogin服务是否正常运行`;
      }
      throw new Error(errorMsg);
    }
  }

  /**
   * 启动环境（打开环境窗口）
   * @param {string|number} envId - 环境ID
   * @param {object} options - 选项
   * @param {number} options.uniqueId - 环境序号
   * @param {boolean} options.isHeadless - 是否以headless方式启动
   * @param {string} options.encryptKey - 密钥（环境开启端对端加密时必传）
   * @param {boolean} options.cdpEvasion - 是否启用CDP特征规避机制
   */
  async startEnvironment(envId, options = {}) {
    try {
      const params = {};
      
      if (envId) {
        params.envId = String(envId);
      } else if (options.uniqueId) {
        params.uniqueId = options.uniqueId;
      } else {
        throw new Error('环境ID或环境序号至少传一个');
      }

      if (options.isHeadless !== undefined) {
        params.isHeadless = options.isHeadless;
      }
      if (options.encryptKey) {
        params.encryptKey = options.encryptKey;
      }
      if (options.cdpEvasion !== undefined) {
        params.cdpEvasion = options.cdpEvasion;
      }

      const response = await axios.post(
        `${this.baseUrl}/api/env/start`,
        params,
        {
          headers: this.getHeaders(),
          timeout: 30000
        }
      );

      const result = this.checkResponse(response);
      return result.data;
    } catch (error) {
      let errorMsg = `启动环境失败: ${error.message}`;
      if (error.response) {
        if (error.response.data && error.response.data.msg) {
          errorMsg = `启动环境失败: ${error.response.data.msg}`;
        } else {
          errorMsg += ` (状态码: ${error.response.status})`;
        }
      }
      throw new Error(errorMsg);
    }
  }

  /**
   * 关闭环境窗口
   * @param {string|number} envId - 环境ID
   * @param {object} options - 选项
   * @param {number} options.uniqueId - 环境序号
   */
  async closeEnvironment(envId, options = {}) {
    try {
      const params = {};
      
      if (envId) {
        params.envId = String(envId);
      } else if (options.uniqueId) {
        params.uniqueId = options.uniqueId;
      } else {
        throw new Error('环境ID或环境序号至少传一个');
      }

      const response = await axios.post(
        `${this.baseUrl}/api/env/close`,
        params,
        {
          headers: this.getHeaders(),
          timeout: 10000
        }
      );

      const result = this.checkResponse(response);
      return result.data;
    } catch (error) {
      // 检查是否是"环境不存在"或"已经关闭"的情况
      if (error.response) {
        const status = error.response.status;
        const data = error.response.data;
        
        // 404 或特定的错误码可能表示环境已经不存在或已关闭
        if (status === 404) {
          // 环境可能已经关闭，视为成功
          return { alreadyClosed: true };
        }
        
        // 检查错误消息中是否包含"不存在"、"已关闭"等关键词
        const errorMsg = data?.msg || data?.message || error.message || '';
        const lowerMsg = errorMsg.toLowerCase();
        if (lowerMsg.includes('不存在') || 
            lowerMsg.includes('已关闭') || 
            lowerMsg.includes('not found') ||
            lowerMsg.includes('already closed') ||
            lowerMsg.includes('not running')) {
          // 环境已经关闭，视为成功
          return { alreadyClosed: true };
        }
        
        // 其他错误才抛出
        throw new Error(data?.msg || error.message || '关闭失败');
      }
      
      // 网络错误或其他错误
      throw new Error(error.message || '关闭失败');
    }
  }

  /**
   * 获取环境的WebSocket连接地址（用于Puppeteer）
   * 启动环境后，可以通过debugPort构建WebSocket地址
   * @param {string} debugPort - debug端口（从startEnvironment返回）
   */
  getWebSocketUrl(debugPort) {
    return `ws://127.0.0.1:${debugPort}`;
  }

  /**
   * 获取环境详情
   * @param {string|number} envId - 环境ID
   */
  async getEnvironmentDetail(envId) {
    try {
      const response = await axios.post(
        `${this.baseUrl}/api/env/detail`,
        { envId: String(envId) },
        {
          headers: this.getHeaders(),
          timeout: 10000
        }
      );

      const result = this.checkResponse(response);
      return result.data;
    } catch (error) {
      let errorMsg = `获取环境详情失败: ${error.message}`;
      if (error.response && error.response.data && error.response.data.msg) {
        errorMsg = `获取环境详情失败: ${error.response.data.msg}`;
      }
      throw new Error(errorMsg);
    }
  }

  /**
   * 获取环境运行状态
   * @param {string|number} envId - 环境ID
   */
  async getEnvironmentStatus(envId) {
    try {
      const response = await axios.post(
        `${this.baseUrl}/api/env/status`,
        { envId: String(envId) },
        {
          headers: this.getHeaders(),
          timeout: 10000
        }
      );

      const result = this.checkResponse(response);
      return result.data;
    } catch (error) {
      let errorMsg = `获取环境状态失败: ${error.message}`;
      if (error.response && error.response.data && error.response.data.msg) {
        errorMsg = `获取环境状态失败: ${error.response.data.msg}`;
      }
      throw new Error(errorMsg);
    }
  }

  /**
   * 检查服务连接
   * @returns {object} {success: boolean, message: string, details: object}
   */
  async checkConnection() {
    const details = {
      baseUrl: this.baseUrl,
      port: this.port,
      hasApiId: !!this.apiId,
      hasApiKey: !!this.apiKey
    };

    // 检查基本配置
    if (!this.apiId || !this.apiKey) {
      return {
        success: false,
        message: 'API ID或API Key未配置',
        details
      };
    }

    // 尝试连接服务
    try {
      // 首先尝试简单的连接测试（不验证API）
      try {
        await axios.get(`${this.baseUrl}`, {
          timeout: 3000,
          validateStatus: () => true // 接受任何状态码
        });
      } catch (testError) {
        if (testError.code === 'ECONNREFUSED') {
          return {
            success: false,
            message: `无法连接到MoreLogin服务 (端口 ${this.port})`,
            details: {
              ...details,
              error: '连接被拒绝',
              suggestion: '请确保MoreLogin客户端已启动并启用本地API'
            }
          };
        }
        if (testError.code === 'ETIMEDOUT') {
          return {
            success: false,
            message: `连接超时 (端口 ${this.port})`,
            details: {
              ...details,
              error: '连接超时',
              suggestion: '请检查MoreLogin服务是否正常运行'
            }
          };
        }
      }

      // 尝试获取环境列表来验证API
      try {
        const result = await this.getEnvironments({ pageNo: 1, pageSize: 1 });
        return {
          success: true,
          message: '连接成功',
          details: {
            ...details,
            totalEnvironments: result.total || 0
          }
        };
      } catch (apiError) {
        const errorMsg = apiError.message || '未知错误';
        let suggestion = '请检查API ID和API Key是否正确';
        
        if (apiError.response) {
          if (apiError.response.status === 401 || apiError.response.status === 403) {
            suggestion = 'API ID或API Key无效，请在MoreLogin客户端中重新获取';
          } else if (apiError.response.data && apiError.response.data.msg) {
            suggestion = apiError.response.data.msg;
          }
        }

        return {
          success: false,
          message: `API验证失败: ${errorMsg}`,
          details: {
            ...details,
            error: errorMsg,
            suggestion
          }
        };
      }
    } catch (error) {
      return {
        success: false,
        message: `连接检查失败: ${error.message}`,
        details: {
          ...details,
          error: error.message
        }
      };
    }
  }
}

module.exports = MoreLoginClient;
