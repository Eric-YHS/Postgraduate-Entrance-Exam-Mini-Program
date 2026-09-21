/**
 * 会话存档消息调度器
 *
 * 职责：
 *   1. 批量解密 archive 拉取的加密消息
 *   2. 过滤：处理群聊文字、图片、语音和常见文件
 *   3. 去重：基于 msgid 防止重复处理
 *   4. 回复策略：判断是否应该回复
 *   5. 路由到对应 bot + 发送回复
 */

const { db } = require('../db');
const { sendAppChatMessage } = require('./wecom');
const { handleMessage: handleFreeTutor } = require('./bots/freeTutorBot');
const { handleQuestion: handleAnswer } = require('./bots/answerBot');
const { handleConfiguredGroupBot } = require('./bots/configurableGroupBot');
const { buildGroupContext } = require('./contextBuilder');
const { processMediaMessage } = require('./wecomMedia');

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
let pendingReplyTimer = null;
let pendingFlushRunning = false;

const PENDING_WORKER_INTERVAL_MS = 500;
const PENDING_RETRY_DELAY_MS = 30 * 1000;
const MAX_BATCH_MESSAGES = 100;
const BINDING_MARKER_PATTERN = /\[机器人绑定:([a-f0-9]{24})\]/i;

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
  // 当前支持文字、图片、语音和文件；视频等仍跳过。
  if (!['text', 'image', 'voice', 'file'].includes(msg.msgtype)) return true;

  // 非群聊消息（没有 roomid）
  if (!msg.roomid) return true;

  // 自建应用通过 appchat/send 发出的消息在存档中没有发送者，必须跳过，
  // 否则机器人会把自己的欢迎语或回复再次当成用户问题。
  if (!msg.from) return true;

  // 自己发的消息
  if (!botUserIdsLoaded) loadBotUserIds();
  if (BOT_USER_IDS.has(msg.from)) return true;

  if (msg.msgtype === 'text') {
    const text = (msg.text?.content || '').trim();
    if (!text) return true;
  } else {
    const sdkfileid = String(msg?.[msg.msgtype]?.sdkfileid || msg.sdkfileid || '').trim();
    if (!sdkfileid) return true;
  }

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

function safeJsonParse(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch (_) {
    return fallback;
  }
}

/**
 * 存档 roomid 与应用 chatid 都可以定位同一条群配置。
 */
function getGroupByRoomId(roomid) {
  if (!roomid) return null;
  return db.prepare(`
    SELECT id, chat_id, archive_roomid, name, owner,
           reply_enabled, reply_all_text, reply_delay_seconds, binding_token
    FROM wecom_groups
    WHERE archive_roomid = ? OR chat_id = ?
    LIMIT 1
  `).get(roomid, roomid) || null;
}

function getGroupById(groupId) {
  if (!groupId) return null;
  return db.prepare(`
    SELECT id, chat_id, archive_roomid, name, owner,
           reply_enabled, reply_all_text, reply_delay_seconds, binding_token
    FROM wecom_groups
    WHERE id = ?
    LIMIT 1
  `).get(groupId) || null;
}

function listAssignedBots(groupId) {
  if (!groupId) return [];
  const rows = db.prepare(`
    SELECT b.id, b.code, b.name, b.type, b.config, b.is_active,
           a.is_default, a.id AS assignment_id
    FROM bot_group_assignments a
    JOIN bots b ON b.id = a.bot_id
    WHERE a.group_id = ? AND b.is_active = 1
    ORDER BY a.is_default DESC, a.id ASC
  `).all(groupId);

  return rows.map((row) => ({
    ...row,
    config: safeJsonParse(row.config, {}),
  }));
}

/**
 * 优先匹配 @角色名/触发词；没有显式命中时使用群默认机器人。
 */
function selectGroupBot(groupId, message) {
  const bots = listAssignedBots(groupId);
  if (!bots.length) return null;

  const text = String(message || '').toLowerCase();
  const matched = bots.find((bot) => {
    if (bot.name && text.includes(`@${String(bot.name).toLowerCase()}`)) return true;
    const rawKeywords = bot.config?.triggerKeywords;
    const keywords = Array.isArray(rawKeywords)
      ? rawKeywords
      : String(rawKeywords || '').split(/[,，\n]/);
    return keywords.some((keyword) => {
      const normalized = String(keyword || '').trim().toLowerCase();
      return normalized && text.includes(normalized);
    });
  });

  return matched || bots.find((bot) => Number(bot.is_default) === 1) || bots[0];
}

/**
 * 新建应用群会收到带绑定码的应用消息。存档拉到这条消息后，自动建立
 * archive roomid -> app chatid 映射，不再要求管理员手工查数据库。
 */
function tryBindArchiveRoom(msg) {
  if (!msg || msg.from || !msg.roomid || msg.msgtype !== 'text') return false;
  const content = String(msg.text?.content || msg.content || '');
  const match = content.match(BINDING_MARKER_PATTERN);
  if (!match) return false;

  const result = db.prepare(`
    UPDATE wecom_groups
    SET archive_roomid = ?
    WHERE binding_token = ?
  `).run(msg.roomid, match[1]);

  if (result.changes > 0) {
    console.log(`[archive-dispatcher] 群聊绑定成功: archive_roomid=${msg.roomid}`);
    return true;
  }

  console.error('[archive-dispatcher] 收到群绑定消息，但未找到对应的群配置');
  return false;
}

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
    const group = options.group || getGroupByRoomId(roomid);
    const selectedBot = group ? selectGroupBot(group.id, message) : null;

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

    if (selectedBot) {
      reply = await handleConfiguredGroupBot({
        bot: selectedBot,
        message,
        groupContext: groupContext?.fullContext || '',
        externalUserId: userId,
        studentId: user?.id || null,
      });
      console.log(`[archive-dispatcher] 使用群机器人: code=${selectedBot.code} group=${group?.id}`);
    } else if (user && user.role === 'student') {
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
 * 将会话存档中的 roomid 映射到自建应用群聊的 chatid。
 * 两者由企业微信的不同接口生成，不能直接互换使用。
 * @param {string} archiveRoomid
 * @returns {string|null}
 */
function resolveAppChatId(archiveRoomid) {
  const group = getGroupByRoomId(archiveRoomid);
  return group?.chat_id || null;
}

/**
 * 记录消息处理结果
 * @param {object} params
 */
function recordMessage({
  msgid,
  seq,
  fromUser,
  roomid,
  msgtype,
  content,
  action,
  msgtimeMs,
  senderName,
  mediaPath,
  mediaMeta,
}) {
  try {
    const result = db.prepare(`
      INSERT OR IGNORE INTO wecom_archive_messages
        (msgid, seq, from_user, roomid, msgtype, content, action, msgtime_ms,
         sender_name, media_path, media_meta, processed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      msgid, seq, fromUser, roomid, msgtype, content, action,
      msgtimeMs || 0, senderName || '', mediaPath || '', mediaMeta || '',
      new Date().toISOString()
    );
    return result.changes > 0;
  } catch (err) {
    // UNIQUE 冲突是正常的（并发去重）
    if (err.code !== 'SQLITE_CONSTRAINT') {
      console.error('[archive-dispatcher] recordMessage 失败:', err.message);
    }
    return false;
  }
}

// ── 按群防抖回复队列 ───────────────────────────────────────────────────

function getReplyDelaySeconds(group) {
  const seconds = Number(group?.reply_delay_seconds);
  if (!Number.isFinite(seconds)) return 5;
  return Math.min(300, Math.max(0, seconds));
}

/**
 * 在同一事务中记录消息并加入按群聚合队列，避免进程重启或写库中断导致消息丢失。
 */
function queueMessageForReply(messageData, group) {
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const dueAt = nowMs + getReplyDelaySeconds(group) * 1000;

  return db.transaction(() => {
    const insertResult = db.prepare(`
      INSERT OR IGNORE INTO wecom_archive_messages
        (msgid, seq, from_user, roomid, msgtype, content, action, msgtime_ms,
         sender_name, media_path, media_meta, processed_at)
      VALUES (?, ?, ?, ?, ?, ?, 'ignored', ?, ?, ?, ?, ?)
    `).run(
      messageData.msgid,
      messageData.seq,
      messageData.fromUser,
      messageData.roomid,
      messageData.msgtype,
      messageData.content,
      messageData.msgtimeMs || 0,
      messageData.senderName || '',
      messageData.mediaPath || '',
      messageData.mediaMeta || '',
      nowIso
    );

    if (insertResult.changes === 0) return false;

    const existing = db.prepare(
      'SELECT messages_json, version, processing_version FROM wecom_pending_replies WHERE roomid = ?'
    ).get(messageData.roomid);
    const existingIsInFlight = existing
      && Number(existing.processing_version) === Number(existing.version);
    const messages = existingIsInFlight
      ? []
      : safeJsonParse(existing?.messages_json, []);
    const boundedMessages = Array.isArray(messages)
      ? messages.slice(-(MAX_BATCH_MESSAGES - 1))
      : [];
    boundedMessages.push({
      msgid: messageData.msgid,
      fromUser: messageData.fromUser,
      content: messageData.content,
      msgtype: messageData.msgtype,
      msgtimeMs: messageData.msgtimeMs || nowMs,
      senderName: messageData.senderName || messageData.fromUser,
    });

    db.prepare(`
      INSERT INTO wecom_pending_replies
        (roomid, group_id, messages_json, version, processing_version, due_at,
         attempts, last_error, created_at, updated_at)
      VALUES (?, ?, ?, 1, 0, ?, 0, '', ?, ?)
      ON CONFLICT(roomid) DO UPDATE SET
        group_id = excluded.group_id,
        messages_json = excluded.messages_json,
        version = wecom_pending_replies.version + 1,
        processing_version = 0,
        due_at = excluded.due_at,
        attempts = 0,
        last_error = '',
        updated_at = excluded.updated_at
    `).run(
      messageData.roomid,
      group?.id || null,
      JSON.stringify(boundedMessages),
      dueAt,
      nowIso,
      nowIso
    );

    return true;
  })();
}

function formatBatchPrompt(messages) {
  if (messages.length === 1) return String(messages[0].content || '').trim();
  const lines = messages.map((message) => {
    const sender = message.senderName || message.fromUser || '群成员';
    return `${sender}：${String(message.content || '').trim()}`;
  });
  return `以下是群成员在刚才几秒内连续发送的消息。请结合起来理解并一次性完整回复：\n\n${lines.join('\n')}`;
}

function deletePendingVersion(roomid, version) {
  return db.prepare(
    'DELETE FROM wecom_pending_replies WHERE roomid = ? AND version = ?'
  ).run(roomid, version).changes > 0;
}

function claimPendingVersion(roomid, version) {
  return db.prepare(`
    UPDATE wecom_pending_replies
    SET processing_version = ?
    WHERE roomid = ? AND version = ? AND processing_version = 0
  `).run(version, roomid, version).changes > 0;
}

function retryPendingVersion(row, errorMessage, nowMs) {
  const attempts = Number(row.attempts) || 0;
  const delayMs = Math.min(5 * 60 * 1000, PENDING_RETRY_DELAY_MS * (attempts + 1));
  db.prepare(`
    UPDATE wecom_pending_replies
    SET attempts = attempts + 1, processing_version = 0,
        last_error = ?, due_at = ?, updated_at = ?
    WHERE roomid = ? AND version = ?
  `).run(
    String(errorMessage || '').slice(0, 500),
    nowMs + delayMs,
    new Date(nowMs).toISOString(),
    row.roomid,
    row.version
  );
}

function markBatchReplied(messages) {
  const msgids = messages.map((message) => message.msgid).filter(Boolean);
  if (!msgids.length) return;
  const placeholders = msgids.map(() => '?').join(', ');
  db.prepare(`
    UPDATE wecom_archive_messages
    SET action = 'group_reply'
    WHERE msgid IN (${placeholders})
  `).run(...msgids);
}

/**
 * 发送所有已过静默等待期的群消息批次。version 条件保证回复生成期间如果又收到
 * 新消息，新批次不会被旧批次的清理操作误删。
 */
async function flushDueReplies(nowMs = Date.now()) {
  if (pendingFlushRunning) return { processed: 0, replied: 0, errors: 0, busy: true };
  pendingFlushRunning = true;

  const stats = { processed: 0, replied: 0, errors: 0 };
  try {
    const rows = db.prepare(`
      SELECT roomid, group_id, messages_json, version, processing_version, due_at, attempts
      FROM wecom_pending_replies
      WHERE due_at <= ? AND processing_version = 0
      ORDER BY due_at ASC
      LIMIT 20
    `).all(nowMs);

    for (const row of rows) {
      if (!claimPendingVersion(row.roomid, row.version)) continue;
      stats.processed++;
      const messages = safeJsonParse(row.messages_json, []);
      const group = getGroupById(row.group_id) || getGroupByRoomId(row.roomid);

      if (!Array.isArray(messages) || messages.length === 0) {
        deletePendingVersion(row.roomid, row.version);
        continue;
      }

      if (group && Number(group.reply_enabled) === 0) {
        deletePendingVersion(row.roomid, row.version);
        continue;
      }

      if (!group || !group.chat_id) {
        stats.errors++;
        retryPendingVersion(row, '未找到可发送的应用群映射', nowMs);
        console.error(`[archive-dispatcher] 待回复群缺少映射: room=${row.roomid}`);
        continue;
      }

      const lastMessage = messages[messages.length - 1];
      const prompt = formatBatchPrompt(messages);

      try {
        const replyText = await routeToBot(
          lastMessage.fromUser,
          prompt,
          row.roomid,
          { msgtime_ms: lastMessage.msgtimeMs, group }
        );

        if (!replyText) {
          throw new Error('机器人未生成回复');
        }

        const sendResult = await sendAppChatMessage({
          chatid: group.chat_id,
          msgtype: 'text',
          text: { content: replyText },
        });

        if (Number(sendResult?.errcode) !== 0) {
          throw new Error(
            `errcode=${sendResult?.errcode ?? 'NO_RESULT'} errmsg=${sendResult?.errmsg || ''}`
          );
        }

        markBatchReplied(messages);
        deletePendingVersion(row.roomid, row.version);
        stats.replied++;
        console.log(
          `[archive-dispatcher] 群聊合并回复成功: room=${row.roomid} ` +
          `chatid=${group.chat_id} messages=${messages.length}`
        );
      } catch (error) {
        stats.errors++;
        retryPendingVersion(row, error.message, Date.now());
        console.error(`[archive-dispatcher] 群聊合并回复失败: room=${row.roomid}`, error.message);
      }
    }
  } finally {
    pendingFlushRunning = false;
  }

  return stats;
}

function startPendingReplyWorker(intervalMs = PENDING_WORKER_INTERVAL_MS) {
  if (pendingReplyTimer) return;
  // 进程若在生成回复时退出，旧的处理中标记会残留；启动时安全地恢复它们。
  db.prepare('UPDATE wecom_pending_replies SET processing_version = 0 WHERE processing_version != 0').run();
  flushDueReplies().catch((error) => {
    console.error('[archive-dispatcher] 恢复待回复队列失败:', error.message);
  });
  pendingReplyTimer = setInterval(() => {
    flushDueReplies().catch((error) => {
      console.error('[archive-dispatcher] 待回复队列执行失败:', error.message);
    });
  }, Math.max(250, Number(intervalMs) || PENDING_WORKER_INTERVAL_MS));
  pendingReplyTimer.unref?.();
}

function stopPendingReplyWorker() {
  if (!pendingReplyTimer) return;
  clearInterval(pendingReplyTimer);
  pendingReplyTimer = null;
}

// ── 批量处理 ─────────────────────────────────────────────────────────────

/**
 * 批量处理解密后的消息
 *
 * @param {Array} decryptedMessages - 解密后的消息对象数组
 * @returns {Promise<{processed:number, queued:number, replied:number, errors:number}>}
 */
async function processBatch(decryptedMessages) {
  let processed = 0;
  let queued = 0;
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
      const content = msg.msgtype === 'file'
        ? String(msg.file?.filename || msg.filename || '[文件]')
        : msg.msgtype === 'image'
          ? '[图片]'
          : msg.msgtype === 'voice'
            ? '[语音]'
            : msg.text?.content || msg.content || '';
      const msgtimeMs = msg.msgtime || 0;
      const senderName = msg.from || '';

      if (!msgid) continue;

      // 新建群的应用绑定消息没有发送者；先尝试自动绑定，再按机器人消息跳过。
      tryBindArchiveRoom(msg);

      // 过滤
      if (shouldSkip(msg)) {
        recordMessage({ msgid, seq, fromUser, roomid, msgtype, content, action: 'ignored', msgtimeMs, senderName });
        continue;
      }

      // 去重
      if (isDuplicate(msgid)) continue;

      const group = getGroupByRoomId(roomid);

      if (!group) {
        errors++;
        console.error(`[archive-dispatcher] 未登记的群聊消息，已跳过: room=${roomid}`);
        recordMessage({ msgid, seq, fromUser, roomid, msgtype, content, action: 'ignored', msgtimeMs, senderName });
        continue;
      }

      if (Number(group.reply_enabled) === 0) {
        recordMessage({ msgid, seq, fromUser, roomid, msgtype, content, action: 'ignored', msgtimeMs, senderName });
        continue;
      }

      let normalizedContent = String(content || '').trim();
      let mediaPath = '';
      let mediaMeta = '';
      if (msgtype === 'image' || msgtype === 'voice' || msgtype === 'file') {
        const mediaResult = await processMediaMessage(msg);
        normalizedContent = String(mediaResult?.content || '').trim();
        mediaPath = String(mediaResult?.mediaPath || '');
        mediaMeta = String(mediaResult?.mediaMeta || '');
        if (!normalizedContent) {
          recordMessage({
            msgid, seq, fromUser, roomid, msgtype, content,
            action: 'ignored', msgtimeMs, senderName, mediaPath, mediaMeta,
          });
          continue;
        }
      }

      // reply_all_text 只控制普通文字；媒体消息始终给出识别结果或失败提示。
      if (msgtype === 'text' && Number(group.reply_all_text) !== 1) {
        const evaluation = evaluateReply(normalizedContent);
        if (!evaluation.shouldReply) {
          recordMessage({ msgid, seq, fromUser, roomid, msgtype, content, action: 'ignored', msgtimeMs, senderName });
          continue;
        }
      }

      const wasQueued = queueMessageForReply({
        msgid, seq, fromUser, roomid, msgtype, content: normalizedContent,
        msgtimeMs, senderName, mediaPath, mediaMeta,
      }, group);
      if (wasQueued) {
        queued++;
        console.log(
          `[archive-dispatcher] 已加入群回复队列: room=${roomid} ` +
          `delay=${getReplyDelaySeconds(group)}s type=${msgtype}`
        );
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

  return { processed, queued, replied: 0, errors };
}

module.exports = {
  processBatch,
  evaluateReply,
  shouldSkip,
  isDuplicate,
  recordMessage,
  resolveAppChatId,
  getGroupByRoomId,
  selectGroupBot,
  tryBindArchiveRoom,
  queueMessageForReply,
  flushDueReplies,
  startPendingReplyWorker,
  stopPendingReplyWorker,
  loadBotUserIds,
  routeToBot,
};
