import { describe, it, expect, vi } from 'vitest';
import { ReActLoop } from './react-loop.js';
import { LLMRouter } from '../llm/index.js';
import { ToolRegistry } from '../tools/tool-registry.js';
import { BaseTool } from '../tools/base-tool.js';
import { ContextManager } from '../context/context-manager.js';
import { ConfirmationManager } from '../permissions/confirmation-manager.js';
import type { Message, LLMConfig, StreamChunk, ToolDefinition, ToolResult } from '@xai/shared';
import type { LLMAdapter, HttpRequest } from '../llm/types.js';

/**
 * react-loop 集成测试：模拟完整的 ReAct 循环（用户提问 → 工具调用 → 工具结果 → AI 回答）。
 *
 * 关键验证：第 2 轮（工具结果反馈后）是否仍然发送 streamReset 和 streamThinking 事件。
 * 这正是用户报告的 bug 场景："工具调用结果给 deveco 他不会输出思考"。
 */

// ── Mock Adapter ─────────────────────────────────────────────────────────────

/**
 * 模拟 DevEcoAdapter 的行为：
 * - 第 1 轮：返回 thinking + tool_call
 * - 第 2 轮：返回 thinking + text
 *
 * 关键：记录每次 translateInput 的请求体，验证 reasoning_content 是否被正确回传。
 */
class MockDevecoAdapter implements LLMAdapter {
  readonly supportsNativeTools = true;
  readonly supportsCompression = false;

  /** 模拟 adapter 的 conversationHistory（供 react-loop 检查是否有 system 消息） */
  conversationHistory: Array<{ role: string }> = [];

  private callCount = 0;
  private history: Array<{
    role: string;
    content: string | null;
    reasoning_content?: string;
    tool_calls?: unknown[];
    tool_call_id?: string;
  }> = [];

  /** 记录每次 translateInput 的请求体，供测试验证 */
  requestBodies: Array<{ messages: unknown[]; thinking?: unknown }> = [];

  resetSession(): void {
    this.history = [];
    this.conversationHistory = [];
  }

  async translateInput(messages: Message[], _config: LLMConfig): Promise<HttpRequest> {
    this.callCount++;

    // 模拟 DevEcoAdapter 的行为：
    // - 第 1 轮：messages 包含 system + user，加入 history
    // - 第 2 轮：messages 只包含 tool result，加入 history（adapter 自己管理之前的 history）
    for (const msg of messages) {
      if (msg.role === 'system') {
        this.history.push({ role: 'system', content: msg.content });
      } else if (msg.role === 'user') {
        this.history.push({ role: 'user', content: msg.content });
      } else if (msg.role === 'tool') {
        this.history.push({
          role: 'tool',
          content: msg.content,
          tool_call_id: 'call_001',
        });
      }
    }

    // 记录请求体（模拟 DevEcoAdapter 的 translateInput 逻辑）
    // 关键：assistant 消息的 reasoning_content 必须始终存在（即使为空字符串）
    const requestMessages = this.history.map(m => {
      const out: Record<string, unknown> = { role: m.role, content: m.content };
      if (m.role === 'assistant') {
        out['reasoning_content'] = m.reasoning_content ?? '';
      }
      if (m.tool_calls) out['tool_calls'] = m.tool_calls;
      if (m.tool_call_id) out['tool_call_id'] = m.tool_call_id;
      return out;
    });

    const body: Record<string, unknown> = {
      model: 'glm-5.1',
      messages: requestMessages,
      stream: true,
      thinking: { type: 'enabled', clear_thinking: false },
    };

    this.requestBodies.push({
      messages: requestMessages,
      thinking: body['thinking'],
    });

    return {
      url: 'https://mock.example.com/chat',
      method: 'POST',
      headers: {},
      body: JSON.stringify(body),
    };
  }

  async *translateStream(_stream: AsyncIterable<Buffer>): AsyncIterable<StreamChunk> {
    if (this.callCount === 1) {
      // 第 1 轮：thinking + tool_call
      yield { type: 'thinking', content: '需要读取文件' };
      yield {
        type: 'tool_call',
        toolCall: { name: 'read_file', parameters: { path: 'test.ts' } },
      };
      yield { type: 'done' };

      // 记录到 history（模拟 commitAssistantMessage）
      this.history.push({
        role: 'assistant',
        content: null,
        reasoning_content: '需要读取文件',
        tool_calls: [{ id: 'call_001', type: 'function', function: { name: 'read_file', arguments: '{"path":"test.ts"}' } }],
      });
    } else {
      // 第 2 轮：thinking + text
      yield { type: 'thinking', content: '文件内容是一个 hello 函数' };
      yield { type: 'text', content: 'test.ts 定义了一个 hello 函数' };
      yield { type: 'done' };

      this.history.push({
        role: 'assistant',
        content: 'test.ts 定义了一个 hello 函数',
        reasoning_content: '文件内容是一个 hello 函数',
      });
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async makeHttpRequest(_request: HttpRequest, _signal?: AbortSignal): Promise<Response> {
    return new Response('', { status: 200 });
  }
}

// ── Mock LLMRouter ────────────────────────────────────────────────────────────

class MockLLMRouter extends LLMRouter {
  private mockAdapter: MockDevecoAdapter;

  constructor(adapter: MockDevecoAdapter) {
    super();
    this.mockAdapter = adapter;
  }

  override getAdapter(_name: string): LLMAdapter {
    return this.mockAdapter;
  }

  override async *send(messages: Message[], config: LLMConfig, signal?: AbortSignal): AsyncIterable<StreamChunk> {
    const request = await this.mockAdapter.translateInput(messages, config);
    // 模拟 HTTP 请求和流式响应
    const mockStream = (async function* () { yield Buffer.from('mock'); })();
    yield* this.mockAdapter.translateStream(mockStream);
  }
}

// ── 测试 ───────────────────────────────────────────────────────────────────────

describe('ReActLoop 集成测试：多轮工具调用中的 thinking 事件', () => {
  it('第 2 轮（工具结果反馈后）应仍然发送 streamReset 和 streamThinking 事件', async () => {
    // ── 准备 Mock ──
    const mockAdapter = new MockDevecoAdapter();
    const llmRouter = new MockLLMRouter(mockAdapter);

    // ToolRegistry
    const toolRegistry = new ToolRegistry();

    // 创建一个 mock BaseTool
    class MockReadFileTool extends BaseTool {
      get definition(): ToolDefinition {
        return {
          name: 'read_file',
          description: 'Read a file',
          parameters: { path: { type: 'string', description: 'File path', required: true } },
          mode: 'core',
          contentMode: 'json',
          category: 'file',
        };
      }
      protected async _execute(): Promise<ToolResult> {
        return {
          toolName: 'read_file',
          success: true,
          output: 'export function hello() { console.log("hello"); }',
        };
      }
    }
    toolRegistry.register(new MockReadFileTool());

    // ContextManager
    const contextManager = new ContextManager();

    // ConfirmationManager
    const confirmationManager = new ConfirmationManager({ autoApprove: true });

    const llmConfig: LLMConfig = {
      provider: 'deveco',
      model: 'glm-5.1',
      temperature: 0.7,
      stream: true,
    };

    const loop = new ReActLoop({
      llmRouter,
      toolRegistry,
      contextManager,
      confirmationManager,
      llmConfig,
      workspacePath: '/test',
      maxIterations: 5,
    });

    // ── 记录事件 ──
    const events: Array<{ type: string; data?: unknown }> = [];

    loop.on('streamReset', () => events.push({ type: 'streamReset' }));
    loop.on('streamThinking', (text: string) => events.push({ type: 'streamThinking', data: text }));
    loop.on('streamText', (text: string) => events.push({ type: 'streamText', data: text }));
    loop.on('toolCallStart', () => events.push({ type: 'toolCallStart' }));
    loop.on('toolCallParsed', (tc: unknown) => events.push({ type: 'toolCallParsed', data: tc }));
    loop.on('toolCallEnd', (summary: string) => events.push({ type: 'toolCallEnd', data: summary }));
    loop.on('toolResult', (data: unknown) => events.push({ type: 'toolResult', data }));
    loop.on('stateChange', (state: string) => events.push({ type: 'stateChange', data: state }));
    loop.on('completed', () => events.push({ type: 'completed' }));

    // ── 运行 ──
    await loop.run('读一下 test.ts');

    // ── 打印事件序列 ──
    console.log('\n========== 事件序列 ==========');
    for (const e of events) {
      const dataStr = e.data !== undefined ? `: ${typeof e.data === 'string' ? e.data.substring(0, 60) : JSON.stringify(e.data).substring(0, 60)}` : '';
      console.log(`  ${e.type}${dataStr}`);
    }
    console.log('================================\n');

    // ── 验证事件序列 ──

    // 第 1 轮事件
    const round1Events = events.slice(0, events.indexOf(events.find(e => e.type === 'toolResult')!) + 1);
    expect(round1Events.some(e => e.type === 'streamReset')).toBe(true);
    expect(round1Events.some(e => e.type === 'streamThinking' && e.data === '需要读取文件')).toBe(true);
    expect(round1Events.some(e => e.type === 'toolCallEnd')).toBe(true);
    expect(round1Events.some(e => e.type === 'toolResult')).toBe(true);
    console.log('✅ 第 1 轮: streamReset + streamThinking + toolCall + toolResult');

    // 第 2 轮事件
    const toolResultIdx = events.indexOf(events.find(e => e.type === 'toolResult')!);
    const round2Events = events.slice(toolResultIdx + 1);
    expect(round2Events.some(e => e.type === 'streamReset')).toBe(true);
    console.log('✅ 第 2 轮: streamReset 发送了');

    // ★★★ 关键验证：第 2 轮有 streamThinking 事件 ★★★
    const round2Thinking = round2Events.filter(e => e.type === 'streamThinking');
    expect(round2Thinking.length).toBeGreaterThan(0);
    expect(round2Thinking[0].data).toBe('文件内容是一个 hello 函数');
    console.log(`✅ 第 2 轮: streamThinking 发送了 ("${round2Thinking[0].data}")`);

    // 第 2 轮有 streamText 事件
    expect(round2Events.some(e => e.type === 'streamText')).toBe(true);
    console.log('✅ 第 2 轮: streamText 发送了');

    // 第 2 轮有 completed 事件
    expect(round2Events.some(e => e.type === 'completed')).toBe(true);
    console.log('✅ 第 2 轮: completed 发送了');

    // ── 验证请求体 ──
    expect(mockAdapter.requestBodies.length).toBe(2);
    console.log(`\n========== 请求体验证 ==========`);
    console.log(`第 1 轮请求: ${mockAdapter.requestBodies[0].messages.length} messages`);
    console.log(`第 2 轮请求: ${mockAdapter.requestBodies[1].messages.length} messages`);

    // 第 2 轮请求中，thinking 参数应存在
    const round2Body = mockAdapter.requestBodies[1];
    expect(round2Body.thinking).toEqual({ type: 'enabled', clear_thinking: false });
    console.log(`✅ 第 2 轮请求: thinking = ${JSON.stringify(round2Body.thinking)}`);

    console.log('\n========== 集成测试通过 ==========');
  });
});
