const fs = require('fs');
const path = require('path');
const dayjs = require('dayjs');
const { db, getAgent, createStudent, loginAs } = require('./helper');
const config = require('../src/config');
const { clearAccessTokenCache } = require('../src/services/wechatContentSecurity');

const JPEG_BUFFER = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);

function responseJson(value, status = 200) {
  return new Response(JSON.stringify(value), { status });
}

function installWechatFetch({
  msgResponse = { errcode: 0, errmsg: 'ok', result: { suggest: 'pass', label: 100 }, trace_id: 'trace-msg' },
  imageResponse = { errcode: 0, errmsg: 'ok' },
  mediaResponse = { errcode: 0, errmsg: 'ok', trace_id: 'trace-media' }
} = {}) {
  global.fetch = jest.fn(async (url) => {
    const requestUrl = String(url);
    if (requestUrl.includes('/cgi-bin/stable_token')) {
      return responseJson({ access_token: 'forum-access-token', expires_in: 7200 });
    }
    if (requestUrl.includes('/wxa/msg_sec_check')) return responseJson(msgResponse);
    if (requestUrl.includes('/wxa/img_sec_check')) return responseJson(imageResponse);
    if (requestUrl.includes('/wxa/media_check_async')) return responseJson(mediaResponse);
    throw new Error(`Unexpected WeChat URL: ${requestUrl}`);
  });
  return global.fetch;
}

function forumDirectoryEntries() {
  const directory = path.join(config.uploadRootDir, 'forum');
  fs.mkdirSync(directory, { recursive: true });
  return new Set(fs.readdirSync(directory));
}

function absoluteUploadPath(publicPath) {
  const relative = String(publicPath || '').replace(/^\/uploads[\\/]/, '');
  return path.join(config.uploadRootDir, relative);
}

describe('论坛最终发布边界的微信内容安全检测', () => {
  const originalFetch = global.fetch;
  const originalConfig = {
    wxAppId: config.wxAppId,
    wxAppSecret: config.wxAppSecret,
    contentSecurityPublicBaseUrl: config.contentSecurityPublicBaseUrl
  };
  let sequence = 0;
  let user;
  let agent;
  let token;
  const filesToDelete = new Set();

  beforeEach(async () => {
    sequence += 1;
    clearAccessTokenCache();
    config.wxAppId = 'wx-forum-test';
    config.wxAppSecret = 'forum-secret-test';
    config.contentSecurityPublicBaseUrl = 'https://xiaoeduhub.online';
    user = createStudent({ username: `forum_security_${Date.now()}_${sequence}` });
    db.prepare('UPDATE users SET openid = ? WHERE id = ?').run(`openid-forum-${sequence}`, user.id);
    agent = getAgent();
    const login = await loginAs(agent, user.username);
    token = login.token;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    clearAccessTokenCache();
    for (const filename of filesToDelete) {
      try { fs.unlinkSync(filename); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    filesToDelete.clear();
  });

  afterAll(() => {
    config.wxAppId = originalConfig.wxAppId;
    config.wxAppSecret = originalConfig.wxAppSecret;
    config.contentSecurityPublicBaseUrl = originalConfig.contentSecurityPublicBaseUrl;
  });

  test('发帖对规范化文字和最终图片字节调用三项接口，并生成可读取的论坛签名 URL', async () => {
    const fetchMock = installWechatFetch();
    const response = await agent
      .post('/api/forum/topics')
      .set('Authorization', `Bearer ${token}`)
      .field('title', '<b>安全标题</b>')
      .field('content', '正常交流内容 #复习计划#')
      .field('category', '考研交流')
      .field('links', '[]')
      .attach('images', JPEG_BUFFER, { filename: '复习截图.jpg', contentType: 'image/jpeg' });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ ok: true, moderationStatus: 'approved' });

    const topic = db.prepare('SELECT * FROM forum_topics WHERE id = ?').get(response.body.id);
    expect(topic.title).toBe('安全标题');
    for (const publicPath of JSON.parse(topic.image_paths)) filesToDelete.add(absoluteUploadPath(publicPath));

    const msgCall = fetchMock.mock.calls.find(([url]) => String(url).includes('/wxa/msg_sec_check'));
    const imageCall = fetchMock.mock.calls.find(([url]) => String(url).includes('/wxa/img_sec_check'));
    const mediaCall = fetchMock.mock.calls.find(([url]) => String(url).includes('/wxa/media_check_async'));
    expect(JSON.parse(msgCall[1].body).content).toContain('标题：安全标题');
    expect(imageCall[1].body).toBeInstanceOf(FormData);

    const mediaBody = JSON.parse(mediaCall[1].body);
    expect(mediaBody).toMatchObject({ media_type: 2, version: 2, scene: 3, openid: `openid-forum-${sequence}` });
    expect(mediaBody.media_url).toContain('/api/content-security/media/forum/');
    const signedUrl = new URL(mediaBody.media_url);
    const signedDownload = await getAgent().get(`${signedUrl.pathname}${signedUrl.search}`);
    expect(signedDownload.status).toBe(200);

    const checks = db.prepare(
      `SELECT api_name, status, input_digest FROM content_security_checks
        WHERE user_hash = (SELECT user_hash FROM content_security_checks WHERE api_name = 'msgSecCheck' ORDER BY id DESC LIMIT 1)
        ORDER BY id DESC LIMIT 3`
    ).all().reverse();
    expect(checks.map((check) => [check.api_name, check.status])).toEqual([
      ['msgSecCheck', 'passed'],
      ['imgSecCheck', 'passed'],
      ['mediaCheckAsync', 'submitted']
    ]);
    expect(checks[1].input_digest).toBe(checks[2].input_digest);
  });

  test('msgSecCheck 缺少 trace_id 时拒绝发帖且不落库', async () => {
    installWechatFetch({
      msgResponse: { errcode: 0, errmsg: 'ok', result: { suggest: 'pass', label: 100 } }
    });
    const title = `缺少追踪标识-${sequence}`;
    const response = await agent
      .post('/api/forum/topics')
      .set('Authorization', `Bearer ${token}`)
      .field('title', title)
      .field('content', '这段文字不应被发布')
      .field('links', '[]');

    expect(response.status).toBe(503);
    expect(response.body.code).toBe('CONTENT_SECURITY_UNAVAILABLE');
    expect(db.prepare('SELECT id FROM forum_topics WHERE title = ?').get(title)).toBeUndefined();
    const latest = db.prepare("SELECT status FROM content_security_checks WHERE api_name = 'msgSecCheck' ORDER BY id DESC LIMIT 1").get();
    expect(latest.status).toBe('error');
  });

  test('业务账号未绑定真实 openid 时拒绝发布且不调用微信接口', async () => {
    const fetchMock = installWechatFetch();
    db.prepare("UPDATE users SET openid = '' WHERE id = ?").run(user.id);
    const title = `缺少微信身份-${sequence}`;
    const response = await agent
      .post('/api/forum/topics')
      .set('Authorization', `Bearer ${token}`)
      .field('title', title)
      .field('content', '不能使用伪造用户标识调用内容安全接口')
      .field('links', '[]');

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('WECHAT_IDENTITY_REQUIRED');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(db.prepare('SELECT id FROM forum_topics WHERE title = ?').get(title)).toBeUndefined();
  });

  test('mediaCheckAsync 缺少 trace_id 时拒绝发帖并清理本次图片', async () => {
    installWechatFetch({ mediaResponse: { errcode: 0, errmsg: 'ok' } });
    const before = forumDirectoryEntries();
    const title = `异步响应不完整-${sequence}`;
    const response = await agent
      .post('/api/forum/topics')
      .set('Authorization', `Bearer ${token}`)
      .field('title', title)
      .field('content', '图片检测必须完整成功')
      .field('links', '[]')
      .attach('images', JPEG_BUFFER, { filename: '待清理.jpg', contentType: 'image/jpeg' });

    expect(response.status).toBe(503);
    expect(response.body.code).toBe('CONTENT_SECURITY_UNAVAILABLE');
    expect(db.prepare('SELECT id FROM forum_topics WHERE title = ?').get(title)).toBeUndefined();
    expect(forumDirectoryEntries()).toEqual(before);
    const latest = db.prepare("SELECT status FROM content_security_checks WHERE api_name = 'mediaCheckAsync' ORDER BY id DESC LIMIT 1").get();
    expect(latest.status).toBe('error');
  });

  test('普通附件强制进入 pending，使用正确 content_reports 字段且不发送提及通知', async () => {
    installWechatFetch();
    const mentioned = createStudent({ username: `mentioned_${Date.now()}_${sequence}` });
    const response = await agent
      .post('/api/forum/topics')
      .set('Authorization', `Bearer ${token}`)
      .field('title', `附件待复核-${sequence}`)
      .field('content', `请查看资料 @${mentioned.username}`)
      .field('links', '[]')
      .attach('attachments', Buffer.from('review notes'), { filename: '资料.txt', contentType: 'text/plain' });

    expect(response.status).toBe(200);
    expect(response.body.moderationStatus).toBe('pending');
    const topic = db.prepare('SELECT * FROM forum_topics WHERE id = ?').get(response.body.id);
    for (const publicPath of JSON.parse(topic.attachment_paths)) filesToDelete.add(absoluteUploadPath(publicPath));
    const report = db.prepare(
      "SELECT reporter_id, target_type, target_id, status, reason FROM content_reports WHERE target_type = 'topic' AND target_id = ?"
    ).get(response.body.id);
    expect(report).toMatchObject({
      reporter_id: user.id,
      target_type: 'topic',
      target_id: response.body.id,
      status: 'pending'
    });
    expect(report.reason).toContain('普通附件');
    expect(db.prepare("SELECT id FROM notifications WHERE student_id = ? AND type = 'mention'").get(mentioned.id)).toBeUndefined();
  });

  test('回复得到 review 结论时拒绝并且不写入回复表', async () => {
    const topic = db.prepare(
      `INSERT INTO forum_topics (user_id, title, content, moderation_status, created_at)
       VALUES (?, ?, ?, 'approved', ?)`
    ).run(user.id, `回复目标-${sequence}`, '已有正文', dayjs().toISOString());
    installWechatFetch({
      msgResponse: {
        errcode: 0,
        errmsg: 'ok',
        result: { suggest: 'review', label: 20001 },
        trace_id: 'trace-review'
      }
    });

    const response = await agent
      .post(`/api/forum/topics/${topic.lastInsertRowid}/replies`)
      .set('Authorization', `Bearer ${token}`)
      .field('content', '这条回复需要复核')
      .field('links', '[]');

    expect(response.status).toBe(422);
    expect(response.body.code).toBe('CONTENT_SECURITY_REJECTED');
    expect(db.prepare('SELECT id FROM forum_replies WHERE topic_id = ?').get(topic.lastInsertRowid)).toBeUndefined();
  });
});
