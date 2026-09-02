import type { Message, LLMConfig, StreamChunk, ToolCall } from '@xai/shared';
import type { HttpRequest, LLMAdapter, MigratableSnapshot } from './types.js';
import type { ContextUsage, CompactionResult, AdapterMessage } from './session-compressor.js';
import {
  getContextWindow,
  computeUsage,
  splitHeadTail,
  performCompaction,
  buildCompactedHistory,
  rebuildPendingToolCallIds,
  DEFAULT_TAIL_TURNS,
} from './session-compressor.js';

/**
 * DevEco (Huawei) GLM adapter.
 *
 * Uses Huawei's OpenAI-compatible proxy at cn.devecostudio.huawei.com,
 * which provides GLM-5.1 with native tool_call and reasoning support.
 *
 * Auth: Bearer accessToken extracted from the `ds-authInfo` cookie
 * after Huawei OAuth login.
 */

export interface DevecoAdapterOptions {
  /** Huawei OAuth accessToken (from ds-authInfo cookie or OAuth login) */
  accessToken?: string;
  /** Optional base URL override */
  baseUrl?: string;
  /** Optional async token provider (for OAuth auto-refresh) */
  getToken?: () => Promise<string>;
}

const DEFAULT_BASE_URL = 'https://cn.devecostudio.huawei.com';
const CHAT_COMPLETIONS_PATH = '/sse/codeGenie/maas/v2/chat/completions';
const NO_STREAM_PATH = '/sse/codeGenie/maas/v2/no-stream/chat/completions';
const MODEL_CONFIG_PATH = '/codeGenie/modelConfig';

// ── OpenAI-compatible API types ──────────────────────────────────────────────

interface DevecoToolCallDelta {
  index: number;
  id?: string;
  type?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
}

interface DevecoChoice {
  index: number;
  message?: {
    role: string;
    content: string;
    /** DeepSeek / GLM style — used by Huawei's default endpoint. */
    reasoning_content?: string;
    /** OpenRouter-style field (defensive: baseUrl is overridable). */
    reasoning?: string;
    tool_calls?: Array<{
      id: string;
      type: string;
      function: { name: string; arguments: string };
    }>;
  };
  delta?: {
    role?: string;
    content?: string;
    /** DeepSeek / GLM style — used by Huawei's default endpoint. */
    reasoning_content?: string;
    /** OpenRouter-style field (defensive: baseUrl is overridable). */
    reasoning?: string;
    tool_calls?: DevecoToolCallDelta[];
  };
  finish_reason: string | null;
}

interface DevecoResponse {
  id: string;
  choices: DevecoChoice[];
  model: string;
}

interface DevecoMessage {
  role: string;
  content: string | null;
  /** Native reasoning field — replay previous turn's thinking to the model
   *  so it doesn't re-think from scratch each turn. GLM's OpenAI-compatible
   *  API accepts `reasoning_content` on assistant messages natively. */
  reasoning_content?: string;
  /** OpenRouter-style field (defensive: baseUrl is overridable). */
  reasoning?: string;
  tool_calls?: Array<{
    id: string;
    type: string;
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

function uuidNoHyphen(): string {
  return 'xxxxxxxxxxxx4xxxyxxxxxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export class DevecoAdapter implements LLMAdapter {
  readonly supportsNativeTools = true;
  readonly supportsCompression = true;

  private options: DevecoAdapterOptions;
  private abortController: AbortController | null = null;
  /** Full conversation history in OpenAI message format. */
  private conversationHistory: DevecoMessage[] = [];
  /** FIFO queue of tool_call_ids for matching incoming tool results. */
  private pendingToolCallIdQueue: string[] = [];
  /** Chat-Id header value, kept stable per session. */
  private chatId: string;

  constructor(options: DevecoAdapterOptions = {}) {
    this.options = { ...options };
    this.chatId = uuidNoHyphen();
  }

  get conversationId(): string {
    return this.chatId;
  }

  resetSession(): void {
    this.conversationHistory = [];
    this.pendingToolCallIdQueue = [];
    this.chatId = uuidNoHyphen();
  }

  loadSession(conversationId: string): void {
    // DevEco uses Chat-Id header for session tracking; reuse it if provided.
    this.chatId = conversationId || this.chatId;
  }

  /**
   * Snapshot the current session state (history + pending tool-call IDs +
   * chatId). Used to run a standalone generation (e.g. Designer) without
   * polluting the long-lived Code-view session: snapshotSession → resetSession
   * → run → restoreSession. The Code view shares this same adapter instance.
   * chatId is included so the Designer turn gets a fresh server-side session
   * (new Chat-Id) and the Code view's Chat-Id is restored afterwards.
   */
  snapshotSession(): { history: DevecoMessage[]; pendingToolCallIds: string[]; chatId: string } {
    return {
      history: this.conversationHistory.map(m => ({ ...m })),
      pendingToolCallIds: [...this.pendingToolCallIdQueue],
      chatId: this.chatId,
    };
  }

  /** Restore a previously snapshotted session. */
  restoreSession(snapshot: { history: DevecoMessage[]; pendingToolCallIds: string[]; chatId: string }): void {
    this.conversationHistory = snapshot.history.map(m => ({ ...m }));
    this.pendingToolCallIdQueue = [...snapshot.pendingToolCallIds];
    this.chatId = snapshot.chatId;
  }

  // ── Cross-adapter context migration ────────────────────────────────────────

  /** Export the current session as a migratable snapshot for cross-adapter context preservation. */
  exportSnapshot(): MigratableSnapshot {
    return {
      history: this.conversationHistory.map(m => ({
        role: m.role,
        content: m.content,
        ...(m.reasoning_content ? { reasoning_content: m.reasoning_content } : {}),
        ...(m.tool_calls ? { tool_calls: m.tool_calls.map(tc => ({ ...tc, function: { ...tc.function } })) } : {}),
        ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
      })),
      pendingToolCallIds: [...this.pendingToolCallIdQueue],
    };
  }

  /** Import a migratable snapshot, replacing the current session state.
   *  chatId is regenerated so the DevEco server treats this as a fresh session
   *  carrying the migrated history. */
  importSnapshot(snapshot: MigratableSnapshot): void {
    this.conversationHistory = snapshot.history.map(m => ({
      role: m.role,
      content: m.content,
      ...(m.reasoning_content ? { reasoning_content: m.reasoning_content } : {}),
      ...(m.tool_calls ? { tool_calls: m.tool_calls.map(tc => ({ ...tc, function: { ...tc.function } })) } : {}),
      ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
    }));
    this.pendingToolCallIdQueue = [...snapshot.pendingToolCallIds];
    // Generate a fresh chatId so the DevEco server creates a new server-side
    // session for the migrated context (the old chatId belongs to the previous
    // provider's server-side session and is not reusable).
    this.chatId = uuidNoHyphen();
  }

  // ── Local conversation persistence ──────────────────────────────────────────

  /** Get serializable adapter state for local saving. */
  getAdapterState(): { conversationHistory: DevecoMessage[]; pendingToolCallIds: string[] } {
    return {
      conversationHistory: this.conversationHistory.map(m => ({ ...m })),
      pendingToolCallIds: [...this.pendingToolCallIdQueue],
    };
  }

  /** Restore adapter state from a locally saved snapshot. */
  setAdapterState(state: { conversationHistory: DevecoMessage[]; pendingToolCallIds: string[] }): void {
    this.conversationHistory = state.conversationHistory.map(m => ({ ...m }));
    this.pendingToolCallIdQueue = [...state.pendingToolCallIds];
  }

  /** Restore the conversation ID (chatId) after loading a locally saved conversation. */
  setConversationId(conversationId: string): void {
    this.chatId = conversationId;
  }

  /** Get compression info (whether history has been compacted). */
  getCompressionInfo(): { isCompressed: boolean; summary: string | null } {
    const summaryMsg = this.conversationHistory.find(
      m => m.role === 'user' && typeof m.content === 'string' && m.content.startsWith('Summary of previous conversation:'),
    );
    return {
      isCompressed: !!summaryMsg,
      summary: summaryMsg?.content ?? null,
    };
  }

  private getBaseUrl(): string {
    return (this.options.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
  }

  /**
   * Normalize the accessToken input.
   * Users may paste:
   *   1. The raw accessToken string
   *   2. The full ds-authInfo JSON object (we extract accessToken from it)
   *   3. URL-encoded ds-authInfo (we decode first, then extract)
   */
  private normalizeAccessToken(raw: string): string {
    let token = raw.trim();

    // If it starts with '{', try parsing as JSON (ds-authInfo object)
    if (token.startsWith('{')) {
      try {
        const obj = JSON.parse(token) as Record<string, unknown>;
        if (obj.accessToken && typeof obj.accessToken === 'string') {
          console.log('[DevEco] Extracted accessToken from ds-authInfo JSON');
          return obj.accessToken;
        }
      } catch {
        // Not valid JSON, try URL-decoding first
      }
    }

    // Try URL-decoding then JSON parsing (cookie value is URL-encoded)
    if (token.startsWith('%7B') || token.startsWith('%7b')) {
      try {
        const decoded = decodeURIComponent(token);
        const obj = JSON.parse(decoded) as Record<string, unknown>;
        if (obj.accessToken && typeof obj.accessToken === 'string') {
          console.log('[DevEco] Extracted accessToken from URL-encoded ds-authInfo');
          return obj.accessToken;
        }
      } catch {
        // Not valid after decode
      }
    }

    // Return as-is (raw accessToken string)
    return token;
  }

  private async resolveAccessToken(): Promise<string> {
    // If async token provider is available, use it (handles refresh automatically)
    if (this.options.getToken) {
      const token = await this.options.getToken();
      if (token) return token;
    }
    // Fallback to static accessToken from options
    const raw = this.options.accessToken || '';
    if (!raw) {
      throw new Error('DevEco not authenticated. Please login via Huawei OAuth in Settings.');
    }
    return this.normalizeAccessToken(raw);
  }

  private async buildHeaders(stream: boolean): Promise<Record<string, string>> {
    const token = await this.resolveAccessToken();
    return {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'lang': 'en',
      'Chat-Id': this.chatId,
      'Accept': stream ? 'text/event-stream' : 'application/json',
    };
  }

  // ── translateInput ─────────────────────────────────────────────────────────

  async translateInput(messages: Message[], config: LLMConfig): Promise<HttpRequest> {
    this.appendNewMessages(messages);

    const openaiMessages = this.conversationHistory.map(m => {
      const out: Record<string, unknown> = { role: m.role, content: m.content };
      // 不回传 reasoning_content。
      // 对齐 deveco 源码 transform.ts normalizeMessages line 303-305：
      // 该分支要求 model.capabilities.interleaved 为对象且有 field 字段才回传。
      // 但 deveco 内置 GLM-5.1 的 mapModelConfigToInternal (deveco-models.ts line 85-98)
      // 不设置 interleaved capability，因此该分支不匹配，reasoning_content 不回传。
      // GLM-5.1 默认交错式思考，每轮独立思考，不依赖历史 reasoning_content。
      if (m.tool_calls) out['tool_calls'] = m.tool_calls;
      if (m.tool_call_id) out['tool_call_id'] = m.tool_call_id;
      return out;
    });

    const stream = config.stream ?? true;
    const body: Record<string, unknown> = {
      model: config.model || 'GLM-5.1',
      messages: openaiMessages,
      stream,
      temperature: config.temperature,
    };
    // 仅在用户显式设置 maxTokens 时下发；留空则由 API 使用模型默认值
    if (config.maxTokens !== undefined) {
      body['max_tokens'] = config.maxTokens;
    }

    // Native tool definitions (OpenAI function-calling format)
    const options = config.options as Record<string, unknown> | undefined;
    const tools = options?.tools;
    if (tools && Array.isArray(tools) && (tools as unknown[]).length > 0) {
      body['tools'] = tools;
      body['tool_choice'] = 'auto';
    }

    // Enable reasoning / thinking mode when configured.
    // 'off' means reasoning is explicitly disabled — omit the param entirely
    // (OpenAI-compatible APIs reject unknown reasoning_effort values).
    if (options?.reasoningEffort && options.reasoningEffort !== 'off') {
      body['reasoning_effort'] = options.reasoningEffort;
    }

    // 不设置 thinking 参数。
    // 对齐 deveco 源码 transform.ts：line 1077-1078 的 thinking 分支只匹配
    // providerID 包含 "zai"/"zhipuai" 的 provider，deveco 内置 provider 的
    // providerID 是 "deveco"，不匹配该分支，因此不设置 thinking 参数。
    // GLM-5.1 默认开启 Thinking（交错式思考），无需显式启用。
    // 不设置 clear_thinking: false，避免触发保留式思考的严格约束。

    // Generic escape hatch for non-standard API params (e.g. vLLM's
    // `chat_template_kwargs: { enable_thinking: true }`). Any plain object
    // provided via options.extraBody is merged verbatim into the request body.
    const extraBody = options?.extraBody;
    if (extraBody && typeof extraBody === 'object' && !Array.isArray(extraBody)) {
      for (const [k, v] of Object.entries(extraBody)) {
        if (!(k in body)) body[k] = v;
      }
    }

    const url = `${this.getBaseUrl()}${stream ? CHAT_COMPLETIONS_PATH : NO_STREAM_PATH}`;

    // 调试日志：打印每轮请求的 messages 结构概要，帮助诊断多轮 thinking 问题。
    const msgSummary = openaiMessages.map((m, i) => {
      const role = m.role;
      const cStr = typeof m.content === 'string' ? m.content : '';
      const hasThink = cStr.includes('<think>');
      const hasTC = !!m.tool_calls;
      const cType = m.content === null ? 'null' : `str(${cStr.length})`;
      return `  [${i}] role=${role} content=${cType} think_tag=${hasThink ? 'yes' : 'no'} tool_calls=${hasTC ? 'yes' : 'no'}`;
    }).join('\n');
    console.log(`[DevEco] translateInput: ${openaiMessages.length} messages, model=${body['model']}, reasoning_effort=${JSON.stringify(body['reasoning_effort'] ?? null)}\n${msgSummary}`);

    return {
      url,
      method: 'POST',
      headers: await this.buildHeaders(stream),
      body: JSON.stringify(body),
      conversationId: this.chatId,
    };
  }

  // ── Message history helpers ────────────────────────────────────────────────

  private appendNewMessages(messages: Message[]): void {
    for (const msg of messages) {
      if (msg.role === 'tool' && msg.toolName) {
        let toolCallId: string | null | undefined = this.pendingToolCallIdQueue.shift();
        if (!toolCallId) {
          // 自愈：Code 视图与 Designer 视图共享同一个 adapter 实例，snapshot/restore
          // 边界可能导致队列被重置/清空。此时工具结果消息会被 shift() 取空而静默丢弃，
          // 造成本轮历史残缺。这里从已有历史里回填最后一个尚未被 tool 消息消费的 id。
          toolCallId = this.findUnmatchedToolCallId();
          if (toolCallId) {
            console.warn('[DevEco] Tool message matched via history fallback (queue was empty)');
          }
        }
        if (toolCallId) {
          this.conversationHistory.push({
            role: 'tool',
            content: msg.content,
            tool_call_id: toolCallId,
          });
        } else {
          // 队列为空且历史自愈也未命中：这是 ++++ 文本格式工具
          // （write_to_file / replace_in_file）的结果或格式纠正反馈。
          // 绝不能丢弃：丢弃会让模型认为 ++++ 调用"没有回音"，进而退化为
          // 滥用 execute_command（echo 挪步）。降级为 user 消息回传，内容
          // 自带 [Tool Result] 前缀，模型可以理解。
          console.warn('[DevEco] Tool message without matching tool_call_id, delivering as user message');
          this.conversationHistory.push({ role: 'user', content: msg.content });
        }
      } else if (msg.role === 'system') {
        // Only add system if history doesn't already have one.
        // Insert at the beginning (OpenAI-compatible APIs require system message first).
        const hasSystem = this.conversationHistory.some(m => m.role === 'system');
        if (!hasSystem && msg.content) {
          this.conversationHistory.unshift({ role: 'system', content: msg.content });
        }
      } else if (msg.role === 'user') {
        const lastUser = [...this.conversationHistory].reverse().find(m => m.role === 'user');
        if (!lastUser || lastUser.content !== msg.content) {
          this.conversationHistory.push({ role: 'user', content: msg.content });
        }
      }
      // assistant messages are added in translateStream after response is received
    }
  }

  /**
   * 自愈辅助：从已有历史里找出一个"已声明 tool_calls 但尚未被任何 tool 消息消费"的 id。
   * 用于当 pendingToolCallIdQueue 因 snapshot/restore 等边界被清空时，仍能把工具结果
   * 正确挂到对应的 assistant tool_call 上，避免结果被静默丢弃导致历史残缺。
   */
  private findUnmatchedToolCallId(): string | null {
    const used = new Set<string>();
    for (const m of this.conversationHistory) {
      if (m.role === 'tool' && m.tool_call_id) used.add(m.tool_call_id);
    }
    // 从后往前找最近的、带 tool_calls 的 assistant 消息
    for (let i = this.conversationHistory.length - 1; i >= 0; i--) {
      const m = this.conversationHistory[i];
      if (m.role === 'assistant' && m.tool_calls) {
        for (let j = m.tool_calls.length - 1; j >= 0; j--) {
          const tc = m.tool_calls[j];
          if (tc.id && !used.has(tc.id)) return tc.id;
        }
      }
    }
    return null;
  }

  // ── translateOutput (non-streaming) ────────────────────────────────────────

  translateOutput(response: unknown): Message {
    const data = response as DevecoResponse;
    const choice = data.choices?.[0];
    const content = choice?.message?.content ?? '';
    // Huawei's endpoint returns `reasoning_content`; accept OpenRouter's
    // `reasoning` too. Wrap in <think> tags, consistent with commitAssistantMessage,
    // so non-streaming responses preserve the thinking content too.
    const reasoning = choice?.message?.reasoning_content ?? choice?.message?.reasoning ?? '';
    const finalContent = reasoning && reasoning.trim()
      ? `<think>\n${reasoning}\n</think>\n${content}`
      : content;

    const msg: Message = {
      role: 'assistant',
      content: finalContent,
      timestamp: Date.now(),
    };
    // 非流式响应也可能携带 tool_calls（NO_STREAM_PATH）。虽然 Message 类型未定义该字段，
    // 这里仍将它透传在下层对象上，供需要解析原生工具调用的调用方使用（防御性改进）。
    if (choice?.message?.tool_calls && choice.message.tool_calls.length > 0) {
      (msg as Message & { tool_calls?: DevecoMessage['tool_calls'] }).tool_calls = choice.message.tool_calls;
    }
    return msg;
  }

  // ── translateStream ────────────────────────────────────────────────────────

  async *translateStream(stream: AsyncIterable<Buffer>): AsyncIterable<StreamChunk> {
    let buffer = '';
    // 流式 UTF-8 解码器：暂存跨 chunk 被切断的多字节字符，避免单独 decode 产生 U+FFFD 乱码。
    const decoder = new TextDecoder('utf-8');
    let assistantContent = '';
    // 累积推理内容，结束时拼进 content 持久化到 history，
    // 让下一轮迭代模型能看到自己上一轮的推理，避免重复思考。
    let assistantReasoning = '';
    const toolCallAccumulators = new Map<number, {
      id: string;
      name: string;
      arguments: string;
    }>();
    const completedToolCalls: Array<{ id: string; name: string; parameters: Record<string, unknown> }> = [];
    const completedIndices = new Set<number>();
    let toolCallStartEmitted = false;

    /**
     * 把累加器里尚未产出的 tool_call 一次性产出为 chunk。
     * 可被调用多次（finish_reason 到达时 + 流自然结束后兜底），
     * 通过 completedIndices 去重，保证每个调用只会产出一次——
     * 即使服务器在 finish_reason/stop/[DONE] 从未到达、连接被异常截断，
     * 已积累的工具调用也不会静默丢失。
     */
    const emitPendingToolCalls = (): StreamChunk[] => {
      const emitted: StreamChunk[] = [];
      for (const [idx, acc] of toolCallAccumulators) {
        if (completedIndices.has(idx)) continue;
        completedIndices.add(idx);
        try {
          const parameters = acc.arguments
            ? JSON.parse(acc.arguments) as Record<string, unknown>
            : {};
          completedToolCalls.push({ id: acc.id, name: acc.name, parameters });
          emitted.push({ type: 'tool_call', content: '', toolCall: { name: acc.name, parameters } });
        } catch {
          console.warn('[DevEco] Failed to parse tool_call arguments:', acc.arguments);
        }
      }
      return emitted;
    };

    /**
     * 解析单个 `data: ` 事件并累积状态，返回需要产出的 chunk。
     * 主循环与"残余 buffer 分支"共享同一实现，因此 finish_reason
     * 的解析逻辑不会在两处漂移，也不会因事件被拆到残余 buffer 而丢失。
     * 该方法不决定 done/return——由外层统一 commit + yield done。
     */
    const handleDataEvent = (dataStr: string): StreamChunk[] => {
      const out: StreamChunk[] = [];
      if (dataStr === '[DONE]' || dataStr === '') return out;

      let parsed: DevecoResponse;
      try {
        parsed = JSON.parse(dataStr) as DevecoResponse;
      } catch {
        return out;
      }
      const choice = parsed.choices?.[0];
      if (!choice) return out;

      // reasoning / thinking
      // Huawei's default endpoint uses `reasoning_content`; accept OpenRouter's
      // `reasoning` too (baseUrl is overridable via DevecoAdapterOptions).
      const reasoningContent = choice.delta?.reasoning_content ?? choice.delta?.reasoning;
      if (reasoningContent) {
        if (!assistantReasoning) {
          console.log('[DevEco] reasoning_content detected in stream, thinking mode active');
        }
        assistantReasoning += reasoningContent;
        out.push({ type: 'thinking', content: reasoningContent });
      }

      // 调试日志：打印每个 delta 的字段，帮助诊断"工具结果轮次无 thinking"问题。
      // 只在 delta 非空时打印，避免噪音。如果有 reasoning 会特别标注。
      const delta = choice.delta;
      if (delta && (delta.content || delta.reasoning_content || delta.reasoning || delta.tool_calls)) {
        const hasR = !!(delta.reasoning_content || delta.reasoning);
        const hasC = !!delta.content;
        const hasT = !!delta.tool_calls;
        console.log(`[DevEco] delta: reasoning=${hasR} content=${hasC} tool_calls=${hasT} finish=${choice.finish_reason ?? ''}`);
      }

      // text content
      const content = choice.delta?.content;
      if (content) {
        assistantContent += content;
        out.push({ type: 'text', content });
      }

      // tool_calls deltas
      const toolCallDeltas = choice.delta?.tool_calls;
      if (toolCallDeltas) {
        if (!toolCallStartEmitted) {
          toolCallStartEmitted = true;
          out.push({ type: 'text', content: '' } as StreamChunk);
        }
        for (const tcDelta of toolCallDeltas) {
          const idx = tcDelta.index;
          let acc = toolCallAccumulators.get(idx);
          if (!acc) {
            acc = { id: tcDelta.id ?? '', name: '', arguments: '' };
            toolCallAccumulators.set(idx, acc);
          }
          if (tcDelta.id) acc.id = tcDelta.id;
          if (tcDelta.function?.name) acc.name += tcDelta.function.name;
          if (tcDelta.function?.arguments) acc.arguments += tcDelta.function.arguments;
        }
      }

      // finish_reason: tool_calls / stop → 产出本轮已完成调用
      if (choice.finish_reason === 'tool_calls' || choice.finish_reason === 'stop') {
        for (const c of emitPendingToolCalls()) out.push(c);
      }

      return out;
    };

    for await (const chunk of stream) {
      buffer += decoder.decode(chunk, { stream: true });

      // 同时兼容 `\n\n` 与 `\r\n\r\n` 的事件分隔符（部分华为 SSE 使用 CRLF）。
      const parts = buffer.split(/\r?\n\r?\n/);
      buffer = parts.pop() ?? '';

      for (const part of parts) {
        const lines = part.split(/\r?\n/);
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const dataStr = line.slice(6).trim();
          // 不在 [DONE] 处立即 return——先把剩余 buffer 处理完，
          // 避免同 chunk 内 [DONE] 之前的事件被丢弃。
          if (dataStr === '[DONE]') continue;
          for (const c of handleDataEvent(dataStr)) yield c;
        }
      }
    }

    // 冲刷解码器缓存的不完整字节（正常结束时应为空字符串）。
    buffer += decoder.decode();

    // 处理残余 buffer：可能因 CRLF / 缺失空行 / 连接中断而未被主循环拆分的完整事件。
    // 与主循环共享 handleDataEvent，因此 finish_reason 解析同样生效，不会丢失工具调用。
    if (buffer.trim()) {
      const remainingParts = buffer.split(/\r?\n\r?\n/);
      for (const part of remainingParts) {
        const lines = part.split(/\r?\n/);
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const dataStr = line.slice(6).trim();
          if (dataStr === '[DONE]' || dataStr === '') continue;
          for (const c of handleDataEvent(dataStr)) yield c;
        }
      }
    }

    // 兜底：即便从未收到 finish_reason/stop/[DONE]（服务器异常截断流），
    // 也把已积累的 tool_call 产出，避免工具执行/结果气泡静默消失。
    for (const c of emitPendingToolCalls()) yield c;

    this.commitAssistantMessage(assistantContent, completedToolCalls, assistantReasoning);
    yield { type: 'done', content: '' };
  }

  // ── History commit helper ──────────────────────────────────────────────────

  /**
   * 把本轮 assistant 响应写入 conversationHistory 并排队 tool_call_id。
   * 若有 reasoning，用 <think> 标签包裹后拼到 content 前面，让下一轮请求
   * 能携带上一轮的推理内容，避免模型跨轮重复思考。
   * 跨 provider（deveco/cline/freebuff）统一使用标签回传，避免依赖各
   * provider 特有的 reasoning_content 字段。对齐 openai-adapter.ts 实现。
   */
  private commitAssistantMessage(
    content: string,
    toolCalls: Array<{ id: string; name: string; parameters: Record<string, unknown> }>,
    reasoning?: string,
  ): void {
    // 有推理内容时用 <think> 标签包裹拼到 content 前面持久化到 history
    const finalContent = reasoning && reasoning.trim()
      ? `<think>\n${reasoning}\n</think>\n${content}`
      : content;
    const msg: DevecoMessage = {
      role: 'assistant',
      content: finalContent || null,
    };

    if (toolCalls.length > 0) {
      msg.tool_calls = toolCalls.map(tc => ({
        id: tc.id,
        type: 'function',
        function: {
          name: tc.name,
          arguments: JSON.stringify(tc.parameters),
        },
      }));

      for (const tc of toolCalls) {
        this.pendingToolCallIdQueue.push(tc.id);
      }
    }

    this.conversationHistory.push(msg);
  }

  // ── Session compression (OpenAI / DevEco / Cline) ──────────────────────────

  /**
   * Snapshot of how full the adapter's conversation history is, relative to
   * the model's context window. Uses a chars/4 token estimate.
   */
  getContextUsage(config: LLMConfig): ContextUsage {
    const window = getContextWindow('deveco', config.model, config.contextWindow);
    return computeUsage(this.conversationHistory as AdapterMessage[], window);
  }

  /**
   * Manually compact the conversation history:
   *   1. Split into head (to summarize) + tail (last 2 turns, preserved verbatim).
   *   2. Call the LLM with a compaction prompt to summarize the head.
   *   3. Replace history with [system?, summary, ack, ...tail].
   *   4. Rebuild the pending tool_call_id queue from the new history.
   */
  async compressHistory(config: LLMConfig): Promise<CompactionResult> {
    const beforeUsage = this.getContextUsage(config);
    const beforeTokens = beforeUsage.totalTokens;
    const beforeMessages = beforeUsage.messageCount;

    if (this.conversationHistory.length < 4) {
      return {
        success: false,
        error: 'Not enough conversation history to compress.',
        beforeTokens,
        afterTokens: beforeTokens,
        beforeMessages,
        afterMessages: beforeMessages,
      };
    }

    const { head, tail } = splitHeadTail(
      this.conversationHistory as AdapterMessage[],
      DEFAULT_TAIL_TURNS,
    );

    if (head.length === 0) {
      return {
        success: false,
        error: 'Nothing to compress — the recent turns cover the entire history.',
        beforeTokens,
        afterTokens: beforeTokens,
        beforeMessages,
        afterMessages: beforeMessages,
      };
    }

    // DevEco uses a non-streaming endpoint for the summarization call.
    const url = `${this.getBaseUrl()}${NO_STREAM_PATH}`;
    const headers = await this.buildHeaders(false);
    const model = config.model || 'GLM-5.1';

    let summary: string | null;
    try {
      summary = await performCompaction(head as AdapterMessage[], config, {
        url,
        headers,
        model,
      });
    } catch (err) {
      return {
        success: false,
        error: `Compaction failed: ${String(err)}`,
        beforeTokens,
        afterTokens: beforeTokens,
        beforeMessages,
        afterMessages: beforeMessages,
      };
    }

    if (!summary) {
      return {
        success: false,
        error: 'Compaction produced an empty summary.',
        beforeTokens,
        afterTokens: beforeTokens,
        beforeMessages,
        afterMessages: beforeMessages,
      };
    }

    this.conversationHistory = buildCompactedHistory(
      this.conversationHistory as AdapterMessage[],
      summary,
      tail as AdapterMessage[],
    ) as DevecoMessage[];
    this.pendingToolCallIdQueue = rebuildPendingToolCallIds(
      this.conversationHistory as AdapterMessage[],
    );

    const afterUsage = this.getContextUsage(config);
    return {
      success: true,
      beforeTokens,
      afterTokens: afterUsage.totalTokens,
      beforeMessages,
      afterMessages: afterUsage.messageCount,
      summary,
    };
  }

  // ── Abort handling ─────────────────────────────────────────────────────────

  abort(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }

  getAbortController(): AbortController {
    if (!this.abortController) {
      this.abortController = new AbortController();
    }
    return this.abortController;
  }

  // ── Model list (optional helper) ───────────────────────────────────────────

  /**
   * Fetch available models from DevEco modelConfig endpoint.
   * Returns null on failure.
   */
  static async fetchModels(accessToken: string, baseUrl?: string): Promise<Array<{ id: string; name: string }> | null> {
    const base = (baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
    try {
      const response = await fetch(`${base}${MODEL_CONFIG_PATH}?localVersion=0&pluginVersion=CLI.1.0.0`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(15000),
      });

      if (!response.ok) return null;

      const data = await response.json() as Record<string, unknown>;
      const models = data.models as Array<Record<string, unknown>> | undefined;
      if (!Array.isArray(models)) return null;

      return models.map(m => ({
        id: String(m.id || m.model || ''),
        name: String(m.name || m.display_name || m.id || ''),
      }));
    } catch {
      return null;
    }
  }

  /**
   * Fetch available models from DevEco modelConfig endpoint using this adapter's credentials.
   * Returns an array of model descriptors, or null on failure.
   */
  async fetchModels(): Promise<Array<DevecoModelInfo> | null> {
    const token = await this.resolveAccessToken();
    const base = this.getBaseUrl();
    try {
      const response = await fetch(`${base}${MODEL_CONFIG_PATH}?localVersion=0&pluginVersion=CLI.1.0.0`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(15000),
      });

      if (!response.ok) {
        console.error('[DevEco] fetchModels failed:', response.status);
        return null;
      }

      const data = await response.json() as Record<string, unknown>;
      const body = data.body as Record<string, unknown> | undefined;
      const innerModels = body?.inner_models as Array<Record<string, unknown>> | undefined;
      if (!Array.isArray(innerModels)) return null;

      const result: DevecoModelInfo[] = [];
      for (const group of innerModels) {
        const configs = group.model_configs as Array<Record<string, unknown>> | undefined;
        if (!Array.isArray(configs)) continue;
        for (const cfg of configs) {
          const modelId = String(cfg.model_id || '');
          if (!modelId) continue;
          result.push({
            id: modelId,
            name: modelId,
            contextWindow: Number(cfg.context_window || 0),
            maxOutput: Number(cfg.output || 0),
            thinkingMode: String(cfg.thinking_mode || 'off'),
            toolCallMode: String(cfg.tool_call_mode || 'none'),
            inputModalities: Array.isArray(cfg.input_modalities) ? cfg.input_modalities as string[] : ['text'],
          });
        }
      }
      return result;
    } catch (err) {
      console.error('[DevEco] fetchModels error:', err);
      return null;
    }
  }
}

export interface DevecoModelInfo {
  id: string;
  name: string;
  contextWindow: number;
  maxOutput: number;
  thinkingMode: string;
  toolCallMode: string;
  inputModalities: string[];
}
