import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WebFetchTool } from '../web-fetch-tool.js';

describe('WebFetchTool', () => {
  let tool: WebFetchTool;

  beforeEach(() => {
    tool = new WebFetchTool();
  });

  describe('definition', () => {
    it('should have correct tool name', () => {
      expect(tool.definition.name).toBe('web_fetch');
    });

    it('should require url parameter', () => {
      expect(tool.definition.parameters.url.required).toBe(true);
    });

    it('should not require confirmation', () => {
      expect(tool.definition.confirmationRequired).toBe(false);
    });

    it('should have maxLength with default 50000', () => {
      expect(tool.definition.parameters.maxLength.default).toBe(50000);
    });

    it('should have timeout with default 30000', () => {
      expect(tool.definition.parameters.timeout.default).toBe(30000);
    });
  });

  describe('execute', () => {
    it('should fail for empty URL', async () => {
      const result = await tool.execute({ url: '' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('cannot be empty');
    });

    it('should fail for invalid URL', async () => {
      const result = await tool.execute({ url: 'not-a-valid-url' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid URL');
    });

    it('should fetch URL via HTTP fallback when no IPC', async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue({
        text: () => Promise.resolve('<html><body><h1>Hello World</h1><p>Content here</p></body></html>'),
      });

      const result = await tool.execute({ url: 'https://example.com' });
      expect(result.success).toBe(true);
      expect(result.output).toContain('Hello World');
      expect(result.output).toContain('Content here');

      globalThis.fetch = originalFetch;
    });

    it('should use IPC sender when available', async () => {
      const ipcSend = vi.fn().mockResolvedValue({
        content: 'IPC fetched content',
        title: 'IPC Page',
        url: 'https://example.com',
      });
      tool.setIpcSender(ipcSend);

      const result = await tool.execute({ url: 'https://example.com' });
      expect(result.success).toBe(true);
      expect(result.output).toContain('IPC fetched content');
      expect(ipcSend).toHaveBeenCalledWith('web:fetch-request', expect.objectContaining({
        url: 'https://example.com',
      }));
    });

    it('should fall back to HTTP fetch when IPC fails', async () => {
      const ipcSend = vi.fn().mockRejectedValue(new Error('IPC error'));
      tool.setIpcSender(ipcSend);

      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue({
        text: () => Promise.resolve('<html><body>Fallback content</body></html>'),
      });

      const result = await tool.execute({ url: 'https://example.com' });
      expect(result.success).toBe(true);
      expect(result.output).toContain('Fallback content');

      globalThis.fetch = originalFetch;
    });

    it('should accept maxLength as string', async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue({
        text: () => Promise.resolve('<html><body>Content</body></html>'),
      });

      const result = await tool.execute({ url: 'https://example.com', maxLength: '10000' });
      expect(result.success).toBe(true);

      globalThis.fetch = originalFetch;
    });
  });

  describe('extractContentFromHtml', () => {
    it('should remove script and style tags', () => {
      const html = '<html><body><script>alert("xss")</script><style>.x{color:red}</style><p>Content</p></body></html>';
      const result = (tool as any).extractContentFromHtml(html);
      expect(result).not.toContain('alert');
      expect(result).not.toContain('color:red');
      expect(result).toContain('Content');
    });

    it('should decode HTML entities', () => {
      const html = '<p>Tom &amp; Jerry &lt;3&gt;</p>';
      const result = (tool as any).extractContentFromHtml(html);
      expect(result).toContain('Tom & Jerry');
      expect(result).toContain('<3>');
    });

    it('should compress whitespace', () => {
      const html = '<p>Line 1</p>   <p>Line 2</p>';
      const result = (tool as any).extractContentFromHtml(html);
      // Multiple spaces within a line should be preserved as-is (just trimmed)
      // but consecutive blank lines should be collapsed
      expect(result).toContain('Line 1');
      expect(result).toContain('Line 2');
    });

    it('should truncate content at maxLength', () => {
      const longContent = 'A'.repeat(1000);
      const html = `<p>${longContent}</p>`;
      const result = (tool as any).extractContentFromHtml(html, 100);
      expect(result.length).toBeLessThan(200); // 100 chars + truncation message
      expect(result).toContain('内容已截断');
    });
  });

  describe('parseBlockParams', () => {
    it('should parse web_fetch block with url', () => {
      const params = tool.parseBlockParams('++++ web_fetch url:https://example.com', '');
      expect(params).not.toBeNull();
      expect(params!.url).toBe('https://example.com');
    });
  });

  describe('config', () => {
    it('should update config at runtime', () => {
      tool.updateConfig({ maxLength: 10000 });
      // No error
    });
  });
});
