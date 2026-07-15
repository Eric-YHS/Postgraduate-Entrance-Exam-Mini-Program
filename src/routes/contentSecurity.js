const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const {
  ContentSecurityError,
  exchangeLoginCode,
  issueSessionToken,
  verifySessionToken,
  msgSecCheck,
  imgSecCheck,
  mediaCheckAsync,
  isCheckAllowed,
  saveCheck,
  getRecentChecks
} = require('../services/wechatContentSecurity');

const MAX_TEXT_LENGTH = 1000;
const MAX_SYNC_IMAGE_SIZE = 1024 * 1024;
const MEDIA_URL_TTL_SECONDS = 2 * 60 * 60;
const MEDIA_RETENTION_MS = 24 * 60 * 60 * 1000;
const TEMPORARY_MEDIA_SCOPE = 'content-security';
const FORUM_MEDIA_SCOPE = 'forum';
const ALLOWED_MEDIA_SCOPES = new Set([TEMPORARY_MEDIA_SCOPE, FORUM_MEDIA_SCOPE]);
const ALLOWED_IMAGE_TYPES = new Map([
  ['image/jpeg', '.jpg'],
  ['image/png', '.png']
]);
const ALLOWED_UPLOAD_MIME_TYPES = new Set([
  ...ALLOWED_IMAGE_TYPES.keys(),
  'application/octet-stream'
]);

function detectImageType(buffer) {
  if (!Buffer.isBuffer(buffer)) return null;
  if (
    buffer.length >= 3 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff
  ) {
    return { contentType: 'image/jpeg', extension: ALLOWED_IMAGE_TYPES.get('image/jpeg') };
  }
  if (
    buffer.length >= 8 &&
    buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return { contentType: 'image/png', extension: ALLOWED_IMAGE_TYPES.get('image/png') };
  }
  return null;
}

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
  console.error('[ContentSecurity] 未处理异常:', error && error.message ? error.message : error);
  response.status(500).json({ ok: false, code: 'CONTENT_SECURITY_ERROR', error: '内容安全检测失败，请稍后重试。' });
}

function mediaSignature(filename, expires, secret, scope = TEMPORARY_MEDIA_SCOPE) {
  return crypto.createHmac('sha256', secret).update(`${scope}/${filename}.${expires}`).digest('base64url');
}

function buildSignedMediaUrl(config, filename, scope = TEMPORARY_MEDIA_SCOPE) {
  if (!ALLOWED_MEDIA_SCOPES.has(scope)) {
    throw new Error('不支持的内容安全媒体范围。');
  }
  const expires = Math.floor(Date.now() / 1000) + MEDIA_URL_TTL_SECONDS;
  const signature = mediaSignature(filename, expires, config.sessionSecret, scope);
  const base = config.contentSecurityPublicBaseUrl;
  const scopePath = scope === TEMPORARY_MEDIA_SCOPE ? '' : `${scope}/`;
  return `${base}/api/content-security/media/${scopePath}${encodeURIComponent(filename)}?expires=${expires}&sig=${encodeURIComponent(signature)}`;
}

function buildSignedForumMediaUrl(config, filename) {
  return buildSignedMediaUrl(config, filename, FORUM_MEDIA_SCOPE);
}

function verifyMediaSignature(filename, expiresValue, signature, secret, scope = TEMPORARY_MEDIA_SCOPE) {
  if (!ALLOWED_MEDIA_SCOPES.has(scope)) return false;
  const expires = Number(expiresValue);
  if (!Number.isInteger(expires) || expires <= Math.floor(Date.now() / 1000)) return false;
  const expected = mediaSignature(filename, expires, secret, scope);
  const actualBuffer = Buffer.from(String(signature || ''));
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

function sendSignedMedia(request, response, directory, scope, secret) {
  const filename = path.basename(String(request.params.filename || ''));
  if (
    filename !== request.params.filename ||
    !verifyMediaSignature(filename, request.query.expires, request.query.sig, secret, scope)
  ) {
    response.status(403).send('Forbidden');
    return;
  }
  const absolutePath = path.resolve(directory, filename);
  const resolvedRoot = path.resolve(directory) + path.sep;
  if (!absolutePath.startsWith(resolvedRoot) || !fs.existsSync(absolutePath)) {
    response.status(404).send('Not found');
    return;
  }
  response.setHeader('Cache-Control', 'private, max-age=300');
  response.sendFile(absolutePath);
}

function cleanupExpiredMedia(directory) {
  const threshold = Date.now() - MEDIA_RETENTION_MS;
  try {
    for (const name of fs.readdirSync(directory)) {
      const candidate = path.join(directory, name);
      const stat = fs.statSync(candidate);
      if (stat.isFile() && stat.mtimeMs < threshold) fs.unlinkSync(candidate);
    }
  } catch (error) {
    console.warn('[ContentSecurity] 清理临时媒体失败:', error.message);
  }
}

function removeMediaFile(filePath) {
  if (!filePath) return;
  try {
    fs.unlinkSync(filePath);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn('[ContentSecurity] 清理未通过检测的媒体失败:', error.message);
    }
  }
}

module.exports = function registerContentSecurityRoutes(app, shared) {
  const { config, db, uploadRootDir } = shared;
  const mediaDirectory = path.join(uploadRootDir, 'content-security');
  const forumMediaDirectory = path.join(uploadRootDir, FORUM_MEDIA_SCOPE);
  fs.mkdirSync(mediaDirectory, { recursive: true });
  cleanupExpiredMedia(mediaDirectory);
  const mediaCleanupTimer = setInterval(() => cleanupExpiredMedia(mediaDirectory), 60 * 60 * 1000);
  if (typeof mediaCleanupTimer.unref === 'function') mediaCleanupTimer.unref();

  const imageUpload = multer({
    storage: multer.memoryStorage(),
    limits: { files: 1, fileSize: MAX_SYNC_IMAGE_SIZE },
    fileFilter: (_request, file, callback) => {
      if (!ALLOWED_UPLOAD_MIME_TYPES.has(String(file.mimetype || '').toLowerCase())) {
        callback(new Error('仅支持 JPG 或 PNG 图片。'));
        return;
      }
      callback(null, true);
    }
  }).single('media');

  const sessionRateLimit = createRateLimiter(20);
  const checkRateLimit = createRateLimiter(60);

  function requireSecuritySession(request, response, next) {
    try {
      const session = verifySessionToken(getBearerToken(request), config.sessionSecret);
      request.contentSecurityOpenId = session.openid;
      next();
    } catch (error) {
      sendError(response, error);
    }
  }

  app.get('/api/content-security/health', (_request, response) => {
    const configured = Boolean(
      config.wxAppId &&
      config.wxAppId === config.expectedWxAppId &&
      config.wxAppSecret &&
      config.contentSecurityPublicBaseUrlValid
    );
    const credentialsVerified = Boolean(
      configured &&
      config.deploymentSha &&
      config.contentSecurityVerifiedSha === config.deploymentSha
    );
    response.json({
      ok: true,
      configured,
      credentialsVerified,
      deploymentSha: config.deploymentSha || '',
      appId: config.wxAppId || '',
      apis: ['msgSecCheck', 'imgSecCheck', 'mediaCheckAsync']
    });
  });

  app.post('/api/content-security/session', sessionRateLimit, async (request, response) => {
    try {
      const { openid } = await exchangeLoginCode(config, request.body && request.body.code);
      const session = issueSessionToken(openid, config.sessionSecret);
      response.json({ ok: true, token: session.token, expiresAt: session.expiresAt });
    } catch (error) {
      sendError(response, error);
    }
  });

  app.post('/api/content-security/text', checkRateLimit, requireSecuritySession, async (request, response) => {
    const content = String(request.body?.content || '').trim();
    if (!content || Array.from(content).length > MAX_TEXT_LENGTH) {
      response.status(400).json({ ok: false, code: 'INVALID_TEXT', error: `检测文字须为 1-${MAX_TEXT_LENGTH} 字。` });
      return;
    }

    const requestId = crypto.randomUUID();
    try {
      const raw = await msgSecCheck(config, {
        content,
        openid: request.contentSecurityOpenId,
        scene: 3
      });
      const check = saveCheck(db, {
        requestId,
        openid: request.contentSecurityOpenId,
        apiName: 'msgSecCheck',
        contentType: 'text',
        input: content,
        response: raw
      });
      response.json({
        ok: true,
        allowed: isCheckAllowed(check),
        requestId,
        saved: true,
        checks: [check]
      });
    } catch (error) {
      sendError(response, error);
    }
  });

  app.post('/api/content-security/image', checkRateLimit, requireSecuritySession, (request, response) => {
    imageUpload(request, response, async (uploadError) => {
      if (uploadError) {
        response.status(400).json({
          ok: false,
          code: uploadError.code === 'LIMIT_FILE_SIZE' ? 'IMAGE_TOO_LARGE' : 'INVALID_IMAGE',
          error: uploadError.code === 'LIMIT_FILE_SIZE'
            ? '图片压缩后仍超过 1 MB，请更换图片。'
            : uploadError.message
        });
        return;
      }
      if (!request.file) {
        response.status(400).json({ ok: false, code: 'IMAGE_REQUIRED', error: '请选择需要检测的图片。' });
        return;
      }

      const buffer = request.file.buffer;
      const detectedType = detectImageType(buffer);
      if (!detectedType) {
        response.status(400).json({
          ok: false,
          code: 'INVALID_IMAGE',
          error: '图片内容不是有效的 JPG 或 PNG 格式。'
        });
        return;
      }

      cleanupExpiredMedia(mediaDirectory);
      const requestId = crypto.randomUUID();
      const filename = `${Date.now()}-${crypto.randomBytes(16).toString('hex')}${detectedType.extension}`;
      const mediaPath = path.join(mediaDirectory, filename);
      const mediaUrl = buildSignedMediaUrl(config, filename);
      try {
        fs.writeFileSync(mediaPath, buffer, { flag: 'wx' });
        const syncRaw = await imgSecCheck(config, {
          buffer,
          filename,
          contentType: detectedType.contentType
        });
        const syncCheck = saveCheck(db, {
          requestId,
          openid: request.contentSecurityOpenId,
          apiName: 'imgSecCheck',
          contentType: 'image',
          input: buffer,
          response: syncRaw
        });
        if (!isCheckAllowed(syncCheck)) {
          removeMediaFile(mediaPath);
          response.json({
            ok: true,
            allowed: false,
            requestId,
            saved: true,
            checks: [syncCheck]
          });
          return;
        }

        const asyncRaw = await mediaCheckAsync(config, {
          mediaUrl,
          openid: request.contentSecurityOpenId,
          mediaType: 2,
          scene: 3
        });
        const asyncCheck = saveCheck(db, {
          requestId,
          openid: request.contentSecurityOpenId,
          apiName: 'mediaCheckAsync',
          contentType: 'image',
          input: mediaUrl,
          response: asyncRaw
        });
        const allowed = isCheckAllowed(asyncCheck);
        if (!allowed) removeMediaFile(mediaPath);
        response.json({
          ok: true,
          allowed,
          requestId,
          saved: true,
          checks: [syncCheck, asyncCheck]
        });
      } catch (error) {
        removeMediaFile(mediaPath);
        sendError(response, error);
      }
    });
  });

  app.post('/api/content-security/history', checkRateLimit, requireSecuritySession, (request, response) => {
    response.json({ ok: true, checks: getRecentChecks(db, request.contentSecurityOpenId, request.body?.limit) });
  });

  app.get('/api/content-security/media/forum/:filename', (request, response) => {
    sendSignedMedia(request, response, forumMediaDirectory, FORUM_MEDIA_SCOPE, config.sessionSecret);
  });

  app.get('/api/content-security/media/:filename', (request, response) => {
    sendSignedMedia(request, response, mediaDirectory, TEMPORARY_MEDIA_SCOPE, config.sessionSecret);
  });
};

module.exports.buildSignedForumMediaUrl = buildSignedForumMediaUrl;
module.exports._private = {
  mediaSignature,
  verifyMediaSignature,
  buildSignedMediaUrl,
  buildSignedForumMediaUrl,
  sendSignedMedia,
  detectImageType
};
