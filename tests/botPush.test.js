const dayjs = require('dayjs');
const { db, createStudent } = require('./helper');
const { cronMatches, dispatchSchedule, rolloutEligible } = require('../src/services/botPush');
const { completeBotConfig } = require('./requirementsFixtures');

let serial = 0;
function createBot(config = completeBotConfig()) {
  serial += 1;
  const now = dayjs().toISOString();
  const result = db.prepare(`
    INSERT INTO bots (robot_uid, code, name, type, config, status, is_active, created_at, updated_at)
    VALUES (?, ?, '推送机器人', 'planner', ?, 'online', 1, ?, ?)
  `).run(`R-T${serial}`, `push_bot_${Date.now()}_${serial}`, JSON.stringify(config), now, now);
  return db.prepare('SELECT * FROM bots WHERE id = ?').get(result.lastInsertRowid);
}

describe('机器人主动推送执行器', () => {
  test('标准五字段 cron 可按分钟匹配', () => {
    const at = dayjs('2026-07-27T09:30:00+08:00');
    expect(cronMatches('30 9 * * 1', at)).toBe(true);
    expect(cronMatches('0 9 * * 1', at)).toBe(false);
  });

  test('手动任务实际发送并执行单机器人每日 1 条限频', async () => {
    const student = createStudent({ username: `push_student_${Date.now()}` });
    const bot = createBot();
    const schedule = completeBotConfig().schedules[0];
    const at = dayjs().hour(10).minute(0).second(0);

    const first = await dispatchSchedule(db, bot, schedule, { at, studentIds: [student.id] });
    const second = await dispatchSchedule(db, bot, schedule, { at: at.add(1, 'hour'), studentIds: [student.id] });
    expect(first).toEqual([{ studentId: student.id, sent: true }]);
    expect(second[0]).toMatchObject({ studentId: student.id, sent: false, reason: 'per_bot_daily_limit' });
    expect(db.prepare("SELECT COUNT(*) AS count FROM notifications WHERE student_id = ? AND type = '机器人主动推送'").get(student.id).count).toBe(1);
  });

  test('考前 3 天静默并使用稳定灰度分桶', async () => {
    const student = createStudent({ username: `silent_student_${Date.now()}` });
    const bot = createBot();
    const at = dayjs().hour(10).minute(0).second(0);
    db.prepare('INSERT OR REPLACE INTO exam_countdown (student_id, exam_date, exam_name, created_at) VALUES (?, ?, ?, ?)')
      .run(student.id, at.add(2, 'day').format('YYYY-MM-DD'), '考研', at.toISOString());
    const result = await dispatchSchedule(db, bot, completeBotConfig().schedules[0], { at, studentIds: [student.id] });
    expect(result[0].reason).toBe('exam_silence');
    expect(rolloutEligible(bot.id, student.id, 50)).toBe(rolloutEligible(bot.id, student.id, 50));
  });
});
