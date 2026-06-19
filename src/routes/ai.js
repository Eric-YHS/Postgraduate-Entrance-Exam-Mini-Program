const ai = require('../services/ai');
const botManager = require('../services/botManager');

module.exports = function registerAiRoutes(app, shared) {
  const { requireAuth, requireStudent } = shared;

  // AI 通用问答
  app.post('/api/ai/ask', requireAuth, async (request, response) => {
    try {
      const { prompt, systemPrompt, messages } = request.body;
      if (!prompt && (!messages || !messages.length)) {
        return response.status(400).json({ error: 'prompt 或 messages 不能为空。' });
      }
      let reply;
      if (messages && messages.length) {
        reply = await ai.chat(messages, request.body.options || {});
      } else {
        reply = await ai.quickAsk(prompt, systemPrompt || '', request.body.options || {});
      }
      response.json({ reply });
    } catch (error) {
      console.error('AI 问答失败:', error.message);
      response.status(500).json({ error: 'AI 服务暂时不可用，请稍后重试。' });
    }
  });

  // AI 题目讲解
  app.post('/api/ai/explain-question', requireAuth, async (request, response) => {
    try {
      const { question, studentHistory } = request.body;
      if (!question || !question.trim()) {
        return response.status(400).json({ error: '题目内容不能为空。' });
      }
      const explanation = await ai.explainQuestion(question, studentHistory || '');
      response.json({ explanation });
    } catch (error) {
      console.error('AI 题目讲解失败:', error.message);
      response.status(500).json({ error: 'AI 服务暂时不可用，请稍后重试。' });
    }
  });

  // AI 生成学习计划
  app.post('/api/ai/study-plan', requireAuth, async (request, response) => {
    try {
      const context = request.body;
      if (!context || typeof context !== 'object') {
        return response.status(400).json({ error: 'context 不能为空。' });
      }
      const plan = await ai.generateStudyPlan(context);
      response.json({ plan });
    } catch (error) {
      console.error('AI 学习计划生成失败:', error.message);
      response.status(500).json({ error: 'AI 服务暂时不可用，请稍后重试。' });
    }
  });

  // AI 文本摘要
  app.post('/api/ai/summarize', requireAuth, async (request, response) => {
    try {
      const { text, maxLength } = request.body;
      if (!text || !text.trim()) {
        return response.status(400).json({ error: 'text 不能为空。' });
      }
      const summary = await ai.summarize(text, maxLength || 200);
      response.json({ summary });
    } catch (error) {
      console.error('AI 摘要失败:', error.message);
      response.status(500).json({ error: 'AI 服务暂时不可用，请稍后重试。' });
    }
  });

  // AI 流式对话（SSE）
  app.post('/api/ai/stream', requireAuth, async (request, response) => {
    try {
      const { messages, options } = request.body;
      if (!messages || !messages.length) {
        return response.status(400).json({ error: 'messages 不能为空。' });
      }
      response.setHeader('Content-Type', 'text/event-stream');
      response.setHeader('Cache-Control', 'no-cache');
      response.setHeader('Connection', 'keep-alive');
      for await (const chunk of ai.streamChat(messages, options || {})) {
        response.write(`data: ${JSON.stringify({ chunk })}
\n`);
      }
      response.write('data: [DONE]\n\n');
      response.end();
    } catch (error) {
      console.error('AI 流式对话失败:', error.message);
      if (!response.headersSent) {
        response.status(500).json({ error: 'AI 服务暂时不可用，请稍后重试。' });
      } else {
        response.write(`data: ${JSON.stringify({ error: error.message })}
\n`);
        response.end();
      }
    }
  });

  // AI 对话历史（个人中心可查看）
  app.get('/api/ai/conversations', requireAuth, (request, response) => {
    try {
      const userId = request.currentUser.id;
      const type = request.query.type || '';
      const limit = Math.min(Number(request.query.limit) || 50, 200);
      const offset = Number(request.query.offset) || 0;
      const conversations = botManager.getConversations({ userId, type, limit, offset });
      response.json({ conversations });
    } catch (error) {
      console.error('获取 AI 对话历史失败:', error.message);
      response.status(500).json({ error: '获取对话历史失败，请稍后重试。' });
    }
  });
};
