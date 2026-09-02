import { EventEmitter } from 'events';
import type { MCPServerConfig, MCPToolInfo } from '@xai/shared';
import { MCPClient } from './mcp-client.js';
import { MCPTool } from '../tools/mcp-tool.js';
import { ToolSearchTool } from '../tools/tool-search-tool.js';
import type { ToolRegistry } from '../tools/tool-registry.js';

export interface MCPServerStatus {
  name: string;
  connected: boolean;
  toolCount: number;
  error?: string;
}

export class MCPManager extends EventEmitter {
  private clients: Map<string, MCPClient> = new Map();
  private registry: ToolRegistry | null = null;
  private _configs: MCPServerConfig[] = [];
  private toolSearchTool: ToolSearchTool | null = null;

  get configs(): MCPServerConfig[] {
    return this._configs;
  }

  getAllToolInfos(): MCPToolInfo[] {
    const tools: MCPToolInfo[] = [];
    for (const client of this.clients.values()) {
      if (client.connected) {
        tools.push(...client.tools);
      }
    }
    return tools;
  }

  async initialize(configs: MCPServerConfig[], registry: ToolRegistry): Promise<void> {
    this.registry = registry;
    this._configs = configs;

    const enabledConfigs = configs.filter(c => c.enabled);
    if (enabledConfigs.length === 0) return;

    this.toolSearchTool = new ToolSearchTool(() => this.getAllToolInfos());

    const results = await Promise.allSettled(
      enabledConfigs.map(config => this.startServer(config))
    );

    let hasMCPTools = false;
    for (const client of this.clients.values()) {
      if (client.connected && client.tools.length > 0) {
        hasMCPTools = true;
        break;
      }
    }

    if (hasMCPTools && this.toolSearchTool) {
      registry.register(this.toolSearchTool);
    }

    const statuses = this.getServerStatuses();
    this.emit('initialized', statuses);

    for (let i = 0; i < results.length; i++) {
      if (results[i].status === 'fulfilled') {
        console.log(`[MCPManager] Server "${enabledConfigs[i].name}" started successfully`);
      } else {
        console.error(`[MCPManager] Server "${enabledConfigs[i].name}" failed:`, (results[i] as PromiseRejectedResult).reason);
      }
    }
  }

  async startServer(config: MCPServerConfig): Promise<void> {
    const existing = this.clients.get(config.name);
    if (existing) {
      existing.kill();
      this.clients.delete(config.name);
    }

    const client = new MCPClient(config);
    this.clients.set(config.name, client);

    try {
      await client.connect();

      if (client.tools.length > 0 && this.registry) {
        for (const toolInfo of client.tools) {
          const mcpTool = new MCPTool(client, toolInfo.name, toolInfo.description, toolInfo.parameters);
          try {
            this.registry.register(mcpTool);
          } catch (err) {
            console.warn(`[MCPManager] Tool "${toolInfo.name}" already registered, skipping`);
          }
        }
      }

      this.emit('serverStarted', { name: config.name, toolCount: client.tools.length });
    } catch (err) {
      console.error(`[MCPManager] Failed to start server "${config.name}":`, err);
      this.emit('serverError', { name: config.name, error: String(err) });
      throw err;
    }
  }

  async stopServer(name: string): Promise<void> {
    const client = this.clients.get(name);
    if (!client) return;

    for (const toolInfo of client.tools) {
      this.registry?.unregister(toolInfo.name);
    }

    client.kill();
    this.clients.delete(name);
    this.emit('serverStopped', { name });
  }

  async restartServer(config: MCPServerConfig): Promise<void> {
    await this.stopServer(config.name);
    await this.startServer(config);
  }

  ensureToolSearchRegistered(registry: ToolRegistry): void {
    const hasMCPTools = Array.from(this.clients.values()).some(c => c.connected && c.tools.length > 0);

    if (hasMCPTools) {
      if (!this.toolSearchTool) {
        this.toolSearchTool = new ToolSearchTool(() => this.getAllToolInfos());
      }
      if (!registry.has('tool_search')) {
        registry.register(this.toolSearchTool);
      }
    } else {
      if (registry.has('tool_search')) {
        registry.unregister('tool_search');
      }
      this.toolSearchTool = null;
    }
  }

  async shutdown(): Promise<void> {
    for (const [name] of this.clients) {
      await this.stopServer(name);
    }

    if (this.toolSearchTool && this.registry) {
      this.registry.unregister('tool_search');
    }

    this.toolSearchTool = null;
    this.registry = null;
  }

  async reload(configs: MCPServerConfig[]): Promise<void> {
    await this.shutdown();
    if (this.registry) {
      await this.initialize(configs, this.registry);
    }
  }

  getServerStatuses(): MCPServerStatus[] {
    const statuses: MCPServerStatus[] = [];

    for (const config of this._configs) {
      const client = this.clients.get(config.name);
      if (client) {
        statuses.push({
          name: config.name,
          connected: client.connected,
          toolCount: client.tools.length,
        });
      } else {
        statuses.push({
          name: config.name,
          connected: false,
          toolCount: 0,
          error: config.enabled ? 'Not started' : 'Disabled',
        });
      }
    }

    return statuses;
  }
}
