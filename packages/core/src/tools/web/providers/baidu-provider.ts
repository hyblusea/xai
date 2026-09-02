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
};

const CAPTCHA_PATTERNS = ['验证码', 'captcha_verify', '安全验证'];

export class BaiduSearchProvider implements SearchProvider {
  readonly name = 'baidu';

  async search(query: string, options: SearchOptions): Promise<SerpApiResponse> {
    const startTime = Date.now();
    const url = this.buildSearchUrl(query, options);
    const html = await this.fetchWithBrowserHeaders(url, options.proxy, options.cookie);
    return this.parseHtml(html, query, options, Date.now() - startTime);
  }

  private buildSearchUrl(query: string, options: SearchOptions): string {
    const params = new URLSearchParams({
      wd: query,
      rn: String(options.num ?? 10),
      hl: options.hl ?? 'zh-CN',
    });
    if (options.start) params.set('pn', String(options.start));
    return `https://www.baidu.com/s?${params}`;
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
    return CAPTCHA_PATTERNS.some(p => lowerHtml.includes(p.toLowerCase()));
  }

  private parseHtml(html: string, query: string, options: SearchOptions, timeTaken: number): SerpApiResponse {
    const $ = cheerio.load(html);
    const results: OrganicResult[] = [];

    $('#content_left > .result, #content_left > .c-container').each((index, element) => {
      const titleEl = $(element).find('h3 > a');
      const snippetEl = $(element).find('.c-abstract, .content-right_8Zs40');
      const title = titleEl.text().trim();
      const link = titleEl.attr('href') || '';
      const snippet = snippetEl.text().trim();
      if (title && link) {
        results.push({
          position: index + 1,
          title,
          link,
          displayed_link: $(element).find('.c-showurl, .showurl').text().trim() || undefined,
          snippet,
          snippet_highlighted_words: this.extractHighlightedWords(snippetEl, $),
        });
      }
    });

    const relatedSearches: { query: string }[] = [];
    $('#rs table a').each((_, el) => {
      const q = $(el).text().trim();
      if (q) relatedSearches.push({ query: q });
    });

    const resultStats = $('#resultStats, .nums_text').text();
    const totalMatch = resultStats.match(/约\s*([\d,]+)\s*个/);

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
