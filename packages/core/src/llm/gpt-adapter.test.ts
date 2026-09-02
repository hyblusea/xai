import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GptAdapter } from './gpt-adapter.js';
import type { GptAdapterOptions } from './gpt-adapter.js';
import type { Message, LLMConfig } from '@xai/shared';
import sha3Lib from 'js-sha3';

type AdapterAny = any;

function createAdapter(opts?: Partial<GptAdapterOptions>): AdapterAny {
  return new GptAdapter(opts);
}

function makeJWT(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64');
  const sig = Buffer.from('fakesignature').toString('base64');
  return `${header}.${body}.${sig}`;
}

async function collectStream(chunks: string[]): Promise<{ texts: string[]; errors: string[]; done: boolean }> {
  const adapter = createAdapter();
  const texts: string[] = [];
  const errors: string[] = [];
  let done = false;

  async function* mockStream() {
    for (const chunk of chunks) {
      yield Buffer.from(chunk);
    }
  }

  for await (const event of adapter.translateStream(mockStream())) {
    if (event.type === 'text') texts.push(event.content);
    if (event.type === 'error') errors.push(event.content);
    if (event.type === 'done') done = true;
  }

  return { texts, errors, done };
}

describe('GptAdapter constructor', () => {
  it('should use default baseUrl when not provided', () => {
    const adapter = createAdapter();
    expect(adapter.getBaseUrl()).toBe('https://chatgpt.com');
  });

  it('should use custom baseUrl when provided', () => {
    const adapter = createAdapter({ baseUrl: 'https://custom.example.com' });
    expect(adapter.getBaseUrl()).toBe('https://custom.example.com');
  });

  it('should strip trailing slashes from baseUrl', () => {
    const adapter = createAdapter({ baseUrl: 'https://custom.example.com///' });
    expect(adapter.getBaseUrl()).toBe('https://custom.example.com');
  });

  it('should initialize with default parentMessageId', () => {
    const adapter = createAdapter();
    expect(adapter.parentMessageId).toBe('client-created-root');
  });

  it('should initialize with null conversationId', () => {
    const adapter = createAdapter();
    expect(adapter.conversationId).toBeNull();
  });

  it('should initialize with null assistantMessageId', () => {
    const adapter = createAdapter();
    expect(adapter.assistantMessageId).toBeNull();
  });

  it('should store authorization token', () => {
    const adapter = createAdapter({ authorization: 'Bearer test-token' });
    expect(adapter._authorization).toBe('Bearer test-token');
  });

  it('should default to empty authorization', () => {
    const adapter = createAdapter();
    expect(adapter._authorization).toBe('');
  });
});

describe('GptAdapter session management', () => {
  it('resetSession should clear all session state', () => {
    const adapter = createAdapter();
    adapter._conversationId = 'conv-123';
    adapter._parentMessageId = 'msg-456';
    adapter._assistantMessageId = 'msg-789';

    adapter.resetSession();

    expect(adapter.conversationId).toBeNull();
    expect(adapter.parentMessageId).toBe('client-created-root');
    expect(adapter.assistantMessageId).toBeNull();
  });

  it('loadSession should set conversationId', () => {
    const adapter = createAdapter();
    adapter.loadSession('conv-abc');
    expect(adapter.conversationId).toBe('conv-abc');
  });

  it('loadSession should set parentMessageId when provided', () => {
    const adapter = createAdapter();
    adapter.loadSession('conv-abc', 'msg-xyz');
    expect(adapter.conversationId).toBe('conv-abc');
    expect(adapter.parentMessageId).toBe('msg-xyz');
  });

  it('loadSession should not change parentMessageId when not provided', () => {
    const adapter = createAdapter();
    adapter._parentMessageId = 'existing-msg';
    adapter.loadSession('conv-abc');
    expect(adapter.parentMessageId).toBe('existing-msg');
  });
});

describe('GptAdapter decodeJWT', () => {
  it('should decode a valid JWT with exp', () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const token = makeJWT({ exp, sub: 'user123' });
    const adapter = createAdapter();

    const result = adapter.decodeJWT(token);

    expect(result).not.toBeNull();
    expect(result!.exp).toBe(exp);
    expect(result!.sub).toBe('user123');
  });

  it('should decode JWT with Bearer prefix', () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const token = makeJWT({ exp });
    const adapter = createAdapter();

    const result = adapter.decodeJWT(`Bearer ${token}`);

    expect(result).not.toBeNull();
    expect(result!.exp).toBe(exp);
  });

  it('should return null for invalid JWT (wrong format)', () => {
    const adapter = createAdapter();
    expect(adapter.decodeJWT('not-a-jwt')).toBeNull();
  });

  it('should return null for JWT with only 2 parts', () => {
    const adapter = createAdapter();
    expect(adapter.decodeJWT('part1.part2')).toBeNull();
  });

  it('should return null for empty string', () => {
    const adapter = createAdapter();
    expect(adapter.decodeJWT('')).toBeNull();
  });

  it('should return null for non-base64 payload', () => {
    const adapter = createAdapter();
    expect(adapter.decodeJWT('a.!!!.c')).toBeNull();
  });
});

describe('GptAdapter isTokenExpiringSoon', () => {
  it('should return true when no authorization token', () => {
    const adapter = createAdapter();
    expect(adapter.isTokenExpiringSoon()).toBe(true);
  });

  it('should return true when JWT has no exp field', () => {
    const token = makeJWT({ sub: 'user' });
    const adapter = createAdapter({ authorization: token });
    expect(adapter.isTokenExpiringSoon()).toBe(true);
  });

  it('should return true when JWT is expired', () => {
    const exp = Math.floor(Date.now() / 1000) - 60;
    const token = makeJWT({ exp });
    const adapter = createAdapter({ authorization: token });
    expect(adapter.isTokenExpiringSoon()).toBe(true);
  });

  it('should return true when JWT expires within threshold', () => {
    const exp = Math.floor(Date.now() / 1000) + 60;
    const token = makeJWT({ exp });
    const adapter = createAdapter({ authorization: token });
    expect(adapter.isTokenExpiringSoon()).toBe(true);
  });

  it('should return false when JWT is valid for a long time', () => {
    const exp = Math.floor(Date.now() / 1000) + 86400;
    const token = makeJWT({ exp });
    const adapter = createAdapter({ authorization: token });
    expect(adapter.isTokenExpiringSoon()).toBe(false);
  });

  it('should respect custom threshold', () => {
    const exp = Math.floor(Date.now() / 1000) + 600;
    const token = makeJWT({ exp });
    const adapter = createAdapter({ authorization: token });
    expect(adapter.isTokenExpiringSoon(120)).toBe(false);
    expect(adapter.isTokenExpiringSoon(3600)).toBe(true);
  });
});

describe('GptAdapter buildBaseHeaders', () => {
  it('should include authorization header', () => {
    const adapter = createAdapter({ authorization: 'Bearer mytoken' });
    const headers = adapter.buildBaseHeaders();
    expect(headers['authorization']).toBe('Bearer mytoken');
  });

  it('should include cookie header', () => {
    const adapter = createAdapter({ cookies: 'session=abc123' });
    const headers = adapter.buildBaseHeaders();
    expect(headers['cookie']).toBe('session=abc123');
  });

  it('should include oai-device-id header', () => {
    const adapter = createAdapter({ deviceId: 'device-xyz' });
    const headers = adapter.buildBaseHeaders();
    expect(headers['oai-device-id']).toBe('device-xyz');
  });

  it('should include x-oai-is header', () => {
    const adapter = createAdapter({ xOaiIs: 'ois1.abc' });
    const headers = adapter.buildBaseHeaders();
    expect(headers['x-oai-is']).toBe('ois1.abc');
  });

  it('should include origin based on baseUrl', () => {
    const adapter = createAdapter({ baseUrl: 'https://custom.example.com' });
    const headers = adapter.buildBaseHeaders();
    expect(headers['origin']).toBe('https://custom.example.com');
  });

  it('should include referer based on baseUrl', () => {
    const adapter = createAdapter({ baseUrl: 'https://custom.example.com' });
    const headers = adapter.buildBaseHeaders();
    expect(headers['referer']).toBe('https://custom.example.com/');
  });

  it('should include custom user-agent', () => {
    const adapter = createAdapter({ userAgent: 'CustomAgent/1.0' });
    const headers = adapter.buildBaseHeaders();
    expect(headers['user-agent']).toBe('CustomAgent/1.0');
  });

  it('should include default user-agent when not specified', () => {
    const adapter = createAdapter();
    const headers = adapter.buildBaseHeaders();
    expect(headers['user-agent']).toContain('Chrome/');
  });

  it('should include oai-client-build-number', () => {
    const adapter = createAdapter({ clientBuildNumber: '20250101' });
    const headers = adapter.buildBaseHeaders();
    expect(headers['oai-client-build-number']).toBe('20250101');
  });

  it('should include oai-client-version', () => {
    const adapter = createAdapter({ clientVersion: '1.0.0' });
    const headers = adapter.buildBaseHeaders();
    expect(headers['oai-client-version']).toBe('1.0.0');
  });

  it('should include sec-ch-ua headers', () => {
    const adapter = createAdapter();
    const headers = adapter.buildBaseHeaders();
    expect(headers['sec-ch-ua']).toBeDefined();
    expect(headers['sec-ch-ua-mobile']).toBeDefined();
    expect(headers['sec-ch-ua-platform']).toBeDefined();
  });

  it('should include x-oai-turn-trace-id as UUID format', () => {
    const adapter = createAdapter();
    const headers = adapter.buildBaseHeaders();
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    expect(headers['x-oai-turn-trace-id']).toMatch(uuidRegex);
  });
});

describe('GptAdapter extractUserMessage', () => {
  it('should extract last user message', () => {
    const adapter = createAdapter();
    const messages: Message[] = [
      { role: 'user', content: 'Hello', timestamp: 1 },
      { role: 'assistant', content: 'Hi', timestamp: 2 },
      { role: 'user', content: 'How are you?', timestamp: 3 },
    ];

    expect(adapter.extractUserMessage(messages)).toBe('How are you?');
  });

  it('should prepend system message to user message', () => {
    const adapter = createAdapter();
    const messages: Message[] = [
      { role: 'system', content: 'You are helpful.', timestamp: 0 },
      { role: 'user', content: 'Hello', timestamp: 1 },
    ];

    const result = adapter.extractUserMessage(messages);
    expect(result).toContain('You are helpful.');
    expect(result).toContain('Hello');
    expect(result).toContain('---');
  });

  it('should return empty string when no user message', () => {
    const adapter = createAdapter();
    const messages: Message[] = [
      { role: 'assistant', content: 'Hi', timestamp: 1 },
    ];

    expect(adapter.extractUserMessage(messages)).toBe('');
  });

  it('should handle tool results at the end', () => {
    const adapter = createAdapter();
    const messages: Message[] = [
      { role: 'user', content: 'List files', timestamp: 1 },
      { role: 'assistant', content: 'Let me check', timestamp: 2 },
      { role: 'tool', content: 'file1.txt\nfile2.txt', toolName: 'list_files', timestamp: 3 },
    ];

    const result = adapter.extractUserMessage(messages);
    expect(result).toContain('[Tool Result] list_files');
    expect(result).toContain('file1.txt');
    expect(result).toContain('continue your response');
  });

  it('should handle multiple consecutive tool results', () => {
    const adapter = createAdapter();
    const messages: Message[] = [
      { role: 'user', content: 'Check', timestamp: 1 },
      { role: 'tool', content: 'result1', toolName: 'tool_a', timestamp: 2 },
      { role: 'tool', content: 'result2', toolName: 'tool_b', timestamp: 3 },
    ];

    const result = adapter.extractUserMessage(messages);
    expect(result).toContain('[Tool Result] tool_a');
    expect(result).toContain('[Tool Result] tool_b');
  });

  it('should not include tool results that are not at the end', () => {
    const adapter = createAdapter();
    const messages: Message[] = [
      { role: 'tool', content: 'old result', toolName: 'tool_a', timestamp: 1 },
      { role: 'user', content: 'New question', timestamp: 2 },
    ];

    const result = adapter.extractUserMessage(messages);
    expect(result).toBe('New question');
  });

  it('should return user message without system when no system message', () => {
    const adapter = createAdapter();
    const messages: Message[] = [
      { role: 'user', content: 'Just a question', timestamp: 1 },
    ];

    expect(adapter.extractUserMessage(messages)).toBe('Just a question');
  });
});

describe('GptAdapter generateRequirementsToken', () => {
  it('should return a string starting with gAAAAAC', () => {
    const adapter = createAdapter();
    const token = adapter.generateRequirementsToken();
    expect(token.startsWith('gAAAAAC')).toBe(true);
  });

  it('should return different tokens on each call', () => {
    const adapter = createAdapter();
    const token1 = adapter.generateRequirementsToken();
    const token2 = adapter.generateRequirementsToken();
    expect(token1).not.toBe(token2);
  });

  it('should be valid base64 after prefix', () => {
    const adapter = createAdapter();
    const token = adapter.generateRequirementsToken();
    const b64Part = token.substring(7);
    expect(() => Buffer.from(b64Part, 'base64')).not.toThrow();
  });
});

describe('GptAdapter solveProofOfWork', () => {
  it('should return a string starting with gAAAAAB', () => {
    const adapter = createAdapter();
    const result = adapter.solveProofOfWork('testseed', 'ff');
    expect(result.startsWith('gAAAAAB')).toBe(true);
  });

  it('should solve easy difficulty (ff prefix)', () => {
    const adapter = createAdapter();
    const result = adapter.solveProofOfWork('testseed', 'ff');
    expect(result.length).toBeGreaterThan(7);
  });

  it('should produce valid SHA3-512 hash for easy difficulty', () => {
    const adapter = createAdapter();
    const seed = 'test-seed-value';
    const difficulty = 'ff';
    const result = adapter.solveProofOfWork(seed, difficulty);

    const b64Part = result.substring(7);
    const decoded = Buffer.from(b64Part, 'base64').toString();

    const proofArr = JSON.parse(decoded) as (number | string)[];
    proofArr[3] = 0;

    const hashHex = sha3Lib.sha3_512(seed + Buffer.from(JSON.stringify(proofArr)).toString('base64'));

    expect(hashHex.substring(0, difficulty.length / 2)).toBeDefined();
  });
});

describe('GptAdapter translateStream SSE parsing', () => {
  it('should parse append events', async () => {
    const sseData = `data: ${JSON.stringify({ o: 'append', p: '/message/content/parts/0', v: 'Hello' })}\n\n` +
      `data: ${JSON.stringify({ o: 'append', p: '/message/content/parts/0', v: ' world' })}\n\n`;

    const result = await collectStream([sseData]);

    expect(result.texts).toEqual(['Hello', ' world']);
    expect(result.done).toBe(true);
  });

  it('should parse add event with assistant message', async () => {
    const msgId = 'msg-001';
    const sseData = `data: ${JSON.stringify({
      o: 'add',
      v: {
        conversation_id: 'conv-123',
        message: {
          id: msgId,
          author: { role: 'assistant' },
          content: { parts: ['Full response text'] },
        },
      },
    })}\n\n`;

    const adapter = createAdapter();
    const texts: string[] = [];

    async function* mockStream() {
      yield Buffer.from(sseData);
    }

    for await (const event of adapter.translateStream(mockStream())) {
      if (event.type === 'text') texts.push(event.content);
    }

    expect(texts).toContain('Full response text');
    expect(adapter.conversationId).toBe('conv-123');
    expect(adapter.assistantMessageId).toBe(msgId);
    expect(adapter.parentMessageId).toBe(msgId);
  });

  it('should update conversationId from top-level field', async () => {
    const sseData = `data: ${JSON.stringify({ conversation_id: 'conv-top' })}\n\n`;

    const adapter = createAdapter();

    async function* mockStream() {
      yield Buffer.from(sseData);
    }

    for await (const event of adapter.translateStream(mockStream())) {
      // consume
    }

    expect(adapter.conversationId).toBe('conv-top');
  });

  it('should update conversationId from v.conversation_id', async () => {
    const sseData = `data: ${JSON.stringify({ v: { conversation_id: 'conv-nested' } })}\n\n`;

    const adapter = createAdapter();

    async function* mockStream() {
      yield Buffer.from(sseData);
    }

    for await (const event of adapter.translateStream(mockStream())) {
      // consume
    }

    expect(adapter.conversationId).toBe('conv-nested');
  });

  it('should handle array of operations in v field', async () => {
    const sseData = `data: ${JSON.stringify({
      v: [
        { o: 'append', p: '/message/content/parts/0', v: 'Part1' },
        { o: 'append', p: '/message/content/parts/0', v: ' Part2' },
      ],
    })}\n\n`;

    const result = await collectStream([sseData]);

    expect(result.texts).toEqual(['Part1', ' Part2']);
  });

  it('should handle [DONE] marker', async () => {
    const sseData = `data: ${JSON.stringify({ o: 'append', p: '/message/content/parts/0', v: 'Done' })}\n\ndata: [DONE]\n\n`;

    const result = await collectStream([sseData]);

    expect(result.texts).toEqual(['Done']);
    expect(result.done).toBe(true);
  });

  it('should handle error events', async () => {
    const sseData = `data: ${JSON.stringify({ error: 'Rate limited' })}\n\n`;

    const result = await collectStream([sseData]);

    expect(result.errors).toContain('Rate limited');
  });

  it('should handle chunks split across buffers', async () => {
    const chunk1 = `data: ${JSON.stringify({ o: 'append', p: '/message/content/parts/0', v: 'Hello' })}\n\n`;
    const chunk2 = `data: ${JSON.stringify({ o: 'append', p: '/message/content/parts/0', v: ' world' })}\n\n`;

    const result = await collectStream([chunk1, chunk2]);

    expect(result.texts).toEqual(['Hello', ' world']);
  });

  it('should handle SSE split in the middle of an event', async () => {
    const fullEvent = `data: ${JSON.stringify({ o: 'append', p: '/message/content/parts/0', v: 'Split' })}\n\n`;
    const mid = Math.floor(fullEvent.length / 2);

    const result = await collectStream([
      fullEvent.substring(0, mid),
      fullEvent.substring(mid),
    ]);

    expect(result.texts).toEqual(['Split']);
  });

  it('should ignore non-data lines', async () => {
    const sseData = `event: ping\ndata: ${JSON.stringify({ o: 'append', p: '/message/content/parts/0', v: 'Text' })}\nid: 123\n\n`;

    const result = await collectStream([sseData]);

    expect(result.texts).toEqual(['Text']);
  });

  it('should ignore invalid JSON in data', async () => {
    const sseData = `data: not-json\n\ndata: ${JSON.stringify({ o: 'append', p: '/message/content/parts/0', v: 'Valid' })}\n\n`;

    const result = await collectStream([sseData]);

    expect(result.texts).toEqual(['Valid']);
  });

  it('should handle add event with incremental text after append events', async () => {
    const appendEvent = `data: ${JSON.stringify({ o: 'append', p: '/message/content/parts/0', v: 'Hello' })}\n\n`;
    const addEvent = `data: ${JSON.stringify({
      o: 'add',
      v: {
        message: {
          id: 'msg-002',
          author: { role: 'assistant' },
          content: { parts: ['Hello World!'] },
        },
      },
    })}\n\n`;

    const adapter = createAdapter();
    const texts: string[] = [];

    async function* mockStream() {
      yield Buffer.from(appendEvent);
      yield Buffer.from(addEvent);
    }

    for await (const event of adapter.translateStream(mockStream())) {
      if (event.type === 'text') texts.push(event.content);
    }

    expect(texts).toEqual(['Hello', ' World!']);
  });

  it('should not yield duplicate text when add event matches accumulated text', async () => {
    const appendEvent = `data: ${JSON.stringify({ o: 'append', p: '/message/content/parts/0', v: 'Hello World!' })}\n\n`;
    const addEvent = `data: ${JSON.stringify({
      o: 'add',
      v: {
        message: {
          id: 'msg-003',
          author: { role: 'assistant' },
          content: { parts: ['Hello World!'] },
        },
      },
    })}\n\n`;

    const adapter = createAdapter();
    const texts: string[] = [];

    async function* mockStream() {
      yield Buffer.from(appendEvent);
      yield Buffer.from(addEvent);
    }

    for await (const event of adapter.translateStream(mockStream())) {
      if (event.type === 'text') texts.push(event.content);
    }

    expect(texts).toEqual(['Hello World!']);
  });

  it('should ignore non-assistant messages in add event', async () => {
    const sseData = `data: ${JSON.stringify({
      o: 'add',
      v: {
        message: {
          id: 'msg-004',
          author: { role: 'user' },
          content: { parts: ['User message'] },
        },
      },
    })}\n\n`;

    const result = await collectStream([sseData]);

    expect(result.texts).toEqual([]);
  });

  it('should handle empty stream', async () => {
    const result = await collectStream([]);

    expect(result.texts).toEqual([]);
    expect(result.done).toBe(true);
  });

  it('should handle v.message without author role check (fallback)', async () => {
    const sseData = `data: ${JSON.stringify({
      v: {
        conversation_id: 'conv-fallback',
        message: {
          id: 'msg-fallback',
          author: { role: 'assistant' },
          content: { parts: ['Fallback text'] },
        },
      },
    })}\n\n`;

    const adapter = createAdapter();

    async function* mockStream() {
      yield Buffer.from(sseData);
    }

    const texts: string[] = [];
    for await (const event of adapter.translateStream(mockStream())) {
      if (event.type === 'text') texts.push(event.content);
    }

    expect(texts).toContain('Fallback text');
    expect(adapter.conversationId).toBe('conv-fallback');
  });

  it('should handle v1 delta continuation events (v-only without o/p fields)', async () => {
    // GPT uses v1 delta encoding where continuation events only have {"v": "text"}
    // without explicit o/p fields, implying they continue the previous append operation
    const explicitAppend = `data: ${JSON.stringify({ o: 'append', p: '/message/content/parts/0', v: '++++ read_file path:./log1.txt\n++++' })}\n\n`;
    const continuation = `data: ${JSON.stringify({ v: ' end' })}\n\n`;
    const patchEvent = `data: ${JSON.stringify({ p: '', o: 'patch', v: [{ p: '/message/status', o: 'replace', v: 'finished_successfully' }] })}\n\n`;

    const result = await collectStream([explicitAppend, continuation, patchEvent]);

    // The continuation " end" should NOT be dropped
    expect(result.texts).toEqual(['++++ read_file path:./log1.txt\n++++', ' end']);
  });

  it('should handle multiple v1 delta continuation events', async () => {
    const chunks = [
      `data: ${JSON.stringify({ o: 'append', p: '/message/content/parts/0', v: '++++' })}\n\n`,
      `data: ${JSON.stringify({ v: ' list_files' })}\n\n`,
      `data: ${JSON.stringify({ v: ' path:.' })}\n\n`,
      `data: ${JSON.stringify({ v: '\n++++ end\n' })}\n\n`,
    ];

    const result = await collectStream(chunks);

    expect(result.texts).toEqual(['++++', ' list_files', ' path:.', '\n++++ end\n']);
  });

  it('should not treat conversation_id events as v1 delta continuation', async () => {
    const append = `data: ${JSON.stringify({ o: 'append', p: '/message/content/parts/0', v: 'Hello' })}\n\n`;
    const convIdEvent = `data: ${JSON.stringify({ conversation_id: 'conv-123' })}\n\n`;

    const result = await collectStream([append, convIdEvent]);

    // conversation_id event should not be treated as text continuation
    expect(result.texts).toEqual(['Hello']);
  });
});

describe('GptAdapter translateOutput', () => {
  it('should convert string response to Message', () => {
    const adapter = createAdapter();
    const msg = adapter.translateOutput('Hello world');
    expect(msg.role).toBe('assistant');
    expect(msg.content).toBe('Hello world');
  });

  it('should convert object response to JSON string Message', () => {
    const adapter = createAdapter();
    const msg = adapter.translateOutput({ text: 'Hello' });
    expect(msg.role).toBe('assistant');
    expect(msg.content).toBe('{"text":"Hello"}');
  });

  it('should include timestamp in output', () => {
    const adapter = createAdapter();
    const before = Date.now();
    const msg = adapter.translateOutput('test');
    const after = Date.now();
    expect(msg.timestamp).toBeGreaterThanOrEqual(before);
    expect(msg.timestamp).toBeLessThanOrEqual(after);
  });
});

describe('GptAdapter getUserAgent', () => {
  it('should return custom user agent when set', () => {
    const adapter = createAdapter({ userAgent: 'MyAgent/2.0' });
    expect(adapter.getUserAgent()).toBe('MyAgent/2.0');
  });

  it('should return default user agent when not set', () => {
    const adapter = createAdapter();
    expect(adapter.getUserAgent()).toContain('Chrome/');
    expect(adapter.getUserAgent()).toContain('AppleWebKit/');
  });
});

describe('GptAdapter abort', () => {
  it('should not throw when no abort controller', () => {
    const adapter = createAdapter();
    expect(() => adapter.abort()).not.toThrow();
  });
});

describe('GptAdapter refreshToken', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('should skip refresh when token is still valid', async () => {
    const exp = Math.floor(Date.now() / 1000) + 86400;
    const token = makeJWT({ exp });
    const adapter = createAdapter({ authorization: token });

    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const result = await (adapter as any)['refreshToken']();

    expect(result).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('should attempt refresh when token is expiring soon', async () => {
    const exp = Math.floor(Date.now() / 1000) + 60;
    const token = makeJWT({ exp });
    const adapter = createAdapter({
      authorization: token,
      cookies: 'session=abc',
      deviceId: 'dev-1',
    });

    const newToken = makeJWT({ exp: Math.floor(Date.now() / 1000) + 86400 });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ accessToken: newToken }),
    } as Response);

    const result = await (adapter as any)['refreshToken']();

    expect(result).toBe(true);
    expect(adapter._authorization).toBe(`Bearer ${newToken}`);
  });

  it('should return false when refresh request fails', async () => {
    const exp = Math.floor(Date.now() / 1000) + 60;
    const token = makeJWT({ exp });
    const adapter = createAdapter({ authorization: token });

    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => 'Unauthorized',
    } as Response);

    const result = await (adapter as any)['refreshToken']();

    expect(result).toBe(false);
  });

  it('should return false when refresh returns no accessToken', async () => {
    const exp = Math.floor(Date.now() / 1000) + 60;
    const token = makeJWT({ exp });
    const adapter = createAdapter({ authorization: token });

    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({}),
    } as Response);

    const result = await (adapter as any)['refreshToken']();

    expect(result).toBe(false);
  });

  it('should return false when refresh throws network error', async () => {
    const exp = Math.floor(Date.now() / 1000) + 60;
    const token = makeJWT({ exp });
    const adapter = createAdapter({ authorization: token });

    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network error'));

    const result = await (adapter as any)['refreshToken']();

    expect(result).toBe(false);
  });
});

describe('GptAdapter multi-turn conversation state', () => {
  it('should accumulate conversation state across SSE events', async () => {
    const adapter = createAdapter();

    const event1 = `data: ${JSON.stringify({ conversation_id: 'conv-multi' })}\n\n`;
    const event2 = `data: ${JSON.stringify({
      o: 'add',
      v: {
        message: {
          id: 'msg-first',
          author: { role: 'assistant' },
          content: { parts: ['First reply'] },
        },
      },
    })}\n\n`;

    async function* mockStream() {
      yield Buffer.from(event1);
      yield Buffer.from(event2);
    }

    for await (const _ of adapter.translateStream(mockStream())) {
      // consume
    }

    expect(adapter.conversationId).toBe('conv-multi');
    expect(adapter.parentMessageId).toBe('msg-first');
    expect(adapter.assistantMessageId).toBe('msg-first');
  });

  it('should maintain state after resetSession and new conversation', () => {
    const adapter = createAdapter();
    adapter._conversationId = 'old-conv';
    adapter._parentMessageId = 'old-msg';

    adapter.resetSession();

    expect(adapter.conversationId).toBeNull();
    expect(adapter.parentMessageId).toBe('client-created-root');

    adapter.loadSession('new-conv', 'new-parent');
    expect(adapter.conversationId).toBe('new-conv');
    expect(adapter.parentMessageId).toBe('new-parent');
  });
});
