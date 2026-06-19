/**
 * 群聊上下文构建器
 *
 * 三层记忆检索：
 *   Layer 1 (STM): 最近 50 条同群消息 → 格式化时间线
 *   Layer 2 (LTM): 向量检索记忆卡 → Top 5 相关记忆
 *   Layer 3 (Profile): 发送者画像 → 个性化信息
 *
 * 依赖：
 *   - SQLite (wecom_archive_messages, memory_cards, member_profiles)
 *   - ai.generateEmbedding (复用现有本地 Embedding 模型)
 *   - 纯 JS 余弦相似度计算（无外部依赖）
 */

const { db } = require('../db');
const { generateEmbedding } = require('./ai');
const dayjs = require('dayjs');

// ── 常量 ─────────────────────────────────────────────────────────────────
const STM_MAX_MESSAGES = 50;       // 上下文窗口大小
const MEMORY_TOP_K = 5;            // 记忆卡检索数量
const MEMORY_MIN_SCORE = 0.25;     // 记忆卡最低相似度阈值
const MAX_CONTEXT_TOKENS_ESTIMATE = 1500; // 上下文 token 上限（中文约 1.5 字/token）

// ── Layer 1: STM 对话缓冲区 ──────────────────────────────────────────────

/**
 * 查询最近 N 条同群消息
 * @param {string} roomid
 * @param {number} beforeTimeMs - 当前消息时间（ms），只取此前的消息
 * @param {number} limit
 * @returns {Array<{from_user:string, content:string, msgtime_ms:number}>}
 */
function queryRecentMessages(roomid, beforeTimeMs, limit = STM_MAX_MESSAGES) {
  try {
    const rows = db.prepare(`
      SELECT from_user, content, msgtime_ms, msgtype
      FROM wecom_archive_messages
      WHERE roomid = ? AND msgtime_ms < ? AND msgtype = 'text' AND content != ''
      ORDER BY msgtime_ms DESC
      LIMIT ?
    `).all(roomid, beforeTimeMs, limit);

    // 逆序查出来的，翻转为正序
    return rows.reverse();
  } catch (err) {
    console.error('[context-builder] STM 查询失败:', err.message);
    return [];
  }
}

/**
 * 格式化消息时间线为 prompt 文本
 * 合并同一发送者的连续消息
 */
function formatTimeline(messages) {
  if (!messages || messages.length === 0) return '';

  const lines = [];
  let lastUser = '';
  let groupBuffer = [];

  for (const msg of messages) {
    const time = msg.msgtime_ms
      ? dayjs(msg.msgtime_ms).format('HH:mm')
      : '--:--';
    const user = msg.from_user || '未知';
    const content = (msg.content || '').trim().slice(0, 200); // 截断超长消息

    if (user === lastUser) {
      // 同一用户连续发言 → 合并
      groupBuffer.push(content);
    } else {
      // 输出上一组
      if (groupBuffer.length > 0) {
        lines.push(formatGroup(lastUser, lastTime, groupBuffer));
      }
      lastUser = user;
      lastTime = time;
      groupBuffer = [content];
    }
  }
  // 最后一组
  if (groupBuffer.length > 0) {
    lines.push(formatGroup(lastUser, lastTime, groupBuffer));
  }

  return lines.join('\n');
}

function formatGroup(user, time, contents) {
  if (contents.length === 1) {
    return `[${time}] ${user}: ${contents[0]}`;
  }
  return `[${time}] ${user}: ` + contents.join(' → ');
}

// ── Layer 2: LTM 记忆卡检索 ──────────────────────────────────────────────

/**
 * 余弦相似度
 */
function cosineSimilarity(vecA, vecB) {
  if (!vecA || !vecB || vecA.length !== vecB.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dot += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * 对 query 文本检索相关记忆卡
 * @param {string} roomid
 * @param {string} queryText
 * @returns {Promise<Array<{card_type:string, content:string, score:number}>>}
 */
async function searchMemoryCards(roomid, queryText) {
  try {
    // 查询同群所有有 embedding 的记忆卡
    const cards = db.prepare(`
      SELECT id, card_type, content, embedding, hit_count, last_hit_at
      FROM memory_cards
      WHERE roomid = ? AND embedding IS NOT NULL AND embedding != ''
    `).all(roomid);

    if (cards.length === 0) return [];

    // 生成 query embedding
    const queryEmb = await generateEmbedding(queryText);
    if (!queryEmb) return [];

    // 计算相似度 + 混合排序
    const scored = cards.map((card) => {
      let emb;
      try { emb = JSON.parse(card.embedding); } catch (_) { return null; }
      const similarity = cosineSimilarity(queryEmb, emb);
      if (similarity < MEMORY_MIN_SCORE) return null;

      // 命中强化因子: 被多次命中的记忆提高权重
      const hitBoost = Math.min(1, (card.hit_count || 0) / 5);
      // 时间衰减: 最近被命中的记忆更有价值
      let recencyBoost = 1.0;
      if (card.last_hit_at) {
        const daysSinceHit = (Date.now() - new Date(card.last_hit_at).getTime()) / (1000 * 86400);
        recencyBoost = Math.max(0.3, 1 - daysSinceHit / 30);
      }

      return {
        card_type: card.card_type,
        content: card.content,
        score: Math.round(similarity * (1 + hitBoost * 0.5) * recencyBoost * 1000) / 1000,
        cardId: card.id,
      };
    }).filter(Boolean);

    // 按混合分数排序 → Top K
    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, MEMORY_TOP_K);

    // 更新命中计数（异步，不阻塞回复）
    updateHitCounts(top).catch(() => {});

    return top;
  } catch (err) {
    console.error('[context-builder] 记忆卡检索失败:', err.message);
    return [];
  }
}

async function updateHitCounts(cards) {
  const stmt = db.prepare(`
    UPDATE memory_cards SET hit_count = hit_count + 1, last_hit_at = ? WHERE id = ?
  `);
  const now = new Date().toISOString();
  for (const c of cards) {
    try { stmt.run(now, c.cardId); } catch (_) {}
  }
}

function formatMemoryCards(cards) {
  if (!cards || cards.length === 0) return '';
  const typeLabel = { fact: '📌', question: '❓', topic: '🔗', summary: '📝' };
  return cards.map((c) =>
    `${typeLabel[c.card_type] || '•'} ${c.content}`
  ).join('\n');
}

// ── Layer 3: 成员画像 ────────────────────────────────────────────────────

function getSenderProfile(wecomUserid) {
  try {
    const row = db.prepare(`
      SELECT profile_json, display_name FROM member_profiles WHERE wecom_userid = ?
    `).get(wecomUserid);
    if (!row) return null;
    const profile = JSON.parse(row.profile_json || '{}');
    return { ...profile, displayName: row.display_name || wecomUserid };
  } catch (err) {
    return null;
  }
}

function formatProfile(profile) {
  if (!profile || Object.keys(profile).filter((k) => k !== 'displayName' && k !== 'confidence' && k !== 'lastUpdated').length === 0) {
    return '';
  }
  const parts = [];
  if (profile.targetSchool) parts.push(`目标：${profile.targetSchool}`);
  if (profile.targetMajor) parts.push(profile.targetMajor);
  if (profile.examType) parts.push(profile.examType);
  if (profile.weakSubjects?.length) parts.push(`弱项：${profile.weakSubjects.join('、')}`);
  if (profile.studyPhase) parts.push(`阶段：${profile.studyPhase}`);
  if (parts.length === 0) return '';
  return `[${profile.displayName || '该成员'}的学习情况]\n${parts.join(' | ')}`;
}

// ── 主入口 ───────────────────────────────────────────────────────────────

/**
 * 构建群聊回复的完整上下文
 *
 * @param {object} params
 * @param {string} params.roomid        - 群聊 ID
 * @param {string} params.currentMsg    - 当前消息文本
 * @param {string} params.currentUserId - 发送者企微 userId
 * @param {number} params.currentMsgtime - 当前消息时间戳（ms）
 * @returns {Promise<{timeline:string, memoryCardsText:string, profileText:string, fullContext:string}>}
 */
async function buildGroupContext({ roomid, currentMsg, currentUserId, currentMsgtime }) {
  const sections = [];

  // Layer 1: STM 时间线
  const recentMessages = queryRecentMessages(roomid, currentMsgtime || Date.now());
  const timeline = formatTimeline(recentMessages);
  if (timeline) {
    sections.push(`[群聊上下文 — 最近消息]\n${timeline}`);
  }

  // Layer 2: LTM 记忆卡（并行检索，不阻塞 STM）
  let memoryCardsText = '';
  if (currentMsg && currentMsg.trim().length >= 2) {
    try {
      const cards = await searchMemoryCards(roomid, currentMsg);
      memoryCardsText = formatMemoryCards(cards);
      if (memoryCardsText) {
        sections.push(`[相关讨论历史]\n${memoryCardsText}`);
      }
    } catch (err) {
      console.error('[context-builder] 记忆检索跳过:', err.message);
    }
  }

  // Layer 3: 发送者画像
  let profileText = '';
  const profile = getSenderProfile(currentUserId);
  if (profile) {
    profileText = formatProfile(profile);
    if (profileText) {
      sections.push(profileText);
    }
  }

  const fullContext = sections.join('\n\n');

  return {
    timeline,
    memoryCardsText,
    profileText,
    fullContext,
  };
}

module.exports = {
  buildGroupContext,
  // 暴露子功能方便测试
  queryRecentMessages,
  formatTimeline,
  searchMemoryCards,
  getSenderProfile,
};
