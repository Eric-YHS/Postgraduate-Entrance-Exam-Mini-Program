/**
 * 微信客服消息同步、去重、媒体理解、5 秒聚合回复与人工接管。
 */

const crypto = require('crypto');
const config = require('../config');
const { db: defaultDb } = require('../db');
const wecomKf = require('./wecomKf');
const { processKfMediaMessage } = require('./wecomKfMedia');
const { handleConfiguredKfBot } = require('./bots/configurableKfBot');

const PENDING_WORKER_INTERVAL_MS = 500;
const MAX_SYNC_PAGES = 100;
const MAX_CONTEXT_MESSAGES = 30;
const MAX_BATCH_MESSAGES = 100;
const SEND_WINDOW_SECONDS = 48 * 60 * 60;
const PENDING_RESERVATION_MS = 5 * 60 * 1000;
const DEFAULT_THINKING_MESSAGE = '思考中，请稍等';
const OUTBOUND_CHUNK_DELAY_MS = 1200;
const OUTBOUND_MULTI_CHUNK_BYTES = 1980;

function safeJsonParse(value, fallback) {
  try {
    const parsed = JSON.parse(value);
    return parsed === undefined || parsed === null ? fallback : parsed;
  } catch (_) {
    return fallback;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeEpochSeconds(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return Math.floor(Date.now() / 1000);
  return number > 100000000000 ? Math.floor(number / 1000) : Math.floor(number);
}

function fallbackMsgId(message) {
  const stable = JSON.stringify({
    open_kfid: message?.open_kfid || message?.event?.open_kfid || '',
    external_userid: message?.external_userid || message?.event?.external_userid || '',
    send_time: message?.send_time || 0,
    origin: message?.origin || 0,
    msgtype: message?.msgtype || '',
    event: message?.event || null,
    text: message?.text || null,
  });
  return `kf_${crypto.createHash('sha256').update(stable).digest('hex').slice(0, 28)}`;
}

function getMessageIdentity(message) {
  const event = message?.event || {};
  return {
    msgid: String(message?.msgid || fallbackMsgId(message)).slice(0, 128),
    openKfid: String(message?.open_kfid || event.open_kfid || '').trim(),
    externalUserid: String(message?.external_userid || event.external_userid || '').trim(),
    sendTime: normalizeEpochSeconds(message?.send_time),
    origin: Number(message?.origin || 0),
    msgtype: String(message?.msgtype || 'text').trim() || 'text',
    eventType: String(event.event_type || '').trim(),
  };
}

function normalizeDelay(value, fallback = 5) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(300, Math.max(0, Math.round(number)));
}

function formatNonMediaMessage(message) {
  const type = String(message?.msgtype || '');
  if (type === 'text') return String(message?.text?.content || '').trim();
  if (type === 'location') {
    const location = message.location || {};
    return `[学生发送了位置]\n名称：${location.name || '未命名位置'}\n地址：${location.address || ''}\n坐标：${location.latitude || ''}, ${location.longitude || ''}`.trim();
  }
  if (type === 'link') {
    const link = message.link || {};
    return `[学生发送了链接]\n标题：${link.title || ''}\n说明：${link.desc || ''}\n地址：${link.url || ''}`.trim();
  }
  if (type === 'business_card') {
    const card = message.business_card || {};
    return `[学生发送了名片]\n姓名：${card.userid || card.user_id || '未提供'}`;
  }
  if (type === 'miniprogram') {
    const mini = message.miniprogram || {};
    return `[学生发送了小程序]\n标题：${mini.title || ''}\nAppID：${mini.appid || ''}`.trim();
  }
  if (type === 'video') return '[学生发送了一段视频。当前可以记录视频消息，但暂不自动读取视频画面；请结合前后文字进行回复。]';
  if (type === 'channels') return '[学生发送了视频号内容。请结合前后消息询问他希望了解的具体问题。]';
  return `[学生发送了一条 ${type || '未知'} 类型的消息。请结合前后消息回应；如缺少内容，请请学生补充文字。]`;
}

function selectAssignedBot(rows, message) {
  if (!rows.length) return null;
  const text = String(message || '').toLowerCase();
  const matched = rows.find((bot) => {
    const keywords = Array.isArray(bot.config?.triggerKeywords)
      ? bot.config.triggerKeywords
      : String(bot.config?.triggerKeywords || '').split(/[,，\n]/);
    return keywords.some((keyword) => {
      const normalized = String(keyword || '').trim().toLowerCase();
      return normalized && text.includes(normalized);
    });
  });
  return matched || rows.find((bot) => bot.isDefault) || rows[0];
}

function buildReplyChunks(value, maxChunks) {
  const text = String(value || '').trim();
  const chunkLimit = Math.min(5, Math.max(0, Math.floor(Number(maxChunks) || 0)));
  if (!text || chunkLimit < 1) return [];
  if (Buffer.byteLength(text, 'utf8') <= 2048) return [text];

  const chunks = wecomKf.utf8Chunks(text, OUTBOUND_MULTI_CHUNK_BYTES, chunkLimit);
  if (chunks.length <= 1) return chunks;
  return chunks.map((chunk, index) => `【${index + 1}/${chunks.length}】\n${chunk}`);
}

function createWecomKfDispatcher(dependencies = {}) {
  const db = dependencies.db || defaultDb;
  const client = dependencies.client || wecomKf;
  const mediaProcessor = dependencies.processKfMediaMessage || processKfMediaMessage;
  const botHandler = dependencies.handleConfiguredKfBot || handleConfiguredKfBot;
  const runtimeConfig = dependencies.config || config;
  const logger = dependencies.logger || console;
  const sleep = dependencies.sleep || delay;

  const syncInFlight = new Map();
  let pendingWorker = null;
  let recoveryPoller = null;
  let lastSyncAt = '';
  let lastError = '';

  function ensureAccount(openKfid, fields = {}) {
    if (!openKfid) return null;
    const currentTime = nowIso();
    db.prepare(`
      INSERT INTO wecom_kf_accounts
        (open_kfid, name, avatar, contact_url, reply_enabled, reply_delay_seconds,
         managed_by_api, last_error, created_at, updated_at)
      VALUES (?, ?, ?, ?, 1, ?, ?, '', ?, ?)
      ON CONFLICT(open_kfid) DO UPDATE SET
        name = CASE WHEN excluded.name != '' THEN excluded.name ELSE wecom_kf_accounts.name END,
        avatar = CASE WHEN excluded.avatar != '' THEN excluded.avatar ELSE wecom_kf_accounts.avatar END,
        contact_url = CASE WHEN excluded.contact_url != '' THEN excluded.contact_url ELSE wecom_kf_accounts.contact_url END,
        managed_by_api = MAX(wecom_kf_accounts.managed_by_api, excluded.managed_by_api),
        updated_at = excluded.updated_at
    `).run(
      openKfid,
      String(fields.name || ''),
      String(fields.avatar || ''),
      String(fields.contactUrl || ''),
      normalizeDelay(runtimeConfig.wecomKfReplyDelaySeconds, 5),
      fields.managedByApi ? 1 : 0,
      currentTime,
      currentTime
    );
    db.prepare(`
      INSERT OR IGNORE INTO wecom_kf_sync_state (open_kfid, cursor, last_error, updated_at)
      VALUES (?, '', '', ?)
    `).run(openKfid, currentTime);
    return db.prepare('SELECT * FROM wecom_kf_accounts WHERE open_kfid = ?').get(openKfid);
  }

  function ensureCustomer(openKfid, externalUserid, sendTime = 0) {
    if (!openKfid || !externalUserid) return null;
    ensureAccount(openKfid);
    const currentTime = nowIso();
    const normalizedTime = normalizeEpochSeconds(sendTime);
    db.prepare(`
      INSERT INTO wecom_kf_customers
        (open_kfid, external_userid, service_state, last_message_at, created_at, updated_at)
      VALUES (?, ?, 4, ?, ?, ?)
      ON CONFLICT(open_kfid, external_userid) DO UPDATE SET
        last_message_at = MAX(wecom_kf_customers.last_message_at, excluded.last_message_at),
        updated_at = excluded.updated_at
    `).run(openKfid, externalUserid, normalizedTime, currentTime, currentTime);
    return db.prepare(`
      SELECT * FROM wecom_kf_customers WHERE open_kfid = ? AND external_userid = ?
    `).get(openKfid, externalUserid);
  }

  function markCustomerMessage(openKfid, externalUserid, sendTime, resetOutboundCount = true) {
    ensureCustomer(openKfid, externalUserid, sendTime);
    db.prepare(`
      UPDATE wecom_kf_customers
      SET last_customer_message_at = ?,
          outbound_count = CASE WHEN ? = 1 THEN 0 ELSE outbound_count END,
          last_message_at = MAX(last_message_at, ?),
          updated_at = ?
      WHERE open_kfid = ? AND external_userid = ?
    `).run(
      sendTime,
      resetOutboundCount ? 1 : 0,
      sendTime,
      nowIso(),
      openKfid,
      externalUserid
    );
  }

  function isDuplicate(msgid) {
    return Boolean(db.prepare('SELECT 1 FROM wecom_kf_messages WHERE msgid = ?').get(msgid));
  }

  function recordMessage(identity, message, details = {}) {
    const rawJson = JSON.stringify(message || {}).slice(0, 200000);
    const result = db.prepare(`
      INSERT OR IGNORE INTO wecom_kf_messages
        (msgid, open_kfid, external_userid, origin, msgtype, event_type, content,
         media_path, media_meta, action, raw_json, send_time, processed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      identity.msgid,
      identity.openKfid,
      identity.externalUserid,
      identity.origin,
      identity.msgtype,
      identity.eventType,
      String(details.content || ''),
      String(details.mediaPath || ''),
      String(details.mediaMeta || ''),
      String(details.action || 'ignored'),
      rawJson,
      identity.sendTime,
      nowIso()
    );
    return Number(result.changes) > 0;
  }

  function cancelPending(openKfid, externalUserid) {
    db.prepare(`
      DELETE FROM wecom_kf_pending_replies WHERE open_kfid = ? AND external_userid = ?
    `).run(openKfid, externalUserid);
  }

  function reservePendingBatch(identity) {
    const currentTime = nowIso();
    const result = db.prepare(`
      INSERT OR IGNORE INTO wecom_kf_pending_replies
        (open_kfid, external_userid, messages_json, version, processing_version,
         due_at, attempts, last_error, created_at, updated_at)
      VALUES (?, ?, '[]', 1, 0, ?, 0, '', ?, ?)
    `).run(
      identity.openKfid,
      identity.externalUserid,
      Date.now() + PENDING_RESERVATION_MS,
      currentTime,
      currentTime
    );
    return Number(result.changes) > 0;
  }

  function updatePendingAfterRecall(openKfid, externalUserid, recallMsgid) {
    const row = db.prepare(`
      SELECT * FROM wecom_kf_pending_replies WHERE open_kfid = ? AND external_userid = ?
    `).get(openKfid, externalUserid);
    if (!row) return;
    const messages = safeJsonParse(row.messages_json, [])
      .filter((item) => item.msgid !== recallMsgid);
    if (!messages.length) {
      cancelPending(openKfid, externalUserid);
      return;
    }
    db.prepare(`
      UPDATE wecom_kf_pending_replies
      SET messages_json = ?, version = version + 1, processing_version = 0, updated_at = ?
      WHERE open_kfid = ? AND external_userid = ?
    `).run(JSON.stringify(messages), nowIso(), openKfid, externalUserid);
  }

  function queueReply(account, identity, content) {
    if (!content || !identity.openKfid || !identity.externalUserid) return false;
    const messageItem = {
      msgid: identity.msgid,
      msgtype: identity.msgtype,
      content,
      sendTime: identity.sendTime,
    };
    const dueAt = Date.now() + normalizeDelay(account?.reply_delay_seconds, 5) * 1000;
    const currentTime = nowIso();
    const row = db.prepare(`
      SELECT messages_json FROM wecom_kf_pending_replies
      WHERE open_kfid = ? AND external_userid = ?
    `).get(identity.openKfid, identity.externalUserid);

    if (!row) {
      db.prepare(`
        INSERT INTO wecom_kf_pending_replies
          (open_kfid, external_userid, messages_json, version, processing_version,
           due_at, attempts, last_error, created_at, updated_at)
        VALUES (?, ?, ?, 1, 0, ?, 0, '', ?, ?)
      `).run(
        identity.openKfid,
        identity.externalUserid,
        JSON.stringify([messageItem]),
        dueAt,
        currentTime,
        currentTime
      );
      return true;
    }

    const messages = safeJsonParse(row.messages_json, []);
    if (!messages.some((item) => item.msgid === identity.msgid)) messages.push(messageItem);
    const bounded = messages.slice(-MAX_BATCH_MESSAGES);
    db.prepare(`
      UPDATE wecom_kf_pending_replies
      SET messages_json = ?, version = version + 1, due_at = ?, attempts = 0,
          last_error = '', updated_at = ?
      WHERE open_kfid = ? AND external_userid = ?
    `).run(
      JSON.stringify(bounded),
      dueAt,
      currentTime,
      identity.openKfid,
      identity.externalUserid
    );
    return true;
  }

  async function refreshCustomerProfiles(openKfid, externalUserids) {
    const ids = [...new Set(externalUserids.filter(Boolean))];
    if (!ids.length) return;
    for (let offset = 0; offset < ids.length; offset += 100) {
      try {
        const data = await client.batchGetCustomers(ids.slice(offset, offset + 100), true);
        for (const customer of data.customer_list || []) {
          ensureCustomer(openKfid, customer.external_userid);
          db.prepare(`
            UPDATE wecom_kf_customers
            SET nickname = ?, avatar = ?, updated_at = ?
            WHERE open_kfid = ? AND external_userid = ?
          `).run(
            String(customer.nickname || ''),
            String(customer.avatar || ''),
            nowIso(),
            openKfid,
            String(customer.external_userid)
          );
        }
      } catch (error) {
        logger.warn?.('[wecom-kf] 获取客户昵称失败:', error.message);
      }
    }
  }

  async function handleEvent(identity, message) {
    const event = message.event || {};
    if (identity.openKfid && identity.externalUserid) {
      ensureCustomer(identity.openKfid, identity.externalUserid, identity.sendTime);
    } else if (identity.openKfid) {
      ensureAccount(identity.openKfid);
    }

    if (identity.eventType === 'session_status_change' && identity.externalUserid) {
      const changeType = Number(event.change_type);
      const serviceState = changeType === 3 ? 4 : 3;
      db.prepare(`
        UPDATE wecom_kf_customers
        SET service_state = ?, servicer_userid = ?, manual_takeover = 1, updated_at = ?
        WHERE open_kfid = ? AND external_userid = ?
      `).run(
        serviceState,
        String(event.new_servicer_userid || event.old_servicer_userid || ''),
        nowIso(),
        identity.openKfid,
        identity.externalUserid
      );
      cancelPending(identity.openKfid, identity.externalUserid);
    } else if (identity.eventType === 'reject_customer_msg_switch_change' && identity.externalUserid) {
      db.prepare(`
        UPDATE wecom_kf_customers
        SET reject_switch = ?, servicer_userid = ?, updated_at = ?
        WHERE open_kfid = ? AND external_userid = ?
      `).run(
        Number(event.reject_switch) === 1 ? 1 : 0,
        String(event.servicer_userid || ''),
        nowIso(),
        identity.openKfid,
        identity.externalUserid
      );
    } else if (identity.eventType === 'user_recall_msg' && identity.externalUserid) {
      const recalled = String(event.recall_msgid || '');
      if (recalled) {
        db.prepare(`UPDATE wecom_kf_messages SET action = 'recalled' WHERE msgid = ?`).run(recalled);
        updatePendingAfterRecall(identity.openKfid, identity.externalUserid, recalled);
      }
    } else if (identity.eventType === 'msg_send_fail') {
      const failed = String(event.fail_msgid || '');
      if (failed) {
        db.prepare(`UPDATE wecom_kf_messages SET action = 'send_failed' WHERE msgid = ?`).run(failed);
      }
    }

    recordMessage(identity, message, {
      content: `[微信客服事件：${identity.eventType || 'unknown'}]`,
      action: 'event',
    });
  }

  async function processMessage(message) {
    const identity = getMessageIdentity(message);
    if (isDuplicate(identity.msgid)) return { duplicate: true, msgid: identity.msgid };

    if (identity.origin === 4 || identity.msgtype === 'event') {
      await handleEvent(identity, message);
      return { event: true, msgid: identity.msgid };
    }

    if (!identity.openKfid) {
      recordMessage(identity, message, { action: 'invalid' });
      return { ignored: true, reason: 'missing_open_kfid' };
    }
    const account = ensureAccount(identity.openKfid);

    if (identity.origin === 5) {
      if (identity.externalUserid) {
        ensureCustomer(identity.openKfid, identity.externalUserid, identity.sendTime);
        db.prepare(`
          UPDATE wecom_kf_customers
          SET service_state = 3, servicer_userid = ?, manual_takeover = 1,
              last_message_at = MAX(last_message_at, ?), updated_at = ?
          WHERE open_kfid = ? AND external_userid = ?
        `).run(
          String(message.servicer_userid || ''),
          identity.sendTime,
          nowIso(),
          identity.openKfid,
          identity.externalUserid
        );
        cancelPending(identity.openKfid, identity.externalUserid);
      }
      recordMessage(identity, message, {
        content: formatNonMediaMessage(message),
        action: 'human_reply',
      });
      return { human: true, msgid: identity.msgid };
    }

    if (identity.origin !== 3 || !identity.externalUserid) {
      recordMessage(identity, message, {
        content: formatNonMediaMessage(message),
        action: 'ignored',
      });
      return { ignored: true, reason: 'not_customer_message' };
    }

    const hadPendingBatch = Boolean(db.prepare(`
      SELECT 1 FROM wecom_kf_pending_replies
      WHERE open_kfid = ? AND external_userid = ?
    `).get(identity.openKfid, identity.externalUserid));
    markCustomerMessage(
      identity.openKfid,
      identity.externalUserid,
      identity.sendTime,
      !hadPendingBatch
    );
    const initialCustomer = ensureCustomer(
      identity.openKfid,
      identity.externalUserid,
      identity.sendTime
    );
    const initiallyEligible = Boolean(account.reply_enabled) && !initialCustomer.manual_takeover;
    const startedBatch = initiallyEligible && reservePendingBatch(identity);
    const thinkingMessage = String(
      runtimeConfig.wecomKfThinkingMessage ?? DEFAULT_THINKING_MESSAGE
    ).trim().slice(0, 500);
    let receiptSent = false;
    if (startedBatch && thinkingMessage) {
      const receipt = await sendThinkingReceipt(account, identity, thinkingMessage);
      receiptSent = Boolean(receipt?.sent);
    }

    let content = '';
    let mediaPath = '';
    let mediaMeta = '';
    if (['image', 'voice', 'file'].includes(identity.msgtype)) {
      const mediaResult = await mediaProcessor(message);
      content = mediaResult?.content || '';
      mediaPath = mediaResult?.mediaPath || '';
      mediaMeta = mediaResult?.mediaMeta || '';
    } else {
      content = formatNonMediaMessage(message);
    }

    const latestAccount = db.prepare(`
      SELECT * FROM wecom_kf_accounts WHERE open_kfid = ?
    `).get(identity.openKfid) || account;
    const customer = ensureCustomer(identity.openKfid, identity.externalUserid, identity.sendTime);
    const shouldQueue = Boolean(latestAccount.reply_enabled) && !customer.manual_takeover;
    recordMessage(identity, message, {
      content,
      mediaPath,
      mediaMeta,
      action: shouldQueue ? 'queued' : (customer.manual_takeover ? 'manual_takeover' : 'reply_disabled'),
    });
    if (shouldQueue) {
      queueReply(latestAccount, identity, content);
    } else if (startedBatch) {
      cancelPending(identity.openKfid, identity.externalUserid);
    }
    return { queued: shouldQueue, receiptSent, msgid: identity.msgid };
  }

  async function syncAccountInternal(openKfid, callbackToken = '') {
    ensureAccount(openKfid);
    const profileIds = new Set();
    let pages = 0;
    let token = callbackToken;
    let total = 0;
    let hasMore = false;

    while (pages < MAX_SYNC_PAGES) {
      const state = db.prepare(`
        SELECT cursor FROM wecom_kf_sync_state WHERE open_kfid = ?
      `).get(openKfid);
      const data = await client.syncMessages({
        openKfid,
        cursor: state?.cursor || '',
        token,
        limit: 1000,
        voiceFormat: 0,
      });
      token = '';
      const messages = Array.isArray(data.msg_list) ? data.msg_list : [];
      for (const message of messages) {
        await processMessage(message);
        const identity = getMessageIdentity(message);
        if (identity.externalUserid) profileIds.add(identity.externalUserid);
      }
      total += messages.length;
      const updatedAt = nowIso();
      db.prepare(`
        UPDATE wecom_kf_sync_state
        SET cursor = ?, last_error = '', last_synced_at = ?, updated_at = ?
        WHERE open_kfid = ?
      `).run(String(data.next_cursor || state?.cursor || ''), updatedAt, updatedAt, openKfid);
      db.prepare(`
        UPDATE wecom_kf_accounts
        SET last_error = '', last_synced_at = ?, updated_at = ?
        WHERE open_kfid = ?
      `).run(updatedAt, updatedAt, openKfid);
      pages += 1;
      hasMore = Number(data.has_more) === 1;
      if (!hasMore) break;
    }

    if (pages >= MAX_SYNC_PAGES && hasMore) {
      throw new Error(`微信客服账号 ${openKfid} 连续同步页数超过安全上限`);
    }
    await refreshCustomerProfiles(openKfid, [...profileIds]);
    lastSyncAt = nowIso();
    lastError = '';
    return { openKfid, pages, messages: total };
  }

  function syncAccount(openKfid, callbackToken = '') {
    if (!openKfid) return Promise.reject(new Error('open_kfid 不能为空'));
    if (syncInFlight.has(openKfid)) return syncInFlight.get(openKfid);
    const promise = syncAccountInternal(openKfid, callbackToken)
      .catch((error) => {
        const message = String(error?.message || '同步失败').slice(0, 500);
        lastError = message;
        const updatedAt = nowIso();
        try {
          ensureAccount(openKfid);
          db.prepare(`
            UPDATE wecom_kf_sync_state SET last_error = ?, updated_at = ? WHERE open_kfid = ?
          `).run(message, updatedAt, openKfid);
          db.prepare(`
            UPDATE wecom_kf_accounts SET last_error = ?, updated_at = ? WHERE open_kfid = ?
          `).run(message, updatedAt, openKfid);
        } catch (_) {}
        throw error;
      })
      .finally(() => syncInFlight.delete(openKfid));
    syncInFlight.set(openKfid, promise);
    return promise;
  }

  async function syncAllAccounts() {
    const accounts = db.prepare(`
      SELECT open_kfid FROM wecom_kf_accounts ORDER BY open_kfid
    `).all();
    const results = [];
    for (const account of accounts) {
      try {
        results.push(await syncAccount(account.open_kfid));
      } catch (error) {
        logger.error?.(`[wecom-kf] 恢复同步失败 open_kfid=${account.open_kfid}:`, error.message);
      }
    }
    return results;
  }

  function getAssignedBots(openKfid) {
    return db.prepare(`
      SELECT b.id, b.code, b.name, b.type, b.config, a.is_default
      FROM wecom_kf_bot_assignments a
      JOIN bots b ON b.id = a.bot_id
      WHERE a.open_kfid = ? AND b.is_active = 1
      ORDER BY a.is_default DESC, a.id ASC
    `).all(openKfid).map((row) => ({
      id: Number(row.id),
      code: row.code,
      name: row.name,
      type: row.type,
      config: safeJsonParse(row.config, {}),
      isDefault: Boolean(row.is_default),
    }));
  }

  function fallbackBot() {
    const row = db.prepare(`
      SELECT id, code, name, type, config
      FROM bots
      WHERE is_active = 1
      ORDER BY CASE code
        WHEN 'paid_group_assistant' THEN 0
        WHEN 'free_tutor' THEN 1
        ELSE 2 END, id ASC
      LIMIT 1
    `).get();
    if (!row) {
      return {
        id: 0,
        code: 'wecom_kf_default',
        name: '考研助手',
        type: 'configurable',
        config: {
          description: '耐心、准确地回答考研规划、择校和学习问题。',
          showName: false,
        },
        isDefault: true,
      };
    }
    return { ...row, config: safeJsonParse(row.config, {}), isDefault: true };
  }

  function buildConversationContext(openKfid, externalUserid) {
    const rows = db.prepare(`
      SELECT origin, content, send_time, action
      FROM wecom_kf_messages
      WHERE open_kfid = ? AND external_userid = ? AND content != ''
        AND msgtype != 'event'
        AND action NOT IN ('thinking_receipt_sent', 'thinking_receipt_failed')
      ORDER BY send_time DESC, id DESC
      LIMIT ?
    `).all(openKfid, externalUserid, MAX_CONTEXT_MESSAGES).reverse();
    return rows.map((row) => {
      const speaker = Number(row.origin) === 3 ? '学生' : (Number(row.origin) === 6 ? '机器人' : '人工客服');
      const content = String(row.content || '').slice(0, 1200);
      return `${speaker}：${content}`;
    }).join('\n');
  }

  function formatBatchPrompt(messages) {
    return messages.map((message, index) => (
      `第${index + 1}条（${message.msgtype || 'text'}）：\n${String(message.content || '').trim()}`
    )).join('\n\n');
  }

  function claimPending(row) {
    const result = db.prepare(`
      UPDATE wecom_kf_pending_replies
      SET processing_version = ?, updated_at = ?
      WHERE open_kfid = ? AND external_userid = ?
        AND version = ? AND processing_version = 0
    `).run(
      row.version,
      nowIso(),
      row.open_kfid,
      row.external_userid,
      row.version
    );
    return Number(result.changes) > 0;
  }

  function deletePendingVersion(row) {
    db.prepare(`
      DELETE FROM wecom_kf_pending_replies
      WHERE open_kfid = ? AND external_userid = ? AND version = ?
    `).run(row.open_kfid, row.external_userid, row.version);
  }

  function releaseChangedPending(row) {
    db.prepare(`
      UPDATE wecom_kf_pending_replies
      SET processing_version = 0, updated_at = ?
      WHERE open_kfid = ? AND external_userid = ? AND processing_version = ?
    `).run(nowIso(), row.open_kfid, row.external_userid, row.version);
  }

  function retryPending(row, error) {
    const attempts = Number(row.attempts || 0) + 1;
    const delayMs = Math.min(5 * 60 * 1000, 15000 * attempts);
    db.prepare(`
      UPDATE wecom_kf_pending_replies
      SET processing_version = 0, attempts = ?, last_error = ?, due_at = ?, updated_at = ?
      WHERE open_kfid = ? AND external_userid = ? AND version = ?
    `).run(
      attempts,
      String(error?.message || error || '回复失败').slice(0, 500),
      Date.now() + delayMs,
      nowIso(),
      row.open_kfid,
      row.external_userid,
      row.version
    );
  }

  function updateServiceState(openKfid, externalUserid, result) {
    db.prepare(`
      UPDATE wecom_kf_customers
      SET service_state = ?, servicer_userid = ?, updated_at = ?
      WHERE open_kfid = ? AND external_userid = ?
    `).run(
      Number(result.service_state),
      String(result.servicer_userid || ''),
      nowIso(),
      openKfid,
      externalUserid
    );
  }

  async function sendThinkingReceipt(account, identity, content) {
    const msgid = wecomKf.makeKfMessageId('wait');
    try {
      let state = await client.getServiceState(identity.openKfid, identity.externalUserid);
      updateServiceState(identity.openKfid, identity.externalUserid, state);
      if (Number(state.service_state) === 0) {
        await client.transitionServiceState(identity.openKfid, identity.externalUserid, 1);
        state = { ...state, service_state: 1, servicer_userid: '' };
        updateServiceState(identity.openKfid, identity.externalUserid, state);
      }
      if (Number(state.service_state) !== 1) {
        if (Number(state.service_state) === 3) {
          db.prepare(`
            UPDATE wecom_kf_customers
            SET manual_takeover = 1, updated_at = ?
            WHERE open_kfid = ? AND external_userid = ?
          `).run(nowIso(), identity.openKfid, identity.externalUserid);
          cancelPending(identity.openKfid, identity.externalUserid);
        }
        return { sent: false, reason: `service_state_${state.service_state}` };
      }

      const currentAccount = db.prepare(`
        SELECT reply_enabled FROM wecom_kf_accounts WHERE open_kfid = ?
      `).get(identity.openKfid) || account;
      const currentCustomer = db.prepare(`
        SELECT manual_takeover FROM wecom_kf_customers
        WHERE open_kfid = ? AND external_userid = ?
      `).get(identity.openKfid, identity.externalUserid);
      if (!currentAccount?.reply_enabled || currentCustomer?.manual_takeover) {
        return {
          sent: false,
          reason: currentCustomer?.manual_takeover ? 'manual_takeover' : 'reply_disabled',
        };
      }

      const result = await client.sendText(
        identity.openKfid,
        identity.externalUserid,
        content,
        msgid
      );
      recordOutbound(
        identity.openKfid,
        identity.externalUserid,
        msgid,
        content,
        result,
        'thinking_receipt_sent'
      );
      db.prepare(`
        UPDATE wecom_kf_customers
        SET outbound_count = MIN(5, outbound_count + 1),
            last_message_at = MAX(last_message_at, ?), updated_at = ?
        WHERE open_kfid = ? AND external_userid = ?
      `).run(
        Math.floor(Date.now() / 1000),
        nowIso(),
        identity.openKfid,
        identity.externalUserid
      );
      return { sent: true, msgid };
    } catch (error) {
      recordOutbound(
        identity.openKfid,
        identity.externalUserid,
        msgid,
        content,
        {
          errcode: Number(error?.errcode) || 0,
          errmsg: String(error?.message || '即时提示发送失败').slice(0, 500),
        },
        'thinking_receipt_failed'
      );
      logger.warn?.(
        `[wecom-kf] 即时提示发送失败 open_kfid=${identity.openKfid} external_userid=${identity.externalUserid}:`,
        error.message
      );
      return { sent: false, error: error.message };
    }
  }

  function pendingVersionStillCurrent(row) {
    const current = db.prepare(`
      SELECT version, processing_version FROM wecom_kf_pending_replies
      WHERE open_kfid = ? AND external_userid = ?
    `).get(row.open_kfid, row.external_userid);
    return current
      && Number(current.version) === Number(row.version)
      && Number(current.processing_version) === Number(row.version);
  }

  function recordOutbound(openKfid, externalUserid, msgid, content, responseData, action = 'sent') {
    const identity = {
      msgid,
      openKfid,
      externalUserid,
      origin: 6,
      msgtype: 'text',
      eventType: '',
      sendTime: Math.floor(Date.now() / 1000),
    };
    recordMessage(identity, responseData || {}, { content, action });
  }

  async function flushPendingRow(row) {
    if (!claimPending(row)) return { skipped: true };
    const messages = safeJsonParse(row.messages_json, []);
    const account = db.prepare(`
      SELECT * FROM wecom_kf_accounts WHERE open_kfid = ?
    `).get(row.open_kfid);
    const customer = db.prepare(`
      SELECT * FROM wecom_kf_customers WHERE open_kfid = ? AND external_userid = ?
    `).get(row.open_kfid, row.external_userid);

    if (!messages.length || !account || !customer || !account.reply_enabled || customer.manual_takeover) {
      deletePendingVersion(row);
      return { skipped: true };
    }
    const age = Math.floor(Date.now() / 1000) - Number(customer.last_customer_message_at || 0);
    if (age > SEND_WINDOW_SECONDS || Number(customer.outbound_count || 0) >= 5) {
      deletePendingVersion(row);
      return { skipped: true, reason: age > SEND_WINDOW_SECONDS ? 'window_expired' : 'quota_exhausted' };
    }

    let state = await client.getServiceState(row.open_kfid, row.external_userid);
    updateServiceState(row.open_kfid, row.external_userid, state);
    if (Number(state.service_state) === 0) {
      await client.transitionServiceState(row.open_kfid, row.external_userid, 1);
      state = { ...state, service_state: 1, servicer_userid: '' };
      updateServiceState(row.open_kfid, row.external_userid, state);
    }
    if (Number(state.service_state) !== 1) {
      if (Number(state.service_state) === 3) {
        db.prepare(`
          UPDATE wecom_kf_customers SET manual_takeover = 1, updated_at = ?
          WHERE open_kfid = ? AND external_userid = ?
        `).run(nowIso(), row.open_kfid, row.external_userid);
      }
      deletePendingVersion(row);
      return { skipped: true, reason: `service_state_${state.service_state}` };
    }

    const prompt = formatBatchPrompt(messages);
    const selected = selectAssignedBot(getAssignedBots(row.open_kfid), prompt) || fallbackBot();
    const reply = await botHandler({
      bot: selected,
      message: prompt,
      conversationContext: buildConversationContext(row.open_kfid, row.external_userid),
      externalUserId: row.external_userid,
    });
    if (!reply) throw new Error('机器人没有返回有效内容');
    if (!pendingVersionStillCurrent(row)) {
      releaseChangedPending(row);
      return { skipped: true, reason: 'new_message_arrived' };
    }

    const remaining = Math.max(0, 5 - Number(customer.outbound_count || 0));
    const chunks = buildReplyChunks(reply, remaining);
    if (!chunks.length) {
      deletePendingVersion(row);
      return { skipped: true, reason: 'quota_exhausted' };
    }

    let sent = 0;
    try {
      for (let index = 0; index < chunks.length; index += 1) {
        if (index > 0) await sleep(OUTBOUND_CHUNK_DELAY_MS);
        const chunk = chunks[index];
        const msgid = wecomKf.makeKfMessageId('ai');
        const result = await client.sendText(row.open_kfid, row.external_userid, chunk, msgid);
        recordOutbound(row.open_kfid, row.external_userid, msgid, chunk, result, 'sent');
        sent += 1;
        db.prepare(`
          UPDATE wecom_kf_customers
          SET outbound_count = outbound_count + 1,
              last_message_at = MAX(last_message_at, ?), updated_at = ?
          WHERE open_kfid = ? AND external_userid = ?
        `).run(Math.floor(Date.now() / 1000), nowIso(), row.open_kfid, row.external_userid);
      }
    } catch (error) {
      if (sent > 0) {
        deletePendingVersion(row);
        logger.error?.('[wecom-kf] 多段回复部分发送失败，已停止重试以避免重复:', error.message);
        return { replied: true, partial: true, sent };
      }
      throw error;
    }

    const msgids = messages.map((message) => message.msgid).filter(Boolean);
    if (msgids.length) {
      const placeholders = msgids.map(() => '?').join(', ');
      db.prepare(`
        UPDATE wecom_kf_messages SET action = 'replied' WHERE msgid IN (${placeholders})
      `).run(...msgids);
    }
    deletePendingVersion(row);
    return { replied: true, sent, botCode: selected.code };
  }

  async function flushDueReplies(currentTimeMs = Date.now()) {
    const rows = db.prepare(`
      SELECT * FROM wecom_kf_pending_replies
      WHERE due_at <= ? AND processing_version = 0
      ORDER BY due_at ASC
      LIMIT 20
    `).all(currentTimeMs);
    const stats = { processed: 0, replied: 0, errors: 0 };
    for (const row of rows) {
      stats.processed += 1;
      try {
        const result = await flushPendingRow(row);
        if (result?.replied) stats.replied += 1;
      } catch (error) {
        stats.errors += 1;
        retryPending(row, error);
        logger.error?.(
          `[wecom-kf] 自动回复失败 open_kfid=${row.open_kfid} external_userid=${row.external_userid}:`,
          error.message
        );
      }
    }
    return stats;
  }

  function start() {
    if (!runtimeConfig.wecomKfEnabled) return false;
    if (!pendingWorker) {
      db.prepare(`
        UPDATE wecom_kf_pending_replies SET processing_version = 0, updated_at = ?
        WHERE processing_version != 0
      `).run(nowIso());
      pendingWorker = setInterval(() => {
        flushDueReplies().catch((error) => logger.error?.('[wecom-kf] 回复队列异常:', error.message));
      }, PENDING_WORKER_INTERVAL_MS);
      pendingWorker.unref?.();
    }
    if (!recoveryPoller) {
      const intervalSeconds = Math.max(
        30,
        Number(runtimeConfig.wecomKfRecoveryPollIntervalSeconds) || 60
      );
      recoveryPoller = setInterval(() => {
        syncAllAccounts().catch((error) => logger.error?.('[wecom-kf] 恢复轮询异常:', error.message));
      }, intervalSeconds * 1000);
      recoveryPoller.unref?.();
    }
    return true;
  }

  function stop() {
    if (pendingWorker) clearInterval(pendingWorker);
    if (recoveryPoller) clearInterval(recoveryPoller);
    pendingWorker = null;
    recoveryPoller = null;
  }

  function getStatus() {
    return {
      enabled: Boolean(runtimeConfig.wecomKfEnabled),
      running: Boolean(pendingWorker),
      syncingAccounts: [...syncInFlight.keys()],
      lastSyncAt,
      lastError,
      pendingReplies: db.prepare('SELECT COUNT(*) AS count FROM wecom_kf_pending_replies').get().count,
    };
  }

  async function setManualTakeover(openKfid, externalUserid, manual) {
    const customer = ensureCustomer(openKfid, externalUserid);
    let state = await client.getServiceState(openKfid, externalUserid);
    updateServiceState(openKfid, externalUserid, state);
    if (manual) {
      if ([0, 1].includes(Number(state.service_state))) {
        await client.transitionServiceState(openKfid, externalUserid, 2);
        state = { ...state, service_state: 2, servicer_userid: '' };
      }
      cancelPending(openKfid, externalUserid);
      db.prepare(`
        UPDATE wecom_kf_customers
        SET manual_takeover = 1, service_state = ?, updated_at = ?
        WHERE open_kfid = ? AND external_userid = ?
      `).run(Number(state.service_state), nowIso(), openKfid, externalUserid);
    } else {
      // 人工正在接待时，先结束该次人工会话；客户下次发言会回到“未处理”，再自动切至智能助手。
      if (Number(state.service_state) === 3) {
        await client.transitionServiceState(openKfid, externalUserid, 4);
        state = { ...state, service_state: 4, servicer_userid: '' };
      } else if (Number(state.service_state) === 0) {
        await client.transitionServiceState(openKfid, externalUserid, 1);
        state = { ...state, service_state: 1, servicer_userid: '' };
      }
      db.prepare(`
        UPDATE wecom_kf_customers
        SET manual_takeover = 0, service_state = ?, servicer_userid = '', updated_at = ?
        WHERE open_kfid = ? AND external_userid = ?
      `).run(Number(state.service_state), nowIso(), openKfid, externalUserid);
    }
    return db.prepare(`
      SELECT * FROM wecom_kf_customers WHERE open_kfid = ? AND external_userid = ?
    `).get(openKfid, externalUserid) || customer;
  }

  return {
    ensureAccount,
    ensureCustomer,
    processMessage,
    syncAccount,
    syncAllAccounts,
    flushDueReplies,
    start,
    stop,
    getStatus,
    setManualTakeover,
    refreshCustomerProfiles,
  };
}

const defaultDispatcher = createWecomKfDispatcher();

module.exports = {
  ...defaultDispatcher,
  createWecomKfDispatcher,
  getMessageIdentity,
  formatNonMediaMessage,
  selectAssignedBot,
  normalizeEpochSeconds,
  buildReplyChunks,
};
