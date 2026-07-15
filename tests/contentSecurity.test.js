const fs = require('fs');
const path = require('path');
const {
  ContentSecurityError,
  issueSessionToken,
  verifySessionToken,
  summarizeCheck,
  isCheckAllowed,
  saveCheck,
  getRecentChecks,
  msgSecCheck,
  imgSecCheck,
  mediaCheckAsync,
  clearAccessTokenCache
} = require('../src/services/wechatContentSecurity');
const { _private: routePrivate } = require('../src/routes/contentSecurity');
const { db, getAgent } = require('./helper');
const config = require('../src/config');

describe('微信内容安全服务', () => {
  const secret = 'test-content-security-session-secret-32-bytes';
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    clearAccessTokenCache();
  });

  test('专用会话令牌可验证且拒绝篡改和过期令牌', () => {
    const now = 1_700_000_000_000;
    const issued = issueSessionToken('openid-test', secret, now);
    expect(verifySessionToken(issued.token, secret, now + 1000)).toEqual({
      openid: 'openid-test',
      expiresAt: issued.expiresAt
    });

    expect(() => verifySessionToken(`${issued.token}x`, secret, now + 1000)).toThrow(ContentSecurityError);
    expect(() => verifySessionToken(issued.token, secret, issued.expiresAt + 1)).toThrow('已过期');
  });

  test('微信返回值按 pass、submitted、review、risky 和错误正确映射', () => {
    const pass = summarizeCheck('msgSecCheck', { errcode: 0, errmsg: 'ok', result: { suggest: 'pass', label: 100 }, trace_id: 'trace-text' });
    const submitted = summarizeCheck('mediaCheckAsync', { errcode: 0, errmsg: 'ok', trace_id: 'trace-1' });
    const review = summarizeCheck('msgSecCheck', { errcode: 0, result: { suggest: 'review', label: 20001 } });
    const risky = summarizeCheck('msgSecCheck', { errcode: 0, result: { suggest: 'risky', label: 20002 } });
    const error = summarizeCheck('imgSecCheck', { errcode: 40164, errmsg: 'invalid ip' });

    expect(pass.status).toBe('passed');
    expect(submitted.status).toBe('submitted');
    expect(submitted.traceId).toBe('trace-1');
    expect(review.status).toBe('review');
    expect(risky.status).toBe('rejected');
    expect(error.status).toBe('error');
    expect(isCheckAllowed(pass)).toBe(true);
    expect(isCheckAllowed(submitted)).toBe(true);
    expect(isCheckAllowed(review)).toBe(false);
  });

  test('空响应及缺少判定字段或 trace_id 的成功码均失败关闭', () => {
    const empty = summarizeCheck('msgSecCheck', {});
    const msgWithoutSuggestion = summarizeCheck('msgSecCheck', { errcode: 0, trace_id: 'trace-only' });
    const msgWithoutTrace = summarizeCheck('msgSecCheck', { errcode: 0, result: { suggest: 'pass', label: 100 } });
    const mediaWithoutTrace = summarizeCheck('mediaCheckAsync', { errcode: 0, errmsg: 'ok' });
    const mediaWithBlankTrace = summarizeCheck('mediaCheckAsync', { errcode: 0, errmsg: 'ok', trace_id: '   ' });
    const malformedErrcode = summarizeCheck('imgSecCheck', { errcode: '', errmsg: 'ok' });
    const legacyImagePass = summarizeCheck('imgSecCheck', { errcode: 0, errmsg: 'ok' });

    expect(empty.status).toBe('error');
    expect(msgWithoutSuggestion.status).toBe('error');
    expect(msgWithoutTrace.status).toBe('error');
    expect(mediaWithoutTrace.status).toBe('error');
    expect(mediaWithBlankTrace.status).toBe('error');
    expect(malformedErrcode.status).toBe('error');
    expect(isCheckAllowed(msgWithoutSuggestion)).toBe(false);
    expect(isCheckAllowed(msgWithoutTrace)).toBe(false);
    expect(isCheckAllowed(mediaWithoutTrace)).toBe(false);
    expect(isCheckAllowed(mediaWithBlankTrace)).toBe(false);
    expect(legacyImagePass.status).toBe('passed');
    expect(isCheckAllowed(legacyImagePass)).toBe(true);
  });

  test('接口原始返回值会落库并可按用户读取', () => {
    const requestId = `test-${Date.now()}`;
    const openid = `openid-${Date.now()}`;
    saveCheck(db, {
      requestId,
      openid,
      apiName: 'msgSecCheck',
      contentType: 'text',
      input: '考研交流测试',
      response: { errcode: 0, errmsg: 'ok', result: { suggest: 'pass', label: 100 }, trace_id: 'saved-trace' }
    });
    const checks = getRecentChecks(db, openid, 5);
    expect(checks[0]).toMatchObject({
      requestId,
      apiName: 'msgSecCheck',
      status: 'passed',
      traceId: 'saved-trace',
      raw: { errcode: 0, errmsg: 'ok', result: { suggest: 'pass', label: 100 }, trace_id: 'saved-trace' }
    });
  });

  test('异步媒体下载签名拒绝过期或篡改参数', () => {
    const filename = 'audit-test.jpg';
    const expires = Math.floor(Date.now() / 1000) + 600;
    const signature = routePrivate.mediaSignature(filename, expires, secret);
    const forumSignature = routePrivate.mediaSignature(filename, expires, secret, 'forum');
    expect(routePrivate.verifyMediaSignature(filename, expires, signature, secret)).toBe(true);
    expect(routePrivate.verifyMediaSignature('other.jpg', expires, signature, secret)).toBe(false);
    expect(routePrivate.verifyMediaSignature(filename, 1, signature, secret)).toBe(false);
    expect(routePrivate.verifyMediaSignature(filename, expires, forumSignature, secret, 'forum')).toBe(true);
    expect(routePrivate.verifyMediaSignature(filename, expires, forumSignature, secret)).toBe(false);
    expect(routePrivate.buildSignedForumMediaUrl({
      sessionSecret: secret,
      contentSecurityPublicBaseUrl: 'https://xiaoeduhub.online'
    }, filename)).toContain('/api/content-security/media/forum/audit-test.jpg?');
  });

  test('msgSecCheck 使用稳定版 token、真实 openid、scene=3 和 version=2', async () => {
    const calls = [];
    global.fetch = jest.fn(async (url, options) => {
      calls.push({ url: String(url), options });
      if (String(url).includes('/cgi-bin/stable_token')) {
        return new Response(JSON.stringify({ access_token: 'access-token-test', expires_in: 7200 }), { status: 200 });
      }
      return new Response(
        JSON.stringify({ errcode: 0, errmsg: 'ok', result: { suggest: 'pass', label: 100 }, trace_id: 'trace-text' }),
        { status: 200 }
      );
    });

    const result = await msgSecCheck(
      { wxAppId: 'wx-test', wxAppSecret: 'secret-test' },
      { content: '考研交流测试', openid: 'openid-real', scene: 3 }
    );
    expect(result.trace_id).toBe('trace-text');
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toContain('/cgi-bin/stable_token');
    expect(JSON.parse(calls[0].options.body)).toMatchObject({
      grant_type: 'client_credential',
      appid: 'wx-test',
      secret: 'secret-test'
    });
    expect(calls[1].url).toContain('/wxa/msg_sec_check?access_token=access-token-test');
    expect(JSON.parse(calls[1].options.body)).toEqual({
      content: '考研交流测试',
      version: 2,
      scene: 3,
      openid: 'openid-real'
    });
  });

  test('图片同步与异步接口分别发送 multipart media 和签名媒体 URL', async () => {
    const calls = [];
    global.fetch = jest.fn(async (url, options) => {
      calls.push({ url: String(url), options });
      if (String(url).includes('/cgi-bin/stable_token')) {
        return new Response(JSON.stringify({ access_token: 'image-token', expires_in: 7200 }), { status: 200 });
      }
      if (String(url).includes('/wxa/img_sec_check')) {
        return new Response(JSON.stringify({ errcode: 0, errmsg: 'ok' }), { status: 200 });
      }
      return new Response(JSON.stringify({ errcode: 0, errmsg: 'ok', trace_id: 'trace-media' }), { status: 200 });
    });

    await imgSecCheck(
      { wxAppId: 'wx-image', wxAppSecret: 'secret-image' },
      { buffer: Buffer.from('fake-image'), filename: 'audit.jpg', contentType: 'image/jpeg' }
    );
    await mediaCheckAsync(
      { wxAppId: 'wx-image', wxAppSecret: 'secret-image' },
      { mediaUrl: 'https://xiaoeduhub.online/api/content-security/media/audit.jpg?sig=test', openid: 'openid-image' }
    );

    const imageCall = calls.find((call) => call.url.includes('/wxa/img_sec_check'));
    const mediaCall = calls.find((call) => call.url.includes('/wxa/media_check_async'));
    expect(imageCall.options.body).toBeInstanceOf(FormData);
    expect(imageCall.options.body.get('media')).toBeTruthy();
    expect(JSON.parse(mediaCall.options.body)).toEqual({
      media_url: 'https://xiaoeduhub.online/api/content-security/media/audit.jpg?sig=test',
      media_type: 2,
      version: 2,
      scene: 3,
      openid: 'openid-image'
    });
  });

  test('健康检查列出三项能力，缺少生产凭据时会阻止建立会话', async () => {
    const agent = getAgent();
    const health = await agent.get('/api/content-security/health');
    expect(health.status).toBe(200);
    expect(health.body.apis).toEqual(['msgSecCheck', 'imgSecCheck', 'mediaCheckAsync']);

    const session = await agent.post('/api/content-security/session').send({ code: 'test-code' });
    expect(session.status).toBe(503);
    expect(session.body).toMatchObject({ ok: false, code: 'WX_CONFIG_MISSING' });
  });

  test('图片接口按文件魔数接受 octet-stream JPEG，并拒绝伪造图片', async () => {
    const originalAppId = config.wxAppId;
    const originalAppSecret = config.wxAppSecret;
    let persistedPath = '';
    config.wxAppId = 'wx-upload-test';
    config.wxAppSecret = 'upload-secret-test';

    global.fetch = jest.fn(async (url) => {
      const requestUrl = String(url);
      if (requestUrl.includes('/cgi-bin/stable_token')) {
        return new Response(JSON.stringify({ access_token: 'upload-token', expires_in: 7200 }), { status: 200 });
      }
      if (requestUrl.includes('/wxa/img_sec_check')) {
        return new Response(JSON.stringify({ errcode: 0, errmsg: 'ok' }), { status: 200 });
      }
      if (requestUrl.includes('/wxa/media_check_async')) {
        return new Response(JSON.stringify({ errcode: 0, errmsg: 'ok', trace_id: 'trace-upload' }), { status: 200 });
      }
      throw new Error(`Unexpected request: ${requestUrl}`);
    });

    try {
      const token = issueSessionToken('openid-upload', config.sessionSecret).token;
      const validJpeg = Buffer.from(
        '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AKpAB//Z',
        'base64'
      );
      const agent = getAgent();
      const accepted = await agent
        .post('/api/content-security/image')
        .set('Authorization', `Bearer ${token}`)
        .attach('media', validJpeg, { filename: 'candidate.bin', contentType: 'application/octet-stream' });

      expect(accepted.status).toBe(200);
      expect(accepted.body).toMatchObject({ ok: true, allowed: true, saved: true });
      expect(accepted.body.checks.map((check) => check.apiName)).toEqual(['imgSecCheck', 'mediaCheckAsync']);

      const imageCall = global.fetch.mock.calls.find(([url]) => String(url).includes('/wxa/img_sec_check'));
      const uploadedMedia = imageCall[1].body.get('media');
      expect(uploadedMedia.type).toBe('image/jpeg');
      expect(uploadedMedia.name).toMatch(/\.jpg$/);

      const mediaCall = global.fetch.mock.calls.find(([url]) => String(url).includes('/wxa/media_check_async'));
      const mediaPayload = JSON.parse(mediaCall[1].body);
      const persistedFilename = path.basename(new URL(mediaPayload.media_url).pathname);
      persistedPath = path.join(config.uploadRootDir, 'content-security', persistedFilename);
      expect(fs.existsSync(persistedPath)).toBe(true);

      const fetchCallCount = global.fetch.mock.calls.length;
      const rejected = await agent
        .post('/api/content-security/image')
        .set('Authorization', `Bearer ${token}`)
        .attach('media', Buffer.from('not an image'), { filename: 'forged.jpg', contentType: 'image/jpeg' });

      expect(rejected.status).toBe(400);
      expect(rejected.body).toMatchObject({ ok: false, code: 'INVALID_IMAGE' });
      expect(global.fetch).toHaveBeenCalledTimes(fetchCallCount);
    } finally {
      if (persistedPath && fs.existsSync(persistedPath)) fs.unlinkSync(persistedPath);
      config.wxAppId = originalAppId;
      config.wxAppSecret = originalAppSecret;
      clearAccessTokenCache();
    }
  });
});
