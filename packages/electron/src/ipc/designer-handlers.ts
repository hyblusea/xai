/**
 * Designer IPC handlers (API 化版本).
 *
 * 所有 Designer 数据（项目/目录/设计稿）由管理平台后端统一管理，不再读写本地 .designer 目录。
 * 保留 LLM 流式生成（DesignerGenerate）为本地逻辑，生成完成后通过 save-html 落库。
 *
 * 适配层：renderer 仍使用 folderPath（字符串路径）模型，后端使用 folderId（数字）模型。
 * 本模块维护 projectId → {path↔id} 映射，在两端间转换。
 */
import { ipcMain, dialog, BrowserWindow, shell } from 'electron';
import { randomUUID } from 'crypto';
import { IPCChannel, scoreMenuMatch, MENU_MATCH_SCORE, TOOL_OUTPUT_MAX_CHARS } from '@xai/shared';
import type {
  DesignerProject,
  DesignerScreen,
  ProjectType,
  Message,
  FolderTreeNode,
  ProjectMember,
  ProjectRole,
  FolderPermission,
  FolderPermissionGrant,
  CreatePublicationRequest,
  ToolDefinition,
  ToolResult,
  MasterLayout,
} from '@xai/shared';
import type { IpcDeps } from './types.js';
import { createAiLogContext, submitRawHttpLog } from '../ai-logger.js';
import {
  buildDesignerSystemPrompt,
  buildDesignerUserMessage,
  buildDesignerToolSystemPrompt,
  ToolRegistry,
  ReadFileTool,
  ReplaceInFileTool,
  WriteFileTool,
  GrepInFilesTool,
  AiderStyleParser,
  extractAiderBlocks,
} from '@xai/core';
import type { ParsedToolCall } from '@xai/core';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as cheerio from 'cheerio';

/** Active AbortController for the current generation stream */
let activeAbort: AbortController | null = null;

// ── Designer tool-calling helpers ─────────────────────────────────────────────

/** Convert ToolDefinition[] to OpenAI native function-calling format. */
function convertToolDefinitionsForNative(tools: ToolDefinition[]): unknown[] {
  return tools.map(tool => {
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [name, param] of Object.entries(tool.parameters)) {
      const prop: Record<string, unknown> = { type: param.type ?? 'string' };
      if (param.description) prop['description'] = param.description;
      if (param.enum) prop['enum'] = param.enum;
      if (param.default !== undefined) prop['default'] = param.default;
      properties[name] = prop;
      if (param.required) required.push(name);
    }
    return {
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: {
          type: 'object',
          properties,
          ...(required.length > 0 ? { required } : {}),
        },
      },
    };
  });
}

/** Format a tool execution result as a Message for the LLM context. */
function formatToolResultMessage(toolCall: ParsedToolCall, result: ToolResult): Message {
  const status = result.success ? '成功' : '失败';
  let content = `[Tool Result] ${toolCall.name} - ${status}\n`;
  const filePath = toolCall.parameters['path'] || '';
  if (filePath) content += `File: ${filePath}\n`;
  if (result.executionTime) content += `Time: ${result.executionTime}ms\n`;
  if (!result.success) {
    content += `\nERROR: ${toolCall.name} FAILED!\n${result.error || result.output}\n`;
  } else {
    // write_to_file: AI already knows what it wrote, no need to echo back the
    // full diff (can be 27KB+). Just confirm success.
    if (toolCall.name === 'write_to_file') {
      content += 'File written successfully.';
    } else if (toolCall.name === 'replace_in_file') {
      // replace_in_file: the AI already produced the search/replace blocks, so
      // echoing the full diff is redundant. Only return the concise summary
      // header (line counts + match count) and skip the diff/context sections
      // which can be large for big edits.
      const output = result.output || '';
      const summaryEnd = output.indexOf('\n--- Changes ---');
      content += summaryEnd > 0 ? output.substring(0, summaryEnd) : output;
    } else {
      // 统一 90KB 阈值（与 BaseTool 源头截断一致）。正常情况下 BaseTool 已截断，
      // 此处不会触发；保留同等阈值作为兜底，防止绕过 BaseTool 的结果膨胀上下文。
      const maxLen = TOOL_OUTPUT_MAX_CHARS;
      if (result.output.length > maxLen) {
        content += `Output (truncated, ${result.output.length} chars total):\n${result.output.substring(0, maxLen)}\n... [truncated ${result.output.length - maxLen} chars]`;
      } else {
        content += `Output:\n${result.output}`;
      }
    }
  }
  return {
    role: 'tool',
    content,
    timestamp: Date.now(),
    toolName: toolCall.name,
    toolResult: result,
  };
}

/**
 * Read_file result deduplication cache.
 * The AI may call read_file on the same file (same path + startLine + limit)
 * multiple times within one Designer tool loop. Each call appends a 50KB+ tool
 * result to the conversation history, quickly exhausting the 200K context.
 * This cache keys on (path|startLine|limit) and reuses the previous result
 * instead of re-reading and re-emitting the file content.
 *
 * The cache is per-tool-loop (declared inside runDesignerToolLoop) so it never
 * leaks across Designer generations.
 */
interface ReadFileCacheEntry {
  result: ToolResult;
}
function makeReadFileCacheKey(params: Record<string, unknown>): string {
  const p = (params['path'] as string) || '';
  const s = params['startLine'] ?? 0;
  const l = params['limit'] ?? 0;
  return `${p}|${s}|${l}`;
}

/**
 * Estimate context usage for a local (stateless) message history, using the
 * same chars/4 heuristic as session-compressor.ts. Used to trigger head
 * summarization for stateless providers (deepseek/qwenai/zai) where there is
 * no server-side adapter to call getContextUsage on.
 */
function estimateLocalHistoryTokens(messages: Message[]): number {
  let chars = 0;
  for (const m of messages) {
    if (m.content) chars += m.content.length;
    chars += 20; // per-message overhead
  }
  return Math.round(chars / 4);
}

/**
 * Compress a stateless (local) message history by dropping old tool results
 * that have already been consumed. Unlike the OpenAI adapter's LLM-driven
 * compaction, this is a mechanical prune: keep the system prompt + user prompt
 * + the last N tool-result pairs, and drop older tool results (which are
 * usually large file reads whose content has already been applied).
 *
 * Returns a new array — does not mutate the input.
 */
function pruneLocalHistory(messages: Message[], keepLastToolPairs: number = 4): Message[] {
  if (messages.length <= 4) return messages;
  // Find indices of all tool messages
  const toolIdx: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === 'tool') toolIdx.push(i);
  }
  if (toolIdx.length <= keepLastToolPairs) return messages;
  // Keep the first 2 (system + user) and the last keepLastToolPairs tool results
  // plus any assistant messages between them.
  const dropUntil = toolIdx[toolIdx.length - keepLastToolPairs];
  const head = messages.slice(0, 2); // system + user
  const tail = messages.slice(dropUntil);
  return [...head, ...tail];
}

interface DesignerToolLoopParams {
  prompt: string;
  existingHtml?: string;
  styleReferences?: string[];
  provider: string;
  llmConfig: import('@xai/shared').LLMConfig;
  router: import('@xai/core').LLMRouter;
  signal: AbortSignal;
  sendToRenderer: (channel: IPCChannel, data: unknown) => void;
  projectName: string;
  adapterManager: import('../adapter-manager.js').AdapterManager;
  sessionConfig: import('@xai/shared').SessionConfig;
  /** Project type (WEB / APP / PDA) — drives platform CSS injected into tool prompt. */
  projectType?: import('@xai/shared').ProjectType;
  /** Project theme prompt (JSON string from DB) — drives theme CSS + style instructions. */
  themePrompt?: string;
}

/**
 * Wrap an async iterable with an idle-timeout guard. If no chunk arrives within
 * `timeoutMs`, the iteration breaks and the generator ends. This prevents the
 * designer tool loop from hanging forever when an LLM API (e.g. Mimo) accepts
 * a request but never responds — the spinner would otherwise spin indefinitely.
 *
 * The timeout resets on every received chunk, so slow-but-streaming responses
 * are not affected.
 */
async function* withStreamIdleTimeout<T>(
  stream: AsyncIterable<T>,
  timeoutMs: number,
  signal: AbortSignal,
): AsyncIterable<T> {
  const iterator = stream[Symbol.asyncIterator]();
  try {
    while (true) {
      if (signal.aborted) break;

      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<{ done: true; value: undefined; timedOut: true }>((resolve) => {
        timeoutHandle = setTimeout(() => resolve({ done: true, value: undefined, timedOut: true }), timeoutMs);
      });

      const nextPromise = iterator.next().then(r => ({
        done: r.done,
        value: r.value,
        timedOut: false as const,
      }));

      const result = await Promise.race([nextPromise, timeoutPromise]);

      if (timeoutHandle) clearTimeout(timeoutHandle);

      if (result.timedOut) {
        console.warn(`[Designer Tool Loop] Stream idle timeout (${timeoutMs}ms) — treating as end of stream`);
        break;
      }
      if (result.done) break;

      yield result.value as T;
    }
  } finally {
    if (typeof iterator.return === 'function') {
      await iterator.return();
    }
  }
}

/**
 * Run the designer tool-calling loop for Scenario A (edit existing page) or
 * Scenario B (reference files added to conversation).
 *
 * - Scenario A (existingHtml present): tools = replace_in_file + read_file.
 *   After the loop, the modified file is read back and streamed as HTML.
 * - Scenario B (styleReferences only): tools = read_file only.
 *   Text output from the AI is streamed as HTML during the loop.
 *
 * Context preservation:
 * - OpenAI/DevEco: snapshot → reset → loop (context accumulates) → restore.
 * - Mimo: reset → save → loop (server-side context via conversationId) → delete.
 */
async function runDesignerToolLoop(params: DesignerToolLoopParams): Promise<{ totalToolCalls: number }> {
  const {
    prompt, existingHtml, styleReferences, provider, llmConfig, router, signal,
    sendToRenderer, projectName, adapterManager, sessionConfig, onIterationComplete,
    projectType, themePrompt,
  } = params;

  const useNativeTools = provider === 'openai' || provider === 'deveco' || provider === 'cline' || provider === 'freebuff';
  const scenario: 'edit' | 'reference' = existingHtml ? 'edit' : 'reference';

  // 状态反馈：已进入工具循环，告知用户当前模式
  sendToRenderer(
    IPCChannel.DesignerStreamMessage,
    scenario === 'edit' ? '进入修改模式，正在初始化工具环境...' : '进入参考模式，正在初始化工具环境...',
  );

  // For chat-style models (mimo, deepseek, ...) in edit mode, emphasize that
  // tool calls MUST use the ++++ prefix, NOT <tool_call> tags. These models
  // tend to emit <tool_call> XML which the AiderStyleParser won't recognize,
  // causing the raw text to leak into the output and corrupt files.
  const effectivePrompt = (!useNativeTools && scenario === 'edit')
    ? `${prompt}\n\n强调: 工具调用严禁使用 <tool_call> , 必须是 ++++开头，且保证格式正确，正文中不要出现与代码无关内容`
    : prompt;

  // ── Create temp workspace ──
  const tmpDir = path.join(os.tmpdir(), `xai-designer-${Date.now()}`);
  await fs.promises.mkdir(tmpDir, { recursive: true });

  // ── Set up tool registry ──
  const toolRegistry = new ToolRegistry();
  const filePaths: string[] = [];

  const hasStyleReferences = !!styleReferences && styleReferences.length > 0;

  if (scenario === 'edit') {
    const fileName = 'current.html';
    await fs.promises.writeFile(path.join(tmpDir, fileName), existingHtml!, 'utf-8');
    filePaths.push(fileName);
    // Write style reference files too, so the AI can read_file them for style consistency
    // (e.g. "keep the bottom nav bar consistent with 首页"). Without this, the AI has no
    // way to access the referenced page's HTML and the style reference becomes a no-op.
    const refs = styleReferences || [];
    for (let i = 0; i < refs.length; i++) {
      const refFileName = `reference-${i}.html`;
      await fs.promises.writeFile(path.join(tmpDir, refFileName), refs[i], 'utf-8');
      filePaths.push(refFileName);
    }
    // replace_in_file: targeted edits (preserve unchanged sections)
    // write_to_file: full rewrite (for major redesigns) — restricted to current.html
    //   so the AI physically cannot create new files in edit mode. The system
    //   prompt also tells it not to, but this is the hard guard that enforces it.
    // read_file: inspect current content before editing
    // grep_search: locate specific text/sections without loading the whole file (saves context)
    toolRegistry.register(new ReplaceInFileTool(tmpDir));
    toolRegistry.register(new WriteFileTool(tmpDir, ['current.html']));
    toolRegistry.register(new ReadFileTool(tmpDir));
    toolRegistry.register(new GrepInFilesTool(tmpDir));
  } else {
    const refs = styleReferences || [];
    for (let i = 0; i < refs.length; i++) {
      const fileName = `reference-${i}.html`;
      await fs.promises.writeFile(path.join(tmpDir, fileName), refs[i], 'utf-8');
      filePaths.push(fileName);
    }
    toolRegistry.register(new ReadFileTool(tmpDir));
  }

  // ── Build system prompt (minimal: only tool defs + file info, no design prompts) ──
  const allToolDefs = toolRegistry.getDefinitions();
  const toolsForPrompt = useNativeTools
    ? allToolDefs.filter(d => d.contentMode === 'text')  // OpenAI/DevEco: content tools in ++++ format
    : allToolDefs;                                         // Mimo: all tools in ++++ format

  const systemPrompt = buildDesignerToolSystemPrompt({
    tools: toolsForPrompt,
    workspacePath: tmpDir,
    scenario,
    filePaths,
    hasStyleReferences,
    projectType,
    themePrompt,
  });

  // ── Build loop config (inject native tool defs for OpenAI/DevEco) ──
  let loopConfig = llmConfig;
  if (useNativeTools) {
    const nativeDefs = allToolDefs.filter(d => d.contentMode !== 'text');
    if (nativeDefs.length > 0) {
      const openaiTools = convertToolDefinitionsForNative(nativeDefs);
      loopConfig = {
        ...llmConfig,
        options: { ...(llmConfig.options ?? {}), tools: openaiTools },
      };
    }
  }

  // ── AiderStyleParser for ++++ content tool calls ──
  const aiderParser = new AiderStyleParser({ toolRegistry });

  // ── Context strategy ──
  // OpenAI/DevEco/Mimo: server-side context — adapter maintains conversation history,
  //   so we only send the latest tool results each iteration. After the task completes,
  //   we clear the server-side context (restore snapshot / delete conversation).
  // Other models (deepseek, qwenai, zai, ...): stateless — no server-side context.
  //   We accumulate the full message history locally and resend it every iteration.
  //   No context cleanup is needed after completion.
  const useServerContext = useNativeTools || provider === 'mimo';

  // ── Session management (server-side context models only) ──
  let restoreSession: (() => void) | null = null;
  if (useNativeTools) {
    const sharedAdapter = adapterManager.get(provider);
    if (
      sharedAdapter &&
      typeof (sharedAdapter as { snapshotSession?: unknown }).snapshotSession === 'function' &&
      typeof (sharedAdapter as { restoreSession?: unknown }).restoreSession === 'function'
    ) {
      const snapshot = (sharedAdapter as { snapshotSession: () => unknown }).snapshotSession();
      (sharedAdapter as { resetSession: () => void }).resetSession();
      restoreSession = () => {
        try {
          (sharedAdapter as { restoreSession: (s: unknown) => void }).restoreSession(snapshot);
        } catch (e) {
          console.error('[Designer Tool Loop] restoreSession failed:', e);
        }
      };
    }
  } else if (provider === 'mimo' || provider === 'deepseek') {
    // Reset adapter state so stale _messageId / _conversationId from a prior
    // conversation (Code view or previous Designer turn) doesn't leak in.
    // For DeepSeek a stale _messageId causes "invalid message id" (biz_code: 26).
    adapterManager.resetCurrent(sessionConfig);
    if (provider === 'mimo') {
      await adapterManager.saveConversation(sessionConfig, projectName);
    }
  }

  // 状态反馈：环境与 会话已就绪，即将请求 AI
  sendToRenderer(IPCChannel.DesignerStreamMessage, '会话已就绪，正在等待 AI 响应...');

  // True if any file-modifying tool (replace_in_file / write_to_file) was called —
  // the final HTML should be read back from the file rather than streamed as text.
  let fileModified = false;
  // Track total tool calls across all iterations — used to detect "AI forgot to use tools" in edit mode.
  let totalToolCalls = 0;
  const maxIterations = 20;

  // For server-side-context models: only the latest tool results are sent each round.
  let latestToolResults: Message[] = [];
  // For stateless models: full conversation history is accumulated and resent each round.
  const fullHistory: Message[] = [];

  // ── Context budget management ──
  // Trigger compression when context usage exceeds this threshold. For server-
  // context models (OpenAI/DevEco/Cline) we use the adapter's LLM-driven compressHistory;
  // for stateless models we mechanically prune old tool results from fullHistory.
  const CONTEXT_COMPRESS_THRESHOLD = 0.7;
  // Avoid re-triggering compression on every iteration — require usage to climb
  // above the threshold again before the next compaction.
  let lastCompressIteration = -1;

  // read_file dedup cache (per tool-loop). Keyed by (path|startLine|limit).
  const readFileCache = new Map<string, ReadFileCacheEntry>();

  try {
    for (let iteration = 0; iteration < maxIterations; iteration++) {
      if (signal.aborted) break;

      // ── Context compression check (server-context models: OpenAI/DevEco/Cline) ──
      // Before building the request, check the adapter's context usage. If it
      // exceeds the threshold and we haven't already compressed this iteration,
      // call compressHistory to summarize old turns. This prevents the 200K
      // context from filling up during long edit/reference loops where the AI
      // reads large HTML files multiple times.
      if (useNativeTools && iteration > 0 && iteration !== lastCompressIteration) {
        const sharedAdapter = adapterManager.get(provider);
        if (
          sharedAdapter &&
          typeof (sharedAdapter as { getContextUsage?: unknown }).getContextUsage === 'function' &&
          typeof (sharedAdapter as { compressHistory?: unknown }).compressHistory === 'function'
        ) {
          try {
            const usage = (sharedAdapter as {
              getContextUsage: (cfg: unknown) => { usagePercent: number };
            }).getContextUsage(llmConfig);
            if (usage.usagePercent >= CONTEXT_COMPRESS_THRESHOLD * 100) {
              sendToRenderer(
                IPCChannel.DesignerStreamMessage,
                `上下文使用率 ${usage.usagePercent}%，正在压缩历史…`,
              );
              const comp = await (sharedAdapter as {
                compressHistory: (cfg: unknown) => Promise<{ success: boolean; afterTokens?: number }>;
              }).compressHistory(llmConfig);
              if (comp.success) {
                lastCompressIteration = iteration;
                sendToRenderer(
                  IPCChannel.DesignerStreamMessage,
                  `历史已压缩，继续编辑…`,
                );
              }
            }
          } catch (e) {
            console.error('[Designer Tool Loop] compressHistory failed:', e);
          }
        }
      }

      // ── Context compression check (stateless models: deepseek/qwenai/zai) ──
      // No server-side adapter to ask; estimate locally and prune old tool
      // results from fullHistory when the budget is exceeded.
      if (!useServerContext && iteration > 0 && iteration !== lastCompressIteration && fullHistory.length > 4) {
        const estTokens = estimateLocalHistoryTokens(fullHistory);
        // Stateless models default to 128K window if not overridden.
        const window = llmConfig.contextWindow && llmConfig.contextWindow > 0
          ? llmConfig.contextWindow
          : 128_000;
        if (estTokens >= window * CONTEXT_COMPRESS_THRESHOLD) {
          const before = fullHistory.length;
          const pruned = pruneLocalHistory(fullHistory, 4);
          if (pruned.length < before) {
            fullHistory.length = 0;
            fullHistory.push(...pruned);
            lastCompressIteration = iteration;
            sendToRenderer(
              IPCChannel.DesignerStreamMessage,
              `上下文较大，已精简历史 (${before} → ${pruned.length} 条)，继续…`,
            );
          }
        }
      }

      const messages: Message[] = [];
      if (useServerContext) {
        // Server maintains history — only send latest tool results
        if (iteration === 0) {
          messages.push({ role: 'system', content: systemPrompt, timestamp: Date.now() });
          messages.push({ role: 'user', content: effectivePrompt, timestamp: Date.now() });
        }
        messages.push(...latestToolResults);
      } else {
        // Stateless — resend full history every iteration
        if (iteration === 0) {
          fullHistory.push({ role: 'system', content: systemPrompt, timestamp: Date.now() });
          fullHistory.push({ role: 'user', content: effectivePrompt, timestamp: Date.now() });
        }
        messages.push(...fullHistory);
      }

      aiderParser.reset();
      const stream = router.send(messages, loopConfig, signal);

      let fullResponse = '';
      const toolCalls: ParsedToolCall[] = [];

      // Wrap the stream with an idle timeout (60s). If the LLM API accepts the
      // request but never responds (observed with Mimo when the tool-result
      // payload is very large), the stream would hang forever and the spinner
      // would never stop. The timeout resets on each received chunk, so normal
      // slow-but-streaming responses are unaffected.
      const STREAM_IDLE_TIMEOUT_MS = 60_000;
      for await (const chunk of withStreamIdleTimeout(stream, STREAM_IDLE_TIMEOUT_MS, signal)) {
        if (signal.aborted) break;

        if (chunk.type === 'text') {
          fullResponse += chunk.content;

          // Feed text to AiderStyleParser to catch ++++ content tool calls
          const events = aiderParser.feed(chunk.content);
          for (const event of events) {
            if (event.type === 'text') {
              if (scenario === 'reference') {
                // Scenario B (reference): stream text as HTML live (canvas + top display).
                sendToRenderer(IPCChannel.DesignerStreamChunk, event.content);
              } else {
                // Scenario A (edit): show text in the top status area only,
                // do NOT touch htmlBuffer — canvas only reflects tool-modified file.
                sendToRenderer(IPCChannel.DesignerStreamMessage, event.content);
              }
            } else if (event.type === 'tool_call' && event.toolCall) {
              toolCalls.push(event.toolCall);
              sendToRenderer(IPCChannel.DesignerStreamMessage, `AI 调用工具: ${event.toolCall.name}`);
            }
          }
        } else if (chunk.type === 'tool_call') {
          // Native tool call (OpenAI/DevEco) for simple-parameter tools
          const tc = chunk.toolCall;
          if (tc) {
            toolCalls.push({ name: tc.name, parameters: tc.parameters, rawXml: '' });
            sendToRenderer(IPCChannel.DesignerStreamMessage, `AI 调用工具: ${tc.name}`);
          }
        } else if (chunk.type === 'thinking') {
          sendToRenderer(IPCChannel.DesignerStreamThinking, chunk.content);
        } else if (chunk.type === 'error') {
          sendToRenderer(IPCChannel.DesignerStreamError, chunk.content);
          return { totalToolCalls };
        } else if (chunk.type === 'done') {
          break;
        }
      }

      if (signal.aborted) {
        break;
      }

      // Flush remaining AiderStyleParser events
      const flushEvents = aiderParser.flush();
      for (const event of flushEvents) {
        if (event.type === 'text') {
          if (scenario === 'reference') {
            sendToRenderer(IPCChannel.DesignerStreamChunk, event.content);
          } else {
            sendToRenderer(IPCChannel.DesignerStreamMessage, event.content);
          }
        } else if (event.type === 'tool_call' && event.toolCall) {
          toolCalls.push(event.toolCall);
          sendToRenderer(IPCChannel.DesignerStreamMessage, `AI 调用工具: ${event.toolCall.name}`);
        }
      }

      // Full-text fallback parse for content tools
      if (toolCalls.length === 0 && fullResponse.length > 0) {
        const aiderCalls = extractAiderBlocks(fullResponse, { toolRegistry });
        for (const tc of aiderCalls) {
          toolCalls.push(tc);
          sendToRenderer(IPCChannel.DesignerStreamMessage, `AI 调用工具: ${tc.name}`);
        }
      }

      // For stateless models: record the assistant response before tool execution
      if (!useServerContext && fullResponse.length > 0) {
        fullHistory.push({ role: 'assistant', content: fullResponse, timestamp: Date.now() });
      }

      if (toolCalls.length === 0) {
        // No more tool calls — AI is done
        break;
      }

      // Execute tools and collect results
      const newToolResults: Message[] = [];
      let invalidatedCacheFiles = false;
      for (const tc of toolCalls) {
        if (!tc.name || !tc.name.trim()) continue;
        totalToolCalls++;
        // Track whether any file-modifying tool was invoked
        const isModifier = tc.name === 'replace_in_file' || tc.name === 'write_to_file';
        if (isModifier) {
          fileModified = true;
          // Any file modification invalidates the read_file cache — the file
          // content has changed, so cached reads are now stale.
          if (!invalidatedCacheFiles && readFileCache.size > 0) {
            readFileCache.clear();
            invalidatedCacheFiles = true;
          }
        }

        let result: ToolResult;
        if (tc.name === 'read_file') {
          // read_file dedup: if the same (path|startLine|limit) was already read
          // in this tool loop, reuse the cached result instead of re-reading and
          // re-emitting a 50KB+ tool message into the conversation history.
          const cacheKey = makeReadFileCacheKey(tc.parameters as Record<string, unknown>);
          const cached = readFileCache.get(cacheKey);
          if (cached) {
            result = { ...cached.result };
          } else {
            result = await toolRegistry.execute(tc.name, tc.parameters as Record<string, unknown>, signal);
            if (result.success) {
              readFileCache.set(cacheKey, { result: { ...result } });
            }
          }
        } else {
          result = await toolRegistry.execute(tc.name, tc.parameters as Record<string, unknown>, signal);
        }

        const hint = isModifier ? '，文件已修改' : '';
        sendToRenderer(
          IPCChannel.DesignerStreamMessage,
          `工具 ${tc.name} ${result.success ? '完成' : '失败'}${hint}`,
        );
        newToolResults.push(formatToolResultMessage(tc, result));
      }

      if (useServerContext) {
        // Server maintains history — only keep latest tool results
        latestToolResults = newToolResults;
      } else {
        // Stateless — accumulate tool results into full history
        fullHistory.push(...newToolResults);
      }
    }

    // ── After loop: handle results ──
    if (scenario === 'edit') {
      // 修改模式：只接受工具（replace_in_file / write_to_file）修改文件的结果。
      // 不使用 AI 的文本输出作为文件内容，避免格式错误的输出（如 <tool_call> 标签）
      // 错误地覆盖文件内容。当没有工具修改文件时，回退到原始 HTML，保持画布不被清空。
      if (fileModified) {
        sendToRenderer(IPCChannel.DesignerStreamMessage, '正在应用修改到画布...');
        const currentFilePath = path.join(tmpDir, 'current.html');
        try {
          const modifiedHtml = await fs.promises.readFile(currentFilePath, 'utf-8');
          sendToRenderer(IPCChannel.DesignerStreamChunk, modifiedHtml);
        } catch {
          // 文件读取失败 — 回退到原始 HTML，保持画布不被清空
          if (existingHtml) {
            sendToRenderer(IPCChannel.DesignerStreamChunk, existingHtml);
          }
        }
      } else if (existingHtml) {
        // 没有工具修改文件 — 回退到原始 HTML，保持画布不被清空
        sendToRenderer(IPCChannel.DesignerStreamChunk, existingHtml);
      }
    }
    // Scenario B: text was already streamed during the loop

  } finally {
    // ── Clear context (auto-clear after task completion) ──
    // OpenAI/DevEco: restore overwrites designer context with Code view snapshot
    if (restoreSession) restoreSession();
    // Mimo/DeepSeek: delete server-side conversation + reset
    if (provider === 'mimo' || provider === 'deepseek') {
      try {
        await adapterManager.deleteConversation(sessionConfig);
      } catch (err) {
        console.error(`[Designer Tool Loop] Failed to delete ${provider} conversation:`, err);
      }
    }

    // ── Clean up temp files ──
    try {
      await fs.promises.rm(tmpDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  }

  return { totalToolCalls };
}

// ── 适配层：folderPath ↔ folderId 映射 ─────────────────────────────────────
interface FolderMap {
  byPath: Map<string, number>; // "首页/子模块" -> folderId
  byId: Map<number, string>;   // folderId -> "首页/子模块"
}
const folderMaps = new Map<string, FolderMap>();

/** renderer 临时 screenId -> server 真实 screenId（处理多次保存同一新页） */
const tempIdMap = new Map<string, string>();
/** screenId -> version（乐观锁） */
const versionCache = new Map<string, number>();

function getMap(projectId: string): FolderMap {
  let m = folderMaps.get(projectId);
  if (!m) {
    m = { byPath: new Map(), byId: new Map() };
    folderMaps.set(projectId, m);
  }
  return m;
}

function normalizePath(p: string | undefined | null): string {
  if (!p) return '';
  return p.replace(/^\/+/, '').replace(/\/+$/, '');
}

function pathToId(projectId: string, folderPath: string | undefined | null): number | null {
  const p = normalizePath(folderPath);
  if (!p) return null; // 根目录
  const m = getMap(projectId);
  const id = m.byPath.get(p);
  if (id == null) {
    throw new Error(`目录路径不存在: ${p}（请刷新项目后重试）`);
  }
  return id;
}

function idToPath(projectId: string, folderId: number | null | undefined): string {
  if (folderId == null) return '';
  return getMap(projectId).byId.get(folderId) ?? '';
}

/** 从服务端目录树重建 path↔id 映射，并转换为 renderer 使用的 DesignerProject 结构。 */
function treeToProject(projectMeta: DesignerProject, tree: FolderTreeNode): DesignerProject {
  const m = getMap(projectMeta.id);
  m.byPath.clear();
  m.byId.clear();
  const folders: string[] = [];
  const screens: DesignerScreen[] = [];
  const folderPermissions: Record<string, { userId: number; displayName: string; permission: string }[]> = {};

  const walk = (node: FolderTreeNode, parentPath: string) => {
    // 当前节点路径
    const currentPath = node.id == null ? '' : (parentPath ? `${parentPath}/${node.name}` : node.name);
    if (node.id != null) {
      m.byPath.set(currentPath, node.id);
      m.byId.set(node.id, currentPath);
      folders.push(currentPath);
      // 记录目录权限（用于前端徽章显示）
      if (node.permissions && node.permissions.length > 0) {
        folderPermissions[currentPath] = node.permissions.map(p => ({
          userId: p.userId,
          displayName: p.displayName,
          permission: p.permission,
        }));
      }
    }
    // 挂在该节点的设计稿
    for (const s of node.screens) {
      const screenPath = node.id == null ? '' : currentPath;
      const ds: DesignerScreen = {
        id: s.id,
        name: s.name,
        html: '', // 树只返回摘要，html 在 loadScreen 时按需获取
        createdAt: Date.now(),
        folderPath: screenPath,
        folderId: node.id,
        ownerId: s.ownerId,
        ownerName: s.ownerName,
        updatedAt: new Date(s.updatedAt).getTime(),
      };
      screens.push(ds);
    }
    for (const child of node.children) {
      walk(child, currentPath);
    }
  };
  walk(tree, '');

  return {
    id: projectMeta.id,
    name: projectMeta.name,
    type: projectMeta.type,
    themePrompt: projectMeta.themePrompt,
    folders,
    createdAt: new Date(projectMeta.createdAt as unknown as string).getTime() || Date.now(),
    updatedAt: new Date(projectMeta.updatedAt as unknown as string).getTime() || Date.now(),
    screens,
    ownerId: projectMeta.ownerId,
    role: projectMeta.role,
    homeScreenId: projectMeta.homeScreenId,
    folderPermissions,
    // 共享母版：normalizeProject 已把 masterLayoutsJson 解析为 masterLayouts 数组。
    // 老项目缺失时为 undefined，渲染层注入逻辑会短路跳过（向后兼容）。
    masterLayouts: projectMeta.masterLayouts,
  };
}

async function refreshMapsAndProject(deps: IpcDeps, projectId: string): Promise<DesignerProject> {
  const client = deps.adminClient;
  const [projectMeta, tree] = await Promise.all([
    client.getProject(projectId),
    client.loadTree(projectId),
  ]);
  return treeToProject(projectMeta, tree);
}

// ── Registration ───────────────────────────────────────────────────────────

export function registerDesignerHandlers(deps: IpcDeps): void {
  const requireUser = () => {
    if (!deps.currentUser) throw new Error('未登录，请先登录');
    return deps.currentUser;
  };

  // ── Generate HTML (streaming，本地逻辑) ──────────────────────────────
  ipcMain.handle(
    IPCChannel.DesignerGenerate,
    async (
      _event,
      payload: {
        prompt: string;
        projectType: ProjectType;
        existingHtml?: string;
        styleReferences?: string[];
        projectId?: string;
        screenId?: string;
        /** renderer 端最新的 masterLayouts（提取/编辑后立即生效，避免后端二次拉取拿到陈旧数据） */
        masterLayouts?: MasterLayout[];
      },
    ) => {
      const { prompt, projectType, existingHtml, styleReferences, projectId, screenId, masterLayouts: payloadMasterLayouts } = payload;

      // 状态反馈：立即告知用户请求已接收（避免前期静默，用户以为卡住）
      deps.sendToRenderer(IPCChannel.DesignerStreamMessage, '正在准备生成...');

      // AI 日志：本次 Designer 会话的 sessionId（同一次 DesignerGenerate 内多轮共享）
      const sessionId = randomUUID();
      const logStartTime = Date.now();
      let logResponseText = '';
      let logStatus: 'success' | 'error' | 'aborted' = 'success';
      let logErrorMessage: string | undefined;
      let loggedProjectName: string | undefined;

      // 从后端取项目主题
      let themePrompt: string | undefined;
      // 优先使用 renderer 传入的 masterLayouts（最新内存态）；后端拉取作为兜底
      let masterLayouts: MasterLayout[] | undefined = payloadMasterLayouts;
      let projectName = 'Design';
      if (projectId) {
        try {
          const projectMeta = await deps.adminClient.getProject(projectId);
          themePrompt = projectMeta.themePrompt;
          // 仅在 renderer 未传 masterLayouts 时使用后端数据（renderer 提取/编辑后未及时落库的窗口期）
          if (!masterLayouts || masterLayouts.length === 0) {
            masterLayouts = projectMeta.masterLayouts;
          }
          projectName = `${projectMeta.name}-Design`;
          loggedProjectName = projectMeta.name;
        } catch { /* ignore */ }
      }

      if (activeAbort) {
        activeAbort.abort();
        activeAbort = null;
      }
      activeAbort = new AbortController();
      const signal = activeAbort.signal;

      // For OpenAI/DevEco the adapter keeps an in-memory conversation history
      // shared with the Code view (same adapter instance). We snapshot + reset
      // it so this Designer generation runs standalone (no memory of prior
      // Designer turns, and no pollution of the Code view's history), then
      // restore it in the finally below. Declared here so the finally can see it.
      let restoreSession: (() => void) | null = null;
      // True when the tool-calling loop handled its own session lifecycle.
      let usedToolLoop = false;

      // router is declared here (not inside try) so the finally block can clear
      // its onRawHttp callback. Declaring it inside try with const makes it
      // block-scoped and invisible to finally — causing ReferenceError.
      let router: import('@xai/core').LLMRouter | null = null;

      // 包装 sendToRenderer：拦截 DesignerStreamChunk（实际响应内容）累计到日志
      const wrappedSend = (channel: IPCChannel, data: unknown) => {
        if (channel === IPCChannel.DesignerStreamChunk && typeof data === 'string') {
          logResponseText += data;
        }
        deps.sendToRenderer(channel, data);
      };

      try {
        router = deps.adapterManager.getLLMRouter();
        if (!router) {
          deps.sendToRenderer(IPCChannel.DesignerStreamError, 'LLM router not available. Please configure an LLM provider.');
          logStatus = 'error';
          logErrorMessage = 'LLM router not available';
          return { success: false, error: 'LLM router not available' };
        }

        const llmConfig = deps.sessionConfig.llm;
        const provider = llmConfig.provider || 'mimo';

        // 日志上下文：每次 HTTP LLM 调用完成后由 onRawHttp 回调上报一条原始日志
        const logCtx = createAiLogContext({
          mode: 'designer',
          sessionId,
          projectId,
          projectName: loggedProjectName,
          screenId,
          provider: deps.sessionConfig.llm.provider,
          model: deps.sessionConfig.llm.model,
        });
        router.onRawHttp = (info) => {
          void submitRawHttpLog(deps, logCtx, info);
        };

        // ── Tool-calling mode ──
        // Scenario A: existing page selected (existingHtml present) → replace_in_file + read_file
        // Scenario B: only files added to conversation (styleReferences, no existingHtml) → read_file only
        // For these scenarios: only chat content + tool prompts (no design prompts).
        // OpenAI/DevEco: preserve context during tool calls, clear after completion.
        const useToolLoop = !!existingHtml || (!!styleReferences && styleReferences.length > 0 && !existingHtml);

        if (useToolLoop) {
          usedToolLoop = true;
          const toolResult = await runDesignerToolLoop({
            prompt,
            existingHtml,
            styleReferences,
            provider,
            llmConfig,
            router,
            signal,
            sendToRenderer: wrappedSend,
            projectName,
            adapterManager: deps.adapterManager,
            sessionConfig: deps.sessionConfig,
            projectType,
            themePrompt,
          });
          if (signal.aborted) logStatus = 'aborted';
          const scenario = existingHtml ? 'edit' : 'reference';
          deps.sendToRenderer(IPCChannel.DesignerStreamDone, {
            projectId,
            screenId,
            aborted: signal.aborted,
            noToolCalls: toolResult.totalToolCalls === 0,
            scenario,
          });
          activeAbort = null;
          return { success: true, aborted: signal.aborted };
        }

        // ── Standard mode (no tools, design prompts) — current behavior ──
        if (provider === 'mimo' || provider === 'deepseek') {
          // Reset adapter state to avoid stale _messageId leaking into this
          // standalone Designer turn (causes "invalid message id" on DeepSeek).
          deps.adapterManager.resetCurrent(deps.sessionConfig);
          if (provider === 'mimo') {
            await deps.adapterManager.saveConversation(deps.sessionConfig, projectName);
          }
        }

        // OpenAI/DevEco: snapshot the shared adapter's Code-view session, then
        // reset so this Designer turn is context-free. Restored in finally.
        const sharedAdapter = deps.adapterManager.get(provider);
        if (
          sharedAdapter &&
          typeof (sharedAdapter as { snapshotSession?: unknown }).snapshotSession === 'function' &&
          typeof (sharedAdapter as { restoreSession?: unknown }).restoreSession === 'function'
        ) {
          const snapshot = (sharedAdapter as { snapshotSession: () => unknown }).snapshotSession();
          (sharedAdapter as { resetSession: () => void }).resetSession();
          restoreSession = () => {
            try {
              (sharedAdapter as { restoreSession: (s: unknown) => void }).restoreSession(snapshot);
            } catch (e) {
              console.error('[Designer] restoreSession failed:', e);
            }
          };
        }

        const systemPrompt = buildDesignerSystemPrompt({ projectType, existingHtml, styleReferences, themePrompt, masterLayouts });
        const userMessage = buildDesignerUserMessage(prompt, projectType);
        const messages: Message[] = [
          { role: 'system', content: systemPrompt, timestamp: Date.now() },
          { role: 'user', content: userMessage, timestamp: Date.now() },
        ];

        for await (const chunk of router.send(messages, llmConfig, signal)) {
          if (signal.aborted) {
            logStatus = 'aborted';
            deps.sendToRenderer(IPCChannel.DesignerStreamDone, { projectId, screenId, aborted: true });
            return { success: true, aborted: true };
          }
          if (chunk.type === 'text') {
            logResponseText += chunk.content;
            deps.sendToRenderer(IPCChannel.DesignerStreamChunk, chunk.content);
          } else if (chunk.type === 'thinking') {
            deps.sendToRenderer(IPCChannel.DesignerStreamThinking, chunk.content);
          } else if (chunk.type === 'error') {
            logStatus = 'error';
            logErrorMessage = chunk.content;
            deps.sendToRenderer(IPCChannel.DesignerStreamError, chunk.content);
            return { success: false, error: chunk.content };
          } else if (chunk.type === 'done') {
            break;
          }
        }

        deps.sendToRenderer(IPCChannel.DesignerStreamDone, { projectId, screenId, aborted: false });

        if (provider === 'mimo' || provider === 'deepseek') {
          try {
            await deps.adapterManager.deleteConversation(deps.sessionConfig);
          } catch (err) {
            console.error(`[Designer] Failed to delete ${provider} conversation:`, err);
          }
        }

        activeAbort = null;
        return { success: true };
      } catch (err) {
        const errMsg = String(err);
        logStatus = 'error';
        logErrorMessage = errMsg;
        deps.sendToRenderer(IPCChannel.DesignerStreamError, errMsg);
        activeAbort = null;
        return { success: false, error: errMsg };
      } finally {
        // Restore the Code view's accumulated session so it is unaffected by
        // the standalone Designer generation above.
        // (Tool-calling loop handles its own session restore internally.)
        if (!usedToolLoop && restoreSession) restoreSession();
        // 清除 raw HTTP 日志回调
        if (router) router.onRawHttp = undefined;
      }
    },
  );

  // ── Abort generation ──────────────────────────────────────────────────
  ipcMain.handle(IPCChannel.DesignerAbort, async () => {
    if (activeAbort) {
      activeAbort.abort();
      activeAbort = null;
    }
    return { success: true };
  });

  // ── Save HTML（新建或更新）────────────────────────────────────────────
  ipcMain.handle(
    IPCChannel.DesignerSaveHtml,
    async (
      _event,
      payload: { projectId: string; screenId: string; screenName: string; html: string; folderPath?: string; source?: string },
    ) => {
      const { projectId, screenId, screenName, html, folderPath, source } = payload;
      requireUser();
      try {
        const client = deps.adminClient;
        // 解析真实 screenId（处理 renderer 临时 id）
        const realId = tempIdMap.get(screenId) ?? screenId;
        const isTempId = tempIdMap.has(screenId);
        let knownVersion = versionCache.get(realId);

        // 如果 version 未缓存且 screenId 不是临时 id（即来自 tree 的真实 id），
        // 先从后端拉取 screen 获取当前 version。
        // 注意：必须区分"screen 不存在(404)"与"网络/鉴权错误"——后者绝不能
        // 静默走新建流程，否则会在根目录产生重复页面（原页面未被修改）。
        let screenNotFound = false;
        if (knownVersion == null && !isTempId) {
          try {
            const existing = await client.getScreen(realId);
            knownVersion = existing.version ?? 0;
            versionCache.set(realId, knownVersion);
          } catch (err: any) {
            const status = err?.status ?? err?.statusCode;
            if (status === 404) {
              // 确实不存在 → 允许走新建流程
              screenNotFound = true;
            } else {
              // 网络/鉴权/服务端错误 → 不能新建，否则会重复。直接返回失败让前端报错。
              return {
                success: false,
                error: `Failed to fetch screen ${realId} for update: ${err?.message || String(err)}`,
              };
            }
          }
        }

        // 判断新建 vs 更新：version 已知则为更新
        if (knownVersion != null) {
          const updated = await client.updateScreen(realId, { content: html, version: knownVersion, source: source ?? 'manual' });
          versionCache.set(realId, updated.version ?? knownVersion);
          return { success: true, screenId: realId };
        }

        // 仅当 screen 真不存在（404）或本来就是临时 id（首次保存新建生成结果）时才新建。
        // 这避免了"修改模式下因 getScreen 抛错而误新建"导致刷新后出现重复页面。
        if (!screenNotFound && !isTempId) {
          return {
            success: false,
            error: `Refused to create a new screen in edit mode (screenId=${realId} exists in tree but version unknown). This would duplicate the page.`,
          };
        }

        // 新建：解析目录（默认根目录）
        const folderId = folderPath ? pathToId(projectId, folderPath) : null;
        const created = await client.saveScreen(projectId, {
          folderId,
          name: screenName,
          content: html,
        });
        const newId = created.id;
        tempIdMap.set(screenId, newId);
        versionCache.set(newId, created.version ?? 0);
        return { success: true, screenId: newId };
      } catch (err) {
        return { success: false, error: String(err) };
      }
    },
  );

  // ── List projects ─────────────────────────────────────────────────────
  ipcMain.handle(IPCChannel.DesignerListProjects, async () => {
    try {
      requireUser();
      const projects = await deps.adminClient.listProjects();
      return { success: true, projects };
    } catch (err) {
      return { success: false, error: String(err), projects: [] };
    }
  });

  // ── Create project ────────────────────────────────────────────────────
  ipcMain.handle(
    IPCChannel.DesignerCreateProject,
    async (_event, payload: { name: string; type: ProjectType; basePath?: string; themePrompt?: string }) => {
      const { name, type, themePrompt } = payload;
      requireUser();
      try {
        const project = await deps.adminClient.createProject({ name, type, themePrompt });
        return { success: true, project };
      } catch (err) {
        return { success: false, error: String(err) };
      }
    },
  );

  // ── Delete project ────────────────────────────────────────────────────
  ipcMain.handle(IPCChannel.DesignerDeleteProject, async (_event, payload: { projectId: string }) => {
    requireUser();
    try {
      await deps.adminClient.deleteProject(payload.projectId);
      folderMaps.delete(payload.projectId);
      return { success: true };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  // ── Load project（从后端拉取目录树，转换为 renderer 模型）──────────────
  ipcMain.handle(IPCChannel.DesignerLoadProject, async (_event, payload: { projectId: string }) => {
    requireUser();
    try {
      const project = await refreshMapsAndProject(deps, payload.projectId);
      // 记录当前选中的 designer 项目，供"查看提示词"等菜单使用
      deps.currentDesignerProjectId = payload.projectId;
      // 缓存 version
      for (const s of project.screens) {
        if (s.version != null) versionCache.set(s.id, s.version);
      }
      return { success: true, project };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  // ── Load single screen content (html + version) ──────────────────────
  ipcMain.handle(IPCChannel.DesignerLoadScreen, async (_event, payload: { screenId: string }) => {
    requireUser();
    try {
      const screen = await deps.adminClient.getScreen(payload.screenId);
      // Cache version for optimistic-lock on subsequent saves
      if (screen.version != null) {
        versionCache.set(screen.id, screen.version);
      }
      return { success: true, screen };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  // ── Load tree（供权限 UI 使用）─────────────────────────────────────────
  ipcMain.handle(IPCChannel.DesignerLoadTree, async (_event, projectId: string) => {
    requireUser();
    try {
      const tree = await deps.adminClient.loadTree(projectId);
      // 同步刷新映射
      const projectMeta = await deps.adminClient.getProject(projectId);
      treeToProject(projectMeta, tree);
      return { success: true, tree };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  // ── Rename project ────────────────────────────────────────────────────
  ipcMain.handle(IPCChannel.DesignerRenameProject, async (_event, payload: { projectId: string; name: string }) => {
    requireUser();
    try {
      await deps.adminClient.updateProject(payload.projectId, { name: payload.name });
      return { success: true };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  // ── Update project theme (系统设计：编辑设计 token 后写回数据库) ───────
  ipcMain.handle(
    IPCChannel.DesignerUpdateProjectTheme,
    async (_event, payload: { projectId: string; themePrompt: string }) => {
      requireUser();
      try {
        const updated = await deps.adminClient.updateProject(payload.projectId, { themePrompt: payload.themePrompt });
        return { success: true, project: updated };
      } catch (err) {
        return { success: false, error: String(err) };
      }
    },
  );

  // ── Delete screen ─────────────────────────────────────────────────────
  ipcMain.handle(IPCChannel.DesignerDeleteScreen, async (_event, payload: { projectId: string; screenId: string }) => {
    requireUser();
    try {
      const realId = tempIdMap.get(payload.screenId) ?? payload.screenId;
      await deps.adminClient.deleteScreen(realId);
      versionCache.delete(realId);
      return { success: true };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  // ── Rename screen ─────────────────────────────────────────────────────
  ipcMain.handle(
    IPCChannel.DesignerRenameScreen,
    async (_event, payload: { projectId: string; screenId: string; name: string }) => {
      requireUser();
      try {
        const realId = tempIdMap.get(payload.screenId) ?? payload.screenId;
        const s = await deps.adminClient.renameScreen(realId, payload.name);
        if (s.version != null) versionCache.set(realId, s.version);
        return { success: true };
      } catch (err) {
        return { success: false, error: String(err) };
      }
    },
  );

  // ── Duplicate screen ──────────────────────────────────────────────────
  ipcMain.handle(
    IPCChannel.DesignerDuplicateScreen,
    async (_event, payload: { projectId: string; screenId: string }) => {
      requireUser();
      try {
        const realId = tempIdMap.get(payload.screenId) ?? payload.screenId;
        const copy = await deps.adminClient.duplicateScreen(payload.projectId, realId);
        if (copy.version != null) versionCache.set(copy.id, copy.version);
        return { success: true, newScreenId: copy.id };
      } catch (err) {
        return { success: false, error: String(err) };
      }
    },
  );

  // ── Move screen to a folder ───────────────────────────────────────────
  ipcMain.handle(
    IPCChannel.DesignerMoveScreen,
    async (_event, payload: { projectId: string; screenId: string; folderPath: string }) => {
      requireUser();
      try {
        const realId = tempIdMap.get(payload.screenId) ?? payload.screenId;
        const folderId = pathToId(payload.projectId, payload.folderPath);
        await deps.adminClient.moveScreen(realId, folderId);
        return { success: true };
      } catch (err) {
        return { success: false, error: String(err) };
      }
    },
  );

  // ── Set home screen ───────────────────────────────────────────────────
  ipcMain.handle(
    IPCChannel.DesignerSetHomeScreen,
    async (_event, payload: { projectId: string; screenId: string | null }) => {
      requireUser();
      try {
        await deps.adminClient.setHomeScreen(payload.projectId, payload.screenId);
        return { success: true };
      } catch (err) {
        return { success: false, error: String(err) };
      }
    },
  );

  // ── Reorder screen ────────────────────────────────────────────────────
  ipcMain.handle(
    IPCChannel.DesignerReorderScreen,
    async (_event, payload: { screenId: string; targetScreenId: string; insertBefore: boolean }) => {
      requireUser();
      try {
        const realId = tempIdMap.get(payload.screenId) ?? payload.screenId;
        const realTargetId = tempIdMap.get(payload.targetScreenId) ?? payload.targetScreenId;
        await deps.adminClient.reorderScreen(realId, realTargetId, payload.insertBefore);
        return { success: true };
      } catch (err) {
        return { success: false, error: String(err) };
      }
    },
  );

  // ── Create folder ─────────────────────────────────────────────────────
  ipcMain.handle(
    IPCChannel.DesignerCreateFolder,
    async (_event, payload: { projectId: string; folderPath: string }) => {
      requireUser();
      try {
        const p = normalizePath(payload.folderPath);
        const lastSlash = p.lastIndexOf('/');
        const parentPath = lastSlash === -1 ? '' : p.substring(0, lastSlash);
        const name = lastSlash === -1 ? p : p.substring(lastSlash + 1);
        const parentId = pathToId(payload.projectId, parentPath);
        await deps.adminClient.createFolder(payload.projectId, { parentId, name });
        // 刷新由 renderer 的 reloadCurrentProject() 负责，避免 DB 写入成功
        // 但后续刷新失败导致整体被报告为失败
        return { success: true };
      } catch (err) {
        return { success: false, error: String(err) };
      }
    },
  );

  // ── Delete folder ──────────────────────────────────────────────────────
  ipcMain.handle(
    IPCChannel.DesignerDeleteFolder,
    async (_event, payload: { projectId: string; folderPath: string }) => {
      requireUser();
      try {
        const folderId = pathToId(payload.projectId, payload.folderPath);
        await deps.adminClient.deleteFolder(folderId);
        return { success: true };
      } catch (err) {
        return { success: false, error: String(err) };
      }
    },
  );

  // ── Rename folder ──────────────────────────────────────────────────────
  ipcMain.handle(
    IPCChannel.DesignerRenameFolder,
    async (_event, payload: { projectId: string; folderPath: string; newName: string }) => {
      requireUser();
      try {
        const folderId = pathToId(payload.projectId, payload.folderPath);
        await deps.adminClient.renameFolder(folderId, payload.newName);
        return { success: true };
      } catch (err) {
        return { success: false, error: String(err) };
      }
    },
  );

  // ── Export HTML via save dialog ────────────────────────────────────────
  ipcMain.handle('designer:export-dialog', async (_event, payload: { html: string; defaultName?: string }) => {
    const { html, defaultName } = payload;
    const win = BrowserWindow.getFocusedWindow();
    if (!win) return { success: false, error: 'No focused window' };

    const result = await dialog.showSaveDialog(win, {
      title: 'Export HTML',
      defaultPath: defaultName || 'design.html',
      filters: [{ name: 'HTML Files', extensions: ['html', 'htm'] }],
    });

    if (result.canceled || !result.filePath) {
      return { success: false, canceled: true };
    }
    try {
      fs.writeFileSync(result.filePath, html, 'utf-8');
      return { success: true, filePath: result.filePath };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  // ── Export multiple HTML files with progress events ──────────────────
  // Writes each screen as an HTML file under outputDir, preserving folder
  // hierarchy. Sends 'designer:export-progress' events after each file so
  // the renderer can update a progress bar.
  ipcMain.handle(
    'designer:export-multi-html',
    async (event, payload: {
      items: { name: string; html: string; folderPath?: string }[];
      outputDir: string;
    }) => {
      const { items, outputDir } = payload;
      if (!outputDir) return { success: false, error: 'No output directory' };
      try {
        ensureDir(outputDir);
        const usedPaths = new Set<string>();
        let exported = 0;
        const total = items.length;
        for (const item of items) {
          const safeName = (item.name || 'untitled').replace(/[\\/:*?"<>|]/g, '_').trim() || 'untitled';
          const subParts = item.folderPath
            ? item.folderPath.split('/').map(p => p.replace(/[\\/:*?"<>|]/g, '_').trim()).filter(Boolean)
            : [];
          const targetDir = subParts.length > 0 ? path.join(outputDir, ...subParts) : outputDir;
          ensureDir(targetDir);
          let fileName = `${safeName}.html`;
          let fullPath = path.join(targetDir, fileName);
          let n = 1;
          while (usedPaths.has(fullPath.toLowerCase())) {
            fileName = `${safeName}_${n}.html`;
            fullPath = path.join(targetDir, fileName);
            n++;
          }
          usedPaths.add(fullPath.toLowerCase());
          fs.writeFileSync(fullPath, item.html, 'utf-8');
          exported++;
          event.sender.send('designer:export-progress', { current: exported, total, name: item.name });
        }
        return { success: true, count: exported };
      } catch (err) {
        return { success: false, error: String(err) };
      }
    },
  );

  // ── Show in explorer（数据已上云，打开工作区目录作为占位）──────────────
  ipcMain.handle('designer:show-in-explorer', async (_event, _projectId: string) => {
    const ws = deps.sessionConfig?.workspace || '';
    if (ws && fs.existsSync(ws)) {
      shell.openPath(ws);
    }
    return { success: true };
  });

  // ── List directories for the export directory browser ─────────────────
  // Returns only subdirectories (no files). When `dirPath` is empty, returns
  // the filesystem roots: drive letters on Windows (C:\, D:\, ...) or `/`
  // on Unix. Each entry: { name, path }.
  ipcMain.handle('designer:list-dirs', async (_event, dirPath?: string) => {
    try {
      // No path → list roots
      if (!dirPath) {
        if (process.platform === 'win32') {
          // Enumerate A-Z drives
          const roots: { name: string; path: string }[] = [];
          for (let code = 65; code <= 90; code++) {
            const letter = String.fromCharCode(code);
            const drivePath = `${letter}:\\`;
            try {
              if (fs.existsSync(drivePath) && fs.statSync(drivePath).isDirectory()) {
                roots.push({ name: `${letter}:`, path: drivePath });
              }
            } catch { /* drive not accessible — skip */ }
          }
          return { success: true, entries: roots };
        }
        // Unix: single root
        return { success: true, entries: [{ name: '/', path: '/' }] };
      }
      // Validate + read subdirectories only
      const stat = fs.statSync(dirPath);
      if (!stat.isDirectory()) {
        return { success: false, error: 'Not a directory' };
      }
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      const dirs = entries
        .filter(e => {
          if (!e.isDirectory()) return false;
          // Skip hidden folders (starting with '.') for a cleaner tree
          if (e.name.startsWith('.')) return false;
          return true;
        })
        .map(e => ({ name: e.name, path: path.join(dirPath, e.name) }))
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
      return { success: true, entries: dirs };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  // ── Create a new directory for the export browser ─────────────────────
  ipcMain.handle('designer:create-dir', async (_event, parentPath: string, dirName: string) => {
    try {
      const safeName = (dirName || '').trim().replace(/[\\/:*?"<>|]/g, '');
      if (!safeName) return { success: false, error: 'Invalid folder name' };
      const newPath = path.join(parentPath, safeName);
      fs.mkdirSync(newPath, { recursive: false });
      return { success: true, path: newPath };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  // ── Select export path via directory dialog ───────────────────────────
  ipcMain.handle('designer:select-path', async () => {
    const win = BrowserWindow.getFocusedWindow();
    if (!win) return { success: false, error: 'No focused window' };
    const ws = deps.sessionConfig?.workspace || '';
    const result = await dialog.showOpenDialog(win, {
      title: '选择导出路径',
      defaultPath: ws || undefined,
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { success: false, canceled: true };
    }
    return { success: true, path: result.filePaths[0] };
  });

  // ── Export project as Vue 3 project ───────────────────────────────────
  ipcMain.handle(
    IPCChannel.DesignerExportVue,
    async (_event, payload: { projectId: string; outputDir: string }) => {
      const { projectId, outputDir } = payload;
      requireUser();
      try {
        // 从后端拉取项目 + 设计稿内容
        const projectMeta = await deps.adminClient.getProject(projectId);
        const tree = await deps.adminClient.loadTree(projectId);
        // 收集所有 screenId 并逐个拉取完整 html
        const screenIds: string[] = [];
        const collect = (n: FolderTreeNode) => {
          n.screens.forEach(s => screenIds.push(s.id));
          n.children.forEach(collect);
        };
        collect(tree);
        const screensWithHtml: { id: string; name: string; html: string }[] = [];
        for (const id of screenIds) {
          const s = await deps.adminClient.getScreen(id);
          screensWithHtml.push({ id: s.id, name: s.name, html: s.html });
        }

        const projectName = projectMeta.name;
        const projectRoot = path.join(outputDir, projectName.replace(/\s+/g, '-'));
        ensureDir(projectRoot);

        // package.json
        fs.writeFileSync(
          path.join(projectRoot, 'package.json'),
          JSON.stringify({
            name: projectName.replace(/\s+/g, '-').toLowerCase(),
            version: '0.1.0',
            private: true,
            type: 'module',
            scripts: { dev: 'vite', build: 'vite build', preview: 'vite preview' },
            dependencies: { vue: '^3.4.0' },
            devDependencies: { '@vitejs/plugin-vue': '^5.0.0', typescript: '^5.3.0', vite: '^5.0.0', 'vue-tsc': '^2.0.0' },
          }, null, 2),
          'utf-8',
        );
        fs.writeFileSync(
          path.join(projectRoot, 'vite.config.ts'),
          `import { defineConfig } from 'vite'\nimport vue from '@vitejs/plugin-vue'\n\nexport default defineConfig({\n  plugins: [vue()],\n})\n`,
          'utf-8',
        );
        fs.writeFileSync(
          path.join(projectRoot, 'index.html'),
          `<!DOCTYPE html>\n<html lang="zh-CN">\n  <head>\n    <meta charset="UTF-8" />\n    <meta name="viewport" content="width=device-width, initial-scale=1.0" />\n    <title>${projectName}</title>\n  </head>\n  <body>\n    <div id="app"></div>\n    <script type="module" src="/src/main.ts"></script>\n  </body>\n</html>\n`,
          'utf-8',
        );
        const srcDir = path.join(projectRoot, 'src');
        const viewsDir = path.join(srcDir, 'views');
        ensureDir(srcDir);
        ensureDir(viewsDir);
        fs.writeFileSync(
          path.join(srcDir, 'main.ts'),
          `import { createApp } from 'vue'\nimport App from './App.vue'\n\ncreateApp(App).mount('#app')\n`,
          'utf-8',
        );

        const screenImports = screensWithHtml.map((s, i) => {
          const compName = toPascalCase(s.name) || `Screen${i + 1}`;
          return `import ${compName} from './views/${compName}.vue'`;
        }).join('\n');
        const screenList = screensWithHtml.map((s, i) => {
          const compName = toPascalCase(s.name) || `Screen${i + 1}`;
          return `      <${compName} v-if="currentView === ${i}" />`;
        }).join('\n');
        const screenButtons = screensWithHtml.map((s, i) =>
          `      <button @click="currentView = ${i}" :class="{ active: currentView === ${i} }">${s.name}</button>`
        ).join('\n');

        fs.writeFileSync(
          path.join(srcDir, 'App.vue'),
          `<template>\n  <div class="app">\n    <nav class="app-nav">\n${screenButtons}\n    </nav>\n    <main class="app-content">\n${screenList}\n    </main>\n  </div>\n</template>\n\n<script setup lang="ts">\nimport { ref } from 'vue'\n${screenImports}\n\nconst currentView = ref(0)\n</script>\n\n<style>\n.app { min-height: 100vh; }\n.app-nav { display: flex; gap: 8px; padding: 12px 24px; background: #f5f5f5; border-bottom: 1px solid #e5e7eb; }\n.app-nav button { padding: 6px 16px; border: none; background: transparent; cursor: pointer; border-radius: 6px; font-size: 14px; color: #6b7280; }\n.app-nav button.active { background: #3b82f6; color: #fff; }\n.app-content { flex: 1; }
</style>\n`,
          'utf-8',
        );

        for (const s of screensWithHtml) {
          const compName = toPascalCase(s.name) || 'Screen';
          fs.writeFileSync(path.join(viewsDir, `${compName}.vue`), htmlToVueSFC(s.html, compName), 'utf-8');
        }

        return { success: true, path: projectRoot };
      } catch (err) {
        return { success: false, error: String(err) };
      }
    },
  );

  // ═══════════════════════════════════════════════════════════════════════
  // 团队 / 权限 IPC
  // ═══════════════════════════════════════════════════════════════════════

  ipcMain.handle(IPCChannel.DesignerListMembers, async (_e, projectId: string) => {
    requireUser();
    try {
      const members = await deps.adminClient.listMembers(projectId);
      return { success: true, members };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle(
    IPCChannel.DesignerAddMember,
    async (_e, payload: { projectId: string; email: string; role: ProjectRole }) => {
      requireUser();
      try {
        const m = await deps.adminClient.addMember(payload.projectId, payload.email, payload.role);
        return { success: true, member: m };
      } catch (err) {
        return { success: false, error: String(err) };
      }
    },
  );

  ipcMain.handle(
    IPCChannel.DesignerUpdateMemberRole,
    async (_e, payload: { projectId: string; userId: number; role: ProjectRole }) => {
      requireUser();
      try {
        await deps.adminClient.updateMemberRole(payload.projectId, payload.userId, payload.role);
        return { success: true };
      } catch (err) {
        return { success: false, error: String(err) };
      }
    },
  );

  ipcMain.handle(
    IPCChannel.DesignerRemoveMember,
    async (_e, payload: { projectId: string; userId: number }) => {
      requireUser();
      try {
        await deps.adminClient.removeMember(payload.projectId, payload.userId);
        return { success: true };
      } catch (err) {
        return { success: false, error: String(err) };
      }
    },
  );

  ipcMain.handle(IPCChannel.DesignerSearchUsers, async (_e, email: string) => {
    requireUser();
    try {
      const users = await deps.adminClient.searchUsers(email || '');
      return { success: true, users };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle(
    IPCChannel.DesignerListFolderPermissions,
    async (_e, payload: { projectId: string; folderPath: string }) => {
      requireUser();
      try {
        const folderId = pathToId(payload.projectId, payload.folderPath);
        const perms = await deps.adminClient.listFolderPermissions(folderId);
        return { success: true, permissions: perms };
      } catch (err) {
        return { success: false, error: String(err) };
      }
    },
  );

  ipcMain.handle(
    IPCChannel.DesignerGrantFolderPermission,
    async (_e, payload: { projectId: string; folderPath: string; userId: number; permission: FolderPermission }) => {
      requireUser();
      try {
        const folderId = pathToId(payload.projectId, payload.folderPath);
        await deps.adminClient.grantFolderPermission(folderId, payload.userId, payload.permission);
        return { success: true };
      } catch (err) {
        return { success: false, error: String(err) };
      }
    },
  );

  ipcMain.handle(
    IPCChannel.DesignerRevokeFolderPermission,
    async (_e, payload: { projectId: string; folderPath: string; userId: number }) => {
      requireUser();
      try {
        const folderId = pathToId(payload.projectId, payload.folderPath);
        await deps.adminClient.revokeFolderPermission(folderId, payload.userId);
        return { success: true };
      } catch (err) {
        return { success: false, error: String(err) };
      }
    },
  );

  /** 检查当前用户在指定目录（或根目录）是否有写权限，供 AI 操作前置弹窗使用。 */
  ipcMain.handle(
    IPCChannel.DesignerCheckWritePermission,
    async (_e, payload: { projectId: string; folderPath?: string }) => {
      const user = requireUser();
      try {
        // 根目录写权限 = OWNER/ADMIN（项目 role）；子目录需查后端
        const projectMeta = await deps.adminClient.getProject(payload.projectId);
        const role = projectMeta.role;
        if (role === 'OWNER' || role === 'ADMIN') {
          return { success: true, canWrite: true, role };
        }
        // 普通成员：根目录无写权限
        const folderPath = normalizePath(payload.folderPath);
        if (!folderPath) {
          return { success: true, canWrite: false, role };
        }
        // 子目录：尝试解析 folderId；若该目录由当前用户创建或被授权 WRITE 则可写
        // 通过 loadTree 拿 createdBy 与权限列表判断
        const tree = await deps.adminClient.loadTree(payload.projectId);
        let canWrite = false;
        const findFolder = (n: FolderTreeNode): boolean => {
          if (n.id != null && idToPath(payload.projectId, n.id) === folderPath) return true;
          return n.children.some(findFolder);
        };
        // 重建映射后再查
        treeToProject(projectMeta, tree);
        const folderId = pathToId(payload.projectId, folderPath);
        // 查权限列表
        const perms = await deps.adminClient.listFolderPermissions(folderId);
        const mine = perms.find(p => p.userId === user.id);
        canWrite = !!mine && mine.permission === 'WRITE';
        // 或该目录由当前用户创建
        if (!canWrite) {
          const findCreatedBy = (n: FolderTreeNode): boolean => {
            if (n.id === folderId) return n.createdBy === user.id;
            return n.children.some(findCreatedBy);
          };
          canWrite = findCreatedBy(tree);
        }
        return { success: true, canWrite, role };
      } catch (err) {
        return { success: false, error: String(err), canWrite: false };
      }
    },
  );

  /** 获取当前用户在项目中所有可写目录列表。 */
  ipcMain.handle(
    IPCChannel.DesignerListWritableFolders,
    async (_e, payload: { projectId: string }) => {
      requireUser();
      try {
        const folders = await deps.adminClient.writableFolders(payload.projectId);
        return { success: true, folders };
      } catch (err) {
        return { success: false, error: String(err), folders: [] };
      }
    },
  );

  // ═══════════════════════════════════════════════════════════════════════
  // 发布 (Publication) IPC
  // ═══════════════════════════════════════════════════════════════════════

  ipcMain.handle(
    IPCChannel.DesignerCreatePublication,
    async (_e, payload: { projectId: string; req: CreatePublicationRequest }) => {
      requireUser();
      try {
        const pub = await deps.adminClient.createPublication(payload.projectId, payload.req);
        return { success: true, publication: pub };
      } catch (err) {
        return { success: false, error: String(err) };
      }
    },
  );

  ipcMain.handle(
    IPCChannel.DesignerListPublications,
    async (_e, payload: { projectId: string }) => {
      requireUser();
      try {
        const list = await deps.adminClient.listPublications(payload.projectId);
        return { success: true, publications: list };
      } catch (err) {
        return { success: false, error: String(err), publications: [] };
      }
    },
  );

  ipcMain.handle(
    IPCChannel.DesignerDeletePublication,
    async (_e, payload: { projectId: string; publicationId: number }) => {
      requireUser();
      try {
        await deps.adminClient.deletePublication(payload.projectId, payload.publicationId);
        return { success: true };
      } catch (err) {
        return { success: false, error: String(err) };
      }
    },
  );

  ipcMain.handle(
    IPCChannel.DesignerRefreshPublication,
    async (_e, payload: { projectId: string; publicationId: number }) => {
      requireUser();
      try {
        const pub = await deps.adminClient.refreshPublication(payload.projectId, payload.publicationId);
        return { success: true, publication: pub };
      } catch (err) {
        return { success: false, error: String(err) };
      }
    },
  );

  // ═══════════════════════════════════════════════════════════════════════
  // 设计稿历史版本 (Screen History) IPC
  // ═══════════════════════════════════════════════════════════════════════

  ipcMain.handle(
    IPCChannel.DesignerListScreenHistory,
    async (_e, payload: { screenId: string }) => {
      requireUser();
      try {
        const list = await deps.adminClient.listScreenHistory(payload.screenId);
        return { success: true, history: list };
      } catch (err) {
        return { success: false, error: String(err), history: [] };
      }
    },
  );

  ipcMain.handle(
    IPCChannel.DesignerGetScreenHistoryContent,
    async (_e, payload: { screenId: string; historyId: number }) => {
      requireUser();
      try {
        const content = await deps.adminClient.getScreenHistoryContent(payload.screenId, payload.historyId);
        return { success: true, content };
      } catch (err) {
        return { success: false, error: String(err) };
      }
    },
  );

  ipcMain.handle(
    IPCChannel.DesignerRestoreScreenHistory,
    async (_e, payload: { screenId: string; historyId: number }) => {
      requireUser();
      try {
        const restored = await deps.adminClient.restoreScreenHistory(payload.screenId, payload.historyId);
        // 更新本地 version 缓存，避免后续保存因 version 不匹配而失败
        versionCache.set(restored.id, restored.version ?? 0);
        return { success: true, screen: restored };
      } catch (err) {
        return { success: false, error: String(err) };
      }
    },
  );

  // ── Master Layout: 共享母版 / 菜单注入 ────────────────────────────────
  // 三个 handler：保存（新建/更新）、删除、批量注入所有页面。
  // 注入逻辑运行在主进程（Node 环境），使用 cheerio 操作 HTML。
  // 与渲染层 masterLayoutInject.ts 的 DOMParser 版本逻辑保持一致（D13）。

  /** 保存（新建或更新）MasterLayout。layout.id 缺失时生成新 id。 */
  ipcMain.handle(
    IPCChannel.DesignerSaveMasterLayout,
    async (_event, payload: { projectId: string; layout: MasterLayout }) => {
      requireUser();
      try {
        const { projectId, layout } = payload;
        // 取当前项目（含已有 masterLayouts）
        const project = await deps.adminClient.getProject(projectId);
        const existing: MasterLayout[] = project.masterLayouts ?? [];
        // 同 id 替换，否则追加；MVP 限制 ≤1 个，此处仍按数组通用处理以便 v1 扩展
        const idx = existing.findIndex(l => l.id === layout.id);
        const now = new Date().toISOString();
        const normalized: MasterLayout = {
          ...layout,
          id: layout.id || randomUUID(),
          updatedAt: now,
          createdAt: layout.createdAt || now,
        };
        if (idx >= 0) existing[idx] = normalized;
        else existing.push(normalized);
        const masterLayoutsJson = JSON.stringify(existing);
        const updated = await deps.adminClient.updateProject(projectId, { masterLayoutsJson });
        return { success: true, project: updated, layouts: existing };
      } catch (err) {
        return { success: false, error: String(err) };
      }
    },
  );

  /** 删除指定 MasterLayout。 */
  ipcMain.handle(
    IPCChannel.DesignerDeleteMasterLayout,
    async (_event, payload: { projectId: string; layoutId: string }) => {
      requireUser();
      try {
        const { projectId, layoutId } = payload;
        const project = await deps.adminClient.getProject(projectId);
        const existing: MasterLayout[] = project.masterLayouts ?? [];
        const filtered = existing.filter(l => l.id !== layoutId);
        const masterLayoutsJson = filtered.length > 0 ? JSON.stringify(filtered) : '';
        const updated = await deps.adminClient.updateProject(projectId, { masterLayoutsJson });
        return { success: true, project: updated, layouts: filtered };
      } catch (err) {
        return { success: false, error: String(err) };
      }
    },
  );

  /**
   * 批量注入 MasterLayout 到所有页面（立即同步，D4）。
   * 串行 UPDATE 避免服务器/带宽争用（参考 strict serial loading 约束）。
   * 通过 event.sender.send 推送进度，失败页入 failed 列表（不阻塞其他页）。
   */
  ipcMain.handle(
    IPCChannel.DesignerInjectMasterLayoutAll,
    async (event, payload: { projectId: string; layoutId: string; layout?: MasterLayout }) => {
      requireUser();
      const { projectId, layoutId, layout: passedLayout } = payload;
      try {
        // 1. 取 layout + 所有 screens
        const project = await refreshMapsAndProject(deps, projectId);
        // Prefer the layout passed directly from the renderer (just saved) to
        // avoid "MasterLayout not found" if the server hasn't propagated the
        // write yet. Fall back to fetching from the project for backward compat.
        const layout = passedLayout ?? (project.masterLayouts ?? []).find(l => l.id === layoutId);
        if (!layout) {
          return { success: false, error: 'MasterLayout not found', updated: 0, failed: [] };
        }
        const screens = project.screens;
        const total = screens.length;
        const failed: Array<{ screenId: string; reason: string }> = [];
        let updated = 0;

        // 2. 逐个注入并保存（串行，参考 strict serial loading 约束）
        for (const screen of screens) {
          const realId = tempIdMap.get(screen.id) ?? screen.id;
          try {
            // 取当前 html（树摘要 html=''，需按需拉取）
            let html = screen.html;
            let version = versionCache.get(realId);
            if (!html) {
              const fresh = await deps.adminClient.getScreen(realId);
              html = fresh.html;
              version = fresh.version;
            }
            if (version == null) version = 0;

            // cheerio 注入（与 renderer 端 DOMParser 版本逻辑一致）
            const injected = injectMasterLayoutWithCheerio(html, screen.id, screen.name ?? '', layout, project.masterLayouts ?? [layout]);
            if (injected === html) {
              // 无 slot，跳过（老页面兼容）
              updated++;
              event.sender.send(IPCChannel.DesignerMasterLayoutProgress, {
                updated, total, current: screen.id, skipped: true,
              });
              continue;
            }

            const updatedScreen = await deps.adminClient.updateScreen(realId, {
              content: injected,
              version,
              source: 'master-layout-inject',
            });
            versionCache.set(realId, updatedScreen.version ?? version);
            updated++;
            event.sender.send(IPCChannel.DesignerMasterLayoutProgress, {
              updated, total, current: screen.id, skipped: false,
            });
          } catch (err) {
            // version 冲突(409)/网络错误：入 failed，不阻塞其他页
            failed.push({ screenId: screen.id, reason: String(err) });
            event.sender.send(IPCChannel.DesignerMasterLayoutProgress, {
              updated, total, current: screen.id, skipped: false, failed: true,
            });
          }
        }

        return { success: true, updated, failed };
      } catch (err) {
        return { success: false, error: String(err), updated: 0, failed: [] };
      }
    },
  );
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * 主进程端 MasterLayout 注入（cheerio，D13）。
 * 与渲染层 masterLayoutInject.ts 的 DOMParser 版本逻辑保持一致。
 * 找不到 slot 时原样返回（老页面兼容）。
 *
 * 高亮策略与 renderer 端 highlightActiveMenuItem 一致：
 *  - data-nav-target===screenId → EXACT+1（强绑定最高）
 *  - 否则 scoreMenuMatch(textContent, screenName)（EXACT > FUZZY > NONE）
 *  - winner 加 .active；若位于子菜单（.collapse/.dropdown），展开父级。
 *
 * allLayouts 用于合并所有 layout.css 到一个 <style> 块（幂等替换），
 * 与 renderer 端 injectMasterLayouts 行为一致。
 */
function injectMasterLayoutWithCheerio(
  html: string,
  screenId: string,
  screenName: string,
  layout: MasterLayout,
  allLayouts: MasterLayout[] = [layout],
): string {
  const $ = cheerio.load(html);
  const slot = $(`[data-design-slot="${layout.slotName}"]`);
  if (slot.length === 0) return html; // 老页面无 slot，跳过

  // 1. 用 MasterLayout.html 替换 slot 内容，并移除其中 <script>（Bug C 防御：
  //    旧 layout 可能仍带 <script src="bootstrap...">，避免与目标页 Bootstrap JS 重复加载）
  slot.html(layout.html);
  $('script', slot).remove();

  // 2. 高亮当前页对应菜单项 + 展开父级（与 renderer 端一致）
  highlightActiveMenuItemCheerio($, slot, screenId, screenName);

  // 3. 合并所有 layout.css 到 <head> 的 <style id="__xai_master_layout_css__">（幂等替换）
  const cssParts: string[] = [];
  for (const l of allLayouts) {
    if (l.css && l.css.trim()) {
      cssParts.push(`/* ${l.name || l.id} */\n${l.css}`);
    }
  }
  if (cssParts.length > 0) {
    const cssContent = cssParts.join('\n');
    const existing = $(`style#__xai_master_layout_css__`);
    if (existing.length > 0) {
      existing.text(cssContent);
    } else {
      // 插在第一个 designer 注入样式之前（保持 cascade 与 renderer 端一致）
      const styleEl = `<style id="__xai_master_layout_css__">\n${cssContent}\n</style>`;
      const firstDesignerStyle = $('head').find('style[id^="__xai_designer_"], link[href*="bootstrap"]').first();
      if (firstDesignerStyle.length > 0) {
        firstDesignerStyle.before(styleEl);
      } else {
        $('head').append(styleEl);
      }
    }
  }

  // 4. 合并所有 layout.scripts 到 </body> 前的 <script id="__xai_master_layout_scripts__">
  //    （幂等替换，Bug A：恢复 toggleSidebarDropdown 等交互函数）
  const scriptParts: string[] = [];
  const declaredFn = new Set<string>();
  for (const l of allLayouts) {
    if (!l.scripts || !l.scripts.trim()) continue;
    const fnNames = [...l.scripts.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)\b/g)].map(m => m[1]);
    if (fnNames.length > 0 && fnNames.every(n => declaredFn.has(n))) continue;
    fnNames.forEach(n => declaredFn.add(n));
    scriptParts.push(`/* ${l.name || l.id} */\n${l.scripts}`);
  }
  if (scriptParts.length > 0) {
    const scriptsContent = scriptParts.join('\n;\n');
    const existing = $('script#__xai_master_layout_scripts__');
    // 风险点：cheerio .text() 会转义 JS 里的 < / & 破坏代码，必须用原始字符串拼接。
    const scriptTag = `<script id="__xai_master_layout_scripts__">//\n${scriptsContent}\n</` + `script>`;
    if (existing.length > 0) {
      existing.replaceWith(scriptTag);
    } else {
      $('body').append(scriptTag);
    }
  }

  return $.html();
}

/**
 * cheerio 版高亮：在 slot 内选出当前页对应菜单项并加 .active，展开父级折叠/下拉。
 * 与 renderer 端 highlightActiveMenuItem（DOMParser）逻辑完全对齐。
 *
 * 打分：data-nav-target===screenId → EXACT+1（强绑定最高，优先于一切文本匹配）；
 *      否则 scoreMenuMatch(textContent, screenName)（EXACT > FUZZY > NONE）。
 * 选优：最高分；同分取 label 最长（最具体）；仍同分优先非 toggle 叶子。
 * 幂等：先清掉所有候选的 .active（含其 <li>），再给 winner 加 .active。
 */
function highlightActiveMenuItemCheerio(
  $: cheerio.CheerioAPI,
  slot: cheerio.Cheerio<any>,
  screenId: string,
  screenName: string,
): void {
  const candidateNodes = slot.find('a, button').toArray();

  type Cand = { node: any; score: number; labelLen: number; isToggle: boolean };
  let best: Cand | null = null;
  for (const node of candidateNodes) {
    const el = $(node);
    const navTarget = el.attr('data-nav-target') || '';
    const text = (el.text() || '').trim();
    const score = navTarget && navTarget === screenId
      ? MENU_MATCH_SCORE.EXACT + 1 // 强绑定压过一切文本匹配
      : scoreMenuMatch(text, screenName);
    if (score === MENU_MATCH_SCORE.NONE) continue;
    const isToggle = el.attr('data-bs-toggle') !== undefined;
    const c: Cand = { node, score, labelLen: text.length, isToggle };
    if (
      !best ||
      c.score > best.score ||
      (c.score === best.score && c.labelLen > best.labelLen) ||
      (c.score === best.score && c.labelLen === best.labelLen && !c.isToggle && best.isToggle)
    ) {
      best = c;
    }
  }

  // 清除所有候选的 .active / .active-side（幂等重算，确保每页高亮反映当前页而非母版快照残留）
  candidateNodes.forEach(node => {
    const el = $(node);
    el.removeClass('active active-side');
    el.closest('li').removeClass('active');
  });

  if (best) {
    const bestEl = $(best.node);
    bestEl.addClass('active active-side');
    bestEl.closest('li').addClass('active');
    expandAncestorsCheerio($, bestEl, slot);
  }
}

/**
 * cheerio 版父级展开：从 el 向上遍历到 slot 根，展开沿途的折叠/下拉父级。
 * 与 renderer 端 expandAncestors（DOMParser）逻辑完全对齐。
 *
 *  - Bootstrap collapse：.collapse 加 show；并用 href="#<id>" 找到同级 toggle
 *    设 aria-expanded="true"。
 *  - data-dropdown-open 状态属性（类无关）：任何带该属性的祖先置 "true"
 *    （覆盖 designer 的 .dropdown 与 AI 的 .sidebar-dropdown）。
 *  - sidebar-submenu 内联 display:none 清除：toggleSidebarDropdown JS 用 inline
 *    style 管理显隐，初始注入时 JS 未执行，需同步清除 display:none。
 */
function expandAncestorsCheerio(
  $: cheerio.CheerioAPI,
  el: cheerio.Cheerio<any>,
  slot: cheerio.Cheerio<any>,
): void {
  // parentsUntil(slot) 返回 el 到 slot（不含）之间所有祖先
  el.parentsUntil(slot).each((_, cur) => {
    const $cur = $(cur);
    if ($cur.hasClass('collapse')) {
      $cur.addClass('show');
      const id = $cur.attr('id');
      if (id) {
        const toggle = slot.find(`[data-bs-toggle="collapse"][href="#${id}"]`).first();
        toggle.attr('aria-expanded', 'true');
      }
    }
    if ($cur.attr('data-dropdown-open') !== undefined) {
      $cur.attr('data-dropdown-open', 'true');
      // 清除 .sidebar-submenu 的内联 display:none + maxHeight
      const $submenu = $cur.find('.sidebar-submenu').first();
      if ($submenu.length > 0) {
        $submenu.css('display', 'block');
        $submenu.css('max-height', 'none');
      }
    }
  });
}

/** Convert a screen name to PascalCase for Vue component names. */
function toPascalCase(str: string): string {
  return str
    .replace(/[-_\s]+(.) /g, (_, c) => c.toUpperCase())
    .replace(/^(.)/, (_, c) => c.toUpperCase())
    .replace(/[^a-zA-Z0-9]/g, '');
}

/** Convert HTML to a Vue 3 SFC with Composition API. */
function htmlToVueSFC(html: string, componentName: string): string {
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  const bodyContent = bodyMatch ? bodyMatch[1].trim() : html;
  const styleMatches = html.match(/<style[^>]*>([\s\S]*?)<\/style>/gi);
  const styles = styleMatches ? styleMatches.map(s => s.replace(/<\/?style[^>]*>/gi, '')).join('\n') : '';
  const scriptMatches = html.match(/<script(?![^>]*type=["']module["'])[^>]*>([\s\S]*?)<\/script>/gi);
  const scripts = scriptMatches ? scriptMatches.map(s => s.replace(/<script[^>]*>/i, '').replace(/<\/script>/i, '')).join('\n') : '';

  let sfc = `<template>\n  <div class="${componentName.toLowerCase()}">\n    ${bodyContent}\n  </div>\n</template>\n\n`;
  sfc += `<script setup lang="ts">\n`;
  sfc += scripts ? `// Extracted from original HTML\n${scripts}\n` : `// Component logic\n`;
  sfc += `</script>\n\n`;
  sfc += styles
    ? `<style scoped>\n${styles}\n</style>\n`
    : `<style scoped>\n.${componentName.toLowerCase()} {\n  \n}\n</style>\n`;
  return sfc;
}
