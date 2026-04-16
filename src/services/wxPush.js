const https = require('https');
const config = require('../config');

let accessTokenCache = { token: null, expiresAt: 0 };

/**
 * 获取微信 access_token（带缓存）
 */
function getAccessToken() {
  if (!config.wxAppId || !config.wxAppSecret) {
    return Promise.resolve(null);
  }

  const now = Date.now();
  if (accessTokenCache.token && accessTokenCache.expiresAt > now) {
    return Promise.resolve(accessTokenCache.token);
  }

  return new Promise((resolve, reject) => {
    const url = `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${config.wxAppId}&secret=${config.wxAppSecret}`;
    https.get(url, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString());
          if (data.access_token) {
            const bufferSeconds = Math.min(300, Math.max(60, data.expires_in * 0.1));
            accessTokenCache = {
              token: data.access_token,
              expiresAt: now + (data.expires_in - bufferSeconds) * 1000
            };
            resolve(data.access_token);
          } else {
            console.error('获取微信 access_token 失败:', data.errmsg);
            resolve(null);
          }
        } catch (error) {
          reject(error);
        }
      });
      response.on('error', reject);
    }).on('error', reject);
  });
}

/**
 * 发送微信订阅消息
 * @param {string} openid - 用户 openid
 * @param {string} templateId - 模板 ID
 * @param {object} data - 模板数据
 * @param {string} page - 跳转页面路径
 */
async function sendSubscribeMessage(openid, templateId, data, page) {
  if (!openid || !templateId) {
    return null;
  }

  const token = await getAccessToken();
  if (!token) {
    return null;
  }

  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      touser: openid,
      template_id: templateId,
      page: page || '',
      data
    });

    const url = `https://api.weixin.qq.com/cgi-bin/message/subscribe/send?access_token=${token}`;
    const options = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    };

    const req = https.request(url, options, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        try {
          const result = JSON.parse(Buffer.concat(chunks).toString());
          resolve(result);
        } catch (error) {
          reject(error);
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

module.exports = {
  getAccessToken,
  sendSubscribeMessage
};
