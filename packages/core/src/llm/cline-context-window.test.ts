/**
 * Tests for Cline provider context window resolution in session-compressor.
 */
import { describe, it, expect } from 'vitest';
import { getContextWindow } from './session-compressor.js';

describe('getContextWindow — cline provider', () => {
  it('should return 1M for Claude Opus 5+ / Sonnet 4.5+ models', () => {
    expect(getContextWindow('cline', 'anthropic/claude-opus-5')).toBe(1_000_000);
    expect(getContextWindow('cline', 'anthropic/claude-opus-4-7')).toBe(1_000_000);
    expect(getContextWindow('cline', 'anthropic/claude-sonnet-4.5')).toBe(1_000_000);
    expect(getContextWindow('cline', 'anthropic/claude-sonnet-4-5-20250929')).toBe(1_000_000);
    expect(getContextWindow('cline', 'anthropic/claude-sonnet-4.6')).toBe(1_000_000);
    expect(getContextWindow('cline', 'anthropic/claude-sonnet-4-6')).toBe(1_000_000);
  });

  it('should return 200K for other Claude models', () => {
    expect(getContextWindow('cline', 'anthropic/claude-3.5-sonnet')).toBe(200_000);
    expect(getContextWindow('cline', 'Claude-3-Haiku')).toBe(200_000);
  });

  it('should return 1M for Gemini models', () => {
    expect(getContextWindow('cline', 'google/gemini-3.1-pro-preview')).toBe(1_000_000);
    expect(getContextWindow('cline', 'Gemini-2.0-Flash')).toBe(1_000_000);
  });

  it('should return 1M for GPT-5 models', () => {
    expect(getContextWindow('cline', 'openai/gpt-5.3-codex')).toBe(1_000_000);
    expect(getContextWindow('cline', 'openai/gpt-4.1')).toBe(1_000_000);
  });

  it('should return 128K for GPT-4o models', () => {
    expect(getContextWindow('cline', 'openai/gpt-4o')).toBe(128_000);
    expect(getContextWindow('cline', 'openai/gpt-4o-mini')).toBe(128_000);
  });

  it('should return 200K for o-series models', () => {
    expect(getContextWindow('cline', 'openai/o1-preview')).toBe(200_000);
    expect(getContextWindow('cline', 'openai/o3-mini')).toBe(200_000);
    expect(getContextWindow('cline', 'openai/o4-mini')).toBe(200_000);
  });

  it('should return 1M for DeepSeek v4+ / R1 models', () => {
    expect(getContextWindow('cline', 'deepseek/deepseek-v4-pro')).toBe(1_000_000);
    expect(getContextWindow('cline', 'deepseek/deepseek-v4-flash')).toBe(1_000_000);
    expect(getContextWindow('cline', 'deepseek/deepseek-r1')).toBe(1_000_000);
    expect(getContextWindow('cline', 'deepseek/deepseek-reasoner')).toBe(1_000_000);
  });

  it('should return 128K for other DeepSeek models', () => {
    expect(getContextWindow('cline', 'deepseek/deepseek-v3')).toBe(128_000);
    expect(getContextWindow('cline', 'deepseek/deepseek-chat')).toBe(128_000);
  });

  it('should return 1M for Qwen 3.5+ models', () => {
    expect(getContextWindow('cline', 'qwen/qwen3.5-max')).toBe(1_000_000);
    expect(getContextWindow('cline', 'qwen/qwen3.7-plus')).toBe(1_000_000);
  });

  it('should return 128K for other Qwen models', () => {
    expect(getContextWindow('cline', 'qwen/qwen2.5-coder')).toBe(128_000);
  });

  it('should return 1M for MiniMax / MiMo models', () => {
    expect(getContextWindow('cline', 'minimax/minimax-m3')).toBe(1_000_000);
    expect(getContextWindow('cline', 'minimax/mimo-v2.5-pro')).toBe(1_000_000);
  });

  it('should return 128K for GLM models', () => {
    expect(getContextWindow('cline', 'zai/glm-5.2')).toBe(128_000);
  });

  it('should return 128K for Kimi models', () => {
    expect(getContextWindow('cline', 'moonshotai/kimi-k3')).toBe(128_000);
  });

  it('should return 200K for Grok models', () => {
    expect(getContextWindow('cline', 'x-ai/grok-3')).toBe(200_000);
  });

  it('should return 128K for cline-free / cline-pass models', () => {
    expect(getContextWindow('cline', 'cline-free/glm-5.2')).toBe(128_000);
    expect(getContextWindow('cline', 'cline-pass/deepseek-v4-pro')).toBe(128_000);
  });

  it('should return 128K for unknown models', () => {
    expect(getContextWindow('cline', 'some-unknown/model')).toBe(128_000);
    expect(getContextWindow('cline', '')).toBe(128_000);
  });

  it('should use explicit config override when provided', () => {
    expect(getContextWindow('cline', 'anthropic/claude-sonnet-4.5', 64000)).toBe(64000);
    expect(getContextWindow('cline', 'unknown-model', 256000)).toBe(256000);
  });

  it('should handle case-insensitive model matching', () => {
    expect(getContextWindow('cline', 'ANTHROPIC/CLAUDE-OPUS-5')).toBe(1_000_000);
    expect(getContextWindow('cline', 'Google/Gemini-Pro')).toBe(1_000_000);
  });
});

describe('getContextWindow — existing providers unchanged', () => {
  it('should still resolve openai models correctly', () => {
    expect(getContextWindow('openai', 'gpt-4o')).toBe(128_000);
    expect(getContextWindow('openai', 'gpt-4.1')).toBe(1_000_000);
    expect(getContextWindow('openai', 'o3-mini')).toBe(200_000);
  });

  it('should still resolve deveco models correctly', () => {
    expect(getContextWindow('deveco', 'GLM-5.1')).toBe(128_000);
  });

  it('should still use default for unknown providers', () => {
    expect(getContextWindow('mimo', 'mimo-v2.5-pro')).toBe(128_000);
    expect(getContextWindow('deepseek', 'deepseek-v4')).toBe(128_000);
  });
});
