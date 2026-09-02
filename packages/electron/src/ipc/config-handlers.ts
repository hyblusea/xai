/**
 * Config IPC handlers.
 */
import { ipcMain, app } from 'electron';
import { IPCChannel } from '@xai/shared';
import type { SessionConfig } from '@xai/shared';
import type { MigratableSnapshot } from '@xai/core';
import { applyProxyConfig, applyUndiciProxyDispatcher } from '../proxy-manager.js';
import type { IpcDeps } from './types.js';
import { requestLocalConversationSave, isLocalPersistenceProvider } from '../agent/persist.js';
import type { CapturedConversationState } from '../agent/persist.js';
import type { AdapterState } from '../conversation-store.js';

/**
 * Prepare a migratable snapshot for cross-adapter context preservation.
 *
 * When switching between OpenAI / DevEco / Cline (all OpenAI-compatible),
 * we can carry the conversation history forward so the user doesn't lose
 * context. This function:
 *   1. Exports the snapshot from the old adapter
 *   2. Filters out the system prompt (it will be re-injected by ReActLoop
 *      on the next run, and the old system prompt may contain provider-specific
 *      tool definitions that don't apply to the new provider)
 *   3. Strips incomplete tool-call sequences: if there are pending tool_call_ids
 *      (meaning the last assistant message issued tool_calls but the tool results
 *      haven't been submitted yet), we remove the trailing assistant tool_calls
 *      and the pending IDs to avoid a malformed conversation state in the new adapter.
 */
function prepareMigratedSnapshot(snapshot: MigratableSnapshot): MigratableSnapshot {
  // Filter out system messages — ReActLoop will re-inject the correct one
  let history = snapshot.history.filter(m => m.role !== 'system');

  // Strip incomplete tool-call sequences at the tail.
  // If there are pending tool_call_ids, the last assistant message with
  // tool_calls is "open" (no tool result yet). Removing it prevents the
  // new adapter from sending orphaned tool_calls that the new model can't
  // resolve.
  let pendingIds = [...snapshot.pendingToolCallIds];
  if (pendingIds.length > 0) {
    // Walk backward and remove trailing tool messages + the assistant message
    // that issued the unmatched tool_calls.
    while (history.length > 0) {
      const last = history[history.length - 1];
      if (last.role === 'tool' && pendingIds.length > 0) {
        // Remove trailing tool result that matches a pending ID
        history.pop();
        pendingIds.shift();
      } else if (last.role === 'assistant' && last.tool_calls && last.tool_calls.length > 0) {
        // This is the assistant message that issued the tool_calls.
        // If it has ONLY tool_calls (no text content), remove it entirely.
        // If it also has text content, keep it but strip the tool_calls.
        if (last.content && last.content.trim().length > 0) {
          // Keep the text, remove tool_calls
          const { tool_calls: _tc, ...rest } = last;
          history[history.length - 1] = rest as typeof last;
        } else {
          history.pop();
        }
        break;
      } else {
        break;
      }
    }
    // Clear remaining pending IDs
    pendingIds = [];
  }

  return { history, pendingToolCallIds: pendingIds };
}

export function registerConfigHandlers(deps: IpcDeps): void {
  ipcMain.handle(IPCChannel.ConfigGet, async () => {
    return deps.sessionConfig;
  });

  ipcMain.handle(IPCChannel.ConfigSet, async (_event, config: Partial<SessionConfig>) => {
    const oldLLM = { ...deps.sessionConfig.llm };
    const oldProxy = { ...deps.sessionConfig.proxy };
    // Merge config while preserving the llm object reference so that
    // ReActLoop.options.llmConfig (which points to the same object) sees updates.
    const { llm: incomingLlm, ...restConfig } = config as Partial<SessionConfig> & { llm?: Partial<SessionConfig['llm']> };
    Object.assign(deps.sessionConfig, restConfig);
    if (incomingLlm) {
      Object.assign(deps.sessionConfig.llm, incomingLlm);
    }
    const { configManager } = await import('../config.js');
    await configManager.saveConfig(deps.sessionConfig);

    const newLLM = config.llm || deps.sessionConfig.llm;
    // Only detect changes that require adapter re-creation.
    // Model / maxTokens / temperature are passed to the adapter at request time
    // and do NOT require re-instantiation.
    const providerChanged = !!newLLM && newLLM.provider !== oldLLM.provider;
    const adapterConfigChanged = !!newLLM && (
      newLLM.cookies !== oldLLM.cookies ||
      newLLM.apiKey !== oldLLM.apiKey ||
      newLLM.botId !== oldLLM.botId ||
      newLLM.baseUrl !== oldLLM.baseUrl
    );
    const llmChanged = providerChanged || adapterConfigChanged;

    const proxyChanged = config.proxy && (
      config.proxy.enabled !== oldProxy.enabled ||
      config.proxy.server !== oldProxy.server ||
      config.proxy.useSystemProxy !== oldProxy.useSystemProxy ||
      config.proxy.cmdUseProxy !== oldProxy.cmdUseProxy
    );

    const agentReinitialized = llmChanged || proxyChanged;
    if (agentReinitialized) {
      // ── Persist the running conversation before tearing down the agent ──
      // A mid-run provider/model switch would otherwise lose the in-flight
      // partial output: 'completed' never fires and initializeAgent() below
      // removes the loop's listeners, so nothing saves after the switch.
      // sessionConfig already points at the NEW provider here, so we capture
      // the OLD provider's adapter state synchronously and pass it through the
      // renderer round-trip (the save handler then doesn't depend on the
      // post-teardown adapter).
      if (deps.reactLoop && deps.currentMessages.length > 0) {
        let capturedState: CapturedConversationState | undefined;
        const oldProvider = oldLLM.provider;
        if (isLocalPersistenceProvider(oldProvider)) {
          try {
            const oldAdapter = deps.adapterManager.get(oldProvider);
            if (oldAdapter && typeof (oldAdapter as { getAdapterState?: unknown }).getAdapterState === 'function') {
              const a = oldAdapter as {
                getAdapterState: () => AdapterState;
                getCompressionInfo?: () => { isCompressed: boolean; summary: string | null };
                conversationId?: string;
              };
              const ci = a.getCompressionInfo?.() ?? { isCompressed: false, summary: null };
              capturedState = {
                provider: oldProvider,
                model: oldLLM.model,
                conversationId: a.conversationId ?? String(Date.now()),
                adapterState: a.getAdapterState(),
                compressionInfo: {
                  isCompressed: !!ci.isCompressed,
                  originalMessageCount: null,
                  summary: ci.summary ?? null,
                  compressedAt: null,
                },
              };
            }
          } catch (err) {
            console.error('[Config] Failed to capture conversation state before re-init:', err);
            capturedState = undefined;
          }
        }
        // Small delay lets the renderer flush the final streamed chunks into
        // its messagesRef mirror before it snapshots displayMessages.
        requestLocalConversationSave(deps, { delayMs: 150, capturedState });
      }

      // ── Cross-adapter context migration ──
      // When switching between OpenAI / DevEco / Cline, preserve the
      // conversation history so the user doesn't lose context.
      let migratedSnapshot: MigratableSnapshot | null = null;
      let contextMigrated = false;

      if (providerChanged && oldLLM.provider && newLLM?.provider) {
        if (deps.adapterManager.canMigrateContext(oldLLM.provider, newLLM.provider)) {
          // Export from old adapter BEFORE initializeAgent clears it
          const rawSnapshot = deps.adapterManager.exportContext(oldLLM.provider);
          if (rawSnapshot && rawSnapshot.history.length > 0) {
            migratedSnapshot = prepareMigratedSnapshot(rawSnapshot);
            console.log(
              `[Config] Context migration: ${oldLLM.provider} → ${newLLM.provider}, ` +
              `${rawSnapshot.history.length} → ${migratedSnapshot.history.length} messages ` +
              `(filtered system prompt + incomplete tool calls)`,
            );
          }
        }
      }

      deps.titleGenerated = false;
      deps.firstAssistantMessage = '';
      deps.reactLoop = null;
      const { initializeAgent } = await import('../agent/initialize.js');
      await initializeAgent(deps, { preserveMessages: !!migratedSnapshot });

      // Import the migrated context into the new adapter
      if (migratedSnapshot && migratedSnapshot.history.length > 0) {
        const newProvider = newLLM?.provider || deps.sessionConfig.llm.provider;
        contextMigrated = deps.adapterManager.importContext(newProvider, migratedSnapshot);
      }

      if (contextMigrated) {
        // Context was successfully migrated — this is NOT a new session
        deps.isFirstMessageOfSession = false;
        console.log('[Config] Context migration completed — session continues');
      } else {
        // No migration or migration failed — treat as a new session
        deps.isFirstMessageOfSession = true;
        if (migratedSnapshot) {
          console.warn('[Config] Context migration failed — starting new session');
        }
      }
    } else if (config.autoApproveCommands && deps.confirmationManager) {
      deps.confirmationManager.setAutoApproveCommands(deps.sessionConfig.autoApproveCommands || []);
    }

    if (config.proxy) {
      // initializeAgent() already calls applyProxyConfig + applyUndiciProxyDispatcher,
      // so only apply them here when the agent was NOT re-initialized
      if (!agentReinitialized) {
        applyProxyConfig(deps.sessionConfig.proxy);
        await applyUndiciProxyDispatcher(deps.sessionConfig.proxy);
      }
      if (deps.reactLoop) {
        try {
          const opts = (deps.reactLoop as any).options;
          if (opts?.llmRouter) {
            opts.llmRouter.setProxyConfig(deps.sessionConfig.proxy);
          }
          if (opts?.toolRegistry) {
            const execTool = opts.toolRegistry.get('execute_command');
            if (execTool && typeof execTool.setProxyConfig === 'function') {
              execTool.setProxyConfig(deps.sessionConfig.proxy);
            }
          }
        } catch (err) {
          console.error('[Main] Proxy config update failed:', err);
        }
      }
    }

    if (config.mqtt && deps.mqttBridge) {
      try {
        await deps.mqttBridge.updateConfig(config.mqtt);
      } catch (err) {
        console.error('[Main] MQTT config update failed:', err);
      }
    }

    if (config.update) {
      const { applyUpdateConfig } = await import('../auto-updater.js');
      applyUpdateConfig(deps.sessionConfig.update);
    }

    deps.sendToRenderer(IPCChannel.ConfigChanged, deps.sessionConfig);
    return { success: true };
  });

  ipcMain.handle(IPCChannel.ConfigReset, async () => {
    const { configManager } = await import('../config.js');
    deps.sessionConfig = await configManager.resetConfig();
    if (!deps.sessionConfig.workspace || deps.sessionConfig.workspace === process.cwd()) {
      deps.sessionConfig.workspace = app.getPath('home');
    }
    deps.reactLoop = null;
    const { initTerminalSessionManager } = await import('../terminal-manager.js');
    initTerminalSessionManager(deps);
    const { initializeAgent } = await import('../agent/initialize.js');
    await initializeAgent(deps);
    return deps.sessionConfig;
  });
}
