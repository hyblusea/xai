/**
 * Agent IPC handlers.
 */
import { ipcMain } from 'electron';
import { randomUUID } from 'crypto';
import { IPCChannel } from '@xai/shared';
import type { ConfirmationResponse } from '@xai/shared';
import type { IpcDeps } from './types.js';
import { createAiLogContext, submitRawHttpLog } from '../ai-logger.js';
import { freebuffAuthService } from '../freebuff-auth.js';
import { requestLocalConversationSave } from '../agent/persist.js';

export function registerAgentHandlers(deps: IpcDeps): void {
  ipcMain.handle(IPCChannel.AgentStart, async (_event, message: string) => {
    deps.logToRenderer('info', `Received message: "${message.substring(0, 50)}..."`);

    try {
      if (deps.isAgentRunning) {
        deps.logToRenderer('warn', 'Agent is already running, ignoring request');
        return { success: false, error: 'Agent is already running' };
      }

      if (!deps.reactLoop) {
        deps.logToRenderer('info', 'Agent not initialized, initializing now...');
        const { initializeAgent } = await import('../agent/initialize.js');
        await initializeAgent(deps);
      }

      if (!deps.reactLoop) {
        const errMsg = 'Agent failed to initialize. Please check your settings.';
        deps.logToRenderer('error', errMsg);
        deps.sendToRenderer(IPCChannel.AgentError, errMsg);
        deps.sendToRenderer(IPCChannel.AgentCompleted);
        // Persist whatever the renderer already has (the typed user message +
        // error bubble) so it survives a model switch / app restart.
        requestLocalConversationSave(deps, { delayMs: 400 });
        return { success: false, error: errMsg };
      }

      // ── Freebuff: ensure an active free-mode session before chatting ──
      // The Codebuff chat-completions endpoint requires a valid
      // freebuff_instance_id in codebuff_metadata. Without an active
      // session the server returns 401. The official Freebuff CLI
      // manages this via a React hook (use-freebuff-session) that
      // auto-starts and polls; we replicate the essential start-on-send
      // behavior here.
      if (deps.sessionConfig.llm.provider === 'freebuff') {
        const model = deps.sessionConfig.llm.model || 'deepseek/deepseek-v4-flash';
        // Use ensureActiveSession which auto-detects expired sessions and
        // re-admits, instead of only checking getInstanceId() which returns
        // stale instanceIds after the 1-hour TTL expires.
        const sessionResult = await freebuffAuthService.ensureActiveSession(model);
        if (!sessionResult.active) {
          const errMsg = sessionResult.error
            ? `Freebuff session unavailable: ${sessionResult.error}`
            : 'Freebuff session not available. Please try again later.';
          deps.logToRenderer('error', errMsg);
          deps.sendToRenderer(IPCChannel.AgentError, errMsg);
          deps.sendToRenderer(IPCChannel.AgentCompleted);
          requestLocalConversationSave(deps, { delayMs: 400 });
          return { success: false, error: errMsg };
        }
        deps.logToRenderer('info', `Freebuff session active (instance: ${sessionResult.instanceId})`);
      }

      deps.isAgentRunning = true;
      deps.currentMessages.push({ role: 'user', content: message, timestamp: Date.now() });

      // 日志上下文：每次 HTTP LLM 调用完成后由 onRawHttp 回调上报一条原始日志
      const logCtx = createAiLogContext({
        mode: 'code',
        sessionId: randomUUID(),
        provider: deps.sessionConfig.llm.provider,
        model: deps.sessionConfig.llm.model,
      });
      const router = deps.adapterManager.getLLMRouter();
      if (router) {
        router.onRawHttp = (info) => {
          void submitRawHttpLog(deps, logCtx, info);
        };
      }

      const isFirst = deps.isFirstMessageOfSession;
      if (isFirst) {
        deps.firstAssistantMessage = '';
        await deps.adapterManager.saveConversation(deps.sessionConfig);
        deps.isFirstMessageOfSession = false;
      }
      deps.logToRenderer('info', 'Starting agent run...');
      await deps.reactLoop.run(message, { isFirstMessageOfSession: isFirst });
      deps.logToRenderer('info', 'Agent run finished');
      return { success: true };
    } catch (err) {
      const errMsg = String(err);
      deps.logToRenderer('error', `Agent run error: ${errMsg}`);
      deps.sendToRenderer(IPCChannel.AgentError, errMsg);
      deps.sendToRenderer(IPCChannel.AgentCompleted);
      // reactLoop.run() threw — persist the current conversation so nothing is
      // lost on a model switch / app restart.
      requestLocalConversationSave(deps, { delayMs: 400 });
      return { success: false, error: errMsg };
    } finally {
      deps.isAgentRunning = false;
      // run() 内部 finally 已清除 onRawHttp，此处兜底
      const router = deps.adapterManager.getLLMRouter();
      if (router) router.onRawHttp = undefined;
    }
  });

  ipcMain.handle('session:new', async () => {
    deps.adapterManager.resetCurrent(deps.sessionConfig);
    deps.isFirstMessageOfSession = true;
    deps.titleGenerated = false;
    deps.firstAssistantMessage = '';
    deps.reactLoop = null;
    const { initializeAgent } = await import('../agent/initialize.js');
    await initializeAgent(deps);
    return { success: true };
  });

  ipcMain.handle(IPCChannel.AgentStop, async () => {
    deps.reactLoop?.abort();
    return { success: true };
  });

  ipcMain.handle(IPCChannel.AgentGetState, async () => {
    return deps.reactLoop?.currentState ?? 'idle';
  });

  ipcMain.handle(IPCChannel.AgentConfirmationResponse, async (_event, response: ConfirmationResponse) => {
    deps.confirmationManager.respondConfirmation(response);
    return { success: true };
  });

  ipcMain.handle(IPCChannel.AgentToolNames, async () => {
    // 返回带 contentMode 的工具元数据，供 renderer 区分"编辑器块工具"
    // （contentMode === 'text'，运行中隐藏气泡、完成才显示）与原生工具
    // （运行中即显示 "Running" 气泡）。旧调用方仅使用 name 时不受影响。
    const registry = deps.toolRegistry;
    if (!registry) return [];
    return registry.getDefinitions().map(d => ({
      name: d.name,
      contentMode: d.contentMode ?? 'native',
    }));
  });

  // ── Session compression (OpenAI / DevEco / Cline) ──────────────────────────
  ipcMain.handle(IPCChannel.SessionCompress, async () => {
    if (deps.isAgentRunning) {
      return { success: false, error: 'Cannot compress while the agent is running.' };
    }
    const provider = deps.sessionConfig.llm.provider;
    const adapter = deps.adapterManager.getCurrent(deps.sessionConfig);
    if (!adapter || typeof (adapter as { compressHistory?: unknown }).compressHistory !== 'function') {
      return { success: false, error: 'Current provider does not support session compression.' };
    }
    try {
      const result = await (adapter as { compressHistory: (cfg: unknown) => Promise<unknown> }).compressHistory(
        deps.sessionConfig.llm,
      );
      // Push the refreshed usage snapshot to the renderer.
      if (typeof (adapter as { getContextUsage?: unknown }).getContextUsage === 'function') {
        const usage = (adapter as { getContextUsage: (cfg: unknown) => unknown }).getContextUsage(
          deps.sessionConfig.llm,
        );
        deps.sendToRenderer(IPCChannel.AgentContextUpdate, usage);
      }
      return { success: true, result };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });
}
