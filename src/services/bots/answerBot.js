/**
 * 解答机器人（付费群内三层应答）
 * 职责：处理用户问题，通过 知识库检索 → AI生成 → 政策确认/转人工 三层流程提供答案
 *
 * 依赖：
 *   - knowledgeBase.searchChunks      (知识库关键词检索)
 *   - ai.quickAsk / ai.chat           (AI 对话生成)
 *   - botManager.logConversation      (对话记录)
 *   - wecom.sendAppMessage            (消息推送)
 *   - humanHandoff.isHandoffRequest   (转人工判断)
 *   - humanHandoff.startHandoff       (转人工)
 *   - humanHandoff.notifyHumanAgents  (通知人工客服)
 *   - humanHandoff.isInHandoff        (检查是否已在人工接管中)
 *   - config                          (配置读取)
 */

const fs = require('fs');
const path = require('path');
const { searchChunks } = require('../knowledgeBase');
const { quickAsk, chat } = require('../ai');
const { logConversation, getBotByCode } = require('../botManager');
const { sendAppMessage } = require('../wecom');
const {
  isHandoffRequest,
  startHandoff,
  notifyHumanAgents,
  isInHandoff,
  isHandedOff
} = require('./humanHandoff');
const { db } = require('../../db');
const config = require('../../config');

// ── 常量 ──

const BOT_CODE = 'answer';
const CONVERSATION_TYPE = 'answer';
const RAG_TOP_K = 5;                    // 知识库检索返回条数
const RAG_KEYWORD_HIT_THRESHOLD = 2;    // 关键词命中数阈值（命中至少 N 个关键词视为高相关）
const MAX_CONTEXT_MESSAGES = 10;        // 上下文保留的最大消息数

// 系统提示词：解答专家角色
const SYSTEM_PROMPT_ANSWER = `你是一位资深考研辅导专家，擅长解答数学、英语、政治等科目的具体问题。
回答要求：
1. 步骤清晰，逻辑严谨
2. 对易错点给出特别提醒
3. 适当拓展相关知识点
4. 语言通俗易懂，适合考研学生理解`;

// 触发"建议人工确认最新政策"的关键词（分数线、政策、最新等）
const POLICY_KEYWORDS = [
  '分数线', '录取线', '复试线', '国家线', '自划线', '单科线',
  '招生简章', '招生目录', '招生计划', '招生人数',
  '政策', '改革', '调整', '变化', '新规', '新政',
  '报名', '现场确认', '网上确认', '考试时间', '考试大纲',
  '调剂', '调剂信息', '调剂系统', '调剂名额',
  '推免', '保研', '夏令营', '预推免',
  '学费', '奖学金', '助学金', '住宿',
  '2026', '2027', '今年', '去年', '最新', '最近', '刚刚'
];

// ── 内部工具：判断问题是否涉及最新政策/分数线 ──

function isPolicyQuestion(question) {
  const q = (question || '').toLowerCase();
  return POLICY_KEYWORDS.some((kw) => q.includes(kw.toLowerCase()));
}

// ── 内部工具：处理附件 ──

/**
 * 处理附件（图片、文档）
 * @param {Array<string>} attachments - 文件路径数组
 * @returns {Promise<{text:string, notes:Array<string>}>}
 */
// ── 骨架：图片 OCR 识别（待接入第三方服务） ──
async function ocrImage(filePath) {
  // TODO: 接入 OCR 服务（如百度 OCR、腾讯云 OCR、Tesseract.js）
  // 配置后可调用对应 API 提取图片中的文字
  console.log('[answerBot] ocrImage 未配置，文件:', filePath);
  return null;
}

// ── 骨架：语音转文字（待接入第三方服务） ──
async function transcribeAudio(filePath) {
  // TODO: 接入语音识别 API（如百度语音、腾讯云 ASR、Whisper API）
  // 配置后可调用对应 API 将语音转为文本
  console.log('[answerBot] transcribeAudio 未配置，文件:', filePath);
  return null;
}

async function processAttachments(attachments) {
  const notes = [];
  let extractedText = '';

  if (!attachments || attachments.length === 0) {
    return { text: '', notes: [] };
  }

  for (const filePath of attachments) {
    if (!fs.existsSync(filePath)) {
      notes.push(`附件不存在: ${path.basename(filePath)}`);
      continue;
    }

    const ext = path.extname(filePath).toLowerCase();

    // 图片文件
    if (['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.svg'].includes(ext)) {
      try {
        const ocrText = await ocrImage(filePath);
        if (ocrText) {
          extractedText += `\n[图片OCR内容]: ${ocrText}\n`;
          notes.push(`[图片] ${path.basename(filePath)} — OCR 识别成功`);
        } else {
          notes.push(`[图片] ${path.basename(filePath)} — OCR 服务未配置，建议补充文字描述`);
        }
      } catch (e) {
        notes.push(`[图片] ${path.basename(filePath)} — OCR 识别失败: ${e.message}，建议补充文字描述`);
      }
      continue;
    }

    // 文档文件（PDF / Word / 文本）
    if (['.pdf', '.doc', '.docx', '.txt', '.md', '.csv', '.json'].includes(ext)) {
      try {
        const { parseDocument } = require('../knowledgeBase');
        const text = parseDocument(filePath, ext.replace(/^\./, ''));
        if (text && text.trim()) {
          extractedText += `\n[文档 ${path.basename(filePath)} 内容]:\n${text.trim()}\n`;
          notes.push(`[文档] ${path.basename(filePath)} — 已提取 ${text.length} 字`);
        } else {
          notes.push(`[文档] ${path.basename(filePath)} — 未能提取文本（PDF/Word 解析库未安装或文件格式不支持）`);
        }
      } catch (e) {
        notes.push(`[文档] ${path.basename(filePath)} — 提取失败: ${e.message}`);
      }
      continue;
    }

    // 语音文件
    if (['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.amr', '.wma'].includes(ext)) {
      try {
        const speechResult = await transcribeAudio(filePath);
        if (speechResult) {
          extractedText += `\n[语音转文字]: ${speechResult}\n`;
          notes.push(`[语音] ${path.basename(filePath)} — 已转为文字 (${speechResult.length} 字)`);
        } else {
          notes.push(`[语音] ${path.basename(filePath)} — 语音转文字服务未配置，建议补充文字描述`);
        }
      } catch (e) {
        notes.push(`[语音] ${path.basename(filePath)} — 语音转文字失败: ${e.message}，建议补充文字描述`);
      }
      continue;
    }

    notes.push(`[未知类型] ${path.basename(filePath)} — 暂不支持的文件类型`);
  }

  return { text: extractedText.trim(), notes };
}

// ── 内部工具：构建用户消息内容 ──

function buildUserContent(question, attachmentText, attachmentNotes) {
  let content = question || '';

  if (attachmentText) {
    content += `\n\n[附件提取内容]:\n${attachmentText}`;
  }

  if (attachmentNotes && attachmentNotes.length > 0) {
    content += `\n\n[附件处理备注]:\n${attachmentNotes.join('\n')}`;
  }

  return content.trim();
}

// ── 内部工具：知识库检索（第一层） ──

/**
 * 第一层：知识库关键词检索
 * 在 knowledge_chunks 中按关键词/LIKE 匹配，找到最相关片段。
 * 若相似度足够高（按关键词命中数判断），直接返回答案。
 * @param {string} question
 * @param {number} baseId - 知识库 ID（如未提供，使用默认知识库）
 * @returns {Promise<{hit:boolean, answer:string, sources:Array<Object>}>}
 */
async function layer1KnowledgeBase(question, baseId = null) {
  const targetBaseId = baseId || 1;

  try {
    const results = await searchChunks(targetBaseId, question, RAG_TOP_K);

    if (!results || results.length === 0) {
      return { hit: false, answer: '', sources: [] };
    }

    // 计算关键词命中数：将问题分词，统计每个 chunk 命中多少关键词
    const queryTokens = question
      .toLowerCase()
      .replace(/[^一-龥a-z0-9]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length >= 2);

    let maxHits = 0;
    for (const r of results) {
      const contentLower = (r.content || '').toLowerCase();
      const titleLower = (r.documentTitle || '').toLowerCase();
      const keywordsLower = (r.keywords || '').toLowerCase();
      let hits = 0;
      for (const token of queryTokens) {
        if (contentLower.includes(token) || titleLower.includes(token) || keywordsLower.includes(token)) {
          hits++;
        }
      }
      // 标题匹配额外加权
      if (titleLower.includes(question.toLowerCase().substring(0, 10))) {
        hits += 2;
      }
      maxHits = Math.max(maxHits, hits);
    }

    // 如果最高命中数低于阈值，视为未命中
    if (maxHits < RAG_KEYWORD_HIT_THRESHOLD) {
      console.log(`[answerBot] 知识库最高关键词命中数 ${maxHits} 低于阈值 ${RAG_KEYWORD_HIT_THRESHOLD}，视为未命中`);
      return { hit: false, answer: '', sources: results.slice(0, 3) };
    }

    // 构建来源信息
    const sources = results.map((r) => ({
      documentTitle: r.documentTitle || '未知文档',
      chunkIndex: r.chunkIndex,
      score: r.score,
      content: r.content
    }));

    // 将检索到的 chunks 拼接作为上下文，让 AI 整理成流畅回答
    const contextText = results
      .map((r, i) => `[来源${i + 1}] ${r.documentTitle || '未知文档'}:\n${r.content}`)
      .join('\n\n');

    const prompt = `基于以下知识库内容，回答用户问题。请直接给出完整答案，并在末尾标注参考来源。

用户问题：${question}

知识库内容：
${contextText}

要求：
1. 综合各来源信息，给出准确、完整的回答
2. 如果不同来源有冲突，以最新或最权威的为准
3. 在回答末尾列出参考来源（文档标题）`;

    const answer = await quickAsk(prompt, SYSTEM_PROMPT_ANSWER, { maxTokens: 2000, temperature: 0.3 });

    return {
      hit: true,
      answer,
      sources
    };
  } catch (err) {
    console.error('[answerBot] 知识库检索失败:', err.message);
    return { hit: false, answer: '', sources: [] };
  }
}

// ── 内部工具：AI 生成（第二层） ──

/**
 * 第二层：AI 生成回答
 * 未命中知识库时调用大模型 API 生成回答。
 * @param {string} question
 * @param {Array<{role:string, content:string}>} historyMessages
 * @returns {Promise<string>}
 */
async function layer2AIGenerate(question, historyMessages = []) {
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT_ANSWER }
  ];

  // 添加上下文历史（限制条数）
  if (historyMessages && historyMessages.length > 0) {
    const recent = historyMessages.slice(-MAX_CONTEXT_MESSAGES);
    messages.push(...recent);
  }

  messages.push({ role: 'user', content: question });

  try {
    const answer = await chat(messages, { maxTokens: 2000, temperature: 0.7 });
    return answer;
  } catch (err) {
    console.error('[answerBot] AI 生成失败:', err.message);
    // 如果 AI 未配置，返回占位提示（不引入新依赖）
    if (err.message && err.message.includes('未配置')) {
      return '【正在接入大模型】\n\n目前 AI 解答服务正在配置中，您的提问已记录，配置完成后将自动为您提供智能解答。如有紧急问题，请回复「人工」联系老师。';
    }
    throw new Error('AI 生成回答失败，请稍后重试');
  }
}

// ── 内部工具：政策确认/转人工（第三层） ──

/**
 * 联网搜索（从 schoolSelectorBot 移植，Bing/SerpAPI 双引擎）
 * @param {string} query
 * @returns {Promise<Array<{title:string, snippet:string, url:string}>>}
 */
async function searchWeb(query) {
  const bingKey = process.env.BING_API_KEY || config.bingApiKey || '';
  const serpKey = process.env.SERP_API_KEY || config.serpApiKey || '';

  if (bingKey) {
    try {
      const https = require('https');
      const encodedQuery = encodeURIComponent(query);
      const result = await new Promise((resolve, reject) => {
        https.get(
          `https://api.bing.microsoft.com/v7.0/search?q=${encodedQuery}&count=5&mkt=zh-CN`,
          { headers: { 'Ocp-Apim-Subscription-Key': bingKey } },
          (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
              try {
                const data = JSON.parse(Buffer.concat(chunks).toString());
                resolve((data.webPages?.value || []).map((item) => ({
                  title: item.name || '',
                  snippet: item.snippet || '',
                  url: item.url || ''
                })));
              } catch (e) { reject(e); }
            });
            res.on('error', reject);
          }
        ).on('error', reject);
      });
      console.log(`[answerBot] Bing 搜索返回 ${result.length} 条结果`);
      return result;
    } catch (err) {
      console.error('[answerBot] Bing 搜索失败:', err.message);
    }
  }

  if (serpKey) {
    try {
      const https = require('https');
      const encodedQuery = encodeURIComponent(query);
      const result = await new Promise((resolve, reject) => {
        https.get(
          `https://serpapi.com/search?engine=google&q=${encodedQuery}&api_key=${serpKey}&hl=zh-CN&num=5`,
          (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
              try {
                const data = JSON.parse(Buffer.concat(chunks).toString());
                resolve((data.organic_results || []).map((item) => ({
                  title: item.title || '',
                  snippet: item.snippet || '',
                  url: item.link || ''
                })));
              } catch (e) { reject(e); }
            });
            res.on('error', reject);
          }
        ).on('error', reject);
      });
      console.log(`[answerBot] SerpAPI 搜索返回 ${result.length} 条结果`);
      return result;
    } catch (err) {
      console.error('[answerBot] SerpAPI 搜索失败:', err.message);
    }
  }

  console.log('[answerBot] 未配置搜索 API (BING_API_KEY / SERP_API_KEY)，跳过联网搜索');
  return [];
}

/**
 * 第三层：涉及最新政策/分数线时，尝试联网搜索；搜索不可用时转人工
 * @param {string} question
 * @param {number} userId
 * @param {string} source
 * @returns {Promise<{isPolicy:boolean, answer:string, sources:Array}>}
 */
async function layer3WebSearch(question, userId, source = 'wecom') {
  if (!isPolicyQuestion(question)) {
    return { isPolicy: false, answer: '', sources: [] };
  }

  console.log('[answerBot] 检测到政策/分数线问题，尝试联网搜索...');

  try {
    const searchResults = await searchWeb(question);
    if (searchResults.length > 0) {
      const context = searchResults.map((r, i) =>
        `[搜索结果${i + 1}] 标题: ${r.title}\n内容: ${r.snippet}\n来源: ${r.url}`
      ).join('\n\n');

      const prompt = `基于以下联网搜索的最新信息，回答用户问题。请注意：
1. 优先使用搜索结果中的最新数据
2. 如搜索结果信息不充分，请告知用户
3. 在回答末尾标注信息来源

搜索结果：
${context}

用户问题：${question}`;

      const answer = await quickAsk(prompt, SYSTEM_PROMPT_ANSWER, { maxTokens: 2000, temperature: 0.3 });

      return {
        isPolicy: true,
        answer: answer + '\n\n---\n*信息来源于联网搜索，仅供参考，请以官方最新公告为准。*',
        sources: searchResults.map((r) => ({ documentTitle: r.title, url: r.url }))
      };
    }
  } catch (err) {
    console.error('[answerBot] 联网搜索失败:', err.message);
  }

  // 搜索不可用：转人工客服
  const policyReply = '【联网搜索不可用，已为您转接人工客服】\n\n您的问题涉及最新政策或分数线信息，已转接人工客服确认，老师将尽快回复。';
  try {
    startHandoff(db, userId, source, null, question);
    await notifyHumanAgents(db, userId, question, source);
  } catch (err) {
    console.error('[answerBot] 转人工失败:', err.message);
  }

  return { isPolicy: true, answer: policyReply, sources: [] };
}

// ── 内部工具：发送回复 ──

async function sendReply(userId, content, source) {
  const bot = getBotByCode(BOT_CODE);
  const botName = bot?.name || '解答专家';
  const fullContent = `${botName}：\n${content}`;

  if (source === 'wecom') {
    const payload = {
      touser: userId,
      msgtype: 'text',
      text: { content: fullContent }
    };
    await sendAppMessage(payload);
  } else if (source === 'webhook') {
    // 企业微信群机器人 Webhook —— 通过调用方处理
    console.log(`[answerBot] Webhook 消息（用户 ${userId}）: ${content.slice(0, 100)}...`);
  } else if (source === 'miniapp') {
    console.log(`[answerBot] 小程序消息（用户 ${userId}）: ${content.slice(0, 100)}...`);
  } else {
    console.log(`[answerBot] 未知来源 ${source}，仅记录不发送`);
  }
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
    console.error('[answerBot] 记录对话失败:', err.message);
  }
}

// ── 主入口：处理用户消息 ──

/**
 * 处理用户消息（三层应答）
 * @param {string} userId        - 用户唯一标识
 * @param {string} message       - 用户消息文本
 * @param {Array<string>} [attachments=[]] - 附件文件路径数组
 * @param {string} [source='wecom'] - 消息来源：wecom | webhook | miniapp
 * @param {Object} [context={}]     - 扩展上下文（如历史对话、用户信息等）
 * @returns {Promise<{success:boolean, answer:string, layer:string, sources:Array, disclaimer:string}>}
 */
async function handleMessage(userId, message, attachments = [], source = 'wecom', context = {}) {
  if (!userId) {
    throw new Error('userId 为必填项');
  }
  if (!message && (!attachments || attachments.length === 0)) {
    throw new Error('message 和 attachments 不能同时为空');
  }

  console.log(`[answerBot] 收到消息 | 用户: ${userId} | 来源: ${source} | 消息: ${message?.slice(0, 50)}...`);

  // 1. 检查是否触发人工
  if (isHandoffRequest(message)) {
    console.log('[answerBot] 用户触发人工，执行转人工...');
    try {
      startHandoff(db, userId, source, null, message);
      await notifyHumanAgents(db, userId, message, source);
    } catch (err) {
      console.error('[answerBot] 转人工失败:', err.message);
    }

    const handoffReply = '已为您转接人工客服，老师将尽快回复您的问题。';
    await sendReply(userId, handoffReply, source);
    recordConversation(userId, message, handoffReply, JSON.stringify({ layer: 'handoff', source }));

    return {
      success: true,
      answer: handoffReply,
      layer: 'handoff',
      sources: [],
      disclaimer: ''
    };
  }

  // 2. 若处于人工接管状态，不自动回复
  if (isInHandoff(db, userId)) {
    const handoffReply = '当前会话已由人工客服接管，机器人暂不自动回复，请等待老师回复。';
    recordConversation(userId, message, handoffReply, JSON.stringify({ layer: 'handoff_active', source }));
    return {
      success: true,
      answer: handoffReply,
      layer: 'handoff_active',
      sources: [],
      disclaimer: ''
    };
  }

  // 3. 处理附件
  const { text: attachmentText, notes: attachmentNotes } = await processAttachments(attachments);

  // 4. 构建完整用户输入
  const userContent = buildUserContent(message, attachmentText, attachmentNotes);

  // 5. 提取历史上下文
  const historyMessages = context.historyMessages || [];
  const baseId = context.baseId || null;

  let finalAnswer = '';
  let usedLayer = '';
  let sources = [];
  let disclaimer = '';

  // ========== 第一层：知识库检索 ==========
  console.log('[answerBot] 尝试第一层：知识库检索...');
  const kbResult = await layer1KnowledgeBase(userContent, baseId);

  if (kbResult.hit) {
    finalAnswer = kbResult.answer;
    usedLayer = 'knowledge_base';
    sources = kbResult.sources;
    console.log(`[answerBot] 第一层命中，来源: ${sources.map((s) => s.documentTitle).join(', ')}`);
  } else {
    // ========== 第二层：AI 生成 ==========
    console.log('[answerBot] 第一层未命中，进入第二层：AI 生成...');

    try {
      finalAnswer = await layer2AIGenerate(userContent, historyMessages);
      usedLayer = 'ai';
    } catch (err) {
      console.error('[answerBot] AI 生成失败:', err.message);
      finalAnswer = '抱歉，当前无法生成回答，请稍后重试。';
      usedLayer = 'error';
    }

    // ========== 第三层：政策/分数线 → 联网搜索 ==========
    if (usedLayer !== 'error' && isPolicyQuestion(message)) {
      console.log('[answerBot] 问题涉及最新政策/分数线，进入第三层：联网搜索...');
      const policyResult = await layer3WebSearch(message, userId, source);
      if (policyResult.isPolicy && policyResult.answer) {
        // 将 AI 回答与政策搜索结论结合
        finalAnswer = finalAnswer + '\n\n---\n' + policyResult.answer;
        usedLayer = 'ai_web_search';
        if (policyResult.sources && policyResult.sources.length) {
          sources = policyResult.sources;
        }
      }
    }
  }

  // 6. 拼接附件处理备注（如有）
  let replyContent = finalAnswer;
  if (attachmentNotes && attachmentNotes.length > 0) {
    const pendingNotes = attachmentNotes.filter((n) => n.includes('待接入') || n.includes('建议补充') || n.includes('未能提取'));
    if (pendingNotes.length > 0) {
      replyContent += `\n\n---\n📎 附件处理：\n${pendingNotes.join('\n')}`;
    }
  }

  // 7. 发送回复
  await sendReply(userId, replyContent, source);

  // 8. 记录对话到 ai_conversations（type='answer'）
  const logContext = JSON.stringify({
    layer: usedLayer,
    source,
    hasAttachments: attachments.length > 0,
    attachmentNotes,
    sources: sources.map((s) => s.documentTitle)
  });
  recordConversation(userId, userContent, finalAnswer, logContext);

  console.log(`[answerBot] 回答完成 | 使用层: ${usedLayer} | 用户: ${userId}`);

  return {
    success: usedLayer !== 'error',
    answer: finalAnswer,
    layer: usedLayer,
    sources,
    disclaimer
  };
}

/**
 * 包装器：兼容 wecom.js 的调用格式
 * wecom.js 以单个对象参数调用：handleQuestion({ userId, question, source, groupId, attachments })
 * 内部转换为 handleMessage 的多参数形式
 */
async function handleQuestion({ userId, question, source = 'wecom', groupId = null, attachments = [] }) {
  const result = await handleMessage(userId, question, attachments, source, { groupId });
  return {
    success: result.success !== false,
    answer: result.answer,
    layer: result.layer,
    sources: result.sources,
    disclaimer: result.disclaimer
  };
}

// ── 导出 ──

module.exports = {
  handleMessage,
  handleQuestion,
  processAttachments
};
