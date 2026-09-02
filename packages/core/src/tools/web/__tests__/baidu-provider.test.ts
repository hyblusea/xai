import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BaiduSearchProvider } from '../providers/baidu-provider.js';

describe('BaiduSearchProvider', () => {
  let provider: BaiduSearchProvider;

  beforeEach(() => {
    provider = new BaiduSearchProvider();
  });

  describe('definition', () => {
    it('should have name "baidu"', () => {
      expect(provider.name).toBe('baidu');
    });
  });

  describe('buildSearchUrl', () => {
    it('should build correct Baidu search URL', () => {
      const url = (provider as any).buildSearchUrl('测试', {});
      expect(url).toContain('https://www.baidu.com/s?');
      expect(url).toContain('wd=');
      expect(url).toContain('rn=10');
      expect(url).toContain('hl=zh-CN');
    });

    it('should include pn for pagination', () => {
      const url = (provider as any).buildSearchUrl('test', { start: 10 });
      expect(url).toContain('pn=10');
    });
  });

  describe('isCaptchaPage', () => {
    it('should detect Baidu CAPTCHA page', () => {
      expect((provider as any).isCaptchaPage('<html>验证码</html>')).toBe(true);
      expect((provider as any).isCaptchaPage('<html>captcha_verify</html>')).toBe(true);
      expect((provider as any).isCaptchaPage('<html>安全验证</html>')).toBe(true);
    });

    it('should not flag normal pages', () => {
      expect((provider as any).isCaptchaPage('<html>正常搜索结果</html>')).toBe(false);
    });
  });

  describe('parseHtml', () => {
    it('should parse Baidu search results HTML', () => {
      const html = `
        <html><body>
        <div id="content_left">
          <div class="result">
            <h3><a href="https://example.com/1">百度结果1</a></h3>
            <div class="c-abstract">这是第一个结果的摘要 <em>关键词</em></div>
            <span class="c-showurl">example.com</span>
          </div>
          <div class="c-container">
            <h3><a href="https://example.com/2">百度结果2</a></h3>
            <div class="c-abstract">第二个结果的摘要</div>
          </div>
        </div>
        <div id="rs"><table><tr><td><a>相关搜索1</a></td></tr></table></div>
        </body></html>
      `;

      const result = (provider as any).parseHtml(html, '测试', {}, 700);

      expect(result.search_metadata.engine).toBe('baidu');
      expect(result.organic_results).toHaveLength(2);
      expect(result.organic_results[0].title).toBe('百度结果1');
      expect(result.organic_results[0].link).toBe('https://example.com/1');
      expect(result.organic_results[0].displayed_link).toBe('example.com');
      expect(result.organic_results[0].snippet_highlighted_words).toContain('关键词');
      expect(result.related_searches).toHaveLength(1);
      expect(result.related_searches![0].query).toBe('相关搜索1');
    });

    it('should return Error status when no results', () => {
      const html = '<html><body><div id="content_left"></div></body></html>';
      const result = (provider as any).parseHtml(html, 'test', {}, 500);
      expect(result.search_metadata.status).toBe('Error');
    });
  });

  describe('search (integration)', () => {
    it('should throw on CAPTCHA detection', async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue({
        text: () => Promise.resolve('<html>验证码</html>'),
      });

      await expect(provider.search('test', {})).rejects.toThrow('CAPTCHA detected');

      globalThis.fetch = originalFetch;
    });
  });
});
