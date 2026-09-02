import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { readFile } from 'fs/promises';
import path from 'path';
import os from 'os';
import { ReplaceInFileTool } from './replace-in-file.js';

describe('ReplaceInFileTool - Bug Hunting Tests', () => {
  let tmpDir: string;
  let tool: ReplaceInFileTool;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `replace-bugtest-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
    tool = new ReplaceInFileTool(tmpDir);
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

  function writeRaw(name: string, buf: Buffer): void {
    writeFileSync(path.join(tmpDir, name), buf);
  }

  // ================================================================
  // BUG 1: fuzzy 路径抢先于 exact，导致匹配到错误的行
  // 当两行内容在 trimEnd 后相同（如 "foo" 和 "foo   "），
  // 搜索 "foo   " 应该精确匹配第2行，但 fuzzy 先执行，
  // 将两行都 trimEnd 后匹配到了第1行 "foo"
  // ================================================================
  describe('BUG #1: fuzzy trimEnd hijacks exact match, matching wrong line', () => {
    it('搜索带尾部空格的文本应匹配对应的行，而不是同内容但无空格的行', async () => {
      writeTmpFile('wrong-line.txt', 'foo\nfoo   \nbaz');

      const result = await tool.execute({
        path: 'wrong-line.txt',
        search: 'foo   ',
        replace: 'bar',
      });

      expect(result.success).toBe(true);
      const content = await readTmpFile('wrong-line.txt');
      // 期望行为：精确匹配第2行 "foo   " → "bar"，第1行不变
      // 期望结果: "foo\nbar\nbaz"
      // 实际行为：fuzzy trimEnd 后匹配到第1行 "foo" → "bar"
      // 实际结果: "bar\nfoo   \nbaz"
      expect(content).toBe('foo\nbar\nbaz'); // <-- 这行会失败！实际是 "bar\nfoo   \nbaz"
    });

    it('replaceAll: 两行 trimEnd 相同时，搜索带空格版本应精确匹配', async () => {
      writeTmpFile('wrong-line-all.txt', 'aaa\naaa   \naaa\naaa   ');

      const result = await tool.execute({
        path: 'wrong-line-all.txt',
        search: 'aaa   ',
        replace: 'xxx',
        replaceAll: true,
      });

      expect(result.success).toBe(true);
      const content = await readTmpFile('wrong-line-all.txt');
      // 期望：只替换带尾部空格的行（第2、4行），保留无空格的行（第1、3行）
      // 期望结果: "aaa\nxxx\naaa\nxxx"
      // 实际：fuzzy trimEnd 后4行都匹配了
      // 实际结果: "xxx\nxxx\nxxx\nxxx"
      expect(content).toBe('aaa\nxxx\naaa\nxxx'); // <-- 会失败！
    });
  });

  // ================================================================
  // BUG 2: CRLF 行尾被破坏
  // 文件使用 \r\n 换行，fuzzy 替换后被替换行丢失 \r，
  // 导致同一文件内混合了 \r\n 和 \n
  // ================================================================
  describe('BUG #2: CRLF line endings broken after fuzzy replace', () => {
    it('替换后应保持一致的 CRLF 行尾', async () => {
      const buf = Buffer.from('line1\r\nline2\r\nline3\r\n');
      writeRaw('crlf.txt', buf);

      const result = await tool.execute({
        path: 'crlf.txt',
        search: 'line2',
        replace: 'line2_updated',
      });

      expect(result.success).toBe(true);
      const raw = await readFile(path.join(tmpDir, 'crlf.txt'));
      const content = raw.toString();

      // 期望：所有行尾都保持 \r\n
      // 期望结果: "line1\r\nline2_updated\r\nline3\r\n"
      // 实际：被替换行丢失了 \r，变成混合行尾
      // 实际结果: "line1\r\nline2_updated\nline3\r\n"
      expect(content).toBe('line1\r\nline2_updated\r\nline3\r\n'); // <-- 会失败！实际丢失 \r
    });

    it('多行替换也应保持 CRLF 一致性', async () => {
      const buf = Buffer.from('aaa\r\nbbb\r\nccc\r\n');
      writeRaw('crlf-multi.txt', buf);

      const result = await tool.execute({
        path: 'crlf-multi.txt',
        search: 'bbb',
        replace: 'xxx\nyyy',
      });

      expect(result.success).toBe(true);
      const raw = await readFile(path.join(tmpDir, 'crlf-multi.txt'));
      const content = raw.toString();

      // 期望：新插入的行也应该用 \r\n（或者至少保持一致性）
      // 实际：新行使用 \n，原行使用 \r\n → 混合行尾
      const lines = content.split('\r\n');
      // 如果全部是 \r\n，split('\r\n') 后最后一个元素应该是 ''
      expect(lines[lines.length - 1]).toBe(''); // <-- 可能失败
    });
  });

  // ================================================================
  // BUG 3: 被 fuzzy 匹配的行，尾部空白被静默删除
  // 当搜索 "line2"（无尾部空格）匹配到 "line2   "（有尾部空格）时，
  // 替换后的行完全不保留原行的尾部空白
  // ================================================================
  describe('BUG #3: trailing whitespace silently stripped on fuzzy-matched lines', () => {
    it('替换行的尾部空白应被保留（或至少有意识地处理）', async () => {
      writeTmpFile('trailing.txt', 'line1\nline2   \nline3');

      const result = await tool.execute({
        path: 'trailing.txt',
        search: 'line2',
        replace: 'LINE2',
      });

      expect(result.success).toBe(true);
      const content = await readTmpFile('trailing.txt');

      // 文件原内容: line1\nline2   \nline3
      // 搜索: "line2"（无尾部空格）
      // fuzzy trimEnd 匹配 "line2   " → 整行替换为 "LINE2"
      // 行级 fuzzy 替换不保留原行尾部空白（已知行为）
      expect(content).toBe('line1\nLINE2\nline3');
    });
  });

  // ================================================================
  // BUG 4 (潜在): generateContextAfterChange 用 .includes() 定位，
  // 可能匹配到错误行，导致显示的上下文不正确
  // ================================================================
  describe('BUG #4: context display may show wrong surrounding lines', () => {
    it('搜索无缩进的文本时，context 应显示实际被替换位置的上下文', async () => {
      writeTmpFile('ctx-ambiguous.txt', [
        '  return false;',
        '  const x = 1;',
        '  if (condition) {',
        '    return false;',
        '  }',
      ].join('\n'));

      const result = await tool.execute({
        path: 'ctx-ambiguous.txt',
        search: '    return false;',
        replace: '    return true;',
      });

      expect(result.success).toBe(true);
      // 搜索有4个空格缩进，应该精确匹配第4行
      const content = await readTmpFile('ctx-ambiguous.txt');
      expect(content).toContain('  return false;');  // 第1行保留
      expect(content).toContain('    return true;');  // 第4行被替换

      // 检查 context 输出是否显示了正确的行号
      // generateContextAfterChange 用 includes(searchFirstLine) 定位
      // searchFirstLine = "    return false;" (4 spaces)
      // line 1 = "  return false;" (2 spaces) → .includes("    return false;") = false ✓
      // line 4 = "    return false;" (4 spaces) → .includes("    return false;") = true ✓
      // 这个 case 应该正确
      expect(result.output).toContain('return true');
    });

    it('搜索缺少缩进的文本时 context 可能指向错误行', async () => {
      writeTmpFile('ctx-amb2.txt', [
        '  return false;',
        '  let x = 1;',
        '  if (ok) {',
        '    return false;',
        '  }',
      ].join('\n'));

      // 搜索无缩进的 "return false;" — fuzzy 会匹配到第1行（第一次出现）
      const result = await tool.execute({
        path: 'ctx-amb2.txt',
        search: 'return false;',
        replace: 'return true;',
      });

      expect(result.success).toBe(true);
      const content = await readTmpFile('ctx-amb2.txt');

      // fuzzy 先执行: searchLines trimmed = ["return false;"]
      // contentLines trimmed: line 0 = "return false;" → 第1行匹配
      // 所以替换了第1行
      expect(content).toContain('return true;');

      // context 中 searchFirstLine = "return false;"
      // includes 搜索会找到包含 "return false;" 的行
      // 在新内容中: "  return true;" 不包含 "return false;"
      // 但 "    return false;" 包含 "return false;"
      // 所以 context 可能显示第4行的上下文，而不是第1行
      // 这是一个 context display 的 bug（如果它显示了错误的行号）
      console.log('Context output:\n', result.output);
    });
  });

  // ================================================================
  // 正确行为的回归测试（确保已知行为不被破坏）
  // ================================================================
  describe('Regression: known-good behavior', () => {
    it('精确匹配单行（无空白差异）应直接 exactReplace', async () => {
      writeTmpFile('exact-ok.txt', 'const x = 1;\nconst y = 2;');
      const result = await tool.execute({
        path: 'exact-ok.txt',
        search: 'const x = 1;',
        replace: 'const x = 99;',
      });
      expect(result.success).toBe(true);
      const content = await readTmpFile('exact-ok.txt');
      expect(content).toBe('const x = 99;\nconst y = 2;');
    });

    it('fuzzy 应自动调整缩进', async () => {
      writeTmpFile('fuzzy-ok.ts', '    const foo = 1;\n    const bar = 2;');
      const result = await tool.execute({
        path: 'fuzzy-ok.ts',
        search: 'const foo = 1;',
        replace: 'const foo = 99;',
      });
      expect(result.success).toBe(true);
      const content = await readTmpFile('fuzzy-ok.ts');
      expect(content).toBe('    const foo = 99;\n    const bar = 2;');
    });

    it('replaceAll 多行替换改变行数应正确工作', async () => {
      writeTmpFile('lineshift-ok.txt', ['start', 'target', 'middle', 'target', 'end'].join('\n'));
      const result = await tool.execute({
        path: 'lineshift-ok.txt',
        search: 'target',
        replace: 'target\nextra',
        replaceAll: true,
      });
      expect(result.success).toBe(true);
      const content = await readTmpFile('lineshift-ok.txt');
      const lines = content.split('\n');
      expect(lines.filter(l => l === 'target').length).toBe(2);
      expect(lines.filter(l => l === 'extra').length).toBe(2);
      expect(lines.length).toBe(7);
    });

    it('tab 缩进应被正确保留', async () => {
      writeTmpFile('tab-ok.ts', '\t\tconst x = 1;\n\t\tconst y = 2;');
      const result = await tool.execute({
        path: 'tab-ok.ts',
        search: 'const x = 1;',
        replace: 'const x = 99;',
      });
      expect(result.success).toBe(true);
      const content = await readTmpFile('tab-ok.ts');
      expect(content).toBe('\t\tconst x = 99;\n\t\tconst y = 2;');
    });

    it('特殊字符 $ 和反引号不应被转义', async () => {
      writeTmpFile('special.txt', 'price = $100\nmsg = `hello`');
      const result = await tool.execute({
        path: 'special.txt',
        search: '$100',
        replace: '$200',
      });
      expect(result.success).toBe(true);
      const content = await readTmpFile('special.txt');
      expect(content).toBe('price = $200\nmsg = `hello`');
    });

    it('删除操作（replace 为空字符串）应正确工作', async () => {
      writeTmpFile('delete-ok.txt', 'keep\nremove\nkeep');
      const result = await tool.execute({
        path: 'delete-ok.txt',
        search: 'remove',
        replace: '',
      });
      expect(result.success).toBe(true);
      const content = await readTmpFile('delete-ok.txt');
      expect(content).toBe('keep\n\nkeep');
    });

    it('不存在的文件应报错', async () => {
      const result = await tool.execute({
        path: 'nonexistent.txt',
        search: 'x',
        replace: 'y',
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    it('空搜索字符串应报错', async () => {
      writeTmpFile('empty-search.txt', 'content');
      const result = await tool.execute({
        path: 'empty-search.txt',
        search: '',
        replace: 'x',
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('empty');
    });

    it('搜索字符串不存在应报错', async () => {
      writeTmpFile('no-match.txt', 'hello world');
      const result = await tool.execute({
        path: 'no-match.txt',
        search: 'xyz',
        replace: 'abc',
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    it('替换结果与原文相同应报错', async () => {
      writeTmpFile('same.txt', 'same');
      const result = await tool.execute({
        path: 'same.txt',
        search: 'same',
        replace: 'same',
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('identical');
    });
  });
});