const https = require('https');
const crypto = require('crypto');
const config = require('../config');

// 企业微信 access_token 缓存
let wecomTokenCache = { token: null, expiresAt: 0 };
let wecomTokenInFlight = null;

/**
 * 通用 HTTPS POST 请求封装
 * @param {string} url
 * @param {object} body
 * @returns {Promise<object>}
 */
function httpsPost(url, body = {}) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);
    const options = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr)
      }
    };

    const req = https.request(url, options, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString());
          resolve(data);
        } catch (error) {
          reject(error);
        }
      });
    });

    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

/**
 * 通用 HTTPS GET 请求封装
 * @param {string} url
 * @returns {Promise<object>}
 */
function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString());
          resolve(data);
        } catch (error) {
          reject(error);
        }
      });
      response.on('error', reject);
    }).on('error', reject);
  });
}

/**
 * 获取企业微信 access_token（带缓存 + 并发去重）
 * 环境变量依赖：WECOM_CORP_ID, WECOM_SECRET
 * @returns {Promise<string|null>}
 */
function getWecomAccessToken() {
  if (!config.wecomCorpId || !config.wecomSecret) {
    console.warn('[wecom] WECOM_CORP_ID 或 WECOM_SECRET 未配置');
    return Promise.resolve(null);
  }

  const now = Date.now();
  if (wecomTokenCache.token && wecomTokenCache.expiresAt > now) {
    return Promise.resolve(wecomTokenCache.token);
  }

  if (wecomTokenInFlight) return wecomTokenInFlight;

  wecomTokenInFlight = new Promise((resolve, reject) => {
    const url = `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${config.wecomCorpId}&corpsecret=${config.wecomSecret}`;
    httpsGet(url)
      .then((data) => {
        wecomTokenInFlight = null;
        if (data.access_token) {
          const expiresIn = data.expires_in || 7200;
          const bufferSeconds = Math.min(300, Math.max(60, expiresIn * 0.1));
          wecomTokenCache = {
            token: data.access_token,
            expiresAt: now + (expiresIn - bufferSeconds) * 1000
          };
          resolve(data.access_token);
        } else {
          console.error('[wecom] 获取 access_token 失败:', data.errmsg || JSON.stringify(data));
          resolve(null);
        }
      })
      .catch((err) => {
        wecomTokenInFlight = null;
        reject(err);
      });
  });

  return wecomTokenInFlight;
}

/**
 * 清除 access_token 缓存（通常在 token 失效时调用）
 */
function clearWecomTokenCache() {
  wecomTokenCache = { token: null, expiresAt: 0 };
}

/**
 * 企业微信错误码：access_token 相关
 * @param {number} errcode
 * @returns {boolean}
 */
function isTokenError(errcode) {
  // 40014: 不合法的access_token; 42001: access_token已过期; 42007: 预授权码已过期
  return errcode === 40014 || errcode === 42001 || errcode === 42007;
}

/**
 * 发送应用消息（支持重试一次）
 * 环境变量依赖：WECOM_AGENT_ID
 * @param {object} payload - 企业微信消息体，必须包含 touser/toparty/totag 之一
 * @param {boolean} [retry=true] - 是否允许 token 失效重试
 * @returns {Promise<object|null>}
 */
async function sendAppMessage(payload, retry = true) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('sendAppMessage 需要有效的 payload 对象');
  }

  const agentId = config.wecomAgentId;
  if (!agentId) {
    console.warn('[wecom] WECOM_AGENT_ID 未配置');
    return null;
  }

  const token = await getWecomAccessToken();
  if (!token) return null;

  const body = { agentid: Number(agentId), ...payload };
  const url = `https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${token}`;

  try {
    const result = await httpsPost(url, body);
    if (isTokenError(result.errcode) && retry) {
      clearWecomTokenCache();
      return sendAppMessage(payload, false);
    }
    if (result.errcode !== 0) {
      console.error('[wecom] 发送应用消息失败:', result.errmsg, '| payload:', JSON.stringify(body));
    }
    return result;
  } catch (error) {
    console.error('[wecom] 发送应用消息异常:', error.message);
    throw error;
  }
}

/**
 * 发送群机器人 Webhook 消息
 * 环境变量依赖：WECOM_WEBHOOK_KEY
 * @param {object} payload - 消息体（text/markdown/news/image/file 等类型）
 * @returns {Promise<object|null>}
 */
async function sendWebhookMessage(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('sendWebhookMessage 需要有效的 payload 对象');
  }

  const webhookKey = config.wecomWebhookKey;
  if (!webhookKey) {
    console.warn('[wecom] WECOM_WEBHOOK_KEY 未配置');
    return null;
  }

  const url = `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=${webhookKey}`;

  try {
    const result = await httpsPost(url, payload);
    if (result.errcode !== 0) {
      console.error('[wecom] 发送 Webhook 消息失败:', result.errmsg, '| payload:', JSON.stringify(payload));
    }
    return result;
  } catch (error) {
    console.error('[wecom] 发送 Webhook 消息异常:', error.message);
    throw error;
  }
}

/**
 * 创建应用群聊
 * 环境变量依赖：WECOM_AGENT_ID
 * @param {object} params
 * @param {string} params.name - 群聊名称
 * @param {string} params.owner - 群主 userId
 * @param {string[]} params.userlist - 群成员 userId 列表
 * @param {string} [params.chatid] - 自定义群聊 ID（可选）
 * @param {boolean} [retry=true] - 是否允许 token 失效重试
 * @returns {Promise<object|null>} - 成功返回 { chatid: string }
 */
async function createAppChat(params, retry = true) {
  if (!params || typeof params !== 'object') {
    throw new Error('createAppChat 需要有效的 params 对象');
  }
  const { name, owner, userlist, chatid } = params;
  if (!name || !owner || !Array.isArray(userlist) || userlist.length === 0) {
    throw new Error('createAppChat 参数缺失：name, owner, userlist 为必填');
  }

  const token = await getWecomAccessToken();
  if (!token) return null;

  const body = {
    name,
    owner,
    userlist: userlist.slice(0, 2000), // 企业微信上限 2000 人
    ...(chatid ? { chatid } : {})
  };
  const url = `https://qyapi.weixin.qq.com/cgi-bin/appchat/create?access_token=${token}`;

  try {
    const result = await httpsPost(url, body);
    if (isTokenError(result.errcode) && retry) {
      clearWecomTokenCache();
      return createAppChat(params, false);
    }
    if (result.errcode !== 0) {
      console.error('[wecom] 创建群聊失败:', result.errmsg, '| params:', JSON.stringify(body));
    }
    return result;
  } catch (error) {
    console.error('[wecom] 创建群聊异常:', error.message);
    throw error;
  }
}

/**
 * 邀请成员加入群聊
 * @param {object} params
 * @param {string} params.chatid - 群聊 ID
 * @param {string[]} [params.userlist] - 待添加成员 userId 列表
 * @param {string[]} [params.invitelist] - 待邀请成员 userId 列表（群满 40 人时只能用邀请）
 * @param {boolean} [retry=true] - 是否允许 token 失效重试
 * @returns {Promise<object|null>}
 */
async function inviteChatMembers(params, retry = true) {
  if (!params || typeof params !== 'object') {
    throw new Error('inviteChatMembers 需要有效的 params 对象');
  }
  const { chatid, userlist, invitelist } = params;
  if (!chatid) {
    throw new Error('inviteChatMembers 缺少 chatid');
  }
  if (!Array.isArray(userlist) && !Array.isArray(invitelist)) {
    throw new Error('inviteChatMembers 至少需要 userlist 或 invitelist 之一');
  }

  const token = await getWecomAccessToken();
  if (!token) return null;

  const body = { chatid };
  if (Array.isArray(userlist) && userlist.length > 0) body.userlist = userlist;
  if (Array.isArray(invitelist) && invitelist.length > 0) body.invitelist = invitelist;

  const url = `https://qyapi.weixin.qq.com/cgi-bin/appchat/update?access_token=${token}`;

  try {
    const result = await httpsPost(url, body);
    if (isTokenError(result.errcode) && retry) {
      clearWecomTokenCache();
      return inviteChatMembers(params, false);
    }
    if (result.errcode !== 0) {
      console.error('[wecom] 邀请成员失败:', result.errmsg, '| params:', JSON.stringify(body));
    }
    return result;
  } catch (error) {
    console.error('[wecom] 邀请成员异常:', error.message);
    throw error;
  }
}

// ==================== 企业微信消息加解密（API 接收消息）====================

const AES_BLOCK_SIZE = 32;

function getAesKey(encodingAesKey) {
  if (!encodingAesKey) return null;
  const key = Buffer.from(encodingAesKey + '=', 'base64');
  if (key.length !== 32) {
    throw new Error('EncodingAESKey 解码后长度必须为 32 字节');
  }
  return key;
}

function getIv(key) {
  return key.slice(0, 16);
}

function padBuffer(buffer) {
  const padLen = AES_BLOCK_SIZE - (buffer.length % AES_BLOCK_SIZE);
  const pad = Buffer.alloc(padLen, padLen);
  return Buffer.concat([buffer, pad]);
}

function unpadBuffer(buffer) {
  const padLen = buffer[buffer.length - 1];
  return buffer.slice(0, buffer.length - padLen);
}

/**
 * 计算企业微信消息签名
 * @param {string} token
 * @param {string} timestamp
 * @param {string} nonce
 * @param {string} encrypt - 加密后的消息体
 * @returns {string}
 */
function computeSignature(token, timestamp, nonce, encrypt) {
  const raw = [token, timestamp, nonce, encrypt].sort().join('');
  return crypto.createHash('sha1').update(raw).digest('hex');
}

/**
 * 解密企业微信消息
 * @param {string} encodingAesKey
 * @param {string} encrypt - Base64 编码的加密消息
 * @returns {{message: string, appId: string}}
 */
function decryptMessage(encodingAesKey, encrypt) {
  const key = getAesKey(encodingAesKey);
  const iv = getIv(key);
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  decipher.setAutoPadding(false);
  let decrypted = decipher.update(encrypt, 'base64', 'binary');
  decrypted += decipher.final('binary');
  const buf = Buffer.from(decrypted, 'binary');
  const unpadded = unpadBuffer(buf);
  // 格式：16 字节随机字符串 + 4 字节消息长度（网络字节序）+ 消息 + appid
  const msgLen = unpadded.readUInt32BE(16);
  const message = unpadded.slice(20, 20 + msgLen).toString('utf-8');
  const appId = unpadded.slice(20 + msgLen).toString('utf-8');
  return { message, appId };
}

/**
 * 加密企业微信消息
 * @param {string} encodingAesKey
 * @param {string} reply
 * @param {string} appId
 * @returns {string}
 */
function encryptMessage(encodingAesKey, reply, appId) {
  const key = getAesKey(encodingAesKey);
  const iv = getIv(key);
  const randomBytes = crypto.randomBytes(16);
  const replyBuf = Buffer.from(reply, 'utf-8');
  const msgLenBuf = Buffer.alloc(4);
  msgLenBuf.writeUInt32BE(replyBuf.length, 0);
  const appIdBuf = Buffer.from(appId, 'utf-8');
  const raw = Buffer.concat([randomBytes, msgLenBuf, replyBuf, appIdBuf]);
  const padded = padBuffer(raw);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  cipher.setAutoPadding(false);
  let encrypted = cipher.update(padded, 'binary', 'base64');
  encrypted += cipher.final('base64');
  return encrypted;
}

/**
 * 验证企业微信回调 URL
 * @param {object} params - { msg_signature, timestamp, nonce, echostr }
 * @param {string} token
 * @param {string} encodingAesKey
 * @returns {string|null} - 验证通过返回解密后的 echostr，否则 null
 */
function verifyCallbackUrl(params, token, encodingAesKey) {
  if (!token || !encodingAesKey) return null;
  const { msg_signature, timestamp, nonce, echostr } = params;
  if (!msg_signature || !timestamp || !nonce || !echostr) return null;

  const signature = computeSignature(token, timestamp, nonce, echostr);
  if (signature !== msg_signature) return null;

  try {
    const { message } = decryptMessage(encodingAesKey, echostr);
    return message;
  } catch (error) {
    console.error('[wecom] 解密 echostr 失败:', error.message);
    return null;
  }
}

/**
 * 解析并解密企业微信推送的 XML 消息
 * @param {string} xml
 * @param {string} msgSignature
 * @param {string} timestamp
 * @param {string} nonce
 * @param {string} token
 * @param {string} encodingAesKey
 * @returns {{toUserName:string, agentId:string, encrypt:string, message:string}|null}
 */
function parseEncryptedXml(xml, msgSignature, timestamp, nonce, token, encodingAesKey) {
  if (!token || !encodingAesKey) return null;
  const encryptMatch = xml.match(/<Encrypt><!\[CDATA\[(.*?)\]\]><\/Encrypt>/);
  const toUserMatch = xml.match(/<ToUserName><!\[CDATA\[(.*?)\]\]><\/ToUserName>/);
  const agentIdMatch = xml.match(/<AgentID><!\[CDATA\[(.*?)\]\]><\/AgentID>/);
  if (!encryptMatch) return null;

  const encrypt = encryptMatch[1];
  const signature = computeSignature(token, timestamp, nonce, encrypt);
  if (signature !== msgSignature) {
    console.warn('[wecom] 消息签名不匹配');
    return null;
  }

  try {
    const { message } = decryptMessage(encodingAesKey, encrypt);
    return {
      toUserName: toUserMatch ? toUserMatch[1] : '',
      agentId: agentIdMatch ? agentIdMatch[1] : '',
      encrypt,
      message
    };
  } catch (error) {
    console.error('[wecom] 解密消息失败:', error.message);
    return null;
  }
}

module.exports = {
  getWecomAccessToken,
  clearWecomTokenCache,
  sendAppMessage,
  sendWebhookMessage,
  createAppChat,
  inviteChatMembers,
  computeSignature,
  decryptMessage,
  encryptMessage,
  verifyCallbackUrl,
  parseEncryptedXml
};
