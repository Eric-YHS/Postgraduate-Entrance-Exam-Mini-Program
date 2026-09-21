const fs = require('fs');
const os = require('os');
const path = require('path');
const iconv = require('iconv-lite');

const {
  createWecomMediaProcessor,
  decodeTextBuffer,
  docxXmlToText,
} = require('../src/services/wecomMedia');

describe('wecomMedia', () => {
  let mediaRoot;
  let errorSpy;

  beforeEach(async () => {
    mediaRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'wecom-media-test-'));
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    errorSpy.mockRestore();
    await fs.promises.rm(mediaRoot, { recursive: true, force: true });
  });

  test('downloads an image privately and returns MiniMax-M3 vision text', async () => {
    const analyzeImages = jest.fn().mockResolvedValue('已知函数 f(x)=x²，求导数。');
    const downloadMedia = jest.fn(async (_sdkfileid, filepath) => {
      await fs.promises.writeFile(filepath, Buffer.from('fake-image'));
      return true;
    });
    const processor = createWecomMediaProcessor({ mediaRoot, analyzeImages, downloadMedia });

    const result = await processor.processMediaMessage({
      msgid: 'image-message-1',
      msgtype: 'image',
      image: { sdkfileid: 'sdk-image-1', filesize: 10 },
    });

    expect(downloadMedia).toHaveBeenCalledWith('sdk-image-1', expect.stringContaining('.part'));
    expect(analyzeImages).toHaveBeenCalledWith(
      [result.mediaPath],
      expect.objectContaining({ originalName: '群聊图片' })
    );
    expect(result.content).toContain('MiniMax-M3 高精度读取结果');
    expect(result.content).toContain('求导数');
    expect(JSON.parse(result.mediaMeta)).toEqual(expect.objectContaining({
      status: 'ok',
      kind: 'image',
      extractor: 'minimax-m3-vision-high',
    }));
    expect((await fs.promises.stat(result.mediaPath)).isFile()).toBe(true);
    expect(path.dirname(result.mediaPath)).toBe(mediaRoot);
  });

  test('reads a GB18030 text file without invoking an external command', async () => {
    const runCommand = jest.fn();
    const downloadMedia = jest.fn(async (_sdkfileid, filepath) => {
      await fs.promises.writeFile(filepath, iconv.encode('材料分析：请说明原因。', 'gb18030'));
      return true;
    });
    const processor = createWecomMediaProcessor({ mediaRoot, runCommand, downloadMedia });

    const result = await processor.processMediaMessage({
      msgid: 'file-message-1',
      msgtype: 'file',
      file: { filename: '材料.txt', fileext: 'txt', sdkfileid: 'sdk-file-1' },
    });

    expect(runCommand).not.toHaveBeenCalled();
    expect(result.content).toContain('材料分析：请说明原因。');
    expect(JSON.parse(result.mediaMeta).extractor).toBe('plain-text');
  });

  test('uses pdftotext for the first 30 pages of a PDF', async () => {
    const runCommand = jest.fn().mockResolvedValue('PDF 中的题目正文');
    const processor = createWecomMediaProcessor({
      mediaRoot,
      runCommand,
      downloadMedia: async (_sdkfileid, filepath) => {
        await fs.promises.writeFile(filepath, Buffer.from('%PDF-test'));
        return true;
      },
    });

    const result = await processor.processMediaMessage({
      msgid: 'pdf-message-1',
      msgtype: 'file',
      file: { filename: '题目.pdf', fileext: 'pdf', sdkfileid: 'sdk-pdf-1' },
    });

    expect(runCommand).toHaveBeenCalledWith(
      'pdftotext',
      expect.arrayContaining(['-f', '1', '-l', '30', '-layout', '-']),
      expect.any(Object)
    );
    expect(result.content).toContain('PDF 中的题目正文');
  });

  test('renders a scanned PDF and sends its pages to MiniMax-M3', async () => {
    const analyzeImages = jest.fn().mockResolvedValue('扫描页中的数学题');
    const runCommand = jest.fn(async (command, args) => {
      if (command === 'pdftotext') return '  ';
      if (command === 'pdftoppm') {
        const outputPrefix = args[args.length - 1];
        await fs.promises.writeFile(`${outputPrefix}-1.jpg`, Buffer.from('page-one'));
        await fs.promises.writeFile(`${outputPrefix}-2.jpg`, Buffer.from('page-two'));
        return '';
      }
      throw new Error(`unexpected command ${command}`);
    });
    const processor = createWecomMediaProcessor({
      mediaRoot,
      runCommand,
      analyzeImages,
      downloadMedia: async (_sdkfileid, filepath) => {
        await fs.promises.writeFile(filepath, Buffer.from('%PDF-scanned'));
        return true;
      },
    });

    const result = await processor.processMediaMessage({
      msgid: 'scanned-pdf-message',
      msgtype: 'file',
      file: { filename: '扫描题目.pdf', fileext: 'pdf', sdkfileid: 'sdk-scanned-pdf' },
    });

    expect(analyzeImages).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.stringMatching(/\.pdf-pages-.+-1\.jpg$/),
        expect.stringMatching(/\.pdf-pages-.+-2\.jpg$/),
      ]),
      expect.objectContaining({ originalName: '扫描题目.pdf' })
    );
    expect(result.content).toContain('扫描页中的数学题');
    expect(JSON.parse(result.mediaMeta).extractor).toBe('pdftoppm+minimax-m3-vision-high');
    const remainingPages = (await fs.promises.readdir(mediaRoot)).filter((name) => name.startsWith('.pdf-pages-'));
    expect(remainingPages).toEqual([]);
  });

  test('downloads an enterprise WeChat AMR voice and queues its transcript', async () => {
    const transcribeAudio = jest.fn().mockResolvedValue({
      text: '我想问一下考研中山大学怎么样？',
      extractor: 'volcengine-seed-asr-2.0-nostream',
      language: 'auto-zh-en',
    });
    const downloadMedia = jest.fn(async (_sdkfileid, filepath) => {
      await fs.promises.writeFile(filepath, Buffer.from('#!AMR\nvoice-data'));
      return true;
    });
    const processor = createWecomMediaProcessor({
      mediaRoot,
      transcribeAudio,
      downloadMedia,
    });

    const result = await processor.processMediaMessage({
      msgid: 'voice-message-1',
      msgtype: 'voice',
      voice: {
        sdkfileid: 'sdk-voice-1',
        voice_size: 1234,
        play_length: 7,
      },
    });

    expect(downloadMedia).toHaveBeenCalledWith('sdk-voice-1', expect.stringContaining('.part'));
    expect(transcribeAudio).toHaveBeenCalledWith(
      result.mediaPath,
      expect.objectContaining({ durationSeconds: 7, workRoot: mediaRoot })
    );
    expect(result.content).toContain('学生语音 火山引擎 Seed-ASR 2.0 转写结果');
    expect(result.content).toContain('考研中山大学怎么样');
    expect(JSON.parse(result.mediaMeta)).toEqual(expect.objectContaining({
      status: 'ok',
      kind: 'voice',
      extension: 'amr',
      durationSeconds: 7,
      extractor: 'volcengine-seed-asr-2.0-nostream',
    }));
  });

  test('rejects an oversized message before downloading it', async () => {
    const downloadMedia = jest.fn();
    const processor = createWecomMediaProcessor({
      mediaRoot,
      maxMediaBytes: 1024,
      downloadMedia,
    });

    const result = await processor.processMediaMessage({
      msgid: 'large-image',
      msgtype: 'image',
      image: { sdkfileid: 'sdk-large', filesize: 2048 },
    });

    expect(downloadMedia).not.toHaveBeenCalled();
    expect(JSON.parse(result.mediaMeta).status).toBe('failed');
    expect(result.content).toContain('重新发送一张清晰');
  });

  test('keeps an unsupported file private and returns a useful fallback prompt', async () => {
    const processor = createWecomMediaProcessor({
      mediaRoot,
      downloadMedia: async (_sdkfileid, filepath) => {
        await fs.promises.writeFile(filepath, Buffer.from('zip-data'));
        return true;
      },
    });

    const result = await processor.processMediaMessage({
      msgid: 'zip-message',
      msgtype: 'file',
      file: { filename: '资料.zip', fileext: 'zip', sdkfileid: 'sdk-zip' },
    });

    expect(JSON.parse(result.mediaMeta)).toEqual(expect.objectContaining({
      status: 'failed',
      extension: 'zip',
    }));
    expect(result.content).toContain('当前支持 TXT');
    expect((await fs.promises.stat(result.mediaPath)).isFile()).toBe(true);
  });

  test('decodes XML entities and document paragraphs', () => {
    expect(docxXmlToText('<w:p><w:r><w:t>A&amp;B</w:t></w:r></w:p><w:p><w:t>第二段</w:t></w:p>'))
      .toContain('A&B\n第二段');
    expect(decodeTextBuffer(Buffer.from('普通 UTF-8 文本'))).toBe('普通 UTF-8 文本');
  });
});
