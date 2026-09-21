import { z } from 'zod';

export const studentDto = student => ({
  id: student.id,
  accountId: student.account_id,
  name: student.name,
  year: student.year,
  status: student.status,
  phone: student.phone,
  email: student.email,
  wechatId: student.wechat_id || '',
  shippingRecipient: student.shipping_recipient || '',
  shippingPhone: student.shipping_phone || '',
  shippingInfo: student.shipping_info,
  school: student.school,
  major: student.major || '',
  targetScore: student.target_score,
  stage: student.stage,
  evaluation: student.evaluation,
  paidUntil: student.paid_until,
  accountStatus: student.account_status || null,
  createdAt: student.created_at,
  updatedAt: student.updated_at
});

const nonEmptyPatch = schema => schema.refine(value => Object.keys(value).length > 0, '至少提供一个可更新字段');
const shortText = (max, message) => z.string().trim().max(max, message);

export const staffStudentPatchSchema = nonEmptyPatch(z.object({
  name: z.string().trim().min(1).max(60).optional(),
  year: z.string().trim().min(1).max(30).optional(),
  status: z.enum(['免费', '新人', '体验', '付费']).optional(),
  email: z.string().trim().email('邮箱格式不正确').max(254).nullable().optional(),
  wechatId: shortText(120).nullable().optional(),
  shippingRecipient: shortText(120).nullable().optional(),
  shippingPhone: shortText(40).nullable().optional(),
  shippingInfo: shortText(2000).nullable().optional(),
  school: shortText(160).nullable().optional(),
  major: shortText(160).nullable().optional(),
  targetScore: shortText(60).nullable().optional(),
  stage: shortText(80).optional(),
  evaluation: shortText(5000).nullable().optional(),
  paidUntil: z.string().datetime('付费截止时间必须为 ISO 8601 时间').nullable().optional()
}).strict());

export const selfStudentPatchSchema = nonEmptyPatch(z.object({
  name: z.string().trim().min(1).max(60).optional(),
  year: z.string().trim().min(1).max(30).optional(),
  email: z.string().trim().email('邮箱格式不正确').max(254).nullable().optional(),
  wechatId: shortText(120).nullable().optional(),
  shippingRecipient: shortText(120).nullable().optional(),
  shippingPhone: shortText(40).nullable().optional(),
  shippingInfo: shortText(2000).nullable().optional(),
  school: shortText(160).nullable().optional(),
  major: shortText(160).nullable().optional(),
  targetScore: shortText(60).nullable().optional()
}).strict());

export const validateAppOrigin = ({ origin, nodeEnv }) => {
  if (!origin) {
    if (nodeEnv === 'production') throw new Error('APP_ORIGIN is required in production');
    return 'http://localhost:5173';
  }
  let parsed;
  try { parsed = new URL(origin); } catch { throw new Error('APP_ORIGIN must be an absolute URL'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error('APP_ORIGIN must be a plain http(s) origin without credentials, path, query, or hash');
  }
  if (nodeEnv === 'production' && parsed.protocol !== 'https:') throw new Error('APP_ORIGIN must use HTTPS in production');
  return parsed.origin;
};

export const normalizeAnswer = value => Array.isArray(value)
  ? value.map(item => String(item).trim().toLowerCase()).filter(Boolean).sort()
  : String(value ?? '').trim().toLowerCase();

export const answersEqual = (actual, expected) => JSON.stringify(normalizeAnswer(actual)) === JSON.stringify(normalizeAnswer(expected));

export const companionStudyDuration = (baseSeconds, speedMode) => {
  const multipliers = { 基础: 2, 适中: 1.5, 合适: 1 };
  const seconds = Number(baseSeconds);
  if (!Number.isInteger(seconds) || seconds < 60 || seconds > 86400) {
    throw new Error('题目计时必须为 60 到 86400 秒');
  }
  if (!Object.hasOwn(multipliers, speedMode)) {
    throw new Error('无效的做题风格');
  }
  return Math.round(seconds * multipliers[speedMode]);
};

export const companionStudyVisibility = ({ startedAt, effectiveDurationSeconds, finishedAt, now = Date.now() }) => {
  const startedAtMs = new Date(startedAt).getTime();
  const durationSeconds = Number(effectiveDurationSeconds);
  if (!Number.isFinite(startedAtMs) || !Number.isInteger(durationSeconds) || durationSeconds < 60) {
    throw new Error('学习会话计时数据无效');
  }
  const elapsedSeconds = Math.max(0, Math.floor((now - startedAtMs) / 1000));
  const expired = Boolean(finishedAt) || elapsedSeconds >= durationSeconds;
  return {
    elapsedSeconds: Math.min(elapsedSeconds, durationSeconds),
    remainingSeconds: expired ? 0 : Math.max(0, durationSeconds - elapsedSeconds),
    showKnowledgePoint: expired || Math.max(0, durationSeconds - elapsedSeconds) <= 600,
    showHalfHint: expired || elapsedSeconds >= Math.ceil(durationSeconds / 2),
    showAnswer: expired
  };
};

export const normalizeCourseScope = scope => {
  const value = scope && typeof scope === 'object' && !Array.isArray(scope) ? scope : {};
  return {
    school: String(value.school || '').trim(),
    major: String(value.major || '').trim(),
    professional: String(value.professional || value.subject || '').trim(),
    year: String(value.year || '').trim()
  };
};

// Numbered English/Math subjects share the family course scope (英语一 -> 英语).
// Other subjects remain exact matches unless both values are identical.
export const normalizeSubjectFamily = value => {
  const subject = String(value || '').trim();
  return subject.replace(/(英语|数学)[一二三]$/, '$1');
};

export const subjectsMatch = (left, right) => {
  const a = String(left || '').trim();
  const b = String(right || '').trim();
  if (!a || !b || a === b) return Boolean(a && b);
  const familyA = normalizeSubjectFamily(a);
  const familyB = normalizeSubjectFamily(b);
  const numberedA = familyA !== a;
  const numberedB = familyB !== b;
  // A numbered English/Math enrollment can use family-authored content. The
  // direction is intentional: a family enrollment must not unlock a numbered
  // variant, and English I must not accidentally match English II.
  if (familyA === familyB && numberedA && !numberedB) return true;
  // Keep legacy professional-subject prefix compatibility (专业课一 -> 专业课)
  // without broadening numbered English/Math matching.
  return !numberedA && !numberedB && (a.startsWith(b) || b.startsWith(a));
};

export const courseScopeMatches = (student, enrolledSubjects = [], scope) => {
  const expected = normalizeCourseScope(scope);
  const actualSubjects = (Array.isArray(enrolledSubjects) ? enrolledSubjects : [])
    .map(item => String(item || '').trim()).filter(Boolean);
  const subjectMatches = !expected.professional || actualSubjects.some(item => subjectsMatch(item, expected.professional));
  return (!expected.school || String(student?.school || '').trim() === expected.school)
    && (!expected.major || String(student?.major || '').trim() === expected.major)
    && (!expected.year || String(student?.year || '').trim() === expected.year)
    && subjectMatches;
};

export const questionAnswerShapeIsValid = ({ questionType, correctAnswer } = {}) => {
  const type = String(questionType || '').trim();
  if (type === 'multiple_choice') {
    return Array.isArray(correctAnswer)
      && correctAnswer.length > 0
      && correctAnswer.every(answer => typeof answer === 'string' && answer.trim())
      && new Set(correctAnswer.map(answer => answer.trim())).size === correctAnswer.length;
  }
  if (['single_choice', 'true_false'].includes(type)) {
    return typeof correctAnswer === 'string' && Boolean(correctAnswer.trim());
  }
  // Subjective answers are scalar strings too, but may intentionally be empty:
  // an empty reference answer means the teacher must review it manually.
  if (['fill_blank', 'short_answer'].includes(type)) {
    return typeof correctAnswer === 'string'
      || (Array.isArray(correctAnswer)
        && correctAnswer.length > 0
        && correctAnswer.every(answer => typeof answer === 'string' && answer.trim()));
  }
  return false;
};

export const taskDayNumber = (startDay, rowIndex) => {
  const start = Number(startDay);
  const row = Number(rowIndex);
  if (!Number.isInteger(start) || start < 1 || !Number.isInteger(row) || row < 0) throw new Error('任务日期索引无效');
  return start + row;
};

const stateTransitions = {
  course: { 草稿: new Set(['草稿', '已发布']), 已发布: new Set(['已发布', '已下架']), 已下架: new Set(['已下架', '已发布']) },
  product: { 草稿: new Set(['草稿', '已上架']), 已上架: new Set(['已上架', '已下架']), 已下架: new Set(['已下架', '已上架']) },
  order: { 待支付: new Set(['待支付', '已支付', '已驳回']), 已支付: new Set(['已支付']), 已驳回: new Set(['已驳回']) }
};
export const isAllowedStateTransition = (entity, current, next) => Boolean(stateTransitions[entity]?.[current]?.has(next));

export const decisionForOrderClaim = ({
  product,
  alreadyPaidOrder,
  pendingOrder
}) => {
  if (!product) return { status: 422, message: '商品不存在或未上架' };
  if (product.state !== '已上架') return { status: 422, message: '商品不存在或未上架' };
  const price = Number(product.price);
  if (!Number.isFinite(price) || price < 0 || (product.pricing === '付费' && price <= 0) || (product.pricing === '免费' && price !== 0)) {
    return { status: 422, message: '商品价格配置无效' };
  }
  if (alreadyPaidOrder) return { kind: 'already_paid', order: alreadyPaidOrder, requiresManualReview: false };
  // 成功路径的订单状态必须叫 orderStatus：status 字段只承载数字 HTTP 错误码，
  // 否则「已支付」会被当成 statusCode 抛出，免费领取直接 500。
  if (pendingOrder) return { kind: 'reuse_pending', orderId: pendingOrder.id, orderStatus: '待支付' };
  const isFree = product.pricing === '免费';
  return { kind: 'create', orderStatus: isFree ? '已支付' : '待支付', requiresManualReview: !isFree, isFree };
};

export const decisionForOrderReview = ({ order, product, requestedStatus }) => {
  if (!order) return { status: 404, message: '订单不存在' };
  if (!product) return { status: 422, message: '订单商品不存在' };
  if (order.status !== '待支付') return { kind: 'already_reviewed', order, alreadyReviewed: true };
  const approved = requestedStatus === '已支付';
  return { kind: 'review', order, product, approved, requestedStatus };
};

const accountRoles = ['admin','teacher','assistant','operator','student'];
export const adminAccountSchema = z.object({
  role: z.enum(accountRoles),
  name: z.string().trim().min(1).max(60),
  phone: z.string().regex(/^1\d{10}$/, '手机号须为 1 开头的 11 位数字'),
  password: z.string().min(12).max(128).optional(),
  mustChangePassword: z.boolean().optional()
});

export const adminAccountPatchSchema = z.object({
  status: z.enum(['启用','停用']).optional(),
  password: z.string().min(12).max(128).optional(),
  resetPassword: z.boolean().optional(),
  mustChangePassword: z.boolean().optional(),
  name: z.string().trim().min(1).max(60).optional()
}).strict().refine(value => Object.keys(value).length > 0, '至少提供一个可更新字段').refine(
  value => !(value.password && value.resetPassword),
  '不能同时提交新密码和随机重置密码'
);

export const assistantStudentPatchSchema = nonEmptyPatch(z.object({
  name: z.string().trim().min(1).max(60).optional(),
  email: z.string().trim().email('邮箱格式不正确').max(254).nullable().optional(),
  shippingInfo: shortText(2000).nullable().optional(),
  school: shortText(160).nullable().optional(),
  major: shortText(160).nullable().optional(),
  targetScore: shortText(60).nullable().optional()
}).strict());

export const accountSummary = (account, student = null) => ({
  id: account.id,
  role: account.role,
  name: account.name,
  phone: account.phone,
  status: account.status,
  studentId: account.student_id,
  mustChangePassword: account.must_change_password,
  student: student ? studentDto(student) : null,
  createdAt: account.created_at,
  lastLoginAt: account.last_login_at
});

export const gradeEntrancePaper = (items, answers) => {
  let score = 0;
  let objectiveScore = 0;
  let total = 0;
  const subjectScores = {};
  const subjectTotals = {};
  const wrongQuestions = [];
  for (const item of items) {
    const question = item.questionSnapshot;
    if (!questionAnswerShapeIsValid({ questionType:question.questionType, correctAnswer:question.correctAnswer })) {
      throw new Error('题型与正确答案形状不匹配');
    }
    const points = Number(question.score || 0);
    total += points;
    subjectTotals[question.subject] = (subjectTotals[question.subject] || 0) + points;
    const actual = answers[String(item.itemIndex)];
    const objective = ['single_choice', 'multiple_choice', 'true_false', 'fill_blank'].includes(question.questionType);
    const correct = objective && actual !== undefined && answersEqual(actual, question.correctAnswer);
    if (correct) {
      score += points;
      objectiveScore += points;
      subjectScores[question.subject] = (subjectScores[question.subject] || 0) + points;
    } else {
      wrongQuestions.push({ number: item.itemIndex + 1, subject: question.subject, stem: question.stem, knowledgePoint: question.knowledgePoint || '', analysis: question.analysis || '', answer: actual ?? null, correctAnswer: question.correctAnswer, gradingStatus: objective ? '客观题已判错' : '待批改' });
    }
  }
  const hasPendingReview = wrongQuestions.some(item => item.gradingStatus === '待批改');
  return { score, objectiveScore, total, subjectScores, subjectTotals, wrongQuestions, gradingStatus: hasPendingReview ? '部分待批改' : '已批改', reviewStatus: hasPendingReview ? 'pending_review' : 'graded' };
};

export const gradeObjectiveAssessment = (items, answers) => {
  const normalizedItems = (Array.isArray(items) ? items : []).map((item, index) => {
    const questionSnapshot = item.questionSnapshot || item;
    return {
      itemIndex: Number.isInteger(Number(item.itemIndex)) ? Number(item.itemIndex) : index,
      questionSnapshot: { ...questionSnapshot }
    };
  });
  if (!normalizedItems.length) throw new Error('正式题库没有可用题目');
  const itemIndexes = new Set();
  const invalid = normalizedItems.find(item => {
    const question = item.questionSnapshot || {};
    const points = Number(question.score);
    const type = String(question.questionType || '').trim();
    const objective = ['single_choice', 'multiple_choice', 'true_false', 'fill_blank'].includes(type);
    const options = Array.isArray(question.options) ? question.options : [];
    const optionKeys = new Set(options.map(option => typeof option === 'object' ? String(option?.key || '').trim() : ''));
    const answerKeys = Array.isArray(question.correctAnswer) ? question.correctAnswer : [question.correctAnswer];
    const answerShapeValid = questionAnswerShapeIsValid({ questionType:type, correctAnswer:question.correctAnswer });
    const optionsValid = !['single_choice', 'multiple_choice', 'true_false'].includes(type)
      || options.length >= 2
        && options.every(option => option && typeof option === 'object' && String(option.key || '').trim() && String(option.text || '').trim() && String(option.text) !== '[object Object]')
        && answerKeys.every(answer => optionKeys.has(String(answer).trim()));
    const indexValid = !itemIndexes.has(item.itemIndex);
    itemIndexes.add(item.itemIndex);
    return !indexValid
      || !String(question.subject || '').trim()
      || !['single_choice', 'multiple_choice', 'true_false', 'fill_blank', 'short_answer'].includes(type)
      || !String(question.stem || '').trim()
      || !Number.isFinite(points) || points <= 0
      || question.correctAnswer === undefined || question.correctAnswer === null
      || !answerShapeValid
      || (question.state && question.state !== '已发布')
      || !optionsValid
      || (!objective && options.length > 0);
  });
  if (invalid) throw new Error('正式题库题目快照不完整、未发布或选项无效，暂不能评分');
  const safeAnswers = answers && typeof answers === 'object' && !Array.isArray(answers) ? answers : {};
  const validAnswerIndexes = new Set(normalizedItems.map(item => String(item.itemIndex)));
  if (Object.keys(safeAnswers).some(key => !validAnswerIndexes.has(String(key)))) {
    throw new Error('作答包含不属于该题目快照的题号');
  }
  return gradeEntrancePaper(normalizedItems, safeAnswers);
};

export const assessmentSubmissionDecision = payload => {
  const value = payload && typeof payload === 'object' ? payload : {};
  if (Object.hasOwn(value, 'score') || Object.hasOwn(value, 'total')) {
    return { status: 422, code: 'CLIENT_SCORE_FORBIDDEN', message: '普通自测成绩必须由服务端题目快照计算' };
  }
  return { status: 202, code: 'PENDING_REVIEW', reviewStatus: value.questionSetId ? 'pending_review' : 'pending_review' };
};

export const canGradeEntranceSubmission = role => ['admin', 'teacher'].includes(String(role));

export const companionProgressScope = ({ studentId, courseId = null, bookId, questionId }) => ({
  studentId: String(studentId), courseId: courseId ? String(courseId) : null,
  resourceType: 'companion_study', resourceId: String(bookId), itemId: String(questionId)
});

export const normalizeRegistrationSubjects = subjects => {
  let values = subjects;
  if (typeof values === 'string') {
    try { values = JSON.parse(values); } catch { values = []; }
  }
  return [...new Set((Array.isArray(values) ? values : [])
    .map(item => String(item || '').trim()).filter(Boolean))];
};

export const companionFinishReason = ({ startedAt, effectiveDurationSeconds, now = Date.now() }) => {
  const elapsed = Math.max(0, Math.floor((new Date(now).getTime() - new Date(startedAt).getTime()) / 1000));
  return { elapsedSeconds: Math.min(elapsed, Number(effectiveDurationSeconds)), reason: elapsed >= Number(effectiveDurationSeconds) ? '到时结束' : '提前结束' };
};

export const PLAN_TEMPLATE_SUBJECTS = ['政治', '英语', '数学', '专业课'];
export const planTemplateSubjectSchema = z.enum(PLAN_TEMPLATE_SUBJECTS);
// 模板行：day 为教师端显示的天序号（如「第一天」），tasks 与任务列一一对应，note 为补充说明。
// 非 strict：教师端草稿行会携带 attachments 等本地字段，落库时剥掉。
export const planTemplateRowSchema = z.object({
  day: z.string().trim().max(160).default(''),
  tasks: z.array(z.string().trim().max(1000)).max(30).default([]),
  note: z.string().trim().max(2000).default('')
});
export const planTemplatePayloadSchema = z.object({
  subject: planTemplateSubjectSchema,
  name: z.string().trim().min(1).max(160),
  category: z.string().trim().min(1).max(80),
  columns: z.array(z.string().trim().min(1).max(80)).max(30).default([]),
  rows: z.array(planTemplateRowSchema).max(1000).default([])
}).strict();
// 更新模板不改科目；科目错了应当删除后重建，避免已分配学员的副本口径错乱。
export const planTemplateUpdateSchema = planTemplatePayloadSchema.omit({ subject: true });

// tasks jsonb 落库形状为 { tasks: [...], note }；兼容早期直接存字符串数组的行。
export const planTemplateRowDto = row => {
  const payload = row?.tasks;
  const tasks = Array.isArray(payload) ? payload : (Array.isArray(payload?.tasks) ? payload.tasks : []);
  const note = payload && !Array.isArray(payload) && typeof payload.note === 'string' ? payload.note : '';
  return { day: String(row?.title || ''), tasks: tasks.map(task => String(task ?? '')), note };
};
export const planTemplateRowRecord = (row, rowIndex) => ({
  rowIndex,
  title: String(row?.day || '').trim().slice(0, 160),
  tasks: {
    tasks: (Array.isArray(row?.tasks) ? row.tasks : []).map(task => String(task ?? '').trim().slice(0, 1000)),
    note: String(row?.note || '').trim().slice(0, 2000)
  }
});
export const planTemplateRowDtos = rows => (Array.isArray(rows) ? rows : []).map((row, index) => {
  const record = planTemplateRowRecord(row, index);
  return { title: record.title, tasks: record.tasks };
});
export const planTemplateDto = (template, rows = []) => ({
  id: template.id,
  subject: template.subject,
  name: template.name,
  category: template.category || '',
  columns: Array.isArray(template.columns) ? template.columns.map(column => String(column ?? '')) : [],
  rows: rows.map(planTemplateRowDto),
  state: template.state,
  createdAt: template.created_at,
  updatedAt: template.updated_at
});
