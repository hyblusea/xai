/**
 * Cline OAuth authentication & model IPC handlers.
 * Handles login, logout, auth status, and model list queries.
 */
import { ipcMain } from 'electron';
import { IPCChannel } from '@xai/shared';
import { clineAuthService } from '../cline-auth.js';
import type { IpcDeps } from './types.js';

export function registerClineAuthHandlers(deps: IpcDeps): void {
  ipcMain.handle(IPCChannel.ClineLogin, async () => {
    try {
      const result = await clineAuthService.login((message) => {
        deps.sendToRenderer(IPCChannel.ClineLoginProgress, message);
      });
      return result;
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle(IPCChannel.ClineLogout, async () => {
    clineAuthService.logout();
    return { success: true };
  });

  ipcMain.handle(IPCChannel.ClineAuthStatus, async () => {
    return clineAuthService.getAuthStatus();
  });

  ipcMain.handle(IPCChannel.ClineModels, async () => {
    try {
      const models = await clineAuthService.fetchRecommendedModels();
      if (!models) {
        return { success: false, error: 'Failed to fetch recommended models' };
      }
      // Only return free models — the Cline provider in xAI IDE is for free model usage.
      // Recommended and clinePass models require paid subscriptions.
      const freeModels = models.free.map(m => ({ ...m, category: 'free' as const }));
      return { success: true, models: freeModels };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle(IPCChannel.ClineModelReasoning, async (_event, modelId: string) => {
    try {
      const result = await clineAuthService.checkModelReasoning(modelId);
      return { success: true, ...result };
    } catch (err) {
      return { success: false, supportsReasoning: false, supportedEfforts: [], defaultEffort: '', error: String(err) };
    }
  });

  ipcMain.handle(IPCChannel.ClineModelContextInfo, async (_event, modelId: string) => {
    try {
      const result = await clineAuthService.checkModelContextInfo(modelId);
      return { success: true, ...result };
    } catch (err) {
      return { success: false, contextWindow: 128_000, maxInputTokens: 115_000, maxOutputTokens: 4_096, error: String(err) };
    }
  });
}