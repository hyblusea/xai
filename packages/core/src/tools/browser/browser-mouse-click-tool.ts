import { ToolDefinition } from '@xai/shared';
import { BrowserBaseTool } from './browser-base-tool.js';

export class BrowserMouseClickTool extends BrowserBaseTool {
  get definition(): ToolDefinition {
    return {
      name: 'browser_mouse_click',
      description: 'Click element or coordinates. Supports left/right/middle, single/double click. frameSelector for iframes.',
      parameters: {
        sessionId: { type: 'string', description: 'Browser session ID', required: true, location: 'header' },
        selector: { type: 'string', description: 'CSS selector (if no x/y)', required: false, location: 'header' },
        x: { type: 'number', description: 'X coordinate (used if selector not provided)', required: false, location: 'header' },
        y: { type: 'number', description: 'Y coordinate (used if selector not provided)', required: false, location: 'header' },
        button: { type: 'string', description: 'Button: left, right, middle (default: left)', required: false, location: 'header' },
        clickCount: { type: 'number', description: '1=single, 2=double (default: 1)', required: false, location: 'header' },
        frameSelector: { type: 'string', description: 'iframe CSS selector', required: false, location: 'header' },
      },
      confirmationRequired: false,
      examples: [
        `++++ browser_mouse_click sessionId:br-abc123 selector:#submit-btn button:left clickCount:1
++++ end`,
      ],
    };
  }

  async _execute(params: Record<string, unknown>, _signal?: AbortSignal) {
    const start = Date.now();
    try {
      const sessionId = params.sessionId as string;
      const selector = params.selector as string | undefined;
      const x = params.x as number | undefined;
      const y = params.y as number | undefined;
      const button = (params.button as string) || 'left';
      const clickCount = (params.clickCount as number) || 1;

      if (!sessionId) return this.fail('sessionId parameter is required', Date.now() - start);
      if (!selector && (x === undefined || y === undefined)) {
        return this.fail('Either selector or x/y coordinates are required', Date.now() - start);
      }
      if (!['left', 'right', 'middle'].includes(button)) {
        return this.fail('button must be left, right, or middle', Date.now() - start);
      }
      if (![1, 2].includes(clickCount)) {
        return this.fail('clickCount must be 1 or 2', Date.now() - start);
      }

      await this.invokeIPC('browser:mouse-click', {
        sessionId, selector, x, y, button, clickCount,
        frameSelector: params.frameSelector as string | undefined,
      });

      const target = selector || `(${x},${y})`;
      const clickType = clickCount === 2 ? 'Double-clicked' : 'Clicked';
      const buttonLabel = button === 'left' ? '' : ` (${button})`;
      return this.success(`${clickType}${buttonLabel} on ${target}`, Date.now() - start);
    } catch (error) {
      return this.fail(`browser_mouse_click failed: ${error instanceof Error ? error.message : String(error)}`, Date.now() - start);
    }
  }
}
