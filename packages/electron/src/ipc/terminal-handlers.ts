/**
 * Terminal session IPC handlers.
 */
import { ipcMain } from 'electron';
import { IPCChannel } from '@xai/shared';
import type { IpcDeps } from './types.js';

export function registerTerminalHandlers(deps: IpcDeps): void {
  ipcMain.handle(IPCChannel.TerminalSessionSpawn, async (_event, options: { shell?: string }) => {
    if (!deps.terminalSessionManager) {
      const { initTerminalSessionManager } = await import('../terminal-manager.js');
      initTerminalSessionManager(deps);
    }
    if (!deps.terminalSessionManager) {
      return { success: false, error: 'Terminal session manager not initialized' };
    }
    try {
      const result = await deps.terminalSessionManager.spawn({ shell: (options.shell as any) || undefined });
      return { success: true, sessionId: result.sessionId, shell: result.shell };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle(IPCChannel.TerminalSessionSend, async (_event, sessionId: string, data: string) => {
    if (!deps.terminalSessionManager) {
      const { initTerminalSessionManager } = await import('../terminal-manager.js');
      initTerminalSessionManager(deps);
    }
    if (!deps.terminalSessionManager) {
      return { success: false, error: 'Terminal session manager not initialized' };
    }
    try {
      const session = (deps.terminalSessionManager as any).sessions.get(sessionId);
      if (!session || session.info.status !== 'active') {
        return { success: false, error: 'Session not found or closed' };
      }
      session.pty.write(data);
      session.info.lastActivity = Date.now();
      return { success: true };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle(IPCChannel.TerminalSessionClose, async (_event, sessionId: string) => {
    if (!deps.terminalSessionManager) {
      const { initTerminalSessionManager } = await import('../terminal-manager.js');
      initTerminalSessionManager(deps);
    }
    if (!deps.terminalSessionManager) {
      return { success: false, error: 'Terminal session manager not initialized' };
    }
    try {
      await deps.terminalSessionManager.close(sessionId);
      return { success: true };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle(IPCChannel.TerminalSessionResize, async (_event, sessionId: string, cols: number, rows: number) => {
    if (!deps.terminalSessionManager) {
      return { success: false, error: 'Terminal session manager not initialized' };
    }
    try {
      deps.terminalSessionManager.resize(sessionId, cols, rows);
      return { success: true };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle(IPCChannel.TerminalSessionGetBuffer, async (_event, sessionId: string) => {
    if (!deps.terminalSessionManager) {
      return { success: false, error: 'Terminal session manager not initialized' };
    }
    try {
      const buffer = await deps.terminalSessionManager.getDisplayBuffer(sessionId);
      return { success: true, buffer };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });
}
