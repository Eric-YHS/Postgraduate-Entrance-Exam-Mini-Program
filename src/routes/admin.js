const dayjs = require('dayjs');
const bcrypt = require('bcryptjs');
const { sanitizeText, stripHtml } = require('../utils/sanitize');
const { detectSensitiveWords, invalidateCache } = require('../services/moderation');

module.exports = function registerAdminRoutes(app, shared) {
  const {
    db,
    sanitizeUser,
    requireAdmin,
    requireRole,
    getUserEntitlement,
    setUserEntitlement,
    downgradeExpiredTrials,
    downgradeExpiredPaid,
    createTaskRecord,
    serializeTask,
    serializeOrder,
    serializeSummary,
    serializeCourse,
    serializeLiveSession,
    serializeProduct,
    serializeQuestionForTeacher,
    serializeForumTopic,
    batchLoadForumReplies,
    batchLoadForumLikes,
    safeJsonParse
  } = shared;

  // 管理后台 - 初始数据
  app.get('/api/admin/bootstrap', requireRole(['admin', 'teacher', 'customer_service']), (request, response) => {
    const isAdmin = request.currentUser.role === 'admin';

    const applications = isAdmin
      ? db.prepare('SELECT * FROM teacher_applications ORDER BY created_at DESC').all().map((row) => ({
          id: row.id,
          username: row.username,
          displayName: row.display_name,
          className: row.class_name,
          motivation: row.motivation,
          status: row.status,
          reviewedBy: row.reviewed_by,
          reviewedAt: row.reviewed_at,
          createdAt: row.created_at
        }))
      : [];

    const users = isAdmin
      ? db.prepare('SELECT * FROM users ORDER BY created_at DESC').all().map((row) => ({
          id: row.id,
          username: row.username,
          role: row.role,
          displayName: row.display_name,
          className: row.class_name,
          createdAt: row.created_at
        }))
      : [];

    const stats = {
      totalUsers: db.prepare('SELECT COUNT(*) AS cnt FROM users').get().cnt,
      teacherCount: db.prepare("SELECT COUNT(*) AS cnt FROM users WHERE role = 'teacher'").get().cnt,
      studentCount: db.prepare("SELECT COUNT(*) AS cnt FROM users WHERE role = 'student'").get().cnt,
      pendingApplications: isAdmin ? db.prepare("SELECT COUNT(*) AS cnt FROM teacher_applications WHERE status = 'pending'").get().cnt : 0
    };

    response.json({
      user: sanitizeUser(request.currentUser),
      applications,
      users,
      stats
    });
  });

  // 系统设置
  app.get('/api/admin/settings', requireAdmin, (request, response) => {
    const rows = db.prepare('SELECT key, value, updated_at FROM system_settings ORDER BY key ASC').all();
    const settings = {};
    for (const row of rows) {
      settings[row.key] = row.value;
    }
    response.json({ settings });
  });

  app.put('/api/admin/settings', requireAdmin, (request, response) => {
    const updates = request.body || {};
    const allowedKeys = [
      'site_name',
      'trial_days',
      'course_preview_count',
      'low_stock_threshold',
      'customer_service_account',
      'wx_subscribe_template_id',
      'payment_mode',
      'wechat_appid',
      'wechat_secret',
      'alipay_appid',
      'alipay_private_key',
      'alipay_public_key',
      'sms_access_key',
      'sms_secret',
      'oss_access_key',
      'oss_secret',
      'oss_bucket',
      'oss_region',
      'cdn_domain',
      'robot_api_key',
      'robot_api_endpoint'
    ];
    const now = dayjs().toISOString();
    const updateStmt = db.prepare('UPDATE system_settings SET value = ?, updated_at = ? WHERE key = ?');
    const insertStmt = db.prepare('INSERT OR IGNORE INTO system_settings (key, value, updated_at) VALUES (?, ?, ?)');

    for (const key of Object.keys(updates)) {
      if (!allowedKeys.includes(key)) continue;
      const value = String(updates[key]);
      const result = updateStmt.run(value, now, key);
      if (!result.changes) {
        insertStmt.run(key, value, now);
      }
    }
    response.json({ ok: true });
  });

  // 管理后台 - 审核教师申请
  app.post('/api/admin/applications/:id/approve', requireAdmin, (request, response) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id) || id <= 0) return response.status(400).json({ error: '无效的 ID。' });
    const application = db.prepare('SELECT * FROM teacher_applications WHERE id = ?').get(id);
    if (!application) {
      response.status(404).json({ error: '申请不存在。' });
      return;
    }

    if (application.status !== 'pending') {
      response.status(400).json({ error: '该申请已处理。' });
      return;
    }

    const now = dayjs().toISOString();

    try {
      const approveTransaction = db.transaction(() => {
        // 创建教师账号
        db.prepare(
          `INSERT INTO users (username, password, role, display_name, class_name, created_at)
           VALUES (?, ?, 'teacher', ?, ?, ?)`
        ).run(application.username, application.password, application.display_name, application.class_name, now);

        // BUG-080: 审批后清除申请中的密码
        db.prepare('UPDATE teacher_applications SET status = \'approved\', reviewed_by = ?, reviewed_at = ?, password = \'\' WHERE id = ?')
          .run(request.currentUser.id, now, id);
      });

      approveTransaction();

      response.json({ ok: true });
    } catch (err) {
      if (err.message && err.message.includes('UNIQUE constraint')) {
        response.status(400).json({ error: '用户名已被占用，无法创建账号。' });
        return;
      }
      throw err;
    }
  });

  app.post('/api/admin/applications/:id/reject', requireAdmin, (request, response) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id) || id <= 0) return response.status(400).json({ error: '无效的 ID。' });
    const application = db.prepare('SELECT * FROM teacher_applications WHERE id = ?').get(id);
    if (!application) {
      response.status(404).json({ error: '申请不存在。' });
      return;
    }

    if (application.status !== 'pending') {
      response.status(400).json({ error: '该申请已处理。' });
      return;
    }

    const now = dayjs().toISOString();
    db.prepare('UPDATE teacher_applications SET status = \'rejected\', reviewed_by = ?, reviewed_at = ? WHERE id = ?')
      .run(request.currentUser.id, now, id);

    response.json({ ok: true });
  });

  // 管理后台 - 用户管理
  app.get('/api/admin/users', requireRole(['admin', 'customer_service']), (request, response) => {
    const { search } = request.query;
    let { role } = request.query;
    const limit = Math.min(Number(request.query.limit) || 100, 500);
    const offset = Number(request.query.offset) || 0;

    // 客服只能查看学生
    if (request.currentUser.role === 'customer_service') {
      role = 'student';
    }

    let query = 'SELECT * FROM users WHERE 1=1';
    const params = [];

    if (role) {
      query += ' AND role = ?';
      params.push(role);
    }

    if (search) {
      // BUG-059: 转义 LIKE 通配符
      const safeSearch = String(search).replace(/[%_]/g, '\\$&');
      query += " AND (username LIKE ? ESCAPE '\\' OR display_name LIKE ? ESCAPE '\\')";
      params.push(`%${safeSearch}%`, `%${safeSearch}%`);
    }

    query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const users = db.prepare(query).all(...params).map((row) => ({
      id: row.id,
      username: row.username,
      role: row.role,
      displayName: row.display_name,
      className: row.class_name,
      createdAt: row.created_at
    }));

    response.json({ users });
  });

  app.put('/api/admin/users/:id', requireAdmin, (request, response) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id) || id <= 0) return response.status(400).json({ error: '无效的 ID。' });
    const targetUser = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!targetUser) {
      response.status(404).json({ error: '用户不存在。' });
      return;
    }

    const { displayName, className, role } = request.body;
    const updates = [];
    const params = [];

    if (displayName !== undefined) {
      updates.push('display_name = ?');
      params.push(sanitizeText(displayName));
    }

    if (className !== undefined) {
      updates.push('class_name = ?');
      params.push(sanitizeText(className));
    }

    if (role !== undefined) {
      if (!['teacher', 'student', 'admin', 'customer_service'].includes(role)) {
        response.status(400).json({ error: '无效的角色类型。' });
        return;
      }
      if (role && targetUser.role === 'admin' && role !== 'admin') {
        const adminCount = db.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin'").get().count;
        if (adminCount <= 1) {
          response.status(400).json({ error: '不能移除唯一的管理员。' });
          return;
        }
      }
      updates.push('role = ?');
      params.push(role);
    }

    if (!updates.length) {
      response.status(400).json({ error: '没有需要更新的字段。' });
      return;
    }

    params.push(id);
    db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    response.json({ ok: true });
  });

  app.delete('/api/admin/users/:id', requireAdmin, (request, response) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id) || id <= 0) return response.status(400).json({ error: '无效的 ID。' });
    const targetUser = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!targetUser) {
      response.status(404).json({ error: '用户不存在。' });
      return;
    }

    if (targetUser.role === 'admin') {
      response.status(400).json({ error: '不能删除管理员账号。' });
      return;
    }

    // 清理该用户的所有关联数据，避免外键约束报错
    const uid = targetUser.id;
    const cleanup = db.transaction(() => {
      db.prepare('DELETE FROM auth_tokens WHERE user_id = ?').run(uid);
      db.prepare('DELETE FROM practice_records WHERE student_id = ?').run(uid);
      db.prepare('DELETE FROM practice_sessions WHERE student_id = ?').run(uid);
      db.prepare('DELETE FROM flashcard_records WHERE student_id = ?').run(uid);
      db.prepare('DELETE FROM task_completions WHERE student_id = ?').run(uid);
      db.prepare('DELETE FROM task_completions WHERE task_id IN (SELECT id FROM tasks WHERE created_by = ?)').run(uid);
      db.prepare('DELETE FROM subtask_completions WHERE student_id = ?').run(uid);
      db.prepare('DELETE FROM subtasks WHERE task_id IN (SELECT id FROM tasks WHERE created_by = ?)').run(uid);
      db.prepare('DELETE FROM student_reminders WHERE student_id = ?').run(uid);
      db.prepare('DELETE FROM study_streaks WHERE student_id = ?').run(uid);
      db.prepare('DELETE FROM habit_tracking WHERE student_id = ?').run(uid);
      db.prepare('DELETE FROM ai_conversations WHERE user_id = ?').run(uid);
      db.prepare('DELETE FROM course_progress WHERE student_id = ?').run(uid);
      db.prepare('DELETE FROM course_reviews WHERE student_id = ?').run(uid);
      db.prepare('DELETE FROM shopping_cart WHERE student_id = ?').run(uid);
      db.prepare('DELETE FROM question_favorites WHERE student_id = ?').run(uid);
      db.prepare('DELETE FROM forum_favorites WHERE user_id = ?').run(uid);
      db.prepare('DELETE FROM forum_likes WHERE user_id = ?').run(uid);
      db.prepare('DELETE FROM live_reservations WHERE student_id = ?').run(uid);
      db.prepare('DELETE FROM live_poll_votes WHERE user_id = ?').run(uid);
      db.prepare('DELETE FROM notifications WHERE student_id = ?').run(uid);
      db.prepare('DELETE FROM summaries WHERE student_id = ?').run(uid);
      db.prepare('DELETE FROM orders WHERE student_id = ?').run(uid);
      db.prepare('DELETE FROM address_book WHERE student_id = ?').run(uid);
      db.prepare('DELETE FROM live_messages WHERE user_id = ?').run(uid);
      db.prepare('DELETE FROM forum_replies WHERE user_id = ?').run(uid);
      db.prepare('DELETE FROM forum_topics WHERE user_id = ?').run(uid);
      db.prepare('DELETE FROM folder_items WHERE created_by = ?').run(uid);
      db.prepare('DELETE FROM folders WHERE created_by = ?').run(uid);
      db.prepare('DELETE FROM question_tag_relations WHERE question_id IN (SELECT id FROM questions WHERE created_by = ?)').run(uid);
      db.prepare('DELETE FROM questions WHERE created_by = ?').run(uid);
      db.prepare('DELETE FROM flashcards WHERE created_by = ?').run(uid);
      db.prepare('DELETE FROM tasks WHERE created_by = ?').run(uid);
      db.prepare('DELETE FROM products WHERE created_by = ?').run(uid);
      db.prepare('DELETE FROM courses WHERE created_by = ?').run(uid);
      db.prepare('DELETE FROM live_messages WHERE live_session_id IN (SELECT id FROM live_sessions WHERE created_by = ?)').run(uid);
      db.prepare('DELETE FROM live_sessions WHERE created_by = ?').run(uid);
      db.prepare('DELETE FROM teacher_applications WHERE reviewed_by = ?').run(uid);
      db.prepare('DELETE FROM users WHERE id = ?').run(uid);
    });

    cleanup();
    response.status(204).end();
  });

  // 权益管理
  app.get('/api/admin/entitlements/:userId', requireRole(['admin', 'teacher', 'customer_service']), (request, response) => {
    const userId = Number(request.params.userId);
    if (!Number.isInteger(userId) || userId <= 0) return response.status(400).json({ error: '无效的用户 ID。' });
    const entitlement = getUserEntitlement(userId);
    response.json({ entitlement });
  });

  app.post('/api/admin/entitlements/:userId', requireRole(['admin', 'customer_service']), (request, response) => {
    const userId = Number(request.params.userId);
    if (!Number.isInteger(userId) || userId <= 0) return response.status(400).json({ error: '无效的用户 ID。' });
    try {
      setUserEntitlement(userId, request.body || {});
      response.json({ ok: true, entitlement: getUserEntitlement(userId) });
    } catch (error) {
      response.status(400).json({ error: error.message });
    }
  });

  app.post('/api/entitlements/check-expired', requireAdmin, (request, response) => {
    const trialDowngraded = downgradeExpiredTrials();
    const paidDowngraded = downgradeExpiredPaid();
    response.json({ trialDowngraded, paidDowngraded });
  });

  app.get('/api/entitlements/me', requireRole(['student']), (request, response) => {
    const entitlement = getUserEntitlement(request.currentUser.id);
    response.json({ entitlement });
  });

  // 学员管理：列表与筛选
  app.get('/api/admin/students', requireRole(['admin', 'teacher', 'customer_service']), (request, response) => {
    const { tier, className, subject, active7days, incompleteTasks, search } = request.query;
    const limit = Math.min(Number(request.query.limit) || 100, 500);
    const offset = Number(request.query.offset) || 0;

    let query = `
      SELECT users.*, ue.tier, ue.trial_ended_at, ue.paid_until, ue.unlocked_subjects, ue.package_type
      FROM users
      LEFT JOIN user_entitlements ue ON ue.student_id = users.id
      WHERE users.role = 'student'
    `;
    const params = [];

    if (tier) {
      query += ' AND ue.tier = ?';
      params.push(tier);
    }
    if (className) {
      query += ' AND users.class_name = ?';
      params.push(className);
    }
    if (search) {
      const safeSearch = String(search).replace(/[%_]/g, '\\$&');
      query += " AND (users.username LIKE ? ESCAPE '\\' OR users.display_name LIKE ? ESCAPE '\\')";
      params.push(`%${safeSearch}%`, `%${safeSearch}%`);
    }

    query += ' ORDER BY users.created_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const rows = db.prepare(query).all(...params);
    const today = dayjs().format('YYYY-MM-DD');
    const sevenDaysAgo = dayjs().subtract(7, 'day').format('YYYY-MM-DD');

    const students = rows.map((row) => {
      const entitlement = getUserEntitlement(row.id);
      const trialDaysLeft = entitlement.trialEndedAt
        ? Math.max(0, Math.ceil((dayjs(entitlement.trialEndedAt).valueOf() - Date.now()) / (1000 * 60 * 60 * 24)))
        : 0;
      const todayCompleted = db.prepare(`
        SELECT COUNT(*) AS cnt FROM task_completions
        WHERE student_id = ? AND task_date = ? AND completed_at IS NOT NULL
      `).get(row.id, today).cnt;
      const totalQuestions = db.prepare('SELECT COUNT(*) AS cnt FROM practice_records WHERE student_id = ?').get(row.id).cnt;
      const correctQuestions = db.prepare('SELECT COUNT(*) AS cnt FROM practice_records WHERE student_id = ? AND is_correct = 1').get(row.id).cnt;
      const lastStudy = db.prepare(`
        SELECT MAX(created_at) AS last_at FROM (
          SELECT created_at FROM practice_records WHERE student_id = ?
          UNION ALL
          SELECT created_at FROM task_completions WHERE student_id = ? AND completed_at IS NOT NULL
          UNION ALL
          SELECT updated_at AS created_at FROM summaries WHERE student_id = ?
        )
      `).get(row.id, row.id, row.id).last_at;
      const lastSummary = db.prepare('SELECT updated_at FROM summaries WHERE student_id = ? ORDER BY updated_at DESC LIMIT 1').get(row.id);
      const incompleteTaskCount = db.prepare(`
        SELECT COUNT(*) AS cnt FROM tasks
        WHERE student_ids LIKE ? AND (
          SELECT COUNT(*) FROM task_completions
          WHERE task_completions.task_id = tasks.id AND task_completions.student_id = ? AND task_completions.task_date = ? AND task_completions.completed_at IS NOT NULL
        ) = 0
      `).get(`%${row.id}%`, row.id, today).cnt;
      const activeRecent = db.prepare(`
        SELECT COUNT(*) AS cnt FROM (
          SELECT created_at FROM practice_records WHERE student_id = ? AND DATE(created_at) >= ?
          UNION ALL
          SELECT completed_at AS created_at FROM task_completions WHERE student_id = ? AND task_date >= ? AND completed_at IS NOT NULL
        )
      `).get(row.id, sevenDaysAgo, row.id, sevenDaysAgo).cnt;

      return {
        id: row.id,
        username: row.username,
        displayName: row.display_name,
        className: row.class_name,
        tier: entitlement.effectiveTier || entitlement.tier,
        trialDaysLeft,
        unlockedSubjects: entitlement.unlockedSubjects,
        todayCompleted,
        lastStudyAt: lastStudy || null,
        totalQuestions: totalQuestions || 0,
        accuracy: totalQuestions > 0 ? Math.round((correctQuestions / totalQuestions) * 100) : 0,
        lastSummaryAt: lastSummary ? lastSummary.updated_at : null,
        incompleteTaskCount: incompleteTaskCount || 0,
        activeRecent: activeRecent > 0
      };
    });

    response.json({ students });
  });

  // 学员详情：学习档案
  app.get('/api/admin/students/:id', requireRole(['admin', 'teacher', 'customer_service']), (request, response) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id) || id <= 0) return response.status(400).json({ error: '无效的学员 ID。' });

    const student = db.prepare('SELECT * FROM users WHERE id = ? AND role = ?').get(id, 'student');
    if (!student) return response.status(404).json({ error: '学员不存在。' });

    const entitlement = getUserEntitlement(id);
    const today = dayjs().format('YYYY-MM-DD');
    const last30Days = dayjs().subtract(30, 'day').format('YYYY-MM-DD');

    // 任务完成日历（最近 30 天）
    const completions = db.prepare(`
      SELECT task_date, COUNT(*) AS cnt FROM task_completions
      WHERE student_id = ? AND task_date >= ? AND completed_at IS NOT NULL
      GROUP BY task_date ORDER BY task_date DESC
    `).all(id, last30Days);

    // 每日总结
    const summaries = db.prepare('SELECT * FROM summaries WHERE student_id = ? ORDER BY task_date DESC LIMIT 30').all(id).map(serializeSummary);

    // 课程观看进度
    const courseProgress = db.prepare(`
      SELECT cp.*, fi.title AS item_title
      FROM course_progress cp
      LEFT JOIN folder_items fi ON fi.id = cp.course_id
      WHERE cp.student_id = ? ORDER BY cp.updated_at DESC LIMIT 50
    `).all(id);

    // 做题统计
    const totalQuestions = db.prepare('SELECT COUNT(*) AS cnt FROM practice_records WHERE student_id = ?').get(id).cnt;
    const correctQuestions = db.prepare('SELECT COUNT(*) AS cnt FROM practice_records WHERE student_id = ? AND is_correct = 1').get(id).cnt;
    const subjectStats = db.prepare(`
      SELECT q.subject, COUNT(*) AS total, SUM(CASE WHEN pr.is_correct = 1 THEN 1 ELSE 0 END) AS correct
      FROM practice_records pr JOIN questions q ON q.id = pr.question_id
      WHERE pr.student_id = ? GROUP BY q.subject
    `).all(id);

    // 错题分布（按科目）
    const wrongDistribution = db.prepare(`
      SELECT q.subject, COUNT(*) AS cnt
      FROM practice_records pr JOIN questions q ON q.id = pr.question_id
      WHERE pr.student_id = ? AND pr.is_correct = 0 GROUP BY q.subject
    `).all(id);

    // 词汇学习数据
    const flashcardStats = db.prepare(`
      SELECT COUNT(*) AS total, SUM(CASE WHEN repetitions > 0 THEN 1 ELSE 0 END) AS learned
      FROM flashcard_records WHERE student_id = ?
    `).get(id);

    // 订单记录
    const orders = db.prepare(`
      SELECT orders.*, products.title AS product_title FROM orders
      LEFT JOIN products ON products.id = orders.product_id
      WHERE orders.student_id = ? ORDER BY orders.created_at DESC LIMIT 50
    `).all(id).map(serializeOrder);

    // 专属复习计划
    const personalPlans = db.prepare(`
      SELECT tasks.*, users.display_name AS teacher_name
      FROM tasks LEFT JOIN users ON users.id = tasks.created_by
      WHERE tasks.plan_type = 'personal' AND tasks.student_ids LIKE ?
      ORDER BY tasks.created_at DESC
    `).get(`%${id}%`); // 只取一条？应 all

    // 修正：使用 all 而不是 get
    const personalPlansRows = db.prepare(`
      SELECT tasks.*, users.display_name AS teacher_name
      FROM tasks LEFT JOIN users ON users.id = tasks.created_by
      WHERE tasks.plan_type = 'personal' AND tasks.student_ids LIKE ?
      ORDER BY tasks.created_at DESC
    `).all(`%${id}%`);

    response.json({
      student: sanitizeUser(student),
      entitlement,
      taskCalendar: completions,
      summaries,
      courseProgress,
      practiceStats: {
        totalQuestions: totalQuestions || 0,
        correctQuestions: correctQuestions || 0,
        accuracy: totalQuestions > 0 ? Math.round((correctQuestions / totalQuestions) * 100) : 0,
        subjectStats,
        wrongDistribution
      },
      flashcardStats: {
        total: flashcardStats.total || 0,
        learned: flashcardStats.learned || 0
      },
      orders,
      personalPlans: personalPlansRows.map(serializeTask)
    });
  });

  // 创建专属复习计划
  app.post('/api/admin/students/:id/plans', requireRole(['admin', 'teacher']), (request, response) => {
    const studentId = Number(request.params.id);
    if (!Number.isInteger(studentId) || studentId <= 0) return response.status(400).json({ error: '无效的学员 ID。' });

    const student = db.prepare('SELECT * FROM users WHERE id = ? AND role = ?').get(studentId, 'student');
    if (!student) return response.status(404).json({ error: '学员不存在。' });

    const entitlement = getUserEntitlement(studentId);
    const effectiveTier = entitlement.effectiveTier || entitlement.tier;
    if (effectiveTier !== 'paid') {
      response.status(400).json({ error: '只有付费学员才能创建专属复习计划。' });
      return;
    }

    const { title, description, subject, startTime, endTime, weekdays } = request.body;
    if (!title || !startTime || !endTime) {
      response.status(400).json({ error: '请填写计划标题、开始和结束时间。' });
      return;
    }

    const taskId = createTaskRecord({
      title,
      description,
      subject,
      startTime,
      endTime,
      weekdays: weekdays || [0, 1, 2, 3, 4, 5, 6],
      studentIds: [studentId],
      teacherId: request.currentUser.id,
      priority: 2
    });

    db.prepare("UPDATE tasks SET plan_type = 'personal' WHERE id = ?").run(taskId);
    response.json({ ok: true, taskId });
  });

  // ===== P4 内容、题库、论坛运营 =====

  // 内容管理：统一查询课程/网盘文件/直播/商品
  app.get('/api/admin/content', requireRole(['admin', 'teacher']), (request, response) => {
    const { type } = request.query;
    let result = {};
    if (!type || type === 'courses') {
      result.courses = db.prepare('SELECT courses.*, users.display_name AS teacher_name FROM courses LEFT JOIN users ON users.id = courses.created_by ORDER BY courses.created_at DESC LIMIT 200').all().map(serializeCourse);
    }
    if (!type || type === 'folder_items') {
      const items = db.prepare('SELECT folder_items.*, users.display_name AS teacher_name, folders.name AS folder_name FROM folder_items LEFT JOIN users ON users.id = folder_items.created_by LEFT JOIN folders ON folders.id = folder_items.folder_id ORDER BY folder_items.created_at DESC LIMIT 200').all();
      result.folderItems = items.map((row) => ({
        id: row.id,
        folderId: row.folder_id,
        folderName: row.folder_name,
        chapterId: row.chapter_id || null,
        itemType: row.item_type,
        title: row.title,
        description: row.description,
        subject: row.subject,
        visibility: row.visibility || 'free',
        subjectScope: row.subject_scope || '',
        sortOrder: row.sort_order || 0,
        isFreePreview: row.is_free_preview || 0,
        createdBy: row.created_by,
        teacherName: row.teacher_name,
        createdAt: row.created_at
      }));
    }
    if (!type || type === 'live_sessions') {
      result.liveSessions = db.prepare('SELECT live_sessions.*, users.display_name AS teacher_name FROM live_sessions LEFT JOIN users ON users.id = live_sessions.created_by ORDER BY live_sessions.created_at DESC LIMIT 200').all().map(serializeLiveSession);
    }
    if (!type || type === 'products') {
      let productQuery = 'SELECT products.*, users.display_name AS teacher_name FROM products LEFT JOIN users ON users.id = products.created_by';
      const productParams = [];
      // B-14: 支持低库存阈值参数
      const lowStockThreshold = Number(request.query.low_stock_threshold) || Number(getSetting('low_stock_threshold', '10'));
      result.products = db.prepare(productQuery + ' ORDER BY products.created_at DESC LIMIT 200').all(...productParams).map((row) => {
        const product = serializeProduct(row);
        product.isLowStock = product.stock <= lowStockThreshold;
        return product;
      });
    }
    response.json(result);
  });

  // 内容管理：更新可见性/科目范围/状态/上架下架
  app.put('/api/admin/content/:type/:id', requireRole(['admin', 'teacher']), (request, response) => {
    const type = request.params.type;
    const id = Number(request.params.id);
    if (!Number.isInteger(id) || id <= 0) return response.status(400).json({ error: '无效的 ID。' });

    const tableMap = {
      courses: 'courses',
      folder_items: 'folder_items',
      live_sessions: 'live_sessions',
      products: 'products'
    };
    const table = tableMap[type];
    if (!table) return response.status(400).json({ error: '无效的内容类型。' });

    const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
    if (!row) return response.status(404).json({ error: '内容不存在。' });

    if (request.currentUser.role === 'teacher' && row.created_by !== request.currentUser.id) {
      return response.status(403).json({ error: '无权修改他人创建的内容。' });
    }

    const updates = [];
    const params = [];

    if (request.body.visibility !== undefined) {
      updates.push('visibility = ?');
      params.push(request.body.visibility);
    }
    if (request.body.subjectScope !== undefined) {
      updates.push('subject_scope = ?');
      params.push(sanitizeText(request.body.subjectScope));
    }
    if (request.body.status !== undefined && table === 'products') {
      updates.push('status = ?');
      params.push(request.body.status);
    }
    if (request.body.subject !== undefined) {
      updates.push('subject = ?');
      params.push(sanitizeText(request.body.subject));
    }
    if (request.body.isPaidOnly !== undefined && table === 'folder_items') {
      updates.push('is_paid_only = ?');
      params.push(request.body.isPaidOnly ? 1 : 0);
    }
    if (request.body.isFreePreview !== undefined && table === 'folder_items') {
      updates.push('is_free_preview = ?');
      params.push(request.body.isFreePreview ? 1 : 0);
    }
    if (request.body.sortOrder !== undefined && table === 'folder_items') {
      updates.push('sort_order = ?');
      params.push(Number(request.body.sortOrder) || 0);
    }
    if (request.body.chapterId !== undefined && table === 'folder_items') {
      updates.push('chapter_id = ?');
      params.push(request.body.chapterId ? Number(request.body.chapterId) : null);
    }
    if (request.body.categoryId !== undefined && table === 'courses') {
      updates.push('category_id = ?');
      params.push(request.body.categoryId ? Number(request.body.categoryId) : null);
    }

    if (!updates.length) return response.status(400).json({ error: '没有需要更新的字段。' });

    params.push(id);
    db.prepare(`UPDATE ${table} SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    response.json({ ok: true });
  });

  // 内容管理：删除
  app.delete('/api/admin/content/:type/:id', requireRole(['admin', 'teacher']), (request, response) => {
    const type = request.params.type;
    const id = Number(request.params.id);
    if (!Number.isInteger(id) || id <= 0) return response.status(400).json({ error: '无效的 ID。' });

    const tableMap = { courses: 'courses', folder_items: 'folder_items', live_sessions: 'live_sessions', products: 'products' };
    const table = tableMap[type];
    if (!table) return response.status(400).json({ error: '无效的内容类型。' });

    const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
    if (!row) return response.status(404).json({ error: '内容不存在。' });

    if (request.currentUser.role === 'teacher' && row.created_by !== request.currentUser.id) {
      return response.status(403).json({ error: '无权删除他人创建的内容。' });
    }

    db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);
    response.status(204).end();
  });

  // 题库管理：列表与筛选
  app.get('/api/admin/questions', requireRole(['admin', 'teacher']), (request, response) => {
    const { subject, questionType, textbook, sourceYear, difficulty, isPaidOnly } = request.query;
    let query = 'SELECT questions.*, users.display_name AS teacher_name FROM questions LEFT JOIN users ON users.id = questions.created_by WHERE 1=1';
    const params = [];

    if (subject) { query += ' AND questions.subject = ?'; params.push(subject); }
    if (questionType) { query += ' AND questions.question_type = ?'; params.push(questionType); }
    if (textbook) { query += ' AND questions.textbook = ?'; params.push(textbook); }
    if (sourceYear) { query += ' AND questions.source_year = ?'; params.push(sourceYear); }
    if (difficulty) { query += ' AND questions.difficulty = ?'; params.push(difficulty); }
    if (isPaidOnly !== undefined) { query += ' AND questions.is_paid_only = ?'; params.push(Number(isPaidOnly)); }

    query += ' ORDER BY questions.created_at DESC LIMIT 200';
    const questions = db.prepare(query).all(...params).map(serializeQuestionForTeacher);
    response.json({ questions });
  });

  // 题库管理：详情
  app.get('/api/admin/questions/:id', requireRole(['admin', 'teacher']), (request, response) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id) || id <= 0) return response.status(400).json({ error: '无效的 ID。' });
    const question = db.prepare('SELECT * FROM questions WHERE id = ?').get(id);
    if (!question) return response.status(404).json({ error: '题目不存在。' });
    response.json({ question: serializeQuestionForTeacher(question) });
  });

  // 题库管理：编辑
  app.put('/api/admin/questions/:id', requireRole(['admin', 'teacher']), (request, response) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id) || id <= 0) return response.status(400).json({ error: '无效的 ID。' });
    const question = db.prepare('SELECT * FROM questions WHERE id = ?').get(id);
    if (!question) return response.status(404).json({ error: '题目不存在。' });
    if (request.currentUser.role === 'teacher' && question.created_by !== request.currentUser.id) {
      return response.status(403).json({ error: '无权修改他人创建的题目。' });
    }

    const body = request.body || {};
    const options = Array.isArray(body.options) ? body.options : safeJsonParse(body.options, []);
    const correctAnswer = String(body.correctAnswer || '').trim().toUpperCase();

    if (options.length && (!correctAnswer || !options.some((o) => o.key === correctAnswer))) {
      return response.status(400).json({ error: '正确答案必须属于已有选项。' });
    }

    const updates = [];
    const params = [];

    if (body.title !== undefined) { updates.push('title = ?'); params.push(stripHtml(body.title)); }
    if (body.subject !== undefined) { updates.push('subject = ?'); params.push(sanitizeText(body.subject)); }
    if (body.questionType !== undefined) { updates.push('question_type = ?'); params.push(sanitizeText(body.questionType)); }
    if (body.textbook !== undefined) { updates.push('textbook = ?'); params.push(sanitizeText(body.textbook)); }
    if (body.sourceYear !== undefined) { updates.push('source_year = ?'); params.push(sanitizeText(body.sourceYear)); }
    if (body.difficulty !== undefined) { updates.push('difficulty = ?'); params.push(sanitizeText(body.difficulty)); }
    if (body.stem !== undefined) { updates.push('stem = ?'); params.push(stripHtml(body.stem)); }
    if (Array.isArray(body.options)) { updates.push('options = ?'); params.push(JSON.stringify(options)); }
    if (body.correctAnswer !== undefined) { updates.push('correct_answer = ?'); params.push(correctAnswer); }
    if (body.analysisText !== undefined) { updates.push('analysis_text = ?'); params.push(sanitizeText(body.analysisText)); }
    if (body.tags !== undefined) { updates.push('tags = ?'); params.push(JSON.stringify(Array.isArray(body.tags) ? body.tags : [])); }
    if (body.isPaidOnly !== undefined) { updates.push('is_paid_only = ?'); params.push(body.isPaidOnly ? 1 : 0); }
    if (body.subjectScope !== undefined) { updates.push('subject_scope = ?'); params.push(sanitizeText(body.subjectScope)); }

    if (!updates.length) return response.status(400).json({ error: '没有需要更新的字段。' });

    params.push(id);
    db.prepare(`UPDATE questions SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    response.json({ ok: true });
  });

  // 题库管理：删除
  app.delete('/api/admin/questions/:id', requireRole(['admin', 'teacher']), (request, response) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id) || id <= 0) return response.status(400).json({ error: '无效的 ID。' });
    const question = db.prepare('SELECT * FROM questions WHERE id = ?').get(id);
    if (!question) return response.status(404).json({ error: '题目不存在。' });
    if (request.currentUser.role === 'teacher' && question.created_by !== request.currentUser.id) {
      return response.status(403).json({ error: '无权删除他人创建的题目。' });
    }
    db.prepare('DELETE FROM questions WHERE id = ?').run(id);
    response.status(204).end();
  });

  // 论坛管理：帖子列表
  app.get('/api/admin/forum/topics', requireRole(['admin', 'teacher', 'customer_service']), (request, response) => {
    const { status, category } = request.query;
    let query = `
      SELECT forum_topics.*, users.display_name AS author_name, users.role AS author_role
      FROM forum_topics LEFT JOIN users ON users.id = forum_topics.user_id WHERE 1=1
    `;
    const params = [];
    if (status) { query += ' AND forum_topics.status = ?'; params.push(status); }
    if (category) { query += ' AND forum_topics.category = ?'; params.push(category); }
    query += ' ORDER BY forum_topics.is_pinned DESC, forum_topics.created_at DESC LIMIT 200';
    const topics = db.prepare(query).all(...params);
    const replies = batchLoadForumReplies(topics.map((t) => t.id), { includePending: true });
    const likes = batchLoadForumLikes(topics.map((t) => t.id));
    response.json({ topics: topics.map((t) => serializeForumTopic(t, replies, likes)) });
  });

  // 论坛管理：回复列表
  app.get('/api/admin/forum/replies', requireRole(['admin', 'teacher', 'customer_service']), (request, response) => {
    const { topicId } = request.query;
    let query = `
      SELECT forum_replies.*, users.display_name AS author_name, users.role AS author_role
      FROM forum_replies LEFT JOIN users ON users.id = forum_replies.user_id
    `;
    const params = [];
    if (topicId) { query += ' WHERE forum_replies.topic_id = ?'; params.push(Number(topicId)); }
    query += ' ORDER BY forum_replies.created_at DESC LIMIT 200';
    const replies = db.prepare(query).all(...params);
    response.json({ replies });
  });

  // 论坛管理：举报列表
  app.get('/api/admin/forum/reports', requireRole(['admin', 'teacher', 'customer_service']), (request, response) => {
    const { status } = request.query;
    let query = `
      SELECT content_reports.*, reporter.display_name AS reporter_name
      FROM content_reports
      LEFT JOIN users reporter ON reporter.id = content_reports.reporter_id
      WHERE 1=1
    `;
    const params = [];
    if (status) { query += ' AND content_reports.status = ?'; params.push(status); }
    query += ' ORDER BY content_reports.created_at DESC LIMIT 200';
    const reports = db.prepare(query).all(...params);
    response.json({ reports });
  });

  // 论坛管理：删除帖子/回复
  app.delete('/api/admin/forum/topics/:id', requireRole(['admin', 'teacher', 'customer_service']), (request, response) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id) || id <= 0) return response.status(400).json({ error: '无效的 ID。' });
    db.prepare('DELETE FROM forum_topics WHERE id = ?').run(id);
    response.status(204).end();
  });

  app.delete('/api/admin/forum/replies/:id', requireRole(['admin', 'teacher', 'customer_service']), (request, response) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id) || id <= 0) return response.status(400).json({ error: '无效的 ID。' });
    db.prepare('DELETE FROM forum_replies WHERE id = ?').run(id);
    response.status(204).end();
  });

  // 论坛管理：置顶/精华
  app.post('/api/admin/forum/topics/:id/pin', requireRole(['admin', 'teacher']), (request, response) => {
    const id = Number(request.params.id);
    const pinned = request.body.pinned === true || request.body.pinned === 1 ? 1 : 0;
    db.prepare('UPDATE forum_topics SET is_pinned = ? WHERE id = ?').run(pinned, id);
    response.json({ ok: true });
  });

  app.post('/api/admin/forum/topics/:id/featured', requireRole(['admin', 'teacher']), (request, response) => {
    const id = Number(request.params.id);
    const featured = request.body.featured === true || request.body.featured === 1 ? 1 : 0;
    db.prepare('UPDATE forum_topics SET is_featured = ? WHERE id = ?').run(featured, id);
    response.json({ ok: true });
  });

  // 论坛管理：举报审核
  app.post('/api/admin/forum/reports/:id/review', requireRole(['admin', 'teacher', 'customer_service']), (request, response) => {
    const id = Number(request.params.id);
    const { status } = request.body;
    if (!['pending', 'reviewed', 'dismissed'].includes(status)) {
      return response.status(400).json({ error: '无效的举报状态。' });
    }
    db.prepare('UPDATE content_reports SET status = ? WHERE id = ?').run(status, id);
    response.json({ ok: true });
  });

  // ===== 论坛内容审核（敏感词 / 人工二审） =====

  app.get('/api/admin/moderation/words', requireRole(['admin', 'teacher']), (_request, response) => {
    const words = db.prepare('SELECT * FROM sensitive_words ORDER BY level, word ASC').all();
    response.json({ words });
  });

  app.post('/api/admin/moderation/words', requireRole(['admin', 'teacher']), (request, response) => {
    const { word, level = 'review' } = request.body || {};
    const cleanWord = String(word || '').trim();
    if (!cleanWord) return response.status(400).json({ error: '敏感词不能为空。' });
    if (!['block', 'review'].includes(level)) return response.status(400).json({ error: '无效的级别。' });
    try {
      db.prepare('INSERT INTO sensitive_words (word, level, created_at) VALUES (?, ?, ?)').run(cleanWord, level, dayjs().toISOString());
      invalidateCache();
      response.json({ ok: true });
    } catch (err) {
      if (err.message && err.message.includes('UNIQUE constraint')) {
        return response.status(400).json({ error: '该敏感词已存在。' });
      }
      throw err;
    }
  });

  app.delete('/api/admin/moderation/words/:id', requireRole(['admin', 'teacher']), (request, response) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id) || id <= 0) return response.status(400).json({ error: '无效的 ID。' });
    db.prepare('DELETE FROM sensitive_words WHERE id = ?').run(id);
    invalidateCache();
    response.status(204).end();
  });

  app.get('/api/admin/moderation/pending', requireRole(['admin', 'teacher', 'customer_service']), (_request, response) => {
    const topics = db.prepare(`
      SELECT forum_topics.*, users.display_name AS author_name, users.role AS author_role
      FROM forum_topics LEFT JOIN users ON users.id = forum_topics.user_id
      WHERE forum_topics.moderation_status = 'pending'
      ORDER BY forum_topics.created_at DESC LIMIT 200
    `).all();
    const replies = db.prepare(`
      SELECT forum_replies.*, users.display_name AS author_name, users.role AS author_role
      FROM forum_replies LEFT JOIN users ON users.id = forum_replies.user_id
      WHERE forum_replies.moderation_status = 'pending'
      ORDER BY forum_replies.created_at DESC LIMIT 200
    `).all();
    response.json({ topics, replies });
  });

  function updateModerationStatus(table, id, status) {
    if (!['approved', 'rejected'].includes(status)) throw new Error('无效的审核状态。');
    const result = db.prepare(`UPDATE ${table} SET moderation_status = ? WHERE id = ?`).run(status, id);
    if (!result.changes) throw new Error('记录不存在。');
  }

  app.post('/api/admin/moderation/topics/:id/approve', requireRole(['admin', 'teacher', 'customer_service']), (request, response) => {
    try {
      updateModerationStatus('forum_topics', Number(request.params.id), 'approved');
      response.json({ ok: true });
    } catch (err) { response.status(400).json({ error: err.message }); }
  });

  app.post('/api/admin/moderation/topics/:id/reject', requireRole(['admin', 'teacher', 'customer_service']), (request, response) => {
    try {
      updateModerationStatus('forum_topics', Number(request.params.id), 'rejected');
      response.json({ ok: true });
    } catch (err) { response.status(400).json({ error: err.message }); }
  });

  app.post('/api/admin/moderation/replies/:id/approve', requireRole(['admin', 'teacher', 'customer_service']), (request, response) => {
    try {
      updateModerationStatus('forum_replies', Number(request.params.id), 'approved');
      response.json({ ok: true });
    } catch (err) { response.status(400).json({ error: err.message }); }
  });

  app.post('/api/admin/moderation/replies/:id/reject', requireRole(['admin', 'teacher', 'customer_service']), (request, response) => {
    try {
      updateModerationStatus('forum_replies', Number(request.params.id), 'rejected');
      response.json({ ok: true });
    } catch (err) { response.status(400).json({ error: err.message }); }
  });

  // 对已有内容做敏感词检测（便于管理后台复核）
  app.post('/api/admin/moderation/detect', requireRole(['admin', 'teacher', 'customer_service']), (request, response) => {
    const text = String(request.body.text || '');
    if (!text) return response.status(400).json({ error: '缺少 text。' });
    const result = detectSensitiveWords(db, text);
    response.json({ result });
  });

  // ===== P6 数据看板 =====

  app.get('/api/admin/dashboard', requireRole(['admin', 'teacher', 'customer_service']), (request, response) => {
    const today = dayjs().format('YYYY-MM-DD');
    const weekStart = dayjs().startOf('week').add(1, 'day').format('YYYY-MM-DD');
    const monthStart = dayjs().startOf('month').format('YYYY-MM-DD');

    const totalUsers = db.prepare('SELECT COUNT(*) AS cnt FROM users').get().cnt;
    const newUsersToday = db.prepare("SELECT COUNT(*) AS cnt FROM users WHERE DATE(created_at) = ?").get(today).cnt;
    const newUsersWeek = db.prepare("SELECT COUNT(*) AS cnt FROM users WHERE DATE(created_at) >= ?").get(weekStart).cnt;
    const newUsersMonth = db.prepare("SELECT COUNT(*) AS cnt FROM users WHERE DATE(created_at) >= ?").get(monthStart).cnt;

    const tierCounts = { free: 0, trial: 0, paid: 0 };
    const entitlementRows = db.prepare('SELECT * FROM user_entitlements').all();
    for (const row of entitlementRows) {
      const e = getUserEntitlement(row.student_id);
      const tier = e.effectiveTier || e.tier;
      tierCounts[tier] = (tierCounts[tier] || 0) + 1;
    }

    const dau = db.prepare(`
      SELECT COUNT(DISTINCT student_id) AS cnt FROM (
        SELECT student_id FROM practice_records WHERE DATE(created_at) = ?
        UNION ALL
        SELECT student_id FROM task_completions WHERE task_date = ? AND completed_at IS NOT NULL
        UNION ALL
        SELECT student_id FROM summaries WHERE task_date = ?
      )
    `).get(today, today, today).cnt;

    const wau = db.prepare(`
      SELECT COUNT(DISTINCT student_id) AS cnt FROM (
        SELECT student_id FROM practice_records WHERE DATE(created_at) >= ?
        UNION ALL
        SELECT student_id FROM task_completions WHERE task_date >= ? AND completed_at IS NOT NULL
        UNION ALL
        SELECT student_id FROM summaries WHERE task_date >= ?
      )
    `).get(weekStart, weekStart, weekStart).cnt;

    const mau = db.prepare(`
      SELECT COUNT(DISTINCT student_id) AS cnt FROM (
        SELECT student_id FROM practice_records WHERE DATE(created_at) >= ?
        UNION ALL
        SELECT student_id FROM task_completions WHERE task_date >= ? AND completed_at IS NOT NULL
        UNION ALL
        SELECT student_id FROM summaries WHERE task_date >= ?
      )
    `).get(monthStart, monthStart, monthStart).cnt;

    const assignedToday = db.prepare(`
      SELECT COUNT(*) AS cnt FROM tasks
      WHERE (weekdays LIKE '%${dayjs().day()}%' OR weekdays = '[]')
    `).get().cnt;
    const completedToday = db.prepare('SELECT COUNT(*) AS cnt FROM task_completions WHERE task_date = ? AND completed_at IS NOT NULL').get(today).cnt;

    const totalRevenue = db.prepare("SELECT COALESCE(SUM(total_amount), 0) AS total FROM orders WHERE status = 'paid'").get().total;
    const todayRevenue = db.prepare("SELECT COALESCE(SUM(total_amount), 0) AS total FROM orders WHERE status = 'paid' AND DATE(paid_at) = ?").get(today).total;
    const paidStudents = db.prepare('SELECT COUNT(DISTINCT student_id) AS cnt FROM orders WHERE status = ?').get('paid').cnt;
    const totalStudents = db.prepare("SELECT COUNT(*) AS cnt FROM users WHERE role = 'student'").get().cnt;
    const conversionRate = totalStudents > 0 ? Math.round((paidStudents / totalStudents) * 100) : 0;

    const courseViews = db.prepare('SELECT COUNT(*) AS cnt FROM course_progress').get().cnt;
    const totalQuestions = db.prepare('SELECT COUNT(*) AS cnt FROM practice_records').get().cnt;
    const correctQuestions = db.prepare('SELECT COUNT(*) AS cnt FROM practice_records WHERE is_correct = 1').get().cnt;
    const questionAccuracy = totalQuestions > 0 ? Math.round((correctQuestions / totalQuestions) * 100) : 0;

    // B-07: 课程完成率 = 已完成课程数 / 总课程数
    const totalCourses = db.prepare('SELECT COUNT(*) AS cnt FROM courses').get().cnt;
    const completedCourses = db.prepare('SELECT COUNT(DISTINCT course_id) AS cnt FROM course_progress WHERE progress >= 100').get().cnt;
    const courseCompletionRate = totalCourses > 0 ? Math.round((completedCourses / totalCourses) * 100) : 0;

    // B-07: 平均学习时长（当日有学习记录的用户人均学习分钟数）
    const avgStudyMinutesRow = db.prepare(`
      SELECT COALESCE(AVG(duration), 0) AS avg_min FROM (
        SELECT SUM(progress_seconds) / 60.0 AS duration
        FROM course_progress WHERE DATE(updated_at) = ?
        GROUP BY student_id
      )
    `).get(today);
    const avgStudyMinutes = Math.round(avgStudyMinutesRow?.avg_min || 0);

    const lowStockThreshold = Number(getSetting('low_stock_threshold', '10'));
    const lowStockCount = db.prepare('SELECT COUNT(*) AS cnt FROM products WHERE stock <= ? AND status = ?').get(lowStockThreshold, 'active').cnt;

    function buildTrend(days) {
      const labels = [];
      const newStudents = [];
      const revenue = [];
      const taskCompletionRate = [];
      const questionCount = [];
      const courseViewsTrend = [];
      for (let i = days - 1; i >= 0; i--) {
        const date = dayjs().subtract(i, 'day').format('YYYY-MM-DD');
        labels.push(date.slice(5));
        newStudents.push(db.prepare("SELECT COUNT(*) AS cnt FROM users WHERE DATE(created_at) = ?").get(date).cnt);
        revenue.push(db.prepare("SELECT COALESCE(SUM(total_amount), 0) AS total FROM orders WHERE status = 'paid' AND DATE(paid_at) = ?").get(date).total);
        const assigned = db.prepare(`
          SELECT COUNT(*) AS cnt FROM tasks
          WHERE (weekdays LIKE '%${dayjs(date).day()}%' OR weekdays = '[]')
        `).get().cnt;
        const completed = db.prepare('SELECT COUNT(*) AS cnt FROM task_completions WHERE task_date = ? AND completed_at IS NOT NULL').get(date).cnt;
        taskCompletionRate.push(assigned > 0 ? Math.round((completed / assigned) * 100) : 0);
        questionCount.push(db.prepare('SELECT COUNT(*) AS cnt FROM practice_records WHERE DATE(created_at) = ?').get(date).cnt);
        courseViewsTrend.push(db.prepare('SELECT COUNT(*) AS cnt FROM course_progress WHERE DATE(updated_at) = ?').get(date).cnt);
      }
      return { labels, newStudents, revenue, taskCompletionRate, questionCount, courseViews: courseViewsTrend };
    }

    response.json({
      totalUsers,
      newUsersToday,
      newUsersWeek,
      newUsersMonth,
      tierDistribution: tierCounts,
      dau,
      wau,
      mau,
      todayTaskCompletionRate: assignedToday > 0 ? Math.round((completedToday / assignedToday) * 100) : 0,
      totalRevenue,
      todayRevenue,
      conversionRate,
      courseViews,
      totalQuestions,
      questionAccuracy,
      courseCompletionRate,
      avgStudyMinutes,
      lowStockCount,
      robotData: {
        totalConversations: db.prepare("SELECT COUNT(*) AS cnt FROM ai_conversations WHERE type = 'answer' OR type = 'tutor'").get().cnt,
        todayConversations: db.prepare("SELECT COUNT(*) AS cnt FROM ai_conversations WHERE (type = 'answer' OR type = 'tutor') AND DATE(created_at) = ?").get(today).cnt,
        knowledgeHitRate: (() => {
          const total = db.prepare("SELECT COUNT(*) AS cnt FROM ai_conversations WHERE type = 'answer'").get().cnt;
          if (total === 0) return 0;
          const kbHits = db.prepare("SELECT COUNT(*) AS cnt FROM ai_conversations WHERE type = 'answer' AND context LIKE '%knowledge_base%'").get().cnt;
          return Math.round((kbHits / total) * 100);
        })()
      },
      trend7: buildTrend(7),
      trend30: buildTrend(30)
    });
  });

  // 退款审核：列出退款申请
  app.get('/api/admin/refunds', requireRole(['admin', 'customer_service']), (request, response) => {
    const { status } = request.query;
    let sql = `SELECT
        refunds.id,
        refunds.order_id AS order_id,
        refunds.student_id AS student_id,
        refunds.reason,
        refunds.amount,
        refunds.status,
        refunds.created_at,
        orders.status AS order_status,
        users.display_name AS student_display_name
      FROM refunds
      LEFT JOIN orders ON orders.id = refunds.order_id
      LEFT JOIN users ON users.id = refunds.student_id`;
    const params = [];
    if (status && ['requested', 'approved', 'rejected', 'refunded'].includes(status)) {
      sql += ' WHERE refunds.status = ?';
      params.push(status);
    }
    sql += ' ORDER BY refunds.created_at DESC';
    const refunds = db.prepare(sql).all(...params).map((row) => ({
      id: row.id,
      orderId: row.order_id,
      studentId: row.student_id,
      studentDisplayName: row.student_display_name || '',
      reason: row.reason,
      amount: row.amount,
      status: row.status,
      orderStatus: row.order_status,
      createdAt: row.created_at
    }));
    response.json({ refunds });
  });
};
