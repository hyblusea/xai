import { BaseTool } from './base-tool.js';
import type { ToolDefinition, ToolResult, MCPToolInfo } from '@xai/shared';

export class ToolSearchTool extends BaseTool {
  private getMCPTools: () => MCPToolInfo[];

  constructor(getMCPTools: () => MCPToolInfo[]) {
    super();
    this.getMCPTools = getMCPTools;
  }

  get definition(): ToolDefinition {
    return {
      name: 'tool_search',
      description: 'Search MCP tools by keyword.',
      parameters: {
        query: {
          type: 'string',
          description: 'Search keyword',
          required: true,
        },
      },
      confirmationRequired: false,
    };
  }

  async _execute(params: Record<string, unknown>, _signal?: AbortSignal): Promise<ToolResult> {
    const query = String(params.query || '').toLowerCase();
    if (!query) {
      return this.fail('query parameter is required');
    }

    const allTools = this.getMCPTools();
    if (allTools.length === 0) {
      return this.success('No MCP tools available.');
    }

    const matches = allTools.filter((tool) => {
      const nameMatch = tool.name.toLowerCase().includes(query);
      const descMatch = tool.description.toLowerCase().includes(query);
      const serverMatch = tool.serverName.toLowerCase().includes(query);
      return nameMatch || descMatch || serverMatch;
    });

    if (matches.length === 0) {
      const toolNames = allTools.map(t => `${t.name} (${t.serverName})`).join(', ');
      return this.success(`No tools matched "${params.query}". Available MCP tools: ${toolNames}`);
    }

    const results = matches.map((tool) => {
      const paramsList = Object.entries(tool.parameters)
        .map(([name, p]) => {
          const req = p.required ? ' [required]' : '';
          return `    - ${name} (${p.type})${req}: ${p.description || ''}`;
        })
        .join('\n');

      return `### ${tool.name}\n  Server: ${tool.serverName}\n  ${tool.description}${paramsList ? '\n  Parameters:\n' + paramsList : ''}`;
    }).join('\n\n');

    return this.success(`Found ${matches.length} MCP tool(s):\n\n${results}`);
  }
}
