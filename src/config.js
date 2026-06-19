const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// 自动加载 .env 文件（无需 dotenv 依赖）
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf-8');
  envContent.split('\n').forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) return;
    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
    if (!process.env[key]) {
      process.env[key] = value;
    }
  });
}

const rootDir = path.join(__dirname, '..');
const dbPath = process.env.DB_PATH || path.join(rootDir, 'data.sqlite');
const uploadRootDir = process.env.UPLOAD_DIR || path.join(rootDir, 'public', 'uploads');
const port = Number(process.env.PORT || 3000);
// BUG-061: PORT 环境变量验证
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`FATAL: PORT 环境变量无效: ${process.env.PORT}`);
  process.exit(1);
}
const tokenTtlDays = Number(process.env.TOKEN_TTL_DAYS || 30);
const nodeEnv = process.env.NODE_ENV || 'development';

// SESSION_SECRET 安全校验
const rawSessionSecret = process.env.SESSION_SECRET;
if (nodeEnv === 'production') {
  if (!rawSessionSecret || rawSessionSecret.length < 32) {
    console.error('FATAL: 生产环境必须设置 SESSION_SECRET，且长度至少 32 个字符。请运行 npm run generate-secret 生成。');
    process.exit(1);
  }
}
const sessionSecret = rawSessionSecret && rawSessionSecret.length >= 8
  ? rawSessionSecret
  : crypto.randomBytes(32).toString('hex');
if (!rawSessionSecret) {
  console.warn('WARN: SESSION_SECRET 未设置，已使用临时随机密钥。请勿在生产环境使用此配置。');
}

const cookieSecure = process.env.COOKIE_SECURE === 'true';
const trustProxy = process.env.TRUST_PROXY === 'true';
const wxAppId = process.env.WX_APP_ID || '';
const wxAppSecret = process.env.WX_APP_SECRET || '';

// 企业微信配置
const wecomCorpId = process.env.WECOM_CORP_ID || '';
const wecomAgentId = process.env.WECOM_AGENT_ID || '';
const wecomSecret = process.env.WECOM_SECRET || '';
const wecomWebhookKey = process.env.WECOM_WEBHOOK_KEY || '';
const wecomToken = process.env.WECOM_TOKEN || '';
const wecomEncodingAesKey = process.env.WECOM_ENCODING_AES_KEY || '';

// AI 大模型 API 配置
const aiApiKey = process.env.AI_API_KEY || '';
const aiApiUrl = process.env.AI_API_URL || '';
const aiModel = process.env.AI_MODEL || 'deepseek-chat';

// WebRTC ICE 服务器配置
// 默认只有 STUN；生产环境应配置 TURN 服务器以保证 NAT 穿透成功率
const turnUrl = process.env.TURN_URL || '';
const turnUsername = process.env.TURN_USERNAME || '';
const turnCredential = process.env.TURN_CREDENTIAL || '';

const iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
if (turnUrl && turnUsername && turnCredential) {
  iceServers.push({
    urls: turnUrl,
    username: turnUsername,
    credential: turnCredential
  });
}

function ensureDirectory(directoryPath) {
  fs.mkdirSync(directoryPath, { recursive: true });
}

ensureDirectory(path.dirname(dbPath));
ensureDirectory(uploadRootDir);

module.exports = {
  aiApiKey,
  aiApiUrl,
  aiModel,
  cookieSecure,
  dbPath,
  iceServers,
  nodeEnv,
  port,
  rootDir,
  sessionSecret,
  tokenTtlDays,
  trustProxy,
  uploadRootDir,
  wxAppId,
  wxAppSecret,
  wecomCorpId,
  wecomAgentId,
  wecomSecret,
  wecomWebhookKey,
  wecomToken,
  wecomEncodingAesKey
};
