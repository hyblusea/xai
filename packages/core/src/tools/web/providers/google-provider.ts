import * as cheerio from 'cheerio';
import type { SearchProxyConfig } from '@xai/shared';
import type { SearchProvider, SearchOptions, SerpApiResponse, OrganicResult } from './search-provider.js';
import { CaptchaError } from '../captcha-error.js';

const BROWSER_HEADERS: Record<string, string> = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  'Accept-Encoding': 'gzip, deflate, br',
  'Cache-Control': 'no-cache',
  'Sec-Ch-Ua': '"Not/A)Brand";v="8", "Chromium";v="126", "Google Chrome";v="126"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"Windows"',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Upgrade-Insecure-Requests': '1',
};

const CAPTCHA_PATTERNS = ['captcha', 'sorry/index', 'unusual traffic', 'detected unusual traffic'];

export class GoogleSearchProvider implements SearchProvider {
  readonly name = 'google';

  async search(query: string, options: SearchOptions): Promise<SerpApiResponse> {
    const startTime = Date.now();
    const url = this.buildSearchUrl(query, options);
    const html = await this.fetchWithBrowserHeaders(url, options.proxy, options.cookie);
    return this.parseHtml(html, query, options, Date.now() - startTime);
  }

  private buildSearchUrl(query: string, options: SearchOptions): string {
    const params = new URLSearchParams({
      q: query,
      num: String(options.num ?? 10),
      hl: options.hl ?? 'zh-CN',
      gl: options.gl ?? 'CN',
    });
    if (options.start) params.set('start', String(options.start));
    return `https://www.google.com/search?${params}`;
  }

  private async fetchWithBrowserHeaders(url: string, proxy?: SearchProxyConfig, cookie?: string): Promise<string> {
    const headers: Record<string, string> = { ...BROWSER_HEADERS };
    if (cookie) {
      headers['Cookie'] = cookie;
    }
    const fetchOptions: RequestInit = {
      headers,
      redirect: 'follow',
      signal: AbortSignal.timeout(30000),
    };

    // Proxy support via dispatcher (undici) or https-proxy-agent
    if (proxy?.enabled) {
      try {
        const { HttpsProxyAgent } = await import('https-proxy-agent');
        const proxyUrl = this.buildProxyUrl(proxy);
        (fetchOptions as any).dispatcher = undefined; // clear if set
        (fetchOptions as any).agent = new HttpsProxyAgent(proxyUrl);
      } catch {
        // https-proxy-agent not available, try socks-proxy-agent
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
    const html = await response.text();

    if (this.isCaptchaPage(html)) {
      throw new CaptchaError(this.name, url);
    }
    return html;
  }

  private buildProxyUrl(proxy: SearchProxyConfig): string {
    const auth = proxy.username || proxy.password
      ? `${proxy.username || ''}:${proxy.password || ''}@`
      : '';
    return `${proxy.protocol}://${auth}${proxy.host}:${proxy.port}`;
  }

  private isCaptchaPage(html: string): boolean {
    const lowerHtml = html.toLowerCase();
    return CAPTCHA_PATTERNS.some(p => lowerHtml.includes(p));
  }

  private parseHtml(html: string, query: string, options: SearchOptions, timeTaken: number): SerpApiResponse {
    const $ = cheerio.load(html);
    const results: OrganicResult[] = [];

    $('#rso > .g, #rso > div[data-hveid]').each((index, element) => {
      const titleEl = $(element).find('h3');
      const linkEl = $(element).find('a[href]');
      const snippetEl = $(element).find('.VwiC3b, .lyLwlc');
      const title = titleEl.text().trim();
      const link = linkEl.attr('href') || '';
      const snippet = snippetEl.text().trim();
      if (title && link) {
        results.push({
          position: index + 1,
          title,
          link,
          displayed_link: $(element).find('.byY8ec, .TbwUpd').text().trim() || undefined,
          snippet,
          snippet_highlighted_words: this.extractHighlightedWords(snippetEl, $),
        });
      }
    });

    const relatedSearches: { query: string }[] = [];
    $('.related-question-pair, [data-ved] a[data-q]').each((_, el) => {
      const q = $(el).text().trim();
      if (q) relatedSearches.push({ query: q });
    });

    const resultStats = $('#result-stats').text();
    const totalMatch = resultStats.match(/约 ([\d,]+) 条结果/);

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
        total_results: totalMatch?.[1] || undefined,
      },
      organic_results: results,
      related_searches: relatedSearches.length > 0 ? relatedSearches : undefined,
    };
  }

  private extractHighlightedWords(element: cheerio.Cheerio<any>, $: cheerio.CheerioAPI): string[] {
    const words: string[] = [];
    element.find('em, b').each((_, el) => {
      const text = $(el).text().trim();
      if (text) words.push(text);
    });
    return words;
  }
}
