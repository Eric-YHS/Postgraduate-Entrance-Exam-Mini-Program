/**
 * 把微信客服 sync_msg 的 media_id 适配为现有图片、语音和文档处理链路。
 */

const path = require('path');
const { createWecomMediaProcessor } = require('./wecomMedia');
const wecomKf = require('./wecomKf');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_KF_MEDIA_ROOT = path.resolve(
  process.env.WECOM_KF_MEDIA_DIR || path.join(PROJECT_ROOT, 'private', 'wecom-kf-media')
);

function toMediaProcessorMessage(message) {
  const msgtype = String(message?.msgtype || '');
  if (!['image', 'voice', 'file'].includes(msgtype)) return message;
  const source = message?.[msgtype] || {};
  const mediaId = String(source.media_id || '').trim();
  const adapted = {
    ...message,
    [msgtype]: {
      ...source,
      sdkfileid: mediaId,
    },
  };
  if (msgtype === 'file') {
    adapted.file.filename = String(source.filename || source.file_name || '微信客服文件');
    adapted.file.fileext = String(source.fileext || path.extname(adapted.file.filename)).replace(/^\./, '');
  }
  return adapted;
}

function createWecomKfMediaProcessor(dependencies = {}) {
  const client = dependencies.client || wecomKf;
  const processor = createWecomMediaProcessor({
    ...dependencies,
    mediaRoot: dependencies.mediaRoot || DEFAULT_KF_MEDIA_ROOT,
    downloadMedia: async (mediaId, destinationPath) => {
      await client.downloadMedia(mediaId, destinationPath);
      return true;
    },
  });

  return {
    async processKfMediaMessage(message) {
      return processor.processMediaMessage(toMediaProcessorMessage(message));
    },
  };
}

const defaultProcessor = createWecomKfMediaProcessor();

module.exports = {
  processKfMediaMessage: defaultProcessor.processKfMediaMessage,
  createWecomKfMediaProcessor,
  toMediaProcessorMessage,
  DEFAULT_KF_MEDIA_ROOT,
};
