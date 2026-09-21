import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { adminAccountPatchSchema, adminAccountSchema, answersEqual, assessmentSubmissionDecision, assistantStudentPatchSchema, canGradeEntranceSubmission, companionFinishReason, companionProgressScope, companionStudyDuration, companionStudyVisibility, courseScopeMatches, decisionForOrderClaim, decisionForOrderReview, gradeEntrancePaper, gradeObjectiveAssessment, isAllowedStateTransition, normalizeCourseScope, normalizeRegistrationSubjects, normalizeSubjectFamily, questionAnswerShapeIsValid, selfStudentPatchSchema, staffStudentPatchSchema, subjectsMatch, taskDayNumber, validateAppOrigin } from '../src/core.js';
import { storage } from '../src/storage.js';

const isDateUnlocked = (startDate, today) => !startDate || today >= startDate;

test('companion study applies configured speed modes and rejects invalid values', () => {
  assert.equal(companionStudyDuration(1800, '基础'), 3600);
  assert.equal(companionStudyDuration(1800, '适中'), 2700);
  assert.equal(companionStudyDuration(1800, '合适'), 1800);
  assert.throws(() => companionStudyDuration(59, '合适'));
  assert.throws(() => companionStudyDuration(1800, '未知'));
});

test('companion study unlocks staged content only at server timing thresholds', () => {
  const startedAt = '2026-08-18T00:00:00.000Z';
  const early = companionStudyVisibility({ startedAt, effectiveDurationSeconds:1800, now:Date.parse('2026-08-18T00:05:00.000Z') });
  assert.equal(early.showKnowledgePoint, false);
  assert.equal(early.showHalfHint, false);
  assert.equal(early.showAnswer, false);
  const halfway = companionStudyVisibility({ startedAt, effectiveDurationSeconds:1800, now:Date.parse('2026-08-18T00:15:00.000Z') });
  assert.equal(halfway.showKnowledgePoint, false);
  assert.equal(halfway.showHalfHint, true);
  assert.equal(halfway.showAnswer, false);
  const finalTenMinutes = companionStudyVisibility({ startedAt, effectiveDurationSeconds:1800, now:Date.parse('2026-08-18T00:20:00.000Z') });
  assert.equal(finalTenMinutes.showKnowledgePoint, true);
  assert.equal(finalTenMinutes.showHalfHint, true);
  assert.equal(finalTenMinutes.showAnswer, false);
  const completed = companionStudyVisibility({ startedAt, effectiveDurationSeconds:1800, now:Date.parse('2026-08-18T00:30:00.000Z') });
  assert.equal(completed.showAnswer, true);
  const earlyFinish = companionStudyVisibility({ startedAt, effectiveDurationSeconds:1800, finishedAt:'2026-08-18T00:01:00.000Z', now:Date.parse('2026-08-18T00:02:00.000Z') });
  assert.equal(earlyFinish.showKnowledgePoint, true);
  assert.equal(earlyFinish.showHalfHint, true);
  assert.equal(earlyFinish.showAnswer, true);
});

test('student plan calendar start date unlocks on the configured day and keeps empty dates compatible', () => {
  assert.equal(isDateUnlocked(null, '2026-08-14'), true);
  assert.equal(isDateUnlocked('2026-08-14', '2026-08-14'), true);
  assert.equal(isDateUnlocked('2026-08-15', '2026-08-14'), false);
  assert.equal(isDateUnlocked('2026-08-13', '2026-08-14'), true);
});

test('objective answers ignore case, whitespace, and multi-choice order', () => {
  assert.equal(answersEqual([' B ', 'a'], ['a', 'b']), true);
  assert.equal(answersEqual(' true ', 'TRUE'), true);
  assert.equal(answersEqual('A', 'B'), false);
});

test('entrance grading scores objectives and leaves subjective answers pending', () => {
  const result = gradeEntrancePaper([
    { itemIndex:0, questionSnapshot:{ subject:'英语', questionType:'single_choice', stem:'Q1', correctAnswer:'A', score:2 } },
    { itemIndex:1, questionSnapshot:{ subject:'英语', questionType:'short_answer', stem:'Q2', correctAnswer:'', score:8 } }
  ], { 0:' a ', 1:'answer' });
  assert.equal(result.score, 2);
  assert.equal(result.total, 10);
  assert.equal(result.gradingStatus, '部分待批改');
  assert.equal(result.wrongQuestions[0].gradingStatus, '待批改');
});

test('student patch permissions limit self-service fields', () => {
  assert.deepEqual(selfStudentPatchSchema.parse({ school:'测试学校', email:null }), { school:'测试学校', email:null });
  assert.throws(() => selfStudentPatchSchema.parse({ status:'付费' }));
  assert.deepEqual(staffStudentPatchSchema.parse({ status:'付费', paidUntil:null }), { status:'付费', paidUntil:null });
});

test('production origin requires a plain HTTPS origin', () => {
  assert.equal(validateAppOrigin({ origin:'https://app.example.com', nodeEnv:'production' }), 'https://app.example.com');
  assert.throws(() => validateAppOrigin({ origin:'http://app.example.com', nodeEnv:'production' }));
  assert.throws(() => validateAppOrigin({ origin:'https://app.example.com/path', nodeEnv:'production' }));
  assert.equal(validateAppOrigin({ origin:undefined, nodeEnv:'test' }), 'http://localhost:5173');
});

test('decisionForOrderClaim rejects missing or unpublished products', () => {
  assert.equal(decisionForOrderClaim({ product:null }).status, 422);
  assert.equal(decisionForOrderClaim({ product:{ state:'已下架' } }).status, 422);
});

test('decisionForOrderClaim returns paid order on second claim of free product', () => {
  const product = { pricing:'免费', state:'已上架', price:0 };
  const existing = { id:'order-1', status:'已支付' };
  const result = decisionForOrderClaim({ product, alreadyPaidOrder:existing });
  assert.equal(result.kind, 'already_paid');
  assert.equal(result.requiresManualReview, false);
  assert.equal(result.order.id, 'order-1');
});

test('decisionForOrderClaim creates paid order for free product and pending for paid product', () => {
  const freeProduct = { pricing:'免费', state:'已上架', price:0 };
  const freeResult = decisionForOrderClaim({ product:freeProduct });
  assert.equal(freeResult.kind, 'create');
  assert.equal(freeResult.orderStatus, '已支付');
  assert.equal(freeResult.status, undefined, '成功路径不得占用 status 字段（它是 HTTP 错误码语义）');
  assert.equal(freeResult.requiresManualReview, false);
  assert.equal(freeResult.isFree, true);

  const paidProduct = { pricing:'付费', state:'已上架', price:199 };
  const paidResult = decisionForOrderClaim({ product:paidProduct });
  assert.equal(paidResult.kind, 'create');
  assert.equal(paidResult.orderStatus, '待支付');
  assert.equal(paidResult.status, undefined);
  assert.equal(paidResult.requiresManualReview, true);
  assert.equal(paidResult.isFree, false);
});

test('decisionForOrderClaim reuses an existing pending order', () => {
  const product = { pricing:'付费', state:'已上架', price:199 };
  const result = decisionForOrderClaim({ product, pendingOrder:{ id:'order-2' } });
  assert.equal(result.kind, 'reuse_pending');
  assert.equal(result.orderId, 'order-2');
});

test('decisionForOrderReview flags already reviewed orders', () => {
  const order = { id:'order-1', status:'已支付' };
  const product = { id:'product-1', course_ids:[] };
  const result = decisionForOrderReview({ order, product, requestedStatus:'已支付' });
  assert.equal(result.kind, 'already_reviewed');
  assert.equal(result.alreadyReviewed, true);
});

test('decisionForOrderReview approves a pending order and grants entitlement', () => {
  const order = { id:'order-1', status:'待支付', product_id:'product-1', student_id:'student-1' };
  const product = { id:'product-1', course_ids:['course-1'] };
  const approved = decisionForOrderReview({ order, product, requestedStatus:'已支付' });
  assert.equal(approved.kind, 'review');
  assert.equal(approved.approved, true);

  const rejected = decisionForOrderReview({ order, product, requestedStatus:'已驳回' });
  assert.equal(rejected.kind, 'review');
  assert.equal(rejected.approved, false);
});

test('adminAccountSchema requires phone and limits role', () => {
  const ok = adminAccountSchema.parse({ role:'teacher', name:'张老师', phone:'13900000000' });
  assert.equal(ok.role, 'teacher');
  assert.throws(() => adminAccountSchema.parse({ role:'teacher', name:'x', phone:'123' }));
  assert.throws(() => adminAccountSchema.parse({ role:'student', name:'a', phone:'13900000000', password:'short' }));
});

test('adminAccountPatchSchema strips unknown keys and requires at least one field', () => {
  assert.throws(() => adminAccountPatchSchema.parse({}));
  assert.throws(() => adminAccountPatchSchema.parse({ unknown:'x' }));
  assert.deepEqual(adminAccountPatchSchema.parse({ status:'停用' }), { status:'停用' });
  assert.deepEqual(adminAccountPatchSchema.parse({ status:'停用', name:'张三' }), { status:'停用', name:'张三' });
});

test('admin account reset schema is mutually exclusive with an explicit password', () => {
  assert.deepEqual(adminAccountPatchSchema.parse({ resetPassword:true }), { resetPassword:true });
  assert.throws(() => adminAccountPatchSchema.parse({ resetPassword:true, password:'a'.repeat(12) }));
});

test('assistant student patch cannot change payment or learning-control fields', () => {
  assert.deepEqual(assistantStudentPatchSchema.parse({ school:'目标院校', email:null }), { school:'目标院校', email:null });
  assert.throws(() => assistantStudentPatchSchema.parse({ status:'付费' }));
  assert.throws(() => assistantStudentPatchSchema.parse({ paidUntil:'2026-08-14T00:00:00.000Z' }));
  assert.throws(() => assistantStudentPatchSchema.parse({ evaluation:'越权写入' }));
});

test('local storage signed URLs bind the object key and expire', async () => {
  const previousSecret = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = 'a'.repeat(32);
  try {
    const signed = await storage.getSignedUrl({ key:'materials/demo.pdf', expiresInSeconds:60 });
    const [, , , , token, encodedKey] = new URL(signed.url, 'http://localhost').pathname.split('/');
    assert.equal(storage.verifySignedUrl({ token, key:decodeURIComponent(encodedKey) }), true);
    assert.equal(storage.verifySignedUrl({ token, key:'materials/other.pdf' }), false);
  } finally {
    if (previousSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = previousSecret;
  }
});


test('course scope matches school, major, professional subject and year', () => {
  const student = { school:'A大学', major:'计算机科学', year:'2027' };
  assert.equal(courseScopeMatches(student, ['专业课一'], { school:'A大学', major:'计算机科学', professional:'专业课', year:'2027' }), true);
  assert.equal(courseScopeMatches(student, ['专业课一'], { school:'B大学' }), false);
  assert.equal(courseScopeMatches(student, ['英语一'], { professional:'数学' }), false);
  assert.deepEqual(normalizeCourseScope({ subject:'数学一' }), { school:'', major:'', professional:'数学一', year:'' });
});

test('course and product state machines reject skipping draft or reopening incorrectly', () => {
  assert.equal(isAllowedStateTransition('course', '草稿', '已发布'), true);
  assert.equal(isAllowedStateTransition('course', '草稿', '已下架'), false);
  assert.equal(isAllowedStateTransition('product', '已上架', '已下架'), true);
  assert.equal(isAllowedStateTransition('order', '已支付', '已驳回'), false);
});

test('entrance grading exposes objective score separately from pending subjective review', () => {
  const result = gradeEntrancePaper([
    { itemIndex:0, questionSnapshot:{ subject:'政治', questionType:'single_choice', stem:'Q1', correctAnswer:'A', score:3 } },
    { itemIndex:1, questionSnapshot:{ subject:'政治', questionType:'short_answer', stem:'Q2', correctAnswer:'', score:7 } }
  ], { 0:'A', 1:'答卷' });
  assert.equal(result.objectiveScore, 3);
  assert.equal(result.score, 3);
  assert.equal(result.reviewStatus, 'pending_review');
});

test('student plan patch uses real optimistic-concurrency placeholders', async () => {
  const index = await fs.readFile(new URL('../src/index.js', import.meta.url), 'utf8');
  assert.match(index, /WHERE id=\$10 AND student_id=\$11 AND revision=\$12 RETURNING \*/);
  assert.doesNotMatch(index, /WHERE id=\$9 AND student_id=\$10 AND revision=\$11 RETURNING \*/);
});

test('registration import keeps selected subjects as un-enrolled intentions', async () => {
  assert.deepEqual(normalizeRegistrationSubjects([' 数学一 ', '数学一', '', null, '英语一']), ['数学一', '英语一']);
  const source = await fs.readFile(new URL('../src/index.js', import.meta.url), 'utf8');
  assert.match(source, /INSERT INTO student_subjects\(student_id,subject,enrolled\) VALUES\(\$1,\$2,false\)/);
});

test('ordinary self-test rejects client supplied scores and reports pending review', () => {
  assert.deepEqual(assessmentSubmissionDecision({ score:90, total:100 }), { status:422, code:'CLIENT_SCORE_FORBIDDEN', message:'普通自测成绩必须由服务端题目快照计算' });
  const pending = assessmentSubmissionDecision({ answers:{'0':'A'} });
  assert.equal(pending.status, 202);
  assert.equal(pending.reviewStatus, 'pending_review');
});

test('objective assessment only scores complete published snapshots', () => {
  const items = [{ itemIndex:0, questionSnapshot:{ subject:'数学', questionType:'single_choice', stem:'1+1=?', options:[{key:'A',text:'2'},{key:'B',text:'3'}], correctAnswer:'A', score:2, state:'已发布' } }];
  assert.equal(gradeObjectiveAssessment(items, { 0:'A' }).objectiveScore, 2);
  assert.throws(() => gradeObjectiveAssessment([{ itemIndex:0, questionSnapshot:{ ...items[0].questionSnapshot, options:[{key:'A',text:'[object Object]'},{key:'B',text:'3'}] } }], { 0:'A' }));
  assert.throws(() => gradeObjectiveAssessment(items, { 1:'A' }));
});

test('teacher-only subjective grading permission and companion progress scope', () => {
  assert.equal(canGradeEntranceSubmission('teacher'), true);
  assert.equal(canGradeEntranceSubmission('student'), false);
  assert.deepEqual(companionProgressScope({ studentId:'s', courseId:'c', bookId:'b', questionId:'q' }), { studentId:'s', courseId:'c', resourceType:'companion_study', resourceId:'b', itemId:'q' });
});

test('companion finish records timeout or early-end reason', () => {
  const startedAt = '2026-08-18T00:00:00.000Z';
  assert.deepEqual(companionFinishReason({ startedAt, effectiveDurationSeconds:60, now:Date.parse('2026-08-18T00:00:30.000Z') }), { elapsedSeconds:30, reason:'提前结束' });
  assert.deepEqual(companionFinishReason({ startedAt, effectiveDurationSeconds:60, now:Date.parse('2026-08-18T00:02:00.000Z') }), { elapsedSeconds:60, reason:'到时结束' });
});

test('math seed repair migration rebuilds keyed options and snapshots', async () => {
  const migration = await fs.readFile(new URL('../db/migrations/026_repair_integrity_and_math_seed.sql', import.meta.url), 'utf8');
  assert.match(migration, /CREATE TABLE IF NOT EXISTS assessment_question_sets/);
  assert.match(migration, /ALTER TABLE companion_study_books[\s\S]*ADD COLUMN IF NOT EXISTS course_id/);
  assert.match(migration, /UPDATE entrance_paper_items i[\s\S]*question_snapshot=jsonb_build_object/);
  assert.doesNotMatch(migration, /text\": \"\[object Object\]\"/);
  assert.match(migration, /\(49, \$json\$/);
});

test('password change rotates session and invalidates old version', async () => {
  const source = await fs.readFile(new URL('../src/index.js', import.meta.url), 'utf8');
  assert.match(source, /session_version=session_version\+1 WHERE id=\$2 RETURNING/);
  assert.match(source, /jwt\.sign\(session, JWT_SECRET/);
  assert.match(source, /sessionVersion: Number\(updated\.session_version/);
  assert.match(source, /const updatedSessionVersion = Number\(updated\.session_version/);
  assert.match(source, /sessionVersion, authVersion: updatedSessionVersion/);
  assert.match(source, /status: updated\.status, studentId: updated\.student_id/);
});

test('teacher grading endpoint persists objective and subjective review fields', async () => {
  const source = await fs.readFile(new URL('../src/index.js', import.meta.url), 'utf8');
  assert.match(source, /app\.patch\('\/api\/admin\/exams\/submissions\/:id\/grade'/);
  assert.match(source, /objective_score=\$1,subjective_score=\$2/);
  assert.match(source, /批改人必须是当前登录教师/);
});

test('companion completion writes real scoped progress and events', async () => {
  const source = await fs.readFile(new URL('../src/index.js', import.meta.url), 'utf8');
  assert.match(source, /INSERT INTO student_learning_progress\(student_id,course_id,resource_type,resource_id,item_id,total_count\)/);
  assert.match(source, /companion_session_finished/);
  assert.match(source, /bookId:row\.book_id, questionId:row\.question_id/);
});


test('English and Math numbered subjects match family-authored content without cross-variant leakage', () => {
  assert.equal(normalizeSubjectFamily('英语一'), '英语');
  assert.equal(normalizeSubjectFamily('数学三'), '数学');
  assert.equal(subjectsMatch('英语一', '英语'), true);
  assert.equal(subjectsMatch('英语二', '英语'), true);
  assert.equal(subjectsMatch('数学三', '数学'), true);
  assert.equal(subjectsMatch('英语一', '英语二'), false);
  assert.equal(courseScopeMatches({}, ['英语三'], { professional:'英语' }), true);
  assert.equal(courseScopeMatches({}, ['数学二'], { professional:'数学' }), true);
});

test('question answer shapes are strict by question type', () => {
  assert.equal(questionAnswerShapeIsValid({ questionType:'multiple_choice', correctAnswer:['A','C'] }), true);
  assert.equal(questionAnswerShapeIsValid({ questionType:'multiple_choice', correctAnswer:'A' }), false);
  assert.equal(questionAnswerShapeIsValid({ questionType:'multiple_choice', correctAnswer:['A','A'] }), false);
  assert.equal(questionAnswerShapeIsValid({ questionType:'single_choice', correctAnswer:'A' }), true);
  assert.equal(questionAnswerShapeIsValid({ questionType:'single_choice', correctAnswer:['A'] }), false);
  assert.equal(questionAnswerShapeIsValid({ questionType:'true_false', correctAnswer:'A' }), true);
  assert.equal(questionAnswerShapeIsValid({ questionType:'short_answer', correctAnswer:'' }), true);
});

test('task day uses startDay rather than zero-based row index', () => {
  assert.equal(taskDayNumber(1, 0), 1);
  assert.equal(taskDayNumber(7, 2), 9);
  assert.throws(() => taskDayNumber(0, 0));
  assert.throws(() => taskDayNumber(1, -1));
});

test('backend exposes public health, revoke, revision, task-detail and learning-event contracts', async () => {
  const source = await fs.readFile(new URL('../src/index.js', import.meta.url), 'utf8');
  assert.match(source, /app\.get\('\/health', async request/);
  assert.match(source, /app\.get\('\/ready', async request/);
  assert.doesNotMatch(source, /app\.get\('\/health', \{ preHandler:/);
  assert.doesNotMatch(source, /app\.get\('\/ready', \{ preHandler:/);
  assert.match(source, /app\.get\('\/metrics', \{ preHandler: requireRoles\(\['admin'\]\)/);
  assert.match(source, /app\.post\('\/api\/admin\/exams\/distributions\/:id\/revoke'/);
  assert.match(source, /requireRoles\(\['admin','teacher'\]\)/);
  assert.match(source, /status='已撤销'/);
  assert.match(source, /INSERT INTO learning_events[\s\S]*exam_distribution_revoked/);
  assert.match(source, /UPDATE student_plans SET start_date=\$1,revision=revision\+1/);
  assert.match(source, /const studentPlanStartDateSchema = .*revision:z\.number\(\)/);
  assert.match(source, /const task = planTaskDetail\(plan, rowIndex, taskIndex\)/);
  assert.match(source, /app\.get\('\/api\/plans\/:id\/tasks\/:rowIndex\/\:taskIndex\/details'/);
  assert.match(source, /payload->>'planId'/);
});

test('migration 027 preserves nullable review scores and adds answer/cycle integrity', async () => {
  const migration = await fs.readFile(new URL('../db/migrations/027_runtime_integrity.sql', import.meta.url), 'utf8');
  assert.match(migration, /ALTER TABLE assessment_records[\s\S]*ALTER COLUMN score DROP NOT NULL/);
  assert.match(migration, /question_type = 'multiple_choice'[\s\S]*jsonb_typeof\(answer\) = 'array'/);
  assert.match(migration, /question_answer_shape_valid\(question_type, correct_answer\)/);
  assert.match(migration, /assessment_question_answer_shapes_valid/);
  assert.match(migration, /entrance_paper_items_correct_answer_shape_check/);
  assert.match(migration, /student_plan_predecessor_cycle_trigger/);
  assert.match(migration, /pg_advisory_xact_lock/);
  assert.doesNotMatch(migration, /migrations\/020|020_seed/);
});

test('ordinary self-test persists answers and null scores until a formal snapshot is available', async () => {
  const source = await fs.readFile(new URL('../src/index.js', import.meta.url), 'utf8');
  assert.match(source, /INSERT INTO assessment_records\(student_id,course_id,question_set_id,assessment_type,subject,title,score,total,objective_score,subjective_score,answers/);
  assert.match(source, /grading \? grading\.score : null, grading \? grading\.total : null, grading \? grading\.objectiveScore : null, null, json\(body\.answers\)/);
  assert.match(source, /reviewStatus = 'pending_review'/);
  assert.match(source, /gradeObjectiveAssessment\(questionSet\.questions, body\.answers\)/);
});
