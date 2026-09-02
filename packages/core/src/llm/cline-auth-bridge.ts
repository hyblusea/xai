/**
 * 桥接模块：re-export Cline 源码中的 auth/cline 公共 API。
 *
 * 测试文件通过 `import ... from "./cline-auth-bridge"` 引用 Cline 源码，
 * 配合 vitest.config.ts 中的 alias 把 @cline/shared 等内部包映射到 mock，
 * 即可在 xai 项目的 vitest 环境下运行 Cline 登录逻辑的单元测试。
 *
 * 路径说明：Cline 源码位于 D:\cline-main\cline-main，通过 vitest.config.ts
 * 的 alias `#cline-root` 注入，避免在源码里硬编码绝对路径或跨盘符相对路径。
 */
export type {
  ClineOAuthCredentials,
  ClineOAuthProviderOptions,
  ClineTokenResolution,
} from "#cline-root/sdk/packages/core/src/auth/cline";

export {
  completeClineDeviceAuth,
  getValidClineCredentials,
  loginClineOAuth,
  refreshClineToken,
  startClineDeviceAuth,
} from "#cline-root/sdk/packages/core/src/auth/cline";
