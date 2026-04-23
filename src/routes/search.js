const dayjs = require('dayjs');

module.exports = function registerSearchRoutes(app, shared) {
  const { db, requireAuth } = shared;

  // 全局搜索
  app.get('/api/search', requireAuth, (request, response) => {
    const keyword = String(request.query.q || '').trim();
    if (!keyword || keyword.length < 2) { response.json({ topics: [], questions: [], items: [] }); return; }
    const escaped = keyword.replace(/[%_]/g, '\\$&');
    const like = '%' + escaped + '%';

    const topics = db.prepare(
      `SELECT forum_topics.id, forum_topics.title, forum_topics.created_at, users.display_name AS author_name
       FROM forum_topics LEFT JOIN users ON users.id = forum_topics.user_id
       WHERE forum_topics.title LIKE ? OR forum_topics.content LIKE ?
       ORDER BY forum_topics.created_at DESC LIMIT 10`
    ).all(like, like);

    const questions = db.prepare(
      `SELECT id, title, subject FROM questions WHERE title LIKE ? OR stem LIKE ?
       ORDER BY created_at DESC LIMIT 10`
    ).all(like, like);

    const items = db.prepare(
      `SELECT id, title, subject, item_type FROM folder_items WHERE title LIKE ?
       ORDER BY created_at DESC LIMIT 10`
    ).all(like);

    response.json({ topics, questions, items });
    // 记录搜索历史
    try {
      db.prepare('INSERT INTO search_logs (user_id, keyword, created_at) VALUES (?, ?, ?)').run(request.currentUser.id, keyword, dayjs().toISOString());
    } catch (_) {}
  });

  // 热门搜索词
  app.get('/api/search/hot', requireAuth, (request, response) => {
    const keywords = db.prepare(
      `SELECT keyword, COUNT(*) AS cnt FROM search_logs
       WHERE created_at >= date('now', '-7 days')
       GROUP BY keyword ORDER BY cnt DESC LIMIT 10`
    ).all();
    response.json({ keywords });
  });
};
