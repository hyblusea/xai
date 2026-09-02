import { ToolDefinition } from '@xai/shared';
import { BrowserBaseTool } from './browser-base-tool.js';

export class BrowserDebugTool extends BrowserBaseTool {
  get definition(): ToolDefinition {
    return {
      name: 'browser_debug',
      description: 'Debug: console (capture/filter/clear logs), network (monitor requests), dialog (handle alert/confirm/prompt).',
      parameters: {
        sessionId: { type: 'string', description: 'Browser session ID', required: true, location: 'header' },
        target: { type: 'string', description: 'Debug target: console, network, dialog', required: true, location: 'header' },
        action: { type: 'string', description: 'Action: console(start/stop/list/clear), network(start/stop/list/clear), dialog(list/accept/dismiss/set-auto/clear-auto)', required: true, location: 'header' },
        level: { type: 'string', description: 'Console log level: log, warn, error, info, debug', required: false, location: 'header' },
        filter: { type: 'string', description: 'URL substring filter (network list)', required: false, location: 'header' },
        promptText: { type: 'string', description: 'Text for prompt dialogs, or "dismiss" for set-auto', required: false, location: 'body' },
      },
      confirmationRequired: false,
      examples: [
        `++++ browser_debug sessionId:br-abc123 target:dialog action:set-auto promptText:dismiss
++++ end`,
      ],
    };
  }

  async _execute(params: Record<string, unknown>, _signal?: AbortSignal) {
    const start = Date.now();
    try {
      const sessionId = params.sessionId as string;
      const target = params.target as string;
      const action = params.action as string;

      if (!sessionId || !target || !action) {
        return this.fail('sessionId, target, and action parameters are required', Date.now() - start);
      }

      if (!['console', 'network', 'dialog'].includes(target)) {
        return this.fail('target must be console, network, or dialog', Date.now() - start);
      }

      if (target === 'console') {
        return this.handleConsole(sessionId, action, params, start);
      }
      if (target === 'network') {
        return this.handleNetwork(sessionId, action, params, start);
      }
      return this.handleDialog(sessionId, action, params, start);
    } catch (error) {
      return this.fail(`browser_debug failed: ${error instanceof Error ? error.message : String(error)}`, Date.now() - start);
    }
  }

  private async handleConsole(sessionId: string, action: string, params: Record<string, unknown>, start: number) {
    if (!['start', 'stop', 'list', 'clear'].includes(action)) {
      return this.fail('console action must be start, stop, list, or clear', Date.now() - start);
    }

    const level = params.level as string | undefined;
    const result = await this.invokeIPC<{ data?: unknown }>('browser:console', { sessionId, action, level });

    if (action === 'start' || action === 'stop' || action === 'clear') {
      const label = action === 'start' ? 'started' : action === 'stop' ? 'stopped' : 'cleared';
      return this.success(`Console monitoring ${label}`, Date.now() - start);
    }

    // list
    const logs = (result.data as Array<{ level: string; text: string; timestamp: number; url?: string; line?: number }>) || [];
    if (logs.length === 0) return this.success('No console logs captured.', Date.now() - start);

    const output = logs.map((log, i) => {
      const loc = log.url ? ` (${log.url}${log.line ? `:${log.line}` : ''})` : '';
      return `[${i}] [${log.level.toUpperCase()}] ${log.text}${loc}`;
    }).join('\n');

    return this.success(`Console logs (${logs.length} entries):\n${output}`, Date.now() - start);
  }

  private async handleNetwork(sessionId: string, action: string, params: Record<string, unknown>, start: number) {
    if (!['start', 'stop', 'list', 'clear'].includes(action)) {
      return this.fail('network action must be start, stop, list, or clear', Date.now() - start);
    }

    const filter = params.filter as string | undefined;
    const result = await this.invokeIPC<{ data?: unknown }>('browser:network', { sessionId, action, filter });

    if (action === 'start' || action === 'stop' || action === 'clear') {
      const label = action === 'start' ? 'started' : action === 'stop' ? 'stopped' : 'cleared';
      return this.success(`Network monitoring ${label}`, Date.now() - start);
    }

    // list
    const output = typeof result.data === 'string' ? result.data : JSON.stringify(result.data, null, 2);
    return this.success(`Network requests:\n${output}`, Date.now() - start);
  }

  private async handleDialog(sessionId: string, action: string, params: Record<string, unknown>, start: number) {
    if (!['list', 'accept', 'dismiss', 'set-auto', 'clear-auto'].includes(action)) {
      return this.fail('dialog action must be list, accept, dismiss, set-auto, or clear-auto', Date.now() - start);
    }

    const promptText = params.promptText as string | undefined;
    const result = await this.invokeIPC<{ data?: unknown }>('browser:dialog', { sessionId, action, promptText });

    if (action === 'list') {
      const dialogs = (result.data as Array<{ type: string; message: string }>) || [];
      if (dialogs.length === 0) return this.success('No pending dialogs.', Date.now() - start);
      const output = dialogs.map((d, i) => `[${i}] type=${d.type} message="${d.message}"`).join('\n');
      return this.success(`Pending dialogs (${dialogs.length}):\n${output}`, Date.now() - start);
    }

    if (action === 'accept' || action === 'dismiss') {
      const data = result.data as { type: string; action: string };
      return this.success(`Dialog ${data.action}: type=${data.type}`, Date.now() - start);
    }

    if (action === 'set-auto') {
      return this.success('Auto-respond mode enabled for future dialogs.', Date.now() - start);
    }

    return this.success('Auto-respond mode cleared.', Date.now() - start);
  }
}
