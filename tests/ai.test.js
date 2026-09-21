const {
  buildChatRequestBody,
  stripThinkingContent,
} = require('../src/services/ai');

describe('shared AI MiniMax-M3 request settings', () => {
  test('enables Adaptive Thinking, priority, and a large completion budget for M3', () => {
    const multimodalContent = [
      { type: 'text', text: '读图' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==', detail: 'high' } },
    ];
    const body = buildChatRequestBody(
      [{ role: 'user', content: multimodalContent }],
      { maxTokens: 800 },
      {
        provider: 'minimax',
        apiUrl: 'https://api.minimaxi.com/v1/chat/completions',
        model: 'MiniMax-M3',
      }
    );

    expect(body.model).toBe('MiniMax-M3');
    expect(body.messages[0].content).toBe(multimodalContent);
    expect(body.max_completion_tokens).toBeGreaterThanOrEqual(8192);
    expect(body.max_tokens).toBeUndefined();
    expect(body.thinking).toEqual({ type: 'adaptive' });
    expect(body.reasoning_split).toBe(true);
    expect(body.service_tier).toBe('priority');
  });

  test('keeps the legacy max_tokens format for non-MiniMax providers', () => {
    const body = buildChatRequestBody(
      [{ role: 'user', content: '你好' }],
      { maxTokens: 600 },
      { provider: 'default', apiUrl: 'https://api.deepseek.com/v1/chat/completions', model: 'deepseek-chat' }
    );

    expect(body.max_tokens).toBe(600);
    expect(body.max_completion_tokens).toBeUndefined();
    expect(body.thinking).toBeUndefined();
  });

  test('uses DeepSeek-V4-Pro with thinking enabled and maximum reasoning effort', () => {
    const tools = [{
      type: 'function',
      function: {
        name: 'web_search',
        description: 'search',
        parameters: { type: 'object', properties: {} },
      },
    }];
    const reasoningDetails = [{
      type: 'reasoning.text',
      text: 'private MiniMax reasoning',
    }];
    const body = buildChatRequestBody(
      [
        {
          role: 'assistant',
          content: '',
          reasoning_details: reasoningDetails,
          tool_calls: [{
            id: 'call_1',
            type: 'function',
            function: { name: 'web_search', arguments: '{"query":"test"}' },
          }],
        },
        { role: 'tool', tool_call_id: 'call_1', content: '{"results":[]}' },
      ],
      {
        maxCompletionTokens: 131072,
        tools,
        thinking: { type: 'enabled' },
        reasoningEffort: 'max',
      },
      {
        provider: 'deepseek',
        apiUrl: 'https://api.deepseek.com/chat/completions',
        model: 'deepseek-v4-pro',
      }
    );

    expect(body.model).toBe('deepseek-v4-pro');
    expect(body.max_tokens).toBeGreaterThanOrEqual(131072);
    expect(body.thinking).toEqual({ type: 'enabled' });
    expect(body.reasoning_effort).toBe('max');
    expect(body.temperature).toBeUndefined();
    expect(body.tools).toBe(tools);
    expect(body.messages[0].reasoning_details).toBe(reasoningDetails);
    expect(body.messages[0].tool_calls).toHaveLength(1);
    expect(body.messages[1].tool_call_id).toBe('call_1');
  });

  test('removes provider thinking tags before a reply reaches the user', () => {
    expect(stripThinkingContent('<think>internal reasoning</think>最终答案')).toBe('最终答案');
  });
});
