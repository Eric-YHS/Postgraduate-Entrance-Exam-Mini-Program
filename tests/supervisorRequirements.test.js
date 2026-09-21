const dayjs = require('dayjs');
jest.mock('../src/services/wecom', () => ({ sendAppMessage: jest.fn().mockResolvedValue({ errcode: 0 }) }));
const { db, createStudent } = require('./helper');
const { replacePlanForDate } = require('../src/services/studyPlan');
const { sendEveningCheck, handleReply } = require('../src/services/bots/supervisorBot');
const { sendAppMessage } = require('../src/services/wecom');

describe('表3晚间完成反馈闭环', () => {
  test('晚间消息列出编号计划，按编号登记并自动微调次日任务', async () => {
    const student = createStudent({ username: `supervisor_plan_${Date.now()}` });
    db.prepare('UPDATE users SET wecom_userid = ? WHERE id = ?').run(`wecom_${student.id}`, student.id);
    const today = dayjs().format('YYYY-MM-DD');
    const ids = replacePlanForDate(db, {
      studentId: student.id,
      planDate: today,
      sourceMode: 'manual',
      items: [
        { subject: '英语', title: '阅读真题一篇' },
        { subject: '数学', title: '高数例题十道' }
      ]
    });

    const evening = await sendEveningCheck(db, student.id);
    expect(evening.sent).toBe(true);
    const content = sendAppMessage.mock.calls[0][0].text.content;
    expect(content).toContain('1. 数学｜高数例题十道');
    expect(content).toContain('2. 英语｜阅读真题一篇');
    expect(content).not.toContain('加油');

    const reply = await handleReply(db, student.id, '1完成 2未完成');
    expect(reply.success).toBe(true);
    expect(reply.updated).toEqual(expect.arrayContaining([
      { planItemId: ids[1], completed: true },
      { planItemId: ids[0], completed: false }
    ]));
    const todayRows = db.prepare('SELECT title, status FROM study_plan_items WHERE student_id = ? AND plan_date = ? ORDER BY id').all(student.id, today);
    expect(todayRows).toEqual([
      { title: '阅读真题一篇', status: 'pending' },
      { title: '高数例题十道', status: 'completed' }
    ]);
    const tomorrow = dayjs(today).add(1, 'day').format('YYYY-MM-DD');
    const nextRows = db.prepare('SELECT title, source_mode FROM study_plan_items WHERE student_id = ? AND plan_date = ?').all(student.id, tomorrow);
    expect(nextRows).toEqual([expect.objectContaining({ title: '补做：阅读真题一篇', source_mode: 'semi_auto' })]);
  });
});
