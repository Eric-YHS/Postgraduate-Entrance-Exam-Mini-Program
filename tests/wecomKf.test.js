const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');

const { app } = require('./helper');
const config = require('../src/config');
const wecom = require('../src/services/wecom');
const dispatcher = require('../src/services/wecomKfDispatcher');
const {
  createWecomKfClient,
  utf8Chunks,
} = require('../src/services/wecomKf');

function jsonResponse(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json' },
    text: jest.fn().mockResolvedValue(JSON.stringify(data)),
    arrayBuffer: jest.fn().mockResolvedValue(Buffer.from(JSON.stringify(data))),
  };
}

describe('微信客服 API 客户端', () => {
  test('缓存自建应用 access_token 并分页读取客服账号', async () => {
    const fetch = jest.fn()
      .mockResolvedValueOnce(jsonResponse({ errcode: 0, access_token: 'token-one', expires_in: 7200 }))
      .mockResolvedValueOnce(jsonResponse({
        errcode: 0,
        account_list: [{ open_kfid: 'wk_1', name: '咨询客服' }],
      }))
      .mockResolvedValueOnce(jsonResponse({
        errcode: 0,
        url: 'https://work.weixin.qq.com/kf/example',
      }));
    const client = createWecomKfClient({
      fetch,
      corpId: 'ww_test',
      secret: 'secret_test',
      maxAttempts: 1,
    });

    await expect(client.listAccounts()).resolves.toEqual([
      expect.objectContaining({ open_kfid: 'wk_1' }),
    ]);
    await client.getContactWay('wk_1');

    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch.mock.calls.filter(([url]) => String(url).includes('/gettoken'))).toHaveLength(1);
  });

  test('access_token 失效时清缓存并自动获取新 token 重试', async () => {
    const fetch = jest.fn()
      .mockResolvedValueOnce(jsonResponse({ errcode: 0, access_token: 'old-token', expires_in: 7200 }))
      .mockResolvedValueOnce(jsonResponse({ errcode: 40014, errmsg: 'invalid access_token' }))
      .mockResolvedValueOnce(jsonResponse({ errcode: 0, access_token: 'new-token', expires_in: 7200 }))
      .mockResolvedValueOnce(jsonResponse({ errcode: 0, url: 'https://work.weixin.qq.com/kf/example' }));
    const client = createWecomKfClient({
      fetch,
      corpId: 'ww_test',
      secret: 'secret_test',
      maxAttempts: 4,
      sleep: jest.fn(),
    });

    await expect(client.getContactWay('wk_1')).resolves.toMatchObject({
      url: expect.stringContaining('/kf/'),
    });
    expect(fetch.mock.calls[3][0]).toContain('access_token=new-token');
  });

  test('sync_msg 发送 cursor、回调 token、账号和 AMR 语音格式', async () => {
    const fetch = jest.fn()
      .mockResolvedValueOnce(jsonResponse({ errcode: 0, access_token: 'token', expires_in: 7200 }))
      .mockResolvedValueOnce(jsonResponse({ errcode: 0, next_cursor: 'next', has_more: 0, msg_list: [] }));
    const client = createWecomKfClient({
      fetch,
      corpId: 'ww_test',
      secret: 'secret_test',
      maxAttempts: 1,
    });

    await client.syncMessages({
      openKfid: 'wk_1',
      cursor: 'cursor_1',
      token: 'callback_token',
      voiceFormat: 0,
    });
    const body = JSON.parse(fetch.mock.calls[1][1].body);
    expect(body).toMatchObject({
      open_kfid: 'wk_1',
      cursor: 'cursor_1',
      token: 'callback_token',
      voice_format: 0,
      limit: 1000,
    });
  });

  test('按企业微信 2048 字节和最多 5 条安全切分中文回复', () => {
    const chunks = utf8Chunks('中'.repeat(5000), 2048, 5);
    expect(chunks.length).toBeLessThanOrEqual(5);
    expect(chunks.every((chunk) => Buffer.byteLength(chunk) <= 2048)).toBe(true);
    expect(chunks.join('')).toContain('[回复内容较长，已截断]');
  });

  test('媒体下载只把二进制写入指定私有路径', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'wecom-kf-client-'));
    const destination = path.join(root, 'nested', 'image.bin');
    const fetch = jest.fn()
      .mockResolvedValueOnce(jsonResponse({ errcode: 0, access_token: 'token', expires_in: 7200 }))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: { get: (name) => (name === 'content-type' ? 'image/jpeg' : '') },
        arrayBuffer: jest.fn().mockResolvedValue(Buffer.from([0xff, 0xd8, 0xff, 0x01])),
      });
    const client = createWecomKfClient({
      fetch,
      corpId: 'ww_test',
      secret: 'secret_test',
      maxAttempts: 1,
    });

    await expect(client.downloadMedia('media_1', destination)).resolves.toMatchObject({ bytes: 4 });
    await expect(fs.promises.readFile(destination)).resolves.toEqual(Buffer.from([0xff, 0xd8, 0xff, 0x01]));
    await fs.promises.rm(root, { recursive: true, force: true });
  });
});

describe('微信客服加密回调', () => {
  const original = {};

  beforeEach(() => {
    for (const key of [
      'wecomCorpId',
      'wecomToken',
      'wecomEncodingAesKey',
      'wecomKfToken',
      'wecomKfEncodingAesKey',
      'wecomKfEnabled',
    ]) {
      original[key] = config[key];
    }
    config.wecomCorpId = 'ww_callback_test';
    config.wecomKfToken = 'callback-token';
    config.wecomKfEncodingAesKey = Buffer.alloc(32, 7).toString('base64').replace(/=$/, '');
    config.wecomToken = config.wecomKfToken;
    config.wecomEncodingAesKey = config.wecomKfEncodingAesKey;
    config.wecomKfEnabled = true;
  });

  afterEach(() => {
    Object.assign(config, original);
    jest.restoreAllMocks();
  });

  test('GET 验证返回解密后的 echostr', async () => {
    const timestamp = '1700000000';
    const nonce = 'nonce_get';
    const encrypted = wecom.encryptMessage(
      config.wecomKfEncodingAesKey,
      'verified_echo',
      config.wecomCorpId
    );
    const signature = wecom.computeSignature(config.wecomKfToken, timestamp, nonce, encrypted);

    const response = await request(app)
      .get('/api/wecom/kf/callback')
      .query({ msg_signature: signature, timestamp, nonce, echostr: encrypted })
      .expect(200);
    expect(response.text).toBe('verified_echo');
  });

  test('POST 先返回 success，再用回调 token 触发指定客服账号同步', async () => {
    const timestamp = '1700000001';
    const nonce = 'nonce_post';
    const callbackToken = 'sync-token-not-logged';
    const inner = `<xml>
      <ToUserName><![CDATA[${config.wecomCorpId}]]></ToUserName>
      <CreateTime>1700000001</CreateTime>
      <MsgType><![CDATA[event]]></MsgType>
      <Event><![CDATA[kf_msg_or_event]]></Event>
      <Token><![CDATA[${callbackToken}]]></Token>
      <OpenKfId><![CDATA[wk_callback]]></OpenKfId>
    </xml>`;
    const encrypted = wecom.encryptMessage(
      config.wecomKfEncodingAesKey,
      inner,
      config.wecomCorpId
    );
    const signature = wecom.computeSignature(config.wecomKfToken, timestamp, nonce, encrypted);
    const outer = `<xml>
      <ToUserName><![CDATA[${config.wecomCorpId}]]></ToUserName>
      <Encrypt><![CDATA[${encrypted}]]></Encrypt>
    </xml>`;
    const syncSpy = jest.spyOn(dispatcher, 'syncAccount').mockResolvedValue({ messages: 0 });

    const response = await request(app)
      .post('/api/wecom/kf/callback')
      .query({ msg_signature: signature, timestamp, nonce })
      .set('Content-Type', 'text/xml')
      .send(outer)
      .expect(200);
    expect(response.text).toBe('success');
    await new Promise((resolve) => setImmediate(resolve));
    expect(syncSpy).toHaveBeenCalledWith('wk_callback', callbackToken);
  });

  test('自建应用原有接收消息回调也能触发微信客服同步', async () => {
    const timestamp = '1700000002';
    const nonce = 'nonce_shared_callback';
    const callbackToken = 'shared-sync-token';
    const inner = `<xml>
      <ToUserName><![CDATA[${config.wecomCorpId}]]></ToUserName>
      <CreateTime>1700000002</CreateTime>
      <MsgType><![CDATA[event]]></MsgType>
      <Event><![CDATA[kf_msg_or_event]]></Event>
      <Token><![CDATA[${callbackToken}]]></Token>
      <OpenKfId><![CDATA[wk_shared_callback]]></OpenKfId>
    </xml>`;
    const encrypted = wecom.encryptMessage(
      config.wecomEncodingAesKey,
      inner,
      config.wecomCorpId
    );
    const signature = wecom.computeSignature(config.wecomToken, timestamp, nonce, encrypted);
    const outer = `<xml>
      <ToUserName><![CDATA[${config.wecomCorpId}]]></ToUserName>
      <Encrypt><![CDATA[${encrypted}]]></Encrypt>
    </xml>`;
    const syncSpy = jest.spyOn(dispatcher, 'syncAccount').mockResolvedValue({ messages: 0 });

    const response = await request(app)
      .post('/api/wecom/callback')
      .query({ msg_signature: signature, timestamp, nonce })
      .set('Content-Type', 'text/xml')
      .send(outer)
      .expect(200);
    expect(response.text).toBe('success');
    await new Promise((resolve) => setImmediate(resolve));
    expect(syncSpy).toHaveBeenCalledWith('wk_shared_callback', callbackToken);
  });
});
