import { describe, it, expect } from 'vitest';
import { DevecoAdapter } from './deveco-adapter.js';

/** 构造一个产生给定 UTF-8 分块的 async iterable。 */
async function* chunkedStream(pieces: string[], splitEvery = 2): AsyncIterable<Buffer> {
  for (const piece of pieces) {
    for (let i = 0; i < piece.length; i += splitEvery) {
      yield Buffer.from(piece.slice(i, i + splitEvery), 'utf-8');
    }
  }
}

async function collect(stream: AsyncIterable<Buffer>): Promise<{
  texts: string[];
  thinkings: string[];
  toolCalls: Array<{ name: string; parameters: Record<string, unknown> }>;
  done: boolean;
}> {
  const out = { texts: [], thinkings: [], toolCalls: [], done: false } as any;
  const adapter = new DevecoAdapter();
  for await (const ev of adapter.translateStream(stream)) {
    if (ev.type === 'text') out.texts.push(ev.content);
    else if (ev.type === 'thinking') out.thinkings.push(ev.content);
    else if (ev.type === 'tool_call' && ev.toolCall) out.toolCalls.push({ name: ev.toolCall.name, parameters: ev.toolCall.parameters });
    else if (ev.type === 'done') out.done = true;
  }
  // 校验 history 与 pending 队列（运行时访问私有字段便于断言）
  out.history = (adapter as any).conversationHistory;
  out.pending = (adapter as any).pendingToolCallIdQueue;
  return out;
}

const doneSse = 'data: [DONE]\n\n';

describe('DevecoAdapter translateStream — 工具调用健壮性回归', () => {
  it('普通文本流（LF 分隔）应产出 text 并最终 done', async () => {
    const sse = 'data: {"choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}\n\n'
      + 'data: {"choices":[{"delta":{"content":" world"},"finish_reason":"stop"}]}\n\n'
      + doneSse;
    const out = await collect(chunkedStream([sse]));
    expect(out.texts.join('')).toBe('Hello world');
    expect(out.done).toBe(true);
    expect(out.toolCalls.length).toBe(0);
  });

  it('原生 tool_calls（LF + [DONE]）应产出 tool_call 块并填充 pending 队列', async () => {
    const sse =
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read_file","arguments":"{\\"path\\":\\"./a.ts\\"}"}}]},"finish_reason":null}]}\n\n'
      + 'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n'
      + doneSse;
    const out = await collect(chunkedStream([sse]));
    expect(out.toolCalls.length).toBe(1);
    expect(out.toolCalls[0].name).toBe('read_file');
    expect(out.toolCalls[0].parameters).toEqual({ path: './a.ts' });
    expect(out.done).toBe(true);
    // assistant 消息带 tool_calls，且 pending 队列填了 id
    expect(out.pending).toContain('call_1');
    const last = out.history[out.history.length - 1];
    expect(last.role).toBe('assistant');
    expect(last.tool_calls?.[0]?.id).toBe('call_1');
  });

  it('CRLF 分隔（\\r\\n\\r\\n）的 tool_calls 也应被解析（此前会全部落入残余分支丢失）', async () => {
    const sse =
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c2","function":{"name":"grep_search","arguments":"{\\"pattern\\":\\"TODO\\"}"}}]},"finish_reason":null}]}\r\n\r\n'
      + 'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\r\n\r\n'
      + 'data: [DONE]\r\n\r\n';
    const out = await collect(chunkedStream([sse]));
    expect(out.toolCalls.length).toBe(1);
    expect(out.toolCalls[0].name).toBe('grep_search');
    expect(out.toolCalls[0].parameters).toEqual({ pattern: 'TODO' });
    expect(out.done).toBe(true);
  });

  it('流在 finish_reason 之后直接结束、无 [DONE]：tool_calls 仍应产出（此前丢失）', async () => {
    const sse =
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c3","function":{"name":"list_files","arguments":"{\\"path\\":\\".\\"}"}}]},"finish_reason":null}]}\n\n'
      + 'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}'; // 没有结尾空行、没有 [DONE]
    const out = await collect(chunkedStream([sse]));
    expect(out.toolCalls.length).toBe(1);
    expect(out.toolCalls[0].name).toBe('list_files');
    expect(out.done).toBe(true);
  });

  it('服务器异常截断、从未发送 finish_reason/[DONE]：已积累的 tool_call 兜底产出（此前丢失）', async () => {
    const sse =
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c4","function":{"name":"read_file","arguments":"{\\"path\\":\\"./b.ts\\"}"}}]},"finish_reason":null}]}\n\n'
      + 'data: {"choices":[{"delta":{},"finish_reason":null}]}';
    const out = await collect(chunkedStream([sse]));
    expect(out.toolCalls.length).toBe(1);
    expect(out.toolCalls[0].name).toBe('read_file');
    expect(out.done).toBe(true);
    expect(out.pending).toContain('c4');
  });

  it('多字节 UTF-8 跨 chunk 切断 + 事件跨 chunk 拆分不应乱码或丢块', async () => {
  const sse =
  'data: {"choices":[{"delta":{"content":"中文😀"},"finish_reason":null}]}\n\n'
  + 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n'
  + doneSse;
  // 按字节切分 Buffer（真实模拟 TCP 分片，多字节字符可能被从中间切开）
  const buf = Buffer.from(sse, 'utf-8');
  async function* byteChunks(): AsyncIterable<Buffer> {
  for (let i = 0; i < buf.length; i += 3) {
  yield buf.subarray(i, i + 3);
  }
  }
  const out = await collect(byteChunks());
  expect(out.texts.join('')).toBe('中文😀');
  expect(out.done).toBe(true);
  });
});

// ── reasoning 字段兼容性（reasoning_content / reasoning 双格式） ──────────────

describe('DevecoAdapter translateStream — reasoning 字段兼容', () => {
  it('delta.reasoning_content（华为默认端点格式）应产出 thinking 并持久化', async () => {
    const sse =
      'data: {"choices":[{"delta":{"reasoning_content":"GLM thinking"},"finish_reason":null}]}\n\n'
      + 'data: {"choices":[{"delta":{"content":"answer"},"finish_reason":"stop"}]}\n\n'
      + doneSse;
    const out = await collect(chunkedStream([sse]));
    expect(out.thinkings).toEqual(['GLM thinking']);
    expect(out.texts.join('')).toBe('answer');
    // 持久化到 history：用 <think> 标签包裹拼在 content 前
    const last = out.history[out.history.length - 1];
    expect(last.content).toContain('<think>');
    expect(last.content).toContain('GLM thinking');
    expect(last.content).toContain('</think>');
  });

  it('delta.reasoning（OpenRouter 格式，baseUrl 被覆盖时）也应产出 thinking', async () => {
    const sse =
      'data: {"choices":[{"delta":{"reasoning":"OpenRouter-style thinking"},"finish_reason":null}]}\n\n'
      + 'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n'
      + doneSse;
    const out = await collect(chunkedStream([sse]));
    expect(out.thinkings).toEqual(['OpenRouter-style thinking']);
    expect(out.texts.join('')).toBe('ok');
    const last = out.history[out.history.length - 1];
    expect(last.content).toContain('<think>');
    expect(last.content).toContain('OpenRouter-style thinking');
  });

  it('两种字段同时存在时 reasoning_content 优先', async () => {
    const sse =
      'data: {"choices":[{"delta":{"reasoning_content":"from_rc","reasoning":"from_or"},"finish_reason":null}]}\n\n'
      + doneSse;
    const out = await collect(chunkedStream([sse]));
    expect(out.thinkings).toEqual(['from_rc']);
  });
});
