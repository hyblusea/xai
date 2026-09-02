import { EventEmitter } from 'events';
import { Message, AgentState, ToolResult, LLMConfig, ConfirmationRequest, ToolDefinition, TOOL_OUTPUT_MAX_CHARS } from '@xai/shared';
import { LLMRouter } from '../llm/index.js';
import { ParsedToolCall, AiderStyleParser, extractAiderBlocks } from '../parser/index.js';
import { ToolRegistry } from '../tools/tool-registry.js';
import { ContextManager } from '../context/context-manager.js';
import { buildSystemPrompt, buildContentToolsPrompt } from '../context/prompt-builder.js';
import { ConfirmationManager } from '../permissions/confirmation-manager.js';
import type { LLMAdapter } from '../llm/types.js';

/** Check if a tool should use ++++ text format instead of native function calling. */
function isTextModeTool(tool: ToolDefinition): boolean {
  return tool.contentMode === 'text';
}

export interface ReActLoopOptions {
  llmRouter: LLMRouter;
  toolRegistry: ToolRegistry;
  contextManager: ContextManager;
  confirmationManager: ConfirmationManager;
  llmConfig: LLMConfig;
  workspacePath: string;
  maxIterations?: number;
  skipToolParsing?: boolean;
}

export class ReActLoop extends EventEmitter {
  private _state: AgentState = 'idle';
  private options: ReActLoopOptions;
  private streamAiderParser: AiderStyleParser;
  private abortController?: AbortController;
  private iterationCount: number = 0;
  private consecutiveErrors: number = 0;
  private _aborted: boolean = false;
  private readonly MAX_CONSECUTIVE_ERRORS = 12;
  /** Iteration index of the last successful auto-compaction (to avoid re-triggering). */
  private lastCompressIteration: number = -1;

  constructor(options: ReActLoopOptions) {
    super();
    this.options = options;
    this.streamAiderParser = new AiderStyleParser({ toolRegistry: this.options.toolRegistry });
  }

  get currentState(): AgentState {
    return this._state;
  }

  private setState(newState: AgentState): void {
    this._state = newState;
    this.emit('stateChange', newState);
  }

  /**
   * Emit a context-usage snapshot for compression-aware adapters
   * (OpenAI / DevEco / Cline). The renderer uses this to render the usage indicator.
   */
  private emitContextUpdate(): void {
    try {
      const adapter = this.options.llmRouter.getAdapter(this.options.llmConfig.provider) as LLMAdapter;
      if (typeof adapter.getContextUsage === 'function') {
        const usage = adapter.getContextUsage(this.options.llmConfig);
        this.emit('contextUpdate', usage);
      }
    } catch {
      // Adapter missing or not compression-aware — ignore.
    }
  }

  /**
   * Auto-compression for compression-aware adapters (OpenAI / DevEco / Cline).
   * When the adapter's context usage exceeds the threshold, call LLM-driven
   * compressHistory to summarize old conversation turns into a compact summary.
   * Mirrors the Designer-view's auto-compaction logic.
   *
   * Threshold: 70% of context window.
   * Skipped if: already compressed this iteration, agent is aborted, or
   * the adapter does not support compression.
   */
  private async tryAutoCompress(): Promise<void> {
    // Don't re-compress on the same iteration or after abort.
    if (this._aborted || this.iterationCount === this.lastCompressIteration) return;

    const CONTEXT_COMPRESS_THRESHOLD = 0.7;

    try {
      const adapter = this.options.llmRouter.getAdapter(this.options.llmConfig.provider) as LLMAdapter;

      // Only for compression-aware adapters (OpenAI / DevEco / Cline).
      if (
        !adapter ||
        typeof adapter.getContextUsage !== 'function' ||
        typeof adapter.compressHistory !== 'function'
      ) return;

      const usage = adapter.getContextUsage(this.options.llmConfig);
      if (usage.usagePercent < CONTEXT_COMPRESS_THRESHOLD * 100) return;

      console.log(
        `[ReActLoop] Context usage ${usage.usagePercent}% >= ${CONTEXT_COMPRESS_THRESHOLD * 100}%, auto-compressing...`,
      );
      this.emit('compressing', { usagePercent: usage.usagePercent });

      const result = await adapter.compressHistory(this.options.llmConfig);

      if (result.success) {
        this.lastCompressIteration = this.iterationCount;
        console.log(
          `[ReActLoop] Auto-compaction succeeded: ${result.beforeMessages}→${result.afterMessages} messages, ${result.beforeTokens}→${result.afterTokens} tokens`,
        );
        this.emit('compressed', {
          beforeMessages: result.beforeMessages,
          afterMessages: result.afterMessages,
          beforeTokens: result.beforeTokens,
          afterTokens: result.afterTokens,
        });
        // Emit an updated context snapshot so the UI badge refreshes.
        this.emitContextUpdate();
      } else {
        console.warn(`[ReActLoop] Auto-compaction returned success=false: ${result.error}`);
        // Emit a compression-failed event so the UI can dismiss the
        // "compressing" toast instead of leaving it stuck forever.
        this.emit('compressError', { error: result.error ?? 'Auto-compaction failed' });
        // Mark this iteration as the last compress attempt to avoid
        // re-triggering on every subsequent iteration (which would keep
        // the "compressing" toast alive indefinitely while context keeps
        // growing). The next user message will reset lastCompressIteration.
        this.lastCompressIteration = this.iterationCount;
      }
    } catch (err) {
      // Non-fatal: log and continue — the agent loop should not break
      // because a compression attempt failed.
      console.error('[ReActLoop] Auto-compaction failed:', err);
      this.emit('compressError', { error: String(err) });
      this.lastCompressIteration = this.iterationCount;
    }
  }

  private isTerminalState(): boolean {
    return this._state === 'completed' || this._state === 'error';
  }

  async run(userMessage: string, options?: { isFirstMessageOfSession?: boolean }): Promise<void> {
    this.setState('thinking');
    this.iterationCount = 0;
    this.consecutiveErrors = 0;
    this._aborted = false;
    this.lastCompressIteration = -1;

    this.options.contextManager.clear();

    const adapter = this.options.llmRouter.getAdapter(this.options.llmConfig.provider);
    const useNativeTools = !!(adapter as LLMAdapter).supportsNativeTools;

    let systemPrompt: string;

    if (useNativeTools) {
      // Hybrid path: adapter self-manages history and uses native function calling
      // for simple-parameter tools, but content-type tools (write_to_file, replace_in_file)
      // go through ++++ text format via AiderStyleParser to avoid JSON escaping issues.
      if (options?.isFirstMessageOfSession) {
        (adapter as { resetSession?: () => void }).resetSession?.();
      }

      // When the adapter already has conversation history (e.g. after a cross-adapter
      // context migration), the system prompt was filtered out during migration and
      // needs to be re-injected. However, we must NOT inject it as a separate message
      // that would be appended via appendNewMessages — instead, we check if the
      // adapter's history already contains a system message. If not, we build and
      // inject one so the new model has the tool definitions and workspace context.
      const hasSystemInHistory = (adapter as { conversationHistory?: Array<{ role: string }> }).conversationHistory?.some(m => m.role === 'system') ?? false;
      if (hasSystemInHistory) {
        // Adapter already has a system prompt (normal continuation) — skip
        systemPrompt = '';
      } else {
        systemPrompt = buildContentToolsPrompt(
          this.options.toolRegistry.getDefinitions(),
          this.options.workspacePath,
        );
      }
    } else {
      // MiMo path: use text-based system prompt with ++++ tool format.
      // The reverse-engineered web APIs remember system_prompt server-side via
      // conversation_id, so it only needs to go out on the first message of a session.
      systemPrompt = options?.isFirstMessageOfSession === false
        ? ''
        : buildSystemPrompt(
            this.options.toolRegistry.getDefinitions(),
            this.options.workspacePath
          );
    }

    try {
      await this.loop(systemPrompt, userMessage);
    } finally {
      // 清除 raw HTTP 回调，避免残留影响后续会话或 Designer 视图
      this.options.llmRouter.onRawHttp = undefined;
    }
  }

  private async loop(systemPrompt: string, userMessage: string): Promise<void> {
    const adapter = this.options.llmRouter.getAdapter(this.options.llmConfig.provider) as LLMAdapter;
    const useNativeTools = !!adapter.supportsNativeTools;

    while (this.iterationCount < (this.options.maxIterations ?? 9999)) {
      if (this.isTerminalState() || this._aborted) break;

      this.iterationCount++;

      // 本轮迭代的日志数据（提到 try 外，便于 catch / finally 统一上报）
      const iterationStartTime = Date.now();
      let iterationRequestText = '';
      let fullResponse = '';
      let iterationStatus: 'success' | 'error' | 'aborted' = 'success';
      let iterationErrorMessage: string | undefined;

      try {
        const allMessages: Message[] = [];
        if (this.iterationCount === 1) {
          if (systemPrompt) {
            allMessages.push({ role: 'system', content: systemPrompt, timestamp: Date.now() });
          }
          if (userMessage) {
            allMessages.push({ role: 'user', content: userMessage, timestamp: Date.now() });
          }
        }
        allMessages.push(...this.options.contextManager.getMessages());

        // 记录本轮实际发给 LLM 的完整内容（第1轮含 system+user，第N轮含上一轮 tool results）
        try {
          iterationRequestText = JSON.stringify(allMessages, null, 2);
        } catch {
          iterationRequestText = allMessages.map(m => `[${m.role}] ${m.content ?? ''}`).join('\n\n');
        }

        this.setState('thinking');

        this.abortController = new AbortController();
        console.log(`[ReActLoop] Iteration ${this.iterationCount}: Sending ${allMessages.length} messages to LLM (nativeTools=${useNativeTools})`);
        this.emit('streamReset');

        // For native-tools providers, inject tool definitions into the config.
        // Content-type tools are excluded — they use ++++ text format instead.
        let loopConfig = this.options.llmConfig;
        if (useNativeTools) {
          const nativeDefs = this.options.toolRegistry.getDefinitions()
            .filter(d => !isTextModeTool(d));
          const openaiTools = this.convertToolDefinitions(nativeDefs);
          loopConfig = {
            ...this.options.llmConfig,
            options: { ...(this.options.llmConfig.options ?? {}), tools: openaiTools },
          };
        }

        const stream = this.options.llmRouter.send(allMessages, loopConfig, this.abortController.signal);

        let streamTextOnly = '';
        const toolCalls: ParsedToolCall[] = [];

        if (useNativeTools) {
          // ── Hybrid path: native tool-call + AiderStyleParser for content tools ──
          // Content-type tools (write_to_file, replace_in_file) are emitted as ++++
          // text blocks by the LLM and parsed by AiderStyleParser, NOT via native
          // function calling. This avoids JSON escaping issues for large content.
          this.streamAiderParser.reset();

          for await (const chunk of stream) {
            if (this._aborted || this.isTerminalState()) break;

            if (chunk.type === 'text') {
              fullResponse += chunk.content;

              // Feed text to AiderStyleParser to catch ++++ content tool calls
              const aiderEvents = this.streamAiderParser.feed(chunk.content);
              for (const event of aiderEvents) {
                if (event.type === 'text') {
                  streamTextOnly += event.content;
                  this.emit('streamText', event.content);
                } else if (event.type === 'tool_summary') {
                  this.emit('streamToolSummary', event.content);
                } else if (event.type === 'tool_call_start') {
                  this.emit('toolCallStart');
                } else if (event.type === 'tool_call' && event.toolCall) {
                  toolCalls.push(event.toolCall);
                  this.emit('toolCallParsed', event.toolCall);
                } else if (event.type === 'tool_call_end') {
                  this.emit('toolCallEnd', event.content, event.toolCall);
                }
              }
            } else if (chunk.type === 'tool_call') {
              // Native tool call from OpenAI adapter (simple-parameter tools)
              const tc = chunk.toolCall;
              if (tc) {
                const parsed: ParsedToolCall = {
                  name: tc.name,
                  parameters: tc.parameters,
                  rawXml: '',
                };
                toolCalls.push(parsed);
                this.emit('toolCallStart');
                this.emit('toolCallParsed', parsed);
                this.emit('toolCallEnd', `${tc.name}`, parsed);
              }
            } else if (chunk.type === 'thinking') {
              this.emit('streamThinking', chunk.content);
            } else if (chunk.type === 'error') {
              this.consecutiveErrors++;
              iterationStatus = 'error';
              iterationErrorMessage = chunk.content;
              this.setState('error');
              this.emit('error', new Error(chunk.content));
              this.emit('streamText', `❌ LLM Error: ${chunk.content}`);
              return;
            } else if (chunk.type === 'done') {
              break;
            }
          }

          // Flush remaining AiderStyleParser events
          const flushEvents = this.streamAiderParser.flush();
          for (const event of flushEvents) {
            if (event.type === 'text') {
              streamTextOnly += event.content;
              this.emit('streamText', event.content);
            } else if (event.type === 'tool_summary') {
              this.emit('streamToolSummary', event.content);
            } else if (event.type === 'tool_call_start') {
              this.emit('toolCallStart');
            } else if (event.type === 'tool_call' && event.toolCall) {
              toolCalls.push(event.toolCall);
              this.emit('toolCallParsed', event.toolCall);
            } else if (event.type === 'tool_call_end') {
              this.emit('toolCallEnd', event.content, event.toolCall);
            }
          }

          // Full-text fallback parse for content tools
          if (toolCalls.length === 0 && fullResponse.length > 0) {
            const aiderCalls = extractAiderBlocks(fullResponse, { toolRegistry: this.options.toolRegistry });
            if (aiderCalls.length > 0) {
              console.log(`[ReActLoop] Full-text parser found ${aiderCalls.length} content tool call(s)`);
              for (const tc of aiderCalls) {
                toolCalls.push(tc);
                this.emit('toolCallParsed', tc);
              }
            }
          }
        } else {
          // ── AiderStyleParser path (MiMo) ────────────────────
          const skipParsing = this.options.skipToolParsing ?? false;
          if (!skipParsing) {
            this.streamAiderParser.reset();
          }

          for await (const chunk of stream) {
            if (this._aborted || this.isTerminalState()) break;

            if (chunk.type === 'text') {
              fullResponse += chunk.content;

              if (!skipParsing) {
                const aiderEvents = this.streamAiderParser.feed(chunk.content);
                for (const event of aiderEvents) {
                  if (event.type === 'text') {
                    streamTextOnly += event.content;
                    this.emit('streamText', event.content);
                  } else if (event.type === 'tool_summary') {
                    this.emit('streamToolSummary', event.content);
                  } else if (event.type === 'tool_call_start') {
                    this.emit('toolCallStart');
                  } else if (event.type === 'tool_call' && event.toolCall) {
                    toolCalls.push(event.toolCall);
                    this.emit('toolCallParsed', event.toolCall);
                  } else if (event.type === 'tool_call_end') {
                    this.emit('toolCallEnd', event.content, event.toolCall);
                  }
                }
              } else {
                this.emit('streamText', chunk.content);
              }
            } else if (chunk.type === 'thinking') {
              this.emit('streamThinking', chunk.content);
            } else if (chunk.type === 'error') {
              this.consecutiveErrors++;
              iterationStatus = 'error';
              iterationErrorMessage = chunk.content;
              this.setState('error');
              this.emit('error', new Error(chunk.content));
              this.emit('streamText', `❌ LLM Error: ${chunk.content}`);
              return;
            } else if (chunk.type === 'done') {
              break;
            }
          }

          if (this._aborted) break;

          if (!skipParsing) {
            const flushEvents = this.streamAiderParser.flush();
            for (const event of flushEvents) {
              if (event.type === 'text') {
                streamTextOnly += event.content;
                this.emit('streamText', event.content);
              } else if (event.type === 'tool_summary') {
                this.emit('streamToolSummary', event.content);
              } else if (event.type === 'tool_call_start') {
                this.emit('toolCallStart');
              } else if (event.type === 'tool_call' && event.toolCall) {
                toolCalls.push(event.toolCall);
                this.emit('toolCallParsed', event.toolCall);
              } else if (event.type === 'tool_call_end') {
                this.emit('toolCallEnd', event.content, event.toolCall);
              }
            }
          }

          // If streaming parse did not find anything, retry once on the full response
          if (!skipParsing && toolCalls.length === 0 && fullResponse.length > 0) {
            const aiderCalls = extractAiderBlocks(fullResponse, { toolRegistry: this.options.toolRegistry });
            if (aiderCalls.length > 0) {
              console.log(`[ReActLoop] Full-text parser found ${aiderCalls.length} tool call(s)`);
              for (const tc of aiderCalls) {
                toolCalls.push(tc);
                this.emit('toolCallParsed', tc);
              }
            }
          }
        }

        if (this._aborted) {
          iterationStatus = 'aborted';
          break;
        }

        // Emit context usage snapshot for compression-aware adapters (OpenAI/DevEco/Cline).
        this.emitContextUpdate();

        // Auto-compress conversation history when context usage exceeds threshold.
        // Uses LLM-driven summarization (same as Designer view's auto-compaction).
        if (useNativeTools && this.iterationCount > 1) {
          await this.tryAutoCompress();
        }

        // Clear context manager (tool results from previous iteration no longer needed here;
        // for OpenAI path the adapter manages history separately).
        this.options.contextManager.clear();

        console.log(`[ReActLoop] Iteration ${this.iterationCount}: fullResponse=${fullResponse.length} chars, streamTextOnly=${streamTextOnly.length} chars, toolCalls=${toolCalls.length}`);
        if (toolCalls.length > 0) {
          for (const tc of toolCalls) {
            console.log(`[ReActLoop] Tool call: name="${tc.name}", params=${JSON.stringify(tc.parameters).substring(0, 200)}`);
          }
        }
        if (fullResponse.length > 0 && fullResponse.length < 500) {
          console.log(`[ReActLoop] Full response: "${fullResponse}"`);
        }

        const validToolCalls: ParsedToolCall[] = [];
        const parseErrors: string[] = [];

        for (const tc of toolCalls) {
          if (tc.name && tc.name.trim() !== '') {
            validToolCalls.push(tc);
          } else {
            // For native tool calls (rawXml is empty), use a different error format
            const errDetail = tc.rawXml
              ? `Could not extract tool name from: rawXml="${tc.rawXml.substring(0, 300)}", params=${JSON.stringify(tc.parameters).substring(0, 200)}`
              : `Tool call missing name: params=${JSON.stringify(tc.parameters).substring(0, 200)}`;
            console.log(`[ReActLoop] ${errDetail}`);
            parseErrors.push(errDetail);
          }
        }

        if (toolCalls.length === 0 && validToolCalls.length === 0) {
          // No tool calls detected — LLM is done responding
          // For non-OpenAI path, check for block markers (parse error feedback)
          if (!useNativeTools) {
            const hasBlockMarker = fullResponse.includes('++++');
            if (hasBlockMarker) {
              const feedback = [
                '[Tool Result] tool_call_parse_error - 失败',
                'Error: Your command block was detected but could not be parsed. Common issues:',
                '- Missing ==== separator in replace_in_file (search text goes ABOVE ====, replacement text goes BELOW)',
                '- Incomplete block (missing closing marker ++++ end)',
                '- Header must use ++++ tool_name key:value format',
                '',
                'Correct format for replace_in_file:',
                '++++ replace_in_file path:./src/app.ts',
                'exact old code to find',
                '====',
                'new code to replace with',
                '++++ end',
                '',
                'Correct format for grep_search:',
                '++++ grep_search path:src pattern:TODO context:3',
                '++++ end',
                '',
                'Please retry with the correct format.',
              ].join('\n');

              console.log('[ReActLoop] Detected block markers but no tool calls parsed, feeding error back to AI');
              this.options.contextManager.addMessage({
                role: 'tool',
                content: feedback,
                timestamp: Date.now(),
                toolName: 'tool_call_parser',
                toolResult: { toolName: 'tool_call_parser', success: false, output: feedback, error: feedback }
              });

              this.consecutiveErrors++;
              if (this.consecutiveErrors >= this.MAX_CONSECUTIVE_ERRORS) {
                this.setState('error');
                this.emit('error', new Error('Too many consecutive parse failures'));
                return;
              }

              continue;
            }

            // ── MiMo format compensation: detect <tool_call> tag with known command names ──
            // MiMo occasionally emits <tool_call>...</tool_call> instead of the ++++ format.
            // When no tool calls and no ++++ marker are found, check if MiMo intended to
            // call a tool by looking for <tool_call> + a known command name. If found,
            // feed back the correct ++++ format and let MiMo retry.
            if (fullResponse.includes('<tool_call')) {
              const knownToolNames = this.options.toolRegistry.getToolNames();
              const matchedToolName = knownToolNames.find(name => {
                const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                return new RegExp(`\\b${escaped}\\b`).test(fullResponse);
              });
              if (matchedToolName) {
                const feedback = [
                  'Error: You used <tool_call> tag but the correct command format uses ++++ to start commands.',
                  '',
                  `Detected intended command: ${matchedToolName}`,
                  'Correct format:',
                  `++++ ${matchedToolName}`,
                  '++++ end',
                  '',
                  'Please retry with the correct format using ++++.',
                ].join('\n');

                console.log(`[ReActLoop] Detected <tool_call> with command "${matchedToolName}", feeding format correction back to AI`);
                this.options.contextManager.addMessage({
                  role: 'tool',
                  content: feedback,
                  timestamp: Date.now(),
                  toolName: 'format_correction',
                  toolResult: { toolName: 'format_correction', success: false, output: feedback, error: feedback }
                });

                this.consecutiveErrors++;
                if (this.consecutiveErrors >= this.MAX_CONSECUTIVE_ERRORS) {
                  this.setState('error');
                  this.emit('error', new Error('Too many consecutive format correction failures'));
                  return;
                }

                continue;
              }
            }

          }

          this.consecutiveErrors = 0;
          this.setState('completed');
          this.emit('completed');
          return;
        }

        if (validToolCalls.length === 0 && parseErrors.length > 0) {
          // All tool calls were invalid — only for AiderStyleParser path
          if (!useNativeTools) {
            const feedback = [
              '[Tool Result] tool_call_parse_error - 失败',
              'Error: The tool call format was invalid. Please use the correct format:',
              '',
              'To edit a file:',
              '++++ replace_in_file path:./src/app.ts',
              'exact old code to find',
              '====',
              'new code to replace with',
              '++++ end',
              '',
              'To create a new file:',
              '++++ write_to_file path:./src/app.ts',
              'file content here',
              '++++ end',
              '',
              'To execute a command:',
              '++++ execute_command',
              'npm test',
              '++++ end',
              '',
              'To search file contents:',
              '++++ grep_search path:src pattern:TODO context:3',
              '++++ end',
              '',
              `Parse errors encountered: ${parseErrors.join('; ')}`,
              'Please retry with the correct format.',
            ].join('\n');

            console.log('[ReActLoop] Feeding parse error back to AI for self-correction');
            this.options.contextManager.addMessage({
              role: 'tool',
              content: feedback,
              timestamp: Date.now(),
              toolName: 'tool_call_parser',
              toolResult: { toolName: 'tool_call_parser', success: false, output: feedback, error: feedback }
            });
          }

          this.consecutiveErrors++;
          if (this.consecutiveErrors >= this.MAX_CONSECUTIVE_ERRORS) {
            this.setState('error');
            this.emit('error', new Error('Too many consecutive parse failures'));
            return;
          }

          continue;
        }

        this.setState('acting');

        for (const toolCall of validToolCalls) {
          if (this._aborted || this.isTerminalState()) break;

          const result = await this.executeToolCall(toolCall);

          this.setState('observing');

          const resultMessage = this.formatToolResult(toolCall, result);
          // For OpenAI: add to adapter history via context manager
          // For others: add to context manager (cleared at next iteration start)
          this.options.contextManager.addMessage(resultMessage);

          this.emit('toolResult', { toolCall, result });
        }

        this.consecutiveErrors = 0;

      } catch (error) {
        if (this._aborted) {
          iterationStatus = 'aborted';
          break;
        }

        iterationStatus = 'error';
        iterationErrorMessage = String(error);
        this.consecutiveErrors++;
        const errMsg = String(error);
        this.emit('streamText', `\n\n❌ Internal error: ${errMsg}`);
        this.emit('loopError', error);

        if (this.consecutiveErrors >= this.MAX_CONSECUTIVE_ERRORS) {
          this.setState('error');
          this.emit('error', error);
          return;
        }
      }
    }

    if (this._aborted) {
      this.setState('idle');
      return;
    }

    if (this.iterationCount >= (this.options.maxIterations ?? 9999)) {
      this.setState('error');
      this.emit('error', new Error('Max iterations reached'));
    }
  }

  // ── Tool definition conversion (ToolDefinition → OpenAI function calling) ────

  private convertToolDefinitions(tools: ToolDefinition[]): unknown[] {
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

  private async executeToolCall(toolCall: ParsedToolCall): Promise<ToolResult> {
    const tool = this.options.toolRegistry.get(toolCall.name);

    if (!tool) {
      return {
        toolName: toolCall.name,
        success: false,
        output: `Unknown tool: ${toolCall.name}`,
        error: `Tool "${toolCall.name}" is not registered. Available tools: ${this.options.toolRegistry.getAll().map(t => t.definition.name).join(', ')}`
      };
    }

    const params = toolCall.parameters as Record<string, unknown>;

    if (this.options.confirmationManager.needsConfirmation(toolCall.name, params)) {
      this.setState('waiting_confirmation');

      const request: ConfirmationRequest = {
        toolName: toolCall.name,
        description: `Execute tool: ${toolCall.name}`,
        parameters: params,
        riskLevel: tool.definition.confirmationRequired ? 'medium' : 'low'
      };

      this.emit('confirmationNeeded', request);

      const response = await this.options.confirmationManager.requestConfirmation(request);

      if (response === 'deny') {
        return {
          toolName: toolCall.name,
          success: false,
          output: 'User denied the operation',
          error: 'Operation denied by user'
        };
      }
    }

    this.emit('toolExecuting', { name: toolCall.name, params });

    const startTime = Date.now();
    try {
      // Pass the abort signal to the tool so it can cancel long-running operations
      const signal = this.abortController?.signal;
      const result = await tool.execute(params, signal);
      result.executionTime = Date.now() - startTime;
      return result;
    } catch (error) {
      return {
        toolName: toolCall.name,
        success: false,
        output: String(error),
        error: String(error),
        executionTime: Date.now() - startTime
      };
    }
  }

  private formatToolResult(toolCall: ParsedToolCall, result: ToolResult): Message {
    const status = result.success ? '成功' : '⛔ 失败';
    let content = `[Tool Result] ${toolCall.name} - ${status}\n`;

    if (toolCall.name === 'write_to_file' || toolCall.name === 'replace_in_file') {
      const filePath = toolCall.parameters['path'] || '';
      content += `File: ${filePath}\n`;
    } else if (toolCall.name === 'execute_command') {
      content += `Command: ${toolCall.parameters['command'] || ''}\n`;
    } else if (toolCall.name === 'read_file') {
      content += `File: ${toolCall.parameters['path'] || ''}\n`;
    } else if (toolCall.name === 'list_files') {
      content += `Path: ${toolCall.parameters['path'] || ''}\n`;
    } else if (toolCall.name === 'grep_search') {
      content += `Path: ${toolCall.parameters['path'] || ''}, Pattern: ${toolCall.parameters['pattern'] || ''}\n`;
    } else if (toolCall.name === 'tool_search') {
      content += `Query: ${toolCall.parameters['query'] || ''}\n`;
    }

    if (result.executionTime) {
      content += `Time: ${result.executionTime}ms\n`;
    }

    if (!result.success) {
      // Prominent error block that the AI cannot ignore
      content += `\n`;
      content += `⛔ ERROR: ${toolCall.name} FAILED!\n`;
      content += `${result.error || result.output}\n`;
    } else {
      // 统一 90KB 阈值。BaseTool.execute() 已在源头截断，正常情况下此处不会
      // 再触发；保留同等阈值作为兜底，防止绕过 BaseTool 的结果膨胀上下文。
      const maxOutputLength = TOOL_OUTPUT_MAX_CHARS;
      if (result.output.length > maxOutputLength) {
        content += `Output (truncated, ${result.output.length} chars total):\n${result.output.substring(0, maxOutputLength)}\n... [truncated ${result.output.length - maxOutputLength} chars]`;
      } else {
        content += `Output:\n${result.output}`;
      }
    }

    return {
      role: 'tool',
      content,
      timestamp: Date.now(),
      toolName: toolCall.name,
      toolResult: result
    };
  }

  abort(): void {
    this._aborted = true;
    if (this.abortController) {
      this.abortController.abort();
    }
    this.setState('idle');
    this.emit('aborted');
  }
}
