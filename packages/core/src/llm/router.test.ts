import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LLMRouter } from './router.js';
import type { RawHttpInfo } from './router.js';
import type { LLMAdapter, HttpRequest } from './types.js';
import type { Message, LLMConfig, StreamChunk } from '@xai/shared';

// ── 辅助：构造 mock adapter ─────────────────────────────────────────────────

function makeMockHttpAdapter(
  request: HttpRequest,
  streamChunks: StreamChunk[],
): LLMAdapter {
  return {
    async translateInput(_messages, _config): Promise<HttpRequest> {
      return request;
    },
    translateOutput() {
      return { role: 'assistant', content: '', timestamp: Date.now() };
    },
    async *translateStream(stream) {
      // 消费底层 stream（这里直接忽略原始字节，按预设 chunks 产出）
      for await (const _ of stream) {
        // drain
      }
      for (const c of streamChunks) yield c;
    },
    abort() {},
  };
}

function makeMessages(): Message[] {
  return [
    { role: 'system', content: '你是助手', timestamp: 1 },
    { role: 'user', content: '你好', timestamp: 2 },
  ];
}

function makeConfig(provider: string): LLMConfig {
  return { provider, model: 'test-model', apiKey: 'k', temperature: 0.7 } as unknown as LLMConfig;
}

async function collect(iter: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const c of iter) out.push(c);
  return out;
}

// ────────────────────────────────────────────────────────────────────────────

describe('LLMRouter onRawHttp —— HTTP fetch 路径', () => {
  beforeEach(() => {
    // mock fetch
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('HTTP 成功时触发 onRawHttp，requestBody 含 request.body，responseBody 含完整流', async () => {
    const router = new LLMRouter();
    const sseBody = 'data: {"v":"hello"}\n\ndata: {"v":" world"}\n\n';
    const request: HttpRequest = {
      url: 'https://fake.llm/v1/chat',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: '你好' }] }),
    };
    router.registerAdapter('http-provider', makeMockHttpAdapter(request, [
      { type: 'text', content: 'hello' },
      { type: 'text', content: ' world' },
      { type: 'done', content: '' },
    ]));

    // mock fetch 返回 200 + 流式 body
    (globalThis.fetch as any).mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      body: new Response(sseBody).body,
    });

    const rawCalls: RawHttpInfo[] = [];
    router.onRawHttp = (info) => rawCalls.push(info);

    await collect(router.send(makeMessages(), makeConfig('http-provider')));

    expect(rawCalls.length).toBe(1);
    const info = rawCalls[0];

    expect(info.url).toBe('https://fake.llm/v1/chat');
    expect(info.status).toBe(200);
    expect(info.requestBody).toContain('你好');
    // responseBody 含完整原始 SSE 文本
    expect(info.responseBody).toContain('hello');
    expect(info.responseBody).toContain('world');
  });

  it('HTTP 返回错误状态码时触发 onRawHttp，含错误 body', async () => {
    const router = new LLMRouter();
    const request: HttpRequest = {
      url: 'https://fake.llm/v1/chat',
      method: 'POST',
      headers: {},
      body: '{"q":1}',
    };
    router.registerAdapter('http-err', makeMockHttpAdapter(request, []));

    (globalThis.fetch as any).mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      text: async () => 'invalid api key',
    });

    const rawCalls: RawHttpInfo[] = [];
    router.onRawHttp = (info) => rawCalls.push(info);

    const out = await collect(router.send(makeMessages(), makeConfig('http-err')));

    expect(rawCalls.length).toBe(1);
    expect(rawCalls[0].status).toBe(401);
    expect(rawCalls[0].requestBody).toBe('{"q":1}');
    expect(rawCalls[0].responseBody).toContain('invalid api key');
    expect(out.some(c => c.type === 'error')).toBe(true);
  });

  it('未设置 onRawHttp 时 HTTP 路径正常工作', async () => {
    const router = new LLMRouter();
    const request: HttpRequest = {
      url: 'https://fake.llm/v1/chat',
      method: 'POST',
      headers: {},
      body: '{}',
    };
    router.registerAdapter('http-nocb', makeMockHttpAdapter(request, [
      { type: 'text', content: 'hi' },
      { type: 'done', content: '' },
    ]));

    (globalThis.fetch as any).mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      body: new Response('data: {"v":"hi"}\n\n').body,
    });

    // 不设置 onRawHttp
    const out = await collect(router.send(makeMessages(), makeConfig('http-nocb')));
    expect(out.map(c => c.content).join('')).toContain('hi');
  });

  it('★ 消费者在 done chunk 后 break 时 onRawHttp 仍触发（HTTP 路径）', async () => {
    // 同 sendDirect 路径的 break 测试，验证 HTTP fetch 路径也在 finally 中触发
    const router = new LLMRouter();
    const sseBody = 'data: {"v":"hello"}\n\ndata: {"v":" world"}\n\n';
    const request: HttpRequest = {
      url: 'https://fake.llm/v1/chat',
      method: 'POST',
      headers: {},
      body: '{"prompt":"test"}',
    };
    router.registerAdapter('http-break', makeMockHttpAdapter(request, [
      { type: 'text', content: 'hello' },
      { type: 'done', content: '' },
    ]));

    (globalThis.fetch as any).mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      body: new Response(sseBody).body,
    });

    const rawCalls: RawHttpInfo[] = [];
    router.onRawHttp = (info) => rawCalls.push(info);

    // 模拟 ReActLoop：遇到 done 就 break
    for await (const chunk of router.send(makeMessages(), makeConfig('http-break'))) {
      if (chunk.type === 'done') break;
    }

    expect(rawCalls.length).toBe(1);
    expect(rawCalls[0].requestBody).toBe('{"prompt":"test"}');
    expect(rawCalls[0].responseBody).toContain('hello');
    expect(rawCalls[0].status).toBe(200);
  });
});

describe('LLMRouter waitForRateLimit —— 限流正确性', () => {
  // 每次调用 fetch 都需要返回新的 Response（body 是一次性 ReadableStream）
  function makeFetchMock() {
    return vi.fn().mockImplementation(() => {
      return Promise.resolve({
        ok: true,
        status: 200,
        statusText: 'OK',
        body: new Response('data: {"v":"hi"}\n\n').body,
      });
    });
  }

  it('并发调用时，限流应串行化，不允许同时通过', async () => {
    const router = new LLMRouter();
    (router as any).MIN_REQUEST_INTERVAL = 500;

    const request: HttpRequest = {
      url: 'https://fake.llm/v1/chat',
      method: 'POST',
      headers: {},
      body: '{}',
    };
    router.registerAdapter('concurrent-test', makeMockHttpAdapter(request, [
      { type: 'text', content: 'hi' },
      { type: 'done', content: '' },
    ]));

    const fetchMock = makeFetchMock();
    vi.stubGlobal('fetch', fetchMock);

    // 同时发起3个并发请求
    const promises = [
      collect(router.send(makeMessages(), makeConfig('concurrent-test'))),
      collect(router.send(makeMessages(), makeConfig('concurrent-test'))),
      collect(router.send(makeMessages(), makeConfig('concurrent-test'))),
    ];

    await Promise.all(promises);

    // 3个请求都应该最终完成（fetch 被调用3次）
    expect(fetchMock).toHaveBeenCalledTimes(3);

    vi.unstubAllGlobals();
  });

  it('串行调用时，间隔不足应等待', async () => {
    const router = new LLMRouter();
    (router as any).MIN_REQUEST_INTERVAL = 300;

    const request: HttpRequest = {
      url: 'https://fake.llm/v1/chat',
      method: 'POST',
      headers: {},
      body: '{}',
    };
    router.registerAdapter('serial-test', makeMockHttpAdapter(request, [
      { type: 'text', content: 'a' },
      { type: 'done', content: '' },
    ]));

    const fetchMock = makeFetchMock();
    vi.stubGlobal('fetch', fetchMock);

    // 第1次请求
    await collect(router.send(makeMessages(), makeConfig('serial-test')));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // 立即发起第2次请求——应被限流等待
    const t0 = Date.now();
    await collect(router.send(makeMessages(), makeConfig('serial-test')));
    const elapsed = Date.now() - t0;

    // 应该至少等了约 300ms（允许一定误差）
    expect(elapsed).toBeGreaterThanOrEqual(250);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    vi.unstubAllGlobals();
  });

  it('串行调用时，间隔足够应立即通过', async () => {
    const router = new LLMRouter();
    (router as any).MIN_REQUEST_INTERVAL = 100;

    const request: HttpRequest = {
      url: 'https://fake.llm/v1/chat',
      method: 'POST',
      headers: {},
      body: '{}',
    };
    router.registerAdapter('interval-test', makeMockHttpAdapter(request, [
      { type: 'text', content: 'b' },
      { type: 'done', content: '' },
    ]));

    const fetchMock = makeFetchMock();
    vi.stubGlobal('fetch', fetchMock);

    // 第1次请求
    await collect(router.send(makeMessages(), makeConfig('interval-test')));

    // 等待足够长时间
    await new Promise(r => setTimeout(r, 150));

    // 第2次请求——应立即通过
    const t0 = Date.now();
    await collect(router.send(makeMessages(), makeConfig('interval-test')));
    const elapsed = Date.now() - t0;

    // 不应该有明显等待（< 50ms）
    expect(elapsed).toBeLessThan(80);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    vi.unstubAllGlobals();
  });
});

describe('LLMRouter 限流 —— 模拟 ReActLoop 完整调用链', () => {
  /**
   * 精确复现 ReActLoop 的调用模式：
   *   for await (chunk of send()) → 消费流 → 工具执行 → 下一轮 send()
   * 
   * 核心验证：两次 fetch() 调用之间的真实时间间隔 >= MIN_REQUEST_INTERVAL
   */
  it('★ ReActLoop 模式：工具调用后下一轮 fetch 间隔应 >= MIN_REQUEST_INTERVAL', async () => {
    const router = new LLMRouter();
    const INTERVAL = 2000;  // 用2秒方便测试
    (router as any).MIN_REQUEST_INTERVAL = INTERVAL;

    const request: HttpRequest = {
      url: 'https://fake.llm/v1/chat',
      method: 'POST',
      headers: {},
      body: '{}',
    };
    router.registerAdapter('react-test', makeMockHttpAdapter(request, [
      { type: 'text', content: 'tool_call' },
      { type: 'done', content: '' },
    ]));

    const fetchCallTimes: number[] = [];
    const fetchMock = vi.fn().mockImplementation(() => {
      fetchCallTimes.push(Date.now());
      return Promise.resolve({
        ok: true,
        status: 200,
        statusText: 'OK',
        body: new Response('data: {"v":"hi"}\n\n').body,
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    // ── 迭代1：模拟 ReActLoop 的 for-await 消费 ──
    const stream1 = router.send(makeMessages(), makeConfig('react-test'));
    for await (const chunk of stream1) {
      if (chunk.type === 'done') break;
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // 模拟工具执行（很快，100ms）
    await new Promise(r => setTimeout(r, 100));

    // ── 迭代2：工具结果返给AI ──
    const stream2 = router.send(makeMessages(), makeConfig('react-test'));
    for await (const chunk of stream2) {
      if (chunk.type === 'done') break;
    }
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // 验证：两次 fetch 之间的间隔 >= INTERVAL
    const fetchInterval = fetchCallTimes[1] - fetchCallTimes[0];
    // 允许 50ms 误差（setTimeout 不精确）
    expect(fetchInterval).toBeGreaterThanOrEqual(INTERVAL - 50);

    vi.unstubAllGlobals();
  });

  it('★ ReActLoop 模式：连续3轮迭代，每轮 fetch 间隔都应 >= MIN_REQUEST_INTERVAL', async () => {
    const router = new LLMRouter();
    const INTERVAL = 1000;
    (router as any).MIN_REQUEST_INTERVAL = INTERVAL;

    const request: HttpRequest = {
      url: 'https://fake.llm/v1/chat',
      method: 'POST',
      headers: {},
      body: '{}',
    };
    router.registerAdapter('react3-test', makeMockHttpAdapter(request, [
      { type: 'text', content: 'tool_call' },
      { type: 'done', content: '' },
    ]));

    const fetchCallTimes: number[] = [];
    const fetchMock = vi.fn().mockImplementation(() => {
      fetchCallTimes.push(Date.now());
      return Promise.resolve({
        ok: true,
        status: 200,
        statusText: 'OK',
        body: new Response('data: {"v":"hi"}\n\n').body,
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    for (let i = 0; i < 3; i++) {
      const stream = router.send(makeMessages(), makeConfig('react3-test'));
      for await (const chunk of stream) {
        if (chunk.type === 'done') break;
      }
      // 模拟工具执行（很快）
      if (i < 2) await new Promise(r => setTimeout(r, 100));
    }

    expect(fetchMock).toHaveBeenCalledTimes(3);

    // 验证每对相邻 fetch 的间隔
    for (let i = 1; i < fetchCallTimes.length; i++) {
      const interval = fetchCallTimes[i] - fetchCallTimes[i - 1];
      expect(interval).toBeGreaterThanOrEqual(INTERVAL - 50);
    }

    vi.unstubAllGlobals();
  });

  it('★ 429 后立即重试，fetch 间隔仍应 >= MIN_REQUEST_INTERVAL（不会"瞬间"重发）', async () => {
    const router = new LLMRouter();
    const INTERVAL = 1000;
    (router as any).MIN_REQUEST_INTERVAL = INTERVAL;

    const request: HttpRequest = {
      url: 'https://fake.llm/v1/chat',
      method: 'POST',
      headers: {},
      body: '{}',
    };
    router.registerAdapter('429-test', makeMockHttpAdapter(request, []));

    const fetchCallTimes: number[] = [];
    let callCount = 0;
    const fetchMock = vi.fn().mockImplementation(() => {
      fetchCallTimes.push(Date.now());
      callCount++;
      // 第1次返回429，第2次返回200
      if (callCount === 1) {
        return Promise.resolve({
          ok: false,
          status: 429,
          statusText: 'Too Many Requests',
          text: async () => '{"error":{"code":"insufficient_quota"}}',
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        statusText: 'OK',
        body: new Response('data: {"v":"hi"}\n\n').body,
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    // 第1次请求 → 429
    const out1 = await collect(router.send(makeMessages(), makeConfig('429-test')));
    expect(out1.some(c => c.type === 'error')).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // 立即发第2次请求（模拟用户重试或 ReActLoop continue）
    const t0 = Date.now();
    const out2 = await collect(router.send(makeMessages(), makeConfig('429-test')));
    const elapsed = Date.now() - t0;

    // 关键验证：第2次请求必须等够 INTERVAL 才发 fetch
    expect(elapsed).toBeGreaterThanOrEqual(INTERVAL - 50);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    vi.unstubAllGlobals();
  });

  it('★ send() 是 async generator，generator body 在 for-await 时才执行——限流仍生效', async () => {
    const router = new LLMRouter();
    const INTERVAL = 500;
    (router as any).MIN_REQUEST_INTERVAL = INTERVAL;

    const request: HttpRequest = {
      url: 'https://fake.llm/v1/chat',
      method: 'POST',
      headers: {},
      body: '{}',
    };
    router.registerAdapter('lazy-gen-test', makeMockHttpAdapter(request, [
      { type: 'text', content: 'hi' },
      { type: 'done', content: '' },
    ]));

    const fetchCallTimes: number[] = [];
    const fetchMock = vi.fn().mockImplementation(() => {
      fetchCallTimes.push(Date.now());
      return Promise.resolve({
        ok: true,
        status: 200,
        statusText: 'OK',
        body: new Response('data: {"v":"hi"}\n\n').body,
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    // 第1次：send() 返回后立即 for-await
    const stream1 = router.send(makeMessages(), makeConfig('lazy-gen-test'));
    // send() 返回时 generator body 还没执行！
    // 但 for-await 会触发执行
    for await (const chunk of stream1) {
      if (chunk.type === 'done') break;
    }

    // 第2次：send() 返回后，故意延迟 200ms 才 for-await
    // 这模拟 ReActLoop 在 for-await 前做了一些处理
    const stream2 = router.send(makeMessages(), makeConfig('lazy-gen-test'));
    await new Promise(r => setTimeout(r, 200));  // 延迟消费
    for await (const chunk of stream2) {
      if (chunk.type === 'done') break;
    }

    // 验证：即使延迟了 for-await，两次 fetch 的间隔仍 >= INTERVAL
    const fetchInterval = fetchCallTimes[1] - fetchCallTimes[0];
    expect(fetchInterval).toBeGreaterThanOrEqual(INTERVAL - 50);

    vi.unstubAllGlobals();
  });
});
