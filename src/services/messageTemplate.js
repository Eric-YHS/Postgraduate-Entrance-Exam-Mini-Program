const dayjs = require('dayjs');

// 默认模板配置
const DEFAULT_TEMPLATES = [
  {
    code: 'morning_plan',
    name: '早安计划',
    content: '早安，{name}！\n今天是 {date}，你的今日计划是：\n{tasks}\n祝你学习愉快！',
    channels: JSON.stringify(['wx_subscribe', 'push']),
    isActive: 1
  },
  {
    code: 'due_reminder',
    name: '到点提醒',
    content: '提醒：{name}，你的任务 "{task}" 将在 {time} 截止，请尽快完成！',
    channels: JSON.stringify(['wx_subscribe', 'push', 'sms']),
    isActive: 1
  },
  {
    code: 'evening_check',
    name: '晚间检查',
    content: '晚上好，{name}！\n今日学习总结：\n- 已完成：{completed}\n- 待完成：{pending}\n记得早点休息，明天继续加油！',
    channels: JSON.stringify(['wx_subscribe', 'push']),
    isActive: 1
  },
  {
    code: 'paid_group_welcome',
    name: '付费服务群欢迎语',
    content: '欢迎 {studentName} 加入「{groupName}」！\n你已开通 {productName}，专属督学老师、答疑老师、择校顾问已就位。\n有任何学习问题随时在群里 @ 我们，祝你考研顺利上岸！',
    channels: JSON.stringify(['wecom']),
    isActive: 1
  }
];

/**
 * 确保默认模板存在，如不存在则自动创建
 * @param {Database} db - better-sqlite3 数据库实例
 */
function ensureDefaultTemplates(db) {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO message_templates (code, name, content, channels, is_active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const now = dayjs().toISOString();
  for (const tpl of DEFAULT_TEMPLATES) {
    insert.run(tpl.code, tpl.name, tpl.content, tpl.channels, tpl.isActive, now, now);
  }
}

/**
 * 列表查询模板
 * @param {Database} db
 * @param {object} filters - 可选过滤条件 { code, name, isActive, channels }
 * @param {object} pagination - { limit, offset }
 */
function listTemplates(db, filters = {}, pagination = {}) {
  let where = '1=1';
  const params = [];

  if (filters.code) {
    where += ' AND code = ?';
    params.push(filters.code);
  }
  if (filters.name) {
    where += ' AND name LIKE ?';
    params.push(`%${filters.name}%`);
  }
  if (filters.isActive !== undefined) {
    where += ' AND is_active = ?';
    params.push(filters.isActive ? 1 : 0);
  }
  if (filters.channels) {
    where += ' AND channels LIKE ?';
    params.push(`%${filters.channels}%`);
  }

  const countRow = db.prepare(`SELECT COUNT(*) AS total FROM message_templates WHERE ${where}`).get(...params);

  const limit = Math.min(Number(pagination.limit) || 100, 500);
  const offset = Number(pagination.offset) || 0;

  const rows = db.prepare(`
    SELECT id, code, name, content, channels, is_active, updated_by, created_at, updated_at
    FROM message_templates
    WHERE ${where}
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  return {
    total: countRow.total,
    templates: rows.map(serializeTemplate)
  };
}

/**
 * 根据 code 获取模板
 * @param {Database} db
 * @param {string} code
 */
function getTemplateByCode(db, code) {
  const row = db.prepare(`
    SELECT id, code, name, content, channels, is_active, updated_by, created_at, updated_at
    FROM message_templates
    WHERE code = ?
  `).get(code);
  return row ? serializeTemplate(row) : null;
}

/**
 * 创建模板
 * @param {Database} db
 * @param {object} param
 * @param {string} param.code - 唯一标识
 * @param {string} param.name - 模板名称
 * @param {string} param.content - 模板内容（支持 {placeholder}）
 * @param {string[]} param.channels - 发送渠道数组，如 ['wx_subscribe', 'push', 'sms']
 * @param {boolean} param.isActive - 是否启用
 * @param {number} param.updatedBy - 操作人用户ID
 */
function createTemplate(db, { code, name, content, channels, isActive, updatedBy }) {
  if (!code || !name || !content) {
    throw new Error('code、name、content 为必填项');
  }
  const codeRegex = /^[a-zA-Z0-9_]+$/;
  if (!codeRegex.test(code)) {
    throw new Error('code 只能包含字母、数字和下划线');
  }

  const existing = db.prepare('SELECT id FROM message_templates WHERE code = ?').get(code);
  if (existing) {
    throw new Error(`模板 code "${code}" 已存在`);
  }

  const now = dayjs().toISOString();
  const channelsJson = Array.isArray(channels) ? JSON.stringify(channels) : JSON.stringify([]);

  const result = db.prepare(`
    INSERT INTO message_templates (code, name, content, channels, is_active, updated_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(code, name, content, channelsJson, isActive ? 1 : 0, updatedBy || null, now, now);

  return {
    id: result.lastInsertRowid,
    code,
    name,
    content,
    channels: safeParseChannels(channelsJson),
    isActive: isActive ? 1 : 0,
    updatedBy: updatedBy || null,
    createdAt: now,
    updatedAt: now
  };
}

/**
 * 更新模板（code 不可修改）
 * @param {Database} db
 * @param {number} id
 * @param {object} param
 * @param {string} param.name
 * @param {string} param.content
 * @param {string[]} param.channels
 * @param {boolean} param.isActive
 * @param {number} param.updatedBy
 */
function updateTemplate(db, id, { name, content, channels, isActive, updatedBy }) {
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error('无效的模板 ID');
  }

  const existing = db.prepare('SELECT id FROM message_templates WHERE id = ?').get(id);
  if (!existing) {
    throw new Error('模板不存在');
  }

  const updates = [];
  const params = [];

  if (name !== undefined) {
    updates.push('name = ?');
    params.push(name);
  }
  if (content !== undefined) {
    updates.push('content = ?');
    params.push(content);
  }
  if (channels !== undefined) {
    updates.push('channels = ?');
    params.push(Array.isArray(channels) ? JSON.stringify(channels) : JSON.stringify([]));
  }
  if (isActive !== undefined) {
    updates.push('is_active = ?');
    params.push(isActive ? 1 : 0);
  }
  if (updatedBy !== undefined) {
    updates.push('updated_by = ?');
    params.push(updatedBy);
  }

  if (!updates.length) {
    throw new Error('没有需要更新的字段');
  }

  const now = dayjs().toISOString();
  updates.push('updated_at = ?');
  params.push(now);
  params.push(id);

  db.prepare(`UPDATE message_templates SET ${updates.join(', ')} WHERE id = ?`).run(...params);

  return getTemplateById(db, id);
}

/**
 * 渲染模板：将 {name}, {time}, {subject} 等占位符替换为变量值
 * @param {Database} db
 * @param {string} code - 模板 code
 * @param {object} variables - 变量映射，如 { name: '张三', time: '08:00' }
 * @returns {string|null} 渲染后的文本，模板不存在返回 null
 */
function renderTemplate(db, code, variables = {}) {
  const row = db.prepare('SELECT content, is_active FROM message_templates WHERE code = ?').get(code);
  if (!row) return null;
  if (!row.is_active) return null;

  let result = row.content;
  // 支持 {key} 和 {{key}} 两种占位符风格
  for (const [key, value] of Object.entries(variables)) {
    const safeValue = value === null || value === undefined ? '' : String(value);
    result = result.replace(new RegExp(`\\{\\{${escapeRegExp(key)}\\}\\}|\\{${escapeRegExp(key)}\\}`, 'g'), safeValue);
  }
  return result;
}

// ── 内部辅助函数 ──

function getTemplateById(db, id) {
  const row = db.prepare(`
    SELECT id, code, name, content, channels, is_active, updated_by, created_at, updated_at
    FROM message_templates WHERE id = ?
  `).get(id);
  return row ? serializeTemplate(row) : null;
}

function serializeTemplate(row) {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    content: row.content,
    channels: safeParseChannels(row.channels),
    isActive: Boolean(row.is_active),
    updatedBy: row.updated_by || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function safeParseChannels(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = {
  ensureDefaultTemplates,
  listTemplates,
  getTemplateByCode,
  createTemplate,
  updateTemplate,
  renderTemplate
};
