import { ToolDefinition } from '@xai/shared';
import { BrowserBaseTool } from './browser-base-tool.js';

export class BrowserQueryTool extends BrowserBaseTool {
  get definition(): ToolDefinition {
    return {
      name: 'browser_query',
      description: 'Query page elements. Returns tag, text, attributes, position. No selector = all interactive elements. detail=true adds styles/HTML/form state. frameSelector for iframes.',
      parameters: {
        sessionId: { type: 'string', description: 'Browser session ID', required: true, location: 'header' },
        selector: { type: 'string', description: 'CSS selector (omit for all interactive elements)', required: false, location: 'header' },
        detail: { type: 'boolean', description: 'Include styles, outerHTML, form state', required: false, location: 'header' },
        frameSelector: { type: 'string', description: 'iframe CSS selector', required: false, location: 'header' },
      },
      confirmationRequired: false,
    };
  }

  async _execute(params: Record<string, unknown>, _signal?: AbortSignal) {
    const start = Date.now();
    try {
      const sessionId = params.sessionId as string;
      const selector = params.selector as string | undefined;
      const detail = params.detail === true || params.detail === 'true';
      const frameSelector = params.frameSelector as string | undefined;

      if (!sessionId) return this.fail('sessionId parameter is required', Date.now() - start);

      const result = await this.invokeIPC<{
        elements?: Array<{
          tagName: string;
          selector: string;
          text: string;
          attributes: Record<string, string>;
          rect: { x: number; y: number; width: number; height: number };
          detail?: Record<string, unknown>;
        }>;
      }>('browser:query', { sessionId, selector, detail, frameSelector });

      const elements = result.elements || [];
      if (elements.length === 0) {
        return this.success('No elements found matching the query.', Date.now() - start);
      }

      const output = elements.map((el, i) => {
        const attrs = Object.entries(el.attributes)
          .map(([k, v]) => `${k}="${v}"`)
          .join(' ');
        const text = el.text.length > 80 ? el.text.slice(0, 80) + '...' : el.text;
        let line = `[${i}] <${el.tagName}${attrs ? ' ' + attrs : ''}> "${text}" selector:${el.selector} pos:(${el.rect.x},${el.rect.y}) ${el.rect.width}x${el.rect.height}`;
        if (detail && el.detail) {
          const d = el.detail;
          const cs = d.computedStyle as Record<string, string> | undefined;
          if (cs) line += `\n    style: display=${cs.display} visibility=${cs.visibility} position=${cs.position}`;
          if (d.outerHTML) line += `\n    html: ${String(d.outerHTML).substring(0, 200)}`;
          if (d.value !== undefined && d.value !== null && d.value !== '') line += `\n    value: ${d.value}`;
          if (d.href) line += ` href: ${d.href}`;
          if (d.src) line += ` src: ${d.src}`;
          const flags = [];
          if (d.checked) flags.push('checked');
          if (d.disabled) flags.push('disabled');
          if (d.readOnly) flags.push('readOnly');
          if (d.required) flags.push('required');
          if (flags.length) line += ` [${flags.join(', ')}]`;
        }
        return line;
      }).join('\n');

      const context = frameSelector ? ` in iframe "${frameSelector}"` : '';
      return this.success(`Found ${elements.length} element(s)${context}:\n${output}`, Date.now() - start);
    } catch (error) {
      return this.fail(`browser_query failed: ${error instanceof Error ? error.message : String(error)}`, Date.now() - start);
    }
  }
}
