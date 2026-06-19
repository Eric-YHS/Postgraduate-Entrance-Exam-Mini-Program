const path = require('path');
const fs = require('fs');
const dayjs = require('dayjs');
const { sanitizeText } = require('../utils/sanitize');

module.exports = function registerCourseRoutes(app, shared) {
  const { db, requireTeacher, requireAuth, requireRole, toPublicPath, uploadRootDir, courseUpload, cloudUpload, safeJsonParse, stripHtml, serializeCourse, canAccessContent } = shared;

  // 创建课程
  app.post('/api/courses', requireTeacher, (request, response) => {
    courseUpload(request, response, (error) => {
      if (error) {
        response.status(400).json({ error: '课程上传失败。' });
        return;
      }

      const title = sanitizeText(request.body.title);
      if (!title) {
        response.status(400).json({ error: '课程标题不能为空。' });
        return;
      }

      const visibility = String(request.body.visibility || 'free').trim();
      const validVisibilities = ['free', 'preview', 'trial_paid', 'subject_paid', 'all_paid'];
      if (!validVisibilities.includes(visibility)) {
        response.status(400).json({ error: '无效的可见性类型。' });
        return;
      }

      const courseResult = db.prepare(
        `
          INSERT INTO courses (
            title, description, subject, category_id, visibility, subject_scope, video_path, video_url, created_by, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
      ).run(
        title,
        sanitizeText(request.body.description),
        sanitizeText(request.body.subject || '考研规划'),
        request.body.categoryId ? Number(request.body.categoryId) : null,
        visibility,
        sanitizeText(request.body.subjectScope || ''),
        request.file ? toPublicPath(request.file.path) : '',
        String(request.body.videoUrl || '').trim(),
        request.currentUser.id,
        dayjs().toISOString()
      );

      response.json({ ok: true, id: courseResult.lastInsertRowid });
    });
  });

  // 课程列表
  app.get('/api/courses', requireAuth, (request, response) => {
    const rows = db
      .prepare('SELECT courses.*, users.display_name AS teacher_name FROM courses LEFT JOIN users ON users.id = courses.created_by ORDER BY courses.created_at DESC LIMIT 100')
      .all();
    const courses = rows.map(serializeCourse);
    if (request.currentUser.role === 'student') {
      response.json({ courses: courses.filter((course) => canAccessContent(request.currentUser.id, { visibility: course.visibility, subjectScope: course.subjectScope, subject: course.subject })) });
      return;
    }
    response.json({ courses });
  });

  // 获取单条课程详情
  app.get('/api/courses/:id', requireAuth, (request, response) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id) || id <= 0) return response.status(400).json({ error: '无效的 ID。' });
    const course = db.prepare(
      'SELECT courses.*, users.display_name AS teacher_name FROM courses LEFT JOIN users ON users.id = courses.created_by WHERE courses.id = ?'
    ).get(id);
    if (!course) {
      response.status(404).json({ error: '课程不存在。' });
      return;
    }
    const serialized = serializeCourse(course);
    if (request.currentUser.role === 'student' && !canAccessContent(request.currentUser.id, { visibility: serialized.visibility, subjectScope: serialized.subjectScope, subject: serialized.subject })) {
      response.status(403).json({ error: '当前权益不足，无法访问该课程。' });
      return;
    }
    response.json(serialized);
  });

  // 文件夹（网盘）API
  function serializeFolder(row) {
    return {
      id: row.id,
      name: row.name,
      parentId: row.parent_id,
      createdBy: row.created_by,
      createdAt: row.created_at
    };
  }

  function serializeFolderItem(row, accessInfo = {}) {
    const item = {
      id: row.id,
      folderId: row.folder_id,
      chapterId: row.chapter_id || null,
      chapterTitle: row.chapter_title || '',
      itemType: row.item_type,
      title: row.title,
      description: row.description,
      subject: row.subject,
      visibility: row.visibility || 'free',
      subjectScope: row.subject_scope || '',
      filePath: row.file_path,
      fileUrl: row.file_url,
      fileSize: row.file_size,
      sortOrder: row.sort_order,
      isFreePreview: row.is_free_preview || 0,
      createdBy: row.created_by,
      createdAt: row.created_at
    };
    if (accessInfo.locked) {
      item.locked = true;
      item.filePath = '';
      item.fileUrl = '';
    }
    return item;
  }

  function getFolderChildren(rawParentId, studentId = null) {
    const parentId = rawParentId === null || rawParentId === undefined || rawParentId === ''
      ? null
      : Number(rawParentId);
    if (parentId !== null && (!Number.isInteger(parentId) || parentId <= 0)) {
      return { folders: [], items: [] };
    }

    const folders = db.prepare('SELECT * FROM folders WHERE parent_id IS ? ORDER BY name').all(parentId);
    const rows = db.prepare(`
      SELECT fi.*, cc.title AS chapter_title
      FROM folder_items fi
      LEFT JOIN course_chapters cc ON cc.id = fi.chapter_id
      WHERE fi.folder_id IS ?
      ORDER BY fi.sort_order, fi.created_at DESC
    `).all(parentId);
    const items = rows.map((row) => {
      if (studentId) {
        const canAccess = (row.is_free_preview || 0) || canAccessContent(studentId, { visibility: row.visibility, subjectScope: row.subject_scope, subject: row.subject });
        return serializeFolderItem(row, { locked: !canAccess });
      }
      return serializeFolderItem(row);
    });
    return { folders: folders.map(serializeFolder), items };
  }

  function getFolderPath(folderId) {
    const breadcrumbs = [];
    const visited = new Set();
    let currentId = folderId;
    while (currentId) {
      if (visited.has(currentId)) break; // 防止循环引用
      visited.add(currentId);
      const folder = db.prepare('SELECT * FROM folders WHERE id = ?').get(currentId);
      if (!folder) break;
      breadcrumbs.unshift({ id: folder.id, name: folder.name });
      currentId = folder.parent_id;
    }
    return breadcrumbs;
  }

  const MAX_NAME_LENGTH = 100;

  app.get('/api/folders', requireAuth, (request, response) => {
    const { parentId, subject } = request.query;
    const studentId = request.currentUser.role === 'student' ? request.currentUser.id : null;
    const children = getFolderChildren(parentId || null, studentId);
    if (subject) {
      children.items = children.items.filter((item) => item.subject === subject);
    }
    response.json({
      path: parentId ? getFolderPath(Number(parentId)) : [],
      ...children
    });
  });

  app.get('/api/folders/:id', requireAuth, (request, response) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id) || id <= 0) return response.status(400).json({ error: '无效的 ID。' });
    const folder = db.prepare('SELECT * FROM folders WHERE id = ?').get(id);
    if (!folder) {
      response.status(404).json({ error: '文件夹不存在。' });
      return;
    }

    const studentId = request.currentUser.role === 'student' ? request.currentUser.id : null;
    const children = getFolderChildren(folder.id, studentId);
    response.json({
      folder: serializeFolder(folder),
      path: getFolderPath(folder.id),
      ...children
    });
  });

  app.post('/api/folders', requireTeacher, (request, response) => {
    const name = sanitizeText(request.body.name);
    if (!name) {
      response.status(400).json({ error: '文件夹名称不能为空。' });
      return;
    }
    if (name.length > MAX_NAME_LENGTH) {
      response.status(400).json({ error: `名称不能超过${MAX_NAME_LENGTH}个字符。` });
      return;
    }

    const parentId = request.body.parentId || null;
    const now = dayjs().toISOString();
    const result = db.prepare('INSERT INTO folders (name, parent_id, created_by, created_at) VALUES (?, ?, ?, ?)').run(name, parentId, request.currentUser.id, now);
    response.json({ ok: true, id: result.lastInsertRowid });
  });

  app.put('/api/folders/:id', requireTeacher, (request, response) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id) || id <= 0) return response.status(400).json({ error: '无效的 ID。' });
    const folder = db.prepare('SELECT * FROM folders WHERE id = ?').get(id);
    if (!folder) {
      response.status(404).json({ error: '文件夹不存在。' });
      return;
    }
    // BUG-007: 校验所有权
    if (folder.created_by !== request.currentUser.id) {
      response.status(403).json({ error: '无权操作其他教师的文件夹。' });
      return;
    }

    const name = sanitizeText(request.body.name);
    if (!name) {
      response.status(400).json({ error: '文件夹名称不能为空。' });
      return;
    }

    const parentId = request.body.parentId !== undefined ? request.body.parentId : folder.parent_id;

    // 检测循环引用：parentId 不能是自身，也不能是自身的后代
    if (parentId && Number(parentId) !== folder.parent_id) {
      if (Number(parentId) === folder.id) {
        response.status(400).json({ error: '不能将文件夹设为自己的子文件夹。' });
        return;
      }
      let ancestorId = Number(parentId);
      const visited = new Set();
      while (ancestorId) {
        if (ancestorId === folder.id) {
          response.status(400).json({ error: '不能将文件夹移动到其子文件夹中，这会形成循环。' });
          return;
        }
        if (visited.has(ancestorId)) break;
        visited.add(ancestorId);
        const parent = db.prepare('SELECT parent_id FROM folders WHERE id = ?').get(ancestorId);
        ancestorId = parent ? parent.parent_id : null;
      }
    }

    db.prepare('UPDATE folders SET name = ?, parent_id = ? WHERE id = ?').run(name, parentId, id);
    response.json({ ok: true });
  });

  // BUG-050: 删除文件夹时清理关联磁盘文件; BUG-077: 返回 204
  app.delete('/api/folders/:id', requireTeacher, (request, response) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id) || id <= 0) return response.status(400).json({ error: '无效的 ID。' });
    const folder = db.prepare('SELECT * FROM folders WHERE id = ?').get(id);
    if (!folder) {
      response.status(404).json({ error: '文件夹不存在。' });
      return;
    }
    // BUG-007: 校验文件夹所有权
    if (folder.created_by !== request.currentUser.id) {
      response.status(403).json({ error: '无权操作其他教师的文件夹。' });
      return;
    }

    // 清理文件夹内所有 item 的磁盘文件
    const items = db.prepare('SELECT file_path FROM folder_items WHERE folder_id = ?').all(id);
    items.forEach((item) => {
      if (item.file_path) {
        const diskPath = path.join(uploadRootDir, item.file_path.replace(/^\/uploads/, ''));
        fs.unlink(diskPath, () => {});
      }
    });

    db.prepare('DELETE FROM folders WHERE id = ?').run(id);
    response.status(204).end();
  });

  app.post('/api/folder-items', requireTeacher, (request, response) => {
    cloudUpload(request, response, (error) => {
      if (error) {
        response.status(400).json({ error: '文件上传失败。' });
        return;
      }

      const title = sanitizeText(request.body.title);
      const folderId = Number(request.body.folderId) || null;
      const itemType = String(request.body.itemType || 'video').trim();
      const validItemTypes = ['course', 'file', 'video'];
      if (!validItemTypes.includes(itemType)) {
        response.status(400).json({ error: '无效的文件类型。' });
        return;
      }
      const fileUrl = String(request.body.fileUrl || '').trim();
      const visibility = String(request.body.visibility || 'free').trim();
      const validVisibilities = ['free', 'preview', 'trial_paid', 'subject_paid', 'all_paid'];
      if (!validVisibilities.includes(visibility)) {
        response.status(400).json({ error: '无效的可见性类型。' });
        return;
      }
      const chapterId = request.body.chapterId ? Number(request.body.chapterId) : null;
      const sortOrder = Number(request.body.sortOrder) || 0;
      const isFreePreview = request.body.isFreePreview === true || request.body.isFreePreview === '1' || request.body.isFreePreview === 1 ? 1 : 0;

      if (!title) {
        response.status(400).json({ error: '文件标题不能为空。' });
        return;
      }

      if (!folderId) {
        response.status(400).json({ error: '请选择目标文件夹。' });
        return;
      }

      const now = dayjs().toISOString();
      db.prepare(
        `INSERT INTO folder_items (folder_id, chapter_id, item_type, title, description, subject, visibility, subject_scope, file_path, file_url, file_size, sort_order, is_free_preview, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        folderId,
        chapterId,
        itemType,
        title,
        sanitizeText(request.body.description),
        sanitizeText(request.body.subject),
        visibility,
        sanitizeText(request.body.subjectScope || ''),
        request.file ? toPublicPath(request.file.path) : '',
        fileUrl,
        request.file ? request.file.size : 0,
        sortOrder,
        isFreePreview,
        request.currentUser.id,
        now
      );

      response.json({ ok: true });
    });
  });

  app.delete('/api/folder-items/:id', requireTeacher, (request, response) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id) || id <= 0) return response.status(400).json({ error: '无效的 ID。' });
    const item = db.prepare('SELECT * FROM folder_items WHERE id = ?').get(id);
    if (!item) {
      response.status(404).json({ error: '文件不存在。' });
      return;
    }
    // BUG-007: 校验所有权
    if (item.created_by !== request.currentUser.id) {
      response.status(403).json({ error: '无权操作其他教师的文件。' });
      return;
    }

    // BUG-050: 删除文件项时清理磁盘文件
    if (item.file_path) {
      const diskPath = path.join(uploadRootDir, item.file_path.replace(/^\/uploads/, ''));
      fs.unlink(diskPath, () => {});
    }

    db.prepare('DELETE FROM folder_items WHERE id = ?').run(id);
    response.status(204).end();
  });

  // 更新文件项（试看、排序、章节、可见性）
  app.put('/api/folder-items/:id', requireTeacher, (request, response) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id) || id <= 0) return response.status(400).json({ error: '无效的 ID。' });
    const item = db.prepare('SELECT * FROM folder_items WHERE id = ?').get(id);
    if (!item) return response.status(404).json({ error: '文件不存在。' });
    if (item.created_by !== request.currentUser.id) return response.status(403).json({ error: '无权操作其他教师的文件。' });

    const updates = [];
    const params = [];
    const body = request.body || {};
    if (body.title !== undefined) { updates.push('title = ?'); params.push(sanitizeText(body.title)); }
    if (body.description !== undefined) { updates.push('description = ?'); params.push(sanitizeText(body.description)); }
    if (body.subject !== undefined) { updates.push('subject = ?'); params.push(sanitizeText(body.subject)); }
    if (body.visibility !== undefined) { updates.push('visibility = ?'); params.push(body.visibility); }
    if (body.subjectScope !== undefined) { updates.push('subject_scope = ?'); params.push(sanitizeText(body.subjectScope)); }
    if (body.chapterId !== undefined) { updates.push('chapter_id = ?'); params.push(body.chapterId ? Number(body.chapterId) : null); }
    if (body.sortOrder !== undefined) { updates.push('sort_order = ?'); params.push(Number(body.sortOrder) || 0); }
    if (body.isFreePreview !== undefined) { updates.push('is_free_preview = ?'); params.push(body.isFreePreview === true || body.isFreePreview === '1' || body.isFreePreview === 1 ? 1 : 0); }

    if (!updates.length) return response.status(400).json({ error: '没有需要更新的字段。' });
    params.push(id);
    db.prepare(`UPDATE folder_items SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    response.json({ ok: true });
  });

  // 课程章节管理
  app.get('/api/courses/:id/chapters', requireAuth, (request, response) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id) || id <= 0) return response.status(400).json({ error: '无效的 ID。' });
    const course = db.prepare('SELECT * FROM courses WHERE id = ?').get(id);
    if (!course) return response.status(404).json({ error: '课程不存在。' });

    const chapters = db.prepare('SELECT * FROM course_chapters WHERE course_id = ? ORDER BY sort_order, created_at ASC').all(id);
    const items = db.prepare('SELECT * FROM folder_items WHERE folder_id IN (SELECT id FROM folders WHERE parent_id IS NULL) AND chapter_id IN (SELECT id FROM course_chapters WHERE course_id = ?) ORDER BY sort_order, created_at ASC').all(id);
    // 简单方案：章节与 folder_items 通过 chapter_id 关联，不限制 folder_id
    const itemsByChapter = {};
    const rows = db.prepare('SELECT fi.* FROM folder_items fi WHERE fi.chapter_id IN (SELECT id FROM course_chapters WHERE course_id = ?) ORDER BY fi.sort_order, fi.created_at ASC').all(id);
    rows.forEach((row) => {
      if (!itemsByChapter[row.chapter_id]) itemsByChapter[row.chapter_id] = [];
      const studentId = request.currentUser.role === 'student' ? request.currentUser.id : null;
      const canAccess = studentId ? ((row.is_free_preview || 0) || canAccessContent(studentId, { visibility: row.visibility, subjectScope: row.subject_scope, subject: row.subject })) : true;
      itemsByChapter[row.chapter_id].push(serializeFolderItem(row, { locked: studentId ? !canAccess : false }));
    });

    response.json({
      chapters: chapters.map((c) => ({ id: c.id, courseId: c.course_id, title: c.title, sortOrder: c.sort_order, createdAt: c.created_at, items: itemsByChapter[c.id] || [] }))
    });
  });

  app.post('/api/courses/:id/chapters', requireTeacher, (request, response) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id) || id <= 0) return response.status(400).json({ error: '无效的 ID。' });
    const course = db.prepare('SELECT * FROM courses WHERE id = ?').get(id);
    if (!course) return response.status(404).json({ error: '课程不存在。' });
    if (course.created_by !== request.currentUser.id) return response.status(403).json({ error: '无权操作。' });
    const title = sanitizeText(request.body.title);
    if (!title) return response.status(400).json({ error: '章节标题不能为空。' });
    const sortOrder = Number(request.body.sortOrder) || 0;
    const result = db.prepare('INSERT INTO course_chapters (course_id, title, sort_order, created_at) VALUES (?, ?, ?, ?)').run(id, title, sortOrder, dayjs().toISOString());
    response.json({ ok: true, id: result.lastInsertRowid });
  });

  app.put('/api/courses/:id/chapters/:chapterId', requireTeacher, (request, response) => {
    const id = Number(request.params.id);
    const chapterId = Number(request.params.chapterId);
    if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(chapterId) || chapterId <= 0) return response.status(400).json({ error: '无效的 ID。' });
    const chapter = db.prepare('SELECT * FROM course_chapters WHERE id = ? AND course_id = ?').get(chapterId, id);
    if (!chapter) return response.status(404).json({ error: '章节不存在。' });
    const course = db.prepare('SELECT created_by FROM courses WHERE id = ?').get(id);
    if (course && course.created_by !== request.currentUser.id) return response.status(403).json({ error: '无权操作。' });

    const updates = [];
    const params = [];
    if (request.body.title !== undefined) { updates.push('title = ?'); params.push(sanitizeText(request.body.title)); }
    if (request.body.sortOrder !== undefined) { updates.push('sort_order = ?'); params.push(Number(request.body.sortOrder) || 0); }
    if (!updates.length) return response.status(400).json({ error: '没有需要更新的字段。' });
    params.push(chapterId);
    db.prepare(`UPDATE course_chapters SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    response.json({ ok: true });
  });

  app.delete('/api/courses/:id/chapters/:chapterId', requireTeacher, (request, response) => {
    const id = Number(request.params.id);
    const chapterId = Number(request.params.chapterId);
    if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(chapterId) || chapterId <= 0) return response.status(400).json({ error: '无效的 ID。' });
    const chapter = db.prepare('SELECT * FROM course_chapters WHERE id = ? AND course_id = ?').get(chapterId, id);
    if (!chapter) return response.status(404).json({ error: '章节不存在。' });
    const course = db.prepare('SELECT created_by FROM courses WHERE id = ?').get(id);
    if (course && course.created_by !== request.currentUser.id) return response.status(403).json({ error: '无权操作。' });
    db.prepare('DELETE FROM course_chapters WHERE id = ?').run(chapterId);
    response.status(204).end();
  });

  // 课程笔记
  app.get('/api/courses/:id/notes', requireAuth, (request, response) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id) || id <= 0) return response.status(400).json({ error: '无效的 ID。' });
    const notes = db.prepare(
      'SELECT * FROM course_notes WHERE item_id = ? AND student_id = ? ORDER BY timestamp_seconds ASC'
    ).all(id, request.currentUser.id);
    response.json({ notes });
  });

  app.post('/api/courses/:id/notes', requireAuth, (request, response) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id) || id <= 0) return response.status(400).json({ error: '无效的 ID。' });
    const content = stripHtml(request.body.content);
    if (!content) { response.status(400).json({ error: '笔记内容不能为空。' }); return; }
    db.prepare(
      'INSERT INTO course_notes (item_id, student_id, content, timestamp_seconds, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(id, request.currentUser.id, content, Number(request.body.timestampSeconds) || 0, dayjs().toISOString());
    response.json({ ok: true });
  });

  app.delete('/api/courses/:id/notes/:noteId', requireAuth, (request, response) => {
    db.prepare('DELETE FROM course_notes WHERE id = ? AND student_id = ?').run(request.params.noteId, request.currentUser.id);
    response.json({ ok: true });
  });

  // 课程评价
  app.get('/api/courses/:id/reviews', requireAuth, (request, response) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id) || id <= 0) return response.status(400).json({ error: '无效的 ID。' });
    const currentUserId = request.currentUser.id;
    const reviews = db.prepare(
      `SELECT course_reviews.*, users.display_name AS student_name
       FROM course_reviews
       LEFT JOIN users ON users.id = course_reviews.student_id
       WHERE course_reviews.item_id = ? ORDER BY course_reviews.created_at DESC`
    ).all(id);
    const reviewIds = reviews.map((r) => r.id);
    const likedSet = new Set();
    if (reviewIds.length) {
      const placeholders = reviewIds.map(() => '?').join(',');
      const likedRows = db.prepare(
        `SELECT review_id FROM course_review_likes WHERE review_id IN (${placeholders}) AND user_id = ?`
      ).all(...reviewIds, currentUserId);
      likedRows.forEach((row) => likedSet.add(row.review_id));
    }
    const myReview = db.prepare('SELECT * FROM course_reviews WHERE item_id = ? AND student_id = ?').get(id, currentUserId);
    const reviewList = reviews.map((r) => ({
      ...r,
      liked: likedSet.has(r.id),
    }));
    response.json({ reviews: reviewList, myReview });
  });

  app.post('/api/courses/:id/reviews', requireAuth, (request, response) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id) || id <= 0) return response.status(400).json({ error: '无效的 ID。' });
    const rating = Number(request.body.rating);
    if (!rating || rating < 1 || rating > 5) { response.status(400).json({ error: '评分须为1-5。' }); return; }
    const content = sanitizeText(request.body.content || '');
    const now = dayjs().toISOString();

    db.prepare(
      `INSERT INTO course_reviews (item_id, student_id, rating, content, likes, created_at)
       VALUES (?, ?, ?, ?, 0, ?)
       ON CONFLICT(item_id, student_id)
       DO UPDATE SET rating = excluded.rating, content = excluded.content, created_at = excluded.created_at`
    ).run(id, request.currentUser.id, rating, content, now);

    response.json({ ok: true });
  });

  // 课程评价点赞/取消点赞
  app.post('/api/course-reviews/:id/like', requireAuth, (request, response) => {
    const reviewId = Number(request.params.id);
    if (!Number.isInteger(reviewId) || reviewId <= 0) return response.status(400).json({ error: '无效的 ID。' });
    const userId = request.currentUser.id;
    const liked = db.prepare('SELECT id FROM course_review_likes WHERE review_id = ? AND user_id = ?').get(reviewId, userId);
    const now = dayjs().toISOString();

    try {
      if (liked) {
        db.prepare('DELETE FROM course_review_likes WHERE review_id = ? AND user_id = ?').run(reviewId, userId);
        db.prepare('UPDATE course_reviews SET likes = CASE WHEN likes > 0 THEN likes - 1 ELSE 0 END WHERE id = ?').run(reviewId);
        response.json({ ok: true, liked: false });
      } else {
        db.prepare('INSERT OR IGNORE INTO course_review_likes (review_id, user_id, created_at) VALUES (?, ?, ?)').run(reviewId, userId, now);
        db.prepare('UPDATE course_reviews SET likes = likes + 1 WHERE id = ?').run(reviewId);
        response.json({ ok: true, liked: true });
      }
    } catch (error) {
      console.error('课程评价点赞失败:', error);
      response.status(500).json({ error: '操作失败，请稍后重试。' });
    }
  });

  // 课程分类
  app.get('/api/course-categories', requireAuth, (_request, response) => {
    const rows = db.prepare('SELECT * FROM course_categories ORDER BY type, sort_order, id').all();
    response.json({ categories: rows });
  });

  app.post('/api/admin/course-categories', requireRole(['admin', 'teacher']), (request, response) => {
    const { name, type = 'public', parentId, sortOrder = 0 } = request.body || {};
    const cleanName = sanitizeText(name);
    if (!cleanName) return response.status(400).json({ error: '分类名称不能为空。' });
    if (!['public', 'major'].includes(type)) return response.status(400).json({ error: '无效的分类类型。' });
    const result = db.prepare('INSERT INTO course_categories (name, type, parent_id, sort_order, created_at) VALUES (?, ?, ?, ?, ?)').run(cleanName, type, parentId ? Number(parentId) : null, Number(sortOrder) || 0, dayjs().toISOString());
    response.json({ ok: true, id: result.lastInsertRowid });
  });

  app.put('/api/admin/course-categories/:id', requireRole(['admin', 'teacher']), (request, response) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id) || id <= 0) return response.status(400).json({ error: '无效的 ID。' });
    const cat = db.prepare('SELECT * FROM course_categories WHERE id = ?').get(id);
    if (!cat) return response.status(404).json({ error: '分类不存在。' });
    const updates = [];
    const params = [];
    if (request.body.name !== undefined) { updates.push('name = ?'); params.push(sanitizeText(request.body.name)); }
    if (request.body.type !== undefined) { updates.push('type = ?'); params.push(request.body.type); }
    if (request.body.parentId !== undefined) { updates.push('parent_id = ?'); params.push(request.body.parentId ? Number(request.body.parentId) : null); }
    if (request.body.sortOrder !== undefined) { updates.push('sort_order = ?'); params.push(Number(request.body.sortOrder) || 0); }
    if (!updates.length) return response.status(400).json({ error: '没有需要更新的字段。' });
    params.push(id);
    db.prepare(`UPDATE course_categories SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    response.json({ ok: true });
  });

  app.delete('/api/admin/course-categories/:id', requireRole(['admin', 'teacher']), (request, response) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id) || id <= 0) return response.status(400).json({ error: '无效的 ID。' });
    db.prepare('DELETE FROM course_categories WHERE id = ?').run(id);
    response.status(204).end();
  });
};
