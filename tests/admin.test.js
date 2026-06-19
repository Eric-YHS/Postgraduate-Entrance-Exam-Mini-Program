const { getAgent, createTeacher, createStudent, createUser, loginAs } = require('./helper');

describe('后台管理', () => {
  test('管理员可访问系统设置', async () => {
    const agent = getAgent();
    const admin = createUser({ username: 'admin_settings', password: 'admin123', role: 'admin', displayName: '管理员' });
    await loginAs(agent, admin.username, 'admin123');

    const res = await agent.get('/api/admin/settings').expect(200);
    expect(res.body.settings.trial_days).toBeDefined();
  });

  test('客服无法访问系统设置', async () => {
    const agent = getAgent();
    const cs = createUser({ username: 'cs_settings', password: '123456', role: 'customer_service', displayName: '客服' });
    await loginAs(agent, cs.username);

    await agent.get('/api/admin/settings').expect(403);
  });

  test('客服可查看学员列表但角色被强制为学生', async () => {
    const agent = getAgent();
    const cs = createUser({ username: 'cs_students', password: '123456', role: 'customer_service', displayName: '客服' });
    createStudent({ username: 'student_for_cs' });
    createTeacher({ username: 'teacher_for_cs' });

    await loginAs(agent, cs.username);
    const res = await agent.get('/api/admin/users').expect(200);
    expect(res.body.users.every((u) => u.role === 'student')).toBe(true);
  });

  test('管理员可创建客服账号并更新角色', async () => {
    const agent = getAgent();
    const admin = createUser({ username: 'admin_create_cs', password: 'admin123', role: 'admin', displayName: '管理员' });
    const user = createStudent({ username: 'promote_to_cs' });

    await loginAs(agent, admin.username, 'admin123');
    await agent.put(`/api/admin/users/${user.id}`).send({ role: 'customer_service' }).expect(200);

    const updated = await agent.get('/api/admin/users?role=customer_service').expect(200);
    expect(updated.body.users.some((u) => u.id === user.id)).toBe(true);
  });

  test('客服不能删除用户', async () => {
    const agent = getAgent();
    const cs = createUser({ username: 'cs_delete', password: '123456', role: 'customer_service', displayName: '客服' });
    const student = createStudent({ username: 'student_to_delete' });

    await loginAs(agent, cs.username);
    await agent.delete(`/api/admin/users/${student.id}`).expect(403);
  });
});
