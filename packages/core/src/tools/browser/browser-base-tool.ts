import { BaseTool } from '../base-tool.js';

/**
 * Base class for all browser automation tools.
 * Provides shared IPC sender injection and a helper for invoking IPC channels
 * with automatic success/error handling.
 */
export abstract class BrowserBaseTool extends BaseTool {
  protected ipcSend: ((channel: string, data: unknown) => Promise<unknown>) | null = null;

  setIpcSender(send: (channel: string, data: unknown) => Promise<unknown>): void {
    this.ipcSend = send;
  }

  /**
   * Invoke a browser IPC channel. Throws on failure so callers can use try/catch.
   */
  protected async invokeIPC<T = any>(channel: string, payload: Record<string, unknown>): Promise<T> {
    if (!this.ipcSend) {
      throw new Error(`${this.definition.name} requires Electron IPC (not available in current environment)`);
    }
    const result = await this.ipcSend(channel, payload) as { success: boolean; error?: string } & T;
    if (!result.success) {
      throw new Error(result.error || 'Unknown error');
    }
    return result;
  }
}
