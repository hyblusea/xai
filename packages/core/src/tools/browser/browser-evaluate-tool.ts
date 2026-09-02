import { ToolDefinition } from '@xai/shared';
import { BrowserBaseTool } from './browser-base-tool.js';

export class BrowserEvaluateTool extends BrowserBaseTool {
  get definition(): ToolDefinition {
    return {
      name: 'browser_evaluate',
      description: 'Execute JS in browser page context. Set frameSelector for same-origin iframe.',
      parameters: {
        sessionId: { type: 'string', description: 'Browser session ID', required: true, location: 'header' },
        expression: { type: 'string', description: 'JS expression to evaluate', required: true, location: 'body' },
        frameSelector: { type: 'string', description: 'iframe CSS selector (same-origin only)', required: false, location: 'header' },
      },
      confirmationRequired: false,
      examples: [
        `++++ browser_evaluate sessionId:br-abc123
document.querySelector('h1')?.textContent
++++ end`,
      ],
    };
  }

  async _execute(params: Record<string, unknown>, _signal?: AbortSignal) {
    const start = Date.now();
    try {
      const sessionId = params.sessionId as string;
      const expression = params.expression as string;
      const frameSelector = params.frameSelector as string | undefined;

      if (!sessionId || !expression) {
        return this.fail('sessionId and expression parameters are required', Date.now() - start);
      }

      const result = await this.invokeIPC<{ result?: unknown }>('browser:evaluate', {
        sessionId, expression, frameSelector,
      });

      const output = typeof result.result === 'string'
        ? result.result
        : JSON.stringify(result.result, null, 2);

      return this.success(`Evaluation result:\n${output}`, Date.now() - start);
    } catch (error) {
      return this.fail(`browser_evaluate failed: ${error instanceof Error ? error.message : String(error)}`, Date.now() - start);
    }
  }
}
