const crypto = require('crypto');
const dayjs = require('dayjs');
const { createDefaultBotConfig } = require('./robotConfig');

function parseJson(value, fallback = {}) {
  try { return JSON.parse(value || ''); } catch (_) { return fallback; }
}

function fieldMatches(field, value, min, max) {
  return String(field || '*').split(',').some((part) => {
    const [rangePart, stepPart] = part.split('/');
    const step = Math.max(1, Number(stepPart) || 1);
    let start = min;
    let end = max;
    if (rangePart !== '*') {
      const bounds = rangePart.split('-').map(Number);
      start = bounds[0];
      end = bounds.length > 1 ? bounds[1] : bounds[0];
    }
    return Number.isInteger(start) && Number.isInteger(end) && value >= start && value <= end && (value - start) % step === 0;
  });
}

function cronMatches(expression, at = dayjs()) {
  const fields = String(expression || '').trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const current = dayjs(at);
  const weekday = current.day();
  return fieldMatches(fields[0], current.minute(), 0, 59)
    && fieldMatches(fields[1], current.hour(), 0, 23)
    && fieldMatches(fields[2], current.date(), 1, 31)
    && fieldMatches(fields[3], current.month() + 1, 1, 12)
    && (fieldMatches(fields[4], weekday, 0, 6) || (weekday === 0 && fieldMatches(fields[4], 7, 0, 7)));
}

function rolloutEligible(botId, studentId, percent) {
  const value = crypto.createHash('sha256').update(`${botId}:${studentId}`).digest().readUInt32BE(0) % 100;
  return value < percent;
}

function audienceStudents(db, audience, explicitStudentIds = []) {
  if (explicitStudentIds.length) {
    const ids = [...new Set(explicitStudentIds.map(Number).filter((id) => Number.isInteger(id) && id > 0))];
    if (!ids.length) return [];
    return db.prepare(`
      SELECT u.id, u.display_name, u.wecom_userid, p.current_stage, p.target_school
      FROM users u LEFT JOIN student_profiles p ON p.user_id = u.id
      WHERE u.role = 'student' AND u.id IN (${ids.map(() => '?').join(',')})
    `).all(...ids);
  }
  const value = String(audience || 'all').trim();
  let sql = `SELECT u.id, u.display_name, u.wecom_userid, p.current_stage, p.target_school
    FROM users u LEFT JOIN student_profiles p ON p.user_id = u.id WHERE u.role = 'student'`;
  const params = [];
  const match = value.match(/^(?:stage|阶段)[:=：](.+)$/i) || value.match(/^(?:school|院校)[:=：](.+)$/i);
  if (match) {
    const schoolRule = /^(?:school|院校)/i.test(value);
    sql += schoolRule ? ' AND p.target_school = ?' : ' AND p.current_stage = ?';
    params.push(match[1].trim());
  }
  return db.prepare(sql).all(...params);
}

function findTemplate(config, templateId) {
  const key = String(templateId || '').trim();
  return (config.templates || []).find((item) => [item.id, item.key, item.name].some((value) => String(value || '') === key));
}

function formatContent(content, bot, student) {
  return String(content || '')
    .replaceAll('{昵称}', bot.config.nickname || bot.name)
    .replaceAll('{机器人名}', bot.name)
    .replaceAll('{学员姓名}', student.display_name || '学员')
    .trim();
}

function recordDelivery(db, { botId, studentId, scheduleId, pushSlotKey, triggerType, content, status, reason = '', at }) {
  return db.prepare(`
    INSERT INTO bot_push_deliveries
      (bot_id, student_id, schedule_id, push_slot_key, trigger_type, content_excerpt, status, skip_reason, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(botId, studentId, scheduleId, pushSlotKey, triggerType, String(content || '').slice(0, 500), status, reason, dayjs(at).toISOString()).lastInsertRowid;
}

function eligibility(db, bot, student, schedule, at) {
  const now = dayjs(at);
  const limits = bot.config.rateLimits;
  if (now.hour() < limits.startHour || now.hour() >= limits.endHour) return 'quiet_hours';
  const countdown = db.prepare('SELECT exam_date FROM exam_countdown WHERE student_id = ?').get(student.id);
  if (countdown?.exam_date) {
    const days = dayjs(countdown.exam_date).startOf('day').diff(now.startOf('day'), 'day');
    if (days >= 0 && days <= limits.examSilenceDays) return 'exam_silence';
  }
  if (!rolloutEligible(bot.id, student.id, bot.config.rolloutPercent)) return 'outside_rollout';
  const dayStart = now.startOf('day').toISOString();
  const perBot = db.prepare("SELECT COUNT(*) AS count FROM bot_push_deliveries WHERE bot_id = ? AND student_id = ? AND status = 'sent' AND created_at >= ?").get(bot.id, student.id, dayStart).count;
  if (perBot >= limits.perBotPerStudentDaily) return 'per_bot_daily_limit';
  const allBots = db.prepare("SELECT COUNT(*) AS count FROM bot_push_deliveries WHERE student_id = ? AND status = 'sent' AND created_at >= ?").get(student.id, dayStart).count;
  if (allBots >= limits.allBotsPerStudentDaily) return 'all_bots_daily_limit';
  const minuteStart = now.startOf('minute').toISOString();
  const duplicate = db.prepare("SELECT id FROM bot_push_deliveries WHERE bot_id = ? AND student_id = ? AND schedule_id = ? AND status = 'sent' AND created_at >= ? LIMIT 1")
    .get(bot.id, student.id, String(schedule.id || schedule.name || ''), minuteStart);
  return duplicate ? 'duplicate_schedule_minute' : '';
}

async function dispatchSchedule(db, rawBot, schedule, { at = dayjs(), studentIds = [] } = {}) {
  const bot = { ...rawBot, config: createDefaultBotConfig(parseJson(rawBot.config, rawBot.config || {})) };
  const triggerType = String(schedule.triggerType || 'manual').toLowerCase();
  const template = findTemplate(bot.config, schedule.templateId);
  const baseContent = String(schedule.content || template?.content || '').trim();
  if (!baseContent) throw new Error(`任务“${schedule.name || schedule.id}”未找到可用模板内容`);
  const students = audienceStudents(db, schedule.audience, studentIds);
  const results = [];
  for (const student of students) {
    const reason = eligibility(db, bot, student, schedule, at);
    const content = formatContent(baseContent, bot, student);
    if (reason) {
      recordDelivery(db, { botId: bot.id, studentId: student.id, scheduleId: String(schedule.id || ''), pushSlotKey: schedule.pushSlotKey || '', triggerType, content, status: 'skipped', reason, at });
      results.push({ studentId: student.id, sent: false, reason });
      continue;
    }
    const now = dayjs(at).toISOString();
    const key = `bot_push:${bot.id}:${schedule.id || schedule.name}:${student.id}:${dayjs(at).format('YYYYMMDDHHmm')}`;
    db.prepare(`
      INSERT OR IGNORE INTO notifications (student_id, type, title, body, task_id, task_date, schedule_key, created_at)
      VALUES (?, '机器人主动推送', ?, ?, NULL, '', ?, ?)
    `).run(student.id, schedule.name || bot.name, content, key, now);
    recordDelivery(db, { botId: bot.id, studentId: student.id, scheduleId: String(schedule.id || ''), pushSlotKey: schedule.pushSlotKey || '', triggerType, content, status: 'sent', at });
    if (student.wecom_userid && process.env.NODE_ENV !== 'test') {
      const { sendAppMessage } = require('./wecom');
      await sendAppMessage({ touser: student.wecom_userid, msgtype: 'text', text: { content } }).catch((error) => {
        console.error(`[botPush] 企业微信推送失败 studentId=${student.id}:`, error.message);
      });
    }
    results.push({ studentId: student.id, sent: true });
  }
  return results;
}

async function dispatchScheduledBotPushes(db, at = dayjs()) {
  const bots = db.prepare("SELECT * FROM bots WHERE status = 'online' AND is_active = 1").all();
  const results = [];
  for (const bot of bots) {
    const config = createDefaultBotConfig(parseJson(bot.config, {}));
    for (const schedule of config.schedules.filter((item) => item.enabled !== false && String(item.triggerType).toLowerCase() === 'cron' && cronMatches(item.cron, at))) {
      results.push({ botId: bot.id, scheduleId: schedule.id, deliveries: await dispatchSchedule(db, bot, schedule, { at }) });
    }
  }
  return results;
}

async function dispatchBotEvent(db, eventName, { at = dayjs(), studentIds = [] } = {}) {
  const bots = db.prepare("SELECT * FROM bots WHERE status = 'online' AND is_active = 1").all();
  const results = [];
  for (const bot of bots) {
    const config = createDefaultBotConfig(parseJson(bot.config, {}));
    const schedules = config.schedules.filter((item) => item.enabled !== false
      && String(item.triggerType).toLowerCase() === 'event'
      && String(item.event || item.cron || '').trim() === String(eventName));
    for (const schedule of schedules) {
      results.push({ botId: bot.id, scheduleId: schedule.id, deliveries: await dispatchSchedule(db, bot, schedule, { at, studentIds }) });
    }
  }
  return results;
}

module.exports = {
  audienceStudents,
  cronMatches,
  dispatchBotEvent,
  dispatchSchedule,
  dispatchScheduledBotPushes,
  rolloutEligible
};
