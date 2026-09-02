import { ToolDefinition } from '@xai/shared';
import { BrowserBaseTool } from './browser-base-tool.js';

export class BrowserScreenshotTool extends BrowserBaseTool {
  get definition(): ToolDefinition {
    return {
      name: 'browser_screenshot',
      description: 'Screenshot current page. Returns base64 PNG.',
      parameters: {
        sessionId: { type: 'string', description: 'Browser session ID', required: true, location: 'header' },
      },
      confirmationRequired: false,
    };
  }

  async _execute(params: Record<string, unknown>, _signal?: AbortSignal) {
    const start = Date.now();
    try {
      const sessionId = params.sessionId as string;
      if (!sessionId) return this.fail('sessionId parameter is required', Date.now() - start);

      const result = await this.invokeIPC<{ data?: string }>('browser:screenshot', { sessionId });
      return this.success(`Screenshot captured (base64 PNG, ${result.data?.length || 0} chars)`, Date.now() - start);
    } catch (error) {
      return this.fail(`browser_screenshot failed: ${error instanceof Error ? error.message : String(error)}`, Date.now() - start);
    }
  }
}
