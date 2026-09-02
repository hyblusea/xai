import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// xterm.js v6.0.0 ships pre-minified ESM. esbuild's production minification
// (part of Vite's Rollup pipeline) corrupts closure captures in requestMode
// and other DCS/CSI handlers — e.g. `let r; IIFE(r||(r={}))` gets rewritten to
// `IIFE(void 0||(r={}))` which throws ReferenceError since r is undeclared.
// This kills the parser chain and breaks all TUI apps (mimo, vim, htop).
// Fix: disable esbuild minification entirely. The xterm module is already
// pre-minified, so the bundle size impact is minimal.
// See: https://github.com/xtermjs/xterm.js/issues/5800
export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: 'dist',
    minify: false,
  },
  optimizeDeps: {
    exclude: ['@xterm/xterm'],
  },
  server: {
    port: 5173,
  },
});
