const crypto = require('crypto');
const dayjs = require('dayjs');
const wecom = require('../services/wecom');

function toBooleanInt(value, fallback = 1) {
  if (value === undefined) return fallback;
  return value === true || value === 1 || value === '1' ? 1 : 0;
}

function normalizeDelay(value, fallback = 5) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(300, Math.max(0, Math.round(number)));
}

function normalizeUserIds(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item || '').trim()).filter(Boolean))];
}

function normalizeBotIds(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(Number).filter((id) => Number.isInteger(id) && id > 0))];
}

function makeChatId() {
  return `kyai${Date.now().toString(36)}${crypto.randomBytes(4).toString('hex')}`.slice(0, 32);
}

function makeBindingToken() {
  return crypto.randomBytes(12).toString('hex');
}

function bindingMessage(token) {
  return `机器人正在接入本群，通常几秒内完成。\n[机器人绑定:${token}]`;
}

function serializeGroup(db, row) {
  const members = db.prepare(`
    SELECT user_id, role, created_at
    FROM wecom_group_members
    WHERE group_id = ?
    ORDER BY CASE role WHEN 'owner' THEN 0 ELSE 1 END, id ASC
  `).all(row.id).map((member) => ({
    userId: member.user_id,
    role: member.role,
    createdAt: member.created_at,
  }));

  const bots = db.prepare(`
    SELECT b.id, b.code, b.name, b.type, a.is_default
    FROM bot_group_assignments a
    JOIN bots b ON b.id = a.bot_id
    WHERE a.group_id = ?
    ORDER BY a.is_default DESC, a.id ASC
  `).all(row.id).map((bot) => ({
    id: bot.id,
    code: bot.code,
    name: bot.name,
    type: bot.type,
    isDefault: Boolean(bot.is_default),
  }));

  const pending = db.prepare(
    'SELECT due_at, attempts, last_error FROM wecom_pending_replies WHERE group_id = ? LIMIT 1'
  ).get(row.id);

  return {
    id: row.id,
    chatId: row.chat_id,
    archiveRoomId: row.archive_roomid || '',
    name: row.name || '',
    owner: row.owner || '',
    replyEnabled: Boolean(row.reply_enabled),
    replyAllText: Boolean(row.reply_all_text),
    replyDelaySeconds: Number(row.reply_delay_seconds) || 0,
    connected: Boolean(row.archive_roomid),
    members,
    bots,
    pending: pending ? {
      dueAt: pending.due_at,
      attempts: pending.attempts,
      lastError: pending.last_error || '',
    } : null,
    createdAt: row.created_at,
  };
}

function replaceGroupBots(db, groupId, botIds, defaultBotId, now) {
  const validBotIds = normalizeBotIds(botIds);
  if (validBotIds.length > 0) {
    const placeholders = validBotIds.map(() => '?').join(', ');
    const found = db.prepare(
      `SELECT id FROM bots WHERE id IN (${placeholders})`
    ).all(...validBotIds).map((row) => Number(row.id));
    if (found.length !== validBotIds.length) {
      throw new Error('选择的机器人中包含不存在的记录');
    }
  }

  const normalizedDefaultId = validBotIds.includes(Number(defaultBotId))
    ? Number(defaultBotId)
    : validBotIds[0] || null;
  db.prepare('DELETE FROM bot_group_assignments WHERE group_id = ?').run(groupId);
  const insert = db.prepare(`
    INSERT INTO bot_group_assignments (bot_id, group_id, is_default, created_at)
    VALUES (?, ?, ?, ?)
  `);
  for (const botId of validBotIds) {
    insert.run(botId, groupId, botId === normalizedDefaultId ? 1 : 0, now);
  }
}

module.exports = function registerWecomAdminRoutes(app, shared) {
  const { db, requireAdmin } = shared;

  app.get('/api/admin/wecom/directory', requireAdmin, async (_request, response) => {
    try {
      const result = await wecom.listVisibleUsers(1, true);
      if (!result || Number(result.errcode) !== 0) {
        return response.status(502).json({
          error: result?.errmsg || '无法读取企业微信通讯录，请检查自建应用的可见范围和通讯录权限。',
          errcode: result?.errcode,
        });
      }

      const users = (result.userlist || []).map((user) => ({
        userId: user.userid,
        name: user.name || user.userid,
        department: Array.isArray(user.department) ? user.department : [],
        position: user.position || '',
        avatar: user.avatar || '',
        status: user.status,
      }));
      response.json({ users });
    } catch (error) {
      console.error('[wecom-admin] 读取通讯录失败:', error.message);
      response.status(502).json({ error: '读取企业微信通讯录失败。' });
    }
  });

  app.get('/api/admin/wecom/groups', requireAdmin, (_request, response) => {
    try {
      const rows = db.prepare(`
        SELECT id, chat_id, archive_roomid, name, owner,
               reply_enabled, reply_all_text, reply_delay_seconds, created_at
        FROM wecom_groups
        ORDER BY created_at DESC, id DESC
      `).all();
      response.json({ groups: rows.map((row) => serializeGroup(db, row)) });
    } catch (error) {
      console.error('[wecom-admin] 列出群聊失败:', error.message);
      response.status(500).json({ error: '读取企业微信群聊失败。' });
    }
  });

  app.post('/api/admin/wecom/groups', requireAdmin, async (request, response) => {
    const name = String(request.body?.name || '').trim();
    const owner = String(request.body?.owner || '').trim();
    const members = normalizeUserIds(request.body?.memberUserIds);
    const botIds = normalizeBotIds(request.body?.botIds);
    const defaultBotId = Number(request.body?.defaultBotId) || null;

    if (!name) return response.status(400).json({ error: '群聊名称不能为空。' });
    if (!owner) return response.status(400).json({ error: '请选择群主。' });
    if (members.length === 0) return response.status(400).json({ error: '请至少选择一位群成员。' });
    if (name.length > 50) return response.status(400).json({ error: '群聊名称不能超过 50 个字符。' });

    const userlist = [...new Set([owner, ...members])];
    const chatId = makeChatId();
    const token = makeBindingToken();

    try {
      const createResult = await wecom.createAppChat({ name, owner, userlist, chatid: chatId });
      if (!createResult || Number(createResult.errcode) !== 0) {
        return response.status(502).json({
          error: `企业微信建群失败：${createResult?.errmsg || '接口未返回结果'}`,
          errcode: createResult?.errcode,
        });
      }

      const now = dayjs().toISOString();
      const createLocalGroup = db.transaction(() => {
        const groupResult = db.prepare(`
          INSERT INTO wecom_groups
            (chat_id, archive_roomid, name, owner, reply_enabled, reply_all_text,
             reply_delay_seconds, binding_token, created_at)
          VALUES (?, '', ?, ?, ?, ?, ?, ?, ?)
        `).run(
          chatId,
          name,
          owner,
          toBooleanInt(request.body?.replyEnabled, 1),
          toBooleanInt(request.body?.replyAllText, 1),
          normalizeDelay(request.body?.replyDelaySeconds, 5),
          token,
          now
        );
        const groupId = Number(groupResult.lastInsertRowid);

        const insertMember = db.prepare(`
          INSERT OR IGNORE INTO wecom_group_members (group_id, user_id, role, created_at)
          VALUES (?, ?, ?, ?)
        `);
        for (const userId of userlist) {
          insertMember.run(groupId, userId, userId === owner ? 'owner' : 'member', now);
        }
        replaceGroupBots(db, groupId, botIds, defaultBotId, now);
        return groupId;
      });

      const groupId = createLocalGroup();
      const bindResult = await wecom.sendAppChatMessage({
        chatid: chatId,
        msgtype: 'text',
        text: { content: bindingMessage(token) },
      });

      const row = db.prepare('SELECT * FROM wecom_groups WHERE id = ?').get(groupId);
      response.status(201).json({
        group: serializeGroup(db, row),
        bindingMessageSent: Number(bindResult?.errcode) === 0,
        warning: Number(bindResult?.errcode) === 0
          ? ''
          : `群已创建，但自动绑定消息发送失败：${bindResult?.errmsg || '未知错误'}`,
      });
    } catch (error) {
      console.error('[wecom-admin] 创建群聊失败:', error.message);
      response.status(500).json({ error: `创建群聊失败：${error.message}` });
    }
  });

  app.put('/api/admin/wecom/groups/:id', requireAdmin, (request, response) => {
    const groupId = Number(request.params.id);
    if (!Number.isInteger(groupId) || groupId <= 0) {
      return response.status(400).json({ error: '群组 ID 无效。' });
    }
    const group = db.prepare('SELECT * FROM wecom_groups WHERE id = ?').get(groupId);
    if (!group) return response.status(404).json({ error: '群聊不存在。' });

    try {
      const now = dayjs().toISOString();
      db.transaction(() => {
        db.prepare(`
          UPDATE wecom_groups
          SET reply_enabled = ?, reply_all_text = ?, reply_delay_seconds = ?
          WHERE id = ?
        `).run(
          toBooleanInt(request.body?.replyEnabled, group.reply_enabled),
          toBooleanInt(request.body?.replyAllText, group.reply_all_text),
          normalizeDelay(request.body?.replyDelaySeconds, group.reply_delay_seconds),
          groupId
        );
        if (request.body?.botIds !== undefined) {
          replaceGroupBots(
            db,
            groupId,
            request.body.botIds,
            request.body.defaultBotId,
            now
          );
        }
      })();

      const updated = db.prepare('SELECT * FROM wecom_groups WHERE id = ?').get(groupId);
      response.json({ group: serializeGroup(db, updated) });
    } catch (error) {
      console.error('[wecom-admin] 更新群聊设置失败:', error.message);
      response.status(400).json({ error: error.message });
    }
  });

  app.post('/api/admin/wecom/groups/:id/members', requireAdmin, async (request, response) => {
    const groupId = Number(request.params.id);
    const users = normalizeUserIds(request.body?.userIds);
    const group = db.prepare('SELECT * FROM wecom_groups WHERE id = ?').get(groupId);
    if (!group) return response.status(404).json({ error: '群聊不存在。' });
    if (!users.length) return response.status(400).json({ error: '请选择要添加的成员。' });

    try {
      const result = await wecom.inviteChatMembers({ chatid: group.chat_id, userlist: users });
      if (!result || Number(result.errcode) !== 0) {
        return response.status(502).json({
          error: `企业微信添加成员失败：${result?.errmsg || '接口未返回结果'}`,
          errcode: result?.errcode,
        });
      }

      const insert = db.prepare(`
        INSERT OR IGNORE INTO wecom_group_members (group_id, user_id, role, created_at)
        VALUES (?, ?, 'member', ?)
      `);
      const now = dayjs().toISOString();
      db.transaction(() => users.forEach((userId) => insert.run(groupId, userId, now)))();
      const updated = db.prepare('SELECT * FROM wecom_groups WHERE id = ?').get(groupId);
      response.json({ group: serializeGroup(db, updated) });
    } catch (error) {
      console.error('[wecom-admin] 添加群成员失败:', error.message);
      response.status(500).json({ error: '添加群成员失败。' });
    }
  });

  app.post('/api/admin/wecom/groups/:id/rebind', requireAdmin, async (request, response) => {
    const groupId = Number(request.params.id);
    const group = db.prepare('SELECT * FROM wecom_groups WHERE id = ?').get(groupId);
    if (!group) return response.status(404).json({ error: '群聊不存在。' });

    try {
      const token = group.binding_token || makeBindingToken();
      if (!group.binding_token) {
        db.prepare('UPDATE wecom_groups SET binding_token = ? WHERE id = ?').run(token, groupId);
      }
      const result = await wecom.sendAppChatMessage({
        chatid: group.chat_id,
        msgtype: 'text',
        text: { content: bindingMessage(token) },
      });
      if (!result || Number(result.errcode) !== 0) {
        return response.status(502).json({
          error: `重新绑定消息发送失败：${result?.errmsg || '接口未返回结果'}`,
        });
      }
      response.json({ success: true });
    } catch (error) {
      console.error('[wecom-admin] 重新绑定群聊失败:', error.message);
      response.status(500).json({ error: '重新绑定群聊失败。' });
    }
  });

  app.post('/api/admin/wecom/groups/:id/sync', requireAdmin, async (request, response) => {
    const groupId = Number(request.params.id);
    const group = db.prepare('SELECT * FROM wecom_groups WHERE id = ?').get(groupId);
    if (!group) return response.status(404).json({ error: '群聊不存在。' });

    try {
      const result = await wecom.getAppChat(group.chat_id);
      if (!result || Number(result.errcode) !== 0 || !result.chat_info) {
        return response.status(502).json({
          error: `同步企业微信群失败：${result?.errmsg || '接口未返回群详情'}`,
        });
      }
      const info = result.chat_info;
      const userlist = normalizeUserIds(info.userlist || []);
      const now = dayjs().toISOString();
      db.transaction(() => {
        db.prepare('UPDATE wecom_groups SET name = ?, owner = ? WHERE id = ?')
          .run(info.name || group.name, info.owner || group.owner, groupId);
        db.prepare('DELETE FROM wecom_group_members WHERE group_id = ?').run(groupId);
        const insert = db.prepare(`
          INSERT INTO wecom_group_members (group_id, user_id, role, created_at)
          VALUES (?, ?, ?, ?)
        `);
        for (const userId of userlist) {
          insert.run(groupId, userId, userId === info.owner ? 'owner' : 'member', now);
        }
      })();
      const updated = db.prepare('SELECT * FROM wecom_groups WHERE id = ?').get(groupId);
      response.json({ group: serializeGroup(db, updated) });
    } catch (error) {
      console.error('[wecom-admin] 同步群聊失败:', error.message);
      response.status(500).json({ error: '同步群聊失败。' });
    }
  });
};

