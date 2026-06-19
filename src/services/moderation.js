const dayjs = require('dayjs');

// 默认本地敏感词缓存（每次调用从数据库刷新，简单实现）
let cachedWords = null;
let cachedAt = 0;
const CACHE_TTL_MS = 60_000;

function loadSensitiveWords(db) {
  const now = Date.now();
  if (cachedWords && now - cachedAt < CACHE_TTL_MS) return cachedWords;
  try {
    const rows = db.prepare('SELECT word, level FROM sensitive_words').all();
    cachedWords = rows.map((r) => ({ word: r.word, level: r.level }));
    cachedAt = now;
    return cachedWords;
  } catch (err) {
    console.error('[moderation] 加载敏感词失败:', err.message);
    return [];
  }
}

/**
 * 检测文本是否包含敏感词（带词边界感知，避免子串误匹配）
 * 策略：对纯中文敏感词，要求前后不是 CJK 字符，避免如"政府"误匹配"人民政府"
 * @param {object} db - better-sqlite3 实例
 * @param {string} text - 待检测文本
 * @returns {{blocked: boolean, review: boolean, matched: string[], level: 'block'|'review'|null}}
 */
function detectSensitiveWords(db, text) {
  const words = loadSensitiveWords(db);
  const input = String(text || '');
  const matchedBlock = [];
  const matchedReview = [];

  for (const { word, level } of words) {
    if (!word) continue;
    if (matchWithBoundary(input, word)) {
      if (level === 'block') matchedBlock.push(word);
      else matchedReview.push(word);
    }
  }

  if (matchedBlock.length > 0) {
    return { blocked: true, review: false, matched: matchedBlock, level: 'block' };
  }
  if (matchedReview.length > 0) {
    return { blocked: false, review: true, matched: matchedReview, level: 'review' };
  }
  return { blocked: false, review: false, matched: [], level: null };
}

/**
 * 带词边界感知的匹配
 * 对纯中文敏感词，使用正则断言确保前后不是可构成复合词的中文字符
 * 对非纯中文敏感词，使用普通 contains 匹配
 */
function matchWithBoundary(text, word) {
  if (!word) return false;
  // 非纯中文 → 普通包含匹配
  if (!/^[一-鿿]+$/.test(word)) {
    return text.includes(word);
  }
  // 纯中文 → 词边界正则：前不能是中文、后不能是中文
  const regex = new RegExp(
    `(?<![一-鿿])${escapeRegex(word)}(?![一-鿿])`,
    'gu'
  );
  return regex.test(text);
}

/**
 * 转义正则特殊字符
 */
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 重新加载敏感词缓存（供管理后台增删后调用）
 */
function invalidateCache() {
  cachedWords = null;
  cachedAt = 0;
}

module.exports = {
  detectSensitiveWords,
  invalidateCache
};
