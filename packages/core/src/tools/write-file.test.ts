import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { readFile } from 'fs/promises';
import path from 'path';
import os from 'os';
import { WriteFileTool } from './write-file.js';

describe('WriteFileTool', () => {
  let tmpDir: string;
  let tool: WriteFileTool;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `write-file-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    tool = new WriteFileTool(tmpDir);
  });

  afterEach(() => {
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  async function readTmpFile(name: string): Promise<string> {
    return readFile(path.join(tmpDir, name), 'utf-8');
  }

  function writeTmpFile(name: string, content: string): void {
    writeFileSync(path.join(tmpDir, name), content, 'utf-8');
  }

  // ── 覆盖模式（无 start_line）──────────────────────────────────────────────

  describe('overwrite mode (no start_line)', () => {
    it('should create a new file', async () => {
      const result = await tool.execute({ path: 'new.txt', content: 'hello world' });
      expect(result.success).toBe(true);
      expect(result.output).toContain('Created');
      const content = await readTmpFile('new.txt');
      expect(content).toBe('hello world');
    });

    it('should overwrite an existing file', async () => {
      writeTmpFile('existing.txt', 'old content');
      const result = await tool.execute({ path: 'existing.txt', content: 'new content' });
      expect(result.success).toBe(true);
      expect(result.output).toContain('Overwritten');
      const content = await readTmpFile('existing.txt');
      expect(content).toBe('new content');
    });

    it('should create parent directories when createDirs is true', async () => {
      const result = await tool.execute({ path: 'sub/dir/file.txt', content: 'nested' });
      expect(result.success).toBe(true);
      const content = await readTmpFile('sub/dir/file.txt');
      expect(content).toBe('nested');
    });

    it('should fail when parent dir missing and createDirs is false', async () => {
      const result = await tool.execute({ path: 'no/such/dir/file.txt', content: 'x', createDirs: false });
      expect(result.success).toBe(false);
      expect(result.error).toContain('does not exist');
    });

    it('should show diff when overwriting with changes', async () => {
      writeTmpFile('diff.txt', 'line1\nline2');
      const result = await tool.execute({ path: 'diff.txt', content: 'line1\nline3' });
      expect(result.success).toBe(true);
      expect(result.output).toContain('-line2');
      expect(result.output).toContain('+line3');
    });

    it('should handle absolute path', async () => {
      const absPath = path.join(tmpDir, 'abs.txt');
      const result = await tool.execute({ path: absPath, content: 'absolute' });
      expect(result.success).toBe(true);
      const content = await readFile(absPath, 'utf-8');
      expect(content).toBe('absolute');
    });
  });

  // ── 插入模式（有 start_line）──────────────────────────────────────────────

  describe('insert mode (with start_line)', () => {
    it('should insert content at the beginning of file (start_line=1)', async () => {
      writeTmpFile('insert.txt', 'line2\nline3');
      const result = await tool.execute({ path: 'insert.txt', content: 'line1', start_line: 1 });
      expect(result.success).toBe(true);
      expect(result.output).toContain('Inserted');
      expect(result.output).toContain('Inserted at line: 1');
      const content = await readTmpFile('insert.txt');
      expect(content).toBe('line1\nline2\nline3');
    });

    it('should insert content in the middle of file', async () => {
      writeTmpFile('middle.txt', 'line1\nline2\nline5');
      const result = await tool.execute({ path: 'middle.txt', content: 'line3\nline4', start_line: 3 });
      expect(result.success).toBe(true);
      const content = await readTmpFile('middle.txt');
      expect(content).toBe('line1\nline2\nline3\nline4\nline5');
    });

    it('should insert content at the end of file (start_line = lines.length + 1)', async () => {
      writeTmpFile('end.txt', 'line1\nline2');
      const result = await tool.execute({ path: 'end.txt', content: 'line3', start_line: 3 });
      expect(result.success).toBe(true);
      const content = await readTmpFile('end.txt');
      expect(content).toBe('line1\nline2\nline3');
    });

    it('should fail when start_line is out of range (too small)', async () => {
      writeTmpFile('range.txt', 'line1\nline2');
      const result = await tool.execute({ path: 'range.txt', content: 'x', start_line: 0 });
      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid start_line');
    });

    it('should fail when start_line is out of range (too large)', async () => {
      writeTmpFile('range.txt', 'line1\nline2');
      const result = await tool.execute({ path: 'range.txt', content: 'x', start_line: 10 });
      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid start_line');
    });

    it('should fail when using start_line on a new file', async () => {
      const result = await tool.execute({ path: 'new.txt', content: 'x', start_line: 1 });
      expect(result.success).toBe(false);
      expect(result.error).toContain('Cannot use start_line on a new file');
    });

    it('should show inserted content with line markers', async () => {
      writeTmpFile('marker.txt', 'aaa\nbbb\nccc');
      const result = await tool.execute({ path: 'marker.txt', content: 'inserted', start_line: 2 });
      expect(result.success).toBe(true);
      expect(result.output).toContain('Inserted at line: 2');
      expect(result.output).toContain('+inserted');
    });

    it('should handle multiline insert', async () => {
      writeTmpFile('multi.txt', 'a\nd');
      const result = await tool.execute({ path: 'multi.txt', content: 'b\nc', start_line: 2 });
      expect(result.success).toBe(true);
      const content = await readTmpFile('multi.txt');
      expect(content).toBe('a\nb\nc\nd');
    });

    it('should handle Chinese characters in insert', async () => {
      writeTmpFile('cn.txt', '第一行\n第三行');
      const result = await tool.execute({ path: 'cn.txt', content: '第二行', start_line: 2 });
      expect(result.success).toBe(true);
      const content = await readTmpFile('cn.txt');
      expect(content).toBe('第一行\n第二行\n第三行');
    });
  });
});
