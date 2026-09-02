/**
 * Agent initialization — creates adapters, tool registry, ReActLoop, and binds events.
 */
import { ipcMain, session } from 'electron';
import { watch } from 'fs';
import { IPCChannel } from '@xai/shared';
import { ReActLoop, LLMRouter, ConfirmationManager, ContextManager, MCPManager, ToolRegistry, createDefaultRegistry } from '@xai/core';
import { applyProxyConfig, applyUndiciProxyDispatcher } from '../proxy-manager.js';
import { bindAgentEvents } from './events.js';
import { handleBrowserChannel } from './browser-routing.js';
import { fetchHtmlViaBrowser } from '../web-search-via-browser.js';
import type { AppState } from '../app-state.js';

export interface InitializeAgentOptions {
  /** When true, preserve currentMessages (used during cross-adapter context migration
   *  so the renderer's chat history is not cleared). Default: false. */
  preserveMessages?: boolean;
}

export async function initializeAgent(state: AppState, options?: InitializeAgentOptions): Promise<void> {
  if (state.reactLoop) {
    try {
      state.reactLoop.abort();
    } catch {}
    state.reactLoop.removeAllListeners();
    state.reactLoop = null;
  }

  if (!options?.preserveMessages) {
    state.currentMessages = [];
  }

  try {
    const provider = state.sessionConfig.llm.provider || 'mimo';
    const cookies = state.sessionConfig.llm.cookies || '';
    const apiKey = state.sessionConfig.llm.apiKey || '';
    state.logToRenderer('info', `Initializing agent: provider=${provider}, cookies=${cookies.length > 0 ? 'yes' : 'no'}, apiKey=${apiKey.length > 0 ? 'yes' : 'no'}, workspace=${state.sessionConfig.workspace}`);

    // Create a fresh LLMRouter
    const llmRouter = new LLMRouter();
    state.currentLLMRouter = llmRouter;
    state.adapterManager.setLLMRouter(llmRouter);

    // Apply proxy before adapter init
    llmRouter.setProxyConfig(state.sessionConfig.proxy || null);
    await applyUndiciProxyDispatcher(state.sessionConfig.proxy);
    if (state.sessionConfig.proxy) {
      applyProxyConfig(state.sessionConfig.proxy);
    }

    // Only create the adapter for the current provider
    await state.adapterManager.createAdapterForProvider(provider, state.sessionConfig, llmRouter);
    console.log(`[Main] Adapter initialized for provider: ${provider}`);

    state.toolRegistry = createDefaultRegistry(state.sessionConfig.workspace, {
      onCommandOutput: (commandId: string, outputType: 'stdout' | 'stderr', data: string) => {
        state.sendToRenderer(IPCChannel.CommandOutput, {
          commandId,
          outputType,
          data,
          command: state.currentCommandInfo?.command || 'unknown'
        });
      },
      proxyConfig: state.sessionConfig.proxy,
      terminalSessionManager: state.terminalSessionManager ?? undefined,
      webSearchConfig: state.sessionConfig.webSearch,
      webFetchConfig: state.sessionConfig.webFetch,
      browserFetcher: fetchHtmlViaBrowser,
      ipcSend: async (channel: string, data: unknown) => {
        if (channel === 'web:captcha-detected') {
          state.sendToRenderer(IPCChannel.WebCaptchaDetected, data);
          return new Promise((resolve) => {
            const handler = async (_event: unknown, result: { resolved: boolean }) => {
              ipcMain.removeListener(IPCChannel.WebCaptchaResolved, handler);
              if (result?.resolved) {
                try {
                  const { url } = data as { url: string };
                  const parsedUrl = new URL(url);
                  const cookies = await session.defaultSession.cookies.get({ domain: parsedUrl.hostname });
                  const cookieStr = cookies.map((c: { name: string; value: string }) => `${c.name}=${c.value}`).join('; ');
                  resolve({ resolved: true, cookie: cookieStr || undefined });
                } catch {
                  resolve({ resolved: true });
                }
              } else {
                resolve(result);
              }
            };
            ipcMain.on(IPCChannel.WebCaptchaResolved, handler);
          });
        }

        // Browser tool calls: route directly to browserSessionManager
        if (state.browserSessionManager && channel.startsWith('browser:')) {
          try {
            return await handleBrowserChannel(channel, data, state.browserSessionManager, state);
          } catch (err: any) {
            return { success: false, error: err.message };
          }
        }

        // Default: forward to renderer via invoke
        return state.mainWindow!.webContents.executeJavaScript('void 0');
      },
    });

    state.confirmationManager = new ConfirmationManager();
    state.confirmationManager.setAutoApproveCommands(state.sessionConfig.autoApproveCommands || []);

    const contextManager = new ContextManager();
    state.mcpManager = new MCPManager();

    state.reactLoop = new ReActLoop({
      llmRouter,
      toolRegistry: state.toolRegistry,
      contextManager,
      confirmationManager: state.confirmationManager,
      llmConfig: state.sessionConfig.llm,
      workspacePath: state.sessionConfig.workspace,
    });

    bindAgentEvents(state.reactLoop, state);

    state.logToRenderer('info', 'Agent initialized successfully');

    const mcpConfigs = state.sessionConfig.mcpServers || [];
    if (mcpConfigs.filter(c => c.enabled).length > 0 && state.toolRegistry) {
      state.mcpManager = new MCPManager();
      state.mcpManager.initialize(mcpConfigs, state.toolRegistry).catch((err) => {
        state.logToRenderer('error', `MCP initialization error: ${String(err)}`);
      });
    }

    startFileWatcher(state);
  } catch (err) {
    console.error('[Agent] Failed to initialize agent:', err);
    state.logToRenderer('error', `Failed to initialize agent: ${String(err)}`);
    state.reactLoop = null;
  }
}

function startFileWatcher(state: AppState): void {
  if (state.fileWatcher) {
    state.fileWatcher.close();
    state.fileWatcher = null;
  }

  if (!state.sessionConfig.workspace) return;

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  state.fileWatcher = watch(state.sessionConfig.workspace, { recursive: true }, (eventType, filename) => {
    if (!filename) return;
    if (filename.includes('node_modules') || filename.includes('.git')) return;
    if (filename.endsWith('.log')) return;

    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      state.sendToRenderer('file:changed', { eventType, filename });
    }, 300);
  });
}
