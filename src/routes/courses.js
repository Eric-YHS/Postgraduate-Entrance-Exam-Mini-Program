const path = require('path');
const fs = require('fs');
const dayjs = require('dayjs');
const { sanitizeText } = require('../utils/sanitize');

module.exports = function registerCourseRoutes(app, shared) {
  const { db, requireTeacher, requireAuth, toPublicPath, uploadRootDir, courseUpload, cloudUpload, safeJsonParse, stripHtml, serializeCourse } = shared;

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

      const courseResult = db.prepare(
        `
          INSERT INTO courses (
            title, description, subject, video_path, video_url, created_by, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `
      ).run(
        title,
        sanitizeText(request.body.description),
        sanitizeText(request.body.subject || '考研规划'),
        request.file ? toPublicPath(request.file.path) : '',
        String(request.body.videoUrl || '').trim(),
        request.currentUser.id,
        dayjs().toISOString()
      );

      response.json({ ok: true, id: courseResult.lastInsertRowid });
    });
  });

  // 获取单条课程详情
  app.get('/api/courses/:id', requireAuth, (request, response) => {
    const course = db.prepare(
      'SELECT courses.*, users.display_name AS teacher_name FROM courses LEFT JOIN users ON users.id = courses.created_by WHERE courses.id = ?'
    ).get(request.params.id);
    if (!course) {
      response.status(404).json({ error: '课程不存在。' });
      return;
    }
    response.json(serializeCourse(course));
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

  function serializeFolderItem(row) {
    return {
      id: row.id,
      folderId: row.folder_id,
      itemType: row.item_type,
      title: row.title,
      description: row.description,
      subject: row.subject,
      filePath: row.file_path,
      fileUrl: row.file_url,
      fileSize: row.file_size,
      sortOrder: row.sort_order,
      createdBy: row.created_by,
      createdAt: row.created_at
    };
  }

  function getFolderChildren(parentId) {
    const folders = db.prepare('SELECT * FROM folders WHERE parent_id ' + (parentId ? '= ?' : 'IS NULL') + ' ORDER BY name').all(...(parentId ? [parentId] : []));
    const items = db.prepare('SELECT * FROM folder_items WHERE folder_id ' + (parentId ? '= ?' : 'IS NULL') + ' ORDER BY sort_order, created_at DESC').all(...(parentId ? [parentId] : []));
    return {
      folders: folders.map(serializeFolder),
      items: items.map(serializeFolderItem)
    };
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
    const children = getFolderChildren(parentId || null);
    if (subject) {
      children.items = children.items.filter((item) => item.subject === subject);
    }
    response.json({
      path: parentId ? getFolderPath(Number(parentId)) : [],
      ...children
    });
  });

  app.get('/api/folders/:id', requireAuth, (request, response) => {
    const folder = db.prepare('SELECT * FROM folders WHERE id = ?').get(request.params.id);
    if (!folder) {
      response.status(404).json({ error: '文件夹不存在。' });
      return;
    }

    const children = getFolderChildren(folder.id);
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
    const folder = db.prepare('SELECT * FROM folders WHERE id = ?').get(request.params.id);
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

    db.prepare('UPDATE folders SET name = ?, parent_id = ? WHERE id = ?').run(name, parentId, request.params.id);
    response.json({ ok: true });
  });

  // BUG-050: 删除文件夹时清理关联磁盘文件; BUG-077: 返回 204
  app.delete('/api/folders/:id', requireTeacher, (request, response) => {
    const folder = db.prepare('SELECT * FROM folders WHERE id = ?').get(request.params.id);
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
    const items = db.prepare('SELECT file_path FROM folder_items WHERE folder_id = ?').all(request.params.id);
    items.forEach((item) => {
      if (item.file_path) {
        const diskPath = path.join(uploadRootDir, item.file_path.replace(/^\/uploads/, ''));
        fs.unlink(diskPath, () => {});
      }
    });

    db.prepare('DELETE FROM folders WHERE id = ?').run(request.params.id);
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
      const fileUrl = String(request.body.fileUrl || '').trim();

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
        `INSERT INTO folder_items (folder_id, item_type, title, description, subject, file_path, file_url, file_size, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        folderId,
        itemType,
        title,
        sanitizeText(request.body.description),
        sanitizeText(request.body.subject),
        request.file ? toPublicPath(request.file.path) : '',
        fileUrl,
        request.file ? request.file.size : 0,
        request.currentUser.id,
        now
      );

      response.json({ ok: true });
    });
  });

  app.delete('/api/folder-items/:id', requireTeacher, (request, response) => {
    const item = db.prepare('SELECT * FROM folder_items WHERE id = ?').get(request.params.id);
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

    db.prepare('DELETE FROM folder_items WHERE id = ?').run(request.params.id);
    response.status(204).end();
  });

  // 课程笔记
  app.get('/api/courses/:id/notes', requireAuth, (request, response) => {
    const notes = db.prepare(
      'SELECT * FROM course_notes WHERE item_id = ? AND student_id = ? ORDER BY timestamp_seconds ASC'
    ).all(request.params.id, request.currentUser.id);
    response.json({ notes });
  });

  app.post('/api/courses/:id/notes', requireAuth, (request, response) => {
    const content = stripHtml(request.body.content);
    if (!content) { response.status(400).json({ error: '笔记内容不能为空。' }); return; }
    db.prepare(
      'INSERT INTO course_notes (item_id, student_id, content, timestamp_seconds, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(request.params.id, request.currentUser.id, content, Number(request.body.timestampSeconds) || 0, dayjs().toISOString());
    response.json({ ok: true });
  });

  app.delete('/api/courses/:id/notes/:noteId', requireAuth, (request, response) => {
    db.prepare('DELETE FROM course_notes WHERE id = ? AND student_id = ?').run(request.params.noteId, request.currentUser.id);
    response.json({ ok: true });
  });

  // 课程评价
  app.get('/api/courses/:id/reviews', requireAuth, (request, response) => {
    const reviews = db.prepare(
      `SELECT course_reviews.*, users.display_name AS student_name
       FROM course_reviews
       LEFT JOIN users ON users.id = course_reviews.student_id
       WHERE course_reviews.item_id = ? ORDER BY course_reviews.created_at DESC`
    ).all(request.params.id);
    const myReview = db.prepare('SELECT * FROM course_reviews WHERE item_id = ? AND student_id = ?').get(request.params.id, request.currentUser.id);
    response.json({ reviews, myReview });
  });

  app.post('/api/courses/:id/reviews', requireAuth, (request, response) => {
    const rating = Number(request.body.rating);
    if (!rating || rating < 1 || rating > 5) { response.status(400).json({ error: '评分须为1-5。' }); return; }
    db.prepare(
      `INSERT INTO course_reviews (item_id, student_id, rating, content, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(item_id, student_id) DO UPDATE SET rating = excluded.rating, content = excluded.content, created_at = excluded.created_at`
    ).run(request.params.id, request.currentUser.id, rating, stripHtml(request.body.content || ''), dayjs().toISOString());
    response.json({ ok: true });
  });
};
