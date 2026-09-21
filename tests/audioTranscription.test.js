const { gzipSync, gunzipSync } = require('zlib');

const {
  createAudioTranscriber,
  normalizeTranscript,
  buildFullClientRequest,
  buildAudioOnlyRequest,
  parseServerFrame,
  isTransientAsrError,
  MSG_TYPE,
} = require('../src/services/audioTranscription');

describe('audioTranscription with Volcengine Seed-ASR 2.0', () => {
  test('converts enterprise WeChat audio and uses the high-accuracy cloud model', async () => {
    const pcm = Buffer.alloc(6400, 1);
    const convertAudio = jest.fn().mockResolvedValue(pcm);
    const recognizePcm = jest.fn().mockResolvedValue({
      text: '我想问一下考研中山大学怎么样？',
      logId: 'safe-log-id',
    });
    const transcriber = createAudioTranscriber({
      apiKey: 'test-key',
      convertAudio,
      recognizePcm,
      maxAttempts: 1,
    });

    const result = await transcriber.transcribeAudio('/private/voice.amr', {
      durationSeconds: 7,
    });

    expect(convertAudio).toHaveBeenCalledWith('/private/voice.amr', expect.objectContaining({
      maxAudioSeconds: 120,
    }));
    expect(recognizePcm).toHaveBeenCalledWith(pcm, expect.objectContaining({
      apiKey: 'test-key',
      resourceId: 'volc.seedasr.sauc.duration',
      model: 'bigmodel',
    }), expect.any(Object));
    expect(result).toEqual({
      text: '我想问一下考研中山大学怎么样？',
      extractor: 'volcengine-seed-asr-2.0-nostream',
      language: 'auto-zh-en',
      logId: 'safe-log-id',
    });
  });

  test('rejects overlong voice messages before conversion or upload', async () => {
    const convertAudio = jest.fn();
    const transcriber = createAudioTranscriber({
      apiKey: 'test-key',
      convertAudio,
      recognizePcm: jest.fn(),
      maxAudioSeconds: 60,
    });

    await expect(transcriber.transcribeAudio('/private/voice.amr', { durationSeconds: 61 }))
      .rejects.toThrow('语音超过 60 秒限制');
    expect(convertAudio).not.toHaveBeenCalled();
  });

  test('retries transient upstream failures without retrying deterministic auth failures', async () => {
    const transient = Object.assign(new Error('connection reset'), { code: 'ECONNRESET' });
    const recognizePcm = jest.fn()
      .mockRejectedValueOnce(transient)
      .mockResolvedValueOnce({ text: '第二次成功。' });
    const sleep = jest.fn().mockResolvedValue();
    const transcriber = createAudioTranscriber({
      apiKey: 'test-key',
      convertAudio: jest.fn().mockResolvedValue(Buffer.alloc(3200)),
      recognizePcm,
      sleep,
      maxAttempts: 3,
    });

    await expect(transcriber.transcribeAudio('/private/voice.amr'))
      .resolves.toEqual(expect.objectContaining({ text: '第二次成功。' }));
    expect(recognizePcm).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(isTransientAsrError(Object.assign(new Error('forbidden'), { statusCode: 403 })))
      .toBe(false);
  });

  test('encodes and decodes the official Seed-ASR binary WebSocket protocol', () => {
    const requestPayload = { request: { model_name: 'bigmodel' } };
    const fullFrame = buildFullClientRequest(1, requestPayload);
    expect([...fullFrame.subarray(0, 4)]).toEqual([0x11, 0x11, 0x11, 0x00]);
    expect(fullFrame.readInt32BE(4)).toBe(1);
    const fullPayloadSize = fullFrame.readUInt32BE(8);
    expect(JSON.parse(gunzipSync(fullFrame.subarray(12, 12 + fullPayloadSize)).toString('utf8')))
      .toEqual(requestPayload);

    const audioFrame = buildAudioOnlyRequest(2, Buffer.from('pcm'), true);
    expect(audioFrame[1]).toBe(0x23);
    expect(audioFrame.readInt32BE(4)).toBe(-2);

    const responsePayload = gzipSync(Buffer.from(JSON.stringify({
      result: { text: '识别完成。' },
    })));
    const responseHeader = Buffer.from([0x11, 0x93, 0x11, 0x00]);
    const responseSequence = Buffer.alloc(4);
    responseSequence.writeInt32BE(-3, 0);
    const responseSize = Buffer.alloc(4);
    responseSize.writeUInt32BE(responsePayload.length, 0);
    const parsed = parseServerFrame(Buffer.concat([
      responseHeader,
      responseSequence,
      responseSize,
      responsePayload,
    ]));

    expect(parsed).toEqual(expect.objectContaining({
      messageType: MSG_TYPE.SERVER_FULL_RESPONSE,
      sequence: -3,
      isLast: true,
      payload: { result: { text: '识别完成。' } },
    }));
  });

  test('normalizes timestamps and detects silent output', () => {
    expect(normalizeTranscript('[00:00.000 --> 00:01.000] 第一行\r\n[00:01.000 --> 00:02.000] 第二行'))
      .toBe('第一行\n第二行');
    expect(normalizeTranscript('[BLANK_AUDIO]')).toBe('');
  });
});
