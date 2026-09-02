import { describe, it, expect } from 'vitest';
import { OpenAIAdapter } from './openai-adapter.js';
import type { Message, LLMConfig } from '@xai/shared';

function makeLLMConfig(overrides?: Partial<LLMConfig>): LLMConfig {
  return {
    provider: 'openai',
    model: 'deepseek/deepseek-r1',
    temperature: 0.7,
    stream: true,
    baseUrl: 'https://api.openai.com/v1/chat/completions',
    ...overrides,
  };
}

function makeMessages(): Message[] {
  return [
    { role: 'system', content: 'You are a helpful assistant.', timestamp: 1 },
    { role: 'user', content: 'Hello', timestamp: 2 },
  ];
}

async function collectStream(adapter: OpenAIAdapter, chunks: string[]): Promise<{
  texts: string[];
  thinkings: string[];
  toolCalls: Array<{ name: string; parameters: Record<string, unknown> }>;
  done: boolean;
}> {
  const texts: string[] = [];
  const thinkings: string[] = [];
  const toolCalls: Array<{ name: string; parameters: Record<string, unknown> }> = [];
  let done = false;

  async function* mockStream() {
    for (const chunk of chunks) {
      yield Buffer.from(chunk);
    }
  }

  for await (const event of adapter.translateStream(mockStream())) {
    if (event.type === 'text') texts.push(event.content);
    if (event.type === 'thinking') thinkings.push(event.content);
    if (event.type === 'tool_call' && event.toolCall) toolCalls.push(event.toolCall);
    if (event.type === 'done') done = true;
  }

  return { texts, thinkings, toolCalls, done };
}

// ── translateStream — reasoning field compatibility ─────────────────────────

describe('OpenAIAdapter — translateStream (reasoning)', () => {
  it('should parse delta.reasoning (OpenRouter format) as thinking chunks', async () => {
    // OpenRouter streams reasoning in `delta.reasoning`, NOT `delta.reasoning_content`
    const adapter = new OpenAIAdapter();
    const sseChunks = [
      'data: {"id":"c1","choices":[{"index":0,"delta":{"reasoning":"OpenRouter thinking"},"finish_reason":null}]}\n\n',
      'data: {"id":"c1","choices":[{"index":0,"delta":{"content":"result"},"finish_reason":null}]}\n\n',
      'data: [DONE]\n\n',
    ];

    const result = await collectStream(adapter, sseChunks);

    expect(result.thinkings).toEqual(['OpenRouter thinking']);
    expect(result.texts).toEqual(['result']);
    expect(result.done).toBe(true);

    // Reasoning is persisted to history wrapped in <think> tags for next-turn replay
    const assistantMsg = adapter.getConversationHistory().find(m => m.role === 'assistant');
    expect(assistantMsg?.content).toContain('<think>');
    expect(assistantMsg?.content).toContain('OpenRouter thinking');
    expect(assistantMsg?.content).toContain('result');
  });

  it('should parse delta.reasoning_content (DeepSeek format) as thinking chunks', async () => {
    const adapter = new OpenAIAdapter();
    const sseChunks = [
      'data: {"id":"c1","choices":[{"index":0,"delta":{"reasoning_content":"DeepSeek thinking"},"finish_reason":null}]}\n\n',
      'data: {"id":"c1","choices":[{"index":0,"delta":{"content":"answer"},"finish_reason":null}]}\n\n',
      'data: [DONE]\n\n',
    ];

    const result = await collectStream(adapter, sseChunks);

    expect(result.thinkings).toEqual(['DeepSeek thinking']);
    expect(result.texts).toEqual(['answer']);
  });

  it('should prefer reasoning_content when both fields are present', async () => {
    const adapter = new OpenAIAdapter();
    const sseChunks = [
      'data: {"id":"c1","choices":[{"index":0,"delta":{"reasoning_content":"from_rc","reasoning":"from_or"},"finish_reason":null}]}\n\n',
      'data: [DONE]\n\n',
    ];

    const result = await collectStream(adapter, sseChunks);

    expect(result.thinkings).toEqual(['from_rc']);
  });

  it('should emit each reasoning delta immediately (not buffered until DONE)', async () => {
    const adapter = new OpenAIAdapter();
    const sseChunks = [
      'data: {"id":"c1","choices":[{"index":0,"delta":{"reasoning":"part1 "},"finish_reason":null}]}\n\n',
      'data: {"id":"c1","choices":[{"index":0,"delta":{"reasoning":"part2"},"finish_reason":null}]}\n\n',
      'data: [DONE]\n\n',
    ];

    const result = await collectStream(adapter, sseChunks);

    expect(result.thinkings).toEqual(['part1 ', 'part2']);
  });
});

// ── translateInput — reasoning request params ────────────────────────────────

describe('OpenAIAdapter — translateInput (reasoning effort)', () => {
  it('should send reasoning.effort object for openrouter.ai base URLs', async () => {
    const adapter = new OpenAIAdapter();
    const config = makeLLMConfig({
      baseUrl: 'https://openrouter.ai/api/v1/chat/completions',
      options: { reasoningEffort: 'max' },
    });

    const req = await adapter.translateInput(makeMessages(), config);
    const body = JSON.parse(req.body) as Record<string, unknown>;

    expect(body['reasoning']).toEqual({ effort: 'max' });
    expect(body['reasoning_effort']).toBeUndefined();
  });

  it('should send reasoning_effort string for non-openrouter base URLs', async () => {
    const adapter = new OpenAIAdapter();
    const config = makeLLMConfig({
      baseUrl: 'https://api.deepseek.com/v1/chat/completions',
      options: { reasoningEffort: 'high' },
    });

    const req = await adapter.translateInput(makeMessages(), config);
    const body = JSON.parse(req.body) as Record<string, unknown>;

    expect(body['reasoning_effort']).toBe('high');
    expect(body['reasoning']).toBeUndefined();
  });

  it('should omit reasoning params entirely when effort is off', async () => {
    const adapter = new OpenAIAdapter();
    const config = makeLLMConfig({
      baseUrl: 'https://openrouter.ai/api/v1/chat/completions',
      options: { reasoningEffort: 'off' },
    });

    const req = await adapter.translateInput(makeMessages(), config);
    const body = JSON.parse(req.body) as Record<string, unknown>;

    expect(body['reasoning']).toBeUndefined();
    expect(body['reasoning_effort']).toBeUndefined();
  });
});

// ── translateOutput — non-streaming reasoning ────────────────────────────────

describe('OpenAIAdapter — translateOutput (reasoning)', () => {
  it('should extract message.reasoning (OpenRouter format)', () => {
    const adapter = new OpenAIAdapter();
    const msg = adapter.translateOutput({
      id: 'c1',
      model: 'test',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: 'Answer', reasoning: 'my reasoning' },
        finish_reason: 'stop',
      }],
    });

    expect(msg.content).toContain('<think>');
    expect(msg.content).toContain('my reasoning');
    expect(msg.content).toContain('Answer');
  });

  it('should extract message.reasoning_content (DeepSeek format)', () => {
    const adapter = new OpenAIAdapter();
    const msg = adapter.translateOutput({
      id: 'c1',
      model: 'test',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: 'Answer', reasoning_content: 'rc reasoning' },
        finish_reason: 'stop',
      }],
    });

    expect(msg.content).toContain('<think>');
    expect(msg.content).toContain('rc reasoning');
  });

  it('should not wrap content when no reasoning present', () => {
    const adapter = new OpenAIAdapter();
    const msg = adapter.translateOutput({
      id: 'c1',
      model: 'test',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: 'Plain answer' },
        finish_reason: 'stop',
      }],
    });

    expect(msg.content).toBe('Plain answer');
  });
});