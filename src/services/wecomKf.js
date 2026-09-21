/**
 * 微信客服 API 客户端。
 *
 * 与企业内部应用消息使用同一个 CorpID，但使用“被授权为可调用微信客服接口”
 * 的自建应用 Secret。所有 access_token 只保存在服务端内存中。
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('../config');

const DEFAULT_API_BASE = 'https://qyapi.weixin.qq.com/cgi-bin';
const TOKEN_ERROR_CODES = new Set([40014, 42001, 42007]);
const TRANSIENT_ERROR_CODES = new Set([-1, 45009]);
const TRANSIENT_HTTP_STATUSES = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

class WecomKfApiError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'WecomKfApiError';
    this.errcode = Number(details.errcode);
    this.errmsg = details.errmsg || '';
    this.status = Number(details.status) || 0;
    this.retryable = Boolean(details.retryable);
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizePositiveInt(value, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(number)));
}

function isTransientNetworkError(error) {
  if (!error) return false;
  if (error.name === 'AbortError' || error.name === 'TimeoutError') return true;
  const code = String(error.code || error.cause?.code || '').toUpperCase();
  return [
    'ECONNRESET',
    'ECONNREFUSED',
    'EAI_AGAIN',
    'ENETDOWN',
    'ENETRESET',
    'ENETUNREACH',
    'ETIMEDOUT',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_HEADERS_TIMEOUT',
    'UND_ERR_SOCKET',
  ].includes(code);
}

function utf8Chunks(value, maxBytes = 2048, maxChunks = 5) {
  const text = String(value || '').trim();
  if (!text) return [];
  const byteLimit = normalizePositiveInt(maxBytes, 2048, 64, 2048);
  const chunkLimit = normalizePositiveInt(maxChunks, 5, 1, 5);
  const chunks = [];
  let current = '';
  let currentBytes = 0;

  for (const character of text) {
    const bytes = Buffer.byteLength(character);
    if (current && currentBytes + bytes > byteLimit) {
      chunks.push(current);
      if (chunks.length >= chunkLimit) break;
      current = '';
      currentBytes = 0;
    }
    if (bytes > byteLimit) continue;
    current += character;
    currentBytes += bytes;
  }

  if (current && chunks.length < chunkLimit) chunks.push(current);
  const included = chunks.join('');
  if (included.length < text.length && chunks.length) {
    const suffix = '\n\n[回复内容较长，已截断]';
    const last = chunks[chunks.length - 1];
    while (Buffer.byteLength(chunks[chunks.length - 1] + suffix) > byteLimit) {
      chunks[chunks.length - 1] = [...chunks[chunks.length - 1]].slice(0, -1).join('');
    }
    chunks[chunks.length - 1] += suffix;
  }
  return chunks;
}

function makeKfMessageId(prefix = 'reply') {
  const safePrefix = String(prefix || 'reply').replace(/[^0-9a-zA-Z_-]/g, '').slice(0, 8) || 'reply';
  return `${safePrefix}_${Date.now().toString(36)}_${crypto.randomBytes(6).toString('hex')}`.slice(0, 32);
}

function createWecomKfClient(dependencies = {}) {
  const fetchFn = dependencies.fetch || global.fetch;
  if (typeof fetchFn !== 'function') {
    throw new Error('当前 Node.js 环境不支持 fetch');
  }

  const corpId = dependencies.corpId ?? config.wecomCorpId;
  const secret = dependencies.secret ?? config.wecomKfSecret;
  const apiBase = String(dependencies.apiBase || DEFAULT_API_BASE).replace(/\/$/, '');
  const timeoutMs = normalizePositiveInt(
    dependencies.timeoutMs ?? process.env.WECOM_KF_REQUEST_TIMEOUT_MS,
    15000,
    1000,
    120000
  );
  const maxAttempts = normalizePositiveInt(
    dependencies.maxAttempts ?? process.env.WECOM_KF_REQUEST_MAX_ATTEMPTS,
    5,
    1,
    10
  );
  const sleep = dependencies.sleep || delay;

  let tokenCache = { token: '', expiresAt: 0 };
  let tokenInFlight = null;

  async function fetchWithRetry(url, options = {}) {
    let lastError;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchFn(url, { ...options, signal: controller.signal });
        if (
          TRANSIENT_HTTP_STATUSES.has(Number(response.status))
          && attempt < maxAttempts
        ) {
          await response.arrayBuffer().catch(() => {});
          await sleep(Math.min(5000, 250 * (2 ** (attempt - 1))));
          continue;
        }
        return response;
      } catch (error) {
        lastError = error;
        if (!isTransientNetworkError(error) || attempt >= maxAttempts) throw error;
        await sleep(Math.min(5000, 250 * (2 ** (attempt - 1))));
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError || new Error('微信客服 API 请求失败');
  }

  async function readJsonResponse(response) {
    const raw = await response.text();
    let data;
    try {
      data = JSON.parse(raw);
    } catch (_) {
      throw new WecomKfApiError(`微信客服 API 返回了无效 JSON（HTTP ${response.status}）`, {
        status: response.status,
        retryable: TRANSIENT_HTTP_STATUSES.has(Number(response.status)),
      });
    }
    if (!response.ok) {
      throw new WecomKfApiError(data.errmsg || `微信客服 API HTTP ${response.status}`, {
        errcode: data.errcode,
        errmsg: data.errmsg,
        status: response.status,
        retryable: TRANSIENT_HTTP_STATUSES.has(Number(response.status)),
      });
    }
    return data;
  }

  async function requestJson(url, options = {}) {
    return readJsonResponse(await fetchWithRetry(url, options));
  }

  function clearTokenCache() {
    tokenCache = { token: '', expiresAt: 0 };
  }

  async function getAccessToken(forceRefresh = false) {
    if (!corpId || !secret) {
      throw new WecomKfApiError('微信客服鉴权未配置：缺少 WECOM_CORP_ID 或自建应用 Secret', {
        errcode: 0,
      });
    }
    const now = Date.now();
    if (!forceRefresh && tokenCache.token && tokenCache.expiresAt > now) {
      return tokenCache.token;
    }
    if (!forceRefresh && tokenInFlight) return tokenInFlight;

    tokenInFlight = (async () => {
      const url = `${apiBase}/gettoken?corpid=${encodeURIComponent(corpId)}&corpsecret=${encodeURIComponent(secret)}`;
      const data = await requestJson(url);
      if (Number(data.errcode || 0) !== 0 || !data.access_token) {
        throw new WecomKfApiError(data.errmsg || '获取微信客服 access_token 失败', {
          errcode: data.errcode,
          errmsg: data.errmsg,
          retryable: TRANSIENT_ERROR_CODES.has(Number(data.errcode)),
        });
      }
      const expiresIn = normalizePositiveInt(data.expires_in, 7200, 60, 86400);
      tokenCache = {
        token: data.access_token,
        expiresAt: Date.now() + Math.max(60, expiresIn - 300) * 1000,
      };
      return data.access_token;
    })();

    try {
      return await tokenInFlight;
    } finally {
      tokenInFlight = null;
    }
  }

  async function callApi(endpoint, body = {}, options = {}) {
    let forceTokenRefresh = false;
    let lastError;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const token = await getAccessToken(forceTokenRefresh);
      forceTokenRefresh = false;
      const url = `${apiBase}${endpoint}?access_token=${encodeURIComponent(token)}`;
      try {
        const data = await requestJson(url, {
          method: options.method || 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body || {}),
        });
        const errcode = Number(data.errcode || 0);
        if (errcode === 0) return data;
        if (TOKEN_ERROR_CODES.has(errcode) && attempt < maxAttempts) {
          clearTokenCache();
          forceTokenRefresh = true;
          continue;
        }
        if (TRANSIENT_ERROR_CODES.has(errcode) && attempt < maxAttempts) {
          await sleep(Math.min(5000, 250 * (2 ** (attempt - 1))));
          continue;
        }
        throw new WecomKfApiError(data.errmsg || `微信客服 API 错误 ${errcode}`, {
          errcode,
          errmsg: data.errmsg,
          retryable: TRANSIENT_ERROR_CODES.has(errcode),
        });
      } catch (error) {
        lastError = error;
        if (error instanceof WecomKfApiError && !error.retryable) throw error;
        if (!isTransientNetworkError(error) && !error.retryable) throw error;
        if (attempt >= maxAttempts) throw error;
        await sleep(Math.min(5000, 250 * (2 ** (attempt - 1))));
      }
    }
    throw lastError || new WecomKfApiError('微信客服 API 请求失败');
  }

  async function listAccounts() {
    const accounts = [];
    let offset = 0;
    const limit = 100;
    while (true) {
      const data = await callApi('/kf/account/list', { offset, limit });
      const page = Array.isArray(data.account_list) ? data.account_list : [];
      accounts.push(...page);
      if (page.length < limit) break;
      offset += page.length;
    }
    return accounts;
  }

  async function getContactWay(openKfid, scene = 'admin') {
    if (!openKfid) throw new Error('open_kfid 不能为空');
    const body = { open_kfid: String(openKfid) };
    const normalizedScene = String(scene || '').trim();
    if (normalizedScene) body.scene = normalizedScene.slice(0, 32);
    return callApi('/kf/add_contact_way', body);
  }

  async function syncMessages({
    openKfid,
    cursor = '',
    token = '',
    limit = 1000,
    voiceFormat = 0,
  }) {
    if (!openKfid) throw new Error('open_kfid 不能为空');
    const body = {
      open_kfid: String(openKfid),
      limit: normalizePositiveInt(limit, 1000, 1, 1000),
      voice_format: Number(voiceFormat) === 1 ? 1 : 0,
    };
    if (cursor) body.cursor = String(cursor);
    if (token) body.token = String(token);
    return callApi('/kf/sync_msg', body);
  }

  async function sendMessage(payload) {
    if (!payload?.touser || !payload?.open_kfid || !payload?.msgtype) {
      throw new Error('发送微信客服消息缺少 touser、open_kfid 或 msgtype');
    }
    return callApi('/kf/send_msg', payload);
  }

  async function sendText(openKfid, externalUserid, content, msgid = makeKfMessageId()) {
    const chunks = utf8Chunks(content, 2048, 1);
    if (!chunks.length) throw new Error('微信客服文字回复不能为空');
    return sendMessage({
      touser: String(externalUserid),
      open_kfid: String(openKfid),
      msgid,
      msgtype: 'text',
      text: { content: chunks[0] },
    });
  }

  async function getServiceState(openKfid, externalUserid) {
    return callApi('/kf/service_state/get', {
      open_kfid: String(openKfid),
      external_userid: String(externalUserid),
    });
  }

  async function transitionServiceState(openKfid, externalUserid, serviceState, servicerUserid = '') {
    const body = {
      open_kfid: String(openKfid),
      external_userid: String(externalUserid),
      service_state: Number(serviceState),
    };
    if (Number(serviceState) === 3 && servicerUserid) {
      body.servicer_userid = String(servicerUserid);
    }
    return callApi('/kf/service_state/trans', body);
  }

  async function batchGetCustomers(externalUserids, needEnterSessionContext = false) {
    const ids = [...new Set((externalUserids || []).map(String).filter(Boolean))].slice(0, 100);
    if (!ids.length) return { customer_list: [], invalid_external_userid: [] };
    return callApi('/kf/customer/batchget', {
      external_userid_list: ids,
      need_enter_session_context: needEnterSessionContext ? 1 : 0,
    });
  }

  async function downloadMedia(mediaId, destinationPath, maxBytes = 20 * 1024 * 1024) {
    if (!mediaId || !destinationPath) throw new Error('媒体下载缺少 media_id 或保存路径');
    let forceTokenRefresh = false;
    let lastError;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const token = await getAccessToken(forceTokenRefresh);
      forceTokenRefresh = false;
      const url = `${apiBase}/media/get?access_token=${encodeURIComponent(token)}&media_id=${encodeURIComponent(mediaId)}`;
      try {
        const response = await fetchWithRetry(url);
        if (!response.ok) {
          throw new WecomKfApiError(`下载微信客服媒体失败（HTTP ${response.status}）`, {
            status: response.status,
            retryable: TRANSIENT_HTTP_STATUSES.has(Number(response.status)),
          });
        }
        const buffer = Buffer.from(await response.arrayBuffer());
        const contentType = String(response.headers?.get?.('content-type') || '').toLowerCase();
        if (contentType.includes('json') || buffer.subarray(0, 1).toString() === '{') {
          let data;
          try {
            data = JSON.parse(buffer.toString('utf8'));
          } catch (_) {
            throw new WecomKfApiError('微信客服媒体接口返回了无效内容');
          }
          const errcode = Number(data.errcode || 0);
          if (TOKEN_ERROR_CODES.has(errcode) && attempt < maxAttempts) {
            clearTokenCache();
            forceTokenRefresh = true;
            continue;
          }
          if (TRANSIENT_ERROR_CODES.has(errcode) && attempt < maxAttempts) {
            await sleep(Math.min(5000, 250 * (2 ** (attempt - 1))));
            continue;
          }
          throw new WecomKfApiError(data.errmsg || `下载微信客服媒体失败（${errcode}）`, {
            errcode,
            errmsg: data.errmsg,
            retryable: TRANSIENT_ERROR_CODES.has(errcode),
          });
        }
        if (!buffer.length) throw new WecomKfApiError('下载到的微信客服媒体为空');
        if (buffer.length > maxBytes) {
          throw new WecomKfApiError(`微信客服媒体超过 ${Math.ceil(maxBytes / 1024 / 1024)}MB 限制`);
        }
        await fs.promises.mkdir(path.dirname(destinationPath), { recursive: true, mode: 0o700 });
        await fs.promises.writeFile(destinationPath, buffer, { mode: 0o600 });
        return {
          bytes: buffer.length,
          contentType,
          filename: String(response.headers?.get?.('content-disposition') || ''),
        };
      } catch (error) {
        lastError = error;
        if (error instanceof WecomKfApiError && !error.retryable) throw error;
        if (!isTransientNetworkError(error) && !error.retryable) throw error;
        if (attempt >= maxAttempts) throw error;
        await sleep(Math.min(5000, 250 * (2 ** (attempt - 1))));
      }
    }
    throw lastError || new WecomKfApiError('下载微信客服媒体失败');
  }

  return {
    getAccessToken,
    clearTokenCache,
    listAccounts,
    getContactWay,
    syncMessages,
    sendMessage,
    sendText,
    getServiceState,
    transitionServiceState,
    batchGetCustomers,
    downloadMedia,
  };
}

const defaultClient = createWecomKfClient();

module.exports = {
  ...defaultClient,
  createWecomKfClient,
  WecomKfApiError,
  utf8Chunks,
  makeKfMessageId,
  TOKEN_ERROR_CODES,
  TRANSIENT_ERROR_CODES,
};
