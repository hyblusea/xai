import { ToolDefinition, ToolResult } from '@xai/shared';
import { BaseTool } from '../base-tool.js';
import type { TerminalSessionManager } from './session-manager.js';

export class TerminalOpenTool extends BaseTool {
  private manager: TerminalSessionManager;

  constructor(manager: TerminalSessionManager) {
    super();
    this.manager = manager;
  }

  get definition(): ToolDefinition {
    return {
      name: 'terminal_open',
      description: 'Open a persistent terminal session (cmd/PowerShell). Returns sessionId. Use for SSH, REPLs, etc.',
      parameters: {
        shell: {
          type: 'string',
          description: 'Shell type. Default: auto-detect.',
          enum: ['cmd', 'powershell'],
          location: 'header',
        },
        cwd: {
          type: 'string',
          description: 'Working directory (default: workspace root)',
          location: 'header',
        },
      },
      confirmationRequired: true,
      examples: [
        `++++ terminal_open shell:powershell cwd:./packages/core
++++ end`,
      ],
    };
  }

  async _execute(params: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
    const start = Date.now();
    try {
      const shell = params.shell as string | undefined;
      const cwd = params.cwd as string | undefined;

      const result = await this.manager.spawn({
        shell: shell as any,
        cwd,
      });

      const activeSessions = this.manager.listSessions();
      const sessionList = activeSessions
        .filter((s) => s.status === 'active')
        .map((s) => '  ' + s.id + ' [' + s.shell + '] ' + s.cwd)
        .join('\n');

      const output = [
        'Session opened: ' + result.sessionId,
        'Shell: ' + result.shell,
        'Active sessions: ' + activeSessions.filter((s) => s.status === 'active').length,
        '',
        'Initial output:',
        result.initialOutput || '(no output)',
        '',
        'Use terminal_send to send commands to this session.',
        'Use terminal_close when done.',
        '',
        'All active sessions:\n' + sessionList,
      ].join('\n');

      return this.success(output, Date.now() - start);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return this.fail('Failed to open terminal session: ' + message, Date.now() - start);
    }
  }
}