const dayjs = require('dayjs');

const SYSTEM_RESTRICTED_WORDS = [
  '包过', '保过', '必上岸', '100%通过', '保录取', '不过退款', '稳过', '绝对能',
  '不通过赔钱', '签约保过', '内部资料', '泄题', '压题', '原题', '答案已出', '考后改分'
];

const HANDOFF_KEYWORDS = ['人工', '老师', '真人', '客服', '转人工', '找老师'];

const STANDARD_PUSH_SLOTS = [
  { key: 'daily_question', name: '每日一题', enabled: false, trigger: '每天固定时间' },
  { key: 'key_point', name: '考点速记', enabled: false, trigger: '每周一/四 9 点' },
  { key: 'wrong_review', name: '错题回炉', enabled: false, trigger: '标记“不懂”后 3 天' },
  { key: 'stage_change', name: '阶段切换提醒', enabled: true, trigger: '阶段变化时' },
  { key: 'mock_exam', name: '模考真题', enabled: true, trigger: '模考报名/考前一周' },
  { key: 'current_affairs', name: '时效内容', enabled: false, trigger: '重大时政事件' }
];

const DEFAULT_FALLBACK = '这个我得查一下。你是想问学习方法、复习安排，还是具体题目？可以再具体点。';

function uniqueStrings(value) {
  const list = Array.isArray(value) ? value : String(value || '').split(/[，,\n]/);
  return [...new Set(list.map((item) => String(item || '').trim()).filter(Boolean))];
}

function normalizeResourceList(value) {
  return Array.isArray(value) ? value.filter((item) => item && typeof item === 'object') : [];
}

function createDefaultBotConfig(input = {}) {
  const nickname = String(input.nickname || input.name || '').trim();
  return {
    description: String(input.description || '').trim(),
    nickname,
    avatar: String(input.avatar || nickname.slice(0, 1) || '研').trim().slice(0, 2),
    positioning: String(input.positioning || input.type || '').trim(),
    initialNote: String(input.initialNote || '').trim(),
    showName: input.showName !== false,
    triggerKeywords: uniqueStrings(input.triggerKeywords),
    model: String(input.model || '').trim(),
    temperature: Number.isFinite(Number(input.temperature)) ? Number(input.temperature) : 0.6,
    maxTokens: Number(input.maxTokens) || 1000,
    welcomeMessage: String(input.welcomeMessage || '').trim(),
    style: {
      tone: String(input.style?.tone || '中立老师').trim(),
      addressStudent: String(input.style?.addressStudent || '你').trim(),
      selfReference: String(input.style?.selfReference || nickname || '我').trim(),
      closingStyle: String(input.style?.closingStyle || '简短反问').trim(),
      bannedSpeech: String(input.style?.bannedSpeech || '不说廉价称呼、空话和夸大承诺').trim()
    },
    prompts: normalizeResourceList(input.prompts),
    systemRestrictedWords: uniqueStrings(input.systemRestrictedWords?.length ? input.systemRestrictedWords : SYSTEM_RESTRICTED_WORDS),
    customRestrictedWords: uniqueStrings(input.customRestrictedWords),
    corpus: normalizeResourceList(input.corpus),
    keywords: normalizeResourceList(input.keywords),
    templates: normalizeResourceList(input.templates),
    pushSlots: mergePushSlots(input.pushSlots),
    schedules: normalizeResourceList(input.schedules),
    handoffKeywords: uniqueStrings(input.handoffKeywords?.length ? input.handoffKeywords : HANDOFF_KEYWORDS),
    routing: normalizeResourceList(input.routing),
    fallbackReply: String(input.fallbackReply || DEFAULT_FALLBACK).trim(),
    rateLimits: {
      perBotPerStudentDaily: Number(input.rateLimits?.perBotPerStudentDaily) || 1,
      allBotsPerStudentDaily: Number(input.rateLimits?.allBotsPerStudentDaily) || 3,
      startHour: Number.isFinite(Number(input.rateLimits?.startHour)) ? Number(input.rateLimits.startHour) : 9,
      endHour: Number.isFinite(Number(input.rateLimits?.endHour)) ? Number(input.rateLimits.endHour) : 21,
      examSilenceDays: Number.isFinite(Number(input.rateLimits?.examSilenceDays)) ? Number(input.rateLimits.examSilenceDays) : 3
    },
    rolloutPercent: [10, 50, 100].includes(Number(input.rolloutPercent)) ? Number(input.rolloutPercent) : 100,
    systemPrompt: String(input.systemPrompt || '').trim(),
    knowledgeBaseIds: [...new Set((Array.isArray(input.knowledgeBaseIds) ? input.knowledgeBaseIds : [])
      .map(Number).filter((value) => Number.isInteger(value) && value > 0))]
  };
}

function mergePushSlots(value) {
  const source = normalizeResourceList(value);
  const current = new Map(source.map((item) => [String(item.key || item.name), item]));
  const standard = STANDARD_PUSH_SLOTS.map((slot) => ({
    ...slot,
    ...(current.get(slot.key) || current.get(slot.name) || {})
  }));
  const standardKeys = new Set(STANDARD_PUSH_SLOTS.flatMap((slot) => [slot.key, slot.name]));
  const custom = source.filter((item) => !standardKeys.has(String(item.key || item.name)) && String(item.name || '').trim());
  return [...standard, ...custom];
}

function humanVoiceIssues(text) {
  const value = String(text || '');
  const issues = [];
  if (/(亲|宝子|同学|小伙伴)/.test(value)) issues.push('包含廉价称呼');
  if (/(加油哦|继续努力|坚持住)/.test(value)) issues.push('包含空泛鼓励');
  const emojis = value.match(/[\u{1F300}-\u{1FAFF}]/gu) || [];
  if (emojis.length > 1) issues.push('emoji 堆砌');
  if (/(^|\n)\s*#{1,6}\s|(^|\n)\s*\d+[.、]\s/m.test(value)) issues.push('包含结构化标签');
  if (value.length > 250) issues.push('超过 250 字');
  return issues;
}

function validatePrompt(prompt) {
  return Boolean(
    String(prompt?.role || '').trim()
    && String(prompt?.context || '').trim()
    && String(prompt?.task || '').trim()
    && String(prompt?.outputRules || '').trim()
  );
}

function validateBotConfig(rawConfig) {
  const config = createDefaultBotConfig(rawConfig);
  const promptOk = config.prompts.some(validatePrompt)
    || ['# 角色', '# 上下文', '# 任务', '# 输出规范'].every((section) => config.systemPrompt.includes(section));
  const systemTerms = new Set(config.systemRestrictedWords);
  const keywordCategories = new Set(config.keywords.map((item) => String(item.category || '').toLowerCase()));
  const checks = [
    {
      key: 'identity',
      label: '基础信息',
      ok: Boolean(config.nickname && config.avatar && config.positioning && config.description && config.initialNote),
      detail: '昵称、头像、角色定位、角色简介、初始说明均必填'
    },
    {
      key: 'style',
      label: '说话风格 5 维度',
      ok: Object.values(config.style).every((value) => String(value || '').trim()),
      detail: '口吻、称谓、自称、收尾和禁用话术均必填'
    },
    { key: 'prompt', label: 'Prompt 4 段式', ok: promptOk, detail: '角色、上下文、任务、输出规范缺一不可' },
    {
      key: 'system_restricted',
      label: '系统禁用词',
      ok: SYSTEM_RESTRICTED_WORDS.every((term) => systemTerms.has(term)),
      detail: '运营红线必须全部启用'
    },
    { key: 'custom_restricted', label: '机器人自定义禁用词', ok: Array.isArray(config.customRestrictedWords), detail: '允许为空，但配置项必须存在' },
    {
      key: 'corpus',
      label: '专属语料 5+ 条',
      ok: config.corpus.length >= 5 && config.corpus.every((item) => String(item.title || '').trim() && String(item.category || '').trim() && String(item.content || '').trim().length >= 50),
      detail: '至少 5 条，且标题、分类、50 字以上内容必填'
    },
    {
      key: 'keywords',
      label: '关键词 3 类',
      ok: ['handoff', 'business', 'fallback'].every((category) => keywordCategories.has(category)),
      detail: '转人工、业务、兜底三类都要有'
    },
    { key: 'templates', label: '消息模板 3-5 类', ok: config.templates.length >= 3, detail: '欢迎、兜底、转人工、引导、反馈至少配置 3 类' },
    { key: 'push_slots', label: '6 个标准推送位', ok: STANDARD_PUSH_SLOTS.every((slot) => config.pushSlots.some((item) => item.key === slot.key && item.trigger)), detail: '6 个标准位都要保留触发配置' },
    {
      key: 'rate_limits',
      label: '主动推送强制限频',
      ok: config.rateLimits.perBotPerStudentDaily === 1
        && config.rateLimits.allBotsPerStudentDaily === 3
        && config.rateLimits.startHour === 9
        && config.rateLimits.endHour === 21
        && config.rateLimits.examSilenceDays === 3,
      detail: '必须为单机器人每日 1 条、跨机器人每日 3 条、9:00-21:00、考前 3 天静默'
    },
    {
      key: 'schedules',
      label: '定时任务格式',
      ok: config.schedules.every((item) => (
        String(item.name || '').trim()
        && ['cron', 'event', 'manual'].includes(String(item.triggerType || '').toLowerCase())
        && (String(item.triggerType || '').toLowerCase() !== 'cron' || String(item.cron || '').trim().split(/\s+/).length === 5)
        && String(item.templateId || '').trim()
        && String(item.audience || '').trim()
      )),
      detail: '每项需有任务名、cron/event/manual 类型、模板、圈选规则；cron 必须是 5 字段'
    },
    {
      key: 'fallback',
      label: '兜底回复',
      ok: Boolean(config.fallbackReply) && config.fallbackReply.length <= 150 && !/(我不知道|我也不太清楚)/.test(config.fallbackReply),
      detail: '不超过 150 字，不说“不知道”，并给出下一步引导'
    },
    {
      key: 'handoff',
      label: '转人工触发词',
      ok: HANDOFF_KEYWORDS.every((term) => config.handoffKeywords.includes(term)),
      detail: '人工、老师、真人、客服、转人工、找老师必须齐全'
    },
    { key: 'status', label: '创建后草稿', ok: true, detail: '新建机器人默认草稿，校验通过后才能上线' },
    {
      key: 'human_voice',
      label: '真人话术自检',
      ok: [...config.templates.map((item) => item.content), config.fallbackReply].every((text) => humanVoiceIssues(text).length === 0),
      detail: '无廉价称呼、空话、emoji 堆砌和结构化标签'
    }
  ];
  return { valid: checks.every((item) => item.ok), checks, config };
}

function matchRestrictedTerms(config, text) {
  const content = String(text || '').toLowerCase();
  return uniqueStrings([...(config.systemRestrictedWords || []), ...(config.customRestrictedWords || [])])
    .filter((term) => content.includes(term.toLowerCase()));
}

function keywordMatches(rule, message) {
  const pattern = String(rule?.pattern || rule?.keyword || '').trim();
  if (!pattern) return false;
  const content = String(message || '').trim();
  const type = String(rule.matchType || rule.type || 'contains').toLowerCase();
  if (type === 'exact') return content.toLowerCase() === pattern.toLowerCase();
  if (type === 'regex') {
    try { return new RegExp(pattern, 'i').test(content); } catch (_) { return false; }
  }
  return content.toLowerCase().includes(pattern.toLowerCase());
}

function matchKeyword(config, message) {
  const weights = { P0: 0, P1: 1, P2: 2 };
  return [...(config.keywords || [])]
    .filter((rule) => keywordMatches(rule, message))
    .sort((left, right) => (weights[left.priority] ?? 9) - (weights[right.priority] ?? 9))[0] || null;
}

function selectCorpus(config, message, limit = 5) {
  const normalized = String(message || '').toLowerCase();
  const words = normalized.split(/[^\p{L}\p{N}]+/u).filter((token) => token.length > 1);
  const cjkBigrams = [...normalized.matchAll(/[\p{Script=Han}]+/gu)].flatMap(([segment]) => {
    const chars = [...segment];
    return chars.slice(0, -1).map((char, index) => `${char}${chars[index + 1]}`);
  });
  const tokens = uniqueStrings([...words, ...cjkBigrams]);
  return (config.corpus || []).map((item) => {
    const haystack = `${item.title || ''} ${item.category || ''} ${item.content || ''}`.toLowerCase();
    const score = tokens.reduce((sum, token) => sum + (haystack.includes(token) ? 1 : 0), 0);
    return { ...item, score };
  }).filter((item) => item.score > 0).sort((a, b) => b.score - a.score).slice(0, limit);
}

function buildConfiguredPrompt(bot, context = {}) {
  const config = createDefaultBotConfig(bot?.config || {});
  const prompt = config.prompts.find((item) => item.active !== false && validatePrompt(item));
  const corpus = context.corpus || [];
  const profileText = String(context.profileText || '').trim();
  const conversationText = String(context.conversationText || '').trim();
  return [
    '# 角色',
    prompt?.role || config.systemPrompt || `你是“${bot?.name || config.nickname}”，${config.description || config.positioning}。`,
    `最大忌讳：不用“亲”“宝子”“加油哦”等廉价称呼；不作夸大承诺。`,
    '# 上下文',
    prompt?.context || '结合学员档案、最近对话和专属语料回答。',
    profileText ? `学员档案：\n${profileText}` : '',
    conversationText ? `最近对话：\n${conversationText}` : '',
    corpus.length ? `专属语料：\n${corpus.map((item) => `- ${item.title}：${item.content}`).join('\n')}` : '',
    '# 任务',
    prompt?.task || '先一句话讲本质，再用类比建立直觉，拆成可执行步骤，最后反问具体卡点。',
    '# 输出规范',
    prompt?.outputRules || '控制在 80-250 字；短句、口语化；不堆砌 emoji；不写空话；错了直接承认。'
  ].filter(Boolean).join('\n');
}

function recordAudit(db, { botId, actorId = null, action, before = {}, after = {}, summary = '' }) {
  db.prepare(`
    INSERT INTO bot_config_audits (bot_id, actor_id, action, before_json, after_json, summary, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(botId, actorId, action, JSON.stringify(before || {}), JSON.stringify(after || {}), summary, dayjs().toISOString());
}

function createHandoffTicket(db, { botId = null, channel = '', externalUserId = '', studentId = null, reason, message = '', priority = 'P0' }) {
  const now = dayjs().toISOString();
  const existing = db.prepare(`
    SELECT id FROM bot_handoff_tickets
    WHERE status != 'resolved' AND channel = ? AND external_user_id = ? AND ifnull(bot_id, 0) = ifnull(?, 0)
    ORDER BY created_at DESC LIMIT 1
  `).get(channel, externalUserId, botId);
  if (existing) {
    db.prepare(`
      UPDATE bot_handoff_tickets
      SET reason = ?, message_excerpt = ?, priority = ?, updated_at = ?
      WHERE id = ?
    `).run(reason, String(message).slice(0, 500), priority, now, existing.id);
    return existing.id;
  }
  return db.prepare(`
    INSERT INTO bot_handoff_tickets
      (bot_id, channel, external_user_id, student_id, reason, message_excerpt, priority, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)
  `).run(botId, channel, externalUserId, studentId, reason, String(message).slice(0, 500), priority, now, now).lastInsertRowid;
}

function recordViolation(db, { botId, channel = '', externalUserId = '', direction, terms, content, action }) {
  const now = dayjs().toISOString();
  db.prepare(`
    INSERT INTO bot_violation_events
      (bot_id, channel, external_user_id, direction, matched_terms, content_excerpt, action, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(botId, channel, externalUserId, direction, JSON.stringify(terms || []), String(content || '').slice(0, 500), action, now);
  if (!externalUserId) return 1;
  return db.prepare(`
    SELECT COUNT(*) AS count FROM bot_violation_events
    WHERE bot_id = ? AND external_user_id = ? AND created_at >= ?
  `).get(botId, externalUserId, dayjs().subtract(1, 'hour').toISOString()).count;
}

module.exports = {
  DEFAULT_FALLBACK,
  HANDOFF_KEYWORDS,
  STANDARD_PUSH_SLOTS,
  SYSTEM_RESTRICTED_WORDS,
  buildConfiguredPrompt,
  createDefaultBotConfig,
  createHandoffTicket,
  humanVoiceIssues,
  matchKeyword,
  matchRestrictedTerms,
  recordAudit,
  recordViolation,
  selectCorpus,
  uniqueStrings,
  validateBotConfig
};
