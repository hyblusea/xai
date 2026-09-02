import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GoogleSearchProvider } from '../providers/google-provider.js';

describe('GoogleSearchProvider', () => {
  let provider: GoogleSearchProvider;

  beforeEach(() => {
    provider = new GoogleSearchProvider();
  });

  describe('definition', () => {
    it('should have name "google"', () => {
      expect(provider.name).toBe('google');
    });
  });

  describe('buildSearchUrl', () => {
    it('should build correct Google search URL with default options', () => {
      // Access private method via any
      const url = (provider as any).buildSearchUrl('React 19', {});
      expect(url).toContain('https://www.google.com/search?');
      expect(url).toContain('q=React+19');
      expect(url).toContain('num=10');
      expect(url).toContain('hl=zh-CN');
      expect(url).toContain('gl=CN');
    });

    it('should include start parameter for pagination', () => {
      const url = (provider as any).buildSearchUrl('test', { start: 10 });
      expect(url).toContain('start=10');
    });

    it('should respect custom num, hl, gl options', () => {
      const url = (provider as any).buildSearchUrl('test', { num: 5, hl: 'en', gl: 'US' });
      expect(url).toContain('num=5');
      expect(url).toContain('hl=en');
      expect(url).toContain('gl=US');
    });
  });

  describe('isCaptchaPage', () => {
    it('should detect Google CAPTCHA page', () => {
      expect((provider as any).isCaptchaPage('<html>sorry/index</html>')).toBe(true);
      expect((provider as any).isCaptchaPage('<html>unusual traffic</html>')).toBe(true);
      expect((provider as any).isCaptchaPage('<html>detected unusual traffic</html>')).toBe(true);
      expect((provider as any).isCaptchaPage('<html>captcha</html>')).toBe(true);
    });

    it('should not flag normal pages as CAPTCHA', () => {
      expect((provider as any).isCaptchaPage('<html>normal search results</html>')).toBe(false);
    });
  });

  describe('parseHtml', () => {
    it('should parse Google search results HTML', () => {
      const html = `
        <html>
        <body>
        <div id="result-stats">约 12,300,000 条结果</div>
        <div id="rso">
          <div class="g">
            <h3><a href="https://react.dev/blog">React 19 新特性</a></h3>
            <div class="VwiC3b">React 19 引入了 <em>Actions</em>、use() Hook 等新特性</div>
            <span class="byY8ec">https://react.dev › blog</span>
          </div>
          <div class="g">
            <h3><a href="https://example.com">Another Result</a></h3>
            <div class="VwiC3b">Some snippet text</div>
          </div>
        </div>
        </body>
        </html>
      `;

      const result = (provider as any).parseHtml(html, 'React 19', {}, 1000);

      expect(result.search_metadata.engine).toBe('google');
      expect(result.search_metadata.status).toBe('Success');
      expect(result.search_parameters.q).toBe('React 19');
      expect(result.organic_results).toHaveLength(2);
      expect(result.organic_results[0].title).toBe('React 19 新特性');
      expect(result.organic_results[0].link).toBe('https://react.dev/blog');
      expect(result.organic_results[0].snippet).toContain('Actions');
      expect(result.organic_results[0].displayed_link).toBe('https://react.dev › blog');
      expect(result.organic_results[0].snippet_highlighted_words).toContain('Actions');
      expect(result.search_information.total_results).toBe('12,300,000');
    });

    it('should return Error status when no results found', () => {
      const html = '<html><body><div id="rso"></div></body></html>';
      const result = (provider as any).parseHtml(html, 'nonexistent', {}, 500);

      expect(result.search_metadata.status).toBe('Error');
      expect(result.organic_results).toHaveLength(0);
    });

    it('should skip results without title or link', () => {
      const html = `
        <html><body>
        <div id="rso">
          <div class="g">
            <h3>No link here</h3>
            <div class="VwiC3b">snippet</div>
          </div>
          <div class="g">
            <a href="https://example.com">No h3 title</a>
            <div class="VwiC3b">snippet</div>
          </div>
        </div>
        </body></html>
      `;
      const result = (provider as any).parseHtml(html, 'test', {}, 500);
      expect(result.organic_results).toHaveLength(0);
    });
  });

  describe('search (integration)', () => {
    it('should throw on CAPTCHA detection', async () => {
      // Mock fetch to return CAPTCHA page
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue({
        text: () => Promise.resolve('<html>sorry/index</html>'),
      });

      await expect(provider.search('test', {})).rejects.toThrow('CAPTCHA detected');

      globalThis.fetch = originalFetch;
    });
  });
});
