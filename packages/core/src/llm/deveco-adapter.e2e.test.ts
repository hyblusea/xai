import { describe, it, expect } from 'vitest';
import { DevecoAdapter } from './deveco-adapter.js';
import type { Message, LLMConfig, StreamChunk } from '@xai/shared';

/**
 * 端到端真实场景测试：模拟 ReAct 循环中的完整多轮工具调用。
 *
 * 场景：用户问"读一下 test.ts 文件"
 *  第 1 轮：AI 思考 → 调用 read_file 工具
 *  第 2 轮：AI 收到文件内容 → 思考 → 回答
 *
 * 验证：
 *  1. 每轮请求体的完整结构（打印出来）
 *  2. 每轮响应是否产出 thinking 事件
 *  3. assistant 消息的 content/reasoning_content/tool_calls 格式
 */

const FAKE_TOKEN = 'test-token';

function makeSse(events: Array<Record<string, unknown>>): Buffer {
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

async function collectStream(adapter: DevecoAdapter, sse: Buffer) {
  const events: Array<{ type: string; content: string }> = [];
  async function* mockStream() { yield sse; }
  for await (const ev of adapter.translateStream(mockStream())) {
    events.push({ type: ev.type, content: ev.content });
  }
  return events;
}

function printRequest(label: string, body: string) {
  const parsed = JSON.parse(body);
  console.log(`\n========== ${label} ==========`);
  console.log(JSON.stringify(parsed, null, 2));
  console.log(`========================================\n`);
}

function printEvents(label: string, events: Array<{ type: string; content: string }>) {
  console.log(`\n---------- ${label} ----------`);
  for (const e of events) {
    const preview = e.content.length > 80 ? e.content.substring(0, 80) + '...' : e.content;
    console.log(`  [${e.type}] ${preview}`);
  }
  console.log(`----------------------------------------\n`);
}

describe('DevecoAdapter 端到端真实场景测试', () => {
  it('场景：用户问"读一下 test.ts" → 工具调用 → AI 回答，每轮都应有 thinking', async () => {
    const adapter = new DevecoAdapter({ accessToken: FAKE_TOKEN });
    const config = makeConfig();

    // ── 第 1 轮：用户提问 ──
    console.log('\n>>> 第 1 轮：用户提问"读一下 test.ts"');
    const messages1: Message[] = [
      { role: 'system', content: 'You are a helpful coding assistant.', timestamp: 1 },
      { role: 'user', content: '读一下 test.ts', timestamp: 2 },
    ];
    const req1 = await adapter.translateInput(messages1, config);
    printRequest('第 1 轮请求体', req1.body);

    // 验证第 1 轮请求体（不设置 thinking 参数，对齐 deveco 源码）
    const body1 = JSON.parse(req1.body);
    expect(body1.thinking).toBeUndefined();
    expect(body1.messages).toHaveLength(2);
    expect(body1.messages[0].role).toBe('system');
    expect(body1.messages[1].role).toBe('user');

    // 模拟 GLM API 第 1 轮响应：reasoning + tool_call
    const sse1 = makeSse([
      { choices: [{ delta: { reasoning_content: '用户想看 test.ts 文件，我需要调用 read_file 工具' }, finish_reason: null }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_001', type: 'function', function: { name: 'read_file', arguments: '{"path":"test.ts"}' } }] }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ]);
    const events1 = await collectStream(adapter, sse1);
    printEvents('第 1 轮响应事件', events1);

    // ★ 验证第 1 轮产出了 thinking
    const thinking1 = events1.filter(e => e.type === 'thinking').map(e => e.content).join('');
    expect(thinking1).toBe('用户想看 test.ts 文件，我需要调用 read_file 工具');
    console.log(`✅ 第 1 轮 thinking: "${thinking1}"`);

    const toolCalls1 = events1.filter(e => e.type === 'tool_call');
    expect(toolCalls1.length).toBe(1);
    console.log(`✅ 第 1 轮 tool_call: read_file`);

    // ── 模拟工具执行，返回结果 ──
    console.log('\n>>> 模拟工具执行：read_file 返回文件内容');

    // ── 第 2 轮：工具结果反馈 ──
    console.log('\n>>> 第 2 轮：工具结果反馈给 AI');
    const messages2: Message[] = [
      {
        role: 'tool',
        content: '[Tool Result] read_file - 成功\nFile: test.ts\nOutput:\nexport function hello() {\n  console.log("hello");\n}',
        timestamp: 3,
        toolName: 'read_file',
        toolResult: { toolName: 'read_file', success: true, output: 'export function hello() {...}' }
      },
    ];
    const req2 = await adapter.translateInput(messages2, config);
    printRequest('第 2 轮请求体（工具结果轮次）', req2.body);

    // ★ 关键验证：第 2 轮请求体结构
    const body2 = JSON.parse(req2.body);

    // 1. thinking 参数不设置（对齐 deveco 源码）
    expect(body2.thinking).toBeUndefined();
    console.log('✅ 第 2 轮 thinking 参数不设置');

    // 2. messages 数组结构：system, user, assistant(reasoning+tool_calls), tool(result)
    const msgs2 = body2.messages;
    console.log(`  messages 数量: ${msgs2.length}`);
    for (let i = 0; i < msgs2.length; i++) {
      const m = msgs2[i];
      console.log(`  [${i}] role=${m.role}, content=${m.content === null ? 'null' : `"${String(m.content).substring(0, 50)}..."`}, reasoning_content=${m.reasoning_content !== undefined ? `"${String(m.reasoning_content).substring(0, 50)}..."` : 'undefined'}, tool_calls=${m.tool_calls ? 'yes' : 'no'}, tool_call_id=${m.tool_call_id || 'no'}`);
    }

    // 3. assistant 消息（第 1 轮的）content 包含 <think> 标签和 reasoning 文本
    const assistantMsgs = msgs2.filter((m: { role: string }) => m.role === 'assistant');
    expect(assistantMsgs.length).toBe(1);
    expect(assistantMsgs[0].content).toContain('<think>');
    expect(assistantMsgs[0].content).toContain('用户想看 test.ts 文件，我需要调用 read_file 工具');
    console.log(`✅ 第 2 轮请求中 assistant.content 包含 reasoning 标签`);

    // 4. assistant 消息不应有独立的 reasoning_content 字段
    expect(assistantMsgs[0].reasoning_content).toBeUndefined();
    console.log(`✅ 第 2 轮请求中 assistant.content: null`);

    // 5. assistant 消息的 tool_calls 应存在
    expect(assistantMsgs[0].tool_calls).toBeDefined();
    expect(assistantMsgs[0].tool_calls.length).toBe(1);
    console.log(`✅ 第 2 轮请求中 assistant.tool_calls: [${assistantMsgs[0].tool_calls[0].function.name}]`);

    // 6. tool 消息
    const toolMsgs = msgs2.filter((m: { role: string }) => m.role === 'tool');
    expect(toolMsgs.length).toBe(1);
    expect(toolMsgs[0].tool_call_id).toBe('call_001');
    console.log(`✅ 第 2 轮请求中 tool.tool_call_id: ${toolMsgs[0].tool_call_id}`);

    // 模拟 GLM API 第 2 轮响应：应该返回新的 reasoning + text
    const sse2 = makeSse([
      { choices: [{ delta: { reasoning_content: '文件内容是一个 hello 函数，我来给用户解释一下' }, finish_reason: null }] },
      { choices: [{ delta: { content: 'test.ts 文件定义了一个 hello 函数，它会打印 "hello"。' }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ]);
    const events2 = await collectStream(adapter, sse2);
    printEvents('第 2 轮响应事件', events2);

    // ★★★ 关键验证：第 2 轮产出了 thinking ★★★
    const thinking2 = events2.filter(e => e.type === 'thinking').map(e => e.content).join('');
    expect(thinking2).toBe('文件内容是一个 hello 函数，我来给用户解释一下');
    console.log(`✅ 第 2 轮 thinking: "${thinking2}"`);

    const text2 = events2.filter(e => e.type === 'text').map(e => e.content).join('');
    expect(text2).toContain('hello');
    console.log(`✅ 第 2 轮 text: "${text2}"`);

    console.log('\n========== 端到端测试通过 ==========');
  });

  it('场景：连续两次工具调用（读两个文件），每次都应有 thinking', async () => {
    const adapter = new DevecoAdapter({ accessToken: FAKE_TOKEN });
    const config = makeConfig();

    // ── 第 1 轮 ──
    console.log('\n>>> 第 1 轮：用户提问');
    const req1 = await adapter.translateInput([
      { role: 'system', content: 'System', timestamp: 1 },
      { role: 'user', content: '读 a.ts 和 b.ts', timestamp: 2 },
    ], config);
    printRequest('第 1 轮请求体', req1.body);

    const sse1 = makeSse([
      { choices: [{ delta: { reasoning_content: '需要读两个文件，先读 a.ts' }, finish_reason: null }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } }] }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ]);
    const events1 = await collectStream(adapter, sse1);
    printEvents('第 1 轮响应', events1);
    expect(events1.some(e => e.type === 'thinking')).toBe(true);

    // ── 第 2 轮：第一个工具结果 ──
    console.log('\n>>> 第 2 轮：a.ts 结果反馈');
    const req2 = await adapter.translateInput([
      { role: 'tool', content: 'content of a.ts', timestamp: 3, toolName: 'read_file', toolResult: { toolName: 'read_file', success: true, output: 'content of a.ts' } },
    ], config);
    printRequest('第 2 轮请求体', req2.body);

    // 验证第 2 轮 assistant 消息的 content 包含 <think> 标签和 reasoning 文本
    const body2 = JSON.parse(req2.body);
    const asst2 = body2.messages.find((m: { role: string }) => m.role === 'assistant');
    expect(asst2.content).toContain('<think>');
    expect(asst2.content).toContain('需要读两个文件，先读 a.ts');
    console.log(`✅ 第 2 轮请求 assistant.content 包含 reasoning 标签`);

    const sse2 = makeSse([
      { choices: [{ delta: { reasoning_content: 'a.ts 读完了，现在读 b.ts' }, finish_reason: null }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c2', type: 'function', function: { name: 'read_file', arguments: '{"path":"b.ts"}' } }] }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ]);
    const events2 = await collectStream(adapter, sse2);
    printEvents('第 2 轮响应', events2);
    expect(events2.some(e => e.type === 'thinking')).toBe(true);
    console.log(`✅ 第 2 轮产出 thinking`);

    // ── 第 3 轮：第二个工具结果 ──
    console.log('\n>>> 第 3 轮：b.ts 结果反馈');
    const req3 = await adapter.translateInput([
      { role: 'tool', content: 'content of b.ts', timestamp: 4, toolName: 'read_file', toolResult: { toolName: 'read_file', success: true, output: 'content of b.ts' } },
    ], config);
    printRequest('第 3 轮请求体', req3.body);

    // 验证第 3 轮两个 assistant 消息的 content 都包含 reasoning 标签
    const body3 = JSON.parse(req3.body);
    const asstMsgs3 = body3.messages.filter((m: { role: string }) => m.role === 'assistant');
    expect(asstMsgs3.length).toBe(2);
    expect(asstMsgs3[0].content).toContain('需要读两个文件，先读 a.ts');
    expect(asstMsgs3[1].content).toContain('a.ts 读完了，现在读 b.ts');
    console.log(`✅ 第 3 轮请求两个 assistant 消息的 content 都包含 reasoning 标签`);

    const sse3 = makeSse([
      { choices: [{ delta: { reasoning_content: '两个文件都读完了，总结一下' }, finish_reason: null }] },
      { choices: [{ delta: { content: 'a.ts 和 b.ts 都已读取完毕' }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ]);
    const events3 = await collectStream(adapter, sse3);
    printEvents('第 3 轮响应', events3);
    expect(events3.some(e => e.type === 'thinking')).toBe(true);
    console.log(`✅ 第 3 轮产出 thinking`);

    console.log('\n========== 连续工具调用测试通过 ==========');
  });
});
