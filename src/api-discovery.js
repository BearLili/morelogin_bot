const axios = require('axios');

/**
 * API路径发现工具
 * 用于自动检测MoreLogin的API端点
 */
class APIDiscovery {
  constructor(baseUrl, apiId, apiKey) {
    this.baseUrl = baseUrl;
    this.apiId = apiId;
    this.apiKey = apiKey;
    this.headers = {
      'X-API-ID': apiId,
      'X-API-KEY': apiKey,
      'x-api-id': apiId,
      'x-api-key': apiKey,
      'Content-Type': 'application/json'
    };
  }

  /**
   * 测试API路径
   */
  async testPath(method, path, data = {}) {
    try {
      const config = {
        headers: this.headers,
        timeout: 5000,
        validateStatus: (status) => status < 500 // 只接受5xx为错误
      };

      let response;
      if (method === 'post') {
        response = await axios.post(`${this.baseUrl}${path}`, data, config);
      } else {
        response = await axios.get(`${this.baseUrl}${path}`, config);
      }

      return {
        success: response.status < 400,
        status: response.status,
        data: response.data
      };
    } catch (error) {
      return {
        success: false,
        status: error.response?.status || 0,
        error: error.message
      };
    }
  }

  /**
   * 发现环境列表API
   */
  async discoverEnvList() {
    const paths = [
      { method: 'post', path: '/api/env/list' },
      { method: 'get', path: '/api/env/list' },
      { method: 'post', path: '/api/v1/env/list' },
      { method: 'get', path: '/api/v1/env/list' },
      { method: 'post', path: '/api/v1/environment/list' },
      { method: 'get', path: '/api/v1/environment/list' },
      { method: 'post', path: '/api/environment/list' },
      { method: 'get', path: '/api/environment/list' }
    ];

    for (const { method, path } of paths) {
      const result = await this.testPath(method, path, {});
      if (result.success) {
        return { method, path, result };
      }
    }

    return null;
  }

  /**
   * 发现所有API端点
   */
  async discoverAll() {
    const results = {
      envList: await this.discoverEnvList()
    };

    return results;
  }
}

module.exports = APIDiscovery;

