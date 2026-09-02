import { ToolDefinition } from '@xai/shared';
import { BrowserBaseTool } from './browser-base-tool.js';

export class BrowserInteractTool extends BrowserBaseTool {
  get definition(): ToolDefinition {
    return {
      name: 'browser_interact',
      description: 'Interact: hover (mouseover), scroll (up/down/left/right, default 300px), select (choose <select> option). Supports frameSelector for iframes.',
      parameters: {
        sessionId: { type: 'string', description: 'Browser session ID', required: true, location: 'header' },
        action: { type: 'string', description: 'Action: hover, scroll, select', required: true, location: 'header' },
        selector: { type: 'string', description: 'CSS selector (required for hover/select; optional for scroll)', required: false, location: 'header' },
        direction: { type: 'string', description: 'Scroll direction: up, down, left, right', required: false, location: 'header' },
        amount: { type: 'number', description: 'Scroll distance in pixels (default 300)', required: false, location: 'header' },
        value: { type: 'string', description: 'Option value (for select)', required: false, location: 'header' },
        frameSelector: { type: 'string', description: 'iframe CSS selector', required: false, location: 'header' },
      },
      confirmationRequired: false,
      examples: [
        `++++ browser_interact sessionId:br-abc123 action:scroll direction:down amount:500
++++ end`,
      ],
    };
  }

  async _execute(params: Record<string, unknown>, _signal?: AbortSignal) {
    const start = Date.now();
    try {
      const sessionId = params.sessionId as string;
      const action = params.action as string;
      const frameSelector = params.frameSelector as string | undefined;

      if (!sessionId || !action) {
        return this.fail('sessionId and action parameters are required', Date.now() - start);
      }

      if (!['hover', 'scroll', 'select'].includes(action)) {
        return this.fail('action must be hover, scroll, or select', Date.now() - start);
      }

      if (action === 'hover') {
        const selector = params.selector as string;
        if (!selector) return this.fail('selector is required for hover action', Date.now() - start);

        await this.invokeIPC('browser:hover', { sessionId, selector, frameSelector });
        return this.success(`Hovered over element: ${selector}`, Date.now() - start);
      }

      if (action === 'scroll') {
        const direction = params.direction as string;
        if (!direction) return this.fail('direction is required for scroll action', Date.now() - start);
        if (!['up', 'down', 'left', 'right'].includes(direction)) {
          return this.fail('direction must be up, down, left, or right', Date.now() - start);
        }

        const amount = typeof params.amount === 'number' ? params.amount : 300;
        const selector = params.selector as string | undefined;

        await this.invokeIPC('browser:scroll', { sessionId, direction, amount, selector, frameSelector });
        return this.success(`Scrolled ${direction} by ${amount}px${selector ? ` in ${selector}` : ''}`, Date.now() - start);
      }

      // select
      const selector = params.selector as string;
      const value = params.value as string;
      if (!selector || !value) return this.fail('selector and value are required for select action', Date.now() - start);

      await this.invokeIPC('browser:select', { sessionId, selector, value, frameSelector });
      return this.success(`Selected value "${value}" in ${selector}`, Date.now() - start);
    } catch (error) {
      return this.fail(`browser_interact failed: ${error instanceof Error ? error.message : String(error)}`, Date.now() - start);
    }
  }
}
