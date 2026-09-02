import { describe, it, expect } from 'vitest';
import { defaultParseBlockParams } from './base-tool.js';
import type { ToolDefinition } from '@xai/shared';

/** Minimal tool definition that mirrors list_files */
const listFilesDef: ToolDefinition = {
  name: 'list_files',
  description: 'List files',
  parameters: {
    path: { type: 'string', description: 'Directory path', required: true, location: 'header' },
    recursive: { type: 'boolean', description: 'List recursively', default: false, location: 'header' },
    pattern: { type: 'string', description: 'Glob filter', default: '*.*', location: 'header' },
  },
  confirmationRequired: false,
};

describe('defaultParseBlockParams', () => {
  it('parses normal header without trailing ++++', () => {
    const result = defaultParseBlockParams(
      listFilesDef,
      '++++ list_files path:src recursive:true pattern:*.ts',
      '',
    );
    expect(result).not.toBeNull();
    expect(result!['path']).toBe('src');
    expect(result!['recursive']).toBe(true);
    expect(result!['pattern']).toBe('*.ts');
  });

  it('strips trailing ++++ on the header line', () => {
    const result = defaultParseBlockParams(
      listFilesDef,
      '++++ list_files path:src recursive:true pattern:*.ts ++++',
      '',
    );
    expect(result).not.toBeNull();
    expect(result!['path']).toBe('src');
    expect(result!['recursive']).toBe(true);
    expect(result!['pattern']).toBe('*.ts');
  });

  it('strips trailing ++++ followed by a space (LLM artifact)', () => {
    // This is the exact bug scenario: LLM writes "++++" at the end of the
    // header line with a trailing space before the newline.
    const result = defaultParseBlockParams(
      listFilesDef,
      '++++ list_files path:D:\\myProject\\xAI recursive:true pattern:*.{ts,tsx,js,json} ++++ ',
      '',
    );
    expect(result).not.toBeNull();
    expect(result!['path']).toBe('D:\\myProject\\xAI');
    expect(result!['recursive']).toBe(true);
    expect(result!['pattern']).toBe('*.{ts,tsx,js,json}');
  });

  it('strips trailing ++++ followed by \\r (Windows CRLF artifact)', () => {
    // On Windows, headerLine may include a trailing \r when the raw block
    // uses \r\n line endings and the parser splits on \n.
    const result = defaultParseBlockParams(
      listFilesDef,
      '++++ list_files path:src recursive:true pattern:*.ts ++++\r',
      '',
    );
    expect(result).not.toBeNull();
    expect(result!['path']).toBe('src');
    expect(result!['recursive']).toBe(true);
    expect(result!['pattern']).toBe('*.ts');
  });

  it('strips trailing ++++ followed by multiple spaces', () => {
    const result = defaultParseBlockParams(
      listFilesDef,
      '++++ list_files path:src pattern:*.ts ++++   ',
      '',
    );
    expect(result).not.toBeNull();
    expect(result!['path']).toBe('src');
    expect(result!['pattern']).toBe('*.ts');
  });

  it('does not strip ++++ that is part of a parameter value', () => {
    // If ++++ appears in the middle (not at the end), it should be preserved
    // as part of the value.
    const def: ToolDefinition = {
      name: 'test_tool',
      description: 'Test',
      parameters: {
        query: { type: 'string', description: 'Query', required: true, location: 'header' },
      },
      confirmationRequired: false,
    };
    const result = defaultParseBlockParams(
      def,
      '++++ test_tool query:hello++++world',
      '',
    );
    expect(result).not.toBeNull();
    expect(result!['query']).toBe('hello++++world');
  });

  it('handles Windows absolute path with trailing ++++', () => {
    const result = defaultParseBlockParams(
      listFilesDef,
      '++++ list_files path:D:\\myProject\\xAI recursive:true pattern:*.{ts,tsx,js,json} ++++',
      '',
    );
    expect(result).not.toBeNull();
    expect(result!['path']).toBe('D:\\myProject\\xAI');
    expect(result!['recursive']).toBe(true);
    expect(result!['pattern']).toBe('*.{ts,tsx,js,json}');
  });

  it('returns null when required param is missing', () => {
    const result = defaultParseBlockParams(
      listFilesDef,
      '++++ list_files recursive:true',
      '',
    );
    expect(result).toBeNull();
  });

  it('handles body parameter correctly', () => {
    const writeDef: ToolDefinition = {
      name: 'write_to_file',
      description: 'Write file',
      parameters: {
        path: { type: 'string', description: 'File path', required: true, location: 'header' },
        content: { type: 'string', description: 'Content', required: true, location: 'body' },
      },
      confirmationRequired: false,
    };
    const result = defaultParseBlockParams(
      writeDef,
      '++++ write_to_file path:./src/app.ts',
      'export const x = 1;\n',
    );
    expect(result).not.toBeNull();
    expect(result!['path']).toBe('./src/app.ts');
    expect(result!['content']).toBe('export const x = 1;');
  });
});
