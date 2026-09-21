const config = require('../config');
const wecomKf = require('../services/wecomKf');
const dispatcher = require('../services/wecomKfDispatcher');

const SERVICE_STATE_LABELS = {
  0: '新接入待处理',
  1: '智能助手接待',
  2: '待人工接入',
  3: '人工接待',
  4: '已结束/未开始',
};

function nowIso() {
  return new Date().toISOString();
}

function normalizeDelay(value, fallback = 5) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(300, Math.max(0, Math.round(number)));
}

function normalizeBotIds(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(Number).filter((id) => Number.isInteger(id) && id > 0))];
}

function replaceAccountBots(db, openKfid, botIds, defaultBotId) {
  const ids = normalizeBotIds(botIds);
  if (ids.length) {
    const placeholders = ids.map(() => '?').join(', ');
    const found = db.prepare(`
      SELECT id FROM bots WHERE id IN (${placeholders}) AND is_active = 1
    `).all(...ids).map((row) => Number(row.id));
    if (found.length !== ids.length) throw new Error('选择的机器人中包含不存在或已停用的角色');
  }
  const defaultId = ids.includes(Number(defaultBotId)) ? Number(defaultBotId) : (ids[0] || null);
  db.prepare('DELETE FROM wecom_kf_bot_assignments WHERE open_kfid = ?').run(openKfid);
  const insert = db.prepare(`
    INSERT INTO wecom_kf_bot_assignments (open_kfid, bot_id, is_default, created_at)
    VALUES (?, ?, ?, ?)
  `);
  for (const botId of ids) {
    insert.run(openKfid, botId, botId === defaultId ? 1 : 0, nowIso());
  }
}

function serializeAccount(db, row) {
  const bots = db.prepare(`
    SELECT b.id, b.code, b.name, b.type, a.is_default
    FROM wecom_kf_bot_assignments a
    JOIN bots b ON b.id = a.bot_id
    WHERE a.open_kfid = ?
    ORDER BY a.is_default DESC, a.id ASC
  `).all(row.open_kfid).map((bot) => ({
    id: Number(bot.id),
    code: bot.code,
    name: bot.name,
    type: bot.type,
    isDefault: Boolean(bot.is_default),
  }));
  const stats = db.prepare(`
    SELECT COUNT(*) AS customer_count,
           SUM(CASE WHEN manual_takeover = 1 THEN 1 ELSE 0 END) AS manual_count
    FROM wecom_kf_customers WHERE open_kfid = ?
  `).get(row.open_kfid);
  const pending = db.prepare(`
    SELECT COUNT(*) AS count FROM wecom_kf_pending_replies WHERE open_kfid = ?
  `).get(row.open_kfid);
  return {
    openKfid: row.open_kfid,
    name: row.name || row.open_kfid,
    avatar: row.avatar || '',
    contactUrl: row.contact_url || '',
    replyEnabled: Boolean(row.reply_enabled),
    replyDelaySeconds: Number(row.reply_delay_seconds) || 0,
    managedByApi: Boolean(row.managed_by_api),
    lastError: row.last_error || '',
    lastSyncedAt: row.last_synced_at || null,
    updatedAt: row.updated_at,
    bots,
    customerCount: Number(stats.customer_count || 0),
    manualCount: Number(stats.manual_count || 0),
    pendingCount: Number(pending.count || 0),
  };
}

function serializeCustomer(row) {
  const lastCustomerMessageAt = Number(row.last_customer_message_at || 0);
  return {
    openKfid: row.open_kfid,
    externalUserid: row.external_userid,
    nickname: row.nickname || row.external_userid,
    avatar: row.avatar || '',
    serviceState: Number(row.service_state),
    serviceStateLabel: SERVICE_STATE_LABELS[Number(row.service_state)] || '未知',
    servicerUserid: row.servicer_userid || '',
    manualTakeover: Boolean(row.manual_takeover),
    rejectSwitch: Boolean(row.reject_switch),
    outboundCount: Number(row.outbound_count || 0),
    remainingMessages: Math.max(0, 5 - Number(row.outbound_count || 0)),
    lastCustomerMessageAt,
    sendWindowExpiresAt: lastCustomerMessageAt
      ? new Date((lastCustomerMessageAt + 48 * 60 * 60) * 1000).toISOString()
      : null,
    lastMessageAt: Number(row.last_message_at || 0),
    lastMessage: row.last_message || '',
    updatedAt: row.updated_at,
  };
}

function apiError(response, error, fallback) {
  const errcode = Number(error?.errcode);
  const permissionCodes = new Set([48002, 60011, 84074, 95000, 95001, 95002]);
  const permissionHint = permissionCodes.has(errcode)
    || /permission|not allow|无权限|未授权|可调用接口的应用|可管理的客服账号/i.test(error?.message || '');
  return response.status(permissionHint ? 403 : 502).json({
    error: error?.message || fallback,
    errcode: Number.isFinite(errcode) ? errcode : undefined,
    permissionRequired: permissionHint,
  });
}

module.exports = function registerWecomKfAdminRoutes(app, shared) {
  const { db, requireAdmin } = shared;

  app.get('/api/admin/wecom/kf/status', requireAdmin, (_request, response) => {
    const callbackBase = String(config.contentSecurityPublicBaseUrl || '').replace(/\/$/, '');
    response.json({
      enabled: Boolean(config.wecomKfEnabled),
      credentialsReady: Boolean(
        config.wecomCorpId
        && config.wecomKfSecret
        && config.wecomKfToken
        && config.wecomKfEncodingAesKey
      ),
      callbackUrl: `${callbackBase}/api/wecom/kf/callback`,
      defaultReplyDelaySeconds: Number(config.wecomKfReplyDelaySeconds) || 5,
      usesSharedSecret: !process.env.WECOM_KF_SECRET,
      usesSharedCallbackCredentials: !process.env.WECOM_KF_TOKEN
        && !process.env.WECOM_KF_ENCODING_AES_KEY,
      runtime: dispatcher.getStatus(),
      permissionSteps: [
        '在企业微信管理后台开通“微信客服”，并至少创建一个客服账号。',
        '在“微信客服—API—可调用接口的应用”中选择当前自建应用，并把客服账号授权给它管理。',
        '在微信客服回调配置中填写本页的回调 URL，以及服务器现有的 Token 和 EncodingAESKey。',
      ],
    });
  });

  app.get('/api/admin/wecom/kf/accounts', requireAdmin, (_request, response) => {
    const rows = db.prepare(`
      SELECT * FROM wecom_kf_accounts ORDER BY name COLLATE NOCASE, open_kfid
    `).all();
    response.json({ accounts: rows.map((row) => serializeAccount(db, row)) });
  });

  app.post('/api/admin/wecom/kf/accounts/sync', requireAdmin, async (_request, response) => {
    try {
      const remoteAccounts = await wecomKf.listAccounts();
      const warnings = [];
      for (const remote of remoteAccounts) {
        const openKfid = String(remote.open_kfid || '');
        if (!openKfid) continue;
        const existing = dispatcher.ensureAccount(openKfid, {
          name: remote.name,
          avatar: remote.avatar,
          managedByApi: remote.manage_privilege,
        });
        if (!existing.contact_url) {
          try {
            const contact = await wecomKf.getContactWay(openKfid, 'admin');
            db.prepare(`
              UPDATE wecom_kf_accounts SET contact_url = ?, updated_at = ? WHERE open_kfid = ?
            `).run(String(contact.url || ''), nowIso(), openKfid);
          } catch (error) {
            warnings.push(`${remote.name || openKfid}：入口链接获取失败（${error.message}）`);
          }
        }
      }
      const rows = db.prepare(`
        SELECT * FROM wecom_kf_accounts ORDER BY name COLLATE NOCASE, open_kfid
      `).all();
      response.json({
        accounts: rows.map((row) => serializeAccount(db, row)),
        remoteCount: remoteAccounts.length,
        warnings,
      });
    } catch (error) {
      console.error('[wecom-kf-admin] 同步客服账号失败:', error.message);
      apiError(response, error, '同步微信客服账号失败');
    }
  });

  app.put('/api/admin/wecom/kf/accounts/:openKfid', requireAdmin, (request, response) => {
    const openKfid = String(request.params.openKfid || '');
    const account = db.prepare(`
      SELECT * FROM wecom_kf_accounts WHERE open_kfid = ?
    `).get(openKfid);
    if (!account) return response.status(404).json({ error: '微信客服账号不存在。' });

    try {
      db.transaction(() => {
        db.prepare(`
          UPDATE wecom_kf_accounts
          SET reply_enabled = ?, reply_delay_seconds = ?, updated_at = ?
          WHERE open_kfid = ?
        `).run(
          request.body?.replyEnabled === false ? 0 : 1,
          normalizeDelay(request.body?.replyDelaySeconds, account.reply_delay_seconds),
          nowIso(),
          openKfid
        );
        if (request.body?.botIds !== undefined) {
          replaceAccountBots(
            db,
            openKfid,
            request.body.botIds,
            request.body.defaultBotId
          );
        }
      })();
      const updated = db.prepare('SELECT * FROM wecom_kf_accounts WHERE open_kfid = ?').get(openKfid);
      response.json({ account: serializeAccount(db, updated) });
    } catch (error) {
      response.status(400).json({ error: error.message });
    }
  });

  app.post('/api/admin/wecom/kf/accounts/:openKfid/link', requireAdmin, async (request, response) => {
    const openKfid = String(request.params.openKfid || '');
    if (!db.prepare('SELECT 1 FROM wecom_kf_accounts WHERE open_kfid = ?').get(openKfid)) {
      return response.status(404).json({ error: '微信客服账号不存在。' });
    }
    try {
      const result = await wecomKf.getContactWay(openKfid, String(request.body?.scene || 'admin'));
      db.prepare(`
        UPDATE wecom_kf_accounts SET contact_url = ?, updated_at = ? WHERE open_kfid = ?
      `).run(String(result.url || ''), nowIso(), openKfid);
      response.json({ url: result.url || '' });
    } catch (error) {
      apiError(response, error, '获取微信客服入口链接失败');
    }
  });

  app.post('/api/admin/wecom/kf/accounts/:openKfid/messages/sync', requireAdmin, async (request, response) => {
    const openKfid = String(request.params.openKfid || '');
    try {
      const result = await dispatcher.syncAccount(openKfid);
      response.json({ result });
    } catch (error) {
      apiError(response, error, '同步微信客服消息失败');
    }
  });

  app.get('/api/admin/wecom/kf/accounts/:openKfid/customers', requireAdmin, (request, response) => {
    const openKfid = String(request.params.openKfid || '');
    const limit = Math.min(200, Math.max(1, Number(request.query.limit) || 100));
    const rows = db.prepare(`
      SELECT c.*,
             COALESCE((
               SELECT content FROM wecom_kf_messages m
               WHERE m.open_kfid = c.open_kfid
                 AND m.external_userid = c.external_userid
                 AND m.msgtype != 'event'
               ORDER BY m.send_time DESC, m.id DESC
               LIMIT 1
             ), '') AS last_message
      FROM wecom_kf_customers c
      WHERE c.open_kfid = ?
      ORDER BY c.last_message_at DESC
      LIMIT ?
    `).all(openKfid, limit);
    response.json({ customers: rows.map(serializeCustomer) });
  });

  app.post(
    '/api/admin/wecom/kf/accounts/:openKfid/customers/:externalUserid/takeover',
    requireAdmin,
    async (request, response) => {
      const openKfid = String(request.params.openKfid || '');
      const externalUserid = String(request.params.externalUserid || '');
      const manual = request.body?.manual !== false;
      try {
        const updated = await dispatcher.setManualTakeover(openKfid, externalUserid, manual);
        response.json({ customer: serializeCustomer(updated) });
      } catch (error) {
        apiError(response, error, manual ? '转人工失败' : '恢复 AI 接待失败');
      }
    }
  );
};

module.exports.serializeAccount = serializeAccount;
module.exports.serializeCustomer = serializeCustomer;
module.exports.replaceAccountBots = replaceAccountBots;
