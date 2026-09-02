import { ToolDefinition, ToolResult } from '@xai/shared';
import { BaseTool } from '../base-tool.js';
import type { TerminalSessionManager } from './session-manager.js';

export class TerminalSendTool extends BaseTool {
  private manager: TerminalSessionManager;

  constructor(manager: TerminalSessionManager) {
    super();
    this.manager = manager;
  }

  get definition(): ToolDefinition {
    return {
      name: 'terminal_send',
      description: 'Send command to terminal session. Output auto-cleaned. background:true for long-running, interactive:true for SSH/REPL.',
      parameters: {
        sessionId: {
          type: 'string',
          description: 'Session ID from terminal_open',
          required: true,
          location: 'header',
        },
        timeout: {
          type: 'number',
          description: 'Timeout in ms (default: 30000)',
          location: 'header',
        },
        background: {
          type: 'boolean',
          description: 'Run in background, poll with terminal_poll',
          location: 'header',
        },
        interactive: {
          type: 'boolean',
          description: 'For interactive commands (SSH/REPL)',
          location: 'header',
        },
        command: {
          type: 'string',
          description: 'Command to execute',
          required: true,
          location: 'body',
        },
      },
      confirmationRequired: true,
      examples: [
        `++++ terminal_send sessionId:term-abc123 timeout:30000
npm run build
++++ end`,
      ],
    };
  }

  async _execute(params: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
    const start = Date.now();
    try {
      const sessionId = params.sessionId as string;
      const command = params.command as string;
      const timeout = typeof params.timeout === 'number' ? params.timeout : undefined;
      const background = params.background === true;
      const interactive = params.interactive === true;

      if (!sessionId || !sessionId.trim()) {
        return this.fail('sessionId is required', Date.now() - start);
      }

      if (!command || !command.trim()) {
        return this.fail('command is required', Date.now() - start);
      }

      if (!this.manager.isSessionActive(sessionId)) {
        const sessions = this.manager.listSessions();
        const activeList = sessions
          .filter((s) => s.status === 'active')
          .map((s) => '  ' + s.id + ' [' + s.shell + ']')
          .join('\n');

        return this.fail(
          'Session "' + sessionId + '" not found or closed.\nActive sessions:\n' + (activeList || '  (none)'),
          Date.now() - start,
        );
      }

      const result = await this.manager.send(sessionId, command, { timeout, background, interactive, signal });

      const statusLabel = background && result.status === 'completed'
        ? 'COMPLETED IMMEDIATELY (possible error — check output below)'
        : result.status === 'completed'
          ? 'completed'
          : result.status === 'still_running'
            ? 'STILL RUNNING (use terminal_poll to check)'
            : result.status;

      const lines = [
        'Session: ' + sessionId,
        'Command: ' + command,
        'Status: ' + statusLabel,
        '',
      ];

      if (result.status === 'still_running') {
        if (interactive) {
          lines.push('NOTE: Interactive command is still running and waiting for input.');
          lines.push('To send input (e.g. a password), use:');
          lines.push('  terminal_send sessionId:' + sessionId + ' interactive:true');
          lines.push('  <your input here>');
          lines.push('++++ end');
        } else {
          lines.push('NOTE: The command timed out but is still executing in the terminal.');
          lines.push('To get the final result without repeated polling, use:');
          lines.push('  terminal_poll sessionId:' + sessionId + ' wait:true');
          lines.push('Or check current progress with:');
          lines.push('  terminal_poll sessionId:' + sessionId);
        }
        lines.push('');
      }

      if (background && result.status === 'completed') {
        lines.push('NOTE: Background command completed immediately. This usually means an error');
        lines.push('occurred (e.g. syntax error, garbled command text). Review the output below.');
        lines.push('');
      }

      lines.push('Output:');
      lines.push(result.output || '(command completed successfully with no output)');

      const toolResult = this.success(lines.join('\n'), Date.now() - start);
      // Mark still_running as not a failure but not a typical success either
      if (result.status === 'still_running') {
        toolResult.success = true;
      }
      return toolResult;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return this.fail('Command failed: ' + message, Date.now() - start);
    }
  }
}