import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { QwenAiAdapter } from './qwenai-adapter.js';
import type { LLMConfig, Message } from '@xai/shared';

describe('QwenAiAdapter - Session Management', () => {
  let adapter: QwenAiAdapter;

  beforeEach(() => {
    adapter = new QwenAiAdapter({ token: 'test-token' });
  });

  it('should initialize with empty chat id', () => {
    expect(adapter.chatId).toBe('');
  });

  it('should resetSession and clear chat id', () => {
    adapter.loadSession('preset-id');
    adapter.resetSession();
    expect(adapter.chatId).toBe('');
  });

  it('should loadSession and switch the chat id', () => {
    const target = 'custom-qwenai-chat-id';
    adapter.loadSession(target);
    expect(adapter.chatId).toBe(target);
  });
});

describe('QwenAiAdapter - mapModel', () => {
  it('should map qwen alias to qwen3.7-max', () => {
    const adapter = new QwenAiAdapter({});
    // @ts-expect-error - testing private method
    const r1 = adapter.mapModel('qwen');
    expect(r1.mapped).toBe('qwen3.7-max');
  });

  it('should map qwen3 alias to qwen3.7-max', () => {
    const adapter = new QwenAiAdapter({});
    // @ts-expect-error - testing private method
    const r1 = adapter.mapModel('qwen3');
    expect(r1.mapped).toBe('qwen3.7-max');
  });

  it('should preserve the model name for unknown aliases', () => {
    const adapter = new QwenAiAdapter({});
    // @ts-expect-error - testing private method
    const r1 = adapter.mapModel('qwen-custom-model');
    expect(r1.mapped).toBe('qwen-custom-model');
  });

  it('should force thinking for -thinking suffix', () => {
    const adapter = new QwenAiAdapter({});
    // @ts-expect-error - testing private method
    const r1 = adapter.mapModel('qwen3.6-plus-thinking');
    expect(r1.mapped).toBe('qwen3.6-plus');
    expect(r1.forceThinking).toBe(true);
  });

  it('should force non-thinking for -fast suffix', () => {
    const adapter = new QwenAiAdapter({});
    // @ts-expect-error - testing private method
    const r1 = adapter.mapModel('qwen3.6-plus-fast');
    expect(r1.mapped).toBe('qwen3.6-plus');
    expect(r1.forceThinking).toBe(false);
  });
});

describe('QwenAiAdapter - translateInput', () => {
  const config: LLMConfig = {
    provider: 'qwenai',
    model: 'qwen3.7-max',
    maxTokens: 4096,
    temperature: 0.5,
  };

  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('should build a valid request to the qwen chat completions endpoint', async () => {
    const adapter = new QwenAiAdapter({ token: 'jwt-token' });
    global.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: { id: 'new-chat-id-123' },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );

    const messages: Message[] = [
      { role: 'system', content: 'You are helpful.', timestamp: Date.now() },
      { role: 'user', content: 'Hi', timestamp: Date.now() },
    ];

    const req = await adapter.translateInput(messages, config);
    expect(req.method).toBe('POST');
    expect(req.url).toContain('chat.qwen.ai/api/v2/chat/completions');
    expect(req.url).toContain('chat_id=new-chat-id-123');
    expect(req.headers.Authorization).toBe('Bearer jwt-token');
    expect(req.body).toBeTruthy();

    const body = JSON.parse(req.body);
    expect(body.stream).toBe(true);
    expect(body.chat_id).toBe('new-chat-id-123');
    expect(body.model).toBe('qwen3.7-max');
    expect(Array.isArray(body.messages)).toBe(true);
  });

  it('should enable thinking for -thinking models', async () => {
    const adapter = new QwenAiAdapter({ token: 'jwt-token' });
    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: { id: 'c1' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );
    const tConfig: LLMConfig = { ...config, model: 'qwen3.6-plus-thinking' };
    const messages: Message[] = [{ role: 'user', content: 'test', timestamp: Date.now() }];
    const req = await adapter.translateInput(messages, tConfig);
    const body = JSON.parse(req.body);
    expect(body.messages[0].feature_config.thinking_enabled).toBe(true);
  });

  it('should reuse existing chat id if already set', async () => {
    const adapter = new QwenAiAdapter({ token: 'jwt-token' });
    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: { id: 'should-not-call' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );
    adapter.loadSession('existing-id');
    const messages: Message[] = [{ role: 'user', content: 'hi', timestamp: Date.now() }];
    const req = await adapter.translateInput(messages, config);
    expect(req.url).toContain('chat_id=existing-id');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('should throw when token is missing', async () => {
    const adapter = new QwenAiAdapter({});
    const messages: Message[] = [{ role: 'user', content: 'Hi', timestamp: Date.now() }];
    await expect(adapter.translateInput(messages, config)).rejects.toThrow(/Token/);
  });
});

describe('QwenAiAdapter - translateOutput', () => {
  it('should extract content from OpenAI-style choices', () => {
    const adapter = new QwenAiAdapter({});
    const out = adapter.translateOutput({
      choices: [{ message: { content: 'Hello from Qwen' } }],
    });
    expect(out.role).toBe('assistant');
    expect(out.content).toBe('Hello from Qwen');
  });

  it('should fallback to data field for non-OpenAI shapes', () => {
    const adapter = new QwenAiAdapter({});
    const out = adapter.translateOutput({ content: 'fallback' });
    expect(out.content).toBe('fallback');
  });
});

describe('QwenAiAdapter - translateStream', () => {
  it('should parse answer phase chunks', async () => {
    const adapter = new QwenAiAdapter({});
    const events: Array<{ type: string; content: string }> = [];
    const sse =
      'data:{"choices":[{"delta":{"phase":"answer","content":"Hello "},"finish_reason":null}]}\n\n' +
      'data:{"choices":[{"delta":{"phase":"answer","content":"world"},"finish_reason":"stop"}]}\n\n';

    const stream = (async function* () {
      yield Buffer.from(sse);
    })();

    for await (const ev of adapter.translateStream(stream)) {
      events.push({ type: ev.type, content: ev.content });
    }

    const text = events.filter((e) => e.type === 'text').map((e) => e.content).join('');
    expect(text).toBe('Hello world');
  });

  it('should parse think phase chunks as thinking', async () => {
    const adapter = new QwenAiAdapter({});
    const events: Array<{ type: string; content: string }> = [];
    const sse =
      'data:{"choices":[{"delta":{"phase":"think","content":"reasoning here"},"finish_reason":null}]}\n\n' +
      'data:{"choices":[{"delta":{"phase":"answer","content":"Final"},"finish_reason":"stop"}]}\n\n';

    const stream = (async function* () {
      yield Buffer.from(sse);
    })();

    for await (const ev of adapter.translateStream(stream)) {
      events.push({ type: ev.type, content: ev.content });
    }

    const thinking = events.filter((e) => e.type === 'thinking').map((e) => e.content).join('');
    const text = events.filter((e) => e.type === 'text').map((e) => e.content).join('');
    expect(thinking).toBe('reasoning here');
    expect(text).toBe('Final');
  });

  it('should handle concatenated JSON events in a single data field', async () => {
    const adapter = new QwenAiAdapter({});
    const events: Array<{ type: string; content: string }> = [];
    const sse =
      'data:{"choices":[{"delta":{"phase":"answer","content":"a"},"finish_reason":null}]}{"choices":[{"delta":{"phase":"answer","content":"b"},"finish_reason":"stop"}]}\n\n';

    const stream = (async function* () {
      yield Buffer.from(sse);
    })();

    for await (const ev of adapter.translateStream(stream)) {
      events.push({ type: ev.type, content: ev.content });
    }

    const text = events.filter((e) => e.type === 'text').map((e) => e.content).join('');
    expect(text).toBe('ab');
  });

  it('should emit done at the end', async () => {
    const adapter = new QwenAiAdapter({});
    const events: Array<{ type: string; content: string }> = [];
    const stream = (async function* () {
      yield Buffer.from('data:{"choices":[{"delta":{"phase":"answer","content":""},"finish_reason":"stop"}]}\n\n');
    })();

    for await (const ev of adapter.translateStream(stream)) {
      events.push({ type: ev.type, content: ev.content });
    }
    expect(events[events.length - 1].type).toBe('done');
  });

  it('should yield error chunk for non-SSE JSON error response (success: false)', async () => {
    const adapter = new QwenAiAdapter({});
    const events: Array<{ type: string; content: string }> = [];
    const errorBody = JSON.stringify({
      success: false,
      request_id: 'req-123',
      data: { code: 'Bad_Request', details: 'Internal error...' },
    });
    const stream = (async function* () {
      yield Buffer.from(errorBody);
    })();

    for await (const ev of adapter.translateStream(stream)) {
      events.push({ type: ev.type, content: ev.content });
    }

    const errorEvents = events.filter((e) => e.type === 'error');
    expect(errorEvents.length).toBe(1);
    expect(errorEvents[0].content).toContain('Bad_Request');
    expect(errorEvents[0].content).toContain('Internal error');
  });

  it('should yield done (not error) for non-SSE non-error JSON response', async () => {
    const adapter = new QwenAiAdapter({});
    const events: Array<{ type: string; content: string }> = [];
    const stream = (async function* () {
      yield Buffer.from('{"success":true,"data":{"id":"some-id"}}');
    })();

    for await (const ev of adapter.translateStream(stream)) {
      events.push({ type: ev.type, content: ev.content });
    }

    const errorEvents = events.filter((e) => e.type === 'error');
    expect(errorEvents.length).toBe(0);
    expect(events[events.length - 1].type).toBe('done');
  });

  it('should yield done for completely empty response', async () => {
    const adapter = new QwenAiAdapter({});
    const events: Array<{ type: string; content: string }> = [];
    const stream = (async function* () {
      yield Buffer.from('');
    })();

    for await (const ev of adapter.translateStream(stream)) {
      events.push({ type: ev.type, content: ev.content });
    }

    expect(events.length).toBe(1);
    expect(events[0].type).toBe('done');
  });
});

describe('QwenAiAdapter - getConversationList', () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('should return null when no token', async () => {
    const adapter = new QwenAiAdapter({});
    const result = await adapter.getConversationList(1, 20);
    expect(result).toBeNull();
  });

  it('should fetch and parse the conversation list', async () => {
    const adapter = new QwenAiAdapter({ token: 'jwt' });
    global.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            chats: [
              { id: 'c1', title: 'First', created_at: 100, updated_at: 200 },
              { id: 'c2', title: 'Second', created_at: 101, updated_at: 201 },
            ],
            total: 2,
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );

    const result = await adapter.getConversationList(1, 20);
    expect(result).not.toBeNull();
    expect(result!.list.length).toBe(2);
    expect(result!.list[0].conversationId).toBe('c1');
    expect(result!.list[0].title).toBe('First');
    expect(result!.total).toBe(2);
  });

  it('should return null on error response', async () => {
    const adapter = new QwenAiAdapter({ token: 'jwt' });
    global.fetch = vi.fn().mockResolvedValue(new Response('error', { status: 500 }));
    const result = await adapter.getConversationList(1, 20);
    expect(result).toBeNull();
  });
});

describe('QwenAiAdapter - deleteConversation', () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('should return false when no token', async () => {
    const adapter = new QwenAiAdapter({});
    const result = await adapter.deleteConversationById('any-id');
    expect(result).toBe(false);
  });

  it('should return false when no chat id', async () => {
    const adapter = new QwenAiAdapter({ token: 'jwt' });
    const result = await adapter.deleteConversationById('');
    expect(result).toBe(false);
  });

  it('should return true on successful delete and clear chatId if matching', async () => {
    const adapter = new QwenAiAdapter({ token: 'jwt' });
    adapter.loadSession('target-id');
    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );
    const result = await adapter.deleteConversationById('target-id');
    expect(result).toBe(true);
    expect(adapter.chatId).toBe('');
  });

  it('should return false on failed delete', async () => {
    const adapter = new QwenAiAdapter({ token: 'jwt' });
    global.fetch = vi.fn().mockResolvedValue(new Response('error', { status: 500 }));
    const result = await adapter.deleteConversationById('target-id');
    expect(result).toBe(false);
  });
});

describe('QwenAiAdapter - buildHeaders cookie warning', () => {
  it('should warn when no cookies are provided', () => {
    const adapter = new QwenAiAdapter({ token: 'jwt' });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // @ts-expect-error - testing private method
    adapter.buildHeaders('chat-id');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('No cookies provided'),
    );
    warnSpy.mockRestore();
  });

  it('should warn about specific missing cookies', () => {
    const adapter = new QwenAiAdapter({ token: 'jwt', cookies: 'cna=abc; token=xyz' });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // @ts-expect-error - testing private method
    adapter.buildHeaders('chat-id');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Missing cookies'),
    );
    warnSpy.mockRestore();
  });

  it('should not warn when all required cookies are present', () => {
    const allCookies = 'cnaui=1; aui=2; sca=3; xlly_s=4; cna=5; token=6; _bl_uid=7; x-ap=8';
    const adapter = new QwenAiAdapter({ token: 'jwt', cookies: allCookies });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // @ts-expect-error - testing private method
    adapter.buildHeaders('chat-id');
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe('QwenAiAdapter - createChat', () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('should call /api/v2/chats/new and return the chat id', async () => {
    const adapter = new QwenAiAdapter({ token: 'jwt' });
    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: { id: 'chat-xyz' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );
    const id = await adapter.createChat('qwen3.7-max', 'New Chat');
    expect(id).toBe('chat-xyz');
    expect(global.fetch).toHaveBeenCalled();
  });

  it('should throw on http error', async () => {
    const adapter = new QwenAiAdapter({ token: 'jwt' });
    global.fetch = vi.fn().mockResolvedValue(new Response('forbidden', { status: 403 }));
    await expect(adapter.createChat('qwen3.7-max')).rejects.toThrow(/HTTP 403/);
  });

  it('should throw when no id returned', async () => {
    const adapter = new QwenAiAdapter({ token: 'jwt' });
    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: {} }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );
    await expect(adapter.createChat('qwen3.7-max')).rejects.toThrow(/no chat id/);
  });
});
