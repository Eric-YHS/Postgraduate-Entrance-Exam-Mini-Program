const cron = require('node-cron');
const dayjs = require('dayjs');
const { getTasksForStudentOnDate, normalizeTaskRow } = require('./taskService');
const { sendSubscribeMessage } = require('./wxPush');
const { sendMorningPlan, sendDueReminders, sendEveningCheck, getPaidStudents } = require('./bots/supervisorBot');
const { downgradeExpiredTrials, downgradeExpiredPaid } = require('./entitlements');

// Phase 3: 引入进阶智能服务机器人
let plannerBot = null;
let examGeneratorBot = null;
try {
  plannerBot = require('./bots/plannerBot');
} catch (err) {
  console.warn('[scheduler] plannerBot 未加载:', err.message);
}

try {
  examGeneratorBot = require('./bots/examGeneratorBot');
} catch (err) {
  console.warn('[scheduler] examGeneratorBot 未加载:', err.message);
}

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
  const notifications = [];

  // 1. 原有逻辑：task.start_time 匹配当前分钟
  const tasks = db.prepare('SELECT * FROM tasks WHERE start_time = ?').all(currentMinute);

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

      // I-16: 发送微信订阅消息推送
      const student = db.prepare('SELECT openid FROM users WHERE id = ?').get(studentId);
      if (student && student.openid && notifyClient && (typeof notifyClient === 'function' || (typeof notifyClient === 'object' && notifyClient.sendSubscribeMessage))) {
        notifyClient.sendSubscribeMessage(
          student.openid,
          'task_reminder',
          { thing1: { value: task.title }, thing2: { value: task.start_time } },
          'pages/home/index'
        ).catch(() => {});
      }
    });
  });

  // 2. 新增逻辑：学生自选提醒时间匹配当前分钟
  const studentReminders = db.prepare('SELECT sr.*, t.title AS task_title, t.subject, u.openid FROM student_reminders sr JOIN tasks t ON t.id = sr.task_id JOIN users u ON u.id = sr.student_id WHERE sr.reminder_time = ?').all(currentMinute);

  studentReminders.forEach((rem) => {
    const taskRow = db.prepare('SELECT * FROM tasks WHERE id = ?').get(rem.task_id);
    if (!taskRow) return;
    const task = normalizeTaskRow(taskRow);
    if (!task.weekdays.includes(currentDayOfWeek)) return;

    const scheduleKey = `reminder:${rem.student_id}:${rem.task_id}:${dateString}:${rem.reminder_time}`;
    const notification = createNotification(db, notifyClient, {
      studentId: rem.student_id,
      type: '学习提醒',
      title: `${rem.subject} 专属提醒`,
      body: `你设定的 ${rem.reminder_time} 提醒：${rem.task_title}`,
      taskId: rem.task_id,
      taskDate: dateString,
      scheduleKey
    });

    if (notification && rem.openid && process.env.WX_EVENING_TEMPLATE_ID) {
      sendSubscribeMessage(
        rem.openid,
        process.env.WX_EVENING_TEMPLATE_ID,
        {
          thing1: { value: `${rem.subject} 专属提醒` },
          thing2: { value: rem.task_title.slice(0, 20) },
          date3: { value: dateString }
        },
        'pages/home/index'
      ).catch((err) => { console.error('微信推送失败:', err.message); });
    }

    if (notification) {
      notifications.push(notification);
    }
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
  // BUG-305: 整点检查日常提醒（07:00 日报、08:00 督学计划、22:00 晚间提醒）
  cron.schedule('0 * * * *', () => {
    try {
      const now = dayjs();
      const timeStr = now.format('HH:mm');
      if (timeStr === '07:00') {
        dispatchDailyDigest(db, notifyClient, now);
      }
      if (timeStr === '08:00') {
        // 新增：08:00 给付费学员发送督学早安计划
        const paidStudents = getPaidStudents(db);
        for (const student of paidStudents) {
          sendMorningPlan(db, student.id).catch((err) => {
            console.error(`[scheduler] 发送早安计划失败 studentId=${student.id}:`, err.message);
          });
        }
      }
      if (timeStr === '22:00') {
        dispatchEveningReminder(db, notifyClient);
        // 新增：22:00 给付费学员发送晚间检查
        const paidStudents = getPaidStudents(db);
        for (const student of paidStudents) {
          sendEveningCheck(db, student.id).catch((err) => {
            console.error(`[scheduler] 发送晚间检查失败 studentId=${student.id}:`, err.message);
          });
        }
      }
    } catch (err) {
      console.error('整点 cron 错误:', err);
    }
  });

  cron.schedule('* * * * *', () => {
    try {
      // 原有到点提醒逻辑（通知系统 + 微信推送）
      dispatchDueTaskReminders(db, notifyClient, dayjs());
      // 新增：付费学员到点提醒（企业微信应用消息）
      sendDueReminders(db, dayjs()).catch((err) => {
        console.error('[scheduler] 发送付费学员到点提醒失败:', err.message);
      });
    } catch (err) {
      console.error('分钟 cron 错误:', err);
    }
  });

  // B-29: 每天凌晨清理超过 30 天的搜索日志
  cron.schedule('0 3 * * *', () => {
    try {
      const result = db.prepare("DELETE FROM search_logs WHERE created_at < datetime('now', '-30 days')").run();
      if (result.changes > 0) {
        console.log(`已清理 ${result.changes} 条过期搜索日志。`);
      }
    } catch (err) {
      console.error('清理搜索日志失败:', err);
    }
  });

  // B-30: 每天凌晨清理超过 90 天的 AI 对话记录
  cron.schedule('0 3 * * *', () => {
    try {
      const result = db.prepare("DELETE FROM ai_conversations WHERE created_at < datetime('now', '-90 days')").run();
      if (result.changes > 0) {
        console.log(`已清理 ${result.changes} 条过期 AI 对话记录。`);
      }
    } catch (err) {
      console.error('清理 AI 对话记录失败:', err);
    }
  });

  // ===== Phase 3: 每半月生成 AI 自测试卷（1 日和 16 日凌晨）=====
  cron.schedule('0 2 1,16 * *', () => {
    try {
      if (examGeneratorBot && typeof examGeneratorBot.generateExamForAllPaidStudents === 'function') {
        examGeneratorBot.generateExamForAllPaidStudents(db).then((results) => {
          const successCount = results.filter((r) => r.success).length;
          console.log(`[scheduler] AI 试卷生成完成: ${successCount}/${results.length} 成功`);
        }).catch((err) => {
          console.error('[scheduler] AI 试卷生成失败:', err.message);
        });
      } else {
        console.log('[scheduler] examGeneratorBot 不可用，跳过 AI 试卷生成');
      }
    } catch (err) {
      console.error('[scheduler] AI 试卷生成 cron 错误:', err);
    }
  });

  // ===== Phase 3(C-10): 每周日凌晨 06:30 生成学情周报并同步师生 =====
  cron.schedule('30 6 * * 0', () => {
    try {
      if (plannerBot && typeof plannerBot.generateReportsForAllPaidStudents === 'function') {
        plannerBot.generateReportsForAllPaidStudents(db).then((results) => {
          const succeeded = results.filter((r) => r.success);
          console.log(`[scheduler] 学情周报生成完成: ${succeeded.length}/${results.length} 成功`);
          const weekTag = dayjs().subtract(7, 'day').format('YYYY-MM-DD');

          for (const r of succeeded) {
            const reportRow = db.prepare('SELECT * FROM study_reports WHERE id = ?').get(r.reportId);
            let reportData = null;
            if (reportRow && reportRow.data_json) {
              try { reportData = JSON.parse(reportRow.data_json); } catch (_) {}
            } else if (reportRow && reportRow.content) {
              try { reportData = JSON.parse(reportRow.content); } catch (_) {}
            }

            // 学生站内通知
            const weakPoints = reportData && Array.isArray(reportData.weakPoints) ? reportData.weakPoints : [];
            createNotification(db, notifyClient, {
              studentId: r.studentId,
              type: '学情周报',
              title: '本周学情周报已生成',
              body: weakPoints.length
                ? `本周薄弱点：${weakPoints.slice(0, 3).join('、')}。点击查看完整周报与下周计划。`
                : '本周学情周报已生成，点击查看掌握情况与下周计划。',
              scheduleKey: `weekly_report:${r.studentId}:${weekTag}`
            });

            // 学生企微推送（已有能力，无 wecom_userid 时内部跳过）
            if (reportData && plannerBot.sendReportToUser) {
              plannerBot.sendReportToUser(db, r.studentId, reportData).catch((err) => {
                console.error(`[scheduler] 发送周报失败 studentId=${r.studentId}:`, err.message);
              });
            }
          }

          // 同步给老师：聚合一条站内通知，提示到后台查看
          if (succeeded.length > 0) {
            const teachers = db.prepare(`SELECT id FROM users WHERE role IN ('teacher', 'admin')`).all();
            for (const teacher of teachers) {
              createNotification(db, notifyClient, {
                studentId: teacher.id,
                type: '学情周报',
                title: '学员学情周报已生成',
                body: `本周已为 ${succeeded.length} 名学员生成学情周报，请在后台「学情分析」中查看并调整计划。`,
                scheduleKey: `weekly_report_teacher:${teacher.id}:${weekTag}`
              });
            }
          }
        }).catch((err) => {
          console.error('[scheduler] 学情周报生成失败:', err.message);
        });
      } else {
        console.log('[scheduler] plannerBot 不可用，跳过学情周报生成');
      }
    } catch (err) {
      console.error('[scheduler] 学情周报 cron 错误:', err);
    }
  });

  // B 线：体验到期降级与到期前提醒
  cron.schedule('0 9 * * *', () => {
    try {
      const downgraded = downgradeExpiredTrials();
      for (const studentId of downgraded) {
        createNotification(db, notifyClient, {
          studentId,
          type: '权益提醒',
          title: '体验已到期',
          body: '你的 7 天体验期已结束，已降级为免费用户。如需继续使用付费内容，请开通。',
          scheduleKey: `trial_expired:${studentId}:${dayjs().format('YYYY-MM-DD')}`
        });
      }

      const expiringTomorrow = db.prepare(`
        SELECT student_id FROM user_entitlements
        WHERE tier = 'trial' AND date(trial_ended_at) = date('now', '+1 day')
      `).all();
      for (const row of expiringTomorrow) {
        createNotification(db, notifyClient, {
          studentId: row.student_id,
          type: '权益提醒',
          title: '体验即将到期',
          body: '你的体验期将于明天到期，请及时开通付费服务。',
          scheduleKey: `trial_expiring:${row.student_id}:${dayjs().format('YYYY-MM-DD')}`
        });
      }

      downgradeExpiredPaid();
    } catch (err) {
      console.error('权益生命周期调度失败:', err);
    }
  });
}

module.exports = {
  dispatchDailyDigest,
  dispatchDueTaskReminders,
  dispatchEveningReminder,
  startScheduler
};
