import { ToolDefinition } from '@xai/shared';
import { BrowserBaseTool } from './browser-base-tool.js';

export class BrowserDragTool extends BrowserBaseTool {
  get definition(): ToolDefinition {
    return {
      name: 'browser_drag',
      description: 'Drag element/position to another. Selector or coordinate based. Useful for canvas UIs, drag-and-drop, reordering.',
      parameters: {
        sessionId: { type: 'string', description: 'Browser session ID', required: true, location: 'header' },
        fromSelector: { type: 'string', description: 'Drag source selector', required: false, location: 'header' },
        toSelector: { type: 'string', description: 'Drag target selector', required: false, location: 'header' },
        fromX: { type: 'number', description: 'Drag start X (if no fromSelector)', required: false, location: 'header' },
        fromY: { type: 'number', description: 'Drag start Y (if no fromSelector)', required: false, location: 'header' },
        toX: { type: 'number', description: 'Drag end X (if no toSelector)', required: false, location: 'header' },
        toY: { type: 'number', description: 'Drag end Y (if no toSelector)', required: false, location: 'header' },
        frameSelector: { type: 'string', description: 'iframe CSS selector', required: false, location: 'header' },
      },
      confirmationRequired: false,
    };
  }

  async _execute(params: Record<string, unknown>, _signal?: AbortSignal) {
    const start = Date.now();
    try {
      const sessionId = params.sessionId as string;
      const fromSelector = params.fromSelector as string | undefined;
      const toSelector = params.toSelector as string | undefined;
      const fromX = params.fromX as number | undefined;
      const fromY = params.fromY as number | undefined;
      const toX = params.toX as number | undefined;
      const toY = params.toY as number | undefined;

      if (!sessionId) return this.fail('sessionId parameter is required', Date.now() - start);
      if (!fromSelector && (fromX === undefined || fromY === undefined)) {
        return this.fail('Either fromSelector or fromX/fromY coordinates are required', Date.now() - start);
      }
      if (!toSelector && (toX === undefined || toY === undefined)) {
        return this.fail('Either toSelector or toX/toY coordinates are required', Date.now() - start);
      }

      await this.invokeIPC('browser:drag', {
        sessionId, fromSelector, toSelector, fromX, fromY, toX, toY,
        frameSelector: params.frameSelector as string | undefined,
      });

      const from = fromSelector || `(${fromX},${fromY})`;
      const to = toSelector || `(${toX},${toY})`;
      return this.success(`Dragged from ${from} to ${to}`, Date.now() - start);
    } catch (error) {
      return this.fail(`browser_drag failed: ${error instanceof Error ? error.message : String(error)}`, Date.now() - start);
    }
  }
}
