import { describe, it, expect } from 'vitest';
import { MiMoAdapter } from './mimo-adapter.js';

const NUL = '\u0000';

describe('MiMoAdapter processThinkTags', () => {
  function processChunks(chunks: string[]): { text: string; thinking: string } {
    const textParts: string[] = [];
    const thinkingParts: string[] = [];
    let isInThinkBlock = false;
    let pendingThink = '';
    const adapter = new MiMoAdapter({});

    for (const chunk of chunks) {
      const sseChunk = { type: 'text' as const, content: chunk };
      const generator = adapter.processThinkTagsInternal(sseChunk, isInThinkBlock, pendingThink, (v, pending) => {
        isInThinkBlock = v;
        pendingThink = pending;
      });
      for (const event of generator) {
        if (event.type === 'text') textParts.push(event.content);
        if (event.type === 'thinking') thinkingParts.push(event.content);
      }
    }

    if (pendingThink) {
      if (isInThinkBlock) {
        thinkingParts.push(pendingThink);
      } else {
        textParts.push(pendingThink);
      }
    }

    return { text: textParts.join(''), thinking: thinkingParts.join('') };
  }

  it('should preserve plus-sign command markers in a single chunk', () => {
    const result = processChunks([
      'Hello\n\n++++ list_files path:.\n++++ end',
    ]);
    expect(result.text).toContain('++++ list_files');
  });

  it('should preserve plus-sign command markers across chunks', () => {
    const result = processChunks([
      'Hello\n\n++',
      '++ list_files path:.\n++++ end',
    ]);
    expect(result.text).toContain('++++ list_files');
  });

  it('should handle thinking blocks using \\u0000 delimiter in a single chunk', () => {
    const result = processChunks([
      `Before${NUL}thinking here${NUL}After`,
    ]);
    expect(result.text).toBe('BeforeAfter');
    expect(result.thinking).toBe('thinking here');
  });

  it('should handle thinking blocks split at \\u0000 boundary', () => {
    const result = processChunks([
      `Before${NUL}`,
      `thinking here${NUL}After`,
    ]);
    expect(result.text).toBe('BeforeAfter');
    expect(result.thinking).toBe('thinking here');
  });

  it('should pass through normal text without modification', () => {
    const result = processChunks([
      'This is normal text without any special characters.',
    ]);
    expect(result.text).toBe('This is normal text without any special characters.');
  });

  it('should preserve < in HTML <div> tags across chunk boundaries', () => {
    const result = processChunks([
      'some text <',
      'div>hello</div>',
    ]);
    expect(result.text).toBe('some text <div>hello</div>');
  });

  it('should preserve < in <p> tags across chunk boundaries', () => {
    const result = processChunks([
      'text <',
      'p>test</p>',
    ]);
    expect(result.text).toBe('text <p>test</p>');
  });

  it('should preserve < in <svg> tags across chunk boundaries', () => {
    const result = processChunks([
      '<',
      'svg width="10">path</svg>',
    ]);
    expect(result.text).toBe('<svg width="10">path</svg>');
  });

  it('should preserve < in <b> tags across chunk boundaries', () => {
    const result = processChunks([
      'text <',
      'b>bold</b> text',
    ]);
    expect(result.text).toBe('text <b>bold</b> text');
  });

  it('should preserve <div> in single chunk', () => {
    const result = processChunks(['<div>hello</div>']);
    expect(result.text).toBe('<div>hello</div>');
  });

  it('should preserve <div> when < and div> are in separate chunks', () => {
    const result = processChunks(['<', 'div>hello</div>']);
    expect(result.text).toBe('<div>hello</div>');
  });

  it('should preserve <div class="x"> in single chunk', () => {
    const result = processChunks(['<div class="x">content</div>']);
    expect(result.text).toBe('<div class="x">content</div>');
  });

  it('should preserve <svg><path> in single chunk', () => {
    const result = processChunks(['<svg width="10"><path d="M0"></path></svg>']);
    expect(result.text).toBe('<svg width="10"><path d="M0"></path></svg>');
  });

  it('should preserve <p><span> nested tags in single chunk', () => {
    const result = processChunks(['<p><span>test</span></p>']);
    expect(result.text).toBe('<p><span>test</span></p>');
  });

  it('should preserve text with <b> inline in single chunk', () => {
    const result = processChunks(['text <b>bold</b> text']);
    expect(result.text).toBe('text <b>bold</b> text');
  });

  it('should preserve <d split then iv> (simulating real streaming)', () => {
    const result = processChunks(['text <d', 'iv>hello</div>']);
    expect(result.text).toBe('text <div>hello</div>');
  });

  it('should preserve <s split then vg> (simulating real streaming)', () => {
    const result = processChunks(['<s', 'vg width="10"><path d="M0"></path></svg>']);
    expect(result.text).toBe('<svg width="10"><path d="M0"></path></svg>');
  });

  it('should preserve <p split then > (simulating real streaming)', () => {
    const result = processChunks(['<p', '><span>test</span></p>']);
    expect(result.text).toBe('<p><span>test</span></p>');
  });

  it('should handle thinking block followed by HTML content using \\u0000', () => {
    const result = processChunks([
      `${NUL}thinking content${NUL}<div>hello</div>`,
    ]);
    expect(result.text).toBe('<div>hello</div>');
    expect(result.thinking).toBe('thinking content');
  });

  it('should handle thinking block split then HTML after using \\u0000', () => {
    const result = processChunks([
      `${NUL}thinking`,
      ` content${NUL}<div>hello</div>`,
    ]);
    expect(result.text).toBe('<div>hello</div>');
    expect(result.thinking).toBe('thinking content');
  });

  it('should not treat <template> as think tag', () => {
    const result = processChunks(['<template>content</template>']);
    expect(result.text).toBe('<template>content</template>');
  });

  it('should not treat <th> as think tag', () => {
    const result = processChunks(['<th>header</th>']);
    expect(result.text).toBe('<th>header</th>');
  });

  it('should not treat <th split across chunks as think tag', () => {
    const result = processChunks(['<th', '>header</th>']);
    expect(result.text).toBe('<th>header</th>');
  });

  it('should not treat <title> as think tag', () => {
    const result = processChunks(['<title>page</title>']);
    expect(result.text).toBe('<title>page</title>');
  });

  it('should not treat <textarea> as think tag', () => {
    const result = processChunks(['<textarea>input</textarea>']);
    expect(result.text).toBe('<textarea>input</textarea>');
  });

  it('should not treat <t split across chunks as think tag start', () => {
    const result = processChunks(['text <t', 'd>cell</td>']);
    expect(result.text).toBe('text <td>cell</td>');
  });

  it('should not treat <thi split across chunks as think tag start', () => {
    const result = processChunks(['text <thi', 's>stuff</this>']);
    expect(result.text).toBe('text <this>stuff</this>');
  });

  it('should not treat <thinking> as think tag', () => {
    const result = processChunks(['<thinking>deep thoughts</thinking>']);
    expect(result.text).toBe('<thinking>deep thoughts</thinking>');
  });

  it('should not swallow <think when followed by letter in same chunk', () => {
    const result = processChunks(['text <thinking>about</thinking> more']);
    expect(result.text).toBe('text <thinking>about</thinking> more');
  });

  it('should not swallow <think when followed by letter across chunks', () => {
    const result = processChunks(['text <think', 'ing>about</thinking> more']);
    expect(result.text).toBe('text <thinking>about</thinking> more');
  });

  it('should handle real MiMo format: \\u0000 thinking \\u0000 text', () => {
    const result = processChunks([
      `${NUL}Hmm, thinking${NUL}TEST_A: <div>hello</div>`,
    ]);
    expect(result.text).toBe('TEST_A: <div>hello</div>');
    expect(result.thinking).toBe('Hmm, thinking');
  });

  it('should handle real MiMo format split across chunks', () => {
    const result = processChunks([
      `${NUL}Hmm,`,
      ` thinking${NUL}TEST_A: <div>hello</div>`,
    ]);
    expect(result.text).toBe('TEST_A: <div>hello</div>');
    expect(result.thinking).toBe('Hmm, thinking');
  });

  it('should handle \\u0000 split with text in next chunk followed by HTML', () => {
    const result = processChunks([
      `Some text ${NUL}thinking`,
      `${NUL}<div>hello</div>`,
    ]);
    expect(result.text).toBe('Some text <div>hello</div>');
    expect(result.thinking).toBe('thinking');
  });

  it('should handle \\u0000 followed immediately by <div> in same chunk', () => {
    const result = processChunks([
      `${NUL}thinking${NUL}<div>hello</div>`,
    ]);
    expect(result.text).toBe('<div>hello</div>');
    expect(result.thinking).toBe('thinking');
  });

  it('should handle \\u0000 split with <div> in next chunk', () => {
    const result = processChunks([
      `${NUL}thinking${NUL}`,
      '<div>hello</div>',
    ]);
    expect(result.text).toBe('<div>hello</div>');
    expect(result.thinking).toBe('thinking');
  });

  it('should preserve all < in user reported test cases (single chunk)', () => {
    const result = processChunks([
      'TEST_A: <div>hello</div> TEST_B: <b>bold</b> TEST_C: <svg width="10"><path d="M0"></path></svg>',
    ]);
    expect(result.text).toContain('<div>hello</div>');
    expect(result.text).toContain('<b>bold</b>');
    expect(result.text).toContain('<svg width="10"><path d="M0"></path></svg>');
  });

  it('should handle think block then HTML with <div> split across chunks', () => {
    const result = processChunks([
      `${NUL}thinking${NUL}<`,
      'div>hello</div>',
    ]);
    expect(result.text).toBe('<div>hello</div>');
    expect(result.thinking).toBe('thinking');
  });

  it('should simulate real MiMo SSE stream with \\u0000 delimiters', () => {
    const result = processChunks([
      `${NUL}The user wants`,
      ' me to reply',
      ' with the exact content they specified, without any modifications.',
      `${NUL}TEST`,
      '_A: <div',
      '>hello</div',
      '>',
    ]);
    expect(result.text).toBe('TEST_A: <div>hello</div>');
    expect(result.thinking).toContain('The user wants');
  });

  it('should strip tagged think markers wrapped around \\u0000 delimiters', () => {
    const result = processChunks([
      `<think>${NUL}The user is greeting me in Chinese.</think>${NUL}你好！有什么我可以帮你的吗？`,
    ]);
    expect(result.thinking).toBe('The user is greeting me in Chinese.');
    expect(result.text).toBe('你好！有什么我可以帮你的吗？');
  });

  it('should handle tagged think markers split across multiple chunks', () => {
    const result = processChunks([
      '<thi',
      `nk>${NUL}The user is`,
      ' greeting me',
      ' in Chinese.',
      '</th',
      `ink>${NUL}你好！`,
      '有什么我可以',
      '帮你的吗？',
    ]);
    expect(result.thinking).toBe('The user is greeting me in Chinese.');
    expect(result.text).toBe('你好！有什么我可以帮你的吗？');
  });

  it('should keep incomplete tagged think markers as plain text at stream end', () => {
    const result = processChunks([
      'prefix <think>',
    ]);
    expect(result.text).toBe('prefix <think>');
    expect(result.thinking).toBe('');
  });

  it('should simulate real MiMo SSE stream with \\u0000 in single chunk', () => {
    const result = processChunks([
      `${NUL}The user wants me to reply${NUL}TEST_A: <div>hello</div>`,
    ]);
    expect(result.text).toBe('TEST_A: <div>hello</div>');
    expect(result.thinking).toContain('The user wants');
  });

  it('should handle thinking starting at the very beginning of stream', () => {
    const result = processChunks([
      `${NUL}thinking content${NUL}response text`,
    ]);
    expect(result.text).toBe('response text');
    expect(result.thinking).toBe('thinking content');
  });

  it('should handle multiple think/text blocks', () => {
    const result = processChunks([
      `${NUL}think1${NUL}text1${NUL}think2${NUL}text2`,
    ]);
    expect(result.text).toBe('text1text2');
    expect(result.thinking).toBe('think1think2');
  });

  it('should handle empty thinking content', () => {
    const result = processChunks([
      `${NUL}${NUL}response text`,
    ]);
    expect(result.text).toBe('response text');
    expect(result.thinking).toBe('');
  });

  it('should handle thinking content with <div> inside', () => {
    const result = processChunks([
      `${NUL}I think <div>hello</div>${NUL}actual response`,
    ]);
    expect(result.text).toBe('actual response');
    expect(result.thinking).toBe('I think <div>hello</div>');
  });

  it('should handle text content with \\u0000 inside thinking across chunks', () => {
    const result = processChunks([
      `${NUL}first part`,
      ' second part',
      `${NUL}final text <b>bold</b>`,
    ]);
    expect(result.text).toBe('final text <b>bold</b>');
    expect(result.thinking).toBe('first part second part');
  });

  it('should handle only thinking content without closing delimiter', () => {
    const result = processChunks([
      `${NUL}thinking without end`,
    ]);
    expect(result.thinking).toBe('thinking without end');
    expect(result.text).toBe('');
  });

  it('should handle text then thinking without closing delimiter across chunks', () => {
    const result = processChunks([
      'some text',
      `${NUL}thinking without end`,
    ]);
    expect(result.text).toBe('some text');
    expect(result.thinking).toBe('thinking without end');
  });
});

describe('MiMoAdapter findPartialThinkTag', () => {
  const adapter = new MiMoAdapter({});

  it('should always return -1 (no partial tag detection needed)', () => {
    expect(adapter.findPartialThinkTagInternal('some text<think')).toBe(-1);
  });

  it('should return -1 for normal text', () => {
    expect(adapter.findPartialThinkTagInternal('some text')).toBe(-1);
  });

  it('should return -1 for ++++ followed by tool name', () => {
    expect(adapter.findPartialThinkTagInternal('++++ list_files')).toBe(-1);
  });

  it('should return -1 for <thinking at end', () => {
    expect(adapter.findPartialThinkTagInternal('some text<thinking')).toBe(-1);
  });
});
