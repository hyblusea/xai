/**
 * Terminal session manager initialization.
 */
import { IPCChannel } from '@xai/shared';
import { TerminalSessionManager } from '@xai/core';
import type { AppState } from './app-state.js';

export function initTerminalSessionManager(state: AppState): void {
  if (state.terminalSessionManager) {
    state.terminalSessionManager.dispose();
  }
  state.terminalSessionManager = new TerminalSessionManager(state.sessionConfig.workspace || process.cwd(), undefined, {
    onSessionOpened: (info, initialOutput) => {
      state.sendToRenderer(IPCChannel.TerminalSessionOpened, {
        sessionId: info.id,
        shell: info.shell,
        cwd: info.cwd,
        initialOutput,
        status: info.status,
      });
    },
    onSessionData: (sessionId, data) => {
      state.sendToRenderer(IPCChannel.TerminalSessionData, { sessionId, data });
    },
    onSessionExited: (sessionId, code) => {
      state.sendToRenderer(IPCChannel.TerminalSessionExited, { sessionId, code });
    },
  });
}
