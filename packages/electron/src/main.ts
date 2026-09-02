/**
 * XAI IDE — Electron Main Process Entry
 *
 * This file is the orchestrator only. All logic has been extracted into
 * dedicated modules under src/ipc/, src/agent/, and standalone files.
 */
import { app, BrowserWindow } from 'electron';
import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';

// ── 提升 V8 老生代上限,缓解 Designer 流式渲染 OOM ──
// 默认渲染进程老生代约 1.4~2 GB,Designer 长页面流式输出(document.write +
// iframe reflow)易触顶导致 render-process-gone: oom。此 switch 对主进程 +
// 渲染进程同时生效(Electron 透传 --js-flags 给 renderer 子进程)。4096 适用
// 于 16 GB 及以上机器;8 GB 机器建议改 2048。必须在 app.whenReady() 之前调用。
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=4096');

// ── GPU 崩溃缓解：Designer 流式渲染（多页 doc.write + iframe reflow + 光标
// opacity 过渡）会产生大量 GPU 合成层，导致 GPU 进程过载。GPU watchdog 在 GPU
// 进程响应超时时会强制 kill 它（exitCode=-36861），严重时级联导致主进程崩溃
// （exitCode=0x80000003 STATUS_BREAKPOINT，pnpm 报 Exit status 2147483651）。
//
// 以下三个 switch 从不同维度降低 GPU 崩溃概率，全部必须在 app.whenReady() 之前
// 调用：
//   1. disable-gpu-watchdog：禁用 GPU 看门狗定时器。流式渲染期间 GPU 合成任务
//      繁重，watchdog 默认超时（~10s）会误杀正常但忙碌的 GPU 进程。禁用后 GPU
//      进程不再因"响应慢"被 kill，仅在实际崩溃时退出。
//   2. disable-gpu-sandbox：禁用 GPU 沙箱，减少 GPU 进程内存开销（沙箱本身
//      占用 ~20-30% 额外内存）。降低 OOM 概率。
//   3. disable-accelerated-2d-canvas：禁用 GPU 加速 2D Canvas。Designer 视图
//      主要使用 HTML/CSS 渲染（非 Canvas），关闭后对视觉无影响但减少 GPU 负载。
app.commandLine.appendSwitch('disable-gpu-watchdog');
app.commandLine.appendSwitch('disable-gpu-sandbox');
app.commandLine.appendSwitch('disable-accelerated-2d-canvas');

console.log('[MAIN] Starting XAI IDE...');
console.log('[MAIN] Node.js version:', process.versions.node);
console.log('[MAIN] Electron version:', process.versions.electron);
console.log('[MAIN] Current directory:', process.cwd());

// Fix: app.getVersion() may return Electron's version in dev mode.
// Read the app's own version from package.json and override it.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
try {
  const appPkgPath = path.resolve(__dirname, '../../package.json');
  const appPkgContent = await fs.readFile(appPkgPath, 'utf-8');
  const appPkg = JSON.parse(appPkgContent);
  if (appPkg.version) {
    (app as any).setVersion(appPkg.version);
    console.log('[MAIN] App version set to:', appPkg.version);
  }
} catch (err) {
  console.warn('[MAIN] Failed to read app version from package.json:', err);
}

import { configManager } from './config.js';
import { initAutoUpdater, disposeAutoUpdater } from './auto-updater.js';
import { BrowserSessionManager } from './browser-session-manager.js';
import { registerBrowserIPC } from './browser-ipc-handlers.js';
import { AppState } from './app-state.js';
import { AdapterManager } from './adapter-manager.js';
import { ConversationStore } from './conversation-store.js';
import { registerAllIpcHandlers } from './ipc/index.js';
import { createWindow, createMenu } from './window.js';
import { initTerminalSessionManager } from './terminal-manager.js';
import { initializeAgent } from './agent/initialize.js';
import { initAuthSession } from './ipc/auth-handlers.js';
import { initializeMqttBridge } from './mqtt-bridge-init.js';
import { getRgPath } from './file-search.js';
import { AdminClient } from './admin-client.js';
import { disposeLSP } from './ipc/lsp-handlers.js';

const state = new AppState();
state.adapterManager = new AdapterManager();

app.whenReady().then(async () => {
  state.sessionConfig = await configManager.loadConfig();

  // Initialize the local conversation store for stateless providers
  // (OpenAI / DevEco / Cline). Must run after app.whenReady() because the
  // constructor calls app.getPath('userData'). Initialized before IPC handlers
  // are registered so the store is ready when conversation:list/load fire.
  state.conversationStore = new ConversationStore();
  await state.conversationStore.init();

  // 初始化管理平台客户端（auth + designer 共用）
  const baseUrl = state.sessionConfig.adminServer?.baseUrl || 'http://localhost:8089';
  console.log('[MAIN] Admin server baseUrl:', baseUrl);
  state.adminClient = new AdminClient(baseUrl);
  state.adminClient.onRefreshed((access, user) => {
    state.accessToken = access;
    state.currentUser = user;
  });

  // 启动时探测 adminServer 连通性（仅日志，不阻塞启动）
  // Mac 打包后若 fetch failed，此日志可帮助区分"服务器地址不对"还是"网络不通"
  const probeUrl = `${baseUrl}/api/auth/me`;
  fetch(probeUrl, { method: 'GET' }).then(res => {
    console.log(`[MAIN] Admin server probe: ${probeUrl} → HTTP ${res.status}`);
  }).catch(err => {
    const cause = (err instanceof Error && (err as any).cause) instanceof Error
      ? (err as any).cause as Error
      : null;
    const detail = cause ? cause.message : (err instanceof Error ? err.message : String(err));
    console.error(`[MAIN] Admin server probe FAILED: ${probeUrl} → ${detail}`);
    console.error('[MAIN] 如果 Mac 上出现此错误，请检查：');
    console.error('[MAIN]   1. adminServer.baseUrl 是否正确（当前:', baseUrl, '）');
    console.error('[MAIN]   2. Mac 是否能访问该地址（内网 IP 需在同一网络）');
    console.error('[MAIN]   3. 服务器是否正在运行');
  });

  // Extract rg binary from asar to userData and expose path via env var
  // so that @xai/core can find it (core doesn't have access to Electron's app module)
  const rgPath = getRgPath();
  if (rgPath) {
    process.env.XAI_RG_PATH = rgPath;
  }

  // ── Bypass all SSL certificate errors ──
  // Electron's <webview> tags don't inherit the main session's cert trust,
  // so self-signed / untrusted certs cause navigation failures.
  app.on('certificate-error', (_event, _webContents, url, error, _cert, callback) => {
    console.log(`[MAIN] Bypassing certificate error for: ${url} (${error})`);
    _event.preventDefault();
    callback(true);
  });

  createMenu(state);
  registerAllIpcHandlers(state);
  createWindow(state);
  initTerminalSessionManager(state);

  // 尝试静默恢复登录会话（若之前已登录且 refresh token 未过期）
  initAuthSession(state).catch(e => console.log('[MAIN] auth session restore failed:', e?.message));

  // Initialize browser session manager
  state.browserSessionManager = new BrowserSessionManager();
  registerBrowserIPC(state.browserSessionManager, state.sendToRenderer.bind(state));

  await initializeAgent(state);
  initializeMqttBridge(state);
  initAutoUpdater(state.mainWindow, state.sessionConfig.update);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow(state);
    }
  });
});

app.on('window-all-closed', () => {
  disposeAutoUpdater();
  disposeLSP();
  if (state.terminalSessionManager) {
    state.terminalSessionManager.dispose();
    state.terminalSessionManager = null;
  }
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
