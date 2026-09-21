const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// 自动加载 .env 文件（无需 dotenv 依赖）
const envPath = path.join(__dirname, '..', '.env');
if (process.env.NODE_ENV !== 'test' && fs.existsSync(envPath)) {
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
const readDeploymentMarker = (fileName) => {
  try {
    return fs.readFileSync(path.join(rootDir, fileName), 'utf8').trim();
  } catch (_) {
    return '';
  }
};
const deploymentSha = readDeploymentMarker('.deploy-sha');
const contentSecurityVerifiedSha = readDeploymentMarker('.content-security-verified');
const port = Number(process.env.PORT || 3000);
// BUG-061: PORT 环境变量验证
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`FATAL: PORT 环境变量无效: ${process.env.PORT}`);
  process.exit(1);
}
const tokenTtlDays = Number(process.env.TOKEN_TTL_DAYS || 30);
const nodeEnv = process.env.NODE_ENV || 'development';
// 默认关闭全部付费能力；false 仅重新启用旧服务端逻辑，恢复商业化前仍需完成前端与数据迁移。
const freeAccessMode = String(process.env.FREE_ACCESS_MODE || 'true').toLowerCase() !== 'false';
const publicBaseUrl = String(process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
const smtpHost = process.env.SMTP_HOST || '';
const smtpPort = Number(process.env.SMTP_PORT || 465);
const smtpSecure = String(process.env.SMTP_SECURE || 'true').toLowerCase() !== 'false';
const smtpUser = process.env.SMTP_USER || '';
const smtpPassword = process.env.SMTP_PASSWORD || '';
const smtpFrom = process.env.SMTP_FROM || smtpUser || '';

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
const expectedWxAppId = 'wx27fca32a9ddfdc8e';
const wxAppId = process.env.WX_APP_ID || '';
const wxAppSecret = process.env.WX_APP_SECRET || '';
const wxSubscribeTestTemplateId = process.env.WX_SUBSCRIBE_TEST_TEMPLATE_ID || '';
const wxSubscribeTestFixedKey = process.env.WX_SUBSCRIBE_TEST_FIXED_KEY || 'short_thing1';
const wxSubscribeTestDateKey = process.env.WX_SUBSCRIBE_TEST_DATE_KEY || 'time2';
const wxSubscribeTestNumberKey = process.env.WX_SUBSCRIBE_TEST_NUMBER_KEY || 'character_string3';
const wxSubscribeTestTipKey = process.env.WX_SUBSCRIBE_TEST_TIP_KEY || 'thing4';
const wxSubscribeMiniprogramState = ['developer', 'trial', 'formal'].includes(
  process.env.WX_SUBSCRIBE_MINIPROGRAM_STATE
)
  ? process.env.WX_SUBSCRIBE_MINIPROGRAM_STATE
  : (process.env.NODE_ENV === 'production' ? 'formal' : 'developer');
const contentSecurityPublicBaseUrl = (process.env.CONTENT_SECURITY_PUBLIC_BASE_URL || 'https://xiaoeduhub.online').replace(/\/$/, '');
const contentSecurityPublicBaseUrlValid = (() => {
  try {
    const parsed = new URL(contentSecurityPublicBaseUrl);
    return (
      parsed.protocol === 'https:' &&
      !parsed.username &&
      !parsed.password &&
      !parsed.search &&
      !parsed.hash &&
      (parsed.pathname === '/' || parsed.pathname === '')
    );
  } catch (_) {
    return false;
  }
})();

// 企业微信配置
const wecomCorpId = process.env.WECOM_CORP_ID || '';
const wecomAgentId = process.env.WECOM_AGENT_ID || '';
const wecomSecret = process.env.WECOM_SECRET || '';
const wecomWebhookKey = process.env.WECOM_WEBHOOK_KEY || '';
const wecomToken = process.env.WECOM_TOKEN || '';
const wecomEncodingAesKey = process.env.WECOM_ENCODING_AES_KEY || '';

// 微信客服（普通微信用户的一对一客服渠道）
// 微信客服使用被授权的企业自建应用 Secret；未单独配置时复用 WECOM_SECRET。
// 回调 Token/AES 也默认复用现有企业微信回调配置，避免保存重复密钥。
const wecomKfEnabled = process.env.WECOM_KF_ENABLED === 'true';
const wecomKfSecret = process.env.WECOM_KF_SECRET || wecomSecret;
const wecomKfToken = process.env.WECOM_KF_TOKEN || wecomToken;
const wecomKfEncodingAesKey = process.env.WECOM_KF_ENCODING_AES_KEY || wecomEncodingAesKey;
const wecomKfReplyDelaySeconds = Math.min(
  300,
  Math.max(0, Number(process.env.WECOM_KF_REPLY_DELAY_SECONDS) || 5)
);
const wecomKfThinkingMessage = process.env.WECOM_KF_THINKING_MESSAGE === undefined
  ? '思考中，请稍等'
  : String(process.env.WECOM_KF_THINKING_MESSAGE).trim().slice(0, 500);
const wecomKfRecoveryPollIntervalSeconds = Math.min(
  3600,
  Math.max(30, Number(process.env.WECOM_KF_RECOVERY_POLL_INTERVAL_SECONDS) || 60)
);

// 企业微信-会话内容存档（群聊监听）
const wecomArchiveSecret = process.env.WECOM_ARCHIVE_SECRET || '';
// 私钥 PEM 在 .env 中编码为 base64 单行，这里还原换行
const wecomArchivePrivateKey = (() => {
  const raw = process.env.WECOM_ARCHIVE_PRIVATE_KEY || '';
  if (!raw) return '';
  try { return Buffer.from(raw, 'base64').toString('utf-8'); } catch { return raw; }
})();
const wecomArchivePollInterval = Number(process.env.WECOM_ARCHIVE_POLL_INTERVAL) || 15;
const wecomArchiveEnabled = process.env.WECOM_ARCHIVE_ENABLED === 'true';

// AI 大模型 API 配置。保留原 AI_* 作为回退，生产可通过 AI_PROVIDER=minimax
// 切换到 MiniMax-M3，而无需覆盖原有供应商密钥。
const aiProvider = String(process.env.AI_PROVIDER || 'default').trim().toLowerCase();
const legacyAiApiKey = process.env.AI_API_KEY || '';
const legacyAiApiUrl = process.env.AI_API_URL || '';
const minimaxApiKey = process.env.MINIMAX_API_KEY || '';
const minimaxApiUrl = process.env.MINIMAX_API_URL || 'https://api.minimaxi.com/v1/chat/completions';
const minimaxModel = process.env.MINIMAX_MODEL || 'MiniMax-M3';
const minimaxServiceTier = process.env.MINIMAX_SERVICE_TIER || 'priority';
const minimaxMaxCompletionTokens = Math.max(
  1024,
  Number(process.env.MINIMAX_MAX_COMPLETION_TOKENS) || 131072
);
const minimaxWebSearchEnabled = process.env.MINIMAX_WEB_SEARCH_ENABLED !== 'false';
const minimaxWebSearchApiUrl = process.env.MINIMAX_WEB_SEARCH_API_URL
  || 'https://api.minimaxi.com/v1/coding_plan/search';
const officialAiDeepMode = process.env.OFFICIAL_AI_DEEP_MODE !== 'false';
const officialAiMaxToolRounds = Math.min(
  8,
  Math.max(1, Number(process.env.OFFICIAL_AI_MAX_TOOL_ROUNDS) || 5)
);
const deepseekApiKey = process.env.DEEPSEEK_API_KEY
  || (/api\.deepseek\.com/i.test(legacyAiApiUrl) ? legacyAiApiKey : '');
const deepseekApiUrl = process.env.DEEPSEEK_API_URL
  || 'https://api.deepseek.com/chat/completions';
const deepseekModel = process.env.DEEPSEEK_MODEL || 'deepseek-v4-pro';
const deepseekReasoningEffort = process.env.DEEPSEEK_REASONING_EFFORT || 'max';
const deepseekMaxCompletionTokens = Math.max(
  1024,
  Number(process.env.DEEPSEEK_MAX_COMPLETION_TOKENS) || 131072
);
const aiApiKey = aiProvider === 'minimax' ? minimaxApiKey : legacyAiApiKey;
const aiApiUrl = aiProvider === 'minimax' ? minimaxApiUrl : legacyAiApiUrl;
const aiModel = aiProvider === 'minimax' ? minimaxModel : (process.env.AI_MODEL || 'deepseek-chat');

// 微信支付 V3 配置。免费模式下即使环境变量仍有残留，也不会向应用暴露。
const wxPayAppId = freeAccessMode ? '' : (process.env.WX_PAY_APP_ID || process.env.WX_APP_ID || '');
const wxPayMchId = freeAccessMode ? '' : (process.env.WX_PAY_MCH_ID || '');
const wxPayApiV3Key = freeAccessMode ? '' : (process.env.WX_PAY_API_V3_KEY || '');
const wxPayPrivateKeyPath = freeAccessMode ? '' : (process.env.WX_PAY_PRIVATE_KEY_PATH || '');
const wxPaySerialNo = freeAccessMode ? '' : (process.env.WX_PAY_SERIAL_NO || '');
const wxPayEnabled = freeAccessMode
  ? 'false'
  : (process.env.WX_PAY_ENABLED === 'true' ? 'true' : (process.env.WX_PAY_ENABLED || 'false'));

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
  aiProvider,
  cookieSecure,
  contentSecurityPublicBaseUrl,
  contentSecurityPublicBaseUrlValid,
  contentSecurityVerifiedSha,
  dbPath,
  deploymentSha,
  expectedWxAppId,
  freeAccessMode,
  iceServers,
  nodeEnv,
  deepseekApiKey,
  deepseekApiUrl,
  deepseekModel,
  deepseekReasoningEffort,
  deepseekMaxCompletionTokens,
  minimaxApiKey,
  minimaxApiUrl,
  minimaxModel,
  minimaxServiceTier,
  minimaxMaxCompletionTokens,
  minimaxWebSearchEnabled,
  minimaxWebSearchApiUrl,
  officialAiDeepMode,
  officialAiMaxToolRounds,
  port,
  publicBaseUrl,
  rootDir,
  sessionSecret,
  smtpFrom,
  smtpHost,
  smtpPassword,
  smtpPort,
  smtpSecure,
  smtpUser,
  tokenTtlDays,
  trustProxy,
  uploadRootDir,
  wxAppId,
  wxAppSecret,
  wxSubscribeTestTemplateId,
  wxSubscribeTestFixedKey,
  wxSubscribeTestDateKey,
  wxSubscribeTestNumberKey,
  wxSubscribeTestTipKey,
  wxSubscribeMiniprogramState,
  wxPayAppId,
  wxPayMchId,
  wxPayApiV3Key,
  wxPayPrivateKeyPath,
  wxPaySerialNo,
  wxPayEnabled,
  wecomCorpId,
  wecomAgentId,
  wecomSecret,
  wecomWebhookKey,
  wecomToken,
  wecomEncodingAesKey,
  wecomKfEnabled,
  wecomKfSecret,
  wecomKfToken,
  wecomKfEncodingAesKey,
  wecomKfReplyDelaySeconds,
  wecomKfThinkingMessage,
  wecomKfRecoveryPollIntervalSeconds,
  wecomArchiveSecret,
  wecomArchivePrivateKey,
  wecomArchivePollInterval,
  wecomArchiveEnabled
};
