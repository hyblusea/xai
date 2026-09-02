/**
 * MCP (Model Context Protocol) IPC handlers.
 */
import { ipcMain } from 'electron';
import { IPCChannel } from '@xai/shared';
import type { MCPServerConfig } from '@xai/shared';
import type { IpcDeps } from './types.js';

export function registerMCPHandlers(deps: IpcDeps): void {
  ipcMain.handle(IPCChannel.MCPList, async () => {
    return deps.mcpManager.getServerStatuses();
  });

  ipcMain.handle(IPCChannel.MCPAdd, async (_event, serverConfig: MCPServerConfig) => {
    try {
      if (!deps.sessionConfig.mcpServers) {
        deps.sessionConfig.mcpServers = [];
      }
      const existing = deps.sessionConfig.mcpServers.find(s => s.name === serverConfig.name);
      if (existing) {
        return { success: false, error: `Server "${serverConfig.name}" already exists` };
      }
      deps.sessionConfig.mcpServers.push(serverConfig);
      const { configManager } = await import('../config.js');
      await configManager.saveConfig(deps.sessionConfig);

      if (serverConfig.enabled && deps.toolRegistry) {
        if (!deps.mcpManager['registry']) {
          const { MCPManager } = await import('@xai/core');
          deps.mcpManager = new MCPManager();
          await deps.mcpManager.initialize(deps.sessionConfig.mcpServers, deps.toolRegistry);
        } else {
          try {
            await deps.mcpManager.startServer(serverConfig);
            deps.mcpManager.ensureToolSearchRegistered(deps.toolRegistry);
          } catch (err) {
            deps.logToRenderer('error', `Failed to start MCP server "${serverConfig.name}": ${String(err)}`);
          }
        }
      }

      return { success: true };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle(IPCChannel.MCPUpdate, async (_event, name: string, updates: Partial<MCPServerConfig>) => {
    try {
      if (!deps.sessionConfig.mcpServers) {
        return { success: false, error: 'No MCP servers configured' };
      }
      const index = deps.sessionConfig.mcpServers.findIndex(s => s.name === name);
      if (index === -1) {
        return { success: false, error: `Server "${name}" not found` };
      }
      const wasEnabled = deps.sessionConfig.mcpServers[index].enabled;
      deps.sessionConfig.mcpServers[index] = { ...deps.sessionConfig.mcpServers[index], ...updates };
      const { configManager } = await import('../config.js');
      await configManager.saveConfig(deps.sessionConfig);
      const updated = deps.sessionConfig.mcpServers[index];

      if (deps.toolRegistry && deps.mcpManager['registry']) {
        if (wasEnabled && !updated.enabled) {
          await deps.mcpManager.stopServer(name).catch(() => {});
          deps.mcpManager.ensureToolSearchRegistered(deps.toolRegistry);
        } else if (!wasEnabled && updated.enabled) {
          try {
            await deps.mcpManager.startServer(updated);
            deps.mcpManager.ensureToolSearchRegistered(deps.toolRegistry);
          } catch (err) {
            deps.logToRenderer('error', `Failed to start MCP server "${name}": ${String(err)}`);
          }
        } else if (updated.enabled) {
          await deps.mcpManager.restartServer(updated).catch(() => {});
          deps.mcpManager.ensureToolSearchRegistered(deps.toolRegistry);
        }
      }

      return { success: true };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle(IPCChannel.MCPRemove, async (_event, name: string) => {
    try {
      if (!deps.sessionConfig.mcpServers) {
        return { success: false, error: 'No MCP servers configured' };
      }
      deps.sessionConfig.mcpServers = deps.sessionConfig.mcpServers.filter(s => s.name !== name);
      const { configManager } = await import('../config.js');
      await configManager.saveConfig(deps.sessionConfig);

      await deps.mcpManager.stopServer(name).catch(() => {});
      if (deps.toolRegistry) {
        deps.mcpManager.ensureToolSearchRegistered(deps.toolRegistry);
      }

      return { success: true };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle(IPCChannel.MCPServerStatus, async () => {
    return deps.mcpManager.getServerStatuses();
  });
}
