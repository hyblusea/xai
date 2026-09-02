/**
 * office2md IPC handler — converts pasted office documents to Markdown
 * in the main process (shared converter with the AI tool).
 *
 * Renderer sends: { filename: string, buffer: ArrayBuffer | Uint8Array }
 * Returns:        { success: boolean, markdown?: string, error?: string }
 */
import { ipcMain } from 'electron';
import { IPCChannel } from '@xai/shared';
import { convertToMarkdown } from '@xai/core';
import type { IpcDeps } from './types.js';

export function registerOffice2MdHandlers(_deps: IpcDeps): void {
  ipcMain.handle(
    IPCChannel.Office2MdConvert,
    async (_event, payload: { filename: string; buffer: ArrayBuffer | Uint8Array }) => {
      try {
        if (!payload || !payload.filename || !payload.buffer) {
          return { success: false, error: 'Missing filename or buffer' };
        }
        const markdown = await convertToMarkdown(payload.buffer, payload.filename);
        return { success: true, markdown };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { success: false, error: message };
      }
    },
  );
}
