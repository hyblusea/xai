/**
 * File operation IPC handlers.
 */
import { ipcMain, shell } from 'electron';
import { IPCChannel } from '@xai/shared';
import path from 'path';
import fs from 'fs/promises';
import { searchInFiles } from '../file-search.js';
import type { IpcDeps } from './types.js';

export function registerFileHandlers(deps: IpcDeps): void {
  ipcMain.handle(IPCChannel.FileWrite, async (_event, filePath: string, content: string) => {
    try {
      await fs.writeFile(filePath, content, 'utf-8');
      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  ipcMain.handle(IPCChannel.FileRead, async (_event, filePath: string) => {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      return { success: true, content };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  ipcMain.handle(IPCChannel.FileList, async (_event, dirPath: string) => {
    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });
      return {
        success: true,
        entries: entries.map(e => ({
          name: e.name,
          isDirectory: e.isDirectory(),
          path: path.join(dirPath, e.name)
        }))
      };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  ipcMain.handle(IPCChannel.FileSearch, async (_event, dirPath: string, pattern: string, ignoreCase: boolean = true) => {
    try {
      const results = await searchInFiles(dirPath, pattern, 500, ignoreCase);
      return { success: true, results };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  ipcMain.handle('file:delete', async (_event, filePath: string) => {
    try {
      await fs.rm(filePath, { recursive: true, force: true });
      return { success: true };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('file:rename', async (_event, oldPath: string, newName: string) => {
    try {
      const dir = path.dirname(oldPath);
      const newPath = path.join(dir, newName);
      await fs.rename(oldPath, newPath);
      return { success: true, newPath };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('file:copy-path', async (_event, filePath: string) => {
    try {
      const { clipboard } = await import('electron');
      clipboard.writeText(filePath);
      return { success: true };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('file:show-in-explorer', async (_event, filePath: string) => {
    try {
      shell.showItemInFolder(filePath);
      return { success: true };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('file:create-file', async (_event, dirPath: string, fileName: string) => {
    try {
      const filePath = path.join(dirPath, fileName);
      await fs.writeFile(filePath, '', { flag: 'wx' });
      return { success: true, path: filePath };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('file:create-directory', async (_event, dirPath: string, dirName: string) => {
    try {
      const newDirPath = path.join(dirPath, dirName);
      await fs.mkdir(newDirPath, { recursive: false });
      return { success: true, path: newDirPath };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('file:replace-in-file', async (_event, filePath: string, search: string, replace: string) => {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const newContent = content.split(search).join(replace);
      if (newContent === content) {
        return { success: false, error: 'No matches found' };
      }
      await fs.writeFile(filePath, newContent, 'utf-8');
      const matchCount = content.split(search).length - 1;
      return { success: true, matchCount };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });
}
