/**
 * Web search & fetch IPC handlers.
 */
import { ipcMain } from 'electron';
import { IPCChannel } from '@xai/shared';
import { fetchWebContent } from '../web-fetch-via-browser.js';
import { fetchHtmlViaBrowser } from '../web-search-via-browser.js';
import type { IpcDeps } from './types.js';

export function registerWebHandlers(deps: IpcDeps): void {
  ipcMain.handle(IPCChannel.WebSearchTest, async (_event, params: { query: string; engine?: string; num?: number }) => {
    try {
      const { WebSearchTool } = await import('@xai/core');
      const searchConfig = deps.sessionConfig.webSearch || {
        enabled: true,
        defaultEngine: 'bing',
        maxResults: 10,
        minRequestInterval: 2000,
        autoFallback: true,
        hl: 'zh-CN',
        gl: 'CN',
      };
      const tool = new WebSearchTool({
        ...searchConfig,
        defaultEngine: (params.engine || searchConfig.defaultEngine) as 'google' | 'bing' | 'duckduckgo' | 'baidu',
        maxResults: params.num || searchConfig.maxResults,
      });
      tool.setBrowserFetcher(fetchHtmlViaBrowser);
      const result = await tool.execute({ query: params.query, num: params.num });
      return { success: result.success, data: result.output, error: result.error };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle(IPCChannel.WebFetchRequest, async (_event, params: { url: string; maxLength?: number; timeout?: number }) => {
    try {
      const result = await fetchWebContent(params.url, {
        maxLength: params.maxLength,
        timeout: params.timeout,
        proxy: deps.sessionConfig.proxy,
      });
      return { success: true, data: result };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });
}
