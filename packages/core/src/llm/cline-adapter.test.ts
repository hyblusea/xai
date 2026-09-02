import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ClineAdapter, type ClineAdapterOptions } from './cline-adapter.js';
import type { Message, LLMConfig } from '@xai/shared';

function makeLLMConfig(overrides?: Partial<LLMConfig>): LLMConfig {
  return {
    provider: 'cline',
    model: 'anthropic/claude-sonnet-4.5',
    temperature: 0.7,
    stream: true,
    baseUrl: 'https://api.cline.bot/api/v1/chat/completions',
    ...overrides,
  };
}

function makeMessages(): Message[] {
  return [
    { role: 'system', content: 'You are a helpful assistant.', timestamp: 1 },
    { role: 'user', content: 'Hello', timestamp: 2 },
  ];
}

async function collectStream(adapter: ClineAdapter, chunks: string[]): Promise<{
  texts: string[];
  thinkings: string[];
  toolCalls: Array<{ name: string; parameters: Record<string, unknown> }>;
  errors: string[];
  done: boolean;
}> {
  const texts: string[] = [];
  const thinkings: string[] = [];
  const toolCalls: Array<{ name: string; parameters: Record<string, unknown> }> = [];
  const errors: string[] = [];
  let done = false;

  async function* mockStream() {
    for (const chunk of chunks) {
      yield Buffer.from(chunk);
    }
  }

  for await (const event of adapter.translateStream(mockStream())) {
    if (event.type === 'text') texts.push(event.content);
    if (event.type === 'thinking') thinkings.push(event.content);
    if (event.type === 'tool_call' && event.toolCall) toolCalls.push(event.toolCall);
    if (event.type === 'error') errors.push(event.content);
    if (event.type === 'done') done = true;
  }

  return { texts, thinkings, toolCalls, errors, done };
}

// ── Constructor & Session ─────────────────────────────────────────────────

describe('ClineAdapter — constructor & session management', () => {
  it('should create with default options', () => {
    const adapter = new ClineAdapter();
    expect(adapter).toBeDefined();
    expect(adapter.supportsNativeTools).toBe(true);
    expect(adapter.supportsCompression).toBe(true);
  });

  it('should create with custom options', () => {
    const getToken = vi.fn().mockResolvedValue('test-token');
    const adapter = new ClineAdapter({ getToken });
    expect(adapter.supportsNativeTools).toBe(true);
  });

  it('should initialize with empty conversation history', () => {
    const adapter = new ClineAdapter();
    expect(adapter.getConversationHistory()).toEqual([]);
  });

  it('should clear history on resetSession', () => {
    const adapter = new ClineAdapter();
    // Manually add something to history by calling translateInput
    adapter.resetSession();
    expect(adapter.getConversationHistory()).toEqual([]);
  });

  it('should snapshot and restore session', () => {
    const adapter = new ClineAdapter();
    const snapshot = adapter.snapshotSession();
    expect(snapshot.history).toEqual([]);
    expect(snapshot.pendingToolCallIds).toEqual([]);

    // After restore, should still be empty
    adapter.restoreSession(snapshot);
    expect(adapter.getConversationHistory()).toEqual([]);
  });

  it('should generate different instances with independent state', () => {
    const a = new ClineAdapter();
    const b = new ClineAdapter();
    expect(a.getConversationHistory()).toEqual(b.getConversationHistory());
    a.resetSession(); // should not affect b
    expect(b.getConversationHistory()).toEqual([]);
  });
});

// ── translateInput ────────────────────────────────────────────────────────

describe('ClineAdapter — translateInput', () => {
  it('should produce correct OpenAI-format request', async () => {
    const adapter = new ClineAdapter();
    const config = makeLLMConfig();
    const messages = makeMessages();

    const request = await adapter.translateInput(messages, config);

    expect(request.method).toBe('POST');
    expect(request.url).toBe('https://api.cline.bot/api/v1/chat/completions');
    expect(request.headers['Content-Type']).toBe('application/json');

    const body = JSON.parse(request.body);
    expect(body.model).toBe('anthropic/claude-sonnet-4.5');
    expect(body.stream).toBe(true);
    expect(body.temperature).toBe(0.7);
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0].role).toBe('system');
    expect(body.messages[1].role).toBe('user');
  });

  it('should set Authorization header from getToken callback (with workos: prefix)', async () => {
    const getToken = vi.fn().mockResolvedValue('workos:my-token-123');
    const adapter = new ClineAdapter({ getToken });
    const config = makeLLMConfig();
    const messages = makeMessages();

    const request = await adapter.translateInput(messages, config);

    expect(request.headers['Authorization']).toBe('Bearer workos:my-token-123');
    expect(getToken).toHaveBeenCalled();
  });

  it('should add workos: prefix to raw token from getToken', async () => {
    const getToken = vi.fn().mockResolvedValue('raw-token-no-prefix');
    const adapter = new ClineAdapter({ getToken });
    const config = makeLLMConfig();
    const messages = makeMessages();

    const request = await adapter.translateInput(messages, config);

    expect(request.headers['Authorization']).toBe('Bearer workos:raw-token-no-prefix');
  });

  it('should fallback to config.apiKey when getToken returns null (with workos: prefix)', async () => {
    const getToken = vi.fn().mockResolvedValue(null);
    const adapter = new ClineAdapter({ getToken });
    const config = makeLLMConfig({ apiKey: 'fallback-key' });
    const messages = makeMessages();

    const request = await adapter.translateInput(messages, config);

    expect(request.headers['Authorization']).toBe('Bearer workos:fallback-key');
  });

  it('should use config.apiKey directly when no getToken (with workos: prefix)', async () => {
    const adapter = new ClineAdapter();
    const config = makeLLMConfig({ apiKey: 'direct-key' });
    const messages = makeMessages();

    const request = await adapter.translateInput(messages, config);

    expect(request.headers['Authorization']).toBe('Bearer workos:direct-key');
  });

  it('should not double-add workos: prefix if already present', async () => {
    const adapter = new ClineAdapter();
    const config = makeLLMConfig({ apiKey: 'workos:already-prefixed' });
    const messages = makeMessages();

    const request = await adapter.translateInput(messages, config);

    expect(request.headers['Authorization']).toBe('Bearer workos:already-prefixed');
  });

  it('should include tools in request when provided', async () => {
    const adapter = new ClineAdapter();
    const tools = [
      {
        type: 'function',
        function: {
          name: 'read_file',
          description: 'Read a file',
          parameters: { type: 'object', properties: { path: { type: 'string' } } },
        },
      },
    ];
    const config = makeLLMConfig({
      options: { tools },
    });
    const messages = makeMessages();

    const request = await adapter.translateInput(messages, config);
    const body = JSON.parse(request.body);

    expect(body.tools).toEqual(tools);
    expect(body.tool_choice).toBe('auto');
  });

  it('should include reasoning effort in OpenRouter format when configured', async () => {
    const adapter = new ClineAdapter();
    const config = makeLLMConfig({
      options: { reasoningEffort: 'high' },
    });
    const messages = makeMessages();

    const request = await adapter.translateInput(messages, config);
    const body = JSON.parse(request.body);

    // Cline API is an OpenRouter proxy — uses `reasoning: { effort: "high" }` format
    expect(body.reasoning).toEqual({ effort: 'high' });
    expect(body.reasoning_effort).toBeUndefined();
  });

  it('should send reasoning.effort=none when reasoningEffort is off', async () => {
    const adapter = new ClineAdapter();
    const config = makeLLMConfig({
      options: { reasoningEffort: 'off' },
    });
    const messages = makeMessages();

    const request = await adapter.translateInput(messages, config);
    const body = JSON.parse(request.body);

    expect(body.reasoning).toEqual({ effort: 'none' });
  });

  it('should use custom baseUrl when provided', async () => {
    const adapter = new ClineAdapter();
    const config = makeLLMConfig({ baseUrl: 'https://custom.cline.bot/api/v1/chat/completions' });
    const messages = makeMessages();

    const request = await adapter.translateInput(messages, config);

    expect(request.url).toBe('https://custom.cline.bot/api/v1/chat/completions');
  });

  it('should respect maxTokens when set', async () => {
    const adapter = new ClineAdapter();
    const config = makeLLMConfig({ maxTokens: 4096 });
    const messages = makeMessages();

    const request = await adapter.translateInput(messages, config);
    const body = JSON.parse(request.body);

    expect(body.max_tokens).toBe(4096);
  });

  it('should omit maxTokens when not set', async () => {
    const adapter = new ClineAdapter();
    const config = makeLLMConfig();
    const messages = makeMessages();

    const request = await adapter.translateInput(messages, config);
    const body = JSON.parse(request.body);

    expect(body.max_tokens).toBeUndefined();
  });

  it('should not send Authorization when no token and no apiKey', async () => {
    const adapter = new ClineAdapter();
    const config = makeLLMConfig();
    const messages = makeMessages();

    const request = await adapter.translateInput(messages, config);

    expect(request.headers['Authorization']).toBeUndefined();
  });

  it('should merge customHeaders', async () => {
    const adapter = new ClineAdapter();
    const config = makeLLMConfig({ customHeaders: { 'X-Custom': 'value' } });
    const messages = makeMessages();

    const request = await adapter.translateInput(messages, config);

    expect(request.headers['X-Custom']).toBe('value');
    expect(request.headers['Content-Type']).toBe('application/json');
  });
});

// ── translateStream — text streaming ──────────────────────────────────────

describe('ClineAdapter — translateStream (text)', () => {
  it('should emit text chunks from SSE data', async () => {
    const adapter = new ClineAdapter();
    const sseChunks = [
      'data: {"id":"c1","choices":[{"index":0,"delta":{"role":"assistant","content":"Hello"},"finish_reason":null}]}\n\n',
      'data: {"id":"c1","choices":[{"index":0,"delta":{"content":" world"},"finish_reason":null}]}\n\n',
      'data: {"id":"c1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ];

    const result = await collectStream(adapter, sseChunks);

    expect(result.texts).toEqual(['Hello', ' world']);
    expect(result.done).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('should handle stream ending without [DONE]', async () => {
    const adapter = new ClineAdapter();
    const sseChunks = [
      'data: {"id":"c1","choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}]}\n\n',
    ];

    const result = await collectStream(adapter, sseChunks);

    expect(result.texts).toEqual(['partial']);
    expect(result.done).toBe(true);
  });

  it('should skip malformed JSON lines', async () => {
    const adapter = new ClineAdapter();
    const sseChunks = [
      'data: {invalid json}\n\n',
      'data: {"id":"c1","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}\n\n',
      'data: [DONE]\n\n',
    ];

    const result = await collectStream(adapter, sseChunks);

    expect(result.texts).toEqual(['ok']);
    expect(result.done).toBe(true);
  });

  it('should ignore non-data SSE lines', async () => {
    const adapter = new ClineAdapter();
    const sseChunks = [
      ': comment line\n\n',
      'event: message\n\n',
      'data: {"id":"c1","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}\n\n',
      'data: [DONE]\n\n',
    ];

    const result = await collectStream(adapter, sseChunks);

    expect(result.texts).toEqual(['hi']);
  });
});

// ── translateStream — thinking/reasoning ──────────────────────────────────

describe('ClineAdapter — translateStream (thinking)', () => {
  it('should stream each reasoning_content delta immediately as a thinking chunk', async () => {
    // Matches the OpenAI adapter: each delta.reasoning_content is yielded at once
    // (not buffered). Buffering starved the consumer during long high-effort
    // reasoning phases — the Designer handler's for-await blocked with no output.
    const adapter = new ClineAdapter();
    const sseChunks = [
      'data: {"id":"c1","choices":[{"index":0,"delta":{"reasoning_content":"Let me think"},"finish_reason":null}]}\n\n',
      'data: {"id":"c1","choices":[{"index":0,"delta":{"reasoning_content":" about this"},"finish_reason":null}]}\n\n',
      'data: {"id":"c1","choices":[{"index":0,"delta":{"content":"The answer is 42"},"finish_reason":null}]}\n\n',
      'data: {"id":"c1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ];

    const result = await collectStream(adapter, sseChunks);

    // Each reasoning delta is its own thinking chunk (NOT concatenated/buffered).
    expect(result.thinkings).toEqual(['Let me think', ' about this']);
    expect(result.texts).toEqual(['The answer is 42']);
  });

  it('should emit thinking on receipt of the delta (not deferred until [DONE])', async () => {
    const adapter = new ClineAdapter();
    const sseChunks = [
      'data: {"id":"c1","choices":[{"index":0,"delta":{"reasoning_content":"still thinking"},"finish_reason":null}]}\n\n',
      'data: [DONE]\n\n',
    ];

    const result = await collectStream(adapter, sseChunks);

    // The thinking chunk is emitted when the delta arrives, not buffered until [DONE].
    expect(result.thinkings).toEqual(['still thinking']);
    expect(result.texts).toEqual([]);
  });
});

// ── translateStream — tool calls ──────────────────────────────────────────

describe('ClineAdapter — translateStream (tool calls)', () => {
  it('should accumulate and emit tool calls', async () => {
    const adapter = new ClineAdapter();
    const sseChunks = [
      'data: {"id":"c1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"tc_1","type":"function","function":{"name":"read_file","arguments":""}}]},"finish_reason":null}]}\n\n',
      'data: {"id":"c1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"pa"}}]},"finish_reason":null}]}\n\n',
      'data: {"id":"c1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"th\\":\\"file.ts\\"}"}}]},"finish_reason":null}]}\n\n',
      'data: {"id":"c1","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      'data: [DONE]\n\n',
    ];

    const result = await collectStream(adapter, sseChunks);

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe('read_file');
    expect(result.toolCalls[0].parameters).toEqual({ path: 'file.ts' });
    expect(result.done).toBe(true);
  });

  it('should handle multiple tool calls in one response', async () => {
    const adapter = new ClineAdapter();
    const sseChunks = [
      'data: {"id":"c1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"tc_1","type":"function","function":{"name":"read_file","arguments":"{\\"path\\":\\"a.ts\\"}"}},{"index":1,"id":"tc_2","type":"function","function":{"name":"list_files","arguments":"{\\"path\\":\\".\\"}"}}]},"finish_reason":null}]}\n\n',
      'data: {"id":"c1","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      'data: [DONE]\n\n',
    ];

    const result = await collectStream(adapter, sseChunks);

    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls[0].name).toBe('read_file');
    expect(result.toolCalls[1].name).toBe('list_files');
  });

  it('should handle tool call with empty arguments', async () => {
    const adapter = new ClineAdapter();
    const sseChunks = [
      'data: {"id":"c1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"tc_1","type":"function","function":{"name":"noop","arguments":""}}]},"finish_reason":null}]}\n\n',
      'data: {"id":"c1","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      'data: [DONE]\n\n',
    ];

    const result = await collectStream(adapter, sseChunks);

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe('noop');
    expect(result.toolCalls[0].parameters).toEqual({});
  });
});

// ── translateStream — error handling ──────────────────────────────────────

describe('ClineAdapter — translateStream (error handling)', () => {
  it('should handle abort gracefully', async () => {
    const adapter = new ClineAdapter();
    adapter.abort();

    const result = await collectStream(adapter, []);

    expect(result.done).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('should handle empty stream', async () => {
    const adapter = new ClineAdapter();

    const result = await collectStream(adapter, []);

    expect(result.done).toBe(true);
    expect(result.texts).toEqual([]);
  });
});

// ── translateOutput ───────────────────────────────────────────────────────

describe('ClineAdapter — translateOutput', () => {
  it('should translate a simple text response', () => {
    const adapter = new ClineAdapter();
    const response = {
      id: 'c1',
      model: 'anthropic/claude-sonnet-4.5',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: 'Hello there!' },
        finish_reason: 'stop',
      }],
    };

    const result = adapter.translateOutput(response);

    expect(result.role).toBe('assistant');
    expect(result.content).toBe('Hello there!');
    expect(result.toolName).toBeUndefined();
  });

  it('should translate a tool_calls response', () => {
    const adapter = new ClineAdapter();
    const response = {
      id: 'c1',
      model: 'anthropic/claude-sonnet-4.5',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'tc_1',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"test.ts"}' },
          }],
        },
        finish_reason: 'tool_calls',
      }],
    };

    const result = adapter.translateOutput(response);

    expect(result.role).toBe('assistant');
    expect(result.toolName).toBe('read_file');
    expect(result.toolResult?.toolName).toBe('read_file');
    expect(result.toolResult?.success).toBe(true);
  });

  it('should handle empty choices', () => {
    const adapter = new ClineAdapter();
    const response = { id: 'c1', choices: [], model: 'test' };

    const result = adapter.translateOutput(response);

    expect(result.role).toBe('assistant');
    expect(result.content).toBe('');
  });
});

// ── Session history management ────────────────────────────────────────────

describe('ClineAdapter — history tracking', () => {
  it('should track messages in conversation history after translateInput', async () => {
    const adapter = new ClineAdapter();
    const config = makeLLMConfig();
    const messages = makeMessages();

    await adapter.translateInput(messages, config);
    const history = adapter.getConversationHistory();

    // System message + user message
    expect(history.length).toBeGreaterThanOrEqual(2);
    expect(history.some(m => m.role === 'system')).toBe(true);
    expect(history.some(m => m.role === 'user')).toBe(true);
  });

  it('should not duplicate system message on second call', async () => {
    const adapter = new ClineAdapter();
    const config = makeLLMConfig();

    await adapter.translateInput(makeMessages(), config);
    const count1 = adapter.getConversationHistory().filter(m => m.role === 'system').length;

    // Second call with same system message
    await adapter.translateInput([
      { role: 'user', content: 'Follow up', timestamp: 3 },
    ], config);
    const count2 = adapter.getConversationHistory().filter(m => m.role === 'system').length;

    expect(count2).toBe(count1);
  });

  it('should clear history on resetSession', async () => {
    const adapter = new ClineAdapter();
    const config = makeLLMConfig();

    await adapter.translateInput(makeMessages(), config);
    expect(adapter.getConversationHistory().length).toBeGreaterThan(0);

    adapter.resetSession();
    expect(adapter.getConversationHistory()).toEqual([]);
  });

  it('should preserve history across snapshot/restore', async () => {
    const adapter = new ClineAdapter();
    const config = makeLLMConfig();

    await adapter.translateInput(makeMessages(), config);
    const snapshot = adapter.snapshotSession();
    const historyBefore = adapter.getConversationHistory().length;

    adapter.resetSession();
    expect(adapter.getConversationHistory().length).toBe(0);

    adapter.restoreSession(snapshot);
    expect(adapter.getConversationHistory().length).toBe(historyBefore);
  });
});

// ── Context compression ──────────────────────────────────────────────────

describe('ClineAdapter — getContextUsage', () => {
  it('should return context usage metrics', async () => {
    const adapter = new ClineAdapter();
    const config = makeLLMConfig();

    await adapter.translateInput(makeMessages(), config);
    const usage = adapter.getContextUsage(config);

    expect(usage.totalTokens).toBeGreaterThan(0);
    expect(usage.contextWindow).toBeGreaterThan(0);
    expect(usage.usagePercent).toBeGreaterThanOrEqual(0);
    expect(usage.usagePercent).toBeLessThanOrEqual(100);
    expect(usage.messageCount).toBeGreaterThan(0);
  });

  it('should use correct context window for different models', () => {
    const adapter = new ClineAdapter();

    // Claude Sonnet 4.5+ has 1M context on OpenRouter
    const claudeSonnet45Usage = adapter.getContextUsage(makeLLMConfig({ model: 'anthropic/claude-sonnet-4.5' }));
    expect(claudeSonnet45Usage.contextWindow).toBe(1_000_000);

    // Older Claude models have 200K context
    const claude35Usage = adapter.getContextUsage(makeLLMConfig({ model: 'anthropic/claude-3.5-sonnet' }));
    expect(claude35Usage.contextWindow).toBe(200_000);

    const geminiUsage = adapter.getContextUsage(makeLLMConfig({ model: 'google/gemini-3.1-pro-preview' }));
    expect(geminiUsage.contextWindow).toBe(1_000_000);

    const gptUsage = adapter.getContextUsage(makeLLMConfig({ model: 'openai/gpt-4o' }));
    expect(gptUsage.contextWindow).toBe(128_000);

    const customUsage = adapter.getContextUsage(makeLLMConfig({ model: 'unknown-model', contextWindow: 64000 }));
    expect(customUsage.contextWindow).toBe(64000);
  });

  it('should return zero usage for empty history', () => {
    const adapter = new ClineAdapter();
    const usage = adapter.getContextUsage(makeLLMConfig());

    expect(usage.totalTokens).toBe(0);
    expect(usage.messageCount).toBe(0);
  });
});

// ── ClineAdapterOptions.getToken ─────────────────────────────────────────

describe('ClineAdapter — getToken lazy resolution', () => {
  it('should call getToken on each translateInput and add workos: prefix', async () => {
    let callCount = 0;
    const getToken = vi.fn().mockImplementation(async () => {
      callCount++;
      return `token-${callCount}`;
    });
    const adapter = new ClineAdapter({ getToken });
    const config = makeLLMConfig();

    const req1 = await adapter.translateInput(makeMessages(), config);
    const req2 = await adapter.translateInput([
      { role: 'user', content: 'second', timestamp: 3 },
    ], config);

    expect(getToken).toHaveBeenCalledTimes(2);
    expect(req1.headers['Authorization']).toBe('Bearer workos:token-1');
    expect(req2.headers['Authorization']).toBe('Bearer workos:token-2');
  });

  it('should handle getToken throwing error gracefully', async () => {
    const getToken = vi.fn().mockRejectedValue(new Error('Network error'));
    const adapter = new ClineAdapter({ getToken });
    const config = makeLLMConfig({ apiKey: 'fallback' });
    const messages = makeMessages();

    const request = await adapter.translateInput(messages, config);

    // Should fallback to apiKey (with workos: prefix added)
    expect(request.headers['Authorization']).toBe('Bearer workos:fallback');
  });

  it('should have no auth header when getToken returns null and no apiKey', async () => {
    const getToken = vi.fn().mockResolvedValue(null);
    const adapter = new ClineAdapter({ getToken });
    const config = makeLLMConfig();
    const messages = makeMessages();

    const request = await adapter.translateInput(messages, config);

    expect(request.headers['Authorization']).toBeUndefined();
  });
});

// ── Abort ─────────────────────────────────────────────────────────────────

describe('ClineAdapter — abort', () => {
  it('should be callable without error', () => {
    const adapter = new ClineAdapter();
    expect(() => adapter.abort()).not.toThrow();
  });

  it('should be callable multiple times', () => {
    const adapter = new ClineAdapter();
    adapter.abort();
    adapter.abort();
    expect(true).toBe(true); // no crash
  });
});

// ── Reasoning persistence & replay ────────────────────────────────────────

describe('ClineAdapter — reasoning persistence (native reasoning_content field)', () => {
  it('should store reasoning in reasoning_content field, NOT in content with tags', async () => {
    const adapter = new ClineAdapter();
    const sseChunks = [
      'data: {"id":"c1","choices":[{"index":0,"delta":{"reasoning_content":"I need to think"},"finish_reason":null}]}\n\n',
      'data: {"id":"c1","choices":[{"index":0,"delta":{"content":"The answer"},"finish_reason":null}]}\n\n',
      'data: {"id":"c1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ];

    await collectStream(adapter, sseChunks);

    const history = adapter.getConversationHistory();
    const assistantMsg = history.find(m => m.role === 'assistant');
    expect(assistantMsg).toBeDefined();

    // Reasoning goes into the native field
    expect(assistantMsg!.reasoning_content).toBe('I need to think');
    // Content is clean — no pseudo-XML tags
    expect(assistantMsg!.content).toBe('The answer');
    expect(assistantMsg!.content).not.toContain('I need to think');
  });

  it('should parse delta.reasoning (OpenRouter format) as thinking chunks', async () => {
    // OpenRouter returns reasoning in `delta.reasoning` instead of `delta.reasoning_content`
    const adapter = new ClineAdapter();
    const sseChunks = [
      'data: {"id":"c1","choices":[{"index":0,"delta":{"reasoning":"OpenRouter reasoning"},"finish_reason":null}]}\n\n',
      'data: {"id":"c1","choices":[{"index":0,"delta":{"content":"result"},"finish_reason":null}]}\n\n',
      'data: {"id":"c1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ];

    const result = await collectStream(adapter, sseChunks);

    expect(result.thinkings).toEqual(['OpenRouter reasoning']);
    expect(result.texts).toEqual(['result']);

    // Also persisted correctly
    const assistantMsg = adapter.getConversationHistory().find(m => m.role === 'assistant');
    expect(assistantMsg!.reasoning_content).toBe('OpenRouter reasoning');
  });

  it('should prefer reasoning_content over reasoning when both present', async () => {
    const adapter = new ClineAdapter();
    const sseChunks = [
      'data: {"id":"c1","choices":[{"index":0,"delta":{"reasoning_content":"from_rc","reasoning":"from_r"},"finish_reason":null}]}\n\n',
      'data: {"id":"c1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ];

    const result = await collectStream(adapter, sseChunks);
    // reasoning_content takes priority (?? operator: first non-null wins)
    expect(result.thinkings).toEqual(['from_rc']);
  });

  it('should replay reasoning_content in translateInput', async () => {
    const adapter = new ClineAdapter();
    // Simulate a prior turn with reasoning
    const sseChunks = [
      'data: {"id":"c1","choices":[{"index":0,"delta":{"reasoning_content":"my reasoning"},"finish_reason":null}]}\n\n',
      'data: {"id":"c1","choices":[{"index":0,"delta":{"content":"my answer"},"finish_reason":null}]}\n\n',
      'data: {"id":"c1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ];
    await collectStream(adapter, sseChunks);

    // Now make a second request — reasoning_content should be in the wire messages
    const config = makeLLMConfig();
    const request = await adapter.translateInput([
      { role: 'user', content: 'follow up', timestamp: 4 },
    ], config);
    const body = JSON.parse(request.body);

    const assistantInWire = body.messages.find((m: any) => m.role === 'assistant');
    expect(assistantInWire).toBeDefined();
    expect(assistantInWire.reasoning_content).toBe('my reasoning');
    // Content should be clean
    expect(assistantInWire.content).toBe('my answer');
  });

  it('should not set reasoning_content when no reasoning was produced', async () => {
    const adapter = new ClineAdapter();
    const sseChunks = [
      'data: {"id":"c1","choices":[{"index":0,"delta":{"content":"just text"},"finish_reason":null}]}\n\n',
      'data: {"id":"c1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ];

    await collectStream(adapter, sseChunks);

    const assistantMsg = adapter.getConversationHistory().find(m => m.role === 'assistant');
    expect(assistantMsg!.reasoning_content).toBeUndefined();
    expect(assistantMsg!.content).toBe('just text');
  });

  it('should extract reasoning from translateOutput (non-streaming)', () => {
    const adapter = new ClineAdapter();
    const response = {
      id: 'c1',
      model: 'test',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: 'final answer',
          reasoning_content: 'my reasoning',
        },
        finish_reason: 'stop',
      }],
    };

    adapter.translateOutput(response);

    const assistantMsg = adapter.getConversationHistory().find(m => m.role === 'assistant');
    expect(assistantMsg!.reasoning_content).toBe('my reasoning');
    expect(assistantMsg!.content).toBe('final answer');
  });

  it('should extract reasoning from message.reasoning (OpenRouter format) in translateOutput', () => {
    const adapter = new ClineAdapter();
    const response = {
      id: 'c1',
      model: 'test',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: 'final answer',
          reasoning: 'OpenRouter reasoning',
        },
        finish_reason: 'stop',
      }],
    };

    adapter.translateOutput(response);

    const assistantMsg = adapter.getConversationHistory().find(m => m.role === 'assistant');
    expect(assistantMsg!.reasoning_content).toBe('OpenRouter reasoning');
  });

  it('should preserve reasoning_content through exportSnapshot/importSnapshot', async () => {
    const adapter = new ClineAdapter();
    const sseChunks = [
      'data: {"id":"c1","choices":[{"index":0,"delta":{"reasoning_content":"reasoning text"},"finish_reason":null}]}\n\n',
      'data: {"id":"c1","choices":[{"index":0,"delta":{"content":"answer text"},"finish_reason":null}]}\n\n',
      'data: {"id":"c1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ];
    await collectStream(adapter, sseChunks);

    const snapshot = adapter.exportSnapshot();
    const assistantInSnapshot = snapshot.history.find(m => m.role === 'assistant');
    expect(assistantInSnapshot!.reasoning_content).toBe('reasoning text');

    // Import into a fresh adapter
    const adapter2 = new ClineAdapter();
    adapter2.importSnapshot(snapshot);

    const history2 = adapter2.getConversationHistory();
    const assistant2 = history2.find(m => m.role === 'assistant');
    expect(assistant2!.reasoning_content).toBe('reasoning text');
  });

  it('should preserve reasoning_content through snapshotSession/restoreSession', async () => {
    const adapter = new ClineAdapter();
    const sseChunks = [
      'data: {"id":"c1","choices":[{"index":0,"delta":{"reasoning_content":"session reasoning"},"finish_reason":null}]}\n\n',
      'data: {"id":"c1","choices":[{"index":0,"delta":{"content":"session answer"},"finish_reason":null}]}\n\n',
      'data: {"id":"c1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ];
    await collectStream(adapter, sseChunks);

    const snapshot = adapter.snapshotSession();
    const assistantInSnapshot = snapshot.history.find(m => m.role === 'assistant');
    expect(assistantInSnapshot!.reasoning_content).toBe('session reasoning');

    // Restore into a reset adapter
    adapter.resetSession();
    adapter.restoreSession(snapshot);

    const history = adapter.getConversationHistory();
    const assistant = history.find(m => m.role === 'assistant');
    expect(assistant!.reasoning_content).toBe('session reasoning');
  });
});