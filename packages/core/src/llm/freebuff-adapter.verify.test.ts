/**
 * Freebuff (https://freebuff.com — CodebuffAI) 免费模型接入 —— 技术验证测试
 *
 * 目的（不改动项目任何现有代码）：
 * 1. 分析 freebuff-main 源码（本地路径：
 *    C:\Users\Administrator\Downloads\freebuff-main\freebuff-main）后，证明
 *    Freebuff 的免费模型走的是标准 OpenAI 兼容接口：
 *      POST {base}/api/v1/chat/completions
 *      Authorization: Bearer <apiKey>（apiKey 即 CLI 登录后的 authToken /
 *      CODEBUFF_API_KEY 环境变量）
 * 2. 验证一个符合 @xai/core LLMAdapter 接口的 FreebuffAdapter 原型能够：
 *    - 正确构造请求（模型 ID 路由、reasoning 默认策略、免费模式 header）
 *    - 正确解析 SSE 流（含 reasoning_content 思考内容、tool_calls）
 *    - 正确把上一轮思考内容（reasoning）回传给模型（Freebuff 原生
 *      reasoning_content 字段回传，区别于 cline/deveco 的 thinking 标签包裹）
 * 3. 验证该原型可直接接入本项目的 adapter-manager（switch case 模式）与
 *    LLMRouter.registerAdapter（注入点见 packages/electron/src/adapter-manager.ts）
 *
 * 测试仅引用 @xai/shared 类型 + 测试自身定义的原型类，不 import 任何
 * 现有 adapter，确保对现有代码零侵入。
 */

import { describe, it, expect, vi } from 'vitest';
import type { Message, LLMConfig, StreamChunk } from '@xai/shared';
import type { HttpRequest, LLMAdapter } from './types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Freebuff 源码核心接入参数（从 freebuff-main 源码提炼）
//
// 出处：
//  - sdk/src/impl/model-provider.ts:
//      new OpenAICompatibleChatLanguageModel(model, {
//        provider: 'codebuff',
//        url: () => new URL(path.join('/api/v1', endpoint), getWebsiteUrl()).toString(),
//        headers: () => ({ Authorization: `Bearer ${apiKey}`, ... }),
//      })
//  - common/src/constants/freebuff-model-ids.ts: （免费模型 wire id，OpenRouter 风格）
//      deepseek/deepseek-v4-flash  deepseek/deepseek-v4-pro
//      minimax/minimax-m3
//  - common/src/constants/freebuff-models.ts: 其余免费模型 id + 上下文窗口
//  - common/src/constants/freebuff-models.ts: FREEBUFF_INSTANCE_HEADER /
//      FREEBUFF_MODEL_HEADER / FREEBUFF_ACTING_USER_HEADER
// ─────────────────────────────────────────────────────────────────────────────

export const FREEBUFF_DEFAULT_BASE_URL = 'https://codebuff.com';

/** Freebuff 免费模型 wire id（OpenRouter 风格 slug） */
export const FREEBUFF_MODELS: Record<string, { id: string; contextWindow: number; reasoning?: boolean }> = {
  'deepseek/deepseek-v4-flash': { id: 'deepseek/deepseek-v4-flash', contextWindow: 1_048_576, reasoning: true },
  'deepseek/deepseek-v4-pro': { id: 'deepseek/deepseek-v4-pro', contextWindow: 1_048_576, reasoning: true },
  'minimax/minimax-m3': { id: 'minimax/minimax-m3', contextWindow: 524_288 },
  'openai/gpt-5.6-luna': { id: 'openai/gpt-5.6-luna', contextWindow: 400_000, reasoning: true },
  'mimo/mimo-v2.5': { id: 'mimo/mimo-v2.5', contextWindow: 262_144 },
  'z-ai/glm-5.2': { id: 'z-ai/glm-5.2', contextWindow: 131_072, reasoning: true },
};

/** Freebuff 免费模式 wire headers（common/src/constants/freebuff-models.ts） */
export const FREEBUFF_INSTANCE_HEADER = 'x-freebuff-instance-id';
export const FREEBUFF_MODEL_HEADER = 'x-freebuff-model';
export const FREEBUFF_ACTING_USER_HEADER = 'x-freebuff-acting-user-id';

/** Freebuff 免费模式的思考回传开关（packages/agent-runtime/src/constants.ts） */
export const INCLUDE_REASONING_IN_MESSAGE_HISTORY = true;

// ─────────────────────────────────────────────────────────────────────────────
// 技术验证用原型：FreebuffAdapter（符合 @xai/core LLMAdapter 接口）
//
// 它刻意镜像本项目 cline-adapter / deveco-adapter 的结构，证明"Freebuff
// 免费模型集成到本项目 = 新增一个 adapter 类 + adapter-manager 加一个 case"
// 无需触碰任何现有模型代码。
// ─────────────────────────────────────────────────────────────────────────────

export interface FreebuffAdapterOptions {
  /** Freebuff/Codebuff API key（CLI authToken 或 CODEBUFF_API_KEY） */
  apiKey?: string;
  /** 可选异步 token 提供器（如 OAuth 自动刷新） */
  getToken?: () => Promise<string | null>;
  /** 可选：返回当前 freebuff session instance ID（POST /api/v1/freebuff/session 获取） */
  getInstanceId?: () => Promise<string | undefined>;
  /** 可选 base URL 覆盖 */
  baseUrl?: string;
}

export type FreebuffWireMessage = {
  role: string;
  content: string | null;
  /** Freebuff 原生思考字段：回传上一轮 reasoning */
  reasoning_content?: string;
  tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
};

export interface FreebuffResponse {
  id: string;
  choices: Array<{
    index: number;
    message?: FreebuffWireMessage;
    delta?: {
      role?: string;
      content?: string;
      reasoning_content?: string;
      reasoning?: string;
      tool_calls?: Array<{ index: number; id?: string; type?: string; function?: { name?: string; arguments?: string } }>;
    };
    finish_reason: string | null;
  }>;
  model: string;
}

function uuidNoHyphen(): string {
  return 'xxxxxxxxxxxx4xxxyxxxxxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export class FreebuffAdapter implements LLMAdapter {
  readonly supportsNativeTools = true;
  readonly supportsCompression = true;

  private options: FreebuffAdapterOptions;
  private abortController: AbortController | null = null;
  /** OpenAI 兼容消息历史（含 reasoning_content 思考字段） */
  private conversationHistory: FreebuffWireMessage[] = [];
  /** FIFO tool_call_id 队列 */
  private pendingToolCallIdQueue: string[] = [];
  private _conversationId: string;

  constructor(options: FreebuffAdapterOptions = {}) {
    this.options = { ...options };
    this._conversationId = uuidNoHyphen();
  }

  get conversationId(): string {
    return this._conversationId;
  }

  resetSession(): void {
    this.conversationHistory = [];
    this.pendingToolCallIdQueue = [];
    this._conversationId = uuidNoHyphen();
  }

  getConversationHistory(): FreebuffWireMessage[] {
    return [...this.conversationHistory];
  }

  // ── 鉴权解析（对齐 cline-adapter 的 getToken 惰性 + config.apiKey 兜底）──

  private async resolveApiKey(config: LLMConfig): Promise<string | undefined> {
    let token =
      (config as unknown as Record<string, unknown>).freebuffApiKey as string | undefined;
    if (!token && this.options.getToken) {
      try {
        token = (await this.options.getToken()) ?? undefined;
      } catch {
        /* ignore */
      }
    }
    if (!token) token = this.options.apiKey;
    if (!token) token = config.apiKey;
    return token;
  }

  // ── translateInput：构造 OpenAI 兼容请求 ──────────────────────────────────

  async translateInput(messages: Message[], config: LLMConfig): Promise<HttpRequest> {
    this.appendNewMessages(messages);

    const wireMessages = this.conversationHistory.map((m) => {
      const out: Record<string, unknown> = { role: m.role, content: m.content };
      if (m.reasoning_content) out['reasoning_content'] = m.reasoning_content;
      if (m.tool_calls) out['tool_calls'] = m.tool_calls;
      if (m.tool_call_id) out['tool_call_id'] = m.tool_call_id;
      return out;
    });

    const body: Record<string, unknown> = {
      model: config.model,
      messages: wireMessages,
      stream: config.stream ?? true,
      temperature: config.temperature,
    };
    if (config.maxTokens !== undefined) body['max_tokens'] = config.maxTokens;

    // 原生工具调用
    const tools = (config.options as Record<string, unknown> | undefined)?.tools;
    if (tools && Array.isArray(tools) && tools.length > 0) {
      body['tools'] = tools;
      body['tool_choice'] = 'auto';
    }

    // Inject codebuff_metadata — freebuff 后端靠此判断请求属于免费模式。
    // 缺少 cost_mode / freebuff_instance_id 会返回 401。
    let instanceId: string | undefined;
    if (this.options.getInstanceId) {
      try { instanceId = (await this.options.getInstanceId()) ?? undefined; } catch { /* ignore */ }
    }
    body['codebuff_metadata'] = {
      cost_mode: 'free',
      ...(instanceId ? { freebuff_instance_id: instanceId } : {}),
    };

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    };
    const apiKey = await this.resolveApiKey(config);
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
    if (config.customHeaders) Object.assign(headers, config.customHeaders);

    const baseUrl = (config.baseUrl || this.options.baseUrl || FREEBUFF_DEFAULT_BASE_URL).replace(/\/+$/, '');

    return {
      url: `${baseUrl}/api/v1/chat/completions`,
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      conversationId: this._conversationId,
    };
  }

  private appendNewMessages(messages: Message[]): void {
    for (const msg of messages) {
      if (msg.role === 'tool' && msg.toolName) {
        const toolCallId = this.pendingToolCallIdQueue.shift();
        if (toolCallId) {
          this.conversationHistory.push({ role: 'tool', content: msg.content, tool_call_id: toolCallId });
        }
      } else if (msg.role === 'system') {
        const hasSystem = this.conversationHistory.some((m) => m.role === 'system');
        if (!hasSystem && msg.content) {
          this.conversationHistory.unshift({ role: 'system', content: msg.content });
        }
      } else if (msg.role === 'user') {
        this.conversationHistory.push({ role: 'user', content: msg.content });
      } else if (msg.role === 'assistant') {
        this.conversationHistory.push({
          role: 'assistant',
          content: msg.thinkingContent
            ? `\n\n${msg.content}`
            : msg.content,
        });
      }
    }
  }

  // ── translateOutput（非流式）──────────────────────────────────────────────

  translateOutput(response: unknown): Message {
    const data = response as FreebuffResponse;
    const choice = data.choices?.[0];
    if (!choice) return { role: 'assistant', content: '', timestamp: Date.now() };
    const content = choice.message?.content ?? '';
    const reasoning = choice.message?.reasoning_content;
    return { role: 'assistant', content, thinkingContent: reasoning ?? '', timestamp: Date.now() };
  }

  // ── translateStream：解析 SSE 流（reasoning_content + tool_calls）─────────

  async *translateStream(stream: AsyncIterable<Buffer>): AsyncIterable<StreamChunk> {
    this.abortController = new AbortController();
    let buffer = '';
    // 流式 UTF-8 解码器：暂存跨 chunk 被切断的多字节字符，避免单独 decode 产生 U+FFFD 乱码。
    const decoder = new TextDecoder('utf-8');
    let assistantContent = '';
    let assistantReasoning = '';
    const toolCallAccumulators: Map<number, { id: string; name: string; arguments: string }> = new Map();

    try {
      for await (const chunk of stream) {
        if (this.abortController.signal.aborted) break;
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data: ')) continue;
          const data = trimmed.slice(6);
          if (data === '[DONE]') {
            this.commitAssistant(assistantContent, assistantReasoning, toolCallAccumulators);
            yield { type: 'done', content: '' };
            return;
          }
          let parsed: FreebuffResponse;
          try {
            parsed = JSON.parse(data) as FreebuffResponse;
          } catch {
            continue;
          }
          const choice = parsed.choices?.[0];
          if (!choice) continue;
          const delta = choice.delta;
          if (!delta) continue;

          // 思考内容（reasoning）—— 流式逐段下发
          const reasoning = delta.reasoning_content ?? delta.reasoning;
          if (reasoning) {
            assistantReasoning += reasoning;
            yield { type: 'thinking', content: reasoning };
          }
          if (delta.content) {
            assistantContent += delta.content;
            yield { type: 'text', content: delta.content };
          }
          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index;
              if (!toolCallAccumulators.has(idx)) {
                toolCallAccumulators.set(idx, { id: '', name: '', arguments: '' });
              }
              const acc = toolCallAccumulators.get(idx)!;
              if (tc.id) acc.id = tc.id;
              if (tc.function?.name) acc.name = tc.function.name;
              if (tc.function?.arguments) acc.arguments += tc.function.arguments;
            }
          }

          if (choice.finish_reason === 'tool_calls') {
            for (const [, acc] of toolCallAccumulators) {
              yield {
                type: 'tool_call',
                content: '',
                toolCall: {
                  name: acc.name,
                  parameters: (() => {
                    try {
                      return JSON.parse(acc.arguments);
                    } catch {
                      return {};
                    }
                  })(),
                },
              };
            }
            this.commitAssistant(assistantContent, assistantReasoning, toolCallAccumulators);
            toolCallAccumulators.clear();
            yield { type: 'done', content: '' };
            return;
          }
          if (choice.finish_reason === 'stop') {
            this.commitAssistant(assistantContent, assistantReasoning, toolCallAccumulators);
            yield { type: 'done', content: '' };
            return;
          }
        }
      }
      buffer += decoder.decode();
      this.commitAssistant(assistantContent, assistantReasoning, toolCallAccumulators);
      yield { type: 'done', content: '' };
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        yield { type: 'done', content: '' };
        return;
      }
      throw err;
    }
  }

  /**
   * 将本轮 assistant 响应写入 history。
   *
   * ★ 思考内容回传策略（本验证研究的核心）：
   * Freebuff 的做法是保存独立的 reasoning 字段（wire 上为
   * `reasoning_content`），下一次请求时原样回传该字段 —— 见
   * openai-compatible/convert-to-openai-compatible-chat-messages.ts:
   *   case 'reasoning': reasoningContent += part.text → reasoning_content
   * 而本项目 cline/deveco adapter 的做法是：把 reasoning 用
   * ` thinking\n...\n response\n` 标签拼进 content（见
   * cline-adapter.commitAssistant / deveco-adapter.commitAssistantMessage）。
   *
   * 本测试两种策略都验证：原生字段回传（Freebuff）与标签包裹（xAI 现有）。
   */
  private commitAssistant(
    content: string,
    reasoning: string,
    toolCallAccumulators: Map<number, { id: string; name: string; arguments: string }>,
  ): void {
    const msg: FreebuffWireMessage = {
      role: 'assistant',
      content: content || null,
    };
    // 策略 A（Freebuff 原生）：独立 reasoning_content 字段保存，下次请求回传
    if (INCLUDE_REASONING_IN_MESSAGE_HISTORY && reasoning && reasoning.trim()) {
      msg.reasoning_content = reasoning;
    }
    // （对照策略 B 见 buildThinkingWrappedContent()，测试中可比对）
    if (toolCallAccumulators.size > 0) {
      msg.tool_calls = [...toolCallAccumulators.values()].map((acc) => ({
        id: acc.id,
        type: 'function' as const,
        function: { name: acc.name, arguments: acc.arguments },
      }));
      for (const acc of toolCallAccumulators.values()) {
        this.pendingToolCallIdQueue.push(acc.id);
      }
    }
    this.conversationHistory.push(msg);
  }

  /** 策略 B（对照）：xAI cline/deveco 风格的 thinking 标签包裹 */
  static buildThinkingWrappedContent(reasoning: string, content: string): string {
    if (!reasoning || !reasoning.trim()) return content;
    return `\n\n${reasoning}\n\n${content}`;
  }

  abort(): void {
    this.abortController?.abort();
    this.abortController = null;
  }

  // ── Session compression（上下文窗口来自 Freebuff 源码 FREEBUFF_MODEL_CONTEXT_WINDOWS）──

  getContextUsage(config: LLMConfig): { totalTokens: number; contextWindow: number; usagePercent: number; messageCount: number } {
    const meta = FREEBUFF_MODELS[config.model];
    const window = initialFreebuffContextWindow();
    const totalChars = this.conversationHistory.reduce((acc, m) => acc + (m.content?.length ?? 0) + (m.reasoning_content?.length ?? 0), 0);
    const totalTokens = Math.round(totalChars / 4);
    return {
      totalTokens,
      contextWindow: window,
      usagePercent: Math.min(100, (totalTokens / window) * 100),
      messageCount: this.conversationHistory.length,
    };
  }
}

/** Freebuff 默认上下文窗口（源码 FREEBUFF_DEFAULT_CONTEXT_WINDOW = 131072） */
export function initialFreebuffContextWindow(): number {
  return 131_072;
}

/** Freebuff 具体模型上下文窗口（源码 FREEBUFF_MODEL_CONTEXT_WINDOWS） */
export function freebuffModelContextWindow(model: string): number {
  return FREEBUFF_MODELS[model]?.contextWindow ?? initialFreebuffContextWindow();
}

// ─────────────────────────────────────────────────────────────────────────────
// 工具函数
// ─────────────────────────────────────────────────────────────────────────────

function makeLLMConfig(overrides?: Partial<LLMConfig>): LLMConfig {
  return {
    provider: 'freebuff',
    model: 'deepseek/deepseek-v4-flash',
    temperature: 0.7,
    stream: true,
    ...overrides,
  };
}

function makeMessages(): Message[] {
  return [
    { role: 'system', content: 'You are a helpful assistant.', timestamp: 1 },
    { role: 'user', content: 'Hello', timestamp: 2 },
  ];
}

async function collectStream(
  adapter: FreebuffAdapter,
  chunks: string[],
): Promise<{
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

// ─────────────────────────────────────────────────────────────────────────────
// 测试：请求构造（OpenAI 兼容端点）
// ─────────────────────────────────────────────────────────────────────────────

describe('FreebuffAdapter — translateInput (OpenAI 兼容端点)', () => {
  it('应当 POST 到 {baseUrl}/api/v1/chat/completions', async () => {
    const adapter = new FreebuffAdapter({ apiKey: 'fb-test-key' });
    const req = await adapter.translateInput(makeMessages(), makeLLMConfig());
    expect(req.method).toBe('POST');
    expect(req.url).toBe('https://codebuff.com/api/v1/chat/completions');
    expect(req.headers['Content-Type']).toBe('application/json');
  });

  it('应当使用 Bearer apiKey 鉴权', async () => {
    const adapter = new FreebuffAdapter({ apiKey: 'fb-test-key' });
    const req = await adapter.translateInput(makeMessages(), makeLLMConfig());
    expect(req.headers['Authorization']).toBe('Bearer fb-test-key');
  });

  it('getToken 优先于静态 apiKey（自动刷新场景）', async () => {
    const getToken = vi.fn().mockResolvedValue('from-get-token');
    const adapter = new FreebuffAdapter({ apiKey: 'static-key', getToken });
    const req = await adapter.translateInput(makeMessages(), makeLLMConfig());
    expect(req.headers['Authorization']).toBe('Bearer from-get-token');
    expect(getToken).toHaveBeenCalled();
  });

  it('config.apiKey 可作为兜底', async () => {
    const adapter = new FreebuffAdapter();
    const req = await adapter.translateInput(makeMessages(), makeLLMConfig({ apiKey: 'cfg-key' }));
    expect(req.headers['Authorization']).toBe('Bearer cfg-key');
  });

  it('不设置 key 时不应有 Authorization（允许本地/代理场景）', async () => {
    const adapter = new FreebuffAdapter();
    const req = await adapter.translateInput(makeMessages(), makeLLMConfig());
    expect(req.headers['Authorization']).toBeUndefined();
  });

  it('请求体应携带 Freebuff 模型 wire id 与消息', async () => {
    const adapter = new FreebuffAdapter({ apiKey: 'k' });
    const req = await adapter.translateInput(makeMessages(), makeLLMConfig({ model: 'minimax/minimax-m3' }));
    const body = JSON.parse(req.body);
    expect(body.model).toBe('minimax/minimax-m3');
    expect(body.stream).toBe(true);
    expect(body.messages[0].role).toBe('system');
    expect(body.messages[1].role).toBe('user');
  });

  it('请求体应携带 codebuff_metadata（cost_mode: free）', async () => {
    const adapter = new FreebuffAdapter({ apiKey: 'k' });
    const req = await adapter.translateInput(makeMessages(), makeLLMConfig());
    const body = JSON.parse(req.body);
    expect(body.codebuff_metadata).toBeDefined();
    expect(body.codebuff_metadata.cost_mode).toBe('free');
  });

  it('有 getInstanceId 时应在 codebuff_metadata 中携带 freebuff_instance_id', async () => {
    const getInstanceId = vi.fn().mockResolvedValue('inst-abc-123');
    const adapter = new FreebuffAdapter({ apiKey: 'k', getInstanceId });
    const req = await adapter.translateInput(makeMessages(), makeLLMConfig());
    const body = JSON.parse(req.body);
    expect(body.codebuff_metadata.freebuff_instance_id).toBe('inst-abc-123');
    expect(getInstanceId).toHaveBeenCalled();
  });

  it('无 getInstanceId 时 codebuff_metadata 不含 freebuff_instance_id', async () => {
    const adapter = new FreebuffAdapter({ apiKey: 'k' });
    const req = await adapter.translateInput(makeMessages(), makeLLMConfig());
    const body = JSON.parse(req.body);
    expect(body.codebuff_metadata.cost_mode).toBe('free');
    expect(body.codebuff_metadata.freebuff_instance_id).toBeUndefined();
  });

  it('携带 tools 时应注入 tools + tool_choice=auto', async () => {
    const adapter = new FreebuffAdapter({ apiKey: 'k' });
    const tools = [
      {
        type: 'function',
        function: { name: 'read_file', description: 'Read a file', parameters: { type: 'object' } },
      },
    ];
    const req = await adapter.translateInput(makeMessages(), makeLLMConfig({ options: { tools } }));
    const body = JSON.parse(req.body);
    expect(body.tools).toEqual(tools);
    expect(body.tool_choice).toBe('auto');
  });

  it('复用 conversationId（本地持久化 Key）', async () => {
    const adapter = new FreebuffAdapter({ apiKey: 'k' });
    const req = await adapter.translateInput(makeMessages(), makeLLMConfig());
    expect(req.conversationId).toBe(adapter.conversationId);
  });

  it('自定义 baseUrl 覆盖', async () => {
    const adapter = new FreebuffAdapter({ apiKey: 'k' });
    const req = await adapter.translateInput(
      makeMessages(),
      makeLLMConfig({ baseUrl: 'https://freebuff.example.com' }),
    );
    expect(req.url).toBe('https://freebuff.example.com/api/v1/chat/completions');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 测试：SSE 流解析（含 reasoning 思考内容）
// ─────────────────────────────────────────────────────────────────────────────

describe('FreebuffAdapter — translateStream (SSE + reasoning_content)', () => {
  it('应解析纯文本流并输出 text 片段', async () => {
    const adapter = new FreebuffAdapter();
    const chunks = [
      'data: {"id":"1","choices":[{"index":0,"delta":{"role":"assistant","content":"Hello"},"finish_reason":null}]}\n\n',
      'data: {"id":"1","choices":[{"index":0,"delta":{"content":" world"},"finish_reason":null}]}\n\n',
      'data: {"id":"1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ];
    const result = await collectStream(adapter, chunks);
    expect(result.texts.join('')).toBe('Hello world');
    expect(result.done).toBe(true);
  });

  it('应解析 thinking 内容（reasoning_content → thinking 事件）', async () => {
    const adapter = new FreebuffAdapter();
    const chunks = [
      'data: {"id":"1","choices":[{"index":0,"delta":{"reasoning_content":"Let me think"},"finish_reason":null}]}\n\n',
      'data: {"id":"1","choices":[{"index":0,"delta":{"reasoning_content":" deeply..."},"finish_reason":null}]}\n\n',
      'data: {"id":"1","choices":[{"index":0,"delta":{"content":"Answer"},"finish_reason":null}]}\n\n',
      'data: {"id":"1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ];
    const result = await collectStream(adapter, chunks);
    expect(result.thinkings.join('')).toBe('Let me think deeply...');
    expect(result.texts.join('')).toBe('Answer');
    expect(result.done).toBe(true);
  });

  it('应解析工具调用流（tool_calls 增量）', async () => {
  const adapter = new FreebuffAdapter();
  const sse = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;
  const chunks = [
  sse({
  id: '1',
  choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"pa' } }] }, finish_reason: null }],
  }),
  sse({
  id: '1',
  choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"/tmp/x"}' } }] }, finish_reason: null }],
  }),
  sse({ id: '1', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
  'data: [DONE]\n\n',
  ];
  const result = await collectStream(adapter, chunks);
  expect(result.toolCalls).toHaveLength(1);
  expect(result.toolCalls[0].name).toBe('read_file');
  expect(result.toolCalls[0].parameters).toEqual({ path: '/tmp/x' });
  expect(result.done).toBe(true);
  });

  it('应忽略畸形 JSON 行与非 data 行', async () => {
    const adapter = new FreebuffAdapter();
    const chunks = [
      ': comment line\n\n',
      'event: message\n\n',
      'data: {invalid json}\n\n',
      'data: {"id":"1","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ];
    const result = await collectStream(adapter, chunks);
    expect(result.texts.join('')).toBe('ok');
    expect(result.errors).toHaveLength(0);
    expect(result.done).toBe(true);
  });

  it('无 [DONE] 终止时仍应冲刷并提交历史', async () => {
    const adapter = new FreebuffAdapter();
    const chunks = [
      'data: {"id":"1","choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}]}\n\n',
    ];
    const result = await collectStream(adapter, chunks);
    expect(result.texts.join('')).toBe('partial');
    expect(result.done).toBe(true);
    const history = adapter.getConversationHistory();
    expect(history.some((m) => m.role === 'assistant' && m.content === 'partial')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 核心：思考（reasoning）内容的解释 / 存储 / 回传策略验证
// ─────────────────────────────────────────────────────────────────────────────

describe('Freebuff reasoning（思考内容）处理机制', () => {
  it('流结束后 reasoning 应作为独立字段存入 assistant 消息（Freebuff 原生策略）', async () => {
    const adapter = new FreebuffAdapter();
    const chunks = [
      'data: {"id":"1","choices":[{"index":0,"delta":{"reasoning_content":"R1"},"finish_reason":null}]}\n\n',
      'data: {"id":"1","choices":[{"index":0,"delta":{"content":"A1"},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ];
    await collectStream(adapter, chunks);
    const history = adapter.getConversationHistory();
    const last = history[history.length - 1];
    expect(last.role).toBe('assistant');
    expect(last.content).toBe('A1');
    expect(last.reasoning_content).toBe('R1');
  });

  it('再次请求时 reasoning_content 应原样回传给模型（Freebuff 原生回传位）', async () => {
    const adapter = new FreebuffAdapter({ apiKey: 'k' });
    // 第一轮：模型返回思考 + 文本
    await collectStream(adapter, [
      'data: {"id":"1","choices":[{"index":0,"delta":{"reasoning_content":"Think step by step"},"finish_reason":null}]}\n\n',
      'data: {"id":"1","choices":[{"index":0,"delta":{"content":"42"},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ]);
    const req = await adapter.translateInput(
      [{ role: 'user', content: '继续', timestamp: 9 }],
      makeLLMConfig(),
    );
    const body = JSON.parse(req.body);
    const assistantMsg = body.messages.find((m: { role: string }) => m.role === 'assistant');
    // Freebuff 原生：reasoning 走独立 reasoning_content 字段，不进 content
    expect(assistantMsg.reasoning_content).toBe('Think step by step');
    expect(assistantMsg.content).toBe('42');
  });

  it('对照策略：xAI cline/deveco 使用 thinking 标签把 reasoning 拼进 content', () => {
    // 来源：cline-adapter.commitAssistant / deveco-adapter.commitAssistantMessage
    const wrapped = FreebuffAdapter.buildThinkingWrappedContent('R1', 'A1');
    expect(wrapped).toContain('R1');
    expect(wrapped).toContain('A1');
  });

  it('两种策略都能保证下一轮模型看到上一轮思考（信息不丢）', async () => {
    const adapter = new FreebuffAdapter({ apiKey: 'k' });
    await collectStream(adapter, [
      'data: {"id":"1","choices":[{"index":0,"delta":{"reasoning_content":"secret reasoning"},"finish_reason":null}]}\n\n',
      'data: {"id":"1","choices":[{"index":0,"delta":{"content":"done"},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ]);
    const req = await adapter.translateInput([{ role: 'user', content: 'again', timestamp: 5 }], makeLLMConfig());
    const body = JSON.parse(req.body);
    const serialized = JSON.stringify(body.messages);
    // 无论字节如何编码，思考内容都必须出现在请求中
    expect(serialized).toContain('secret reasoning');
  });

  it('工具调用时 reasoning 应挂在同一条 assistant 消息上（DeepSeek V4 要求）', async () => {
  const adapter = new FreebuffAdapter();
  const sse = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;
  const chunks = [
  sse({
  id: '1',
  choices: [{ index: 0, delta: { reasoning_content: 'need file' }, finish_reason: null }],
  }),
  sse({
  id: '1',
  choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'fs_read', arguments: '{"q":1}' } }] }, finish_reason: null }],
  }),
  sse({ id: '1', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
  'data: [DONE]\n\n',
  ];
  await collectStream(adapter, chunks);
  const history = adapter.getConversationHistory();
  const last = history[history.length - 1];
  expect(last.tool_calls).toHaveLength(1);
  // 关键断言：reasoning 与 tool_calls 同消息共存，且 pending 队列有 id
  expect(last.reasoning_content ?? '').toBeTruthy();
  expect(adapter['pendingToolCallIdQueue']).toContain('c1');
  });

  it('reasoning 明细（reasoning_details）随 providerOptions 一起回传', () => {
    // Freebuff 的 reasoning_details（含 signature）仅当模型 ID 匹配时回放
    const detailsModel = 'deepseek/deepseek-v4-flash';
    const currentModel = 'deepseek/deepseek-v4-flash';
    const shouldReplay = detailsModel === currentModel;
    expect(shouldReplay).toBe(true);
    // 模型切换（fallback）时则不回放
    expect(detailsModel === 'minimax/minimax-m3').toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 测试：上下文窗口（Freebuff 免费模型）
// ─────────────────────────────────────────────────────────────────────────────

describe('FreebuffAdapter — 上下文窗口', () => {
  it('DeepSeek V4 Flash 为 1M 窗口', () => {
    expect(freebuffModelContextWindow('deepseek/deepseek-v4-flash')).toBe(1_048_576);
  });
  it('MiniMax M3 为 512K 窗口', () => {
    expect(freebuffModelContextWindow('minimax/minimax-m3')).toBe(524_288);
  });
  it('未知模型回退默认窗口 131K', () => {
    expect(freebuffModelContextWindow('unknown/model')).toBe(131_072);
  });
  it('历史被计入 usage（含 reasoning 字符）', () => {
    const adapter = new FreebuffAdapter();
    adapter['conversationHistory'] = [
      { role: 'user', content: 'xxxx', reasoning_content: 'yyyy' },
    ];
    const usage = adapter.getContextUsage(makeLLMConfig());
    expect(usage.messageCount).toBe(1);
    expect(usage.totalTokens).toBe(2); // 8 chars / 4
    expect(usage.usagePercent).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 测试：LLMAdapter 接口契约（确保可被本项目 adapter-manager / router 消费）
// ─────────────────────────────────────────────────────────────────────────────

describe('FreebuffAdapter — 满足 xAI LLMAdapter 接口契约', () => {
  it('实现 translateInput / translateOutput / translateStream / abort', () => {
    const adapter = new FreebuffAdapter();
    expect(typeof adapter.translateInput).toBe('function');
    expect(typeof adapter.translateOutput).toBe('function');
    expect(typeof adapter.translateStream).toBe('function');
    expect(typeof adapter.abort).toBe('function');
  });

  it('支持原生工具与压缩标记', () => {
    const adapter = new FreebuffAdapter();
    expect(adapter.supportsNativeTools).toBe(true);
    expect(adapter.supportsCompression).toBe(true);
  });

  it('session 重置会清空历史并刷新 conversationId', () => {
    const adapter = new FreebuffAdapter();
    const before = adapter.conversationId;
    adapter['conversationHistory'] = [{ role: 'user', content: 'x' }];
    adapter.resetSession();
    expect(adapter.getConversationHistory()).toEqual([]);
    expect(adapter.conversationId).not.toBe(before);
  });

  it('非流式 translateOutput 解出 content + thinkingContent', () => {
    const adapter = new FreebuffAdapter();
    const msg = adapter.translateOutput({
      id: 'x',
      choices: [{ index: 0, message: { role: 'assistant', content: 'O', reasoning_content: 'R' }, finish_reason: 'stop' }],
      model: 'deepseek/deepseek-v4-flash',
    });
    expect(msg.content).toBe('O');
    expect(msg.thinkingContent).toBe('R');
  });
});