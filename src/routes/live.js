const dayjs = require('dayjs');
const { sanitizeText } = require('../utils/sanitize');

module.exports = function registerLiveRoutes(app, shared) {
  const { db, requireAuth, requireStudent, requireTeacher, sanitizeUser, serializeLiveSession, broadcastToLiveRoom, safeJsonParse } = shared;

  app.post('/api/live-sessions', requireTeacher, (request, response) => {
    const title = sanitizeText(request.body.title);
    if (!title) {
      response.status(400).json({ error: '直播标题不能为空。' });
      return;
    }

    const liveResult = db.prepare(
      `
        INSERT INTO live_sessions (
          title, description, subject, status, created_by, created_at
        ) VALUES (?, ?, ?, 'draft', ?, ?)
      `
    ).run(
      title,
      sanitizeText(request.body.description),
      sanitizeText(request.body.subject || '考研规划'),
      request.currentUser.id,
      dayjs().toISOString()
    );

    response.json({ ok: true, id: liveResult.lastInsertRowid });
  });

  app.post('/api/live-sessions/:id/start', requireTeacher, (request, response) => {
    const session = db.prepare('SELECT * FROM live_sessions WHERE id = ?').get(request.params.id);
    if (!session) {
      response.status(404).json({ error: '直播间不存在。' });
      return;
    }
    // BUG-007: 校验所有权
    if (session.created_by !== request.currentUser.id) {
      response.status(403).json({ error: '无权操作其他教师的直播。' });
      return;
    }
    if (session.status === 'live') {
      response.status(400).json({ error: '直播已在进行中。' });
      return;
    }

    db.prepare(
      `
        UPDATE live_sessions
        SET status = 'live', started_at = COALESCE(started_at, ?), ended_at = NULL
        WHERE id = ?
      `
    ).run(dayjs().toISOString(), request.params.id);

    response.json({ ok: true });
  });

  app.post('/api/live-sessions/:id/end', requireTeacher, (request, response) => {
    const session = db.prepare('SELECT * FROM live_sessions WHERE id = ?').get(request.params.id);
    if (!session) {
      response.status(404).json({ error: '直播间不存在。' });
      return;
    }
    // BUG-007: 校验所有权
    if (session.created_by !== request.currentUser.id) {
      response.status(403).json({ error: '无权操作其他教师的直播。' });
      return;
    }
    if (session.status !== 'live') {
      response.status(400).json({ error: '直播未在进行中，无法结束。' });
      return;
    }

    db.prepare(
      `
        UPDATE live_sessions
        SET status = 'ended', ended_at = ?
        WHERE id = ?
      `
    ).run(dayjs().toISOString(), request.params.id);

    broadcastToLiveRoom(request.params.id, { type: 'live-ended', liveId: Number(request.params.id) });
    response.json({ ok: true });
  });

  app.get('/api/live-sessions/:id', requireAuth, (request, response) => {
    const sessionRow = db
      .prepare(
        `
          SELECT live_sessions.*, users.display_name AS teacher_name
          FROM live_sessions
          LEFT JOIN users ON users.id = live_sessions.created_by
          WHERE live_sessions.id = ?
        `
      )
      .get(request.params.id);

    if (!sessionRow) {
      response.status(404).json({ error: '直播不存在。' });
      return;
    }

    const messages = db
      .prepare(
        `
          SELECT live_messages.*, users.display_name AS author_name, users.role AS author_role
          FROM live_messages
          LEFT JOIN users ON users.id = live_messages.user_id
          WHERE live_messages.live_session_id = ?
          ORDER BY live_messages.created_at ASC
        `
      )
      .all(request.params.id)
      .map((message) => ({
        id: message.id,
        liveSessionId: message.live_session_id,
        userId: message.user_id,
        content: message.content,
        authorName: message.author_name,
        authorRole: message.author_role,
        createdAt: message.created_at
      }));

    response.json({
      liveSession: serializeLiveSession(sessionRow),
      messages,
      user: sanitizeUser(request.currentUser)
    });
  });

  // 直播预约
  app.post('/api/live-sessions/:id/reserve', requireStudent, (request, response) => {
    const session = db.prepare('SELECT id, status FROM live_sessions WHERE id = ?').get(request.params.id);
    if (!session) { response.status(404).json({ error: '直播不存在。' }); return; }
    db.prepare(
      'INSERT OR IGNORE INTO live_reservations (live_session_id, student_id, created_at) VALUES (?, ?, ?)'
    ).run(request.params.id, request.currentUser.id, dayjs().toISOString());
    response.json({ ok: true });
  });

  app.delete('/api/live-sessions/:id/reserve', requireStudent, (request, response) => {
    db.prepare('DELETE FROM live_reservations WHERE live_session_id = ? AND student_id = ?').run(request.params.id, request.currentUser.id);
    response.json({ ok: true });
  });

  // 直播禁言（教师端）
  app.post('/api/live-sessions/:id/mute', requireTeacher, (request, response) => {
    const userId = Number(request.body.userId);
    if (!userId) { response.status(400).json({ error: '参数错误。' }); return; }
    const duration = Number(request.body.durationMinutes) || 10;
    const mutedUntil = dayjs().add(duration, 'minute').toISOString();
    db.prepare('UPDATE users SET muted_until = ? WHERE id = ?').run(mutedUntil, userId);
    response.json({ ok: true, mutedUntil });
  });

  // 直播互动答题
  app.post('/api/live-sessions/:id/polls', requireTeacher, (request, response) => {
    const liveId = Number(request.params.id);
    const question = sanitizeText(request.body.question || '');
    const options = request.body.options || [];
    if (!question || options.length < 2) { return response.status(400).json({ error: '缺少参数。' }); }

    const result = db.prepare(
      'INSERT INTO live_polls (live_session_id, question, options, is_active, created_at) VALUES (?, ?, ?, 1, ?)'
    ).run(liveId, question, JSON.stringify(options), dayjs().toISOString());

    // 通过 WebSocket 广播新投票
    shared.broadcastToLive(liveId, { type: 'poll', poll: { id: result.lastInsertRowid, question, options } });
    response.json({ ok: true, pollId: result.lastInsertRowid });
  });

  app.post('/api/live-sessions/:id/polls/vote', requireAuth, (request, response) => {
    const pollId = Number(request.body.pollId);
    const optionIndex = Number(request.body.optionIndex);
    if (!pollId) { return response.status(400).json({ error: '缺少参数。' }); }

    db.prepare(`
      INSERT INTO live_poll_votes (poll_id, user_id, option_index, created_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(poll_id, user_id) DO UPDATE SET option_index = excluded.option_index
    `).run(pollId, request.currentUser.id, optionIndex, dayjs().toISOString());
    response.json({ ok: true });
  });

  app.get('/api/live-sessions/:id/polls/:pollId/results', requireAuth, (request, response) => {
    const poll = db.prepare('SELECT * FROM live_polls WHERE id = ?').get(request.params.pollId);
    if (!poll) { return response.status(404).json({ error: '不存在。' }); }
    const votes = db.prepare('SELECT option_index, COUNT(*) AS cnt FROM live_poll_votes WHERE poll_id = ? GROUP BY option_index').all(request.params.pollId);
    const results = {};
    votes.forEach((v) => { results[v.option_index] = v.cnt; });
    response.json({ poll: { question: poll.question, options: safeJsonParse(poll.options, []) }, results });
  });
};
