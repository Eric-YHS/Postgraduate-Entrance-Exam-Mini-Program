/**
 * 群聊记忆提取器
 *
 * 从群聊对话中自动提取三类记忆卡：
 *   fact    — 确定性事实（"张三目标是浙大"）
 *   question — 讨论过的问题和结论
 *   topic   — 讨论的知识点话题
 *
 * 触发：每个群每累计 20 条新消息触发一次批量提取
 * 执行：异步后台，不阻塞消息回复
 */

const { db } = require('../db');
const { quickAsk } = require('./ai');
const { generateEmbedding } = require('./ai');
const dayjs = require('dayjs');

// ── 常量 ─────────────────────────────────────────────────────────────────
const EXTRACT_BATCH_SIZE = 20;   // 累计多少条新消息触发提取
const EXTRACT_WINDOW = 50;       // 每次提取最多取多少条消息
const DUPLICATE_THRESHOLD = 0.85; // 余弦相似度 > 此值视为重复记忆卡

// ── 提取触发判断 ─────────────────────────────────────────────────────────

/**
 * 检查并触发记忆提取（每个群每批新消息检查一次）
 * 由 archivePoller 每小时调用一次
 */
async function checkAndExtractAll() {
  // 找出所有有消息的群
  const rooms = db.prepare(`
    SELECT DISTINCT roomid FROM wecom_archive_messages
    WHERE roomid != '' AND msgtype = 'text' AND content != ''
  `).all();

  let totalExtracted = 0;

  for (const { roomid } of rooms) {
    try {
      const count = await extractMemoriesIfNeeded(roomid);
      totalExtracted += count;
    } catch (err) {
      console.error(`[memory-extractor] 群 ${roomid} 提取失败:`, err.message);
    }
  }

  if (totalExtracted > 0) {
    console.log(`[memory-extractor] 本轮共提取 ${totalExtracted} 条新记忆`);
  }
}

/**
 * 检查某个群是否需要提取记忆
 */
async function extractMemoriesIfNeeded(roomid) {
  // 获取上次提取的进度
  const progress = db.prepare(
    'SELECT last_extracted_msgid FROM memory_extraction_progress WHERE roomid = ?'
  ).get(roomid);

  const lastMsgid = progress?.last_extracted_msgid || '';

  // 查询自上次提取后的新消息数
  let newCount;
  if (lastMsgid) {
    const row = db.prepare(`
      SELECT COUNT(*) AS cnt FROM wecom_archive_messages
      WHERE roomid = ? AND msgid > ? AND msgtype = 'text' AND content != ''
    `).get(roomid, lastMsgid);
    newCount = row?.cnt || 0;
  } else {
    const row = db.prepare(`
      SELECT COUNT(*) AS cnt FROM wecom_archive_messages
      WHERE roomid = ? AND msgtype = 'text' AND content != ''
    `).get(roomid);
    newCount = row?.cnt || 0;
  }

  if (newCount < EXTRACT_BATCH_SIZE) return 0;

  // 提取记忆
  return await extractMemories(roomid, lastMsgid);
}

// ── 核心提取逻辑 ─────────────────────────────────────────────────────────

/**
 * 从群聊消息中提取记忆卡
 * @param {string} roomid
 * @param {string} sinceMsgid - 从这条消息之后开始提取（空=从头）
 * @returns {Promise<number>} 新提取的记忆卡数量
 */
async function extractMemories(roomid, sinceMsgid = '') {
  // 取最近消息
  let messages;
  if (sinceMsgid) {
    messages = db.prepare(`
      SELECT msgid, from_user, content, msgtime_ms
      FROM wecom_archive_messages
      WHERE roomid = ? AND msgid > ? AND msgtype = 'text' AND content != ''
      ORDER BY msgtime_ms ASC
      LIMIT ?
    `).all(roomid, sinceMsgid, EXTRACT_WINDOW);
  } else {
    messages = db.prepare(`
      SELECT msgid, from_user, content, msgtime_ms
      FROM wecom_archive_messages
      WHERE roomid = ? AND msgtype = 'text' AND content != ''
      ORDER BY msgtime_ms ASC
      LIMIT ?
    `).all(roomid, EXTRACT_WINDOW);
  }

  if (messages.length < EXTRACT_BATCH_SIZE) return 0;

  // 格式化对话日志
  const logLines = messages.map((m) => {
    const time = m.msgtime_ms ? dayjs(m.msgtime_ms).format('MM/DD HH:mm') : '--:--';
    return `[${time}] ${m.from_user}: ${m.content}`;
  });
  const chatLog = logLines.join('\n');

  // 调用 AI 提取记忆卡
  const cards = await aiExtractCards(chatLog);
  if (!cards || cards.length === 0) return 0;

  // 去重 + 写入
  const existingEmbCache = loadExistingEmbeddings(roomid);
  let newCount = 0;
  const msgidList = JSON.stringify(messages.map((m) => m.msgid));

  for (const card of cards) {
    if (!card.content || !card.type) continue;

    // 生成 embedding
    let emb = null;
    try {
      const vec = await generateEmbedding(card.content);
      if (vec) emb = JSON.stringify(vec);
    } catch (_) { /* embedding 失败继续，只是无法向量检索 */ }

    // 去重：检查与已有记忆的相似度
    if (emb && existingEmbCache.length > 0) {
      const queryVec = JSON.parse(emb);
      let isDuplicate = false;
      for (const existing of existingEmbCache) {
        const sim = cosineSimilarity(queryVec, existing.embedding);
        if (sim > DUPLICATE_THRESHOLD) {
          isDuplicate = true;
          break;
        }
      }
      if (isDuplicate) continue;

      // 缓存新 embedding
      existingEmbCache.push({ embedding: queryVec });
    }

    // 提取关键词（简单分词）
    const keywords = extractKeywords(card.content);

    // 写入
    db.prepare(`
      INSERT INTO memory_cards (roomid, card_type, content, keywords, embedding, source_msgids, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      roomid,
      card.type,
      card.content,
      keywords,
      emb || '',
      msgidList,
      new Date().toISOString()
    );

    newCount++;
  }

  // 更新提取进度
  const lastMsgid = messages[messages.length - 1].msgid;
  db.prepare(`
    INSERT INTO memory_extraction_progress (roomid, last_extracted_msgid, last_extracted_at)
    VALUES (?, ?, ?)
    ON CONFLICT(roomid) DO UPDATE SET
      last_extracted_msgid = excluded.last_extracted_msgid,
      last_extracted_at = excluded.last_extracted_at
  `).run(roomid, lastMsgid, new Date().toISOString());

  console.log(`[memory-extractor] 群 ${roomid}: ${messages.length} 条消息 → ${newCount} 条新记忆`);
  return newCount;
}

// ── AI 提取调用 ──────────────────────────────────────────────────────────

async function aiExtractCards(chatLog) {
  const prompt = `分析以下考研群聊对话，提取有价值的信息。请严格以 JSON 格式输出。

提取 3 类信息：
1. **fact**: 确定性的事实（成员的个人信息、目标院校、弱项、偏好等）
2. **question**: 讨论过的问题及其结论（只提取有明确答案或结论的）
3. **topic**: 讨论的知识点话题（如"古典概型"、"条件概率"、"英语长难句"等）

要求：
- 每个 card 简洁明了，一句完整的话
- 不要提取闲聊、寒暄、无信息量的内容
- 如果没有值得提取的内容，返回空数组

对话：
${chatLog.slice(0, 3000)}

输出格式：{"cards":[{"type":"fact|question|topic","content":"..."}]}`;

  try {
    const raw = await quickAsk(prompt, '', { maxTokens: 600, temperature: 0.2 });
    // 尝试从回复中提取 JSON
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return [];
    const parsed = JSON.parse(jsonMatch[0]);
    return parsed.cards || [];
  } catch (err) {
    console.error('[memory-extractor] AI 提取失败:', err.message);
    return [];
  }
}

// ── 工具函数 ─────────────────────────────────────────────────────────────

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

function loadExistingEmbeddings(roomid) {
  try {
    const rows = db.prepare(
      `SELECT embedding FROM memory_cards WHERE roomid = ? AND embedding != ''`
    ).all(roomid);
    return rows.map((r) => ({ embedding: JSON.parse(r.embedding) }));
  } catch (_) { return []; }
}

function extractKeywords(text) {
  // 简单中文分词：按常见停用词切分，取长度 >= 2 的词
  const stopWords = new Set([
    '的', '了', '在', '是', '我', '有', '和', '就', '不', '人', '都', '一',
    '一个', '上', '也', '很', '到', '说', '要', '去', '你', '会', '着',
    '没有', '看', '好', '自己', '这', '他', '她', '它', '们', '那', '这个',
    '那个', '可以', '这个', '什么', '怎么', '为什么', '觉得', '还是', '应该',
  ]);

  const words = [];
  // 按标点切分
  const segments = text.split(/[,，.。!！?？;；:：\s\n、]+/);
  for (const seg of segments) {
    if (seg.length >= 2 && seg.length <= 10 && !stopWords.has(seg)) {
      words.push(seg);
    }
  }
  return words.slice(0, 10).join(' ');
}

module.exports = {
  checkAndExtractAll,
  extractMemoriesIfNeeded,
  extractMemories,
};
