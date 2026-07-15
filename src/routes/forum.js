const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const dayjs = require('dayjs');
const { sanitizeText, stripHtml } = require('../utils/sanitize');
const { detectSensitiveWords } = require('../services/moderation');
const {
  ContentSecurityError,
  msgSecCheck,
  imgSecCheck,
  mediaCheckAsync,
  saveCheck
} = require('../services/wechatContentSecurity');
const { buildSignedForumMediaUrl } = require('./contentSecurity');

const MAX_SECURITY_TEXT_LENGTH = 2500;
const SECURITY_TEXT_OVERLAP = 50;
const MAX_SECURITY_IMAGE_SIZE = 1024 * 1024;

class ForumRequestError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'ForumRequestError';
    this.status = status;
    this.code = code;
  }
}

function getUploadedFiles(files) {
  if (!files || typeof files !== 'object') return [];
  return Object.values(files).flatMap((value) => (Array.isArray(value) ? value : [])).filter(Boolean);
}

function cleanupUploadedFiles(files) {
  for (const file of getUploadedFiles(files)) {
    if (!file.path) continue;
    try {
      fs.unlinkSync(file.path);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.warn('[Forum] 清理未发布上传文件失败:', error.message);
      }
    }
  }
}

function splitSecurityText(value) {
  const characters = Array.from(String(value || ''));
  if (characters.length <= MAX_SECURITY_TEXT_LENGTH) {
    return characters.length ? [characters.join('')] : [];
  }
  const chunks = [];
  let start = 0;
  while (start < characters.length) {
    const end = Math.min(start + MAX_SECURITY_TEXT_LENGTH, characters.length);
    chunks.push(characters.slice(start, end).join(''));
    if (end === characters.length) break;
    start = end - SECURITY_TEXT_OVERLAP;
  }
  return chunks;
}

function detectImageContentType(buffer) {
  if (!Buffer.isBuffer(buffer)) return '';
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47 &&
    buffer[4] === 0x0d && buffer[5] === 0x0a && buffer[6] === 0x1a && buffer[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (buffer.length >= 6) {
    const signature = buffer.subarray(0, 6).toString('ascii');
    if (signature === 'GIF87a' || signature === 'GIF89a') return 'image/gif';
  }
  return '';
}

function checkFailure(summary, expectedStatus, contentLabel) {
  if (summary.status === expectedStatus) return;
  if (summary.status === 'review' || summary.status === 'rejected') {
    throw new ForumRequestError(422, 'CONTENT_SECURITY_REJECTED', `${contentLabel}未通过微信内容安全检测，请修改后重试。`);
  }
  throw new ForumRequestError(503, 'CONTENT_SECURITY_UNAVAILABLE', '微信内容安全检测返回异常，请稍后重试。');
}

async function checkForumText({ config, db, openid, requestId, text }) {
  const chunks = splitSecurityText(text);
  for (const chunk of chunks) {
    const raw = await msgSecCheck(config, { content: chunk, openid, scene: 3 });
    const summary = saveCheck(db, {
      requestId,
      openid,
      apiName: 'msgSecCheck',
      contentType: 'text',
      input: chunk,
      response: raw
    });
    checkFailure(summary, 'passed', '文字内容');
  }
}

async function checkForumImages({ config, db, openid, requestId, imageFiles }) {
  for (const file of imageFiles) {
    if (Number(file.size) > MAX_SECURITY_IMAGE_SIZE) {
      throw new ForumRequestError(400, 'IMAGE_TOO_LARGE', '图片不能超过 1 MB，请压缩后重试。');
    }
    const buffer = fs.readFileSync(file.path);
    if (buffer.length > MAX_SECURITY_IMAGE_SIZE) {
      throw new ForumRequestError(400, 'IMAGE_TOO_LARGE', '图片不能超过 1 MB，请压缩后重试。');
    }
    const contentType = detectImageContentType(buffer);
    if (!contentType) {
      throw new ForumRequestError(400, 'INVALID_IMAGE', '仅支持有效的 JPG、PNG 或 GIF 图片。');
    }

    const filename = path.basename(String(file.filename || ''));
    if (!filename || filename !== file.filename) {
      throw new ForumRequestError(400, 'INVALID_IMAGE', '图片文件名无效。');
    }

    const syncRaw = await imgSecCheck(config, {
      buffer,
      filename: file.originalname || filename,
      contentType
    });
    const syncCheck = saveCheck(db, {
      requestId,
      openid,
      apiName: 'imgSecCheck',
      contentType: 'image',
      input: buffer,
      response: syncRaw
    });
    checkFailure(syncCheck, 'passed', '图片');

    const mediaUrl = buildSignedForumMediaUrl(config, filename);
    const asyncRaw = await mediaCheckAsync(config, {
      mediaUrl,
      openid,
      mediaType: 2,
      scene: 3
    });
    const asyncCheck = saveCheck(db, {
      requestId,
      openid,
      apiName: 'mediaCheckAsync',
      contentType: 'image',
      input: buffer,
      response: asyncRaw
    });
    checkFailure(asyncCheck, 'submitted', '图片异步检测任务');
  }
}

async function enforceForumContentSecurity({ config, db, user, text, imageFiles }) {
  const openid = String(user && user.openid || '').trim();
  if (!openid) {
    throw new ForumRequestError(403, 'WECHAT_IDENTITY_REQUIRED', '当前账号缺少微信身份，请通过小程序重新登录后再发布。');
  }
  const requestId = crypto.randomUUID();
  await checkForumText({ config, db, openid, requestId, text });
  await checkForumImages({ config, db, openid, requestId, imageFiles });
  return requestId;
}

function sendForumError(response, error) {
  if (error instanceof ForumRequestError) {
    response.status(error.status).json({ ok: false, code: error.code, error: error.message });
    return;
  }
  if (error instanceof ContentSecurityError) {
    console.warn('[Forum] 微信内容安全服务调用失败:', error.code);
    response.status(503).json({
      ok: false,
      code: error.code,
      error: '微信内容安全服务暂不可用，本次内容未发布，请稍后重试。'
    });
    return;
  }
  console.error('[Forum] 发布处理失败:', error);
  response.status(500).json({ ok: false, code: 'FORUM_PUBLISH_FAILED', error: '发布失败，请稍后重试。' });
}

module.exports = function registerForumRoutes(app, shared) {
  const { config, db, requireAuth, safeJsonParse, toPublicPath, forumUpload, serializeForumTopic, batchLoadForumReplies, batchLoadForumLikes, checkAndUnlockAchievements, sendMentionNotifications } = shared;

  function isModerator(user) {
    return user && ['admin', 'teacher', 'customer_service'].includes(user.role);
  }

  // 论坛主题列表（独立页面用）
  app.get('/api/forum/topics', requireAuth, (request, response) => {
    const { category, limit, offset, search, sort, hashtag } = request.query;
    const includePending = isModerator(request.currentUser);
    const maxLimit = Math.min(Number(limit) || 50, 200);
    const skip = Number(offset) || 0;
    let query = `
      SELECT forum_topics.*, users.display_name AS author_name, users.role AS author_role
      FROM forum_topics
      LEFT JOIN users ON users.id = forum_topics.user_id
    `;
    const params = [];
    const conditions = [];
    if (sort === 'hot') {
      query += ' LEFT JOIN (SELECT topic_id, COUNT(*) AS like_cnt FROM forum_likes GROUP BY topic_id) lk ON lk.topic_id = forum_topics.id';
      query += ' LEFT JOIN (SELECT topic_id, COUNT(*) AS reply_cnt FROM forum_replies GROUP BY topic_id) rp ON rp.topic_id = forum_topics.id';
    }
    if (!includePending) { conditions.push("forum_topics.moderation_status = 'approved'"); }
    if (category) { conditions.push('forum_topics.category = ?'); params.push(category); }
    if (search) { const esc = String(search).replace(/[%_]/g, '\\$&'); conditions.push("(forum_topics.title LIKE ? ESCAPE '\\' OR forum_topics.content LIKE ? ESCAPE '\\')"); params.push('%' + esc + '%', '%' + esc + '%'); }
    if (hashtag) {
      const escHt = String(hashtag).replace(/[%_]/g, '\\$&');
      conditions.push("forum_topics.hashtags LIKE ? ESCAPE '\\'");
      params.push('%"' + escHt + '"%');
    }
    if (conditions.length) { query += ' WHERE ' + conditions.join(' AND '); }

    if (sort === 'hot') {
      query += ' ORDER BY forum_topics.is_pinned DESC, (COALESCE(lk.like_cnt, 0) * 2 + COALESCE(rp.reply_cnt, 0) * 3) / MAX(julianday("now") - julianday(forum_topics.created_at), 0.5) DESC';
    } else {
      query += ' ORDER BY forum_topics.is_pinned DESC, forum_topics.created_at DESC';
    }
    query += ' LIMIT ? OFFSET ?';
    params.push(maxLimit, skip);
    const topics = db.prepare(query).all(...params);
    const topicIds = topics.map((t) => t.id);
    const repliesMap = batchLoadForumReplies(topicIds, { includePending });
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
    forumUpload(request, response, async (uploadError) => {
      if (uploadError) {
        cleanupUploadedFiles(request.files);
        response.status(400).json({ ok: false, code: 'UPLOAD_FAILED', error: '上传失败。' });
        return;
      }

      let contentStored = false;
      try {
        const title = stripHtml(request.body.title);
        const content = stripHtml(request.body.content);
        const category = sanitizeText(request.body.category || '考研交流');
        if (!title || !content) {
          throw new ForumRequestError(400, 'INVALID_TOPIC', '帖子标题和内容都不能为空。');
        }
        if (title.length > 200) throw new ForumRequestError(400, 'INVALID_TOPIC', '标题不能超过200字。');
        if (content.length > 10000) throw new ForumRequestError(400, 'INVALID_TOPIC', '内容不能超过10000字。');
        if (category.length > 100) throw new ForumRequestError(400, 'INVALID_TOPIC', '分类名称不能超过100字。');

        const imageFiles = request.files?.images || [];
        const videoFiles = request.files?.videos || [];
        const attachmentFiles = request.files?.attachments || [];
        const imagePaths = imageFiles.map((file) => toPublicPath(file.path));
        const videoPaths = videoFiles.map((file) => toPublicPath(file.path));
        const attachmentPaths = attachmentFiles.map((file) => toPublicPath(file.path));
        const links = safeJsonParse(request.body.links || '[]', []);
        const linksJson = JSON.stringify(links);
        if (linksJson.length > 5000) {
          throw new ForumRequestError(400, 'INVALID_TOPIC', '链接信息过长。');
        }

        // 解析 #话题# 标签
        const hashtagRegex = /#([^#\s]+)#/g;
        const extractedTags = [];
        let tagMatch;
        while ((tagMatch = hashtagRegex.exec(content)) !== null) {
          extractedTags.push(tagMatch[1]);
        }

        const uploadedNames = getUploadedFiles(request.files)
          .map((file) => stripHtml(file.originalname || ''))
          .filter(Boolean);
        const securityText = [
          `标题：${title}`,
          `正文：${content}`,
          `分类：${category}`,
          extractedTags.length ? `话题：${extractedTags.join(' ')}` : '',
          uploadedNames.length ? `文件名：${uploadedNames.join(' ')}` : '',
          linksJson !== '[]' ? `链接：${linksJson}` : ''
        ].filter(Boolean).join('\n');

        await enforceForumContentSecurity({
          config,
          db,
          user: request.currentUser,
          text: securityText,
          imageFiles
        });

        const moderation = detectSensitiveWords(db, `${title} ${content}`);
        if (moderation.blocked) {
          throw new ForumRequestError(422, 'LOCAL_CONTENT_REJECTED', '内容包含敏感词：' + moderation.matched.join(', '));
        }
        const pendingReasons = [];
        if (moderation.review) pendingReasons.push('命中本地复核词：' + moderation.matched.join(', '));
        if (videoFiles.length > 0) pendingReasons.push('包含视频，需人工复核');
        if (attachmentFiles.length > 0) pendingReasons.push('包含普通附件，需人工复核');
        const moderationStatus = pendingReasons.length > 0 ? 'pending' : 'approved';
        const now = dayjs().toISOString();

        const topicId = db.transaction(() => {
          const topicResult = db.prepare(
            `INSERT INTO forum_topics
              (user_id, title, content, category, hashtags, image_paths, attachment_paths,
               video_paths, links, moderation_status, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).run(
            request.currentUser.id,
            title,
            content,
            category,
            JSON.stringify(extractedTags),
            JSON.stringify(imagePaths),
            JSON.stringify(attachmentPaths),
            JSON.stringify(videoPaths),
            linksJson,
            moderationStatus,
            now
          );
          if (moderationStatus === 'pending') {
            db.prepare(
              `INSERT INTO content_reports
                (reporter_id, target_type, target_id, reason, status, created_at)
               VALUES (?, 'topic', ?, ?, 'pending', ?)`
            ).run(
              request.currentUser.id,
              topicResult.lastInsertRowid,
              '自动审核：' + pendingReasons.join('；'),
              now
            );
          }
          return topicResult.lastInsertRowid;
        })();
        contentStored = true;

        if (moderationStatus === 'approved') {
          setImmediate(() => {
            try { checkAndUnlockAchievements(request.currentUser.id); } catch (error) {
              console.warn('[Forum] 成就检查失败:', error.message);
            }
          });
          try {
            sendMentionNotifications(content, request.currentUser.id, title);
          } catch (error) {
            console.warn('[Forum] 提及通知发送失败:', error.message);
          }
        }

        response.json({ ok: true, id: topicId, moderationStatus });
      } catch (error) {
        if (!contentStored) cleanupUploadedFiles(request.files);
        sendForumError(response, error);
      }
    });
  });

  app.post('/api/forum/topics/:id/replies', requireAuth, (request, response) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id) || id <= 0) return response.status(400).json({ error: '无效的 ID。' });
    forumUpload(request, response, async (uploadError) => {
      if (uploadError) {
        cleanupUploadedFiles(request.files);
        response.status(400).json({ ok: false, code: 'UPLOAD_FAILED', error: '上传失败。' });
        return;
      }

      let contentStored = false;
      try {
        const content = stripHtml(request.body.content);
        if (!content) throw new ForumRequestError(400, 'INVALID_REPLY', '回复内容不能为空。');
        if (content.length > 10000) throw new ForumRequestError(400, 'INVALID_REPLY', '回复内容不能超过10000字。');

        const topic = db.prepare('SELECT id, title FROM forum_topics WHERE id = ?').get(id);
        if (!topic) throw new ForumRequestError(404, 'TOPIC_NOT_FOUND', '帖子不存在。');

        const imageFiles = request.files?.images || [];
        const videoFiles = request.files?.videos || [];
        const attachmentFiles = request.files?.attachments || [];
        const imagePaths = imageFiles.map((file) => toPublicPath(file.path));
        const videoPaths = videoFiles.map((file) => toPublicPath(file.path));
        const attachmentPaths = attachmentFiles.map((file) => toPublicPath(file.path));
        const links = safeJsonParse(request.body.links || '[]', []);
        const linksJson = JSON.stringify(links);
        if (linksJson.length > 5000) {
          throw new ForumRequestError(400, 'INVALID_REPLY', '链接信息过长。');
        }

        // 楼中楼回复支持
        let replyToId = null;
        let replyToUser = '';
        const replyToIdRaw = request.body.replyToId;
        if (replyToIdRaw) {
          const parentReply = db.prepare(
            'SELECT forum_replies.id, users.display_name FROM forum_replies LEFT JOIN users ON users.id = forum_replies.user_id WHERE forum_replies.id = ? AND forum_replies.topic_id = ?'
          ).get(Number(replyToIdRaw), id);
          if (parentReply) {
            replyToId = parentReply.id;
            replyToUser = parentReply.display_name || '';
          }
        }

        const uploadedNames = getUploadedFiles(request.files)
          .map((file) => stripHtml(file.originalname || ''))
          .filter(Boolean);
        const securityText = [
          `回复：${content}`,
          uploadedNames.length ? `文件名：${uploadedNames.join(' ')}` : '',
          linksJson !== '[]' ? `链接：${linksJson}` : ''
        ].filter(Boolean).join('\n');

        await enforceForumContentSecurity({
          config,
          db,
          user: request.currentUser,
          text: securityText,
          imageFiles
        });

        const moderation = detectSensitiveWords(db, content);
        if (moderation.blocked) {
          throw new ForumRequestError(422, 'LOCAL_CONTENT_REJECTED', '内容包含敏感词：' + moderation.matched.join(', '));
        }
        const pendingReasons = [];
        if (moderation.review) pendingReasons.push('命中本地复核词：' + moderation.matched.join(', '));
        if (videoFiles.length > 0) pendingReasons.push('包含视频，需人工复核');
        if (attachmentFiles.length > 0) pendingReasons.push('包含普通附件，需人工复核');
        const moderationStatus = pendingReasons.length > 0 ? 'pending' : 'approved';
        const now = dayjs().toISOString();

        const replyId = db.transaction(() => {
          const replyResult = db.prepare(
            `INSERT INTO forum_replies
              (topic_id, user_id, content, image_paths, attachment_paths, video_paths,
               links, reply_to_id, reply_to_user, moderation_status, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).run(
            id,
            request.currentUser.id,
            content,
            JSON.stringify(imagePaths),
            JSON.stringify(attachmentPaths),
            JSON.stringify(videoPaths),
            linksJson,
            replyToId,
            replyToUser,
            moderationStatus,
            now
          );
          if (moderationStatus === 'pending') {
            db.prepare(
              `INSERT INTO content_reports
                (reporter_id, target_type, target_id, reason, status, created_at)
               VALUES (?, 'reply', ?, ?, 'pending', ?)`
            ).run(
              request.currentUser.id,
              replyResult.lastInsertRowid,
              '自动审核：' + pendingReasons.join('；'),
              now
            );
          }
          return replyResult.lastInsertRowid;
        })();
        contentStored = true;

        if (moderationStatus === 'approved') {
          try {
            sendMentionNotifications(content, request.currentUser.id, topic.title || '回复');
          } catch (error) {
            console.warn('[Forum] 提及通知发送失败:', error.message);
          }
        }

        response.json({ ok: true, id: replyId, moderationStatus });
      } catch (error) {
        if (!contentStored) cleanupUploadedFiles(request.files);
        sendForumError(response, error);
      }
    });
  });

  // 论坛收藏列表（必须在 :id 路由之前，否则被参数路由遮蔽）
  app.get('/api/forum/topics/favorites', requireAuth, (request, response) => {
    const { category } = request.query;
    const includePending = isModerator(request.currentUser);
    let query = `
      SELECT forum_topics.*, users.display_name AS author_name, users.role AS author_role
      FROM forum_favorites
      JOIN forum_topics ON forum_topics.id = forum_favorites.topic_id
      LEFT JOIN users ON users.id = forum_topics.user_id
      WHERE forum_favorites.user_id = ?
    `;
    const params = [request.currentUser.id];
    if (!includePending) { query += " AND forum_topics.moderation_status = 'approved'"; }
    if (category) { query += ' AND forum_topics.category = ?'; params.push(category); }
    query += ' ORDER BY forum_favorites.created_at DESC LIMIT 50';
    const topics = db.prepare(query).all(...params);
    const topicIds = topics.map((t) => t.id);
    const repliesMap = batchLoadForumReplies(topicIds, { includePending });
    const likesMap = batchLoadForumLikes(topicIds, request.currentUser.id);
    response.json({ topics: topics.map((t) => serializeForumTopic(t, repliesMap, likesMap)) });
  });

  // 帖子详情
  app.get('/api/forum/topics/:id', requireAuth, (request, response) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id) || id <= 0) return response.status(400).json({ error: '无效的 ID。' });
    const includePending = isModerator(request.currentUser);
    const topic = db.prepare(
      `SELECT forum_topics.*, users.display_name AS author_name, users.role AS author_role
       FROM forum_topics
       LEFT JOIN users ON users.id = forum_topics.user_id
       WHERE forum_topics.id = ?`
    ).get(id);

    if (!topic) {
      response.status(404).json({ error: '帖子不存在。' });
      return;
    }
    if (!includePending && topic.moderation_status !== 'approved') {
      return response.status(403).json({ error: '该帖子正在审核中，暂不可见。' });
    }

    const repliesMap = batchLoadForumReplies([topic.id], { includePending });
    const likesMap = batchLoadForumLikes([topic.id], request.currentUser.id);
    response.json({ topic: serializeForumTopic(topic, repliesMap, likesMap) });
  });

  // 帖子点赞/取消
  app.post('/api/forum/topics/:id/like', requireAuth, (request, response) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id) || id <= 0) return response.status(400).json({ error: '无效的 ID。' });
    const topic = db.prepare('SELECT id FROM forum_topics WHERE id = ?').get(id);
    if (!topic) {
      response.status(404).json({ error: '帖子不存在。' });
      return;
    }

    const existing = db.prepare(
      'SELECT id FROM forum_likes WHERE topic_id = ? AND user_id = ?'
    ).get(id, request.currentUser.id);

    let liked;
    if (existing) {
      db.prepare('DELETE FROM forum_likes WHERE id = ?').run(existing.id);
      liked = false;
    } else {
      db.prepare(
        'INSERT INTO forum_likes (topic_id, user_id, created_at) VALUES (?, ?, ?)'
      ).run(id, request.currentUser.id, dayjs().toISOString());
      liked = true;
    }

    const likeCount = db.prepare(
      'SELECT COUNT(*) AS count FROM forum_likes WHERE topic_id = ?'
    ).get(id).count;

    response.json({ liked, likeCount });
  });

  // 论坛收藏切换
  app.post('/api/forum/topics/:id/favorite', requireAuth, (request, response) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id) || id <= 0) return response.status(400).json({ error: '无效的 ID。' });
    const topic = db.prepare('SELECT id FROM forum_topics WHERE id = ?').get(id);
    if (!topic) { response.status(404).json({ error: '帖子不存在。' }); return; }

    const existing = db.prepare('SELECT id FROM forum_favorites WHERE topic_id = ? AND user_id = ?').get(id, request.currentUser.id);
    let favorited;
    if (existing) {
      db.prepare('DELETE FROM forum_favorites WHERE id = ?').run(existing.id);
      favorited = false;
    } else {
      db.prepare('INSERT INTO forum_favorites (topic_id, user_id, created_at) VALUES (?, ?, ?)').run(id, request.currentUser.id, dayjs().toISOString());
      favorited = true;
    }
    response.json({ favorited });
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
    const id = Number(request.params.id);
    if (!Number.isInteger(id) || id <= 0) return response.status(400).json({ error: '无效的 ID。' });
    const pinned = Number(request.body.pinned) || 0;
    db.prepare('UPDATE forum_topics SET is_pinned = ? WHERE id = ?').run(pinned, id);
    response.json({ ok: true });
  });

  app.post('/api/forum/topics/:id/feature', requireAuth, (request, response) => {
    if (request.currentUser.role !== 'teacher' && request.currentUser.role !== 'admin') {
      return response.status(403).json({ error: '无权限操作。' });
    }
    const featured = Number(request.body.featured) || 0;
    const id = Number(request.params.id);
    if (!Number.isInteger(id) || id <= 0) return response.status(400).json({ error: '无效的 ID。' });
    db.prepare('UPDATE forum_topics SET is_featured = ? WHERE id = ?').run(featured, id);
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

  // 删除帖子（仅作者或管理员/教师可删）
  app.delete('/api/forum/topics/:id', requireAuth, (request, response) => {
    const topicId = Number(request.params.id);
    const topic = db.prepare('SELECT user_id FROM forum_topics WHERE id = ?').get(topicId);
    if (!topic) { return response.status(404).json({ error: '帖子不存在。' }); }
    const role = request.currentUser.role;
    if (topic.user_id !== request.currentUser.id && role !== 'admin' && role !== 'teacher') {
      return response.status(403).json({ error: '无权删除此帖子。' });
    }
    db.transaction(() => {
      db.prepare('DELETE FROM forum_likes WHERE topic_id = ?').run(topicId);
      db.prepare('DELETE FROM forum_endorsements WHERE topic_id = ?').run(topicId);
      db.prepare('DELETE FROM forum_favorites WHERE topic_id = ?').run(topicId);
      db.prepare('DELETE FROM forum_replies WHERE topic_id = ?').run(topicId);
      db.prepare('DELETE FROM forum_topics WHERE id = ?').run(topicId);
    })();
    response.json({ ok: true });
  });

  // 内容审核 API — 供小程序端 cloudAuditText 调用
  app.post('/api/content/audit', requireAuth, (request, response) => {
    const { text } = request.body;
    if (!text) return response.status(400).json({ error: '缺少文本内容' });
    const moderation = detectSensitiveWords(db, String(text));
    response.json({
      passed: !moderation.blocked && !moderation.review,
      hitWords: moderation.matched,
      status: moderation.blocked ? 'rejected' : (moderation.review ? 'pending' : 'passed'),
      level: moderation.level
    });
  });
};

module.exports._private = {
  cleanupUploadedFiles,
  splitSecurityText,
  detectImageContentType,
  enforceForumContentSecurity
};
