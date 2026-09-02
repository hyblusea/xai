import type { ToolDefinition } from '@xai/shared';

export function buildSystemPrompt(tools: ToolDefinition[], workspacePath: string): string {
  return [
    buildIdentitySection(),
    buildToolCallFormatSection(),
    ...buildToolsSection(tools),
    buildWorkspaceSection(workspacePath),
    buildGuidelinesSection(),
  ].join('\n\n');
}

/**
 * Build a minimal system prompt that includes ONLY text-mode tools
 * (contentMode: 'text') in ++++ format.
 * Used in hybrid mode: native function calling handles simple-parameter tools,
 * while text-mode tools go through AiderStyleParser to avoid JSON escaping issues.
 */
export function buildContentToolsPrompt(
  allTools: ToolDefinition[],
  workspacePath: string,
): string {
  const contentTools = allTools.filter(t => t.contentMode === 'text');
  if (contentTools.length === 0) {
    return `## WORKSPACE\n\nPath: ${workspacePath}\nAll file paths are relative to this path.`;
  }
  return [
    buildToolCallFormatSection(),
    ...buildToolsSection(contentTools),
    buildWorkspaceSection(workspacePath),
  ].join('\n\n');
}

function buildIdentitySection(): string {
  return `You are an AI coding assistant.`;
}

function buildToolCallFormatSection(): string {
  return ``;
}

function buildToolsSection(tools: ToolDefinition[]): string[] {
  if (tools.length === 0) {
    return [``];
  }

  const toolEntries = tools.map((tool) => {
    const params = Object.entries(tool.parameters)
      .map(([name, param]) => formatParam(name, param))
      .join('\n');

    let entry = `### ${tool.name}\n${tool.description}`;
    if (params) {
      entry += `\n\nParameters:\n${params}`;
    }
    if (tool.examples && tool.examples.length > 0) {
      entry += '\n\nExamples:\n' + tool.examples.join('\n');
    }
    return entry;
  });

  return [`## EXTENDED TOOL CALL RULE Example:
++++ tool_name headerParam1:value1 headerParam2:value2
body content here (free-form text, can be multiple lines)
++++ end 

## EXTENDED TOOL LIST. \n`, ...toolEntries];
}

function formatParam(name: string, param: { type?: string; description?: string; required?: boolean; default?: unknown; enum?: string[]; location?: string }): string {
  const parts: string[] = [`- ${name}`];
  if (param.type) parts.push(`(${param.type})`);
  if (param.location === 'body') parts.push('[body]');
  if (param.required) parts.push('[required]');
  if (param.default !== undefined) parts.push(`[default: ${JSON.stringify(param.default)}]`);
  if (param.enum) parts.push(`[enum: ${param.enum.join(',')}]`);
  parts.push(`- ${param.description || ''}`);
  return '  ' + parts.join(' ');
}

function buildWorkspaceSection(workspacePath: string): string {
  return `## WORKSPACE\n\nPath: ${workspacePath}\nAll file paths are relative to this path.`;
}

function buildGuidelinesSection(): string {
  return ``;
}

