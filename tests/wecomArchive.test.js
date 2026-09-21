const mockGetChatData = jest.fn();
const mockGetMediaData = jest.fn();
const mockWeWorkChat = jest.fn().mockImplementation(() => ({
  getChatData: mockGetChatData,
  getMediaData: mockGetMediaData,
}));

jest.mock('wework-chat-node', () => ({
  WeWorkChat: mockWeWorkChat,
}));

describe('wecomArchive modern SDK adapter', () => {
  const originalEnv = { ...process.env };
  let archive;

  beforeAll(() => {
    process.env.WECOM_CORP_ID = 'ww-test-corp';
    process.env.WECOM_ARCHIVE_SECRET = 'archive-test-secret';
    process.env.WECOM_ARCHIVE_PRIVATE_KEY = Buffer.from(
      '-----BEGIN RSA PRIVATE KEY-----\ntest\n-----END RSA PRIVATE KEY-----\n'
    ).toString('base64');
    process.env.WECOM_ARCHIVE_ENABLED = 'true';
    jest.resetModules();
    archive = require('../src/services/wecomArchive');
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  beforeEach(() => {
    mockGetChatData.mockReset();
    mockGetMediaData.mockReset();
    mockWeWorkChat.mockClear();
  });

  test('prefers the maintained SDK and normalizes decrypted messages', async () => {
    mockGetChatData.mockReturnValue({
      last_seq: 9,
      data: [
        JSON.stringify({ msgid: 'msg-8', msgtype: 'text', text: { content: '问题一' } }),
        JSON.stringify({ msgid: 'msg-9', msgtype: 'text', text: { content: '问题二' } }),
      ],
    });

    expect(archive.isReady()).toEqual({ ok: true });
    const result = await archive.pullChatData(7, 2);

    expect(mockWeWorkChat).toHaveBeenCalledWith(expect.objectContaining({
      corpid: 'ww-test-corp',
      secret: 'archive-test-secret',
      seq: 0,
    }));
    expect(mockGetChatData).toHaveBeenCalledWith({ seq: 7, max_results: 2, timeout: 30 });
    expect(result).toMatchObject({
      errcode: 0,
      errmsg: 'ok',
      last_seq: 9,
      already_decrypted: true,
    });
    expect(result.chatdata).toEqual([
      expect.objectContaining({ seq: 8, msgid: 'msg-8' }),
      expect.objectContaining({ seq: 9, msgid: 'msg-9' }),
    ]);
    expect(result.chatdata[0].decrypted_message.text.content).toBe('问题一');
    expect(archive.getStatus()).toMatchObject({
      sdk: 'wework-chat-node',
      sdkKind: 'modern',
    });
  });

  test('does not advance the cursor when the SDK returns an undecrypted hole', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockGetChatData.mockReturnValue({
      last_seq: 11,
      data: [JSON.stringify({ msgid: 'msg-10', msgtype: 'text' }), undefined],
    });

    await expect(archive.pullChatData(9, 2)).resolves.toBeNull();
    expect(errorSpy).toHaveBeenCalledWith(
      '[archive] pullChatData 异常:',
      expect.stringContaining('解密为空')
    );
    errorSpy.mockRestore();
  });
});
