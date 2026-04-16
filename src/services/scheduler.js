const cron = require('node-cron');
const dayjs = require('dayjs');
const { getTasksForStudentOnDate, normalizeTaskRow } = require('./taskService');
const { sendSubscribeMessage } = require('./wxPush');

function createNotification(db, notifyClient, payload) {
  const now = dayjs().toISOString();
  const existing = payload.scheduleKey
    ? db.prepare('SELECT id FROM notifications WHERE schedule_key = ?').get(payload.scheduleKey)
    : null;

  if (existing) {
    return null;
  }

  const result = db
    .prepare(
      `
        INSERT INTO notifications (
          student_id, type, title, body, task_id, task_date, schedule_key, created_at
        ) VALUES (
          @student_id, @type, @title, @body, @task_id, @task_date, @schedule_key, @created_at
        )
      `
    )
    .run({
      student_id: payload.studentId,
      type: payload.type,
      title: payload.title,
      body: payload.body,
      task_id: payload.taskId || null,
      task_date: payload.taskDate || '',
      schedule_key: payload.scheduleKey || null,
      created_at: now
    });

  const notification = {
    id: result.lastInsertRowid,
    student_id: payload.studentId,
    type: payload.type,
    title: payload.title,
    body: payload.body,
    task_id: payload.taskId || null,
    task_date: payload.taskDate || '',
    created_at: now
  };

  notifyClient(payload.studentId, {
    type: 'notification',
    payload: notification
  });

  return notification;
}

function dispatchDailyDigest(db, notifyClient, currentDateTime = dayjs()) {
  const dateString = currentDateTime.format('YYYY-MM-DD');
  const students = db.prepare(`SELECT id, display_name FROM users WHERE role = 'student' ORDER BY id ASC`).all();
  const notifications = [];

  students.forEach((student) => {
    const tasks = getTasksForStudentOnDate(db, student.id, dateString);

    if (!tasks.length) {
      return;
    }

    const body = tasks.map((task) => `${task.start_time}-${task.end_time} ${task.subject}｜${task.title}`).join('；');
    const scheduleKey = `digest:${student.id}:${dateString}`;
    const notification = createNotification(db, notifyClient, {
      studentId: student.id,
      type: '每日任务',
      title: `${dateString} 今日考研任务`,
      body,
      taskDate: dateString,
      scheduleKey
    });

    if (notification) {
      notifications.push(notification);
    }
  });

  return notifications;
}

function dispatchDueTaskReminders(db, notifyClient, currentDateTime = dayjs()) {
  const dateString = currentDateTime.format('YYYY-MM-DD');
  const currentMinute = currentDateTime.format('HH:mm');
  const currentDayOfWeek = currentDateTime.day();
  // 仅查询 start_time 匹配当前分钟的任务，避免全量遍历
  const tasks = db.prepare('SELECT * FROM tasks WHERE start_time = ?').all(currentMinute);
  const notifications = [];

  tasks.forEach((taskRow) => {
    const task = normalizeTaskRow(taskRow);

    if (!task.weekdays.includes(currentDayOfWeek)) {
      return;
    }

    task.studentIds.forEach((studentId) => {
      const scheduleKey = `task:${studentId}:${task.id}:${dateString}:${task.start_time}`;
      const notification = createNotification(db, notifyClient, {
        studentId,
        type: '学习提醒',
        title: `${task.subject} 学习提醒`,
        body: `${task.start_time} 开始：${task.title}`,
        taskId: task.id,
        taskDate: dateString,
        scheduleKey
      });

      if (notification) {
        notifications.push(notification);
      }
    });
  });

  return notifications;
}

function dispatchEveningReminder(db, notifyClient) {
  const dateString = dayjs().format('YYYY-MM-DD');
  const students = db.prepare(`SELECT id, display_name, openid FROM users WHERE role = 'student'`).all();

  students.forEach((student) => {
    const tasks = getTasksForStudentOnDate(db, student.id, dateString);

    const incompleteTasks = tasks.filter((task) => {
      const completion = db.prepare(
        'SELECT completed_at FROM task_completions WHERE task_id = ? AND student_id = ? AND task_date = ?'
      ).get(task.id, student.id, dateString);
      return !completion || !completion.completed_at;
    });

    if (!incompleteTasks.length) {
      return;
    }

    const body = incompleteTasks.map((t) => `${t.subject}｜${t.title}`).join('；');
    const scheduleKey = `evening:${student.id}:${dateString}`;

    createNotification(db, notifyClient, {
      studentId: student.id,
      type: '晚间提醒',
      title: '还有任务未完成',
      body: `今日剩余 ${incompleteTasks.length} 项任务：${body}`,
      taskDate: dateString,
      scheduleKey
    });

    // 微信推送（如已配置且有 openid）
    if (student.openid && process.env.WX_EVENING_TEMPLATE_ID) {
      sendSubscribeMessage(
        student.openid,
        process.env.WX_EVENING_TEMPLATE_ID,
        {
          thing1: { value: `剩余${incompleteTasks.length}项任务` },
          thing2: { value: body.slice(0, 20) },
          date3: { value: dateString }
        },
        'pages/home/index'
      ).catch((err) => { console.error('微信推送失败:', err.message); });
    }
  });
}

function startScheduler(db, notifyClient) {
  // BUG-305: 整点检查日常提醒（07:00 日报、22:00 晚间提醒）
  cron.schedule('0 * * * *', () => {
    const now = dayjs();

    if (now.format('HH:mm') === '07:00') {
      dispatchDailyDigest(db, notifyClient, now);
    }

    // 每晚 22:00 发送未完成任务提醒
    if (now.format('HH:mm') === '22:00') {
      dispatchEveningReminder(db, notifyClient);
    }
  });

  // 每分钟检查任务到期提醒（需精确到分钟）
  cron.schedule('* * * * *', () => {
    dispatchDueTaskReminders(db, notifyClient, dayjs());
  });
}

module.exports = {
  dispatchDailyDigest,
  dispatchDueTaskReminders,
  dispatchEveningReminder,
  startScheduler
};
