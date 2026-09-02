import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'happy-dom',
  },
  resolve: {
    extensions: ['.ts', '.tsx', '.js', '.jsx'],
    conditions: ['import'],
  },
  esbuild: {
    target: 'es2022',
  },
});
