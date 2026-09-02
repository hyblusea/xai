import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GptAdapter } from './gpt-adapter.js';
import type { GptAdapterOptions } from './gpt-adapter.js';

type AdapterAny = any;

function createAdapter(opts?: Partial<GptAdapterOptions>): AdapterAny {
  return new GptAdapter(opts);
}

describe('GptAdapter Proxy', () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    // Clear any existing proxy env vars
    delete process.env.HTTP_PROXY;
    delete process.env.HTTPS_PROXY;
    delete process.env.http_proxy;
    delete process.env.https_proxy;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('Proxy initialization', () => {
    it('should not initialize proxy when proxyUrl is not provided', async () => {
      const adapter = createAdapter({
        baseUrl: 'https://chatgpt.com',
        authorization: 'Bearer test',
      });

      expect(adapter._proxyUrl).toBeNull();
      expect(adapter._proxyDispatcher).toBeNull();
    });

    it('should store proxyUrl when provided', async () => {
      const adapter = createAdapter({
        baseUrl: 'https://chatgpt.com',
        authorization: 'Bearer test',
        proxyUrl: 'http://127.0.0.1:10808',
      });

      expect(adapter._proxyUrl).toBe('http://127.0.0.1:10808');
    });

    it('should lazily initialize proxy dispatcher on first request', async () => {
      const adapter = createAdapter({
        baseUrl: 'https://chatgpt.com',
        authorization: 'Bearer test',
        proxyUrl: 'http://127.0.0.1:10808',
      });

      // Proxy dispatcher should be null initially
      expect(adapter._proxyDispatcher).toBeNull();

      // Trigger proxy initialization
      const fetchOptions = await adapter.getFetchOptions();

      // Now dispatcher should be initialized
      expect(adapter._proxyDispatcher).not.toBeNull();
      expect(fetchOptions).toHaveProperty('dispatcher');
    });

    it('should handle proxy initialization errors gracefully', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      // Use an invalid proxy URL format to trigger error
      // Note: https-proxy-agent is more lenient, so we test with a URL that will fail during connection
      const adapter = createAdapter({
        baseUrl: 'https://chatgpt.com',
        authorization: 'Bearer test',
        proxyUrl: 'http://[invalid-url-with-brackets]:99999',
      });

      // The agent may or may not throw during initialization depending on the URL
      // Just verify it doesn't crash
      await expect(adapter.getFetchOptions()).resolves.toBeDefined();

      consoleErrorSpy.mockRestore();
      consoleLogSpy.mockRestore();
    });

    it('should only initialize proxy once', async () => {
      const adapter = createAdapter({
        baseUrl: 'https://chatgpt.com',
        authorization: 'Bearer test',
        proxyUrl: 'http://127.0.0.1:10808',
      });

      const options1 = await adapter.getFetchOptions();
      const dispatcher1 = adapter._proxyDispatcher;

      const options2 = await adapter.getFetchOptions();
      const dispatcher2 = adapter._proxyDispatcher;

      // Should be the same instance
      expect(dispatcher1).toBe(dispatcher2);
    });
  });

  describe('Proxy with different URL formats', () => {
    it('should handle http:// proxy URL', async () => {
      const adapter = createAdapter({
        proxyUrl: 'http://127.0.0.1:7890',
      });

      const options = await adapter.getFetchOptions();
      expect(adapter._proxyUrl).toBe('http://127.0.0.1:7890');
    });

    it('should handle https:// proxy URL', async () => {
      const adapter = createAdapter({
        proxyUrl: 'https://proxy.example.com:8080',
      });

      const options = await adapter.getFetchOptions();
      expect(adapter._proxyUrl).toBe('https://proxy.example.com:8080');
    });

    it('should handle proxy URL with authentication', async () => {
      const adapter = createAdapter({
        proxyUrl: 'http://user:pass@127.0.0.1:10808',
      });

      const options = await adapter.getFetchOptions();
      expect(adapter._proxyUrl).toBe('http://user:pass@127.0.0.1:10808');
    });
  });

  describe('Proxy integration with fetch', () => {
    it('should include dispatcher in fetch options when proxy is configured', async () => {
      const adapter = createAdapter({
        proxyUrl: 'http://127.0.0.1:10808',
      });

      const options = await adapter.getFetchOptions();

      expect(options).toHaveProperty('dispatcher');
      expect(options.dispatcher).not.toBeNull();
    });

    it('should not include dispatcher when proxy is not configured', async () => {
      const adapter = createAdapter({});

      const options = await adapter.getFetchOptions();

      expect(options).not.toHaveProperty('dispatcher');
    });
  });
});
