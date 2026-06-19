const dayjs = require('dayjs');
const { sendAppMessage } = require('../wecom');
const { db: globalDb } = require('../../db');

// 人工客服关键词列表
const HANDOFF_KEYWORDS = [
  '人工',
  '客服',
  '转人工',
  '人工客服',
  '找人工',
  '人工服务',
  '人工咨询',
  '人工帮忙',
  '人工解答',
  '人工回复',
  '人工接管',
  '人工介入',
  '人工处理',
  '人工支持',
  '人工对接',
  '人工老师',
  '真人',
  '真人客服',
  '找老师',
  '找真人',
  '我要人工',
  '需要人工',
  '请转人工',
  '转接人工',
  '人工在吗',
  '人工在线',
  '人工帮忙',
  '人工解答',
  '人工回复',
  '人工接管',
  '人工介入',
  '人工处理',
  '人工支持',
  '人工对接',
  '人工老师',
  '真人',
  '真人客服',
  '找老师',
  '找真人',
  '我要人工',
  '需要人工',
  '请转人工',
  '转接人工',
  '人工在吗',
  '人工在线'
];

/**
 * 判断用户文本是否包含人工客服请求关键词
 * @param {string} text - 用户输入文本
 * @returns {boolean}
 */
function isHandoffRequest(text) {
  if (!text || typeof text !== 'string') return false;
  const normalized = text.trim().toLowerCase();
  return HANDOFF_KEYWORDS.some((kw) => normalized.includes(kw.toLowerCase()));
}

/**
 * 标记用户进入人工接管状态
 * @param {Object} db - better-sqlite3 Database 实例
 * @param {number} userId - 用户 ID
 * @param {string} [source='wecom'] - 来源渠道
 * @param {number|null} [groupId=null] - 企业微信群 ID
 * @param {string} [reason=''] - 转人工原因/用户原始消息
 * @returns {Object} { success: boolean, sessionId?: number, message: string }
 */
function startHandoff(db, userId, source = 'wecom', groupId = null, reason = '') {
  if (!db || !userId) {
    return { success: false, message: '缺少 db 或 userId 参数' };
  }

  // 幂等：如果已存在活跃会话，直接返回
  const existing = db.prepare(
    'SELECT id FROM handoff_status WHERE user_id = ? AND status = ?'
  ).get(userId, 'active');

  if (existing) {
    return {
      success: true,
      sessionId: existing.id,
      message: '用户已处于人工接管状态'
    };
  }

  const now = dayjs().toISOString();
  const insert = db.prepare(`
    INSERT INTO handoff_status (user_id, status, source, group_id, reason, started_at, ended_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const result = insert.run(userId, 'active', source, groupId || null, reason, now, null);

  return {
    success: true,
    sessionId: result.lastInsertRowid,
    message: '已标记用户进入人工接管状态'
  };
}

/**
 * 客服释放会话，恢复机器人自动回复
 * @param {Object} db - better-sqlite3 Database 实例
 * @param {number} userId - 用户 ID
 * @returns {Object} { success: boolean, message: string }
 */
function endHandoff(db, userId) {
  if (!db || !userId) {
    return { success: false, message: '缺少 db 或 userId 参数' };
  }

  const now = dayjs().toISOString();
  const stmt = db.prepare(`
    UPDATE handoff_status
    SET status = ?, ended_at = ?
    WHERE user_id = ? AND status = ?
  `);

  const result = stmt.run('ended', now, userId, 'active');

  if (result.changes === 0) {
    return { success: false, message: '用户当前未处于人工接管状态' };
  }

  return { success: true, message: '已释放会话，恢复机器人自动回复' };
}

/**
 * 查询用户是否处于人工接管中
 * @param {Object} db - better-sqlite3 Database 实例
 * @param {number} userId - 用户 ID
 * @returns {boolean}
 */
function isInHandoff(db, userId) {
  const conn = db || globalDb;
  if (!conn || !userId) return false;

  const row = conn.prepare(
    'SELECT 1 FROM handoff_status WHERE user_id = ? AND status = ? LIMIT 1'
  ).get(userId, 'active');

  return !!row;
}

/**
 * 获取当前人工接管会话详情（供后台管理使用）
 * @param {Object} db - better-sqlite3 Database 实例
 * @param {number} userId - 用户 ID
 * @returns {Object|null} 会话详情或 null
 */
function getActiveHandoff(db, userId) {
  if (!db || !userId) return null;

  return db.prepare(`
    SELECT id, user_id, status, source, group_id, reason, started_at, ended_at
    FROM handoff_status
    WHERE user_id = ? AND status = ?
    ORDER BY started_at DESC
    LIMIT 1
  `).get(userId, 'active') || null;
}

/**
 * 列出所有活跃的人工接管会话（供后台管理使用）
 * @param {Object} db - better-sqlite3 Database 实例
 * @param {Object} [filters={}] - 筛选条件
 * @param {string} [filters.source] - 按来源筛选
 * @param {number} [filters.limit=50] - 返回数量上限
 * @param {number} [filters.offset=0] - 偏移量
 * @returns {Array<Object>}
 */
function listActiveHandoffs(db, filters = {}) {
  if (!db) return [];

  const conditions = ['status = ?'];
  const params = ['active'];

  if (filters.source) {
    conditions.push('source = ?');
    params.push(filters.source);
  }

  const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = Math.min(Math.max(filters.limit || 50, 1), 500);
  const offset = Math.max(filters.offset || 0, 0);

  return db.prepare(`
    SELECT id, user_id, status, source, group_id, reason, started_at, ended_at
    FROM handoff_status
    ${whereClause}
    ORDER BY started_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);
}

/**
 * 通知客服老师（查询 users 表中 role='teacher' 或 'admin' 的用户，通过企微发送）
 * @param {Object} db - better-sqlite3 Database 实例
 * @param {number} userId - 发起转人工的用户 ID
 * @param {string} message - 用户原始消息内容
 * @param {string} [source='wecom'] - 来源渠道
 * @returns {Promise<Object>} { notified: number, failed: number, details: Array }
 */
async function notifyHumanAgents(db, userId, message, source = 'wecom') {
  if (!db || !userId) {
    return { notified: 0, failed: 0, details: [], message: '缺少 db 或 userId 参数' };
  }

  // 查询用户基本信息
  const user = db.prepare(
    'SELECT id, display_name, username, class_name FROM users WHERE id = ?'
  ).get(userId);

  const userDisplay = user ? `${user.display_name}(${user.username})` : `用户#${userId}`;
  const classInfo = user?.class_name ? ` [${user.class_name}]` : '';

  // 查询所有客服老师（role = teacher 或 admin）
  const agents = db.prepare(`
    SELECT id, username, display_name, openid
    FROM users
    WHERE role IN ('teacher', 'admin')
    ORDER BY role DESC, id ASC
  `).all();

  if (!agents.length) {
    console.warn('[humanHandoff] 未找到任何客服老师（teacher/admin）');
    return { notified: 0, failed: 0, details: [], message: '未找到客服老师' };
  }

  const details = [];
  let notified = 0;
  let failed = 0;

  // 构建通知消息
  const notificationText =
    `【人工客服介入通知】\n` +
    `用户：${userDisplay}${classInfo}\n` +
    `来源：${source}\n` +
    `消息：${message || '（用户请求人工客服）'}\n` +
    `时间：${dayjs().format('YYYY-MM-DD HH:mm:ss')}\n` +
    `请尽快通过后台或企微回复该用户。`;

  for (const agent of agents) {
    // 如果用户有 openid（企微 userId），则发送企微应用消息
    if (agent.openid) {
      try {
        const result = await sendAppMessage({
          touser: agent.openid,
          msgtype: 'text',
          text: { content: notificationText }
        });

        if (result && result.errcode === 0) {
          details.push({
            agentId: agent.id,
            agentName: agent.display_name,
            channel: 'wecom',
            status: 'sent'
          });
          notified++;
        } else {
          details.push({
            agentId: agent.id,
            agentName: agent.display_name,
            channel: 'wecom',
            status: 'failed',
            error: result?.errmsg || '企微发送失败'
          });
          failed++;
        }
      } catch (error) {
        details.push({
          agentId: agent.id,
          agentName: agent.display_name,
          channel: 'wecom',
          status: 'failed',
          error: error.message
        });
        failed++;
      }
    } else {
      // 缺少企微 userId，写一条站内通知兜底，确保老师在后台能看到
      try {
        const now = dayjs().toISOString();
        db.prepare(`
          INSERT INTO notifications (student_id, type, title, body, created_at)
          VALUES (?, ?, ?, ?, ?)
        `).run(agent.id, '人工客服', '人工客服介入通知', notificationText, now);
        details.push({
          agentId: agent.id,
          agentName: agent.display_name,
          channel: 'notification',
          status: 'sent',
          message: '缺少企微 userId，已写入站内通知'
        });
      } catch (notifErr) {
        details.push({
          agentId: agent.id,
          agentName: agent.display_name,
          channel: 'notification',
          status: 'failed',
          error: notifErr.message
        });
      }
      console.log(
        `[humanHandoff] 客服老师 ${agent.display_name}(id=${agent.id}) 缺少企微 userId，已写入站内通知。用户 ${userDisplay} 请求人工客服。`
      );
    }
  }

  return {
    notified,
    failed,
    total: agents.length,
    details,
    message: `通知完成：成功 ${notified} 人，失败 ${failed} 人，无 openid ${agents.length - notified - failed} 人`
  };
}

/**
 * 获取用户的人工客服历史记录（供后台查看）
 * @param {Object} db - better-sqlite3 Database 实例
 * @param {number} userId - 用户 ID
 * @param {number} [limit=20] - 返回数量上限
 * @returns {Array<Object>}
 */
function getHandoffHistory(db, userId, limit = 20) {
  if (!db || !userId) return [];

  return db.prepare(`
    SELECT id, user_id, status, source, group_id, reason, started_at, ended_at
    FROM handoff_status
    WHERE user_id = ?
    ORDER BY started_at DESC
    LIMIT ?
  `).all(userId, Math.min(Math.max(limit, 1), 500));
}

module.exports = {
  isHandoffRequest,
  startHandoff,
  endHandoff,
  isInHandoff,
  getActiveHandoff,
  listActiveHandoffs,
  notifyHumanAgents,
  getHandoffHistory
};
