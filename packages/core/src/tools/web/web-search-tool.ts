import { ToolDefinition, WebSearchConfig } from '@xai/shared';
import { BaseTool } from '../base-tool.js';
import { providerRegistry } from './providers/index.js';
import type { EngineName } from './providers/index.js';
import { SearchRateLimiter } from './rate-limiter.js';
import { CaptchaHandler } from './captcha-handler.js';
import { CaptchaError } from './captcha-error.js';
import type { SerpApiResponse, BrowserHtmlFetcher } from './providers/search-provider.js';

const DEFAULT_CONFIG: WebSearchConfig = {
  enabled: true,
  defaultEngine: 'bing',
  maxResults: 10,
  minRequestInterval: 2000,
  autoFallback: true,
  hl: 'zh-CN',
  gl: 'CN',
};

export class WebSearchTool extends BaseTool {
  private config: WebSearchConfig;
  private rateLimiter: SearchRateLimiter;
  private ipcSend: ((channel: string, data: unknown) => Promise<unknown>) | null = null;
  private browserFetcher: BrowserHtmlFetcher | null = null;

  constructor(config?: Partial<WebSearchConfig>) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.rateLimiter = new SearchRateLimiter(this.config.minRequestInterval);
  }

  /** Set the IPC sender function (called by the Electron host to bridge IPC) */
  setIpcSender(send: (channel: string, data: unknown) => Promise<unknown>): void {
    this.ipcSend = send;
  }

  /** Set a real-browser HTML fetcher (Electron BrowserWindow) to avoid bot detection. */
  setBrowserFetcher(fetcher: BrowserHtmlFetcher): void {
    this.browserFetcher = fetcher;
  }

  get definition(): ToolDefinition {
    return {
      name: 'web_search',
      description: 'Search the internet',
      parameters: {
        query: {
          type: 'string',
          description: 'Search query',
          required: true,
          location: 'body',
        },
        num: {
          type: 'number',
          description: 'Result count (default 10, max 20)',
          required: false,
          default: 10,
          location: 'header',
        },
      },
      confirmationRequired: false,
    };
  }

  async _execute(params: Record<string, unknown>, _signal?: AbortSignal) {
    const start = Date.now();
    try {
      const query = params.query as string;
      const num = Math.min(
        typeof params.num === 'number' ? params.num : (typeof params.num === 'string' ? parseInt(params.num, 10) : this.config.maxResults),
        20,
      );

      if (!query || !query.trim()) {
        return this.fail('query parameter cannot be empty', Date.now() - start);
      }

      const engine = this.config.defaultEngine;
      const engines = providerRegistry.getEngineNames();

      // Rate limiting
      await this.rateLimiter.waitIfNeeded(engine);

      let result: SerpApiResponse | null = null;
      let currentEngine: EngineName | string | null = engine;
      let lastError: Error | null = null;

      // Try current engine, then fallback
      while (currentEngine) {
        const provider = providerRegistry.get(currentEngine);
        if (!provider) {
          lastError = new Error(`Provider not found: ${currentEngine}`);
          break;
        }

        try {
          result = await provider.search(query, {
            num,
            hl: this.config.hl,
            gl: this.config.gl,
            browserFetcher: this.browserFetcher ?? undefined,
          });

          // Check for CAPTCHA in result
          if (result.search_metadata.status === 'Captcha') {
            // No degradation: request human verification via IPC
            const captchaUrl = this.buildSearchUrl(currentEngine, query, { num, hl: this.config.hl, gl: this.config.gl });
            const captchaResult = await this.requestCaptchaResolution(currentEngine, captchaUrl);
            if (captchaResult.resolved) {
              // User completed CAPTCHA, retry the same engine with cookies
              result = await provider.search(query, {
                num,
                hl: this.config.hl,
                gl: this.config.gl,
                cookie: captchaResult.cookie,
              });
              if (result.search_metadata.status !== 'Captcha') {
                break;
              }
            }
            return this.fail(`CAPTCHA detected on ${currentEngine}. Human verification was not completed.`, Date.now() - start);
          }

          break;
        } catch (err) {
          lastError = err instanceof Error ? err : new Error(String(err));

          // If CAPTCHA, request human verification instead of auto-fallback
          if (err instanceof CaptchaError) {
            const captchaResult = await this.requestCaptchaResolution(err.engine, err.searchUrl);
            if (captchaResult.resolved) {
              // User completed CAPTCHA, retry the same engine with cookies
              try {
                result = await provider.search(query, {
                  num,
                  hl: this.config.hl,
                  gl: this.config.gl,
                  cookie: captchaResult.cookie,
                });
                break;
              } catch (retryErr) {
                lastError = retryErr instanceof Error ? retryErr : new Error(String(retryErr));
              }
            }
            return this.fail(`CAPTCHA detected on ${currentEngine}. Human verification was not completed.`, Date.now() - start);
          }

          break;
        }
      }

      if (!result) {
        return this.fail(
          `Search failed: ${lastError?.message || 'Unknown error'}`,
          Date.now() - start,
        );
      }

      const output = this.formatResult(result);
      return this.success(output, Date.now() - start);
    } catch (error) {
      return this.fail(`web_search failed: ${error instanceof Error ? error.message : String(error)}`, Date.now() - start);
    }
  }

  private formatResult(result: SerpApiResponse): string {
    const lines: string[] = [];

    // Header
    lines.push(`Search: ${result.search_parameters.q}`);
    lines.push(`Engine: ${result.search_metadata.engine} | Status: ${result.search_metadata.status} | Time: ${result.search_metadata.total_time_taken.toFixed(2)}s`);

    if (result.search_information.total_results) {
      lines.push(`Total results: ${result.search_information.total_results}`);
    }
    lines.push('');

    // Organic results
    for (const r of result.organic_results) {
      lines.push(`${r.position}. ${r.title}`);
      lines.push(`   ${r.link}`);
      if (r.displayed_link) lines.push(`   ${r.displayed_link}`);
      if (r.snippet) lines.push(`   ${r.snippet}`);
      lines.push('');
    }

    // Related searches
    if (result.related_searches && result.related_searches.length > 0) {
      lines.push('Related searches:');
      for (const rs of result.related_searches) {
        lines.push(`  - ${rs.query}`);
      }
    }

    return lines.join('\n');
  }

  updateConfig(config: Partial<WebSearchConfig>): void {
    this.config = { ...this.config, ...config };
    if (config.minRequestInterval) {
      this.rateLimiter.setMinInterval(config.minRequestInterval);
    }
  }

  /**
   * Request human CAPTCHA resolution via IPC.
   * Sends the CAPTCHA URL to the renderer for manual verification.
   * Returns { resolved, cookie? } — cookie contains session cookies from the resolved session.
   */
  private async requestCaptchaResolution(engine: string, url: string): Promise<{ resolved: boolean; cookie?: string }> {
    if (!this.ipcSend) {
      // No IPC available (non-Electron env), cannot do human verification
      return { resolved: false };
    }
    try {
      const result = await this.ipcSend('web:captcha-detected', {
        engine,
        url,
      }) as { resolved: boolean; cookie?: string };
      return { resolved: result?.resolved === true, cookie: result?.cookie };
    } catch {
      return { resolved: false };
    }
  }

  /** Build search URL for a given engine (mirrors provider implementations) */
  private buildSearchUrl(engine: string, query: string, options: { num: number; hl?: string; gl?: string }): string {
    switch (engine) {
      case 'google': {
        const params = new URLSearchParams({ q: query, num: String(options.num), hl: options.hl ?? 'zh-CN', gl: options.gl ?? 'CN' });
        return `https://www.google.com/search?${params}`;
      }
      case 'bing': {
        const params = new URLSearchParams({ q: query, count: String(options.num), ensearch: '1' });
        return `https://cn.bing.com/search?${params}`;
      }
      case 'baidu': {
        const params = new URLSearchParams({ wd: query, rn: String(options.num), hl: options.hl ?? 'zh-CN' });
        return `https://www.baidu.com/s?${params}`;
      }
      case 'duckduckgo': {
        const params = new URLSearchParams({ q: query, kl: options.gl === 'CN' ? 'cn-zh' : (options.hl ?? 'wt-wt') });
        return `https://lite.duckduckgo.com/lite/?${params}`;
      }
      default: {
        const params = new URLSearchParams({ q: query });
        return `https://www.google.com/search?${params}`;
      }
    }
  }
}
