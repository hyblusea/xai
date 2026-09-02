import { defineConfig } from 'tsup';
import { cpSync, mkdirSync, copyFileSync, existsSync } from 'fs';
import { resolve, basename } from 'path';
import { createRequire } from 'node:module';

const req = createRequire(resolve(import.meta.dirname ?? __dirname, 'package.json'));

function copyRendererDist() {
  const rendererDist = resolve(__dirname, '../renderer/dist');
  const targetDir = resolve(__dirname, 'dist/renderer/dist');
  try {
    mkdirSync(targetDir, { recursive: true });
    cpSync(rendererDist, targetDir, { recursive: true });
    console.log('Copied renderer/dist to dist/renderer/dist');
  } catch (err) {
    console.warn('Failed to copy renderer/dist:', err);
  }
}

function copyDeepSeekWasm() {
  const src = resolve(__dirname, '../core/dist/sha3_wasm_bg.7b9ca65ddd.wasm');
  const dest = resolve(__dirname, 'dist/sha3_wasm_bg.7b9ca65ddd.wasm');
  try {
    copyFileSync(src, dest);
    console.log('Copied DeepSeek PoW WASM to dist/sha3_wasm_bg.7b9ca65ddd.wasm');
  } catch (err) {
    console.warn('Failed to copy DeepSeek PoW WASM:', err);
  }
}

/** Copy ripgrep binary from @vscode/ripgrep or @xai/core's dist/rg/ */
function copyRipgrepBinary() {
  const binaryName = process.platform === 'win32' ? 'rg.exe' : 'rg';
  let rgSrc: string | null = null;

  // Try @vscode/ripgrep first
  try {
    const { rgPath } = req('@vscode/ripgrep') as { rgPath: string };
    if (existsSync(rgPath)) rgSrc = rgPath;
  } catch { /* not installed */ }

  // Fallback: from @xai/core's dist/rg/ (already copied by core's tsup)
  if (!rgSrc) {
    const coreRg = resolve(__dirname, '../core/dist/rg', binaryName);
    if (existsSync(coreRg)) rgSrc = coreRg;
  }

  if (rgSrc) {
    const rgDir = resolve(__dirname, 'dist', 'rg');
    mkdirSync(rgDir, { recursive: true });
    const rgDest = resolve(rgDir, basename(rgSrc));
    copyFileSync(rgSrc, rgDest);
    console.log(`[tsup] copied ripgrep binary to ${rgDest}`);
  } else {
    console.warn('[tsup] ripgrep binary not found — search will use Node.js fallback');
  }
}

export default defineConfig([
  {
    entry: ['src/main.ts', 'src/test-captcha.ts'],
    format: ['esm'],
    external: [
      'electron', 'undici', 'mqtt', 'crypto', 'node:crypto',
      'cheerio', 'iconv-lite', 'safer-buffer',
      'https-proxy-agent', 'socks-proxy-agent',
      'typescript-language-server', 'typescript',
      // office2md 共享依赖：必须外置，避免 CJS→ESM 时 __require("fs") 兜底
      // （mammoth 等内部 require("fs")，在 ESM 主进程会抛 Dynamic require 错）
      'mammoth', 'turndown', 'turndown-plugin-gfm',
      'xlsx', 'pdfjs-dist', 'markdown-table',
    ],
    noExternal: ['@xai/core', '@xai/shared'],
    outDir: 'dist',
    clean: true,
    onSuccess: () => {
      copyRendererDist();
      copyDeepSeekWasm();
      copyRipgrepBinary();
    },
  },
  {
    entry: ['src/preload.ts'],
    format: ['cjs'],
    external: ['electron'],
    outDir: 'dist',
    clean: false,
    target: 'es2020',
  },
]);
