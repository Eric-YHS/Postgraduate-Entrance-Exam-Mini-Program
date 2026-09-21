import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { Transform } from 'node:stream';

const DRIVER = process.env.STORAGE_DRIVER || 'local';
const LOCAL_DIR = process.env.STORAGE_LOCAL_DIR || 'storage';

const sanitizeKey = key => {
  const normalized = String(key || '').replace(/^\/+/, '').replace(/\\/g, '/');
  if (!normalized || normalized.includes('..')) throw new Error('对象键不合法');
  return normalized;
};

const SIGNING_SECRET = () => {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) throw new Error('SESSION_SECRET must be at least 32 characters for signed URLs');
  return secret;
};

const localDriver = {
  name: 'local',
  rootDir: path.resolve(process.cwd(), LOCAL_DIR),
  async putObject({ key, body, contentType, maxBytes = 200 * 1024 * 1024 }) {
    const safeKey = sanitizeKey(key);
    const target = path.join(this.rootDir, safeKey);
    await fs.mkdir(path.dirname(target), { recursive: true });
    const limit = Number.isInteger(maxBytes) && maxBytes > 0 ? maxBytes : 200 * 1024 * 1024;
    const hash = crypto.createHash('sha256');
    let bytes = 0;
    const limiter = new Transform({
      transform(chunk, _encoding, callback) {
        bytes += chunk.length;
        if (bytes > limit) {
          callback(Object.assign(new Error('文件超过允许的大小上限'), { statusCode: 422, code: 'FILE_TOO_LARGE' }));
          return;
        }
        hash.update(chunk);
        callback(null, chunk);
      }
    });
    try {
      if (body && typeof body[Symbol.asyncIterator] === 'function') {
        await pipeline(body, limiter, createWriteStream(target));
      } else if (body && typeof body.pipe === 'function') {
        await pipeline(body, limiter, createWriteStream(target));
      } else {
        const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body ?? '');
        if (buffer.length > limit) throw Object.assign(new Error('文件超过允许的大小上限'), { statusCode: 422, code: 'FILE_TOO_LARGE' });
        hash.update(buffer);
        bytes = buffer.length;
        await fs.writeFile(target, buffer);
      }
      const stat = await fs.stat(target);
      return { key: safeKey, size: stat.size, sha256: hash.digest('hex'), contentType: contentType || null, driver: this.name };
    } catch (error) {
      await fs.rm(target, { force: true }).catch(() => {});
      throw error;
    }
  },
  async statObject({ key }) {
    const target = path.join(this.rootDir, sanitizeKey(key));
    const stat = await fs.stat(target).catch(() => null);
    if (!stat) throw Object.assign(new Error('对象不存在'), { statusCode: 404 });
    return { key: sanitizeKey(key), size: stat.size, driver: this.name };
  },
  async readObjectStream({ key }) {
    const target = path.join(this.rootDir, sanitizeKey(key));
    return createReadStream(target);
  },
  async deleteObject({ key }) {
    const target = path.join(this.rootDir, sanitizeKey(key));
    await fs.rm(target, { force: true });
    return { key: sanitizeKey(key) };
  },
  async getSignedUrl({ key, expiresInSeconds = 300 }) {
    const safeKey = sanitizeKey(key);
    const expiresAt = Math.floor(Date.now() / 1000) + Math.max(1, Math.min(86400, Number(expiresInSeconds) || 300));
    const signature = crypto.createHmac('sha256', SIGNING_SECRET())
      .update(`${expiresAt}.${safeKey}`)
      .digest('base64url');
    const token = Buffer.from(`${expiresAt}.${signature}`, 'utf8').toString('base64url');
    return { url: `/api/storage/local/${token}/${encodeURIComponent(safeKey)}`, expiresAt };
  },
  verifySignedUrl({ token, key }) {
    const safeKey = sanitizeKey(key);
    let decoded;
    try { decoded = Buffer.from(String(token), 'base64url').toString('utf8').split('.'); } catch { return false; }
    if (decoded.length !== 2) return false;
    const [expiresAtText, received] = decoded;
    const expiresAt = Number(expiresAtText);
    if (!Number.isInteger(expiresAt) || expiresAt < Math.floor(Date.now() / 1000) || !received) return false;
    const expected = crypto.createHmac('sha256', SIGNING_SECRET())
      .update(`${expiresAt}.${safeKey}`)
      .digest('base64url');
    const receivedBuffer = Buffer.from(received);
    const expectedBuffer = Buffer.from(expected);
    return receivedBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(receivedBuffer, expectedBuffer);
  }
};

const storageUnavailable = name => Object.assign(new Error(`${name} 存储驱动尚未配置，请设置 STORAGE_DRIVER=local 或部署对象存储后重启`), { statusCode:503, code:'STORAGE_UNAVAILABLE' });
const unsupplementedDriver = name => ({
  name,
  async putObject() { throw storageUnavailable(name); },
  async statObject() { throw storageUnavailable(name); },
  async readObjectStream() { throw storageUnavailable(name); },
  async deleteObject() { throw storageUnavailable(name); },
  async getSignedUrl() { throw storageUnavailable(name); }
});

const drivers = {
  local: localDriver,
  s3: unsupplementedDriver('s3'),
  oss: unsupplementedDriver('oss'),
  cos: unsupplementedDriver('cos')
};

const driver = drivers[DRIVER] || (() => { throw new Error(`未知的 STORAGE_DRIVER: ${DRIVER}`); })();

export const storage = driver;
export const STORAGE_DRIVER_NAME = driver.name;
export const generateObjectKey = (prefix, originalName) => {
  const ext = path.extname(originalName || '').toLowerCase().slice(0, 16);
  const safe = crypto.randomBytes(16).toString('hex');
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '/');
  return `${prefix || 'objects'}/${date}/${safe}${ext}`;
};
