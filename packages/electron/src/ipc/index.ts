/**
 * IPC handler registry — registers all IPC handlers by delegating to domain-specific modules.
 */
import type { IpcDeps } from './types.js';
import { registerWindowHandlers } from './window-handlers.js';
import { registerAgentHandlers } from './agent-handlers.js';
import { registerConfigHandlers } from './config-handlers.js';
import { registerTerminalHandlers } from './terminal-handlers.js';
import { registerFileHandlers } from './file-handlers.js';
import { registerLLMHandlers } from './llm-handlers.js';
import { registerDBHandlers } from './db-handlers.js';
import { registerGitHandlers } from './git-handlers.js';
import { registerMCPHandlers } from './mcp-handlers.js';
import { registerMQTTHandlers } from './mqtt-handlers.js';
import { registerWebHandlers } from './web-handlers.js';
import { registerOCRHandlers } from './ocr-handlers.js';
import { registerOffice2MdHandlers } from './office2md-handlers.js';
import { registerDevEcoAuthHandlers } from './deveco-auth-handlers.js';
import { registerClineAuthHandlers } from './cline-auth-handlers.js';
import { registerFreebuffAuthHandlers } from './freebuff-auth-handlers.js';
import { registerDesignerHandlers } from './designer-handlers.js';
import { registerAuthHandlers } from './auth-handlers.js';
import { registerLSPHandlers } from './lsp-handlers.js';

export function registerAllIpcHandlers(deps: IpcDeps): void {
  registerWindowHandlers(deps);
  registerAgentHandlers(deps);
  registerConfigHandlers(deps);
  registerTerminalHandlers(deps);
  registerFileHandlers(deps);
  registerLLMHandlers(deps);
  registerDBHandlers(deps);
  registerGitHandlers(deps);
  registerMCPHandlers(deps);
  registerMQTTHandlers(deps);
  registerWebHandlers(deps);
  registerOCRHandlers(deps);
  registerOffice2MdHandlers(deps);
  registerDevEcoAuthHandlers(deps);
  registerClineAuthHandlers(deps);
  registerFreebuffAuthHandlers(deps);
  registerDesignerHandlers(deps);
  registerAuthHandlers(deps);
  registerLSPHandlers();
}
