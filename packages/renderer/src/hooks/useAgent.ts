import { useState, useCallback, useEffect, useRef } from 'react';
import { IPCChannel, type AgentState, type Message, type ConfirmationRequest, type ToolBatchItem, type ToolResult, type ContextUsage, type CompactionResult } from '@xai/shared';
import { useIpc } from './useIpc';

interface UseAgentReturn {
  state: AgentState;
  messages: Message[];
  sendMessage: (content: string) => void;
  abort: () => void;
  respondConfirmation: (approved: boolean, approveAll?: boolean) => void;
  clearMessages: () => void;
  deleteConversation: () => Promise<boolean>;
  loadHistory: (conversationId: string) => Promise<boolean>;
  confirmationRequest: ConfirmationRequest | null;
  isLoadingHistory: boolean;
  /** Current session context usage (only populated for compression-aware providers). */
  contextUsage: ContextUsage | null;
  /** Info toast from auto-compaction (null = no toast). */
  autoCompressToast: { kind: 'compressing' | 'compressed' | 'error'; message: string } | null;
  /** Manually compact the current session's conversation history. */
  compressSession: () => Promise<{ success: boolean; result?: CompactionResult; error?: string }>;
}

function formatK(tokens: number): string {
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(0)}k`;
  return String(tokens);
}

/**
 * 判断两个工具调用参数是否完全一致。
 * 用于区分"同一调用的重复事件"（deveco/openai 等流式工具调用在异常路径下可能重放）
 * 与"新一轮同名调用"。参数一致视为同一调用，避免产生幽灵气泡。
 */
function paramsEqual(a: unknown, b: unknown): boolean {
  try {
    return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  } catch {
    return false;
  }
}

/**
 * 为工具气泡生成可读摘要。
 * 原生工具调用的 summary 只有工具名（react-loop 传 `${tc.name}`），当同一轮内
 * 同名工具被多次调用（deveco/GLM 常在一轮内 read_file×2 / grep_search×2）时，
 * 折叠状态的气泡看起来完全一样，容易被误认为"一次调用出现了重复气泡"。
 * 这里把关键参数（path/pattern/command/url 等）拼进摘要用于区分。
 */
function buildToolSummary(rawSummary: string | undefined, toolName: string, parameters?: Record<string, unknown>): string {
  // 已有非平凡摘要（Aider ++++ 块内容）→ 直接用
  if (rawSummary && rawSummary.trim() && rawSummary !== toolName) return rawSummary;
  if (!parameters) return rawSummary || '';
  const KEY_PARAMS = ['path', 'pattern', 'command', 'url', 'query', 'sessionId', 'file', 'name'];
  for (const key of KEY_PARAMS) {
    const v = parameters[key];
    if (typeof v === 'string' && v.trim()) {
      const snippet = v.length > 40 ? `${v.slice(0, 40)}…` : v;
      return `${toolName} ${key}=${snippet}`;
    }
  }
  return rawSummary || '';
}

export function useAgent(): UseAgentReturn {
  const { invoke, on, removeListener } = useIpc();
  const [state, setState] = useState<AgentState>('idle');
  const [messages, setMessages] = useState<Message[]>([]);
  const [confirmationRequest, setConfirmationRequest] = useState<ConfirmationRequest | null>(null);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const [contextUsage, setContextUsage] = useState<ContextUsage | null>(null);
  const [autoCompressToast, setAutoCompressToast] = useState<{ kind: 'compressing' | 'compressed' | 'error'; message: string } | null>(null);
  const streamingTextRef = useRef<string>('');
  const thinkingTextRef = useRef<string>('');
  const assistantMessageIndexRef = useRef<number>(-1);
  // Accumulator for tool calls in the current iteration
  const currentBatchRef = useRef<ToolBatchItem[]>([]);
  // Track the messages array index of the current iteration's batch message
  const batchMessageIndexRef = useRef<number>(-1);
  // Track the timestamp of the batch message created in the current iteration,
  // so the fallback search in upsertToolBatch can distinguish "our" batch
  // (created this iteration) from a previous iteration's batch (which must
  // NOT be overwritten — doing so causes earlier tool-call bubbles to vanish).
  const currentBatchTimestampRef = useRef<number>(-1);
  // Track whether a tool summary text was accumulated (now merged into main text)
  const toolSummaryTextRef = useRef<string>('');
  // Mirror of the latest `messages` state, kept in a ref so the
  // 'local-conversation:request-save' IPC listener can read the current
  // displayMessages synchronously without stale-closure issues.
  // 同时是消息更新的唯一数据源：所有更新先同步写入镜像再 setMessages 触发渲染。
  const messagesRef = useRef<Message[]>([]);

  /**
   * 同步应用一次 messages 更新：立即基于 messagesRef 计算新数组并写入镜像，
   * 再用结果触发 React 重渲染。
   *
   * 为什么不能用 setMessages(fn) 的函数式更新：fn 会被 React 推迟到 flush 时
   * 才执行，而 IPC 事件可能被渲染进程背靠背派发（主线程卡顿后积压消息一次
   * 性送达；且主进程在最后一次 toolResult 后同步 emit 下一迭代的 streamReset）。
   * 届时 batchMessageIndexRef / currentBatchTimestampRef 等身份标记已被后续
   * 事件改写，upsertToolBatch 的 in-place 匹配会错位：工具结果被写进新追加的
   * batch 消息又被下一迭代覆盖，原位置气泡永远拿不到 result —— 一直显示
   * "Executing..."（OpenAI / DevEco / Cline 原生工具调用路径高发）。
   * 同步镜像保证更新严格按事件到达顺序、在 refs 一致的时刻完成。
   */
  const applyMessages = useCallback((update: (prev: Message[]) => Message[]) => {
    messagesRef.current = update(messagesRef.current);
    setMessages(messagesRef.current);
  }, []);

  /**
   * Upsert the tool batch message: update in-place if we already created one
   * for this iteration, otherwise create a new batch message.
   */
  const upsertToolBatch = useCallback(() => {
    const batch = currentBatchRef.current;
    if (batch.length === 0) return;
    applyMessages((prev) => {
      const idx = batchMessageIndexRef.current;
      // Check if the tracked index is still valid and points to OUR batch message
      // (timestamp must match the one created this iteration — otherwise the index
      // is stale from a previous iteration and updating in place would overwrite
      // an older batch's bubbles with the current one).
      if (
        idx >= 0 && idx < prev.length &&
        prev[idx]?.toolName === '__tool_batch__' &&
        prev[idx].timestamp === currentBatchTimestampRef.current
      ) {
        // Update in-place (preserve the original creation timestamp so
        // currentBatchTimestampRef can still match on subsequent updates)
        const updated = [...prev];
        updated[idx] = { ...updated[idx], toolBatch: [...batch] };
        return updated;
      }
      // 回退：streamReset 可能已把 batchMessageIndexRef 重置为 -1，但该批气泡仍
      // 在屏幕上。此时若直接新建消息，会产生"原位置气泡丢失 + 末尾新气泡"的重复，
      // 看起来就像气泡"消失/移位"。改为更新最近一个 batch 消息，保持气泡固定在原位。
      //
      // 关键修正：只能更新"当前迭代"创建的 batch 消息，不能覆盖上一轮迭代的 batch。
      // 之前缺少此判断，导致新迭代的工具调用覆盖了上一轮的 batch 消息，使历史工具
      // 调用/工具结果气泡消失。用 currentBatchTimestampRef 区分：只有 timestamp 匹配
      // 的 batch 才是本轮创建的，可以原地更新；否则必须新建。
      const ourTimestamp = currentBatchTimestampRef.current;
      for (let i = prev.length - 1; i >= 0; i--) {
        const m = prev[i];
        if (m.role === 'assistant' && m.toolName === '__tool_batch__') {
          // Only update if this batch was created in the current iteration
          // (timestamp matches). If it belongs to a previous iteration,
          // we must NOT overwrite it — doing so erases earlier tool bubbles.
          if (ourTimestamp > 0 && m.timestamp === ourTimestamp) {
            // Update in-place (preserve creation timestamp for subsequent matches)
            const updated = [...prev];
            updated[i] = { ...m, toolBatch: [...batch] };
            return updated;
          }
          // This is a previous iteration's batch — skip it and keep searching,
          // or fall through to create a new batch message below.
          break;
        }
      }
      // Not found or belongs to a previous iteration — create new batch message
      const newTimestamp = Date.now();
      const newMsg: Message = {
        role: 'assistant',
        content: '',
        timestamp: newTimestamp,
        toolName: '__tool_batch__',
        toolBatch: [...batch],
      };
      batchMessageIndexRef.current = prev.length;
      currentBatchTimestampRef.current = newTimestamp;
      return [...prev, newMsg];
    });
  }, [applyMessages]);

  const upsertAssistantMessage = useCallback((content: string, thinkingContent?: string) => {
    const normalizedThinking = thinkingContent || undefined;
    applyMessages((prev) => {
      const idx = assistantMessageIndexRef.current;
      if (idx >= 0 && idx < prev.length && prev[idx]?.role === 'assistant' && !prev[idx]?.toolName) {
        const updated = [...prev];
        updated[idx] = {
          ...updated[idx],
          content,
          thinkingContent: normalizedThinking,
          timestamp: Date.now(),
        };
        return updated;
      }

      console.log(`[useAgent] upsertAssistantMessage: creating NEW assistant message, idx was ${idx}, prev.length=${prev.length}, hasThinking=${!!normalizedThinking}, hasContent=${!!content}`);

      const newMsg: Message = {
        role: 'assistant',
        content,
        thinkingContent: normalizedThinking,
        timestamp: Date.now(),
      };
      assistantMessageIndexRef.current = prev.length;
      return [...prev, newMsg];
    });
  }, [applyMessages]);

  // Keep messagesRef in sync with the messages state so the save-request
  // listener (registered once below) always sees the latest displayMessages.
  // 正常情况下 applyMessages 已同步维护镜像，这里作为兜底（防止遗漏路径
  // 直接 setMessages 后镜像滞后）。
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  // Local conversation persistence (OpenAI / DevEco / Cline): the main process
  // sends 'local-conversation:request-save' after each completed Code-view turn.
  // We respond by shipping the current displayMessages back via
  // 'local-conversation:save' so both the display layer and the adapter state
  // (which the main process pulls from the adapter directly) get persisted.
  useEffect(() => {
    const handleSaveRequest = (data: unknown) => {
      // payload may carry `title` and — for teardown snapshots taken before a
      // provider/model switch — a pre-captured `capturedState` that the main
      // process needs forwarded back verbatim. Spread the whole payload so
      // nothing is dropped.
      const payload = (data ?? {}) as { title?: string; capturedState?: unknown };
      invoke(IPCChannel.LocalConversationSave, {
        displayMessages: messagesRef.current,
        ...payload,
      }).catch((err) => console.error('[useAgent] Save conversation failed:', err));
    };
    on(IPCChannel.LocalConversationRequestSave, handleSaveRequest);
    return () => {
      removeListener(IPCChannel.LocalConversationRequestSave, handleSaveRequest);
    };
  }, [on, removeListener, invoke]);

  useEffect(() => {
    const handleStateUpdate = (newState: unknown) => {
      const s = newState as AgentState;
      setState(s);
    };

    const handleStreamChunk = (text: unknown) => {
      const chunk = String(text);
      streamingTextRef.current += chunk;
      const currentText = streamingTextRef.current;
      const currentThinking = thinkingTextRef.current;
      if (!currentText.trim() && !currentThinking.trim()) return;
      upsertAssistantMessage(currentText, currentThinking);
    };

    const handleStreamThinking = (text: unknown) => {
      const chunk = String(text);
      thinkingTextRef.current += chunk;
      const currentText = streamingTextRef.current;
      const currentThinking = thinkingTextRef.current;
      console.log(`[useAgent] handleStreamThinking: chunk="${chunk.substring(0, 40)}", totalThinking=${currentThinking.length} chars, assistantIdx=${assistantMessageIndexRef.current}`);
      upsertAssistantMessage(currentText, currentThinking);
    };

    const handleStreamReset = () => {
      console.log(`[useAgent] handleStreamReset: resetting refs (was assistantIdx=${assistantMessageIndexRef.current}, batchIdx=${batchMessageIndexRef.current})`);
      // Reset batch tracking for the new iteration.
      // The previous iteration's batch message is already rendered in the messages list.
      currentBatchRef.current = [];
      batchMessageIndexRef.current = -1;
      currentBatchTimestampRef.current = -1;
      assistantMessageIndexRef.current = -1;
      streamingTextRef.current = '';
      thinkingTextRef.current = '';
      toolSummaryTextRef.current = '';
    };

    const handleStreamToolSummary = (text: unknown) => {
      const chunk = String(text);
      toolSummaryTextRef.current += chunk;
      streamingTextRef.current += chunk;
      const currentText = streamingTextRef.current;
      const currentThinking = thinkingTextRef.current;
      upsertAssistantMessage(currentText, currentThinking);
    };

    const handleToolCallStart = () => {
    };

    const handleToolCallEnd = (data: unknown) => {
      const d = data as { summary: string; toolCall?: { name: string; parameters: Record<string, unknown> } };
      const toolName = d.toolCall?.name || 'unknown';
      // FIFO：把 summary 挂到该名字下第一条"还没有 summary 且没有 result"的条目。
      // 同名多次调用按事件到达顺序一一对应，避免第一条被后续同名调用覆盖。
      const existingIdx = currentBatchRef.current.findIndex(
        (item) => item.toolName === toolName && !item.result && !item.summary
      );
      if (existingIdx >= 0) {
        currentBatchRef.current[existingIdx] = {
          ...currentBatchRef.current[existingIdx],
          summary: buildToolSummary(d.summary, toolName, d.toolCall?.parameters || currentBatchRef.current[existingIdx].parameters),
          parameters: d.toolCall?.parameters || currentBatchRef.current[existingIdx].parameters,
        };
      } else {
        // 没有待补 summary 的同名条目。若已存在参数一致的同名条目，说明这是
        // 同一调用的重复结束事件（流式重放/IPC 重发）——忽略，不创建幽灵条目；
        // 仅当确实不存在对应条目（事件丢失）时才补建。
        const dup = currentBatchRef.current.some(
          (item) => item.toolName === toolName && paramsEqual(item.parameters, d.toolCall?.parameters)
        );
        if (!dup) {
          const item: ToolBatchItem = {
            toolName,
            summary: buildToolSummary(d.summary, toolName, d.toolCall?.parameters),
            parameters: d.toolCall?.parameters,
          };
          currentBatchRef.current.push(item);
        }
      }
      upsertToolBatch();
    };

    const handleToolCall = (data: unknown) => {
      const toolCall = data as { name: string; parameters: Record<string, string> };
      const toolName = toolCall.name;
      // 找到该名字下最后一条"尚未完成"的条目。若参数完全一致，说明这是同一调用的
      // 重复事件（流式重放/IPC 重发），原地补齐参数即可；否则（参数不同）视为新的
      // 同名调用（deveco/GLM 常在一轮内多次调用 read_file / grep_search 等）。
      const sameName = currentBatchRef.current.filter((item) => item.toolName === toolName);
      const last = sameName[sameName.length - 1];
      if (last && !last.result && paramsEqual(last.parameters, toolCall.parameters)) {
        if (!last.parameters && toolCall.parameters) {
          last.parameters = toolCall.parameters as Record<string, unknown>;
        }
      } else {
        const item: ToolBatchItem = {
          toolName,
          parameters: toolCall.parameters as Record<string, unknown>,
        };
        currentBatchRef.current.push(item);
      }
      upsertToolBatch();
    };

    const handleToolExecuting = (data: unknown) => {
      const toolCall = data as { name?: string; params?: Record<string, unknown> };
      if (toolCall.name) {
        const existing = currentBatchRef.current.find(
          (item) => item.toolName === toolCall.name && !item.result
        );
        if (!existing) {
          currentBatchRef.current.push({
            toolName: toolCall.name,
            parameters: toolCall.params,
          });
        } else if (!existing.parameters && toolCall.params) {
          existing.parameters = toolCall.params;
        }
        upsertToolBatch();
      }
      setState('acting');
    };

    const handleToolResult = (data: unknown) => {
      const result = data as {
        toolCall: { name: string };
        result: { success: boolean; output: string; error?: string; executionTime?: number };
      };
      const resultObj: ToolResult = {
        toolName: result.toolCall?.name ?? 'unknown',
        success: result.result.success,
        output: result.result.output,
        error: result.result.error,
        executionTime: result.result.executionTime,
      };
      // Attach result to the FIRST matching batch item (FIFO)。
      // 工具结果与调用按相同顺序到达，用 findIndex 而非 findLastIndex 匹配，
      // 避免同一轮内同名多次调用（deveco/GLM 常见 read_file×2 等）时结果错挂，
      // 也避免重复事件产生"一条 running + 一条 success"的双气泡。
      const batch = currentBatchRef.current;
      const matchIdx = batch.findIndex((item: ToolBatchItem) => item.toolName === result.toolCall?.name && !item.result);
      if (matchIdx >= 0) {
        batch[matchIdx] = { ...batch[matchIdx], result: resultObj };
        upsertToolBatch();
      } else {
        // 当前 batch 里没有可挂载的同名条目（结果晚到：streamReset 已清空 batch，
        // 或事件顺序异常）。回填到屏幕上最近一个 batch 消息里的同名未完成条目，
        // 保持气泡原位更新；仅在确实找不到任何同名气泡时才追加新气泡，
        // 避免"原位置 running + 末尾新增 success"的双份/移位问题。
        applyMessages((prev) => {
          for (let i = prev.length - 1; i >= 0; i--) {
            const m = prev[i];
            if (m.role === 'assistant' && m.toolName === '__tool_batch__' && m.toolBatch) {
              const j = m.toolBatch.findIndex((item: ToolBatchItem) => item.toolName === result.toolCall?.name && !item.result);
              if (j >= 0) {
                const updated = [...prev];
                const tb = [...m.toolBatch];
                tb[j] = { ...tb[j], result: resultObj };
                // 保留原 timestamp，不破坏 batch 消息的身份标识
                updated[i] = { ...m, toolBatch: tb };
                return updated;
              }
            }
          }
          // 没有任何"未完成"的同名气泡。若已存在带结果的同名气泡，说明这是
          // 同一调用的结果重发（流式重放/重复执行）——忽略，不追加重复气泡；
          // 仅当确实没有任何同名气泡（toolCall 事件全部丢失）时才补建。
          const hasResultForName = prev.some(
            (m) => m.role === 'assistant' && m.toolName === '__tool_batch__' && m.toolBatch?.some(
              (item) => item.toolName === result.toolCall?.name && !!item.result
            )
          );
          if (hasResultForName) return prev;
          return [...prev, {
            role: 'assistant',
            content: '',
            timestamp: Date.now(),
            toolName: '__tool_batch__',
            toolBatch: [{ toolName: result.toolCall?.name ?? 'unknown', result: resultObj }],
          }];
        });
      }
      setState('observing');
    };

    const handleConfirmationRequest = (data: unknown) => {
      const request = data as ConfirmationRequest;
      setConfirmationRequest(request);
      setState('waiting_confirmation');
    };

    const handleError = (errorMsg: unknown) => {
      setState('error');
      applyMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          content: `Error: ${String(errorMsg)}`,
          timestamp: Date.now(),
        },
      ]);
      streamingTextRef.current = '';
      thinkingTextRef.current = '';
      assistantMessageIndexRef.current = -1;
    };

    const handleCompleted = () => {
      setState('idle');
      streamingTextRef.current = '';
      thinkingTextRef.current = '';
      toolSummaryTextRef.current = '';
      assistantMessageIndexRef.current = -1;
    };

    const handleContextUpdate = (usage: unknown) => {
      setContextUsage(usage as ContextUsage);
    };

    const handleCompressing = (info: unknown) => {
      const { usagePercent } = info as { usagePercent: number };
      setAutoCompressToast({ kind: 'compressing', message: `上下文使用率 ${usagePercent}%，正在自动压缩…` });
      // Safety net: auto-dismiss the "compressing" toast after 30 seconds
      // if no 'compressed' or 'compressError' event arrives (e.g. the
      // compaction call hangs or the IPC event is lost).
      window.setTimeout(() => {
        setAutoCompressToast(prev => {
          // Only dismiss if still in 'compressing' state — if 'compressed'
          // or 'error' already arrived, leave it alone.
          return prev?.kind === 'compressing' ? null : prev;
        });
      }, 30_000);
    };

    const handleCompressed = (info: unknown) => {
      const { beforeMessages, afterMessages, beforeTokens, afterTokens } = info as {
        beforeMessages: number; afterMessages: number; beforeTokens: number; afterTokens: number;
      };
      setAutoCompressToast({
        kind: 'compressed',
        message: `已压缩：${beforeMessages}→${afterMessages} 消息，${formatK(beforeTokens)}→${formatK(afterTokens)} tokens`,
      });
      // Auto-dismiss after 4 seconds.
      window.setTimeout(() => setAutoCompressToast(null), 4000);
    };

    const handleCompressError = (info: unknown) => {
      const { error } = info as { error: string };
      setAutoCompressToast({
        kind: 'error',
        message: `自动压缩失败：${error || '未知错误'}`,
      });
      // Auto-dismiss after 5 seconds.
      window.setTimeout(() => setAutoCompressToast(null), 5000);
    };

    on(IPCChannel.AgentStateUpdate, handleStateUpdate);
    on(IPCChannel.AgentStreamChunk, handleStreamChunk);
    on(IPCChannel.AgentStreamThinking, handleStreamThinking);
    on(IPCChannel.AgentStreamReset, handleStreamReset);
    on(IPCChannel.AgentStreamToolSummary, handleStreamToolSummary);
    on(IPCChannel.AgentToolCallStart, handleToolCallStart);
    on(IPCChannel.AgentToolCallEnd, handleToolCallEnd);
    on(IPCChannel.AgentToolCall, handleToolCall);
    on(IPCChannel.ToolExecuting, handleToolExecuting);
    on(IPCChannel.ToolResult, handleToolResult);
    on(IPCChannel.AgentConfirmationRequest, handleConfirmationRequest);
    on(IPCChannel.AgentError, handleError);
    on(IPCChannel.AgentCompleted, handleCompleted);
    on(IPCChannel.AgentContextUpdate, handleContextUpdate);
    on(IPCChannel.AgentCompressing, handleCompressing);
    on(IPCChannel.AgentCompressed, handleCompressed);
    on(IPCChannel.AgentCompressError, handleCompressError);

    return () => {
      removeListener(IPCChannel.AgentStateUpdate, handleStateUpdate);
      removeListener(IPCChannel.AgentStreamChunk, handleStreamChunk);
      removeListener(IPCChannel.AgentStreamThinking, handleStreamThinking);
      removeListener(IPCChannel.AgentStreamReset, handleStreamReset);
      removeListener(IPCChannel.AgentStreamToolSummary, handleStreamToolSummary);
      removeListener(IPCChannel.AgentToolCallStart, handleToolCallStart);
      removeListener(IPCChannel.AgentToolCallEnd, handleToolCallEnd);
      removeListener(IPCChannel.AgentToolCall, handleToolCall);
      removeListener(IPCChannel.ToolExecuting, handleToolExecuting);
      removeListener(IPCChannel.ToolResult, handleToolResult);
      removeListener(IPCChannel.AgentConfirmationRequest, handleConfirmationRequest);
      removeListener(IPCChannel.AgentError, handleError);
      removeListener(IPCChannel.AgentCompleted, handleCompleted);
      removeListener(IPCChannel.AgentContextUpdate, handleContextUpdate);
      removeListener(IPCChannel.AgentCompressing, handleCompressing);
      removeListener(IPCChannel.AgentCompressed, handleCompressed);
      removeListener(IPCChannel.AgentCompressError, handleCompressError);
    };
  }, [upsertAssistantMessage, upsertToolBatch, applyMessages]);

  const sendMessage = useCallback((content: string) => {
    const userMessage: Message = {
      role: 'user',
      content,
      timestamp: Date.now(),
    };
    applyMessages((prev) => [...prev, userMessage]);
    streamingTextRef.current = '';
    thinkingTextRef.current = '';
    toolSummaryTextRef.current = '';
    assistantMessageIndexRef.current = -1;
    currentBatchRef.current = [];
    batchMessageIndexRef.current = -1;
    currentBatchTimestampRef.current = -1;
    setState('thinking');

    invoke(IPCChannel.AgentStart, content)
      .then((result) => {
        console.log('[useAgent] Invoke result:', result);
      })
      .catch((err) => {
        console.error('[useAgent] Invoke error:', err);
        setState('error');
        applyMessages((prev) => [
          ...prev,
          {
            role: 'assistant',
            content: `Failed to send message: ${String(err)}`,
            timestamp: Date.now(),
          },
        ]);
      });
  }, [invoke, applyMessages]);

  const abort = useCallback(() => {
    invoke(IPCChannel.AgentStop);
  }, [invoke]);

  const respondConfirmation = useCallback((approved: boolean, approveAll?: boolean) => {
    const response = approveAll ? 'approve_all' as const : approved ? 'approve' as const : 'deny' as const;
    invoke(IPCChannel.AgentConfirmationResponse, response);
    setConfirmationRequest(null);
    if (approved) {
      setState('acting');
    }
  }, [invoke]);

  const clearMessages = useCallback(() => {
    messagesRef.current = [];
    setMessages([]);
    streamingTextRef.current = '';
    thinkingTextRef.current = '';
    toolSummaryTextRef.current = '';
    assistantMessageIndexRef.current = -1;
    currentBatchRef.current = [];
    batchMessageIndexRef.current = -1;
    currentBatchTimestampRef.current = -1;
    setConfirmationRequest(null);
    setState('idle');
    setContextUsage(null);
  }, []);

  const deleteConversation = useCallback(async () => {
    try {
      const result = await invoke('delete-conversation') as { success?: boolean; error?: string };
      if (result?.success) {
        clearMessages();
        return true;
      }
      console.error('[useAgent] Delete conversation failed:', result?.error);
      return false;
    } catch (err) {
      console.error('[useAgent] Delete conversation error:', err);
      return false;
    }
  }, [invoke, clearMessages]);

  const loadHistory = useCallback(async (conversationId: string) => {
    setIsLoadingHistory(true);
    try {
      const result = await invoke('conversation:load', conversationId) as {
        success: boolean;
        data?: Array<{
          role?: string;
          content?: string;
          timestamp?: number;
          toolName?: string;
          toolResult?: ToolResult;
          thinkingContent?: string;
          toolBatch?: ToolBatchItem[];
        }>;
        error?: string;
      };
      if (result.success && result.data) {
        const historyMessages: Message[] = result.data
          .map((d): Message => {
            const roleLower = d.role?.toLowerCase() ?? '';
            let role: 'user' | 'assistant' | 'tool' = 'user';
            if (roleLower === 'assistant' || roleLower === 'bot' || roleLower === 'ai') {
              role = 'assistant';
            } else if (roleLower === 'tool') {
              role = 'tool';
            }
            const msg: Message = {
              role,
              content: d.content ?? '',
              timestamp: d.timestamp ?? Date.now(),
            };
            // Preserve rich display fields from local storage (OpenAI/DevEco/Cline).
            // Remote providers (MiMo/DeepSeek/…) only return role+content, so these
            // branches are no-ops for them and existing behavior is unchanged.
            if (d.toolName) msg.toolName = d.toolName;
            if (d.toolResult) msg.toolResult = d.toolResult;
            if (d.thinkingContent) msg.thinkingContent = d.thinkingContent;
            if (d.toolBatch) msg.toolBatch = d.toolBatch;
            return msg;
          })
          // Keep messages with text content OR a non-empty tool batch (tool-batch
          // bubbles carry empty content but a populated toolBatch). Remote
          // providers never have toolBatch, so this filter is equivalent to the
          // previous `m.content` check for them.
          .filter((m) => m.content || (m.toolBatch && m.toolBatch.length > 0));
        messagesRef.current = historyMessages;
        setMessages(historyMessages);
        streamingTextRef.current = '';
        thinkingTextRef.current = '';
        toolSummaryTextRef.current = '';
        assistantMessageIndexRef.current = -1;
        currentBatchRef.current = [];
        batchMessageIndexRef.current = -1;
        currentBatchTimestampRef.current = -1;
        setConfirmationRequest(null);
        setState('idle');
        return true;
      }
      return false;
    } catch (err) {
      console.error('[useAgent] Load history error:', err);
      return false;
    } finally {
      setIsLoadingHistory(false);
    }
  }, [invoke]);

  const compressSession = useCallback(async () => {
    try {
      const result = await invoke(IPCChannel.SessionCompress) as {
        success: boolean;
        result?: CompactionResult;
        error?: string;
      };
      return result;
    } catch (err) {
      return { success: false, error: String(err) };
    }
  }, [invoke]);

  return { state, messages, sendMessage, abort, respondConfirmation, clearMessages, deleteConversation, loadHistory, confirmationRequest, isLoadingHistory, contextUsage, autoCompressToast, compressSession };
}
