/**
 * 解答机器人（三层应答）
 * 职责：处理用户问题，通过知识库RAG → AI生成 → 联网搜索三层流程提供答案
 *
 * 依赖：
 *   - knowledgeBase.searchChunks  (知识库检索)
 *   - ai.chat / ai.quickAsk      (AI 对话生成)
 *   - botManager.logConversation / botManager.getBotByCode  (对话记录)
 *   - wecom.sendAppMessage / wecom.sendWebhookMessage  (消息推送)
 *   - config                      (配置读取)
 */

const fs = require('fs');
const path = require('path');
const { searchByVector } = require('../knowledgeBase');
const { chat, quickAsk } = require('../ai');
const { logConversation, getBotByCode } = require('../botManager');
const { sendAppMessage, sendWebhookMessage } = require('../wecom');
const config = require('../../config');

// ── 常量 ──

const BOT_CODE = 'answer';
const CONVERSATION_TYPE = 'answer';
const RAG_TOP_K = 5;                    // 知识库检索返回条数
const RAG_SCORE_THRESHOLD = 0.5;        // 知识库命中最低分数阈值（0~1，越高越严格）
const MAX_CONTEXT_MESSAGES = 10;        // 上下文保留的最大消息数

// 系统提示词：解答专家角色
const SYSTEM_PROMPT_ANSWER = `你是一位资深考研辅导专家，擅长解答数学、英语、政治等科目的具体问题。
回答要求：
1. 步骤清晰，逻辑严谨
2. 对易错点给出特别提醒
3. 适当拓展相关知识点
4. 语言通俗易懂，适合考研学生理解`;

// 系统提示词：联网搜索辅助
const SYSTEM_PROMPT_WITH_SEARCH = `你是一位资深考研辅导专家。用户的问题涉及可能随时间变化的信息（如政策、分数线、招生简章等）。
以下提供了联网搜索获取的最新信息片段，请结合这些信息给出准确回答。
如果搜索信息不足，请明确告知用户“信息可能不是最新的”，并建议用户查阅官方渠道。`;

// 触发联网搜索的关键词模式
const REALTIME_KEYWORDS = [
  /分数线|录取线|复试线|国家线|自划线/,
  /招生简章|招生目录|招生计划|招生人数/,
  /政策|改革|调整|变化|新规|新政/,
  /202[4-9]|今年|去年|最新|最近|刚刚/,
  /报名|现场确认|网上确认|考试时间|考试大纲/,
  /调剂|调剂信息|调剂系统|调剂名额/,
  /推免|保研|夏令营|预推免/,
  /院校排名|学科评估|双一流|985|211/,
  /学费|奖学金|助学金|住宿/,
  /就业|毕业去向|薪资|年薪/,
];

// ── 内部工具：判断是否需要联网搜索 ──

function needsRealtimeSearch(question) {
  const q = question || '';
  return REALTIME_KEYWORDS.some((pattern) => pattern.test(q));
}

// ── 内部工具：可插拔联网搜索 ──

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

      console.log(`[answerBot] Bing 搜索返回 ${result.length} 条结果`);
      return result;
    } catch (err) {
      console.error('[answerBot] Bing 搜索失败:', err.message);
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

      console.log(`[answerBot] SerpAPI 搜索返回 ${result.length} 条结果`);
      return result;
    } catch (err) {
      console.error('[answerBot] SerpAPI 搜索失败:', err.message);
      return [];
    }
  }

  // 无搜索配置，返回空
  console.log('[answerBot] 未配置搜索 API，跳过联网搜索');
  return [];
}

// ── 内部工具：处理附件 ──

/**
 * 处理附件（语音、图片、文档）
 * @param {Array<string>} attachments - 文件路径数组
 * @returns {Promise<{text:string, notes:Array<string>}>}
 */
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

    // 语音文件
    if (['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.amr', '.wma'].includes(ext)) {
      notes.push(`[语音] ${path.basename(filePath)} — 语音转文字待接入`);
      // TODO: 接入语音识别服务（如讯飞、百度语音）
      // extractedText += await speechToText(filePath);
      continue;
    }

    // 图片文件
    if (['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.svg'].includes(ext)) {
      notes.push(`[图片] ${path.basename(filePath)} — 图片 OCR 解析待接入`);
      // TODO: 接入 OCR 服务（如百度 OCR、腾讯云 OCR）
      // extractedText += await ocrImage(filePath);
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
          notes.push(`[文档] ${path.basename(filePath)} — 未能提取文本`);
        }
      } catch (e) {
        notes.push(`[文档] ${path.basename(filePath)} — 提取失败: ${e.message}`);
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
 * 第一层：知识库 RAG 检索
 * @param {string} question
 * @param {number} baseId - 知识库 ID（如未提供，使用默认知识库）
 * @returns {Promise<{hit:boolean, answer:string, sources:Array<Object>}>}
 */
async function layer1KnowledgeBase(question, baseId = null) {
  // 如未指定知识库，尝试使用默认知识库（id=1）
  const targetBaseId = baseId || 1;

  try {
    const results = await searchByVector(targetBaseId, question, RAG_TOP_K);

    if (!results || results.length === 0) {
      return { hit: false, answer: '', sources: [] };
    }

    // 检查最高分是否达到阈值
    const topScore = results[0].score || 0;
    if (topScore < RAG_SCORE_THRESHOLD) {
      console.log(`[answerBot] 知识库最高分 ${topScore} 低于阈值 ${RAG_SCORE_THRESHOLD}，视为未命中`);
      return { hit: false, answer: '', sources: results.slice(0, 3) };
    }

    // 构建带来源的预设答案
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
 * @param {string} question
 * @param {Array<{role:string, content:string}>} historyMessages
 * @param {string} [searchContext] - 联网搜索上下文（第三层结果）
 * @returns {Promise<string>}
 */
async function layer2AIGenerate(question, historyMessages = [], searchContext = '') {
  const messages = [];

  if (searchContext) {
    messages.push({ role: 'system', content: SYSTEM_PROMPT_WITH_SEARCH });
    messages.push({ role: 'system', content: `搜索信息：\n${searchContext}` });
  } else {
    messages.push({ role: 'system', content: SYSTEM_PROMPT_ANSWER });
  }

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
    throw new Error('AI 生成回答失败，请稍后重试');
  }
}

// ── 内部工具：联网搜索（第三层） ──

/**
 * 第三层：联网搜索获取最新信息
 * @param {string} question
 * @returns {Promise<{hasResult:boolean, context:string, disclaimer:boolean}>}
 */
async function layer3WebSearch(question) {
  const searchResults = await searchWeb(question);

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

// ── 内部工具：发送回复 ──

async function sendReply(userId, content, source, groupId) {
  const bot = getBotByCode(BOT_CODE);
  const botName = bot?.name || '解答专家';
  const fullContent = `${botName}：\n${content}`;

  if (source === 'wecom') {
    // 企业微信应用消息
    const payload = {
      touser: userId,
      msgtype: 'text',
      text: { content: fullContent }
    };
    await sendAppMessage(payload);
  } else if (source === 'webhook') {
    // 企业微信群机器人 Webhook
    const payload = {
      msgtype: 'text',
      text: { content: fullContent }
    };
    await sendWebhookMessage(payload);
  } else if (source === 'miniapp') {
    // 小程序端：此处仅记录，实际发送由调用方处理
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

// ── 主入口：处理用户问题 ──

/**
 * 处理用户问题（三层应答）
 * @param {Object} params
 * @param {string} params.userId        - 用户唯一标识
 * @param {string} params.question      - 用户问题文本
 * @param {string} [params.source='wecom'] - 消息来源：wecom | webhook | miniapp
 * @param {string} [params.groupId=null]   - 群组 ID（如有）
 * @param {Object} [params.context={}]     - 扩展上下文（如历史对话、用户信息等）
 * @param {Array<string>} [params.attachments=[]] - 附件文件路径数组
 * @returns {Promise<{success:boolean, answer:string, layer:string, sources:Array, disclaimer:string}>}
 */
async function handleQuestion({
  userId,
  question,
  source = 'wecom',
  groupId = null,
  context = {},
  attachments = []
}) {
  if (!userId) {
    throw new Error('userId 为必填项');
  }
  if (!question && (!attachments || attachments.length === 0)) {
    throw new Error('question 和 attachments 不能同时为空');
  }

  console.log(`[answerBot] 收到问题 | 用户: ${userId} | 来源: ${source} | 问题: ${question?.slice(0, 50)}...`);

  // 1. 处理附件
  const { text: attachmentText, notes: attachmentNotes } = await processAttachments(attachments);

  // 2. 构建完整用户输入
  const userContent = buildUserContent(question, attachmentText, attachmentNotes);

  // 3. 提取历史上下文
  const historyMessages = context.historyMessages || [];
  const baseId = context.baseId || null;

  let finalAnswer = '';
  let usedLayer = '';
  let sources = [];
  let disclaimer = '';

  // ========== 第一层：知识库 RAG ==========
  console.log('[answerBot] 尝试第一层：知识库检索...');
  const kbResult = await layer1KnowledgeBase(userContent, baseId);

  if (kbResult.hit) {
    finalAnswer = kbResult.answer;
    usedLayer = 'knowledge_base';
    sources = kbResult.sources;
    console.log(`[answerBot] 第一层命中，来源: ${sources.map((s) => s.documentTitle).join(', ')}`);
  } else {
    // ========== 第二层/第三层：AI 生成 + 联网搜索 ==========
    console.log('[answerBot] 第一层未命中，进入第二层/第三层...');

    // 判断是否需要联网搜索
    const needSearch = needsRealtimeSearch(question);
    let searchContext = '';
    let hasSearchResult = false;

    if (needSearch) {
      console.log('[answerBot] 问题涉及实时信息，尝试第三层：联网搜索...');
      const searchResult = await layer3WebSearch(question);
      if (searchResult.hasResult) {
        searchContext = searchResult.context;
        hasSearchResult = true;
        console.log(`[answerBot] 联网搜索成功，获取 ${searchResult.context.length} 字上下文`);
      } else {
        console.log('[answerBot] 联网搜索未返回结果或配置缺失');
      }
    }

    // 调用 AI 生成
    try {
      finalAnswer = await layer2AIGenerate(userContent, historyMessages, searchContext);
      usedLayer = hasSearchResult ? 'ai_with_search' : 'ai';

      // 如果触发了搜索但未获取到结果，添加免责声明
      if (needSearch && !hasSearchResult) {
        disclaimer = '【提示】该问题可能涉及最新政策或实时信息，当前未能获取联网数据，以上回答基于已有知识生成，信息可能不是最新的。建议您查阅官方渠道确认。';
      }
    } catch (err) {
      console.error('[answerBot] AI 生成失败:', err.message);
      finalAnswer = '抱歉，当前无法生成回答，请稍后重试。';
      usedLayer = 'error';
    }
  }

  // 4. 拼接附件处理备注（如有）
  let replyContent = finalAnswer;
  if (attachmentNotes && attachmentNotes.length > 0) {
    const pendingNotes = attachmentNotes.filter((n) => n.includes('待接入'));
    if (pendingNotes.length > 0) {
      replyContent += `\n\n---\n📎 附件处理：\n${pendingNotes.join('\n')}`;
    }
  }

  // 5. 添加免责声明
  if (disclaimer) {
    replyContent += `\n\n${disclaimer}`;
  }

  // 6. 发送回复
  await sendReply(userId, replyContent, source, groupId);

  // 7. 记录对话
  const logContext = JSON.stringify({
    layer: usedLayer,
    source,
    groupId,
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

// ── 导出 ──

module.exports = {
  handleQuestion,
  searchWeb,        // 导出以便测试和外部调用
  processAttachments // 导出以便测试
};
