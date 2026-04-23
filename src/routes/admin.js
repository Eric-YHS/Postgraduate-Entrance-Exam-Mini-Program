const dayjs = require('dayjs');
const bcrypt = require('bcryptjs');
const { sanitizeText } = require('../utils/sanitize');

module.exports = function registerAdminRoutes(app, shared) {
  const { db, sanitizeUser, requireAdmin, checkRegisterRateLimit } = shared;

  // 管理后台 - 初始数据
  app.get('/api/admin/bootstrap', requireAdmin, (request, response) => {
    const applications = db
      .prepare('SELECT * FROM teacher_applications ORDER BY created_at DESC')
      .all()
      .map((row) => ({
        id: row.id,
        username: row.username,
        displayName: row.display_name,
        className: row.class_name,
        motivation: row.motivation,
        status: row.status,
        reviewedBy: row.reviewed_by,
        reviewedAt: row.reviewed_at,
        createdAt: row.created_at
      }));

    const users = db
      .prepare('SELECT * FROM users ORDER BY created_at DESC')
      .all()
      .map((row) => ({
        id: row.id,
        username: row.username,
        role: row.role,
        displayName: row.display_name,
        className: row.class_name,
        createdAt: row.created_at
      }));

    const stats = {
      totalUsers: users.length,
      teacherCount: users.filter((u) => u.role === 'teacher').length,
      studentCount: users.filter((u) => u.role === 'student').length,
      pendingApplications: applications.filter((a) => a.status === 'pending').length
    };

    response.json({
      user: sanitizeUser(request.currentUser),
      applications,
      users,
      stats
    });
  });

  // 管理后台 - 审核教师申请
  app.post('/api/admin/applications/:id/approve', requireAdmin, (request, response) => {
    const application = db.prepare('SELECT * FROM teacher_applications WHERE id = ?').get(request.params.id);
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
          .run(request.currentUser.id, now, request.params.id);
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
    const application = db.prepare('SELECT * FROM teacher_applications WHERE id = ?').get(request.params.id);
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
      .run(request.currentUser.id, now, request.params.id);

    response.json({ ok: true });
  });

  // 管理后台 - 用户管理
  app.get('/api/admin/users', requireAdmin, (request, response) => {
    const { role, search } = request.query;
    const limit = Math.min(Number(request.query.limit) || 100, 500);
    const offset = Number(request.query.offset) || 0;
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
    const targetUser = db.prepare('SELECT * FROM users WHERE id = ?').get(request.params.id);
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
      if (!['teacher', 'student', 'admin'].includes(role)) {
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

    params.push(request.params.id);
    db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    response.json({ ok: true });
  });

  app.delete('/api/admin/users/:id', requireAdmin, (request, response) => {
    const targetUser = db.prepare('SELECT * FROM users WHERE id = ?').get(request.params.id);
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
      db.prepare('DELETE FROM addresses WHERE student_id = ?').run(uid);
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
};
