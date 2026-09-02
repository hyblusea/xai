import { ipcMain } from 'electron';
import { IPCChannel } from '@xai/shared';
import { BrowserSessionManager } from './browser-session-manager.js';

export function registerBrowserIPC(
  manager: BrowserSessionManager,
  sendToRenderer: (channel: string, ...args: unknown[]) => void,
): void {
  // ── Forward browser events to renderer ──
  manager.on('title-update', (data) => {
    sendToRenderer(IPCChannel.BrowserTitleUpdate, data);
  });

  manager.on('url-update', (data) => {
    sendToRenderer(IPCChannel.BrowserURLUpdate, data);
  });

  manager.on('navigation-complete', (data) => {
    sendToRenderer(IPCChannel.BrowserURLUpdate, data);
  });

  manager.on('loading-state', (data) => {
    sendToRenderer(IPCChannel.BrowserLoadingState, data);
  });

  // ── IPC Handlers ──
  ipcMain.handle(IPCChannel.BrowserCreateSession, (_event, req: { sessionId: string; url?: string }) => {
    try {
      manager.createSession(req.sessionId, req.url);
      // Forward to renderer so it can open a tab (for AI tool triggers)
      sendToRenderer(IPCChannel.BrowserCreateSession, { sessionId: req.sessionId, url: req.url });
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle(IPCChannel.BrowserRegisterWebView, (_event, req: { sessionId: string; webContentsId: number }) => {
    try {
      manager.registerWebView(req.sessionId, req.webContentsId);
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle(IPCChannel.BrowserNavigate, async (_event, req: { sessionId: string; url: string }) => {
    try {
      await manager.navigate(req.sessionId, req.url);
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle(IPCChannel.BrowserGoBack, (_event, req: { sessionId: string }) => {
    try {
      manager.goBack(req.sessionId);
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle(IPCChannel.BrowserGoForward, (_event, req: { sessionId: string }) => {
    try {
      manager.goForward(req.sessionId);
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle(IPCChannel.BrowserReload, (_event, req: { sessionId: string }) => {
    try {
      manager.reload(req.sessionId);
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle(IPCChannel.BrowserMouseClick, async (_event, req: { sessionId: string; selector?: string; x?: number; y?: number; button?: string; clickCount?: number }) => {
    try {
      await manager.mouseClick(req.sessionId, {
        selector: req.selector,
        x: req.x,
        y: req.y,
        button: req.button,
        clickCount: req.clickCount,
      });
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle(IPCChannel.BrowserType, async (_event, req: { sessionId: string; text: string }) => {
    try {
      await manager.type(req.sessionId, req.text);
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle(IPCChannel.BrowserScreenshot, async (_event, req: { sessionId: string }) => {
    try {
      const base64 = await manager.screenshot(req.sessionId);
      return { success: true, data: base64 };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle(IPCChannel.BrowserEvaluate, async (_event, req: { sessionId: string; expression: string }) => {
    try {
      const result = await manager.evaluate(req.sessionId, req.expression);
      return { success: true, result };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle(IPCChannel.BrowserExtract, async (_event, req: { sessionId: string }) => {
    try {
      const content = await manager.extractContent(req.sessionId);
      return { success: true, content };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle(IPCChannel.BrowserCDPCommand, async (_event, req: { sessionId: string; method: string; params?: Record<string, unknown> }) => {
    try {
      const result = await manager.sendCDPCommand(req.sessionId, req.method, req.params);
      return { success: true, result };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle(IPCChannel.BrowserClose, (_event, req: { sessionId: string }) => {
    try {
      manager.closeSession(req.sessionId);
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  console.log('[BrowserIPC] Browser IPC handlers registered');
}