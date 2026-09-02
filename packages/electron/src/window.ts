/**
 * Window & menu creation.
 */
import { app, BrowserWindow, dialog, Menu } from 'electron';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { IPCChannel } from '@xai/shared';
import type { AppState } from './app-state.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = process.env.XAI_DEV === '1';

function getRendererPath(): string {
  if (isDev) {
    return 'http://localhost:5173';
  }
  return path.resolve(__dirname, 'renderer/dist/index.html');
}

/** 崩溃日志写入 userData/crash.log,便于事后排查。 */
function appendCrashLog(line: string): void {
  try {
    const logPath = path.join(app.getPath('userData'), 'crash.log');
    const ts = new Date().toISOString();
    fs.appendFileSync(logPath, `[${ts}] ${line}\n`, 'utf8');
  } catch { /* ignore */ }
}

/**
 * 处理渲染进程崩溃:优先自动 reload;失败则弹框让用户决定。
 * 返回 true 表示已自动恢复,false 表示需要用户介入。
 */
function handleRenderGone(
  win: BrowserWindow,
  state: AppState,
  details: { reason: string; exitCode: number },
): boolean {
  const msg = `render-process-gone: reason=${details.reason}, exitCode=${details.exitCode}`;
  console.error(`[MAIN] ${msg}`);
  appendCrashLog(msg);

  // 优先尝试静默 reload(大多数 OOM/crash 后 reload 即可恢复)
  try {
    const wc = win.webContents;
    if (!wc.isDestroyed()) {
      wc.reload();
      return true;
    }
  } catch (e) {
    console.error('[MAIN] reload after crash failed:', e);
  }

  // reload 失败 → 弹框让用户选择是否重建窗口
  setImmediate(() => {
    try {
      const choice = dialog.showMessageBoxSync(win, {
        type: 'error',
        title: '渲染进程崩溃',
        message: 'IDE 渲染进程已崩溃,界面失去响应。',
        detail: `原因: ${details.reason} (exitCode=${details.exitCode})\n\n是否重新打开窗口?未保存的内容可能丢失。`,
        buttons: ['重新打开窗口', '退出应用'],
        defaultId: 0,
        cancelId: 1,
      });
      if (choice === 0) {
        try { win.destroy(); } catch { /* ignore */ }
        if (state.mainWindow === win) state.mainWindow = null;
        createWindow(state);
      } else {
        app.quit();
      }
    } catch (e) {
      console.error('[MAIN] crash dialog failed:', e);
      app.quit();
    }
  });
  return false;
}

export function createWindow(state: AppState): void {
  state.mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 700,
    title: 'XAI IDE - AI 编程助手',
    titleBarStyle: 'hidden',
    frame: false,
    backgroundColor: '#0e0f14',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
    },
  });

  const win = state.mainWindow;
  const wc = win.webContents;

  // ── 阻止顶层窗口的非预期导航 ──
  // 原因:Designer 的 srcdoc iframe sandbox 含 allow-same-origin,使 iframe 与
  // 父窗口同源。AI 生成页面里的 <a href="#"> 在同源 srcdoc 中,# 会被解析为
  // 顶层窗口 URL 的 hash,点击会导航顶层窗口 → React 应用重载 → useAuth 重挂载
  // → AuthRestoreSession 失败 → 显示登录页。
  // 显式的 loadURL / reload 不会触发 will-navigate,所以可以安全阻止全部。
  wc.on('will-navigate', (event) => {
    event.preventDefault();
  });

  // ── 渲染进程崩溃检测与自动恢复 ──
  // 常见触发原因:Designer 流式输出时长时间高负载 (conic-gradient 动画 +
  // 每帧 document.write + iframe 重排) 导致渲染进程 OOM 或 GPU 合成失败。
  // 不监听时窗口会僵死在 backgroundColor (#0e0f14 黑色) 上,Ctrl+R 也无响应。
  wc.on('render-process-gone', (_e, details) => {
    handleRenderGone(win, state, details);
  });

  // ── 渲染进程无响应(未崩溃但卡死) ──
  // 给一次自动恢复机会;若短时间内反复无响应则可能是死循环,弹框让用户决定。
  let unresponsiveCount = 0;
  let lastUnresponsiveAt = 0;
  wc.on('unresponsive', () => {
    const now = Date.now();
    const msg = `renderer unresponsive #${unresponsiveCount + 1}`;
    console.warn(`[MAIN] ${msg}`);
    appendCrashLog(msg);

    // 10 分钟内的重复无响应视为反复卡死
    if (now - lastUnresponsiveAt < 10 * 60 * 1000) {
      unresponsiveCount++;
    } else {
      unresponsiveCount = 1;
    }
    lastUnresponsiveAt = now;

    if (unresponsiveCount <= 1) {
      // 首次:强制 crash renderer,触发 render-process-gone 自动 reload
      try { wc.forcefullyCrashRenderer(); } catch { /* ignore */ }
    } else {
      // 反复卡死:弹框让用户选择
      setImmediate(() => {
        try {
          const choice = dialog.showMessageBoxSync(win, {
            type: 'warning',
            title: '渲染进程无响应',
            message: 'IDE 界面已无响应。',
            detail: '可能是某个页面或 AI 流式输出导致死循环。是否强制重新加载?',
            buttons: ['强制重新加载', '继续等待'],
            defaultId: 0,
            cancelId: 1,
          });
          if (choice === 0) {
            try { wc.forcefullyCrashRenderer(); } catch { /* ignore */ }
          }
        } catch { /* ignore */ }
      });
    }
  });

  // ── 子进程崩溃监听(GPU/Utility/Renderer 等) ──
  // Electron 新版本将 gpu-process-crashed 合并到 child-process-gone。
  // GPU 进程崩溃会引发渲染进程黑屏;Electron 通常会自动重启 GPU 进程,
  // 这里仅记录日志便于事后排查,不做手动干预。
  //
  // GPU 崩溃计数器：短时间内反复 GPU 崩溃说明 GPU 合成负载过高（Designer
  // 多页流式渲染的典型症状）。达到阈值后提示用户重启并禁用硬件加速。
  // 注意：app.disableHardwareAcceleration() 仅在 app.whenReady() 前生效，
  // 所以这里用 relaunch + 命令行 flag 方案。
  let gpuCrashCount = 0;
  let gpuCrashWindowStart = 0;
  app.on('child-process-gone', (_e, details) => {
    const msg = `child-process-gone: type=${details.type}, reason=${details.reason}, exitCode=${details.exitCode}`;
    console.error(`[MAIN] ${msg}`);
    appendCrashLog(msg);

    // GPU 进程崩溃计数（5 分钟窗口内累计 3 次以上 = 反复崩溃）
    if (details.type === 'GPU') {
      const now = Date.now();
      if (now - gpuCrashWindowStart > 5 * 60 * 1000) {
        gpuCrashCount = 0;
        gpuCrashWindowStart = now;
      }
      gpuCrashCount++;
      appendCrashLog(`GPU crash count in window: ${gpuCrashCount}`);

      if (gpuCrashCount >= 3) {
        appendCrashLog(`GPU crashed ${gpuCrashCount}x in 5min — suggesting relaunch with --disable-gpu`);
        setImmediate(() => {
          try {
            const choice = dialog.showMessageBoxSync(win, {
              type: 'warning',
              title: 'GPU 进程反复崩溃',
              message: '图形渲染进程在短时间内反复崩溃，可能导致界面黑屏或卡死。',
              detail: 'Designer 流式渲染时 GPU 合成层过多触发了 GPU 进程崩溃。\n\n建议重启应用并禁用硬件加速（使用 CPU 软件渲染），可彻底避免 GPU 崩溃。软件渲染对 Designer 视觉无影响，但整体动画可能略卡。',
              buttons: ['重启并禁用硬件加速', '继续使用'],
              defaultId: 0,
              cancelId: 1,
            });
            if (choice === 0) {
              // relaunch with --disable-gpu 禁用所有 GPU 加速
              app.relaunch({ args: [...process.argv.slice(1), '--disable-gpu'] });
              app.quit();
            }
          } catch { /* ignore */ }
        });
      }
    }
  });

  const rendererPath = getRendererPath();
  if (rendererPath.startsWith('http')) {
    win.loadURL(rendererPath);
    if (isDev) {
      wc.openDevTools();
    }
  } else {
    win.loadFile(rendererPath);
  }

  // ── 窗口关闭拦截 ──
  // 拦截所有关闭路径（标题栏关闭按钮、Alt+F4、菜单"退出"等），先通知渲染进程，
  // 让其检查 designer 视图是否有未保存的修改并弹出保存提示。
  // 渲染进程确认后通过 window:force-close 真正关闭窗口。
  win.on('close', (event) => {
    if (state.forceCloseWindow) return; // 允许关闭
    event.preventDefault();
    state.sendToRenderer(IPCChannel.WindowCloseRequested);
  });

  win.on('closed', () => {
    if (state.mainWindow === win) state.mainWindow = null;
    state.forceCloseWindow = false;
  });

  win.on('enter-full-screen', () => {
    createMenu(state);
  });
  win.on('leave-full-screen', () => {
    createMenu(state);
  });
}

export function createMenu(state: AppState): void {
  const isFullScreen = state.mainWindow?.isFullScreen() ?? false;

  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: '文件',
      submenu: [
        {
          label: '打开工作区...',
          accelerator: 'CmdOrCtrl+Shift+O',
          click: async () => {
            const result = await dialog.showOpenDialog(state.mainWindow!, {
              properties: ['openDirectory'],
              title: '选择工作区目录'
            });
            if (!result.canceled && result.filePaths.length > 0) {
              state.sessionConfig.workspace = result.filePaths[0];
              const { configManager } = await import('./config.js');
              await configManager.saveConfig(state.sessionConfig);
              state.reactLoop = null;
              const { initTerminalSessionManager } = await import('./terminal-manager.js');
              initTerminalSessionManager(state);
              const { initializeAgent } = await import('./agent/initialize.js');
              await initializeAgent(state);
              state.sendToRenderer(IPCChannel.WorkspaceInfo, state.sessionConfig.workspace);
              state.sendToRenderer('workspace:changed', state.sessionConfig.workspace);
            }
          }
        },
        {
          label: '关闭工作区',
          click: async () => {
            if (!state.sessionConfig.workspace) return;
            state.sessionConfig.workspace = '';
            const { configManager } = await import('./config.js');
            await configManager.saveConfig(state.sessionConfig);
            if (state.fileWatcher) {
              state.fileWatcher.close();
              state.fileWatcher = null;
            }
            state.reactLoop = null;
            const { initTerminalSessionManager } = await import('./terminal-manager.js');
            initTerminalSessionManager(state);
            const { initializeAgent } = await import('./agent/initialize.js');
            await initializeAgent(state);
            state.sendToRenderer(IPCChannel.WorkspaceInfo, '');
            state.sendToRenderer('workspace:changed', '');
          }
        },
        { type: 'separator' },
        {
          label: '设置...',
          accelerator: 'CmdOrCtrl+,',
          click: () => {
            state.sendToRenderer('menu:open-settings');
          }
        },
        { type: 'separator' },
        {
          label: '退出',
          accelerator: 'CmdOrCtrl+Q',
          role: 'quit'
        }
      ]
    },
    {
      label: '视图',
      submenu: [
        {
          label: '开发者工具',
          accelerator: 'CmdOrCtrl+Shift+I',
          click: () => {
            if (state.mainWindow && !state.mainWindow.isDestroyed()) {
              state.mainWindow.webContents.toggleDevTools();
            }
          }
        },
        { type: 'separator' },
        {
          label: isFullScreen ? '还原' : '全屏',
          accelerator: 'F11',
          click: () => {
            if (state.mainWindow && !state.mainWindow.isDestroyed()) {
              state.mainWindow.setFullScreen(!state.mainWindow.isFullScreen());
            }
          }
        },
      ]
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '关于 XAI IDE',
          click: () => {
            if (state.mainWindow && !state.mainWindow.isDestroyed()) {
              dialog.showMessageBoxSync(state.mainWindow, {
                type: 'info',
                title: '关于 XAI IDE',
                message: 'XAI IDE - AI 编程助手',
                detail: `版本: ${app.getVersion()}\n基于 ReAct + 流式解析的 AI 编程助手\n技术栈: Electron + React + TypeScript`,
              });
            }
          }
        }
      ]
    }
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}
