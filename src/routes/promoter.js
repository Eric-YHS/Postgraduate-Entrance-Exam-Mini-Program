const dayjs = require('dayjs');

module.exports = function registerPromoterRoutes(app, shared) {
  const { db, requireAuth, requireAdmin } = shared;

  // ── 序列化辅助 ──
  function serializePromoterApplication(row) {
    return {
      id: row.id,
      userId: row.user_id,
      name: row.name,
      contact: row.contact,
      platform: row.platform,
      followerCount: row.follower_count,
      status: row.status,
      reviewedBy: row.reviewed_by,
      reviewedAt: row.reviewed_at,
      createdAt: row.created_at
    };
  }

  // ── 学生端：提交博主报名 ──
  app.post('/api/promoter/apply', requireAuth, (request, response) => {
    const userId = request.currentUser.id;
    const { name, contact, platform, follower_count } = request.body;

    if (!name || !contact || !platform) {
      response.status(400).json({ error: '请填写姓名、联系方式和平台信息。' });
      return;
    }

    const trimmedName = String(name).trim();
    const trimmedContact = String(contact).trim();
    const trimmedPlatform = String(platform).trim();
    const followerCount = Math.max(0, Number(follower_count) || 0);

    if (!trimmedName || !trimmedContact || !trimmedPlatform) {
      response.status(400).json({ error: '请填写姓名、联系方式和平台信息。' });
      return;
    }

    // 检查是否已有申请记录
    const existing = db.prepare('SELECT id, status FROM promoter_applications WHERE user_id = ?').get(userId);
    if (existing) {
      if (existing.status === 'pending') {
        response.status(400).json({ error: '您已提交过申请，正在审核中。' });
        return;
      }
      if (existing.status === 'approved') {
        response.status(400).json({ error: '您已是认证博主，无需重复申请。' });
        return;
      }
    }

    const now = dayjs().toISOString();

    try {
      if (existing && existing.status === 'rejected') {
        // 重新提交：更新原有记录
        db.prepare(
          `UPDATE promoter_applications
           SET name = ?, contact = ?, platform = ?, follower_count = ?, status = 'pending', reviewed_by = NULL, reviewed_at = NULL, created_at = ?
           WHERE id = ?`
        ).run(trimmedName, trimmedContact, trimmedPlatform, followerCount, now, existing.id);

        response.json({ ok: true, message: '申请已重新提交。', id: existing.id });
        return;
      }

      const result = db.prepare(
        `INSERT INTO promoter_applications (user_id, name, contact, platform, follower_count, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?)`
      ).run(userId, trimmedName, trimmedContact, trimmedPlatform, followerCount, now);

      response.json({ ok: true, message: '申请已提交，请等待审核。', id: result.lastInsertRowid });
    } catch (error) {
      console.error('博主报名提交失败:', error);
      response.status(500).json({ error: '提交失败，请稍后重试。' });
    }
  });

  // ── 学生端：查看自己的申请状态 ──
  app.get('/api/promoter/my-application', requireAuth, (request, response) => {
    const userId = request.currentUser.id;
    const row = db.prepare('SELECT * FROM promoter_applications WHERE user_id = ? ORDER BY created_at DESC LIMIT 1').get(userId);
    if (!row) {
      response.json({ application: null });
      return;
    }
    response.json({ application: serializePromoterApplication(row) });
  });

  // ── 管理后台：查看报名列表 ──
  app.get('/api/admin/promoter-applications', requireAdmin, (request, response) => {
    const { status } = request.query;
    let sql = `SELECT promoter_applications.*, users.display_name AS user_display_name
               FROM promoter_applications
               LEFT JOIN users ON users.id = promoter_applications.user_id`;
    const params = [];

    if (status && ['pending', 'approved', 'rejected'].includes(status)) {
      sql += ' WHERE promoter_applications.status = ?';
      params.push(status);
    }

    sql += ' ORDER BY promoter_applications.created_at DESC';

    const rows = db.prepare(sql).all(...params);
    const applications = rows.map((row) => ({
      ...serializePromoterApplication(row),
      userDisplayName: row.user_display_name || ''
    }));

    response.json({ applications });
  });

  // ── 管理后台：审核通过 ──
  app.post('/api/admin/promoter-applications/:id/approve', requireAdmin, (request, response) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      response.status(400).json({ error: '无效的 ID。' });
      return;
    }

    const application = db.prepare('SELECT * FROM promoter_applications WHERE id = ?').get(id);
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
        // 更新申请状态
        db.prepare(
          'UPDATE promoter_applications SET status = \'approved\', reviewed_by = ?, reviewed_at = ? WHERE id = ?'
        ).run(request.currentUser.id, now, id);

        // 更新用户推广状态
        db.prepare(
          'UPDATE users SET promoter_status = \'approved\' WHERE id = ?'
        ).run(application.user_id);
      });

      approveTransaction();
      response.json({ ok: true, message: '审核已通过。' });
    } catch (error) {
      console.error('博主审核通过失败:', error);
      response.status(500).json({ error: '审核失败，请稍后重试。' });
    }
  });

  // ── 管理后台：审核驳回 ──
  app.post('/api/admin/promoter-applications/:id/reject', requireAdmin, (request, response) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      response.status(400).json({ error: '无效的 ID。' });
      return;
    }

    const application = db.prepare('SELECT * FROM promoter_applications WHERE id = ?').get(id);
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
      db.prepare(
        'UPDATE promoter_applications SET status = \'rejected\', reviewed_by = ?, reviewed_at = ? WHERE id = ?'
      ).run(request.currentUser.id, now, id);

      response.json({ ok: true, message: '审核已驳回。' });
    } catch (error) {
      console.error('博主审核驳回失败:', error);
      response.status(500).json({ error: '审核失败，请稍后重试。' });
    }
  });
};
