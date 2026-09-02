/**
 * Session compression for OpenAI-compatible adapters (OpenAI, DevEco).
 *
 * Ported and simplified from MiMo-Code's session compaction system.
 * The original uses a layered
 * strategy (checkpoint rebuild + LLM summary + mechanical pruning); this
 * implementation keeps the core LLM-driven compaction with tail preservation
 * and the chars/4 token heuristic, exposed as a manual action.
 */
import type { LLMConfig } from '@xai/shared';

// ── Token estimation (matches MiMo util/token.ts) ────────────────────────────

const CHARS_PER_TOKEN = 4;

export function estimateTokens(text: string): number {
  return Math.max(0, Math.round((text || '').length / CHARS_PER_TOKEN));
}

// ── Adapter message shape (OpenAI / DevEco compatible) ───────────────────────

export interface AdapterMessage {
  role: string;
  content: string | null;
  /** Native reasoning field — included in token accounting for context window estimation. */
  reasoning_content?: string;
  tool_calls?: Array<{
    id: string;
    type: string;
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

// ── Context window defaults ──────────────────────────────────────────────────

const DEFAULT_CONTEXT_WINDOW = 128_000;

/**
 * Resolve the context window for a provider/model. Honors an explicit
 * `configContextWindow` override, otherwise falls back to model heuristics.
 */
export function getContextWindow(
  provider: string,
  model: string,
  configContextWindow?: number,
): number {
  if (configContextWindow && configContextWindow > 0) return configContextWindow;

  const m = (model || '').toLowerCase();
  if (provider === 'openai') {
    if (m.includes('gpt-4.1')) return 1_000_000;
    if (m.includes('o1') || m.includes('o3') || m.includes('o4')) return 200_000;
    if (m.includes('gpt-4o')) return 128_000;
    if (m.includes('gpt-4') && (m.includes('128k') || m.includes('turbo'))) return 128_000;
    if (m.includes('gpt-3.5')) return 16_000;
    return 128_000;
  }
  if (provider === 'deveco') {
    return 128_000;
  }
  if (provider === 'freebuff') {
    // Freebuff free models — context windows from freebuff-main
    // FREEBUFF_MODEL_CONTEXT_WINDOWS / FREEBUFF_DEFAULT_CONTEXT_WINDOW
    if (m.includes('deepseek-v4-flash') || m.includes('deepseek-v4-pro')) return 1_048_576;
    if (m.includes('minimax-m3')) return 524_288;
    if (m.includes('gpt-5.6-luna')) return 400_000;
    if (m.includes('mimo-v2.5')) return 262_144;
    if (m.includes('glm-5.2')) return 131_072;
    return 131_072;
  }
  if (provider === 'cline') {
    // Cline recommended models — context windows by model family
    // Updated to match OpenRouter model data (context_length / top_provider.context_length)
    // Free models (cline-free/*) and ClinePass models (cline-pass/*)
    if (m.includes('cline-free/') || m.includes('cline-pass/')) return 128_000;
    // Claude Opus 5+ / Sonnet 4.5+ — 1M context
    if (m.includes('claude') && (m.includes('opus-5') || m.includes('opus-4-7') || m.includes('sonnet-4.5') || m.includes('sonnet-4-5') || m.includes('sonnet-4.6') || m.includes('sonnet-4-6'))) return 1_000_000;
    // Other Claude models — 200K context
    if (m.includes('claude')) return 200_000;
    // Gemini models — 1M context
    if (m.includes('gemini')) return 1_000_000;
    // GPT-5 / GPT-4.1 — 1M context
    if (m.includes('gpt-5') || m.includes('gpt-4.1')) return 1_000_000;
    // GPT-4o — 128K context
    if (m.includes('gpt-4o')) return 128_000;
    // OpenAI o-series — 200K context
    if (m.includes('o1') || m.includes('o3') || m.includes('o4')) return 200_000;
    // DeepSeek v4+ / R1 — 1M context
    if (m.includes('deepseek') && (m.includes('v4') || m.includes('r1') || m.includes('reasoner'))) return 1_000_000;
    // Other DeepSeek — 128K
    if (m.includes('deepseek')) return 128_000;
    // Qwen 3.5+ — 1M context
    if (m.includes('qwen') && (m.includes('3.5') || m.includes('3.7'))) return 1_000_000;
    // Other Qwen — 128K
    if (m.includes('qwen')) return 128_000;
    // MiniMax / MiMo — 1M context
    if (m.includes('minimax') || m.includes('mimo')) return 1_000_000;
    // GLM — 128K context
    if (m.includes('glm')) return 128_000;
    // Kimi K2+ — 128K context
    if (m.includes('kimi')) return 128_000;
    // Grok — 200K context
    if (m.includes('grok')) return 200_000;
    return 128_000;
  }
  return DEFAULT_CONTEXT_WINDOW;
}

// ── Usage tracking ───────────────────────────────────────────────────────────

export interface ContextUsage {
  totalTokens: number;
  contextWindow: number;
  usagePercent: number;
  messageCount: number;
}

/** Per-message overhead accounting for role/structural framing in the API request. */
const PER_MESSAGE_OVERHEAD_CHARS = 20;

export function computeUsage(history: AdapterMessage[], contextWindow: number): ContextUsage {
  let totalChars = 0;
  for (const msg of history) {
    if (msg.content) totalChars += msg.content.length;
    if (msg.reasoning_content) totalChars += msg.reasoning_content.length;
    if (msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        totalChars += (tc.function?.name?.length ?? 0) + (tc.function?.arguments?.length ?? 0);
      }
    }
    totalChars += PER_MESSAGE_OVERHEAD_CHARS;
  }
  const totalTokens = Math.round(totalChars / CHARS_PER_TOKEN);
  return {
    totalTokens,
    contextWindow,
    usagePercent:
      contextWindow > 0 ? Math.min(100, Math.round((totalTokens / contextWindow) * 100)) : 0,
    messageCount: history.length,
  };
}

// ── Compaction result ────────────────────────────────────────────────────────

export interface CompactionResult {
  success: boolean;
  error?: string;
  beforeTokens: number;
  afterTokens: number;
  beforeMessages: number;
  afterMessages: number;
  summary?: string;
}

// ── Head / tail split (tail preservation, MiMo's DEFAULT_TAIL_TURNS = 2) ─────

export const DEFAULT_TAIL_TURNS = 2;

/**
 * Split history into `head` (to summarize) and `tail` (preserve verbatim).
 * Tail = the last `tailTurns` user/assistant turn pairs.
 * Walks backward to avoid orphaning tool_call / tool_result pairs.
 */
export function splitHeadTail(
  history: AdapterMessage[],
  tailTurns: number = DEFAULT_TAIL_TURNS,
): { head: AdapterMessage[]; tail: AdapterMessage[] } {
  if (tailTurns <= 0 || history.length === 0) {
    return { head: [...history], tail: [] };
  }

  const userIndices: number[] = [];
  for (let i = 0; i < history.length; i++) {
    if (history[i].role === 'user') userIndices.push(i);
  }

  if (userIndices.length <= tailTurns) {
    // Not enough user turns to summarize — keep everything in the tail.
    return { head: [], tail: [...history] };
  }

  const tailStartUserIdx = userIndices[userIndices.length - tailTurns];
  let tailStart = tailStartUserIdx;

  // Include any preceding tool messages so we don't orphan tool results.
  while (tailStart > 0 && history[tailStart - 1].role === 'tool') {
    tailStart--;
  }
  // Include a preceding assistant message that issued tool_calls.
  while (
    tailStart > 0 &&
    history[tailStart - 1].role === 'assistant' &&
    history[tailStart - 1].tool_calls
  ) {
    tailStart--;
  }

  return {
    head: history.slice(0, tailStart),
    tail: history.slice(tailStart),
  };
}

// ── Compaction prompts (ported from MiMo's compaction.txt + default template) ─

const COMPACTION_SYSTEM_PROMPT = `You are an anchored context summarization assistant for coding sessions.

Summarize only the conversation history you are given. The newest turns may be kept verbatim outside your summary, so focus on the older context that still matters for continuing the work.

Always follow the exact output structure requested by the user prompt. Keep every section, preserve exact file paths and identifiers when known, and prefer terse bullets over paragraphs.

Do not answer the conversation itself. Do not mention that you are summarizing, compacting, or merging context. Respond in the same language as the conversation.`;

const COMPACTION_USER_PROMPT_TEMPLATE = `Summarize the following conversation history. Focus on information needed to continue the work.

When constructing the summary, try to stick to this template:
---
## Goal
[What goal(s) is the user trying to accomplish?]
## Instructions
- [What important instructions did the user give you that are relevant]
- [If there is a plan or spec, include information about it so next agent can continue using it]
## Discoveries
[What notable things were learned during this conversation that would be useful to know when continuing the work]
## Accomplished
[What work has been completed, what work is still in progress, and what work is left?]
## Relevant files / directories
[Construct a structured list of relevant files that have been read, edited, or created that pertain to the task at hand. If all the files in a directory are relevant, include the path to the directory.]
---

Conversation history to summarize:
<conversation>
{CONVERSATION}
</conversation>`;

// Cap the head text we send to the summarizer to avoid blowing the compaction call itself.
const MAX_SUMMARY_INPUT_CHARS = 200_000;

function serializeForSummary(messages: AdapterMessage[]): string {
  const lines: string[] = [];
  for (const m of messages) {
    let content = m.content ?? '';
    // Include reasoning content in the summary input so the summarizer
    // can capture the model's reasoning context (not just the final answer).
    if (m.reasoning_content) {
      content = `[Reasoning]: ${m.reasoning_content}\n[Response]: ${content}`;
    }
    if (m.tool_calls && m.tool_calls.length > 0) {
      content +=
        '\n[Tool calls: ' +
        m.tool_calls.map((tc) => `${tc.function.name}(${tc.function.arguments})`).join('; ') +
        ']';
    }
    if (m.role === 'tool') {
      lines.push(`[Tool Result (${m.tool_call_id ?? ''})]: ${content}`);
    } else {
      lines.push(`[${m.role.toUpperCase()}]: ${content}`);
    }
  }
  return lines.join('\n\n');
}

export interface CompactionRequestOptions {
  url: string;
  headers: Record<string, string>;
  model: string;
  /** Optional override of the summarization model (defaults to the request model). */
  summaryModel?: string;
}

/**
 * Call the LLM to summarize the head messages. Returns the summary text, or
 * null if the LLM produced an empty response. Throws on HTTP/network errors.
 */
export async function performCompaction(
  head: AdapterMessage[],
  _config: LLMConfig,
  options: CompactionRequestOptions,
): Promise<string | null> {
  if (head.length === 0) return null;

  let conversationText = serializeForSummary(head);
  if (conversationText.length > MAX_SUMMARY_INPUT_CHARS) {
    conversationText =
      conversationText.substring(0, MAX_SUMMARY_INPUT_CHARS) + '\n\n[... truncated ...]';
  }

  const userPrompt = COMPACTION_USER_PROMPT_TEMPLATE.replace('{CONVERSATION}', conversationText);

  const body = {
    model: options.summaryModel || options.model,
    messages: [
      { role: 'system', content: COMPACTION_SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
    stream: false,
    temperature: 0.3,
    max_tokens: 4096,
  };

  const response = await fetch(options.url, {
    method: 'POST',
    headers: options.headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(
      `Compaction LLM call failed (${response.status} ${response.statusText}): ${errText.substring(0, 300)}`,
    );
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const summary = data.choices?.[0]?.message?.content ?? '';
  if (!summary.trim()) return null;
  return summary.trim();
}

/**
 * Build the new history after compaction:
 *   [original system message?, compaction user msg, ack assistant msg, ...tail]
 *
 * The compaction user/assistant pair gives the model an anchored summary it
 * can reference when continuing the conversation with the preserved tail.
 */
export function buildCompactedHistory(
  originalHistory: AdapterMessage[],
  summary: string,
  tail: AdapterMessage[],
): AdapterMessage[] {
  const newHistory: AdapterMessage[] = [];

  const systemMsg = originalHistory.find((m) => m.role === 'system');
  if (systemMsg) {
    newHistory.push({ ...systemMsg });
  }

  newHistory.push({
    role: 'user',
    content: `Summary of previous conversation:\n\n${summary}`,
  });
  newHistory.push({
    role: 'assistant',
    content:
      'Understood. I have the summary of our previous conversation and will continue from here.',
  });

  for (const m of tail) {
    newHistory.push({ ...m });
  }

  return newHistory;
}

/**
 * Rebuild the pending tool_call_id queue from a (possibly compacted) history.
 * The queue should contain only tool_call_ids from assistant messages that do
 * NOT yet have a matching tool message in the history.
 */
export function rebuildPendingToolCallIds(history: AdapterMessage[]): string[] {
  const consumed = new Set<string>();
  for (const m of history) {
    if (m.role === 'tool' && m.tool_call_id) {
      consumed.add(m.tool_call_id);
    }
  }
  const queue: string[] = [];
  for (const m of history) {
    if (m.role === 'assistant' && m.tool_calls) {
      for (const tc of m.tool_calls) {
        if (!consumed.has(tc.id)) {
          queue.push(tc.id);
        }
      }
    }
  }
  return queue;
}
