const { getAgent, createUser, loginAs, db } = require('./helper');

function createAdmin(prefix) {
  return createUser({
    username: `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`,
    password: 'admin123',
    role: 'admin',
    displayName: '企微管理员',
  });
}

function insertGroup(overrides = {}) {
  const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const result = db.prepare(`
    INSERT INTO wecom_groups
      (chat_id, archive_roomid, name, owner, reply_enabled, reply_all_text,
       reply_delay_seconds, binding_token, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    overrides.chatId || `chat_${suffix}`,
    overrides.archiveRoomId || `room_${suffix}`,
    overrides.name || '后台测试群',
    overrides.owner || 'owner_test',
    overrides.replyEnabled ?? 1,
    overrides.replyAllText ?? 1,
    overrides.replyDelaySeconds ?? 5,
    overrides.bindingToken || `token_${suffix}`,
    new Date().toISOString()
  );
  return Number(result.lastInsertRowid);
}

function insertBot(overrides = {}) {
  const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const result = db.prepare(`
    INSERT INTO bots (code, name, type, config, is_active, created_at)
    VALUES (?, ?, ?, ?, 1, ?)
  `).run(
    overrides.code || `custom_${suffix}`,
    overrides.name || '自定义老师',
    overrides.type || 'tutor',
    JSON.stringify(overrides.config || { description: '保留这段配置' }),
    new Date().toISOString()
  );
  return Number(result.lastInsertRowid);
}

describe('企业微信可视化管理接口', () => {
  test('管理员可以设置全量回复、五秒等待和默认机器人', async () => {
    const agent = getAgent();
    const admin = createAdmin('wecom_group_admin');
    const groupId = insertGroup({ replyAllText: 0, replyDelaySeconds: 15 });
    const botId = insertBot();
    await loginAs(agent, admin.username, 'admin123');

    const update = await agent.put(`/api/admin/wecom/groups/${groupId}`).send({
      replyEnabled: true,
      replyAllText: true,
      replyDelaySeconds: 5,
      botIds: [botId],
      defaultBotId: botId,
    }).expect(200);

    expect(update.body.group).toMatchObject({
      id: groupId,
      replyEnabled: true,
      replyAllText: true,
      replyDelaySeconds: 5,
    });
    expect(update.body.group.bots).toEqual([
      expect.objectContaining({ id: botId, isDefault: true }),
    ]);
  });

  test('切换机器人状态不会清空名称、类型和角色配置', async () => {
    const agent = getAgent();
    const admin = createAdmin('bot_partial_admin');
    const botId = insertBot({
      name: '择校顾问测试',
      type: 'advisor',
      config: { description: '熟悉院校', systemPrompt: '回答择校问题' },
    });
    await loginAs(agent, admin.username, 'admin123');

    await agent.put(`/api/admin/bots/${botId}`).send({ isActive: 0 }).expect(200);
    const row = db.prepare('SELECT name, type, config, is_active FROM bots WHERE id = ?').get(botId);

    expect(row.name).toBe('择校顾问测试');
    expect(row.type).toBe('advisor');
    expect(JSON.parse(row.config)).toMatchObject({
      description: '熟悉院校',
      systemPrompt: '回答择校问题',
    });
    expect(row.is_active).toBe(0);
  });

  test('建群请求缺少成员时在调用企业微信前直接拒绝', async () => {
    const agent = getAgent();
    const admin = createAdmin('wecom_create_validation');
    await loginAs(agent, admin.username, 'admin123');

    const response = await agent.post('/api/admin/wecom/groups').send({
      name: '无成员群',
      owner: 'owner_test',
      memberUserIds: [],
    }).expect(400);

    expect(response.body.error).toContain('至少选择一位群成员');
  });

  test('非管理员不能读取企业微信群配置', async () => {
    const agent = getAgent();
    const user = createUser({
      username: `wecom_student_${Date.now()}`,
      password: '123456',
      role: 'student',
      displayName: '普通学员',
    });
    await loginAs(agent, user.username);
    await agent.get('/api/admin/wecom/groups').expect(403);
  });
});
