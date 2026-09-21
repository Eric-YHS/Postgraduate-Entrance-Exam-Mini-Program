const crypto = require('crypto');
const dayjs = require('dayjs');
const config = require('../config');
const {
  adjustNextDayPlan,
  getPlanDays,
  replacePlanForDate,
  updatePlanStatus
} = require('../services/studyPlan');
const { calculateNextReview, getInitialReviewParams } = require('../services/spacedRepetition');
const { dispatchBotEvent } = require('../services/botPush');

function safeNumber(value) {
  if (value === '' || value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function serializeProfile(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    inviteToken: row.invite_token,
    wecomUserid: row.wecom_userid,
    name: row.name,
    gender: row.gender,
    gaokaoEnglishScore: row.gaokao_english_score,
    cet4Score: row.cet4_score,
    upgradeEnglishScore: row.upgrade_english_score,
    vocabularyLevel: row.vocabulary_level,
    previousReview: row.previous_review,
    weakestEnglishSection: row.weakest_english_section,
    gaokaoMathScore: row.gaokao_math_score,
    upgradeMathScore: row.upgrade_math_score,
    englishPaper: row.english_paper,
    mathPaper: row.math_paper,
    shippingName: row.shipping_name,
    shippingPhone: row.shipping_phone,
    shippingAddress: row.shipping_address,
    requirements: row.requirements,
    targetSchool: row.target_school,
    targetMajor: row.target_major,
    currentStage: row.current_stage,
    headTeacherName: row.head_teacher_name,
    email: row.email,
    submittedAt: row.submitted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function serializePlanTemplate(row, fallbackTargetSchool = '') {
  return {
    studentId: Number(row?.student_id || 0) || null,
    targetSchool: row?.target_school || fallbackTargetSchool || '',
    englishTargetScore: row?.english_target_score ?? null,
    politicsTargetScore: row?.politics_target_score ?? null,
    business1TargetScore: row?.business1_target_score ?? null,
    business2TargetScore: row?.business2_target_score ?? null,
    englishLongTask: row?.english_long_task || '',
    englishStageTask: row?.english_stage_task || '',
    mathTask: row?.math_task || '',
    politicsTask: row?.politics_task || '',
    professionalTask: row?.professional_task || '',
    extraTasks: (() => { try { const value = JSON.parse(row?.extra_tasks_json || '[]'); return Array.isArray(value) ? value : []; } catch (_) { return []; } })(),
    updatedAt: row?.updated_at || null
  };
}

function publicBaseUrl(request) {
  const configured = String(config.publicBaseUrl || process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
  if (configured) return configured;
  return `${request.protocol}://${request.get('host')}`;
}

module.exports = function registerRequirementsRoutes(app, shared) {
  const { db, requireAdmin, requireStudent } = shared;

  app.post('/api/admin/student-profiles/invites', requireAdmin, (request, response) => {
    const userId = Number(request.body?.userId) || null;
    const wecomUserid = String(request.body?.wecomUserid || '').trim();
    if (!userId && !wecomUserid) return response.status(400).json({ error: 'userId 或 wecomUserid 至少填写一个。' });
    const user = userId ? db.prepare("SELECT id, display_name, wecom_userid FROM users WHERE id = ? AND role = 'student'").get(userId) : null;
    if (userId && !user) return response.status(404).json({ error: '学员用户不存在。' });
    let row = userId
      ? db.prepare('SELECT * FROM student_profiles WHERE user_id = ?').get(userId)
      : db.prepare('SELECT * FROM student_profiles WHERE wecom_userid = ?').get(wecomUserid);
    if (!row) {
      const token = crypto.randomBytes(24).toString('hex');
      const now = dayjs().toISOString();
      const result = db.prepare(`
        INSERT INTO student_profiles
          (user_id, invite_token, wecom_userid, name, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(userId, token, wecomUserid || user?.wecom_userid || '', String(request.body?.name || user?.display_name || ''), now, now);
      row = db.prepare('SELECT * FROM student_profiles WHERE id = ?').get(result.lastInsertRowid);
    }
    response.json({ profile: serializeProfile(row), url: `${publicBaseUrl(request)}/student-profile.html?token=${row.invite_token}` });
  });

  app.get('/api/admin/student-profiles', requireAdmin, (request, response) => {
    const rows = db.prepare(`
      SELECT p.*, u.username, u.display_name FROM student_profiles p
      LEFT JOIN users u ON u.id = p.user_id ORDER BY p.updated_at DESC
    `).all();
    response.json({ profiles: rows.map((row) => ({
      ...serializeProfile(row),
      username: row.username,
      displayName: row.display_name,
      planTemplate: row.user_id
        ? serializePlanTemplate(db.prepare('SELECT * FROM student_plan_templates WHERE student_id = ?').get(row.user_id), row.target_school)
        : null
    })) });
  });

  app.get('/api/public/student-profiles/:token', (request, response) => {
    const row = db.prepare('SELECT * FROM student_profiles WHERE invite_token = ?').get(request.params.token);
    if (!row) return response.status(404).json({ error: '登记链接无效或已过期。' });
    response.json({ profile: serializeProfile(row) });
  });

  app.put('/api/public/student-profiles/:token', (request, response) => {
    const row = db.prepare('SELECT * FROM student_profiles WHERE invite_token = ?').get(request.params.token);
    if (!row) return response.status(404).json({ error: '登记链接无效或已过期。' });
    const body = request.body || {};
    const now = dayjs().toISOString();
    db.prepare(`
      UPDATE student_profiles SET
        name = ?, gender = ?, gaokao_english_score = ?, cet4_score = ?, upgrade_english_score = ?,
        vocabulary_level = ?, previous_review = ?, weakest_english_section = ?, gaokao_math_score = ?,
        upgrade_math_score = ?, english_paper = ?, math_paper = ?, shipping_name = ?, shipping_phone = ?,
        shipping_address = ?, requirements = ?, target_school = ?, target_major = ?, current_stage = ?,
        head_teacher_name = ?, email = ?, extra_json = ?, submitted_at = ?, updated_at = ?
      WHERE id = ?
    `).run(
      String(body.name || '').trim(), String(body.gender || '').trim(), safeNumber(body.gaokaoEnglishScore), safeNumber(body.cet4Score), safeNumber(body.upgradeEnglishScore),
      String(body.vocabularyLevel || '').trim(), String(body.previousReview || '').trim(), String(body.weakestEnglishSection || '').trim(), safeNumber(body.gaokaoMathScore),
      safeNumber(body.upgradeMathScore), String(body.englishPaper || '').trim(), String(body.mathPaper || '').trim(), String(body.shippingName || '').trim(), String(body.shippingPhone || '').trim(),
      String(body.shippingAddress || '').trim(), String(body.requirements || '').trim(), String(body.targetSchool || '').trim(), String(body.targetMajor || '').trim(), String(body.currentStage || '基础').trim(),
      String(body.headTeacherName || '').trim(), String(body.email || '').trim(), JSON.stringify(body.extra || {}), now, now, row.id
    );
    if (row.user_id && String(body.currentStage || '基础').trim() !== String(row.current_stage || '')) {
      dispatchBotEvent(db, 'stage_change', { studentIds: [row.user_id] }).catch((error) => {
        console.error('触发阶段切换机器人推送失败:', error.message);
      });
    }
    response.json({ success: true, profile: serializeProfile(db.prepare('SELECT * FROM student_profiles WHERE id = ?').get(row.id)) });
  });

  app.get('/api/student/plans', requireStudent, (request, response) => {
    const days = Math.min(31, Math.max(1, Number(request.query.days) || 7));
    const startDate = request.query.startDate || dayjs().format('YYYY-MM-DD');
    response.json({ code: 0, data: { days: getPlanDays(db, request.currentUser.id, { startDate, days }) }, message: '' });
  });

  app.patch('/api/student/plans/:id', requireStudent, (request, response) => {
    try {
      const item = updatePlanStatus(db, {
        itemId: Number(request.params.id),
        studentId: request.currentUser.id,
        status: String(request.body?.status || ''),
        feedback: request.body?.feedback
      });
      if (!item) return response.status(404).json({ code: 404, message: '计划项不存在。' });
      response.json({ code: 0, data: { item }, message: '' });
    } catch (error) {
      response.status(400).json({ code: 400, message: error.message });
    }
  });

  app.post('/api/student/plans/update', requireStudent, (request, response) => {
    try {
      const item = updatePlanStatus(db, {
        itemId: Number(request.body?.id),
        studentId: request.currentUser.id,
        status: String(request.body?.status || ''),
        feedback: request.body?.feedback
      });
      if (!item) return response.status(404).json({ code: 404, message: '计划项不存在。' });
      response.json({ code: 0, data: { item }, message: '' });
    } catch (error) {
      response.status(400).json({ code: 400, message: error.message });
    }
  });

  app.get('/api/student/vocabulary', requireStudent, (request, response) => {
    const today = dayjs().format('YYYY-MM-DD');
    const rows = db.prepare(`
      SELECT f.*, fr.quality, fr.ease_factor, fr.interval_days, fr.repetitions, fr.next_review_date
      FROM flashcards f
      LEFT JOIN flashcard_records fr ON fr.flashcard_id = f.id AND fr.student_id = ?
      WHERE (lower(f.subject) IN ('english', '英语', 'vocabulary', '词汇') OR f.subject = '')
        AND (fr.next_review_date IS NULL OR fr.next_review_date <= ?)
      ORDER BY CASE WHEN fr.next_review_date IS NULL THEN 0 ELSE 1 END, f.created_at DESC
      LIMIT 100
    `).all(request.currentUser.id, today);
    response.json({ code: 0, data: { cards: rows.map((row) => ({
      id: row.id,
      word: row.front_content || row.title,
      meaning: row.back_content,
      mnemonic: row.word_root || row.affix || row.example_sentence || '',
      phonetic: row.phonetic || '',
      nextReviewDate: row.next_review_date || today
    })) }, message: '' });
  });

  app.post('/api/student/vocabulary/review', requireStudent, (request, response) => {
    const flashcardId = Number(request.body?.id);
    const quality = Number(request.body?.quality);
    if (!flashcardId || ![0, 1, 2, 3].includes(quality)) return response.status(400).json({ code: 400, message: '复习参数无效。' });
    const card = db.prepare('SELECT id FROM flashcards WHERE id = ?').get(flashcardId);
    if (!card) return response.status(404).json({ code: 404, message: '词汇卡不存在。' });
    const previous = db.prepare('SELECT * FROM flashcard_records WHERE flashcard_id = ? AND student_id = ?').get(flashcardId, request.currentUser.id);
    const initial = previous || getInitialReviewParams();
    const next = calculateNextReview(quality, Number(initial.ease_factor ?? initial.easeFactor), Number(initial.interval_days ?? initial.interval), Number(initial.repetitions));
    const now = dayjs().toISOString();
    db.prepare(`
      INSERT INTO flashcard_records
        (flashcard_id, student_id, quality, ease_factor, interval_days, repetitions, next_review_date, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(flashcard_id, student_id) DO UPDATE SET
        quality = excluded.quality, ease_factor = excluded.ease_factor, interval_days = excluded.interval_days,
        repetitions = excluded.repetitions, next_review_date = excluded.next_review_date, created_at = excluded.created_at
    `).run(flashcardId, request.currentUser.id, quality, next.easeFactor, next.interval, next.repetitions, next.nextReviewDate, now);
    response.json({ code: 0, data: { nextReviewDate: next.nextReviewDate }, message: '' });
  });

  app.post('/api/admin/study-plans', requireAdmin, (request, response) => {
    const studentId = Number(request.body?.studentId);
    if (!studentId) return response.status(400).json({ error: 'studentId 不能为空。' });
    const itemIds = replacePlanForDate(db, {
      studentId,
      planDate: request.body?.planDate || dayjs().format('YYYY-MM-DD'),
      sourceMode: request.body?.sourceMode || 'manual',
      items: request.body?.items || [],
      createdBy: request.currentUser?.id
    });
    response.json({ success: true, itemIds });
  });

  app.get('/api/admin/study-plans/:studentId/template', requireAdmin, (request, response) => {
    const studentId = Number(request.params.studentId);
    const student = db.prepare("SELECT id FROM users WHERE id = ? AND role = 'student'").get(studentId);
    if (!student) return response.status(404).json({ error: '学员用户不存在。' });
    const profile = db.prepare('SELECT target_school FROM student_profiles WHERE user_id = ?').get(studentId);
    const row = db.prepare('SELECT * FROM student_plan_templates WHERE student_id = ?').get(studentId);
    response.json({ template: serializePlanTemplate(row, profile?.target_school) });
  });

  app.put('/api/admin/study-plans/:studentId/template', requireAdmin, (request, response) => {
    const studentId = Number(request.params.studentId);
    const student = db.prepare("SELECT id FROM users WHERE id = ? AND role = 'student'").get(studentId);
    if (!student) return response.status(404).json({ error: '学员用户不存在。' });
    const body = request.body || {};
    const extraTasks = Array.isArray(body.extraTasks) ? body.extraTasks.slice(0, 20) : [];
    const now = dayjs().toISOString();
    db.prepare(`
      INSERT INTO student_plan_templates
        (student_id, target_school, english_target_score, politics_target_score, business1_target_score,
         business2_target_score, english_long_task, english_stage_task, math_task, politics_task,
         professional_task, extra_tasks_json, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(student_id) DO UPDATE SET
        target_school = excluded.target_school, english_target_score = excluded.english_target_score,
        politics_target_score = excluded.politics_target_score, business1_target_score = excluded.business1_target_score,
        business2_target_score = excluded.business2_target_score, english_long_task = excluded.english_long_task,
        english_stage_task = excluded.english_stage_task, math_task = excluded.math_task,
        politics_task = excluded.politics_task, professional_task = excluded.professional_task,
        extra_tasks_json = excluded.extra_tasks_json, created_by = excluded.created_by, updated_at = excluded.updated_at
    `).run(
      studentId, String(body.targetSchool || '').trim(), safeNumber(body.englishTargetScore), safeNumber(body.politicsTargetScore),
      safeNumber(body.business1TargetScore), safeNumber(body.business2TargetScore), String(body.englishLongTask || '').trim(),
      String(body.englishStageTask || '').trim(), String(body.mathTask || '').trim(), String(body.politicsTask || '').trim(),
      String(body.professionalTask || '').trim(), JSON.stringify(extraTasks), request.currentUser?.id || null, now, now
    );
    const row = db.prepare('SELECT * FROM student_plan_templates WHERE student_id = ?').get(studentId);
    response.json({ success: true, template: serializePlanTemplate(row) });
  });

  app.post('/api/admin/study-plans/:studentId/adjust-next-day', requireAdmin, (request, response) => {
    try {
      const result = adjustNextDayPlan(db, {
        studentId: Number(request.params.studentId),
        sourceMode: request.body?.sourceMode || 'semi_auto',
        baseItems: request.body?.items || [],
        createdBy: request.currentUser?.id,
        fromDate: request.body?.fromDate || dayjs().format('YYYY-MM-DD')
      });
      response.json({ success: true, ...result });
    } catch (error) {
      response.status(400).json({ error: error.message });
    }
  });
};

module.exports.serializeProfile = serializeProfile;
