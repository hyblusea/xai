/**
 * Shared application state container.
 * All modules receive a reference to this object instead of using module-level globals.
 */
import type { BrowserWindow } from 'electron';
import type { FSWatcher } from 'fs';
import type { SessionConfig, ConfirmationRequest, Message, IdeUser } from '@xai/shared';
import type { ReActLoop, LLMRouter, ConfirmationManager, ToolRegistry, TerminalSessionManager } from '@xai/core';
import { MCPManager } from '@xai/core';
import type { MqttBridge } from './mqtt-bridge.js';
import type { AdapterManager } from './adapter-manager.js';
import type { BrowserSessionManager } from './browser-session-manager.js';
import type { AdminClient } from './admin-client.js';
import type { ConversationStore } from './conversation-store.js';

export class AppState {
  mainWindow: BrowserWindow | null = null;
  reactLoop: ReActLoop | null = null;
  confirmationManager!: ConfirmationManager;
  sessionConfig!: SessionConfig;
  currentLLMRouter: LLMRouter | null = null;
  adapterManager!: AdapterManager;

  /** 当前登录的 IDE 用户（登录后设置；未登录为 null）。 */
  currentUser: IdeUser | null = null;
  /** 内存中的 access token（每次刷新更新）。 */
  accessToken: string | null = null;
  /** 管理平台 HTTP 客户端（auth + designer 共用，登录后注入 token）。 */
  adminClient!: AdminClient;

  /** 当前在 designer 视图选中的项目 ID（用于"查看提示词"等需要项目上下文的菜单）。
   *  在 DesignerLoadProject 时更新；切换/关闭项目时清空。 */
  currentDesignerProjectId: string | null = null;

  /** 关闭窗口时绕过 close 拦截的标志。渲染进程确认未保存提示后通过
   *  window:force-close 设置为 true 再调用 close()，避免再次触发拦截。 */
  forceCloseWindow: boolean = false;

  fileWatcher: FSWatcher | null = null;
  isAgentRunning: boolean = false;
  currentCommandInfo: { commandId: string; command: string } | null = null;
  isFirstMessageOfSession: boolean = true;
  /** Whether a session title has already been generated for the current session. */
  titleGenerated: boolean = false;
  firstAssistantMessage: string = '';
  currentConfirmationRequest: ConfirmationRequest | null = null;
  currentSessionTitle: string = '';
  currentMessages: Message[] = [];

  mcpManager: MCPManager = new MCPManager();
  toolRegistry: ToolRegistry | null = null;
  mqttBridge: MqttBridge | null = null;
  terminalSessionManager: TerminalSessionManager | null = null;
  browserSessionManager: BrowserSessionManager | null = null;

  /**
   * Local conversation store for stateless providers (OpenAI / DevEco / Cline).
   * Instantiated in main.ts after app.whenReady() (constructor uses app.getPath).
   * Code-view only — Designer uses snapshotSession/restoreSession and never
   * persists through this store.
   */
  conversationStore!: ConversationStore;

  /** Send a message to the renderer process.
   *  Defensive against disposed/crashed render frames — during designer HTML
   *  streaming the renderer frame can be momentarily disposed (e.g. while
   *  re-rendering a large page), which makes webContents.send() throw
   *  "Render frame was disposed before WebFrameMain could be accessed".
   *  Swallowing that error keeps the streaming loop alive instead of crashing
   *  the generation and leaving the canvas blank (black screen). */
  sendToRenderer(channel: string, ...args: unknown[]): void {
    const win = this.mainWindow;
    if (!win || win.isDestroyed()) return;
    const wc = win.webContents;
    if (wc.isDestroyed() || wc.isCrashed()) return;
    try {
      wc.send(channel, ...args);
    } catch (err) {
      // Frame was disposed between the check above and the send (race).
      // Log once for diagnostics; do not propagate — propagation breaks the
      // designer streaming loop and causes the black-screen symptom.
      console.warn(`[AppState] sendToRenderer("${channel}") dropped: ${(err as Error).message}`);
    }
  }

  /** Log a message to both console and renderer */
  logToRenderer(level: string, message: string): void {
    console.log(`[XAI][${level}] ${message}`);
    this.sendToRenderer('agent:message', { level, message, timestamp: Date.now() });
  }
}
