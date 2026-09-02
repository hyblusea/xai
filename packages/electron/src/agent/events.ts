/**
 * ReActLoop event binding — wires agent events to renderer notifications.
 *
 * 日志上报已移至 LLMRouter.onRawHttp 回调（在 agent-handlers.ts / designer-handlers.ts 中设置），
 * 每次 HTTP LLM 调用完成时上报一条原始 request/response 日志，不再依赖 iterationComplete 事件。
 */
import { ipcMain, session } from 'electron';
import { IPCChannel, AgentState } from '@xai/shared';
import type { ConfirmationRequest } from '@xai/shared';
import type { ReActLoop } from '@xai/core';
import type { AppState } from '../app-state.js';
import { requestLocalConversationSave } from './persist.js';

export function bindAgentEvents(reactLoop: ReActLoop, state: AppState): void {
  reactLoop.on('stateChange', (stateVal: AgentState) => {
    state.logToRenderer('debug', `State: ${stateVal}`);
    state.sendToRenderer(IPCChannel.AgentStateUpdate, stateVal);
  });

  reactLoop.on('streamText', (text: string) => {
    state.sendToRenderer(IPCChannel.AgentStreamChunk, text);
    if (!state.titleGenerated) {
      state.firstAssistantMessage += text;
      if (state.firstAssistantMessage.length > 500) {
        state.firstAssistantMessage = state.firstAssistantMessage.substring(0, 500);
      }
    }
  });

  reactLoop.on('streamThinking', (text: string) => {
    state.sendToRenderer(IPCChannel.AgentStreamThinking, text);
  });

  reactLoop.on('streamReset', () => {
    state.sendToRenderer(IPCChannel.AgentStreamReset);
  });

  reactLoop.on('contextUpdate', (usage: unknown) => {
    state.sendToRenderer(IPCChannel.AgentContextUpdate, usage);
  });

  reactLoop.on('compressing', (info: unknown) => {
    state.logToRenderer('info', `Auto-compression started: ${JSON.stringify(info)}`);
    state.sendToRenderer(IPCChannel.AgentCompressing, info);
  });

  reactLoop.on('compressed', (info: unknown) => {
    state.logToRenderer('info', `Auto-compression finished: ${JSON.stringify(info)}`);
    state.sendToRenderer(IPCChannel.AgentCompressed, info);
  });

  reactLoop.on('compressError', (info: unknown) => {
    state.logToRenderer('warn', `Auto-compression failed: ${JSON.stringify(info)}`);
    state.sendToRenderer(IPCChannel.AgentCompressError, info);
  });

  reactLoop.on('streamToolSummary', (text: string) => {
    state.sendToRenderer(IPCChannel.AgentStreamToolSummary, text);
  });

  reactLoop.on('toolCallStart', () => {
    state.sendToRenderer(IPCChannel.AgentToolCallStart);
  });

  reactLoop.on('toolCallEnd', (summary: string, toolCall: unknown) => {
    state.sendToRenderer(IPCChannel.AgentToolCallEnd, { summary, toolCall });
  });

  reactLoop.on('toolCallParsed', (toolCall: unknown) => {
    const tc = toolCall as { name: string; parameters: Record<string, unknown> };
    state.logToRenderer('info', `Tool call: ${tc.name}`);
    state.sendToRenderer(IPCChannel.AgentToolCall, toolCall);
  });

  reactLoop.on('toolExecuting', (info: unknown) => {
    const tc = info as { name: string; params: Record<string, unknown> };
    if (tc.name === 'execute_command') {
      state.currentCommandInfo = {
        commandId: `cmd_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        command: (tc.params.command as string) || 'unknown'
      };
      state.sendToRenderer(IPCChannel.ToolExecuting, info);
    } else {
      state.sendToRenderer(IPCChannel.ToolExecuting, info);
    }
  });

  reactLoop.on('toolResult', (data: unknown) => {
    const d = data as { toolCall?: { name: string }; result: { success: boolean; output: string; error?: string } };
    state.logToRenderer('info', `Tool result: ${d.toolCall?.name} -> ${d.result.success ? 'OK' : 'FAIL'}`);
    state.sendToRenderer(IPCChannel.ToolResult, data);
    state.currentMessages.push({
      role: 'tool',
      content: d.result.output || d.result.error || '',
      timestamp: Date.now(),
      toolName: d.toolCall?.name,
      toolResult: {
        toolName: d.toolCall?.name || 'unknown',
        success: d.result.success,
        output: d.result.output,
        error: d.result.error,
      },
    });
  });

  reactLoop.on('confirmationNeeded', (request: ConfirmationRequest) => {
    state.sendToRenderer(IPCChannel.AgentConfirmationRequest, request);
    state.currentConfirmationRequest = request;
  });

  reactLoop.on('error', (error: Error) => {
    state.logToRenderer('error', `Agent error: ${error.message}`);
    state.sendToRenderer(IPCChannel.AgentError, error.message);
    // Persist the current (incomplete) conversation: the loop terminates early
    // on error and 'completed' never fires, so this is the only save point.
    // Delay lets the renderer flush the error bubble into its messagesRef first.
    requestLocalConversationSave(state, { delayMs: 400 });
  });

  // Internal iteration error (e.g. mid-stream connection drop): the loop can
  // retry, but the partial output so far must not be lost on model switch /
  // app restart, so snapshot now as well.
  reactLoop.on('loopError', (error: Error) => {
    state.logToRenderer('error', `Agent internal error: ${error.message}`);
    requestLocalConversationSave(state, { delayMs: 400 });
  });

  reactLoop.on('aborted', () => {
    state.logToRenderer('info', 'Agent aborted');
    // User stopped mid-generation — save the partial conversation so it
    // survives a model switch / app restart.
    requestLocalConversationSave(state, { delayMs: 400 });
  });

  reactLoop.on('completed', async () => {
    state.logToRenderer('info', 'Agent completed');
    state.sendToRenderer(IPCChannel.AgentCompleted);

    const lastAssistantContent = state.firstAssistantMessage || '';
    if (lastAssistantContent) {
      state.currentMessages.push({
        role: 'assistant',
        content: lastAssistantContent,
        timestamp: Date.now(),
      });
    }

    if (!state.titleGenerated && state.firstAssistantMessage) {
      state.titleGenerated = true;
      let title: string | null = null;
      try {
        title = await state.adapterManager.genTitle(state.sessionConfig, state.firstAssistantMessage);
      } catch {}
      // Fallback for stateless providers (OpenAI / DevEco / Cline) whose
      // adapters don't implement genTitle (it returns null), and for any
      // provider where genTitle fails: derive a concise title from the first
      // user message. MiMo/Gemini already return a real title above, so this
      // branch is a no-op for them and their behavior is unchanged.
      if (!title) {
        const firstUser = state.currentMessages.find(m => m.role === 'user');
        const raw = firstUser?.content?.trim();
        if (raw) {
          const collapsed = raw.replace(/\s+/g, ' ').trim();
          title = collapsed.length > 30 ? collapsed.slice(0, 30) + '…' : collapsed;
        }
      }
      if (title) {
        state.sendToRenderer('session:title', title);
        state.currentSessionTitle = title;
      }
    }

    // Local conversation persistence (OpenAI / DevEco / Cline / Freebuff): ask
    // the renderer to send back its displayMessages so we can persist both layers
    // (display + adapter state) to disk. This binding is Code-view only —
    // Designer never emits 'completed' here (it streams via router.send() and
    // emits DesignerStreamDone), so Designer conversations are never persisted.
    requestLocalConversationSave(state, { title: state.currentSessionTitle });
  });
}
