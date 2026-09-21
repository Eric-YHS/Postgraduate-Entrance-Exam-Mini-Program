const fs = require('fs');
const os = require('os');
const path = require('path');

const mockChat = jest.fn();
jest.mock('../src/services/ai', () => ({ chat: mockChat }));

const {
  analyzeImages,
  detectImageMime,
  imageToDataUrl,
} = require('../src/services/minimaxMultimodal');

describe('minimaxMultimodal', () => {
  let tempDir;

  beforeEach(async () => {
    mockChat.mockReset();
    mockChat.mockResolvedValue('题目：求函数导数。');
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'minimax-image-test-'));
  });

  afterEach(async () => {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  test('sends private base64 images to MiniMax-M3 with maximum supported settings', async () => {
    const imagePath = path.join(tempDir, 'question.png');
    await fs.promises.writeFile(imagePath, Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from('test-image-data'),
    ]));

    const result = await analyzeImages([imagePath], { originalName: '高数题.png' });

    expect(result).toBe('题目：求函数导数。');
    expect(mockChat).toHaveBeenCalledTimes(1);
    const [messages, options] = mockChat.mock.calls[0];
    expect(messages[1].content).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'text' }),
      expect.objectContaining({
        type: 'image_url',
        image_url: expect.objectContaining({
          url: expect.stringMatching(/^data:image\/png;base64,/),
          detail: 'high',
        }),
      }),
    ]));
    expect(options).toEqual(expect.objectContaining({
      provider: 'minimax',
      model: 'MiniMax-M3',
      maxCompletionTokens: 8192,
      thinking: { type: 'adaptive' },
      serviceTier: 'priority',
    }));
  });

  test('rejects files that are not a supported image format', async () => {
    const filepath = path.join(tempDir, 'not-an-image.bin');
    await fs.promises.writeFile(filepath, Buffer.from('this is not an image'));

    await expect(imageToDataUrl(filepath)).rejects.toThrow('JPEG、PNG、GIF 或 WEBP');
    expect(mockChat).not.toHaveBeenCalled();
  });

  test('detects the four image formats accepted by MiniMax-M3', () => {
    expect(detectImageMime(Buffer.from([0xff, 0xd8, 0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe('image/jpeg');
    expect(detectImageMime(Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(4),
    ]))).toBe('image/png');
    expect(detectImageMime(Buffer.from('GIF89a......'))).toBe('image/gif');
    expect(detectImageMime(Buffer.from('RIFF....WEBP'))).toBe('image/webp');
  });
});
