const { EventEmitter } = require('events');
const https = require('https');

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-secret-for-wx-push';
process.env.WX_APP_ID = 'wx27fca32a9ddfdc8e';
process.env.WX_APP_SECRET = 'test-app-secret';

describe('微信订阅消息发送服务', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.resetModules();
  });

  test('将开发版状态写入微信请求体并返回发送结果', async () => {
    jest.spyOn(https, 'get').mockImplementation((_url, callback) => {
      const request = new EventEmitter();
      const response = new EventEmitter();
      process.nextTick(() => {
        callback(response);
        response.emit('data', Buffer.from(JSON.stringify({ access_token: 'test-token', expires_in: 7200 })));
        response.emit('end');
      });
      return request;
    });

    let sentBody = '';
    jest.spyOn(https, 'request').mockImplementation((_url, requestOptions, callback) => {
      const request = new EventEmitter();
      const response = new EventEmitter();
      request.write = (body) => { sentBody = body; };
      request.end = () => {
        process.nextTick(() => {
          callback(response);
          response.emit('data', Buffer.from(JSON.stringify({ errcode: 0, errmsg: 'ok' })));
          response.emit('end');
        });
      };
      expect(requestOptions).toMatchObject({ method: 'POST' });
      return request;
    });

    const wxPush = require('../src/services/wxPush');
    const result = await wxPush.sendSubscribeMessage(
      'test-openid',
      'test-template',
      { thing1: { value: 'test' } },
      'pages/notification/detail/detail?id=1',
      { miniprogramState: 'developer' }
    );

    expect(result).toEqual({ errcode: 0, errmsg: 'ok' });
    expect(JSON.parse(sentBody)).toMatchObject({
      touser: 'test-openid',
      template_id: 'test-template',
      miniprogram_state: 'developer'
    });
  });
});
