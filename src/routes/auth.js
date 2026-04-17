const crypto = require('crypto');
const dayjs = require('dayjs');
const bcrypt = require('bcryptjs');
const config = require('../config');
const { sanitizeText } = require('../utils/sanitize');

const MAX_CONTENT_LENGTH = 10000;

module.exports = function registerAuthRoutes(app, shared) {
  const { db, sanitizeUser, requireAuth, getUserById, getBearerToken, getUserByToken, getOrCreateAuthToken, createAuthToken, clearAuthToken, checkLoginRateLimit, checkRegisterRateLimit, fetchJson } = shared;

  app.post('/api/auth/wx-login', async (request, response) => {
    const { code } = request.body;
    if (!code) {
      response.status(400).json({ error: '缺少登录凭证。' });
      return;
    }

    try {
      const wxUrl = `https://api.weixin.qq.com/sns/jscode2session?appid=${config.wxAppId}&secret=${config.wxAppSecret}&js_code=${encodeURIComponent(code)}&grant_type=authorization_code`;
      const wxData = await fetchJson(wxUrl);

      if (!wxData.openid) {
        // BUG-081: 不泄露微信 API 内部错误信息
        console.error('微信登录失败:', wxData.errmsg || '未获取到用户标识');
        response.status(400).json({ error: '微信登录失败，请重试。' });
        return;
      }

      let user = db.prepare('SELECT * FROM users WHERE openid = ?').get(wxData.openid);

      if (!user) {
        const now = dayjs().toISOString();
        // BUG-078: 生成唯一用户名，避免 openid 后 8 位冲突
        let username = `wx_${wxData.openid.slice(-8)}`;
        let suffix = 0;
        while (db.prepare('SELECT id FROM users WHERE username = ?').get(username)) {
          suffix += 1;
          username = `wx_${wxData.openid.slice(-8)}_${suffix}`;
        }
        const result = db.prepare(
          'INSERT INTO users (username, password, role, display_name, class_name, openid, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).run(
          username,
          bcrypt.hashSync(crypto.randomBytes(16).toString('hex'), 10),
          'student',
          '微信用户',
          '',
          wxData.openid,
          now
        );
        user = db.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid);
      }

      request.session.userId = user.id;
      const token = createAuthToken(user.id);
      response.json({
        user: sanitizeUser(user),
        token,
        expiresInDays: config.tokenTtlDays
      });
    } catch (error) {
      response.status(500).json({ error: '微信登录失败，请重试。' });
    }
  });

  // BUG-058: 登录接口添加速率限制
  app.post('/api/auth/login', checkLoginRateLimit, (request, response, next) => {
    const { username, password } = request.body;

    if (!username || !password) {
      response.status(400).json({ error: '请输入账号和密码。' });
      return;
    }

    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(String(username).trim());

    if (!user) {
      response.status(401).json({ error: '账号或密码错误。' });
      return;
    }

    const passwordMatch = bcrypt.compareSync(String(password).trim(), user.password);
    if (!passwordMatch) {
      response.status(401).json({ error: '账号或密码错误。' });
      return;
    }

    // BUG-304: 登录后重新生成 session，防止 Session Fixation
    request.session.regenerate(() => {
      request.session.userId = user.id;
      // BUG-008: 复用已有未过期 Token，避免 token 表膨胀
      const token = getOrCreateAuthToken(user.id);
      response.json({
        user: sanitizeUser(user),
        token,
        expiresInDays: config.tokenTtlDays
      });
    });
  });

  app.get('/api/auth/me', (request, response, next) => {
    const sessionUser = request.session.userId ? getUserById(request.session.userId) : null;
    const authToken = getBearerToken(request);
    const tokenUser = getUserByToken(authToken);
    const user = sessionUser || tokenUser;
    let token = authToken;
    if (user && !token) {
      token = getOrCreateAuthToken(user.id);
    }
    response.json({ user: sanitizeUser(user), token: token || null });
  });

  app.post('/api/auth/logout', (request, response, next) => {
    const authToken = getBearerToken(request);

    // 只清除当前请求携带的 Token，不影响其他设备
    clearAuthToken(authToken);

    request.session.destroy(() => {
      response.json({ ok: true });
    });
  });

  // BUG-010: 修改密码接口（用于强制修改默认密码）
  app.post('/api/auth/change-password', requireAuth, (request, response) => {
    const { oldPassword, newPassword } = request.body;
    const trimmedNewPassword = String(newPassword || '').trim();

    if (!oldPassword || !trimmedNewPassword) {
      response.status(400).json({ error: '请输入旧密码和新密码。' });
      return;
    }

    if (trimmedNewPassword.length < 6) {
      response.status(400).json({ error: '新密码长度不能少于6位。' });
      return;
    }

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(request.currentUser.id);
    if (!bcrypt.compareSync(String(oldPassword).trim(), user.password)) {
      response.status(401).json({ error: '旧密码不正确。' });
      return;
    }

    db.prepare('UPDATE users SET password = ?, must_change_password = 0 WHERE id = ?')
      .run(bcrypt.hashSync(trimmedNewPassword, 10), user.id);

    response.json({ ok: true });
  });

  // 教师注册申请
  app.post('/api/auth/register/teacher', checkRegisterRateLimit, (request, response) => {
    const { username, password, displayName, className, motivation } = request.body;
    const trimmedUsername = String(username || '').trim();
    const trimmedPassword = String(password || '').trim();
    const trimmedDisplayName = sanitizeText(displayName);

    if (!trimmedUsername || !trimmedPassword || !trimmedDisplayName) {
      response.status(400).json({ error: '请填写用户名、密码和显示名称。' });
      return;
    }

    if (trimmedPassword.length < 6) {
      response.status(400).json({ error: '密码长度不能少于6位。' });
      return;
    }

    const existingUser = db.prepare('SELECT id FROM users WHERE username = ?').get(trimmedUsername);
    if (existingUser) {
      response.status(400).json({ error: '该用户名已被使用。' });
      return;
    }

    const existingApp = db.prepare('SELECT id FROM teacher_applications WHERE username = ?').get(trimmedUsername);
    if (existingApp) {
      response.status(400).json({ error: '该用户名已有待审核的注册申请。' });
      return;
    }

    const now = dayjs().toISOString();
    db.prepare(
      `INSERT INTO teacher_applications (username, password, display_name, class_name, motivation, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?)`
    ).run(
      trimmedUsername,
      bcrypt.hashSync(trimmedPassword, 10),
      trimmedDisplayName,
      sanitizeText(className),
      String(motivation || '').trim().slice(0, MAX_CONTENT_LENGTH),
      now
    );

    response.json({ ok: true, message: '注册申请已提交，请等待管理员审核。' });
  });
};
