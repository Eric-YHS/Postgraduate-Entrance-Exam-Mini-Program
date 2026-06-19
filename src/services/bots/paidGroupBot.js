const dayjs = require('dayjs');
const { createAppChat, inviteChatMembers, sendAppChatMessage } = require('../wecom');
const { getBotByCode, assignBotToGroup } = require('../botManager');
const { renderTemplate } = require('../messageTemplate');

// 付费服务群需要的5大机器人 code
const REQUIRED_BOT_CODES = [
  'supervisor',
  'answer',
  'school_selector',
  'exam_generator',
  'planner'
];

// 默认欢迎文案（当模板不存在时使用）
const DEFAULT_WELCOME_MESSAGE = `欢迎加入考研专属服务群！

我是你的专属服务助手，群内还有5位AI机器人随时为你服务：
- 督学助手：监督学习进度，提醒打卡
- 解答专家：提供详细解题思路
- 择校顾问：推荐合适院校专业
- 自测生成器：生成个性化练习题
- 规划师：制定复习计划

为了给你提供更精准的服务，请回复以下信息：
1. 目标院校
2. 目标专业
3. 当前复习进度

祝你考研顺利！`;

/**
 * 创建付费服务群（支付成功后自动拉群）
 * @param {object} db - better-sqlite3 数据库实例
 * @param {number} studentId - 学生用户ID
 * @param {number} orderId - 订单ID
 * @param {object} [options={}] - 可选配置
 * @param {string} [options.groupName] - 自定义群名（默认："{学生姓名}·考研专属服务群"）
 * @param {string} [options.ownerUserId] - 群主企业微信userId（默认取第一位老师）
 * @returns {Promise<object>} { success, groupId, chatId, error }
 */
async function createPaidServiceGroup(db, studentId, orderId, options = {}) {
  try {
    // 1. 查询学生信息
    const student = db.prepare(`
      SELECT id, username, display_name, openid
      FROM users
      WHERE id = ? AND role = 'student'
    `).get(studentId);

    if (!student) {
      throw new Error(`学生 id=${studentId} 不存在或不是学生角色`);
    }

    // 2. 查询订单信息
    const order = db.prepare(`
      SELECT id, product_id, student_id, status, total_amount
      FROM orders
      WHERE id = ? AND student_id = ?
    `).get(orderId, studentId);

    if (!order) {
      throw new Error(`订单 id=${orderId} 不存在或不属于该学生`);
    }

    // 3. 查询商品信息
    const product = order.product_id
      ? db.prepare('SELECT id, title, description FROM products WHERE id = ?').get(order.product_id)
      : null;

    // 4. 查询所有老师（role='teacher'）
    const teachers = db.prepare(`
      SELECT id, username, display_name, openid
      FROM users
      WHERE role = 'teacher'
      ORDER BY id ASC
    `).all();

    if (!teachers.length) {
      throw new Error('系统中没有可用的老师，无法创建服务群');
    }

    // 5. 构建群成员列表（企业微信 userId 使用 openid 或 username）
    const ownerUserId = options.ownerUserId || teachers[0].openid || teachers[0].username;
    const studentUserId = student.openid || student.username;
    const teacherUserIds = teachers.map(t => t.openid || t.username);

    // 去重并确保群主在列表中
    const userlist = [ownerUserId, studentUserId, ...teacherUserIds]
      .filter((v, i, arr) => arr.indexOf(v) === i);

    // 6. 创建群聊
    const groupName = options.groupName || `${student.display_name}·考研专属服务群`;
    const createResult = await createAppChat({
      name: groupName,
      owner: ownerUserId,
      userlist
    });

    if (!createResult || createResult.errcode !== 0) {
      const errmsg = createResult ? createResult.errmsg : 'createAppChat 返回空';
      throw new Error(`创建企业微信群聊失败: ${errmsg}`);
    }

    const chatId = createResult.chatid;

    // 7. 将群信息存入 wecom_groups 表（携带 student_id / order_id 便于后续关联）
    const now = dayjs().toISOString();
    const groupInsert = db.prepare(`
      INSERT INTO wecom_groups (chat_id, name, owner, student_id, order_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const groupResult = groupInsert.run(chatId, groupName, ownerUserId, studentId, orderId, now);
    const groupDbId = groupResult.lastInsertRowid;

    // 8. 将成员关系存入 wecom_group_members 表
    const memberInsert = db.prepare(`
      INSERT OR IGNORE INTO wecom_group_members (group_id, user_id, created_at)
      VALUES (?, ?, ?)
    `);
    for (const userId of userlist) {
      memberInsert.run(groupDbId, userId, now);
    }

    // 9. 邀请5大机器人入群：从 bot 配置读取企微 userId，调用 appchat/update 真正邀请入群
    const botWecomUserIds = [];
    for (const botCode of REQUIRED_BOT_CODES) {
      const bot = getBotByCode(botCode);
      if (bot && bot.is_active) {
        // 建立机器人与群组的分配关系
        try {
          assignBotToGroup(bot.id, groupDbId);
        } catch (assignErr) {
          console.warn(`[paidGroupBot] 分配机器人 ${botCode} 到群组失败:`, assignErr.message);
        }
        const botWecomId = bot.config && bot.config.wecomUserId;
        if (botWecomId) {
          botWecomUserIds.push(botWecomId);
        } else {
          console.warn(`[paidGroupBot] 机器人 ${botCode} 未配置企微 userId，无法邀请入群`);
        }
      } else {
        console.warn(`[paidGroupBot] 机器人 ${botCode} 不存在或未激活`);
      }
    }

    if (botWecomUserIds.length > 0) {
      try {
        const inviteResult = await inviteChatMembers({ chatid: chatId, userlist: botWecomUserIds });
        if (!inviteResult || inviteResult.errcode !== 0) {
          console.warn(`[paidGroupBot] 邀请机器人入群部分失败:`, inviteResult?.errmsg);
        }
      } catch (inviteErr) {
        console.error(`[paidGroupBot] 邀请机器人入群失败:`, inviteErr.message);
      }
    }

    // 10. 发送欢迎消息（使用模板或默认文案），通过 appchat/send 发送到群聊
    let welcomeMessage = renderTemplate(db, 'paid_group_welcome', {
      studentName: student.display_name,
      productName: product ? product.title : '考研专属服务',
      groupName
    });

    if (!welcomeMessage) {
      welcomeMessage = DEFAULT_WELCOME_MESSAGE;
    }

    try {
      await sendAppChatMessage({
        chatid: chatId,
        msgtype: 'text',
        text: { content: welcomeMessage }
      });
    } catch (welcomeErr) {
      console.error('[paidGroupBot] 发送群欢迎消息失败:', welcomeErr.message);
    }

    // 11. 记录订单与群的关联（可选：扩展 orders 表或新建关联表）
    // 当前通过日志记录，后续可扩展为 order_group_relations 表
    console.log(`[paidGroupBot] 已为订单 ${orderId} 创建服务群，chatId=${chatId}, groupDbId=${groupDbId}`);

    return {
      success: true,
      groupId: groupDbId,
      chatId,
      studentId,
      orderId,
      memberCount: userlist.length,
      botCount: botIds.length
    };

  } catch (error) {
    console.error('[paidGroupBot] 创建付费服务群失败:', error.message);
    return {
      success: false,
      error: error.message,
      studentId,
      orderId
    };
  }
}

/**
 * 支付成功后的触发入口
 * @param {number} orderId - 订单ID
 * @returns {Promise<object>} 同 createPaidServiceGroup 返回值
 */
async function triggerAfterPayment(orderId) {
  // 从全局 db 实例获取（与项目其他模块保持一致）
  const { db } = require('../../db');

  // 查询订单确认状态
  const order = db.prepare(`
    SELECT id, student_id, status, product_id
    FROM orders
    WHERE id = ?
  `).get(orderId);

  if (!order) {
    return { success: false, error: `订单 ${orderId} 不存在` };
  }

  // 仅对已支付订单创建服务群
  if (order.status !== 'paid') {
    return { success: false, error: `订单状态为 ${order.status}，非已支付状态，跳过拉群` };
  }

  // 检查是否已创建过群（防止重复）
  const existingGroup = db.prepare(`
    SELECT g.id, g.chat_id
    FROM wecom_groups g
    JOIN wecom_group_members m ON g.id = m.group_id
    JOIN users u ON m.user_id = u.openid OR m.user_id = u.username
    WHERE u.id = ? AND g.name LIKE '%考研专属服务群%'
    LIMIT 1
  `).get(order.student_id);

  if (existingGroup) {
    console.log(`[paidGroupBot] 学生 ${order.student_id} 已有服务群，跳过重复创建`);
    return {
      success: true,
      groupId: existingGroup.id,
      chatId: existingGroup.chat_id,
      skipped: true
    };
  }

  return createPaidServiceGroup(db, order.student_id, orderId);
}

module.exports = {
  createPaidServiceGroup,
  triggerAfterPayment
};
