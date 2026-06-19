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
 * 检测文本是否包含敏感词
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
    if (input.includes(word)) {
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
