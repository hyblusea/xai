import { ToolDefinition } from '@xai/shared';
import { BrowserBaseTool } from './browser-base-tool.js';

export class BrowserExtractTool extends BrowserBaseTool {
  get definition(): ToolDefinition {
    return {
      name: 'browser_extract',
      description: 'Extract page accessibility tree.',
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

      const result = await this.invokeIPC<{ content?: string }>('browser:extract', { sessionId });
      const content = result.content || '(empty page)';
      return this.success(content, Date.now() - start);
    } catch (error) {
      return this.fail(`browser_extract failed: ${error instanceof Error ? error.message : String(error)}`, Date.now() - start);
    }
  }
}
