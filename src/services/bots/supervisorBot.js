const dayjs = require('dayjs');
const { getTasksForStudentOnDate } = require('../taskService');
const { renderTemplate } = require('../messageTemplate');
const { getBotByCode, logConversation } = require('../botManager');
const { sendAppMessage } = require('../wecom');

const BOT_CODE = 'supervisor';
const BOT_TYPE = 'supervisor';

// ── 付费学员过滤（预留权益体系接口） ──

/**
 * 判断学生是否为付费学员
 * 当前 users 表无 tier 字段，暂以 role='student' 兜底；
 * 后续接入权益体系时，只需修改此函数即可。
 * @param {Database} db
 * @param {number} studentId
 * @returns {boolean}
 */
function isPaidStudent(db, studentId) {
  const user = db.prepare("SELECT role FROM users WHERE id = ?").get(studentId);
  return user && user.role === 'student';
}

/**
 * 获取所有应接收督学消息的付费学员
 * @param {Database} db
 * @returns {Array<{id: number, display_name: string, wecom_userid: string|null}>}
 */
function getPaidStudents(db) {
  // 预留 wecom_userid 字段，当前可能不存在则返回 null
  const columns = db.prepare("PRAGMA table_info(users)").all();
  const hasWecomUserid = columns.some(c => c.name === 'wecom_userid');

  if (hasWecomUserid) {
    return db.prepare(`
      SELECT id, display_name, wecom_userid
      FROM users
      WHERE role = 'student'
      ORDER BY id ASC
    `).all();
  }

  return db.prepare(`
    SELECT id, display_name, NULL as wecom_userid
    FROM users
    WHERE role = 'student'
    ORDER BY id ASC
  `).all();
}

// ── 内部辅助 ──

function getStudent(db, studentId) {
  const columns = db.prepare("PRAGMA table_info(users)").all();
  const hasWecomUserid = columns.some(c => c.name === 'wecom_userid');

  if (hasWecomUserid) {
    return db.prepare('SELECT id, display_name, wecom_userid FROM users WHERE id = ?').get(studentId);
  }
  return db.prepare('SELECT id, display_name, NULL as wecom_userid FROM users WHERE id = ?').get(studentId);
}

function getCompletion(db, taskId, studentId, taskDate) {
  return db.prepare(
    'SELECT completed_at FROM task_completions WHERE task_id = ? AND student_id = ? AND task_date = ?'
  ).get(taskId, studentId, taskDate);
}

function setTaskCompletion(db, taskId, studentId, taskDate, completed) {
  const now = dayjs().toISOString();
  const existing = db.prepare(
    'SELECT id FROM task_completions WHERE task_id = ? AND student_id = ? AND task_date = ?'
  ).get(taskId, studentId, taskDate);

  if (existing) {
    if (completed) {
      db.prepare(
        'UPDATE task_completions SET completed_at = ? WHERE task_id = ? AND student_id = ? AND task_date = ?'
      ).run(now, taskId, studentId, taskDate);
    } else {
      db.prepare(
        'UPDATE task_completions SET completed_at = NULL WHERE task_id = ? AND student_id = ? AND task_date = ?'
      ).run(taskId, studentId, taskDate);
    }
  } else {
    db.prepare(
      'INSERT INTO task_completions (task_id, student_id, task_date, completed_at) VALUES (?, ?, ?, ?)'
    ).run(taskId, studentId, taskDate, completed ? now : null);
  }
}

function formatTaskList(tasks) {
  return tasks.map((t, i) => `${i + 1}. ${t.start_time}-${t.end_time} ${t.subject}｜${t.title}`).join('\n');
}

async function sendToStudent(db, studentId, message, context = '') {
  const student = getStudent(db, studentId);
  if (!student) return { sent: false, reason: 'student_not_found' };

  // 记录对话（失败不应阻断消息发送）
  try {
    logConversation({
      userId: studentId,
      botCode: BOT_CODE,
      type: BOT_TYPE,
      prompt: context || message,
      response: message
    });
  } catch (err) {
    console.error(`[supervisorBot] 记录对话失败 studentId=${studentId}:`, err.message);
  }

  // 若学生有企业微信 userId，则发送应用消息
  if (student.wecom_userid) {
    try {
      await sendAppMessage({
        touser: student.wecom_userid,
        msgtype: 'text',
        text: { content: message }
      });
      return { sent: true, channel: 'wecom' };
    } catch (err) {
      console.error(`[supervisorBot] 发送企业微信消息失败 studentId=${studentId}:`, err.message);
      return { sent: false, reason: 'wecom_error', message };
    }
  }

  return { sent: false, reason: 'no_wecom_userid', message };
}

// ── 导出函数 ──

/**
 * 发送早安学习计划
 * 读取学生当日 tasks，用模板 morning_plan 生成消息并发送。
 * @param {Database} db
 * @param {number} studentId
 * @returns {Promise<{sent: boolean, message?: string}>}
 */
async function sendMorningPlan(db, studentId) {
  if (!isPaidStudent(db, studentId)) {
    return { sent: false, reason: 'not_paid_student' };
  }

  const student = getStudent(db, studentId);
  if (!student) return { sent: false, reason: 'student_not_found' };

  const dateString = dayjs().format('YYYY-MM-DD');
  const tasks = getTasksForStudentOnDate(db, studentId, dateString);

  if (!tasks.length) {
    return { sent: false, reason: 'no_tasks_today' };
  }

  const taskList = formatTaskList(tasks);
  const message = renderTemplate(db, 'morning_plan', {
    name: student.display_name,
    date: dateString,
    tasks: taskList
  });

  if (!message) {
    return { sent: false, reason: 'template_not_found' };
  }

  return sendToStudent(db, studentId, message, '早安计划推送');
}

/**
 * 到点提醒：每分钟检查任务 start_time 匹配当前分钟
 * 用模板 due_reminder 发送“该学 XX 科目了”。
 * @param {Database} db
 * @param {dayjs.Dayjs} [currentDateTime=dayjs()]
 * @returns {Promise<Array<{studentId: number, sent: boolean, taskTitle: string}>>}
 */
async function sendDueReminders(db, currentDateTime = dayjs()) {
  const dateString = currentDateTime.format('YYYY-MM-DD');
  const currentMinute = currentDateTime.format('HH:mm');
  const currentDayOfWeek = currentDateTime.day();
  const results = [];

  // 获取所有 start_time 匹配当前分钟的任务
  const taskRows = db.prepare('SELECT * FROM tasks WHERE start_time = ?').all(currentMinute);

  for (const taskRow of taskRows) {
    const task = getTasksForStudentOnDate(db, 0, dateString).find(t => t.id === taskRow.id);
    // 上面调用只是为了复用 normalize，但效率低；直接手动解析
    // 改为：直接用 taskRow，检查 weekdays
    const weekdays = safeJsonParse(taskRow.weekdays, [0, 1, 2, 3, 4, 5, 6]);
    if (!weekdays.includes(currentDayOfWeek)) continue;

    const studentIds = safeJsonParse(taskRow.student_ids, []);
    for (const sid of studentIds) {
      if (!isPaidStudent(db, sid)) continue;

      const student = getStudent(db, sid);
      if (!student) continue;

      const message = renderTemplate(db, 'due_reminder', {
        name: student.display_name,
        task: taskRow.title,
        subject: taskRow.subject || '考研',
        time: currentMinute
      });

      if (!message) continue;

      const result = await sendToStudent(db, sid, message, `到点提醒: ${taskRow.title}`);
      results.push({ studentId: sid, sent: result.sent, taskTitle: taskRow.title });
    }
  }

  return results;
}

/**
 * 晚间检查：列出当日未完成 tasks，用模板 evening_check 发送并询问完成情况。
 * @param {Database} db
 * @param {number} studentId
 * @returns {Promise<{sent: boolean, message?: string}>}
 */
async function sendEveningCheck(db, studentId) {
  if (!isPaidStudent(db, studentId)) {
    return { sent: false, reason: 'not_paid_student' };
  }

  const student = getStudent(db, studentId);
  if (!student) return { sent: false, reason: 'student_not_found' };

  const dateString = dayjs().format('YYYY-MM-DD');
  const tasks = getTasksForStudentOnDate(db, studentId, dateString);

  if (!tasks.length) {
    return { sent: false, reason: 'no_tasks_today' };
  }

  const completedTasks = [];
  const pendingTasks = [];

  for (const task of tasks) {
    const completion = getCompletion(db, task.id, studentId, dateString);
    if (completion && completion.completed_at) {
      completedTasks.push(task);
    } else {
      pendingTasks.push(task);
    }
  }

  const completedList = completedTasks.length ? formatTaskList(completedTasks) : '无';
  const pendingList = pendingTasks.length ? formatTaskList(pendingTasks) : '无';

  const message = renderTemplate(db, 'evening_check', {
    name: student.display_name,
    date: dateString,
    completed: completedList,
    pending: pendingList
  });

  if (!message) {
    return { sent: false, reason: 'template_not_found' };
  }

  // 追加询问语
  const fullMessage = pendingTasks.length
    ? `${message}\n\n请回复任务编号或"完成/未完成"来更新进度。`
    : message;

  return sendToStudent(db, studentId, fullMessage, '晚间检查推送');
}

/**
 * 解析学生回复，更新 task_completions 表
 * 支持：完成/未完成/是/否/1/0/任务编号+状态
 * @param {Database} db
 * @param {number} studentId
 * @param {string} text
 * @returns {Promise<{success: boolean, message?: string, updated?: Array<{taskId: number, completed: boolean}>}>}
 */
async function handleReply(db, studentId, text) {
  if (!isPaidStudent(db, studentId)) {
    return { success: false, message: '您当前不是付费学员，无法使用督学服务。' };
  }

  const student = getStudent(db, studentId);
  if (!student) return { success: false, message: '学生信息不存在。' };

  const dateString = dayjs().format('YYYY-MM-DD');
  const tasks = getTasksForStudentOnDate(db, studentId, dateString);

  if (!tasks.length) {
    return { success: false, message: '今天没有安排学习任务，好好休息！' };
  }

  const normalized = text.trim().toLowerCase();

  // 全局状态回复
  const globalYes = /^(完成|是|yes|y|1|ok|好的|行了|做完了|做完了)$/.test(normalized);
  const globalNo = /^(未完成|否|no|n|0|没|没有|没做|还没|不行)$/.test(normalized);

  const updated = [];

  if (globalYes || globalNo) {
    const completed = globalYes;
    for (const task of tasks) {
      setTaskCompletion(db, task.id, studentId, dateString, completed);
      updated.push({ taskId: task.id, completed });
    }

    const response = completed
      ? `太棒了，${student.display_name}！今日所有任务已标记为完成，继续保持！`
      : `收到，${student.display_name}。未完成也没关系，明天继续加油！`;

    logConversation({
      userId: studentId,
      botCode: BOT_CODE,
      type: BOT_TYPE,
      prompt: text,
      response
    });

    return { success: true, message: response, updated };
  }

  // 按编号解析："1完成"、"2没做"、"3 完成"、"完成了1和2"
  const numberStatusPatterns = [
    { regex: /(\d+)\s*(完成|是|ok|做完了|yes|1)/g, completed: true },
    { regex: /(\d+)\s*(未完成|否|没做|no|0|没|没有)/g, completed: false },
    { regex: /(完成|做完了|yes|ok)\s*(\d+)/g, completed: true, reverse: true },
    { regex: /(没做|未完成|no|否)\s*(\d+)/g, completed: false, reverse: true }
  ];

  for (const pattern of numberStatusPatterns) {
    let match;
    const regex = new RegExp(pattern.regex.source, 'g');
    while ((match = regex.exec(normalized)) !== null) {
      const numStr = pattern.reverse ? match[2] : match[1];
      const taskIndex = parseInt(numStr, 10) - 1;
      if (taskIndex >= 0 && taskIndex < tasks.length) {
        const task = tasks[taskIndex];
        setTaskCompletion(db, task.id, studentId, dateString, pattern.completed);
        updated.push({ taskId: task.id, completed: pattern.completed });
      }
    }
  }

  // 按任务名称解析：包含任务标题关键词
  if (updated.length === 0) {
    for (const task of tasks) {
      const titleLower = task.title.toLowerCase();
      const subjectLower = (task.subject || '').toLowerCase();
      if (normalized.includes(titleLower) || normalized.includes(subjectLower)) {
        const completed = /(完成|做完|ok|yes|是|1)/.test(normalized) && !/(未完成|没做|no|否|0)/.test(normalized);
        setTaskCompletion(db, task.id, studentId, dateString, completed);
        updated.push({ taskId: task.id, completed });
      }
    }
  }

  if (updated.length > 0) {
    const completedCount = updated.filter(u => u.completed).length;
    const response = `已更新 ${updated.length} 项任务进度（完成 ${completedCount} 项）。${student.display_name}，继续加油！`;

    logConversation({
      userId: studentId,
      botCode: BOT_CODE,
      type: BOT_TYPE,
      prompt: text,
      response
    });

    return { success: true, message: response, updated };
  }

  // 无法解析
  const taskList = formatTaskList(tasks);
  const response = `抱歉，我没有理解您的回复。\n\n今日任务列表：\n${taskList}\n\n请回复：\n- "完成" / "未完成"（更新全部任务）\n- "1完成" / "2未完成"（按编号更新）\n- 或任务名称 + 状态`;

  logConversation({
    userId: studentId,
    botCode: BOT_CODE,
    type: BOT_TYPE,
    prompt: text,
    response
  });

  return { success: false, message: response };
}

// ── 内部工具函数 ──

function safeJsonParse(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch (_) {
    return fallback;
  }
}

module.exports = {
  isPaidStudent,
  getPaidStudents,
  sendMorningPlan,
  sendDueReminders,
  sendEveningCheck,
  handleReply
};
