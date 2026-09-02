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
 * Cline adapter — OpenAI-compatible endpoint at api.cline.bot.
 *
 * Auth: Bearer token from WorkOS Device Auth flow (access token stored
 * locally after OAuth login). The Cline API backend requires the token
 * to carry the `workos:` prefix in the Authorization header so it can
 * route verification to the WorkOS identity provider. The getToken
 * callback (provided by ClineAuthService) already returns the prefixed
 * token; if a raw token is supplied via config.apiKey or
 * config.clineAccessToken, we add the prefix here.
 *
 * Supports native tool calling (OpenAI function calling) and session
 * compression, same as OpenAIAdapter / DevecoAdapter.
 */

const DEFAULT_BASE_URL = 'https://api.cline.bot/api/v1/chat/completions';
const WORKOS_TOKEN_PREFIX = 'workos:';

/** Required headers for the Cline API billing/metering system. */
const CLINE_REQUEST_HEADERS: Record<string, string> = {
  'HTTP-Referer': 'https://cline.bot',
  'X-Title': 'Cline',
  'X-IS-MULTIROOT': 'false',
  'X-CLIENT-TYPE': 'xai-ide',
  'X-CLIENT-VERSION': '1.0.0',
  'X-PLATFORM': 'xai-ide',
  'X-PLATFORM-VERSION': '1.0.0',
  'X-CORE-VERSION': '1.0.0',
  'User-Agent': 'Cline/1.0.0',
};

/**
 * Ensure the access token has the `workos:` prefix required by the Cline API.
 * Matches Cline SDK's `formatClineApiKey()` in provider-auth-registry.ts.
 */
function formatClineApiKey(token: string): string {
  const t = token.trim();
  return t.toLowerCase().startsWith(WORKOS_TOKEN_PREFIX)
    ? t
    : `${WORKOS_TOKEN_PREFIX}${t}`;
}

export interface ClineAdapterOptions {
  /** Optional async token provider (for OAuth auto-refresh) */
  getToken?: () => Promise<string | null>;
}

// ── OpenAI-compatible API types ──────────────────────────────────────────────

interface ClineToolCallDelta {
  index: number;
  id?: string;
  type?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
}

interface ClineChoice {
  index: number;
  message?: {
    role: string;
    content: string;
    /** DeepSeek / some OpenAI-compatible providers use this field name. */
    reasoning_content?: string;
    /** OpenRouter uses this field name for reasoning output. */
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
    /** DeepSeek / some OpenAI-compatible providers use this field name. */
    reasoning_content?: string;
    /** OpenRouter uses this field name for reasoning deltas. */
    reasoning?: string;
    tool_calls?: ClineToolCallDelta[];
  };
  finish_reason: string | null;
}

interface ClineResponse {
  id: string;
  choices: ClineChoice[];
  model: string;
}

interface ClineMessage {
  role: string;
  content: string | null;
  /** Native reasoning field — replay previous turn's thinking to the model.
   *  OpenRouter accepts `reasoning_content` on assistant messages to preserve
   *  reasoning context across turns (avoids repeated thinking). */
  reasoning_content?: string;
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

export class ClineAdapter implements LLMAdapter {
  readonly supportsNativeTools = true;
  readonly supportsCompression = true;

  private options: ClineAdapterOptions;
  private abortController: AbortController | null = null;
  /** Full conversation history in OpenAI message format. */
  private conversationHistory: ClineMessage[] = [];
  /** FIFO queue of tool_call_ids for matching incoming tool results. */
  private pendingToolCallIdQueue: string[] = [];
  /** Stable conversation ID for local persistence (regenerated on reset). */
  private _conversationId: string;

  constructor(options: ClineAdapterOptions = {}) {
    this.options = { ...options };
    this._conversationId = uuidNoHyphen();
  }

  get conversationId(): string {
    return this._conversationId;
  }

  // ── Session management ─────────────────────────────────────────────────────

  resetSession(): void {
    this.conversationHistory = [];
    this.pendingToolCallIdQueue = [];
    this._conversationId = uuidNoHyphen();
  }

  getConversationHistory(): ClineMessage[] {
    return [...this.conversationHistory];
  }

  /**
   * Snapshot the current session state (history + pending tool-call IDs).
   * Used to run a standalone generation (e.g. Designer) without polluting the
   * long-lived Code-view session: snapshotSession → resetSession → run →
   * restoreSession. The Code view shares this same adapter instance.
   */
  snapshotSession(): { history: ClineMessage[]; pendingToolCallIds: string[] } {
    return {
      history: this.conversationHistory.map(m => ({ ...m })),
      pendingToolCallIds: [...this.pendingToolCallIdQueue],
    };
  }

  /** Restore a previously snapshotted session. */
  restoreSession(snapshot: { history: ClineMessage[]; pendingToolCallIds: string[] }): void {
    this.conversationHistory = snapshot.history.map(m => ({ ...m }));
    this.pendingToolCallIdQueue = [...snapshot.pendingToolCallIds];
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

  /** Import a migratable snapshot, replacing the current session state. */
  importSnapshot(snapshot: MigratableSnapshot): void {
    this.conversationHistory = snapshot.history.map(m => ({
      role: m.role,
      content: m.content,
      ...(m.reasoning_content ? { reasoning_content: m.reasoning_content } : {}),
      ...(m.tool_calls ? { tool_calls: m.tool_calls.map(tc => ({ ...tc, function: { ...tc.function } })) } : {}),
      ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
    }));
    this.pendingToolCallIdQueue = [...snapshot.pendingToolCallIds];
  }

  // ── Local conversation persistence ──────────────────────────────────────────

  /** Get serializable adapter state for local saving. */
  getAdapterState(): { conversationHistory: ClineMessage[]; pendingToolCallIds: string[] } {
    return {
      conversationHistory: this.conversationHistory.map(m => ({ ...m })),
      pendingToolCallIds: [...this.pendingToolCallIdQueue],
    };
  }

  /** Restore adapter state from a locally saved snapshot. */
  setAdapterState(state: { conversationHistory: ClineMessage[]; pendingToolCallIds: string[] }): void {
    this.conversationHistory = state.conversationHistory.map(m => ({ ...m }));
    this.pendingToolCallIdQueue = [...state.pendingToolCallIds];
  }

  /** Restore the conversation ID after loading a locally saved conversation. */
  setConversationId(conversationId: string): void {
    this._conversationId = conversationId;
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

  // ── translateInput ─────────────────────────────────────────────────────────

  async translateInput(messages: Message[], config: LLMConfig): Promise<HttpRequest> {
    this.appendNewMessages(messages);

    const clineMessages = this.conversationHistory.map(m => {
      const out: Record<string, unknown> = { role: m.role, content: m.content };
      // Replay reasoning_content on assistant messages so the model sees its
      // previous thinking and doesn't re-think from scratch each turn.
      // OpenRouter accepts this field natively on assistant messages.
      if (m.reasoning_content) out['reasoning_content'] = m.reasoning_content;
      if (m.tool_calls) out['tool_calls'] = m.tool_calls;
      if (m.tool_call_id) out['tool_call_id'] = m.tool_call_id;
      return out;
    });

    const body: Record<string, unknown> = {
      model: config.model,
      messages: clineMessages,
      stream: config.stream ?? true,
      temperature: config.temperature,
    };

    if (config.maxTokens !== undefined) {
      body['max_tokens'] = config.maxTokens;
    }

    // Inject native tool definitions when provided
    const options = config.options as Record<string, unknown> | undefined;
    const tools = options?.tools;
    if (tools && Array.isArray(tools) && (tools as unknown[]).length > 0) {
      body['tools'] = tools;
      body['tool_choice'] = 'auto';
    }

    // Enable reasoning / thinking mode when configured.
    // Cline API (api.cline.bot) is an OpenRouter proxy, which uses the
    // `reasoning: { effort: "high" }` format — NOT OpenAI's `reasoning_effort`.
    // See: https://openrouter.ai/docs/guides/best-practices/reasoning-tokens
    if (options?.reasoningEffort) {
      if (options.reasoningEffort === 'off') {
        // Explicitly disable reasoning
        body['reasoning'] = { effort: 'none' };
      } else {
        body['reasoning'] = { effort: options.reasoningEffort };
      }
    }

    // Generic escape hatch for non-standard API params
    const extraBody = options?.extraBody;
    if (extraBody && typeof extraBody === 'object' && !Array.isArray(extraBody)) {
      for (const [k, v] of Object.entries(extraBody)) {
        if (!(k in body)) body[k] = v;
      }
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...CLINE_REQUEST_HEADERS,
    };

    // Auth: resolve token lazily via getToken (OAuth auto-refresh), fallback to static config.
    // The Cline API requires the `workos:` prefix on the Bearer token.
    // - getToken (from ClineAuthService) already returns a prefixed token.
    // - Static config values (clineAccessToken, apiKey) may lack the prefix,
    //   so we ensure it via formatClineApiKey().
    let accessToken: string | undefined = (config as unknown as Record<string, unknown>).clineAccessToken as string | undefined;
    if (!accessToken && this.options.getToken) {
      try {
        accessToken = await this.options.getToken() ?? undefined;
      } catch {
        // ignore
      }
    }
    if (accessToken) {
      headers['Authorization'] = `Bearer ${formatClineApiKey(accessToken)}`;
    } else if (config.apiKey) {
      headers['Authorization'] = `Bearer ${formatClineApiKey(config.apiKey)}`;
    }

    if (config.customHeaders) {
      Object.assign(headers, config.customHeaders);
    }

    return {
      url: config.baseUrl ?? DEFAULT_BASE_URL,
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    };
  }

  // ── Message history helpers ────────────────────────────────────────────────

  private appendNewMessages(messages: Message[]): void {
    for (const msg of messages) {
      if (msg.role === 'tool' && msg.toolName) {
        const toolCallId = this.pendingToolCallIdQueue.shift();
        if (toolCallId) {
          this.conversationHistory.push({
            role: 'tool',
            content: msg.content,
            tool_call_id: toolCallId,
          });
        } else {
          // 配不上原生 tool_call_id 的工具结果来自 ++++ 文本格式工具
          // （write_to_file / replace_in_file）或格式纠正反馈。绝不能丢弃：
          // 丢弃会让模型认为 ++++ 调用"没有回音"，进而退化为滥用
          // execute_command（echo 挪步）。降级为 user 消息回传，内容自带
          // [Tool Result] 前缀，模型可以理解。
          console.warn('[Cline] Tool message without matching tool_call_id, delivering as user message');
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
        this.conversationHistory.push({ role: 'user', content: msg.content });
      } else if (msg.role === 'assistant') {
        this.conversationHistory.push({ role: 'assistant', content: msg.content });
      }
    }
  }

  // ── translateOutput ────────────────────────────────────────────────────────

  translateOutput(response: unknown): Message {
    const data = response as ClineResponse;
    const choice = data.choices?.[0];
    if (!choice) {
      return { role: 'assistant', content: '', timestamp: Date.now() };
    }

    // Extract reasoning from either field name (OpenRouter: reasoning, DeepSeek: reasoning_content)
    const reasoning = choice.message?.reasoning_content ?? choice.message?.reasoning ?? '';

    const toolCalls = choice.message?.tool_calls;
    if (toolCalls && toolCalls.length > 0) {
      const msg: ClineMessage = {
        role: 'assistant',
        content: choice.message?.content ?? null,
        ...(reasoning && reasoning.trim() ? { reasoning_content: reasoning } : {}),
        tool_calls: toolCalls.map(tc => ({
          id: tc.id,
          type: tc.type,
          function: { name: tc.function.name, arguments: tc.function.arguments },
        })),
      };
      this.conversationHistory.push(msg);
      for (const tc of toolCalls) {
        this.pendingToolCallIdQueue.push(tc.id);
      }
      const firstCall = toolCalls[0];
      let params: Record<string, unknown> = {};
      try { params = JSON.parse(firstCall.function.arguments); } catch { /* ignore */ }
      return {
        role: 'assistant',
        content: choice.message?.content || '',
        timestamp: Date.now(),
        toolName: firstCall.function.name,
        toolResult: { toolName: firstCall.function.name, success: true, output: '' },
      };
    }

    // Pure text response — also persist reasoning
    const msg: ClineMessage = {
      role: 'assistant',
      content: choice.message?.content || null,
      ...(reasoning && reasoning.trim() ? { reasoning_content: reasoning } : {}),
    };
    this.conversationHistory.push(msg);

    return {
      role: 'assistant',
      content: choice.message?.content || '',
      timestamp: Date.now(),
    };
  }

  // ── translateStream ────────────────────────────────────────────────────────

  async *translateStream(stream: AsyncIterable<Buffer>): AsyncIterable<StreamChunk> {
    this.abortController = new AbortController();
    let buffer = '';
    // 流式 UTF-8 解码器：decode(chunk, { stream: true }) 会暂存 chunk 结尾
    // 不完整的 UTF-8 字节，等下一块到达时合并解码。若像旧实现那样对每个
    // chunk 独立 toString('utf-8')，多字节汉字一旦被分块边界切断，残字节
    // 会被替换成 U+FFFD 并"焊死"进字符串，产生偶发乱码。
    const decoder = new TextDecoder('utf-8');
    let assistantContent = '';
    // 累积推理内容，结束时拼进 content 持久化到 history，
    // 让下一轮迭代模型能看到自己上一轮的推理，避免重复思考。
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
            // Flush accumulated tool calls
            for (const [, acc] of toolCallAccumulators) {
              yield { type: 'tool_call', content: '', toolCall: { name: acc.name, parameters: (() => { try { return JSON.parse(acc.arguments); } catch { return {}; } })() } };
            }
            // Commit assistant message (text + reasoning + tool_calls) to history
            this.commitAssistant(assistantContent, assistantReasoning, toolCallAccumulators);
            yield { type: 'done', content: '' };
            return;
          }

          let parsed: ClineResponse;
          try { parsed = JSON.parse(data) as ClineResponse; } catch { continue; }
          const choice = parsed.choices?.[0];
          if (!choice) continue;
          const delta = choice.delta;
          if (!delta) continue;

          // Reasoning content (thinking mode) — stream each delta immediately,
          // matching the OpenAI adapter. Previously this was buffered and only
          // flushed when delta.content arrived, which starved the consumer during
          // long high-effort reasoning phases (the Designer handler's for-await
          // blocked, the renderer showed "正在等待 AI 响应..." with no output for
          // minutes). Incremental streaming keeps the UI live.
          //
          // OpenRouter returns reasoning in `delta.reasoning`; some providers
          // (DeepSeek) use `delta.reasoning_content`. Check both.
          const reasoningDelta = delta.reasoning_content ?? delta.reasoning;
          if (reasoningDelta) {
            assistantReasoning += reasoningDelta;
            yield { type: 'thinking', content: reasoningDelta };
          }

          // Text content
          if (delta.content) {
            assistantContent += delta.content;
            yield { type: 'text', content: delta.content };
          }

          // Tool call deltas (streamed incrementally)
          if (delta.tool_calls) {
            for (const tcDelta of delta.tool_calls) {
              const idx = tcDelta.index;
              if (!toolCallAccumulators.has(idx)) {
                toolCallAccumulators.set(idx, { id: '', name: '', arguments: '' });
              }
              const acc = toolCallAccumulators.get(idx)!;
              if (tcDelta.id) acc.id = tcDelta.id;
              if (tcDelta.function?.name) acc.name = tcDelta.function.name;
              if (tcDelta.function?.arguments) acc.arguments += tcDelta.function.arguments;
            }
          }

          // Finish reason
          if (choice.finish_reason === 'tool_calls') {
            for (const [, acc] of toolCallAccumulators) {
              yield { type: 'tool_call', content: '', toolCall: { name: acc.name, parameters: (() => { try { return JSON.parse(acc.arguments); } catch { return {}; } })() } };
            }
            this.commitAssistant(assistantContent, assistantReasoning, toolCallAccumulators);
            toolCallAccumulators.clear();
            yield { type: 'done', content: '' };
            return;
          }

          if (choice.finish_reason === 'stop') {
            // 纯文本回答也要进历史（原实现漏了这一步，导致纯文本回答不入 history）
            this.commitAssistant(assistantContent, assistantReasoning, toolCallAccumulators);
            yield { type: 'done', content: '' };
            return;
          }
        }
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        yield { type: 'done', content: '' };
        return;
      }
      throw err;
    }

    // Stream ended without [DONE] — flush any remaining tool calls
    // 冲刷解码器缓存的不完整字节（正常结束时应为空字符串）。
    buffer += decoder.decode();
    for (const [, acc] of toolCallAccumulators) {
      yield { type: 'tool_call', content: '', toolCall: { name: acc.name, parameters: (() => { try { return JSON.parse(acc.arguments); } catch { return {}; } })() } };
    }
    this.commitAssistant(assistantContent, assistantReasoning, toolCallAccumulators);
    yield { type: 'done', content: '' };
  }

  // ── History commit helper ──────────────────────────────────────────────────

  /**
   * 把本轮 assistant 响应写入 conversationHistory 并排队 tool_call_id。
   * 若有 reasoning，存入 ClineMessage.reasoning_content 原生字段，
   * 下次请求时原样回传给模型（OpenRouter 支持 assistant 消息携带
   * reasoning_content 以保持跨轮推理连续性），避免模型重复思考。
   * 非推理模型 reasoning 为空，content 不受影响。
   */
  private commitAssistant(
    content: string,
    reasoning: string,
    toolCallAccumulators: Map<number, { id: string; name: string; arguments: string }>,
  ): void {
    const msg: ClineMessage = {
      role: 'assistant',
      content: content || null,
    };

    // Persist reasoning in the native reasoning_content field so it gets
    // replayed to the model on the next turn (see translateInput).
    if (reasoning && reasoning.trim()) {
      msg.reasoning_content = reasoning;
    }

    if (toolCallAccumulators.size > 0) {
      msg.tool_calls = [];
      for (const [, acc] of toolCallAccumulators) {
        msg.tool_calls.push({
          id: acc.id,
          type: 'function',
          function: { name: acc.name, arguments: acc.arguments },
        });
        this.pendingToolCallIdQueue.push(acc.id);
      }
    }

    this.conversationHistory.push(msg);
  }

  // ── Abort ──────────────────────────────────────────────────────────────────

  abort(): void {
    this.abortController?.abort();
    this.abortController = null;
  }

  // ── Session compression (context mirrors OpenAIAdapter) ────────────────────

  getContextUsage(config: LLMConfig): ContextUsage {
    const contextWindow = getContextWindow('cline', config.model, config.contextWindow);
    return computeUsage(this.conversationHistory, contextWindow);
  }

  async compressHistory(config: LLMConfig): Promise<CompactionResult> {
    const contextWindow = getContextWindow('cline', config.model, config.contextWindow);
    const beforeUsage = computeUsage(this.conversationHistory, contextWindow);
    const beforeTokens = beforeUsage.totalTokens;
    const beforeMessages = this.conversationHistory.length;

    if (this.conversationHistory.length <= 4) {
      return { success: true, beforeTokens, afterTokens: beforeTokens, beforeMessages, afterMessages: beforeMessages };
    }

    const { head, tail } = splitHeadTail(this.conversationHistory, DEFAULT_TAIL_TURNS);
    if (head.length === 0) {
      return { success: true, beforeTokens, afterTokens: beforeTokens, beforeMessages, afterMessages: beforeMessages };
    }

    try {
      // Resolve access token for the compaction LLM call
      let accessToken: string | undefined;
      if (this.options.getToken) {
        try { accessToken = await this.options.getToken() ?? undefined; } catch { /* ignore */ }
      }
      if (!accessToken) {
        accessToken = (config as unknown as Record<string, unknown>).clineAccessToken as string | undefined;
      }

      const summary = await performCompaction(head, config, {
        url: config.baseUrl ?? DEFAULT_BASE_URL,
        headers: {
          'Content-Type': 'application/json',
          ...CLINE_REQUEST_HEADERS,
          ...(accessToken ? { 'Authorization': `Bearer ${formatClineApiKey(accessToken)}` } : {}),
          ...(config.customHeaders ?? {}),
        },
        model: config.model,
      });

      if (!summary) {
        return { success: false, error: 'Compaction returned empty summary', beforeTokens, afterTokens: beforeTokens, beforeMessages, afterMessages: beforeMessages };
      }

      const newHistory = buildCompactedHistory(this.conversationHistory, summary, tail);
      const newToolCallIds = rebuildPendingToolCallIds(newHistory);
      this.conversationHistory = newHistory;
      this.pendingToolCallIdQueue = newToolCallIds;

      const afterUsage = computeUsage(this.conversationHistory, contextWindow);
      return {
        success: true,
        beforeTokens,
        afterTokens: afterUsage.totalTokens,
        beforeMessages,
        afterMessages: this.conversationHistory.length,
        summary,
      };
    } catch (err) {
      return { success: false, error: String(err), beforeTokens, afterTokens: beforeTokens, beforeMessages, afterMessages: beforeMessages };
    }
  }
}