import { defineConfig } from 'tsup';
import { copyFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, basename } from 'path';
import { createRequire } from 'node:module';

const wasmFile = 'sha3_wasm_bg.7b9ca65ddd.wasm';
const req = createRequire(resolve(import.meta.dirname ?? __dirname, 'package.json'));

/**
 * Resolve the ripgrep binary path from the installed platform-specific package.
 * @vscode/ripgrep uses require.resolve at runtime, so we replicate that logic
 * here to copy the binary into dist/ next to the bundled output.
 */
function resolveRgBinary(): string | null {
  const binaryName = process.platform === 'win32' ? 'rg.exe' : 'rg';
  try {
    const { rgPath } = req('@vscode/ripgrep') as { rgPath: string };
    if (existsSync(rgPath)) return rgPath;
  } catch { /* not installed */ }

  // Fallback: manual search in pnpm store
  const arch = process.env.npm_config_arch || process.arch;
  const platformPkg = `@vscode/ripgrep-${process.platform}-${arch}`;
  try {
    const rgIndex = req.resolve('@vscode/ripgrep/lib/index.js');
    const pkgDir = resolve(rgIndex, '../..');
    const candidates = [
      resolve(pkgDir, 'node_modules', platformPkg, 'bin', binaryName),
      resolve(pkgDir, '..', platformPkg, 'bin', binaryName),
    ];
    for (const c of candidates) {
      if (existsSync(c)) return c;
    }
  } catch { /* skip */ }

  return null;
}

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  noExternal: ['@xai/shared'],
  external: ['undici', 'https-proxy-agent', 'socks-proxy-agent'],
  async onSuccess() {
    // Copy the DeepSeek PoW WASM next to the bundled JS so that the runtime
    // can resolve it from a stable path regardless of cwd.
    const src = resolve(__dirname, 'src/llm', wasmFile);
    const dest = resolve(__dirname, 'dist', wasmFile);
    try {
      copyFileSync(src, dest);
    } catch (e) {
      console.error(`[tsup] failed to copy ${wasmFile}:`, e);
      throw e;
    }

    // Copy ripgrep binary into dist/rg/ so the runtime can find it.
    const rgSrc = resolveRgBinary();
    if (rgSrc && existsSync(rgSrc)) {
      const rgDir = resolve(__dirname, 'dist', 'rg');
      mkdirSync(rgDir, { recursive: true });
      const rgDest = resolve(rgDir, basename(rgSrc));
      copyFileSync(rgSrc, rgDest);
      console.log(`[tsup] copied ripgrep binary to ${rgDest}`);
    } else {
      console.warn('[tsup] ripgrep binary not found — search will use Node.js fallback');
    }
  },
});
