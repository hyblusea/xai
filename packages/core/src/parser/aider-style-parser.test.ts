import { describe, it, expect } from 'vitest';
import os from 'os';
import path from 'path';
import { AiderStyleParser, extractAiderBlocks } from './aider-style-parser.js';
import { createDefaultRegistry } from '../tools/index.js';
import { ToolSearchTool } from '../tools/tool-search-tool.js';

function makeParser() {
  const registry = createDefaultRegistry(path.join(os.tmpdir(), 'aider-parser-test'));
  registry.register(new ToolSearchTool(() => []));
  return new AiderStyleParser({ toolRegistry: registry });
}

function parseAll(input: string) {
  const parser = makeParser();
  const events = [...parser.feed(input), ...parser.flush()];
  const toolCalls = events.filter((event) => event.type === 'tool_call' && event.toolCall).map((event) => event.toolCall!);
  const textEvents = events.filter((event) => event.type === 'text');
  const summaryEvents = events.filter((event) => event.type === 'tool_summary');
  return { events, toolCalls, textEvents, summaryEvents };
}

describe('AiderStyleParser', () => {
  it('parses replace_in_file blocks', () => {
    const input = `Before\n\n++++ replace_in_file path:./src/app.ts\nconst x = 1;\n====\nconst x = 2;\n++++ end\n\nAfter`;
    const { toolCalls, textEvents } = parseAll(input);

    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].name).toBe('replace_in_file');
    expect(toolCalls[0].parameters['path']).toBe('./src/app.ts');
    expect(toolCalls[0].parameters['search']).toBe('const x = 1;');
    expect(toolCalls[0].parameters['replace']).toBe('const x = 2;');
    expect(textEvents.map((event) => event.content).join('')).toContain('Before');
  });

  it('parses write_to_file blocks', () => {
    const input = `++++ write_to_file path:./src/hello.ts\nexport const hello = 'world';\n++++ end`;
    const { toolCalls } = parseAll(input);

    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].name).toBe('write_to_file');
    expect(toolCalls[0].parameters['path']).toBe('./src/hello.ts');
    expect(toolCalls[0].parameters['content']).toBe("export const hello = 'world';");
    expect(toolCalls[0].parameters['createDirs']).toBeUndefined();
  });

  it('parses execute_command blocks with header params', () => {
    const input = `++++ execute_command cwd:./packages/core timeout:30000\npnpm test\n++++ end`;
    const { toolCalls } = parseAll(input);

    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].name).toBe('execute_command');
    expect(toolCalls[0].parameters['command']).toBe('pnpm test');
    expect(toolCalls[0].parameters['cwd']).toBe('./packages/core');
    expect(toolCalls[0].parameters['timeout']).toBe(30000);
  });

  it('parses read_file, list_files, and search_files blocks', () => {
    const input = `++++ read_file path:./src/index.ts startLine:5 limit:20\n++++ end\n\n++++ list_files path:src recursive:true pattern:*.ts\n++++ end\n\n++++ search_files pattern:TODO path:. filePattern:*.ts maxResults:20\n++++ end`;
    const { toolCalls } = parseAll(input);

    expect(toolCalls).toHaveLength(3);
    expect(toolCalls[0].parameters).toMatchObject({ path: './src/index.ts', startLine: 5, limit: 20 });
    expect(toolCalls[1].parameters).toMatchObject({ path: 'src', recursive: true, pattern: '*.ts' });
    expect(toolCalls[2].parameters).toMatchObject({ pattern: 'TODO', path: '.', filePattern: '*.ts', maxResults: 20 });
  });

  it('rejects positional header parameters', () => {
    const input = `++++ read_file ./src/index.ts\n++++ end`;
    const { toolCalls, summaryEvents } = parseAll(input);

    expect(toolCalls).toHaveLength(0);
    expect(summaryEvents.map((event) => event.content).join('')).toContain('++++ read_file ./src/index.ts');
  });

  it('handles chunked streaming input', () => {
    const parser = makeParser();
    const events = [
      ...parser.feed('Fixing it\n\n++++ replace_in_'),
      ...parser.feed('file path:./src/app.ts\nold value\n====\n'),
      ...parser.feed('new value\n++++ end'),
      ...parser.flush(),
    ];
    const toolCalls = events.filter((event) => event.type === 'tool_call' && event.toolCall).map((event) => event.toolCall!);

    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].parameters['path']).toBe('./src/app.ts');
    expect(toolCalls[0].parameters['replace']).toBe('new value');
  });

  it('emits tool_summary incrementally while streaming a block', () => {
    const parser = makeParser();
    const events = [
      ...parser.feed('++++ write_to_file path:./src/a.ts\n'),
      ...parser.feed('export const value = 1;\n'),
      ...parser.feed('++++ end'),
      ...parser.flush(),
    ];
    const summary = events.filter((event) => event.type === 'tool_summary').map((event) => event.content).join('');

    expect(summary).toContain('++++ write_to_file path:./src/a.ts');
    expect(summary).toContain('export const value = 1;');
    expect(summary).toContain('++++ end');
  });

  it('keeps incomplete blocks as summaries on flush', () => {
    const { toolCalls, summaryEvents } = parseAll('++++ replace_in_file path:./src/app.ts\nold\n====\nnew');

    expect(toolCalls).toHaveLength(0);
    expect(summaryEvents.map((event) => event.content).join('')).toContain('++++ replace_in_file path:./src/app.ts');
  });

  // ── write_to_file with start_line (insert mode) ─────────────────────────────

  it('parses write_to_file blocks with start_line', () => {
    const input = `++++ write_to_file path:./src/utils.ts start_line:5\nexport function helper() { return true; }\n++++ end`;
    const { toolCalls } = parseAll(input);

    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].name).toBe('write_to_file');
    expect(toolCalls[0].parameters['path']).toBe('./src/utils.ts');
    expect(toolCalls[0].parameters['start_line']).toBe(5);
    expect(toolCalls[0].parameters['content']).toBe('export function helper() { return true; }');
  });

  it('parses write_to_file with start_line and multiline content', () => {
    const input = `++++ write_to_file path:./src/log.ts start_line:10\nline1\nline2\nline3\n++++ end`;
    const { toolCalls } = parseAll(input);

    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].parameters['content']).toBe('line1\nline2\nline3');
    expect(toolCalls[0].parameters['start_line']).toBe(10);
  });

  // ── remove_line ─────────────────────────────────────────────────────────────

  it('parses remove_line blocks with body', () => {
    const input = `++++ remove_line path:./src/app.ts startLine:10 endLine:15\n++++ end`;
    const { toolCalls } = parseAll(input);

    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].name).toBe('remove_line');
    expect(toolCalls[0].parameters['path']).toBe('./src/app.ts');
    expect(toolCalls[0].parameters['startLine']).toBe(10);
    expect(toolCalls[0].parameters['endLine']).toBe(15);
  });

  it('parses remove_line with only startLine', () => {
    const input = `++++ remove_line path:./src/app.ts startLine:7\n++++ end`;
    const { toolCalls } = parseAll(input);

    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].parameters['startLine']).toBe(7);
    expect(toolCalls[0].parameters['endLine']).toBeUndefined();
  });

  // ── grep_search ─────────────────────────────────────────────────────────────

  it('parses grep_search with basic params', () => {
    const input = `++++ grep_search path:src pattern:TODO context:3\n++++ end`;
    const { toolCalls } = parseAll(input);

    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].name).toBe('grep_search');
    expect(toolCalls[0].parameters['path']).toBe('src');
    expect(toolCalls[0].parameters['pattern']).toBe('TODO');
    expect(toolCalls[0].parameters['context']).toBe(3);
  });

  it('parses grep_search with pipe-separated regex pattern', () => {
    const input = `++++ grep_search path:packages/electron/src/main.ts pattern:devtools|DevTools|openDevTools context:5\n++++ end`;
    const { toolCalls } = parseAll(input);

    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].parameters['pattern']).toBe('devtools|DevTools|openDevTools');
    expect(toolCalls[0].parameters['context']).toBe(5);
  });

  it('parses grep_search with ignoreCase:false', () => {
    const input = `++++ grep_search path:src/index.ts pattern:function\\s+\\w+ ignoreCase:false\n++++ end`;
    const { toolCalls } = parseAll(input);

    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].parameters['ignoreCase']).toBe(false);
  });

  it('parses grep_search with filePattern and maxResults', () => {
    const input = `++++ grep_search path:src/utils pattern:import.*lodash filePattern:*.ts context:3 maxResults:50\n++++ end`;
    const { toolCalls } = parseAll(input);

    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].parameters['filePattern']).toBe('*.ts');
    expect(toolCalls[0].parameters['maxResults']).toBe(50);
    expect(toolCalls[0].parameters['context']).toBe(3);
  });

  it('parses grep_search with complex pattern including Ctrl+Shift+I', () => {
    const input = `++++ grep_search path:packages/electron/src/main.ts pattern:devtools|DevTools|F12|Ctrl+Shift+I|toggle-devtools|openDevTools ignoreCase:false context:5\n++++ end`;
    const { toolCalls } = parseAll(input);

    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].parameters['pattern']).toBe('devtools|DevTools|F12|Ctrl+Shift+I|toggle-devtools|openDevTools');
    expect(toolCalls[0].parameters['ignoreCase']).toBe(false);
    expect(toolCalls[0].parameters['context']).toBe(5);
  });

  it('rejects grep_search without required path', () => {
    const input = `++++ grep_search pattern:TODO\n++++ end`;
    const { toolCalls } = parseAll(input);
    expect(toolCalls).toHaveLength(0);
  });

  it('rejects grep_search without required pattern', () => {
    const input = `++++ grep_search path:src\n++++ end`;
    const { toolCalls } = parseAll(input);
    expect(toolCalls).toHaveLength(0);
  });

  // ── tool_search ─────────────────────────────────────────────────────────────

  it('parses tool_search blocks', () => {
    const input = `++++ tool_search query:github\n++++ end`;
    const { toolCalls } = parseAll(input);

    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].name).toBe('tool_search');
    expect(toolCalls[0].parameters['query']).toBe('github');
  });

  it('parses tool_search with complex query', () => {
    const input = `++++ tool_search query:database-postgres\n++++ end`;
    const { toolCalls } = parseAll(input);

    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].parameters['query']).toBe('database-postgres');
  });

  it('rejects tool_search without required query', () => {
    const input = `++++ tool_search\n++++ end`;
    const { toolCalls } = parseAll(input);
    expect(toolCalls).toHaveLength(0);
  });

  // ── execute_command (additional) ────────────────────────────────────────────

  it('parses execute_command without header params', () => {
    const input = `++++ execute_command\nnpm run build\n++++ end`;
    const { toolCalls } = parseAll(input);

    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].name).toBe('execute_command');
    expect(toolCalls[0].parameters['command']).toBe('npm run build');
    expect(toolCalls[0].parameters['cwd']).toBeUndefined();
  });

  it('parses execute_command with multiline command', () => {
    const input = `++++ execute_command\ncd packages/core\nnpm test\n++++ end`;
    const { toolCalls } = parseAll(input);

    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].parameters['command']).toBe('cd packages/core\nnpm test');
  });

  // ── read_file (additional) ──────────────────────────────────────────────────

  it('parses read_file with only path', () => {
    const input = `++++ read_file path:./src/index.ts\n++++ end`;
    const { toolCalls } = parseAll(input);

    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].parameters['path']).toBe('./src/index.ts');
    expect(toolCalls[0].parameters['startLine']).toBeUndefined();
    expect(toolCalls[0].parameters['limit']).toBeUndefined();
  });

  // ── list_files (additional) ─────────────────────────────────────────────────

  it('parses list_files with only path', () => {
    const input = `++++ list_files path:src\n++++ end`;
    const { toolCalls } = parseAll(input);

    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].parameters['path']).toBe('src');
    expect(toolCalls[0].parameters['recursive']).toBeUndefined();
  });

  it('strips trailing ++++ on header line (LLM artifact)', () => {
    const input = `++++ list_files path:D:\\myProject\\xAI recursive:true pattern:*.{ts,tsx,js,json} ++++\n++++ end`;
    const { toolCalls } = parseAll(input);

    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].parameters['path']).toBe('D:\\myProject\\xAI');
    expect(toolCalls[0].parameters['recursive']).toBe(true);
    expect(toolCalls[0].parameters['pattern']).toBe('*.{ts,tsx,js,json}');
  });

  // ── search_files (additional) ───────────────────────────────────────────────

  it('parses search_files with pipe pattern', () => {
    const input = `++++ search_files pattern:TODO|FIXME path:. filePattern:*.ts\n++++ end`;
    const { toolCalls } = parseAll(input);

    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].parameters['pattern']).toBe('TODO|FIXME');
    expect(toolCalls[0].parameters['path']).toBe('.');
    expect(toolCalls[0].parameters['filePattern']).toBe('*.ts');
  });

  it('strips code fences around command blocks', () => {
    const input = 'Before\n```\n++++ execute_command\npnpm test\n++++ end\n```\nAfter';
    const { toolCalls, textEvents } = parseAll(input);
    const text = textEvents.map((event) => event.content).join('');

    expect(toolCalls).toHaveLength(1);
    expect(text).not.toContain('```');
    expect(text).toContain('Before');
    expect(text).toContain('After');
  });

  // ── relaxed close marker (no line-start requirement) ────────────────────────

  it('closes block when ++++ end is glued to preceding content inline', () => {
    // LLMs sometimes emit `...text |++++ end` without a line break before the
    // marker. The block must still be recognised and executed.
    const input = `长会话预算不爆 |++++ write_to_file path:docs/design.md
# Design Doc
body line
++++ end`;
    const { toolCalls } = parseAll(input);

    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].name).toBe('write_to_file');
    expect(toolCalls[0].parameters['path']).toBe('docs/design.md');
    expect(toolCalls[0].parameters['content']).toBe('# Design Doc\nbody line');
  });

  it('closes block when ++++ end appears inline mid-sentence', () => {
    const input = `++++ grep_search path:src pattern:TODO context:3\n++++ end 以上是我的回答`;
    const { toolCalls, textEvents } = parseAll(input);

    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].name).toBe('grep_search');
    expect(textEvents.map((event) => event.content).join('')).toContain('以上是我的回答');
  });

  it('does not close block on prose like "++++ ended"', () => {
    const input = `++++ write_to_file path:./a.txt
the list was ++++ ended here\nreal content\n++++ end`;
    const { toolCalls } = parseAll(input);

    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].parameters['content']).toBe('the list was ++++ ended here\nreal content');
  });

  it('handles inline close marker split across stream chunks', () => {
    const parser = makeParser();
    const events = [
      ...parser.feed('++++ write_to_file path:./src/a.ts\n'),
      ...parser.feed('export const value = 1;\n表尾 |++++ '),
      ...parser.feed('end'),
      ...parser.flush(),
    ];
    const toolCalls = events.filter((event) => event.type === 'tool_call' && event.toolCall).map((event) => event.toolCall!);

    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].parameters['content']).toBe('export const value = 1;\n表尾 |');
  });
});

describe('extractAiderBlocks', () => {
  function makeExtractor() {
    const registry = createDefaultRegistry(path.join(os.tmpdir(), 'aider-parser-test'));
    registry.register(new ToolSearchTool(() => []));
    return (text: string) => extractAiderBlocks(text, { toolRegistry: registry });
  }

  it('extracts multiple command blocks from a full response', () => {
    const text = `++++ write_to_file path:./src/a.ts\nexport const a = 1;\n++++ end\n\n++++ replace_in_file path:./src/b.ts\nold\n====\nnew\n++++ end\n\n++++ execute_command\npnpm test\n++++ end`;
    const calls = makeExtractor()(text);

    expect(calls).toHaveLength(3);
    expect(calls[0].name).toBe('write_to_file');
    expect(calls[1].name).toBe('replace_in_file');
    expect(calls[2].name).toBe('execute_command');
  });

  it('extracts grep_search and tool_search blocks', () => {
    const text = `++++ grep_search path:src pattern:TODO context:3\n++++ end\n\n++++ tool_search query:github\n++++ end`;
    const calls = makeExtractor()(text);

    expect(calls).toHaveLength(2);
    expect(calls[0].name).toBe('grep_search');
    expect(calls[0].parameters['path']).toBe('src');
    expect(calls[0].parameters['pattern']).toBe('TODO');
    expect(calls[1].name).toBe('tool_search');
    expect(calls[1].parameters['query']).toBe('github');
  });

  // ── terminal tools ──────────────────────────────────────────────────────────

  it('parses terminal_open with optional params', () => {
    const input = `++++ terminal_open shell:cmd\n++++ end`;
    const { toolCalls } = parseAll(input);

    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].name).toBe('terminal_open');
    expect(toolCalls[0].parameters['shell']).toBe('cmd');
  });

  it('parses terminal_open with no params', () => {
    const input = `++++ terminal_open\n++++ end`;
    const { toolCalls } = parseAll(input);

    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].name).toBe('terminal_open');
    expect(toolCalls[0].parameters['shell']).toBeUndefined();
  });

  it('parses terminal_open with shell and cwd', () => {
    const input = `++++ terminal_open shell:powershell cwd:./myproject\n++++ end`;
    const { toolCalls } = parseAll(input);

    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].parameters['shell']).toBe('powershell');
    expect(toolCalls[0].parameters['cwd']).toBe('./myproject');
  });

  it('parses terminal_send with sessionId and body command', () => {
    const input = `++++ terminal_send sessionId:term_xxxx\nping -n 3 127.0.0.1\n++++ end`;
    const { toolCalls } = parseAll(input);

    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].name).toBe('terminal_send');
    expect(toolCalls[0].parameters['sessionId']).toBe('term_xxxx');
    expect(toolCalls[0].parameters['command']).toBe('ping -n 3 127.0.0.1');
  });

  it('parses terminal_send with timeout', () => {
    const input = `++++ terminal_send sessionId:term_xxxx timeout:60000\ndocker logs myapp --tail 100\n++++ end`;
    const { toolCalls } = parseAll(input);

    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].parameters['sessionId']).toBe('term_xxxx');
    expect(toolCalls[0].parameters['timeout']).toBe(60000);
    expect(toolCalls[0].parameters['command']).toBe('docker logs myapp --tail 100');
  });

  it('parses terminal_send with multiline command', () => {
    const input = `++++ terminal_send sessionId:term_xxxx\ncd /tmp\nls -la\n++++ end`;
    const { toolCalls } = parseAll(input);

    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].parameters['command']).toBe('cd /tmp\nls -la');
  });

  it('parses terminal_send with interactive:true', () => {
    const input = `++++ terminal_send sessionId:term_xxxx interactive:true\nssh user@192.168.1.1\n++++ end`;
    const { toolCalls } = parseAll(input);

    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].name).toBe('terminal_send');
    expect(toolCalls[0].parameters['sessionId']).toBe('term_xxxx');
    expect(toolCalls[0].parameters['interactive']).toBe(true);
    expect(toolCalls[0].parameters['command']).toBe('ssh user@192.168.1.1');
  });

  it('parses terminal_send with background:true', () => {
    const input = `++++ terminal_send sessionId:term_xxxx background:true\nlong_task.sh\n++++ end`;
    const { toolCalls } = parseAll(input);

    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].parameters['background']).toBe(true);
    expect(toolCalls[0].parameters['command']).toBe('long_task.sh');
  });

  it('parses terminal_send with interactive:false as false', () => {
    const input = `++++ terminal_send sessionId:term_xxxx interactive:false\necho hello\n++++ end`;
    const { toolCalls } = parseAll(input);

    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].parameters['interactive']).toBe(false);
  });

  it('parses terminal_close with sessionId', () => {
    const input = `++++ terminal_close sessionId:term_xxxx\n++++ end`;
    const { toolCalls } = parseAll(input);

    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].name).toBe('terminal_close');
    expect(toolCalls[0].parameters['sessionId']).toBe('term_xxxx');
  });

  it('parses terminal_poll with sessionId', () => {
    const input = `++++ terminal_poll sessionId:term_xyz789\n++++ end`;
    const { toolCalls } = parseAll(input);

    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].name).toBe('terminal_poll');
    expect(toolCalls[0].parameters['sessionId']).toBe('term_xyz789');
  });

  it('parses terminal_poll with wait and timeout', () => {
    const input = `++++ terminal_poll sessionId:term_xyz789 wait:true timeout:60000\n++++ end`;
    const { toolCalls } = parseAll(input);

    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].name).toBe('terminal_poll');
    expect(toolCalls[0].parameters['sessionId']).toBe('term_xyz789');
    expect(toolCalls[0].parameters['wait']).toBe(true);
    expect(toolCalls[0].parameters['timeout']).toBe(60000);
  });

  it('parses terminal_poll with wait:false', () => {
    const input = `++++ terminal_poll sessionId:term_xyz789 wait:false\n++++ end`;
    const { toolCalls } = parseAll(input);

    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].parameters['wait']).toBe(false);
  });

  it('handles chunked streaming of terminal commands', () => {
    const parser = makeParser();
    const events = [
      ...parser.feed('Opening terminal\n\n++++ terminal_send sessionId:term_'),
      ...parser.feed('abc123\nping -n '),
      ...parser.feed('5 127.0.0.1\n++++ end'),
      ...parser.flush(),
    ];
    const toolCalls = events.filter((event) => event.type === 'tool_call' && event.toolCall).map((event) => event.toolCall!);

    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].name).toBe('terminal_send');
    expect(toolCalls[0].parameters['sessionId']).toBe('term_abc123');
    expect(toolCalls[0].parameters['command']).toBe('ping -n 5 127.0.0.1');
  });

  it('extracts terminal blocks from a full response', () => {
    const text = `++++ terminal_open shell:cmd\n++++ end\n\n++++ terminal_send sessionId:term_123\nping -n 5 127.0.0.1\n++++ end\n\n++++ terminal_close sessionId:term_123\n++++ end`;
    const calls = makeExtractor()(text);

    expect(calls).toHaveLength(3);
    expect(calls[0].name).toBe('terminal_open');
    expect(calls[0].parameters['shell']).toBe('cmd');
    expect(calls[1].name).toBe('terminal_send');
    expect(calls[1].parameters['command']).toBe('ping -n 5 127.0.0.1');
    expect(calls[2].name).toBe('terminal_close');
    expect(calls[2].parameters['sessionId']).toBe('term_123');
  });
});