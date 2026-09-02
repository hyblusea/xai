/**
 * Window & workspace IPC handlers.
 */
import { ipcMain, dialog, shell, app } from 'electron';
import { IPCChannel } from '@xai/shared';
import type { IpcDeps } from './types.js';

export function registerWindowHandlers(deps: IpcDeps): void {
  ipcMain.on(IPCChannel.WindowMinimize, () => {
    deps.mainWindow?.minimize();
  });

  ipcMain.on(IPCChannel.WindowMaximize, () => {
    if (!deps.mainWindow) return;
    if (deps.mainWindow.isMaximized()) {
      deps.mainWindow.unmaximize();
    } else {
      deps.mainWindow.maximize();
    }
  });

  ipcMain.on(IPCChannel.WindowClose, () => {
    deps.mainWindow?.close();
  });

  // 渲染进程确认未保存提示后调用：设置绕过标志再关闭窗口，
  // 避免 close 事件再次触发 window:close-requested 拦截。
  ipcMain.on(IPCChannel.WindowForceClose, () => {
    deps.forceCloseWindow = true;
    deps.mainWindow?.close();
  });

  ipcMain.on('window:fullscreen', () => {
    if (!deps.mainWindow) return;
    deps.mainWindow.setFullScreen(!deps.mainWindow.isFullScreen());
  });

  ipcMain.handle(IPCChannel.WorkspaceOpen, async () => {
    const result = await dialog.showOpenDialog(deps.mainWindow!, {
      properties: ['openDirectory'],
      title: '选择工作区目录'
    });
    if (!result.canceled && result.filePaths.length > 0) {
      deps.sessionConfig.workspace = result.filePaths[0];
      const { configManager } = await import('../config.js');
      await configManager.saveConfig(deps.sessionConfig);
      deps.reactLoop = null;
      const { initializeAgent } = await import('../agent/initialize.js');
      await initializeAgent(deps);
      deps.sendToRenderer('workspace:changed', deps.sessionConfig.workspace);
      return result.filePaths[0];
    }
    return null;
  });

  ipcMain.handle('workspace:info', async (_event, workspacePath?: string) => {
    if (workspacePath !== undefined) {
      deps.sessionConfig.workspace = workspacePath;
      const { configManager } = await import('../config.js');
      await configManager.saveConfig(deps.sessionConfig);
      if (deps.fileWatcher) {
        deps.fileWatcher.close();
        deps.fileWatcher = null;
      }
      deps.reactLoop = null;
      const { initializeAgent } = await import('../agent/initialize.js');
      await initializeAgent(deps);
      deps.sendToRenderer('workspace:changed', workspacePath);
    }
    return deps.sessionConfig.workspace;
  });

  ipcMain.handle('shell:open-external', async (_event, url: string) => {
    if (url && (url.startsWith('http://') || url.startsWith('https://'))) {
      shell.openExternal(url);
    }
  });

  ipcMain.handle('menu:toggle-devtools', async () => {
    if (deps.mainWindow) {
      deps.mainWindow.webContents.toggleDevTools();
    }
  });

  ipcMain.handle('menu:show-about', async () => {
    if (deps.mainWindow) {
      dialog.showMessageBoxSync(deps.mainWindow, {
        type: 'info',
        title: '关于 XAI IDE',
        message: 'XAI IDE - AI 编程助手',
        detail: `版本: ${app.getVersion()}\n基于 ReAct + 流式解析的 AI 编程助手\n技术栈: Electron + React + TypeScript`,
      });
    }
  });

  ipcMain.handle('menu:get-system-prompt', async (_event, payload?: { viewMode?: 'code' | 'designer' }) => {
    try {
      // designer 视图：构建 designer 系统提示词（若选中项目，注入 themePrompt）
      if (payload?.viewMode === 'designer') {
        const { buildDesignerSystemPrompt } = await import('@xai/core');
        let themePrompt: string | undefined;
        let projectType: 'APP' | 'WEB' | 'PDA' | 'DIAGRAM' = 'WEB';
        const projectId = deps.currentDesignerProjectId;
        if (projectId) {
          try {
            const projectMeta = await deps.adminClient.getProject(projectId);
            themePrompt = projectMeta.themePrompt;
            if (projectMeta.type === 'APP' || projectMeta.type === 'WEB' || projectMeta.type === 'PDA' || projectMeta.type === 'DIAGRAM') {
              projectType = projectMeta.type;
            }
          } catch { /* 忽略：项目上下文获取失败时退回无 themePrompt 的 designer 提示词 */ }
        }
        const prompt = buildDesignerSystemPrompt({ projectType, themePrompt });
        return { success: true, prompt };
      }
      // code 视图：构建 agent 系统提示词
      if (!deps.toolRegistry) {
        return { success: false, error: 'Tool registry not initialized' };
      }
      const { buildSystemPrompt } = await import('@xai/core');
      const prompt = buildSystemPrompt(deps.toolRegistry.getDefinitions(), deps.sessionConfig.workspace);
      return { success: true, prompt };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });
}
