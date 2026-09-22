const dayjs = require('dayjs');
const { startHandoff, endHandoff, isInHandoff, getActiveHandoff, listActiveHandoffs, getHandoffHistory } = require('../services/bots/humanHandoff');
const {
  createDefaultBotConfig,
  recordAudit,
  validateBotConfig
} = require('../services/robotConfig');
const { dispatchSchedule } = require('../services/botPush');

module.exports = function registerBotRoutes(app, shared) {
  const { db, requireAdmin } = shared;

  // 列出所有机器人
  app.get('/api/admin/bots', requireAdmin, (request, response) => {
    try {
      const { type, isActive, search } = request.query;
      let sql = 'SELECT * FROM bots WHERE 1=1';
      const params = [];
      if (type) {
        sql += ' AND type = ?';
        params.push(type);
      }
      if (isActive !== undefined && isActive !== '') {
        sql += ' AND is_active = ?';
        params.push(Number(isActive));
      }
      if (search) {
        sql += ' AND (name LIKE ? OR code LIKE ?)';
        params.push(`%${search}%`, `%${search}%`);
      }
      const rows = db.prepare(sql + ' ORDER BY created_at DESC').all(...params);
      response.json({
        bots: rows.map(serializeBot)
      });
    } catch (error) {
      console.error('列出机器人失败:', error);
      response.status(500).json({ error: '列出机器人失败。' });
    }
  });

  // 根据 code 获取机器人
  app.get('/api/admin/bots/:code', requireAdmin, (request, response) => {
    try {
      const row = db.prepare('SELECT * FROM bots WHERE code = ?').get(request.params.code);
      if (!row) {
        return response.status(404).json({ error: '机器人不存在。' });
      }
      response.json(serializeBot(row));
    } catch (error) {
      console.error('获取机器人失败:', error);
      response.status(500).json({ error: '获取机器人失败。' });
    }
  });

  // 创建机器人
  app.post('/api/admin/bots', requireAdmin, (request, response) => {
    try {
      const { code, name, type, config } = request.body;
      if (!code || !code.trim()) {
        return response.status(400).json({ error: '机器人 code 不能为空。' });
      }
      if (!/^[a-z][a-z0-9_-]{1,63}$/.test(code.trim())) {
        return response.status(400).json({ error: '机器人编码只能使用小写字母、数字、下划线和短横线，并以字母开头。' });
      }
      if (!name || !name.trim()) {
        return response.status(400).json({ error: '机器人名称不能为空。' });
      }
      if (!type || !type.trim()) {
        return response.status(400).json({ error: '机器人类型不能为空。' });
      }
      const now = dayjs().toISOString();
      const normalizedConfig = createDefaultBotConfig({ ...(config || {}), name: name.trim(), type: type.trim() });
      const robotUid = nextRobotUid(db);
      const result = db.prepare(
        `INSERT INTO bots
          (robot_uid, code, name, type, config, status, is_active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'draft', 0, ?, ?)`
      ).run(
        robotUid,
        code.trim(),
        name.trim(),
        type.trim(),
        JSON.stringify(normalizedConfig),
        now,
        now
      );
      recordAudit(db, {
        botId: Number(result.lastInsertRowid),
        actorId: request.currentUser?.id,
        action: 'create',
        after: normalizedConfig,
        summary: `创建机器人 ${robotUid}，默认草稿`
      });
      response.json({
        id: result.lastInsertRowid,
        robotUid,
        code: code.trim(),
        name: name.trim(),
        type: type.trim(),
        config: normalizedConfig,
        status: 'draft',
        isActive: false,
        checklist: validateBotConfig(normalizedConfig)
      });
    } catch (error) {
      if (error.message && error.message.includes('UNIQUE constraint failed')) {
        return response.status(409).json({ error: '机器人 code 已存在。' });
      }
      console.error('创建机器人失败:', error);
      response.status(500).json({ error: '创建机器人失败。' });
    }
  });

  // 更新机器人
  app.put('/api/admin/bots/:id', requireAdmin, (request, response) => {
    try {
      const id = Number(request.params.id);
      const { name, type, config, isActive } = request.body;
      const existing = db.prepare('SELECT * FROM bots WHERE id = ?').get(id);
      if (!existing) {
        return response.status(404).json({ error: '机器人不存在。' });
      }
      const nextName = name !== undefined ? String(name).trim() : existing.name;
      const nextType = type !== undefined ? String(type).trim() : existing.type;
      if (!nextName || !nextType) {
        return response.status(400).json({ error: '机器人名称和类型不能为空。' });
      }
      const previousConfig = safeJsonParse(existing.config, {});
      const nextConfig = config !== undefined
        ? createDefaultBotConfig({ ...(config || {}), name: nextName, type: nextType })
        : createDefaultBotConfig(previousConfig);
      const requestedActive = isActive !== undefined ? Boolean(isActive) : Boolean(existing.is_active);
      const validation = validateBotConfig(nextConfig);
      if (requestedActive && !validation.valid) {
        return response.status(422).json({ error: '机器人配置未通过上线检查。', checklist: validation.checks });
      }
      const nextStatus = requestedActive ? 'online' : (existing.status === 'archived' ? 'archived' : 'draft');
      const now = dayjs().toISOString();
      db.prepare(
        'UPDATE bots SET name = ?, type = ?, config = ?, status = ?, is_active = ?, updated_at = ? WHERE id = ?'
      ).run(
        nextName,
        nextType,
        JSON.stringify(nextConfig),
        nextStatus,
        requestedActive ? 1 : 0,
        now,
        id
      );
      recordAudit(db, {
        botId: id,
        actorId: request.currentUser?.id,
        action: 'update',
        before: previousConfig,
        after: nextConfig,
        summary: '更新机器人配置'
      });
      response.json({ success: true, checklist: validation.checks, status: nextStatus });
    } catch (error) {
      console.error('更新机器人失败:', error);
      response.status(500).json({ error: '更新机器人失败。' });
    }
  });

  app.get('/api/admin/bots/:id/checklist', requireAdmin, (request, response) => {
    const row = db.prepare('SELECT * FROM bots WHERE id = ?').get(Number(request.params.id));
    if (!row) return response.status(404).json({ error: '机器人不存在。' });
    const validation = validateBotConfig(safeJsonParse(row.config, {}));
    response.json({ robotUid: row.robot_uid, status: row.status, ...validation });
  });

  app.post('/api/admin/bots/:id/activate', requireAdmin, (request, response) => {
    try {
      const id = Number(request.params.id);
      const row = db.prepare('SELECT * FROM bots WHERE id = ?').get(id);
      if (!row) return response.status(404).json({ error: '机器人不存在。' });
      const validation = validateBotConfig(safeJsonParse(row.config, {}));
      if (!validation.valid) {
        return response.status(422).json({ error: '机器人配置未通过上线检查。', checklist: validation.checks });
      }
      const now = dayjs().toISOString();
      db.prepare("UPDATE bots SET status = 'online', is_active = 1, updated_at = ? WHERE id = ?").run(now, id);
      recordAudit(db, {
        botId: id,
        actorId: request.currentUser?.id,
        action: 'activate',
        before: { status: row.status },
        after: { status: 'online' },
        summary: '机器人通过检查并上线'
      });
      response.json({ success: true, status: 'online', checklist: validation.checks });
    } catch (error) {
      console.error('机器人上线失败:', error);
      response.status(500).json({ error: '机器人上线失败。' });
    }
  });

  app.post('/api/admin/bots/:id/pause', requireAdmin, (request, response) => {
    try {
      const id = Number(request.params.id);
      const row = db.prepare('SELECT * FROM bots WHERE id = ?').get(id);
      if (!row) return response.status(404).json({ error: '机器人不存在。' });
      const now = dayjs().toISOString();
      db.prepare("UPDATE bots SET status = 'paused', is_active = 0, updated_at = ? WHERE id = ?").run(now, id);
      recordAudit(db, {
        botId: id,
        actorId: request.currentUser?.id,
        action: 'pause',
        before: { status: row.status },
        after: { status: 'paused' },
        summary: String(request.body?.reason || '管理员暂停机器人')
      });
      response.json({ success: true, status: 'paused' });
    } catch (error) {
      console.error('暂停机器人失败:', error);
      response.status(500).json({ error: '暂停机器人失败。' });
    }
  });

  app.get('/api/admin/bots/:id/audits', requireAdmin, (request, response) => {
    const id = Number(request.params.id);
    const limit = Math.min(200, Math.max(1, Number(request.query.limit) || 50));
    const rows = db.prepare(`
      SELECT a.*, u.display_name AS actor_name
      FROM bot_config_audits a
      LEFT JOIN users u ON u.id = a.actor_id
      WHERE a.bot_id = ? ORDER BY a.created_at DESC LIMIT ?
    `).all(id, limit);
    response.json({ audits: rows.map((row) => ({
      id: row.id,
      action: row.action,
      summary: row.summary,
      actorName: row.actor_name || '系统',
      before: safeJsonParse(row.before_json, {}),
      after: safeJsonParse(row.after_json, {}),
      createdAt: row.created_at
    })) });
  });

  app.post('/api/admin/bots/:id/releases', requireAdmin, (request, response) => {
    try {
      const id = Number(request.params.id);
      const bot = db.prepare('SELECT * FROM bots WHERE id = ?').get(id);
      if (!bot) return response.status(404).json({ error: '机器人不存在。' });
      const percent = Number(request.body?.rolloutPercent || 10);
      if (![10, 50, 100].includes(percent)) return response.status(400).json({ error: '灰度比例只能是 10、50 或 100。' });
      const now = dayjs().toISOString();
      const nextConfig = createDefaultBotConfig(safeJsonParse(bot.config, {}));
      nextConfig.rolloutPercent = percent;
      const result = db.prepare(`
        INSERT INTO bot_release_batches
          (bot_id, resource_type, resource_key, rollout_percent, status, snapshot_json, created_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'observing', ?, ?, ?, ?)
      `).run(
        id,
        String(request.body?.resourceType || 'config'),
        String(request.body?.resourceKey || ''),
        percent,
        bot.config || '{}',
        request.currentUser?.id || null,
        now,
        now
      );
      db.prepare('UPDATE bots SET config = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(nextConfig), now, id);
      recordAudit(db, {
        botId: id,
        actorId: request.currentUser?.id,
        action: 'gray_release',
        after: { rolloutPercent: percent },
        summary: `启动 ${percent}% 灰度发布`
      });
      response.json({ id: result.lastInsertRowid, status: 'observing', rolloutPercent: percent });
    } catch (error) {
      console.error('创建灰度发布失败:', error);
      response.status(500).json({ error: '创建灰度发布失败。' });
    }
  });

  app.post('/api/admin/bots/:id/schedules/:scheduleId/trigger', requireAdmin, async (request, response) => {
    try {
      const id = Number(request.params.id);
      const bot = db.prepare('SELECT * FROM bots WHERE id = ?').get(id);
      if (!bot) return response.status(404).json({ error: '机器人不存在。' });
      if (!bot.is_active || bot.status !== 'online') return response.status(409).json({ error: '机器人未上线，不能执行主动推送。' });
      const config = createDefaultBotConfig(safeJsonParse(bot.config, {}));
      const schedule = config.schedules.find((item) => String(item.id || item.name) === String(request.params.scheduleId));
      if (!schedule) return response.status(404).json({ error: '定时任务不存在。' });
      const studentIds = Array.isArray(request.body?.studentIds) ? request.body.studentIds : [];
      // 手动触发默认按「此刻」判定静默时段与每日频次上限。运维复核「某个时点会不会推」
      // 时可以显式传 at（ISO 8601）；测试也必须传，否则深夜跑的验收会因为落在
      // 9:00-21:00 之外而被判成 quiet_hours，同一个提交换个时间跑结果就不一样。
      const atRaw = request.body?.at;
      let at = dayjs();
      if (atRaw !== undefined && atRaw !== null && String(atRaw).trim() !== '') {
        at = dayjs(String(atRaw).trim());
        if (!at.isValid()) return response.status(400).json({ error: 'at 需要是可解析的时间（ISO 8601）。' });
      }
      const deliveries = await dispatchSchedule(db, bot, { ...schedule, triggerType: 'manual' }, { at, studentIds });
      recordAudit(db, {
        botId: id,
        actorId: request.currentUser?.id,
        action: 'manual_push',
        after: {
          scheduleId: schedule.id,
          at: at.toISOString(),
          requested: deliveries.length,
          sent: deliveries.filter((item) => item.sent).length,
        },
        summary: `手动执行主动推送：${schedule.name}`
      });
      response.json({ success: true, deliveries });
    } catch (error) {
      console.error('手动执行机器人任务失败:', error);
      response.status(400).json({ error: error.message || '手动执行机器人任务失败。' });
    }
  });

  app.get('/api/admin/robot-platform/overview', requireAdmin, (request, response) => {
    const botRows = db.prepare('SELECT * FROM bots ORDER BY robot_uid ASC, id ASC').all();
    const bots = botRows.map(serializeBot);
    const tickets = db.prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN priority = 'P0' THEN 1 ELSE 0 END) AS urgent FROM bot_handoff_tickets WHERE status != 'resolved'").get();
    const violations = db.prepare("SELECT COUNT(*) AS count FROM bot_violation_events WHERE created_at >= ?").get(dayjs().subtract(24, 'hour').toISOString()).count;
    const releases = db.prepare("SELECT COUNT(*) AS count FROM bot_release_batches WHERE status = 'observing'").get().count;
    response.json({
      summary: {
        totalBots: bots.length,
        onlineBots: bots.filter((item) => item.status === 'online').length,
        completeBots: bots.filter((item) => item.checklist.valid).length,
        openTickets: Number(tickets.total || 0),
        urgentTickets: Number(tickets.urgent || 0),
        violations24h: Number(violations || 0),
        observingReleases: Number(releases || 0)
      },
      bots
    });
  });

  app.get('/api/admin/robot-platform/tickets', requireAdmin, (request, response) => {
    const status = String(request.query.status || '').trim();
    const rows = status
      ? db.prepare(`SELECT t.*, b.robot_uid, b.name AS bot_name FROM bot_handoff_tickets t LEFT JOIN bots b ON b.id = t.bot_id WHERE t.status = ? ORDER BY CASE t.priority WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 ELSE 2 END, t.created_at ASC`).all(status)
      : db.prepare(`SELECT t.*, b.robot_uid, b.name AS bot_name FROM bot_handoff_tickets t LEFT JOIN bots b ON b.id = t.bot_id ORDER BY CASE t.status WHEN 'open' THEN 0 WHEN 'assigned' THEN 1 ELSE 2 END, CASE t.priority WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 ELSE 2 END, t.created_at DESC LIMIT 200`).all();
    response.json({ tickets: rows.map((row) => ({
      id: row.id,
      robotUid: row.robot_uid,
      botName: row.bot_name,
      channel: row.channel,
      externalUserId: row.external_user_id,
      studentId: row.student_id,
      reason: row.reason,
      messageExcerpt: row.message_excerpt,
      priority: row.priority,
      status: row.status,
      assignedTo: row.assigned_to,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    })) });
  });

  app.patch('/api/admin/robot-platform/tickets/:id', requireAdmin, (request, response) => {
    const id = Number(request.params.id);
    const status = String(request.body?.status || '').trim();
    if (!['open', 'assigned', 'resolved'].includes(status)) return response.status(400).json({ error: '工单状态无效。' });
    const result = db.prepare(`
      UPDATE bot_handoff_tickets SET status = ?, assigned_to = ?, updated_at = ? WHERE id = ?
    `).run(status, request.body?.assignedTo || request.currentUser?.id || null, dayjs().toISOString(), id);
    if (!result.changes) return response.status(404).json({ error: '工单不存在。' });
    response.json({ success: true });
  });

  // 删除机器人（群分配通过外键级联移除）
  app.delete('/api/admin/bots/:id', requireAdmin, (request, response) => {
    try {
      const id = Number(request.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        return response.status(400).json({ error: '机器人 ID 无效。' });
      }
      const existing = db.prepare('SELECT id FROM bots WHERE id = ?').get(id);
      if (!existing) return response.status(404).json({ error: '机器人不存在。' });
      db.prepare('DELETE FROM bots WHERE id = ?').run(id);
      response.json({ success: true });
    } catch (error) {
      console.error('删除机器人失败:', error);
      response.status(500).json({ error: '删除机器人失败。' });
    }
  });

  // 分配机器人到群组
  app.post('/api/admin/bots/:id/groups', requireAdmin, (request, response) => {
    try {
      const botId = Number(request.params.id);
      const { groupId, isDefault } = request.body;
      if (!groupId) {
        return response.status(400).json({ error: 'groupId 不能为空。' });
      }
      const bot = db.prepare('SELECT id FROM bots WHERE id = ?').get(botId);
      if (!bot) {
        return response.status(404).json({ error: '机器人不存在。' });
      }
      const group = db.prepare('SELECT id FROM wecom_groups WHERE id = ?').get(Number(groupId));
      if (!group) {
        return response.status(404).json({ error: '群聊不存在。' });
      }
      const now = dayjs().toISOString();
      db.transaction(() => {
        if (isDefault) {
          db.prepare('UPDATE bot_group_assignments SET is_default = 0 WHERE group_id = ?')
            .run(Number(groupId));
        }
        db.prepare(`
          INSERT INTO bot_group_assignments (bot_id, group_id, is_default, created_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(bot_id, group_id) DO UPDATE SET is_default = excluded.is_default
        `).run(botId, Number(groupId), isDefault ? 1 : 0, now);
      })();
      response.json({ success: true });
    } catch (error) {
      console.error('分配机器人到群组失败:', error);
      response.status(500).json({ error: '分配机器人到群组失败。' });
    }
  });

  // 从群组移除机器人
  app.delete('/api/admin/bots/:id/groups/:groupId', requireAdmin, (request, response) => {
    try {
      const botId = Number(request.params.id);
      const groupId = Number(request.params.groupId);
      db.prepare(
        'DELETE FROM bot_group_assignments WHERE bot_id = ? AND group_id = ?'
      ).run(botId, groupId);
      response.json({ success: true });
    } catch (error) {
      console.error('移除机器人分配失败:', error);
      response.status(500).json({ error: '移除机器人分配失败。' });
    }
  });

  // 列出机器人的群组分配
  app.get('/api/admin/bots/:id/groups', requireAdmin, (request, response) => {
    try {
      const botId = Number(request.params.id);
      const rows = db.prepare(`
        SELECT a.group_id, a.is_default, a.created_at, g.name AS group_name
        FROM bot_group_assignments a
        JOIN wecom_groups g ON g.id = a.group_id
        WHERE a.bot_id = ?
      `).all(botId);
      response.json({
        assignments: rows.map((row) => ({
          groupId: row.group_id,
          groupName: row.group_name,
          isDefault: Boolean(row.is_default),
          createdAt: row.created_at
        }))
      });
    } catch (error) {
      console.error('列出机器人分配失败:', error);
      response.status(500).json({ error: '列出机器人分配失败。' });
    }
  });

  // 对话记录查询
  app.get('/api/admin/conversations', requireAdmin, (request, response) => {
    try {
      const { userId, type, startDate, endDate, limit = 50, offset = 0 } = request.query;
      let sql = 'SELECT * FROM ai_conversations WHERE 1=1';
      const params = [];
      if (userId) {
        sql += ' AND user_id = ?';
        params.push(Number(userId));
      }
      if (type) {
        sql += ' AND type = ?';
        params.push(type);
      }
      if (startDate) {
        sql += ' AND created_at >= ?';
        params.push(startDate);
      }
      if (endDate) {
        sql += ' AND created_at <= ?';
        params.push(endDate);
      }
      const total = db.prepare(`SELECT COUNT(*) AS count FROM (${sql})`).get(...params).count;
      sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
      params.push(Number(limit), Number(offset));
      const rows = db.prepare(sql).all(...params);
      response.json({
        total,
        conversations: rows.map((row) => ({
          id: row.id,
          userId: row.user_id,
          type: row.type,
          context: row.context,
          prompt: row.prompt,
          response: row.response,
          createdAt: row.created_at
        }))
      });
    } catch (error) {
      console.error('查询对话记录失败:', error);
      response.status(500).json({ error: '查询对话记录失败。' });
    }
  });

  // ── 人工接管管理路由 ──

  // 客服人工接管指定用户
  app.post('/api/admin/conversations/:userId/handoff', requireAdmin, (request, response) => {
    try {
      const userId = Number(request.params.userId);
      const { reason = '客服主动接管' } = request.body;
      const result = startHandoff(db, userId, 'admin', null, reason);
      response.json(result);
    } catch (error) {
      console.error('人工接管失败:', error);
      response.status(500).json({ error: '人工接管失败。' });
    }
  });

  // 客服释放会话
  app.post('/api/admin/conversations/:userId/release', requireAdmin, (request, response) => {
    try {
      const userId = Number(request.params.userId);
      const result = endHandoff(db, userId);
      response.json(result);
    } catch (error) {
      console.error('释放会话失败:', error);
      response.status(500).json({ error: '释放会话失败。' });
    }
  });

  // 查询用户接管状态
  app.get('/api/admin/conversations/:userId/handoff', requireAdmin, (request, response) => {
    try {
      const userId = Number(request.params.userId);
      const active = getActiveHandoff(db, userId);
      response.json({
        userId,
        inHandoff: !!active,
        session: active || null
      });
    } catch (error) {
      console.error('查询接管状态失败:', error);
      response.status(500).json({ error: '查询接管状态失败。' });
    }
  });

  // 列出所有活跃人工接管会话
  app.get('/api/admin/handoffs/active', requireAdmin, (request, response) => {
    try {
      const { source, limit = 50, offset = 0 } = request.query;
      const sessions = listActiveHandoffs(db, { source, limit: Number(limit), offset: Number(offset) });
      response.json({ sessions });
    } catch (error) {
      console.error('列出活跃人工接管失败:', error);
      response.status(500).json({ error: '列出活跃人工接管失败。' });
    }
  });

  // 获取用户人工客服历史
  app.get('/api/admin/conversations/:userId/handoff-history', requireAdmin, (request, response) => {
    try {
      const userId = Number(request.params.userId);
      const { limit = 20 } = request.query;
      const history = getHandoffHistory(db, userId, Number(limit));
      response.json({ userId, history });
    } catch (error) {
      console.error('获取人工客服历史失败:', error);
      response.status(500).json({ error: '获取人工客服历史失败。' });
    }
  });

  // ── 非管理员人工接管路由（供后续客服系统/外部调用使用）──

  // 人工接管指定用户（无需管理员权限，供客服系统调用）
  app.post('/api/bots/handoff/:userId', (request, response) => {
    try {
      const userId = Number(request.params.userId);
      const { reason = '人工接管' } = request.body;
      const result = startHandoff(db, userId, 'api', null, reason);
      response.json(result);
    } catch (error) {
      console.error('人工接管失败:', error);
      response.status(500).json({ error: '人工接管失败。' });
    }
  });

  // 释放用户会话（无需管理员权限，供客服系统调用）
  app.post('/api/bots/handoff/:userId/release', (request, response) => {
    try {
      const userId = Number(request.params.userId);
      const result = endHandoff(db, userId);
      response.json(result);
    } catch (error) {
      console.error('释放会话失败:', error);
      response.status(500).json({ error: '释放会话失败。' });
    }
  });
};

function safeJsonParse(str, fallback) {
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

function nextRobotUid(db) {
  const rows = db.prepare("SELECT robot_uid FROM bots WHERE robot_uid LIKE 'R-%'").all();
  const used = new Set(rows.map((row) => String(row.robot_uid || '').toUpperCase()));
  let sequence = 1;
  while (used.has(`R-${String(sequence).padStart(2, '0')}`)) sequence += 1;
  return `R-${String(sequence).padStart(2, '0')}`;
}

function serializeBot(row) {
  const config = createDefaultBotConfig(safeJsonParse(row.config, {}));
  const checklist = validateBotConfig(config);
  return {
    id: row.id,
    robotUid: row.robot_uid || '',
    code: row.code,
    name: row.name,
    type: row.type,
    config,
    status: row.status || (row.is_active ? 'online' : 'draft'),
    isActive: Boolean(row.is_active),
    createdAt: row.created_at,
    updatedAt: row.updated_at || row.created_at,
    checklist: { valid: checklist.valid, checks: checklist.checks }
  };
}
