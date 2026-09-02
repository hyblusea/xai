import * as cheerio from 'cheerio';
import type { SearchProvider, SearchOptions, SerpApiResponse, OrganicResult } from './search-provider.js';
import { CaptchaError } from '../captcha-error.js';

const CAPTCHA_PATTERNS = ['captcha', 'verify you are human'];

export class BingSearchProvider implements SearchProvider {
  readonly name = 'bing';

  async search(query: string, options: SearchOptions): Promise<SerpApiResponse> {
    const startTime = Date.now();
    const url = this.buildSearchUrl(query, options);

    if (!options.browserFetcher) {
      throw new Error('BingSearchProvider requires browserFetcher to avoid degraded search results');
    }

    const html = await options.browserFetcher(url, {
      timeout: 30000,
      acceptLanguage: 'en-US,en;q=0.9',
      searchViaInput: {
        startUrl: 'https://cn.bing.com/?ensearch=1',
        searchQuery: query,
        searchBoxSelector: 'input[name="q"]',
      },
    });
    if (this.isCaptchaPage(html)) {
      throw new CaptchaError(this.name, url);
    }

    return this.parseHtml(html, query, options, Date.now() - startTime);
  }

  private buildSearchUrl(query: string, options: SearchOptions): string {
    const params = new URLSearchParams({
      q: query,
      count: String(options.num ?? 10),
      ensearch: '1',
    });
    if (options.start) params.set('first', String(options.start + 1));
    return `https://cn.bing.com/search?${params}`;
  }

  private isCaptchaPage(html: string): boolean {
    const lowerHtml = html.toLowerCase();
    return CAPTCHA_PATTERNS.some(p => lowerHtml.includes(p));
  }

  private parseHtml(html: string, query: string, options: SearchOptions, timeTaken: number): SerpApiResponse {
    const $ = cheerio.load(html);
    const results: OrganicResult[] = [];

    $('#b_results > .b_algo').each((index, element) => {
      const titleEl = $(element).find('h2 > a');
      const snippetEl = $(element).find('.b_caption p');
      const title = titleEl.text().trim();
      const link = this.decodeBingUrl(titleEl.attr('href') || '');
      const snippet = snippetEl.text().trim();
      if (title && link) {
        results.push({
          position: index + 1,
          title,
          link,
          displayed_link: $(element).find('.b_tpcn > cite, .b_attribution > cite').text().trim() || undefined,
          snippet,
          snippet_highlighted_words: this.extractHighlightedWords(snippetEl, $),
        });
      }
    });

    const relatedSearches: { query: string }[] = [];
    $('.b_rs ul li a').each((_, el) => {
      const q = $(el).text().trim();
      if (q) relatedSearches.push({ query: q });
    });

    const resultStats = $('.b_algoStats').text();
    const totalMatch = resultStats.match(/([\d,]+)\s*条结果/);

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
    element.find('strong, em, b').each((_, el) => {
      const text = $(el).text().trim();
      if (text) words.push(text);
    });
    return words;
  }

  /**
   * 解码 Bing 重定向 URL，提取真实目标地址。
   * Bing 国际版搜索结果的 href 形如 /ck/a?...&u=aHR0cHM6Ly9...，其中 u 参数是 base64 编码的真实 URL。
   * 国内版搜索结果的 href 直接是真实 URL。
   */
  private decodeBingUrl(href: string): string {
    if (!href) return '';
    try {
      const url = new URL(href, 'https://www.bing.com');
      const uParam = url.searchParams.get('u');
      if (uParam && url.pathname.startsWith('/ck/')) {
        // u 参数是 base64 编码，前缀 "a1" 表示 https，需要去掉
        const b64 = uParam.startsWith('a1') ? uParam.slice(2) : uParam;
        const decoded = atob(b64);
        if (decoded.startsWith('http')) return decoded;
      }
    } catch { /* not a redirect URL, return as-is */ }
    return href;
  }
}
