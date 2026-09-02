import { ToolDefinition } from '@xai/shared';
import { BrowserBaseTool } from './browser-base-tool.js';

export class BrowserWaitTool extends BrowserBaseTool {
  get definition(): ToolDefinition {
    return {
      name: 'browser_wait',
      description: 'Wait for condition: element appear, navigation complete, or network idle.',
      parameters: {
        sessionId: { type: 'string', description: 'Browser session ID', required: true, location: 'header' },
        waitType: { type: 'string', description: 'Wait type: element, navigation, networkIdle', required: true, location: 'header' },
        selector: { type: 'string', description: 'CSS selector (required for element)', required: false, location: 'header' },
        timeout: { type: 'number', description: 'Max wait time in ms (default 10000)', required: false, location: 'header' },
      },
      confirmationRequired: false,
    };
  }

  async _execute(params: Record<string, unknown>, _signal?: AbortSignal) {
    const start = Date.now();
    try {
      const sessionId = params.sessionId as string;
      const waitType = (params.waitType as string) || 'element';
      const selector = params.selector as string | undefined;
      const timeout = typeof params.timeout === 'number' ? params.timeout : 10000;

      if (!sessionId) return this.fail('sessionId parameter is required', Date.now() - start);
      if (waitType === 'element' && !selector) {
        return this.fail('selector is required when waitType=element', Date.now() - start);
      }

      await this.invokeIPC('browser:wait', { sessionId, waitType, selector, timeout });
      return this.success(`Wait condition met: ${waitType}${selector ? ` (${selector})` : ''}`, Date.now() - start);
    } catch (error) {
      return this.fail(`browser_wait failed: ${error instanceof Error ? error.message : String(error)}`, Date.now() - start);
    }
  }
}
