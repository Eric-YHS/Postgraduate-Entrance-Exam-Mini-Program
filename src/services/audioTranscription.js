/**
 * 企业微信语音的火山引擎 Seed-ASR 2.0 云端转写。
 *
 * 企业微信会话存档中的 voice 媒体通常是 8kHz AMR。这里只在本机用
 * ffmpeg 做无模型的格式转换，再通过私有 WebSocket 将 16kHz PCM 直接
 * 发送给 Seed-ASR 2.0；无需公网临时文件，也不在服务器部署本地 ASR 模型。
 */

const { randomUUID } = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { gzipSync, gunzipSync } = require('zlib');
const WebSocket = require('ws');
require('../config'); // 确保项目 .env 已在独立测试或脚本调用时加载。

const execFileAsync = promisify(execFile);

const DEFAULT_ASR_WS_URL = 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_nostream';
const DEFAULT_ASR_RESOURCE_ID = 'volc.seedasr.sauc.duration';
const DEFAULT_ASR_MODEL = 'bigmodel';
const DEFAULT_TIMEOUT_MS = 90 * 1000;
const DEFAULT_MAX_AUDIO_SECONDS = 120;
const DEFAULT_SEGMENT_DURATION_MS = 200;
const DEFAULT_CONTEXT = [
  '这是考研辅导群中学生提出的问题，通常是普通话或中英混合口述。',
  '常见词包括：考研、初试、复试、调剂、国家线、院校、专业课、中山大学、数学一、数学二、数学三、英语一、英语二、政治、择校、备考。',
].join('');

const MSG_TYPE = {
  CLIENT_FULL_REQUEST: 0b0001,
  CLIENT_AUDIO_ONLY_REQUEST: 0b0010,
  SERVER_FULL_RESPONSE: 0b1001,
  SERVER_ERROR_RESPONSE: 0b1111,
};
const FLAGS = {
  POS_SEQUENCE: 0b0001,
  NEG_WITH_SEQUENCE: 0b0011,
};
const SERIALIZATION = { NONE: 0b0000, JSON: 0b0001 };
const COMPRESSION = { NONE: 0b0000, GZIP: 0b0001 };
const VERSION = 0b0001;

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function normalizeTranscript(value) {
  const normalized = String(value || '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/^\s*\[[\d:.]+\s*-->\s*[\d:.]+\]\s*/gm, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (/^(\[?(blank[ _-]?audio|silence|no speech|music|音乐|静音)\]?|\((silence|music)\))$/i.test(normalized)) {
    return '';
  }
  return normalized;
}

function buildHeader(messageType, flags, serialization, compression) {
  const header = Buffer.alloc(4);
  header[0] = (VERSION << 4) | 0b0001;
  header[1] = (messageType << 4) | flags;
  header[2] = (serialization << 4) | compression;
  header[3] = 0x00;
  return header;
}

function buildFullClientRequest(sequence, payloadObject) {
  const compressed = gzipSync(Buffer.from(JSON.stringify(payloadObject), 'utf8'));
  const sequenceBuffer = Buffer.alloc(4);
  sequenceBuffer.writeInt32BE(sequence, 0);
  const sizeBuffer = Buffer.alloc(4);
  sizeBuffer.writeUInt32BE(compressed.length, 0);
  return Buffer.concat([
    buildHeader(
      MSG_TYPE.CLIENT_FULL_REQUEST,
      FLAGS.POS_SEQUENCE,
      SERIALIZATION.JSON,
      COMPRESSION.GZIP
    ),
    sequenceBuffer,
    sizeBuffer,
    compressed,
  ]);
}

function buildAudioOnlyRequest(sequence, audioChunk, isLast) {
  const compressed = gzipSync(audioChunk);
  const sequenceBuffer = Buffer.alloc(4);
  sequenceBuffer.writeInt32BE(isLast ? -sequence : sequence, 0);
  const sizeBuffer = Buffer.alloc(4);
  sizeBuffer.writeUInt32BE(compressed.length, 0);
  return Buffer.concat([
    buildHeader(
      MSG_TYPE.CLIENT_AUDIO_ONLY_REQUEST,
      isLast ? FLAGS.NEG_WITH_SEQUENCE : FLAGS.POS_SEQUENCE,
      SERIALIZATION.NONE,
      COMPRESSION.GZIP
    ),
    sequenceBuffer,
    sizeBuffer,
    compressed,
  ]);
}

function decodePayload(serialization, compression, payload) {
  let decoded = payload;
  if (compression === COMPRESSION.GZIP && decoded.length > 0) {
    decoded = gunzipSync(decoded);
  }
  if (serialization === SERIALIZATION.JSON && decoded.length > 0) {
    return JSON.parse(decoded.toString('utf8'));
  }
  return decoded;
}

function assertReadable(frame, offset, bytes, label) {
  if (offset < 0 || bytes < 0 || offset + bytes > frame.length) {
    throw new Error(`Seed-ASR 返回帧不完整：${label}`);
  }
}

function parseServerFrame(value) {
  const frame = Buffer.isBuffer(value) ? value : Buffer.from(value);
  assertReadable(frame, 0, 4, 'header');

  const headerSizeBytes = (frame[0] & 0x0f) * 4;
  const messageType = frame[1] >> 4;
  const flags = frame[1] & 0x0f;
  const serialization = frame[2] >> 4;
  const compression = frame[2] & 0x0f;
  let offset = headerSizeBytes;
  let sequence = null;

  if (flags & 0x01) {
    assertReadable(frame, offset, 4, 'sequence');
    sequence = frame.readInt32BE(offset);
    offset += 4;
  }

  if (messageType === MSG_TYPE.SERVER_FULL_RESPONSE) {
    assertReadable(frame, offset, 4, 'payload size');
    const payloadSize = frame.readUInt32BE(offset);
    offset += 4;
    assertReadable(frame, offset, payloadSize, 'payload');
    return {
      messageType,
      sequence,
      isLast: Boolean(flags & 0x02),
      payload: decodePayload(serialization, compression, frame.subarray(offset, offset + payloadSize)),
    };
  }

  if (messageType === MSG_TYPE.SERVER_ERROR_RESPONSE) {
    assertReadable(frame, offset, 8, 'error');
    const errorCode = frame.readInt32BE(offset);
    offset += 4;
    const payloadSize = frame.readUInt32BE(offset);
    offset += 4;
    assertReadable(frame, offset, payloadSize, 'error payload');
    let detail;
    try {
      detail = decodePayload(
        serialization,
        compression,
        frame.subarray(offset, offset + payloadSize)
      );
    } catch (_) {
      detail = frame.subarray(offset, offset + payloadSize).toString('utf8');
    }
    return {
      messageType,
      sequence,
      isLast: Boolean(flags & 0x02),
      errorCode,
      error: detail,
    };
  }

  return { messageType, sequence, isLast: Boolean(flags & 0x02), payload: null };
}

async function defaultConvertAudio(filepath, options = {}) {
  const maxAudioSeconds = positiveInteger(options.maxAudioSeconds, DEFAULT_MAX_AUDIO_SECONDS);
  const result = await execFileAsync('ffmpeg', [
    '-nostdin', '-v', 'error',
    '-i', filepath,
    '-t', String(maxAudioSeconds),
    '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le',
    '-f', 's16le', 'pipe:1',
  ], {
    encoding: null,
    windowsHide: true,
    timeout: Math.min(60 * 1000, positiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS)),
    maxBuffer: 8 * 1024 * 1024,
  });
  return Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout || '');
}

function sendFrame(websocket, frame) {
  return new Promise((resolve, reject) => {
    websocket.send(frame, { binary: true }, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function contextJson(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  return JSON.stringify({ context_data: [{ text }] });
}

function runSeedAsr(pcmBuffer, options = {}, dependencies = {}) {
  const WebSocketImpl = dependencies.WebSocketImpl || WebSocket;
  const sleep = dependencies.sleep || delay;
  const apiKey = String(options.apiKey || '').trim();
  if (!apiKey) throw new Error('火山引擎 Seed-ASR API Key 未配置');
  if (!Buffer.isBuffer(pcmBuffer) || pcmBuffer.length === 0) {
    throw new Error('转换后的语音为空');
  }

  const connectId = randomUUID();
  const timeoutMs = positiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS);
  const segmentDurationMs = positiveInteger(
    options.segmentDurationMs,
    DEFAULT_SEGMENT_DURATION_MS
  );
  const sendIntervalMs = Math.max(0, Number(options.sendIntervalMs) || 0);
  const headers = {
    'X-Api-Key': apiKey,
    'X-Api-Resource-Id': options.resourceId || DEFAULT_ASR_RESOURCE_ID,
    'X-Api-Connect-Id': connectId,
  };

  return new Promise((resolve, reject) => {
    let websocket;
    let settled = false;
    let finalText = '';
    let logId = '';

    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (websocket && websocket.readyState === WebSocketImpl.OPEN) {
        try { websocket.close(); } catch (_) { /* ignore */ }
      }
      if (error) reject(error);
      else resolve(result);
    };

    const timer = setTimeout(() => {
      const error = new Error(`Seed-ASR 请求超时（${timeoutMs}ms）`);
      error.code = 'ASR_TIMEOUT';
      finish(error);
    }, timeoutMs);
    timer.unref?.();

    try {
      websocket = new WebSocketImpl(options.wsUrl || DEFAULT_ASR_WS_URL, {
        headers,
        handshakeTimeout: Math.min(15000, timeoutMs),
      });
    } catch (error) {
      finish(error);
      return;
    }

    websocket.on('upgrade', (response) => {
      logId = String(response?.headers?.['x-tt-logid'] || '');
    });

    websocket.on('unexpected-response', (_request, response) => {
      const error = new Error(`Seed-ASR 鉴权或服务请求失败（HTTP ${response.statusCode || 0}）`);
      error.statusCode = Number(response.statusCode || 0);
      response.resume?.();
      finish(error);
    });

    websocket.on('error', (error) => finish(error));
    websocket.on('close', (code, reason) => {
      if (settled) return;
      const suffix = Buffer.isBuffer(reason) ? reason.toString('utf8') : String(reason || '');
      const error = new Error(`Seed-ASR 连接提前关闭（${code}${suffix ? `: ${suffix}` : ''}）`);
      error.code = 'ASR_CONNECTION_CLOSED';
      finish(error);
    });

    websocket.on('message', (data) => {
      try {
        const parsed = parseServerFrame(data);
        if (parsed.messageType === MSG_TYPE.SERVER_ERROR_RESPONSE) {
          const detail = typeof parsed.error === 'string'
            ? parsed.error
            : JSON.stringify(parsed.error || {});
          const error = new Error(`Seed-ASR 返回错误 ${parsed.errorCode}: ${detail.slice(0, 300)}`);
          error.errorCode = parsed.errorCode;
          error.logId = logId;
          finish(error);
          return;
        }
        const text = parsed.payload?.result?.text;
        if (typeof text === 'string' && text.trim()) finalText = text;
        if (parsed.isLast) {
          finish(null, { text: finalText, logId, connectId });
        }
      } catch (error) {
        finish(error);
      }
    });

    websocket.on('open', async () => {
      try {
        const corpus = contextJson(options.context || DEFAULT_CONTEXT);
        const payload = {
          user: { uid: options.uid || 'wecom-group-bot' },
          audio: {
            format: 'pcm',
            codec: 'raw',
            rate: 16000,
            bits: 16,
            channel: 1,
          },
          request: {
            model_name: options.model || DEFAULT_ASR_MODEL,
            enable_itn: true,
            enable_punc: true,
            enable_ddc: false,
            show_utterances: false,
            result_type: 'full',
            ...(corpus ? { corpus: { context: corpus } } : {}),
          },
        };

        let sequence = 1;
        await sendFrame(websocket, buildFullClientRequest(sequence, payload));
        sequence += 1;
        const bytesPerMillisecond = 16000 * 2 / 1000;
        const segmentBytes = Math.max(2, Math.floor(bytesPerMillisecond * segmentDurationMs));

        for (let offset = 0; offset < pcmBuffer.length;) {
          const end = Math.min(offset + segmentBytes, pcmBuffer.length);
          const isLast = end >= pcmBuffer.length;
          await sendFrame(
            websocket,
            buildAudioOnlyRequest(sequence, pcmBuffer.subarray(offset, end), isLast)
          );
          if (!isLast) sequence += 1;
          offset = end;
          if (!isLast && sendIntervalMs > 0) await sleep(sendIntervalMs);
        }
      } catch (error) {
        finish(error);
      }
    });
  });
}

function isTransientAsrError(error) {
  const status = Number(error?.statusCode || 0);
  if ([408, 409, 425, 429].includes(status) || status >= 500) return true;
  if (Number(error?.errorCode) === 45000081) return true;
  if (['ASR_TIMEOUT', 'ASR_CONNECTION_CLOSED', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN']
    .includes(String(error?.code || ''))) return true;
  return /socket hang up|network|temporar|timeout|timed out/i.test(String(error?.message || ''));
}

function createAudioTranscriber(dependencies = {}) {
  const convertAudio = dependencies.convertAudio || defaultConvertAudio;
  const recognizePcm = dependencies.recognizePcm || runSeedAsr;
  const sleep = dependencies.sleep || delay;
  const apiKey = String(
    dependencies.apiKey
      ?? process.env.VOLCENGINE_ASR_API_KEY
      ?? process.env.SEED_ASR_API_KEY
      ?? process.env.SEED_TTS_API_KEY
      ?? ''
  ).trim();
  const maxAudioSeconds = positiveInteger(
    dependencies.maxAudioSeconds ?? process.env.WECOM_VOICE_MAX_SECONDS,
    DEFAULT_MAX_AUDIO_SECONDS
  );
  const timeoutMs = positiveInteger(
    dependencies.timeoutMs ?? process.env.VOLCENGINE_ASR_TIMEOUT_MS,
    DEFAULT_TIMEOUT_MS
  );
  const maxAttempts = positiveInteger(
    dependencies.maxAttempts ?? process.env.VOLCENGINE_ASR_MAX_ATTEMPTS,
    3
  );

  async function transcribeAudio(filepath, options = {}) {
    const declaredSeconds = Number(options.durationSeconds || 0);
    if (Number.isFinite(declaredSeconds) && declaredSeconds > maxAudioSeconds) {
      throw new Error(`语音超过 ${maxAudioSeconds} 秒限制`);
    }
    if (!apiKey) throw new Error('火山引擎 Seed-ASR API Key 未配置');

    const pcmBuffer = await convertAudio(filepath, { maxAudioSeconds, timeoutMs });
    if (!Buffer.isBuffer(pcmBuffer) || pcmBuffer.length === 0) {
      throw new Error('语音格式转换后没有可识别内容');
    }

    let lastError;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const result = await recognizePcm(pcmBuffer, {
          apiKey,
          wsUrl: dependencies.wsUrl || process.env.VOLCENGINE_ASR_WS_URL || DEFAULT_ASR_WS_URL,
          resourceId: dependencies.resourceId
            || process.env.VOLCENGINE_ASR_RESOURCE_ID
            || DEFAULT_ASR_RESOURCE_ID,
          model: dependencies.model || process.env.VOLCENGINE_ASR_MODEL || DEFAULT_ASR_MODEL,
          timeoutMs,
          segmentDurationMs: dependencies.segmentDurationMs
            ?? process.env.VOLCENGINE_ASR_SEGMENT_MS
            ?? DEFAULT_SEGMENT_DURATION_MS,
          sendIntervalMs: dependencies.sendIntervalMs
            ?? process.env.VOLCENGINE_ASR_SEND_INTERVAL_MS
            ?? 0,
          context: dependencies.context
            ?? process.env.VOLCENGINE_ASR_CONTEXT
            ?? DEFAULT_CONTEXT,
        }, dependencies);
        const transcript = normalizeTranscript(result?.text);
        if (!transcript) throw new Error('语音中没有识别到清晰的人声');
        return {
          text: transcript,
          extractor: 'volcengine-seed-asr-2.0-nostream',
          language: 'auto-zh-en',
          logId: String(result?.logId || ''),
        };
      } catch (error) {
        lastError = error;
        if (!isTransientAsrError(error) || attempt >= maxAttempts) throw error;
        await sleep(Math.min(3000, 500 * (2 ** (attempt - 1))));
      }
    }
    throw lastError;
  }

  return { transcribeAudio };
}

const defaultTranscriber = createAudioTranscriber();

module.exports = {
  transcribeAudio: defaultTranscriber.transcribeAudio,
  createAudioTranscriber,
  normalizeTranscript,
  buildFullClientRequest,
  buildAudioOnlyRequest,
  parseServerFrame,
  runSeedAsr,
  isTransientAsrError,
  DEFAULT_ASR_WS_URL,
  DEFAULT_ASR_RESOURCE_ID,
  DEFAULT_MAX_AUDIO_SECONDS,
  MSG_TYPE,
};
