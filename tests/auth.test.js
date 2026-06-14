const { getAgent, createStudent, createTeacher, loginAs } = require('./helper');

describe('认证接口', () => {
  test('POST /api/auth/login 使用正确凭据可登录', async () => {
    const agent = getAgent();
    const teacher = createTeacher({ username: 'teacher_auth_test' });

    const res = await agent
      .post('/api/auth/login')
      .set('Origin', 'http://localhost:3000')
      .send({ username: teacher.username, password: '123456' })
      .expect(200);

    expect(res.body.token).toBeTruthy();
    expect(res.body.user).toMatchObject({ role: 'teacher', username: teacher.username });
  });

  test('POST /api/auth/login 密码错误返回 401', async () => {
    const agent = getAgent();
    const student = createStudent({ username: 'student_auth_fail' });

    const res = await agent
      .post('/api/auth/login')
      .set('Origin', 'http://localhost:3000')
      .send({ username: student.username, password: 'wrong-password' })
      .expect(401);

    expect(res.body.error).toBeTruthy();
  });

  test('登录后访问受保护接口可获取数据', async () => {
    const agent = getAgent();
    const student = createStudent({ username: 'student_protected' });
    await loginAs(agent, student.username);

    const res = await agent
      .get('/api/student/bootstrap')
      .expect(200);

    expect(res.body).toHaveProperty('user');
    expect(res.body.user).toMatchObject({ username: student.username });
  });

  test('未登录访问受保护接口返回 401', async () => {
    const agent = getAgent();
    await agent
      .get('/api/student/bootstrap')
      .expect(401);
  });

  test('Token 可登出并失效', async () => {
    const agent = getAgent();
    const student = createStudent({ username: 'student_logout' });
    const loginRes = await loginAs(agent, student.username);

    await agent
      .post('/api/auth/logout')
      .set('Authorization', `Bearer ${loginRes.token}`)
      .expect(200);

    // 登出后原 Token 不应再有效
    await agent
      .get('/api/student/bootstrap')
      .set('Authorization', `Bearer ${loginRes.token}`)
      .expect(401);
  });
});
