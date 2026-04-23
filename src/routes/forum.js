const dayjs = require('dayjs');
const { sanitizeText, stripHtml } = require('../utils/sanitize');

module.exports = function registerForumRoutes(app, shared) {
  const { db, requireAuth, safeJsonParse, toPublicPath, forumUpload, serializeForumTopic, batchLoadForumReplies, batchLoadForumLikes, checkAndUnlockAchievements, sendMentionNotifications } = shared;

  // 论坛主题列表（独立页面用）
  app.get('/api/forum/topics', requireAuth, (request, response) => {
    const { category, limit, offset, search, sort, hashtag } = request.query;
    const maxLimit = Math.min(Number(limit) || 50, 200);
    const skip = Number(offset) || 0;
    let query = `
      SELECT forum_topics.*, users.display_name AS author_name, users.role AS author_role
      FROM forum_topics
      LEFT JOIN users ON users.id = forum_topics.user_id
    `;
    const params = [];
    const conditions = [];
    if (category) { conditions.push('forum_topics.category = ?'); params.push(category); }
    if (search) { const esc = String(search).replace(/[%_]/g, '\\$&'); conditions.push('(forum_topics.title LIKE ? OR forum_topics.content LIKE ?)'); params.push('%' + esc + '%', '%' + esc + '%'); }
    if (hashtag) { conditions.push('forum_topics.hashtags LIKE ?'); params.push('%"' + hashtag + '"%'); }
    if (conditions.length) { query += ' WHERE ' + conditions.join(' AND '); }

    if (sort === 'hot') {
      query += ' ORDER BY forum_topics.is_pinned DESC, ((SELECT COUNT(*) FROM forum_likes WHERE topic_id = forum_topics.id) * 2 + (SELECT COUNT(*) FROM forum_replies WHERE topic_id = forum_topics.id) * 3) / MAX(julianday("now") - julianday(forum_topics.created_at), 0.5) DESC';
    } else {
      query += ' ORDER BY forum_topics.is_pinned DESC, forum_topics.created_at DESC';
    }
    query += ' LIMIT ? OFFSET ?';
    params.push(maxLimit, skip);
    const topics = db.prepare(query).all(...params);
    const topicIds = topics.map((t) => t.id);
    const repliesMap = batchLoadForumReplies(topicIds);
    const likesMap = batchLoadForumLikes(topicIds, request.currentUser.id);
    const favRows = db.prepare(`SELECT topic_id FROM forum_favorites WHERE topic_id IN (${topicIds.length ? topicIds.map(() => '?').join(',') : '0'}) AND user_id = ?`).all(...(topicIds.length ? topicIds : []), request.currentUser.id);
    const favSet = new Set(favRows.map((r) => r.topic_id));
    // 批量加载赞同数
    const endorseRows = topicIds.length ? db.prepare(`SELECT topic_id, COUNT(*) AS cnt FROM forum_endorsements WHERE topic_id IN (${topicIds.map(() => '?').join(',')}) GROUP BY topic_id`).all(...topicIds) : [];
    const endorseMap = new Map(endorseRows.map((r) => [r.topic_id, r.cnt]));
    response.json({ topics: topics.map((t) => {
      const serialized = serializeForumTopic(t, repliesMap, likesMap);
      serialized.favoritedByMe = favSet.has(t.id);
      serialized.endorseCount = endorseMap.get(t.id) || 0;
      return serialized;
    }) });
  });

  app.post('/api/forum/topics', requireAuth, (request, response) => {
    forumUpload(request, response, (error) => {
      if (error) {
        response.status(400).json({ error: '上传失败。' });
        return;
      }

      const title = stripHtml(request.body.title);
      const content = stripHtml(request.body.content);

      if (!title || !content) {
        response.status(400).json({ error: '帖子标题和内容都不能为空。' });
        return;
      }
      if (title.length > 200) { response.status(400).json({ error: '标题不能超过200字。' }); return; }
      if (content.length > 10000) { response.status(400).json({ error: '内容不能超过10000字。' }); return; }

      const imagePaths = (request.files?.images || []).map((f) => toPublicPath(f.path));
      const videoPaths = (request.files?.videos || []).map((f) => toPublicPath(f.path));
      const attachmentPaths = (request.files?.attachments || []).map((f) => toPublicPath(f.path));
      const links = safeJsonParse(request.body.links || '[]', []);

      // 解析 #话题# 标签
      const hashtagRegex = /#([^#\s]+)#/g;
      const extractedTags = [];
      let tagMatch;
      while ((tagMatch = hashtagRegex.exec(content)) !== null) {
        extractedTags.push(tagMatch[1]);
      }

      const topicResult = db.prepare(
        `
          INSERT INTO forum_topics (user_id, title, content, category, hashtags, image_paths, attachment_paths, video_paths, links, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
      ).run(
        request.currentUser.id, title, content,
        sanitizeText(request.body.category || '考研交流'),
        JSON.stringify(extractedTags),
        JSON.stringify(imagePaths), JSON.stringify(attachmentPaths),
        JSON.stringify(videoPaths), JSON.stringify(links),
        dayjs().toISOString()
      );

      // 检查成就
      checkAndUnlockAchievements(request.currentUser.id);

      // @提及通知
      sendMentionNotifications(content, request.currentUser.id, title);

      response.json({ ok: true, id: topicResult.lastInsertRowid });
    });
  });

  app.post('/api/forum/topics/:id/replies', requireAuth, (request, response) => {
    forumUpload(request, response, (error) => {
      if (error) {
        response.status(400).json({ error: '上传失败。' });
        return;
      }

      const content = stripHtml(request.body.content);
      if (!content) {
        response.status(400).json({ error: '回复内容不能为空。' });
        return;
      }

      const topic = db.prepare('SELECT id FROM forum_topics WHERE id = ?').get(request.params.id);
      if (!topic) {
        response.status(404).json({ error: '帖子不存在。' });
        return;
      }

      const imagePaths = (request.files?.images || []).map((f) => toPublicPath(f.path));
      const videoPaths = (request.files?.videos || []).map((f) => toPublicPath(f.path));
      const attachmentPaths = (request.files?.attachments || []).map((f) => toPublicPath(f.path));
      const links = safeJsonParse(request.body.links || '[]', []);

      // 楼中楼回复支持
      let replyToId = null;
      let replyToUser = '';
      const replyToIdRaw = request.body.replyToId;
      if (replyToIdRaw) {
        const parentReply = db.prepare(
          'SELECT forum_replies.id, users.display_name FROM forum_replies LEFT JOIN users ON users.id = forum_replies.user_id WHERE forum_replies.id = ? AND forum_replies.topic_id = ?'
        ).get(Number(replyToIdRaw), request.params.id);
        if (parentReply) {
          replyToId = parentReply.id;
          replyToUser = parentReply.display_name || '';
        }
      }

      db.prepare(
        `
          INSERT INTO forum_replies (topic_id, user_id, content, image_paths, attachment_paths, video_paths, links, reply_to_id, reply_to_user, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
      ).run(
        request.params.id, request.currentUser.id, content,
        JSON.stringify(imagePaths), JSON.stringify(attachmentPaths),
        JSON.stringify(videoPaths), JSON.stringify(links),
        replyToId, replyToUser,
        dayjs().toISOString()
      );

      // @提及通知
      const topicTitle = db.prepare('SELECT title FROM forum_topics WHERE id = ?').get(request.params.id);
      sendMentionNotifications(content, request.currentUser.id, topicTitle ? topicTitle.title : '回复');

      response.json({ ok: true });
    });
  });

  // 帖子详情
  app.get('/api/forum/topics/:id', requireAuth, (request, response) => {
    const topic = db.prepare(
      `SELECT forum_topics.*, users.display_name AS author_name, users.role AS author_role
       FROM forum_topics
       LEFT JOIN users ON users.id = forum_topics.user_id
       WHERE forum_topics.id = ?`
    ).get(request.params.id);

    if (!topic) {
      response.status(404).json({ error: '帖子不存在。' });
      return;
    }

    const repliesMap = batchLoadForumReplies([topic.id]);
    const likesMap = batchLoadForumLikes([topic.id], request.currentUser.id);
    response.json({ topic: serializeForumTopic(topic, repliesMap, likesMap) });
  });

  // 帖子点赞/取消
  app.post('/api/forum/topics/:id/like', requireAuth, (request, response) => {
    const topic = db.prepare('SELECT id FROM forum_topics WHERE id = ?').get(request.params.id);
    if (!topic) {
      response.status(404).json({ error: '帖子不存在。' });
      return;
    }

    const existing = db.prepare(
      'SELECT id FROM forum_likes WHERE topic_id = ? AND user_id = ?'
    ).get(request.params.id, request.currentUser.id);

    let liked;
    if (existing) {
      db.prepare('DELETE FROM forum_likes WHERE id = ?').run(existing.id);
      liked = false;
    } else {
      db.prepare(
        'INSERT INTO forum_likes (topic_id, user_id, created_at) VALUES (?, ?, ?)'
      ).run(request.params.id, request.currentUser.id, dayjs().toISOString());
      liked = true;
    }

    const likeCount = db.prepare(
      'SELECT COUNT(*) AS count FROM forum_likes WHERE topic_id = ?'
    ).get(request.params.id).count;

    response.json({ liked, likeCount });
  });

  // 论坛收藏切换
  app.post('/api/forum/topics/:id/favorite', requireAuth, (request, response) => {
    const topic = db.prepare('SELECT id FROM forum_topics WHERE id = ?').get(request.params.id);
    if (!topic) { response.status(404).json({ error: '帖子不存在。' }); return; }

    const existing = db.prepare('SELECT id FROM forum_favorites WHERE topic_id = ? AND user_id = ?').get(request.params.id, request.currentUser.id);
    let favorited;
    if (existing) {
      db.prepare('DELETE FROM forum_favorites WHERE id = ?').run(existing.id);
      favorited = false;
    } else {
      db.prepare('INSERT INTO forum_favorites (topic_id, user_id, created_at) VALUES (?, ?, ?)').run(request.params.id, request.currentUser.id, dayjs().toISOString());
      favorited = true;
    }
    response.json({ favorited });
  });

  // 论坛收藏列表
  app.get('/api/forum/topics/favorites', requireAuth, (request, response) => {
    const { category } = request.query;
    let query = `
      SELECT forum_topics.*, users.display_name AS author_name, users.role AS author_role
      FROM forum_favorites
      JOIN forum_topics ON forum_topics.id = forum_favorites.topic_id
      LEFT JOIN users ON users.id = forum_topics.user_id
      WHERE forum_favorites.user_id = ?
    `;
    const params = [request.currentUser.id];
    if (category) { query += ' AND forum_topics.category = ?'; params.push(category); }
    query += ' ORDER BY forum_favorites.created_at DESC LIMIT 50';
    const topics = db.prepare(query).all(...params);
    const topicIds = topics.map((t) => t.id);
    const repliesMap = batchLoadForumReplies(topicIds);
    const likesMap = batchLoadForumLikes(topicIds, request.currentUser.id);
    response.json({ topics: topics.map((t) => serializeForumTopic(t, repliesMap, likesMap)) });
  });

  // 热门话题标签
  app.get('/api/forum/hashtags', requireAuth, (_request, response) => {
    const rows = db.prepare('SELECT hashtags FROM forum_topics WHERE hashtags != "[]"').all();
    const countMap = {};
    rows.forEach((row) => {
      const tags = safeJsonParse(row.hashtags, []);
      tags.forEach((tag) => { countMap[tag] = (countMap[tag] || 0) + 1; });
    });
    const sorted = Object.entries(countMap).sort((a, b) => b[1] - a[1]).slice(0, 30).map(([name, count]) => ({ name, count }));
    response.json({ hashtags: sorted });
  });

  // 论坛置顶/精华
  app.post('/api/forum/topics/:id/pin', requireAuth, (request, response) => {
    if (request.currentUser.role !== 'teacher' && request.currentUser.role !== 'admin') {
      return response.status(403).json({ error: '无权限操作。' });
    }
    const pinned = Number(request.body.pinned) || 0;
    db.prepare('UPDATE forum_topics SET is_pinned = ? WHERE id = ?').run(pinned, request.params.id);
    response.json({ ok: true });
  });

  app.post('/api/forum/topics/:id/feature', requireAuth, (request, response) => {
    if (request.currentUser.role !== 'teacher' && request.currentUser.role !== 'admin') {
      return response.status(403).json({ error: '无权限操作。' });
    }
    const featured = Number(request.body.featured) || 0;
    db.prepare('UPDATE forum_topics SET is_featured = ? WHERE id = ?').run(featured, request.params.id);
    response.json({ ok: true });
  });

  // 论坛赞同
  app.post('/api/forum/topics/:id/endorse', requireAuth, (request, response) => {
    const topicId = Number(request.params.id);
    const userId = request.currentUser.id;
    const existing = db.prepare('SELECT id FROM forum_endorsements WHERE topic_id = ? AND user_id = ?').get(topicId, userId);
    if (existing) {
      db.prepare('DELETE FROM forum_endorsements WHERE id = ?').run(existing.id);
      response.json({ endorsed: false });
    } else {
      db.prepare('INSERT INTO forum_endorsements (topic_id, user_id, created_at) VALUES (?, ?, ?)').run(topicId, userId, dayjs().toISOString());
      response.json({ endorsed: true });
    }
  });

  // 论坛热门话题
  app.get('/api/forum/trending', requireAuth, (_request, response) => {
    // 计算热门分数并更新
    const now = dayjs();
    const topics = db.prepare(`
      SELECT forum_topics.id, forum_topics.title,
        (SELECT COUNT(*) FROM forum_likes WHERE topic_id = forum_topics.id) AS likes,
        (SELECT COUNT(*) FROM forum_replies WHERE topic_id = forum_topics.id) AS replies,
        (SELECT COUNT(*) FROM forum_endorsements WHERE topic_id = forum_topics.id) AS endorsements,
        julianday(?) - julianday(forum_topics.created_at) AS days_since
      FROM forum_topics
      WHERE julianday(?) - julianday(forum_topics.created_at) <= 7
    `).all(now.toISOString(), now.toISOString());

    const trending = topics.map((t) => {
      const days = Math.max(t.days_since, 0.5);
      const score = (t.likes * 2 + t.replies * 3 + t.endorsements * 2) / days;
      return { id: t.id, title: t.title, score: Math.round(score * 100) / 100, likes: t.likes, replies: t.replies };
    }).sort((a, b) => b.score - a.score).slice(0, 20);

    response.json({ trending });
  });
};
