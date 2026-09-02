import { ToolDefinition } from '@xai/shared';
import { BrowserBaseTool } from './browser-base-tool.js';

export class BrowserApiRequestTool extends BrowserBaseTool {
  get definition(): ToolDefinition {
    return {
      name: 'browser_api_request',
      description: 'Send HTTP request from browser context via fetch(). Auto-includes cookies/tokens/session. Ideal for authenticated REST APIs.',
      parameters: {
        sessionId: { type: 'string', description: 'Browser session ID', required: true, location: 'header' },
        url: { type: 'string', description: 'Request URL (relative or absolute)', required: true, location: 'header' },
        method: { type: 'string', description: 'HTTP method (default: GET)', required: false, location: 'header' },
        headers: { type: 'object', description: 'Extra headers (key-value)', required: false, location: 'header' },
        bodyType: { type: 'string', description: 'Body format: json/form/raw (default: json)', required: false, location: 'header' },
        body: { type: 'string', description: 'Request body string. For json/form, pass JSON like \'{"key":"value"}\'', required: false, location: 'body' },
      },
      confirmationRequired: false,
      examples: [
        `++++ browser_api_request sessionId:br-abc123 url:/api/users method:POST bodyType:json
{"name":"Alice","role":"admin"}
++++ end`,
      ],
    };
  }

  async _execute(params: Record<string, unknown>, _signal?: AbortSignal) {
    const start = Date.now();
    try {
      const sessionId = params.sessionId as string;
      const url = params.url as string;
      const method = (params.method as string) || 'GET';
      const headers = params.headers as Record<string, string> | undefined;
      const bodyType = (params.bodyType as string) || (params.body ? 'json' : undefined);
      const body = params.body as string | undefined;

      if (!sessionId || !url) {
        return this.fail('sessionId and url parameters are required', Date.now() - start);
      }

      // Validate bodyType
      if (bodyType && !['json', 'form', 'raw'].includes(bodyType)) {
        return this.fail('bodyType must be one of: json, form, raw', Date.now() - start);
      }

      // Validate body is valid JSON when bodyType is json or form
      if (body && bodyType && bodyType !== 'raw') {
        try { JSON.parse(body); } catch {
          return this.fail(`body must be a valid JSON string when bodyType is "${bodyType}"`, Date.now() - start);
        }
      }

      const result = await this.invokeIPC<{
        status?: number; statusText?: string;
        responseHeaders?: Record<string, string>; body?: string;
      }>('browser:api-request', { sessionId, url, method, headers, bodyType, body });

      const statusLine = `${result.status} ${result.statusText || ''}`.trim();
      const respHeaders = result.responseHeaders
        ? Object.entries(result.responseHeaders).map(([k, v]) => `  ${k}: ${v}`).join('\n')
        : '';
      const bodyPreview = result.body
        ? (result.body.length > 2000 ? result.body.slice(0, 2000) + '\n... (truncated)' : result.body)
        : '(empty)';

      return this.success(
        `${method} ${url}\nStatus: ${statusLine}\n${respHeaders ? `Response Headers:\n${respHeaders}\n` : ''}Body:\n${bodyPreview}`,
        Date.now() - start,
      );
    } catch (error) {
      return this.fail(`browser_api_request failed: ${error instanceof Error ? error.message : String(error)}`, Date.now() - start);
    }
  }
}
