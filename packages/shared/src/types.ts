export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

export interface Message {
  role: MessageRole;
  content: string;
  timestamp: number;
  toolName?: string;
  toolResult?: ToolResult;
  thinkingContent?: string;
  toolBatch?: ToolBatchItem[];
}

export interface ToolCall {
  name: string;
  parameters: Record<string, unknown>;
}

export interface ToolResult {
  toolName: string;
  success: boolean;
  output: string;
  error?: string;
  executionTime?: number;
}

/**
 * 工具输出统一截断阈值（90KB）。
 * 超过该长度的工具输出在 BaseTool.execute() 中统一截断，
 * 保证发送给 AI 的内容与聊天 UI 气泡显示的内容完全一致。
 */
export const TOOL_OUTPUT_MAX_CHARS = 90 * 1024;

export interface ToolBatchItem {
  toolName: string;
  summary?: string;
  parameters?: Record<string, unknown>;
  result?: ToolResult;
}

export interface ToolParameter {
  type: string;
  description?: string;
  required?: boolean;
  enum?: string[];
  default?: unknown;
  location?: 'header' | 'body';
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, ToolParameter>;
  confirmationRequired: boolean;
  examples?: string[];
  /**
   * How this tool should be invoked when the LLM supports native function calling.
   * - 'native' (default): sent via OpenAI `tools` field (function calling)
   * - 'text': sent via ++++ text format through AiderStyleParser
   *
   * Use 'text' for tools with large content bodies (e.g. write_file, replace_in_file)
   * to avoid JSON escaping issues in native function calling.
   */
  contentMode?: 'text' | 'native';
}

export interface LLMConfig {
  provider: string;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  customHeaders?: Record<string, string>;
  maxTokens?: number;
  temperature: number;
  stream?: boolean;
  options?: Record<string, unknown>;
  /** Context window (in tokens) for the model. When omitted, the adapter uses a model-specific heuristic. */
  contextWindow?: number;
  cookies?: string;
  botId?: string;
  // DeepSeek (chat.deepseek.com) - User Token (JWT) auth
  deepseekToken?: string;
  deepseekModel?: string;
  // Qwen AI (chat.qwen.ai) - JWT auth
  qwenaiToken?: string;
  qwenaiCookies?: string;
  qwenaiModel?: string;
  // DevEco (cn.devecostudio.huawei.com) - Huawei OAuth accessToken
  devecoAccessToken?: string;
  devecoModel?: string;
  // Z.ai (chat.z.ai) - JWT token auth + optional captcha
  zaiToken?: string;
  zaiCookies?: string;
  zaiCaptchaParam?: string;
  zaiRegion?: string;
  // Cline (api.cline.bot) - WorkOS OAuth accessToken
  clineAccessToken?: string;
  // Freebuff (freebuff.com) - device-code OAuth authToken (used as Bearer apiKey)
  freebuffApiKey?: string;
  /**
  * Per-provider saved configurations. On Save, the current llm config
  * (excluding this field) is written under the current provider's key.
  * When switching providers, the target provider's saved config is loaded
  * if present; otherwise provider defaults are used.
  */
  providerConfigs?: Record<string, LLMConfig>;
  /**
  * Named OpenAI-compatible endpoint profiles. Each key is a user-defined
  * profile name and holds a complete LLMConfig (baseUrl, apiKey, model,
  * temperature, options, ...). This lets users manage multiple OpenAI /
  * OpenAI-compatible endpoints (OpenAI official, DeepSeek, GLM, local vLLM,
  * ...) and switch between them from the settings panel.
  */
  openaiProfiles?: Record<string, LLMConfig>;
  /** The currently active OpenAI profile key (a key of `openaiProfiles`). */
  activeOpenaiProfile?: string;
}

export interface StreamChunk {
  type: 'text' | 'thinking' | 'tool_call' | 'tool_result' | 'error' | 'done';
  content: string;
  toolCall?: ToolCall;
  toolResult?: ToolResult;
}

// ── Session compression (OpenAI / DevEco / Cline) ────────────────────────────

/** Snapshot of how full the adapter's conversation history is. */
export interface ContextUsage {
  totalTokens: number;
  contextWindow: number;
  usagePercent: number;
  messageCount: number;
}

/** Result of a manual session compaction. */
export interface CompactionResult {
  success: boolean;
  error?: string;
  beforeTokens: number;
  afterTokens: number;
  beforeMessages: number;
  afterMessages: number;
  summary?: string;
}

export type AgentState =
  | 'idle'
  | 'thinking'
  | 'acting'
  | 'observing'
  | 'waiting_confirmation'
  | 'error'
  | 'completed';

export type CommandStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'timeout'
  | 'killed';

export interface CommandResult {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  status: CommandStatus;
  executionTime: number;
  timedOut: boolean;
}

export interface ConfirmationRequest {
  toolName: string;
  description: string;
  parameters: Record<string, unknown>;
  riskLevel: 'low' | 'medium' | 'high';
}

export type ConfirmationResponse = 'approve' | 'deny' | 'approve_all';

export interface MCPServerConfig {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  enabled: boolean;
}

export interface MCPToolInfo {
  serverName: string;
  name: string;
  description: string;
  parameters: Record<string, ToolParameter>;
}

export interface MQTTConfig {
  brokerUrl: string;
  enabled: boolean;
  deviceId?: string;
  encryptionKey?: string;
}

export interface ProxyConfig {
  enabled: boolean;
  server: string;
  useSystemProxy: boolean;
  cmdUseProxy: boolean;
}

export interface UpdateConfig {
  enabled: boolean;
  server: string;
  username: string;
  password: string; // base64 encoded
}

export interface SearchProxyConfig {
  enabled: boolean;
  protocol: 'http' | 'https' | 'socks4' | 'socks5';
  host: string;
  port: number;
  username?: string;
  password?: string;
}

export interface WebSearchConfig {
  enabled: boolean;
  defaultEngine: 'google' | 'bing' | 'duckduckgo' | 'baidu';
  maxResults: number;
  minRequestInterval: number;
  autoFallback: boolean;
  hl: string;
  gl: string;
}

export interface WebFetchConfig {
  enabled: boolean;
  maxLength: number;
  timeout: number;
  noiseSelectors: string[];
}

export interface OCRConfig {
  enabled: boolean;
  serverUrl: string;
  username: string;
  password: string; // base64 encoded for storage
  lang: string;
  timeout: number;
}

export interface SessionConfig {
  llm: LLMConfig;
  workspace: string;
  mcpServers: MCPServerConfig[];
  autoApproveCommands: string[];
  shortcutCommands: string[];
  mqtt: MQTTConfig;
  proxy: ProxyConfig;
  update: UpdateConfig;
  webSearch?: WebSearchConfig;
  webFetch?: WebFetchConfig;
  ocr?: OCRConfig;
  /** 管理平台后端地址，IDE 登录与 Designer 数据走此 API。 */
  adminServer?: AdminServerConfig;
  /** 上次退出时的视图模式，用于启动时还原（'code' | 'designer'）。 */
  lastViewMode?: ViewMode;
  /** Code 视图皮肤主题，用于启动时还原（'dark' | 'light'）。仅影响 Code 视图，Designer 视图始终深色。 */
  lastCodeViewTheme?: CodeViewTheme;
  /**
   * 配置结构版本号，用于自动迁移。
   * 缺省时视为 1。每次修改默认值时递增并在 migrateConfig 中补充迁移逻辑。
   */
  configVersion?: number;
}

/** 管理平台后端配置。 */
export interface AdminServerConfig {
  baseUrl: string;
}

export interface ChatTag {
  id: string;
  type: 'file' | 'code' | 'table' | 'element' | 'screen';
  filePath: string;
  startLine?: number;
  endLine?: number;
  content?: string;
  tableName?: string;
  dbType?: string;
  /** Designer element fields (type === 'element') */
  elementSelector?: string;
  elementHtml?: string;
  elementTag?: string;
  screenId?: string;
  screenName?: string;
}

/** A selected element inside the designer canvas iframe. */
export interface SelectedElement {
  /** Unique CSS selector path to locate the element inside the iframe document. */
  selector: string;
  /** Tag name (lowercase), e.g. "div", "button", "input". */
  tagName: string;
  /** element.id */
  id: string;
  /** element.className */
  className: string;
  /** Text content (truncated). */
  text: string;
  /** Computed inline style snapshot for the properties panel. */
  style: ElementStyle;
  /** Bounding rect relative to the iframe viewport (px). */
  rect: { x: number; y: number; width: number; height: number };
}

/** Editable style subset shown in the properties panel. */
export interface ElementStyle {
  width: string;
  height: string;
  backgroundColor: string;
  backgroundImage: string;
  color: string;
  fontSize: string;
  padding: string;
  margin: string;
  borderRadius: string;
  border: string;
  text: string;
  placeholder: string;
  value: string;
  href: string;
  src: string;
  /* Position */
  textAlign: string;
  left: string;
  top: string;
  rotation: string;
  zIndex: string;
  /* Appearance */
  opacity: string;
  /* Shadow & Blur */
  boxShadow: string;
  filter: string;
  backdropFilter: string;
  /* Navigation */
  linkType: string;
  linkTarget: string;
  /* Table Scroll */
  overflowX: string;
  overflowY: string;
  tableMaxHeight: string;
  /* Typography (排版四件套) */
  fontFamily: string;
  fontWeight: string;
  lineHeight: string;
  letterSpacing: string;
  textDecoration: string;
  textTransform: string;
  /* 四向间距 */
  paddingTop: string;
  paddingRight: string;
  paddingBottom: string;
  paddingLeft: string;
  marginTop: string;
  marginRight: string;
  marginBottom: string;
  marginLeft: string;
  /* Flex 布局 */
  display: string;
  flexDirection: string;
  justifyContent: string;
  alignItems: string;
  flexWrap: string;
  gap: string;
  /* Navbar 排列方向 (horizontal | vertical) */
  navbarOrientation: string;
  /* nav-link 菜单项图标名（去 bi- 前缀；空串表示无图标） */
  navLinkIcon: string;
  /* <i> 元素完整 className（用于 IconEditor 回写） */
  iconClass: string;
  /* dropdown 展开状态 (true | false | ''=未设置) */
  dropdownOpen: string;
  /* dropdown 子菜单项标记 (data-dropdown-item="true" 时为 "true"，否则 '') */
  dropdownItem: string;
  /* 侧边导航栏折叠状态 (true=折叠仅图标 | false=展开 | ''=未设置) */
  navbarCollapsed: string;
  /* Raw inline style (cssText) */
  cssText: string;
  /**
   * True when the element has multiple text-bearing element children and no
   * direct text nodes — i.e. its `text` is ambiguous and editing it via the
   * properties panel would be unsafe. Read-only DOM flag (not reset by the
   * panel's 重置 button); used by the 文本内容 section to show a hint.
   */
  hasMultipleTextChildren?: boolean;
  /**
   * Read-only DOM hint: if non-empty, the element has an ancestor that is a
   * CSS "backdrop root" (transform/filter/opacity<1/clip-path/will-change/
   * animation-forwards/etc.), which blocks `backdrop-filter` from sampling
   * the page background. Shown as a warning in the 模糊 editor so users
   * understand why blur may not visually apply.
   */
  backdropRootWarning?: string;
}

export interface ConversationItem {
  conversationId: string;
  title: string;
  createTime: string;
  updateTime: string;
}

export const MQTT_CONFIG = {
  BROKER_URL: 'ws://broker.emqx.io:8083/mqtt',
  BROKER_HOST: 'broker.emqx.io',
  BROKER_WS_PORT: 8083,
  BROKER_TCP_PORT: 1883,
  TOPIC_PREFIX: 'xai',
  QOS: 0 as const,
  PAIR_CODE_LENGTH: 6,
  PAIR_CODE_TTL_MS: 300000,
  RECONNECT_INTERVAL_MS: 5000,
  REQUEST_TIMEOUT_MS: 15000,
  DEFAULT_PAGE_SIZE: 20,
  CONTENT_MAX_LENGTH: 500,
  CODE_PREVIEW_LINES: 3,
  TOOL_OUTPUT_MAX_LENGTH: 200,
  COMMAND_OUTPUT_TAIL_LINES: 5,
  ENCRYPTION_KEY_LENGTH: 32,
  ENCRYPTION_IV_LENGTH: 16,
  TIMESTAMP_TOLERANCE_MS: 10000,
} as const;

export type MQTTQoS = 0 | 1 | 2;

export interface MQTTPairRequest {
  mobileId: string;
  deviceName: string;
  timestamp: number;
}

export interface MQTTPairResponse {
  success: boolean;
  deviceId: string;
  errorMessage?: string;
  encryptionKey?: string;
  timestamp: number;
}

export interface EncryptedPayload {
  e: string;
  iv: string;
}

export interface MobileMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  timestamp: number;
  toolName?: string;
  toolStatus?: 'running' | 'success' | 'failed';
  toolSummary?: string;
  confirmationInfo?: {
    toolName: string;
    description: string;
    riskLevel: 'low' | 'medium' | 'high';
  };
}

export interface MQTTRequest {
  requestId: string;
  command: MQTTCommandType;
  data?: unknown;
}

export type MQTTCommandType =
  | 'get_status'
  | 'get_messages'
  | 'get_confirmation'
  | 'get_workspace'
  | 'send_message'
  | 'new_session'
  | 'abort'
  | 'confirm_response'
  | 'load_history'
  | 'load_conversation'
  | 'delete_conversation'
  | 'open_workspace';

export interface MQTTResponse {
  requestId: string;
  command: MQTTCommandType;
  success: boolean;
  data?: unknown;
  error?: string;
}

export interface GetStatusData {
  agentState: AgentState;
  workspace: string;
  isAgentRunning: boolean;
  sessionTitle: string;
  hasConfirmation: boolean;
  messageCount: number;
}

export interface GetMessagesRequest {
  limit?: number;
  beforeTimestamp?: number;
  afterTimestamp?: number;
}

export interface GetMessagesData {
  messages: MobileMessage[];
  hasMore: boolean;
}

export interface GetConfirmationData {
  confirmation: ConfirmationRequest | null;
}

export interface GetWorkspaceData {
  workspace: string;
}

export interface SendMessageData {
  content: string;
}

export interface SendMessageResponse {
  success: boolean;
  isAgentRunning: boolean;
}

export interface ConfirmResponseData {
  response: ConfirmationResponse;
}

export interface LoadHistoryRequest {
  page?: number;
  pageSize?: number;
}

export interface LoadHistoryData {
  list: ConversationItem[];
}

export interface LoadConversationRequest {
  conversationId: string;
}

export interface LoadConversationData {
  messages: MobileMessage[];
}

export interface DeleteConversationRequest {
  conversationId: string;
}

export function getMQTTTopics(deviceId: string) {
  return {
    pairRequestForCode: (code: string) => `${MQTT_CONFIG.TOPIC_PREFIX}/pair/${code}/request`,
    pairResponseForCode: (code: string) => `${MQTT_CONFIG.TOPIC_PREFIX}/pair/${code}/response`,
    pcRequest: `${MQTT_CONFIG.TOPIC_PREFIX}/${deviceId}/pc/request`,
    pcResponse: `${MQTT_CONFIG.TOPIC_PREFIX}/${deviceId}/pc/response`,
  };
}

export enum IPCChannel {
  AgentStateUpdate = 'agent:state-update',
  AgentMessage = 'agent:message',
  AgentStreamChunk = 'agent:stream-chunk',
  AgentStreamThinking = 'agent:stream-thinking',
  AgentStreamReset = 'agent:stream-reset',
  AgentStreamToolSummary = 'agent:stream-tool-summary',
  AgentToolCall = 'agent:tool-call',
  AgentToolCallStart = 'agent:tool-call-start',
  AgentToolCallEnd = 'agent:tool-call-end',
  AgentConfirmationRequest = 'agent:confirmation-request',
  AgentConfirmationResponse = 'agent:confirmation-response',
  AgentStart = 'agent:start',
  AgentStop = 'agent:stop',
  AgentGetState = 'agent:get-state',
  AgentError = 'agent:error',
  AgentCompleted = 'agent:completed',
  AgentToolNames = 'agent:tool-names',
  AgentContextUpdate = 'agent:context-update',
  AgentCompressing = 'agent:compressing',
  AgentCompressed = 'agent:compressed',
  AgentCompressError = 'agent:compress-error',
  SessionCompress = 'session:compress',
  CommandExecute = 'command:execute',
  CommandResult = 'command:result',
  CommandStop = 'command:stop',
  CommandOutput = 'command:output',
  TerminalSessionOpened = 'terminal:session-opened',
  TerminalSessionData = 'terminal:session-data',
  TerminalSessionExited = 'terminal:session-exited',
  TerminalSessionSpawn = 'terminal:session-spawn',
  TerminalSessionSend = 'terminal:session-send',
  TerminalSessionClose = 'terminal:session-close',
  TerminalSessionResize = 'terminal:session-resize',
  TerminalSessionGetBuffer = 'terminal:session-get-buffer',
  ToolExecuting = 'tool:executing',
  ToolResult = 'tool:result',
  FileRead = 'file:read',
  FileWrite = 'file:write',
  FileList = 'file:list',
  FileSearch = 'file:search',
  ConfigGet = 'config:get',
  ConfigSet = 'config:set',
  ConfigReset = 'config:reset',
  WorkspaceOpen = 'workspace:open',
  WorkspaceInfo = 'workspace:info',
  WindowMinimize = 'window:minimize',
  WindowMaximize = 'window:maximize',
  WindowClose = 'window:close',
  /** Main → Renderer: window close requested (allows renderer to prompt for unsaved changes). */
  WindowCloseRequested = 'window:close-requested',
  /** Renderer → Main: force close the window, bypassing the close-requested guard. */
  WindowForceClose = 'window:force-close',
  DeleteConversation = 'delete-conversation',
  MCPList = 'mcp:list',
  MCPAdd = 'mcp:add',
  MCPUpdate = 'mcp:update',
  MCPRemove = 'mcp:remove',
  MCPServerStatus = 'mcp:server-status',
  ConfigChanged = 'config:changed',
  UpdateCheckResult = 'update:check-result',
  UpdateDownloadProgress = 'update:download-progress',
  UpdateDownloaded = 'update:downloaded',
  UpdateError = 'update:error',
  UpdateCheck = 'update:check',
  UpdateInstall = 'update:install',
  UpdateConfigChanged = 'update:config-changed',
  DbExport = 'db:export',
  DbImport = 'db:import',
  WebSearchTest = 'web:search-test',
  WebSearchTestResult = 'web:search-test-result',
  WebFetchRequest = 'web:fetch-request',
  WebFetchResult = 'web:fetch-result',
  WebFetchProgress = 'web:fetch-progress',
  WebCaptchaDetected = 'web:captcha-detected',
  WebCaptchaResolved = 'web:captcha-resolved',
  OCRTestConnection = 'ocr:test-connection',
  OCRTestImage = 'ocr:test-image',
  OCRRecognizeImage = 'ocr:recognize-image',
  DevEcoModels = 'deveco:models',
  FetchOpenaiModels = 'openai:fetch-models',
  OpenAIModelReasoning = 'openai:model-reasoning',
  OpenAIModelContextInfo = 'openai:model-context-info',
  DevEcoLogin = 'deveco:login',
  DevEcoLoginProgress = 'deveco:login-progress',
  DevEcoLogout = 'deveco:logout',
  DevEcoAuthStatus = 'deveco:auth-status',
  ClineLogin = 'cline:login',
  ClineLoginProgress = 'cline:login-progress',
  ClineLogout = 'cline:logout',
  ClineAuthStatus = 'cline:auth-status',
  ClineModels = 'cline:models',
  ClineModelReasoning = 'cline:model-reasoning',
  ClineModelContextInfo = 'cline:model-context-info',
  FreebuffLogin = 'freebuff:login',
  FreebuffLoginProgress = 'freebuff:login-progress',
  FreebuffLogout = 'freebuff:logout',
  FreebuffAuthStatus = 'freebuff:auth-status',
  FreebuffModels = 'freebuff:models',
  FreebuffModelReasoning = 'freebuff:model-reasoning',
  FreebuffModelContextInfo = 'freebuff:model-context-info',
  FreebuffSessionStart = 'freebuff:session-start',
  FreebuffSessionStatus = 'freebuff:session-status',
  FreebuffSessionEnd = 'freebuff:session-end',
  BrowserCreateSession = 'browser:create-session',
  BrowserNavigate = 'browser:navigate',
  BrowserGoBack = 'browser:go-back',
  BrowserGoForward = 'browser:go-forward',
  BrowserReload = 'browser:reload',
  BrowserClose = 'browser:close',
  BrowserMouseClick = 'browser:mouse-click',
  BrowserType = 'browser:type',
  BrowserScreenshot = 'browser:screenshot',
  BrowserEvaluate = 'browser:evaluate',
  BrowserExtract = 'browser:extract',
  BrowserCDPCommand = 'browser:cdp-command',
  BrowserTitleUpdate = 'browser:title-update',
  BrowserURLUpdate = 'browser:url-update',
  BrowserLoadingState = 'browser:loading-state',
  BrowserRegisterWebView = 'browser:register-webview',
  BrowserWait = 'browser:wait',
  BrowserQuery = 'browser:query',
  BrowserStorage = 'browser:storage',
  BrowserNetwork = 'browser:network',
  BrowserPressKey = 'browser:press-key',
  BrowserHover = 'browser:hover',
  BrowserScroll = 'browser:scroll',
  BrowserSelect = 'browser:select',
  BrowserDrag = 'browser:drag',
  BrowserApiRequest = 'browser:api-request',
  BrowserConsole = 'browser:console',
  BrowserDialog = 'browser:dialog',
  BrowserUploadFile = 'browser:upload-file',
  BrowserFile = 'browser:file',
  Office2MdConvert = 'office2md:convert',
  // ── Designer ──
  DesignerGenerate = 'designer:generate',
  DesignerStreamChunk = 'designer:stream-chunk',
  DesignerNewElement = 'designer:new-element',
  DesignerStreamThinking = 'designer:stream-thinking',
  DesignerStreamMessage = 'designer:stream-message',
  DesignerStreamDone = 'designer:stream-done',
  DesignerStreamError = 'designer:stream-error',
  DesignerAbort = 'designer:abort',
  DesignerSaveHtml = 'designer:save-html',
  DesignerListProjects = 'designer:list-projects',
  DesignerCreateProject = 'designer:create-project',
  DesignerDeleteProject = 'designer:delete-project',
  DesignerLoadProject = 'designer:load-project',
  DesignerLoadScreen = 'designer:load-screen',
  DesignerRenameProject = 'designer:rename-project',
  DesignerUpdateProjectTheme = 'designer:update-project-theme',
  DesignerDeleteScreen = 'designer:delete-screen',
  DesignerRenameScreen = 'designer:rename-screen',
  DesignerDuplicateScreen = 'designer:duplicate-screen',
  DesignerMoveScreen = 'designer:move-screen',
  DesignerCreateFolder = 'designer:create-folder',
  DesignerDeleteFolder = 'designer:delete-folder',
  DesignerRenameFolder = 'designer:rename-folder',
  DesignerSetHomeScreen = 'designer:set-home-screen',
  DesignerReorderScreen = 'designer:reorder-screen',
  DesignerExportVue = 'designer:export-vue',
  // ── Master Layout (共享母版 / 菜单注入) ──
  DesignerSaveMasterLayout = 'designer:save-master-layout',
  DesignerDeleteMasterLayout = 'designer:delete-master-layout',
  DesignerInjectMasterLayoutAll = 'designer:inject-master-layout-all',
  DesignerMasterLayoutProgress = 'designer:master-layout-progress',
  // ── Auth ──
  AuthLogin = 'auth:login',
  AuthRegister = 'auth:register',
  AuthRefresh = 'auth:refresh',
  AuthLogout = 'auth:logout',
  AuthGetCurrent = 'auth:get-current',
  AuthChangePassword = 'auth:change-password',
  AuthRestoreSession = 'auth:restore-session',
  AuthGetRememberedCredentials = 'auth:get-remembered-credentials',
  AuthUpdateProfile = 'auth:update-profile',
  AuthForgotPassword = 'auth:forgot-password',
  AuthResetPassword = 'auth:reset-password',
  // ── Team / Permission (Designer) ──
  DesignerListMembers = 'designer:list-members',
  DesignerAddMember = 'designer:add-member',
  DesignerUpdateMemberRole = 'designer:update-member-role',
  DesignerRemoveMember = 'designer:remove-member',
  DesignerSearchUsers = 'designer:search-users',
  DesignerListFolderPermissions = 'designer:list-folder-permissions',
  DesignerGrantFolderPermission = 'designer:grant-folder-permission',
  DesignerRevokeFolderPermission = 'designer:revoke-folder-permission',
  DesignerLoadTree = 'designer:load-tree',
  DesignerCheckWritePermission = 'designer:check-write-permission',
  DesignerListWritableFolders = 'designer:list-writable-folders',
  // ── Publication (设计图发布) ──
  DesignerCreatePublication = 'designer:create-publication',
  DesignerListPublications = 'designer:list-publications',
  DesignerDeletePublication = 'designer:delete-publication',
  DesignerRefreshPublication = 'designer:refresh-publication',
  // ── Screen History (设计稿历史版本) ──
  DesignerListScreenHistory = 'designer:list-screen-history',
  DesignerGetScreenHistoryContent = 'designer:get-screen-history-content',
  DesignerRestoreScreenHistory = 'designer:restore-screen-history',
  // ── Local conversation persistence (OpenAI / DevEco / Cline) ──
  // These providers are stateless, so conversations are persisted to local
  // JSON files. All three providers share one store (not partitioned).
  /** Renderer → Main: save the current conversation (displayMessages + adapter state). */
  LocalConversationSave = 'local-conversation:save',
  /** Renderer → Main: list locally stored conversations. */
  LocalConversationList = 'local-conversation:list',
  /** Renderer → Main: load a locally stored conversation by ID. */
  LocalConversationLoad = 'local-conversation:load',
  /** Renderer → Main: delete a locally stored conversation by ID. */
  LocalConversationDelete = 'local-conversation:delete',
  /** Main → Renderer: request the renderer to send back displayMessages for saving. */
  LocalConversationRequestSave = 'local-conversation:request-save',
}

// ── Browser Session Types ──
export interface BrowserSessionInfo {
  sessionId: string;
  url: string;
  title: string;
  isLoading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
}

export interface BrowserCreateSessionRequest {
  sessionId: string;
  url?: string;
}

export interface BrowserNavigateRequest {
  sessionId: string;
  url: string;
}

export interface BrowserCDPCommandRequest {
  sessionId: string;
  method: string;
  params?: Record<string, unknown>;
}

export interface BrowserCDPCommandResponse {
  success: boolean;
  result?: unknown;
  error?: string;
}

export interface BrowserTitleUpdate {
  sessionId: string;
  title: string;
}

export interface BrowserURLUpdate {
  sessionId: string;
  url: string;
  isLoading: boolean;
}

export interface BrowserLoadingState {
  sessionId: string;
  isLoading: boolean;
}

export interface BrowserRegisterWebViewRequest {
  sessionId: string;
  webContentsId: number;
}

export interface BrowserWaitRequest {
  sessionId: string;
  selector?: string;
  timeout?: number;
  waitType?: 'element' | 'navigation' | 'networkIdle';
}

export interface BrowserQueryRequest {
  sessionId: string;
  selector?: string;
  includeInteractive?: boolean;
}

export interface BrowserQueryResult {
  elements: Array<{
    tagName: string;
    selector: string;
    text: string;
    attributes: Record<string, string>;
    rect: { x: number; y: number; width: number; height: number };
  }>;
}

export interface BrowserStorageRequest {
  sessionId: string;
  storageType: 'localStorage' | 'sessionStorage' | 'cookie';
  action: 'get' | 'set' | 'remove' | 'list';
  key?: string;
  value?: string;
}

export interface BrowserNetworkRequest {
  sessionId: string;
  action: 'start' | 'stop' | 'list' | 'clear';
  filter?: string;
}

export interface BrowserPressKeyRequest {
  sessionId: string;
  key: string;
  modifiers?: string[];
}

export interface BrowserHoverRequest {
  sessionId: string;
  selector: string;
}

export interface BrowserScrollRequest {
  sessionId: string;
  direction: 'up' | 'down' | 'left' | 'right';
  amount?: number;
  selector?: string;
}

export interface BrowserSelectRequest {
  sessionId: string;
  selector: string;
  value: string;
}

export interface BrowserDragRequest {
  sessionId: string;
  fromSelector?: string;
  toSelector?: string;
  fromX?: number;
  fromY?: number;
  toX?: number;
  toY?: number;
}

export interface BrowserRightClickRequest {
  sessionId: string;
  selector?: string;
  x?: number;
  y?: number;
}

export interface BrowserDoubleClickRequest {
  sessionId: string;
  selector: string;
}

export interface BrowserCoordinateClickRequest {
  sessionId: string;
  x: number;
  y: number;
}

// ── Designer Types ──
export type ViewMode = 'code' | 'designer';
/** Code 视图皮肤主题。Designer 视图始终使用深色，不受此项影响。 */
export type CodeViewTheme = 'dark' | 'light';
export type ProjectType = 'APP' | 'WEB' | 'PDA' | 'DIAGRAM';

// ── Master Layout (共享母版 / 菜单注入) ──
/** 共享组件类型。MVP 仅暴露 menu；header/footer/sidebar 架构层已支持，UI 待 v1 开放。 */
export type MasterLayoutType = 'menu' | 'header' | 'footer' | 'sidebar';

/** 菜单项绑定状态。 */
export type MenuItemBindStatus = 'bound' | 'pending' | 'external' | 'none';

/** 单个菜单项（结构化视图，与 MasterLayout.html 双向同步）。 */
export interface MenuItem {
  /** 稳定 id，用于增量 merge 时按 id 匹配（避免按出现顺序错位）。 */
  id: string;
  /** 显示文本。 */
  label: string;
  /** Bootstrap Icons 类名（如 "house-door"），可选。 */
  icon?: string;
  /** 强绑定到 screen id（替代脆弱的文本匹配）。 */
  targetScreenId?: string;
  /** 外链 URL（bindStatus='external' 时使用）。 */
  targetUrl?: string;
  /** 子菜单（嵌套）。 */
  children?: MenuItem[];
  /** 绑定状态：已绑定 / 待绑定 / 外链 / 无跳转。 */
  bindStatus: MenuItemBindStatus;
}

/** 共享母版（核心实体）。html 为单一渲染源，menuItems 为只读视图。 */
export interface MasterLayout {
  id: string;
  /** 用户可读名称，如 "主菜单"。 */
  name: string;
  type: MasterLayoutType;
  /**
   * HTML 片段（不含 <html>/<head>/<body>），含 data-nav-target 占位。
   * 单一渲染源：menuItems 由此反向解析得到。
   */
  html: string;
  /**
   * 提取时从源页面 <style> 中抽取的与该 layout 相关的 CSS 规则（通用化：
   * 匹配元素本身或其后代的选择器，跳过 designer 注入与外部 CDN）。
   * 用于预览 iframe 与注入到其他页面时保持视觉一致性。
   */
  css?: string;
  /**
   * 提取时从源页面 <script> 中抽取的与该 layout 相关的 JS（被 inline on*
   * 引用的函数定义、引用该元素 class 的 DOMContentLoaded/init 块）。
   * 用于预览 iframe 与注入到其他页面时保持交互一致性（如侧栏子菜单展开/折叠）。
   */
  scripts?: string;
  /** 结构化菜单数据，供管理 UI 使用（只读视图）。 */
  menuItems: MenuItem[];
  /** 作用域：哪些页面使用此 layout。MVP 仅支持 mode='all'。 */
  applyTo: {
    mode: 'all' | 'folders';
    folderIds?: number[];
  };
  /** slot 标记，默认与 type 对应：menu→'main-menu', header→'main-header'... */
  slotName: string;
  createdAt: string;
  updatedAt: string;
}

export interface DesignerScreen {
  id: string;
  name: string;
  html: string;
  createdAt: number;
  /** Folder path for grouping (e.g. "/模块A/子模块"). Root if empty. */
  folderPath?: string;
  /** API 化后：所属目录 id（根目录为 null）。 */
  folderId?: number | null;
  /** 创建者 id。 */
  ownerId?: number;
  ownerName?: string;
  /** 乐观锁版本号。 */
  version?: number;
  /** 当前用户是否可编辑。 */
  canEdit?: boolean;
  updatedAt?: number;
}

export interface DesignerProject {
  id: string;
  name: string;
  type: ProjectType;
  /** Custom base path for project files. If unset, defaults to workspace/.designer */
  basePath?: string;
  /** Theme style prompt injected into system prompt when generating HTML */
  themePrompt?: string;
  /** Explicitly created empty folder paths (e.g. ["模块A", "模块A/子模块"]) */
  folders?: string[];
  createdAt: number;
  updatedAt: number;
  screens: DesignerScreen[];
  /** 项目下的设计稿数量（后端 ProjectResponse 返回；目录树加载后可缺失，回退到 screens.length）。 */
  screenCount?: number;
  /** 项目创建人（项目管理员）。API 化后由后端返回。 */
  ownerId?: number;
  /** 当前用户在该项目中的角色：OWNER/ADMIN/MEMBER。 */
  role?: ProjectRole;
  /** 首页设计稿 ID（设置为首页后，预览时默认展示该页面）。 */
  homeScreenId?: string | null;
  /** 目录路径 -> 授权用户列表（用于在项目列表中显示徽章）。 */
  folderPermissions?: Record<string, { userId: number; displayName: string; permission: FolderPermission }[]>;
  /**
   * 共享母版列表（菜单/页头/页脚等）。MVP 限制 ≤1 个 type=menu 的 layout。
   * 老项目缺失时为 undefined，所有注入逻辑会短路跳过（向后兼容）。
   */
  masterLayouts?: MasterLayout[];
}

export type ProjectRole = 'OWNER' | 'ADMIN' | 'MEMBER';
export type FolderPermission = 'READ' | 'WRITE';

/** 设计稿扩展字段（API 化后由后端返回）。 */
export interface DesignerScreenMeta {
  folderId?: number | null;
  ownerId?: number;
  ownerName?: string;
  version?: number;
  canEdit?: boolean;
}

// ── Screen History (设计稿历史版本) ──
/** 历史来源。ai_edit=AI修改, restore=从历史恢复, manual=手动。 */
export type ScreenHistorySource = 'ai_edit' | 'restore' | 'manual';

/** 历史列表项（不含 HTML 全文）。 */
export interface ScreenHistorySummary {
  id: number;
  screenId: string;
  /** 留底时刻的乐观锁版本号。 */
  version: number;
  source: ScreenHistorySource;
  summary?: string | null;
  createdBy: number;
  createdByName?: string | null;
  createdAt: number;
}

/** 历史完整内容（用于预览）。 */
export interface ScreenHistoryContent {
  id: number;
  screenId: string;
  content: string;
  version: number;
  source: ScreenHistorySource;
  summary?: string | null;
  createdAt: number;
}

// ── Auth / User Types ──
export interface IdeUser {
  id: number;
  email: string;
  displayName: string;
  status: number;
}

export interface AuthResult {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  user: IdeUser;
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface RegisterRequest {
  email: string;
  password: string;
  confirmPassword: string;
  displayName: string;
}

export interface ChangePasswordRequest {
  oldPassword: string;
  newPassword: string;
}

export interface UpdateProfileRequest {
  displayName: string;
}

/** 忘记密码：请求发送验证码到注册邮箱 */
export interface ForgotPasswordRequest {
  email: string;
}

/** 重置密码：校验验证码并设置新密码 */
export interface ResetPasswordRequest {
  email: string;
  code: string;
  newPassword: string;
}

// ── Team / Permission Types ──
export interface ProjectMember {
  userId: number;
  email: string;
  displayName: string;
  role: ProjectRole;
  joinedAt: string;
}

export interface FolderPermissionGrant {
  userId: number;
  email: string;
  displayName: string;
  permission: FolderPermission;
  grantedAt: string;
}

/** 目录树节点（含直属设计稿摘要）。 */
export interface FolderTreeNode {
  id: number | null;
  name: string;
  path: string;
  parentId: number | null;
  createdBy: number | null;
  createdByName?: string;
  permissions?: FolderPermissionResponse[];
  children: FolderTreeNode[];
  screens: ScreenSummary[];
}

/** 目录权限摘要（树节点内嵌的精简版，可能无 email）。 */
export interface FolderPermissionResponse {
  userId: number;
  email?: string;
  displayName: string;
  permission: FolderPermission;
  grantedAt: string;
}

/** 可写目录项（供前端选择保存位置）。 */
export interface WritableFolder {
  folderId: number;
  name: string;
  path: string;
  grantedUserNames: string[];
}

export interface ScreenSummary {
  id: string;
  name: string;
  ownerId: number;
  ownerName?: string;
  updatedAt: string;
}

// ── Publication (设计图发布) Types ──
export type PublicationScope = 'PROJECT' | 'FOLDER' | 'SCREEN';

export interface Publication {
  id: number;
  token: string;
  url: string;
  projectId: string;
  scope: PublicationScope;
  folderId: number | null;
  screenId: string | null;
  title: string;
  hasPassword: boolean;
  status: number;
  viewCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreatePublicationRequest {
  scope: PublicationScope;
  folderId?: number | null;
  screenId?: string | null;
  title?: string;
  password?: string;
}
