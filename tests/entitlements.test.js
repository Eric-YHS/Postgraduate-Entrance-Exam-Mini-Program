const { getAgent, createTeacher, createStudent, createProduct, loginAs, db } = require('./helper');

describe('权益体系', () => {
  function setEntitlement(studentId, payload) {
    db.prepare(`
      INSERT INTO user_entitlements (
        student_id, tier, trial_started_at, trial_ended_at, paid_started_at, paid_until, unlocked_subjects, package_type, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(student_id) DO UPDATE SET
        tier = excluded.tier,
        trial_started_at = excluded.trial_started_at,
        trial_ended_at = excluded.trial_ended_at,
        paid_started_at = excluded.paid_started_at,
        paid_until = excluded.paid_until,
        unlocked_subjects = excluded.unlocked_subjects,
        package_type = excluded.package_type,
        updated_at = excluded.updated_at
    `).run(
      studentId,
      payload.tier,
      payload.trialStartedAt || null,
      payload.trialEndedAt || null,
      payload.paidStartedAt || null,
      payload.paidUntil || null,
      JSON.stringify(payload.unlockedSubjects || []),
      payload.packageType || 'none',
      new Date().toISOString(),
      new Date().toISOString()
    );
  }

  test('免费用户访问付费课程被拦截', async () => {
    const agent = getAgent();
    const teacher = createTeacher({ username: 'teacher_ent_1' });
    const student = createStudent({ username: 'student_ent_free' });

    db.prepare('INSERT INTO courses (title, description, subject, visibility, subject_scope, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('付费课', '', '考研英语', 'subject_paid', '考研英语', teacher.id, new Date().toISOString());

    await loginAs(agent, student.username);
    const res = await agent.get('/api/courses');
    expect(res.body.courses.some((c) => c.title === '付费课')).toBe(false);
  });

  test('体验用户在有效期内可访问付费内容', async () => {
    const agent = getAgent();
    const teacher = createTeacher({ username: 'teacher_ent_2' });
    const student = createStudent({ username: 'student_ent_trial' });

    setEntitlement(student.id, {
      tier: 'trial',
      trialStartedAt: new Date().toISOString(),
      trialEndedAt: new Date(Date.now() + 86400000).toISOString()
    });

    db.prepare('INSERT INTO courses (title, description, subject, visibility, subject_scope, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('付费课', '', '考研英语', 'trial_paid', '', teacher.id, new Date().toISOString());

    await loginAs(agent, student.username);
    const res = await agent.get('/api/courses');
    expect(res.body.courses.length).toBe(1);
  });

  test('体验用户到期后访问付费内容被拦截', async () => {
    const agent = getAgent();
    const teacher = createTeacher({ username: 'teacher_ent_3' });
    const student = createStudent({ username: 'student_ent_expired' });

    setEntitlement(student.id, {
      tier: 'trial',
      trialStartedAt: new Date(Date.now() - 86400000 * 8).toISOString(),
      trialEndedAt: new Date(Date.now() - 86400000).toISOString()
    });

    db.prepare('INSERT INTO courses (title, description, subject, visibility, subject_scope, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('付费课', '', '考研英语', 'trial_paid', '', teacher.id, new Date().toISOString());

    await loginAs(agent, student.username);
    const res = await agent.get('/api/courses');
    expect(res.body.courses.length).toBe(0);
  });

  test('单科付费用户只能访问已解锁科目', async () => {
    const agent = getAgent();
    const teacher = createTeacher({ username: 'teacher_ent_4' });
    const student = createStudent({ username: 'student_ent_single' });

    setEntitlement(student.id, {
      tier: 'paid',
      packageType: 'single_subject',
      unlockedSubjects: ['考研英语']
    });

    db.prepare('INSERT INTO courses (title, description, subject, visibility, subject_scope, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('英语课', '', '考研英语', 'subject_paid', '考研英语', teacher.id, new Date().toISOString());
    db.prepare('INSERT INTO courses (title, description, subject, visibility, subject_scope, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('数学课', '', '考研数学', 'subject_paid', '考研数学', teacher.id, new Date().toISOString());

    await loginAs(agent, student.username);
    const res = await agent.get('/api/courses');
    const paidTitles = [...new Set(res.body.courses.filter((c) => ['英语课', '数学课'].includes(c.title)).map((c) => c.title))];
    expect(paidTitles).toEqual(['英语课']);
  });

  test('全科付费用户可访问全部付费内容', async () => {
    const agent = getAgent();
    const teacher = createTeacher({ username: 'teacher_ent_5' });
    const student = createStudent({ username: 'student_ent_all' });

    setEntitlement(student.id, {
      tier: 'paid',
      packageType: 'all_subjects'
    });

    db.prepare('INSERT INTO courses (title, description, subject, visibility, subject_scope, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('英语课', '', '考研英语', 'all_paid', '', teacher.id, new Date().toISOString());
    db.prepare('INSERT INTO courses (title, description, subject, visibility, subject_scope, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('数学课', '', '考研数学', 'all_paid', '', teacher.id, new Date().toISOString());

    await loginAs(agent, student.username);
    const res = await agent.get('/api/courses');
    const paidTitles = [...new Set(res.body.courses.filter((c) => ['英语课', '数学课'].includes(c.title)).map((c) => c.title))];
    expect(paidTitles.length).toBe(2);
  });

  test('支付成功后自动开通权益', async () => {
    const agent = getAgent();
    const teacher = createTeacher({ username: 'teacher_ent_6' });
    const student = createStudent({ username: 'student_ent_pay' });
    const product = createProduct({ createdBy: teacher.id, title: '全科包', price: 199, stock: 10 });
    db.prepare('UPDATE products SET package_type = ?, status = ? WHERE id = ?').run('all_subjects', 'active', product.id);

    await loginAs(agent, student.username);
    const orderRes = await agent.post('/api/orders').send({ productId: product.id, quantity: 1, shippingAddress: '测试' }).expect(200);
    await agent.post(`/api/orders/${orderRes.body.id}/pay`).send({}).expect(200);

    const entitlementRes = await agent.get('/api/entitlements/me').expect(200);
    expect(entitlementRes.body.entitlement.tier).toBe('paid');
    expect(entitlementRes.body.entitlement.packageType).toBe('all_subjects');
  });
});
