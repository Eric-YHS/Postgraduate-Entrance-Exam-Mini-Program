/**
 * 共享 AI 服务封装
 * 供所有机器人、C-12 及业务模块统一调用 DeepSeek API
 *
 * 环境变量依赖（已在 .env 或 config.js 中读取）：
 *   AI_API_URL  — DeepSeek API 基础地址，如 https://api.deepseek.com/v1/chat/completions
 *   AI_API_KEY  — API 密钥
 *   AI_MODEL    — 默认模型，如 deepseek-chat（即 DeepSeek-V3）
 */

const https = require('https');
const http = require('http');
const { URL } = require('url');
const config = require('../config');

// ── 常量 ──

const DEFAULT_TIMEOUT_MS = 30000;          // 默认请求超时 30 秒
const DEFAULT_MAX_TOKENS = 2000;           // 默认最大输出 token 数
const DEFAULT_TEMPERATURE = 0.7;           // 默认温度
const DEFAULT_MODEL = 'deepseek-chat';       // DeepSeek-V3

const EMBEDDING_MODEL = 'Xenova/bge-small-zh-v1.5'; // 中文本地 embedding 模型
let embeddingPipeline = null;              // 懒加载的 embedding pipeline
let transformersEnv = null;                // @xenova/transformers 环境配置

/**
 * 配置本地 embedding 模型下载镜像（国内默认使用 hf-mirror）
 */
function configureEmbeddingEnv(env) {
  const mirrorHost = process.env.TRANSFORMERS_REMOTE_HOST
    || process.env.HF_MIRROR
    || process.env.HF_ENDPOINT
    || 'https://hf-mirror.com/';
  env.remoteHost = mirrorHost.endsWith('/') ? mirrorHost : `${mirrorHost}/`;
  env.cacheDir = process.env.TRANSFORMERS_CACHE || env.cacheDir;
}

// ── 内部工具：基于原生 https/http 的 POST 请求 ──

function postJson(url, body, apiKey, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;
    const postData = JSON.stringify(body);

    const req = lib.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'Accept': 'application/json',
          'Content-Length': Buffer.byteLength(postData)
        },
        timeout: timeoutMs
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf-8');
          if (res.statusCode < 200 || res.statusCode >= 300) {
            let errMsg = `HTTP ${res.statusCode}`;
            try {
              const parsedErr = JSON.parse(raw);
              errMsg = parsedErr.error?.message || parsedErr.errmsg || errMsg;
            } catch (_) {
              // 保持默认 errMsg
            }
            reject(new Error(`AI API 错误: ${errMsg}`));
            return;
          }
          try {
            resolve(JSON.parse(raw));
          } catch (parseErr) {
            reject(new Error(`AI 响应 JSON 解析失败: ${parseErr.message}`));
          }
        });
      }
    );

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('AI 请求超时'));
    });

    req.on('error', (err) => {
      reject(new Error(`AI 网络错误: ${err.message}`));
    });

    req.write(postData);
    req.end();
  });
}

// ── 内部工具：基于原生 https/http 的 SSE 流式请求 ──

function postStream(url, body, apiKey, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;
    const postData = JSON.stringify(body);

    const req = lib.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'Accept': 'text/event-stream',
          'Content-Length': Buffer.byteLength(postData)
        },
        timeout: timeoutMs
      },
      (res) => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const chunks = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf-8');
            let errMsg = `HTTP ${res.statusCode}`;
            try {
              const parsedErr = JSON.parse(raw);
              errMsg = parsedErr.error?.message || parsedErr.errmsg || errMsg;
            } catch (_) {}
            reject(new Error(`AI API 流式错误: ${errMsg}`));
          });
          return;
        }
        resolve(res);
      }
    );

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('AI 流式请求超时'));
    });

    req.on('error', (err) => {
      reject(new Error(`AI 流式网络错误: ${err.message}`));
    });

    req.write(postData);
    req.end();
  });
}

// ── 内部工具：安全提取 AI 回复内容 ──

function extractContent(data) {
  if (!data || typeof data !== 'object') return '';
  return data.choices?.[0]?.message?.content
    || data.choices?.[0]?.delta?.content
    || '';
}

// ── 内部工具：读取 SSE 流中的一行数据 ──

async function* readSSEStream(response) {
  let buffer = '';
  for await (const chunk of response) {
    buffer += chunk.toString('utf-8');
    let lineEnd;
    while ((lineEnd = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, lineEnd).trim();
      buffer = buffer.slice(lineEnd + 1);
      if (!line || line.startsWith(':')) continue; // 忽略空行和注释
      if (line.startsWith('data: ')) {
        const dataStr = line.slice(6).trim();
        if (dataStr === '[DONE]') return;
        try {
          const json = JSON.parse(dataStr);
          const content = extractContent(json);
          if (content) yield content;
        } catch (_) {
          // 忽略无法解析的 SSE 行
        }
      }
    }
  }
}

// ── 内部工具：获取配置 ──

function getAIConfig() {
  return {
    apiKey: config.aiApiKey || '',
    apiUrl: config.aiApiUrl || '',
    model: config.aiModel || DEFAULT_MODEL
  };
}

function checkConfig() {
  const { apiKey, apiUrl } = getAIConfig();
  if (!apiKey || !apiUrl) {
    throw new Error('AI 服务未配置：请在 .env 中设置 AI_API_KEY 和 AI_API_URL');
  }
}

// ── 核心 API ──

/**
 * 标准对话调用（非流式）
 * @param {Array<{role:string, content:string}>} messages - OpenAI 格式消息数组
 * @param {Object} options - 可选参数
 * @param {string} options.model - 覆盖默认模型
 * @param {number} options.maxTokens - 最大输出 token 数
 * @param {number} options.temperature - 温度 (0~2)
 * @param {number} options.timeoutMs - 请求超时毫秒数
 * @returns {Promise<string>} AI 回复文本
 */
async function chat(messages, options = {}) {
  checkConfig();
  const { apiKey, apiUrl, model } = getAIConfig();
  const body = {
    model: options.model || model || DEFAULT_MODEL,
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
    max_tokens: options.maxTokens || DEFAULT_MAX_TOKENS,
    temperature: options.temperature !== undefined ? options.temperature : DEFAULT_TEMPERATURE
  };

  try {
    const data = await postJson(apiUrl, body, apiKey, options.timeoutMs || DEFAULT_TIMEOUT_MS);
    const content = extractContent(data);
    if (!content) {
      throw new Error('AI 返回空内容');
    }
    return content;
  } catch (err) {
    console.error('[AI.chat] 调用失败:', err.message);
    throw err;
  }
}

/**
 * 流式对话调用（返回 async generator）
 * @param {Array<{role:string, content:string}>} messages - OpenAI 格式消息数组
 * @param {Object} options - 可选参数（同 chat）
 * @returns {AsyncGenerator<string>} 逐段生成的文本
 */
async function* streamChat(messages, options = {}) {
  checkConfig();
  const { apiKey, apiUrl, model } = getAIConfig();
  const body = {
    model: options.model || model || DEFAULT_MODEL,
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
    max_tokens: options.maxTokens || DEFAULT_MAX_TOKENS,
    temperature: options.temperature !== undefined ? options.temperature : DEFAULT_TEMPERATURE,
    stream: true
  };

  let response;
  try {
    response = await postStream(apiUrl, body, apiKey, options.timeoutMs || DEFAULT_TIMEOUT_MS);
  } catch (err) {
    console.error('[AI.streamChat] 流式调用失败:', err.message);
    throw err;
  }

  try {
    for await (const chunk of readSSEStream(response)) {
      yield chunk;
    }
  } catch (err) {
    console.error('[AI.streamChat] 流读取失败:', err.message);
    throw err;
  }
}

/**
 * 单轮快捷调用
 * @param {string} prompt - 用户输入
 * @param {string} systemPrompt - 系统提示词
 * @param {Object} options - 可选参数（同 chat）
 * @returns {Promise<string>} AI 回复文本
 */
async function quickAsk(prompt, systemPrompt = '', options = {}) {
  const messages = [];
  if (systemPrompt) {
    messages.push({ role: 'system', content: systemPrompt });
  }
  messages.push({ role: 'user', content: prompt });
  return chat(messages, options);
}

/**
 * 获取文本嵌入向量（Embedding）
 * 使用本地 @xenova/transformers 模型（bge-small-zh-v1.5），无需调用远程 API
 * @param {string|string[]} texts - 待嵌入的文本（单条字符串或字符串数组）
 * @param {Object} options - 可选参数
 * @returns {Promise<number[][]>} 向量数组，每条文本对应一个向量
 */
async function getEmbedding(texts, options = {}) {
  const inputArray = Array.isArray(texts) ? texts : [texts];
  if (inputArray.length === 0 || inputArray.some((t) => typeof t !== 'string' || t.length === 0)) {
    throw new Error('getEmbedding 输入必须是字符串或字符串数组，且不能为空');
  }

  try {
    const { pipeline, env } = await import('@xenova/transformers');
    if (!transformersEnv) {
      configureEmbeddingEnv(env);
      transformersEnv = env;
    }
    if (!embeddingPipeline) {
      console.log(`[AI.getEmbedding] 正在加载本地 embedding 模型 ${EMBEDDING_MODEL}...`);
      embeddingPipeline = await pipeline('feature-extraction', EMBEDDING_MODEL, {
        quantized: true,
        revision: 'main'
      });
      console.log('[AI.getEmbedding] 本地 embedding 模型加载完成');
    }

    const embeddings = [];
    for (const text of inputArray) {
      const output = await embeddingPipeline(text, {
        pooling: 'mean',
        normalize: true
      });
      embeddings.push(Array.from(output.data));
    }

    console.log(`[AI.getEmbedding] 成功生成 ${embeddings.length} 条 embedding，维度 ${embeddings[0]?.length || 'unknown'}`);
    return embeddings;
  } catch (err) {
    console.error('[AI.getEmbedding] 本地 embedding 生成失败:', err.message);
    throw err;
  }
}

/**
 * 生成文本嵌入（向量）
 * 调用本地 embedding 模型获取单条文本的向量
 * @param {string} text
 * @returns {Promise<number[]|null>}
 */
async function generateEmbedding(text) {
  if (!text || typeof text !== 'string') return null;
  try {
    const embeddings = await getEmbedding(text);
    return embeddings && embeddings[0] ? embeddings[0] : null;
  } catch (err) {
    console.error('[AI.generateEmbedding] 生成 embedding 失败:', err.message);
    return null;
  }
}

/**
 * 文本摘要
 * @param {string} text - 待摘要文本
 * @param {number} maxLength - 期望最大字数（提示词约束，非精确截断）
 * @returns {Promise<string>} 摘要结果
 */
async function summarize(text, maxLength = 200) {
  const systemPrompt = '你是一位专业的文本摘要助手。请对用户提供的内容进行精炼摘要，保留核心要点。';
  const userPrompt = `请对以下内容进行摘要，控制在 ${maxLength} 字以内：\n\n${text}`;
  return quickAsk(userPrompt, systemPrompt, { maxTokens: Math.max(500, maxLength * 2) });
}

/**
 * 生成学习计划
 * @param {Object} context - 学生上下文信息
 * @param {string} context.subject - 目标科目
 * @param {number} context.daysUntilExam - 距离考试天数
 * @param {string} context.currentLevel - 当前水平（如"基础薄弱"）
 * @param {string} context.goal - 目标分数或院校
 * @param {Array<string>} [context.weakAreas] - 薄弱知识点列表
 * @returns {Promise<string>} 生成的学习计划
 */
async function generateStudyPlan(context) {
  const systemPrompt = '你是一位资深考研规划师，擅长根据学生情况制定个性化学习计划。请输出结构化的学习计划，包含阶段划分、每日任务、复习策略和注意事项。';

  const weakAreasStr = context.weakAreas && context.weakAreas.length
    ? `薄弱知识点：${context.weakAreas.join('、')}`
    : '';

  const userPrompt = `请为以下学生制定考研学习计划：
目标科目：${context.subject || '未指定'}
距离考试：${context.daysUntilExam || '未知'} 天
当前水平：${context.currentLevel || '中等'}
目标：${context.goal || '上岸'}
${weakAreasStr}

请输出详细、可执行的学习计划。`;

  return quickAsk(userPrompt, systemPrompt, { maxTokens: 3000, temperature: 0.5 });
}

/**
 * 题目讲解
 * @param {string} question - 题目内容（含题干、选项等）
 * @param {string} studentHistory - 学生历史答题记录或学习背景
 * @returns {Promise<string>} 个性化讲解
 */
async function explainQuestion(question, studentHistory = '') {
  const systemPrompt = '你是一位耐心的考研辅导老师。请对题目进行详细讲解，包括：1) 题目分析；2) 知识点梳理；3) 解题思路；4) 常见错误提醒；5) 相关拓展。讲解要通俗易懂，适合考研学生理解。';

  const historyStr = studentHistory
    ? `该学生历史学习情况：${studentHistory}\n`
    : '';

  const userPrompt = `${historyStr}请讲解以下题目：

${question}`;

  return quickAsk(userPrompt, systemPrompt, { maxTokens: 3000, temperature: 0.4 });
}

// ── 导出 ──

module.exports = {
  chat,
  streamChat,
  quickAsk,
  getEmbedding,
  generateEmbedding,
  summarize,
  generateStudyPlan,
  explainQuestion
};
