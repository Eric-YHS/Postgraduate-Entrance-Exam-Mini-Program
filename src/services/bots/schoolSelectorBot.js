/**
 * 择校机器人（School Selector Bot）
 * 职责：根据学生成绩、目标、偏好，结合院校分数线、招生简章等知识库资料，提供择校建议
 *
 * 依赖：
 *   - knowledgeBase.searchChunks  (知识库检索)
 *   - ai.chat / ai.quickAsk       (AI 对话生成)
 *   - botManager.logConversation / botManager.getBotByCode('school_selector')  (对话记录)
 *   - config                      (配置读取)
 */

const { searchByVector } = require('../knowledgeBase');
const { chat, quickAsk } = require('../ai');
const { logConversation, getBotByCode } = require('../botManager');
const config = require('../../config');

// ── 常量 ──

const BOT_CODE = 'school_selector';
const CONVERSATION_TYPE = 'advisor';
const RAG_TOP_K = 5;
const RAG_SCORE_THRESHOLD = 0.5;
const MAX_CONTEXT_MESSAGES = 10;

// 系统提示词：择校专家角色
const SYSTEM_PROMPT_SCHOOL_SELECTOR = `你是一位资深考研择校顾问，擅长根据学生的成绩、目标、地域偏好等，推荐合适的院校和专业。
回答要求：
1. 分析学生的成绩水平和目标院校层次的匹配度
2. 结合分数线、招生人数、报录比等数据给出具体建议
3. 对冲刺、稳妥、保底三个层次分别推荐院校
4. 提醒学生关注最新招生简章和复试政策
5. 语言亲切专业，适合考研学生理解`;

// 系统提示词：联网搜索辅助
const SYSTEM_PROMPT_WITH_SEARCH = `你是一位资深考研择校顾问。用户的问题涉及可能随时间变化的招生信息（如最新分数线、招生简章、专业目录调整等）。
以下提供了联网搜索获取的最新信息片段，请结合这些信息给出准确回答。
如果搜索信息不足，请明确告知用户"信息可能不是最新的"，并建议用户查阅官方渠道。`;

// ── 意图识别规则 ──

// 意图类型枚举
const INTENT_TYPES = {
  RECOMMEND_SCHOOL: 'recommend_school',      // 推荐学校
  SCORELINE_QUERY: 'scoreline_query',         // 分数线查询
  MAJOR_RANKING: 'major_ranking',             // 专业排名/学科评估
  ADMISSION_BROCHURE: 'admission_brochure',   // 招生简章
  SCHOOL_INFO: 'school_info',                 // 院校基本信息
  MAJOR_DIRECTORY: 'major_directory',         // 专业目录
  ADMISSION_PLAN: 'admission_plan',           // 招生计划/人数
  RETEST_POLICY: 'retest_policy',             // 复试政策
  TUTOR_INFO: 'tutor_info',                   // 导师信息
  COMPARE_SCHOOLS: 'compare_schools',         // 院校对比
  APPLY_STRATEGY: 'apply_strategy',           // 报考策略
  UNKNOWN: 'unknown'
};

// 意图识别关键词映射（按优先级排序，先匹配的先命中）
const INTENT_KEYWORDS = [
  {
    intent: INTENT_TYPES.RECOMMEND_SCHOOL,
    patterns: [
      /推荐.{0,5}(学校|院校|大学|专业|方向)/,
      /(适合|匹配|选).{0,5}(学校|院校|大学|专业)/,
      /(冲|稳|保).{0,3}(学校|院校|大学)/,
      /择校|选校|报哪|考哪|考什么学校/,
      /帮我.{0,3}(选|挑|找).{0,3}(学校|院校|大学)/
    ]
  },
  {
    intent: INTENT_TYPES.SCORELINE_QUERY,
    patterns: [
      /(复试|录取|国家|自划线|校线|院线).{0,3}(分数|线|分)/,
      /分数线|录取线|复试线|国家线|自划线/,
      /多少分.{0,3}(能|可以|够).{0,3}(上|考|进)/,
      /(XX|某).{0,2}大学.{0,3}(分数|线|分)/,
      /历年分数|往年分数|近年分数/
    ]
  },
  {
    intent: INTENT_TYPES.MAJOR_RANKING,
    patterns: [
      /专业排名|学科评估|学科排名|专业实力/,
      /(哪个|哪所).{0,3}(学校|大学).{0,3}(专业|学科).{0,3}(好|强|厉害)/,
      /(A\+|A|B\+|B|C).{0,2}类学科/,
      /双一流|985|211.{0,3}(专业|学科)/
    ]
  },
  {
    intent: INTENT_TYPES.ADMISSION_BROCHURE,
    patterns: [
      /招生简章|招生目录|招生公告|招生通知/,
      /(今年|最新|202[4-9]).{0,3}招生/,
      /招生.{0,3}(条件|要求|资格|限制)/
    ]
  },
  {
    intent: INTENT_TYPES.MAJOR_DIRECTORY,
    patterns: [
      /专业目录|招生专业|开设专业|有哪些专业/,
      /(招|有).{0,3}什么.{0,3}专业/,
      /(XX|某).{0,2}专业.{0,3}(招|收).{0,3}吗/
    ]
  },
  {
    intent: INTENT_TYPES.ADMISSION_PLAN,
    patterns: [
      /招生人数|招生计划|招多少人|录取人数|报录比/,
      /(推免|保研).{0,3}人数|推免比例|保研名额/,
      /统考.{0,3}(名额|人数|计划)/
    ]
  },
  {
    intent: INTENT_TYPES.RETEST_POLICY,
    patterns: [
      /复试.{0,3}(政策|安排|流程|内容|科目|比例|权重)/,
      /(初复试|复试).{0,3}占比|复试权重|复试比例/,
      /调剂.{0,3}(政策|信息|名额|系统)/,
      /面试|笔试|英语口语|综合面试/
    ]
  },
  {
    intent: INTENT_TYPES.TUTOR_INFO,
    patterns: [
      /导师.{0,3}(信息|介绍|情况|方向|推荐)/,
      /(哪个|哪位).{0,3}导师.{0,3}(好|厉害|合适)/,
      /导师.{0,3}(招|收).{0,3}(多少|几个).{0,3}学生/
    ]
  },
  {
    intent: INTENT_TYPES.COMPARE_SCHOOLS,
    patterns: [
      /(对比|比较|vs|VS).{0,3}(学校|院校|大学)/,
      /(A和B|XX和YY).{0,3}(哪个|哪所).{0,3}(好|合适|值得)/,
      /(两所|几个).{0,3}(学校|院校).{0,3}(选|挑)/
    ]
  },
  {
    intent: INTENT_TYPES.APPLY_STRATEGY,
    patterns: [
      /报考.{0,3}(策略|建议|技巧|经验|方法)/,
      /(怎么|如何).{0,3}报考|报名.{0,3}(建议|技巧)/,
      /(第一志愿|志愿|填报).{0,3}(建议|技巧|策略)/
    ]
  },
  {
    intent: INTENT_TYPES.SCHOOL_INFO,
    patterns: [
      /(学校|院校|大学).{0,3}(简介|介绍|情况|怎么样|如何)/,
      /(XX|某).{0,2}大学.{0,3}(怎么样|如何|好不好)/,
      /(地理位置|位置|所在|位于).{0,3}(城市|地区|哪里)/
    ]
  }
];

// 触发联网搜索的实时信息关键词（择校相关）
const REALTIME_KEYWORDS = [
  /分数线|录取线|复试线|国家线|自划线|校线|院线/,
  /招生简章|招生目录|招生计划|招生人数|招生公告/,
  /专业目录|开设专业|新增专业|取消专业|调整专业/,
  /推免|保研|夏令营|预推免|推免比例/,
  /调剂|调剂信息|调剂系统|调剂名额|调剂政策/,
  /复试|面试|笔试|初复试占比|复试科目|复试安排/,
  /202[4-9]|今年|去年|最新|最近|刚刚|新公布|新发布/,
  /报名|现场确认|网上确认|考试时间|考试大纲|预报名/,
  /学费|奖学金|助学金|住宿|学制|年限/,
  /报录比|录取比例|竞争程度|报考人数/
];

// ── 内部工具：意图识别 ──

/**
 * 识别用户问题的意图
 * @param {string} question
 * @returns {{intent:string, confidence:number, matchedPattern:RegExp|null}}
 */
function recognizeIntent(question) {
  const q = (question || '').trim();
  if (!q) {
    return { intent: INTENT_TYPES.UNKNOWN, confidence: 0, matchedPattern: null };
  }

  for (const rule of INTENT_KEYWORDS) {
    for (const pattern of rule.patterns) {
      if (pattern.test(q)) {
        return { intent: rule.intent, confidence: 1, matchedPattern: pattern };
      }
    }
  }

  // 兜底：如果包含"大学/学校/院校/专业"等词，默认归为院校信息查询
  if (/大学|学校|院校|专业|考研|报考/.test(q)) {
    return { intent: INTENT_TYPES.SCHOOL_INFO, confidence: 0.3, matchedPattern: null };
  }

  return { intent: INTENT_TYPES.UNKNOWN, confidence: 0, matchedPattern: null };
}

// ── 内部工具：判断是否需要联网搜索 ──

function needsRealtimeSearch(question) {
  const q = question || '';
  return REALTIME_KEYWORDS.some((pattern) => pattern.test(q));
}

// ── 内部工具：可插拔联网搜索（复用 answerBot 的 searchWeb 思路） ──

/**
 * 联网搜索（可插拔实现）
 * 如配置了 BING_API_KEY 或 SERP_API_KEY 则调用，否则返回空数组
 * @param {string} query
 * @returns {Promise<Array<{title:string, snippet:string, url:string}>>}
 */
async function searchWeb(query) {
  const bingKey = process.env.BING_API_KEY || config.bingApiKey || '';
  const serpKey = process.env.SERP_API_KEY || config.serpApiKey || '';

  // Bing Search API
  if (bingKey) {
    try {
      const https = require('https');
      const encodedQuery = encodeURIComponent(query);
      const url = `https://api.bing.microsoft.com/v7.0/search?q=${encodedQuery}&count=5&mkt=zh-CN`;

      const result = await new Promise((resolve, reject) => {
        https.get(url, { headers: { 'Ocp-Apim-Subscription-Key': bingKey } }, (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            try {
              const data = JSON.parse(Buffer.concat(chunks).toString());
              const items = (data.webPages?.value || []).map((item) => ({
                title: item.name || '',
                snippet: item.snippet || '',
                url: item.url || ''
              }));
              resolve(items);
            } catch (e) {
              reject(e);
            }
          });
          res.on('error', reject);
        }).on('error', reject);
      });

      console.log(`[schoolSelectorBot] Bing 搜索返回 ${result.length} 条结果`);
      return result;
    } catch (err) {
      console.error('[schoolSelectorBot] Bing 搜索失败:', err.message);
      return [];
    }
  }

  // SerpAPI (Google)
  if (serpKey) {
    try {
      const https = require('https');
      const encodedQuery = encodeURIComponent(query);
      const url = `https://serpapi.com/search?engine=google&q=${encodedQuery}&api_key=${serpKey}&hl=zh-CN&num=5`;

      const result = await new Promise((resolve, reject) => {
        https.get(url, (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            try {
              const data = JSON.parse(Buffer.concat(chunks).toString());
              const items = (data.organic_results || []).map((item) => ({
                title: item.title || '',
                snippet: item.snippet || '',
                url: item.link || ''
              }));
              resolve(items);
            } catch (e) {
              reject(e);
            }
          });
          res.on('error', reject);
        }).on('error', reject);
      });

      console.log(`[schoolSelectorBot] SerpAPI 搜索返回 ${result.length} 条结果`);
      return result;
    } catch (err) {
      console.error('[schoolSelectorBot] SerpAPI 搜索失败:', err.message);
      return [];
    }
  }

  // 无搜索配置，返回空
  console.log('[schoolSelectorBot] 未配置搜索 API，跳过联网搜索');
  return [];
}

// ── 内部工具：从 context 或简化获取学生信息 ──

/**
 * 构建学生画像（从 context 或简化推断）
 * 当前简化实现：优先从 context 读取，后续可扩展为查询 users/profile 表
 * @param {Object} context
 * @returns {Object} 学生画像
 */
function buildStudentProfile(context = {}) {
  const profile = {
    targetSchools: context.targetSchools || [],      // 目标院校列表
    targetMajor: context.targetMajor || '',          // 目标专业
    currentScore: context.currentScore || null,       // 当前模考成绩（总分）
    subjectScores: context.subjectScores || {},      // 各科成绩
    preferredRegions: context.preferredRegions || [], // 偏好地域
    schoolLevel: context.schoolLevel || '',         // 期望院校层次（985/211/双非）
    studyType: context.studyType || '',              // 学硕/专硕
    year: context.year || new Date().getFullYear()    // 考研年份
  };

  // 如果 context 中提供了具体成绩信息，在后续提示词中直接使用
  return profile;
}

// ── 内部工具：构建择校专用查询（用于知识库检索） ──

/**
 * 根据意图和用户问题构建优化的知识库查询
 * @param {string} question
 * @param {string} intent
 * @param {Object} profile
 * @returns {string}
 */
function buildSearchQuery(question, intent, profile) {
  let query = question;

  // 根据意图增强查询
  const intentEnhancements = {
    [INTENT_TYPES.RECOMMEND_SCHOOL]: `${question} 院校推荐 考研`,
    [INTENT_TYPES.SCORELINE_QUERY]: `${question} 分数线 录取分数`,
    [INTENT_TYPES.MAJOR_RANKING]: `${question} 学科评估 专业排名`,
    [INTENT_TYPES.ADMISSION_BROCHURE]: `${question} 招生简章`,
    [INTENT_TYPES.MAJOR_DIRECTORY]: `${question} 专业目录 招生专业`,
    [INTENT_TYPES.ADMISSION_PLAN]: `${question} 招生人数 招生计划`,
    [INTENT_TYPES.RETEST_POLICY]: `${question} 复试政策 复试安排`,
    [INTENT_TYPES.TUTOR_INFO]: `${question} 导师信息`,
    [INTENT_TYPES.COMPARE_SCHOOLS]: `${question} 院校对比`,
    [INTENT_TYPES.APPLY_STRATEGY]: `${question} 报考策略`,
    [INTENT_TYPES.SCHOOL_INFO]: `${question} 院校介绍`
  };

  if (intentEnhancements[intent]) {
    query = intentEnhancements[intent];
  }

  // 如果学生有目标专业，加入查询以提升相关性
  if (profile.targetMajor && !query.includes(profile.targetMajor)) {
    query += ` ${profile.targetMajor}`;
  }

  return query.trim();
}

// ── 内部工具：知识库检索 ──

/**
 * 知识库 RAG 检索（择校专用）
 * @param {string} question
 * @param {string} intent
 * @param {Object} profile
 * @param {number} baseId - 知识库 ID（如未提供，使用默认知识库）
 * @returns {Promise<{hit:boolean, answer:string, sources:Array<Object>}>}
 */
async function searchKnowledgeBase(question, intent, profile, baseId = null) {
  const targetBaseId = baseId || 1;
  const searchQuery = buildSearchQuery(question, intent, profile);

  try {
    const results = await searchByVector(targetBaseId, searchQuery, RAG_TOP_K);

    if (!results || results.length === 0) {
      return { hit: false, answer: '', sources: [] };
    }

    // 检查最高分是否达到阈值
    const topScore = results[0].score || 0;
    if (topScore < RAG_SCORE_THRESHOLD) {
      console.log(`[schoolSelectorBot] 知识库最高分 ${topScore} 低于阈值 ${RAG_SCORE_THRESHOLD}，视为未命中`);
      return { hit: false, answer: '', sources: results.slice(0, 3) };
    }

    const sources = results.map((r) => ({
      documentTitle: r.documentTitle || '未知文档',
      chunkIndex: r.chunkIndex,
      score: r.score,
      content: r.content
    }));

    const contextText = results
      .map((r, i) => `[来源${i + 1}] ${r.documentTitle || '未知文档'}:\n${r.content}`)
      .join('\n\n');

    const prompt = `基于以下知识库内容，回答用户的择校相关问题。请直接给出完整、专业的择校建议，并在末尾标注参考来源。

用户问题：${question}

知识库内容：
${contextText}

要求：
1. 综合各来源信息，给出准确、完整的回答
2. 如果涉及分数线、招生人数等数据，请明确说明数据年份
3. 如果不同来源有冲突，以最新或最权威的为准
4. 在回答末尾列出参考来源（文档标题）`;

    const answer = await quickAsk(prompt, SYSTEM_PROMPT_SCHOOL_SELECTOR, { maxTokens: 2000, temperature: 0.3 });

    return {
      hit: true,
      answer,
      sources
    };
  } catch (err) {
    console.error('[schoolSelectorBot] 知识库检索失败:', err.message);
    return { hit: false, answer: '', sources: [] };
  }
}

// ── 内部工具：AI 生成回答 ──

/**
 * AI 生成择校建议
 * @param {string} question
 * @param {string} intent
 * @param {Object} profile
 * @param {Array<{role:string, content:string}>} historyMessages
 * @param {string} [searchContext] - 联网搜索上下文
 * @returns {Promise<string>}
 */
async function generateAnswer(question, intent, profile, historyMessages = [], searchContext = '') {
  const messages = [];

  if (searchContext) {
    messages.push({ role: 'system', content: SYSTEM_PROMPT_WITH_SEARCH });
    messages.push({ role: 'system', content: `搜索信息：\n${searchContext}` });
  } else {
    messages.push({ role: 'system', content: SYSTEM_PROMPT_SCHOOL_SELECTOR });
  }

  // 添加上下文历史
  if (historyMessages && historyMessages.length > 0) {
    const recent = historyMessages.slice(-MAX_CONTEXT_MESSAGES);
    messages.push(...recent);
  }

  // 构建包含学生画像的用户消息
  let userContent = question;

  const profileParts = [];
  if (profile.targetMajor) profileParts.push(`目标专业：${profile.targetMajor}`);
  if (profile.currentScore) profileParts.push(`当前模考总分：${profile.currentScore}`);
  if (Object.keys(profile.subjectScores).length > 0) {
    profileParts.push(`各科成绩：${JSON.stringify(profile.subjectScores)}`);
  }
  if (profile.preferredRegions && profile.preferredRegions.length > 0) {
    profileParts.push(`偏好地域：${profile.preferredRegions.join('、')}`);
  }
  if (profile.schoolLevel) profileParts.push(`期望院校层次：${profile.schoolLevel}`);
  if (profile.studyType) profileParts.push(`学位类型：${profile.studyType}`);
  if (profile.year) profileParts.push(`考研年份：${profile.year}`);

  if (profileParts.length > 0) {
    userContent = `【学生背景】\n${profileParts.join('\n')}\n\n【问题】\n${question}`;
  }

  // 根据意图添加引导提示
  const intentGuidance = {
    [INTENT_TYPES.RECOMMEND_SCHOOL]: '请按冲刺、稳妥、保底三个层次分别推荐院校，并说明理由。',
    [INTENT_TYPES.SCORELINE_QUERY]: '请提供具体的分数线数据，并注明数据年份和来源。',
    [INTENT_TYPES.MAJOR_RANKING]: '请结合学科评估结果给出专业排名信息。',
    [INTENT_TYPES.ADMISSION_BROCHURE]: '请提取招生简章中的关键信息（报考条件、考试科目、学制学费等）。',
    [INTENT_TYPES.MAJOR_DIRECTORY]: '请列出该院校开设的相关专业及考试科目。',
    [INTENT_TYPES.ADMISSION_PLAN]: '请提供招生人数、推免比例、统考名额等具体数据。',
    [INTENT_TYPES.RETEST_POLICY]: '请说明复试形式、内容、占比及注意事项。',
    [INTENT_TYPES.TUTOR_INFO]: '请提供导师研究方向、招生名额等关键信息。',
    [INTENT_TYPES.COMPARE_SCHOOLS]: '请从多个维度对比分析两所（或多所）院校的优劣势。',
    [INTENT_TYPES.APPLY_STRATEGY]: '请给出具体的报考策略建议，包括时间节点和注意事项。',
    [INTENT_TYPES.SCHOOL_INFO]: '请介绍该院校的基本情况、优势学科、地理位置等。'
  };

  if (intentGuidance[intent]) {
    userContent += `\n\n【回答要求】\n${intentGuidance[intent]}`;
  }

  messages.push({ role: 'user', content: userContent });

  try {
    const answer = await chat(messages, { maxTokens: 2500, temperature: 0.6 });
    return answer;
  } catch (err) {
    console.error('[schoolSelectorBot] AI 生成失败:', err.message);
    throw new Error('AI 生成回答失败，请稍后重试');
  }
}

// ── 内部工具：联网搜索层 ──

/**
 * 联网搜索获取最新招生信息
 * @param {string} question
 * @param {string} intent
 * @returns {Promise<{hasResult:boolean, context:string, disclaimer:boolean}>}
 */
async function fetchWebSearch(question, intent) {
  // 根据意图优化搜索查询
  let searchQuery = question;
  const intentQueryMap = {
    [INTENT_TYPES.SCORELINE_QUERY]: `${question} 考研分数线`,
    [INTENT_TYPES.ADMISSION_BROCHURE]: `${question} 招生简章`,
    [INTENT_TYPES.MAJOR_DIRECTORY]: `${question} 专业目录`,
    [INTENT_TYPES.ADMISSION_PLAN]: `${question} 招生计划`,
    [INTENT_TYPES.RETEST_POLICY]: `${question} 复试政策`,
    [INTENT_TYPES.MAJOR_RANKING]: `${question} 学科评估`
  };

  if (intentQueryMap[intent]) {
    searchQuery = intentQueryMap[intent];
  }

  const searchResults = await searchWeb(searchQuery);

  if (!searchResults || searchResults.length === 0) {
    return { hasResult: false, context: '', disclaimer: true };
  }

  const context = searchResults
    .map((r, i) => `[结果${i + 1}] ${r.title}\n${r.snippet}\n来源：${r.url}`)
    .join('\n\n');

  return {
    hasResult: true,
    context,
    disclaimer: false
  };
}

// ── 内部工具：记录对话 ──

function recordConversation(userId, prompt, response, context = '') {
  try {
    logConversation({
      userId,
      botCode: BOT_CODE,
      type: CONVERSATION_TYPE,
      prompt,
      response,
      context
    });
  } catch (err) {
    console.error('[schoolSelectorBot] 记录对话失败:', err.message);
  }
}

// ── 主入口：处理用户问题 ──

/**
 * 处理用户择校问题
 * @param {Object} params
 * @param {string} params.userId        - 用户唯一标识
 * @param {string} params.question      - 用户问题文本
 * @param {Object} [params.context={}]   - 扩展上下文（如历史对话、学生信息等）
 *   @param {Array<string>} [params.context.targetSchools]    - 目标院校列表
 *   @param {string} [params.context.targetMajor]             - 目标专业
 *   @param {number} [params.context.currentScore]          - 当前模考总分
 *   @param {Object} [params.context.subjectScores]           - 各科成绩
 *   @param {Array<string>} [params.context.preferredRegions] - 偏好地域
 *   @param {string} [params.context.schoolLevel]           - 期望院校层次
 *   @param {string} [params.context.studyType]             - 学硕/专硕
 *   @param {number} [params.context.year]                  - 考研年份
 *   @param {Array<{role:string, content:string}>} [params.context.historyMessages] - 历史对话
 *   @param {number} [params.context.baseId]                - 知识库 ID
 * @returns {Promise<{success:boolean, answer:string, intent:string, layer:string, sources:Array, disclaimer:string}>}
 */
async function handleQuestion({ userId, question, context = {} }) {
  if (!userId) {
    throw new Error('userId 为必填项');
  }
  if (!question || !question.trim()) {
    throw new Error('question 为必填项');
  }

  console.log(`[schoolSelectorBot] 收到问题 | 用户: ${userId} | 问题: ${question.slice(0, 50)}...`);

  // 1. 意图识别
  const intentResult = recognizeIntent(question);
  console.log(`[schoolSelectorBot] 意图识别: ${intentResult.intent} (置信度: ${intentResult.confidence})`);

  // 2. 构建学生画像
  const profile = buildStudentProfile(context);

  // 3. 提取历史上下文
  const historyMessages = context.historyMessages || [];
  const baseId = context.baseId || null;

  let finalAnswer = '';
  let usedLayer = '';
  let sources = [];
  let disclaimer = '';

  // ========== 第一层：知识库 RAG ==========
  console.log('[schoolSelectorBot] 尝试第一层：知识库检索...');
  const kbResult = await searchKnowledgeBase(question, intentResult.intent, profile, baseId);

  if (kbResult.hit) {
    finalAnswer = kbResult.answer;
    usedLayer = 'knowledge_base';
    sources = kbResult.sources;
    console.log(`[schoolSelectorBot] 第一层命中，来源: ${sources.map((s) => s.documentTitle).join(', ')}`);
  } else {
    // ========== 第二层/第三层：AI 生成 + 联网搜索 ==========
    console.log('[schoolSelectorBot] 第一层未命中，进入第二层/第三层...');

    // 判断是否需要联网搜索
    const needSearch = needsRealtimeSearch(question);
    let searchContext = '';
    let hasSearchResult = false;

    if (needSearch) {
      console.log('[schoolSelectorBot] 问题涉及实时信息，尝试第三层：联网搜索...');
      const searchResult = await fetchWebSearch(question, intentResult.intent);
      if (searchResult.hasResult) {
        searchContext = searchResult.context;
        hasSearchResult = true;
        console.log(`[schoolSelectorBot] 联网搜索成功，获取 ${searchResult.context.length} 字上下文`);
      } else {
        console.log('[schoolSelectorBot] 联网搜索未返回结果或配置缺失');
      }
    }

    // 调用 AI 生成
    try {
      finalAnswer = await generateAnswer(question, intentResult.intent, profile, historyMessages, searchContext);
      usedLayer = hasSearchResult ? 'ai_with_search' : 'ai';

      // 如果触发了搜索但未获取到结果，添加免责声明
      if (needSearch && !hasSearchResult) {
        disclaimer = '【提示】该问题可能涉及最新招生信息或实时数据，当前未能获取联网数据，以上回答基于已有知识生成，信息可能不是最新的。建议您查阅目标院校官网或研招网确认最新信息。';
      }
    } catch (err) {
      console.error('[schoolSelectorBot] AI 生成失败:', err.message);
      finalAnswer = '抱歉，当前无法生成择校建议，请稍后重试。';
      usedLayer = 'error';
    }
  }

  // 4. 添加免责声明
  let replyContent = finalAnswer;
  if (disclaimer) {
    replyContent += `\n\n${disclaimer}`;
  }

  // 5. 记录对话
  const logContext = JSON.stringify({
    intent: intentResult.intent,
    layer: usedLayer,
    hasProfile: Object.keys(profile).some(k => profile[k] && (Array.isArray(profile[k]) ? profile[k].length > 0 : true)),
    sources: sources.map((s) => s.documentTitle)
  });
  recordConversation(userId, question, finalAnswer, logContext);

  console.log(`[schoolSelectorBot] 回答完成 | 意图: ${intentResult.intent} | 使用层: ${usedLayer} | 用户: ${userId}`);

  return {
    success: usedLayer !== 'error',
    answer: replyContent,
    intent: intentResult.intent,
    layer: usedLayer,
    sources,
    disclaimer
  };
}

// ── 导出 ──

module.exports = {
  handleQuestion,
  recognizeIntent,
  buildStudentProfile,
  searchWeb
};
