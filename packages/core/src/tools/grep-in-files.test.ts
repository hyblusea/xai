import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import path from 'path';
import os from 'os';
import { GrepInFilesTool } from './grep-in-files.js';

describe('GrepInFilesTool', () => {
  let tmpDir: string;
  let tool: GrepInFilesTool;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `grep-in-files-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    tool = new GrepInFilesTool(tmpDir);
  });

  afterEach(() => {
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  function writeFile(name: string, content: string, subdir?: string): string {
    const dir = subdir ? path.join(tmpDir, subdir) : tmpDir;
    mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, name);
    writeFileSync(filePath, content, 'utf-8');
    return filePath;
  }

  // ── Definition ──────────────────────────────────────────────────────────────

  describe('definition', () => {
    it('should have correct tool name', () => {
      expect(tool.definition.name).toBe('grep_search');
    });

    it('should require path and pattern parameters', () => {
      expect(tool.definition.parameters.path.required).toBe(true);
      expect(tool.definition.parameters.pattern.required).toBe(true);
    });

    it('should not require confirmation', () => {
      expect(tool.definition.confirmationRequired).toBe(false);
    });

    it('should have examples including pipe-separated multi-keyword', () => {
      expect(tool.definition.examples?.length).toBeGreaterThanOrEqual(2);
      // Verify pipe alternation example exists
      const pipeExample = tool.definition.examples?.find((e) => e.includes('|'));
      expect(pipeExample).toBeDefined();
      expect(pipeExample).toContain('grep_search');
    });
  });

  // ── Single file search ──────────────────────────────────────────────────────

  describe('single file search', () => {
    it('should find a simple pattern in a single file', async () => {
      const filePath = writeFile('hello.txt', 'foo bar\nbaz foo\ngap line\nanother gap\nno match here');

      const result = await tool.execute({ path: filePath, pattern: 'foo' });

      expect(result.success).toBe(true);
      expect(result.output).toContain('foo bar');
      expect(result.output).toContain('baz foo');
      // 'no match here' is beyond the default 2-line context from line 2
      expect(result.output).not.toContain('no match here');
      expect(result.output).toContain('2 match');
    });

    it('should return file header with match count', async () => {
      const filePath = writeFile('test.txt', 'line1\nTODO fix this\nTODO refactor\nline4');

      const result = await tool.execute({ path: filePath, pattern: 'TODO' });

      expect(result.success).toBe(true);
      expect(result.output).toContain('test.txt');
      expect(result.output).toContain('2 matches');
    });

    it('should include match marker (▶) on matched lines', async () => {
      const filePath = writeFile('markers.txt', 'aaa\nbbb target\nccc');

      const result = await tool.execute({ path: filePath, pattern: 'target', context: 1 });

      expect(result.success).toBe(true);
      // Matched line should have ▶ marker
      expect(result.output).toMatch(/▶.*2.*│.*bbb target/);
      // Non-matched context lines should not have ▶
      expect(result.output).toMatch(/\s+1\s*│.*aaa/);
    });
  });

  // ── Context lines ────────────────────────────────────────────────────────────

  describe('context lines', () => {
    it('should show default 0 context lines (match only)', async () => {
      const lines = ['line1', 'line2', 'line3', 'MATCH_HERE', 'line5', 'line6', 'line7'];
      const filePath = writeFile('ctx.txt', lines.join('\n'));

      const result = await tool.execute({ path: filePath, pattern: 'MATCH_HERE' });

      expect(result.success).toBe(true);
      expect(result.output).toContain('MATCH_HERE');
      // Default context is now 0, so no surrounding lines
      expect(result.output).not.toContain('line2');
      expect(result.output).not.toContain('line3');
      expect(result.output).not.toContain('line5');
      expect(result.output).not.toContain('line6');
    });

    it('should respect custom context parameter', async () => {
      const lines = ['L1', 'L2', 'L3', 'L4', 'HIT', 'L6', 'L7', 'L8', 'L9'];
      const filePath = writeFile('ctx-custom.txt', lines.join('\n'));

      const result = await tool.execute({ path: filePath, pattern: 'HIT', context: 1 });

      expect(result.success).toBe(true);
      expect(result.output).toContain('L4');
      expect(result.output).toContain('HIT');
      expect(result.output).toContain('L6');
      expect(result.output).not.toContain('L3');
      expect(result.output).not.toContain('L7');
    });

    it('should handle context:0 (no context lines)', async () => {
      const lines = ['before1', 'before2', 'MATCH', 'after1', 'after2'];
      const filePath = writeFile('ctx0.txt', lines.join('\n'));

      const result = await tool.execute({ path: filePath, pattern: 'MATCH', context: 0 });

      expect(result.success).toBe(true);
      expect(result.output).toContain('MATCH');
      expect(result.output).not.toContain('before1');
      expect(result.output).not.toContain('after1');
    });

    it('should merge overlapping context groups when matches are close', async () => {
      // Lines 1-10, match at line 3 and line 6 → context=2 makes them overlap
      const lines = Array.from({ length: 10 }, (_, i) => `L${i + 1}`);
      lines[2] = 'HIT_A';  // line 3
      lines[5] = 'HIT_B';  // line 6
      const filePath = writeFile('merge.txt', lines.join('\n'));

      const result = await tool.execute({ path: filePath, pattern: 'HIT_', context: 2 });

      expect(result.success).toBe(true);
      // Both matches and all context should appear in a single merged group
      expect(result.output).toContain('HIT_A');
      expect(result.output).toContain('HIT_B');
      // No separator (⋮) between them since groups merged
      const output = result.output!;
      const separatorCount = (output.match(/⋮/g) || []).length;
      expect(separatorCount).toBe(0);
    });

    it('should show separator (⋮) between non-overlapping match groups', async () => {
      // Match at line 1 and line 20 with context=1 → two separate groups
      const lines = Array.from({ length: 20 }, (_, i) => `L${i + 1}`);
      lines[0] = 'HIT_FIRST';
      lines[19] = 'HIT_LAST';
      const filePath = writeFile('sep.txt', lines.join('\n'));

      const result = await tool.execute({ path: filePath, pattern: 'HIT_', context: 1 });

      expect(result.success).toBe(true);
      expect(result.output).toContain('HIT_FIRST');
      expect(result.output).toContain('HIT_LAST');
      expect(result.output).toContain('⋮');
    });

    it('should clamp context to file boundaries', async () => {
      // Match on first line — context before should not underflow
      const filePath = writeFile('edge.txt', 'MATCH\nL2\nL3\nL4');

      const result = await tool.execute({ path: filePath, pattern: 'MATCH', context: 5 });

      expect(result.success).toBe(true);
      expect(result.output).toContain('MATCH');
      expect(result.output).toContain('L4');
    });
  });

  // ── Case sensitivity ─────────────────────────────────────────────────────────

  describe('case sensitivity', () => {
    it('should be case-insensitive by default', async () => {
      const filePath = writeFile('case.txt', 'Hello World\nhello world\nHELLO WORLD');

      const result = await tool.execute({ path: filePath, pattern: 'hello' });

      expect(result.success).toBe(true);
      expect(result.output).toContain('3 match');
    });

    it('should respect ignoreCase:false for case-sensitive search', async () => {
      const filePath = writeFile('case-sensitive.txt', 'Hello World\nhello world\nHELLO WORLD');

      const result = await tool.execute({ path: filePath, pattern: 'hello', ignoreCase: false });

      expect(result.success).toBe(true);
      // Only 'hello world' (lowercase) matches
      expect(result.output).toContain('1 match');
      expect(result.output).toContain('hello world');
    });

    it('should accept ignoreCase as string "false"', async () => {
      const filePath = writeFile('case-str.txt', 'FOO\nfoo');

      const result = await tool.execute({ path: filePath, pattern: 'FOO', ignoreCase: 'false' });

      expect(result.success).toBe(true);
      expect(result.output).toContain('1 match');
    });
  });

  // ── Regex alternation (pipe) ─────────────────────────────────────────────────

  describe('regex alternation (pipe operator)', () => {
    it('should match multiple alternatives with |', async () => {
      const content = 'proxyUrl config\nproxyDispatcher setup\nno match\ndispatcher init';
      const filePath = writeFile('pipe.txt', content);

      const result = await tool.execute({
        path: filePath,
        pattern: 'proxyUrl|proxyDispatcher|dispatcher',
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain('proxyUrl config');
      expect(result.output).toContain('proxyDispatcher setup');
      expect(result.output).toContain('dispatcher init');
      expect(result.output).toContain('3 match');
    });

    it('should support complex alternation patterns', async () => {
      const content = 'import lodash from "lodash"\nconst x = require("lodash")\nno match here';
      const filePath = writeFile('complex-pipe.txt', content);

      const result = await tool.execute({
        path: filePath,
        pattern: 'import.*lodash|require.*lodash',
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain('2 match');
    });
  });

  // ── Directory search ─────────────────────────────────────────────────────────

  describe('directory search', () => {
    it('should recursively search all text files in a directory', async () => {
      writeFile('a.txt', 'apple\nbanana\ncherry');
      writeFile('b.txt', 'avocado\nblueberry\ncherry');
      writeFile('c.txt', 'no fruit here');

      const result = await tool.execute({ path: tmpDir, pattern: 'cherry' });

      expect(result.success).toBe(true);
      expect(result.output).toContain('2 file(s)');
      expect(result.output).toContain('a.txt');
      expect(result.output).toContain('b.txt');
      expect(result.output).not.toContain('c.txt');
    });

    it('should search files in subdirectories', async () => {
      writeFile('root.txt', 'ROOT_MATCH');
      writeFile('sub.txt', 'SUB_MATCH', 'nested');

      const result = await tool.execute({ path: tmpDir, pattern: '_MATCH' });

      expect(result.success).toBe(true);
      expect(result.output).toContain('ROOT_MATCH');
      expect(result.output).toContain('SUB_MATCH');
    });

    it('should skip ignored directories (node_modules, .git, dist)', async () => {
      writeFile('good.txt', 'FIND_ME');
      writeFile('bad.txt', 'FIND_ME', 'node_modules');
      writeFile('bad2.txt', 'FIND_ME', '.git');
      writeFile('bad3.txt', 'FIND_ME', 'dist');

      const result = await tool.execute({ path: tmpDir, pattern: 'FIND_ME' });

      expect(result.success).toBe(true);
      expect(result.output).toContain('good.txt');
      expect(result.output).not.toContain('node_modules');
      expect(result.output).not.toContain('.git');
      expect(result.output).not.toContain('dist');
    });

    it('should skip binary files by extension', async () => {
      writeFile('code.ts', 'SEARCH_TERM');
      writeFile('image.png', 'SEARCH_TERM');
      writeFile('archive.zip', 'SEARCH_TERM');

      const result = await tool.execute({ path: tmpDir, pattern: 'SEARCH_TERM' });

      expect(result.success).toBe(true);
      expect(result.output).toContain('code.ts');
      expect(result.output).not.toContain('image.png');
      expect(result.output).not.toContain('archive.zip');
    });

    it('should filter files by filePattern glob', async () => {
      writeFile('app.ts', 'TODO fix');
      writeFile('app.js', 'TODO fix');
      writeFile('style.css', 'TODO fix');

      const result = await tool.execute({ path: tmpDir, pattern: 'TODO', filePattern: '*.ts' });

      expect(result.success).toBe(true);
      expect(result.output).toContain('app.ts');
      expect(result.output).not.toContain('app.js');
      expect(result.output).not.toContain('style.css');
    });

    it('should support comma-separated filePattern', async () => {
      writeFile('a.ts', 'TARGET');
      writeFile('b.tsx', 'TARGET');
      writeFile('c.js', 'TARGET');

      const result = await tool.execute({
        path: tmpDir,
        pattern: 'TARGET',
        filePattern: '*.ts,*.tsx',
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain('a.ts');
      expect(result.output).toContain('b.tsx');
      expect(result.output).not.toContain('c.js');
    });

    it('should respect maxResults limit', async () => {
      // Create 5 files each with a match, limit to 2
      for (let i = 0; i < 5; i++) {
        writeFile(`file${i}.txt`, `MATCH in file ${i}`);
      }

      const result = await tool.execute({ path: tmpDir, pattern: 'MATCH', maxResults: 2 });

      expect(result.success).toBe(true);
      // Count how many file headers appear (lines with ━━━)
      const fileHeaders = (result.output!.match(/━━━/g) || []).length / 2;
      expect(fileHeaders).toBeLessThanOrEqual(2);
    });
  });

  // ── Error handling ───────────────────────────────────────────────────────────

  describe('error handling', () => {
    it('should fail for non-existent path', async () => {
      const result = await tool.execute({ path: '/no/such/path/xyz', pattern: 'foo' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Path not found');
    });

    it('should fail for invalid regex pattern', async () => {
      const filePath = writeFile('ok.txt', 'content');

      const result = await tool.execute({ path: filePath, pattern: '[invalid(' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid regex');
    });

    it('should fail for empty pattern', async () => {
      const filePath = writeFile('ok2.txt', 'content');

      const result = await tool.execute({ path: filePath, pattern: '' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('cannot be empty');
    });
  });

  // ── No matches ───────────────────────────────────────────────────────────────

  describe('no matches', () => {
    it('should return success with "no matches" message for file with no hits', async () => {
      const filePath = writeFile('nomatch.txt', 'apple\nbanana\ncherry');

      const result = await tool.execute({ path: filePath, pattern: 'xyz_not_found' });

      expect(result.success).toBe(true);
      expect(result.output).toContain('No matches found');
      expect(result.output).toContain('Files searched: 1');
    });

    it('should return success with "no matches" message for directory with no hits', async () => {
      writeFile('a.txt', 'nothing here');
      writeFile('b.txt', 'nothing here either');

      const result = await tool.execute({ path: tmpDir, pattern: 'xyz_not_found' });

      expect(result.success).toBe(true);
      expect(result.output).toContain('No matches found');
    });
  });

  // ── Relative path ────────────────────────────────────────────────────────────

  describe('relative path support', () => {
    it('should resolve relative paths from workspace', async () => {
      writeFile('relative.txt', 'RELATIVE_MATCH');

      const result = await tool.execute({ path: 'relative.txt', pattern: 'RELATIVE_MATCH' });

      expect(result.success).toBe(true);
      expect(result.output).toContain('RELATIVE_MATCH');
    });

    it('should resolve relative directory paths', async () => {
      writeFile('deep.txt', 'DEEP_MATCH', 'sub/deep');

      const result = await tool.execute({ path: 'sub', pattern: 'DEEP_MATCH' });

      expect(result.success).toBe(true);
      expect(result.output).toContain('DEEP_MATCH');
    });
  });

  // ── Output format ────────────────────────────────────────────────────────────

  describe('output format', () => {
    it('should display line numbers with │ separator', async () => {
      const filePath = writeFile('fmt.txt', 'aaa\nMATCH_ME\nbbb');

      const result = await tool.execute({ path: filePath, pattern: 'MATCH_ME', context: 1 });

      expect(result.success).toBe(true);
      // Line numbers followed by │
      expect(result.output).toMatch(/1\s*│\s*aaa/);
      expect(result.output).toMatch(/2\s*│\s*MATCH_ME/);
      expect(result.output).toMatch(/3\s*│\s*bbb/);
    });

    it('should show summary header with match/file counts', async () => {
      writeFile('x.txt', 'HIT\nHIT\nHIT');

      const result = await tool.execute({ path: tmpDir, pattern: 'HIT' });

      expect(result.success).toBe(true);
      expect(result.output).toMatch(/Found \d+ match/);
      expect(result.output).toMatch(/\d+ file\(s\) searched/);
    });

    it('should truncate long lines (>200 chars)', async () => {
      const longLine = 'MATCH_START' + 'x'.repeat(250) + 'END';
      const filePath = writeFile('long.txt', longLine);

      const result = await tool.execute({ path: filePath, pattern: 'MATCH_START' });

      expect(result.success).toBe(true);
      expect(result.output).toContain('…');
      expect(result.output).not.toContain('END');
    });
  });

  // ── Regex patterns ───────────────────────────────────────────────────────────

  describe('regex patterns', () => {
    it('should support basic regex like \\d+', async () => {
      const filePath = writeFile('regex.txt', 'item 42\nno numbers\nitem 7');

      const result = await tool.execute({ path: filePath, pattern: '\\d+' });

      expect(result.success).toBe(true);
      expect(result.output).toContain('2 match');
    });

    it('should support function signature patterns', async () => {
      const content = 'function hello() {\n  return 1;\n}\n\nfunction world() {\n  return 2;\n}';
      const filePath = writeFile('funcs.ts', content);

      const result = await tool.execute({
        path: filePath,
        pattern: 'function\\s+\\w+',
        ignoreCase: false,
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain('2 match');
    });

    it('should support anchored patterns like ^import', async () => {
      const content = 'import foo from "bar"\n  import indented\nconst x = 1';
      const filePath = writeFile('anchor.txt', content);

      const result = await tool.execute({
        path: filePath,
        pattern: '^import',
        ignoreCase: false,
      });

      expect(result.success).toBe(true);
      // Only the first line starts with "import"
      expect(result.output).toContain('1 match');
    });
  });

  // ── String parameter parsing ─────────────────────────────────────────────────

  describe('parameter parsing', () => {
    it('should parse context as string number', async () => {
      const lines = ['L1', 'L2', 'HIT', 'L4', 'L5'];
      const filePath = writeFile('str-ctx.txt', lines.join('\n'));

      const result = await tool.execute({ path: filePath, pattern: 'HIT', context: '1' });

      expect(result.success).toBe(true);
      expect(result.output).toContain('L2');
      expect(result.output).toContain('HIT');
      expect(result.output).toContain('L4');
      expect(result.output).not.toContain('L1');
    });

    it('should parse maxResults as string number', async () => {
      for (let i = 0; i < 3; i++) {
        writeFile(`mr${i}.txt`, 'MATCH');
      }

      const result = await tool.execute({ path: tmpDir, pattern: 'MATCH', maxResults: '1' });

      expect(result.success).toBe(true);
      const fileHeaders = (result.output!.match(/━━━/g) || []).length / 2;
      expect(fileHeaders).toBeLessThanOrEqual(1);
    });
  });
});
