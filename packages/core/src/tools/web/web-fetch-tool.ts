import { ToolDefinition, WebFetchConfig } from '@xai/shared';
import { BaseTool } from '../base-tool.js';

const DEFAULT_CONFIG: WebFetchConfig = {
  enabled: true,
  maxLength: 50000,
  timeout: 30000,
  noiseSelectors: [],
};

/**
 * WebFetchTool fetches web page content via IPC to the Electron main process,
 * which uses a hidden BrowserWindow to render the page and extract content.
 *
 * In non-Electron environments (e.g. tests), it falls back to a simple HTTP fetch.
 */
export class WebFetchTool extends BaseTool {
  private config: WebFetchConfig;
  private ipcSend: ((channel: string, data: unknown) => Promise<unknown>) | null = null;

  constructor(config?: Partial<WebFetchConfig>) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /** Set the IPC sender function (called by the Electron host to bridge IPC) */
  setIpcSender(send: (channel: string, data: unknown) => Promise<unknown>): void {
    this.ipcSend = send;
  }

  get definition(): ToolDefinition {
    return {
      name: 'web_fetch',
      description: 'Fetch web page content by URL',
      parameters: {
        url: {
          type: 'string',
          description: 'URL to fetch',
          required: true,
          location: 'header',
        },
        maxLength: {
          type: 'number',
          description: 'Max content length (default 50000)',
          required: false,
          default: 50000,
          location: 'header',
        },
        timeout: {
          type: 'number',
          description: 'Timeout in ms (default 30000)',
          required: false,
          default: 30000,
          location: 'header',
        },
      },
      confirmationRequired: false,
    };
  }

  async _execute(params: Record<string, unknown>, _signal?: AbortSignal) {
    const start = Date.now();
    try {
      const url = params.url as string;
      const maxLength = typeof params.maxLength === 'number'
        ? params.maxLength
        : (typeof params.maxLength === 'string' ? parseInt(params.maxLength, 10) : this.config.maxLength);
      const timeout = typeof params.timeout === 'number'
        ? params.timeout
        : (typeof params.timeout === 'string' ? parseInt(params.timeout, 10) : this.config.timeout);

      if (!url || !url.trim()) {
        return this.fail('url parameter cannot be empty', Date.now() - start);
      }

      // Validate URL
      try {
        new URL(url);
      } catch {
        return this.fail(`Invalid URL: ${url}`, Date.now() - start);
      }

      // Try IPC (Electron BrowserWindow) first, then fallback to HTTP fetch
      if (this.ipcSend) {
        try {
          const result = await this.ipcSend('web:fetch-request', {
            url,
            maxLength,
            timeout,
          }) as { content: string; title: string; url: string };

          const output = this.formatResult(result);
          return this.success(output, Date.now() - start);
        } catch (err) {
          // IPC failed, fall through to HTTP fetch
        }
      }

      // Fallback: simple HTTP fetch (no JS rendering)
      const content = await this.httpFetch(url, maxLength, timeout);
      const output = this.formatResult({ content, title: '', url });
      return this.success(output, Date.now() - start);
    } catch (error) {
      return this.fail(`web_fetch failed: ${error instanceof Error ? error.message : String(error)}`, Date.now() - start);
    }
  }

  private async httpFetch(url: string, maxLength?: number, timeout?: number): Promise<string> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout || this.config.timeout);

    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        },
        redirect: 'follow',
      });

      const html = await response.text();
      return this.extractContentFromHtml(html, maxLength || this.config.maxLength);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private extractContentFromHtml(html: string, maxLength?: number): string {
    // Simple HTML content extraction (fallback when BrowserWindow is not available)
    let content = html;

    // Remove script, style, and other noise tags
    const noiseTags = ['script', 'style', 'noscript', 'iframe', 'svg'];
    for (const tag of noiseTags) {
      const regex = new RegExp(`<${tag}[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi');
      content = content.replace(regex, '');
    }

    // Remove HTML tags
    content = content.replace(/<[^>]+>/g, ' ');

    // Decode HTML entities
    content = content
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, ' ');

    // Compress whitespace
    content = content
      .split('\n')
      .map(line => line.trim())
      .filter((line, i, arr) => !(line === '' && arr[i - 1] === ''))
      .join('\n');

    const maxLen = maxLength || this.config.maxLength;
    if (content.length > maxLen) {
      content = content.substring(0, maxLen) + '\n\n[... 内容已截断 ...]';
    }

    return content;
  }

  private formatResult(result: { content: string; title: string; url: string }): string {
    const lines: string[] = [];

    if (result.title) {
      lines.push(`# ${result.title}`);
      lines.push(`URL: ${result.url}`);
      lines.push('');
    }

    lines.push(result.content);
    return lines.join('\n');
  }

  updateConfig(config: Partial<WebFetchConfig>): void {
    this.config = { ...this.config, ...config };
  }
}
