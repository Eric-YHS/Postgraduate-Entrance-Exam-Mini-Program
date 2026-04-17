const dayjs = require('dayjs');
const { sanitizeText } = require('../utils/sanitize');

module.exports = function registerStudentRoutes(app, shared) {
  const { db, requireStudent, requireAuth, serializeSummary, serializeNotification, serializeLiveSession, getStudentCoreBootstrapData, getStudentModuleData, safeJsonParse, sendNotificationToStudent, dispatchDailyDigest, dispatchDueTaskReminders, summaryUpload, toPublicPath } = shared;

  // 学生提交总结
  app.post('/api/summaries', requireStudent, (request, response) => {
    const contentType = request.headers['content-type'] || '';
    const isMultipart = contentType.includes('multipart/form-data');

    const handleSummary = () => {
      const taskDate = request.body.taskDate || dayjs().format('YYYY-MM-DD');
      // BUG-006: 验证日期合法性
      const parsedDate = dayjs(taskDate);
      if (!parsedDate.isValid() || parsedDate.isAfter(dayjs().add(1, 'day'))) {
        response.status(400).json({ error: '无效的总结日期。' });
        return;
      }
      const content = sanitizeText(request.body.content);
      const imagePaths = (request.files?.images || []).map((file) => toPublicPath(file.path));
      const attachmentPaths = (request.files?.attachments || []).map((file) => toPublicPath(file.path));
      const now = dayjs().toISOString();

      // BUG-007: 无内容无附件时拒绝创建新记录
      if (!content && !imagePaths.length && !attachmentPaths.length) {
        const existing = db.prepare('SELECT id FROM summaries WHERE student_id = ? AND task_date = ?').get(request.currentUser.id, taskDate);
        if (!existing) {
          response.status(400).json({ error: '请填写总结内容或上传文件。' });
          return;
        }
      }

      // BUG-017: 用事务防止并发读-改-写竞态
      const upsertSummary = db.transaction(() => {
        const existing = db.prepare('SELECT id, content, image_paths, attachment_paths FROM summaries WHERE student_id = ? AND task_date = ?').get(request.currentUser.id, taskDate);

        if (existing) {
          const mergedImages = [...safeJsonParse(existing.image_paths, []), ...imagePaths];
          const mergedAttachments = [...safeJsonParse(existing.attachment_paths, []), ...attachmentPaths];
          const finalContent = content || existing.content;

          db.prepare(
            `
              UPDATE summaries
              SET content = ?, image_paths = ?, attachment_paths = ?, updated_at = ?
              WHERE id = ?
            `
          ).run(finalContent, JSON.stringify(mergedImages), JSON.stringify(mergedAttachments), now, existing.id);
        } else {
          db.prepare(
            `
              INSERT INTO summaries (
                student_id, task_date, content, image_paths, attachment_paths, created_at, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?)
          `
        ).run(request.currentUser.id, taskDate, content, JSON.stringify(imagePaths), JSON.stringify(attachmentPaths), now, now);
        }
      });

      upsertSummary();
      response.json({ ok: true });
    };

    if (isMultipart) {
      summaryUpload(request, response, (error) => {
        if (error) {
          response.status(400).json({ error: '总结上传失败。' });
          return;
        }
        handleSummary();
      });
    } else {
      handleSummary();
    }
  });

  // 学生端 bootstrap
  app.get('/api/student/bootstrap', requireStudent, (request, response) => {
    const modules = request.query.modules ? request.query.modules.split(',') : null;
    if (modules) {
      response.json(getStudentModuleData(request.currentUser, modules));
    } else {
      response.json(getStudentCoreBootstrapData(request.currentUser));
    }
  });

  // 学生标记任务完成
  app.post('/api/tasks/:id/complete', requireStudent, (request, response) => {
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(request.params.id);
    if (!task) {
      response.status(404).json({ error: '任务不存在。' });
      return;
    }

    const taskStudents = safeJsonParse(task.student_ids, []);
    if (!taskStudents.includes(request.currentUser.id)) {
      response.status(403).json({ error: '该任务不属于当前学生。' });
      return;
    }

    const today = dayjs().format('YYYY-MM-DD');
    const now = dayjs().toISOString();

    db.prepare(
      `INSERT INTO task_completions (task_id, student_id, task_date, completed_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(task_id, student_id, task_date) DO UPDATE SET completed_at = excluded.completed_at`
    ).run(request.params.id, request.currentUser.id, today, now);

    response.json({ ok: true });
  });

  // 学生取消任务完成
  app.post('/api/tasks/:id/uncomplete', requireStudent, (request, response) => {
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(request.params.id);
    if (!task) {
      response.status(404).json({ error: '任务不存在。' });
      return;
    }

    const taskStudents = safeJsonParse(task.student_ids, []);
    if (!taskStudents.includes(request.currentUser.id)) {
      response.status(403).json({ error: '该任务不属于当前学生。' });
      return;
    }

    const today = dayjs().format('YYYY-MM-DD');
    db.prepare(
      'UPDATE task_completions SET completed_at = NULL WHERE task_id = ? AND student_id = ? AND task_date = ?'
    ).run(request.params.id, request.currentUser.id, today);

    response.json({ ok: true });
  });

  // 通知已读
  app.post('/api/notifications/:id/read', requireStudent, (request, response) => {
    const result = db.prepare('UPDATE notifications SET read_at = ? WHERE id = ? AND student_id = ?').run(dayjs().toISOString(), request.params.id, request.currentUser.id);
    if (!result.changes) {
      response.status(404).json({ error: '通知不存在或不属于当前用户。' });
      return;
    }
    response.json({ ok: true });
  });

  // 全部标记已读
  app.post('/api/notifications/read-all', requireAuth, (request, response) => {
    db.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL')
      .run(dayjs().toISOString(), request.currentUser.id);
    response.json({ ok: true });
  });

  // 未读通知数
  app.get('/api/notifications/unread-count', requireAuth, (request, response) => {
    const count = db.prepare('SELECT COUNT(*) AS count FROM notifications WHERE user_id = ? AND read_at IS NULL')
      .get(request.currentUser.id).count;
    response.json({ count });
  });

  // 打卡日历 + 连续天数
  app.get('/api/study/streak', requireStudent, (request, response) => {
    const studentId = request.currentUser.id;
    const year = Number(request.query.year) || new Date().getFullYear();
    const month = Number(request.query.month) || new Date().getMonth() + 1;
    const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
    const endDate = `${year}-${String(month).padStart(2, '0')}-31`;

    // 日历天数
    const calendarDays = db.prepare(`
      SELECT DISTINCT date_val AS date FROM (
        SELECT DATE(created_at) AS date_val FROM practice_records WHERE student_id = ? AND DATE(created_at) BETWEEN ? AND ?
        UNION ALL
        SELECT DATE(created_at) AS date_val FROM flashcard_records WHERE student_id = ? AND DATE(created_at) BETWEEN ? AND ?
        UNION ALL
        SELECT DATE(completed_at) AS date_val FROM task_completions WHERE student_id = ? AND completed_at IS NOT NULL AND DATE(completed_at) BETWEEN ? AND ?
      )
      ORDER BY date
    `).all(studentId, startDate, endDate, studentId, startDate, endDate, studentId, startDate, endDate);

    // 连续天数
    const streak = db.prepare('SELECT * FROM study_streaks WHERE student_id = ?').get(studentId);
    const monthDays = calendarDays.length;

    response.json({
      currentStreak: streak ? streak.current_streak : 0,
      longestStreak: streak ? streak.longest_streak : 0,
      lastStudyDate: streak ? streak.last_study_date : null,
      monthDays,
      calendarDays
    });
  });

  // 课程播放进度
  app.get('/api/courses/:id/progress', requireAuth, (request, response) => {
    const row = db.prepare('SELECT position_seconds, duration_seconds, updated_at FROM course_progress WHERE course_id = ? AND student_id = ?')
      .get(request.params.id, request.currentUser.id);
    response.json(row ? { positionSeconds: row.position_seconds, durationSeconds: row.duration_seconds, updatedAt: row.updated_at } : { positionSeconds: 0, durationSeconds: 0 });
  });

  app.post('/api/courses/:id/progress', requireAuth, (request, response) => {
    const positionSeconds = Number(request.body.positionSeconds) || 0;
    const durationSeconds = Number(request.body.durationSeconds) || 0;
    db.prepare(`
      INSERT INTO course_progress (course_id, student_id, position_seconds, duration_seconds, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(course_id, student_id) DO UPDATE SET position_seconds = excluded.position_seconds, duration_seconds = excluded.duration_seconds, updated_at = excluded.updated_at
    `).run(request.params.id, request.currentUser.id, positionSeconds, durationSeconds, dayjs().toISOString());
    response.json({ ok: true });
  });

  // 最近观看课程
  app.get('/api/courses/recent', requireStudent, (request, response) => {
    const studentId = request.currentUser.id;
    const recent = db.prepare(`
      SELECT folder_items.*, course_progress.position_seconds, course_progress.duration_seconds, course_progress.updated_at AS last_watched_at
      FROM course_progress
      JOIN folder_items ON folder_items.id = course_progress.course_id
      WHERE course_progress.student_id = ? AND course_progress.position_seconds > 0
      ORDER BY course_progress.updated_at DESC LIMIT 10
    `).all(studentId);
    response.json({ items: recent });
  });

  // 每日推送
  app.post('/api/tasks/dispatch/daily', shared.requireTeacher, (request, response) => {
    const targetDate = request.body.date || dayjs().format('YYYY-MM-DD');
    const notifications = dispatchDailyDigest(db, sendNotificationToStudent, dayjs(`${targetDate} 07:00`));
    response.json({ ok: true, sent: notifications.length });
  });

  app.post('/api/tasks/dispatch/due', shared.requireTeacher, (request, response) => {
    const targetDate = request.body.date || dayjs().format('YYYY-MM-DD');
    const targetTime = request.body.time || dayjs().format('HH:mm');
    const notifications = dispatchDueTaskReminders(db, sendNotificationToStudent, dayjs(`${targetDate} ${targetTime}`));
    response.json({ ok: true, sent: notifications.length });
  });
};
