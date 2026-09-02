/**
 * Git IPC handlers.
 */
import { ipcMain, app } from 'electron';
import path from 'path';
import fs from 'fs/promises';
import type { IpcDeps } from './types.js';

export function registerGitHandlers(deps: IpcDeps): void {
  ipcMain.handle('git:status', async () => {
    try {
      const git = await import('../git-service.js');
      return await git.getStatus(deps.sessionConfig.workspace);
    } catch (err) {
      return { branch: '', upstream: '', ahead: 0, behind: 0, files: [], isRepo: false };
    }
  });

  ipcMain.handle('git:diff', async (_event, params: { filePath?: string; staged?: boolean }) => {
    try {
      const git = await import('../git-service.js');
      return await git.getDiff(deps.sessionConfig.workspace, params?.filePath, params?.staged);
    } catch (err) {
      return '';
    }
  });

  ipcMain.handle('git:file-diff', async (_event, params: { filePath: string; staged?: boolean }) => {
    try {
      const git = await import('../git-service.js');
      return await git.getFileDiff(deps.sessionConfig.workspace, params.filePath, params?.staged);
    } catch (err) {
      return { filePath: params?.filePath || '', hunks: '', additions: 0, deletions: 0 };
    }
  });

  ipcMain.handle('git:stage', async (_event, filePath: string) => {
    try {
      const git = await import('../git-service.js');
      const success = await git.stageFile(deps.sessionConfig.workspace, filePath);
      return { success };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('git:unstage', async (_event, filePath: string) => {
    try {
      const git = await import('../git-service.js');
      const success = await git.unstageFile(deps.sessionConfig.workspace, filePath);
      return { success };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('git:stage-all', async () => {
    try {
      const git = await import('../git-service.js');
      const result = await git.stageAll(deps.sessionConfig.workspace);
      console.log('[git:stage-all] workspace:', deps.sessionConfig.workspace, 'result:', result);
      return result;
    } catch (err) {
      console.error('[git:stage-all] error:', err);
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('git:unstage-all', async () => {
    try {
      const git = await import('../git-service.js');
      const success = await git.unstageAll(deps.sessionConfig.workspace);
      return { success };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('git:commit', async (_event, message: string) => {
    try {
      const git = await import('../git-service.js');
      const result = await git.commit(deps.sessionConfig.workspace, message);
      console.log('[git:commit] workspace:', deps.sessionConfig.workspace, 'message:', message, 'success:', result.success, 'output:', result.output);
      if (!result.success) {
        const logPath = path.join(app.getPath('userData'), 'git-error.log');
        const logLine = `[${new Date().toISOString()}] git:commit failed\n  workspace: ${deps.sessionConfig.workspace}\n  message: ${message}\n  output: ${result.output}\n\n`;
        try { await fs.appendFile(logPath, logLine, 'utf8'); } catch {}
      }
      return result;
    } catch (err) {
      console.error('[git:commit] error:', err);
      const logPath = path.join(app.getPath('userData'), 'git-error.log');
      const logLine = `[${new Date().toISOString()}] git:commit exception\n  workspace: ${deps.sessionConfig.workspace}\n  message: ${message}\n  error: ${String(err)}\n\n`;
      try { await fs.appendFile(logPath, logLine, 'utf8'); } catch {}
      return { success: false, output: String(err) };
    }
  });

  ipcMain.handle('git:push', async (_event, params?: { remote?: string; branch?: string }) => {
    try {
      const git = await import('../git-service.js');
      return await git.push(deps.sessionConfig.workspace, params?.remote, params?.branch);
    } catch (err) {
      return { success: false, output: String(err) };
    }
  });

  ipcMain.handle('git:pull', async (_event, params?: { remote?: string; branch?: string }) => {
    try {
      const git = await import('../git-service.js');
      return await git.pull(deps.sessionConfig.workspace, params?.remote, params?.branch);
    } catch (err) {
      return { success: false, output: String(err) };
    }
  });

  ipcMain.handle('git:fetch', async (_event, params?: { remote?: string }) => {
    try {
      const git = await import('../git-service.js');
      return await git.fetch(deps.sessionConfig.workspace, params?.remote);
    } catch (err) {
      return { success: false, output: String(err) };
    }
  });

  ipcMain.handle('git:log', async (_event, maxCount?: number) => {
    try {
      const git = await import('../git-service.js');
      return await git.getLog(deps.sessionConfig.workspace, maxCount || 50);
    } catch (err) {
      return [];
    }
  });

  ipcMain.handle('git:branches', async () => {
    try {
      const git = await import('../git-service.js');
      return await git.getBranches(deps.sessionConfig.workspace);
    } catch (err) {
      return [];
    }
  });

  ipcMain.handle('git:checkout', async (_event, branchName: string) => {
    try {
      const git = await import('../git-service.js');
      return await git.checkoutBranch(deps.sessionConfig.workspace, branchName);
    } catch (err) {
      return { success: false, output: String(err) };
    }
  });

  ipcMain.handle('git:create-branch', async (_event, branchName: string) => {
    try {
      const git = await import('../git-service.js');
      return await git.createBranch(deps.sessionConfig.workspace, branchName);
    } catch (err) {
      return { success: false, output: String(err) };
    }
  });

  ipcMain.handle('git:discard', async (_event, filePath: string) => {
    try {
      const git = await import('../git-service.js');
      return await git.discardChanges(deps.sessionConfig.workspace, filePath);
    } catch (err) {
      return { success: false, output: String(err) };
    }
  });

  ipcMain.handle('git:discard-all', async () => {
    try {
      const git = await import('../git-service.js');
      return await git.discardAllChanges(deps.sessionConfig.workspace);
    } catch (err) {
      return { success: false, output: String(err) };
    }
  });

  ipcMain.handle('git:remote-url', async () => {
    try {
      const git = await import('../git-service.js');
      return await git.getRemoteUrl(deps.sessionConfig.workspace);
    } catch (err) {
      return '';
    }
  });

  ipcMain.handle('git:init', async () => {
    try {
      const git = await import('../git-service.js');
      const result = await git.isGitRepo(deps.sessionConfig.workspace);
      if (result) return { success: true, output: 'Already a git repository' };
      const { spawn } = await import('child_process');
      return await new Promise<{ success: boolean; output: string }>((resolve) => {
        const child = spawn('git', ['init'], {
          cwd: deps.sessionConfig.workspace,
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        });
        let stdout = '';
        let stderr = '';
        child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
        child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
        child.on('close', (code) => {
          resolve({ success: code === 0, output: stdout + stderr });
        });
        child.on('error', (err) => {
          resolve({ success: false, output: err.message });
        });
      });
    } catch (err) {
      return { success: false, output: String(err) };
    }
  });

  ipcMain.handle('git:delete-branch', async (_event, branchName: string, force?: boolean) => {
    try {
      const git = await import('../git-service.js');
      return await git.deleteBranch(deps.sessionConfig.workspace, branchName, force);
    } catch (err) {
      return { success: false, output: String(err) };
    }
  });

  ipcMain.handle('git:merge-branch', async (_event, branchName: string) => {
    try {
      const git = await import('../git-service.js');
      return await git.mergeBranch(deps.sessionConfig.workspace, branchName);
    } catch (err) {
      return { success: false, output: String(err) };
    }
  });

  ipcMain.handle('git:stash', async (_event, message?: string) => {
    try {
      const git = await import('../git-service.js');
      return await git.stash(deps.sessionConfig.workspace, message);
    } catch (err) {
      return { success: false, output: String(err) };
    }
  });

  ipcMain.handle('git:stash-list', async () => {
    try {
      const git = await import('../git-service.js');
      return await git.stashList(deps.sessionConfig.workspace);
    } catch {
      return [];
    }
  });

  ipcMain.handle('git:stash-pop', async (_event, index?: number) => {
    try {
      const git = await import('../git-service.js');
      return await git.stashPop(deps.sessionConfig.workspace, index);
    } catch (err) {
      return { success: false, output: String(err) };
    }
  });

  ipcMain.handle('git:stash-apply', async (_event, index?: number) => {
    try {
      const git = await import('../git-service.js');
      return await git.stashApply(deps.sessionConfig.workspace, index);
    } catch (err) {
      return { success: false, output: String(err) };
    }
  });

  ipcMain.handle('git:stash-drop', async (_event, index?: number) => {
    try {
      const git = await import('../git-service.js');
      return await git.stashDrop(deps.sessionConfig.workspace, index);
    } catch (err) {
      return { success: false, output: String(err) };
    }
  });

  ipcMain.handle('git:commit-detail', async (_event, hash: string) => {
    try {
      const git = await import('../git-service.js');
      return await git.getCommitDetail(deps.sessionConfig.workspace, hash);
    } catch {
      return null;
    }
  });

  ipcMain.handle('git:commit-file-diff', async (_event, params: { hash: string; filePath: string }) => {
    try {
      const git = await import('../git-service.js');
      return await git.getCommitFileDiff(deps.sessionConfig.workspace, params.hash, params.filePath);
    } catch {
      return null;
    }
  });

  ipcMain.handle('git:add-remote', async (_event, name: string, url: string) => {
    try {
      const git = await import('../git-service.js');
      return await git.addRemote(deps.sessionConfig.workspace, name, url);
    } catch (err) {
      return { success: false, output: String(err) };
    }
  });

  ipcMain.handle('git:set-remote-url', async (_event, name: string, url: string) => {
    try {
      const git = await import('../git-service.js');
      return await git.setRemoteUrl(deps.sessionConfig.workspace, name, url);
    } catch (err) {
      return { success: false, output: String(err) };
    }
  });

  ipcMain.handle('git:remotes', async () => {
    try {
      const git = await import('../git-service.js');
      return await git.getRemotes(deps.sessionConfig.workspace);
    } catch {
      return [];
    }
  });
}
