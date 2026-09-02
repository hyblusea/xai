/**
 * Local conversation persistence triggers (OpenAI / DevEco / Cline / Freebuff).
 *
 * These stateless providers keep no server-side history, so the Code view
 * persists conversations to local JSON files via ConversationStore. The actual
 * disk write happens in the 'local-conversation:save' IPC handler
 * (ipc/llm-handlers.ts); this module only decides WHEN to ask the renderer for
 * a snapshot of its displayMessages.
 *
 * Save triggers:
 *   - 'completed'  : every successfully finished turn (immediate).
 *   - 'error'      : LLM request failed (e.g. HTTP 429) — the loop terminates
 *                    early and 'completed' never fires, so we save here instead.
 *   - 'loopError'  : internal iteration error (e.g. mid-stream connection drop).
 *   - 'aborted'    : user stopped the generation.
 *   - IPC error paths: agent init failure / freebuff session unavailable /
 *                    unexpected throw in reactLoop.run().
 *
 * The delayed triggers (error/loopError/aborted) wait briefly so the renderer
 * can flush the final AgentError / stream chunks into its messagesRef mirror
 * before it snapshots displayMessages — without the delay the error bubble or
 * the last partial output could be missing from the saved file.
 */
import { IPCChannel } from '@xai/shared';
import type { AppState } from '../app-state.js';
import type { AdapterState, CompressionInfo } from '../conversation-store.js';

/** Providers whose APIs are stateless → conversations are persisted locally. */
export const LOCAL_PERSISTENCE_PROVIDERS: readonly string[] = ['openai', 'deveco', 'cline', 'freebuff'];

export function isLocalPersistenceProvider(provider: string): boolean {
  return LOCAL_PERSISTENCE_PROVIDERS.includes(provider);
}

/**
 * Pre-captured conversation snapshot taken by the main process right before an
 * agent teardown (mid-run provider/model switch). Passed through the renderer
 * round-trip so the save handler can write the OLD provider's adapter state
 * even though the current adapter has already been re-created by then.
 */
export interface CapturedConversationState {
  provider: string;
  model: string;
  conversationId: string;
  adapterState: AdapterState;
  compressionInfo: CompressionInfo;
}

export interface RequestLocalSaveOptions {
  /** Wait before requesting the snapshot, so the renderer has flushed the final
   *  stream/error chunks into its messagesRef mirror. Default 0 (immediate). */
  delayMs?: number;
  /** Conversation title to save (falls back to the current session title). */
  title?: string;
  /**
   * Pre-captured adapter state (e.g. from the old provider before a switch).
   * When present the provider guard is skipped (the caller already validated
   * it) and the save handler uses this snapshot instead of pulling state from
   * the current adapter.
   */
  capturedState?: CapturedConversationState;
}

/**
 * Ask the renderer to persist the current Code-view conversation.
 * The renderer replies with its displayMessages; the main process pulls
 * adapterState from the adapter and writes both layers to disk.
 *
 * No-op for providers that are not in LOCAL_PERSISTENCE_PROVIDERS (they use
 * server-side history and never persist locally) — unless `capturedState` is
 * provided, in which case the provider decision was already made by the caller.
 */
export function requestLocalConversationSave(state: AppState, opts?: RequestLocalSaveOptions): void {
  if (!opts?.capturedState && !isLocalPersistenceProvider(state.sessionConfig.llm.provider)) return;

  const { delayMs = 0, title, capturedState } = opts ?? {};
  const send = (): void => {
    state.sendToRenderer(IPCChannel.LocalConversationRequestSave, {
      title: title ?? state.currentSessionTitle,
      ...(capturedState ? { capturedState } : {}),
    });
  };

  if (delayMs > 0) {
    setTimeout(send, delayMs);
  } else {
    send();
  }
}
