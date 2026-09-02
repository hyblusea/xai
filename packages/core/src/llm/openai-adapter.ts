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

const OPENAI_DEFAULT_BASE_URL = 'https://api.openai.com/v1/chat/completions';

// ── OpenAI API response types ──────────────────────────────────────────────────

interface OpenAIToolCallDelta {
  index: number;
  id?: string;
  type?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
}

interface OpenAIChoice {
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
    tool_calls?: OpenAIToolCallDelta[];
  };
  finish_reason: string | null;
}

interface OpenAIResponse {
  id: string;
  choices: OpenAIChoice[];
  model: string;
}

// ── Internal message type (OpenAI API format) ────────────────────────────────

interface OpenAIMessage {
  role: string;
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: string;
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

// ── Adapter ──────────────────────────────────────────────────────────────────

function uuidNoHyphen(): string {
  return 'xxxxxxxxxxxx4xxxyxxxxxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export class OpenAIAdapter implements LLMAdapter {
  readonly supportsNativeTools = true;
  readonly supportsCompression = true;

  private abortController: AbortController | null = null;
  /** Full conversation history in OpenAI message format. */
  private conversationHistory: OpenAIMessage[] = [];
  /** FIFO queue of tool_call_ids for matching incoming tool results. */
  private pendingToolCallIdQueue: string[] = [];
  /** Stable conversation ID for local persistence (regenerated on reset). */
  private _conversationId: string;

  constructor() {
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

  getConversationHistory(): OpenAIMessage[] {
    return [...this.conversationHistory];
  }

  /**
   * Snapshot the current session state (history + pending tool-call IDs).
   * Used to run a standalone generation (e.g. Designer) without polluting the
   * long-lived Code-view session: snapshotSession → resetSession → run →
   * restoreSession. The Code view shares this same adapter instance.
   */
  snapshotSession(): { history: OpenAIMessage[]; pendingToolCallIds: string[] } {
    return {
      history: this.conversationHistory.map(m => ({ ...m })),
      pendingToolCallIds: [...this.pendingToolCallIdQueue],
    };
  }

  /** Restore a previously snapshotted session. */
  restoreSession(snapshot: { history: OpenAIMessage[]; pendingToolCallIds: string[] }): void {
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
      ...(m.tool_calls ? { tool_calls: m.tool_calls.map(tc => ({ ...tc, function: { ...tc.function } })) } : {}),
      ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
    }));
    this.pendingToolCallIdQueue = [...snapshot.pendingToolCallIds];
  }

  // ── Local conversation persistence ──────────────────────────────────────────

  /** Get serializable adapter state for local saving. */
  getAdapterState(): { conversationHistory: OpenAIMessage[]; pendingToolCallIds: string[] } {
    return {
      conversationHistory: this.conversationHistory.map(m => ({ ...m })),
      pendingToolCallIds: [...this.pendingToolCallIdQueue],
    };
  }

  /** Restore adapter state from a locally saved snapshot. */
  setAdapterState(state: { conversationHistory: OpenAIMessage[]; pendingToolCallIds: string[] }): void {
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
    // Append only genuinely new messages from this iteration.
    // - First iteration: system + user (both new)
    // - Subsequent iterations: tool result messages only
    this.appendNewMessages(messages);

    // Build OpenAI-format messages from full history
    const openaiMessages = this.conversationHistory.map(m => {
      const out: Record<string, unknown> = { role: m.role, content: m.content };
      if (m.tool_calls) out['tool_calls'] = m.tool_calls;
      if (m.tool_call_id) out['tool_call_id'] = m.tool_call_id;
      return out;
    });

    const body: Record<string, unknown> = {
      model: config.model,
      messages: openaiMessages,
      stream: config.stream ?? true,
      temperature: config.temperature,
    };
    // 仅在用户显式设置 maxTokens 时下发；留空则由 API 使用模型默认值
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
    // Supported values: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
    // 'off' means reasoning is explicitly disabled — omit the param entirely
    // (OpenAI-compatible APIs reject unknown reasoning_effort values, and 'off'
    // can leak in from other providers' snapshots via options inheritance).
    if (options?.reasoningEffort && options.reasoningEffort !== 'off') {
      // OpenRouter expects its unified `reasoning: { effort }` format;
      // OpenAI official & most OpenAI-compatible APIs use `reasoning_effort`.
      // See: https://openrouter.ai/docs/guides/best-practices/reasoning-tokens
      const baseUrl = config.baseUrl ?? '';
      if (baseUrl.includes('openrouter.ai')) {
        body['reasoning'] = { effort: options.reasoningEffort };
      } else {
        body['reasoning_effort'] = options.reasoningEffort;
      }
    }

    // Generic escape hatch for non-standard API params (e.g. vLLM's
    // `chat_template_kwargs: { enable_thinking: true }`). Any plain object
    // provided via options.extraBody is merged verbatim into the request body,
    // so per-provider quirks can be supported without touching the adapter.
    const extraBody = options?.extraBody;
    if (extraBody && typeof extraBody === 'object' && !Array.isArray(extraBody)) {
      for (const [k, v] of Object.entries(extraBody)) {
        // Don't let extraBody overwrite the standard fields we set above
        if (!(k in body)) body[k] = v;
      }
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (config.apiKey) {
      headers['Authorization'] = `Bearer ${config.apiKey}`;
    }

    if (config.customHeaders) {
      Object.assign(headers, config.customHeaders);
    }

    return {
      url: config.baseUrl ?? OPENAI_DEFAULT_BASE_URL,
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    };
  }

  // ── Message history helpers ────────────────────────────────────────────────

  /**
   * Append messages that are genuinely new (not already in history).
   * - Tool messages are converted using the pending tool_call_id queue.
   * - System/user/assistant messages are converted directly.
   */
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
          console.warn('[OpenAI] Tool message without matching tool_call_id, delivering as user message');
          this.conversationHistory.push({ role: 'user', content: msg.content });
        }
      } else if (msg.role === 'system') {
        // Only add system if history doesn't already have one.
        // Insert at the beginning (OpenAI requires system message first).
        const hasSystem = this.conversationHistory.some(m => m.role === 'system');
        if (!hasSystem && msg.content) {
          this.conversationHistory.unshift({ role: 'system', content: msg.content });
        }
      } else if (msg.role === 'user') {
        // Only add if last user message in history is different
        const lastUser = [...this.conversationHistory].reverse().find(m => m.role === 'user');
        if (!lastUser || lastUser.content !== msg.content) {
          this.conversationHistory.push({ role: 'user', content: msg.content });
        }
      }
      // assistant messages are added in translateStream after response is received
    }
  }

  // ── translateOutput (non-streaming) ────────────────────────────────────────

  translateOutput(response: unknown): Message {
    const data = response as OpenAIResponse;
    const choice = data.choices?.[0];
    const content = choice?.message?.content ?? '';
    // OpenRouter returns `reasoning`; DeepSeek-style providers use `reasoning_content`.
    const reasoning = choice?.message?.reasoning_content ?? choice?.message?.reasoning ?? '';

    // Wrap reasoning in <think> tags, consistent with commitAssistantMessage,
    // so non-streaming responses preserve the thinking content too.
    const finalContent = reasoning && reasoning.trim()
      ? `<think>\n${reasoning}\n</think>\n${content}`
      : content;

    return {
      role: 'assistant',
      content: finalContent,
      timestamp: Date.now(),
    };
  }

  // ── translateStream ────────────────────────────────────────────────────────

  async *translateStream(stream: AsyncIterable<Buffer>): AsyncIterable<StreamChunk> {
    let buffer = '';
    // 流式 UTF-8 解码器：暂存跨 chunk 被切断的多字节字符，避免单独 decode 产生 U+FFFD 乱码。
    const decoder = new TextDecoder('utf-8');

    // Accumulate this turn's assistant response
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

    for await (const chunk of stream) {
      buffer += decoder.decode(chunk, { stream: true });

      const parts = buffer.split('\n\n');
      buffer = parts.pop() ?? '';

      for (const part of parts) {
        const lines = part.split('\n');
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const dataStr = line.slice(6).trim();

          if (dataStr === '[DONE]') {
            // Commit assistant message to history before yielding done
            this.commitAssistantMessage(assistantContent, completedToolCalls, assistantReasoning);
            yield { type: 'done', content: '' };
            return;
          }

          if (dataStr === '') continue;

          try {
            const parsed = JSON.parse(dataStr) as OpenAIResponse;
            const choice = parsed.choices?.[0];
            if (!choice) continue;

            // ── reasoning / thinking ──────────────────────────────────────
            // OpenRouter streams reasoning as `delta.reasoning`; DeepSeek and
            // most other OpenAI-compatible providers use `delta.reasoning_content`.
            // Accept both — `reasoning_content` takes priority.
            const reasoningContent = choice.delta?.reasoning_content ?? choice.delta?.reasoning;
            if (reasoningContent) {
              assistantReasoning += reasoningContent;
              yield { type: 'thinking', content: reasoningContent };
            }

            // ── text content ──────────────────────────────────────────────
            const content = choice.delta?.content;
            if (content) {
              assistantContent += content;
              yield { type: 'text', content };
            }

            // ── tool_calls deltas ─────────────────────────────────────────
            const toolCallDeltas = choice.delta?.tool_calls;
            if (toolCallDeltas) {
              if (!toolCallStartEmitted) {
                toolCallStartEmitted = true;
                // Signal that a tool call is starting (frontend shows indicator)
                yield { type: 'text', content: '' } as StreamChunk;
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

            // ── finish_reason: tool_calls → parse completed calls ──────────
            if (choice.finish_reason === 'tool_calls' || choice.finish_reason === 'stop') {
              for (const [idx, acc] of toolCallAccumulators) {
                if (completedIndices.has(idx)) continue;
                completedIndices.add(idx);
                try {
                  const parameters = acc.arguments
                    ? JSON.parse(acc.arguments) as Record<string, unknown>
                    : {};
                  completedToolCalls.push({ id: acc.id, name: acc.name, parameters });
                  const toolCall: ToolCall = { name: acc.name, parameters };
                  yield { type: 'tool_call', content: '', toolCall };
                } catch {
                  // Malformed JSON — skip this tool call
                  console.warn('[OpenAI] Failed to parse tool_call arguments:', acc.arguments);
                }
              }
            }

            if (choice.finish_reason === 'stop' && completedToolCalls.length === 0) {
              this.commitAssistantMessage(assistantContent, completedToolCalls, assistantReasoning);
              yield { type: 'done', content: '' };
              return;
            }
          } catch {
            continue;
          }
        }
      }
    }

    // ── Process remaining buffer ─────────────────────────────────────────────
    // 冲刷解码器缓存的不完整字节（正常结束时应为空字符串）。
    buffer += decoder.decode();

    if (buffer.trim()) {
      const lines = buffer.split('\n');
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const dataStr = line.slice(6).trim();
        if (dataStr === '[DONE]' || dataStr === '') continue;

        try {
          const parsed = JSON.parse(dataStr) as OpenAIResponse;
          const choice = parsed.choices?.[0];
          if (!choice) continue;

          const reasoningContent = choice.delta?.reasoning_content ?? choice.delta?.reasoning;
          if (reasoningContent) {
            assistantReasoning += reasoningContent;
            yield { type: 'thinking', content: reasoningContent };
          }

          const content = choice.delta?.content;
          if (content) {
            assistantContent += content;
            yield { type: 'text', content };
          }

          // Handle any remaining tool_calls
          const toolCallDeltas = choice.delta?.tool_calls;
          if (toolCallDeltas) {
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
        } catch {
          continue;
        }
      }
    }

    // Final commit of assistant message to history
    this.commitAssistantMessage(assistantContent, completedToolCalls, assistantReasoning);

    yield { type: 'done', content: '' };
  }

  // ── History commit helper ──────────────────────────────────────────────────

  /**
   * Append the assistant's response to conversation history and
   * queue tool_call_ids for matching future tool result messages.
   *
   * 若本轮模型返回了 reasoning_content，则用 `<think>` 标签包裹后拼到 content 前面，
   * 让下一轮请求能携带上一轮的推理内容，避免模型跨轮重复思考。
   * 非推理模型 reasoning 为空，content 不受影响。
   */
  private commitAssistantMessage(
    content: string,
    toolCalls: Array<{ id: string; name: string; parameters: Record<string, unknown> }>,
    reasoning?: string,
  ): void {
    // 有推理内容时拼进 content 持久化到 history
    const finalContent = reasoning && reasoning.trim()
      ? `<think>\n${reasoning}\n</think>\n${content}`
      : content;
    const msg: OpenAIMessage = {
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

      // Queue IDs in order for matching tool results
      for (const tc of toolCalls) {
        this.pendingToolCallIdQueue.push(tc.id);
      }
    }

    this.conversationHistory.push(msg);
  }

  // ── Session compression (OpenAI / DevEco / Cline) ──────────────────────────────────

  /**
   * Snapshot of how full the adapter's conversation history is, relative to
   * the model's context window. Uses a chars/4 token estimate.
   */
  getContextUsage(config: LLMConfig): ContextUsage {
    const window = getContextWindow('openai', config.model, config.contextWindow);
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

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (config.apiKey) headers['Authorization'] = `Bearer ${config.apiKey}`;
    if (config.customHeaders) Object.assign(headers, config.customHeaders);

    const url = config.baseUrl ?? OPENAI_DEFAULT_BASE_URL;
    const model = config.model;

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
    ) as OpenAIMessage[];
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
}
