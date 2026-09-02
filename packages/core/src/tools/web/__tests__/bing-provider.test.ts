import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BingSearchProvider } from '../providers/bing-provider.js';

describe('BingSearchProvider', () => {
  let provider: BingSearchProvider;

  beforeEach(() => {
    provider = new BingSearchProvider();
  });

  describe('definition', () => {
    it('should have name "bing"', () => {
      expect(provider.name).toBe('bing');
    });
  });

  describe('buildSearchUrl', () => {
    it('should build correct Bing search URL', () => {
      const url = (provider as any).buildSearchUrl('test query', {});
      expect(url).toContain('https://cn.bing.com/search?');
      expect(url).toContain('q=test+query');
      expect(url).toContain('count=10');
      expect(url).toContain('ensearch=1');
    });

    it('should include first for pagination', () => {
      const url = (provider as any).buildSearchUrl('test', { start: 10 });
      expect(url).toContain('first=11');
    });
  });

  describe('isCaptchaPage', () => {
    it('should detect Bing CAPTCHA page', () => {
      expect((provider as any).isCaptchaPage('<html>captcha</html>')).toBe(true);
      expect((provider as any).isCaptchaPage('<html>verify you are human</html>')).toBe(true);
    });

    it('should not flag normal pages', () => {
      expect((provider as any).isCaptchaPage('<html>normal results</html>')).toBe(false);
    });
  });

  describe('parseHtml', () => {
    it('should parse Bing search results HTML', () => {
      const html = `
        <html><body>
        <div id="b_results">
          <li class="b_algo">
            <h2><a href="https://example.com/page1">Result Title 1</a></h2>
            <div class="b_caption"><p>Snippet text for result 1</p></div>
          </li>
          <li class="b_algo">
            <h2><a href="https://example.com/page2">Result Title 2</a></h2>
            <div class="b_caption"><p>Snippet text for <strong>result</strong> 2</p></div>
          </li>
        </div>
        <div class="b_rs"><ul><li><a>related search 1</a></li></ul></div>
        </body></html>
      `;

      const result = (provider as any).parseHtml(html, 'test', {}, 800);

      expect(result.search_metadata.engine).toBe('bing');
      expect(result.organic_results).toHaveLength(2);
      expect(result.organic_results[0].title).toBe('Result Title 1');
      expect(result.organic_results[0].link).toBe('https://example.com/page1');
      expect(result.organic_results[0].snippet).toBe('Snippet text for result 1');
      expect(result.organic_results[1].snippet_highlighted_words).toContain('result');
      expect(result.related_searches).toHaveLength(1);
      expect(result.related_searches![0].query).toBe('related search 1');
    });

    it('should return Error status when no results', () => {
      const html = '<html><body><div id="b_results"></div></body></html>';
      const result = (provider as any).parseHtml(html, 'test', {}, 500);
      expect(result.search_metadata.status).toBe('Error');
    });
  });

  describe('search (integration)', () => {
    it('should throw when browserFetcher is not provided', async () => {
      await expect(provider.search('test', {})).rejects.toThrow('BingSearchProvider requires browserFetcher');
    });

    it('should throw on CAPTCHA detection via browserFetcher', async () => {
      const browserFetcher = vi.fn().mockResolvedValue('<html>verify you are human</html>');

      await expect(provider.search('test', { browserFetcher })).rejects.toThrow('CAPTCHA detected');
    });

    it('should use browserFetcher with preloadUrl for international mode', async () => {
      const browserFetcher = vi.fn().mockResolvedValue(`
        <html><body>
        <div id="b_results">
          <li class="b_algo">
            <h2><a href="https://example.com/page1">Result Title 1</a></h2>
            <div class="b_caption"><p>Snippet text</p></div>
          </li>
        </div>
        </body></html>
      `);

      const result = await provider.search('test', { browserFetcher });

      expect(browserFetcher).toHaveBeenCalledTimes(1);
      expect(browserFetcher).toHaveBeenCalledWith(
        expect.stringContaining('cn.bing.com/search'),
        {
          timeout: 30000,
          acceptLanguage: 'en-US,en;q=0.9',
          preloadUrl: 'https://cn.bing.com/?ensearch=1',
        },
      );
      expect(result.search_metadata.engine).toBe('bing');
      expect(result.organic_results).toHaveLength(1);
      expect(result.organic_results[0].title).toBe('Result Title 1');
    });
  });
});
