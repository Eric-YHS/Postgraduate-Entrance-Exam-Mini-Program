const wecom = require('../services/wecom');
const config = require('../config');
const { handleMessage: handleFreeTutorMessage } = require('../services/bots/freeTutorBot');
const { handleQuestion } = require('../services/bots/answerBot');
const { isHandoffRequest, startHandoff, isInHandoff, notifyHumanAgents } = require('../services/bots/humanHandoff');

module.exports = function registerWecomRoutes(app, shared) {
  const { requireAdmin } = shared;

  // 企业微信官方消息回调：URL 验证（GET）
  app.get('/api/wecom/callback', (request, response) => {
    try {
      const { msg_signature, timestamp, nonce, echostr } = request.query;
      if (!config.wecomToken || !config.wecomEncodingAesKey) {
        console.warn('[wecom] WECOM_TOKEN 或 WECOM_ENCODING_AES_KEY 未配置');
        return response.status(500).send('not configured');
      }
      const plainText = wecom.verifyCallbackUrl(
        { msg_signature, timestamp, nonce, echostr },
        config.wecomToken,
        config.wecomEncodingAesKey
      );
      if (plainText) {
        response.send(plainText);
      } else {
        console.warn('[wecom] 回调 URL 验证失败');
        response.status(403).send('verify fail');
      }
    } catch (error) {
      console.error('[wecom] 回调 URL 验证异常:', error.message);
      response.status(500).send('error');
    }
  });

  // 企业微信官方消息回调：接收消息（POST）
  app.post('/api/wecom/callback', async (request, response) => {
    try {
      const { msg_signature, timestamp, nonce } = request.query;
      // express.raw() 返回 Buffer，需要转为字符串
      const xml = Buffer.isBuffer(request.body) ? request.body.toString('utf-8') : request.body;

      console.log('[wecom] 收到回调消息:', { msg_signature, timestamp, nonce, bodyLength: xml.length });

      if (!config.wecomToken || !config.wecomEncodingAesKey) {
        console.warn('[wecom] WECOM_TOKEN 或 WECOM_ENCODING_AES_KEY 未配置');
        return response.status(500).send('not configured');
      }

      const parsed = wecom.parseEncryptedXml(
        xml,
        msg_signature,
        timestamp,
        nonce,
        config.wecomToken,
        config.wecomEncodingAesKey
      );
      if (!parsed) {
        console.warn('[wecom] 回调消息解密/签名校验失败');
        return response.status(403).send('verify fail');
      }

      // 解析内部 XML 消息（兼容 CDATA 和普通文本）
      function extractXmlField(xmlText, tagName) {
        const cdataRegex = new RegExp(`<${tagName}><!\\[CDATA\\[(.*?)\\]\\]></${tagName}>`);
        const plainRegex = new RegExp(`<${tagName}>(.*?)</${tagName}>`);
        const cdataMatch = xmlText.match(cdataRegex);
        if (cdataMatch) return cdataMatch[1];
        const plainMatch = xmlText.match(plainRegex);
        return plainMatch ? plainMatch[1] : '';
      }

      const msgType = extractXmlField(parsed.message, 'MsgType');
      const userId = extractXmlField(parsed.message, 'FromUserName');
      const message = extractXmlField(parsed.message, 'Content');

      console.log(`[wecom] 解析消息 | 类型: ${msgType} | 用户: ${userId} | 内容: ${message.slice(0, 100)}`);

      // 先返回 success，避免企业微信重试；回复消息异步发送
      response.send('success');

      if (msgType === 'text' && userId && message) {
        const { db } = shared;
        const source = 'wecom';
        let replyText = '';

        if (isInHandoff(db, userId)) {
          await notifyHumanAgents(db, userId, message, source);
          replyText = '已通知人工客服，老师会尽快回复你，请稍候。';
        } else if (isHandoffRequest(message)) {
          const handoffResult = startHandoff(db, userId, source, null, message);
          if (handoffResult.success) {
            await notifyHumanAgents(db, userId, message, source);
          }
          replyText = '已为你转接人工客服，老师会尽快回复你，请稍候。';
        } else {
          // 通过企业微信用户 ID 查找对应学员
          const userRow = db.prepare('SELECT role, id FROM users WHERE wecom_userid = ?').get(userId)
            || db.prepare('SELECT role, id FROM users WHERE id = ?').get(userId);
          const isPaid = userRow && userRow.role === 'student';
          console.log(`[wecom] 用户 ${userId} 身份: ${userRow ? userRow.role : '未绑定'}, 是否付费: ${isPaid}`);

          if (isPaid) {
            const result = await handleQuestion({ userId, question: message, source, groupId: null, attachments: [] });
            replyText = result && result.answer ? result.answer : '抱歉，我暂时无法回答这个问题。';
          } else {
            const result = await handleFreeTutorMessage({ userId, message, source, groupId: null });
            replyText = result && result.reply ? result.reply : '抱歉，我暂时无法回答这个问题。';
          }
        }

        if (replyText) {
          try {
            const sendResult = await wecom.sendAppMessage({
              touser: userId,
              msgtype: 'text',
              text: { content: replyText }
            });
            console.log(`[wecom] 回复用户 ${userId} 结果:`, sendResult);
          } catch (sendErr) {
            console.error('[wecom] 回复用户消息失败:', sendErr.message);
          }
        }
      }
    } catch (error) {
      console.error('[wecom] 处理企业微信回调消息失败:', error.message);
      if (!response.headersSent) {
        response.status(500).send('error');
      }
    }
  });

  // 发送应用消息
  app.post('/api/wecom/message', requireAdmin, async (request, response) => {
    try {
      const payload = request.body;
      if (!payload || typeof payload !== 'object') {
        return response.status(400).json({ error: '请求体不能为空。' });
      }
      const result = await wecom.sendAppMessage(payload);
      response.json({ success: true, result });
    } catch (error) {
      console.error('发送企业微信应用消息失败:', error.message);
      response.status(500).json({ error: '发送企业微信应用消息失败。' });
    }
  });

  // 发送群机器人 Webhook 消息
  app.post('/api/wecom/webhook', requireAdmin, async (request, response) => {
    try {
      const payload = request.body;
      if (!payload || typeof payload !== 'object') {
        return response.status(400).json({ error: '请求体不能为空。' });
      }
      const result = await wecom.sendWebhookMessage(payload);
      response.json({ success: true, result });
    } catch (error) {
      console.error('发送企业微信 Webhook 消息失败:', error.message);
      response.status(500).json({ error: '发送企业微信 Webhook 消息失败。' });
    }
  });

  // 创建应用群聊
  app.post('/api/wecom/chat', requireAdmin, async (request, response) => {
    try {
      const { name, owner, userlist } = request.body;
      if (!name || !name.trim()) {
        return response.status(400).json({ error: '群聊名称不能为空。' });
      }
      if (!userlist || !Array.isArray(userlist) || userlist.length === 0) {
        return response.status(400).json({ error: '群聊成员列表不能为空。' });
      }
      const result = await wecom.createAppChat({ name, owner, userlist });
      response.json({ success: true, result });
    } catch (error) {
      console.error('创建企业微信群聊失败:', error.message);
      response.status(500).json({ error: '创建企业微信群聊失败。' });
    }
  });

  // 邀请/添加成员到群聊
  app.post('/api/wecom/chat/members', requireAdmin, async (request, response) => {
    try {
      const { chatid, users } = request.body;
      if (!chatid || !chatid.trim()) {
        return response.status(400).json({ error: 'chatid 不能为空。' });
      }
      if (!users || !Array.isArray(users) || users.length === 0) {
        return response.status(400).json({ error: '成员列表不能为空。' });
      }
      const result = await wecom.inviteChatMembers({ chatid, users });
      response.json({ success: true, result });
    } catch (error) {
      console.error('邀请成员到群聊失败:', error.message);
      response.status(500).json({ error: '邀请成员到群聊失败。' });
    }
  });

  // 新增：企业微信消息回调 Webhook（接收用户消息并分发到机器人）
  app.post('/api/wecom/webhook', async (request, response) => {
    try {
      const { userId, message, groupId, source = 'wecom', attachments } = request.body;
      if (!userId || !message) {
        return response.status(400).json({ error: 'userId 和 message 为必填项。' });
      }

      const { db } = shared;

      // 1. 检查是否人工接管中
      if (isInHandoff(db, userId)) {
        // 通知客服老师，不触发机器人
        await notifyHumanAgents(db, userId, message, source);
        return response.json({ success: true, handoff: true, message: '已通知人工客服，请稍候。' });
      }

      // 2. 检查是否触发转人工
      if (isHandoffRequest(message)) {
        const handoffResult = startHandoff(db, userId, source, groupId, message);
        if (handoffResult.success) {
          await notifyHumanAgents(db, userId, message, source);
        }
        return response.json({
          success: true,
          handoff: true,
          sessionId: handoffResult.sessionId,
          message: '已为您转接人工客服，请稍候...'
        });
      }

      // 3. 判断用户类型：付费 vs 免费
      // 付费学员判断：当前以 role='student' 兜底，后续可接入权益体系
      const userRow = db.prepare('SELECT role, id FROM users WHERE id = ?').get(userId);
      const isPaid = userRow && userRow.role === 'student';

      let result;
      if (isPaid) {
        // 付费用户走 answerBot（三层应答：知识库RAG -> AI生成 -> 联网搜索）
        result = await handleQuestion({
          userId,
          question: message,
          source,
          groupId,
          attachments: attachments || []
        });
      } else {
        // 免费用户走 freeTutorBot（基础答疑 + 转化话术）
        result = await handleFreeTutorMessage({
          userId,
          message,
          source,
          groupId
        });
      }

      response.json({ success: true, ...result });
    } catch (error) {
      console.error('处理企业微信消息失败:', error.message);
      response.status(500).json({ error: '处理消息失败，请稍后重试。' });
    }
  });
};
