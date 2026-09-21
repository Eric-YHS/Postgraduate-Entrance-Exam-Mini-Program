const dayjs = require('dayjs');
const { getAgent, db } = require('./helper');
const config = require('../src/config');
const wxPush = require('../src/services/wxPush');
const { issueSessionToken } = require('../src/services/wechatContentSecurity');
const { _private } = require('../src/routes/wxSubscribe');
const { csrfCheck } = require('../src/server');

describe('微信小程序长期订阅测试链路', () => {
  const templateId = 'JrqDXsnU8_HMWWvF_ZxZOYpjheppx2rFs43qWFElIl0';
  let sendSpy;

  beforeEach(() => {
    config.wxAppId = config.expectedWxAppId;
    config.wxAppSecret = 'test-app-secret';
    config.wxSubscribeTestTemplateId = templateId;
    config.wxSubscribeTestFixedKey = 'short_thing1';
    config.wxSubscribeTestDateKey = 'time2';
    config.wxSubscribeTestNumberKey = 'character_string3';
    config.wxSubscribeTestTipKey = 'thing4';
    config.wxSubscribeMiniprogramState = 'developer';
    sendSpy = jest.spyOn(wxPush, 'sendSubscribeMessage').mockResolvedValue({ errcode: 0, errmsg: 'ok' });
  });

  afterEach(() => {
    sendSpy.mockRestore();
  });

  test('按官方字段构造今日复习提醒内容', () => {
    const message = _private.buildTestMessage(config, dayjs('2026-07-24 12:34:56'));
    expect(message.data).toEqual({
      short_thing1: { value: '今日复习' },
      time2: { value: '2026年7月24日' },
      character_string3: { value: 'No.20260724123456' },
      thing4: { value: '记得当天完成，22点前发给学长' }
    });
    expect(message.detail.content).toContain('🗡️打卡第110天');
    expect(message.detail.content).toContain('🔥今日完成\n\n1.复习200');
  });

  test('订阅会话初始化接口不受网页 CSRF 来源校验阻断', () => {
    const originalNodeEnv = config.nodeEnv;
    config.nodeEnv = 'production';
    const response = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn()
    };
    const next = jest.fn();

    try {
      csrfCheck({
        method: 'POST',
        path: '/api/wx-subscribe/session',
        headers: {
          host: 'xiaoeduhub.online',
          referer: 'https://servicewechat.com/wx27fca32a9ddfdc8e/page-frame.html'
        }
      }, response, next);
    } finally {
      config.nodeEnv = originalNodeEnv;
    }

    expect(next).toHaveBeenCalledTimes(1);
    expect(response.status).not.toHaveBeenCalled();

    const protectedResponse = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn()
    };
    config.nodeEnv = 'production';
    try {
      csrfCheck({
        method: 'POST',
        path: '/api/wx-subscribe/test',
        headers: {
          host: 'xiaoeduhub.online',
          referer: 'https://servicewechat.com/wx27fca32a9ddfdc8e/page-frame.html'
        }
      }, protectedResponse, jest.fn());
    } finally {
      config.nodeEnv = originalNodeEnv;
    }
    expect(protectedResponse.status).toHaveBeenCalledWith(403);
  });

  test('授权会话只给本人发送并只允许本人读取详情', async () => {
    const openid = `subscribe-openid-${Date.now()}`;
    const token = issueSessionToken(openid, config.sessionSecret).token;
    const agent = getAgent();

    const response = await agent
      .post('/api/wx-subscribe/test')
      .set('Authorization', `Bearer ${token}`)
      .send({});

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ ok: true });
    expect(sendSpy).toHaveBeenCalledTimes(1);
    const [targetOpenid, targetTemplateId, data, page, options] = sendSpy.mock.calls[0];
    expect(targetOpenid).toBe(openid);
    expect(targetTemplateId).toBe(templateId);
    expect(data).toMatchObject({
      short_thing1: { value: '今日复习' },
      time2: { value: expect.stringMatching(/^\d{4}年\d{1,2}月\d{1,2}日$/) },
      character_string3: { value: expect.stringMatching(/^No\.\d{14}$/) },
      thing4: { value: '记得当天完成，22点前发给学长' }
    });
    expect(page).toBe(`pages/notification/detail/detail?id=${response.body.deliveryId}`);
    expect(options).toEqual({ miniprogramState: 'developer' });

    const row = db.prepare('SELECT * FROM wx_subscribe_deliveries WHERE id = ?').get(response.body.deliveryId);
    expect(row).toMatchObject({ openid, template_id: templateId, status: 'sent', errcode: 0, errmsg: 'ok' });

    const ownDetail = await agent
      .get(`/api/wx-subscribe/deliveries/${response.body.deliveryId}`)
      .set('Authorization', `Bearer ${token}`);
    expect(ownDetail.status).toBe(200);
    expect(ownDetail.body.delivery.detail).toMatchObject({
      title: '今日复习',
      fixedContent: '今日复习',
      content: expect.stringContaining('姓名：凯迪')
    });

    const otherToken = issueSessionToken(`${openid}-other`, config.sessionSecret).token;
    const otherDetail = await agent
      .get(`/api/wx-subscribe/deliveries/${response.body.deliveryId}`)
      .set('Authorization', `Bearer ${otherToken}`);
    expect(otherDetail.status).toBe(404);
  });

  test('微信拒绝发送时记录失败状态和失效订阅', async () => {
    sendSpy.mockResolvedValue({ errcode: 43101, errmsg: 'user refuse to accept the msg' });
    const openid = `subscribe-rejected-${Date.now()}`;
    const token = issueSessionToken(openid, config.sessionSecret).token;

    const response = await getAgent()
      .post('/api/wx-subscribe/test')
      .set('Authorization', `Bearer ${token}`)
      .send({});

    expect(response.status).toBe(502);
    expect(response.body).toMatchObject({
      ok: false,
      code: 'WX_SUBSCRIBE_SEND_FAILED',
      wxErrcode: 43101
    });
    const delivery = db.prepare('SELECT status, errcode FROM wx_subscribe_deliveries WHERE id = ?')
      .get(response.body.deliveryId);
    expect(delivery).toEqual({ status: 'failed', errcode: 43101 });
    const recipient = db.prepare(`
      SELECT status FROM wx_subscribe_recipients WHERE openid = ? AND template_id = ?
    `).get(openid, templateId);
    expect(recipient.status).toBe('invalid');
  });
});
