import { BaseTool } from './base-tool.js';
import type { ToolDefinition, ToolResult } from '@xai/shared';
import type { MCPClient } from '../mcp/mcp-client.js';

export class MCPTool extends BaseTool {
  private client: MCPClient;
  private _definition: ToolDefinition;

  constructor(client: MCPClient, toolName: string, description: string, parameters: ToolDefinition['parameters']) {
    super();
    this.client = client;
    this._definition = {
      name: toolName,
      description: `[MCP:${client.serverName}] ${description}`,
      parameters,
      confirmationRequired: false,
    };
  }

  get definition(): ToolDefinition {
    return this._definition;
  }

  async _execute(params: Record<string, unknown>, _signal?: AbortSignal): Promise<ToolResult> {
    const startTime = Date.now();
    try {
      const result = await this.client.callTool(this._definition.name, params);
      const output = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
      return { toolName: this._definition.name, success: true, output, executionTime: Date.now() - startTime };
    } catch (err) {
      return { toolName: this._definition.name, success: false, output: String(err), error: String(err), executionTime: Date.now() - startTime };
    }
  }
}
