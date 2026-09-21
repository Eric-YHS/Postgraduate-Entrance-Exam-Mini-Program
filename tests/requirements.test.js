const path = require('path');
const XLSX = require('xlsx');
const dayjs = require('dayjs');
const {
  db,
  getAgent,
  createUser,
  createStudent,
  loginAs
} = require('./helper');

let sequence = 0;
function unique(prefix) {
  sequence += 1;
  return `${prefix}_${Date.now()}_${sequence}`;
}

function makeAdmin() {
  return createUser({ username: unique('requirements_admin'), password: 'admin123', role: 'admin', displayName: '需求验收管理员' });
}

describe('技术要求核心业务闭环', () => {
  test('管理员生成登记邀请，公开页面读取并提交完整档案，非法用户被拒绝', async () => {
    const admin = makeAdmin();
    const student = createStudent({ username: unique('profile_student') });
    const teacher = createUser({ username: unique('profile_teacher'), password: '123456', role: 'teacher', displayName: '教师' });
    const agent = getAgent();
    await loginAs(agent, admin.username, 'admin123');

    await agent.post('/api/admin/student-profiles/invites').send({ userId: 99999999 }).expect(404);
    await agent.post('/api/admin/student-profiles/invites').send({ userId: teacher.id }).expect(404);
    const invite = await agent.post('/api/admin/student-profiles/invites').send({ userId: student.id }).expect(200);
    expect(invite.body.url).toContain('/student-profile.html?token=');
    const token = invite.body.profile.inviteToken;

    const initial = await getAgent().get(`/api/public/student-profiles/${token}`).expect(200);
    expect(initial.body.profile.userId).toBe(Number(student.id));
    const submitted = await getAgent().put(`/api/public/student-profiles/${token}`).send({
      name: '张同学', gender: '女', gaokaoEnglishScore: 118, cet4Score: 510,
      upgradeEnglishScore: 126, vocabularyLevel: '约 5500', previousReview: '完成一轮词汇',
      weakestEnglishSection: '阅读', gaokaoMathScore: 120, upgradeMathScore: 132,
      englishPaper: '英语一', mathPaper: '数学一', shippingName: '张同学',
      shippingPhone: '13800138000', shippingAddress: '湖北省荆州市测试地址',
      requirements: '强化阅读', targetSchool: '长江大学', targetMajor: '计算机',
      currentStage: '强化', headTeacherName: '王老师', email: 'student@example.com'
    }).expect(200);
    expect(submitted.body.profile).toEqual(expect.objectContaining({
      name: '张同学', targetSchool: '长江大学', currentStage: '强化', email: 'student@example.com'
    }));
    expect(submitted.body.profile.submittedAt).toBeTruthy();
  });

  test('人工计划、晚间反馈、半自动/全自动次日调整和七日小程序接口形成闭环', async () => {
    const admin = makeAdmin();
    const student = createStudent({ username: unique('plan_student') });
    const other = createStudent({ username: unique('other_student') });
    const adminAgent = getAgent();
    await loginAs(adminAgent, admin.username, 'admin123');
    const invite = await adminAgent.post('/api/admin/student-profiles/invites').send({ userId: student.id }).expect(200);
    await getAgent().put(`/api/public/student-profiles/${invite.body.profile.inviteToken}`).send({
      name: '计划学员', targetSchool: '长江大学', currentStage: '基础', weakestEnglishSection: '阅读'
    }).expect(200);
    const template = await adminAgent.put(`/api/admin/study-plans/${student.id}/template`).send({
      targetSchool: '长江大学', englishTargetScore: 65, politicsTargetScore: 65,
      business1TargetScore: 90, business2TargetScore: 120,
      englishLongTask: '单词书list1', englishStageTask: '语法day1',
      mathTask: '数学基础day1', politicsTask: '肖1000（57-87题看完并对答案）',
      professionalTask: '大模型', extraTasks: ['预留额外任务']
    }).expect(200);
    expect(template.body.template).toEqual(expect.objectContaining({
      targetSchool: '长江大学', englishTargetScore: 65, business2TargetScore: 120,
      professionalTask: '大模型'
    }));
    const templateRead = await adminAgent.get(`/api/admin/study-plans/${student.id}/template`).expect(200);
    expect(templateRead.body.template.extraTasks).toEqual(['预留额外任务']);

    const today = dayjs().format('YYYY-MM-DD');
    const created = await adminAgent.post('/api/admin/study-plans').send({
      studentId: student.id,
      planDate: today,
      sourceMode: 'manual',
      items: [
        { subject: '英语', title: '单词书 list1', description: '完成并复盘' },
        { subject: '数学', title: '数学基础 day1', description: '例题与习题' }
      ]
    }).expect(200);
    expect(created.body.itemIds).toHaveLength(2);

    const studentAgent = getAgent();
    await loginAs(studentAgent, student.username);
    const otherAgent = getAgent();
    await loginAs(otherAgent, other.username);
    await otherAgent.patch(`/api/student/plans/${created.body.itemIds[0]}`).send({ status: 'completed' }).expect(404);
    const feedback = await studentAgent.patch(`/api/student/plans/${created.body.itemIds[0]}`).send({
      status: 'completed', feedback: '已完成，阅读错 2 题'
    }).expect(200);
    expect(feedback.body.data.item.status).toBe('completed');

    const semi = await adminAgent.post(`/api/admin/study-plans/${student.id}/adjust-next-day`).send({
      sourceMode: 'semi_auto', fromDate: today,
      items: [{ subject: '政治', title: '肖1000 第57-87题' }]
    }).expect(200);
    expect(semi.body.items.map((item) => item.title)).toEqual(expect.arrayContaining(['补做：数学基础 day1', '肖1000 第57-87题']));

    const full = await adminAgent.post(`/api/admin/study-plans/${student.id}/adjust-next-day`).send({
      sourceMode: 'full_auto', fromDate: semi.body.planDate
    }).expect(200);
    expect(full.body.itemIds.length).toBeGreaterThan(0);
    expect(full.body.items[0].title).toMatch(/回炉|阶段/);
    expect(full.body.items.map((item) => item.title)).toEqual(expect.arrayContaining(['单词书list1', '语法day1', '大模型']));

    const sevenDays = await studentAgent.get(`/api/student/plans?startDate=${today}&days=7`).expect(200);
    expect(sevenDays.body.code).toBe(0);
    expect(sevenDays.body.data.days).toHaveLength(7);
    expect(sevenDays.body.data.days[0].items).toEqual(expect.arrayContaining([expect.objectContaining({ title: '单词书 list1' })]));
  });

  test('表4原始 XLS 可导入词汇，学生复习记录按同一卡片 UPSERT', async () => {
    const admin = makeAdmin();
    const student = createStudent({ username: unique('vocab_student') });
    const adminAgent = getAgent();
    await loginAs(adminAgent, admin.username, 'admin123');
    const workbookPath = path.join(__dirname, '..', '技术要求', '技术要求', '表4.xls');
    const imported = await adminAgent.post('/api/flashcards/import').attach('file', workbookPath).expect(200);
    expect(imported.body.imported).toBeGreaterThanOrEqual(1);

    const studentAgent = getAgent();
    await loginAs(studentAgent, student.username);
    const cards = await studentAgent.get('/api/student/vocabulary').expect(200);
    const difficult = cards.body.data.cards.find((card) => card.word === 'difficult');
    expect(difficult).toEqual(expect.objectContaining({ meaning: '困难的' }));
    expect(difficult.mnemonic).toContain('弟弟');
    await studentAgent.post('/api/student/vocabulary/review').send({ id: difficult.id, quality: 2 }).expect(200);
    await studentAgent.post('/api/student/vocabulary/review').send({ id: difficult.id, quality: 3 }).expect(200);
    const count = db.prepare('SELECT COUNT(*) AS count FROM flashcard_records WHERE flashcard_id = ? AND student_id = ?').get(difficult.id, student.id);
    expect(count.count).toBe(1);
  });

  test('合成的完整表5可导入政治题，小程序列表和详情契约完整', async () => {
    const admin = makeAdmin();
    const student = createStudent({ username: unique('question_student') });
    const adminAgent = getAgent();
    await loginAs(adminAgent, admin.username, 'admin123');
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet([{
      题目: '马克思主义最鲜明的政治立场是？',
      选项A: '致力于实现最广大人民的根本利益', 选项B: '解释世界',
      选项C: '追求抽象真理', 选项D: '维护少数人利益', 答案: 'A', 助记: '人民立场'
    }]), 'Sheet1');
    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
    const imported = await adminAgent.post('/api/questions/import').attach('file', buffer, 'table5-complete.xlsx').expect(200);
    expect(imported.body).toEqual(expect.objectContaining({ imported: 1, skipped: 0 }));

    const studentAgent = getAgent();
    await loginAs(studentAgent, student.username);
    const list = await studentAgent.get('/api/questions?subject=politics&page=1&pageSize=10').expect(200);
    expect(list.body.code).toBe(0);
    const question = list.body.data.list.find((item) => item.stem.includes('马克思主义'));
    expect(question).toEqual(expect.objectContaining({ subject: '政治', subjectCode: 'politics', correctOption: 'A', explanation: '人民立场' }));
    expect(question.options[0]).toEqual(expect.objectContaining({ key: 'A', label: 'A' }));
    const detail = await studentAgent.get(`/api/questions/detail?id=${question.id}`).expect(200);
    expect(detail.body.data.correctAnswer).toBe('A');
  });
});
