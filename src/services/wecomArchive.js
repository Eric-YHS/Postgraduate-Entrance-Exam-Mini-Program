/**
 * 企业微信「会话内容存档」服务
 *
 * 封装官方 C SDK（通过 wework-chat-node / ms-qywx-chat 绑定），提供：
 *   1. 拉取会话数据 (GetChatData)
 *   2. RSA 私钥解密随机密钥（旧版 SDK）
 *   3. SDK 解密消息体 (DecryptData)
 *   4. 媒体文件下载 (GetMediaData)
 *
 * 前置条件（需在管理后台完成）：
 *   - 购买「会话内容存档」功能（1 人，约 800 元/年）
 *   - 在管理后台获取存档专用 Secret
 *   - 生成 RSA 2048 密钥对 → 上传公钥 → 记录 publickey_ver
 *   - 将存档成员加入可见范围 + 目标群聊
 *
 * 参考文档: https://developer.work.weixin.qq.com/document/path/91774
 */

const crypto = require('crypto');
const fs = require('fs');
const config = require('../config');

// ── SDK 加载（兼容两种包名） ──────────────────────────────────────────────
let qywxChat = null;
let sdkName = '';
let sdkKind = '';
let modernClient = null;

function loadSdk() {
  if (qywxChat) return true;

  // 优先使用 2026 年仍在维护、基于 Node-API 的封装。旧版 ms-qywx-chat
  // 在 Node 22/Linux 上虽然能 require，但调用 getData 会触发原生段错误。
  try {
    const modernSdk = require('wework-chat-node');
    if (typeof modernSdk.WeWorkChat === 'function') {
      qywxChat = modernSdk;
      sdkName = 'wework-chat-node';
      sdkKind = 'modern';
      return true;
    }
  } catch (_) { /* Windows 等未构建平台继续尝试旧版 */ }

  try {
    const legacySdk = require('ms-qywx-chat');
    if (typeof legacySdk.getData === 'function') {
      qywxChat = legacySdk;
      sdkName = 'ms-qywx-chat';
      sdkKind = 'legacy';
      return true;
    }
  } catch (_) { /* 由 isReady 返回统一错误 */ }

  return false;
}

function getModernClient() {
  if (modernClient) return modernClient;
  if (!qywxChat || sdkKind !== 'modern') return null;

  modernClient = new qywxChat.WeWorkChat({
    corpid: config.wecomCorpId,
    secret: config.wecomArchiveSecret,
    private_key: config.wecomArchivePrivateKey,
    seq: 0,
  });
  return modernClient;
}

function parseModernChatData(result) {
  const rawMessages = Array.isArray(result?.data) ? result.data : [];
  const lastSeq = Number(result?.last_seq) || 0;
  const firstSeq = lastSeq > 0 ? Math.max(1, lastSeq - rawMessages.length + 1) : 0;

  const chatdata = rawMessages.map((raw, index) => {
    // 新版 SDK 返回稀疏数组意味着其中某条消息解密失败。此时必须让整批
    // 失败，不能推进 seq，否则该消息会永久丢失。
    if (typeof raw !== 'string' || !raw.trim()) {
      throw new Error(`新版 SDK 第 ${index + 1} 条消息解密为空`);
    }

    const message = JSON.parse(raw);
    const seq = firstSeq > 0 ? firstSeq + index : 0;
    return {
      seq,
      msgid: message.msgid || '',
      decrypted_message: message,
    };
  });

  return {
    errcode: 0,
    errmsg: 'ok',
    chatdata,
    last_seq: lastSeq,
    already_decrypted: true,
  };
}

// ── 缓存 ─────────────────────────────────────────────────────────────────
let archiveCache = {
  seq: 0,
  lastSyncAt: null,
  totalPulled: 0,
  totalProcessed: 0,
  errors: 0,
  running: false,
};

// ── 工具函数 ─────────────────────────────────────────────────────────────

/**
 * 使用 RSA PKCS1 私钥解密企业微信返回的 encrypt_random_key
 *
 * 流程（参照官方文档 path/91774）：
 *   ① Base64 decode encrypt_random_key → str1
 *   ② RSA PKCS1 私钥解密 str1 → str2（即真正的 AES 密钥）
 *   ③ 将 str2 传入 SDK DecryptData，解密 encrypt_chat_msg
 *
 * @param {string} encryptedBase64 - encrypt_random_key 字段值
 * @param {string} privateKeyPem  - RSA 私钥 PEM 原文
 * @returns {Buffer} 解密后的 AES 密钥
 */
function decryptRandomKey(encryptedBase64, privateKeyPem) {
  const buffer = Buffer.from(encryptedBase64, 'base64');
  return crypto.privateDecrypt(
    {
      key: privateKeyPem,
      padding: crypto.constants.RSA_PKCS1_PADDING,
    },
    buffer
  );
}

// ── 核心 API ─────────────────────────────────────────────────────────────

/**
 * 校验配置是否就绪
 * @returns {{ ok: boolean, reason?: string }}
 */
function isReady() {
  if (!config.wecomArchiveEnabled) {
    return { ok: false, reason: 'WECOM_ARCHIVE_ENABLED 未启用' };
  }
  if (!config.wecomCorpId || !config.wecomArchiveSecret) {
    return { ok: false, reason: 'WECOM_CORP_ID 或 WECOM_ARCHIVE_SECRET 未配置' };
  }
  if (!config.wecomArchivePrivateKey) {
    return { ok: false, reason: 'WECOM_ARCHIVE_PRIVATE_KEY 未配置' };
  }
  if (!loadSdk()) {
    return { ok: false, reason: '未安装 ms-qywx-chat 或 wework-chat-node SDK 包' };
  }
  return { ok: true };
}

/**
 * 拉取加密会话数据
 *
 * 调用 SDK.GetChatData，从 seq+1 开始拉取。
 *
 * @param {number} seq   - 起始序号，传上次返回的最大 seq
 * @param {number} limit - 单次拉取条数（最大 1000）
 * @returns {Promise<{errcode:number, errmsg:string, chatdata:Array}|null>}
 */
function pullChatData(seq, limit = 500) {
  return new Promise((resolve) => {
    try {
      if (!qywxChat && !loadSdk()) {
        console.error('[archive] SDK 未加载，无法拉取消息');
        return resolve(null);
      }

      if (sdkKind === 'modern') {
        const client = getModernClient();
        const result = client.getChatData({
          seq,
          max_results: Math.min(limit, 1000),
          timeout: 30,
        });
        return resolve(parseModernChatData(result));
      }

      // ms-qywx-chat 的 getData 是同步调用（底层 C SDK 阻塞）
      // 参数: seq, limit, timeout(秒), corpid, secret
      const result = qywxChat.getData(
        seq,
        Math.min(limit, 1000),
        30, // timeout 30 秒
        config.wecomCorpId,
        config.wecomArchiveSecret
      );

      if (!result) {
        return resolve(null);
      }

      // 兼容不同包的返回格式
      if (typeof result === 'string') {
        try { resolve(JSON.parse(result)); } catch (_) { resolve(null); }
      } else {
        resolve(result);
      }
    } catch (err) {
      console.error('[archive] pullChatData 异常:', err.message);
      resolve(null);
    }
  });
}

/**
 * 解密单条会话消息
 *
 * 两步解密：
 *   ① Node.js crypto 模块 RSA 解密 encrypt_random_key → 得到 AES key
 *   ② SDK DecryptData 用 AES key 解密 encrypt_chat_msg → 得到明文 JSON
 *
 * @param {string} encryptRandomKey - encrypt_random_key（Base64）
 * @param {string} encryptChatMsg    - encrypt_chat_msg（Base64）
 * @param {string} privateKeyPem     - RSA 私钥 PEM
 * @returns {Promise<object|null>}   解密后的消息 JSON 对象
 */
function decryptChatMessage(encryptRandomKey, encryptChatMsg, privateKeyPem) {
  return new Promise((resolve) => {
    try {
      // 第一步：RSA 解密随机密钥
      const aesKeyBuffer = decryptRandomKey(encryptRandomKey, privateKeyPem);
      const aesKeyStr = aesKeyBuffer.toString('utf-8');

      // 第二步：调用 SDK 解密消息体
      if (!qywxChat && !loadSdk()) {
        console.error('[archive] SDK 未加载，无法解密消息');
        return resolve(null);
      }

      if (sdkKind !== 'legacy' || typeof qywxChat.decryptData !== 'function') {
        console.error('[archive] 当前 SDK 不支持单独解密；新版 SDK 应在拉取时完成解密');
        return resolve(null);
      }

      // ms-qywx-chat 的 decryptData 是同步调用
      // 参数: decrypt_random_key (RSA 解密后的字符串), encrypt_chat_msg
      const raw = qywxChat.decryptData(aesKeyStr, encryptChatMsg);

      if (!raw) {
        return resolve(null);
      }

      // decryptData 返回的可能是 JSON 字符串或对象
      if (typeof raw === 'string') {
        try { resolve(JSON.parse(raw)); } catch (_) { resolve(null); }
      } else {
        resolve(raw);
      }
    } catch (err) {
      console.error('[archive] decryptChatMessage 异常:', err.message);
      resolve(null);
    }
  });
}

/**
 * 下载媒体文件（图片/语音/视频/文件）
 *
 * @param {string} sdkfileid - 消息中的 sdkfileid
 * @param {string} filepath  - 本地保存路径（绝对路径）
 * @returns {Promise<boolean>}
 */
function downloadMedia(sdkfileid, filepath) {
  return new Promise((resolve) => {
    try {
      if (!qywxChat && !loadSdk()) {
        console.error('[archive] SDK 未加载，无法下载媒体');
        return resolve(false);
      }

      if (sdkKind === 'modern') {
        const client = getModernClient();
        let indexBuf = '';
        let firstChunk = true;

        do {
          const result = client.getMediaData({
            sdk_fileid: sdkfileid,
            index_buf: indexBuf,
          });
          if (!result || !result.data) {
            console.error('[archive] 媒体下载失败: 新版 SDK 返回为空');
            return resolve(false);
          }

          const chunk = Buffer.from(result.data);
          if (firstChunk) {
            fs.writeFileSync(filepath, chunk);
            firstChunk = false;
          } else {
            fs.appendFileSync(filepath, chunk);
          }

          if (result.is_finished) break;
          indexBuf = result.buf_index || '';
          if (!indexBuf) {
            console.error('[archive] 媒体下载失败: 缺少下一分片索引');
            return resolve(false);
          }
        } while (true);

        return resolve(true);
      }

      const result = qywxChat.getMediaData(
        sdkfileid,
        60, // timeout 60 秒
        filepath,
        config.wecomCorpId,
        config.wecomArchiveSecret
      );

      if (result && result.errcode === 0) {
        resolve(true);
      } else {
        console.error('[archive] 媒体下载失败:', result?.errmsg || '未知错误');
        resolve(false);
      }
    } catch (err) {
      console.error('[archive] downloadMedia 异常:', err.message);
      resolve(false);
    }
  });
}

// ── 缓存管理 ─────────────────────────────────────────────────────────────

function getStatus() {
  return { ...archiveCache, sdk: sdkName || '未加载', sdkKind: sdkKind || '未加载' };
}

function updateSeq(newSeq) {
  archiveCache.seq = newSeq;
  archiveCache.lastSyncAt = new Date().toISOString();
  archiveCache.totalPulled++;
}

function incrementErrors() {
  archiveCache.errors++;
}

function resetErrors() {
  archiveCache.errors = 0;
}

function setRunning(running) {
  archiveCache.running = running;
}

module.exports = {
  isReady,
  pullChatData,
  decryptChatMessage,
  downloadMedia,
  getStatus,
  updateSeq,
  incrementErrors,
  resetErrors,
  setRunning,
};
