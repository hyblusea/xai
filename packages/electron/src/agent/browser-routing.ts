/**
 * Browser channel routing — handles browser:* tool calls from the agent's ipcSend callback.
 */
import { ipcMain, session } from 'electron';
import { IPCChannel } from '@xai/shared';
import type { BrowserSessionManager } from '../browser-session-manager.js';
import type { AppState } from '../app-state.js';

export async function handleBrowserChannel(
  channel: string,
  data: unknown,
  browserSessionManager: BrowserSessionManager,
  state: AppState,
): Promise<unknown> {
  const req = data as { sessionId: string; [key: string]: unknown };

  // For all operations except create-session, wait for webview to be ready
  if (channel !== 'browser:create-session') {
    await browserSessionManager.waitForWebView(req.sessionId);
  }

  switch (channel) {
    case 'browser:create-session': {
      browserSessionManager.createSession(req.sessionId, req.url as string | undefined);
      state.sendToRenderer(IPCChannel.BrowserCreateSession, { sessionId: req.sessionId, url: req.url });
      return { success: true };
    }
    case 'browser:navigate': {
      await browserSessionManager.navigate(req.sessionId, req.url as string);
      return { success: true };
    }
    case 'browser:go-back': {
      browserSessionManager.goBack(req.sessionId);
      return { success: true };
    }
    case 'browser:go-forward': {
      browserSessionManager.goForward(req.sessionId);
      return { success: true };
    }
    case 'browser:reload': {
      browserSessionManager.reload(req.sessionId);
      return { success: true };
    }
    case 'browser:mouse-click': {
      await browserSessionManager.mouseClick(req.sessionId, {
        selector: req.selector as string | undefined,
        x: req.x as number | undefined,
        y: req.y as number | undefined,
        button: req.button as string | undefined,
        clickCount: req.clickCount as number | undefined,
        frameSelector: req.frameSelector as string | undefined,
      });
      return { success: true };
    }
    case 'browser:type': {
      await browserSessionManager.type(req.sessionId, req.text as string, req.selector as string | undefined);
      return { success: true };
    }
    case 'browser:fill': {
      await browserSessionManager.fill(req.sessionId, req.selector as string, req.text as string, req.submit === true);
      return { success: true };
    }
    case 'browser:screenshot': {
      const base64 = await browserSessionManager.screenshot(req.sessionId);
      return { success: true, data: base64 };
    }
    case 'browser:evaluate': {
      const result = await browserSessionManager.evaluate(req.sessionId, req.expression as string, req.frameSelector as string | undefined);
      return { success: true, result };
    }
    case 'browser:extract': {
      const content = await browserSessionManager.extractContent(req.sessionId);
      return { success: true, content };
    }
    case 'browser:cdp-command': {
      const cdpResult = await browserSessionManager.sendCDPCommand(req.sessionId, req.method as string, req.params as Record<string, unknown> | undefined);
      return { success: true, result: cdpResult };
    }
    case 'browser:close': {
      browserSessionManager.closeSession(req.sessionId);
      return { success: true };
    }
    case 'browser:wait': {
      await browserSessionManager.wait(req.sessionId, req.waitType as string, req.selector as string | undefined, req.timeout as number | undefined);
      return { success: true };
    }
    case 'browser:query': {
      const elements = await browserSessionManager.queryElements(req.sessionId, req.selector as string | undefined, req.detail as boolean | undefined, req.frameSelector as string | undefined);
      return { success: true, elements };
    }
    case 'browser:storage': {
      const storageData = await browserSessionManager.getStorage(req.sessionId, req.storageType as string, req.action as string, req.key as string | undefined, req.value as string | undefined);
      return { success: true, data: storageData };
    }
    case 'browser:network': {
      const networkData = await browserSessionManager.networkAction(req.sessionId, req.action as string, req.filter as string | undefined);
      return { success: true, data: networkData };
    }
    case 'browser:press-key': {
      await browserSessionManager.pressKey(req.sessionId, req.key as string, req.modifiers as string[] | undefined);
      return { success: true };
    }
    case 'browser:hover': {
      await browserSessionManager.hover(req.sessionId, req.selector as string, req.frameSelector as string | undefined);
      return { success: true };
    }
    case 'browser:scroll': {
      await browserSessionManager.scroll(req.sessionId, req.direction as string, req.amount as number | undefined, req.selector as string | undefined, req.frameSelector as string | undefined);
      return { success: true };
    }
    case 'browser:select': {
      await browserSessionManager.selectOption(req.sessionId, req.selector as string, req.value as string, req.frameSelector as string | undefined);
      return { success: true };
    }
    case 'browser:drag': {
      await browserSessionManager.drag(req.sessionId, {
        fromSelector: req.fromSelector as string | undefined,
        toSelector: req.toSelector as string | undefined,
        fromX: req.fromX as number | undefined,
        fromY: req.fromY as number | undefined,
        toX: req.toX as number | undefined,
        toY: req.toY as number | undefined,
        frameSelector: req.frameSelector as string | undefined,
      });
      return { success: true };
    }
    case 'browser:api-request': {
      const apiResult = await browserSessionManager.apiRequest(req.sessionId, {
        url: req.url as string,
        method: req.method as string | undefined,
        headers: req.headers as Record<string, string> | undefined,
        bodyType: req.bodyType as string | undefined,
        body: req.body as string | undefined,
      });
      return { success: true, ...apiResult };
    }
    case 'browser:console': {
      const consoleData = await browserSessionManager.consoleAction(req.sessionId, req.action as string, req.level as string | undefined);
      return { success: true, data: consoleData };
    }
    case 'browser:dialog': {
      const dialogResult = browserSessionManager.dialogAction(req.sessionId, req.action as string, req.promptText as string | undefined);
      return { success: true, data: dialogResult };
    }
    case 'browser:upload-file': {
      await browserSessionManager.fileAction(req.sessionId, 'upload', { selector: req.selector as string, filePaths: req.filePaths as string[] });
      return { success: true };
    }
    case 'browser:file': {
      const fileResult = await browserSessionManager.fileAction(req.sessionId, req.action as string, {
        selector: req.selector as string | undefined,
        filePaths: req.filePaths as string[] | undefined,
        url: req.url as string | undefined,
      });
      return { success: true, data: fileResult };
    }
    default:
      return { success: false, error: `Unknown browser channel: ${channel}` };
  }
}
