const mockSendAppChatMessage = jest.fn();
const mockHandleFreeTutor = jest.fn();
const mockHandleAnswer = jest.fn();
const mockHandleConfiguredGroupBot = jest.fn();
const mockBuildGroupContext = jest.fn();
const mockProcessMediaMessage = jest.fn();
const mockGroups = [];
const mockAssignments = [];
const mockPendingReplies = new Map();
const mockRecordedMessages = [];

function findGroupByRoom(roomid) {
  return mockGroups.find((group) => (
    group.archive_roomid === roomid || group.chat_id === roomid
  ));
}

const mockDb = {
  transaction: jest.fn((callback) => callback),
  prepare: jest.fn((sql) => {
    const normalized = sql.replace(/\s+/g, ' ').trim();

    if (normalized.includes('SELECT config FROM bots')) {
      return { all: () => [] };
    }
    if (normalized.includes('SELECT id FROM wecom_archive_messages')) {
      return {
        get: (msgid) => mockRecordedMessages.some((row) => row.msgid === msgid)
          ? { id: 1 }
          : undefined,
      };
    }
    if (normalized.includes('FROM wecom_groups') && normalized.includes('archive_roomid = ? OR chat_id = ?')) {
      return { get: (roomid) => findGroupByRoom(roomid) };
    }
    if (normalized.includes('FROM wecom_groups') && normalized.includes('WHERE id = ?')) {
      return { get: (groupId) => mockGroups.find((group) => group.id === groupId) };
    }
    if (normalized.includes('FROM bot_group_assignments')) {
      return {
        all: (groupId) => mockAssignments
          .filter((assignment) => assignment.group_id === groupId && assignment.is_active)
          .map((assignment) => ({ ...assignment, config: JSON.stringify(assignment.config || {}) })),
      };
    }
    if (normalized.includes('SELECT id, role FROM users')) {
      return { get: () => undefined };
    }
    if (normalized.startsWith('UPDATE wecom_groups SET archive_roomid')) {
      return {
        run: (roomid, token) => {
          const group = mockGroups.find((item) => item.binding_token === token);
          if (!group) return { changes: 0 };
          group.archive_roomid = roomid;
          return { changes: 1 };
        },
      };
    }
    if (normalized.includes('INSERT OR IGNORE INTO wecom_archive_messages')) {
      return {
        run: (...args) => {
          const msgid = args[0];
          if (mockRecordedMessages.some((row) => row.msgid === msgid)) return { changes: 0 };
          const actionIsLiteral = normalized.includes("'ignored'");
          mockRecordedMessages.push({
            msgid,
            seq: args[1],
            fromUser: args[2],
            roomid: args[3],
            msgtype: args[4],
            content: args[5],
            action: actionIsLiteral ? 'ignored' : args[6],
            mediaPath: actionIsLiteral ? args[8] : args[9],
            mediaMeta: actionIsLiteral ? args[9] : args[10],
          });
          return { changes: 1 };
        },
      };
    }
    if (normalized === 'SELECT messages_json, version, processing_version FROM wecom_pending_replies WHERE roomid = ?') {
      return {
        get: (roomid) => {
          const pending = mockPendingReplies.get(roomid);
          return pending ? {
            messages_json: pending.messages_json,
            version: pending.version,
            processing_version: pending.processing_version,
          } : undefined;
        },
      };
    }
    if (normalized.startsWith('INSERT INTO wecom_pending_replies')) {
      return {
        run: (roomid, groupId, messagesJson, dueAt, createdAt, updatedAt) => {
          const existing = mockPendingReplies.get(roomid);
          mockPendingReplies.set(roomid, {
            roomid,
            group_id: groupId,
            messages_json: messagesJson,
            version: existing ? existing.version + 1 : 1,
            processing_version: 0,
            due_at: dueAt,
            attempts: 0,
            last_error: '',
            created_at: existing?.created_at || createdAt,
            updated_at: updatedAt,
          });
          return { changes: 1 };
        },
      };
    }
    if (normalized.includes('FROM wecom_pending_replies') && normalized.includes('WHERE due_at <= ?')) {
      return {
        all: (nowMs) => [...mockPendingReplies.values()]
          .filter((row) => row.due_at <= nowMs && row.processing_version === 0)
          .sort((a, b) => a.due_at - b.due_at)
          .slice(0, 20),
      };
    }
    if (normalized.startsWith('DELETE FROM wecom_pending_replies')) {
      return {
        run: (roomid, version) => {
          const row = mockPendingReplies.get(roomid);
          if (!row || row.version !== version) return { changes: 0 };
          mockPendingReplies.delete(roomid);
          return { changes: 1 };
        },
      };
    }
    if (normalized.startsWith('UPDATE wecom_pending_replies SET processing_version = ?')) {
      return {
        run: (processingVersion, roomid, version) => {
          const row = mockPendingReplies.get(roomid);
          if (!row || row.version !== version || row.processing_version !== 0) return { changes: 0 };
          row.processing_version = processingVersion;
          return { changes: 1 };
        },
      };
    }
    if (normalized.startsWith('UPDATE wecom_pending_replies')) {
      return {
        run: (lastError, dueAt, updatedAt, roomid, version) => {
          const row = mockPendingReplies.get(roomid);
          if (!row || row.version !== version) return { changes: 0 };
          row.attempts += 1;
          row.processing_version = 0;
          row.last_error = lastError;
          row.due_at = dueAt;
          row.updated_at = updatedAt;
          return { changes: 1 };
        },
      };
    }
    if (normalized.startsWith("UPDATE wecom_archive_messages SET action = 'group_reply'")) {
      return {
        run: (...msgids) => {
          let changes = 0;
          for (const row of mockRecordedMessages) {
            if (msgids.includes(row.msgid)) {
              row.action = 'group_reply';
              changes++;
            }
          }
          return { changes };
        },
      };
    }

    throw new Error(`Unexpected SQL in archiveDispatcher test: ${normalized}`);
  }),
};

jest.mock('../src/db', () => ({ db: mockDb }));
jest.mock('../src/services/wecom', () => ({
  sendAppChatMessage: mockSendAppChatMessage,
}));
jest.mock('../src/services/bots/freeTutorBot', () => ({
  handleMessage: mockHandleFreeTutor,
}));
jest.mock('../src/services/bots/answerBot', () => ({
  handleQuestion: mockHandleAnswer,
}));
jest.mock('../src/services/bots/configurableGroupBot', () => ({
  handleConfiguredGroupBot: mockHandleConfiguredGroupBot,
}));
jest.mock('../src/services/contextBuilder', () => ({
  buildGroupContext: mockBuildGroupContext,
}));
jest.mock('../src/services/wecomMedia', () => ({
  processMediaMessage: mockProcessMediaMessage,
}));

const {
  processBatch,
  flushDueReplies,
  shouldSkip,
} = require('../src/services/archiveDispatcher');

function addGroup(overrides = {}) {
  const group = {
    id: 1,
    chat_id: 'application-chat-1',
    archive_roomid: 'archive-room-1',
    name: '测试群',
    owner: 'owner-1',
    reply_enabled: 1,
    reply_all_text: 1,
    reply_delay_seconds: 5,
    binding_token: '',
    ...overrides,
  };
  mockGroups.push(group);
  return group;
}

function textMessage(overrides = {}) {
  return {
    msgid: 'msg-1',
    seq: 1,
    from: 'user-1',
    roomid: 'archive-room-1',
    msgtype: 'text',
    msgtime: Date.now(),
    text: { content: '好的' },
    ...overrides,
  };
}

describe('archiveDispatcher group debounce', () => {
  beforeEach(() => {
    mockSendAppChatMessage.mockReset();
    mockHandleFreeTutor.mockReset();
    mockHandleAnswer.mockReset();
    mockHandleConfiguredGroupBot.mockReset();
    mockBuildGroupContext.mockReset();
    mockProcessMediaMessage.mockReset();
    mockGroups.length = 0;
    mockAssignments.length = 0;
    mockPendingReplies.clear();
    mockRecordedMessages.length = 0;

    mockBuildGroupContext.mockResolvedValue({ fullContext: '' });
    mockHandleFreeTutor.mockResolvedValue({ reply: '收到，我来一起看看。' });
    mockProcessMediaMessage.mockResolvedValue({
      content: '[媒体识别结果]\n测试内容',
      mediaPath: '/private/test-media',
      mediaMeta: '{"status":"ok"}',
    });
  });

  test('immediately skips application messages with an empty sender', async () => {
    addGroup();
    const msg = textMessage({ from: '' });

    expect(shouldSkip(msg)).toBe(true);
    const result = await processBatch([msg]);

    expect(result).toEqual({ processed: 1, queued: 0, replied: 0, errors: 0 });
    expect(mockHandleFreeTutor).not.toHaveBeenCalled();
    expect(mockSendAppChatMessage).not.toHaveBeenCalled();
    expect(mockRecordedMessages).toEqual([
      expect.objectContaining({ msgid: 'msg-1', action: 'ignored' }),
    ]);
  });

  test('queues every non-empty human text even when it is not a question', async () => {
    addGroup();

    const result = await processBatch([textMessage({ text: { content: '好的' } })]);

    expect(result).toEqual({ processed: 1, queued: 1, replied: 0, errors: 0 });
    expect(mockSendAppChatMessage).not.toHaveBeenCalled();
    expect(mockPendingReplies.has('archive-room-1')).toBe(true);
  });

  test('downloads and queues a MiniMax-M3 image understanding result', async () => {
    addGroup();
    mockProcessMediaMessage.mockResolvedValue({
      content: '[图片题目 MiniMax-M3 高精度读取结果]\n求函数的导数',
      mediaPath: '/private/image-1.img',
      mediaMeta: '{"status":"ok","kind":"image"}',
    });

    const result = await processBatch([textMessage({
      msgid: 'image-1',
      msgtype: 'image',
      text: undefined,
      image: { sdkfileid: 'sdk-image-1', filesize: 1024 },
    })]);

    expect(result).toEqual({ processed: 1, queued: 1, replied: 0, errors: 0 });
    expect(mockProcessMediaMessage).toHaveBeenCalledTimes(1);
    expect(JSON.parse(mockPendingReplies.get('archive-room-1').messages_json)).toEqual([
      expect.objectContaining({
        msgid: 'image-1',
        msgtype: 'image',
        content: expect.stringContaining('求函数的导数'),
      }),
    ]);
    expect(mockRecordedMessages[0]).toEqual(expect.objectContaining({
      mediaPath: '/private/image-1.img',
      mediaMeta: '{"status":"ok","kind":"image"}',
    }));
  });

  test('downloads, transcribes and queues every human voice message', async () => {
    addGroup({ reply_all_text: 0 });
    mockProcessMediaMessage.mockResolvedValue({
      content: '[学生语音 火山引擎 Seed-ASR 2.0 转写结果]\n考研中山大学怎么样？',
      mediaPath: '/private/voice-1.amr',
      mediaMeta: '{"status":"ok","kind":"voice"}',
    });

    const result = await processBatch([textMessage({
      msgid: 'voice-1',
      msgtype: 'voice',
      text: undefined,
      voice: { sdkfileid: 'sdk-voice-1', voice_size: 5088, play_length: 7 },
    })]);

    expect(result).toEqual({ processed: 1, queued: 1, replied: 0, errors: 0 });
    expect(mockProcessMediaMessage).toHaveBeenCalledTimes(1);
    expect(JSON.parse(mockPendingReplies.get('archive-room-1').messages_json)).toEqual([
      expect.objectContaining({
        msgid: 'voice-1',
        msgtype: 'voice',
        content: expect.stringContaining('考研中山大学怎么样'),
      }),
    ]);
    expect(mockRecordedMessages[0]).toEqual(expect.objectContaining({
      mediaPath: '/private/voice-1.amr',
      mediaMeta: '{"status":"ok","kind":"voice"}',
    }));
  });

  test('queues a file even when smart text triggering is enabled', async () => {
    addGroup({ reply_all_text: 0 });
    mockProcessMediaMessage.mockResolvedValue({
      content: '[文件“题目.pdf”提取结果]\n请分析材料',
      mediaPath: '/private/file-1.pdf',
      mediaMeta: '{"status":"ok","kind":"file"}',
    });

    const result = await processBatch([textMessage({
      msgid: 'file-1',
      msgtype: 'file',
      text: undefined,
      file: { filename: '题目.pdf', fileext: 'pdf', sdkfileid: 'sdk-file-1' },
    })]);

    expect(result.queued).toBe(1);
    expect(mockProcessMediaMessage).toHaveBeenCalledTimes(1);
  });

  test('does not download duplicate media again', async () => {
    addGroup();
    mockRecordedMessages.push({ msgid: 'duplicate-image' });

    const result = await processBatch([textMessage({
      msgid: 'duplicate-image',
      msgtype: 'image',
      text: undefined,
      image: { sdkfileid: 'sdk-duplicate' },
    })]);

    expect(result.queued).toBe(0);
    expect(mockProcessMediaMessage).not.toHaveBeenCalled();
  });

  test('resets the five-second group delay and combines consecutive messages into one reply', async () => {
    addGroup();
    await processBatch([textMessage({ msgid: 'msg-1', text: { content: '中山大学怎么样' } })]);
    await processBatch([textMessage({ msgid: 'msg-2', seq: 2, text: { content: '计算机专业难不难' } })]);
    mockSendAppChatMessage.mockResolvedValue({ errcode: 0, errmsg: 'ok' });

    const pending = mockPendingReplies.get('archive-room-1');
    const result = await flushDueReplies(pending.due_at);

    expect(result).toEqual({ processed: 1, replied: 1, errors: 0 });
    expect(mockHandleFreeTutor).toHaveBeenCalledTimes(1);
    expect(mockHandleFreeTutor.mock.calls[0][0].message).toContain('中山大学怎么样');
    expect(mockHandleFreeTutor.mock.calls[0][0].message).toContain('计算机专业难不难');
    expect(mockSendAppChatMessage).toHaveBeenCalledTimes(1);
    expect(mockSendAppChatMessage).toHaveBeenCalledWith(expect.objectContaining({
      chatid: 'application-chat-1',
    }));
    expect(mockRecordedMessages.every((row) => row.action === 'group_reply')).toBe(true);
    expect(mockPendingReplies.size).toBe(0);
  });

  test('does not record a failed appchat send as a successful reply', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    addGroup();
    await processBatch([textMessage()]);
    mockSendAppChatMessage.mockResolvedValue({ errcode: 40056, errmsg: 'invalid chatid' });

    const pending = mockPendingReplies.get('archive-room-1');
    const result = await flushDueReplies(pending.due_at);

    expect(result).toEqual({ processed: 1, replied: 0, errors: 1 });
    expect(mockRecordedMessages).toEqual([
      expect.objectContaining({ msgid: 'msg-1', action: 'ignored' }),
    ]);
    expect(mockPendingReplies.get('archive-room-1').attempts).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('群聊合并回复失败'),
      expect.stringContaining('invalid chatid')
    );
    errorSpy.mockRestore();
  });

  test('keeps messages arriving during AI generation in a fresh batch', async () => {
    addGroup();
    let releaseReply;
    mockHandleFreeTutor.mockImplementation(() => new Promise((resolve) => {
      releaseReply = () => resolve({ reply: '第一批回复' });
    }));
    mockSendAppChatMessage.mockResolvedValue({ errcode: 0, errmsg: 'ok' });

    await processBatch([textMessage({ msgid: 'msg-old', text: { content: '第一条问题' } })]);
    const firstDueAt = mockPendingReplies.get('archive-room-1').due_at;
    const flushPromise = flushDueReplies(firstDueAt);
    await new Promise((resolve) => setImmediate(resolve));

    await processBatch([textMessage({
      msgid: 'msg-new',
      seq: 2,
      text: { content: '生成回答期间的新问题' },
    })]);
    releaseReply();
    await flushPromise;

    const nextBatch = mockPendingReplies.get('archive-room-1');
    expect(JSON.parse(nextBatch.messages_json)).toEqual([
      expect.objectContaining({ msgid: 'msg-new', content: '生成回答期间的新问题' }),
    ]);
    expect(mockRecordedMessages.find((row) => row.msgid === 'msg-old').action).toBe('group_reply');
    expect(mockRecordedMessages.find((row) => row.msgid === 'msg-new').action).toBe('ignored');
  });

  test('automatically binds a newly created app chat from its binding marker', async () => {
    const group = addGroup({ archive_roomid: '', binding_token: 'abcdef123456abcdef123456' });
    const bindingMessage = textMessage({
      msgid: 'bind-1',
      from: '',
      roomid: 'new-archive-room',
      text: { content: '[机器人绑定:abcdef123456abcdef123456]' },
    });

    await processBatch([bindingMessage]);

    expect(group.archive_roomid).toBe('new-archive-room');
    expect(mockPendingReplies.size).toBe(0);
  });

  test('uses the configured default role assigned to the group', async () => {
    addGroup();
    mockAssignments.push({
      id: 10,
      assignment_id: 10,
      group_id: 1,
      code: 'custom_advisor',
      name: '择校老师',
      type: 'advisor',
      config: { systemPrompt: '专门负责择校' },
      is_active: 1,
      is_default: 1,
    });
    mockHandleConfiguredGroupBot.mockResolvedValue('【择校老师】\n建议先看专业方向。');
    mockSendAppChatMessage.mockResolvedValue({ errcode: 0, errmsg: 'ok' });
    await processBatch([textMessage({ text: { content: '帮我看看学校' } })]);

    const pending = mockPendingReplies.get('archive-room-1');
    await flushDueReplies(pending.due_at);

    expect(mockHandleConfiguredGroupBot).toHaveBeenCalledWith(expect.objectContaining({
      bot: expect.objectContaining({ code: 'custom_advisor' }),
    }));
    expect(mockHandleFreeTutor).not.toHaveBeenCalled();
  });
});
