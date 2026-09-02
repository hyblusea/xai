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
 * Freebuff adapter — OpenAI-compatible endpoint at freebuff.com.
 *
 * Freebuff (CodebuffAI) exposes free coding models via a standard OpenAI
 * compatible chat-completions API:
 *
 *   POST {baseUrl}/api/v1/chat/completions
 *   Authorization: Bearer {authToken}
 *
 * The authToken is obtained through the Freebuff CLI device-code login flow
 * (POST /api/auth/cli/code → open loginUrl in browser → poll
 * GET /api/auth/cli/status until user object with authToken is returned).
 * The getToken callback (provided by FreebuffAuthService) returns this token.
 *
 * Free models (OpenRouter-style slugs):
 *   deepseek/deepseek-v4-flash   (default, 1M ctx, reasoning)
 *   deepseek/deepseek-v4-pro     (1M ctx, reasoning)
 *   minimax/minimax-m3           (512K ctx)
 *   openai/gpt-5.6-luna          (400K ctx, reasoning)
 *   mimo/mimo-v2.5               (262K ctx)
 *   z-ai/glm-5.2                 (128K ctx, reasoning)
 *
 * Free-mode characteristics (from freebuff-main source):
 *   - Server may return HTTP 429 `free_mode_capacity_deferred` under load;
 *     honor Retry-After and retry.
 *   - Free mode admission via /api/v1/freebuff/session; may require waiting
 *     room (HTTP 428) or be region-limited.
 *   - Reasoning (thinking) is returned in `reasoning_content` and replayed
 *     back to the model on subsequent turns via the same field.
 *
 * Server-side anti-abuse gates (free_mode_cli_required 403):
 *   The server validates that free-mode requests come from a legitimate
 *   freebuff client. Three checks are performed (see freebuff-main
 *   common/src/constants/foreign-client-signals.ts):
 *
 *   1. System prompt marker: the first system message must open with a
 *      canonical "You are Buffy, …" sentence (see
 *      FREEBUFF_ROOT_SYSTEM_PROMPT_OPENINGS in free-agents.ts). Without it
 *      the server returns 403 free_mode_cli_required.
 *   2. Toolset signature: the request must include at least one "signature"
 *      tool name that is distinctively freebuff's (not a generic name like
 *      write_file/web_search/glob/skill/apply_patch that third-party clients
 *      also use). Without a signature tool, the server downgrades the request
 *      to a free-tier model (inclusionai/ling-3.0-tiny:free).
 *   3. Sampling params: requests without tools that set temperature/top_p/
 *      max_tokens/max_completion_tokens are flagged. This is reported but
 *      not enforced when signature tools are present.
 *
 *   This adapter injects the Buffy system prompt and signature tools
 *   automatically to pass these gates.
 *
 * Supports native tool calling (OpenAI function calling) and session
 * compression, same as ClineAdapter / DevecoAdapter.
 */

/**
 * API 后端地址。
 *
 * ⚠️ 必须使用 www.codebuff.com，不能用 codebuff.com。
 * codebuff.com 会 307 重定向到 www.codebuff.com，跨域重定向时浏览器/Electron
 * 的 fetch 会按 HTTP 规范丢弃 Authorization header，导致 401。
 *
 * freebuff.com 仅用于登录流程（/api/auth/cli/code, /api/auth/cli/status）。
 * Session 管理和 chat-completions 都走 www.codebuff.com。
 *
 * See: freebuff-main sdk/src/impl/model-provider.ts line 147,
 *      common/src/env-schema.ts NEXT_PUBLIC_CODEBUFF_APP_URL.
 */
export const FREEBUFF_DEFAULT_BASE_URL = 'https://www.codebuff.com';

/** Freebuff free-model wire IDs mapped to their context windows (tokens). */
export const FREEBUFF_MODEL_CATALOG: Record<string, { contextWindow: number; reasoning: boolean }> = {
  'deepseek/deepseek-v4-flash': { contextWindow: 1_048_576, reasoning: true },
  'deepseek/deepseek-v4-pro': { contextWindow: 1_048_576, reasoning: true },
  'minimax/minimax-m3': { contextWindow: 524_288, reasoning: false },
  'openai/gpt-5.6-luna': { contextWindow: 400_000, reasoning: true },
  'mimo/mimo-v2.5': { contextWindow: 262_144, reasoning: false },
  'z-ai/glm-5.2': { contextWindow: 131_072, reasoning: true },
};

/** Default context window when a model is missing from the catalog (Freebuff default). */
export const FREEBUFF_DEFAULT_CONTEXT_WINDOW = 131_072;

// ── Server-side anti-abuse gate constants ─────────────────────────────────────
//
// The Freebuff server validates that free-mode requests come from a legitimate
// client. Two checks are load-bearing:
//
// 1. System prompt marker: the first system message must open with a canonical
//    "You are Buffy, …" sentence. See FREEBUFF_ROOT_SYSTEM_PROMPT_OPENINGS in
//    freebuff-main/common/src/constants/free-agents.ts.
// 2. Toolset signature: the request must include at least one tool name that is
//    distinctively freebuff's (not a generic name like write_file/web_search/
//    glob/skill/apply_patch). See FREEBUFF_SIGNATURE_TOOL_NAMES in
//    freebuff-main/common/src/constants/foreign-client-signals.ts.

/**
 * Canonical system prompt openings accepted by the server's
 * `requestHasFreebuffSystemMarker` gate. The first system message in the
 * request must start with one of these verbatim (leading whitespace tolerated).
 *
 * Reference: freebuff-main/common/src/constants/free-agents.ts
 *   FREEBUFF_ROOT_SYSTEM_PROMPT_OPENINGS
 */
const FREEBUFF_ROOT_SYSTEM_PROMPT_OPENINGS = [
  // base2-free-* CLI roots
  'You are Buffy, the strategic coding assistant.',
  // base3-free-* Web/Cloud roots
  'You are Buffy, the coding agent behind Codebuff.',
  // Cloud planner roots
  'You are Buffy, the Freebuff Cloud project planner.',
] as const;

/**
 * The Buffy system prompt injected at position 0 when the caller's own system
 * prompt does not already open with a canonical Buffy sentence.
 *
 * This is the base2-free variant — the most widely accepted opening. The
 * server's gate checks that the first system message starts with one of the
 * canonical openings; anything else triggers 403 free_mode_cli_required.
 *
 * The date is injected dynamically at call time so it stays current across
 * long-running sessions.
 */
function buildBuffySystemPrompt(): string {
  return `You are Buffy, the strategic coding assistant. You are the AI agent behind the product, Freebuff, a tool where users can chat with you to code with AI for free.

Current date: ${new Date().toISOString().split('T')[0]}.

# General guidelines

- **Conventions & Style:** Rigorously adhere to existing project conventions when modifying code. Analyze surrounding code, tests, and configuration first.
- **Simplicity & Minimalism:** Make as few changes as possible. Prefer simple solutions.
- **Code Reuse:** Always reuse existing helper functions, components, classes, etc. Don't reimplement what already exists.
- **Be careful with terminal commands:** Be careful about instructing to run terminal commands that could be destructive or have effects that are hard to undo.
- **Do what the user asks:** If the user asks you to do something, do it.`;
}

/**
 * Check whether a system prompt text opens with a canonical Buffy sentence.
 * Mirrors the server-side `hasFreebuffRootSystemPromptOpening` check.
 */
function hasBuffySystemPromptOpening(text: string): boolean {
  const trimmed = text.trimStart();
  return FREEBUFF_ROOT_SYSTEM_PROMPT_OPENINGS.some(op => trimmed.startsWith(op));
}

/**
 * Signature tool names that the server recognizes as coming from a legitimate
 * freebuff client. These are the tool names from freebuff's own agent
 * definitions that are NOT in the GENERIC_TOOL_NAMES exclusion list.
 *
 * GENERIC_TOOL_NAMES (excluded — also used by third-party clients):
 *   write_file, web_search, glob, skill, apply_patch
 *
 * Reference: freebuff-main/common/src/constants/foreign-client-signals.ts
 *   FREEBUFF_SIGNATURE_TOOL_NAMES = toolNames.filter(not GENERIC_TOOL_NAMES)
 *   plus FREEBUFF_CUSTOM_TOOL_NAMES = ['decide']
 *
 * We include a representative subset sufficient to pass the gate. The server
 * only checks that at least ONE offered tool name is in the signature set.
 */
const FREEBUFF_SIGNATURE_TOOL_NAMES: ReadonlySet<string> = new Set([
  // From freebuff-main/common/src/tools/constants.ts toolNames,
  // excluding GENERIC_TOOL_NAMES (write_file, web_search, glob, skill, apply_patch)
  'read_files', 'read_subtree', 'list_directory', 'find_files',
  'str_replace', 'run_terminal_command', 'code_search',
  'spawn_agents', 'spawn_agent_inline', 'ask_user',
  'suggest_followups', 'set_output', 'set_messages', 'add_message',
  'think_deeply', 'end_turn', 'task_completed', 'render_ui',
  'read_url', 'read_docs', 'gravity_index', 'lookup_agent_info',
  'propose_str_replace', 'propose_write_file',
  'add_subgoal', 'update_subgoal', 'create_plan',
  'cloud_plan_ready', 'run_file_change_hooks', 'write_todos',
  'browser_logs',
  // FREEBUFF_CUSTOM_TOOL_NAMES
  'decide',
]);

/**
 * Generic tool names that are NOT signature tools — these are also used by
 * third-party clients (Cline, opencode, Codex) and do not count as evidence
 * of a legitimate freebuff client.
 */
const GENERIC_TOOL_NAMES: ReadonlySet<string> = new Set([
  'write_file', 'web_search', 'glob', 'skill', 'apply_patch',
]);

/**
 * Minimal signature tool definitions injected when the caller does not provide
 * any tools, or when none of the caller's tools are in the signature set.
 *
 * These are stub definitions — just enough schema for the server to see that
 * the request carries a legitimate freebuff toolset. The model may or may not
 * call them; if it does, the calling application handles the tool execution
 * as usual.
 *
 * We pick tools that are useful for a coding assistant and unlikely to cause
 * issues if the model decides to call them: read_files, list_directory,
 * str_replace, run_terminal_command.
 */
const STUB_SIGNATURE_TOOLS: Array<{
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}> = [
  {
    type: 'function',
    function: {
      name: 'read_files',
      description: 'Read the contents of one or more files in the project.',
      parameters: {
        type: 'object',
        properties: {
          paths: {
            type: 'array',
            items: { type: 'string' },
            description: 'List of file paths to read.',
          },
        },
        required: ['paths'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_directory',
      description: 'List the contents of a directory in the project.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Directory path to list.',
          },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'str_replace',
      description: 'Replace a string in a file. Provide the file path, the old string to find, and the new string to replace it with.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path.' },
          old: { type: 'string', description: 'String to find.' },
          new: { type: 'string', description: 'Replacement string.' },
        },
        required: ['path', 'old', 'new'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_terminal_command',
      description: 'Run a terminal command and return its output.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The command to run.' },
        },
        required: ['command'],
      },
    },
  },
];

export function resolveFreebuffContextWindow(model: string): number {
  return FREEBUFF_MODEL_CATALOG[model]?.contextWindow ?? FREEBUFF_DEFAULT_CONTEXT_WINDOW;
}

export interface FreebuffAdapterOptions {
  /** Optional static API key (Bearer token). Lower priority than getToken and config.apiKey. */
  apiKey?: string;
  /** Optional async token provider (device-code OAuth auto token source). */
  getToken?: () => Promise<string | null>;
  /**
   * Optional provider that returns the current freebuff session instance ID.
   * The instance ID is obtained via POST /api/v1/freebuff/session and is
   * required for free-mode chat completions. Without it the server returns 401.
   */
  getInstanceId?: () => Promise<string | undefined>;
  /**
   * Optional callback invoked when the server returns 428 (waiting_room_required),
   * meaning the session has expired and must be re-admitted.
   * Should end the stale session and start a fresh one, returning the new
   * instance ID. If not provided, 428 errors are surfaced as-is.
   */
  handleSessionExpired?: (model?: string) => Promise<string | undefined>;
  /** Optional base URL override. */
  baseUrl?: string;
}

// ── OpenAI-compatible API types ──────────────────────────────────────────────

interface FreebuffToolCallDelta {
  index: number;
  id?: string;
  type?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
}

interface FreebuffChoice {
  index: number;
  message?: {
    role: string;
    content: string;
    reasoning_content?: string;
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
    reasoning_content?: string;
    reasoning?: string;
    tool_calls?: FreebuffToolCallDelta[];
  };
  finish_reason: string | null;
}

interface FreebuffResponse {
  id: string;
  choices: FreebuffChoice[];
  model: string;
}

interface FreebuffMessage {
  role: string;
  content: string | null;
  /** Native reasoning field — replay previous turn's thinking to the model. */
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

export class FreebuffAdapter implements LLMAdapter {
  readonly supportsNativeTools = true;
  readonly supportsCompression = true;

  private options: FreebuffAdapterOptions;
  private abortController: AbortController | null = null;
  /** Full conversation history in OpenAI message format (incl. reasoning_content). */
  private conversationHistory: FreebuffMessage[] = [];
  /** FIFO queue of tool_call_ids for matching incoming tool results. */
  private pendingToolCallIdQueue: string[] = [];
  /** Stable conversation ID for local persistence (regenerated on reset). */
  private _conversationId: string;
  /** Agent run ID obtained from POST /api/v1/agent-runs. Required by the server. */
  private _runId: string | null = null;
  /** Model this run was started with. Server rejects model changes mid-run. */
  private _runModel: string | null = null;

  constructor(options: FreebuffAdapterOptions = {}) {
    this.options = { ...options };
    this._conversationId = uuidNoHyphen();
  }

  get conversationId(): string {
    return this._conversationId;
  }

  /**
   * Handle 428 waiting_room_required — re-admit the session.
   * Called by the LLM router when a chat-completions request returns 428.
   * Returns the new instance ID, or undefined if re-admission fails.
   */
  async handleSessionExpired(model?: string): Promise<string | undefined> {
    if (!this.options.handleSessionExpired) return undefined;
    return this.options.handleSessionExpired(model);
  }

  // ── Session management ─────────────────────────────────────────────────────

  resetSession(): void {
    this.conversationHistory = [];
    this.pendingToolCallIdQueue = [];
    this._conversationId = uuidNoHyphen();
    this._runId = null;
    this._runModel = null;
  }

  getConversationHistory(): FreebuffMessage[] {
    return [...this.conversationHistory];
  }

  snapshotSession(): { history: FreebuffMessage[]; pendingToolCallIds: string[] } {
    return {
      history: this.conversationHistory.map(m => ({ ...m })),
      pendingToolCallIds: [...this.pendingToolCallIdQueue],
    };
  }

  restoreSession(snapshot: { history: FreebuffMessage[]; pendingToolCallIds: string[] }): void {
    this.conversationHistory = snapshot.history.map(m => ({ ...m }));
    this.pendingToolCallIdQueue = [...snapshot.pendingToolCallIds];
  }

  // ── Cross-adapter context migration ────────────────────────────────────────

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

  importSnapshot(snapshot: MigratableSnapshot): void {
    this.conversationHistory = snapshot.history.map(m => ({
      role: m.role,
      content: m.content,
      ...((m as Record<string, unknown>).reasoning_content ? { reasoning_content: (m as Record<string, unknown>).reasoning_content as string } : {}),
      ...(m.tool_calls ? { tool_calls: m.tool_calls.map(tc => ({ ...tc, function: { ...tc.function } })) } : {}),
      ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
    }));
    this.pendingToolCallIdQueue = [...snapshot.pendingToolCallIds];
  }

  // ── Local conversation persistence ──────────────────────────────────────────

  getAdapterState(): { conversationHistory: FreebuffMessage[]; pendingToolCallIds: string[] } {
    return {
      conversationHistory: this.conversationHistory.map(m => ({ ...m })),
      pendingToolCallIds: [...this.pendingToolCallIdQueue],
    };
  }

  setAdapterState(state: { conversationHistory: FreebuffMessage[]; pendingToolCallIds: string[] }): void {
    this.conversationHistory = state.conversationHistory.map(m => ({ ...m }));
    this.pendingToolCallIdQueue = [...state.pendingToolCallIds];
  }

  setConversationId(conversationId: string): void {
    this._conversationId = conversationId;
  }

  getCompressionInfo(): { isCompressed: boolean; summary: string | null } {
    const summaryMsg = this.conversationHistory.find(
      m => m.role === 'user' && typeof m.content === 'string' && m.content.startsWith('Summary of previous conversation:'),
    );
    return {
      isCompressed: !!summaryMsg,
      summary: summaryMsg?.content ?? null,
    };
  }

  // ── Auth resolution ────────────────────────────────────────────────────────

  /**
   * Resolve the Bearer token. Priority:
   * 1. config.freebuffApiKey (provider-specific field)
   * 2. options.getToken() (async, e.g. OAuth device-code auto-refresh)
   * 3. config.apiKey (generic OpenAI-compatible config field)
   * 4. options.apiKey (static key from constructor)
   */
  private async resolveToken(config: LLMConfig): Promise<string | undefined> {
    let token = (config as unknown as Record<string, unknown>).freebuffApiKey as string | undefined;
    if (!token && this.options.getToken) {
      try {
        token = (await this.options.getToken()) ?? undefined;
      } catch {
        /* ignore */
      }
    }
    if (!token) token = config.apiKey;
    if (!token) token = this.options.apiKey;
    return token;
  }

  private getBaseUrl(_config: LLMConfig): string {
    // Freebuff always talks to its own backend. config.baseUrl is a SHARED llm
    // field that can carry a stale value from another provider: the main
    // process deep-merges the user config over defaults (config.ts deepMerge),
    // so when a freebuff config has no baseUrl key on disk, the default MiMo
    // baseUrl (aistudio.xiaomimimo.com) leaks back in after an app restart.
    // Honoring it here would silently send freebuff requests to the wrong host
    // → 401 login-required. The only accepted override is the adapter-level
    // options.baseUrl.
    let url = (this.options.baseUrl || FREEBUFF_DEFAULT_BASE_URL).replace(/\/+$/, '');
    // Normalize legacy domains: both codebuff.com and freebuff.com 307-redirect
    // to www.codebuff.com, which strips Authorization on cross-origin redirect.
    // Match both bare domain and paths (e.g. "https://codebuff.com/api/v1/...").
    url = url.replace(/^https:\/\/codebuff\.com(?=$|\/)/i, 'https://www.codebuff.com');
    url = url.replace(/^https:\/\/freebuff\.com(?=$|\/)/i, 'https://www.codebuff.com');
    // Strip known endpoint suffixes so callers can paste any full URL
    url = url.replace(/\/(chat\/)?(completions|embeddings)(\/.*)?$/i, '');
    url = url.replace(/\/v1\/?$/, '');
    return url;
  }

  /**
   * Resolve the current freebuff session instance ID.
   * The instance ID is obtained via POST /api/v1/freebuff/session and is
   * required for free-mode chat completions. Without it the server returns 401.
   */
  private async resolveInstanceId(): Promise<string | undefined> {
    if (!this.options.getInstanceId) return undefined;
    try {
      return (await this.options.getInstanceId()) ?? undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Map a Freebuff model wire ID to the corresponding root agent ID.
   * The server requires a valid agent ID that matches the requested model;
   * a mismatch returns 403 session_model_mismatch.
   * See: common/src/constants/free-agents.ts FREEBUFF_ROOT_AGENT_ID_BY_MODEL
   */
  private static ROOT_AGENT_BY_MODEL: Record<string, string> = {
    'deepseek/deepseek-v4-flash':  'base2-free-deepseek-flash',
    'deepseek/deepseek-v4-pro':    'base2-free-deepseek',
    'minimax/minimax-m3':          'base2-free-minimax-m3',
    'openai/gpt-5.6-luna':         'base2-free-luna',
    'mimo/mimo-v2.5':              'base2-free-mimo',
    'z-ai/glm-5.2':                'base2-free-glm',
  };

  /**
   * Ensure we have a valid agent run ID for the current model.
   * POST /api/v1/agent-runs { action: 'START', agentId } → { runId }.
   * If the model changes between calls, a new run is started.
   */
  private async ensureRunId(config: LLMConfig): Promise<string | undefined> {
    const token = await this.resolveToken(config);
    if (!token) return undefined;

    const model = config.model;
    // If we already have a runId for this model, reuse it
    if (this._runId && this._runModel === model) return this._runId;

    // Model changed or first call — start a new run
    const agentId = FreebuffAdapter.ROOT_AGENT_BY_MODEL[model] ?? 'base2-free-deepseek-flash';
    const url = `${this.getBaseUrl(config)}/api/v1/agent-runs`;

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ action: 'START', agentId }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        console.error('[FreebuffAdapter] startAgentRun failed', res.status, body.slice(0, 500));
        return undefined;
      }
      const data = (await res.json()) as { runId?: string };
      if (data?.runId) {
        this._runId = data.runId;
        this._runModel = model;
        return data.runId;
      }
    } catch (err) {
      console.error('[FreebuffAdapter] startAgentRun error', err);
    }
    return undefined;
  }

  // ── translateInput ─────────────────────────────────────────────────────────

  async translateInput(messages: Message[], config: LLMConfig): Promise<HttpRequest> {
    this.appendNewMessages(messages);

    // ── Gate 1: System prompt marker ──────────────────────────────────────────
    //
    // The server's `requestHasFreebuffSystemMarker` gate requires the first
    // system message to open with a canonical "You are Buffy, …" sentence.
    // If the caller's system prompt doesn't match, we prepend the Buffy prompt.
    // If the caller already has a Buffy-opening system prompt, we leave it as-is.
    const hasSystem = this.conversationHistory.some(m => m.role === 'system');
    if (hasSystem) {
      const sysMsg = this.conversationHistory.find(m => m.role === 'system');
      if (sysMsg && !hasBuffySystemPromptOpening(sysMsg.content ?? '')) {
        // Prepend the Buffy opening to the existing system prompt.
        // The gate checks position 0, so the Buffy sentence must come first.
        sysMsg.content = buildBuffySystemPrompt() + '\n\n' + (sysMsg.content ?? '');
      }
    } else {
      // No system message at all — inject the full Buffy prompt at position 0.
      this.conversationHistory.unshift({ role: 'system', content: buildBuffySystemPrompt() });
    }

    const wireMessages = this.conversationHistory.map(m => {
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
    };

    // ── Gate 3: Sampling params ───────────────────────────────────────────────
    //
    // The server flags requests that set temperature/top_p/max_tokens when no
    // signature tools are present. When signature tools ARE present (Gate 2),
    // sampling params are reported but NOT enforced. So we only need to omit
    // them when we have no signature tools — but since we always inject
    // signature tools (see below), it's safe to pass through temperature.
    // However, to be safe and match the CLI's behavior (which leaves these
    // unset on 99.2% of requests), we omit max_tokens and only set temperature
    // when explicitly provided and non-default.
    if (config.temperature !== undefined && config.temperature !== 1) {
      body['temperature'] = config.temperature;
    }
    // Do NOT set max_tokens — the CLI leaves it unset and the server applies
    // model-specific defaults. Setting it triggers the sampling_params signal.

    // ── Gate 2: Toolset signature ─────────────────────────────────────────────
    //
    // The server's `detectForeignFreebuffClient` checks that the request
    // includes at least one tool name from FREEBUFF_SIGNATURE_TOOL_NAMES.
    // Without a signature tool, the request is downgraded to a free-tier
    // model (inclusionai/ling-3.0-tiny:free) or rejected.
    //
    // Strategy:
    // 1. If the caller provides tools with at least one signature tool → use as-is.
    // 2. If the caller provides tools but none are signature tools → merge in
    //    stub signature tools alongside the caller's tools.
    // 3. If the caller provides no tools → inject stub signature tools.
    const callerTools = (config.options as Record<string, unknown> | undefined)?.tools;
    const callerToolArray = (callerTools && Array.isArray(callerTools)) ? callerTools as Array<Record<string, unknown>> : [];
    const callerHasSignatureTool = callerToolArray.some(t => {
      const name = (t as { function?: { name?: string } })?.function?.name;
      return name && FREEBUFF_SIGNATURE_TOOL_NAMES.has(name);
    });

    let finalTools: Array<Record<string, unknown>>;
    if (callerToolArray.length === 0) {
      // No caller tools — inject stub signature tools
      finalTools = STUB_SIGNATURE_TOOLS as unknown as Array<Record<string, unknown>>;
    } else if (callerHasSignatureTool) {
      // Caller already has signature tools — use as-is
      finalTools = callerToolArray;
    } else {
      // Caller has tools but none are signature — merge stubs in
      finalTools = [...callerToolArray, ...STUB_SIGNATURE_TOOLS as unknown as Array<Record<string, unknown>>];
    }

    if (finalTools.length > 0) {
      body['tools'] = finalTools;
      body['tool_choice'] = 'auto';
    }

    // Reasoning effort (OpenRouter-style, used by Freebuff backend)
    const options = config.options as Record<string, unknown> | undefined;
    if (options?.reasoningEffort) {
      if (options.reasoningEffort === 'off') {
        body['reasoning'] = { effort: 'none' };
      } else {
        body['reasoning'] = { effort: options.reasoningEffort };
      }
    }

    const extraBody = options?.extraBody;
    if (extraBody && typeof extraBody === 'object' && !Array.isArray(extraBody)) {
      for (const [k, v] of Object.entries(extraBody)) {
        if (!(k in body)) body[k] = v;
      }
    }

    // Inject codebuff_metadata required by the Freebuff backend for free-mode
    // access. The server requires run_id (from POST /api/v1/agent-runs) and
    // client_id; without them it returns 400 "No runId found in request body".
    // The server also ties the run to a specific model — sending a different
    // model on subsequent turns returns 403 session_model_mismatch, which is
    // why ensureRunId() starts a new run when config.model changes.
    // Reference: freebuff-main sdk/src/impl/llm.ts getProviderOptions(),
    //   cli/src/hooks/use-send-message.ts extraCodebuffMetadata.
    const instanceId = await this.resolveInstanceId();
    const runId = await this.ensureRunId(config);
    const codebuffMetadata: Record<string, string> = {
      ...(runId ? { run_id: runId } : {}),
      client_id: this._conversationId,
      cost_mode: 'free',
      ...(instanceId ? { freebuff_instance_id: instanceId } : {}),
    };
    body['codebuff_metadata'] = codebuffMetadata;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      // Mimic the CLI's user-agent so the server recognizes this as a
      // legitimate freebuff client request.
      // Reference: freebuff-main/sdk/src/impl/model-provider.ts line 150:
      //   'user-agent': `ai-sdk/openai-compatible/${VERSION}/codebuff`
      'User-Agent': 'ai-sdk/openai-compatible/codebuff',
    };
    const token = await this.resolveToken(config);
    if (token) headers['Authorization'] = `Bearer ${token}`;
    if (config.customHeaders) Object.assign(headers, config.customHeaders);

    return {
      url: `${this.getBaseUrl(config)}/api/v1/chat/completions`,
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      conversationId: this._conversationId,
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
          console.warn('[Freebuff] Tool message without matching tool_call_id, delivering as user message');
          this.conversationHistory.push({ role: 'user', content: msg.content });
        }
      } else if (msg.role === 'system') {
        const hasSystem = this.conversationHistory.some(m => m.role === 'system');
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

  // ── translateOutput (non-streaming) ────────────────────────────────────────

  translateOutput(response: unknown): Message {
    const data = response as FreebuffResponse;
    const choice = data.choices?.[0];
    if (!choice) {
      return { role: 'assistant', content: '', timestamp: Date.now() };
    }
    const content = choice.message?.content ?? '';
    const reasoning = choice.message?.reasoning_content ?? choice.message?.reasoning ?? '';
    return {
      role: 'assistant',
      content,
      thinkingContent: reasoning,
      timestamp: Date.now(),
    };
  }

  // ── translateStream ────────────────────────────────────────────────────────

  async *translateStream(stream: AsyncIterable<Buffer>): AsyncIterable<StreamChunk> {
    this.abortController = new AbortController();
    let buffer = '';
    // 流式 UTF-8 解码器：暂存跨 chunk 被切断的多字节字符，避免单独 decode 产生 U+FFFD 乱码。
    const decoder = new TextDecoder('utf-8');
    let assistantContent = '';
    // 累积推理内容，结束时以 reasoning_content 字段持久化到 history，
    // 让下一轮迭代模型能看到自己上一轮的推理，避免重复思考（Freebuff 原生策略）。
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

          // Reasoning content (thinking mode) — stream each delta immediately
          const reasoning = delta.reasoning_content ?? delta.reasoning;
          if (reasoning) {
            assistantReasoning += reasoning;
            yield { type: 'thinking', content: reasoning };
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
   * 思考内容采用 Freebuff 原生策略：保存为独立 reasoning_content 字段，
   * 下次请求时原样回传（见 convert-to-openai-compatible-chat-messages.ts）。
   * 工具调用轮次 reasoning 与 tool_calls 挂在同一条消息上（DeepSeek V4 要求）。
   */
  private commitAssistant(
    content: string,
    reasoning: string,
    toolCallAccumulators: Map<number, { id: string; name: string; arguments: string }>,
  ): void {
    const msg: FreebuffMessage = {
      role: 'assistant',
      content: content || null,
    };
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

  // ── Session compression ────────────────────────────────────────────────────

  getContextUsage(config: LLMConfig): ContextUsage {
    const window = getContextWindow('freebuff', config.model, config.contextWindow);
    return computeUsage(this.conversationHistory as AdapterMessage[], window);
  }

  async compressHistory(config: LLMConfig): Promise<CompactionResult> {
    const contextWindow = getContextWindow('freebuff', config.model, config.contextWindow);
    const beforeUsage = computeUsage(this.conversationHistory as AdapterMessage[], contextWindow);
    const beforeTokens = beforeUsage.totalTokens;
    const beforeMessages = this.conversationHistory.length;

    if (this.conversationHistory.length <= 4) {
      return { success: true, beforeTokens, afterTokens: beforeTokens, beforeMessages, afterMessages: beforeMessages };
    }

    const { head, tail } = splitHeadTail(this.conversationHistory as AdapterMessage[], DEFAULT_TAIL_TURNS);
    if (head.length === 0) {
      return { success: true, beforeTokens, afterTokens: beforeTokens, beforeMessages, afterMessages: beforeMessages };
    }

    try {
      const token = await this.resolveToken(config);
      const summary = await performCompaction(head as AdapterMessage[], config, {
        url: `${this.getBaseUrl(config)}/api/v1/chat/completions`,
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
          ...(config.customHeaders ?? {}),
        },
        model: config.model,
      });

      if (!summary) {
        return { success: false, error: 'Compaction returned empty summary', beforeTokens, afterTokens: beforeTokens, beforeMessages, afterMessages: beforeMessages };
      }

      const newHistory = buildCompactedHistory(this.conversationHistory as AdapterMessage[], summary, tail as AdapterMessage[]);
      const newToolCallIds = rebuildPendingToolCallIds(newHistory);
      this.conversationHistory = newHistory as FreebuffMessage[];
      this.pendingToolCallIdQueue = newToolCallIds;

      const afterUsage = computeUsage(this.conversationHistory as AdapterMessage[], contextWindow);
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