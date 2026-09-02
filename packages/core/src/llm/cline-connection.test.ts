/**
 * Tests for Cline connection-related scenarios.
 * Validates the adapter handles edge cases that the test-connection flow exercises.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ClineAdapter } from './cline-adapter.js';
import type { LLMConfig } from '@xai/shared';

function makeConfig(overrides?: Partial<LLMConfig>): LLMConfig {
  return {
    provider: 'cline',
    model: 'anthropic/claude-sonnet-4.5',
    temperature: 0.7,
    stream: false,
    ...overrides,
  };
}

describe('ClineAdapter — test-connection scenarios', () => {
  it('should NOT include max_tokens when not configured (test-connection does not set it)', async () => {
    const adapter = new ClineAdapter();
    const config = makeConfig();
    const messages = [{ role: 'user' as const, content: 'Say OK', timestamp: Date.now() }];

    const request = await adapter.translateInput(messages, config);
    const body = JSON.parse(request.body);

    // max_tokens should be undefined — let the server decide
    expect(body.max_tokens).toBeUndefined();
  });

  it('should include max_tokens only when explicitly configured', async () => {
    const adapter = new ClineAdapter();
    const config = makeConfig({ maxTokens: 4096 });
    const messages = [{ role: 'user' as const, content: 'Say OK', timestamp: Date.now() }];

    const request = await adapter.translateInput(messages, config);
    const body = JSON.parse(request.body);

    expect(body.max_tokens).toBe(4096);
  });

  it('should handle various free model IDs correctly', async () => {
    const adapter = new ClineAdapter();

    const modelIds = [
      'kwaipilot/kat-coder-pro',
      'arcee-ai/trinity-large-preview:free',
      'anthropic/claude-sonnet-4.5',
      'google/gemini-3.1-pro-preview',
    ];

    for (const modelId of modelIds) {
      const config = makeConfig({ model: modelId });
      const messages = [{ role: 'user' as const, content: 'test', timestamp: Date.now() }];
      const request = await adapter.translateInput(messages, config);
      const body = JSON.parse(request.body);

      expect(body.model).toBe(modelId);
    }
  });

  it('should send correct Authorization header for free model requests (with workos: prefix)', async () => {
    const getToken = vi.fn().mockResolvedValue('workos:test-access-token');
    const adapter = new ClineAdapter({ getToken });
    const config = makeConfig({ model: 'kwaipilot/kat-coder-pro' });
    const messages = [{ role: 'user' as const, content: 'Say OK', timestamp: Date.now() }];

    const request = await adapter.translateInput(messages, config);

    // The Cline API requires the workos: prefix on the Bearer token
    expect(request.headers['Authorization']).toBe('Bearer workos:test-access-token');
    expect(getToken).toHaveBeenCalled();
  });

  it('should produce valid request body for Cline chat completions endpoint', async () => {
    const adapter = new ClineAdapter();
    const config = makeConfig({
      model: 'anthropic/claude-sonnet-4.5',
      stream: false,
    });
    const messages = [{ role: 'user' as const, content: 'Say OK', timestamp: Date.now() }];

    const request = await adapter.translateInput(messages, config);
    const body = JSON.parse(request.body);

    // Verify the request matches what Cline API expects
    expect(request.url).toBe('https://api.cline.bot/api/v1/chat/completions');
    expect(request.method).toBe('POST');
    expect(request.headers['Content-Type']).toBe('application/json');
    expect(body.model).toBe('anthropic/claude-sonnet-4.5');
    expect(body.stream).toBe(false);
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].role).toBe('user');
    expect(body.messages[0].content).toBe('Say OK');

    // Verify required Cline billing/metering headers
    expect(request.headers['HTTP-Referer']).toBe('https://cline.bot');
    expect(request.headers['X-Title']).toBe('Cline');
    expect(request.headers['X-CLIENT-TYPE']).toBe('xai-ide');
    expect(request.headers['X-CLIENT-VERSION']).toBe('1.0.0');
    expect(request.headers['X-PLATFORM']).toBe('xai-ide');
    expect(request.headers['User-Agent']).toBe('Cline/1.0.0');
  });

  it('should gracefully handle getToken error when testing connection', async () => {
    const getToken = vi.fn().mockRejectedValue(new Error('Network error'));
    const adapter = new ClineAdapter({ getToken });
    const config = makeConfig({ apiKey: 'fallback-key' });
    const messages = [{ role: 'user' as const, content: 'Say OK', timestamp: Date.now() }];

    const request = await adapter.translateInput(messages, config);

    // Should fallback to apiKey (with workos: prefix added)
    expect(request.headers['Authorization']).toBe('Bearer workos:fallback-key');
  });

  it('should have no auth when both getToken fails and no apiKey', async () => {
    const getToken = vi.fn().mockRejectedValue(new Error('Expired'));
    const adapter = new ClineAdapter({ getToken });
    const config = makeConfig();
    const messages = [{ role: 'user' as const, content: 'Say OK', timestamp: Date.now() }];

    const request = await adapter.translateInput(messages, config);

    expect(request.headers['Authorization']).toBeUndefined();
  });
});

describe('ClineAdapter — required Cline API headers', () => {
  it('should always include billing/metering headers on every request', async () => {
    const adapter = new ClineAdapter();
    const config = makeConfig();
    const messages = [{ role: 'user' as const, content: 'hi', timestamp: Date.now() }];

    const request = await adapter.translateInput(messages, config);

    // All these headers are required by the Cline API
    expect(request.headers['HTTP-Referer']).toBe('https://cline.bot');
    expect(request.headers['X-Title']).toBe('Cline');
    expect(request.headers['X-IS-MULTIROOT']).toBe('false');
    expect(request.headers['X-CLIENT-TYPE']).toBe('xai-ide');
    expect(request.headers['X-CLIENT-VERSION']).toBe('1.0.0');
    expect(request.headers['X-PLATFORM']).toBe('xai-ide');
    expect(request.headers['X-PLATFORM-VERSION']).toBe('1.0.0');
    expect(request.headers['X-CORE-VERSION']).toBe('1.0.0');
    expect(request.headers['User-Agent']).toBe('Cline/1.0.0');
  });

  it('should include Cline headers even with custom headers', async () => {
    const adapter = new ClineAdapter();
    const config = makeConfig({ customHeaders: { 'X-Custom': 'test' } });
    const messages = [{ role: 'user' as const, content: 'hi', timestamp: Date.now() }];

    const request = await adapter.translateInput(messages, config);

    // Cline headers present
    expect(request.headers['X-CLIENT-TYPE']).toBe('xai-ide');
    expect(request.headers['HTTP-Referer']).toBe('https://cline.bot');
    // Custom headers also present
    expect(request.headers['X-Custom']).toBe('test');
  });
});

describe('ClineAdapter — model-specific behavior', () => {
  it('should include tools when provided (for non-free models with tool support)', async () => {
    const adapter = new ClineAdapter();
    const tools = [
      {
        type: 'function' as const,
        function: {
          name: 'read_file',
          description: 'Read a file',
          parameters: { type: 'object' as const, properties: { path: { type: 'string' as const } } },
        },
      },
    ];
    const config = makeConfig({ options: { tools } });
    const messages = [{ role: 'user' as const, content: 'test', timestamp: Date.now() }];

    const request = await adapter.translateInput(messages, config);
    const body = JSON.parse(request.body);

    expect(body.tools).toHaveLength(1);
    expect(body.tools[0].function.name).toBe('read_file');
    expect(body.tool_choice).toBe('auto');
  });

  it('should not include tools when not provided', async () => {
    const adapter = new ClineAdapter();
    const config = makeConfig();
    const messages = [{ role: 'user' as const, content: 'test', timestamp: Date.now() }];

    const request = await adapter.translateInput(messages, config);
    const body = JSON.parse(request.body);

    expect(body.tools).toBeUndefined();
    expect(body.tool_choice).toBeUndefined();
  });

  it('should handle base64 image content in messages', async () => {
    const adapter = new ClineAdapter();
    const config = makeConfig();
    const messages = [{
      role: 'user' as const,
      content: [
        { type: 'text', text: 'What is this?' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBOR...' } },
      ],
      timestamp: Date.now(),
    }];

    const request = await adapter.translateInput(messages, config);
    const body = JSON.parse(request.body);

    // Content array should be passed through as-is
    expect(body.messages[0].content).toHaveLength(2);
    expect(body.messages[0].content[0].type).toBe('text');
    expect(body.messages[0].content[1].type).toBe('image');
  });
});