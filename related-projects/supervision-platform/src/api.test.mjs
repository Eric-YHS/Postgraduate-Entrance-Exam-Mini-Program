import test from 'node:test';
import assert from 'node:assert/strict';
import {
  answersMatch,
  buildAssessmentSubmissionPayload,
  getAssessmentSubmissionState,
  buildStudentPlanPayload,
  buildStudentProfilePatch,
  COMPANION_STUDY_RESOURCE_TYPE,
  getSessionAuthVersion,
  normalizeMultipleChoiceAnswer,
  normalizeSubjectCategory,
} from './api.js';

test('商品创建约定之外的学生资料字段不会泄漏到自助 PATCH', () => {
  const patch = buildStudentProfilePatch({
    name: ' 学员 ', year: '', email: '', shippingInfo: '地址', school: '院校', targetScore: '380',
    status: '付费', stage: '冲刺', evaluation: '教师备注', paidUntil: '2027-01-01T00:00:00.000Z',
  }, 'student');
  assert.deepEqual(patch, {
    name: '学员', year: undefined, email: null, shippingInfo: '地址', school: '院校', targetScore: '380',
  });
});

test('教师资料 PATCH 保留允许的档案字段且不需要 account PATCH', () => {
  const patch = buildStudentProfilePatch({ name: '林同学', year: '2027 考研', status: '付费', stage: '基础', evaluation: '跟进' }, 'teacher');
  assert.equal(patch.name, '林同学');
  assert.equal(patch.status, '付费');
  assert.equal(patch.stage, '基础');
  assert.equal(patch.evaluation, '跟进');
  assert.equal(Object.hasOwn(patch, 'password'), false);
});

test('多选答案始终保留为去重排序数组并严格比较', () => {
  assert.deepEqual(normalizeMultipleChoiceAnswer(['C', 'A', 'C']), ['A', 'C']);
  assert.deepEqual(normalizeMultipleChoiceAnswer('C, A'), ['A', 'C']);
  assert.equal(answersMatch(['C', 'A'], ['A', 'C'], true), true);
  assert.equal(answersMatch(['A'], ['A', 'C'], true), false);
});

test('会话版本优先使用服务端返回值，不凭客户端递增', () => {
  assert.equal(getSessionAuthVersion({ sessionVersion: 9 }, 1), 9);
  assert.equal(getSessionAuthVersion({ authVersion: 4 }, 1), 4);
  assert.equal(getSessionAuthVersion({ account: { sessionVersion: 6 } }, 1), 6);
  assert.equal(getSessionAuthVersion({}, 3), 3);
});

test('API 课程资料 PATCH 只包含学生可编辑档案字段', () => {
  const patch = buildStudentProfilePatch({ name: '学生', year: '2027 考研', school: '目标院校', targetScore: '400', stage: '冲刺', evaluation: '内部备注' }, 'student');
  assert.deepEqual(Object.keys(patch).sort(), ['email', 'name', 'school', 'shippingInfo', 'targetScore', 'year']);
  assert.equal(Object.hasOwn(patch, 'stage'), false);
  assert.equal(Object.hasOwn(patch, 'evaluation'), false);
});

test('周期自测提交 payload 不携带客户端成绩，缺少正式题目集时保持 pending 所需的空题集引用', () => {
  const pending = buildAssessmentSubmissionPayload({ assessmentType: 'weekly', subject: '英语一', title: '周测', answers: { '0': ['C', 'A'] }, questionSetId: null, courseId: null });
  assert.deepEqual(pending, { assessmentType: 'weekly', subject: '英语一', title: '周测', answers: { '0': ['C', 'A'] }, wrongQuestions: [] });
  assert.equal(Object.hasOwn(pending, 'score'), false);
  assert.equal(Object.hasOwn(pending, 'total'), false);
  const formal = buildAssessmentSubmissionPayload({ assessmentType: 'daily', subject: '数学一', title: '日测', answers: {}, questionSetId: '123e4567-e89b-12d3-a456-426614174000' });
  assert.equal(formal.questionSetId, '123e4567-e89b-12d3-a456-426614174000');
  assert.equal(getAssessmentSubmissionState({}), 'pending_review');
  assert.equal(getAssessmentSubmissionState({ questionSetId: formal.questionSetId }), 'ready');
});

test('代学进度统一使用 companion_study 资源', () => {
  assert.equal(COMPANION_STUDY_RESOURCE_TYPE, 'companion_study');
});

test('英语一和数学一归一化到兼容的学科分类', () => {
  assert.equal(normalizeSubjectCategory('英语一'), '英语');
  assert.equal(normalizeSubjectCategory('数学一'), '数学');
  assert.equal(normalizeSubjectCategory('计算机专业课'), '专业课');
});

test('计划 payload 保留 UUID、courseId、predecessorPlanId、revision 和 startDay', () => {
  const payload = buildStudentPlanPayload({
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    courseId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    subject: '英语一', name: '阅读计划', taskType: '阶段', startDay: 12,
    predecessorPlanId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', lane: 2,
    revision: 7, rows: [{ day: '第十二天', tasks: ['阅读 1 篇'] }],
  }, { includeRevision: true });
  assert.equal(payload.courseId, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
  assert.equal(payload.predecessorPlanId, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc');
  assert.equal(payload.startDay, 12);
  assert.equal(payload.revision, 7);
  assert.equal(typeof payload.predecessorPlanId, 'string');
  assert.equal(payload.rows[0].title, '第十二天');
});
