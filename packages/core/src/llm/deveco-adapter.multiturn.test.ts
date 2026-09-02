import { describe, it, expect } from 'vitest';
import { DevecoAdapter } from './deveco-adapter.js';
import type { Message, LLMConfig } from '@xai/shared';

const FAKE_TOKEN = 'test-token-for-multiturn';

/**
 * 模拟 GLM API 的多轮工具调用流式响应。
 * 验证：第 2 轮（工具结果反馈后）是否仍然产出 reasoning_content。
 */
function makeSseChunks(events: Array<Record<string, unknown>>): Buffer {
  const lines = events.map(e => `data: ${JSON.stringify(e)}\n`);
  lines.push('data: [DONE]\n');
  return Buffer.from(lines.join('\n'), 'utf-8');
}

function makeConfig(): LLMConfig {
  return {
    provider: 'deveco',
    model: 'glm-5.1',
    temperature: 0.7,
    stream: true,
  };
}

async function collectStream(adapter: DevecoAdapter, sseBuffer: Buffer) {
  const texts: string[] = [];
  const thinkings: string[] = [];
  const toolCalls: Array<{ name: string; parameters: Record<string, unknown> }> = [];
  let done = false;

  async function* mockStream() {
    yield sseBuffer;
  }

  for await (const ev of adapter.translateStream(mockStream())) {
    if (ev.type === 'text') texts.push(ev.content);
    else if (ev.type === 'thinking') thinkings.push(ev.content);
    else if (ev.type === 'tool_call' && ev.toolCall) toolCalls.push({ name: ev.toolCall.name, parameters: ev.toolCall.parameters });
    else if (ev.type === 'done') done = true;
  }

  return { texts, thinkings, toolCalls, done };
}

describe('DevecoAdapter 多轮工具调用 — reasoning 持久化验证', () => {
  it('第 1 轮：产出 reasoning + tool_call，reasoning 存入 history 的 reasoning_content 字段', async () => {
    const adapter = new DevecoAdapter({ accessToken: FAKE_TOKEN });
    const messages: Message[] = [
      { role: 'system', content: 'You are a helpful assistant.', timestamp: 1 },
      { role: 'user', content: 'What files are in the current directory?', timestamp: 2 },
    ];
    const config = makeConfig();

    // 第 1 轮请求
    const req1 = await adapter.translateInput(messages, config);
    const body1 = JSON.parse(req1.body) as Record<string, unknown>;

    // 不设置 thinking 参数（对齐 deveco 源码）
    expect(body1['thinking']).toBeUndefined();

    // 第 1 轮响应：reasoning + tool_call
    const sse1 = makeSseChunks([
      { choices: [{ delta: { reasoning_content: 'I need to list files' }, finish_reason: null }] },
      { choices: [{ delta: { reasoning_content: ' using list_files tool' }, finish_reason: null }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'list_files', arguments: '{"path":"."}' } }] }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ]);

    const out1 = await collectStream(adapter, sse1);

    // 验证第 1 轮产出了 thinking
    expect(out1.thinkings.join('')).toBe('I need to list files using list_files tool');
    expect(out1.toolCalls.length).toBe(1);
    expect(out1.toolCalls[0].name).toBe('list_files');

    // 验证 reasoning 用 <think> 标签拼入了 content（而非独立 reasoning_content 字段）
    const history = (adapter as unknown as { conversationHistory: Array<Record<string, unknown>> }).conversationHistory;
    const assistantMsg = history.find(m => m.role === 'assistant');
    expect(assistantMsg).toBeDefined();
    const content1 = assistantMsg!.content as string;
    expect(content1).toContain('<think>');
    expect(content1).toContain('I need to list files using list_files tool');
    expect(content1).toContain('</think>');
    // 不应有独立的 reasoning_content 字段
    expect(assistantMsg!.reasoning_content).toBeUndefined();
  });

  it('第 2 轮：工具结果反馈后，请求携带 reasoning_content，且响应仍产出新 reasoning', async () => {
    const adapter = new DevecoAdapter({ accessToken: FAKE_TOKEN });
    const config = makeConfig();

    // 第 1 轮
    const messages1: Message[] = [
      { role: 'system', content: 'You are a helpful assistant.', timestamp: 1 },
      { role: 'user', content: 'What files are in the current directory?', timestamp: 2 },
    ];
    await adapter.translateInput(messages1, config);

    const sse1 = makeSseChunks([
      { choices: [{ delta: { reasoning_content: 'Round 1 thinking' }, finish_reason: null }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'list_files', arguments: '{"path":"."}' } }] }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ]);
    await collectStream(adapter, sse1);

    // 第 2 轮：传入工具结果
    const messages2: Message[] = [
      { role: 'tool', content: 'file1.ts\nfile2.ts\nREADME.md', toolName: 'list_files', toolResult: 'file1.ts\nfile2.ts\nREADME.md', timestamp: 3 },
    ];
    const req2 = await adapter.translateInput(messages2, config);
    const body2 = JSON.parse(req2.body) as Record<string, unknown>;
    const msgs2 = body2['messages'] as Array<Record<string, unknown>>;

    // ★ 关键验证 1：assistant 消息的 content 包含 <think> 标签和 reasoning 文本
    const assistantMsgs = msgs2.filter(m => m.role === 'assistant');
    expect(assistantMsgs.length).toBe(1);
    const c2 = assistantMsgs[0].content as string;
    expect(c2).toContain('<think>');
    expect(c2).toContain('Round 1 thinking');
    // 不应有独立的 reasoning_content 字段
    expect(assistantMsgs[0].reasoning_content).toBeUndefined();

    // ★ 关键验证 2：thinking 参数不设置
    expect(body2['thinking']).toBeUndefined();

    // 第 2 轮响应：应该产出新的 reasoning
    const sse2 = makeSseChunks([
      { choices: [{ delta: { reasoning_content: 'Round 2: I see the files' }, finish_reason: null }] },
      { choices: [{ delta: { content: 'The directory contains file1.ts, file2.ts, and README.md' }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ]);

    const out2 = await collectStream(adapter, sse2);

    // ★ 关键验证 3：第 2 轮产出了新的 thinking
    expect(out2.thinkings.join('')).toBe('Round 2: I see the files');
    expect(out2.texts.join('')).toContain('file1.ts');
    expect(out2.done).toBe(true);

    // 验证第 2 轮的 reasoning 也用标签存入了 history content
    const history = (adapter as unknown as { conversationHistory: Array<Record<string, unknown>> }).conversationHistory;
    const allAssistantMsgs = history.filter(m => m.role === 'assistant');
    expect(allAssistantMsgs.length).toBe(2);
    expect((allAssistantMsgs[0].content as string)).toContain('Round 1 thinking');
    expect((allAssistantMsgs[1].content as string)).toContain('Round 2: I see the files');
  });

  it('第 3 轮：连续工具调用，每轮都产出 reasoning', async () => {
    const adapter = new DevecoAdapter({ accessToken: FAKE_TOKEN });
    const config = makeConfig();

    // 第 1 轮：第一个工具调用
    await adapter.translateInput([
      { role: 'system', content: 'System', timestamp: 1 },
      { role: 'user', content: 'Read file1.ts and file2.ts', timestamp: 2 },
    ], config);

    const sse1 = makeSseChunks([
      { choices: [{ delta: { reasoning_content: 'Thinking round 1' }, finish_reason: null }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'read_file', arguments: '{"path":"file1.ts"}' } }] }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ]);
    await collectStream(adapter, sse1);

    // 第 2 轮：第一个工具结果 + 第二个工具调用
    await adapter.translateInput([
      { role: 'tool', content: 'content of file1', toolName: 'read_file', toolResult: 'content of file1', timestamp: 3 },
    ], config);

    const sse2 = makeSseChunks([
      { choices: [{ delta: { reasoning_content: 'Thinking round 2' }, finish_reason: null }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c2', function: { name: 'read_file', arguments: '{"path":"file2.ts"}' } }] }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ]);
    await collectStream(adapter, sse2);

    // 第 3 轮：第二个工具结果 + 最终回答
    const req3 = await adapter.translateInput([
      { role: 'tool', content: 'content of file2', toolName: 'read_file', toolResult: 'content of file2', timestamp: 4 },
    ], config);
    const body3 = JSON.parse(req3.body) as Record<string, unknown>;
    const msgs3 = body3['messages'] as Array<Record<string, unknown>>;

    // 验证两个 assistant 消息的 content 都包含各自的 reasoning 标签
    const assistantMsgs = msgs3.filter(m => m.role === 'assistant');
    expect(assistantMsgs.length).toBe(2);
    expect((assistantMsgs[0].content as string)).toContain('Thinking round 1');
    expect((assistantMsgs[1].content as string)).toContain('Thinking round 2');

    // thinking 参数不设置
    expect(body3['thinking']).toBeUndefined();

    // 第 3 轮响应
    const sse3 = makeSseChunks([
      { choices: [{ delta: { reasoning_content: 'Thinking round 3' }, finish_reason: null }] },
      { choices: [{ delta: { content: 'Both files have been read.' }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ]);
    const out3 = await collectStream(adapter, sse3);

    // ★ 第 3 轮也产出了 thinking
    expect(out3.thinkings.join('')).toBe('Thinking round 3');
    expect(out3.texts.join('')).toContain('Both files');

    // 最终 history 有 3 个 assistant 消息，各有 reasoning 标签在 content 中
    const history = (adapter as unknown as { conversationHistory: Array<Record<string, unknown>> }).conversationHistory;
    const allAssistant = history.filter(m => m.role === 'assistant');
    expect(allAssistant.length).toBe(3);
    expect((allAssistant[0].content as string)).toContain('Thinking round 1');
    expect((allAssistant[1].content as string)).toContain('Thinking round 2');
    expect((allAssistant[2].content as string)).toContain('Thinking round 3');
  });

  it('关键回归：无 reasoning 时不拼标签，content 保持原样', async () => {
    // 这个测试模拟真实场景：第 1 轮 AI 没有产出 reasoning（非推理模型或思考为空），
    // assistant 消息的 content 不应包含 <think> 标签。
    const adapter = new DevecoAdapter({ accessToken: FAKE_TOKEN });
    const config = makeConfig();

    // 第 1 轮：AI 没有产出 reasoning，只有 tool_call
    await adapter.translateInput([
      { role: 'system', content: 'System', timestamp: 1 },
      { role: 'user', content: 'List files', timestamp: 2 },
    ], config);

    const sse1 = makeSseChunks([
      // 注意：没有 reasoning_content delta
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'list_files', arguments: '{}' } }] }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ]);
    await collectStream(adapter, sse1);

    // 第 2 轮：工具结果反馈
    const req2 = await adapter.translateInput([
      { role: 'tool', content: 'file1.ts', toolName: 'list_files', toolResult: 'file1.ts', timestamp: 3 },
    ], config);
    const body2 = JSON.parse(req2.body) as Record<string, unknown>;
    const msgs2 = body2['messages'] as Array<Record<string, unknown>>;

    // ★ 关键验证：第 1 轮没有 reasoning，content 不应包含 <think> 标签
    const assistantMsgs = msgs2.filter(m => m.role === 'assistant');
    expect(assistantMsgs.length).toBe(1);
    // 无 reasoning 且无文本时 content 为 null（只有 tool_calls）
    const c = assistantMsgs[0].content;
    if (typeof c === 'string') {
      expect(c).not.toContain('<think>');
    }
    // 不应有独立的 reasoning_content 字段
    expect(assistantMsgs[0].reasoning_content).toBeUndefined();

    // thinking 参数不设置
    expect(body2['thinking']).toBeUndefined();

    // 第 2 轮响应：AI 产出新的 reasoning（因为 thinking 参数 + 完整历史）
    const sse2 = makeSseChunks([
      { choices: [{ delta: { reasoning_content: 'Now I can see the files' }, finish_reason: null }] },
      { choices: [{ delta: { content: 'Found file1.ts' }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ]);
    const out2 = await collectStream(adapter, sse2);

    // ★ 第 2 轮产出了 thinking（这就是之前 bug 的场景：工具结果轮次不显示思考）
    expect(out2.thinkings.join('')).toBe('Now I can see the files');
    expect(out2.texts.join('')).toContain('file1.ts');
  });
});
