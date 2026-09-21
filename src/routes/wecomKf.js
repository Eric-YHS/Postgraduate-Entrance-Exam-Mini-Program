const config = require('../config');
const wecom = require('../services/wecom');
const dispatcher = require('../services/wecomKfDispatcher');

function extractXmlField(xmlText, tagName) {
  const text = String(xmlText || '');
  const cdataRegex = new RegExp(`<${tagName}><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${tagName}>`);
  const plainRegex = new RegExp(`<${tagName}>([\\s\\S]*?)</${tagName}>`);
  const cdataMatch = text.match(cdataRegex);
  if (cdataMatch) return cdataMatch[1];
  const plainMatch = text.match(plainRegex);
  return plainMatch ? plainMatch[1].trim() : '';
}

module.exports = function registerWecomKfRoutes(app) {
  app.get('/api/wecom/kf/callback', (request, response) => {
    try {
      if (!config.wecomKfToken || !config.wecomKfEncodingAesKey) {
        return response.status(500).send('not configured');
      }
      const plainText = wecom.verifyCallbackUrl(
        request.query,
        config.wecomKfToken,
        config.wecomKfEncodingAesKey
      );
      if (plainText === null) return response.status(403).send('verify fail');
      response.type('text/plain').send(plainText);
    } catch (error) {
      console.error('[wecom-kf] 回调 URL 验证异常:', error.message);
      response.status(500).send('error');
    }
  });

  app.post('/api/wecom/kf/callback', (request, response) => {
    try {
      if (!config.wecomKfToken || !config.wecomKfEncodingAesKey) {
        return response.status(500).send('not configured');
      }
      const rawBody = request.body;
      const xml = Buffer.isBuffer(rawBody)
        ? rawBody.toString('utf8')
        : (typeof rawBody === 'string' ? rawBody : '');
      if (!xml) return response.status(400).send('invalid body');

      const parsed = wecom.parseEncryptedXml(
        xml,
        request.query.msg_signature,
        request.query.timestamp,
        request.query.nonce,
        config.wecomKfToken,
        config.wecomKfEncodingAesKey
      );
      if (!parsed) return response.status(403).send('verify fail');
      if (config.wecomCorpId && parsed.toUserName && parsed.toUserName !== config.wecomCorpId) {
        return response.status(403).send('corp mismatch');
      }

      const eventType = extractXmlField(parsed.message, 'Event');
      const callbackToken = extractXmlField(parsed.message, 'Token');
      const openKfid = extractXmlField(parsed.message, 'OpenKfId');

      // 官方要求快速返回 success，具体消息通过 sync_msg 异步拉取。
      response.type('text/plain').send('success');
      if (
        config.wecomKfEnabled
        && eventType === 'kf_msg_or_event'
        && openKfid
      ) {
        setImmediate(() => {
          dispatcher.syncAccount(openKfid, callbackToken).catch((error) => {
            console.error(`[wecom-kf] 回调触发同步失败 open_kfid=${openKfid}:`, error.message);
          });
        });
      }
    } catch (error) {
      console.error('[wecom-kf] 处理回调异常:', error.message);
      if (!response.headersSent) response.status(500).send('error');
    }
  });
};

module.exports.extractXmlField = extractXmlField;
