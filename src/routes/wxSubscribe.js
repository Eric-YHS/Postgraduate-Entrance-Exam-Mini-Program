const dayjs = require('dayjs');
const {
  ContentSecurityError,
  exchangeLoginCode,
  issueSessionToken,
  verifySessionToken
} = require('../services/wechatContentSecurity');
const wxPush = require('../services/wxPush');

const TEMPLATE_TITLE = '存折更换';
const TEST_FIXED_CONTENT = '今日复习';
const TEST_TIP = '记得当天完成，22点前发给学长';
const TEST_DETAIL_CONTENT = `🗡️打卡第110天
姓名：凯迪
👉阶段性任务（7月30号）
1.完成单词（高）
2.每天150+复习所学的单词
3.完成英语语法视频课
4.看专业课网课一本
5.每天一个长难句
日期2026.7.23
🔥今日完成

1.复习200
2.单词100
3.长难句
4.政治`;

function createRateLimiter(limit, windowMs = 60 * 1000) {
  const attempts = new Map();
  return (request, response, next) => {
    const key = request.ip || request.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const recent = (attempts.get(key) || []).filter((time) => now - time < windowMs);
    if (recent.length >= limit) {
      response.status(429).json({ ok: false, code: 'RATE_LIMITED', error: '操作过于频繁，请稍后再试。' });
      return;
    }
    recent.push(now);
    attempts.set(key, recent);
    next();
  };
}

function getBearerToken(request) {
  const authorization = String(request.headers.authorization || '');
  return authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
}

function sendError(response, error) {
  if (error instanceof ContentSecurityError) {
    const status = error.code === 'WX_CONFIG_MISSING'
      ? 503
      : (error.code.includes('SESSION') ? 401 : 502);
    response.status(status).json({ ok: false, code: error.code, error: error.message });
    return;
  }
  console.error('[WxSubscribe] 未处理异常:', error?.message || error);
  response.status(500).json({ ok: false, code: 'WX_SUBSCRIBE_ERROR', error: '微信提醒服务暂不可用。' });
}

function isConfigured(config) {
  return Boolean(
    config.wxAppId &&
    config.wxAppId === config.expectedWxAppId &&
    config.wxAppSecret &&
    config.wxSubscribeTestTemplateId
  );
}

function buildTestMessage(config, currentTime = dayjs()) {
  const replacementDate = currentTime.format('YYYY年M月D日');
  const number = `No.${currentTime.format('YYYYMMDDHHmmss')}`;
  const data = {
    [config.wxSubscribeTestFixedKey]: { value: TEST_FIXED_CONTENT },
    [config.wxSubscribeTestDateKey]: { value: replacementDate },
    [config.wxSubscribeTestNumberKey]: { value: number },
    [config.wxSubscribeTestTipKey]: { value: TEST_TIP }
  };
  return {
    data,
    detail: {
      title: '今日复习',
      status: '今日学习任务',
      content: TEST_DETAIL_CONTENT,
      fixedContent: TEST_FIXED_CONTENT,
      replacementDate,
      number,
      tip: TEST_TIP,
      createdAt: currentTime.toISOString()
    }
  };
}

module.exports = function registerWxSubscribeRoutes(app, shared) {
  const { config, db } = shared;
  const sessionRateLimit = createRateLimiter(20);
  const sendRateLimit = createRateLimiter(10);

  function requireSubscribeSession(request, response, next) {
    try {
      const session = verifySessionToken(getBearerToken(request), config.sessionSecret);
      request.wxSubscribeOpenId = session.openid;
      next();
    } catch (error) {
      sendError(response, error);
    }
  }

  app.get('/api/wx-subscribe/config', (_request, response) => {
    response.json({
      ok: true,
      configured: isConfigured(config),
      templateId: config.wxSubscribeTestTemplateId || '',
      templateTitle: TEMPLATE_TITLE,
      templateType: 'long-term'
    });
  });

  app.post('/api/wx-subscribe/session', sessionRateLimit, async (request, response) => {
    try {
      const { openid } = await exchangeLoginCode(config, request.body?.code);
      const session = issueSessionToken(openid, config.sessionSecret);
      response.json({ ok: true, token: session.token, expiresAt: session.expiresAt });
    } catch (error) {
      sendError(response, error);
    }
  });

  app.post(
    '/api/wx-subscribe/test',
    sendRateLimit,
    requireSubscribeSession,
    async (request, response) => {
      if (!isConfigured(config)) {
        response.status(503).json({
          ok: false,
          code: 'WX_SUBSCRIBE_CONFIG_MISSING',
          error: '微信提醒模板尚未配置。'
        });
        return;
      }

      const openid = request.wxSubscribeOpenId;
      const now = dayjs();
      const createdAt = now.toISOString();
      const message = buildTestMessage(config, now);
      const templateId = config.wxSubscribeTestTemplateId;

      db.prepare(`
        INSERT INTO wx_subscribe_recipients
          (openid, template_id, status, subscribed_at, updated_at)
        VALUES (?, ?, 'active', ?, ?)
        ON CONFLICT(openid, template_id) DO UPDATE SET
          status = 'active', subscribed_at = excluded.subscribed_at,
          last_error = '', updated_at = excluded.updated_at
      `).run(openid, templateId, createdAt, createdAt);

      const delivery = db.prepare(`
        INSERT INTO wx_subscribe_deliveries
          (openid, template_id, payload_json, detail_json, status, created_at)
        VALUES (?, ?, ?, ?, 'pending', ?)
      `).run(
        openid,
        templateId,
        JSON.stringify(message.data),
        JSON.stringify(message.detail),
        createdAt
      );
      const deliveryId = Number(delivery.lastInsertRowid);
      const page = `pages/notification/detail/detail?id=${deliveryId}`;
      db.prepare('UPDATE wx_subscribe_deliveries SET page = ? WHERE id = ?').run(page, deliveryId);

      try {
        const result = await wxPush.sendSubscribeMessage(
          openid,
          templateId,
          message.data,
          page,
          { miniprogramState: config.wxSubscribeMiniprogramState }
        );
        const errcode = Number(result?.errcode || 0);
        const errmsg = String(result?.errmsg || (result ? '' : '未获取到微信接口返回值'));
        if (!result || errcode !== 0) {
          db.prepare(`
            UPDATE wx_subscribe_deliveries
            SET status = 'failed', errcode = ?, errmsg = ? WHERE id = ?
          `).run(errcode, errmsg.slice(0, 500), deliveryId);
          db.prepare(`
            UPDATE wx_subscribe_recipients
            SET status = ?, last_error = ?, updated_at = ?
            WHERE openid = ? AND template_id = ?
          `).run(
            [43101, 43107].includes(errcode) ? 'invalid' : 'active',
            `${errcode}: ${errmsg}`.slice(0, 500),
            dayjs().toISOString(),
            openid,
            templateId
          );
          response.status(502).json({
            ok: false,
            code: 'WX_SUBSCRIBE_SEND_FAILED',
            error: '微信测试消息发送失败。',
            wxErrcode: errcode,
            wxErrmsg: errmsg,
            deliveryId
          });
          return;
        }

        const sentAt = dayjs().toISOString();
        db.prepare(`
          UPDATE wx_subscribe_deliveries
          SET status = 'sent', errcode = 0, errmsg = 'ok', sent_at = ? WHERE id = ?
        `).run(sentAt, deliveryId);
        db.prepare(`
          UPDATE wx_subscribe_recipients
          SET status = 'active', last_sent_at = ?, last_error = '', updated_at = ?
          WHERE openid = ? AND template_id = ?
        `).run(sentAt, sentAt, openid, templateId);
        response.json({ ok: true, deliveryId, page, sentAt });
      } catch (error) {
        const errmsg = String(error?.message || '微信接口调用异常').slice(0, 500);
        db.prepare(`
          UPDATE wx_subscribe_deliveries
          SET status = 'failed', errmsg = ? WHERE id = ?
        `).run(errmsg, deliveryId);
        db.prepare(`
          UPDATE wx_subscribe_recipients
          SET last_error = ?, updated_at = ? WHERE openid = ? AND template_id = ?
        `).run(errmsg, dayjs().toISOString(), openid, templateId);
        sendError(response, error);
      }
    }
  );

  app.get(
    '/api/wx-subscribe/deliveries/:id',
    requireSubscribeSession,
    (request, response) => {
      const id = Number(request.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        response.status(400).json({ ok: false, code: 'INVALID_DELIVERY_ID', error: '通知编号无效。' });
        return;
      }
      const row = db.prepare(`
        SELECT id, detail_json, status, created_at, sent_at
        FROM wx_subscribe_deliveries WHERE id = ? AND openid = ?
      `).get(id, request.wxSubscribeOpenId);
      if (!row) {
        response.status(404).json({ ok: false, code: 'DELIVERY_NOT_FOUND', error: '通知不存在。' });
        return;
      }
      let detail = {};
      try { detail = JSON.parse(row.detail_json || '{}'); } catch (_) {}
      response.json({
        ok: true,
        delivery: {
          id: row.id,
          status: row.status,
          createdAt: row.created_at,
          sentAt: row.sent_at,
          detail
        }
      });
    }
  );
};

module.exports._private = {
  buildTestMessage,
  isConfigured
};
