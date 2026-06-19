/**
 * 会话存档消息调度器
 *
 * 职责：
 *   1. 批量解密 archive 拉取的加密消息
 *   2. 过滤：只处理群聊文本消息
 *   3. 去重：基于 msgid 防止重复处理
 *   4. 回复策略：判断是否应该回复
 *   5. 路由到对应 bot + 发送回复
 */

const { db } = require('../db');
const { pullChatData, decryptChatMessage } = require('./wecomArchive');
const { sendAppChatMessage } = require('./wecom');
const { handleMessage: handleFreeTutor } = require('./bots/freeTutorBot');
const { handleQuestion: handleAnswer } = require('./bots/answerBot');
const { buildGroupContext } = require('./contextBuilder');
const config = require('../config');

// ── 回复策略常量 ─────────────────────────────────────────────────────────

// 机器人自身的企微 userId 列表（全部 bot 的 wecom_userid），用于跳过自己发的消息
const BOT_USER_IDS = new Set([
  // 这些值在 paidGroupBot 初始化 / bots 表中配置，需要动态加载
]);

// @提及触发回复的关键词
const AT_KEYWORDS = ['@机器人', '@小助手', '@考研助手', '@督学', '@研途', '@答疑'];

// 明确的提问句式模式
const QUESTION_PATTERNS = [
  /^(.+)[？?]$/,           // 以问号结尾
  /^(怎么|如何|怎样|什么|为什么|能不能|可以|是否|有没有|要不要)/,
  /(是什么意思|怎么做|怎么办|怎么学|怎么复习)/,
];

// 不需要回复的闲聊/表情模式
const CHAT_SKIP_PATTERNS = [
  /^[好的嗯哦啊哈嗐唉诶呦哟呵嗨嘿]+$/,      // 纯语气词
  /^[😀-🙏]+$/u,                             // 纯 emoji
  /^[.。,，!！~～…]+$/,                      // 纯标点
  /^(早|早安|晚安|再见|拜拜|谢谢|多谢|不客气|收到|OK|ok|好的|明白了?)$/,
  /^\d{1,2}$/,                                // 纯数字
];

// ── 初始化 ───────────────────────────────────────────────────────────────

let botUserIdsLoaded = false;

/**
 * 从数据库动态加载 bot 的企微 userId
 */
function loadBotUserIds() {
  try {
    const bots = db.prepare(
      `SELECT config FROM bots WHERE config IS NOT NULL AND config != ''`
    ).all();
    for (const row of bots) {
      try {
        const cfg = JSON.parse(row.config);
        if (cfg.wecomUserId) {
          BOT_USER_IDS.add(cfg.wecomUserId);
        }
      } catch (_) { /* skip malformed config */ }
    }
    botUserIdsLoaded = true;
  } catch (err) {
    console.error('[archive-dispatcher] 加载 bot userId 失败:', err.message);
  }
}

// ── 消息过滤 ─────────────────────────────────────────────────────────────

/**
 * 判断消息是否应跳过（自己发的、非文本等）
 * @param {object} msg - 解密后的消息 JSON
 * @returns {boolean} true = 跳过
 */
function shouldSkip(msg) {
  // 非文本消息（image/voice/video/file 等暂不处理）
  if (msg.msgtype !== 'text') return true;

  // 非群聊消息（没有 roomid）
  if (!msg.roomid) return true;

  // 自己发的消息
  if (!botUserIdsLoaded) loadBotUserIds();
  if (BOT_USER_IDS.has(msg.from)) return true;

  // 空内容
  const text = (msg.text?.content || '').trim();
  if (!text) return true;

  return false;
}

// ── 回复判断 ─────────────────────────────────────────────────────────────

/**
 * 判断是否应该回复这条群聊消息
 *
 * 回复策略（由严格 → 宽松）：
 *   ① 包含 @机器人 关键词 → 必须回复（score: 100）
 *   ② 明确提问句式 + 考研相关 → 应该回复（score: 80）
 *   ③ 仅考研关键词 → 可选回复（score: 50）
 *   ④ 闲聊/语气词 → 不回复（score: 0）
 *
 * @param {string} text - 消息文本
 * @returns {{ shouldReply: boolean, score: number, reason: string }}
 */
function evaluateReply(text) {
  const cleaned = text.trim();

  // ① 闲聊跳过
  for (const pattern of CHAT_SKIP_PATTERNS) {
    if (pattern.test(cleaned)) {
      return { shouldReply: false, score: 0, reason: '闲聊/语气词' };
    }
  }

  // ② @提及 → 必须回复
  const lower = cleaned.toLowerCase();
  for (const kw of AT_KEYWORDS) {
    if (lower.includes(kw.toLowerCase())) {
      return { shouldReply: true, score: 100, reason: '@提及' };
    }
  }
  // 也检查纯 @ 符号（企微消息中常见 "@某某某" 格式）
  if (cleaned.includes('@')) {
    // 有 @ 但不一定是在 @ 机器人，给中等分数
    return { shouldReply: true, score: 70, reason: '包含@' };
  }

  // ③ 明确提问句式
  for (const pattern of QUESTION_PATTERNS) {
    if (pattern.test(cleaned)) {
      return { shouldReply: true, score: 80, reason: '提问句式' };
    }
  }

  // ④ 考研相关关键词检测
  const kaoyanKeywords = [
    '考研', '政治', '英语', '数学', '专业课', '复习', '备考', '真题',
    '报名', '初试', '复试', '调剂', '国家线', '院校', '专业', '学科',
    '词汇', '单词', '阅读', '作文', '翻译', '完形', '长难句',
    '马原', '毛中特', '史纲', '思修', '时政',
    '高数', '线代', '概率', '数一', '数二', '数三',
    '报班', '课程', '视频', '资料', '笔记', '题目', '答案',
    '学习', '计划', '打卡', '进度', '背诵', '记忆', '做题',
  ];
  let keywordHits = 0;
  for (const kw of kaoyanKeywords) {
    if (cleaned.includes(kw)) keywordHits++;
    if (keywordHits >= 2) break;
  }

  if (keywordHits >= 2) {
    return { shouldReply: true, score: 50, reason: `考研关键词(${keywordHits})` };
  }

  // ⑤ 默认不回复
  return { shouldReply: false, score: 0, reason: '无触发条件' };
}

// ── 路由 ─────────────────────────────────────────────────────────────────

/**
 * 将消息路由到合适的 bot 并获取回复
 * @param {string} userId  - 发送者企微 userId
 * @param {string} message - 消息文本
 * @param {string} roomid  - 群聊 ID
 * @param {object} options - { msgtime_ms }
 * @returns {Promise<string|null>} 回复文本，null 表示不回复
 */
async function routeToBot(userId, message, roomid, options = {}) {
  try {
    // 查找用户（判断付费/免费状态）
    const user = db.prepare(
      'SELECT id, role FROM users WHERE wecom_userid = ?'
    ).get(userId);

    // 构建群聊上下文（STM + LTM + Profile）
    let groupContext = null;
    try {
      const ctx = await buildGroupContext({
        roomid,
        currentMsg: message,
        currentUserId: userId,
        currentMsgtime: options.msgtime_ms || Date.now(),
      });
      groupContext = ctx;
      if (ctx.fullContext) {
        console.log(`[archive-dispatcher] 上下文构建完成, token 估算: ~${Math.ceil(ctx.fullContext.length / 1.5)}`);
      }
    } catch (err) {
      console.error('[archive-dispatcher] 上下文构建失败（降级继续）:', err.message);
    }

    let reply = null;

    if (user && user.role === 'student') {
      // 付费学生 → 用 answerBot（三层：知识库 → AI → 网络搜索）
      const result = await handleAnswer({
        userId: String(user.id),
        question: message,
        source: 'wecom_archive',
        context: {
          roomid,
          groupContext: groupContext?.fullContext || '',
          relatedMemories: groupContext?.memoryCardsText || '',
          senderProfile: groupContext?.profileText || '',
        }
      });
      reply = result?.answer || result?.reply || (typeof result === 'string' ? result : null);
    } else {
      // 免费/trial/未知用户 → 用 freeTutorBot
      const result = await handleFreeTutor({
        userId,
        message,
        source: 'wecom_archive',
        groupId: roomid,
        config: {
          groupContext: groupContext?.fullContext || '',
          relatedMemories: groupContext?.memoryCardsText || '',
          senderProfile: groupContext?.profileText || '',
        }
      });
      reply = result?.reply || (typeof result === 'string' ? result : null);
    }

    return reply || null;
  } catch (err) {
    console.error('[archive-dispatcher] routeToBot 异常:', err.message);
    return null;
  }
}

// ── 去重 ─────────────────────────────────────────────────────────────────

/**
 * 检查消息是否已处理（基于 msgid）
 * @param {string} msgid
 * @returns {boolean} true = 已处理过
 */
function isDuplicate(msgid) {
  const row = db.prepare(
    'SELECT id FROM wecom_archive_messages WHERE msgid = ?'
  ).get(msgid);
  return !!row;
}

/**
 * 记录消息处理结果
 * @param {object} params
 */
function recordMessage({ msgid, seq, fromUser, roomid, msgtype, content, action, msgtimeMs, senderName }) {
  try {
    db.prepare(`
      INSERT OR IGNORE INTO wecom_archive_messages
        (msgid, seq, from_user, roomid, msgtype, content, action, msgtime_ms, sender_name, processed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      msgid, seq, fromUser, roomid, msgtype, content, action,
      msgtimeMs || 0, senderName || '', new Date().toISOString()
    );
  } catch (err) {
    // UNIQUE 冲突是正常的（并发去重）
    if (err.code !== 'SQLITE_CONSTRAINT') {
      console.error('[archive-dispatcher] recordMessage 失败:', err.message);
    }
  }
}

// ── 批量处理 ─────────────────────────────────────────────────────────────

/**
 * 批量处理解密后的消息
 *
 * @param {Array} decryptedMessages - 解密后的消息对象数组
 * @returns {Promise<{processed:number, replied:number, errors:number}>}
 */
async function processBatch(decryptedMessages) {
  let processed = 0;
  let replied = 0;
  let errors = 0;

  for (const msg of decryptedMessages) {
    try {
      processed++;

      // 消息基础信息提取（兼容不同消息结构）
      const msgid = msg.msgid || msg._msgid || '';
      const seq = msg.seq || msg._seq || 0;
      const fromUser = msg.from || '';
      const roomid = msg.roomid || '';
      const msgtype = msg.msgtype || 'text';
      const content = msg.text?.content || msg.content || '';
      const msgtimeMs = msg.msgtime || 0;
      const senderName = msg.from || '';

      if (!msgid) continue;

      // 过滤
      if (shouldSkip(msg)) {
        recordMessage({ msgid, seq, fromUser, roomid, msgtype, content, action: 'ignored', msgtimeMs, senderName });
        continue;
      }

      // 去重
      if (isDuplicate(msgid)) continue;

      const text = content.trim();

      // 判断是否回复
      const evaluation = evaluateReply(text);

      if (!evaluation.shouldReply) {
        recordMessage({ msgid, seq, fromUser, roomid, msgtype, content, action: 'ignored', msgtimeMs, senderName });
        continue;
      }

      console.log(
        `[archive-dispatcher] 触发回复: from=${fromUser} room=${roomid} ` +
        `score=${evaluation.score} reason=${evaluation.reason} text="${text.slice(0, 50)}"`
      );

      // 路由到 bot 获取回复（传入 msgtime_ms 用于上下文构建）
      const replyText = await routeToBot(fromUser, text, roomid, { msgtime_ms: msgtimeMs });

      if (replyText) {
        // 发送群聊回复
        await sendAppChatMessage({
          chatid: roomid,
          msgtype: 'text',
          text: { content: replyText }
        });
        recordMessage({ msgid, seq, fromUser, roomid, msgtype, content, action: 'group_reply', msgtimeMs, senderName });
        replied++;
        console.log(`[archive-dispatcher] 群聊回复成功: room=${roomid}`);
      } else {
        recordMessage({ msgid, seq, fromUser, roomid, msgtype, content, action: 'ignored', msgtimeMs, senderName });
      }
    } catch (err) {
      errors++;
      console.error(`[archive-dispatcher] 处理消息异常 [msgid=${msg.msgid}]:`, err.message);
      // 仍然记录防止重复处理
      try {
        recordMessage({
          msgid: msg.msgid || msg._msgid || '', seq: msg.seq || msg._seq || 0,
          fromUser: msg.from || '', roomid: msg.roomid || '',
          msgtype: msg.msgtype || '', content: msg.text?.content || '',
          action: 'ignored',
          msgtimeMs: msg.msgtime || 0,
          senderName: msg.from || ''
        });
      } catch (_) { /* 尽最大努力记录 */ }
    }
  }

  return { processed, replied, errors };
}

module.exports = {
  processBatch,
  evaluateReply,
  shouldSkip,
  isDuplicate,
  recordMessage,
  loadBotUserIds,
  routeToBot,
};
