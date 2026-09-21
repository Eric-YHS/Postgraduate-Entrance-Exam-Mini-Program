const { db } = require('../db');
const crypto = require('crypto');
const dayjs = require('dayjs');
const runtimeConfig = require('../config');
const {
  buildConfiguredPrompt,
  createDefaultBotConfig,
  createHandoffTicket,
  matchKeyword,
  matchRestrictedTerms,
  recordViolation,
  selectCorpus
} = require('./robotConfig');

function findTemplate(config, rule, fallbackCategory = '') {
  const key = String(rule?.templateId || rule?.template || '').trim();
  const category = String(rule?.category || fallbackCategory || '').trim().toLowerCase();
  return (config.templates || []).find((item) => (
    (key && [item.id, item.name, item.key].some((value) => String(value || '') === key))
    || (category && String(item.category || '').toLowerCase() === category)
  ));
}

function handoffReply(config, rule) {
  return String(
    rule?.response
    || findTemplate(config, rule, 'handoff')?.content
    || '这个问题我转给老师，稍后由老师继续回复你。'
  ).trim();
}

function ensureProfileInvite({ bot, externalUserId, studentId }) {
  if (!runtimeConfig.publicBaseUrl || !['advisor', 'planner', 'supervisor'].includes(String(bot?.type || ''))) return '';
  let profile = studentId
    ? db.prepare('SELECT * FROM student_profiles WHERE user_id = ?').get(studentId)
    : db.prepare('SELECT * FROM student_profiles WHERE wecom_userid = ?').get(externalUserId);
  if (profile?.submitted_at) return '';
  if (!profile) {
    const now = dayjs().toISOString();
    const token = crypto.randomBytes(24).toString('hex');
    const user = studentId ? db.prepare('SELECT display_name FROM users WHERE id = ?').get(studentId) : null;
    const result = db.prepare(`
      INSERT INTO student_profiles (user_id, invite_token, wecom_userid, name, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(studentId, token, externalUserId, user?.display_name || '', now, now);
    profile = db.prepare('SELECT * FROM student_profiles WHERE id = ?').get(result.lastInsertRowid);
  }
  return `${runtimeConfig.publicBaseUrl}/student-profile.html?token=${profile.invite_token}`;
}

function appendProfileInvite(prepared, reply) {
  if (!prepared.profileInviteUrl) return reply;
  return `${reply}\n\n先把基本情况登记一下，后面的计划会按你的情况来：${prepared.profileInviteUrl}`;
}

function notifyHandoffStaff(ticketId, { studentId = null, reason = '', message = '' } = {}) {
  let recipients = [];
  if (studentId) {
    const profile = db.prepare('SELECT head_teacher_name FROM student_profiles WHERE user_id = ?').get(studentId);
    if (profile?.head_teacher_name) {
      recipients = db.prepare("SELECT id FROM users WHERE role IN ('teacher', 'admin') AND display_name = ?").all(profile.head_teacher_name);
    }
  }
  if (!recipients.length) {
    recipients = db.prepare("SELECT id FROM users WHERE role IN ('teacher', 'admin')").all();
  }
  const now = dayjs().toISOString();
  const insert = db.prepare(`
    INSERT INTO notifications
      (student_id, type, title, body, task_id, task_date, schedule_key, created_at)
    VALUES (?, '机器人转人工', '有一条 P0 转人工工单', ?, NULL, '', ?, ?)
    ON CONFLICT(schedule_key) DO UPDATE SET body = excluded.body, created_at = excluded.created_at
  `);
  for (const recipient of recipients) {
    insert.run(
      recipient.id,
      `${reason}${message ? `；消息：${String(message).slice(0, 120)}` : ''}`,
      `bot_handoff:${ticketId}:${recipient.id}`,
      now
    );
  }
}

async function enrichConfiguredReply({ bot, prepared, message, contextText = '', profileText = '' }) {
  const ids = prepared?.config?.knowledgeBaseIds || [];
  if (!ids.length) return prepared;
  const knowledgeBase = require('./knowledgeBase');
  const settled = await Promise.allSettled(ids.map((baseId) => knowledgeBase.searchByVector(baseId, message, 3)));
  const globalCorpus = settled.flatMap((result) => result.status === 'fulfilled' ? result.value : []).map((item) => ({
    title: item.documentTitle || '知识库资料',
    category: '全局知识库',
    content: item.content,
    source: `knowledge-base:${item.baseId}`
  }));
  if (!globalCorpus.length) return prepared;
  const corpus = [...(prepared.corpus || []), ...globalCorpus].slice(0, 8);
  return {
    ...prepared,
    corpus,
    systemPrompt: buildConfiguredPrompt(bot, { corpus, profileText, conversationText: contextText })
  };
}

function prepareConfiguredReply({ bot, message, channel, externalUserId = '', studentId = null, contextText = '', profileText = '' }) {
  const config = createDefaultBotConfig(bot?.config || {});
  const profileInviteUrl = ensureProfileInvite({ bot, externalUserId, studentId });
  const restrictedTerms = matchRestrictedTerms(config, message);
  if (restrictedTerms.length) {
    const count = recordViolation(db, {
      botId: bot.id,
      channel,
      externalUserId,
      direction: 'input',
      terms: restrictedTerms,
      content: message,
      action: 'handoff'
    });
    const ticketId = createHandoffTicket(db, {
      botId: bot.id,
      channel,
      externalUserId,
      studentId,
      reason: count >= 3 ? '1 小时内 3 次命中禁用词，需班主任电话通知' : `学员消息命中禁用词：${restrictedTerms.join('、')}`,
      message,
      priority: 'P0'
    });
    notifyHandoffStaff(ticketId, {
      studentId,
      reason: count >= 3 ? '1 小时内 3 次命中禁用词，需电话通知' : `学员消息命中禁用词：${restrictedTerms.join('、')}`,
      message
    });
    return { immediateReply: handoffReply(config), config, handoff: true, profileInviteUrl };
  }

  const handoffTerm = (config.handoffKeywords || []).find((term) => String(message).includes(term));
  const matchedRule = matchKeyword(config, message);
  const shouldHandoff = Boolean(
    handoffTerm
    || matchedRule?.priority === 'P0'
    || String(matchedRule?.category || '').toLowerCase() === 'handoff'
  );
  if (shouldHandoff) {
    const reason = handoffTerm ? `命中转人工触发词：${handoffTerm}` : `命中 P0 关键词：${matchedRule?.pattern || matchedRule?.keyword}`;
    const ticketId = createHandoffTicket(db, {
      botId: bot.id,
      channel,
      externalUserId,
      studentId,
      reason,
      message,
      priority: 'P0'
    });
    notifyHandoffStaff(ticketId, { studentId, reason, message });
    return { immediateReply: handoffReply(config, matchedRule), config, handoff: true, profileInviteUrl };
  }

  if (matchedRule) {
    const template = findTemplate(config, matchedRule);
    const response = String(matchedRule.response || template?.content || '').trim();
    if (response) return { immediateReply: response, config, handoff: false, matchedRule, profileInviteUrl };
  }

  const route = (config.routing || []).find((item) => {
    const pattern = String(item.pattern || item.keyword || '').trim();
    return pattern && String(message).includes(pattern);
  });
  if (route?.target) {
    const response = String(route.response || `这个问题交给${route.target}来接着处理。`).trim();
    return { immediateReply: response, config, handoff: false, route, profileInviteUrl };
  }

  const corpus = selectCorpus(config, message, 5);
  const systemPrompt = buildConfiguredPrompt(bot, {
    corpus,
    profileText,
    conversationText: contextText
  });
  return { config, corpus, systemPrompt, handoff: false, profileInviteUrl };
}

function finalizeConfiguredReply({ bot, config, reply, channel, externalUserId = '', studentId = null }) {
  const value = String(reply || '').trim();
  if (!value) return config.fallbackReply;
  const terms = matchRestrictedTerms(config, value);
  if (terms.length) {
    const count = recordViolation(db, {
      botId: bot.id,
      channel,
      externalUserId,
      direction: 'output',
      terms,
      content: value,
      action: 'fallback_replacement'
    });
    if (count >= 3) {
      const reason = '1 小时内 3 次机器人回复命中禁用词，需班主任电话通知';
      const ticketId = createHandoffTicket(db, {
        botId: bot.id,
        channel,
        externalUserId,
        studentId,
        reason,
        message: value,
        priority: 'P0'
      });
      notifyHandoffStaff(ticketId, { studentId, reason, message: value });
    }
    return config.fallbackReply;
  }
  return value.length > 250 ? `${value.slice(0, 247)}...` : value;
}

function decorateReply(bot, config, reply) {
  if (!reply) return null;
  return config.showName === false ? reply : `【${bot.name}】\n${reply}`;
}

module.exports = {
  appendProfileInvite,
  decorateReply,
  enrichConfiguredReply,
  finalizeConfiguredReply,
  notifyHandoffStaff,
  prepareConfiguredReply
};
