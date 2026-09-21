const nodemailer = require('nodemailer');
const dayjs = require('dayjs');
const config = require('../src/config');
const { db, createStudent } = require('./helper');
const { renderWeeklyReportHtml, sendWeeklyReportEmail } = require('../src/services/reportMailer');

let sequence = 0;
function createProfile(studentId, email) {
  sequence += 1;
  const now = dayjs().toISOString();
  db.prepare(`
    INSERT INTO student_profiles (user_id, invite_token, name, email, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(studentId, `mailer_token_${Date.now()}_${sequence}`, '邮件学员', email, now, now);
}

describe('学情周报邮件交付', () => {
  test('HTML 转义所有动态内容并包含周报要求的四个核心板块', () => {
    const html = renderWeeklyReportHtml({
      studentName: '<script>alert(1)</script>', weekStart: '2026-07-20',
      report: {
        stats: { tasks: { rate: 88 } },
        mastered: ['阅读 <已掌握>'], weakPoints: ['数学 & 政治'],
        nextWeekPlan: ['完成 "真题"'], suggestions: ["老师的 '建议'"]
      }
    });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('已经掌握');
    expect(html).toContain('本周薄弱点');
    expect(html).toContain('下周计划');
    expect(html).toContain('老师建议');
    expect(html).toContain('88%');
  });

  test('缺邮箱/缺 SMTP 跳过，SMTP 成功与失败均准确记录交付状态', async () => {
    const original = {
      smtpHost: config.smtpHost, smtpUser: config.smtpUser, smtpPassword: config.smtpPassword,
      smtpFrom: config.smtpFrom, smtpPort: config.smtpPort, smtpSecure: config.smtpSecure
    };
    const report = { weakPoints: ['阅读'], nextWeekPlan: ['真题'], mastered: ['词汇'], suggestions: ['复盘'] };
    try {
      const noEmail = createStudent({ username: `mailer_no_email_${Date.now()}` });
      const missingRecipient = await sendWeeklyReportEmail(db, { studentId: noEmail.id, report, weekStart: '2026-07-20' });
      expect(missingRecipient).toEqual(expect.objectContaining({ skipped: true, reason: 'missing_recipient' }));

      const noSmtp = createStudent({ username: `mailer_no_smtp_${Date.now()}` });
      createProfile(noSmtp.id, 'no-smtp@example.com');
      config.smtpHost = '';
      config.smtpUser = '';
      config.smtpPassword = '';
      config.smtpFrom = '';
      const missingSmtp = await sendWeeklyReportEmail(db, { studentId: noSmtp.id, report, weekStart: '2026-07-20' });
      expect(missingSmtp).toEqual(expect.objectContaining({ skipped: true, reason: 'smtp_not_configured' }));

      config.smtpHost = 'smtp.example.test';
      config.smtpUser = 'robot@example.test';
      config.smtpPassword = 'test-password';
      config.smtpFrom = 'robot@example.test';
      config.smtpPort = 465;
      config.smtpSecure = true;
      const mailer = { sendMail: jest.fn().mockResolvedValueOnce({ messageId: 'ok-1' }) };
      const createTransport = jest.spyOn(nodemailer, 'createTransport').mockReturnValue(mailer);
      const successStudent = createStudent({ username: `mailer_success_${Date.now()}` });
      createProfile(successStudent.id, 'success@example.com');
      const success = await sendWeeklyReportEmail(db, { studentId: successStudent.id, report, weekStart: '2026-07-20' });
      expect(success.sent).toBe(true);
      expect(mailer.sendMail).toHaveBeenCalledWith(expect.objectContaining({ to: 'success@example.com' }));
      expect(db.prepare('SELECT status FROM weekly_report_deliveries WHERE id = ?').get(success.deliveryId).status).toBe('sent');

      mailer.sendMail.mockRejectedValueOnce(new Error('SMTP temporary failure'));
      const failedStudent = createStudent({ username: `mailer_failed_${Date.now()}` });
      createProfile(failedStudent.id, 'failed@example.com');
      await expect(sendWeeklyReportEmail(db, { studentId: failedStudent.id, report, weekStart: '2026-07-20' })).rejects.toThrow('SMTP temporary failure');
      const failed = db.prepare('SELECT status, error_message FROM weekly_report_deliveries WHERE student_id = ? ORDER BY id DESC LIMIT 1').get(failedStudent.id);
      expect(failed).toEqual(expect.objectContaining({ status: 'failed', error_message: 'SMTP temporary failure' }));
      createTransport.mockRestore();
    } finally {
      Object.assign(config, original);
    }
  });
});
