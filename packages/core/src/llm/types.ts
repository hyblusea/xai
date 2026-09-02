import type { Message, LLMConfig, StreamChunk } from '@xai/shared';
import type { ContextUsage, CompactionResult } from './session-compressor.js';

export interface HttpRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
  conversationId?: string;
  tools?: unknown[];
}

/**
 * Migratable session snapshot for cross-adapter context preservation.
 *
 * OpenAI / DevEco / Cline adapters all use the same OpenAI-compatible
 * message format, so a snapshot taken from one can be imported into another
 * when the user switches providers in the Code view — keeping the
 * conversation context alive across provider changes.
 */
export interface MigratableSnapshot {
  history: Array<{
    role: string;
    content: string | null;
    /** Native reasoning field — preserved across adapter migrations so that
     *  reasoning context survives provider switches (e.g. Cline → Freebuff). */
    reasoning_content?: string;
    tool_calls?: Array<{
      id: string;
      type: string;
      function: { name: string; arguments: string };
    }>;
    tool_call_id?: string;
  }>;
  pendingToolCallIds: string[];
}

export interface LLMAdapter {
  /** When true, the adapter handles tool calls via the provider's native API (e.g. OpenAI function calling). */
  supportsNativeTools?: boolean;

  translateInput(messages: Message[], config: LLMConfig): Promise<HttpRequest>;
  translateOutput(response: unknown): Message;
  translateStream(stream: AsyncIterable<Buffer>): AsyncIterable<StreamChunk>;
  abort(): void;

  // ── Session compression (optional; implemented by OpenAI/DevEco adapters) ──

  /** When true, the adapter exposes getContextUsage / compressHistory. */
  supportsCompression?: boolean;
  /** Return current context usage for the active session. */
  getContextUsage?(config: LLMConfig): ContextUsage;
  /** Manually compact the adapter's conversation history. */
  compressHistory?(config: LLMConfig): Promise<CompactionResult>;

  // ── Cross-adapter context migration (optional) ──

  /** Export the current session as a migratable snapshot. */
  exportSnapshot?(): MigratableSnapshot;
  /** Import a migratable snapshot into this adapter, replacing its session state. */
  importSnapshot?(snapshot: MigratableSnapshot): void;

  // ── Local conversation persistence (optional; OpenAI/DevEco/Cline) ──

  /** Get the current stable conversation ID (generated per session, regenerated on reset). */
  readonly conversationId?: string;
  /** Get serializable adapter state for local saving (history + pending tool-call IDs). */
  getAdapterState?(): { conversationHistory: unknown[]; pendingToolCallIds: string[] };
  /** Restore adapter state from a locally saved snapshot. */
  setAdapterState?(state: { conversationHistory: unknown[]; pendingToolCallIds: string[] }): void;
  /**
   * Restore the conversation ID after loading a locally saved conversation, so
   * subsequent saves update the same file instead of creating a duplicate.
   * Called together with setAdapterState / importSnapshot on load.
   */
  setConversationId?(conversationId: string): void;
  /** Get compression info (whether history has been compacted, and the summary if so). */
  getCompressionInfo?(): { isCompressed: boolean; summary: string | null };
}
