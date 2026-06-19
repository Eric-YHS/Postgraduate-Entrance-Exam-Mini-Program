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

const { searchChunks } = require('../knowledgeBase');
const { chat, quickAsk } = require('../ai');
const { logConversation } = require('../botManager');
const { isHandoffRequest, startHandoff, notifyHumanAgents, isHandedOff } = require('./humanHandoff');
const { db } = require('../../db');
const config = require('../../config');

// ── 常量 ──

const BOT_CODE = 'school_selector';
const CONVERSATION_TYPE = 'school_selector';
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

// ── 预设回答模板 ──

const TEMPLATES = {
  // 缺少用户档案时的引导
  missingProfile: {
    recommendSchool: `为了给你更精准的择校建议，我还需要了解一些信息：

1. 你的目标专业是什么？
2. 你目前的模考成绩大约多少分？
3. 你偏好哪些地区或城市？
4. 你期望的院校层次（985/211/双非）？

你可以直接回复，比如："目标计算机，模考340分，想去北京"，我会立刻为你分析！`,

    scorelineQuery: `为了帮你查询更准确的分数线，请告诉我：

1. 你想了解哪所学校的分数线？
2. 你的目标专业是什么？
3. 你目前的成绩水平如何？

这样我可以结合你的情况给出更有针对性的建议。`,

    general: `为了给你更精准的择校建议，我还需要了解一些信息：

1. 你的目标专业是什么？
2. 你目前的模考成绩大约多少分？
3. 你偏好哪些地区或城市？
4. 你期望的院校层次（985/211/双非）？

你可以直接回复，我会立刻为你分析！`
  },

  // 最新招生信息免责声明
  disclaimer: `【温馨提示】以上信息基于知识库中的历史数据整理，最新招生政策、分数线等可能已有调整。建议你在做决定前：
1. 查看目标院校官网研究生院最新公告
2. 关注中国研究生招生信息网（研招网）
3. 如有疑问，可联系我们的老师进一步确认`,

  // 人工转接提示
  handoff: `已为你转接人工客服，老师稍后会联系你。请保持关注，也可以直接拨打我们的咨询电话。`,

  // 知识库未命中时的回复
  noKnowledge: `关于这个问题，我暂时没有足够的数据。不过我可以基于一般经验给你一些建议：

{aiAnswer}

如果你需要更详细、更准确的分析，建议补充你的目标院校和专业信息，或转接人工老师咨询。`
};

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

// ── 内部工具：从数据库获取用户档案 ──

/**
 * 从数据库查询用户档案（users 表）
 * @param {number|string} userId
 * @returns {Object|null} 用户档案
 */
function getUserProfileFromDB(userId) {
  if (!userId) return null;

  try {
    // 尝试获取 users 表中的择校相关字段（通过 ALTER 动态添加的字段）
    const user = db.prepare(
      `SELECT id, username, display_name, target_school, target_major, current_score,
              preferred_region, school_level, study_type, class_name
       FROM users WHERE id = ?`
    ).get(userId);

    if (!user) return null;

    return {
      targetSchools: user.target_school ? [user.target_school] : [],
      targetMajor: user.target_major || '',
      currentScore: user.current_score || null,
      preferredRegions: user.preferred_region ? user.preferred_region.split(/[,，]/).map(s => s.trim()).filter(Boolean) : [],
      schoolLevel: user.school_level || '',
      studyType: user.study_type || '',
      className: user.class_name || '',
      displayName: user.display_name || ''
    };
  } catch (err) {
    // 如果字段不存在（旧表结构），返回 null
    console.warn('[schoolSelectorBot] 获取用户档案失败（可能是字段不存在）:', err.message);
    return null;
  }
}

// ── 内部工具：从 context 或数据库获取学生信息 ──

/**
 * 构建学生画像（优先从数据库获取，其次从 context 读取）
 * @param {Object} context
 * @param {number|string} userId
 * @returns {Object} 学生画像
 */
function buildStudentProfile(context = {}, userId = null) {
  // 优先从数据库获取用户档案
  const dbProfile = userId ? getUserProfileFromDB(userId) : null;

  const profile = {
    targetSchools: dbProfile?.targetSchools || context.targetSchools || [],
    targetMajor: dbProfile?.targetMajor || context.targetMajor || '',
    currentScore: dbProfile?.currentScore || context.currentScore || null,
    subjectScores: context.subjectScores || {},
    preferredRegions: dbProfile?.preferredRegions || context.preferredRegions || [],
    schoolLevel: dbProfile?.schoolLevel || context.schoolLevel || '',
    studyType: dbProfile?.studyType || context.studyType || '',
    year: context.year || new Date().getFullYear(),
    hasProfile: !!(dbProfile && (dbProfile.targetMajor || dbProfile.currentScore))
  };

  return profile;
}

// ── 内部工具：检查用户档案是否完整 ──

/**
 * 检查用户档案是否足够用于择校建议
 * @param {Object} profile
 * @returns {boolean}
 */
function hasEnoughProfile(profile) {
  if (!profile) return false;
  // 至少需要目标专业或当前成绩之一
  return !!(profile.targetMajor || profile.currentScore);
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
    const results = await searchChunks(targetBaseId, searchQuery, RAG_TOP_K);

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

// ── 内部工具：选择引导模板 ──

/**
 * 根据意图选择缺少档案时的引导模板
 * @param {string} intent
 * @returns {string}
 */
function getMissingProfileTemplate(intent) {
  if (intent === INTENT_TYPES.RECOMMEND_SCHOOL) {
    return TEMPLATES.missingProfile.recommendSchool;
  }
  if (intent === INTENT_TYPES.SCORELINE_QUERY) {
    return TEMPLATES.missingProfile.scorelineQuery;
  }
  return TEMPLATES.missingProfile.general;
}

// ── 主入口：处理用户问题（新版 handleMessage） ──

/**
 * 处理用户择校消息（企业微信/小程序统一入口）
 * @param {string} userId - 用户唯一标识（企微 userId 或用户 ID）
 * @param {string} message - 用户消息文本
 * @param {Object} [options={}] - 可选参数
 *   @param {string} [options.source='wecom'] - 来源渠道
 *   @param {number|null} [options.groupId=null] - 企业微信群 ID
 *   @param {Object} [options.context={}] - 扩展上下文
 *   @param {number} [options.baseId] - 知识库 ID
 * @returns {Promise<{reply:string, handoff:boolean, action:string}>}
 */
async function handleMessage(userId, message, options = {}) {
  if (!userId) {
    throw new Error('userId 为必填项');
  }
  if (!message || !message.trim()) {
    throw new Error('message 为必填项');
  }

  const trimmedMessage = message.trim();
  const source = options.source || 'wecom';
  const groupId = options.groupId || null;
  const context = options.context || {};
  const baseId = options.baseId || null;

  console.log(`[schoolSelectorBot] 收到消息 | 用户: ${userId} | 消息: ${trimmedMessage.slice(0, 50)}...`);

  // 0. 检查是否已处于人工接管状态
  if (isHandedOff(userId)) {
    const reply = '已转接人工客服，请稍候。';
    recordConversation(userId, trimmedMessage, reply, JSON.stringify({ intent: 'already_handed_off', source }));
    return { reply, handoff: false, action: 'already_handed_off' };
  }

  // 1. 判断是否转人工
  if (isHandoffRequest(trimmedMessage)) {
    const handoffResult = startHandoff(db, userId, source, groupId, trimmedMessage);
    await notifyHumanAgents(db, userId, trimmedMessage, source);
    const reply = TEMPLATES.handoff;
    recordConversation(userId, trimmedMessage, reply, JSON.stringify({ intent: 'handoff', source, handoff: true }));
    return { reply, handoff: true, action: 'handoff' };
  }

  // 2. 意图识别
  const intentResult = recognizeIntent(trimmedMessage);
  console.log(`[schoolSelectorBot] 意图识别: ${intentResult.intent} (置信度: ${intentResult.confidence})`);

  // 3. 构建学生画像（优先从数据库获取）
  const profile = buildStudentProfile(context, userId);

  // 4. 如果缺少用户档案，引导用户补充（仅对推荐学校、分数线查询等核心意图）
  const coreIntents = [
    INTENT_TYPES.RECOMMEND_SCHOOL,
    INTENT_TYPES.SCORELINE_QUERY,
    INTENT_TYPES.COMPARE_SCHOOLS,
    INTENT_TYPES.APPLY_STRATEGY
  ];

  if (coreIntents.includes(intentResult.intent) && !hasEnoughProfile(profile)) {
    const reply = getMissingProfileTemplate(intentResult.intent);
    recordConversation(userId, trimmedMessage, reply, JSON.stringify({
      intent: intentResult.intent,
      layer: 'profile_guidance',
      missingProfile: true
    }));
    return { reply, handoff: false, action: 'profile_guidance' };
  }

  let finalAnswer = '';
  let usedLayer = '';
  let sources = [];
  let disclaimer = '';

  // 5. 第一层：知识库 RAG 检索
  console.log('[schoolSelectorBot] 尝试第一层：知识库检索...');
  const kbResult = await searchKnowledgeBase(trimmedMessage, intentResult.intent, profile, baseId);

  if (kbResult.hit) {
    finalAnswer = kbResult.answer;
    usedLayer = 'knowledge_base';
    sources = kbResult.sources;
    console.log(`[schoolSelectorBot] 第一层命中，来源: ${sources.map((s) => s.documentTitle).join(', ')}`);
  } else {
    // 6. 第二层/第三层：AI 生成 + 联网搜索
    console.log('[schoolSelectorBot] 第一层未命中，进入第二层/第三层...');

    // 判断是否需要联网搜索
    const needSearch = needsRealtimeSearch(trimmedMessage);
    let searchContext = '';
    let hasSearchResult = false;

    if (needSearch) {
      console.log('[schoolSelectorBot] 问题涉及实时信息，尝试第三层：联网搜索...');
      const searchResult = await fetchWebSearch(trimmedMessage, intentResult.intent);
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
      const historyMessages = context.historyMessages || [];
      finalAnswer = await generateAnswer(trimmedMessage, intentResult.intent, profile, historyMessages, searchContext);
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

  // 7. 对最新招生信息，添加免责声明
  let replyContent = finalAnswer;

  // 如果涉及实时信息（分数线、招生简章等），无论是否命中知识库都添加免责声明
  const realtimeIntents = [
    INTENT_TYPES.SCORELINE_QUERY,
    INTENT_TYPES.ADMISSION_BROCHURE,
    INTENT_TYPES.ADMISSION_PLAN,
    INTENT_TYPES.RETEST_POLICY,
    INTENT_TYPES.MAJOR_DIRECTORY
  ];

  if (realtimeIntents.includes(intentResult.intent) || needsRealtimeSearch(trimmedMessage)) {
    disclaimer = TEMPLATES.disclaimer;
  }

  if (disclaimer) {
    replyContent += `\n\n${disclaimer}`;
  }

  // 8. 记录对话（type='school_selector'）
  const logContext = JSON.stringify({
    intent: intentResult.intent,
    layer: usedLayer,
    hasProfile: hasEnoughProfile(profile),
    sources: sources.map((s) => s.documentTitle),
    source,
    handoff: false
  });
  recordConversation(userId, trimmedMessage, finalAnswer, logContext);

  console.log(`[schoolSelectorBot] 回答完成 | 意图: ${intentResult.intent} | 使用层: ${usedLayer} | 用户: ${userId}`);

  return {
    reply: replyContent,
    handoff: false,
    action: usedLayer === 'error' ? 'error' : 'answer'
  };
}

// ── 兼容旧版 handleQuestion 入口 ──

/**
 * 处理用户择校问题（兼容旧版参数格式）
 * @param {Object} params
 * @param {string} params.userId        - 用户唯一标识
 * @param {string} params.question      - 用户问题文本
 * @param {Object} [params.context={}]   - 扩展上下文
 * @returns {Promise<{success:boolean, answer:string, intent:string, layer:string, sources:Array, disclaimer:string}>}
 */
async function handleQuestion({ userId, question, context = {} }) {
  const result = await handleMessage(userId, question, { context });
  return {
    success: result.action !== 'error',
    answer: result.reply,
    intent: '',
    layer: '',
    sources: [],
    disclaimer: ''
  };
}

// ── 导出 ──

module.exports = {
  handleMessage,
  handleQuestion,
  recognizeIntent,
  buildStudentProfile,
  searchWeb
};
