import { randomUUID } from 'crypto';
import { ToolDefinition } from '@xai/shared';
import { BrowserBaseTool } from './browser-base-tool.js';

export class BrowserSessionTool extends BrowserBaseTool {
  get definition(): ToolDefinition {
    return {
      name: 'browser_session',
      description: 'Manage sessions: open (new tab, returns sessionId), navigate (change URL), close (close tab).',
      parameters: {
        sessionId: { type: 'string', description: 'Session ID (required for navigate/close, auto for open)', required: false, location: 'header' },
        action: { type: 'string', description: 'Action: open, navigate, close', required: true, location: 'header' },
        url: { type: 'string', description: 'URL (required for open/navigate)', required: false, location: 'header' },
      },
      confirmationRequired: false,
      examples: [
        `++++ browser_session action:open url:https://example.com
++++ end`,
      ],
    };
  }

  async _execute(params: Record<string, unknown>, _signal?: AbortSignal) {
    const start = Date.now();
    try {
      const action = params.action as string;
      if (!action) return this.fail('action parameter is required', Date.now() - start);
      if (!['open', 'navigate', 'close'].includes(action)) {
        return this.fail('action must be open, navigate, or close', Date.now() - start);
      }

      if (action === 'open') {
        const url = params.url as string;
        if (!url?.trim()) return this.fail('url is required for open action', Date.now() - start);

        const sessionId = `br-${randomUUID().slice(0, 8)}`;
        await this.invokeIPC('browser:create-session', { sessionId, url });
        return this.success(`Browser session opened.\nsessionId: ${sessionId}\nurl: ${url}`, Date.now() - start);
      }

      const sessionId = params.sessionId as string;
      if (!sessionId) return this.fail('sessionId is required for navigate/close actions', Date.now() - start);

      if (action === 'navigate') {
        const url = params.url as string;
        if (!url) return this.fail('url is required for navigate action', Date.now() - start);
        await this.invokeIPC('browser:navigate', { sessionId, url });
        return this.success(`Navigated to ${url}`, Date.now() - start);
      }

      // close
      await this.invokeIPC('browser:close', { sessionId });
      return this.success(`Browser session ${sessionId} closed.`, Date.now() - start);
    } catch (error) {
      return this.fail(`browser_session failed: ${error instanceof Error ? error.message : String(error)}`, Date.now() - start);
    }
  }
}
