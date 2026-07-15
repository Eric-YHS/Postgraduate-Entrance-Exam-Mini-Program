const crypto = require('crypto');

const WECHAT_API_BASE = 'https://api.weixin.qq.com';
const TOKEN_RETRY_CODES = new Set([40001, 40014, 42001]);
const SESSION_TOKEN_PREFIX = 'cs1';
const SESSION_TTL_MS = 90 * 60 * 1000;

let cachedAccessToken = '';
let cachedAccessTokenAppId = '';
let accessTokenExpiresAt = 0;
let accessTokenPromise = null;

class ContentSecurityError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'ContentSecurityError';
    this.code = code;
    this.details = details;
  }
}

function assertConfigured(config) {
  if (!config.wxAppId || !config.wxAppSecret) {
    throw new ContentSecurityError(
      'WX_CONFIG_MISSING',
      '微信内容安全服务尚未配置，请联系管理员。'
    );
  }
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 12000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    // 响应体读取也必须受同一个超时控制，避免微信只返回响应头后长期不结束。
    const text = await response.text();
    return { response, text };
  } catch (error) {
    if (error && error.name === 'AbortError') {
      throw new ContentSecurityError('WECHAT_TIMEOUT', '微信内容安全服务响应超时。');
    }
    throw new ContentSecurityError('WECHAT_NETWORK_ERROR', '微信内容安全服务暂不可用。');
  } finally {
    clearTimeout(timeout);
  }
}

function readJsonResponse(result) {
  const { response, text } = result;
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch (_) {
    throw new ContentSecurityError('WECHAT_INVALID_RESPONSE', '微信内容安全服务返回了无效数据。');
  }

  if (!response.ok) {
    throw new ContentSecurityError(
      'WECHAT_HTTP_ERROR',
      '微信内容安全服务请求失败。',
      { status: response.status, errcode: data.errcode }
    );
  }
  return data;
}

async function requestJson(url, options = {}) {
  const result = await fetchWithTimeout(url, options);
  return readJsonResponse(result);
}

function clearAccessTokenCache() {
  cachedAccessToken = '';
  cachedAccessTokenAppId = '';
  accessTokenExpiresAt = 0;
  accessTokenPromise = null;
}

async function getAccessToken(config, forceRefresh = false) {
  assertConfigured(config);
  const now = Date.now();
  if (
    !forceRefresh &&
    cachedAccessToken &&
    cachedAccessTokenAppId === config.wxAppId &&
    accessTokenExpiresAt - now > 5 * 60 * 1000
  ) {
    return cachedAccessToken;
  }

  if (!forceRefresh && accessTokenPromise) {
    return accessTokenPromise;
  }

  accessTokenPromise = (async () => {
    const data = await requestJson(`${WECHAT_API_BASE}/cgi-bin/stable_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'client_credential',
        appid: config.wxAppId,
        secret: config.wxAppSecret,
        force_refresh: Boolean(forceRefresh)
      })
    });

    if (!data.access_token) {
      throw new ContentSecurityError(
        'WECHAT_TOKEN_ERROR',
        '无法获取微信接口调用凭据。',
        { errcode: data.errcode, errmsg: data.errmsg }
      );
    }

    cachedAccessToken = data.access_token;
    cachedAccessTokenAppId = config.wxAppId;
    accessTokenExpiresAt = Date.now() + Math.max(Number(data.expires_in) || 7200, 300) * 1000;
    return cachedAccessToken;
  })();

  try {
    return await accessTokenPromise;
  } finally {
    accessTokenPromise = null;
  }
}

async function callWithAccessToken(config, operation) {
  let token = await getAccessToken(config);
  let result = await operation(token);
  if (TOKEN_RETRY_CODES.has(Number(result && result.errcode))) {
    clearAccessTokenCache();
    token = await getAccessToken(config, true);
    result = await operation(token);
  }
  return result;
}

async function exchangeLoginCode(config, code) {
  assertConfigured(config);
  const normalizedCode = String(code || '').trim();
  if (!normalizedCode || normalizedCode.length > 128) {
    throw new ContentSecurityError('INVALID_LOGIN_CODE', '登录凭证无效，请重试。');
  }

  const params = new URLSearchParams({
    appid: config.wxAppId,
    secret: config.wxAppSecret,
    js_code: normalizedCode,
    grant_type: 'authorization_code'
  });
  const data = await requestJson(`${WECHAT_API_BASE}/sns/jscode2session?${params.toString()}`);
  if (!data.openid) {
    throw new ContentSecurityError(
      'WECHAT_LOGIN_ERROR',
      '微信登录校验失败，请重新打开小程序后再试。',
      { errcode: data.errcode, errmsg: data.errmsg }
    );
  }
  return { openid: data.openid };
}

function signSessionPayload(encodedPayload, sessionSecret) {
  return crypto.createHmac('sha256', sessionSecret).update(encodedPayload).digest('base64url');
}

function issueSessionToken(openid, sessionSecret, now = Date.now()) {
  const payload = {
    sub: openid,
    iat: now,
    exp: now + SESSION_TTL_MS,
    nonce: crypto.randomBytes(12).toString('hex')
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = signSessionPayload(encodedPayload, sessionSecret);
  return {
    token: `${SESSION_TOKEN_PREFIX}.${encodedPayload}.${signature}`,
    expiresAt: payload.exp
  };
}

function verifySessionToken(token, sessionSecret, now = Date.now()) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3 || parts[0] !== SESSION_TOKEN_PREFIX) {
    throw new ContentSecurityError('INVALID_SECURITY_SESSION', '内容安全会话无效，请重试。');
  }

  const expected = signSessionPayload(parts[1], sessionSecret);
  const actualBuffer = Buffer.from(parts[2]);
  const expectedBuffer = Buffer.from(expected);
  if (
    actualBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(actualBuffer, expectedBuffer)
  ) {
    throw new ContentSecurityError('INVALID_SECURITY_SESSION', '内容安全会话无效，请重试。');
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch (_) {
    throw new ContentSecurityError('INVALID_SECURITY_SESSION', '内容安全会话无效，请重试。');
  }
  if (!payload.sub || !Number.isFinite(payload.exp) || payload.exp <= now) {
    throw new ContentSecurityError('EXPIRED_SECURITY_SESSION', '内容安全会话已过期，请重试。');
  }
  return { openid: payload.sub, expiresAt: payload.exp };
}

async function msgSecCheck(config, { content, openid, scene = 3 }) {
  return callWithAccessToken(config, (accessToken) =>
    requestJson(`${WECHAT_API_BASE}/wxa/msg_sec_check?access_token=${encodeURIComponent(accessToken)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content,
        version: 2,
        scene,
        openid
      })
    })
  );
}

async function imgSecCheck(config, { buffer, filename = 'content.jpg', contentType = 'image/jpeg' }) {
  return callWithAccessToken(config, async (accessToken) => {
    const form = new FormData();
    form.append('media', new Blob([buffer], { type: contentType }), filename);
    const result = await fetchWithTimeout(
      `${WECHAT_API_BASE}/wxa/img_sec_check?access_token=${encodeURIComponent(accessToken)}`,
      { method: 'POST', body: form },
      20000
    );
    return readJsonResponse(result);
  });
}

async function mediaCheckAsync(config, { mediaUrl, openid, mediaType = 2, scene = 3 }) {
  return callWithAccessToken(config, (accessToken) =>
    requestJson(`${WECHAT_API_BASE}/wxa/media_check_async?access_token=${encodeURIComponent(accessToken)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        media_url: mediaUrl,
        media_type: mediaType,
        version: 2,
        scene,
        openid
      })
    })
  );
}

function summarizeCheck(apiName, response) {
  const rawErrcode = response && response.errcode;
  const hasNumericErrcode = (
    typeof rawErrcode === 'number' && Number.isFinite(rawErrcode)
  ) || (
    typeof rawErrcode === 'string' && /^-?\d+$/.test(rawErrcode.trim())
  );
  const errcode = hasNumericErrcode ? Number(rawErrcode) : -1;
  const suggestion = String(response?.result?.suggest || response?.suggest || '');
  const labelValue = response?.result?.label ?? response?.label;
  const label = Number.isFinite(Number(labelValue)) ? Number(labelValue) : null;
  const traceId = String(response?.trace_id || response?.traceId || '').trim();
  let status = 'error';

  if (errcode === 87014 || suggestion === 'risky') status = 'rejected';
  else if (suggestion === 'review') status = 'review';
  // v2 文本检测的成功响应必须同时给出明确结论和 trace_id；字段缺失时失败关闭。
  else if (errcode === 0 && apiName === 'msgSecCheck' && suggestion === 'pass' && traceId) status = 'passed';
  // 异步媒体接口的 errcode=0 只表示任务已提交，trace_id 是有效提交的必要凭据。
  else if (errcode === 0 && apiName === 'mediaCheckAsync' && traceId) status = 'submitted';
  // 旧版同步图片接口成功时通常只有 errcode=0/errmsg=ok，不强制 suggest 或 trace_id。
  else if (errcode === 0 && apiName === 'imgSecCheck' && (!suggestion || suggestion === 'pass')) status = 'passed';

  return {
    apiName,
    errcode,
    errmsg: String(response?.errmsg || ''),
    suggestion,
    label,
    traceId,
    status,
    raw: response
  };
}

function isCheckAllowed(summary) {
  return summary.status === 'passed' || summary.status === 'submitted';
}

function digestInput(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function hashOpenId(openid) {
  return digestInput(String(openid));
}

function saveCheck(db, { requestId, openid, apiName, contentType, input, response }) {
  const summary = summarizeCheck(apiName, response);
  const inputValue = Buffer.isBuffer(input) ? input : Buffer.from(String(input));
  db.prepare(
    `INSERT INTO content_security_checks
      (request_id, user_hash, api_name, content_type, input_digest, status, errcode, errmsg,
       suggestion, label, trace_id, raw_response, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    requestId,
    hashOpenId(openid),
    apiName,
    contentType,
    digestInput(inputValue),
    summary.status,
    summary.errcode,
    summary.errmsg,
    summary.suggestion,
    summary.label,
    summary.traceId,
    JSON.stringify(response || {}),
    new Date().toISOString()
  );
  return summary;
}

function getRecentChecks(db, openid, limit = 20) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 20, 50));
  return db.prepare(
    `SELECT request_id, api_name, content_type, status, errcode, errmsg, suggestion, label,
            trace_id, raw_response, created_at
       FROM content_security_checks
      WHERE user_hash = ?
      ORDER BY id DESC
      LIMIT ?`
  ).all(hashOpenId(openid), safeLimit).map((row) => ({
    requestId: row.request_id,
    apiName: row.api_name,
    contentType: row.content_type,
    status: row.status,
    errcode: row.errcode,
    errmsg: row.errmsg,
    suggestion: row.suggestion,
    label: row.label,
    traceId: row.trace_id,
    raw: (() => {
      try { return JSON.parse(row.raw_response); } catch (_) { return {}; }
    })(),
    createdAt: row.created_at
  }));
}

module.exports = {
  ContentSecurityError,
  assertConfigured,
  exchangeLoginCode,
  issueSessionToken,
  verifySessionToken,
  msgSecCheck,
  imgSecCheck,
  mediaCheckAsync,
  summarizeCheck,
  isCheckAllowed,
  saveCheck,
  getRecentChecks,
  hashOpenId,
  clearAccessTokenCache
};
