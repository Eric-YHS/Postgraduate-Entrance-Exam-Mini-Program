/**
 * 免费答疑机器人（引流转化）
 * 处理考研基础问题的免费答疑，并在适当时机植入转化话术
 */

const { quickAsk } = require('../ai');
const { searchByVector } = require('../knowledgeBase');
const { logConversation } = require('../botManager');
const config = require('../../config');

// ── 常量 ──

/** 转人工关键词 */
const HANDOFF_KEYWORDS = ['人工', '客服', '转人工', '人工客服', '找老师', '找顾问', '报班', '报名', '付费', '课程咨询', '一对一'];

/** 考研相关主题词（用于判断问题是否在范围内） */
const KAOYAN_TOPICS = [
  '考研', '研究生', '硕士', '博士', '初试', '复试', '调剂', '保研', '推免',
  '政治', '英语', '数学', '专业课', '高数', '线代', '概率', '数一', '数二', '数三',
  '英一', '英二', '四六级', '词汇', '阅读', '写作', '翻译', '完形',
  '马原', '毛概', '史纲', '思修', '时政',
  '院校', '大学', '985', '211', '双一流', '一本', '二本',
  '报名', '报考', '现场确认', '网上确认', '准考证', '考场', '考试时间',
  '分数线', '国家线', '自划线', '单科线', '复试线', '录取线',
  '学硕', '专硕', '全日制', '非全日制', '定向', '非定向',
  '复习', '备考', '规划', '计划', '进度', '打卡', '真题', '模拟',
  '肖秀荣', '张宇', '汤家凤', '李永乐', '腿姐', '徐涛', '唐迟', '刘晓艳',
  '大纲', '参考书', '教材', '辅导书', '网课', '视频课',
  '跨考', '二战', '三战', '在职', '辞职考研', '脱产'
];

/** 明显超出考研范围的主题词（用于拒绝回答） */
const OUT_OF_SCOPE_TOPICS = [
  '股票', '基金', '彩票', '赌博', '色情', '暴力', '恐怖', '毒品', '武器',
  '算命', '风水', '星座', '塔罗', '占卜', '鬼神', '宗教极端',
  '黑客', '破解', '盗号', '诈骗', '传销', '洗钱',
  '医疗诊断', '药方', '治病', '手术', '癌症', '肿瘤',
  '法律诉讼', '打官司', '律师费', '赔偿', '离婚', '继承',
  '房地产', '买房', '卖房', '装修', '贷款', '信用卡逾期',
  '育儿', '奶粉', '尿布', '幼儿园', '小学', '中学', '高考', '中考',
  '公务员', '事业编', '教师资格证', '会计证', '驾照', '雅思', '托福', 'GRE', 'GMAT'
];

/** 默认知识库 ID（当 config.freeTutorBaseId 未设置时使用） */
const DEFAULT_BASE_ID = 1;

/** 转化话术模板 */
const CONVERSION_PHRASES = [
  '这个问题在我们的付费课程中有更系统、更深入的讲解，配有配套习题和答疑服务。',
  '付费学员可享受一对一专属解答，老师会根据你的情况给出针对性建议。',
  '如果你想获得更详细的备考方案和全程跟踪指导，可以了解我们的付费课程。',
  '我们的 VIP 学员有专属学习群，老师实时在线答疑，学习资料持续更新。',
  '对于这类个性化问题，建议报名我们的付费课程，获得一对一学习规划服务。'
];

// ── 内部工具 ──

/**
 * 判断用户消息是否包含转人工关键词
 */
function shouldHandoff(message) {
  const lower = message.toLowerCase();
  return HANDOFF_KEYWORDS.some((kw) => lower.includes(kw));
}

/**
 * 判断问题是否明显超出考研范围
 */
function isOutOfScope(message) {
  const lower = message.toLowerCase();
  return OUT_OF_SCOPE_TOPICS.some((topic) => lower.includes(topic));
}

/**
 * 判断问题是否与考研相关（宽松匹配）
 */
function isKaoyanRelated(message) {
  const lower = message.toLowerCase();
  return KAOYAN_TOPICS.some((topic) => lower.includes(topic));
}

/**
 * 随机选择一条转化话术
 */
function pickConversionPhrase() {
  const idx = Math.floor(Math.random() * CONVERSION_PHRASES.length);
  return CONVERSION_PHRASES[idx];
}

/**
 * 构建基于知识库检索结果的系统提示词
 */
function buildRagSystemPrompt(chunks) {
  const context = chunks
    .map((c, i) => `[参考${i + 1}] ${c.content.trim()}`)
    .join('\n\n');

  return `你是一位专业的考研答疑助手。请根据以下知识库内容回答用户问题。如果知识库内容不足以完整回答，可以结合你的知识补充，但必须确保信息准确。

--- 知识库参考 ---
${context}

--- 回答要求 ---
1. 回答简洁明了，控制在 300 字以内；
2. 优先使用知识库内容，标注来源时可用「根据知识库」；
3. 如果涉及具体政策或时间，请提醒用户以官方最新通知为准；
4. 在回答末尾，自然地植入一句转化话术，引导用户了解付费课程（如："这个问题在付费课程中有更详细的讲解"）。`;
}

/**
 * 构建通用答疑系统提示词（无知识库命中时）
 */
function buildGeneralSystemPrompt() {
  return `你是一位专业的考研答疑助手，专注于回答考研政策、考试科目、院校信息、报名流程等基础问题。

回答要求：
1. 回答简洁准确，控制在 300 字以内；
2. 只回答考研相关问题，如果问题明显与考研无关，礼貌拒绝并引导用户咨询考研相关问题；
3. 如果涉及政策或时间，提醒用户以官方最新通知为准；
4. 在回答末尾，自然地植入一句转化话术，引导用户了解付费课程（如："这个问题在付费课程中有更详细的讲解"）。`;
}

/**
 * 构建超范围拒绝回复
 */
function buildOutOfScopeReply() {
  return `抱歉，这个问题超出了免费答疑的范围。我主要负责回答考研政策、考试科目、院校信息、报名流程等基础问题。

如果你有考研相关的问题，欢迎继续提问！如果想获得更深入、更个性化的解答，可以了解我们的付费课程，享受一对一专属答疑服务。`;
}

/**
 * 构建转人工引导回复
 */
function buildHandoffReply(baseReply = '') {
  const handoffText = '\n\n---\n如果你希望获得更深入、更个性化的解答，欢迎联系我们的课程顾问，了解付费课程详情。我们的专业老师会根据你的情况制定专属学习方案，并提供一对一答疑服务。回复「人工」或直接咨询报名即可。';
  return baseReply ? baseReply + handoffText : handoffText.trim();
}

// ── 核心处理函数 ──

/**
 * 处理免费答疑消息
 * @param {Object} params
 * @param {string} params.userId - 用户唯一标识
 * @param {string} params.message - 用户消息内容
 * @param {string} [params.source='wecom'] - 消息来源（wecom / webhook / api）
 * @param {string|null} [params.groupId=null] - 群组 ID（如有）
 * @param {Object} [params.config={}] - 额外配置（可覆盖默认行为）
 * @returns {Promise<{reply: string, handoff: boolean, action: string|null}>}
 */
async function handleMessage({ userId, message, source = 'wecom', groupId = null, config: userConfig = {} }) {
  if (!userId || !message) {
    throw new Error('userId 和 message 为必填参数');
  }

  const trimmedMessage = message.trim();
  const baseId = userConfig.freeTutorBaseId || config.freeTutorBaseId || DEFAULT_BASE_ID;

  let reply = '';
  let handoff = false;
  let action = null;

  // 1. 判断是否转人工
  if (shouldHandoff(trimmedMessage)) {
    handoff = true;
    reply = buildHandoffReply();
    // 记录对话并提前返回
    await recordConversation(userId, trimmedMessage, reply, handoff, source);
    return { reply, handoff, action: 'handoff' };
  }

  // 2. 判断是否超出考研范围
  if (isOutOfScope(trimmedMessage)) {
    reply = buildOutOfScopeReply();
    await recordConversation(userId, trimmedMessage, reply, handoff, source);
    return { reply, handoff, action: 'out_of_scope' };
  }

  // 3. 尝试知识库检索（优先向量语义搜索，无向量时回退关键词）
  let ragChunks = [];
  try {
    ragChunks = await searchByVector(baseId, trimmedMessage, 3);
  } catch (err) {
    console.error('[freeTutorBot] 知识库检索失败:', err.message);
    // 检索失败不影响后续流程，降级到 AI 直接回答
  }

  // 4. 生成回答
  try {
    if (ragChunks && ragChunks.length > 0) {
      // 命中知识库，用 RAG 方式回答
      const systemPrompt = buildRagSystemPrompt(ragChunks);
      reply = await quickAsk(trimmedMessage, systemPrompt, { maxTokens: 800, temperature: 0.5 });
    } else {
      // 未命中知识库，用通用提示词
      // 如果问题与考研明显无关，直接拒绝
      if (!isKaoyanRelated(trimmedMessage) && trimmedMessage.length > 4) {
        reply = buildOutOfScopeReply();
        await recordConversation(userId, trimmedMessage, reply, handoff, source);
        return { reply, handoff, action: 'out_of_scope' };
      }

      const systemPrompt = buildGeneralSystemPrompt();
      reply = await quickAsk(trimmedMessage, systemPrompt, { maxTokens: 800, temperature: 0.5 });
    }
  } catch (err) {
    console.error('[freeTutorBot] AI 生成回答失败:', err.message);
    reply = '抱歉，我暂时无法回答这个问题，请稍后再试。如果问题紧急，可以联系人工客服。';
    handoff = true;
    action = 'handoff';
  }

  // 5. 确保回答中包含转化话术（如果 AI 没有生成，则追加）
  if (!handoff && !reply.includes('付费')) {
    const phrase = pickConversionPhrase();
    reply += `\n\n💡 ${phrase}`;
  }

  // 6. 如果问题复杂或表露报班意向，标记转人工
  const lowerReply = reply.toLowerCase();
  const complexIndicators = ['建议报名', '需要个性化', '具体情况', '一对一', '详细规划', '专属方案'];
  const isComplex = complexIndicators.some((ind) => lowerReply.includes(ind));
  if (isComplex && !handoff) {
    handoff = true;
    action = 'suggest_handoff';
    reply = buildHandoffReply(reply);
  }

  // 7. 记录对话
  await recordConversation(userId, trimmedMessage, reply, handoff, source);

  return { reply, handoff, action };
}

/**
 * 记录对话日志（内部辅助）
 */
async function recordConversation(userId, prompt, response, handoff, source) {
  try {
    await logConversation({
      userId,
      botCode: 'free_tutor',
      type: 'tutor',
      prompt,
      response,
      context: JSON.stringify({ source, handoff, timestamp: Date.now() })
    });
  } catch (err) {
    console.error('[freeTutorBot] 记录对话失败:', err.message);
    // 记录失败不影响主流程
  }
}

// ── 导出 ──

module.exports = {
  handleMessage
};
