const fs = require('fs');
const dayjs = require('dayjs');
const { sanitizeText } = require('../utils/sanitize');

module.exports = function registerQuestionRoutes(app, shared) {
  const { db, config, requireAuth, requireStudent, requireTeacher, requireAdmin, safeJsonParse, toPublicPath, questionUpload, taskImportUpload, serializeQuestionForTeacher, serializeQuestionForStudent, updateStudyStreak, checkAndUnlockAchievements, readWorkbookRows, getFieldValue, stripHtml, canAccessContent } = shared;

  function questionIsAccessible(userId, question) {
    if (!question.is_paid_only) return true;
    return canAccessContent(userId, {
      visibility: question.subject_scope ? 'subject_paid' : 'all_paid',
      subjectScope: question.subject_scope,
      subject: question.subject
    });
  }

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

      const importQuestions = db.transaction(() => {
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
        const correctAnswer = String(getFieldValue(row, ['正确答案', 'correctAnswer', 'CorrectAnswer']) || '').trim().toUpperCase();
        const analysisText = sanitizeText(getFieldValue(row, ['文字解析', 'analysisText', 'AnalysisText']));
        const displayMode = sanitizeText(getFieldValue(row, ['展示模式', 'displayMode', 'DisplayMode']) || 'radio');
        const sourceYear = Number(getFieldValue(row, ['年份', 'sourceYear', 'SourceYear', 'Year']) || 0) || null;
        const sourcePaper = sanitizeText(getFieldValue(row, ['试卷', 'sourcePaper', 'SourcePaper', 'Paper']) || '');
        const difficulty = Number(getFieldValue(row, ['难度', 'difficulty', 'Difficulty']) || 0) || null;
        const isRealExam = ['1', '是', 'true', 'TRUE', 'True'].includes(String(getFieldValue(row, ['是否真题', 'isRealExam', 'IsRealExam', '真题']) || '').trim()) ? 1 : 0;

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
          `INSERT INTO questions (
            title, subject, question_type, textbook, stem, options, correct_answer, analysis_text,
            display_mode, source_year, source_paper, difficulty, is_real_exam, created_by, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          title, subject, questionType, textbook, stem, JSON.stringify(options), correctAnswer, analysisText,
          displayMode || 'radio', sourceYear, sourcePaper, difficulty, isRealExam,
          request.currentUser.id, dayjs().toISOString()
        );

        imported += 1;
      });
      });
      importQuestions();

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

      const isPaidOnly = config.freeAccessMode
        ? 0
        : (request.body.isPaidOnly === true || request.body.isPaidOnly === '1' || request.body.isPaidOnly === 1 ? 1 : 0);

      const displayMode = sanitizeText(request.body.displayMode || 'radio');
      const sourceYear = Number(request.body.sourceYear || 0) || null;
      const sourcePaper = sanitizeText(request.body.sourcePaper || '');
      const difficulty = Number(request.body.difficulty || 0) || null;
      const isRealExam = request.body.isRealExam === true || request.body.isRealExam === '1' || request.body.isRealExam === 1 ? 1 : 0;
      const formulaImagePath = request.files && request.files.formulaImage
        ? toPublicPath(request.files.formulaImage[0].path)
        : (String(request.body.formulaImagePath || '').trim());

      const questionResult = db.prepare(
        `
          INSERT INTO questions (
            title, subject, question_type, textbook, stem, options, correct_answer, analysis_text,
            analysis_video_path, analysis_video_url, is_paid_only, subject_scope,
            display_mode, formula_image_path, source_year, source_paper, difficulty, is_real_exam,
            created_by, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        isPaidOnly,
        config.freeAccessMode ? '' : sanitizeText(request.body.subjectScope || ''),
        displayMode,
        formulaImagePath,
        sourceYear,
        sourcePaper,
        difficulty,
        isRealExam,
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
    const id = Number(request.params.id);
    if (!Number.isInteger(id) || id <= 0) return response.status(400).json({ error: '无效的 ID。' });
    db.prepare('DELETE FROM question_tag_relations WHERE tag_id = ?').run(id);
    db.prepare('DELETE FROM question_tags WHERE id = ?').run(id);
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
    const existing = db.prepare("SELECT id FROM knowledge_tags WHERE name = ? AND category = 'textbook'").get(name);
    if (existing) {
      response.status(400).json({ error: '该书本已存在。' });
      return;
    }
    const result = db.prepare("INSERT INTO knowledge_tags (name, category, created_at) VALUES (?, 'textbook', ?)").run(name, dayjs().toISOString());
    response.json({ ok: true, name, id: result.lastInsertRowid });
  });

  app.delete('/api/questions/textbooks/:name', requireTeacher, (request, response) => {
    let name;
    try { name = decodeURIComponent(request.params.name); } catch (e) { response.status(400).json({ error: '无效的编码。' }); return; }
    db.prepare("UPDATE questions SET textbook = '' WHERE textbook = ?").run(name);
    response.json({ ok: true });
  });

  // 题目标签关联
  app.post('/api/questions/:id/tags', requireTeacher, (request, response) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id) || id <= 0) return response.status(400).json({ error: '无效的 ID。' });
    const { tagIds } = request.body;
    if (!Array.isArray(tagIds)) {
      response.status(400).json({ error: 'tagIds 必须为数组。' });
      return;
    }

    const question = db.prepare('SELECT id FROM questions WHERE id = ?').get(id);
    if (!question) {
      response.status(404).json({ error: '题目不存在。' });
      return;
    }

    db.prepare('DELETE FROM question_tag_relations WHERE question_id = ?').run(id);
    const insertRelation = db.prepare('INSERT OR IGNORE INTO question_tag_relations (question_id, tag_id) VALUES (?, ?)');
    const insertMany = db.transaction((ids) => {
      ids.forEach((tagId) => insertRelation.run(id, tagId));
    });
    insertMany(tagIds);

    response.json({ ok: true });
  });

  // 题库筛选（学生可用）
  app.get('/api/questions', requireAuth, (request, response) => {
    const {
      subject, questionType, textbook, tagId, page, limit, mode, ids,
      displayMode, isRealExam, sourceYear, sourcePaper, difficulty, minDifficulty, maxDifficulty
    } = request.query;
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

    // 按 ID 列表批量查询
    if (ids) {
      const idList = String(ids).split(',').map(Number).filter((n) => n > 0);
      if (idList.length) {
        const placeholders = idList.map(() => '?').join(',');
        conditions.push(`questions.id IN (${placeholders})`);
        params.push(...idList);
      }
    }

    if (subject) { conditions.push('questions.subject = ?'); params.push(subject); }
    if (questionType) { conditions.push('questions.question_type = ?'); params.push(questionType); }
    if (textbook) { conditions.push('questions.textbook = ?'); params.push(textbook); }
    if (displayMode) { conditions.push('questions.display_mode = ?'); params.push(displayMode); }
    if (isRealExam === '1' || isRealExam === 'true' || isRealExam === 1) { conditions.push('questions.is_real_exam = 1'); }
    if (isRealExam === '0' || isRealExam === 'false' || isRealExam === 0) { conditions.push('questions.is_real_exam = 0'); }
    if (sourceYear) { conditions.push('questions.source_year = ?'); params.push(Number(sourceYear)); }
    if (sourcePaper) { conditions.push('questions.source_paper LIKE ?'); params.push(`%${sourcePaper}%`); }
    const minDiff = Number(minDifficulty) || 0;
    const maxDiff = Number(maxDifficulty) || 0;
    if (minDiff > 0 && maxDiff >= minDiff) {
      conditions.push('questions.difficulty BETWEEN ? AND ?');
      params.push(minDiff, maxDiff);
    } else if (difficulty) {
      conditions.push('questions.difficulty = ?');
      params.push(Number(difficulty));
    }
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

    const filteredResults = studentId ? results.filter((q) => questionIsAccessible(studentId, q)) : results;

    response.json({ questions: filteredResults, totalCount: countResult.total, page: Number(page) || 1, limit: maxLimit });
  });

  // 题目收藏切换
  app.post('/api/questions/:id/favorite', requireStudent, (request, response) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id) || id <= 0) return response.status(400).json({ error: '无效的 ID。' });
    const question = db.prepare('SELECT id FROM questions WHERE id = ?').get(id);
    if (!question) { response.status(404).json({ error: '题目不存在。' }); return; }

    const existing = db.prepare('SELECT id FROM question_favorites WHERE question_id = ? AND student_id = ?').get(id, request.currentUser.id);
    let favorited;
    if (existing) {
      db.prepare('DELETE FROM question_favorites WHERE id = ?').run(existing.id);
      favorited = false;
    } else {
      db.prepare('INSERT INTO question_favorites (question_id, student_id, created_at) VALUES (?, ?, ?)').run(id, request.currentUser.id, dayjs().toISOString());
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
    }).filter((q) => questionIsAccessible(request.currentUser.id, q));
    response.json({ questions });
  });

  // 错题列��（增加 subject 筛选）
  // 错题列表（增加 subject 筛选，过滤已掌握）
  app.get('/api/practice/wrong', requireStudent, (request, response) => {
    const { subject, page, limit } = request.query;
    const maxLimit = Math.min(Number(limit) || 20, 100);
    const pageNum = Number(page) || 1;
    const skip = (pageNum - 1) * maxLimit;
    let query = `
      SELECT questions.*, MAX(practice_records.selected_answer) AS selected_answer, MAX(practice_records.created_at) AS answered_at,
        COALESCE(wrs.is_mastered, 0) AS is_mastered
      FROM practice_records
      JOIN questions ON questions.id = practice_records.question_id
      LEFT JOIN wrong_review_schedule wrs ON wrs.question_id = practice_records.question_id AND wrs.student_id = practice_records.student_id
      WHERE practice_records.student_id = ? AND practice_records.is_correct = 0
        AND COALESCE(wrs.is_mastered, 0) = 0
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
        answeredAt: row.answered_at,
        isMastered: Boolean(row.is_mastered)
      })).filter((q) => questionIsAccessible(request.currentUser.id, q))
    });
  });

  // 错题标记为已掌握（从错题本移除）
  app.post('/api/practice/wrong/:questionId/master', requireStudent, (request, response) => {
    const questionId = Number(request.params.questionId);
    const studentId = request.currentUser.id;
    if (!Number.isInteger(questionId) || questionId <= 0) {
      return response.status(400).json({ error: '无效的题目ID' });
    }

    // 校验该学生确实做错过这道题
    const wrongRecord = db.prepare(
      'SELECT 1 FROM practice_records WHERE student_id = ? AND question_id = ? AND is_correct = 0 LIMIT 1'
    ).get(studentId, questionId);
    if (!wrongRecord) {
      return response.status(404).json({ error: '未找到该学生的错题记录' });
    }

    const now = dayjs().toISOString();
    // 插入或更新复习计划为已掌握
    const existing = db.prepare(
      'SELECT id FROM wrong_review_schedule WHERE student_id = ? AND question_id = ?'
    ).get(studentId, questionId);
    if (existing) {
      db.prepare(
        'UPDATE wrong_review_schedule SET is_mastered = 1, is_done = 1, review_date = ? WHERE id = ?'
      ).run(now, existing.id);
    } else {
      db.prepare(
        'INSERT INTO wrong_review_schedule (question_id, student_id, review_date, review_round, is_done, is_mastered, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(questionId, studentId, now, 1, 1, 1, now);
    }

    response.json({ ok: true, questionId, isMastered: true });
  });

  // 题库筛选元数据
  app.get('/api/questions/meta', requireAuth, (request, response) => {
    const subjects = db.prepare("SELECT DISTINCT subject FROM questions WHERE subject != '' ORDER BY subject").all().map((r) => r.subject);
    const types = db.prepare("SELECT DISTINCT question_type FROM questions WHERE question_type != '' ORDER BY question_type").all().map((r) => r.question_type);
    const textbooks = db.prepare("SELECT DISTINCT textbook FROM questions WHERE textbook != '' ORDER BY textbook").all().map((r) => r.textbook);
    const sourceYears = db.prepare("SELECT DISTINCT source_year FROM questions WHERE source_year IS NOT NULL ORDER BY source_year DESC").all().map((r) => r.source_year);
    const sourcePapers = db.prepare("SELECT DISTINCT source_paper FROM questions WHERE source_paper != '' ORDER BY source_paper").all().map((r) => r.source_paper);
    const tags = db.prepare('SELECT id, name, category FROM question_tags ORDER BY name').all();
    response.json({ subjects, types, textbooks, sourceYears, sourcePapers, tags });
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
    const id = Number(request.params.id);
    if (!Number.isInteger(id) || id <= 0) return response.status(400).json({ error: '无效的 ID。' });
    const selectedAnswer = String(request.body.selectedAnswer || '').trim().toUpperCase();
    const question = db.prepare('SELECT * FROM questions WHERE id = ?').get(id);

    if (!question) {
      response.status(404).json({ error: '题目不存在。' });
      return;
    }

    if (question.is_paid_only && !questionIsAccessible(request.currentUser.id, question)) {
      response.status(403).json({ error: '当前权益不足，无法作答该题目。' });
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
    // B-18: 异步执行成就检查，避免阻塞答题响应
    setImmediate(() => checkAndUnlockAchievements(request.currentUser.id));

    // 错题智能复习调度（3/7/15天间隔）
    if (!isCorrect) {
      const now = dayjs();
      // 删除该题已有的未完成复习记录，避免重复
      db.prepare('DELETE FROM wrong_review_schedule WHERE question_id = ? AND student_id = ? AND reviewed_at IS NULL').run(question.id, request.currentUser.id);
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
    const id = Number(request.params.id);
    if (!Number.isInteger(id) || id <= 0) return response.status(400).json({ error: '无效的 ID。' });
    const note = db.prepare('SELECT * FROM question_notes WHERE question_id = ? AND student_id = ?').get(id, request.currentUser.id);
    response.json({ note: note || null });
  });

  app.post('/api/questions/:id/notes', requireAuth, (request, response) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id) || id <= 0) return response.status(400).json({ error: '无效的 ID。' });
    const content = sanitizeText(request.body.content || '');
    if (!content) { return response.status(400).json({ error: '笔记内容不能为空。' }); }
    const now = dayjs().toISOString();
    db.prepare(`
      INSERT INTO question_notes (question_id, student_id, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(question_id, student_id) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at
    `).run(id, request.currentUser.id, content, now, now);
    response.json({ ok: true });
  });

  app.delete('/api/questions/:id/notes', requireAuth, (request, response) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id) || id <= 0) return response.status(400).json({ error: '无效的 ID。' });
    db.prepare('DELETE FROM question_notes WHERE question_id = ? AND student_id = ?').run(id, request.currentUser.id);
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
      WHERE student_id = ? AND created_at >= ? AND created_at <= ?
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
      WHERE student_id = ? AND created_at >= ? AND created_at <= ?
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
    }).filter((q) => questionIsAccessible(studentId, q));

    response.json({ questions: results });
  });

  // 干扰项自动生成接口
  app.get('/api/questions/:id/distractors', requireAuth, (request, response) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id) || id <= 0) return response.status(400).json({ error: '无效的 ID。' });

    const count = Math.min(Math.max(Number(request.query.count) || 3, 1), 5);

    const question = db.prepare('SELECT * FROM questions WHERE id = ?').get(id);
    if (!question) {
      response.status(404).json({ error: '题目不存在。' });
      return;
    }

    const subject = question.subject;
    const correctAnswer = question.correct_answer;
    const safeJsonParse = shared.safeJsonParse || require('../services/taskService').safeJsonParse;

    // 1. 从同科目其他题目的选项中收集错误答案
    const otherQuestions = db.prepare(
      `SELECT options, correct_answer FROM questions WHERE id != ? AND subject = ? AND display_mode = ? LIMIT 50`
    ).all(id, subject, question.display_mode || 'radio');

    const distractorTexts = new Set();
    for (const q of otherQuestions) {
      const opts = safeJsonParse(q.options, []);
      for (const opt of opts) {
        if (opt && opt.text && opt.text.trim() && opt.key !== q.correct_answer) {
          distractorTexts.add(opt.text.trim());
        }
      }
    }

    // 2. 从同科目闪卡中收集背面内容（释义/答案）作为干扰项
    const flashcards = db.prepare(
      `SELECT back_content FROM flashcards WHERE id != ? AND subject = ? AND back_content != '' LIMIT 30`
    ).all(id, subject);

    for (const fc of flashcards) {
      if (fc.back_content && fc.back_content.trim()) {
        distractorTexts.add(fc.back_content.trim());
      }
    }

    // 3. 排除与正确答案相同的文本
    const correctOption = safeJsonParse(question.options, []).find(o => o.key === correctAnswer);
    const correctText = correctOption ? correctOption.text : '';
    if (correctText) {
      distractorTexts.delete(correctText.trim());
    }

    // 4. 随机选取 count 个干扰项
    let distractors = Array.from(distractorTexts);
    // 随机打乱
    for (let i = distractors.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [distractors[i], distractors[j]] = [distractors[j], distractors[i]];
    }
    distractors = distractors.slice(0, count);

    // 5. 如果干扰项不足，返回已有数量
    if (distractors.length < count) {
      console.warn(`[distractors] 题目 ${id} 的干扰项不足：需要 ${count}，实际 ${distractors.length}`);
    }

    // 6. 构建返回结构：将正确答案 + 干扰项组成 4 个选项并随机排序
    const allOptions = [
      { key: correctAnswer, text: correctText || '正确答案', isCorrect: true },
      ...distractors.map((text, idx) => ({
        key: String.fromCharCode(66 + idx), // B, C, D...
        text,
        isCorrect: false
      }))
    ];

    // 重新随机排序选项
    for (let i = allOptions.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [allOptions[i], allOptions[j]] = [allOptions[j], allOptions[i]];
    }

    // 重新分配选项 key（A, B, C, D）
    const keys = ['A', 'B', 'C', 'D'];
    const finalOptions = allOptions.slice(0, 4).map((opt, idx) => ({
      key: keys[idx],
      text: opt.text,
      isCorrect: opt.isCorrect || false
    }));

    response.json({ options: finalOptions });
  });
};
