import { defineConfig } from 'vitest/config';
import path from 'node:path';

// Cline 源码根目录（D:\cline-main\cline-main）。
// 测试通过 `#cline-root/...` 引用 Cline 源码文件，避免在源码里硬编码
// 跨盘符相对路径。
const CLINE_ROOT = process.env.CLINE_ROOT ?? 'D:\\cline-main\\cline-main';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.bugtest.ts'],
  },
  resolve: {
    extensions: ['.ts', '.js'],
    conditions: ['import'],
    alias: {
      // 桥接模块用 `#cline-root/sdk/...` 引用 Cline 源码。
      '#cline-root': path.resolve(CLINE_ROOT),
      // Cline 源码用 `@cline/shared` 引入 decodeJwtPayload /
      // getClineEnvironmentConfig / ITelemetryService 类型。测试文件已用
      // vi.mock("@cline/shared", ...) 替换运行时实现，但 vitest 在解析
      // 类型 import 时仍需要一个可解析的路径，这里指向 Cline 源码。
      '@cline/shared': path.resolve(
        CLINE_ROOT,
        'sdk/packages/shared/src/index.ts',
      ),
    },
  },
  esbuild: {
    target: 'es2022',
  },
});
