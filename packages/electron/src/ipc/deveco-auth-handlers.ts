/**
 * DevEco OAuth authentication IPC handlers.
 * Handles login, logout, and auth status queries.
 */
import { ipcMain } from 'electron';
import { IPCChannel } from '@xai/shared';
import { devecoAuthService } from '../deveco-auth.js';
import type { IpcDeps } from './types.js';

export function registerDevEcoAuthHandlers(deps: IpcDeps): void {
  ipcMain.handle(IPCChannel.DevEcoLogin, async () => {
    try {
      const result = await devecoAuthService.login((message) => {
        deps.sendToRenderer(IPCChannel.DevEcoLoginProgress, message);
      });
      return result;
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle(IPCChannel.DevEcoLogout, async () => {
    devecoAuthService.logout();
    return { success: true };
  });

  ipcMain.handle(IPCChannel.DevEcoAuthStatus, async () => {
    return devecoAuthService.getAuthStatus();
  });
}
