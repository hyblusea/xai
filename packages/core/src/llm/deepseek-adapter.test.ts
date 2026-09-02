import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DeepSeekAdapter, type DeepSeekAdapterOptions } from './deepseek-adapter.js';
import { resolve } from 'path';
import type { LLMConfig, Message } from '@xai/shared';

// Mock the PoW solver to avoid BigInt compatibility issues in the test environment.
// The PoW-specific test group restores the original implementation via hoisting.
vi.mock('./deepseek-hash.js', async (importOriginal) => {
  const original = await importOriginal() as Record<string, unknown>;
  return {
    ...original,
    // Default: return a dummy answer so translateInput tests don't hit BigInt.
    solvePowChallenge: vi.fn().mockResolvedValue({ answer: 0, signature: 'test-sig' }),
  };
});

interface ChallengeResponse {
  algorithm: string;
  challenge: string;
  salt: string;
  difficulty: number;
  expire_at: number;
  signature: string;
}

// Path to the PoW WASM that ships next to the adapter source.
const WASM_PATH = resolve(__dirname, 'sha3_wasm_bg.7b9ca65ddd.wasm');

/** Helper: decode a base64 PoW response produced by the adapter and verify
 *  its metadata matches the original challenge. We deliberately do not try
 *  to re-implement the SHA-3 prefix-bit check in JS — the WASM is the
 *  canonical reference and we trust its internal verification. */
function verifyPowResponse(
  b64: string,
  expectedChallenge: ChallengeResponse
): { ok: true; answer: number } | { ok: false; reason: string } {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(Buffer.from(b64, 'base64').toString('utf-8'));
  } catch {
    return { ok: false, reason: 'not-base64-json' };
  }
  if (parsed.algorithm !== expectedChallenge.algorithm) return { ok: false, reason: 'algo-mismatch' };
  if (parsed.challenge !== expectedChallenge.challenge) return { ok: false, reason: 'challenge-mismatch' };
  if (parsed.salt !== expectedChallenge.salt) return { ok: false, reason: 'salt-mismatch' };
  if (parsed.target_path !== '/api/v0/chat/completion') return { ok: false, reason: 'target-mismatch' };
  if (typeof parsed.signature !== 'string' || !parsed.signature) {
    return { ok: false, reason: 'missing-signature' };
  }

  const answerNum = Number(parsed.answer);
  if (!Number.isFinite(answerNum) || answerNum < 0) {
    return { ok: false, reason: 'invalid-answer' };
  }
  return { ok: true, answer: answerNum };
}

describe('DeepSeekAdapter - Session Management', () => {
  let adapter: DeepSeekAdapter;

  beforeEach(() => {
    adapter = new DeepSeekAdapter({ token: 'test-token' });
  });

  it('should initialize with a non-empty conversation id', () => {
    expect(adapter.conversationId).toBeTruthy();
    expect(typeof adapter.conversationId).toBe('string');
  });

  it('should generate different conversation ids on construction', () => {
    const a = new DeepSeekAdapter({});
    const b = new DeepSeekAdapter({});
    expect(a.conversationId).not.toBe(b.conversationId);
  });

  it('should resetSession and return a new conversation id', () => {
    const original = adapter.conversationId;
    const newId = adapter.resetSession();
    expect(newId).toBeTruthy();
    expect(newId).not.toBe(original);
    expect(adapter.conversationId).toBe(newId);
    expect(adapter.messageId).toBeNull();
  });

  it('should loadSession and switch the conversation id', () => {
    const target = 'custom-deepseek-conv-id';
    adapter.loadSession(target);
    expect(adapter.conversationId).toBe(target);
    expect(adapter.messageId).toBeNull();
  });
});

describe('DeepSeekAdapter - translateInput', () => {
  const config: LLMConfig = {
    provider: 'deepseek',
    model: 'deepseek-v4-flash',
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

  it('should build a valid request to the deepseek chat completion endpoint', async () => {
    const adapter = new DeepSeekAdapter({ token: 'test-pow-token' });
    global.fetch = vi
      .fn()
      // 1. acquireToken -> /v0/users/current
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ code: 0, data: { biz_data: { token: 'access-token-123' } } }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      )
      // 2. createSession -> /v0/chat_session/create
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ code: 0, data: { biz_data: { chat_session: { id: 'server-session-1' } } } }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      )
      // 3. acquireChallenge -> /v0/chat/create_pow_challenge
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            code: 0,
            data: {
              biz_data: {
                challenge: {
                  algorithm: 'DeepSeekHashV1',
                  challenge: 'test-challenge',
                  salt: 'salt123',
                  difficulty: 0, // difficulty 0 => any answer is valid
                  expire_at: Math.floor(Date.now() / 1000) + 60,
                  signature: 'sig-abc',
                },
              },
            },
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
    expect(req.url).toContain('chat.deepseek.com/api/v0/chat/completion');
    expect(req.headers.Authorization).toBe('Bearer access-token-123');
    expect(req.headers['Content-Type']).toBe('application/json');
    expect(req.headers.Cookie).toBeTruthy();
    expect(req.headers['X-Ds-Pow-Response']).toBeTruthy();
    expect(req.headers.Referer).toContain('server-session-1');
    expect(req.body).toBeTruthy();

    const body = JSON.parse(req.body);
    expect(body.chat_session_id).toBe('server-session-1');
    expect(body.model_type).toBeTruthy();
    expect(typeof body.prompt).toBe('string');
  });

  it('should map deepseek-v4-pro to model_type=expert', async () => {
    const adapter = new DeepSeekAdapter({ token: 'test-pow-pro' });
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: 0, data: { biz_data: { token: 'tk' } } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ code: 0, data: { biz_data: { chat_session: { id: 'sess-pro' } } } }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            code: 0,
            data: {
              biz_data: {
                challenge: {
                  algorithm: 'DeepSeekHashV1',
                  challenge: 'c',
                  salt: 's',
                  difficulty: 0,
                  expire_at: Math.floor(Date.now() / 1000) + 60,
                  signature: 'sig',
                },
              },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      );
    const proConfig: LLMConfig = { ...config, model: 'deepseek-v4-pro' };
    const messages: Message[] = [{ role: 'user', content: 'test', timestamp: Date.now() }];
    const req = await adapter.translateInput(messages, proConfig);
    const body = JSON.parse(req.body);
    expect(body.model_type).toBe('expert');
  });

  it('should map deepseek-v4-flash to model_type=default', async () => {
    const adapter = new DeepSeekAdapter({ token: 'test-pow-flash' });
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: 0, data: { biz_data: { token: 'tk' } } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ code: 0, data: { biz_data: { chat_session: { id: 'sess-flash' } } } }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            code: 0,
            data: {
              biz_data: {
                challenge: {
                  algorithm: 'DeepSeekHashV1',
                  challenge: 'c',
                  salt: 's',
                  difficulty: 0,
                  expire_at: Math.floor(Date.now() / 1000) + 60,
                  signature: 'sig',
                },
              },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      );
    const flashConfig: LLMConfig = { ...config, model: 'deepseek-v4-flash' };
    const messages: Message[] = [{ role: 'user', content: 'test', timestamp: Date.now() }];
    const req = await adapter.translateInput(messages, flashConfig);
    const body = JSON.parse(req.body);
    expect(body.model_type).toBe('default');
  });

  it('should enable thinking mode for r1/think model names', async () => {
    const adapter = new DeepSeekAdapter({ token: 'test-pow-token-2' });
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: 0, data: { biz_data: { token: 'tk' } } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ code: 0, data: { biz_data: { chat_session: { id: 's2' } } } }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            code: 0,
            data: {
              biz_data: {
                challenge: {
                  algorithm: 'DeepSeekHashV1',
                  challenge: 'c',
                  salt: 's',
                  difficulty: 0,
                  expire_at: Math.floor(Date.now() / 1000) + 60,
                  signature: 'sig',
                },
              },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      );
    const r1Config: LLMConfig = { ...config, model: 'deepseek-reasoner' };
    const messages: Message[] = [{ role: 'user', content: 'test', timestamp: Date.now() }];
    const req = await adapter.translateInput(messages, r1Config);
    const body = JSON.parse(req.body);
    // V3/R1/reasoner collapse into the v4-flash 'default' model_type.
    expect(body.model_type).toBe('default');
    expect(body.thinking_enabled).toBe(true);
  });

  it('should enable search mode for *-search model names', async () => {
    const adapter = new DeepSeekAdapter({ token: 'test-pow-token-3' });
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: 0, data: { biz_data: { token: 'tk' } } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ code: 0, data: { biz_data: { chat_session: { id: 's3' } } } }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            code: 0,
            data: {
              biz_data: {
                challenge: {
                  algorithm: 'DeepSeekHashV1',
                  challenge: 'c',
                  salt: 's',
                  difficulty: 0,
                  expire_at: Math.floor(Date.now() / 1000) + 60,
                  signature: 'sig',
                },
              },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      );
    const searchConfig: LLMConfig = { ...config, model: 'deepseek-chat-search' };
    const messages: Message[] = [{ role: 'user', content: 'test', timestamp: Date.now() }];
    const req = await adapter.translateInput(messages, searchConfig);
    const body = JSON.parse(req.body);
    expect(body.search_enabled).toBe(true);
  });

  it('should reuse chat_session_id and pass parent_message_id on subsequent calls', async () => {
    const adapter = new DeepSeekAdapter({ token: 'test-session-reuse' });

    // Simulate that a previous response set _messageId (i.e. we are in an
    // ongoing conversation) and _conversationId was set by loadSession.
    adapter.loadSession('existing-session-abc');
    // Manually set _messageId to simulate a prior assistant response.
    // We access the private field via (adapter as any) because there is no
    // public setter, but the real stream handler sets it the same way.
    (adapter as any)._messageId = '42';

    global.fetch = vi
      .fn()
      // 1. acquireToken -> /v0/users/current
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: 0, data: { biz_data: { token: 'access-tok' } } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      )
      // No createSession call expected — the session should be reused.
      // 2. acquireChallenge -> /v0/chat/create_pow_challenge
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            code: 0,
            data: {
              biz_data: {
                challenge: {
                  algorithm: 'DeepSeekHashV1',
                  challenge: 'c',
                  salt: 's',
                  difficulty: 0,
                  expire_at: Math.floor(Date.now() / 1000) + 60,
                  signature: 'sig',
                },
              },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      );

    const messages: Message[] = [{ role: 'user', content: 'Follow-up', timestamp: Date.now() }];
    const req = await adapter.translateInput(messages, config);
    const body = JSON.parse(req.body);

    // chat_session_id should be the existing session, not a new one
    expect(body.chat_session_id).toBe('existing-session-abc');
    // parent_message_id should carry the previous response's message id (as number, not string)
    expect(body.parent_message_id).toBe(42);
    // Referer should also use the existing session id
    expect(req.headers.Referer).toContain('existing-session-abc');

    // createSession should NOT have been called (only 2 fetch calls: token + challenge)
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('should create a new session when no prior message exists', async () => {
    const adapter = new DeepSeekAdapter({ token: 'test-new-session' });
    // Fresh adapter — _messageId is null, _conversationId is a random UUID.

    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: 0, data: { biz_data: { token: 'tk' } } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ code: 0, data: { biz_data: { chat_session: { id: 'new-sess-1' } } } }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            code: 0,
            data: {
              biz_data: {
                challenge: {
                  algorithm: 'DeepSeekHashV1',
                  challenge: 'c',
                  salt: 's',
                  difficulty: 0,
                  expire_at: Math.floor(Date.now() / 1000) + 60,
                  signature: 'sig',
                },
              },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      );

    const messages: Message[] = [{ role: 'user', content: 'Hello', timestamp: Date.now() }];
    const req = await adapter.translateInput(messages, config);
    const body = JSON.parse(req.body);

    // A new session should be created
    expect(body.chat_session_id).toBe('new-sess-1');
    // No prior message, so parent_message_id should be null
    expect(body.parent_message_id).toBeNull();
    // 3 fetch calls: token + createSession + challenge
    expect(global.fetch).toHaveBeenCalledTimes(3);
  });

  it('should throw when token is missing', async () => {
    const adapter = new DeepSeekAdapter({});
    const messages: Message[] = [{ role: 'user', content: 'Hi', timestamp: Date.now() }];
    await expect(adapter.translateInput(messages, config)).rejects.toThrow(/Token/);
  });
});

describe('DeepSeekAdapter - translateOutput', () => {
  it('should extract content from OpenAI-style choices', () => {
    const adapter = new DeepSeekAdapter({});
    const out = adapter.translateOutput({
      choices: [{ message: { content: 'Hello from DeepSeek' } }],
    });
    expect(out.role).toBe('assistant');
    expect(out.content).toBe('Hello from DeepSeek');
  });

  it('should fallback to data field for non-OpenAI shapes', () => {
    const adapter = new DeepSeekAdapter({});
    const out = adapter.translateOutput({ content: 'fallback' });
    expect(out.content).toBe('fallback');
  });
});

describe('DeepSeekAdapter - translateStream', () => {
  it('should parse THINK and ANSWER fragments', async () => {
    const adapter = new DeepSeekAdapter({});
    const events: Array<{ type: string; content: string }> = [];
    const sse =
      'data:{"v":{"response":{"thinking_enabled":true,"fragments":[{"type":"THINK","content":"thinking1"}]}}}\n\n' +
      'data:{"v":{"response":{"thinking_enabled":false,"fragments":[{"type":"ANSWER","content":"Hello"}]}}}\n\n' +
      'data:{"v":{"response":{"thinking_enabled":false,"fragments":[{"type":"ANSWER","content":" world"}]}}}\n\n' +
      'data:[DONE]\n\n';

    const stream = (async function* () {
      yield Buffer.from(sse);
    })();

    for await (const ev of adapter.translateStream(stream)) {
      events.push({ type: ev.type, content: ev.content });
    }

    const thinking = events.filter((e) => e.type === 'thinking').map((e) => e.content).join('');
    const text = events.filter((e) => e.type === 'text').map((e) => e.content).join('');
    expect(thinking).toBe('thinking1');
    expect(text).toBe('Hello world');
    expect(events[events.length - 1].type).toBe('done');
  });

  it('should handle string-form v fields', async () => {
    const adapter = new DeepSeekAdapter({});
    const events: Array<{ type: string; content: string }> = [];
    const sse =
      'data:{"v":"some content"}\n\n' +
      'data:[DONE]\n\n';

    const stream = (async function* () {
      yield Buffer.from(sse);
    })();

    for await (const ev of adapter.translateStream(stream)) {
      events.push({ type: ev.type, content: ev.content });
    }

    const text = events.filter((e) => e.type === 'text').map((e) => e.content).join('');
    expect(text).toBe('some content');
  });

  it('should strip FINISHED marker from content', async () => {
    const adapter = new DeepSeekAdapter({});
    const events: Array<{ type: string; content: string }> = [];
    const sse =
      'data:{"v":"answer textFINISHED"}\n\n' +
      'data:[DONE]\n\n';

    const stream = (async function* () {
      yield Buffer.from(sse);
    })();

    for await (const ev of adapter.translateStream(stream)) {
      events.push({ type: ev.type, content: ev.content });
    }

    const text = events.filter((e) => e.type === 'text').map((e) => e.content).join('');
    expect(text).toBe('answer text');
  });

  it('should capture message id from response_message_id', async () => {
    const adapter = new DeepSeekAdapter({ token: 'test' });
    const events: Array<{ type: string; content: string }> = [];
    const sse =
      'data:{"response_message_id":"msg-123","v":{"response":{"response_message_id":"msg-123","thinking_enabled":false,"fragments":[{"type":"ANSWER","content":"hi"}]}}}\n\n' +
      'data:[DONE]\n\n';

    const stream = (async function* () {
      yield Buffer.from(sse);
    })();

    for await (const ev of adapter.translateStream(stream)) {
      events.push({ type: ev.type, content: ev.content });
    }
    expect(adapter.messageId).toBe('msg-123');
  });
});

describe('DeepSeekAdapter - getConversationList', () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('should return null when no token', async () => {
    const adapter = new DeepSeekAdapter({});
    const result = await adapter.getConversationList();
    expect(result).toBeNull();
  });

  it('should fetch and parse the conversation list', async () => {
    const adapter = new DeepSeekAdapter({ token: 'list-test-1' });
    global.fetch = vi
      .fn()
      // 1. acquireToken -> /v0/users/current
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ code: 0, data: { biz_data: { token: 'access-tok' } } }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      )
      // 2. GET /v0/chat_session/fetch_page
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            code: 0,
            data: {
              biz_data: {
                chat_sessions: [
                  { id: 'c1', title: 'First', pinned: false, model_type: 'default', updated_at: 1781749120.496 },
                  { id: 'c2', title: 'Second', pinned: false, model_type: 'expert', updated_at: 1781748349.997 },
                ],
                has_more: false,
              },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      );

    const result = await adapter.getConversationList();
    expect(result).not.toBeNull();
    expect(result!.list.length).toBe(2);
    expect(result!.list[0].conversationId).toBe('c1');
    expect(result!.list[0].title).toBe('First');
    expect(result!.list[0].modelType).toBe('default');
    expect(result!.list[1].modelType).toBe('expert');
    expect(result!.hasMore).toBe(false);

    // Verify the GET request URL
    const fetchCalls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls;
    const listCall = fetchCalls[1];
    expect(listCall[0]).toContain('/v0/chat_session/fetch_page');
    expect(listCall[0]).toContain('lte_cursor.pinned=false');
    expect(listCall[1].method).toBe('GET');
  });

  it('should return nextCursor when has_more is true', async () => {
    const adapter = new DeepSeekAdapter({ token: 'list-test-cursor' });
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ code: 0, data: { biz_data: { token: 'access-tok' } } }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            code: 0,
            data: {
              biz_data: {
                chat_sessions: [
                  { id: 'c1', title: 'First', pinned: false, model_type: 'default', updated_at: 1781749120.496 },
                ],
                has_more: true,
              },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      );

    const result = await adapter.getConversationList();
    expect(result).not.toBeNull();
    expect(result!.hasMore).toBe(true);
    expect(result!.nextCursor).toBe('1781749120.496');
  });

  it('should return null on error response', async () => {
    const adapter = new DeepSeekAdapter({ token: 'list-test-2' });
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ code: 0, data: { biz_data: { token: 'access-tok' } } }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: 1, msg: 'failed' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      );
    const result = await adapter.getConversationList();
    expect(result).toBeNull();
  });
});

describe('DeepSeekAdapter - deleteConversation', () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('should return false when no token', async () => {
    const adapter = new DeepSeekAdapter({});
    const result = await adapter.deleteConversationById('any-id');
    expect(result).toBe(false);
  });

  it('should return true on successful delete', async () => {
    const adapter = new DeepSeekAdapter({ token: 'del-test-1' });
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ code: 0, data: { biz_data: { token: 'access-tok' } } }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: 0 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      );
    const result = await adapter.deleteConversationById('target-id');
    expect(result).toBe(true);
  });

  it('should return false on failed delete', async () => {
    const adapter = new DeepSeekAdapter({ token: 'del-test-2' });
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ code: 0, data: { biz_data: { token: 'access-tok' } } }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      )
      .mockResolvedValueOnce(new Response('error', { status: 500 }));
    const result = await adapter.deleteConversationById('target-id');
    expect(result).toBe(false);
  });
});

describe('DeepSeekAdapter - PoW challenge (X-Ds-Pow-Response)', () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  const config: LLMConfig = {
    provider: 'deepseek',
    model: 'deepseek-v4-flash',
    maxTokens: 4096,
    temperature: 0.5,
  };

  const messages: Message[] = [{ role: 'user', content: 'test', timestamp: Date.now() }];

  it('should produce a valid PoW response (difficulty 4) that satisfies SHA3-256 prefix bits', async () => {
    const challenge: ChallengeResponse = {
      algorithm: 'DeepSeekHashV1',
      challenge: 'hello-pow',
      salt: 'salt-xyz',
      difficulty: 4,
      expire_at: Math.floor(Date.now() / 1000) + 60,
      signature: 'sig-001',
    };
    const adapter = new DeepSeekAdapter({ token: 'pow-d4', wasmPath: WASM_PATH });
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ code: 0, data: { biz_data: { token: 'access-tok' } } }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ code: 0, data: { biz_data: { chat_session: { id: 'sess-pow' } } } }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ code: 0, data: { biz_data: { challenge } } }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      );

    const req = await adapter.translateInput(messages, config);
    const pow = req.headers['X-Ds-Pow-Response'];
    expect(typeof pow).toBe('string');
    const result = verifyPowResponse(String(pow), challenge);
    expect(result).toEqual(expect.objectContaining({ ok: true }));
  });

  it('should produce a valid PoW response (difficulty 6) within reasonable time', async () => {
    const challenge: ChallengeResponse = {
      algorithm: 'DeepSeekHashV1',
      challenge: 'hello-pow-d6',
      salt: 'salt-zzz',
      difficulty: 6,
      expire_at: Math.floor(Date.now() / 1000) + 60,
      signature: 'sig-002',
    };
    const adapter = new DeepSeekAdapter({ token: 'pow-d6', wasmPath: WASM_PATH });
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ code: 0, data: { biz_data: { token: 'access-tok' } } }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ code: 0, data: { biz_data: { chat_session: { id: 'sess-d6' } } } }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ code: 0, data: { biz_data: { challenge } } }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      );

    const t0 = Date.now();
    const req = await adapter.translateInput(messages, config);
    const elapsed = Date.now() - t0;
    const pow = req.headers['X-Ds-Pow-Response'];
    const result = verifyPowResponse(String(pow), challenge);
    expect(result).toEqual(expect.objectContaining({ ok: true }));
    // The WASM solver should find a valid PoW for difficulty 6 in well under 30s.
    expect(elapsed).toBeLessThan(30000);
  });
});
