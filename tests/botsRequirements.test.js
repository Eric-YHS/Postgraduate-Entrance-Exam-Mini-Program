const {
  db,
  getAgent,
  createUser,
  createStudent,
  loginAs
} = require('./helper');
const { completeBotConfig } = require('./requirementsFixtures');
const { prepareConfiguredReply, finalizeConfiguredReply } = require('../src/services/configuredBotRuntime');

let sequence = 0;
function unique(prefix) {
  sequence += 1;
  return `${prefix}_${Date.now()}_${sequence}`;
}

describe('机器人管理手册上线与运营要求', () => {
  test('不完整草稿禁止上线；完整草稿可上线、灰度、手动推送、暂停并保留审计', async () => {
    const admin = createUser({ username: unique('bot_admin'), password: 'admin123', role: 'admin', displayName: '机器人管理员' });
    const student = createStudent({ username: unique('bot_push_student') });
    const agent = getAgent();
    await loginAs(agent, admin.username, 'admin123');

    const incomplete = await agent.post('/api/admin/bots').send({
      code: unique('draftbot').toLowerCase(), name: '不完整机器人', type: 'advisor', config: {}
    }).expect(200);
    const rejected = await agent.post(`/api/admin/bots/${incomplete.body.id}/activate`).expect(422);
    expect(rejected.body.checklist.some((item) => !item.ok)).toBe(true);

    const config = completeBotConfig();
    const created = await agent.post('/api/admin/bots').send({
      code: unique('completebot').toLowerCase(), name: '小研', type: 'advisor', config
    }).expect(200);
    expect(created.body.robotUid).toMatch(/^R-\d{2,}$/);
    expect(created.body.checklist.valid).toBe(true);
    await agent.post(`/api/admin/bots/${created.body.id}/activate`).expect(200);

    const release = await agent.post(`/api/admin/bots/${created.body.id}/releases`).send({ rolloutPercent: 50 }).expect(200);
    expect(release.body.rolloutPercent).toBe(50);
    const persisted = JSON.parse(db.prepare('SELECT config FROM bots WHERE id = ?').get(created.body.id).config);
    expect(persisted.rolloutPercent).toBe(50);

    // 手动验收必须确定命中该学员，发布比例恢复到 100%。
    await agent.post(`/api/admin/bots/${created.body.id}/releases`).send({ rolloutPercent: 100 }).expect(200);
    // 必须显式给定时点：不传 at 的话按「现在」判定，晚上 21 点之后或早上 9 点之前
    // 跑测试会得到 quiet_hours，同一个提交换个时间跑就红一次。
    const at = `${new Date().getFullYear()}-06-15T10:00:00`;
    const push = await agent.post(`/api/admin/bots/${created.body.id}/schedules/JOB-MANUAL/trigger`).send({ studentIds: [student.id], at }).expect(200);
    expect(push.body.deliveries).toEqual([expect.objectContaining({ studentId: Number(student.id), sent: true })]);
    expect(db.prepare("SELECT body FROM notifications WHERE student_id = ? AND type = '机器人主动推送'").get(student.id).body).toContain('今天先完成');

    const badAt = await agent.post(`/api/admin/bots/${created.body.id}/schedules/JOB-MANUAL/trigger`).send({ studentIds: [student.id], at: '不是时间' }).expect(400);
    expect(badAt.body.error).toContain('at');
    const night = await agent.post(`/api/admin/bots/${created.body.id}/schedules/JOB-MANUAL/trigger`).send({ studentIds: [student.id], at: `${new Date().getFullYear()}-06-15T23:00:00` }).expect(200);
    expect(night.body.deliveries[0]).toMatchObject({ sent: false, reason: 'quiet_hours' });

    await agent.post(`/api/admin/bots/${created.body.id}/pause`).send({ reason: '验收暂停' }).expect(200);
    const audits = await agent.get(`/api/admin/bots/${created.body.id}/audits`).expect(200);
    expect(audits.body.audits.map((item) => item.action)).toEqual(expect.arrayContaining([
      'create', 'activate', 'gray_release', 'manual_push', 'pause'
    ]));
  });

  test('输入/输出禁用词触发安全替换、P0 工单、第三次电话升级和员工站内通知', () => {
    const admin = createUser({ username: unique('runtime_admin'), password: 'admin123', role: 'admin', displayName: '值班管理员' });
    const student = createStudent({ username: unique('runtime_student') });
    const now = new Date().toISOString();
    const insert = db.prepare(`
      INSERT INTO bots (robot_uid, code, name, type, config, status, is_active, created_at, updated_at)
      VALUES (?, ?, ?, 'advisor', ?, 'online', 1, ?, ?)
    `).run('R-99', unique('runtimebot').toLowerCase(), '小研', JSON.stringify(completeBotConfig()), now, now);
    const bot = { id: Number(insert.lastInsertRowid), name: '小研', type: 'advisor', config: completeBotConfig() };
    const externalUserId = unique('external');

    for (let index = 0; index < 3; index += 1) {
      const prepared = prepareConfiguredReply({ bot, message: '你们是不是包过', channel: 'wecom_kf', externalUserId, studentId: student.id });
      expect(prepared.handoff).toBe(true);
      expect(prepared.immediateReply).toContain('老师');
    }
    const ticket = db.prepare('SELECT * FROM bot_handoff_tickets WHERE bot_id = ? AND external_user_id = ?').get(bot.id, externalUserId);
    expect(ticket.priority).toBe('P0');
    expect(ticket.reason).toContain('电话通知');
    expect(db.prepare('SELECT COUNT(*) AS count FROM bot_violation_events WHERE bot_id = ? AND external_user_id = ?').get(bot.id, externalUserId).count).toBe(3);
    const staffNotice = db.prepare("SELECT body FROM notifications WHERE student_id = ? AND type = '机器人转人工'").get(admin.id);
    expect(staffNotice.body).toContain('电话通知');

    const safe = finalizeConfiguredReply({
      bot, config: completeBotConfig(), reply: '我们承诺包过', channel: 'wecom_kf', externalUserId: `${externalUserId}_output`, studentId: student.id
    });
    expect(safe).toBe(completeBotConfig().fallbackReply);
  });
});
