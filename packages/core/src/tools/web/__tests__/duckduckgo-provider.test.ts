import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DuckDuckGoSearchProvider } from '../providers/duckduckgo-provider.js';

describe('DuckDuckGoSearchProvider', () => {
  let provider: DuckDuckGoSearchProvider;

  beforeEach(() => {
    provider = new DuckDuckGoSearchProvider();
  });

  describe('definition', () => {
    it('should have name "duckduckgo"', () => {
      expect(provider.name).toBe('duckduckgo');
    });
  });

  describe('buildSearchUrl', () => {
    it('should build correct DuckDuckGo Lite search URL', () => {
      const url = (provider as any).buildSearchUrl('test query', {});
      expect(url).toContain('https://lite.duckduckgo.com/lite/?');
      expect(url).toContain('q=test+query');
    });

    it('should use cn-zh for CN region', () => {
      const url = (provider as any).buildSearchUrl('test', { gl: 'CN' });
      expect(url).toContain('kl=cn-zh');
    });

    it('should use hl as kl when gl is not CN', () => {
      const url = (provider as any).buildSearchUrl('test', { hl: 'en' });
      expect(url).toContain('kl=en');
    });
  });

  describe('parseHtml', () => {
    it('should parse DuckDuckGo Lite search results HTML', () => {
      const html = `
        <html><body>
        <div class="result">
          <a class="result__a" href="https://example.com/1">First Result</a>
          <a class="result__snippet">Snippet for first result with <strong>highlight</strong></a>
        </div>
        <div class="result">
          <a class="result__a" href="https://example.com/2">Second Result</a>
          <a class="result__snippet">Another snippet</a>
        </div>
        </body></html>
      `;

      const result = (provider as any).parseHtml(html, 'test', {}, 600);

      expect(result.search_metadata.engine).toBe('duckduckgo');
      expect(result.organic_results).toHaveLength(2);
      expect(result.organic_results[0].title).toBe('First Result');
      expect(result.organic_results[0].link).toBe('https://example.com/1');
      expect(result.organic_results[0].snippet_highlighted_words).toContain('highlight');
    });

    it('should return Error status when no results', () => {
      const html = '<html><body></body></html>';
      const result = (provider as any).parseHtml(html, 'test', {}, 500);
      expect(result.search_metadata.status).toBe('Error');
    });
  });

  describe('search (integration)', () => {
    it('should not throw CAPTCHA for DuckDuckGo (no CAPTCHA patterns)', async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue({
        text: () => Promise.resolve('<html><body><div class="result"><a class="result__a" href="https://example.com">Title</a><a class="result__snippet">Snippet</a></div></body></html>'),
      });

      const result = await provider.search('test', {});
      expect(result.search_metadata.status).toBe('Success');
      expect(result.organic_results).toHaveLength(1);

      globalThis.fetch = originalFetch;
    });
  });
});
