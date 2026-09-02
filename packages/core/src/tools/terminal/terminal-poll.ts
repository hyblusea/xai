import { ToolDefinition, ToolResult } from '@xai/shared';
import { BaseTool } from '../base-tool.js';
import type { TerminalSessionManager } from './session-manager.js';

export class TerminalPollTool extends BaseTool {
  private manager: TerminalSessionManager;

  constructor(manager: TerminalSessionManager) {
    super();
    this.manager = manager;
  }

  get definition(): ToolDefinition {
    return {
      name: 'terminal_poll',
      description: 'Poll terminal session for command result. Use wait:true to block until complete.',
      parameters: {
        sessionId: {
          type: 'string',
          description: 'Session ID to poll',
          required: true,
          location: 'header',
        },
        wait: {
          type: 'boolean',
          description: 'Block until command completes (default: false)',
          location: 'header',
        },
        timeout: {
          type: 'number',
          description: 'Max wait time in ms when wait:true (default: 120000)',
          location: 'header',
        },
        lines: {
          type: 'number',
          description: 'Number of recent output lines to return (default: 40, 0 shows all)',
          location: 'header',
        },
      },
      confirmationRequired: false,
      examples: [
        `++++ terminal_poll sessionId:term-abc123 wait:true timeout:60000 lines:50
++++ end`,
      ],
    };
  }

  async _execute(params: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
    const start = Date.now();
    try {
      const sessionId = params.sessionId as string;
      const wait = params.wait === true;
      const timeout = typeof params.timeout === 'number' ? params.timeout : undefined;
      // 新增：解析 lines 参数，默认 40 行，0 或负数表示显示全部
      const rawLines = params.lines;
      const maxLines = typeof rawLines === 'number' && rawLines > 0 ? rawLines : 0; // 0 代表全量

      if (!sessionId || !sessionId.trim()) {
        return this.fail('sessionId is required', Date.now() - start);
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

      const result = wait
        ? await this.manager.waitUntilComplete(sessionId, { timeout, signal })
        : await this.manager.poll(sessionId);

      const statusLabel = result.status === 'completed'
        ? 'COMPLETED'
        : result.status === 'still_running'
          ? 'STILL RUNNING'
          : result.status.toUpperCase();

      const lines: string[] = [
        'Session: ' + sessionId,
        'Status: ' + statusLabel,
        '',
      ];

      if (result.status === 'still_running') {
        if (wait) {
          lines.push('The command is still executing after the wait timeout. You can:');
          lines.push('- Poll again with wait:true and a longer timeout');
          lines.push('- Poll without wait to check current progress');
        } else {
          lines.push('The command is still executing. Use wait:true to block until it finishes,');
          lines.push('or poll again later for updates.');
        }
        lines.push('');
      }

      // 处理输出，按需截取最后 N 行
      const rawOutput = result.output || '';
      if (rawOutput) {
        const allLines = rawOutput.split('\n');
        let displayOutput: string;

        if (maxLines > 0 && allLines.length > maxLines) {
          // 截取最后 maxLines 行，并在开头加省略提示
          const truncated = allLines.slice(-maxLines).join('\n');
          displayOutput = `... (showing last ${maxLines} lines of ${allLines.length} total)\n${truncated}`;
        } else {
          // 显示全部
          displayOutput = rawOutput;
        }

        lines.push('Output:');
        lines.push(displayOutput);
      } else {
        lines.push('Output:');
        lines.push('(no output)');
      }

      return this.success(lines.join('\n'), Date.now() - start);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return this.fail('Poll failed: ' + message, Date.now() - start);
    }
  }
}