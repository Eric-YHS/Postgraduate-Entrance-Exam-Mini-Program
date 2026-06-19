const dayjs = require('dayjs');
const { startHandoff, endHandoff, isInHandoff, getActiveHandoff, listActiveHandoffs, getHandoffHistory } = require('../services/bots/humanHandoff');

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
        bots: rows.map((row) => ({
          id: row.id,
          code: row.code,
          name: row.name,
          type: row.type,
          config: safeJsonParse(row.config, {}),
          isActive: Boolean(row.is_active),
          createdAt: row.created_at
        }))
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
      response.json({
        id: row.id,
        code: row.code,
        name: row.name,
        type: row.type,
        config: safeJsonParse(row.config, {}),
        isActive: Boolean(row.is_active),
        createdAt: row.created_at
      });
    } catch (error) {
      console.error('获取机器人失败:', error);
      response.status(500).json({ error: '获取机器人失败。' });
    }
  });

  // 创建机器人
  app.post('/api/admin/bots', requireAdmin, (request, response) => {
    try {
      const { code, name, type, config, isActive } = request.body;
      if (!code || !code.trim()) {
        return response.status(400).json({ error: '机器人 code 不能为空。' });
      }
      if (!name || !name.trim()) {
        return response.status(400).json({ error: '机器人名称不能为空。' });
      }
      if (!type || !type.trim()) {
        return response.status(400).json({ error: '机器人类型不能为空。' });
      }
      const now = dayjs().toISOString();
      const result = db.prepare(
        'INSERT INTO bots (code, name, type, config, is_active, created_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(
        code.trim(),
        name.trim(),
        type.trim(),
        JSON.stringify(config || {}),
        isActive !== undefined ? Number(isActive) : 1,
        now
      );
      response.json({ id: result.lastInsertRowid, code, name, type, config, isActive });
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
      const existing = db.prepare('SELECT id FROM bots WHERE id = ?').get(id);
      if (!existing) {
        return response.status(404).json({ error: '机器人不存在。' });
      }
      db.prepare(
        'UPDATE bots SET name = ?, type = ?, config = ?, is_active = ? WHERE id = ?'
      ).run(
        name || '',
        type || '',
        JSON.stringify(config || {}),
        isActive !== undefined ? Number(isActive) : 1,
        id
      );
      response.json({ success: true });
    } catch (error) {
      console.error('更新机器人失败:', error);
      response.status(500).json({ error: '更新机器人失败。' });
    }
  });

  // 分配机器人到群组
  app.post('/api/admin/bots/:id/groups', requireAdmin, (request, response) => {
    try {
      const botId = Number(request.params.id);
      const { groupId } = request.body;
      if (!groupId) {
        return response.status(400).json({ error: 'groupId 不能为空。' });
      }
      const bot = db.prepare('SELECT id FROM bots WHERE id = ?').get(botId);
      if (!bot) {
        return response.status(404).json({ error: '机器人不存在。' });
      }
      const now = dayjs().toISOString();
      db.prepare(
        'INSERT OR IGNORE INTO bot_group_assignments (bot_id, group_id, created_at) VALUES (?, ?, ?)'
      ).run(botId, Number(groupId), now);
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
      const rows = db.prepare(
        'SELECT group_id, created_at FROM bot_group_assignments WHERE bot_id = ?'
      ).all(botId);
      response.json({
        assignments: rows.map((row) => ({
          groupId: row.group_id,
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
};

function safeJsonParse(str, fallback) {
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}
