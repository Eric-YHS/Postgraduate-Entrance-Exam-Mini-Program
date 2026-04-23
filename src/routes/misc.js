const fs = require('fs');
const path = require('path');
const dayjs = require('dayjs');
const bcrypt = require('bcryptjs');
const { sanitizeText, escapeHtml, stripHtml } = require('../utils/sanitize');
const { calculateNextReview } = require('../services/spacedRepetition');

function serializeFlashcard(row) {
  return {
    id: row.id,
    title: row.title,
    subject: row.subject,
    frontContent: row.front_content,
    frontImagePath: row.front_image_path,
    backContent: row.back_content,
    backImagePath: row.back_image_path,
    audioPath: row.audio_path,
    exampleSentence: row.example_sentence || '',
    wordRoot: row.word_root || '',
    affix: row.affix || '',
    collocations: row.collocations ? JSON.parse(row.collocations) : [],
    phonetic: row.phonetic || '',
    tags: row.tags ? JSON.parse(row.tags) : [],
    createdBy: row.created_by,
    createdAt: row.created_at
  };
}

module.exports = function registerMiscRoutes(app, shared) {
  const { db, requireAuth, requireStudent, requireTeacher, requireAdmin, safeJsonParse, sanitizeUser, serializeProduct, serializeOrder, serializeQuestionForTeacher, serializeFlashcard: _serializeFlashcard, updateStudyStreak, checkAndUnlockAchievements, taskImportUpload, readWorkbookRows, getFieldValue, broadcastToLiveRoom } = shared;

  // 健康检查
  app.get('/healthz', (request, response) => {
    response.json({
      ok: true,
      env: shared.config.nodeEnv,
      time: dayjs().toISOString()
    });
  });

  // WebRTC ICE 服务器配置
  app.get('/api/ice-servers', requireAuth, (request, response) => {
    response.json({ iceServers: shared.config.iceServers });
  });

  // 微信验证文件
  app.get('/ZtVqVx2EAC.txt', (request, response) => {
    response.type('text/plain').send('b464730fde7fc1293f16e10c64f425a7');
  });

  // 静态页面路由
  app.get('/', (request, response) => {
    response.sendFile(path.join(shared.publicDir, 'index.html'));
  });

  app.get('/teacher', (request, response) => {
    response.sendFile(path.join(shared.publicDir, 'teacher.html'));
  });

  app.get('/student', (request, response) => {
    response.sendFile(path.join(shared.publicDir, 'student.html'));
  });

  app.get('/admin', (request, response) => {
    response.sendFile(path.join(shared.publicDir, 'admin.html'));
  });

  app.get('/forum', (request, response) => {
    response.sendFile(path.join(shared.publicDir, 'forum.html'));
  });

  app.get('/forum/topic/:id', (request, response) => {
    response.sendFile(path.join(shared.publicDir, 'topic-detail.html'));
  });

  app.get('/register', (request, response) => {
    response.sendFile(path.join(shared.publicDir, 'register.html'));
  });

  app.get('/live/:id', (request, response) => {
    response.sendFile(path.join(shared.publicDir, 'live.html'));
  });

  // 用户批量导入（管理员）
  app.post('/api/users/import', requireAdmin, (request, response) => {
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
        const username = getFieldValue(row, ['用户名', 'username', 'Username']);
        const password = getFieldValue(row, ['密码', 'password', 'Password']);
        const role = getFieldValue(row, ['角色', 'role', 'Role']);
        const displayName = sanitizeText(getFieldValue(row, ['显示名称', 'displayName', 'DisplayName']));
        const className = sanitizeText(getFieldValue(row, ['班级', 'className', 'ClassName']));

        if (!username || !password || !role || !displayName) {
          skipped += 1;
          return;
        }

        // BUG-022: 批量导入验证密码长度
        if (password.length < 6) {
          skipped += 1;
          return;
        }

        if (!['teacher', 'student'].includes(role)) {
          skipped += 1;
          return;
        }

        const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
        if (existing) {
          skipped += 1;
          return;
        }

        db.prepare(
          'INSERT INTO users (username, password, role, display_name, class_name, created_at) VALUES (?, ?, ?, ?, ?, ?)'
        ).run(username, bcrypt.hashSync(password, 10), role, displayName, className, dayjs().toISOString());

        imported += 1;
      });

      fs.unlink(request.file.path, () => {});
      response.json({ ok: true, imported, skipped });
    });
  });

  // 词汇卡片批量导入
  app.post('/api/flashcards/import', requireTeacher, (request, response) => {
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
        const title = sanitizeText(getFieldValue(row, ['标题', 'title', 'Title']));
        const subject = sanitizeText(getFieldValue(row, ['科目', 'subject', 'Subject']));
        const frontContent = sanitizeText(getFieldValue(row, ['正面内容', 'frontContent', 'FrontContent']));
        const backContent = sanitizeText(getFieldValue(row, ['背面内容', 'backContent', 'BackContent']));
        const tags = sanitizeText(getFieldValue(row, ['标签', 'tags', 'Tags']));

        if (!title || !frontContent || !backContent) {
          skipped += 1;
          return;
        }

        db.prepare(
          'INSERT INTO flashcards (title, subject, front_content, back_content, tags, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).run(
          title, subject, frontContent, backContent,
          JSON.stringify(tags ? tags.split(/[,，]/).map((t) => t.trim()).filter(Boolean) : []),
          request.currentUser.id, dayjs().toISOString()
        );

        imported += 1;
      });

      fs.unlink(request.file.path, () => {});
      response.json({ ok: true, imported, skipped });
    });
  });

  // 模板下载
  app.get('/api/templates/:type', requireAuth, (request, response) => {
    const typeMap = {
      task: 'task-import-template.csv',
      question: 'question-import-template.csv',
      user: 'user-import-template.csv',
      flashcard: 'flashcard-import-template.csv'
    };

    const fileName = typeMap[request.params.type];
    if (!fileName) {
      response.status(400).json({ error: '未知模板类型。' });
      return;
    }

    const templatePath = path.join(shared.config.rootDir, 'templates', fileName);
    if (!fs.existsSync(templatePath)) {
      response.status(404).json({ error: '模板文件不存在。' });
      return;
    }

    // BUG-011: 设置正确的 Content-Type 和 charset
    response.set('Content-Type', 'text/csv; charset=utf-8');
    response.download(templatePath, fileName);
  });

  // 成就系统
  app.get('/api/achievements', requireAuth, (request, response) => {
    const achievements = db.prepare('SELECT * FROM achievements ORDER BY id').all();
    const unlocked = db.prepare('SELECT achievement_id, unlocked_at FROM user_achievements WHERE user_id = ?').all(request.currentUser.id);
    const unlockMap = new Map(unlocked.map((u) => [u.achievement_id, u.unlocked_at]));
    response.json({
      achievements: achievements.map((a) => ({
        id: a.id,
        code: a.code,
        title: a.title,
        description: a.description,
        icon: a.icon,
        unlocked: unlockMap.has(a.id),
        unlockedAt: unlockMap.get(a.id) || null
      }))
    });
  });

  // 手动解锁成就
  app.post('/api/achievements/unlock', requireAuth, (request, response) => {
    const { code, value } = request.body;
    const ach = db.prepare('SELECT * FROM achievements WHERE code = ?').get(code);
    if (!ach) { response.json({ unlocked: false }); return; }

    const alreadyUnlocked = db.prepare('SELECT id FROM user_achievements WHERE user_id = ? AND achievement_id = ?').get(request.currentUser.id, ach.id);
    if (alreadyUnlocked) { response.json({ unlocked: false }); return; }

    if (ach.condition_type === 'focus_minutes' && value >= ach.condition_value) {
      db.prepare('INSERT INTO user_achievements (user_id, achievement_id, unlocked_at) VALUES (?, ?, ?)').run(request.currentUser.id, ach.id, dayjs().toISOString());
      response.json({ unlocked: true, achievement: { id: ach.id, code: ach.code, title: ach.title, icon: ach.icon } });
      return;
    }
    if (ach.condition_type === 'early_bird' && value >= 1) {
      db.prepare('INSERT INTO user_achievements (user_id, achievement_id, unlocked_at) VALUES (?, ?, ?)').run(request.currentUser.id, ach.id, dayjs().toISOString());
      response.json({ unlocked: true, achievement: { id: ach.id, code: ach.code, title: ach.title, icon: ach.icon } });
      return;
    }

    response.json({ unlocked: false });
  });

  // 词汇卡片 API
  app.get('/api/flashcards', requireAuth, (request, response) => {
    const { subject } = request.query;
    let query = 'SELECT * FROM flashcards';
    const params = [];

    if (subject) {
      query += ' WHERE subject = ?';
      params.push(subject);
    }

    query += ' ORDER BY created_at DESC LIMIT 500';
    const flashcards = db.prepare(query).all(...params).map(serializeFlashcard);
    response.json({ flashcards });
  });

  app.get('/api/flashcards/due', requireStudent, (request, response) => {
    const today = dayjs().format('YYYY-MM-DD');
    const flashcards = db.prepare(
      `SELECT f.*, fr.quality, fr.ease_factor, fr.interval_days, fr.repetitions, fr.next_review_date
       FROM flashcards f
       LEFT JOIN flashcard_records fr ON fr.flashcard_id = f.id AND fr.student_id = ?
       WHERE fr.next_review_date IS NULL OR fr.next_review_date <= ?
       ORDER BY f.created_at DESC`
    ).all(request.currentUser.id, today).map((row) => ({
      ...serializeFlashcard(row),
      record: row.quality !== null ? {
        quality: row.quality,
        easeFactor: row.ease_factor,
        intervalDays: row.interval_days,
        repetitions: row.repetitions,
        nextReviewDate: row.next_review_date
      } : null
    }));

    response.json({ flashcards });
  });

  app.post('/api/flashcards', requireTeacher, (request, response) => {
    const title = sanitizeText(request.body.title);
    const frontContent = sanitizeText(request.body.frontContent);
    const backContent = sanitizeText(request.body.backContent);

    if (!title || !frontContent || !backContent) {
      response.status(400).json({ error: '请填写标题、正面和背面内容。' });
      return;
    }

    const flashcardResult = db.prepare(
      `INSERT INTO flashcards (title, subject, front_content, back_content, example_sentence, tags, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      title,
      sanitizeText(request.body.subject),
      frontContent,
      backContent,
      sanitizeText(request.body.exampleSentence || ''),
      JSON.stringify(request.body.tags || []),
      request.currentUser.id,
      dayjs().toISOString()
    );

    response.json({ ok: true, id: flashcardResult.lastInsertRowid });
  });

  app.post('/api/flashcards/:id/review', requireStudent, (request, response) => {
    const quality = Number(request.body.quality);
    if (![0, 1, 2, 3].includes(quality)) {
      response.status(400).json({ error: 'quality 必须为 0-3。' });
      return;
    }

    const flashcard = db.prepare('SELECT * FROM flashcards WHERE id = ?').get(request.params.id);
    if (!flashcard) {
      response.status(404).json({ error: '卡片不存在。' });
      return;
    }

    const existing = db.prepare('SELECT * FROM flashcard_records WHERE flashcard_id = ? AND student_id = ?').get(request.params.id, request.currentUser.id);

    let currentEase = existing ? existing.ease_factor : 2.5;
    let currentInterval = existing ? existing.interval_days : 0;
    let currentReps = existing ? existing.repetitions : 0;

    const next = calculateNextReview(quality, currentEase, currentInterval, currentReps);

    if (existing) {
      db.prepare(
        `UPDATE flashcard_records SET quality = ?, ease_factor = ?, interval_days = ?, repetitions = ?, next_review_date = ? WHERE id = ?`
      ).run(quality, next.easeFactor, next.interval, next.repetitions, next.nextReviewDate, existing.id);
    } else {
      db.prepare(
        `INSERT INTO flashcard_records (flashcard_id, student_id, quality, ease_factor, interval_days, repetitions, next_review_date, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(request.params.id, request.currentUser.id, quality, next.easeFactor, next.interval, next.repetitions, next.nextReviewDate, dayjs().toISOString());
    }

    updateStudyStreak(request.currentUser.id);
    checkAndUnlockAchievements(request.currentUser.id);

    response.json({ ok: true, nextReview: next });
  });

  // 模拟考试
  app.get('/api/mock-exams', requireAuth, (request, response) => {
    const exams = db.prepare(`
      SELECT me.*, u.display_name AS creator_name FROM mock_exams me
      LEFT JOIN users u ON u.id = me.created_by
      ORDER BY me.created_at DESC LIMIT 50
    `).all();
    response.json({ exams });
  });

  app.post('/api/mock-exams', requireAuth, (request, response) => {
    if (request.currentUser.role !== 'teacher') { return response.status(403).json({ error: '无权限。' }); }
    const title = sanitizeText(request.body.title || '');
    const subject = sanitizeText(request.body.subject || '');
    const duration = Math.max(10, Number(request.body.durationMinutes) || 120);
    const questionIds = request.body.questionIds || [];
    if (!title || !questionIds.length) { return response.status(400).json({ error: '缺少参数。' }); }

    const result = db.prepare(
      'INSERT INTO mock_exams (title, subject, duration_minutes, question_ids, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(title, subject, duration, JSON.stringify(questionIds), request.currentUser.id, dayjs().toISOString());
    response.json({ ok: true, id: result.lastInsertRowid });
  });

  app.post('/api/mock-exams/:id/start', requireStudent, (request, response) => {
    const examId = Number(request.params.id);
    const exam = db.prepare('SELECT * FROM mock_exams WHERE id = ?').get(examId);
    if (!exam) { return response.status(404).json({ error: '考试不存在。' }); }

    const existing = db.prepare('SELECT * FROM mock_exam_submissions WHERE exam_id = ? AND student_id = ?').get(examId, request.currentUser.id);
    if (existing) { return response.json({ submission: existing, exam }); }

    const result = db.prepare(
      'INSERT INTO mock_exam_submissions (exam_id, student_id, started_at) VALUES (?, ?, ?)'
    ).run(examId, request.currentUser.id, dayjs().toISOString());
    const submission = db.prepare('SELECT * FROM mock_exam_submissions WHERE id = ?').get(result.lastInsertRowid);
    response.json({ submission, exam });
  });

  app.post('/api/mock-exams/:id/submit', requireStudent, (request, response) => {
    const examId = Number(request.params.id);
    const submission = db.prepare('SELECT * FROM mock_exam_submissions WHERE exam_id = ? AND student_id = ?').get(examId, request.currentUser.id);
    if (!submission) { return response.status(404).json({ error: '未开始考试。' }); }
    if (submission.submitted_at) { return response.status(400).json({ error: '已提交。' }); }

    const answers = request.body.answers || {};
    const timeSpent = Number(request.body.timeSpentMs) || 0;

    // 批量判分
    const exam = db.prepare('SELECT * FROM mock_exams WHERE id = ?').get(examId);
    const qIds = safeJsonParse(exam.question_ids, []);
    let score = 0;
    const totalScore = 100;
    const perQuestion = qIds.length > 0 ? totalScore / qIds.length : 0;

    qIds.forEach((qId) => {
      const question = db.prepare('SELECT correct_answer FROM questions WHERE id = ?').get(qId);
      if (question && answers[qId] === question.correct_answer) {
        score += perQuestion;
      }
    });

    db.prepare(
      'UPDATE mock_exam_submissions SET answers = ?, score = ?, time_spent_ms = ?, submitted_at = ? WHERE id = ?'
    ).run(JSON.stringify(answers), Math.round(score * 100) / 100, timeSpent, dayjs().toISOString(), submission.id);

    response.json({ ok: true, score: Math.round(score * 100) / 100, total: totalScore });
  });

  app.get('/api/mock-exams/:id/result', requireStudent, (request, response) => {
    const examId = Number(request.params.id);
    const exam = db.prepare('SELECT * FROM mock_exams WHERE id = ?').get(examId);
    const submission = db.prepare('SELECT * FROM mock_exam_submissions WHERE exam_id = ? AND student_id = ?').get(examId, request.currentUser.id);
    if (!exam || !submission) { return response.status(404).json({ error: '不存在。' }); }

    const qIds = safeJsonParse(exam.question_ids, []);
    const answers = safeJsonParse(submission.answers, {});
    const details = qIds.map((qId) => {
      const q = db.prepare('SELECT id, title, stem, options, correct_answer, analysis_text FROM questions WHERE id = ?').get(qId);
      if (!q) return null;
      return {
        id: q.id, title: q.title, stem: q.stem,
        options: safeJsonParse(q.options, []),
        correctAnswer: q.correct_answer,
        myAnswer: answers[qId] || '',
        isCorrect: answers[qId] === q.correct_answer,
        analysisText: q.analysis_text
      };
    }).filter(Boolean);

    response.json({
      exam: { title: exam.title, subject: exam.subject, durationMinutes: exam.duration_minutes },
      submission: { score: submission.score, timeSpentMs: submission.time_spent_ms, submittedAt: submission.submitted_at, startedAt: submission.started_at },
      details
    });
  });

  // 考研倒计时
  app.get('/api/exam-countdown', requireAuth, (request, response) => {
    const row = db.prepare('SELECT * FROM exam_countdown WHERE student_id = ?').get(request.currentUser.id);
    response.json({ countdown: row || null });
  });

  app.post('/api/exam-countdown', requireAuth, (request, response) => {
    const examDate = sanitizeText(request.body.examDate || '');
    const examName = sanitizeText(request.body.examName || '考研');
    if (!examDate) { return response.status(400).json({ error: '请设置考试日期。' }); }
    db.prepare(`
      INSERT INTO exam_countdown (student_id, exam_date, exam_name, created_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(student_id) DO UPDATE SET exam_date = excluded.exam_date, exam_name = excluded.exam_name
    `).run(request.currentUser.id, examDate, examName, dayjs().toISOString());
    response.json({ ok: true });
  });

  // 习惯追踪
  app.get('/api/habits', requireAuth, (request, response) => {
    const habits = db.prepare('SELECT * FROM habit_tracking WHERE student_id = ? ORDER BY created_at DESC').all(request.currentUser.id);
    response.json({ habits: habits.map((h) => ({ ...h, completedDates: safeJsonParse(h.completed_dates, []) })) });
  });

  app.post('/api/habits', requireAuth, (request, response) => {
    const name = sanitizeText(request.body.name || '');
    const targetDays = Math.max(1, Number(request.body.targetDays) || 7);
    if (!name) { return response.status(400).json({ error: '习惯名不能为空。' }); }
    db.prepare('INSERT INTO habit_tracking (student_id, habit_name, target_days, completed_dates, created_at) VALUES (?, ?, ?, ?, ?)').run(
      request.currentUser.id, name, targetDays, '[]', dayjs().toISOString()
    );
    response.json({ ok: true });
  });

  app.post('/api/habits/:id/check', requireAuth, (request, response) => {
    const habit = db.prepare('SELECT * FROM habit_tracking WHERE id = ? AND student_id = ?').get(request.params.id, request.currentUser.id);
    if (!habit) { return response.status(404).json({ error: '不存在。' }); }
    const dates = safeJsonParse(habit.completed_dates, []);
    const today = dayjs().format('YYYY-MM-DD');
    if (dates.includes(today)) { return response.json({ ok: true, already: true }); }
    dates.push(today);
    db.prepare('UPDATE habit_tracking SET completed_dates = ? WHERE id = ?').run(JSON.stringify(dates), habit.id);
    response.json({ ok: true });
  });

  app.delete('/api/habits/:id', requireAuth, (request, response) => {
    db.prepare('DELETE FROM habit_tracking WHERE id = ? AND student_id = ?').run(Number(request.params.id), request.currentUser.id);
    response.json({ ok: true });
  });

  // 闪卡每日目标
  app.get('/api/flashcards/goal', requireStudent, (request, response) => {
    const goal = db.prepare('SELECT * FROM flashcard_goals WHERE student_id = ?').get(request.currentUser.id);
    response.json({ goal: goal || { daily_new: 20, daily_review: 50 } });
  });

  app.post('/api/flashcards/goal', requireStudent, (request, response) => {
    const dailyNew = Math.max(1, Math.min(200, Number(request.body.dailyNew) || 20));
    const dailyReview = Math.max(1, Math.min(500, Number(request.body.dailyReview) || 50));
    db.prepare(
      `INSERT INTO flashcard_goals (student_id, daily_new, daily_review, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(student_id) DO UPDATE SET daily_new = excluded.daily_new, daily_review = excluded.daily_review, updated_at = excluded.updated_at`
    ).run(request.currentUser.id, dailyNew, dailyReview, dayjs().toISOString());
    response.json({ ok: true });
  });

  // 闪卡排行榜
  app.get('/api/flashcards/leaderboard', requireAuth, (request, response) => {
    const period = request.query.period || 'week';
    let dateFilter = '';
    if (period === 'week') {
      dateFilter = " AND created_at >= datetime('now', '-7 days')";
    } else if (period === 'month') {
      dateFilter = " AND created_at >= datetime('now', '-30 days')";
    }
    const leaders = db.prepare(`
      SELECT fr.student_id, u.display_name, COUNT(*) AS review_count,
        SUM(CASE WHEN fr.quality >= 3 THEN 1 ELSE 0 END) AS good_count
      FROM flashcard_records fr
      JOIN users u ON u.id = fr.student_id
      WHERE 1=1${dateFilter}
      GROUP BY fr.student_id ORDER BY review_count DESC LIMIT 20
    `).all();
    response.json({ leaderboard: leaders });
  });

  // 用户关注系统
  app.post('/api/users/:id/follow', requireAuth, (request, response) => {
    const followingId = Number(request.params.id);
    const followerId = request.currentUser.id;
    if (followingId === followerId) { return response.status(400).json({ error: '不能关注自己。' }); }
    const target = db.prepare('SELECT id FROM users WHERE id = ?').get(followingId);
    if (!target) { return response.status(404).json({ error: '用户不存在。' }); }

    const existing = db.prepare('SELECT id FROM user_follows WHERE follower_id = ? AND following_id = ?').get(followerId, followingId);
    if (existing) {
      db.prepare('DELETE FROM user_follows WHERE id = ?').run(existing.id);
      response.json({ following: false });
    } else {
      db.prepare('INSERT INTO user_follows (follower_id, following_id, created_at) VALUES (?, ?, ?)').run(followerId, followingId, dayjs().toISOString());
      response.json({ following: true });
    }
  });

  app.get('/api/users/:id/follow-status', requireAuth, (request, response) => {
    const targetId = Number(request.params.id);
    const userId = request.currentUser.id;
    const isFollowing = db.prepare('SELECT id FROM user_follows WHERE follower_id = ? AND following_id = ?').get(userId, targetId);
    const followerCount = db.prepare('SELECT COUNT(*) AS cnt FROM user_follows WHERE following_id = ?').get(targetId).cnt;
    const followingCount = db.prepare('SELECT COUNT(*) AS cnt FROM user_follows WHERE follower_id = ?').get(targetId).cnt;
    response.json({ isFollowing: !!isFollowing, followerCount, followingCount });
  });

  app.get('/api/users/:id/followers', requireAuth, (request, response) => {
    const userId = Number(request.params.id);
    const rows = db.prepare(`
      SELECT u.id, u.display_name, u.role FROM user_follows f
      JOIN users u ON u.id = f.follower_id WHERE f.following_id = ?
      ORDER BY f.created_at DESC LIMIT 50
    `).all(userId);
    response.json({ followers: rows });
  });

  app.get('/api/users/:id/following', requireAuth, (request, response) => {
    const userId = Number(request.params.id);
    const rows = db.prepare(`
      SELECT u.id, u.display_name, u.role FROM user_follows f
      JOIN users u ON u.id = f.following_id WHERE f.follower_id = ?
      ORDER BY f.created_at DESC LIMIT 50
    `).all(userId);
    response.json({ following: rows });
  });

  // 内容举报
  app.post('/api/reports', requireAuth, (request, response) => {
    const { targetType, targetId, reason } = request.body;
    if (!targetType || !targetId) { return response.status(400).json({ error: '缺少参数。' }); }
    db.prepare('INSERT INTO content_reports (reporter_id, target_type, target_id, reason, created_at) VALUES (?, ?, ?, ?, ?)').run(
      request.currentUser.id, targetType, Number(targetId), sanitizeText(reason || ''), dayjs().toISOString()
    );
    response.json({ ok: true });
  });

  app.get('/api/reports', requireAuth, (request, response) => {
    if (request.currentUser.role !== 'teacher' && request.currentUser.role !== 'admin') {
      return response.status(403).json({ error: '无权限。' });
    }
    const status = request.query.status || 'pending';
    const reports = db.prepare(`
      SELECT cr.*, u.display_name AS reporter_name FROM content_reports cr
      LEFT JOIN users u ON u.id = cr.reporter_id
      WHERE cr.status = ? ORDER BY cr.created_at DESC LIMIT 50
    `).all(status);
    response.json({ reports });
  });

  app.post('/api/reports/:id/review', requireAuth, (request, response) => {
    if (request.currentUser.role !== 'teacher' && request.currentUser.role !== 'admin') {
      return response.status(403).json({ error: '无权限。' });
    }
    const action = request.body.action; // 'reviewed' or 'dismissed'
    if (!['reviewed', 'dismissed'].includes(action)) { return response.status(400).json({ error: '无效操作。' }); }
    db.prepare('UPDATE content_reports SET status = ? WHERE id = ?').run(action, request.params.id);
    response.json({ ok: true });
  });

  // AI 智能功能
  app.post('/api/ai/tutor', requireAuth, async (request, response) => {
    const { question, context } = request.body;
    if (!question) { return response.status(400).json({ error: '请输入问题。' }); }
    const safeQuestion = String(question).slice(0, 2000);
    const safeContext = context ? String(context).slice(0, 2000) : '';

    const systemPrompt = '你是一个专业的考研辅导老师，擅长各科目答疑。请给出详细的解题思路和知识点讲解。';
    const userPrompt = safeContext ? ('背景：' + safeContext + '\n\n问题：' + safeQuestion) : safeQuestion;

    try {
      const aiResponse = await shared.callAI(systemPrompt, userPrompt);
      db.prepare('INSERT INTO ai_conversations (user_id, type, prompt, response, created_at) VALUES (?, ?, ?, ?, ?)').run(
        request.currentUser.id, 'tutor', question, aiResponse, dayjs().toISOString()
      );
      response.json({ response: aiResponse });
    } catch (err) {
      console.error('AI tutor error:', err.message);
      response.status(500).json({ error: 'AI 服务暂时不可用。' });
    }
  });

  app.post('/api/ai/essay-grade', requireAuth, async (request, response) => {
    const { essay, type } = request.body;
    if (!essay) { return response.status(400).json({ error: '请输入作文。' }); }
    const safeEssay = String(essay).slice(0, 5000);

    const systemPrompt = '你是一个考研英语作文批改专家。请评分（满分20分），指出语法错误，给出修改建议和范文参考。';
    const userPrompt = '作文类型：' + (type || '未知') + '\n\n' + safeEssay;

    try {
      const aiResponse = await shared.callAI(systemPrompt, userPrompt);
      db.prepare('INSERT INTO ai_conversations (user_id, type, prompt, response, created_at) VALUES (?, ?, ?, ?, ?)').run(
        request.currentUser.id, 'essay', essay.substring(0, 500), aiResponse, dayjs().toISOString()
      );
      response.json({ response: aiResponse });
    } catch (err) {
      console.error('AI essay grade error:', err.message);
      response.status(500).json({ error: 'AI 服务暂时不可用。' });
    }
  });

  app.post('/api/ai/study-plan', requireAuth, async (request, response) => {
    const userId = request.currentUser.id;

    // 收集用户数据
    const stats = db.prepare('SELECT COUNT(*) AS total, SUM(CASE WHEN is_correct = 1 THEN 1 ELSE 0 END) AS correct FROM practice_records WHERE student_id = ?').get(userId);
    const subjects = db.prepare('SELECT subject, COUNT(*) AS cnt, SUM(CASE WHEN is_correct = 1 THEN 1 ELSE 0 END) AS correct FROM practice_records pr JOIN questions q ON q.id = pr.question_id WHERE pr.student_id = ? GROUP BY subject').all(userId);
    const streak = db.prepare('SELECT current_streak FROM study_streaks WHERE student_id = ?').get(userId);

    const accuracy = stats.total > 0 ? Math.round(stats.correct / stats.total * 100) : 0;
    const subjectInfo = subjects.map((s) => s.subject + '：正确率 ' + (s.cnt > 0 ? Math.round(s.correct / s.cnt * 100) : 0) + '%，做题 ' + s.cnt + ' 道').join('；');
    const streakDays = streak ? streak.current_streak : 0;

    const systemPrompt = '你是一个考研学习规划师。根据学生的做题数据，生成个性化每日学习计划。';
    const userPrompt = '学生数据：总做题 ' + stats.total + ' 道，总正确率 ' + accuracy + '%，连续学习 ' + streakDays + ' 天。分科目：' + subjectInfo + '。请给出今天的学习计划建议。';

    try {
      const aiResponse = await shared.callAI(systemPrompt, userPrompt);
      db.prepare('INSERT INTO ai_conversations (user_id, type, prompt, response, context, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
        userId, 'plan', userPrompt, aiResponse, JSON.stringify({ accuracy, streakDays }), dayjs().toISOString()
      );
      response.json({ response: aiResponse });
    } catch (err) {
      console.error('AI study plan error:', err.message);
      response.status(500).json({ error: 'AI 服务暂时不可用。' });
    }
  });

  app.post('/api/ai/generate-questions', requireAuth, async (request, response) => {
    if (request.currentUser.role !== 'teacher') { return response.status(403).json({ error: '无权限。' }); }
    const { subject, topic, count, type } = request.body;

    const systemPrompt = '你是一个考研出题专家。请生成标准的考研练习题，格式为 JSON 数组，每题包含 title, stem, options(4个选项的数组), correctAnswer, analysisText。';
    const userPrompt = '科目：' + (subject || '综合') + '，知识点：' + (topic || '综合') + '，数量：' + (count || 5) + '，题型：' + (type || '选择题');

    try {
      const aiResponse = await shared.callAI(systemPrompt, userPrompt);
      db.prepare('INSERT INTO ai_conversations (user_id, type, prompt, response, created_at) VALUES (?, ?, ?, ?, ?)').run(
        request.currentUser.id, 'generate', userPrompt, aiResponse, dayjs().toISOString()
      );
      response.json({ response: aiResponse });
    } catch (err) {
      console.error('AI generate error:', err.message);
      response.status(500).json({ error: 'AI 服务暂时不可用。' });
    }
  });

  app.post('/api/ai/summary', requireAuth, async (request, response) => {
    const { content, type } = request.body;
    if (!content) { return response.status(400).json({ error: '请提供内容。' }); }

    const systemPrompt = '请对以下内容生成简洁的摘要，突出重点和关键信息。';
    const userPrompt = '内容类型：' + (type || '帖子') + '\n\n' + content.substring(0, 3000);

    try {
      const aiResponse = await shared.callAI(systemPrompt, userPrompt);
      db.prepare('INSERT INTO ai_conversations (user_id, type, prompt, response, created_at) VALUES (?, ?, ?, ?, ?)').run(
        request.currentUser.id, 'summary', content.substring(0, 200), aiResponse, dayjs().toISOString()
      );
      response.json({ response: aiResponse });
    } catch (err) {
      console.error('AI summary error:', err.message);
      response.status(500).json({ error: 'AI 服务暂时不可用。' });
    }
  });

  // BUG-012: API 路由统一返回 JSON 404
  app.use('/api', (request, response) => {
    response.status(404).json({ error: '接口不存在。' });
  });

  app.use((error, request, response, next) => {
    console.error(error);
    if (response.headersSent) {
      next(error);
      return;
    }

    response.status(500).json({ error: '服务器内部错误，请稍后重试。' });
  });
};
