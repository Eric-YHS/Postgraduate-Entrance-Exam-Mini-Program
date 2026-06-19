const dayjs = require('dayjs');
const { db } = require('../db');

// 预置默认机器人
const DEFAULT_BOTS = [
  {
    code: 'free_tutor',
    name: '免费答疑',
    type: 'tutor',
    config: {
      description: '为所有学生提供免费的考研答疑服务',
      welcomeMessage: '你好！我是免费答疑机器人，有任何考研问题都可以问我。',
      maxDailyQuestions: 10,
      subjects: ['数学', '英语', '政治', '专业课']
    },
    isActive: 1
  },
  {
    code: 'supervisor',
    name: '督学助手',
    type: 'supervisor',
    config: {
      description: '监督学习进度，提醒打卡和任务完成',
      welcomeMessage: '我是你的督学助手，会帮你监督学习进度，记得每天打卡哦！',
      checkInTime: '20:00',
      reminderInterval: 24
    },
    isActive: 1
  },
  {
    code: 'answer',
    name: '解答专家',
    type: 'tutor',
    config: {
      description: '针对具体题目提供详细解答和思路分析',
      welcomeMessage: '我是解答专家，把不会的题目发给我，我会给你详细的解题思路。',
      subjects: ['数学', '英语', '政治'],
      detailLevel: 'detailed'
    },
    isActive: 1
  },
  {
    code: 'school_selector',
    name: '择校顾问',
    type: 'advisor',
    config: {
      description: '根据学生情况推荐合适的院校和专业',
      welcomeMessage: '我是择校顾问，告诉我你的目标、成绩和偏好，我帮你推荐合适的院校。',
      factors: ['成绩水平', '地域偏好', '专业方向', '院校层次']
    },
    isActive: 1
  },
  {
    code: 'exam_generator',
    name: '自测生成器',
    type: 'generator',
    config: {
      description: '根据知识点生成自测题目',
      welcomeMessage: '我是自测生成器，告诉我你想练习的知识点，我为你生成题目。',
      questionCount: 10,
      difficulty: 'adaptive'
    },
    isActive: 1
  },
  {
    code: 'planner',
    name: '规划师',
    type: 'planner',
    config: {
      description: '制定个性化考研复习计划',
      welcomeMessage: '我是你的考研规划师，告诉我你的备考时间和目标，我帮你制定复习计划。',
      planTypes: ['全程规划', '月度规划', '周规划', '日规划']
    },
    isActive: 1
  }
];

/**
 * 初始化默认机器人（幂等，已存在则跳过）
 */
function seedDefaultBots() {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO bots (code, name, type, config, is_active, created_at)
    VALUES (@code, @name, @type, @config, @isActive, @createdAt)
  `);

  const now = dayjs().toISOString();
  for (const bot of DEFAULT_BOTS) {
    insert.run({
      code: bot.code,
      name: bot.name,
      type: bot.type,
      config: JSON.stringify(bot.config),
      isActive: bot.isActive,
      createdAt: now
    });
  }
}

/**
 * 列出机器人
 * @param {Object} filters - 筛选条件
 * @param {string} [filters.type] - 按类型筛选
 * @param {boolean} [filters.isActive] - 按状态筛选
 * @param {string} [filters.search] - 按名称或 code 模糊搜索
 * @returns {Array<Object>}
 */
function listBots(filters = {}) {
  const conditions = [];
  const params = [];

  if (filters.type) {
    conditions.push('type = ?');
    params.push(filters.type);
  }

  if (typeof filters.isActive === 'boolean') {
    conditions.push('is_active = ?');
    params.push(filters.isActive ? 1 : 0);
  }

  if (filters.search) {
    conditions.push('(name LIKE ? OR code LIKE ?)');
    const pattern = `%${filters.search}%`;
    params.push(pattern, pattern);
  }

  const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const stmt = db.prepare(`
    SELECT id, code, name, type, config, is_active, created_at
    FROM bots
    ${whereClause}
    ORDER BY created_at ASC
  `);

  const rows = stmt.all(...params);
  return rows.map((row) => ({
    ...row,
    config: safeJsonParse(row.config, {})
  }));
}

/**
 * 根据 code 获取机器人
 * @param {string} code
 * @returns {Object|null}
 */
function getBotByCode(code) {
  const stmt = db.prepare(`
    SELECT id, code, name, type, config, is_active, created_at
    FROM bots
    WHERE code = ?
  `);
  const row = stmt.get(code);
  if (!row) return null;
  return {
    ...row,
    config: safeJsonParse(row.config, {})
  };
}

/**
 * 创建机器人
 * @param {Object} data
 * @param {string} data.code - 唯一标识
 * @param {string} data.name - 名称
 * @param {string} data.type - 类型
 * @param {string|Object} data.configJson - 配置 JSON
 * @param {boolean} [data.isActive=true]
 * @returns {Object} { id, code }
 */
function createBot({ code, name, type, configJson, isActive = true }) {
  if (!code || !name || !type) {
    throw new Error('code, name, type 为必填项');
  }

  const existing = db.prepare('SELECT id FROM bots WHERE code = ?').get(code);
  if (existing) {
    throw new Error(`机器人 code "${code}" 已存在`);
  }

  const config = typeof configJson === 'string' ? configJson : JSON.stringify(configJson || {});
  const now = dayjs().toISOString();

  const insert = db.prepare(`
    INSERT INTO bots (code, name, type, config, is_active, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const result = insert.run(code, name, type, config, isActive ? 1 : 0, now);
  return { id: result.lastInsertRowid, code };
}

/**
 * 更新机器人
 * @param {number} id
 * @param {Object} data
 * @param {string} [data.name]
 * @param {string} [data.type]
 * @param {string|Object} [data.configJson]
 * @param {boolean} [data.isActive]
 * @returns {boolean} 是否成功
 */
function updateBot(id, { name, type, configJson, isActive }) {
  const fields = [];
  const values = [];

  if (name !== undefined) {
    fields.push('name = ?');
    values.push(name);
  }
  if (type !== undefined) {
    fields.push('type = ?');
    values.push(type);
  }
  if (configJson !== undefined) {
    const config = typeof configJson === 'string' ? configJson : JSON.stringify(configJson);
    fields.push('config = ?');
    values.push(config);
  }
  if (isActive !== undefined) {
    fields.push('is_active = ?');
    values.push(isActive ? 1 : 0);
  }

  if (fields.length === 0) {
    return false;
  }

  values.push(id);
  const stmt = db.prepare(`UPDATE bots SET ${fields.join(', ')} WHERE id = ?`);
  const result = stmt.run(...values);
  return result.changes > 0;
}

/**
 * 将机器人分配给群组
 * @param {number} botId
 * @param {number} groupId
 * @returns {boolean} 是否成功
 */
function assignBotToGroup(botId, groupId) {
  const botExists = db.prepare('SELECT id FROM bots WHERE id = ?').get(botId);
  if (!botExists) {
    throw new Error(`机器人 id=${botId} 不存在`);
  }

  const insert = db.prepare(`
    INSERT OR IGNORE INTO bot_group_assignments (bot_id, group_id, created_at)
    VALUES (?, ?, ?)
  `);

  const result = insert.run(botId, groupId, dayjs().toISOString());
  return result.changes > 0;
}

/**
 * 从群组移除机器人
 * @param {number} botId
 * @param {number} groupId
 * @returns {boolean} 是否成功
 */
function removeBotFromGroup(botId, groupId) {
  const stmt = db.prepare(`
    DELETE FROM bot_group_assignments WHERE bot_id = ? AND group_id = ?
  `);
  const result = stmt.run(botId, groupId);
  return result.changes > 0;
}

/**
 * 列出机器人的群组分配
 * @param {number} botId
 * @returns {Array<Object>}
 */
function listBotAssignments(botId) {
  const stmt = db.prepare(`
    SELECT a.id, a.bot_id, a.group_id, a.created_at,
           b.name AS bot_name, b.code AS bot_code
    FROM bot_group_assignments a
    JOIN bots b ON a.bot_id = b.id
    WHERE a.bot_id = ?
    ORDER BY a.created_at DESC
  `);
  return stmt.all(botId);
}

/**
 * 记录 AI 对话
 * @param {Object} data
 * @param {number} data.userId
 * @param {string} data.botCode
 * @param {string} data.type
 * @param {string} data.prompt
 * @param {string} data.response
 * @param {string} [data.context='']
 * @returns {Object} { id }
 */
function logConversation({ userId, botCode, type, prompt, response, context = '' }) {
  if (!userId || !botCode || !prompt || !response) {
    throw new Error('userId, botCode, prompt, response 为必填项');
  }

  const now = dayjs().toISOString();
  const insert = db.prepare(`
    INSERT INTO ai_conversations (user_id, type, context, prompt, response, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const result = insert.run(userId, type || 'tutor', context, prompt, response, now);
  return { id: result.lastInsertRowid };
}

/**
 * 获取对话记录
 * @param {Object} filters
 * @param {number} [filters.userId]
 * @param {string} [filters.botCode]
 * @param {string} [filters.type]
 * @param {string} [filters.startDate] - ISO 日期字符串
 * @param {string} [filters.endDate]
 * @param {number} [filters.limit=50]
 * @param {number} [filters.offset=0]
 * @returns {Array<Object>}
 */
function getConversations(filters = {}) {
  const conditions = [];
  const params = [];

  if (filters.userId) {
    conditions.push('c.user_id = ?');
    params.push(filters.userId);
  }

  if (filters.type) {
    conditions.push('c.type = ?');
    params.push(filters.type);
  }

  if (filters.startDate) {
    conditions.push('c.created_at >= ?');
    params.push(filters.startDate);
  }

  if (filters.endDate) {
    conditions.push('c.created_at <= ?');
    params.push(filters.endDate);
  }

  const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = Math.min(Math.max(filters.limit || 50, 1), 500);
  const offset = Math.max(filters.offset || 0, 0);

  const stmt = db.prepare(`
    SELECT c.id, c.user_id, c.type, c.context, c.prompt, c.response, c.created_at
    FROM ai_conversations c
    ${whereClause}
    ORDER BY c.created_at DESC
    LIMIT ? OFFSET ?
  `);

  return stmt.all(...params, limit, offset);
}

function safeJsonParse(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch (_) {
    return fallback;
  }
}

module.exports = {
  seedDefaultBots,
  listBots,
  getBotByCode,
  createBot,
  updateBot,
  assignBotToGroup,
  removeBotFromGroup,
  listBotAssignments,
  logConversation,
  getConversations
};
