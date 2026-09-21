const dayjs = require('dayjs');
const nodemailer = require('nodemailer');
const config = require('../config');

let transporter = null;

function getTransporter() {
  if (!config.smtpHost || !config.smtpUser || !config.smtpPassword || !config.smtpFrom) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: config.smtpHost,
      port: config.smtpPort,
      secure: config.smtpSecure,
      auth: { user: config.smtpUser, pass: config.smtpPassword }
    });
  }
  return transporter;
}

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[character]));
}

function listHtml(items) {
  const values = Array.isArray(items) ? items : [];
  return values.length
    ? `<ul style="margin:8px 0 0;padding-left:20px;line-height:1.8;">${values.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`
    : '<p style="margin:8px 0 0;color:#6b7280;">本周暂无记录。</p>';
}

function renderWeeklyReportHtml({ studentName, weekStart, report }) {
  const taskRate = report?.stats?.tasks?.rate ?? report?.taskCompletionRate ?? '—';
  return `<!doctype html><html><body style="margin:0;background:#f3f6fa;font-family:Arial,'Microsoft YaHei',sans-serif;color:#172033;">
    <div style="max-width:720px;margin:0 auto;padding:28px 16px;">
      <div style="background:linear-gradient(135deg,#1d4e89,#2e75b6);color:white;border-radius:18px;padding:26px;">
        <div style="font-size:13px;opacity:.78;">${escapeHtml(weekStart)} 起 · 学情周报</div>
        <h1 style="font-size:28px;margin:8px 0 6px;">${escapeHtml(studentName)}的本周复盘</h1>
        <div style="font-size:16px;">任务完成率：<strong>${escapeHtml(taskRate)}${taskRate === '—' ? '' : '%'}</strong></div>
      </div>
      <div style="background:white;border:1px solid #dbe4ef;border-radius:16px;padding:22px;margin-top:16px;">
        <h2 style="font-size:18px;color:#1d4e89;margin:0;">已经掌握</h2>${listHtml(report?.mastered)}
      </div>
      <div style="background:white;border:1px solid #dbe4ef;border-radius:16px;padding:22px;margin-top:12px;">
        <h2 style="font-size:18px;color:#b54708;margin:0;">本周薄弱点</h2>${listHtml(report?.weakPoints)}
      </div>
      <div style="background:white;border:1px solid #dbe4ef;border-radius:16px;padding:22px;margin-top:12px;">
        <h2 style="font-size:18px;color:#147a55;margin:0;">下周计划</h2>${listHtml(report?.nextWeekPlan)}
      </div>
      <div style="background:#fff8e7;border:1px solid #f1d48a;border-radius:16px;padding:22px;margin-top:12px;">
        <h2 style="font-size:18px;margin:0;">老师建议</h2>${listHtml(report?.suggestions)}
      </div>
      <p style="font-size:12px;color:#7b8797;line-height:1.7;margin:18px 4px;">这封邮件由考研学习工厂根据本周任务、刷题、错题与对话记录自动生成。计划会结合晚间完成反馈继续微调。</p>
    </div></body></html>`;
}

async function sendWeeklyReportEmail(db, { reportId = null, studentId, report, weekStart }) {
  const profile = db.prepare(`
    SELECT p.email, p.name, u.display_name FROM student_profiles p
    LEFT JOIN users u ON u.id = p.user_id WHERE p.user_id = ?
  `).get(studentId);
  const recipient = String(profile?.email || '').trim();
  const now = dayjs().toISOString();
  const deliveryId = db.prepare(`
    INSERT INTO weekly_report_deliveries
      (report_id, student_id, recipient_email, status, error_message, created_at)
    VALUES (?, ?, ?, 'pending', '', ?)
  `).run(reportId, studentId, recipient, now).lastInsertRowid;
  if (!recipient) {
    db.prepare("UPDATE weekly_report_deliveries SET status = 'skipped', error_message = '学生未填写邮箱' WHERE id = ?").run(deliveryId);
    return { sent: false, skipped: true, reason: 'missing_recipient' };
  }
  const mailer = getTransporter();
  if (!mailer) {
    db.prepare("UPDATE weekly_report_deliveries SET status = 'skipped', error_message = 'SMTP 未配置' WHERE id = ?").run(deliveryId);
    return { sent: false, skipped: true, reason: 'smtp_not_configured' };
  }
  try {
    const studentName = profile?.name || profile?.display_name || '学员';
    await mailer.sendMail({
      from: config.smtpFrom,
      to: recipient,
      subject: `${studentName}的考研学情周报（${weekStart}）`,
      html: renderWeeklyReportHtml({ studentName, weekStart, report }),
      text: `${studentName}的学情周报\n\n薄弱点：${(report?.weakPoints || []).join('、')}\n下周计划：${(report?.nextWeekPlan || []).join('；')}`
    });
    db.prepare("UPDATE weekly_report_deliveries SET status = 'sent', sent_at = ?, error_message = '' WHERE id = ?").run(dayjs().toISOString(), deliveryId);
    return { sent: true, deliveryId };
  } catch (error) {
    db.prepare("UPDATE weekly_report_deliveries SET status = 'failed', error_message = ? WHERE id = ?").run(String(error.message || error).slice(0, 500), deliveryId);
    throw error;
  }
}

module.exports = {
  getTransporter,
  renderWeeklyReportHtml,
  sendWeeklyReportEmail
};
