import * as cheerio from 'cheerio';
import type { SearchProxyConfig } from '@xai/shared';
import type { SearchProvider, SearchOptions, SerpApiResponse, OrganicResult } from './search-provider.js';

const BROWSER_HEADERS: Record<string, string> = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  'Accept-Encoding': 'gzip, deflate, br',
  'Cache-Control': 'no-cache',
};

export class DuckDuckGoSearchProvider implements SearchProvider {
  readonly name = 'duckduckgo';

  async search(query: string, options: SearchOptions): Promise<SerpApiResponse> {
    const startTime = Date.now();
    const url = this.buildSearchUrl(query, options);
    const html = await this.fetchWithBrowserHeaders(url, options.proxy);
    return this.parseHtml(html, query, options, Date.now() - startTime);
  }

  private buildSearchUrl(query: string, options: SearchOptions): string {
    const params = new URLSearchParams({
      q: query,
      kl: options.gl === 'CN' ? 'cn-zh' : (options.hl ?? 'wt-wt'),
    });
    return `https://lite.duckduckgo.com/lite/?${params}`;
  }

  private async fetchWithBrowserHeaders(url: string, proxy?: SearchProxyConfig): Promise<string> {
    const fetchOptions: RequestInit = {
      headers: BROWSER_HEADERS,
      redirect: 'follow',
      signal: AbortSignal.timeout(30000),
    };

    if (proxy?.enabled) {
      try {
        const { HttpsProxyAgent } = await import('https-proxy-agent');
        const proxyUrl = this.buildProxyUrl(proxy);
        (fetchOptions as any).agent = new HttpsProxyAgent(proxyUrl);
      } catch {
        if (proxy.protocol === 'socks4' || proxy.protocol === 'socks5') {
          try {
            const { SocksProxyAgent } = await import('socks-proxy-agent');
            const proxyUrl = this.buildProxyUrl(proxy);
            (fetchOptions as any).agent = new SocksProxyAgent(proxyUrl);
          } catch { /* no proxy agent available */ }
        }
      }
    }

    const response = await fetch(url, fetchOptions);
    return await response.text();
  }

  private buildProxyUrl(proxy: SearchProxyConfig): string {
    const auth = proxy.username || proxy.password
      ? `${proxy.username || ''}:${proxy.password || ''}@`
      : '';
    return `${proxy.protocol}://${auth}${proxy.host}:${proxy.port}`;
  }

  private parseHtml(html: string, query: string, options: SearchOptions, timeTaken: number): SerpApiResponse {
    const $ = cheerio.load(html);
    const results: OrganicResult[] = [];

    $('.result').each((index, element) => {
      const titleEl = $(element).find('.result__a');
      const snippetEl = $(element).find('.result__snippet');
      const title = titleEl.text().trim();
      const link = titleEl.attr('href') || '';
      const snippet = snippetEl.text().trim();
      if (title && link) {
        results.push({
          position: index + 1,
          title,
          link,
          snippet,
          snippet_highlighted_words: this.extractHighlightedWords(snippetEl, $),
        });
      }
    });

    return {
      search_metadata: {
        id: crypto.randomUUID(),
        status: results.length > 0 ? 'Success' : 'Error',
        engine: this.name,
        created_at: new Date().toISOString(),
        total_time_taken: timeTaken / 1000,
      },
      search_parameters: {
        engine: this.name,
        q: query,
        hl: options.hl,
        gl: options.gl,
        num: options.num ?? 10,
      },
      search_information: {
        query_displayed: query,
      },
      organic_results: results,
    };
  }

  private extractHighlightedWords(element: cheerio.Cheerio<any>, $: cheerio.CheerioAPI): string[] {
    const words: string[] = [];
    element.find('strong, em, b').each((_, el) => {
      const text = $(el).text().trim();
      if (text) words.push(text);
    });
    return words;
  }
}
