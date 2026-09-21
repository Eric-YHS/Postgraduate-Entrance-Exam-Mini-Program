const { db, getAgent, createUser, loginAs } = require('./helper');
const dispatcherModule = require('../src/services/wecomKfDispatcher');

function unique(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function createClient(overrides = {}) {
  return {
    syncMessages: jest.fn().mockResolvedValue({
      errcode: 0,
      next_cursor: 'next',
      has_more: 0,
      msg_list: [],
    }),
    batchGetCustomers: jest.fn().mockResolvedValue({ customer_list: [] }),
    getServiceState: jest.fn().mockResolvedValue({ service_state: 0, servicer_userid: '' }),
    transitionServiceState: jest.fn().mockResolvedValue({ errcode: 0 }),
    sendText: jest.fn().mockResolvedValue({ errcode: 0, msgid: 'sent' }),
    ...overrides,
  };
}

describe('微信客服消息调度', () => {
  test('回调 token 只用于第一页，并持久化每页返回的 sync_msg 游标', async () => {
    const openKfid = unique('wk_cursor');
    const externalUserid = unique('wm_cursor');
    const currentSeconds = Math.floor(Date.now() / 1000);
    const client = createClient({
      syncMessages: jest.fn()
        .mockResolvedValueOnce({
          errcode: 0,
          next_cursor: 'cursor_page_1',
          has_more: 1,
          msg_list: [{
            msgid: unique('cursor_msg'),
            open_kfid: openKfid,
            external_userid: externalUserid,
            send_time: currentSeconds,
            origin: 3,
            msgtype: 'text',
            text: { content: '第一页消息' },
          }],
        })
        .mockResolvedValueOnce({
          errcode: 0,
          next_cursor: 'cursor_page_2',
          has_more: 0,
          msg_list: [],
        }),
    });
    const dispatcher = dispatcherModule.createWecomKfDispatcher({
      db,
      client,
      config: { wecomKfEnabled: false, wecomKfReplyDelaySeconds: 5 },
    });

    await expect(dispatcher.syncAccount(openKfid, 'callback_token')).resolves.toMatchObject({
      pages: 2,
      messages: 1,
    });
    expect(client.syncMessages.mock.calls[0][0]).toMatchObject({
      openKfid,
      cursor: '',
      token: 'callback_token',
    });
    expect(client.syncMessages.mock.calls[1][0]).toMatchObject({
      openKfid,
      cursor: 'cursor_page_1',
      token: '',
    });
    expect(db.prepare(`
      SELECT cursor FROM wecom_kf_sync_state WHERE open_kfid = ?
    `).get(openKfid).cursor).toBe('cursor_page_2');
    db.prepare('DELETE FROM wecom_kf_accounts WHERE open_kfid = ?').run(openKfid);
  });

  test('同一客户的连续消息只生成一次合并回复，并从未处理切到智能助手', async () => {
    const openKfid = unique('wk_merge');
    const externalUserid = unique('wm_merge');
    const currentSeconds = Math.floor(Date.now() / 1000);
    const client = createClient();
    const botHandler = jest.fn().mockResolvedValue('这是合并后的回答');
    const dispatcher = dispatcherModule.createWecomKfDispatcher({
      db,
      client,
      handleConfiguredKfBot: botHandler,
      config: {
        wecomKfEnabled: false,
        wecomKfReplyDelaySeconds: 5,
        wecomKfRecoveryPollIntervalSeconds: 60,
      },
      logger: { error: jest.fn(), warn: jest.fn() },
    });

    await dispatcher.processMessage({
      msgid: unique('msg_1'),
      open_kfid: openKfid,
      external_userid: externalUserid,
      send_time: currentSeconds,
      origin: 3,
      msgtype: 'text',
      text: { content: '我想考中山大学' },
    });
    await dispatcher.processMessage({
      msgid: unique('msg_2'),
      open_kfid: openKfid,
      external_userid: externalUserid,
      send_time: currentSeconds + 1,
      origin: 3,
      msgtype: 'text',
      text: { content: '应该怎么准备？' },
    });

    const pending = db.prepare(`
      SELECT * FROM wecom_kf_pending_replies WHERE open_kfid = ? AND external_userid = ?
    `).get(openKfid, externalUserid);
    expect(JSON.parse(pending.messages_json)).toHaveLength(2);
    expect(client.sendText).toHaveBeenCalledTimes(1);
    expect(client.sendText.mock.calls[0][2]).toBe('思考中，请稍等');

    const result = await dispatcher.flushDueReplies(Number.MAX_SAFE_INTEGER);
    expect(result.replied).toBe(1);
    expect(botHandler).toHaveBeenCalledTimes(1);
    expect(botHandler.mock.calls[0][0].message).toContain('我想考中山大学');
    expect(botHandler.mock.calls[0][0].message).toContain('应该怎么准备');
    expect(botHandler.mock.calls[0][0].conversationContext).not.toContain('思考中，请稍等');
    expect(client.transitionServiceState).toHaveBeenCalledWith(openKfid, externalUserid, 1);
    expect(client.sendText).toHaveBeenCalledTimes(2);
    expect(client.sendText.mock.calls[1][2]).toBe('这是合并后的回答');
    expect(db.prepare(`
      SELECT 1 FROM wecom_kf_pending_replies WHERE open_kfid = ? AND external_userid = ?
    `).get(openKfid, externalUserid)).toBeUndefined();
  });

  test('同一批连续消息只即时提示一次，并为正式答案保留四条出站额度', async () => {
    const openKfid = unique('wk_receipt_quota');
    const externalUserid = unique('wm_receipt_quota');
    const client = createClient();
    const sleep = jest.fn().mockResolvedValue();
    const dispatcher = dispatcherModule.createWecomKfDispatcher({
      db,
      client,
      sleep,
      handleConfiguredKfBot: jest.fn().mockResolvedValue('详细回答'.repeat(6000)),
      config: {
        wecomKfEnabled: false,
        wecomKfReplyDelaySeconds: 5,
        wecomKfThinkingMessage: '思考中，请稍等',
      },
      logger: { error: jest.fn(), warn: jest.fn() },
    });
    const currentSeconds = Math.floor(Date.now() / 1000);

    await dispatcher.processMessage({
      msgid: unique('receipt_first'),
      open_kfid: openKfid,
      external_userid: externalUserid,
      send_time: currentSeconds,
      origin: 3,
      msgtype: 'text',
      text: { content: '请详细分析这个问题' },
    });
    await dispatcher.processMessage({
      msgid: unique('receipt_second'),
      open_kfid: openKfid,
      external_userid: externalUserid,
      send_time: currentSeconds + 1,
      origin: 3,
      msgtype: 'text',
      text: { content: '再补充一些背景' },
    });

    expect(client.sendText).toHaveBeenCalledTimes(1);
    expect(client.sendText.mock.calls[0][2]).toBe('思考中，请稍等');
    expect(db.prepare(`
      SELECT outbound_count FROM wecom_kf_customers
      WHERE open_kfid = ? AND external_userid = ?
    `).get(openKfid, externalUserid).outbound_count).toBe(1);

    await dispatcher.flushDueReplies(Number.MAX_SAFE_INTEGER);

    expect(client.sendText).toHaveBeenCalledTimes(5);
    const answerChunks = client.sendText.mock.calls.slice(1).map((call) => call[2]);
    expect(answerChunks).toHaveLength(4);
    expect(answerChunks.map((chunk) => chunk.split('\n')[0])).toEqual([
      '【1/4】',
      '【2/4】',
      '【3/4】',
      '【4/4】',
    ]);
    expect(answerChunks.every((chunk) => Buffer.byteLength(chunk, 'utf8') <= 2048)).toBe(true);
    expect(sleep).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenNthCalledWith(1, 1200);
    expect(sleep).toHaveBeenNthCalledWith(2, 1200);
    expect(sleep).toHaveBeenNthCalledWith(3, 1200);
    expect(db.prepare(`
      SELECT outbound_count FROM wecom_kf_customers
      WHERE open_kfid = ? AND external_userid = ?
    `).get(openKfid, externalUserid).outbound_count).toBe(5);
  });

  test('即时提示发送失败不会阻断正式答案', async () => {
    const openKfid = unique('wk_receipt_failure');
    const externalUserid = unique('wm_receipt_failure');
    const client = createClient({
      sendText: jest.fn()
        .mockRejectedValueOnce(new Error('temporary receipt failure'))
        .mockResolvedValue({ errcode: 0, msgid: 'answer_sent' }),
    });
    const botHandler = jest.fn().mockResolvedValue('正式答案仍然正常发送');
    const logger = { error: jest.fn(), warn: jest.fn() };
    const dispatcher = dispatcherModule.createWecomKfDispatcher({
      db,
      client,
      handleConfiguredKfBot: botHandler,
      config: {
        wecomKfEnabled: false,
        wecomKfReplyDelaySeconds: 5,
        wecomKfThinkingMessage: '思考中，请稍等',
      },
      logger,
    });

    await expect(dispatcher.processMessage({
      msgid: unique('receipt_failure_message'),
      open_kfid: openKfid,
      external_userid: externalUserid,
      send_time: Math.floor(Date.now() / 1000),
      origin: 3,
      msgtype: 'text',
      text: { content: '请回答我的问题' },
    })).resolves.toMatchObject({ queued: true, receiptSent: false });

    expect(logger.warn).toHaveBeenCalled();
    expect(db.prepare(`
      SELECT action FROM wecom_kf_messages
      WHERE open_kfid = ? AND external_userid = ? AND action = 'thinking_receipt_failed'
    `).get(openKfid, externalUserid)).toBeDefined();

    const result = await dispatcher.flushDueReplies(Number.MAX_SAFE_INTEGER);
    expect(result.replied).toBe(1);
    expect(client.sendText).toHaveBeenCalledTimes(2);
    expect(client.sendText.mock.calls[1][2]).toBe('正式答案仍然正常发送');
    expect(botHandler.mock.calls[0][0].conversationContext).not.toContain('思考中，请稍等');
  });

  test('关闭自动回复或人工接管时不会发送即时提示', async () => {
    const disabledOpenKfid = unique('wk_receipt_disabled');
    const disabledExternalUserid = unique('wm_receipt_disabled');
    const disabledClient = createClient();
    const disabledDispatcher = dispatcherModule.createWecomKfDispatcher({
      db,
      client: disabledClient,
      config: { wecomKfEnabled: false, wecomKfReplyDelaySeconds: 5 },
    });
    disabledDispatcher.ensureAccount(disabledOpenKfid);
    db.prepare('UPDATE wecom_kf_accounts SET reply_enabled = 0 WHERE open_kfid = ?')
      .run(disabledOpenKfid);

    await disabledDispatcher.processMessage({
      msgid: unique('disabled_message'),
      open_kfid: disabledOpenKfid,
      external_userid: disabledExternalUserid,
      send_time: Math.floor(Date.now() / 1000),
      origin: 3,
      msgtype: 'text',
      text: { content: '自动回复已关闭' },
    });
    expect(disabledClient.sendText).not.toHaveBeenCalled();

    const manualOpenKfid = unique('wk_receipt_manual');
    const manualExternalUserid = unique('wm_receipt_manual');
    const manualClient = createClient();
    const manualDispatcher = dispatcherModule.createWecomKfDispatcher({
      db,
      client: manualClient,
      config: { wecomKfEnabled: false, wecomKfReplyDelaySeconds: 5 },
    });
    manualDispatcher.ensureCustomer(manualOpenKfid, manualExternalUserid);
    db.prepare(`
      UPDATE wecom_kf_customers SET manual_takeover = 1
      WHERE open_kfid = ? AND external_userid = ?
    `).run(manualOpenKfid, manualExternalUserid);

    await manualDispatcher.processMessage({
      msgid: unique('manual_message'),
      open_kfid: manualOpenKfid,
      external_userid: manualExternalUserid,
      send_time: Math.floor(Date.now() / 1000),
      origin: 3,
      msgtype: 'text',
      text: { content: '已经由人工接待' },
    });
    expect(manualClient.sendText).not.toHaveBeenCalled();
  });

  test('图片、语音和文件都进入同一媒体理解接口', async () => {
    const openKfid = unique('wk_media');
    const externalUserid = unique('wm_media');
    const mediaProcessor = jest.fn().mockImplementation(async (message) => ({
      content: `已读取 ${message.msgtype}`,
      mediaPath: `/private/${message.msgtype}`,
      mediaMeta: JSON.stringify({ status: 'ok', kind: message.msgtype }),
    }));
    const dispatcher = dispatcherModule.createWecomKfDispatcher({
      db,
      client: createClient(),
      processKfMediaMessage: mediaProcessor,
      config: { wecomKfEnabled: false, wecomKfReplyDelaySeconds: 5 },
    });

    for (const msgtype of ['image', 'voice', 'file']) {
      await dispatcher.processMessage({
        msgid: unique(`msg_${msgtype}`),
        open_kfid: openKfid,
        external_userid: externalUserid,
        send_time: 1700000100,
        origin: 3,
        msgtype,
        [msgtype]: { media_id: `media_${msgtype}`, filename: '题目.pdf' },
      });
    }
    expect(mediaProcessor).toHaveBeenCalledTimes(3);
    const rows = db.prepare(`
      SELECT msgtype, media_path FROM wecom_kf_messages
      WHERE open_kfid = ? AND external_userid = ?
        AND origin = 3
      ORDER BY id
    `).all(openKfid, externalUserid);
    expect(rows.map((row) => row.msgtype)).toEqual(['image', 'voice', 'file']);
    expect(rows.every((row) => row.media_path.startsWith('/private/'))).toBe(true);
  });

  test('人工客服发言会立即取消待回复并锁定 AI', async () => {
    const openKfid = unique('wk_human');
    const externalUserid = unique('wm_human');
    const dispatcher = dispatcherModule.createWecomKfDispatcher({
      db,
      client: createClient(),
      config: { wecomKfEnabled: false, wecomKfReplyDelaySeconds: 5 },
    });
    await dispatcher.processMessage({
      msgid: unique('student'),
      open_kfid: openKfid,
      external_userid: externalUserid,
      send_time: 1700000200,
      origin: 3,
      msgtype: 'text',
      text: { content: '请问报考条件？' },
    });
    await dispatcher.processMessage({
      msgid: unique('human'),
      open_kfid: openKfid,
      external_userid: externalUserid,
      servicer_userid: 'teacher_1',
      send_time: 1700000201,
      origin: 5,
      msgtype: 'text',
      text: { content: '老师来回复你。' },
    });

    const customer = db.prepare(`
      SELECT * FROM wecom_kf_customers WHERE open_kfid = ? AND external_userid = ?
    `).get(openKfid, externalUserid);
    expect(customer.manual_takeover).toBe(1);
    expect(customer.service_state).toBe(3);
    expect(db.prepare(`
      SELECT 1 FROM wecom_kf_pending_replies WHERE open_kfid = ? AND external_userid = ?
    `).get(openKfid, externalUserid)).toBeUndefined();
  });

  test('会话被人工接入或结束的事件同样取消 AI 待回复', async () => {
    const openKfid = unique('wk_event');
    const externalUserid = unique('wm_event');
    const dispatcher = dispatcherModule.createWecomKfDispatcher({
      db,
      client: createClient(),
      config: { wecomKfEnabled: false, wecomKfReplyDelaySeconds: 5 },
    });
    await dispatcher.processMessage({
      msgid: unique('event_student'),
      open_kfid: openKfid,
      external_userid: externalUserid,
      send_time: Math.floor(Date.now() / 1000),
      origin: 3,
      msgtype: 'text',
      text: { content: '请老师看看' },
    });
    await dispatcher.processMessage({
      msgid: unique('status_event'),
      send_time: Math.floor(Date.now() / 1000),
      origin: 4,
      msgtype: 'event',
      event: {
        event_type: 'session_status_change',
        open_kfid: openKfid,
        external_userid: externalUserid,
        change_type: 1,
        new_servicer_userid: 'teacher_2',
      },
    });

    const customer = db.prepare(`
      SELECT manual_takeover, service_state, servicer_userid
      FROM wecom_kf_customers WHERE open_kfid = ? AND external_userid = ?
    `).get(openKfid, externalUserid);
    expect(customer).toEqual(expect.objectContaining({
      manual_takeover: 1,
      service_state: 3,
      servicer_userid: 'teacher_2',
    }));
    expect(db.prepare(`
      SELECT 1 FROM wecom_kf_pending_replies WHERE open_kfid = ? AND external_userid = ?
    `).get(openKfid, externalUserid)).toBeUndefined();
  });

  test('重复 msgid 不会重复入库或排队', async () => {
    const openKfid = unique('wk_dup');
    const externalUserid = unique('wm_dup');
    const msgid = unique('same_msg');
    const client = createClient();
    const dispatcher = dispatcherModule.createWecomKfDispatcher({
      db,
      client,
      config: { wecomKfEnabled: false, wecomKfReplyDelaySeconds: 5 },
    });
    const message = {
      msgid,
      open_kfid: openKfid,
      external_userid: externalUserid,
      send_time: 1700000300,
      origin: 3,
      msgtype: 'text',
      text: { content: '同一条消息' },
    };

    await dispatcher.processMessage(message);
    await expect(dispatcher.processMessage(message)).resolves.toMatchObject({ duplicate: true });
    expect(db.prepare('SELECT COUNT(*) AS count FROM wecom_kf_messages WHERE msgid = ?').get(msgid).count).toBe(1);
    const pending = db.prepare(`
      SELECT messages_json FROM wecom_kf_pending_replies WHERE open_kfid = ? AND external_userid = ?
    `).get(openKfid, externalUserid);
    expect(JSON.parse(pending.messages_json)).toHaveLength(1);
    expect(client.sendText).toHaveBeenCalledTimes(1);
  });
});

describe('微信客服管理 API', () => {
  function insertAccount(openKfid) {
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO wecom_kf_accounts
        (open_kfid, name, reply_enabled, reply_delay_seconds, created_at, updated_at)
      VALUES (?, '普通微信咨询', 1, 5, ?, ?)
    `).run(openKfid, now, now);
  }

  test('管理员可设置客服账号的延时和默认角色', async () => {
    const openKfid = unique('wk_admin');
    insertAccount(openKfid);
    const bot = db.prepare(`
      INSERT INTO bots (code, name, type, config, is_active, created_at)
      VALUES (?, '微信择校老师', 'advisor', '{}', 1, ?)
    `).run(unique('kf_bot'), new Date().toISOString());
    const admin = createUser({
      username: unique('kf_admin'),
      password: 'admin123',
      role: 'admin',
      displayName: '微信客服管理员',
    });
    const agent = getAgent();
    await loginAs(agent, admin.username, 'admin123');

    const response = await agent
      .put(`/api/admin/wecom/kf/accounts/${encodeURIComponent(openKfid)}`)
      .send({
        replyEnabled: true,
        replyDelaySeconds: 8,
        botIds: [Number(bot.lastInsertRowid)],
        defaultBotId: Number(bot.lastInsertRowid),
      })
      .expect(200);
    expect(response.body.account).toMatchObject({
      openKfid,
      replyDelaySeconds: 8,
      replyEnabled: true,
      bots: [expect.objectContaining({ name: '微信择校老师', isDefault: true })],
    });
  });

  test('状态接口不会向浏览器返回 Secret、Token 或 AESKey', async () => {
    const admin = createUser({
      username: unique('kf_status_admin'),
      password: 'admin123',
      role: 'admin',
      displayName: '状态管理员',
    });
    const agent = getAgent();
    await loginAs(agent, admin.username, 'admin123');

    const response = await agent.get('/api/admin/wecom/kf/status').expect(200);
    expect(response.body.callbackUrl).toContain('/api/wecom/kf/callback');
    expect(response.body).not.toHaveProperty('token');
    expect(response.body).not.toHaveProperty('secret');
    expect(response.body).not.toHaveProperty('encodingAesKey');
  });

  test('普通学生不能读取微信客服账号', async () => {
    const user = createUser({
      username: unique('kf_student'),
      password: '123456',
      role: 'student',
      displayName: '普通学生',
    });
    const agent = getAgent();
    await loginAs(agent, user.username);
    await agent.get('/api/admin/wecom/kf/accounts').expect(403);
  });
});
