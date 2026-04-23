const fs = require('fs');
const dayjs = require('dayjs');
const { sanitizeText } = require('../utils/sanitize');

module.exports = function registerQuestionRoutes(app, shared) {
  const { db, requireAuth, requireStudent, requireTeacher, requireAdmin, safeJsonParse, toPublicPath, questionUpload, taskImportUpload, serializeQuestionForTeacher, serializeQuestionForStudent, updateStudyStreak, checkAndUnlockAchievements, readWorkbookRows, getFieldValue, stripHtml } = shared;

  // 题目批量导入
  app.post('/api/questions/import', requireTeacher, (request, response) => {
    taskImportUpload(request, response, (error) => {
      if (error) {
        response.status(400).json({ error: '文件上传失败。' });
        return;
      }

      if (!request.file) {
        response.status(400).json({ error: '请先上传文件。' });
        return;
      }

      const rows = readWorkbookRows(request.file.path);
      let imported = 0;
      let skipped = 0;

      rows.forEach((row) => {
        const title = sanitizeText(getFieldValue(row, ['题目标题', 'title', 'Title']));
        const subject = sanitizeText(getFieldValue(row, ['科目', 'subject', 'Subject']) || '考研英语');
        const questionType = sanitizeText(getFieldValue(row, ['题型', 'questionType', 'QuestionType']));
        const textbook = sanitizeText(getFieldValue(row, ['参考书', 'textbook', 'Textbook']));
        const stem = sanitizeText(getFieldValue(row, ['题干', 'stem', 'Stem']));
        const optionA = sanitizeText(getFieldValue(row, ['选项A', 'optionA', 'OptionA']));
        const optionB = sanitizeText(getFieldValue(row, ['选项B', 'optionB', 'OptionB']));
        const optionC = sanitizeText(getFieldValue(row, ['选项C', 'optionC', 'OptionC']));
        const optionD = sanitizeText(getFieldValue(row, ['选项D', 'optionD', 'OptionD']));
        const correctAnswer = getFieldValue(row, ['正确答案', 'correctAnswer', 'CorrectAnswer']).toUpperCase();
        const analysisText = sanitizeText(getFieldValue(row, ['文字解析', 'analysisText', 'AnalysisText']));

        if (!title || !stem || !correctAnswer) {
          skipped += 1;
          return;
        }

        const options = [
          { key: 'A', text: optionA },
          { key: 'B', text: optionB },
          { key: 'C', text: optionC },
          { key: 'D', text: optionD }
        ].filter((o) => o.text);

        if (options.length < 2 || !options.some((o) => o.key === correctAnswer)) {
          skipped += 1;
          return;
        }

        db.prepare(
          `INSERT INTO questions (title, subject, question_type, textbook, stem, options, correct_answer, analysis_text, created_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(title, subject, questionType, textbook, stem, JSON.stringify(options), correctAnswer, analysisText, request.currentUser.id, dayjs().toISOString());

        imported += 1;
      });

      fs.unlink(request.file.path, () => {});
      response.json({ ok: true, imported, skipped });
    });
  });

  // 创建题目
  app.post('/api/questions', requireTeacher, (request, response) => {
    questionUpload(request, response, (error) => {
      if (error) {
        response.status(400).json({ error: '题目录入失败。' });
        return;
      }

      const title = stripHtml(request.body.title);
      const stem = stripHtml(request.body.stem);
      const correctAnswer = String(request.body.correctAnswer || '').trim().toUpperCase();
      const options = ['A', 'B', 'C', 'D']
        .map((key) => ({ key, text: stripHtml(request.body[`option${key}`]) }))
        .filter((option) => option.text);

      if (!title || !stem || !correctAnswer || options.length < 2) {
        response.status(400).json({ error: '请完整填写题干、选项与正确答案。' });
        return;
      }

      if (!options.some((option) => option.key === correctAnswer)) {
        response.status(400).json({ error: '正确答案必须属于已有选项。' });
        return;
      }

      const questionResult = db.prepare(
        `
          INSERT INTO questions (
            title, subject, question_type, textbook, stem, options, correct_answer, analysis_text, analysis_video_path, analysis_video_url, created_by, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
      ).run(
        title,
        sanitizeText(request.body.subject || '考研英语'),
        sanitizeText(request.body.questionType),
        sanitizeText(request.body.textbook),
        stem,
        JSON.stringify(options),
        correctAnswer,
        sanitizeText(request.body.analysisText),
        request.file ? toPublicPath(request.file.path) : '',
        String(request.body.analysisVideoUrl || '').trim(),
        request.currentUser.id,
        dayjs().toISOString()
      );

      response.json({ ok: true, id: questionResult.lastInsertRowid });
    });
  });

  // 题目标签管理
  app.get('/api/questions/tags', requireAuth, (request, response) => {
    const tags = db.prepare('SELECT * FROM question_tags ORDER BY category, name').all();
    const tagsWithCount = tags.map((tag) => {
      const count = db.prepare('SELECT COUNT(*) AS count FROM question_tag_relations WHERE tag_id = ?').get(tag.id).count;
      return {
        id: tag.id,
        name: tag.name,
        category: tag.category,
        count,
        createdAt: tag.created_at
      };
    });
    response.json({ tags: tagsWithCount });
  });

  app.post('/api/questions/tags', requireTeacher, (request, response) => {
    const name = sanitizeText(request.body.name);
    const category = String(request.body.category || 'custom').trim();

    if (!name) {
      response.status(400).json({ error: '标签名称不能为空。' });
      return;
    }

    const existing = db.prepare('SELECT id FROM question_tags WHERE name = ?').get(name);
    if (existing) {
      response.status(400).json({ error: '标签已存在。' });
      return;
    }

    db.prepare('INSERT INTO question_tags (name, category, created_at) VALUES (?, ?, ?)').run(name, category, dayjs().toISOString());
    response.json({ ok: true });
  });

  // BUG-007: 标签删除改为仅管理员可用（标签是全局资源）
  app.delete('/api/questions/tags/:id', requireAdmin, (request, response) => {
    db.prepare('DELETE FROM question_tag_relations WHERE tag_id = ?').run(request.params.id);
    db.prepare('DELETE FROM question_tags WHERE id = ?').run(request.params.id);
    response.json({ ok: true });
  });

  // 书本管理
  app.get('/api/questions/textbooks', requireAuth, (request, response) => {
    const rows = db.prepare("SELECT textbook, COUNT(*) AS count FROM questions WHERE textbook != '' GROUP BY textbook ORDER BY textbook").all();
    response.json({ textbooks: rows });
  });

  app.post('/api/questions/textbooks', requireTeacher, (request, response) => {
    const name = sanitizeText(request.body.name);
    if (!name) {
      response.status(400).json({ error: '书本名称不能为空。' });
      return;
    }
    const existing = db.prepare("SELECT textbook FROM questions WHERE textbook = ? LIMIT 1").get(name);
    if (existing) {
      response.status(400).json({ error: '该书本已存在。' });
      return;
    }
    response.json({ ok: true, name });
  });

  app.delete('/api/questions/textbooks/:name', requireTeacher, (request, response) => {
    let name;
    try { name = decodeURIComponent(request.params.name); } catch (e) { response.status(400).json({ error: '无效的编码。' }); return; }
    db.prepare("UPDATE questions SET textbook = '' WHERE textbook = ?").run(name);
    response.json({ ok: true });
  });

  // 题目标签关联
  app.post('/api/questions/:id/tags', requireTeacher, (request, response) => {
    const { tagIds } = request.body;
    if (!Array.isArray(tagIds)) {
      response.status(400).json({ error: 'tagIds 必须为数组。' });
      return;
    }

    const question = db.prepare('SELECT id FROM questions WHERE id = ?').get(request.params.id);
    if (!question) {
      response.status(404).json({ error: '题目不存在。' });
      return;
    }

    db.prepare('DELETE FROM question_tag_relations WHERE question_id = ?').run(request.params.id);
    const insertRelation = db.prepare('INSERT OR IGNORE INTO question_tag_relations (question_id, tag_id) VALUES (?, ?)');
    const insertMany = db.transaction((ids) => {
      ids.forEach((tagId) => insertRelation.run(request.params.id, tagId));
    });
    insertMany(tagIds);

    response.json({ ok: true });
  });

  // 题库筛选（学生可用）
  app.get('/api/questions', requireAuth, (request, response) => {
    const { subject, questionType, textbook, tagId, page, limit, mode } = request.query;
    const maxLimit = Math.min(Number(limit) || 20, 100);
    const pageNum = Number(page) || 1;
    const skip = (pageNum - 1) * maxLimit;

    let query = `
      SELECT questions.*, users.display_name AS creator_name
      FROM questions
      LEFT JOIN users ON users.id = questions.created_by
    `;
    const params = [];
    const conditions = [];

    if (subject) { conditions.push('questions.subject = ?'); params.push(subject); }
    if (questionType) { conditions.push('questions.question_type = ?'); params.push(questionType); }
    if (textbook) { conditions.push('questions.textbook = ?'); params.push(textbook); }
    if (tagId) {
      query += ' JOIN question_tag_relations ON question_tag_relations.question_id = questions.id ';
      conditions.push('question_tag_relations.tag_id = ?');
      params.push(Number(tagId));
    }

    const studentId = request.currentUser.role === 'student' ? request.currentUser.id : null;

    // 练习模式
    if (mode === 'untried' && studentId) {
      conditions.push('questions.id NOT IN (SELECT question_id FROM practice_records WHERE student_id = ?)');
      params.push(studentId);
    }

    if (conditions.length) {
      query += ' WHERE ' + conditions.join(' AND ');
    }

    const countResult = db.prepare(`SELECT COUNT(*) AS total FROM (${query})`).get(...params);

    if (mode === 'random') {
      query += ' ORDER BY RANDOM()';
    } else {
      query += ' ORDER BY questions.created_at DESC';
    }
    query += ' LIMIT ? OFFSET ?';
    params.push(maxLimit, skip);

    const questions = db.prepare(query).all(...params);

    const results = questions.map((q) => {
      let latestRecord = null;
      if (studentId) {
        latestRecord = db.prepare(
          'SELECT selected_answer, is_correct, created_at FROM practice_records WHERE question_id = ? AND student_id = ? ORDER BY created_at DESC LIMIT 1'
        ).get(q.id, studentId);
      }
      const row = serializeQuestionForStudent(q, latestRecord);
      if (studentId) {
        const fav = db.prepare('SELECT id FROM question_favorites WHERE question_id = ? AND student_id = ?').get(q.id, studentId);
        row.favorited = !!fav;
      }
      return row;
    });

    response.json({ questions: results, totalCount: countResult.total, page: Number(page) || 1, limit: maxLimit });
  });

  // 题目收藏切换
  app.post('/api/questions/:id/favorite', requireStudent, (request, response) => {
    const question = db.prepare('SELECT id FROM questions WHERE id = ?').get(request.params.id);
    if (!question) { response.status(404).json({ error: '题目不存在。' }); return; }

    const existing = db.prepare('SELECT id FROM question_favorites WHERE question_id = ? AND student_id = ?').get(request.params.id, request.currentUser.id);
    let favorited;
    if (existing) {
      db.prepare('DELETE FROM question_favorites WHERE id = ?').run(existing.id);
      favorited = false;
    } else {
      db.prepare('INSERT INTO question_favorites (question_id, student_id, created_at) VALUES (?, ?, ?)').run(request.params.id, request.currentUser.id, dayjs().toISOString());
      favorited = true;
    }
    response.json({ favorited });
  });

  // 收藏题目列表
  app.get('/api/questions/favorites', requireStudent, (request, response) => {
    const { subject, page, limit } = request.query;
    const maxLimit = Math.min(Number(limit) || 20, 100);
    const pageNum = Number(page) || 1;
    const skip = (pageNum - 1) * maxLimit;
    let query = `
      SELECT questions.*, question_favorites.created_at AS favorited_at
      FROM question_favorites
      JOIN questions ON questions.id = question_favorites.question_id
      WHERE question_favorites.student_id = ?
    `;
    const params = [request.currentUser.id];
    if (subject) { query += ' AND questions.subject = ?'; params.push(subject); }
    query += ' ORDER BY question_favorites.created_at DESC LIMIT ? OFFSET ?';
    params.push(maxLimit, skip);

    const rows = db.prepare(query).all(...params);
    const questions = rows.map((r) => {
      const latestRecord = db.prepare(
        'SELECT selected_answer, is_correct, created_at FROM practice_records WHERE question_id = ? AND student_id = ? ORDER BY created_at DESC LIMIT 1'
      ).get(r.id, request.currentUser.id);
      const serialized = serializeQuestionForStudent(r, latestRecord);
      serialized.favorited = true;
      return serialized;
    });
    response.json({ questions });
  });

  // 错题列��（增加 subject 筛选）
  app.get('/api/practice/wrong', requireStudent, (request, response) => {
    const { subject, page, limit } = request.query;
    const maxLimit = Math.min(Number(limit) || 20, 100);
    const pageNum = Number(page) || 1;
    const skip = (pageNum - 1) * maxLimit;
    let query = `
      SELECT questions.*, MAX(practice_records.selected_answer) AS selected_answer, MAX(practice_records.created_at) AS answered_at
      FROM practice_records
      JOIN questions ON questions.id = practice_records.question_id
      WHERE practice_records.student_id = ? AND practice_records.is_correct = 0
    `;
    const params = [request.currentUser.id];
    if (subject) { query += ' AND questions.subject = ?'; params.push(subject); }
    query += ' GROUP BY questions.id ORDER BY MAX(practice_records.created_at) DESC LIMIT ? OFFSET ?';
    params.push(maxLimit, skip);

    const rows = db.prepare(query).all(...params);
    response.json({
      questions: rows.map((row) => ({
        ...serializeQuestionForStudent(row, null),
        selectedAnswer: row.selected_answer,
        answeredAt: row.answered_at
      }))
    });
  });

  // 题库筛选元数据
  app.get('/api/questions/meta', requireAuth, (request, response) => {
    const subjects = db.prepare("SELECT DISTINCT subject FROM questions WHERE subject != '' ORDER BY subject").all().map((r) => r.subject);
    const types = db.prepare("SELECT DISTINCT question_type FROM questions WHERE question_type != '' ORDER BY question_type").all().map((r) => r.question_type);
    const textbooks = db.prepare("SELECT DISTINCT textbook FROM questions WHERE textbook != '' ORDER BY textbook").all().map((r) => r.textbook);
    const tags = db.prepare('SELECT id, name, category FROM question_tags ORDER BY name').all();
    response.json({ subjects, types, textbooks, tags });
  });

  // 练习会话 API
  app.get('/api/practice/sessions', requireStudent, (request, response) => {
    const sessions = db.prepare(
      'SELECT * FROM practice_sessions WHERE student_id = ? ORDER BY started_at DESC LIMIT 20'
    ).all(request.currentUser.id).map((row) => ({
      id: row.id,
      sessionType: row.session_type,
      subjectFilter: row.subject_filter,
      totalQuestions: row.total_questions,
      correctCount: row.correct_count,
      startedAt: row.started_at,
      endedAt: row.ended_at
    }));

    response.json({ sessions });
  });

  app.post('/api/practice/sessions', requireStudent, (request, response) => {
    const sessionId = require('crypto').randomUUID();
    const sessionType = String(request.body.sessionType || 'mixed').trim();
    const subjectFilter = String(request.body.subjectFilter || '').trim();

    db.prepare(
      'INSERT INTO practice_sessions (id, student_id, session_type, subject_filter, started_at) VALUES (?, ?, ?, ?, ?)'
    ).run(sessionId, request.currentUser.id, sessionType, subjectFilter, dayjs().toISOString());

    response.json({ ok: true, sessionId });
  });

  app.post('/api/practice/sessions/:id/end', requireStudent, (request, response) => {
    const session = db.prepare('SELECT * FROM practice_sessions WHERE id = ? AND student_id = ?').get(request.params.id, request.currentUser.id);
    if (!session) {
      response.status(404).json({ error: '练习会话不存在。' });
      return;
    }

    const { totalQuestions, correctCount } = request.body;
    db.prepare(
      'UPDATE practice_sessions SET total_questions = ?, correct_count = ?, ended_at = ? WHERE id = ?'
    ).run(Number(totalQuestions || 0), Number(correctCount || 0), dayjs().toISOString(), request.params.id);

    response.json({ ok: true });
  });

  app.get('/api/practice/stats', requireStudent, (request, response) => {
    const totalAttempts = db.prepare('SELECT COUNT(*) AS count FROM practice_records WHERE student_id = ?').get(request.currentUser.id).count;
    const correctAttempts = db.prepare('SELECT COUNT(*) AS count FROM practice_records WHERE student_id = ? AND is_correct = 1').get(request.currentUser.id).count;
    const flashcardsLearned = db.prepare('SELECT COUNT(*) AS count FROM flashcard_records WHERE student_id = ? AND repetitions > 0').get(request.currentUser.id).count;

    response.json({
      totalAttempts,
      correctAttempts,
      accuracy: totalAttempts > 0 ? Math.round((correctAttempts / totalAttempts) * 100) : 0,
      flashcardsLearned
    });
  });

  // 答题
  app.post('/api/questions/:id/answer', requireStudent, (request, response) => {
    const selectedAnswer = String(request.body.selectedAnswer || '').trim().toUpperCase();
    const question = db.prepare('SELECT * FROM questions WHERE id = ?').get(request.params.id);

    if (!question) {
      response.status(404).json({ error: '题目不存在。' });
      return;
    }

    if (!selectedAnswer) {
      response.status(400).json({ error: '请选择一个答案。' });
      return;
    }

    const isCorrect = selectedAnswer === question.correct_answer ? 1 : 0;
    const sessionId = String(request.body.sessionId || '').trim();
    const timeSpentMs = Number(request.body.timeSpentMs) || 0;
    db.prepare(
      `
        INSERT INTO practice_records (question_id, student_id, selected_answer, is_correct, session_id, time_spent_ms, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `
    ).run(question.id, request.currentUser.id, selectedAnswer, isCorrect, sessionId, timeSpentMs, dayjs().toISOString());

    updateStudyStreak(request.currentUser.id);
    checkAndUnlockAchievements(request.currentUser.id);

    // 错题智能复习调度（3/7/15天间隔）
    if (!isCorrect) {
      const now = dayjs();
      const intervals = [3, 7, 15];
      for (const days of intervals) {
        db.prepare(
          'INSERT INTO wrong_review_schedule (question_id, student_id, review_date, review_round, created_at) VALUES (?, ?, ?, ?, ?)'
        ).run(question.id, request.currentUser.id, now.add(days, 'day').format('YYYY-MM-DD'), days === 3 ? 1 : (days === 7 ? 2 : 3), now.toISOString());
      }
    }

    response.json({
      ok: true,
      result: {
        isCorrect: Boolean(isCorrect),
        correctAnswer: question.correct_answer,
        analysisText: question.analysis_text,
        analysisVideoPath: question.analysis_video_path,
        analysisVideoUrl: question.analysis_video_url
      }
    });
  });

  // 题目笔记
  app.get('/api/questions/:id/notes', requireAuth, (request, response) => {
    const note = db.prepare('SELECT * FROM question_notes WHERE question_id = ? AND student_id = ?').get(request.params.id, request.currentUser.id);
    response.json({ note: note || null });
  });

  app.post('/api/questions/:id/notes', requireAuth, (request, response) => {
    const content = sanitizeText(request.body.content || '');
    if (!content) { return response.status(400).json({ error: '笔记内容不能为空。' }); }
    const now = dayjs().toISOString();
    db.prepare(`
      INSERT INTO question_notes (question_id, student_id, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(question_id, student_id) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at
    `).run(Number(request.params.id), request.currentUser.id, content, now, now);
    response.json({ ok: true });
  });

  app.delete('/api/questions/:id/notes', requireAuth, (request, response) => {
    db.prepare('DELETE FROM question_notes WHERE question_id = ? AND student_id = ?').run(Number(request.params.id), request.currentUser.id);
    response.json({ ok: true });
  });

  // 错题智能复习调度
  app.get('/api/practice/wrong-review', requireStudent, (request, response) => {
    const today = dayjs().format('YYYY-MM-DD');
    const reviews = db.prepare(`
      SELECT wrs.*, q.title, q.stem, q.options, q.correct_answer, q.analysis_text, q.subject, q.question_type
      FROM wrong_review_schedule wrs
      JOIN questions q ON q.id = wrs.question_id
      WHERE wrs.student_id = ? AND wrs.review_date <= ? AND wrs.is_done = 0
      ORDER BY wrs.review_date ASC LIMIT 50
    `).all(request.currentUser.id, today);

    const questions = reviews.map((r) => ({
      id: r.question_id,
      title: r.title,
      stem: r.stem,
      options: safeJsonParse(r.options, []),
      correctAnswer: r.correct_answer,
      analysisText: r.analysis_text,
      subject: r.subject,
      questionType: r.question_type,
      reviewRound: r.review_round,
      scheduleId: r.id
    }));
    response.json({ questions });
  });

  app.post('/api/practice/wrong-review/:id/done', requireStudent, (request, response) => {
    const scheduleId = Number(request.params.id);
    db.prepare('UPDATE wrong_review_schedule SET is_done = 1 WHERE id = ? AND student_id = ?').run(scheduleId, request.currentUser.id);
    response.json({ ok: true });
  });

  // 学习数据详细统计
  app.get('/api/practice/stats/detailed', requireStudent, (request, response) => {
    const studentId = request.currentUser.id;

    // 概览
    const overview = db.prepare(`
      SELECT
        COUNT(*) AS totalAttempts,
        SUM(CASE WHEN is_correct = 1 THEN 1 ELSE 0 END) AS correctAttempts,
        COALESCE(SUM(time_spent_ms), 0) AS totalTimeSpentMs
      FROM practice_records WHERE student_id = ?
    `).get(studentId);

    const totalSessions = db.prepare('SELECT COUNT(*) AS count FROM practice_sessions WHERE student_id = ?').get(studentId).count;
    const flashcardsLearned = db.prepare('SELECT COUNT(*) AS count FROM flashcard_records WHERE student_id = ? AND repetitions > 0').get(studentId).count;
    const accuracy = overview.totalAttempts > 0 ? Math.round((overview.correctAttempts / overview.totalAttempts) * 100) : 0;

    // 科目正确率
    const subjectAccuracy = db.prepare(`
      SELECT q.subject,
        COUNT(*) AS total,
        SUM(CASE WHEN pr.is_correct = 1 THEN 1 ELSE 0 END) AS correct,
        ROUND(SUM(CASE WHEN pr.is_correct = 1 THEN 1 ELSE 0 END) * 100.0 / COUNT(*), 0) AS accuracy
      FROM practice_records pr
      JOIN questions q ON q.id = pr.question_id
      WHERE pr.student_id = ?
      GROUP BY q.subject
      ORDER BY total DESC
    `).all(studentId);

    // 每日活动
    const dailyActivity = db.prepare(`
      SELECT DATE(created_at) AS date,
        COUNT(*) AS questionsAnswered,
        SUM(CASE WHEN is_correct = 1 THEN 1 ELSE 0 END) AS correctCount,
        COALESCE(SUM(time_spent_ms), 0) AS timeSpentMs
      FROM practice_records
      WHERE student_id = ? AND created_at >= date('now', '-30 days')
      GROUP BY DATE(created_at)
      ORDER BY date
    `).all(studentId);

    // 最近会话
    const recentSessions = db.prepare(`
      SELECT * FROM practice_sessions WHERE student_id = ?
      ORDER BY started_at DESC LIMIT 10
    `).all(studentId);

    // 标签维度薄弱点分析
    const tagAccuracy = db.prepare(`
      SELECT qt.name AS tagName, qt.category AS tagCategory,
        COUNT(*) AS total,
        SUM(CASE WHEN pr.is_correct = 1 THEN 1 ELSE 0 END) AS correct,
        ROUND(SUM(CASE WHEN pr.is_correct = 1 THEN 1 ELSE 0 END) * 100.0 / COUNT(*), 0) AS accuracy
      FROM practice_records pr
      JOIN question_tag_relations qtr ON qtr.question_id = pr.question_id
      JOIN question_tags qt ON qt.id = qtr.tag_id
      WHERE pr.student_id = ?
      GROUP BY qt.id
      HAVING total >= 2
      ORDER BY accuracy ASC
      LIMIT 15
    `).all(studentId);

    response.json({
      overview: {
        totalAttempts: overview.totalAttempts || 0,
        correctAttempts: overview.correctAttempts || 0,
        accuracy,
        flashcardsLearned,
        totalSessions,
        totalTimeSpentMs: overview.totalTimeSpentMs || 0
      },
      subjectAccuracy,
      dailyActivity,
      recentSessions,
      tagAccuracy
    });
  });

  // 周报
  app.get('/api/practice/stats/weekly', requireStudent, (request, response) => {
    const studentId = request.currentUser.id;
    const weekOffset = Number(request.query.weekOffset) || 0;
    const baseDate = dayjs().subtract(weekOffset, 'week');
    const weekStart = baseDate.startOf('week').add(1, 'day'); // 周一
    const weekEnd = weekStart.add(6, 'day').endOf('day');

    const stats = db.prepare(`
      SELECT COUNT(*) AS totalQuestions,
        SUM(CASE WHEN is_correct = 1 THEN 1 ELSE 0 END) AS correctCount,
        COALESCE(SUM(time_spent_ms), 0) AS totalTimeMs
      FROM practice_records
      WHERE student_id = ? AND created_at >= ? AND created_at <= ?
    `).get(studentId, weekStart.toISOString(), weekEnd.toISOString());

    const subjectBreakdown = db.prepare(`
      SELECT q.subject, COUNT(*) AS total,
        SUM(CASE WHEN pr.is_correct = 1 THEN 1 ELSE 0 END) AS correct,
        COALESCE(SUM(pr.time_spent_ms), 0) AS timeMs
      FROM practice_records pr JOIN questions q ON q.id = pr.question_id
      WHERE pr.student_id = ? AND pr.created_at >= ? AND pr.created_at <= ?
      GROUP BY q.subject ORDER BY total DESC
    `).all(studentId, weekStart.toISOString(), weekEnd.toISOString());

    const dailyBreakdown = db.prepare(`
      SELECT DATE(created_at) AS date, COUNT(*) AS total,
        SUM(CASE WHEN is_correct = 1 THEN 1 ELSE 0 END) AS correct
      FROM practice_records
      WHERE student_id = ? AND created_at >= ? AND created_at <= ?
      GROUP BY DATE(created_at) ORDER BY date
    `).all(studentId, weekStart.toISOString(), weekEnd.toISOString());

    const flashcardCount = db.prepare(`
      SELECT COUNT(*) AS cnt FROM flashcard_records
      WHERE student_id = ? AND updated_at >= ? AND updated_at <= ?
    `).get(studentId, weekStart.toISOString(), weekEnd.toISOString()).cnt;

    const focusSessions = db.prepare(`
      SELECT COUNT(*) AS cnt FROM practice_sessions
      WHERE student_id = ? AND started_at >= ? AND started_at <= ?
    `).get(studentId, weekStart.toISOString(), weekEnd.toISOString()).cnt;

    response.json({
      weekStart: weekStart.format('YYYY-MM-DD'),
      weekEnd: weekEnd.format('YYYY-MM-DD'),
      totalQuestions: stats.totalQuestions || 0,
      correctCount: stats.correctCount || 0,
      accuracy: stats.totalQuestions > 0 ? Math.round((stats.correctCount / stats.totalQuestions) * 100) : 0,
      totalTimeMinutes: Math.round((stats.totalTimeMs || 0) / 60000),
      subjectBreakdown,
      dailyBreakdown,
      flashcardCount: flashcardCount || 0,
      focusSessions: focusSessions || 0
    });
  });

  // 月报
  app.get('/api/practice/stats/monthly', requireStudent, (request, response) => {
    const studentId = request.currentUser.id;
    const monthOffset = Number(request.query.monthOffset) || 0;
    const baseDate = dayjs().subtract(monthOffset, 'month');
    const monthStart = baseDate.startOf('month');
    const monthEnd = baseDate.endOf('month');

    const stats = db.prepare(`
      SELECT COUNT(*) AS totalQuestions,
        SUM(CASE WHEN is_correct = 1 THEN 1 ELSE 0 END) AS correctCount,
        COALESCE(SUM(time_spent_ms), 0) AS totalTimeMs
      FROM practice_records
      WHERE student_id = ? AND created_at >= ? AND created_at <= ?
    `).get(studentId, monthStart.toISOString(), monthEnd.toISOString());

    const subjectBreakdown = db.prepare(`
      SELECT q.subject, COUNT(*) AS total,
        SUM(CASE WHEN pr.is_correct = 1 THEN 1 ELSE 0 END) AS correct,
        COALESCE(SUM(pr.time_spent_ms), 0) AS timeMs
      FROM practice_records pr JOIN questions q ON q.id = pr.question_id
      WHERE pr.student_id = ? AND pr.created_at >= ? AND pr.created_at <= ?
      GROUP BY q.subject ORDER BY total DESC
    `).all(studentId, monthStart.toISOString(), monthEnd.toISOString());

    const dailyBreakdown = db.prepare(`
      SELECT DATE(created_at) AS date, COUNT(*) AS total,
        SUM(CASE WHEN is_correct = 1 THEN 1 ELSE 0 END) AS correct
      FROM practice_records
      WHERE student_id = ? AND created_at >= ? AND created_at <= ?
      GROUP BY DATE(created_at) ORDER BY date
    `).all(studentId, monthStart.toISOString(), monthEnd.toISOString());

    const flashcardCount = db.prepare(`
      SELECT COUNT(*) AS cnt FROM flashcard_records
      WHERE student_id = ? AND updated_at >= ? AND updated_at <= ?
    `).get(studentId, monthStart.toISOString(), monthEnd.toISOString()).cnt;

    const summaryCount = db.prepare(
      `SELECT COUNT(*) AS cnt FROM summaries WHERE student_id = ? AND task_date >= ? AND task_date <= ?`
    ).get(studentId, monthStart.format('YYYY-MM-DD'), monthEnd.format('YYYY-MM-DD')).cnt;

    const activeDays = dailyBreakdown.length;

    response.json({
      month: monthStart.format('YYYY年MM月'),
      monthStart: monthStart.format('YYYY-MM-DD'),
      monthEnd: monthEnd.format('YYYY-MM-DD'),
      totalQuestions: stats.totalQuestions || 0,
      correctCount: stats.correctCount || 0,
      accuracy: stats.totalQuestions > 0 ? Math.round((stats.correctCount / stats.totalQuestions) * 100) : 0,
      totalTimeMinutes: Math.round((stats.totalTimeMs || 0) / 60000),
      subjectBreakdown,
      dailyBreakdown,
      activeDays,
      flashcardCount: flashcardCount || 0,
      summaryCount: summaryCount || 0
    });
  });

  // 刷题热力图
  app.get('/api/practice/heatmap', requireStudent, (request, response) => {
    const year = request.query.year || dayjs().format('YYYY');
    const rows = db.prepare(`
      SELECT DATE(created_at) AS date, COUNT(*) AS count
      FROM practice_records WHERE student_id = ? AND strftime('%Y', created_at) = ?
      GROUP BY DATE(created_at) ORDER BY date
    `).all(request.currentUser.id, year);
    const heatmap = {};
    rows.forEach((r) => { heatmap[r.date] = r.count; });
    response.json({ heatmap, year });
  });

  // 随机组卷
  app.post('/api/questions/auto-paper', requireAuth, (request, response) => {
    const { subject, count, tags } = request.body;
    const numQ = Math.min(Math.max(Number(count) || 10, 1), 100);
    let query = 'SELECT id FROM questions WHERE 1=1';
    const params = [];
    if (subject) { query += ' AND subject = ?'; params.push(subject); }
    if (tags && tags.length) {
      query += ' AND id IN (SELECT question_id FROM question_tag_relations WHERE tag_id IN (' + tags.map(() => '?').join(',') + '))';
      params.push(...tags);
    }
    query += ' ORDER BY RANDOM() LIMIT ?';
    params.push(numQ);
    const questions = db.prepare(query).all(...params);
    response.json({ questionIds: questions.map((q) => q.id) });
  });

  // 每日推荐题目
  app.get('/api/questions/daily', requireStudent, (request, response) => {
    const studentId = request.currentUser.id;
    // 错题 + 未做题混合推荐
    const wrongQuestions = db.prepare(
      `SELECT question_id, COUNT(*) AS wrong_count FROM practice_records
       WHERE student_id = ? AND is_correct = 0 GROUP BY question_id
       ORDER BY wrong_count DESC LIMIT 10`
    ).all(studentId).map((r) => r.question_id);

    const untriedLimit = 10 - wrongQuestions.length;
    let untried = [];
    if (untriedLimit > 0) {
      untried = db.prepare(
        `SELECT id FROM questions WHERE id NOT IN (
          SELECT DISTINCT question_id FROM practice_records WHERE student_id = ?
        ) ORDER BY RANDOM() LIMIT ?`
      ).all(studentId, untriedLimit).map((r) => r.id);
    }

    const ids = [...wrongQuestions, ...untried];
    if (!ids.length) { response.json({ questions: [] }); return; }

    const placeholders = ids.map(() => '?').join(',');
    const questions = db.prepare(
      `SELECT * FROM questions WHERE id IN (${placeholders})`
    ).all(...ids);

    const results = questions.map((q) => {
      const latestRecord = db.prepare(
        'SELECT selected_answer, is_correct, created_at FROM practice_records WHERE question_id = ? AND student_id = ? ORDER BY created_at DESC LIMIT 1'
      ).get(q.id, studentId);
      const row = serializeQuestionForStudent(q, latestRecord);
      const fav = db.prepare('SELECT id FROM question_favorites WHERE question_id = ? AND student_id = ?').get(q.id, studentId);
      row.favorited = !!fav;
      return row;
    });

    response.json({ questions: results });
  });
};
