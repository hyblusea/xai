/**
 * 管理平台后端 HTTP 客户端。
 * 由主进程统一发起请求（避免渲染进程直连，便于注入 baseUrl、JWT、错误处理）。
 * access token 存内存（AppState.accessToken），refresh token 用 safeStorage 加密落盘。
 */
import { app, safeStorage } from 'electron';
import fs from 'fs/promises';
import path from 'path';
import type {
  AuthResult,
  IdeUser,
  LoginRequest,
  RegisterRequest,
  ChangePasswordRequest,
  UpdateProfileRequest,
  ForgotPasswordRequest,
  ResetPasswordRequest,
  DesignerProject,
  DesignerScreen,
  FolderTreeNode,
  ProjectMember,
  FolderPermissionGrant,
  ProjectRole,
  FolderPermission,
  WritableFolder,
  Publication,
  CreatePublicationRequest,
  ScreenHistorySummary,
  ScreenHistoryContent,
  MasterLayout,
} from '@xai/shared';

const REFRESH_FILE = 'xai-auth.json';
const CREDENTIALS_FILE = 'xai-credentials.json';

function refreshFilePath(): string {
  return path.join(app.getPath('userData'), REFRESH_FILE);
}

function credentialsFilePath(): string {
  return path.join(app.getPath('userData'), CREDENTIALS_FILE);
}

/** 加密保存 refresh token。 */
export async function persistRefreshToken(token: string | null): Promise<void> {
  const file = refreshFilePath();
  if (!token) {
    try { await fs.unlink(file); } catch { /* ignore */ }
    return;
  }
  if (!safeStorage.isEncryptionAvailable()) {
    // 退化：明文写（开发环境）
    await fs.writeFile(file, JSON.stringify({ token }), 'utf8');
    return;
  }
  const buf = safeStorage.encryptString(token);
  await fs.writeFile(file, JSON.stringify({ token: buf.toString('base64') }), 'utf8');
}

/** 读取已保存的 refresh token。 */
export async function loadRefreshToken(): Promise<string | null> {
  try {
    const raw = await fs.readFile(refreshFilePath(), 'utf8');
    const obj = JSON.parse(raw);
    if (!obj.token) return null;
    if (safeStorage.isEncryptionAvailable() && typeof obj.token === 'string') {
      // 加密格式：base64 编码的密文
      try {
        return safeStorage.decryptString(Buffer.from(obj.token, 'base64'));
      } catch {
        return obj.token; // 兼容明文
      }
    }
    return typeof obj.token === 'string' ? obj.token : null;
  } catch {
    return null;
  }
}

/** 记住的登录凭据（邮箱 + 密码），用于下次启动时自动填充登录表单。 */
export interface RememberedCredentials {
  email: string;
  password: string;
}

/** 加密保存用户登录凭据（邮箱 + 密码），方便下次登录时自动填充。 */
export async function persistCredentials(creds: RememberedCredentials | null): Promise<void> {
  const file = credentialsFilePath();
  if (!creds || !creds.email) {
    try { await fs.unlink(file); } catch { /* ignore */ }
    return;
  }
  const json = JSON.stringify(creds);
  if (!safeStorage.isEncryptionAvailable()) {
    // 退化：明文写（开发环境）
    await fs.writeFile(file, JSON.stringify({ creds: json }), 'utf8');
    return;
  }
  const buf = safeStorage.encryptString(json);
  await fs.writeFile(file, JSON.stringify({ creds: buf.toString('base64') }), 'utf8');
}

/** 读取已记住的登录凭据。 */
export async function loadCredentials(): Promise<RememberedCredentials | null> {
  try {
    const raw = await fs.readFile(credentialsFilePath(), 'utf8');
    const obj = JSON.parse(raw);
    if (!obj.creds || typeof obj.creds !== 'string') return null;
    let json: string;
    if (safeStorage.isEncryptionAvailable()) {
      try {
        json = safeStorage.decryptString(Buffer.from(obj.creds, 'base64'));
      } catch {
        // 兼容明文格式
        json = obj.creds;
      }
    } else {
      json = obj.creds;
    }
    const parsed = JSON.parse(json);
    if (parsed && typeof parsed.email === 'string' && typeof parsed.password === 'string') {
      return { email: parsed.email, password: parsed.password };
    }
    return null;
  } catch {
    return null;
  }
}

interface ApiEnvelope<T> {
  success: boolean;
  data?: T;
  error?: string;
  code?: string;
}

export class AdminClientError extends Error {
  code?: string;
  status: number;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export class AdminClient {
  private baseUrl: string;
  private accessToken: string | null = null;
  /** access token 过期时间戳（毫秒，来自后端 AuthResult.expiresAt）。 */
  private accessTokenExpiresAt: number | null = null;
  private onTokenRefreshed?: (access: string, user: IdeUser) => void;
  /** 并发去重：同一时刻只允许一次 access token 刷新，其他请求等待同一个 Promise。 */
  private refreshInFlight: Promise<string> | null = null;
  /** access token 剩余有效期低于此阈值则主动刷新（5 分钟）。 */
  private readonly REFRESH_THRESHOLD_MS = 5 * 60 * 1000;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  /**
   * 用 refresh token 刷新 access token。
   * - 并发去重：多个请求同时命中 401/403 时，只刷新一次。
   * - 刷新成功后更新 this.accessToken、持久化新 refresh token、触发 onTokenRefreshed 回调。
   * @returns 新的 access token；刷新失败时 reject。
   */
  private async refreshAccessToken(): Promise<string> {
    if (this.refreshInFlight) return this.refreshInFlight;
    this.refreshInFlight = (async () => {
      const refreshToken = await loadRefreshToken();
      if (!refreshToken) {
        throw new AdminClientError('无 refresh token', 401, 'NO_REFRESH');
      }
      // refresh() 内部走 auth:false，不会触发 401 重试，无递归风险。
      const r = await this.refresh(refreshToken);
      // 持久化新下发的 refresh token（接口每次返回新的）
      await persistRefreshToken(r.refreshToken);
      return r.accessToken;
    })().finally(() => {
      this.refreshInFlight = null;
    });
    return this.refreshInFlight;
  }

  /**
   * 主动刷新：若 access token 剩余有效期低于阈值则提前刷新，避免请求打到后端才 401。
   * 仅用于"会触发 401 重试"的请求路径（needsAuth 且非 refreshToken 路径）。
   * 容错：刷新失败时静默忽略，让请求用旧 token 走原 401 兜底逻辑。
   */
  private async maybeRefreshAccessToken(): Promise<void> {
    if (this.refreshInFlight) {
      // 已有并发刷新在跑，等它结束即可（失败也会被 catch）。
      try { await this.refreshInFlight; } catch { /* 忽略，下方再判 expiresAt */ }
    }
    if (!this.accessToken || this.accessTokenExpiresAt == null) return;
    const remaining = this.accessTokenExpiresAt - Date.now();
    if (remaining > this.REFRESH_THRESHOLD_MS) return;
    try {
      await this.refreshAccessToken();
    } catch {
      // 刷新失败：不抛，让请求继续用旧 token（最终命中 401 重试逻辑）。
    }
  }

  setBaseUrl(url: string): void {
    this.baseUrl = url.replace(/\/$/, '');
  }

  setAccessToken(token: string | null): void {
    this.accessToken = token;
    // 外部主动置空（如登出）时同步清空过期时间；置非空时一律重置为 null，
    // 由后续 login/register/refresh 重新写入。
    this.accessTokenExpiresAt = null;
  }

  /** 注入回调：token 刷新后通知 AppState 更新。 */
  onRefreshed(cb: (access: string, user: IdeUser) => void): void {
    this.onTokenRefreshed = cb;
  }

  private async request<T>(
    method: string,
    p: string,
    body?: unknown,
    opts: { auth?: boolean; refreshToken?: string } = {},
  ): Promise<T> {
    const url = `${this.baseUrl}${p}`;
    const needsAuth = opts.auth !== false;
    const buildHeaders = (token: string | null): Record<string, string> => {
      const h: Record<string, string> = { 'Content-Type': 'application/json' };
      if (needsAuth) {
        const t = opts.refreshToken ?? token;
        if (t) h['Authorization'] = `Bearer ${t}`;
      }
      return h;
    };

    // 主动刷新：access token 剩余有效期 < 5 分钟时，提前刷新避免请求打到后端才 401。
    // 仅对"会触发 401 重试"的请求路径生效（needsAuth 且非 refreshToken 路径）。
    if (needsAuth && !opts.refreshToken) {
      await this.maybeRefreshAccessToken();
    }

    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: buildHeaders(this.accessToken),
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (fetchErr: unknown) {
      // Node.js fetch 网络层错误（DNS 解析失败、连接拒绝、网络不可达等）会抛
      // TypeError: fetch failed，真实原因藏在 err.cause 里。不提取 cause 的话，
      // 上层只能看到无意义的 "fetch failed"，Mac 用户无法判断是网络不通还是服务未启动。
      const cause = (fetchErr instanceof Error && (fetchErr as any).cause) instanceof Error
        ? (fetchErr as any).cause as Error
        : null;
      const detail = cause
        ? `${cause.message} (${cause.constructor.name})`
        : (fetchErr instanceof Error ? fetchErr.message : String(fetchErr));
      console.error(`[AdminClient] fetch 失败: ${url} → ${detail}`);
      throw new AdminClientError(
        `网络请求失败: ${detail}（服务器: ${this.baseUrl}）`,
        0,
        'FETCH_FAILED',
      );
    }

    // 401/403：access token 过期（或无权限）。仅对需鉴权且非 auth 接口的请求
    // 尝试刷新 access token + 重试一次；refresh/refreshToken 路径本身走 auth:false，不会递归。
    if ((res.status === 401 || res.status === 403) && needsAuth && !opts.refreshToken) {
      try {
        const newToken = await this.refreshAccessToken();
        // refresh() 已更新 this.accessToken，这里用返回值重试更稳
        try {
          res = await fetch(url, {
            method,
            headers: buildHeaders(newToken),
            body: body ? JSON.stringify(body) : undefined,
          });
        } catch (retryFetchErr: unknown) {
          const cause2 = (retryFetchErr instanceof Error && (retryFetchErr as any).cause) instanceof Error
            ? (retryFetchErr as any).cause as Error
            : null;
          const detail2 = cause2
            ? `${cause2.message} (${cause2.constructor.name})`
            : (retryFetchErr instanceof Error ? retryFetchErr.message : String(retryFetchErr));
          throw new AdminClientError(
            `网络请求失败(重试): ${detail2}（服务器: ${this.baseUrl}）`,
            0,
            'FETCH_FAILED',
          );
        }
      } catch (refreshErr) {
        // 刷新失败：如果是 FETCH_FAILED 则直接抛出（网络不通，刷新也没用）
        if (refreshErr instanceof AdminClientError && refreshErr.code === 'FETCH_FAILED') {
          throw refreshErr;
        }
        // 其他刷新失败：抛出统一错误，调用方可据 code 判断是否需重新登录
        throw new AdminClientError(
          `会话已过期且刷新失败: ${(refreshErr as Error).message}`,
          401,
          'REFRESH_FAILED',
        );
      }
    }

    let payload: ApiEnvelope<T>;
    try {
      payload = await res.json() as ApiEnvelope<T>;
    } catch {
      throw new AdminClientError(`HTTP ${res.status}: 响应解析失败`, res.status);
    }
    if (!payload.success) {
      throw new AdminClientError(payload.error || `请求失败 (${res.status})`, res.status, payload.code);
    }
    return payload.data as T;
  }

  // ====== Auth ======
  async login(req: LoginRequest): Promise<AuthResult> {
    const r = await this.request<AuthResult>('POST', '/api/auth/login', req, { auth: false });
    this.accessToken = r.accessToken;
    this.accessTokenExpiresAt = r.expiresAt;
    this.onTokenRefreshed?.(r.accessToken, r.user);
    return r;
  }

  async register(req: RegisterRequest): Promise<AuthResult> {
    const r = await this.request<AuthResult>('POST', '/api/auth/register', req, { auth: false });
    this.accessToken = r.accessToken;
    this.accessTokenExpiresAt = r.expiresAt;
    this.onTokenRefreshed?.(r.accessToken, r.user);
    return r;
  }

  async refresh(refreshToken: string): Promise<AuthResult> {
    const r = await this.request<AuthResult>('POST', '/api/auth/refresh', { refreshToken }, { auth: false });
    this.accessToken = r.accessToken;
    this.accessTokenExpiresAt = r.expiresAt;
    this.onTokenRefreshed?.(r.accessToken, r.user);
    return r;
  }

  logout(refreshToken: string): Promise<void> {
    // 先清空本地状态，再发请求；无论后端响应如何，本地都视为已登出。
    this.accessToken = null;
    this.accessTokenExpiresAt = null;
    return this.request<void>('POST', '/api/auth/logout', { refreshToken });
  }

  me(): Promise<IdeUser> {
    return this.request<IdeUser>('GET', '/api/auth/me');
  }

  changePassword(req: ChangePasswordRequest): Promise<void> {
    return this.request<void>('POST', '/api/auth/change-password', req);
  }

  updateProfile(req: UpdateProfileRequest): Promise<IdeUser> {
    return this.request<IdeUser>('PUT', '/api/auth/profile', req);
  }

  /** 忘记密码：向注册邮箱发送 6 位验证码（10 分钟有效）。无需登录态。 */
  forgotPassword(req: ForgotPasswordRequest): Promise<void> {
    return this.request<void>('POST', '/api/auth/forgot-password', req, { auth: false });
  }

  /** 重置密码：校验验证码通过后设置新密码。无需登录态。 */
  resetPassword(req: ResetPasswordRequest): Promise<void> {
    return this.request<void>('POST', '/api/auth/reset-password', req, { auth: false });
  }

  // ====== Projects ======
  /**
   * 后端 ProjectResponse 不含 screens/folders（仅元数据）。
   * 统一补默认值，避免渲染层访问 project.screens.length 时出现 undefined 报错。
   * screens/folders 的完整数据通过 loadTree / loadProject 单独获取。
   *
   * masterLayoutsJson（JSON 字符串）在此处反序列化为 masterLayouts: MasterLayout[]，
   * 并删除原始 masterLayoutsJson 字段避免泄漏到渲染层。解析失败/空时回退为空数组，
   * 触发所有注入逻辑短路（向后兼容老项目）。
   */
  private normalizeProject(p: Partial<DesignerProject> & { masterLayoutsJson?: string | null }): DesignerProject {
    let masterLayouts: MasterLayout[] | undefined;
    const raw = p.masterLayoutsJson;
    if (typeof raw === 'string' && raw.trim()) {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          masterLayouts = parsed as MasterLayout[];
        }
      } catch {
        // 解析失败不致命：当作未启用处理，避免老数据损坏阻塞加载
        masterLayouts = undefined;
      }
    }
    const { masterLayoutsJson: _omit, ...rest } = p;
    return {
      ...rest,
      screens: p.screens ?? [],
      folders: p.folders ?? [],
      masterLayouts,
    } as DesignerProject;
  }

  listProjects(): Promise<DesignerProject[]> {
    return this.request<DesignerProject[]>('GET', '/api/projects').then(arr => arr.map(p => this.normalizeProject(p)));
  }

  createProject(req: { name: string; type: string; themePrompt?: string }): Promise<DesignerProject> {
    return this.request<DesignerProject>('POST', '/api/projects', req).then(p => this.normalizeProject(p));
  }

  getProject(projectId: string): Promise<DesignerProject> {
    return this.request<DesignerProject>('GET', `/api/projects/${projectId}`).then(p => this.normalizeProject(p));
  }

  updateProject(projectId: string, req: { name?: string; themePrompt?: string; masterLayoutsJson?: string }): Promise<DesignerProject> {
    return this.request<DesignerProject>('PUT', `/api/projects/${projectId}`, req).then(p => this.normalizeProject(p));
  }

  deleteProject(projectId: string): Promise<void> {
    return this.request<void>('DELETE', `/api/projects/${projectId}`);
  }

  loadTree(projectId: string): Promise<FolderTreeNode> {
    return this.request<FolderTreeNode>('GET', `/api/projects/${projectId}/tree`);
  }

  // ====== Folders ======
  createFolder(projectId: string, req: { parentId: number | null; name: string }): Promise<unknown> {
    return this.request('POST', `/api/projects/${projectId}/folders`, req);
  }

  renameFolder(folderId: number, name: string): Promise<unknown> {
    return this.request('PUT', `/api/folders/${folderId}`, { name });
  }

  deleteFolder(folderId: number): Promise<void> {
    return this.request<void>('DELETE', `/api/folders/${folderId}`);
  }

  moveFolder(folderId: number, targetParentId: number | null): Promise<unknown> {
    return this.request('PUT', `/api/folders/${folderId}/move`, { targetParentId });
  }

  listFolderPermissions(folderId: number): Promise<FolderPermissionGrant[]> {
    return this.request<FolderPermissionGrant[]>('GET', `/api/folders/${folderId}/permissions`);
  }

  writableFolders(projectId: string): Promise<WritableFolder[]> {
    return this.request<WritableFolder[]>('GET', `/api/projects/${projectId}/writable-folders`);
  }

  grantFolderPermission(folderId: number, userId: number, permission: FolderPermission): Promise<void> {
    return this.request<void>('POST', `/api/folders/${folderId}/permissions`, { userId, permission });
  }

  revokeFolderPermission(folderId: number, userId: number): Promise<void> {
    return this.request<void>('DELETE', `/api/folders/${folderId}/permissions/${userId}`);
  }

  // ====== Screens ======
  /**
   * 后端 ScreenResponse 用 `content` 字段存储 HTML，前端 DesignerScreen 用 `html`。
   * 这里做一次字段映射，避免渲染层读到 `screen.html === undefined` 导致画布空白。
   * 同时把 ISO 时间字符串转为毫秒时间戳，与 DesignerScreen 类型保持一致。
   */
  private mapScreen(raw: Record<string, unknown>): DesignerScreen {
    const toMs = (v: unknown): number | undefined => {
      if (v == null) return undefined;
      const n = typeof v === 'number' ? v : Date.parse(String(v));
      return Number.isNaN(n) ? undefined : n;
    };
    return {
      id: raw.id as string,
      name: raw.name as string,
      html: (raw.content as string) ?? (raw.html as string) ?? '',
      createdAt: toMs(raw.createdAt) ?? Date.now(),
      folderId: (raw.folderId as number | null) ?? null,
      ownerId: raw.ownerId as number | undefined,
      ownerName: raw.ownerName as string | undefined,
      version: raw.version as number | undefined,
      canEdit: raw.canEdit as boolean | undefined,
      updatedAt: toMs(raw.updatedAt),
    } as DesignerScreen;
  }

  saveScreen(projectId: string, req: { folderId: number | null; name: string; content: string }): Promise<DesignerScreen> {
    return this.request<Record<string, unknown>>('POST', `/api/projects/${projectId}/screens`, req).then(r => this.mapScreen(r));
  }

  getScreen(screenId: string): Promise<DesignerScreen> {
    return this.request<Record<string, unknown>>('GET', `/api/screens/${screenId}`).then(r => this.mapScreen(r));
  }

  updateScreen(screenId: string, req: { content: string; version: number; source?: string }): Promise<DesignerScreen> {
    return this.request<Record<string, unknown>>('PUT', `/api/screens/${screenId}`, req).then(r => this.mapScreen(r));
  }

  deleteScreen(screenId: string): Promise<void> {
    return this.request<void>('DELETE', `/api/screens/${screenId}`);
  }

  renameScreen(screenId: string, name: string): Promise<DesignerScreen> {
    return this.request<Record<string, unknown>>('PUT', `/api/screens/${screenId}/rename`, { name }).then(r => this.mapScreen(r));
  }

  moveScreen(screenId: string, targetFolderId: number | null): Promise<DesignerScreen> {
    return this.request<Record<string, unknown>>('PUT', `/api/screens/${screenId}/move`, { targetFolderId }).then(r => this.mapScreen(r));
  }

  setHomeScreen(projectId: string, screenId: string | null): Promise<void> {
    return this.request<void>('PUT', `/api/projects/${projectId}/home-screen`, { screenId });
  }

  reorderScreen(screenId: string, targetScreenId: string, insertBefore: boolean): Promise<void> {
    return this.request<void>('PUT', `/api/screens/${screenId}/reorder`, { targetScreenId, insertBefore });
  }

  duplicateScreen(projectId: string, screenId: string): Promise<DesignerScreen> {
    return this.request<Record<string, unknown>>('POST', `/api/projects/${projectId}/screens/${screenId}/duplicate`).then(r => this.mapScreen(r));
  }

  // ====== Members ======
  listMembers(projectId: string): Promise<ProjectMember[]> {
    return this.request<ProjectMember[]>('GET', `/api/projects/${projectId}/members`);
  }

  addMember(projectId: string, email: string, role: ProjectRole): Promise<ProjectMember> {
    return this.request<ProjectMember>('POST', `/api/projects/${projectId}/members`, { email, role });
  }

  updateMemberRole(projectId: string, userId: number, role: ProjectRole): Promise<ProjectMember> {
    return this.request<ProjectMember>('PUT', `/api/projects/${projectId}/members/${userId}`, { role });
  }

  removeMember(projectId: string, userId: number): Promise<void> {
    return this.request<void>('DELETE', `/api/projects/${projectId}/members/${userId}`);
  }

  searchUsers(email: string): Promise<{ id: number; email: string; displayName: string }[]> {
    return this.request('GET', `/api/users/search?email=${encodeURIComponent(email)}`);
  }

  // ====== Publications (设计图发布) ======
  createPublication(projectId: string, req: CreatePublicationRequest): Promise<Publication> {
    return this.request<Publication>('POST', `/api/projects/${projectId}/publications`, req);
  }

  listPublications(projectId: string): Promise<Publication[]> {
    return this.request<Publication[]>('GET', `/api/projects/${projectId}/publications`);
  }

  deletePublication(projectId: string, publicationId: number): Promise<void> {
    return this.request<void>('DELETE', `/api/projects/${projectId}/publications/${publicationId}`);
  }

  refreshPublication(projectId: string, publicationId: number): Promise<Publication> {
    return this.request<Publication>('PUT', `/api/projects/${projectId}/publications/${publicationId}/refresh`);
  }

  // ====== Screen History (设计稿历史版本) ======
  listScreenHistory(screenId: string): Promise<ScreenHistorySummary[]> {
    return this.request<ScreenHistorySummary[]>('GET', `/api/screens/${screenId}/history`);
  }

  getScreenHistoryContent(screenId: string, historyId: number): Promise<ScreenHistoryContent> {
    return this.request<ScreenHistoryContent>('GET', `/api/screens/${screenId}/history/${historyId}`);
  }

  restoreScreenHistory(screenId: string, historyId: number): Promise<DesignerScreen> {
    return this.request<Record<string, unknown>>('POST', `/api/screens/${screenId}/history/${historyId}/restore`).then(r => this.mapScreen(r));
  }

  // ====== AI Logs (Code/Designer 交互日志上报) ======
  submitAiLog(req: {
    mode: 'code' | 'designer';
    sessionId?: string;
    projectId?: string;
    projectName?: string;
    screenId?: string;
    screenName?: string;
    provider?: string;
    model?: string;
    requestText: string;
    responseText?: string;
    status: 'success' | 'error' | 'aborted';
    errorMessage?: string;
    durationMs?: number;
  }): Promise<{ id: number; createdAt: string } | null> {
    return this.request<{ id: number; createdAt: string } | null>('POST', '/api/ai-logs', req);
  }
}
