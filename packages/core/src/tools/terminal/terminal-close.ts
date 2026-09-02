import { ToolDefinition, ToolResult } from '@xai/shared';
import { BaseTool } from '../base-tool.js';
import type { TerminalSessionManager } from './session-manager.js';

export class TerminalCloseTool extends BaseTool {
  private manager: TerminalSessionManager;

  constructor(manager: TerminalSessionManager) {
    super();
    this.manager = manager;
  }

  get definition(): ToolDefinition {
    return {
      name: 'terminal_close',
      description: 'Close a terminal session. Auto-closes after 10min idle.',
      parameters: {
        sessionId: {
          type: 'string',
          description: 'Session ID to close',
          required: true,
          location: 'header',
        },
      },
      confirmationRequired: false,
    };
  }

  async _execute(params: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
    const start = Date.now();
    try {
      const sessionId = params.sessionId as string;

      if (!sessionId || !sessionId.trim()) {
        return this.fail('sessionId is required', Date.now() - start);
      }

      const isActive = this.manager.isSessionActive(sessionId);
      await this.manager.close(sessionId);

      const remaining = this.manager
        .listSessions()
        .filter((s) => s.status === 'active');

      const output = [
        isActive
          ? 'Session ' + sessionId + ' closed.'
          : 'Session ' + sessionId + ' was already closed.',
        '',
        'Active sessions: ' + remaining.length,
        ...remaining.map((s) => '  ' + s.id + ' [' + s.shell + '] ' + s.cwd),
      ].join('\n');

      return this.success(output, Date.now() - start);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return this.fail('Failed to close session: ' + message, Date.now() - start);
    }
  }
}