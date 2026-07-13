const { getAgent, createUser, createTeacher, createStudent, loginAs, db } = require('./helper');
const config = require('../src/config');
const { canAccessContent, getUserEntitlement, requireEntitlement } = require('../src/services/entitlements');
const { handleMessage } = require('../src/services/bots/freeTutorBot');

describe('免费访问模式', () => {
  test('默认启用免费模式并使权益检查直接放行', () => {
    expect(config.freeAccessMode).toBe(true);
    expect(canAccessContent(999999, { visibility: 'all_paid' })).toBe(true);

    const next = jest.fn();
    const request = { currentUser: { id: 999999 } };
    requireEntitlement({ tier: 'paid', subject: '考研数学' })(request, {}, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(request.userEntitlement).toMatchObject({ tier: 'free', effectiveTier: 'free' });
  });

  test('免费模式只移除收费门槛，不绕过登录鉴权', () => {
    const next = jest.fn();
    const response = { status: jest.fn().mockReturnThis(), json: jest.fn() };

    requireEntitlement({ tier: 'paid' })({}, response, next);

    expect(next).not.toHaveBeenCalled();
    expect(response.status).toHaveBeenCalledWith(401);
  });

  test('历史付费课程对免费学生开放列表和详情，并序列化为免费', async () => {
    const agent = getAgent();
    const teacher = createTeacher({ username: 'teacher_free_course' });
    const student = createStudent({ username: 'student_free_course' });

    const result = db.prepare(
      'INSERT INTO courses (title, description, subject, visibility, subject_scope, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run('历史付费课程', '', '考研英语', 'subject_paid', '考研英语', teacher.id, new Date().toISOString());

    await loginAs(agent, student.username);
    const list = await agent.get('/api/courses').expect(200);
    const course = list.body.courses.find((item) => item.id === result.lastInsertRowid);
    expect(course).toMatchObject({ visibility: 'free', subjectScope: '' });

    const detail = await agent.get(`/api/courses/${result.lastInsertRowid}`).expect(200);
    expect(detail.body).toMatchObject({ id: result.lastInsertRowid, visibility: 'free', subjectScope: '' });
  });

  test('历史付费题目对免费学生可见且可作答', async () => {
    const agent = getAgent();
    const teacher = createTeacher({ username: 'teacher_free_question' });
    const student = createStudent({ username: 'student_free_question' });
    const options = JSON.stringify([
      { key: 'A', text: '正确' },
      { key: 'B', text: '错误' }
    ]);
    const result = db.prepare(`
      INSERT INTO questions (
        title, subject, stem, options, correct_answer, is_paid_only, subject_scope, created_by, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('历史付费题', '考研数学', '请选择正确答案', options, 'A', 1, '考研数学', teacher.id, new Date().toISOString());

    await loginAs(agent, student.username);
    const list = await agent.get(`/api/questions?ids=${result.lastInsertRowid}`).expect(200);
    expect(list.body.questions).toHaveLength(1);
    expect(list.body.questions[0]).toMatchObject({ isPaidOnly: 0, subjectScope: '' });

    const answer = await agent
      .post(`/api/questions/${result.lastInsertRowid}/answer`)
      .send({ selectedAnswer: 'A' })
      .expect(200);
    expect(answer.body.result.isCorrect).toBe(true);
  });

  test('新建课程、直播和题目时忽略付费属性', async () => {
    const agent = getAgent();
    const teacher = createTeacher({ username: 'teacher_free_writes' });
    await loginAs(agent, teacher.username);

    const course = await agent
      .post('/api/courses')
      .field('title', '免费课程')
      .field('visibility', 'all_paid')
      .field('subjectScope', '考研英语')
      .expect(200);
    expect(db.prepare('SELECT visibility, subject_scope FROM courses WHERE id = ?').get(course.body.id))
      .toEqual({ visibility: 'free', subject_scope: '' });

    const live = await agent
      .post('/api/live-sessions')
      .send({ title: '免费直播', visibility: 'trial_paid' })
      .expect(200);
    expect(db.prepare('SELECT visibility FROM live_sessions WHERE id = ?').get(live.body.id))
      .toEqual({ visibility: 'free' });

    const question = await agent
      .post('/api/questions')
      .field('title', '免费题目')
      .field('stem', '题干')
      .field('optionA', '选项 A')
      .field('optionB', '选项 B')
      .field('correctAnswer', 'A')
      .field('isPaidOnly', '1')
      .field('subjectScope', '考研英语')
      .expect(200);
    expect(db.prepare('SELECT is_paid_only, subject_scope FROM questions WHERE id = ?').get(question.body.id))
      .toEqual({ is_paid_only: 0, subject_scope: '' });
  });

  test('免费模式忽略付费属性更新并保留历史元数据', async () => {
    const agent = getAgent();
    const teacher = createTeacher({ username: 'teacher_free_updates' });
    const now = new Date().toISOString();
    const course = db.prepare(
      'INSERT INTO courses (title, description, subject, visibility, subject_scope, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run('待更新课程', '', '考研英语', 'all_paid', '考研英语', teacher.id, now);
    const question = db.prepare(`
      INSERT INTO questions (title, subject, stem, options, correct_answer, is_paid_only, subject_scope, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('待更新题目', '考研英语', '题干', JSON.stringify([{ key: 'A', text: 'A' }, { key: 'B', text: 'B' }]), 'A', 1, '考研英语', teacher.id, now);

    await loginAs(agent, teacher.username);
    await agent.put(`/api/admin/content/courses/${course.lastInsertRowid}`)
      .send({ subject: '考研英语（更新）', visibility: 'free' })
      .expect(200);
    await agent.put(`/api/admin/questions/${question.lastInsertRowid}`)
      .send({ title: '已更新题目', isPaidOnly: false, subjectScope: '' })
      .expect(200);

    expect(db.prepare('SELECT visibility, subject_scope FROM courses WHERE id = ?').get(course.lastInsertRowid))
      .toEqual({ visibility: 'all_paid', subject_scope: '考研英语' });
    expect(db.prepare('SELECT is_paid_only, subject_scope FROM questions WHERE id = ?').get(question.lastInsertRowid))
      .toEqual({ is_paid_only: 1, subject_scope: '考研英语' });

    const courseResponse = await agent.get(`/api/courses/${course.lastInsertRowid}`).expect(200);
    expect(courseResponse.body).toMatchObject({ visibility: 'free', subjectScope: '' });
    const questionResponse = await agent.get(`/api/admin/questions/${question.lastInsertRowid}`).expect(200);
    expect(questionResponse.body.question).toMatchObject({ isPaidOnly: 0, subjectScope: '' });
  });

  test('免费模式拒绝配置或结算用户权益', async () => {
    const agent = getAgent();
    const admin = createUser({
      username: 'admin_free_entitlements',
      password: '123456',
      role: 'admin',
      displayName: '测试管理员'
    });
    const student = createStudent({ username: 'student_free_entitlements' });
    await loginAs(agent, admin.username);

    await agent.post(`/api/admin/entitlements/${student.id}`).send({ tier: 'paid' }).expect(410);
    await agent.post('/api/entitlements/check-expired').send({}).expect(410);
  });

  test('权益接口在免费模式下只表现为 free', () => {
    const student = createStudent({ username: 'student_hidden_entitlement' });
    db.prepare(`
      INSERT INTO user_entitlements (student_id, tier, package_type, unlocked_subjects, created_at, updated_at)
      VALUES (?, 'paid', 'all_subjects', '[]', ?, ?)
    `).run(student.id, new Date().toISOString(), new Date().toISOString());

    expect(getUserEntitlement(student.id)).toMatchObject({
      tier: 'free',
      effectiveTier: 'free',
      packageType: 'none',
      unlockedSubjects: []
    });
  });

  test('免费答疑不会把考试报名问题误判为课程交易咨询', async () => {
    const student = createStudent({ username: 'student_free_tutor_faq' });
    const result = await handleMessage({ userId: student.id, message: '考研报名时间是什么时候？', source: 'test' });

    expect(result.action).toBe('faq');
    expect(result.reply).toContain('预报名');
  });

  test('明确咨询课程价格时只引导免费资源', async () => {
    const student = createStudent({ username: 'student_free_tutor_course_price' });
    const result = await handleMessage({ userId: student.id, message: '你们的课程价格是多少？', source: 'test' });

    expect(result.action).toBe('free_resources');
    expect(result.reply).toContain('免费开放');
    expect(result.handoff).toBe(false);
  });
});
