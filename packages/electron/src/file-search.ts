/**
 * File search utilities — ripgrep + Node.js fallback.
 * Extracted from main.ts for modularity.
 */
import path from 'path';
import fs from 'fs/promises';
import { existsSync, copyFileSync, mkdirSync, statSync } from 'fs';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { createRequire } from 'module';
import { app } from 'electron';

// ESM-safe require for resolving optional npm packages (e.g. @vscode/ripgrep).
// Static `require()` is not available in ESM output and esbuild rejects dynamic
// `require('<pkg>')` of non-external modules, so we go through createRequire.
const esmRequire = createRequire(import.meta.url);

// Ripgrep binary path — resolved from @vscode/ripgrep (dynamic) or bundled fallback.
// When rg is inside asar, we extract it to userData so it can be executed as a child process.
let _rgPath: string | null | undefined = undefined;

/**
 * Extract rg binary from asar to userData directory.
 * rg.exe cannot be executed from inside asar, so we copy it out on first use.
 */
function extractRgFromAsar(asarRgPath: string): string | null {
  try {
    const userDataDir = app.getPath('userData');
    const rgDir = path.join(userDataDir, 'rg');
    const bundledName = process.platform === 'win32' ? 'rg.exe' : 'rg';
    const targetPath = path.join(rgDir, bundledName);

    // Already extracted — check if version matches via mtime
    if (existsSync(targetPath)) {
      const srcStat = statSync(asarRgPath);
      const dstStat = statSync(targetPath);
      if (srcStat.size === dstStat.size) {
        return targetPath;
      }
    }

    // Extract: read from asar (bypass asar shim), write to userData
    mkdirSync(rgDir, { recursive: true });
    const origNoAsar = process.noAsar;
    try {
      process.noAsar = true;
      copyFileSync(asarRgPath, targetPath);
    } finally {
      process.noAsar = origNoAsar;
    }
    console.log(`[file-search] Extracted rg binary to ${targetPath}`);
    return targetPath;
  } catch (err) {
    console.error('[file-search] Failed to extract rg from asar:', err);
    return null;
  }
}

export function getRgPath(): string | null {
  if (_rgPath !== undefined) return _rgPath as string | null;

  // 1. Try @vscode/ripgrep (dynamic require)
  try {
    const { rgPath } = esmRequire('@vscode/ripgrep') as { rgPath: string };
    if (existsSync(rgPath)) {
      // If inside asar, extract to userData first
      if (rgPath.includes('.asar')) {
        const extracted = extractRgFromAsar(rgPath);
        if (extracted) { _rgPath = extracted; return _rgPath!; }
      } else {
        _rgPath = rgPath; return _rgPath!;
      }
    }
  } catch { /* not installed */ }

  // 2. Bundled binary next to dist/ output
  try {
    const bundledName = process.platform === 'win32' ? 'rg.exe' : 'rg';
    const bundled = path.join(path.dirname(fileURLToPath(import.meta.url)), 'rg', bundledName);
    if (existsSync(bundled)) {
      // If inside asar, extract to userData first
      if (bundled.includes('.asar')) {
        const extracted = extractRgFromAsar(bundled);
        if (extracted) { _rgPath = extracted; return _rgPath!; }
      } else {
        _rgPath = bundled; return _rgPath!;
      }
    }
  } catch { /* skip */ }

  _rgPath = null;
  return _rgPath;
}

export function rgSearch(dirPath: string, pattern: string, maxResults: number, ignoreCase: boolean): Array<{ file: string; line: number; text: string }> | null {
  const rgBin = getRgPath();
  if (!rgBin) return null;
  const args = ['--json'];
  if (ignoreCase) args.push('-i');
  args.push('--max-count', String(maxResults), pattern, dirPath);
  try {
    const output = execSync(`"${rgBin}" ${args.map(a => `"${a}"`).join(' ')}`, {
      stdio: 'pipe', timeout: 30000, maxBuffer: 50 * 1024 * 1024, encoding: 'utf-8',
    });
    const results: Array<{ file: string; line: number; text: string }> = [];
    for (const ln of output.split('\n')) {
      if (!ln.trim()) continue;
      try {
        const obj = JSON.parse(ln);
        if (obj.type === 'match') {
          results.push({ file: obj.data.path.text, line: obj.data.line_number, text: obj.data.lines.text.replace(/\n$/, '').trim() });
          if (results.length >= maxResults) break;
        }
      } catch { /* skip */ }
    }
    return results;
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'status' in err && (err as { status: number }).status === 1) return [];
    return null; // fallback
  }
}

export async function searchInFiles(dirPath: string, pattern: string, maxResults: number = 500, ignoreCase: boolean = true): Promise<Array<{ file: string; line: number; text: string }>> {
  if (getRgPath()) {
    const rg = rgSearch(dirPath, pattern, maxResults, ignoreCase);
    if (rg !== null) return rg;
  }

  // Fallback: Node.js recursive search
  const results: Array<{ file: string; line: number; text: string }> = [];
  const IGNORED_DIRS = new Set([
    'node_modules', '.git', 'dist', 'build', '.next', '__pycache__', '.venv',
    '.vscode', '.idea', '.cache', 'coverage', '.nyc_output', 'tmp', 'temp', 'vendor', 'target',
  ]);
  const IGNORED_EXTS = new Set([
    '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.webp', '.bmp', '.tiff',
    '.woff', '.woff2', '.ttf', '.eot', '.otf',
    '.mp3', '.mp4', '.avi', '.mov', '.wmv', '.flv', '.webm',
    '.zip', '.tar', '.gz', '.bz2', '.rar', '.7z',
    '.exe', '.dll', '.so', '.dylib', '.bin', '.dat',
    '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.lock', '.map',
  ]);
  const MAX_FILE_SIZE = 1024 * 1024;
  const patternLower = ignoreCase ? pattern.toLowerCase() : pattern;
  let stopped = false;

  async function collectFiles(dir: string): Promise<string[]> {
    const queue: string[] = [];
    async function walk(d: string) {
      if (stopped) return;
      try {
        for (const e of await fs.readdir(d, { withFileTypes: true })) {
          if (stopped) return;
          if (e.name.startsWith('.') && e.name !== '.env') continue;
          const full = path.join(d, e.name);
          if (e.isDirectory()) { if (!IGNORED_DIRS.has(e.name)) await walk(full); }
          else if (e.isFile()) {
            const ext = path.extname(e.name).toLowerCase();
            if (IGNORED_EXTS.has(ext)) continue;
            const lower = e.name.toLowerCase();
            if (lower.endsWith('.min.js') || lower.endsWith('.min.css') || lower.endsWith('.d.ts.map')) continue;
            queue.push(full);
          }
        }
      } catch { /* skip */ }
    }
    await walk(dir);
    return queue;
  }

  const files = await collectFiles(dirPath);
  const concurrency = 8;
  let idx = 0;

  async function worker() {
    while (!stopped && idx < files.length) {
      const fp = files[idx++];
      try {
        const stat = await fs.stat(fp);
        if (stat.size > MAX_FILE_SIZE || stat.size === 0) continue;
        const lines = (await fs.readFile(fp, 'utf-8')).split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (results.length >= maxResults) { stopped = true; return; }
          if (ignoreCase ? lines[i].toLowerCase().includes(patternLower) : lines[i].includes(patternLower)) {
            results.push({ file: fp, line: i + 1, text: lines[i].trim() });
          }
        }
      } catch { /* skip */ }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return results;
}
