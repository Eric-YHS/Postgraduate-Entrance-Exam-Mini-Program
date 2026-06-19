/**
 * 免费答疑机器人（引流转化）
 * 处理考研基础问题的免费答疑，并在适当时机植入转化话术
 */

const { quickAsk } = require('../ai');
const { searchByVector } = require('../knowledgeBase');
const { logConversation } = require('../botManager');
const { startHandoff, notifyHumanAgents, isHandedOff } = require('./humanHandoff');
const { db } = require('../../db');
const config = require('../../config');

// ── 常量 ──

/** 转人工关键词 */
const HANDOFF_KEYWORDS = ['人工', '客服', '转人工', '人工客服', '找老师', '找顾问'];

/** 报班/付费意向关键词 */
const ENROLLMENT_KEYWORDS = ['报班', '报名', '付费', '课程咨询', '多少钱', '价格', '费用', '学费', '怎么报名', '怎么付费', '想报班', '想报名', '报个名', '报个班', '课程价格', '课程费用', '报什么班', '推荐课程', '有什么课', '课程介绍', 'VIP', 'vip', '一对一', '1对1'];

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

/** 预设 FAQ 答案（常见考研基础问题） */
const FAQ_MAP = {
  '考研报名时间': '考研报名分为预报名和正式报名。预报名一般在 9 月下旬（应届生可参加），正式报名在 10 月。报名网站为中国研究生招生信息网（研招网）。',
  '考研考试时间': '全国硕士研究生招生考试初试通常在每年 12 月倒数第二个周末举行。具体日期以教育部当年公布为准。',
  '国家线什么时候出': '考研国家线一般在次年 3 月中旬公布，34 所自划线院校会稍早一些。',
  '什么是国家线': '国家线是全国统一的最低复试分数线，分为 A 区和 B 区。只有总分和单科都过线，才有资格参加复试或调剂。',
  '什么是自划线': '自划线是指 34 所 985 高校有权自主划定复试分数线，通常高于国家线。这些学校的分数线公布时间也较早。',
  '学硕和专硕区别': '学硕侧重学术研究，学制一般 3 年，适合想读博或从事科研的同学；专硕侧重实践应用，学制一般 2-3 年，更适合直接就业。',
  '全日制和非全日制': '全日制需脱产在校学习，有奖学金；非全日制可边工作边读，一般周末或集中授课，学费较高，通常无奖学金。两者证书法律效力相同。',
  '考研科目有哪些': '大部分专业考四门：政治（100 分）、外语（100 分）、数学/专业基础（150 分）、专业课（150 分）。不考数学的专业考两门专业课。',
  '数一和数二区别': '数一考高等数学、线性代数、概率论与数理统计，内容最多，理工学硕一般考数一；数二只考高等数学和线性代数，不考概率，专硕或部分工学考数二。',
  '英一和英二区别': '英一难度较高，学硕一般考英一；英二相对简单，专硕一般考英二。两者题型类似，但英一阅读理解和写作要求更高。',
  '政治考什么': '政治考五部分：马克思主义基本原理（马原）、毛泽东思想和中国特色社会主义理论体系（毛中特）、中国近现代史纲要（史纲）、思想道德与法治（思修）、形势与政策（时政）。',
  '考研大纲什么时候出': '考研大纲一般在 9 月发布，包括公共课大纲和统考专业课大纲。自主命题专业课大纲由各校自行发布。',
  '什么是调剂': '调剂是指初试成绩过国家线但未被一志愿录取的考生，可以申请其他有缺额的院校或专业。调剂系统一般在 3 月底至 4 月开放。',
  '二战怎么报名': '二战（往届生）报名与应届生流程相同，但需选择户口所在地或工作地作为报考点，并按要求提供相关证明材料。',
  '在职考研': '在职考研可以选择非全日制研究生，或报考全日制但需协调工作与学习时间。非全日制一般周末或集中授课，适合在职人员。',
  '跨专业考研': '跨专业考研是允许的，但需提前了解目标专业的考试科目和参考书目，理工科跨考文科相对容易，反之难度较大。',
  '考研复试考什么': '复试一般包括专业课笔试、综合面试、英语口语/听力测试。部分专业还有实践操作。具体以各校公布为准。',
  '准考证怎么打印': '准考证一般在考前 10 天左右开放打印，登录研招网下载 PDF 后打印即可。建议多打印几份备用。',
  '考研总分多少': '考研初试总分 500 分（政治 100 + 外语 100 + 业务课一 150 + 业务课二 150）。管理类联考等部分专业总分 300 分。',
  '怎么选院校': '选院校需综合考虑：自身实力、院校层次、专业排名、地域偏好、报录比、复试分数线等。建议先确定专业方向，再筛选 3-5 所目标院校。'
};

// ── 内部工具 ──

/**
 * 判断用户消息是否包含转人工关键词
 */
function shouldHandoff(message) {
  const lower = message.toLowerCase();
  return HANDOFF_KEYWORDS.some((kw) => lower.includes(kw));
}

/**
 * 判断用户消息是否表露报班/付费意向
 */
function hasEnrollmentIntent(message) {
  const lower = message.toLowerCase();
  return ENROLLMENT_KEYWORDS.some((kw) => lower.includes(kw));
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
 * 尝试 FAQ 关键词匹配
 * 返回匹配到的 FAQ 答案或 null
 */
function matchFaq(message) {
  const lower = message.toLowerCase();
  // 直接关键词匹配
  for (const [key, answer] of Object.entries(FAQ_MAP)) {
    if (lower.includes(key.toLowerCase())) {
      return answer;
    }
  }
  // 模糊匹配：检查消息中是否包含 FAQ 关键词的核心部分
  const faqKeywords = {
    '报名': '考研报名时间',
    '考试时间': '考研考试时间',
    '什么时候考': '考研考试时间',
    '国家线': '什么是国家线',
    '自划线': '什么是自划线',
    '学硕': '学硕和专硕区别',
    '专硕': '学硕和专硕区别',
    '全日制': '全日制和非全日制',
    '非全日制': '全日制和非全日制',
    '科目': '考研科目有哪些',
    '考什么': '考研科目有哪些',
    '数一': '数一和数二区别',
    '数二': '数一和数二区别',
    '英一': '英一和英二区别',
    '英二': '英一和英二区别',
    '政治': '政治考什么',
    '大纲': '考研大纲什么时候出',
    '调剂': '什么是调剂',
    '二战': '二战怎么报名',
    '在职': '在职考研',
    '跨专业': '跨专业考研',
    '复试': '考研复试考什么',
    '准考证': '准考证怎么打印',
    '总分': '考研总分多少',
    '选院校': '怎么选院校',
    '择校': '怎么选院校'
  };
  for (const [kw, faqKey] of Object.entries(faqKeywords)) {
    if (lower.includes(kw.toLowerCase())) {
      return FAQ_MAP[faqKey] || null;
    }
  }
  return null;
}

/**
 * 从 knowledge_chunks 表做简单文本 LIKE 匹配
 * 返回最相关的 chunk 内容或空字符串
 */
function searchKnowledgeChunks(baseId, message, topK = 3) {
  try {
    const queryTokens = message
      .toLowerCase()
      .replace(/[^一-龥a-z0-9]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length >= 2);

    if (!queryTokens.length) {
      // 如果分词后没有有效 token，尝试直接用原始查询
      queryTokens.push(message.trim().toLowerCase());
    }

    const conditions = queryTokens.map(() => '(kc.content LIKE ? OR kc.keywords LIKE ?)').join(' OR ');
    const params = [];
    for (const token of queryTokens) {
      params.push(`%${token}%`, `%${token}%`);
    }
    params.push(baseId, topK);

    const rows = db.prepare(`
      SELECT kc.content, kc.keywords
      FROM knowledge_chunks kc
      WHERE (${conditions}) AND kc.base_id = ?
      ORDER BY kc.created_at DESC
      LIMIT ?
    `).all(...params);

    if (!rows || !rows.length) {
      return '';
    }

    // 拼接 chunk 内容，去重
    const contents = [];
    const seen = new Set();
    for (const row of rows) {
      const content = row.content?.trim();
      if (content && !seen.has(content)) {
        seen.add(content);
        contents.push(content);
      }
    }
    return contents.join('\n\n');
  } catch (err) {
    console.error('[freeTutorBot] 知识库 LIKE 匹配失败:', err.message);
    return '';
  }
}

/**
 * 构建基于知识库检索结果的系统提示词
 * @param {Array} chunks - 知识库检索结果
 * @param {string} [groupContext=''] - 群聊上下文（STM + LTM + Profile）
 */
function buildRagSystemPrompt(chunks, groupContext = '') {
  const context = chunks
    .map((c, i) => `[参考${i + 1}] ${c.content.trim()}`)
    .join('\n\n');

  const groupContextBlock = groupContext
    ? `${groupContext}\n\n---\n\n`
    : '';

  return `${groupContextBlock}你是一位正在和学生微信聊天的考研学长/学姐。你本人就是考研过来人，对考研政策、备考方法非常熟悉。你在聊天中看到了以下参考资料，请用这些资料来回答学生的问题。

参考资料：
${context}

聊天风格要求：
1. 像朋友聊天一样自然回复，用"你"称呼对方，语言温暖亲切；
2. 回答简洁，控制在 300 字以内，像微信消息一样分段短小；
3. 绝对不要提"知识库"、"资料库"、"系统"、"数据库"这些词——你是在用自己的知识和经验回答；
4. 不要标注参考来源、不要编号、不要用"根据XX"这类正式句式；
5. 如果涉及政策或时间，自然地提醒一句"不过具体还是要看官网最新通知哦"；
6. 如果参考资料不够回答，就用你自己的知识补充，保持自然；
7. 在回答末尾，像朋友推荐一样自然地提一句付费课程（参考句式："对了，这个问题在我们的付费课程里有更详细的讲解，还有配套练习～"），不要生硬推销。`;
}

/**
 * 构建通用答疑系统提示词（无知识库命中时）
 * @param {string} [groupContext=''] - 群聊上下文（STM + LTM + Profile）
 */
function buildGeneralSystemPrompt(groupContext = '') {
  const groupContextBlock = groupContext
    ? `${groupContext}\n\n---\n\n`
    : '';

  return `${groupContextBlock}你是一位正在和学生微信聊天的考研学长/学姐。你本人就是考研过来人，对考研政策、考试科目、院校信息、报名流程这些都非常了解。

聊天风格要求：
1. 像朋友一样自然回复，用"你"称呼对方，语气温暖亲切、轻松自然；
2. 回答简洁明了，控制在 300 字以内，像微信消息一样短小分段；
3. 绝对不要提"知识库"、"资料库"、"系统"、"数据库"这些词——你就是在用自己的经验聊天；
4. 只回答考研相关的问题，如果明显不相关，就笑着说不擅长这个，引导回考研话题；
5. 如果涉及政策或时间，自然加一句"具体还是要看官网最新通知哦"；
6. 在回答末尾，像朋友推荐一样自然地提一句付费课程（参考句式："对了，这个问题在付费课程里有更详细的讲解和配套练习～"），不要生硬推销。`;
}

/**
 * 构建超范围拒绝回复
 */
function buildOutOfScopeReply() {
  return `抱歉，这个问题超出了免费答疑的范围。我主要负责回答考研政策、考试科目、院校信息、报名流程等基础问题。

如果你有考研相关的问题，欢迎继续提问！如果想获得更深入、更个性化的解答，可以了解我们的付费课程，享受一对一专属答疑服务。`;
}

/**
 * 构建转化引导回复（报班意向）
 */
function buildConversionReply() {
  return `你好！看来你对我们的课程很感兴趣。我们提供多种考研辅导课程，包括：

- VIP 全程班：系统课程 + 一对一答疑 + 学习规划
- 单科强化班：数学/英语/政治专项突破
- 冲刺押题班：考前重点梳理 + 模拟测试

具体课程内容和价格，建议联系我们的课程顾问老师，会根据你的情况推荐最适合的方案。

你可以回复「人工」直接联系顾问老师，或访问我们的课程商城了解更多详情。`;
}

/**
 * 构建转人工引导回复
 */
function buildHandoffReply(baseReply = '') {
  const handoffText = '\n\n---\n如果你希望获得更深入、更个性化的解答，欢迎联系我们的课程顾问，了解付费课程详情。我们的专业老师会根据你的情况制定专属学习方案，并提供一对一答疑服务。回复「人工」或直接咨询报名即可。';
  return baseReply ? baseReply + handoffText : handoffText.trim();
}

/**
 * 调用人工转接
 */
async function handoffToHuman(userId, message, source) {
  try {
    const result = startHandoff(db, userId, source, null, message);
    if (result.success) {
      await notifyHumanAgents(db, userId, message, source);
    }
    return result;
  } catch (err) {
    console.error('[freeTutorBot] 人工转接失败:', err.message);
    return { success: false, message: err.message };
  }
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
  const groupContext = userConfig.groupContext || '';

  let reply = '';
  let handoff = false;
  let action = null;

  // 0. 检查是否已处于人工接管状态
  if (isHandedOff(userId)) {
    reply = '已转接人工客服，请稍候。';
    await recordConversation(userId, trimmedMessage, reply, false, source, 'already_handed_off');
    return { reply, handoff: false, action: 'already_handed_off' };
  }

  // 1. 判断是否转人工（包含"人工"、"客服"等关键词）
  if (shouldHandoff(trimmedMessage)) {
    handoff = true;
    action = 'handoff';
    reply = '已为你转接人工客服，课程顾问老师会尽快与你联系，请稍等。';
    await handoffToHuman(userId, trimmedMessage, source);
    await recordConversation(userId, trimmedMessage, reply, handoff, source, action);
    return { reply, handoff, action };
  }

  // 2. 判断是否表露报班/付费意向
  if (hasEnrollmentIntent(trimmedMessage)) {
    reply = buildConversionReply();
    handoff = true;
    action = 'suggest_handoff';
    await handoffToHuman(userId, trimmedMessage, source);
    await recordConversation(userId, trimmedMessage, reply, handoff, source, action);
    return { reply, handoff, action };
  }

  // 3. 判断是否超出考研范围
  if (isOutOfScope(trimmedMessage)) {
    reply = buildOutOfScopeReply();
    await recordConversation(userId, trimmedMessage, reply, handoff, source, 'out_of_scope');
    return { reply, handoff, action: 'out_of_scope' };
  }

  // 4. 尝试 FAQ 匹配（优先预设答案）
  const faqAnswer = matchFaq(trimmedMessage);
  if (faqAnswer) {
    reply = faqAnswer + '\n\n💡 ' + pickConversionPhrase();
    await recordConversation(userId, trimmedMessage, reply, handoff, source, 'faq');
    return { reply, handoff, action: 'faq' };
  }

  // 5. 尝试知识库检索（优先向量语义搜索，无向量时回退关键词 LIKE 匹配）
  let ragChunks = [];
  try {
    ragChunks = await searchByVector(baseId, trimmedMessage, 3);
  } catch (err) {
    console.error('[freeTutorBot] 知识库向量检索失败:', err.message);
    // 向量检索失败，尝试朴素 LIKE 匹配
  }

  // 如果向量检索无结果，尝试 LIKE 匹配
  if (!ragChunks || ragChunks.length === 0) {
    const likeContent = searchKnowledgeChunks(baseId, trimmedMessage, 3);
    if (likeContent) {
      // 将 LIKE 匹配结果包装成 chunk 格式
      ragChunks = [{ content: likeContent }];
    }
  }

  // 6. 生成回答
  try {
    if (ragChunks && ragChunks.length > 0) {
      // 命中知识库，用 RAG 方式回答
      const systemPrompt = buildRagSystemPrompt(ragChunks, groupContext);
      reply = await quickAsk(trimmedMessage, systemPrompt, { maxTokens: 800, temperature: 0.5 });
    } else {
      // 未命中知识库，用通用提示词
      // 如果问题与考研明显无关，直接拒绝
      if (!isKaoyanRelated(trimmedMessage) && trimmedMessage.length > 4) {
        reply = buildOutOfScopeReply();
        await recordConversation(userId, trimmedMessage, reply, handoff, source, 'out_of_scope');
        return { reply, handoff, action: 'out_of_scope' };
      }

      const systemPrompt = buildGeneralSystemPrompt(groupContext);
      reply = await quickAsk(trimmedMessage, systemPrompt, { maxTokens: 800, temperature: 0.5 });
    }
  } catch (err) {
    console.error('[freeTutorBot] AI 生成回答失败:', err.message);
    reply = '抱歉，我暂时无法回答这个问题，请稍后再试。如果问题紧急，可以回复「人工」联系客服。';
    handoff = false;
    action = 'ai_error';
  }

  // 7. 确保回答中包含转化话术（如果 AI 没有生成，则追加）
  if (!handoff && !reply.includes('付费')) {
    const phrase = pickConversionPhrase();
    reply += `\n\n💡 ${phrase}`;
  }

  // 8. 如果问题复杂或表露报班意向，标记转人工
  const lowerReply = reply.toLowerCase();
  const complexIndicators = ['建议报名', '需要个性化', '具体情况', '一对一', '详细规划', '专属方案'];
  const isComplex = complexIndicators.some((ind) => lowerReply.includes(ind));
  if (isComplex && !handoff) {
    handoff = true;
    action = 'suggest_handoff';
    reply = buildHandoffReply(reply);
  }

  // 9. 记录对话（type='free_tutor'）
  await recordConversation(userId, trimmedMessage, reply, handoff, source, action);

  return { reply, handoff, action };
}

/**
 * 记录对话日志（内部辅助）
 * 写入 ai_conversations 表，type='free_tutor'
 */
async function recordConversation(userId, prompt, response, handoff, source, action) {
  try {
    await logConversation({
      userId,
      botCode: 'free_tutor',
      type: 'free_tutor',
      prompt,
      response,
      context: JSON.stringify({ source, handoff, action, timestamp: Date.now() })
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
