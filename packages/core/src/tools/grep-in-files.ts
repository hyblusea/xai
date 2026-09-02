import { readdir, stat, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { ToolDefinition } from '@xai/shared';
import { BaseTool } from './base-tool.js';

// ESM-safe require for resolving optional npm packages (e.g. @vscode/ripgrep).
// Static `require()` is not available in ESM output and esbuild rejects dynamic
// `require('<pkg>')` of non-external modules, so we go through createRequire.
const esmRequire = createRequire(import.meta.url);

// Ripgrep binary path — resolved from @vscode/ripgrep (via createRequire) or
// bundled dist/rg/ fallback. We avoid a static import so the bundled output
// does not depend on @vscode/ripgrep being resolvable at runtime.

interface MatchLine {
  lineNumber: number;
  content: string;
  isMatch: boolean;
}

interface FileMatch {
  filePath: string;
  relativePath: string;
  matchGroups: MatchLine[][];
  totalMatches: number;
}

type RgLine = { type: string; data?: { path?: { text: string }; lines?: { text: string }; line_number?: number; stats?: { searches: number } } };

const DEFAULT_MAX_RESULTS = 50;
const DEFAULT_CONTEXT_LINES = 3;
const IGNORED_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', '__pycache__',
  '.idea', '.vscode', 'dist', 'build', '.next', '.nuxt',
  'coverage', '.cache', '.tmp', '.temp', '.turbo',
]);
const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.svg',
  '.mp3', '.mp4', '.avi', '.mov', '.wmv', '.flac',
  '.zip', '.tar', '.gz', '.rar', '.7z', '.bz2',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.dat',
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.sqlite', '.db', '.lock',
]);

let _rgPath: string | null | undefined = undefined;
function getRgPath(): string | null {
  if (_rgPath !== undefined) return _rgPath;

  // 0. Env override — set by Electron main process after extracting rg from asar
  if (process.env.XAI_RG_PATH && existsSync(process.env.XAI_RG_PATH)) {
    _rgPath = process.env.XAI_RG_PATH;
    return _rgPath;
  }

  // 1. Try @vscode/ripgrep (via createRequire — only works if package is resolvable)
  try {
    const { rgPath } = esmRequire('@vscode/ripgrep') as { rgPath: string };
    if (existsSync(rgPath)) {
      // rg inside asar cannot be executed as child process — skip
      if (!rgPath.includes('.asar')) { _rgPath = rgPath; return _rgPath; }
    }
  } catch { /* not installed or not resolvable */ }

  // 2. Bundled binary next to dist/ output (copied by tsup onSuccess)
  try {
    const thisDir = path.dirname(fileURLToPath(import.meta.url));
    const bundledName = process.platform === 'win32' ? 'rg.exe' : 'rg';
    const bundled = path.join(thisDir, 'rg', bundledName);
    if (existsSync(bundled)) {
      // rg inside asar cannot be executed as child process — skip
      if (!bundled.includes('.asar')) { _rgPath = bundled; return _rgPath; }
    }
  } catch { /* not in ESM context */ }

  _rgPath = null;
  return _rgPath;
}

function numParam(v: unknown, fallback: number): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return parseInt(v, 10) || fallback;
  return fallback;
}

export class GrepInFilesTool extends BaseTool {
  private workspacePath: string;

  constructor(workspacePath: string) {
    super();
    this.workspacePath = workspacePath;
  }

  get definition(): ToolDefinition {
    return {
      name: 'grep_search',
      description: 'Search regex in files. Supports context lines, case control, glob filter. Auto-uses ripgrep.',
      parameters: {
        path: { type: 'string', description: 'File or directory to search (relative or absolute)', required: true, location: 'header' },
        pattern: { type: 'string', description: 'Regex pattern', required: true, location: 'header' },
        ignoreCase: { type: 'boolean', description: 'Case-insensitive search', default: true, location: 'header' },
        context: { type: 'number', description: `Context lines before/after match (default: ${DEFAULT_CONTEXT_LINES})`, location: 'header' },
        filePattern: { type: 'string', description: 'Glob filter (e.g. "*.ts")', location: 'header' },
        maxResults: { type: 'number', description: `Max matching files (default: ${DEFAULT_MAX_RESULTS})`, location: 'header' },
      },
      confirmationRequired: false,
      examples: [
        `++++ grep_search path:src pattern:proxyUrl|proxyDispatcher filePattern:*.{ts,tsx}
++++ end`,
      ],
    };
  }

  async _execute(params: Record<string, unknown>, _signal?: AbortSignal) {
    const start = Date.now();
    try {
      const targetPath = this.resolvePath(params.path as string);
      const pattern = params.pattern as string;
      const ignoreCase = params.ignoreCase !== false && params.ignoreCase !== 'false';
      const contextLines = numParam(params.context, DEFAULT_CONTEXT_LINES);
      const filePattern = params.filePattern as string | undefined;
      const maxResults = numParam(params.maxResults, DEFAULT_MAX_RESULTS);

      if (!pattern) return this.fail('pattern parameter cannot be empty', Date.now() - start);
      if (!existsSync(targetPath)) return this.fail(`Path not found: ${targetPath}`, Date.now() - start);

      // Try ripgrep first
      const rg = getRgPath();
      if (rg) {
        try {
          const rgResult = this.rgSearch(rg, targetPath, pattern, ignoreCase, contextLines, filePattern, maxResults);
          if (rgResult !== null) {
            const { fileMatches, filesSearched } = rgResult;
            if (fileMatches.length === 0) {
              return this.success(
                `No matches found for "${pattern}" in ${path.relative(this.workspacePath, targetPath) || targetPath}\nFiles searched: ${filesSearched}`,
                Date.now() - start,
              );
            }
            return this.success(this.formatFileMatches(fileMatches, pattern, filesSearched), Date.now() - start);
          }
        } catch { /* fallback */ }
      }

      // Fallback: Node.js recursive search
      let regex: RegExp;
      try {
        regex = new RegExp(pattern, ignoreCase ? 'gi' : 'g');
      } catch {
        return this.fail(`Invalid regex pattern: ${pattern}`, Date.now() - start);
      }

      const targetStat = await stat(targetPath);
      const fileMatches: FileMatch[] = [];
      const stats = { filesSearched: 0, totalMatches: 0 };

      if (targetStat.isFile()) {
        const result = await this.searchSingleFile(targetPath, regex, contextLines);
        stats.filesSearched = 1;
        if (result) { fileMatches.push(result); stats.totalMatches = result.totalMatches; }
      } else if (targetStat.isDirectory()) {
        const fileFilterRegex = filePattern ? this.globToRegex(filePattern) : null;
        await this.searchDirectory(targetPath, regex, contextLines, fileFilterRegex, maxResults, fileMatches, stats);
      } else {
        return this.fail(`Path is neither a file nor a directory: ${targetPath}`, Date.now() - start);
      }

      if (fileMatches.length === 0) {
        return this.success(
          `No matches found for "${pattern}" in ${path.relative(this.workspacePath, targetPath) || targetPath}\nFiles searched: ${stats.filesSearched}`,
          Date.now() - start,
        );
      }

      return this.success(this.formatFileMatches(fileMatches, pattern, stats.filesSearched), Date.now() - start);
    } catch (error) {
      return this.fail(`grep_search failed: ${error instanceof Error ? error.message : String(error)}`, Date.now() - start);
    }
  }

  // ─── Ripgrep ───────────────────────────────────────────────────────

  private rgSearch(
    rgBin: string, searchPath: string, pattern: string, ignoreCase: boolean,
    context: number, filePattern?: string, maxResults?: number,
  ): { fileMatches: FileMatch[]; filesSearched: number } | null {
    const args = ['--json', '--stats'];
    if (ignoreCase) args.push('-i');
    if (context > 0) args.push('--context', String(context));
    if (filePattern) {
      // Convert comma-separated patterns like "*.ts,*.tsx" to rg's brace syntax "{*.ts,*.tsx}"
      const rgPattern = filePattern.includes(',') && !filePattern.includes('{')
        ? `{${filePattern}}`
        : filePattern;
      args.push('--glob', rgPattern);
    }
    // Exclude ignored dirs and binary extensions to match Node.js fallback behavior
    for (const dir of IGNORED_DIRS) args.push('--glob', `!${dir}`);
    for (const ext of BINARY_EXTENSIONS) args.push('--glob', `!*${ext}`);
    args.push(pattern, searchPath);

    let output: string;
    try {
      output = execSync(`"${rgBin}" ${args.map(a => `"${a}"`).join(' ')}`, {
        stdio: 'pipe', timeout: 30000, maxBuffer: 50 * 1024 * 1024, encoding: 'utf-8',
      });
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'status' in err && (err as { status: number }).status === 1) {
        // rg exits with code 1 when no matches found — still a valid result.
        // With --json --stats, the summary line is still in stdout.
        const stdout = (err as { stdout?: Buffer }).stdout?.toString('utf-8') || '';
        let searched = 0;
        for (const ln of stdout.split('\n')) {
          if (!ln.trim()) continue;
          try {
            const obj = JSON.parse(ln);
            if (obj.type === 'summary' && obj.data?.stats?.searches) searched = obj.data.stats.searches;
          } catch { /* skip */ }
        }
        return { fileMatches: [], filesSearched: searched };
      }
      return null;
    }

    // Parse rg --json output into FileMatch[]
    const fileMap = new Map<string, { lines: MatchLine[]; matchCount: number }>();
    let filesSearched = 0;
    for (const ln of output.split('\n')) {
      if (!ln.trim()) continue;
      let obj: RgLine;
      try { obj = JSON.parse(ln); } catch { continue; }

      if (obj.type === 'summary' && obj.data?.stats?.searches) {
        filesSearched = obj.data.stats.searches;
        continue;
      }

      if ((obj.type !== 'match' && obj.type !== 'context') || !obj.data?.path || !obj.data?.lines || obj.data.line_number == null) continue;

      const fp = obj.data.path.text;
      if (!fileMap.has(fp)) fileMap.set(fp, { lines: [], matchCount: 0 });
      const entry = fileMap.get(fp)!;
      const isMatch = obj.type === 'match';
      entry.lines.push({ lineNumber: obj.data.line_number, content: obj.data.lines.text.replace(/\n$/, ''), isMatch });
      if (isMatch) entry.matchCount++;
    }

    // If stats didn't report filesSearched (e.g. single file search), infer from results
    if (filesSearched === 0 && fileMap.size > 0) filesSearched = fileMap.size;

    const results: FileMatch[] = [];
    let count = 0;
    for (const [fp, entry] of fileMap) {
      if (maxResults && count >= maxResults) break;
      results.push({
        filePath: fp,
        relativePath: path.relative(this.workspacePath, fp) || fp,
        matchGroups: this.buildGroupsFromLines(entry.lines),
        totalMatches: entry.matchCount,
      });
      count++;
    }
    return { fileMatches: results, filesSearched };
  }

  // ─── Unified formatting ────────────────────────────────────────────

  private formatFileMatches(fileMatches: FileMatch[], pattern: string, filesSearched?: number): string {
    const totalMatches = fileMatches.reduce((s, f) => s + f.totalMatches, 0);
    const suffix = filesSearched ? ` (${filesSearched} file(s) searched)` : '';
    const parts = [`Found ${totalMatches} match(es) in ${fileMatches.length} file(s)${suffix}`];

    for (const fm of fileMatches) {
      parts.push(`\n━━━ ${fm.relativePath} (${fm.totalMatches} match${fm.totalMatches > 1 ? 'es' : ''}) ━━━`);
      const maxLineNumWidth = String(Math.max(...fm.matchGroups.flat().map(l => l.lineNumber))).length;

      for (let gi = 0; gi < fm.matchGroups.length; gi++) {
        if (gi > 0) parts.push('  ⋮');
        for (const line of fm.matchGroups[gi]) {
          const lineNum = String(line.lineNumber).padStart(maxLineNumWidth, ' ');
          const marker = line.isMatch ? '▶' : ' ';
          const truncated = line.content.length > 200 ? line.content.slice(0, 200) + '…' : line.content;
          parts.push(`  ${marker} ${lineNum} │ ${truncated}`);
        }
      }
    }
    return parts.join('\n');
  }

  private buildGroupsFromLines(lines: MatchLine[]): MatchLine[][] {
    if (lines.length === 0) return [];
    const groups: MatchLine[][] = [[lines[0]]];
    for (let i = 1; i < lines.length; i++) {
      const prev = groups[groups.length - 1][groups[groups.length - 1].length - 1];
      if (lines[i].lineNumber <= prev.lineNumber + 1) {
        groups[groups.length - 1].push(lines[i]);
      } else {
        groups.push([lines[i]]);
      }
    }
    return groups;
  }

  // ─── Node.js fallback ──────────────────────────────────────────────

  private resolvePath(inputPath: string): string {
    return path.isAbsolute(inputPath) ? path.normalize(inputPath) : path.resolve(this.workspacePath, inputPath);
  }

  private globToRegex(pattern: string): RegExp {
    const expanded = this.expandBraces(pattern);
    const regexParts = expanded.map(part =>
      part
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*/g, '{{GLOBSTAR}}')
        .replace(/\*/g, '[^/]*')
        .replace(/\?/g, '[^/]')
        .replace(/\{\{GLOBSTAR\}\}/g, '.*'),
    );
    return new RegExp(`^(${regexParts.join('|')})$`);
  }

  private expandBraces(pattern: string): string[] {
    const braceMatch = pattern.match(/\{([^}]+)\}/);
    if (braceMatch) {
      const braceStart = pattern.indexOf('{');
      const braceEnd = pattern.indexOf('}', braceStart);
      const prefix = pattern.substring(0, braceStart);
      const suffix = pattern.substring(braceEnd + 1);
      return braceMatch[1].split(',').map(s => prefix + s.trim() + suffix);
    }
    return pattern.split(',').map(p => p.trim());
  }

  private async searchDirectory(
    dirPath: string, regex: RegExp, contextLines: number,
    fileFilterRegex: RegExp | null, maxResults: number,
    fileMatches: FileMatch[], stats: { filesSearched: number; totalMatches: number },
  ): Promise<void> {
    if (fileMatches.length >= maxResults) return;
    let entries;
    try { entries = await readdir(dirPath, { withFileTypes: true }); } catch { return; }

    for (const entry of entries) {
      if (fileMatches.length >= maxResults) return;
      const fullPath = path.join(dirPath, entry.name);

      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) await this.searchDirectory(fullPath, regex, contextLines, fileFilterRegex, maxResults, fileMatches, stats);
      } else if (entry.isFile()) {
        if (BINARY_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
        if (fileFilterRegex && !fileFilterRegex.test(entry.name)) continue;
        const result = await this.searchSingleFile(fullPath, regex, contextLines);
        stats.filesSearched++;
        if (result) { fileMatches.push(result); stats.totalMatches += result.totalMatches; }
      }
    }
  }

  private async searchSingleFile(filePath: string, regex: RegExp, contextLines: number): Promise<FileMatch | null> {
    let content: string;
    try { content = await readFile(filePath, 'utf-8'); } catch { return null; }

    const lines = content.split('\n');
    const matchLineNums = new Set<number>();
    for (let i = 0; i < lines.length; i++) {
      regex.lastIndex = 0;
      if (regex.test(lines[i])) matchLineNums.add(i);
    }
    if (matchLineNums.size === 0) return null;

    // Build match groups with context
    const sorted = Array.from(matchLineNums).sort((a, b) => a - b);
    const matchGroups: MatchLine[][] = [];
    let groupStart = -1, groupEnd = -1;

    const flushGroup = () => {
      if (groupStart === -1) return;
      const group: MatchLine[] = [];
      for (let i = groupStart; i <= groupEnd; i++) {
        group.push({ lineNumber: i + 1, content: lines[i], isMatch: matchLineNums.has(i) });
      }
      matchGroups.push(group);
    };

    for (const ln of sorted) {
      const rs = Math.max(0, ln - contextLines);
      const re = Math.min(lines.length - 1, ln + contextLines);
      if (groupStart === -1) { groupStart = rs; groupEnd = re; }
      else if (rs <= groupEnd + 1) { groupEnd = Math.max(groupEnd, re); }
      else { flushGroup(); groupStart = rs; groupEnd = re; }
    }
    flushGroup();

    return { filePath, relativePath: path.relative(this.workspacePath, filePath), matchGroups, totalMatches: matchLineNums.size };
  }
}
