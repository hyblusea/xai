export { BaseTool } from './base-tool.js';
export { ReadFileTool } from './read-file.js';
export { ListFilesTool } from './list-files.js';
export { WriteFileTool } from './write-file.js';
export { ReplaceInFileTool } from './replace-in-file.js';
export { RemoveLineTool } from './remove-line.js';
export { GrepInFilesTool } from './grep-in-files.js';
export { ExecuteCommandTool } from './execute-command.js';
export { TerminalOpenTool } from './terminal/terminal-open.js';
export { TerminalSendTool } from './terminal/terminal-send.js';
export { TerminalCloseTool } from './terminal/terminal-close.js';
export { TerminalPollTool } from './terminal/terminal-poll.js';
export { TerminalSessionManager } from './terminal/session-manager.js';
export { MCPTool } from './mcp-tool.js';
export { ToolSearchTool } from './tool-search-tool.js';
export { ToolRegistry } from './tool-registry.js';
export { SqlExecuteTool } from './database/sql-execute-tool.js';
export { WebSearchTool } from './web/web-search-tool.js';
export { WebFetchTool } from './web/web-fetch-tool.js';
export { BrowserBaseTool } from './browser/browser-base-tool.js';
export { BrowserSessionTool } from './browser/browser-session-tool.js';
export { BrowserMouseClickTool } from './browser/browser-mouse-click-tool.js';
export { BrowserInputTool } from './browser/browser-input-tool.js';
export { BrowserScreenshotTool } from './browser/browser-screenshot-tool.js';
export { BrowserEvaluateTool } from './browser/browser-evaluate-tool.js';
export { BrowserExtractTool } from './browser/browser-extract-tool.js';
export { BrowserWaitTool } from './browser/browser-wait-tool.js';
export { BrowserQueryTool } from './browser/browser-query-tool.js';
export { BrowserStorageTool } from './browser/browser-storage-tool.js';
export { BrowserInteractTool } from './browser/browser-interact-tool.js';
export { BrowserDragTool } from './browser/browser-drag-tool.js';
export { BrowserApiRequestTool } from './browser/browser-api-request-tool.js';
export { BrowserDebugTool } from './browser/browser-debug-tool.js';
export { BrowserFileTool } from './browser/browser-file-tool.js';
export { Office2MdTool, convertToMarkdown, isSupportedFile, SUPPORTED_EXTENSIONS } from './office2md/index.js';
export type { ConvertOptions } from './office2md/index.js';

import { ToolRegistry } from './tool-registry.js';
import { ReadFileTool } from './read-file.js';
import { ListFilesTool } from './list-files.js';
import { WriteFileTool } from './write-file.js';
import { ReplaceInFileTool } from './replace-in-file.js';
import { RemoveLineTool } from './remove-line.js';
import { GrepInFilesTool } from './grep-in-files.js';
import { ExecuteCommandTool } from './execute-command.js';
import { TerminalOpenTool } from './terminal/terminal-open.js';
import { TerminalSendTool } from './terminal/terminal-send.js';
import { TerminalCloseTool } from './terminal/terminal-close.js';
import { TerminalPollTool } from './terminal/terminal-poll.js';
import { TerminalSessionManager } from './terminal/session-manager.js';
import { WebSearchTool } from './web/web-search-tool.js';
import { WebFetchTool } from './web/web-fetch-tool.js';
import { SqlExecuteTool } from './database/sql-execute-tool.js';
import { BrowserSessionTool } from './browser/browser-session-tool.js';
import { BrowserMouseClickTool } from './browser/browser-mouse-click-tool.js';
import { BrowserInputTool } from './browser/browser-input-tool.js';
import { BrowserScreenshotTool } from './browser/browser-screenshot-tool.js';
import { BrowserEvaluateTool } from './browser/browser-evaluate-tool.js';
import { BrowserExtractTool } from './browser/browser-extract-tool.js';
import { BrowserWaitTool } from './browser/browser-wait-tool.js';
import { BrowserQueryTool } from './browser/browser-query-tool.js';
import { BrowserStorageTool } from './browser/browser-storage-tool.js';
import { BrowserInteractTool } from './browser/browser-interact-tool.js';
import { BrowserDragTool } from './browser/browser-drag-tool.js';
import { BrowserApiRequestTool } from './browser/browser-api-request-tool.js';
import { BrowserDebugTool } from './browser/browser-debug-tool.js';
import { BrowserFileTool } from './browser/browser-file-tool.js';
import { Office2MdTool } from './office2md/index.js';
import type { ProxyConfig, WebSearchConfig, WebFetchConfig } from '@xai/shared';
import type { BrowserHtmlFetcher } from './web/providers/search-provider.js';


export function createDefaultRegistry(
  workspacePath: string,
  options?: {
    onCommandOutput?: (commandId: string, outputType: 'stdout' | 'stderr', data: string) => void;
    proxyConfig?: ProxyConfig;
    terminalSessionManager?: TerminalSessionManager;
    webSearchConfig?: WebSearchConfig;
    webFetchConfig?: WebFetchConfig;
    ipcSend?: (channel: string, data: unknown) => Promise<unknown>;
    browserFetcher?: BrowserHtmlFetcher;
  }
): ToolRegistry {
  const registry = new ToolRegistry();

  registry.register(new ReadFileTool(workspacePath));
  registry.register(new ListFilesTool(workspacePath));
  registry.register(new WriteFileTool(workspacePath));
  registry.register(new ReplaceInFileTool(workspacePath));
  registry.register(new RemoveLineTool(workspacePath));
  registry.register(new GrepInFilesTool(workspacePath));
  registry.register(new Office2MdTool(workspacePath));
  const execTool = new ExecuteCommandTool(workspacePath, options?.onCommandOutput);
  execTool.setProxyConfig(options?.proxyConfig || null);
  registry.register(execTool);

  // Database tool — executes SQL via the db-gateway service (default
  // http://localhost:8088). confirmationRequired is true, so the AI's SQL
  // runs only after explicit user approval.
  registry.register(new SqlExecuteTool());

  // Terminal session tools
  const terminalManager = options?.terminalSessionManager ?? new TerminalSessionManager(workspacePath);
  registry.register(new TerminalOpenTool(terminalManager));
  registry.register(new TerminalSendTool(terminalManager));
  registry.register(new TerminalCloseTool(terminalManager));
  registry.register(new TerminalPollTool(terminalManager));

  // Web tools
  if (options?.webSearchConfig?.enabled !== false) {
    const webSearchTool = new WebSearchTool(options?.webSearchConfig);
    if (options?.ipcSend) {
      webSearchTool.setIpcSender(options.ipcSend);
    }
    if (options?.browserFetcher) {
      webSearchTool.setBrowserFetcher(options.browserFetcher);
    }
    registry.register(webSearchTool);
  }

  if (options?.webFetchConfig?.enabled !== false) {
    const webFetchTool = new WebFetchTool(options?.webFetchConfig);
    if (options?.ipcSend) {
      webFetchTool.setIpcSender(options.ipcSend);
    }
    registry.register(webFetchTool);
  }

  // Browser tools (CDP-based browser automation) — 11 tools (merged from 21)
  const browserTools = [
    new BrowserSessionTool(),
    new BrowserMouseClickTool(),
    new BrowserInputTool(),
    // TODO: BrowserScreenshotTool 暂时禁用 — 需要多模态 Message 支持后 AI 才能"看"图片
    // new BrowserScreenshotTool(),
    new BrowserEvaluateTool(),
    new BrowserExtractTool(),
    new BrowserWaitTool(),
    new BrowserQueryTool(),
    new BrowserStorageTool(),
    new BrowserInteractTool(),
    new BrowserDragTool(),
    new BrowserApiRequestTool(),
    new BrowserDebugTool(),
    new BrowserFileTool(),
  ];
  for (const tool of browserTools) {
    if (options?.ipcSend) {
      tool.setIpcSender(options.ipcSend);
    }
    registry.register(tool);
  }

  return registry;
}
