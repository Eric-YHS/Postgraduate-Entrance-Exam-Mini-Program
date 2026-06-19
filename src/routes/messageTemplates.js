const dayjs = require('dayjs');

module.exports = function registerMessageTemplateRoutes(app, shared) {
  const { db, requireAdmin } = shared;

  // 列出所有消息模板
  app.get('/api/admin/message-templates', requireAdmin, (request, response) => {
    try {
      const { code, name, isActive, limit = 50, offset = 0 } = request.query;
      let sql = 'SELECT * FROM message_templates WHERE 1=1';
      const params = [];
      if (code) {
        sql += ' AND code LIKE ?';
        params.push(`%${code}%`);
      }
      if (name) {
        sql += ' AND name LIKE ?';
        params.push(`%${name}%`);
      }
      if (isActive !== undefined && isActive !== '') {
        sql += ' AND is_active = ?';
        params.push(Number(isActive));
      }
      const total = db.prepare(`SELECT COUNT(*) AS count FROM (${sql})`).get(...params).count;
      sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
      params.push(Number(limit), Number(offset));
      const rows = db.prepare(sql).all(...params);
      response.json({
        total,
        templates: rows.map((row) => ({
          id: row.id,
          code: row.code,
          name: row.name,
          content: row.content,
          channels: safeJsonParse(row.channels, []),
          isActive: Boolean(row.is_active),
          updatedBy: row.updated_by,
          createdAt: row.created_at,
          updatedAt: row.updated_at
        }))
      });
    } catch (error) {
      console.error('列出消息模板失败:', error);
      response.status(500).json({ error: '列出消息模板失败。' });
    }
  });

  // 根据 code 获取单个模板
  app.get('/api/admin/message-templates/:code', requireAdmin, (request, response) => {
    try {
      const row = db.prepare('SELECT * FROM message_templates WHERE code = ?').get(request.params.code);
      if (!row) {
        return response.status(404).json({ error: '模板不存在。' });
      }
      response.json({
        id: row.id,
        code: row.code,
        name: row.name,
        content: row.content,
        channels: safeJsonParse(row.channels, []),
        isActive: Boolean(row.is_active),
        updatedBy: row.updated_by,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      });
    } catch (error) {
      console.error('获取模板失败:', error);
      response.status(500).json({ error: '获取模板失败。' });
    }
  });

  // 创建模板
  app.post('/api/admin/message-templates', requireAdmin, (request, response) => {
    try {
      const { code, name, content, channels, isActive } = request.body;
      if (!code || !code.trim()) {
        return response.status(400).json({ error: '模板 code 不能为空。' });
      }
      if (!/^[a-zA-Z0-9_]+$/.test(code)) {
        return response.status(400).json({ error: '模板 code 只能包含字母、数字和下划线。' });
      }
      if (!name || !name.trim()) {
        return response.status(400).json({ error: '模板名称不能为空。' });
      }
      if (!content || !content.trim()) {
        return response.status(400).json({ error: '模板内容不能为空。' });
      }
      const now = dayjs().toISOString();
      const result = db.prepare(
        'INSERT INTO message_templates (code, name, content, channels, is_active, updated_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(
        code.trim(),
        name.trim(),
        content.trim(),
        JSON.stringify(channels || []),
        isActive !== undefined ? Number(isActive) : 1,
        request.currentUser.id,
        now,
        now
      );
      response.json({ id: result.lastInsertRowid, code, name, content, channels, isActive });
    } catch (error) {
      if (error.message && error.message.includes('UNIQUE constraint failed')) {
        return response.status(409).json({ error: '模板 code 已存在。' });
      }
      console.error('创建模板失败:', error);
      response.status(500).json({ error: '创建模板失败。' });
    }
  });

  // 更新模板
  app.put('/api/admin/message-templates/:id', requireAdmin, (request, response) => {
    try {
      const id = Number(request.params.id);
      const { name, content, channels, isActive } = request.body;
      const existing = db.prepare('SELECT id FROM message_templates WHERE id = ?').get(id);
      if (!existing) {
        return response.status(404).json({ error: '模板不存在。' });
      }
      const now = dayjs().toISOString();
      db.prepare(
        'UPDATE message_templates SET name = ?, content = ?, channels = ?, is_active = ?, updated_by = ?, updated_at = ? WHERE id = ?'
      ).run(
        name || '',
        content || '',
        JSON.stringify(channels || []),
        isActive !== undefined ? Number(isActive) : 1,
        request.currentUser.id,
        now,
        id
      );
      response.json({ success: true });
    } catch (error) {
      console.error('更新模板失败:', error);
      response.status(500).json({ error: '更新模板失败。' });
    }
  });

  // 预览渲染模板
  app.post('/api/admin/message-templates/:code/render', requireAdmin, (request, response) => {
    try {
      const { variables = {} } = request.body;
      const row = db.prepare('SELECT content, is_active FROM message_templates WHERE code = ?').get(request.params.code);
      if (!row) {
        return response.status(404).json({ error: '模板不存在。' });
      }
      if (!row.is_active) {
        return response.status(400).json({ error: '模板未启用。' });
      }
      let rendered = row.content;
      // 支持 {key} 和 {{key}} 两种占位符风格
      for (const [key, value] of Object.entries(variables)) {
        const regex1 = new RegExp(`\\{\\{${key}\\}\\}`, 'g');
        const regex2 = new RegExp(`\\{${key}\\}`, 'g');
        rendered = rendered.replace(regex1, String(value)).replace(regex2, String(value));
      }
      response.json({ rendered, variables });
    } catch (error) {
      console.error('渲染模板失败:', error);
      response.status(500).json({ error: '渲染模板失败。' });
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
