const dayjs = require('dayjs');
const { sanitizeText } = require('../utils/sanitize');

module.exports = function registerTeacherRoutes(app, shared) {
  const { db, requireTeacher, serializeTask, serializeSummary, getTasksForStudentOnDate, getAllTasks, getStudents, getTeacherCoreBootstrapData, getTeacherModuleData, safeJsonParse, sendNotificationToStudent, parseWeekdaysInput, resolveStudentIds, createTaskRecord, serializeLiveSession } = shared;

  const MAX_TITLE_LENGTH = 200;

  // 教师端 bootstrap
  app.get('/api/teacher/bootstrap', requireTeacher, (request, response) => {
    const modules = request.query.modules ? request.query.modules.split(',') : null;
    if (modules) {
      response.json(getTeacherModuleData(modules));
    } else {
      response.json(getTeacherCoreBootstrapData(request.currentUser));
    }
  });

  // 教师端 - 学生维度视图
  app.get('/api/teacher/students/overview', requireTeacher, (request, response) => {
    const today = dayjs().format('YYYY-MM-DD');
    // BUG-052: 教师只能查看同班级的学生数据
    const teacherClassName = request.currentUser.class_name || '';
    let students = getStudents();
    if (teacherClassName) {
      students = students.filter((s) => !s.className || s.className === teacherClassName);
    }

    // B-27: 使用批量查询替代 N+1 查询
    const studentIds = students.map((s) => s.id);
    if (!studentIds.length) {
      response.json({ students: [], today });
      return;
    }

    const placeholders = studentIds.map(() => '?').join(',');

    // 批量获取今日任务（获取全部任务后按日期和学生过滤）
    const day = dayjs(today).day();
    const allTasks = getAllTasks(db).filter((task) => task.weekdays.includes(day));
    const tasksByStudent = {};
    allTasks.forEach((task) => {
      const taskStudentIds = task.studentIds || [];
      taskStudentIds.forEach((sid) => {
        if (!tasksByStudent[sid]) tasksByStudent[sid] = [];
        tasksByStudent[sid].push(task);
      });
    });

    // 批量获取任务完成情况
    const completions = db.prepare(
      `SELECT task_id, student_id, completed_at FROM task_completions WHERE task_date = ? AND student_id IN (${placeholders})`
    ).all(today, ...studentIds);
    const completionMap = {};
    completions.forEach((c) => {
      const key = `${c.task_id}_${c.student_id}`;
      if (c.completed_at) completionMap[key] = true;
    });

    // 批量获取最新总结日期
    const latestSummaries = db.prepare(
      `SELECT student_id, MAX(created_at) AS created_at FROM summaries WHERE student_id IN (${placeholders}) GROUP BY student_id`
    ).all(...studentIds);
    const summaryMap = {};
    latestSummaries.forEach((s) => { summaryMap[s.student_id] = s.created_at; });

    // 批量获取练习统计
    const practiceStats = db.prepare(
      `SELECT student_id, COUNT(*) AS total, SUM(CASE WHEN is_correct = 1 THEN 1 ELSE 0 END) AS correct FROM practice_records WHERE student_id IN (${placeholders}) GROUP BY student_id`
    ).all(...studentIds);
    const practiceMap = {};
    practiceStats.forEach((p) => { practiceMap[p.student_id] = p; });

    const overview = students.map((student) => {
      const todaysTasks = tasksByStudent[student.id] || [];
      const completedCount = todaysTasks.filter((task) => completionMap[`${task.id}_${student.id}`]).length;
      const stats = practiceMap[student.id] || { total: 0, correct: 0 };

      return {
        ...student,
        todaysTaskCount: todaysTasks.length,
        todaysCompletedCount: completedCount,
        lastSummaryDate: summaryMap[student.id] || null,
        practiceTotal: stats.total || 0,
        practiceAccuracy: stats.total > 0 ? Math.round(((stats.correct || 0) / stats.total) * 100) : 0
      };
    });

    response.json({ students: overview, today });
  });

  app.get('/api/teacher/students/:id/overview', requireTeacher, (request, response) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id) || id <= 0) return response.status(400).json({ error: '无效的 ID。' });
    // BUG-052: 教师只能查看同班级的学生详情
    const teacherClassName = request.currentUser.class_name || '';
    const student = db.prepare('SELECT * FROM users WHERE id = ? AND role = \'student\'').get(id);
    if (!student) {
      response.status(404).json({ error: '学生不存在。' });
      return;
    }
    if (teacherClassName && student.class_name && student.class_name !== teacherClassName) {
      response.status(403).json({ error: '无权查看该学生的数据。' });
      return;
    }

    const today = dayjs().format('YYYY-MM-DD');
    const todaysTasks = getTasksForStudentOnDate(db, student.id, today).map((task) => {
      const completion = db.prepare(
        'SELECT completed_at FROM task_completions WHERE task_id = ? AND student_id = ? AND task_date = ?'
      ).get(task.id, student.id, today);

      return {
        ...serializeTask(task),
        completed: !!(completion && completion.completed_at)
      };
    });

    const summaries = db.prepare(
      'SELECT * FROM summaries WHERE student_id = ? ORDER BY updated_at DESC LIMIT 10'
    ).all(student.id).map(serializeSummary);

    const practiceStats = db.prepare(
      'SELECT COUNT(*) AS total, SUM(CASE WHEN is_correct = 1 THEN 1 ELSE 0 END) AS correct FROM practice_records WHERE student_id = ?'
    ).get(student.id);

    response.json({
      student: {
        id: student.id,
        username: student.username,
        displayName: student.display_name,
        className: student.class_name
      },
      todaysTasks,
      summaries,
      practiceStats: {
        total: practiceStats.total || 0,
        correct: practiceStats.correct || 0,
        accuracy: practiceStats.total > 0 ? Math.round(((practiceStats.correct || 0) / practiceStats.total) * 100) : 0
      }
    });
  });

  // 教师提醒指定学生未完成任务
  app.post('/api/teacher/students/:id/remind', requireTeacher, (request, response) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id) || id <= 0) return response.status(400).json({ error: '无效的 ID。' });
    const teacherClassName = request.currentUser.class_name || '';
    const student = db.prepare('SELECT * FROM users WHERE id = ? AND role = \'student\'').get(id);
    if (!student) {
      response.status(404).json({ error: '学生不存在。' });
      return;
    }
    if (teacherClassName && student.class_name && student.class_name !== teacherClassName) {
      response.status(403).json({ error: '无权操作该学生。' });
      return;
    }

    const today = dayjs().format('YYYY-MM-DD');
    const todaysTasks = getTasksForStudentOnDate(db, student.id, today);
    const incompleteTasks = todaysTasks.filter((task) => {
      const completion = db.prepare(
        'SELECT completed_at FROM task_completions WHERE task_id = ? AND student_id = ? AND task_date = ?'
      ).get(task.id, student.id, today);
      return !completion || !completion.completed_at;
    });

    if (!incompleteTasks.length) {
      response.json({ ok: true, sent: 0, message: '该学生今日任务已全部完成。' });
      return;
    }

    const taskList = incompleteTasks.map((t) => `${t.start_time}-${t.end_time} ${t.title}`).join('；');
    const now = dayjs().toISOString();
    const notificationTitle = `老师提醒：今日未完成任务 (${today})`;
    const notificationBody = taskList;

    const notifInfo = db.prepare(
      'INSERT INTO notifications (student_id, type, title, body, task_date, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(student.id, '任务提醒', notificationTitle, notificationBody, today, now);

    sendNotificationToStudent(student.id, {
      type: 'notification',
      payload: {
        id: notifInfo.lastInsertRowid,
        studentId: student.id,
        type: '任务提醒',
        title: notificationTitle,
        body: notificationBody,
        taskDate: today,
        readAt: null,
        createdAt: now
      }
    });

    response.json({ ok: true, sent: 1, count: incompleteTasks.length });
  });

  // 创建任务
  app.post('/api/tasks', requireTeacher, (request, response) => {
    const { title, description, subject, startTime, endTime, weekdays, studentIds } = request.body;
    const normalizedWeekdays = parseWeekdaysInput(weekdays);
    const normalizedStudentIds = resolveStudentIds(studentIds);

    if (!title || !startTime || !endTime || !normalizedStudentIds.length) {
      response.status(400).json({ error: '请完整填写任务标题、时间与学生。' });
      return;
    }

    // BUG-005: 输入长度限制
    if (String(title).length > MAX_TITLE_LENGTH) {
      response.status(400).json({ error: `标题不能超过${MAX_TITLE_LENGTH}个字符。` });
      return;
    }

    // BUG-05: 校验 weekdays 非空
    if (!normalizedWeekdays.length) {
      response.status(400).json({ error: '请选择有效的周期（周一至周日）。' });
      return;
    }

    // BUG-006: 校验时间格式为合法 HH:mm
    const timeRegex = /^([01]\d|2[0-3]):([0-5]\d)$/;
    if (!timeRegex.test(String(startTime)) || !timeRegex.test(String(endTime))) {
      response.status(400).json({ error: '时间格式无效，请使用 HH:mm（00:00-23:59）。' });
      return;
    }

    if (startTime >= endTime) {
      response.status(400).json({ error: '结束时间必须晚于开始时间。' });
      return;
    }

    // BUG-04: 校验 studentIds 中的每个 ID 确实是学生
    const validStudents = db.prepare(`SELECT id FROM users WHERE role = 'student' AND id IN (${normalizedStudentIds.map(() => '?').join(',')})`).all(...normalizedStudentIds);
    if (validStudents.length !== normalizedStudentIds.length) {
      response.status(400).json({ error: '包含无效的学生ID，请检查学生列表。' });
      return;
    }

    // BUG-076: 创建任务返回新 ID，并与子任务插入合并为同一事务
    const subtasks = Array.isArray(request.body.subtasks) ? request.body.subtasks.filter((s) => s && String(s).trim()) : [];
    const taskId = db.transaction(() => {
      const id = createTaskRecord({
        title: sanitizeText(title),
        description: sanitizeText(description),
        subject: sanitizeText(subject || '考研规划'),
        startTime: String(startTime).trim(),
        endTime: String(endTime).trim(),
        weekdays: normalizedWeekdays,
        studentIds: normalizedStudentIds,
        teacherId: request.currentUser.id,
        priority: Number(request.body.priority) || 2,
        reminderStart: String(request.body.reminderStart || '').trim(),
        reminderEnd: String(request.body.reminderEnd || '').trim()
      });

      if (subtasks.length) {
        const insertSubtask = db.prepare('INSERT INTO subtasks (task_id, title, sort_order) VALUES (?, ?, ?)');
        subtasks.forEach((s, i) => insertSubtask.run(id, sanitizeText(String(s).trim()), i));
      }

      return id;
    })();

    response.json({ ok: true, id: taskId });
  });

  // 任务批量导入 — 支持"阶段/当日任务/听课链接/时间安排/注意"5 列格式
  app.post('/api/tasks/import', requireTeacher, (request, response) => {
    shared.taskImportUpload(request, response, (error) => {
      if (error) {
        response.status(400).json({ error: '表格上传失败。' });
        return;
      }

      if (!request.file) {
        response.status(400).json({ error: '请先上传 Excel 或 CSV 文件。' });
        return;
      }

      const rows = shared.readWorkbookRows(request.file.path);
      let imported = 0;
      let skipped = 0;

      // 获取老师班级下全部学生
      const teacherClassName = request.currentUser.class_name || '';
      let allStudents = getStudents();
      if (teacherClassName) {
        allStudents = allStudents.filter((s) => !s.className || s.className === teacherClassName);
      }
      const allStudentIds = allStudents.map((s) => s.id);

      const importTasks = db.transaction(() => {
        rows.forEach((row) => {
        const stage = shared.getFieldValue(row, ['阶段']);
        const rawTask = shared.getFieldValue(row, ['当日任务']);
        const listenLink = shared.getFieldValue(row, ['听课链接']);
        const timeArrangement = shared.getFieldValue(row, ['时间安排']);
        const notes = shared.getFieldValue(row, ['注意']);

        if (!rawTask) {
          skipped += 1;
          return;
        }

        // 当日任务拆分：首条为 title，其余加入 description
        const taskLines = String(rawTask).split(/[\n；;]/).map((s) => s.trim()).filter(Boolean);
        const title = taskLines[0].replace(/^[一二三四五六七八九十\d]+[、.．]\s*/, '').trim() || taskLines[0];
        const descriptionLines = taskLines.slice(1);

        // 结构化额外信息，方便前端分开展示
        const extra = {};
        if (descriptionLines.length) extra.tasks = descriptionLines;
        if (listenLink) extra.link = String(listenLink).trim();
        if (timeArrangement) extra.time = String(timeArrangement).trim();
        if (notes) extra.notes = String(notes).trim();

        const description = Object.keys(extra).length ? JSON.stringify(extra) : '';
        const subject = stage ? String(stage).trim() : '考研规划';

        if (!title || !allStudentIds.length) {
          skipped += 1;
          return;
        }

        const taskId = createTaskRecord({
          title: title.substring(0, MAX_TITLE_LENGTH),
          description,
          subject,
          startTime: '00:00',
          endTime: '23:59',
          weekdays: [0, 1, 2, 3, 4, 5, 6],
          studentIds: allStudentIds,
          teacherId: request.currentUser.id
        });

        // 导入任务拆分为子任务
        if (descriptionLines.length) {
          const newTaskId = taskId;
          const insertSubtask = db.prepare('INSERT INTO subtasks (task_id, title, sort_order) VALUES (?, ?, ?)');
          descriptionLines.forEach((line, i) => {
            insertSubtask.run(newTaskId, line, i);
          });
        }

        imported += 1;
      });
      });
      importTasks();

      const fs = require('fs');
      fs.unlink(request.file.path, () => {});
      response.json({ ok: true, imported, skipped });
    });
  });

  // 查看某个任务下学生的提醒时间设置
  app.get('/api/tasks/:id/student-reminders', requireTeacher, (request, response) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id) || id <= 0) return response.status(400).json({ error: '无效的 ID。' });
    const task = db.prepare('SELECT id FROM tasks WHERE id = ?').get(id);
    if (!task) {
      response.status(404).json({ error: '任务不存在。' });
      return;
    }
    const reminders = db.prepare(
      `SELECT sr.student_id, sr.reminder_time, sr.created_at, u.display_name
       FROM student_reminders sr JOIN users u ON u.id = sr.student_id
       WHERE sr.task_id = ? ORDER BY u.display_name`
    ).all(id);
    response.json({ reminders });
  });

  // 教师评语 — 对学生总结写评语
  app.post('/api/summaries/:id/comment', requireTeacher, (request, response) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id) || id <= 0) return response.status(400).json({ error: '无效的 ID。' });
    const { comment } = request.body;
    if (!comment || typeof comment !== 'string' || !comment.trim()) {
      response.status(400).json({ error: '评语内容不能为空。' });
      return;
    }
    if (comment.length > 2000) {
      response.status(400).json({ error: '评语不能超过 2000 个字符。' });
      return;
    }

    const summary = db.prepare(
      `SELECT summaries.*, users.class_name AS student_class
       FROM summaries LEFT JOIN users ON users.id = summaries.student_id
       WHERE summaries.id = ?`
    ).get(id);

    if (!summary) {
      response.status(404).json({ error: '总结不存在。' });
      return;
    }

    const teacherClassName = request.currentUser.class_name || '';
    if (teacherClassName && summary.student_class && summary.student_class !== teacherClassName) {
      response.status(403).json({ error: '无权评论该学生的总结。' });
      return;
    }

    const now = dayjs().toISOString();
    const sanitizedComment = sanitizeText(comment.trim());

    db.prepare('UPDATE summaries SET teacher_comment = ?, commented_at = ? WHERE id = ?')
      .run(sanitizedComment, now, id);

    response.json({ ok: true, teacherComment: sanitizedComment, commentedAt: now });
  });

  // 教师评语 — 删除评语
  app.delete('/api/summaries/:id/comment', requireTeacher, (request, response) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id) || id <= 0) return response.status(400).json({ error: '无效的 ID。' });
    const summary = db.prepare(
      `SELECT summaries.*, users.class_name AS student_class
       FROM summaries LEFT JOIN users ON users.id = summaries.student_id
       WHERE summaries.id = ?`
    ).get(id);

    if (!summary) {
      response.status(404).json({ error: '总结不存在。' });
      return;
    }

    const teacherClassName = request.currentUser.class_name || '';
    if (teacherClassName && summary.student_class && summary.student_class !== teacherClassName) {
      response.status(403).json({ error: '无权操作该总结。' });
      return;
    }

    db.prepare('UPDATE summaries SET teacher_comment = NULL, commented_at = NULL WHERE id = ?')
      .run(id);

    response.json({ ok: true });
  });
};
