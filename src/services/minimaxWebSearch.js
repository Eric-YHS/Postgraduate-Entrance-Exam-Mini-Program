/**
 * MiniMax 官方网络搜索。
 *
 * 接口与 MiniMax 官方 Coding Plan MCP 的 web_search 工具一致：
 * POST https://api.minimaxi.com/v1/coding_plan/search
 * 这里只返回结构化网页证据，不把网页片段当作系统指令。
 */

const config = require('../config');

const TRANSIENT_HTTP_STATUSES = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
const TRANSIENT_ERROR_CODES = new Set([
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
]);

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cleanText(value, maxLength) {
  return String(value || '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function cleanWebUrl(value) {
  try {
    const parsed = new URL(String(value || '').trim());
    if (!['http:', 'https:'].includes(parsed.protocol)) return '';
    parsed.username = '';
    parsed.password = '';
    parsed.hash = '';
    return parsed.toString();
  } catch (_) {
    return '';
  }
}

function normalizeSearchResponse(data, query) {
  const seen = new Set();
  const results = [];
  for (const item of Array.isArray(data?.organic) ? data.organic : []) {
    const url = cleanWebUrl(item?.link);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    results.push({
      title: cleanText(item?.title, 300) || url,
      url,
      snippet: cleanText(item?.snippet, 1500),
      date: cleanText(item?.date, 80),
    });
    if (results.length >= 10) break;
  }
  const relatedSearches = (Array.isArray(data?.related_searches) ? data.related_searches : [])
    .map((item) => cleanText(item?.query || item, 300))
    .filter(Boolean)
    .slice(0, 8);
  return {
    provider: 'MiniMax 官方网络搜索',
    query,
    results,
    relatedSearches,
  };
}

function isTransientError(error) {
  if (!error) return false;
  if (error.retryable || error.name === 'AbortError' || error.name === 'TimeoutError') return true;
  const code = String(error.code || error.cause?.code || '').toUpperCase();
  return TRANSIENT_ERROR_CODES.has(code);
}

function createMinimaxWebSearch(dependencies = {}) {
  const fetchImpl = dependencies.fetchImpl || global.fetch;
  const apiKey = dependencies.apiKey !== undefined
    ? dependencies.apiKey
    : config.minimaxApiKey;
  const apiUrl = dependencies.apiUrl
    || config.minimaxWebSearchApiUrl
    || 'https://api.minimaxi.com/v1/coding_plan/search';
  const enabled = dependencies.enabled !== undefined
    ? Boolean(dependencies.enabled)
    : Boolean(config.minimaxWebSearchEnabled);
  const timeoutMs = Math.max(1000, Number(dependencies.timeoutMs) || 30000);
  const maxAttempts = Math.min(8, Math.max(1, Number(dependencies.maxAttempts) || 4));
  const sleep = dependencies.sleep || delay;

  async function search(queryValue) {
    if (!enabled) throw new Error('MiniMax 官方网络搜索未启用');
    if (!apiKey) throw new Error('MiniMax 官方网络搜索未配置 API Key');
    if (typeof fetchImpl !== 'function') throw new Error('当前 Node.js 运行时不支持 fetch');

    const query = cleanText(queryValue, 500);
    if (!query) throw new Error('网络搜索词不能为空');

    let lastError;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(apiUrl, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            'MM-API-Source': 'Minimax-MCP',
          },
          body: JSON.stringify({ q: query }),
          signal: controller.signal,
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          const error = new Error(`MiniMax 官方搜索 HTTP ${response.status}`);
          error.statusCode = Number(response.status) || 0;
          error.retryable = TRANSIENT_HTTP_STATUSES.has(error.statusCode);
          const retryAfter = Number(response.headers?.get?.('retry-after'));
          error.retryAfterMs = Number.isFinite(retryAfter) ? retryAfter * 1000 : 0;
          throw error;
        }
        const providerCode = Number(data?.base_resp?.status_code || 0);
        if (providerCode !== 0) {
          const error = new Error(data?.base_resp?.status_msg || `MiniMax 搜索错误码 ${providerCode}`);
          error.providerCode = providerCode;
          error.retryable = providerCode === 1002 || providerCode === 1003;
          throw error;
        }
        return normalizeSearchResponse(data, query);
      } catch (error) {
        lastError = error;
        if (!isTransientError(error) || attempt >= maxAttempts) throw error;
        const retryAfterMs = Math.min(10000, Math.max(0, Number(error.retryAfterMs) || 0));
        const backoffMs = Math.min(8000, 400 * (2 ** (attempt - 1)));
        await sleep(Math.max(retryAfterMs, backoffMs));
      } finally {
        clearTimeout(timeout);
      }
    }
    throw lastError || new Error('MiniMax 官方网络搜索失败');
  }

  return { search };
}

const defaultClient = createMinimaxWebSearch();

module.exports = {
  createMinimaxWebSearch,
  normalizeSearchResponse,
  search: defaultClient.search,
};
