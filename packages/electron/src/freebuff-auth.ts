/**
 * Freebuff (CodebuffAI) OAuth Authentication Service.
 *
 * Implements the Freebuff CLI device-code login flow:
 *   1. Generate a stable device fingerprint (enhanced style, falls back to legacy).
 *   2. POST {baseUrl}/api/auth/cli/code  { fingerprintId } → { loginUrl, fingerprintHash, expiresAt }
 *   3. Open loginUrl in browser for the user to authenticate.
 *   4. Poll GET {baseUrl}/api/auth/cli/status  with the code until it returns
 *      a user object carrying `authToken`.
 *   5. Persist the user (authToken) to disk; reuse the token as the Bearer
 *      apiKey for the OpenAI-compatible chat completions endpoint.
 *
 * Reference: freebuff-main cli/src/utils/auth.ts, cli/src/login/login-flow.ts,
 *            cli/src/utils/codebuff-api.ts
 */
import { app, shell } from 'electron';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import os from 'os';

// ── Constants ────────────────────────────────────────────────────────────────

/**
 * Prod origin of the Codebuff API backend.
 * Used for session management (/api/v1/freebuff/session) and chat
 * completions (/api/v1/chat/completions).
 *
 * The login flow (/api/auth/cli/code, /api/auth/cli/status) targets
 * FREEBUFF_LOGIN_BASE_URL (freebuff.com) instead, matching the official
 * Freebuff CLI which uses freebuff.com for the device-code login when
 * IS_FREEBUFF=true. Tokens from freebuff.com's login are accepted by
 * codebuff.com's /api/v1/* endpoints because they share a unified auth
 * backend.
 *
 * See: freebuff-main cli/src/login/constants.ts line 13,
 *      common/src/constants/hosts.ts FREEBUFF_WEB_URL_PROD,
 *      sdk/src/impl/model-provider.ts line 147,
 *      cli/src/utils/freebuff-session-api.ts line 98.
 */
/**
 * API 后端地址。
 *
 * ⚠️ 必须使用 www.codebuff.com，不能用 codebuff.com。
 * codebuff.com 会 307 重定向到 www.codebuff.com，跨域重定向时 fetch 会
 * 丢弃 Authorization header，导致 401。
 *
 * See: freebuff-main sdk/src/impl/model-provider.ts,
 *      common/src/env-schema.ts NEXT_PUBLIC_CODEBUFF_APP_URL.
 */
const CODEBUFF_API_BASE_URL = 'https://www.codebuff.com';

/**
 * Prod origin for the Freebuff login flow.
 * The official Freebuff CLI (IS_FREEBUFF build) uses freebuff.com for
 * the device-code login endpoints (/api/auth/cli/code, /api/auth/cli/status).
 * Tokens obtained from freebuff.com are accepted by codebuff.com's API
 * because both domains share a unified auth backend.
 *
 * See: freebuff-main cli/src/login/constants.ts line 13:
 *   LOGIN_WEBSITE_URL = IS_FREEBUFF ? FREEBUFF_WEB_URL : WEBSITE_URL
 *   FREEBUFF_WEB_URL = 'https://freebuff.com' (prod)
 */
const FREEBUFF_LOGIN_BASE_URL = 'https://freebuff.com';

const LOGIN_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const LOGIN_INTERVAL_MS = 5000; // poll every 5s
const HTTP_TIMEOUT_MS = 30_000;

// ── Types ────────────────────────────────────────────────────────────────────

interface StoredUser {
  type: 'freebuff';
  id?: string;
  name: string;
  email: string;
  /** The token used as Bearer apiKey for chat-completions. */
  authToken: string;
  fingerprintId?: string;
  fingerprintHash?: string;
  savedAt: number;
}

export interface FreebuffAuthStatus {
  loggedIn: boolean;
  email: string;
  expired: boolean;
}

export interface FreebuffLoginResult {
  success: boolean;
  email?: string;
  error?: string;
  /** The login URL the user must open in a browser (long, non-blocking flows). */
  loginUrl?: string;
}

export type FreebuffLoginProgressFn = (message: string) => void;

interface LoginCodeResponse {
  loginUrl: string;
  fingerprintHash: string;
  expiresAt: string;
}

interface LoginStatusResponse {
  user?: Record<string, unknown>;
}

// ── Token persistence ────────────────────────────────────────────────────────

function getAuthFilePath(): string {
  return path.join(app.getPath('userData'), 'freebuff-auth.json');
}

function loadAuth(): StoredUser | null {
  try {
    const filePath = getAuthFilePath();
    if (!fs.existsSync(filePath)) return null;
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as StoredUser;
    if (data.type === 'freebuff' && data.authToken) return data;
  } catch {
    // ignore
  }
  return null;
}

function saveAuth(auth: StoredUser): void {
  try {
    const filePath = getAuthFilePath();
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(auth, null, 2), { mode: 0o600 });
  } catch (err) {
    console.error('[FreebuffAuth] Failed to save auth:', err);
  }
}

function clearAuth(): void {
  try {
    const filePath = getAuthFilePath();
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {
    // ignore
  }
}

// ── HTTP helpers (use global fetch so proxy-manager dispatcher is honoured) ──

interface HttpResult {
  statusCode: number;
  data: string;
}

async function httpRequest(url: string, options: {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeout?: number;
}): Promise<HttpResult> {
  const { method = 'GET', headers = {}, body, timeout = HTTP_TIMEOUT_MS } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Freebuff-CLI/dev',
        ...headers,
      },
      body,
      signal: controller.signal,
    });
    const data = await response.text();
    return { statusCode: response.status, data };
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error('Request timeout');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Base URL for the device-code login flow.
 *
 * The login endpoints (/api/auth/cli/code, /api/auth/cli/status) target
 * freebuff.com, matching the official Freebuff CLI (IS_FREEBUFF build)
 * which uses freebuff.com for the device-code login. Tokens from
 * freebuff.com's login are accepted by codebuff.com's /api/v1/* endpoints
 * because both domains share a unified auth backend.
 *
 * Reference: freebuff-main cli/src/login/constants.ts line 13:
 *   LOGIN_WEBSITE_URL = IS_FREEBUFF ? FREEBUFF_WEB_URL : WEBSITE_URL
 *   FREEBUFF_WEB_URL = 'https://freebuff.com' (prod)
 */
export function freebuffWebBase(): string {
  return process.env.NEXT_PUBLIC_FREEBUFF_APP_URL || FREEBUFF_LOGIN_BASE_URL;
}

// ── Fingerprint generation (mirrors freebuff CLI) ────────────────────────────

/**
 * Generate a legacy-style fingerprint. The enhanced hardware fingerprinting
 * (node-machine-id / systeminformation) requires optional deps; we use a
 * stable random persisted fingerprint which is sufficient for the device-code
 * flow (the server keyed sessions on fingerprintId + fingerprintHash).
 */
export function generateFreebuffFingerprint(persistedId?: string): string {
  if (persistedId) return persistedId;
  const randomSuffix = crypto.randomBytes(6).toString('base64url').substring(0, 8);
  return `codebuff-cli-${randomSuffix}`;
}

// ── Auth endpoints ───────────────────────────────────────────────────────────

async function requestLoginCode(fingerprintId: string): Promise<LoginCodeResponse> {
  const { statusCode, data } = await httpRequest(
    `${freebuffWebBase()}/api/auth/cli/code`,
    { method: 'POST', body: JSON.stringify({ fingerprintId }) },
  );
  if (statusCode < 200 || statusCode >= 300) {
    throw new Error(`Failed to get login URL: HTTP ${statusCode} - ${data.substring(0, 300)}`);
  }
  const json = JSON.parse(data) as LoginCodeResponse;
  if (!json.loginUrl || !json.fingerprintHash || !json.expiresAt) {
    throw new Error('Invalid login code response');
  }
  return json;
}

async function pollLoginStatus(
  params: { fingerprintId: string; fingerprintHash: string; expiresAt: string; timeoutMs: number },
  onProgress?: FreebuffLoginProgressFn,
): Promise<Record<string, unknown>> {
  const startTime = Date.now();
  const deadline = startTime + params.timeoutMs;
  while (Date.now() <= deadline) {
    const query = new URLSearchParams({
      fingerprintId: params.fingerprintId,
      fingerprintHash: params.fingerprintHash,
      expiresAt: params.expiresAt,
    }).toString();
    try {
      const { statusCode, data } = await httpRequest(
        `${freebuffWebBase()}/api/auth/cli/status?${query}`,
        { method: 'GET', timeout: HTTP_TIMEOUT_MS },
      );
      if (statusCode >= 200 && statusCode < 300) {
        const json = JSON.parse(data) as LoginStatusResponse;
        if (json.user && typeof json.user === 'object' && json.user.authToken) {
          return json.user;
        }
      }
    } catch (err) {
      onProgress?.(`轮询登录状态出错: ${err instanceof Error ? err.message : String(err)}`);
    }
    onProgress?.('等待浏览器授权完成...');
    await sleep(LOGIN_INTERVAL_MS);
  }
  throw new Error('Login timed out. Please try again.');
}

// ── Public service ───────────────────────────────────────────────────────────

export class FreebuffAuthService {
  private cachedAuth: StoredUser | null = null;

  constructor() {
    this.cachedAuth = loadAuth();
  }

  getAuthStatus(): FreebuffAuthStatus {
    const auth = this.cachedAuth ?? loadAuth();
    if (!auth) return { loggedIn: false, email: '', expired: false };
    // Freebuff CLI tokens are long-lived; we treat them as non-expiring unless
    // the server rejects them (handled at request time via test-connection).
    // Update cachedAuth if it was null but loadAuth() found a valid file
    // (e.g. when the singleton was created before app.getPath was available).
    if (!this.cachedAuth && auth) this.cachedAuth = auth;
    return { loggedIn: true, email: auth.email || auth.name || '', expired: false };
  }

  /**
   * Returns the authToken to use as Bearer apiKey.
   * Freebuff CLI tokens are long-lived (no refresh endpoint in the CLI code),
   * so we return the persisted token directly.
   * Falls back to loadAuth() if the in-memory cache is null (matches DevEco
   * pattern — handles cases where the singleton was constructed before
   * app.getPath('userData') was available).
   */
  async getAccessToken(): Promise<string | null> {
    const auth = this.cachedAuth ?? loadAuth();
    if (!auth) return null;
    // Update cachedAuth if it was null but loadAuth() found a valid file.
    if (!this.cachedAuth) this.cachedAuth = auth;
    return auth.authToken;
  }

  async login(onProgress?: FreebuffLoginProgressFn): Promise<FreebuffLoginResult> {
    try {
      const fingerprintId = generateFreebuffFingerprint(this.cachedAuth?.fingerprintId);
      onProgress?.('正在获取登录链接...');
      const code = await requestLoginCode(fingerprintId);

      const displayUrl = code.loginUrl;
      onProgress?.(`请在浏览器中打开链接完成登录: ${displayUrl}`);

      // Open the browser
      shell.openExternal(displayUrl);

      onProgress?.('等待浏览器授权完成...');
      const user = await pollLoginStatus(
        {
          fingerprintId,
          fingerprintHash: code.fingerprintHash,
          expiresAt: code.expiresAt,
          timeoutMs: LOGIN_TIMEOUT_MS,
        },
        onProgress,
      );

      // The CLI User schema: { id?, name, email, authToken, fingerprintId?... }
      const authToken = String(user.authToken || '');
      if (!authToken) {
        throw new Error('Login response did not include an auth token');
      }
      const stored: StoredUser = {
        type: 'freebuff',
        id: user.id ? String(user.id) : undefined,
        name: String(user.name || ''),
        email: String(user.email || ''),
        authToken,
        fingerprintId: user.fingerprintId ? String(user.fingerprintId) : fingerprintId,
        fingerprintHash: user.fingerprintHash ? String(user.fingerprintHash) : code.fingerprintHash,
        savedAt: Date.now(),
      };
      this.cachedAuth = stored;
      saveAuth(stored);

      return { success: true, email: stored.email };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error('[FreebuffAuth] Login failed:', errorMsg);
      return { success: false, error: errorMsg };
    }
  }

  logout(): void {
    this.cachedAuth = null;
    clearAuth();
  }

  // ── Free-mode session management ──────────────────────────────────────────
  //
  // Freebuff free models require an active "session" obtained via
  // POST /api/v1/freebuff/session. The session grants a time-limited slot
  // (typically 1 hour) for the chosen model. While the session is active,
  // chat-completions requests must include the x-freebuff-instance-id header.
  //
  // Reference: freebuff-main cli/src/utils/freebuff-session-api.ts,
  //            cli/src/hooks/use-freebuff-session.ts

  private sessionState: FreebuffSessionState | null = null;
  private sessionHeartbeatTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * Start a free-mode session for the given model.
   * POST /api/v1/freebuff/session with the model header.
   */
  async startSession(model?: string): Promise<FreebuffSessionResult> {
    const token = await this.getAccessToken();
    if (!token) {
      return { active: false, error: 'Not logged in' };
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    };
    if (model) {
      headers['x-freebuff-model'] = model;
    }

    try {
      // Session management endpoint is on the Codebuff API backend (codebuff.com),
      // NOT on freebuff.com (which only serves the marketing site and login flow).
      const { statusCode, data } = await httpRequest(
        `${CODEBUFF_API_BASE_URL}/api/v1/freebuff/session`,
        { method: 'POST', headers, timeout: 20_000 },
      );

      if (statusCode === 404) {
        // No session exists — user needs to join the queue
        this.sessionState = null;
        return { active: false, status: 'none' };
      }

      if (statusCode === 403) {
        try {
          const body = JSON.parse(data);
          if (body.status === 'country_blocked' || body.status === 'banned') {
            this.sessionState = null;
            return { active: false, status: body.status, error: body.status };
          }
        } catch { /* ignore */ }
        this.sessionState = null;
        return { active: false, status: 'forbidden', error: `Forbidden (403)` };
      }

      if (statusCode === 429) {
        try {
          const body = JSON.parse(data);
          if (body.status === 'rate_limited' || body.status === 'spend_limited' || body.status === 'ip_capped') {
            this.sessionState = null;
            return { active: false, status: body.status, error: body.status };
          }
        } catch { /* ignore */ }
        this.sessionState = null;
        return { active: false, status: 'rate_limited', error: 'Rate limited' };
      }

      if (statusCode === 409) {
        try {
          const body = JSON.parse(data);
          if (body.status === 'model_locked' || body.status === 'model_unavailable') {
            this.sessionState = null;
            return { active: false, status: body.status, error: body.status };
          }
        } catch { /* ignore */ }
        this.sessionState = null;
        return { active: false, status: 'conflict', error: `Conflict (409)` };
      }

      // 503 = service unavailable or admission shedding (retryable).
      // Reference: freebuff-main cli/src/utils/freebuff-session-api.ts
      //   classifyFreebuffSessionRequestFailure() treats 503 as 'retry'.
      if (statusCode === 503) {
        this.sessionState = null;
        return { active: false, status: 'service_unavailable', error: 'Service temporarily unavailable (503). Please try again in a moment.' };
      }

      if (statusCode >= 200 && statusCode < 300) {
        const body = JSON.parse(data);
        if (body.status === 'active') {
          this.sessionState = {
            status: 'active',
            instanceId: body.instanceId,
            model: body.model,
            expiresAt: body.expiresAt,
            admittedAt: body.admittedAt,
          };
          this.startHeartbeat();
          return {
            active: true,
            status: 'active',
            instanceId: body.instanceId,
            model: body.model,
            expiresAt: body.expiresAt,
          };
        }
        // Other statuses (none, ended, etc.)
        this.sessionState = body.status ? { status: body.status } : null;
        this.stopHeartbeat();
        return { active: false, status: body.status || 'unknown' };
      }

      this.sessionState = null;
      this.stopHeartbeat();
      return { active: false, error: `HTTP ${statusCode}` };
    } catch (err) {
      return { active: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Ensure we have a live session, automatically re-admitting if the current
   * one has expired or is missing. Call this before every agent run.
   *
   * The official Freebuff CLI does the same in its poll loop: when a session
   * transitions to `none`/`ended`, it re-POSTs to claim a fresh seat.
   */
  async ensureActiveSession(model?: string): Promise<FreebuffSessionResult> {
    // Fast path: session looks valid and hasn't expired (with 30s safety margin).
    if (
      this.sessionState?.status === 'active' &&
      this.sessionState.instanceId
    ) {
      if (this.sessionState.expiresAt) {
        const expiresMs = new Date(this.sessionState.expiresAt).getTime();
        if (expiresMs > Date.now() + 30_000) {
          return {
            active: true,
            status: 'active',
            instanceId: this.sessionState.instanceId,
            model: this.sessionState.model,
            expiresAt: this.sessionState.expiresAt,
          };
        }
      } else {
        // No expiresAt — assume valid (shouldn't happen, but don't break).
        return {
          active: true,
          status: 'active',
          instanceId: this.sessionState.instanceId,
          model: this.sessionState.model,
        };
      }
    }

    // Session is missing or expired — end the stale one and start fresh.
    await this.endSession();
    return this.startSession(model);
  }

  /**
   * Called by the LLM router when a chat-completions request returns 428
   * (waiting_room_required). Ends the dead session and starts a fresh one.
   * Returns the new instanceId, or undefined if re-admission fails.
   */
  async handleSessionExpired(model?: string): Promise<string | undefined> {
    console.log('[FreebuffAuth] Session expired (428), re-admitting...');
    await this.endSession();
    const result = await this.startSession(model);
    return result.active ? result.instanceId : undefined;
  }

  /**
   * Get the current session status.
   * GET /api/v1/freebuff/session with the instance header.
   */
  async getSessionStatus(): Promise<FreebuffSessionResult> {
    const token = await this.getAccessToken();
    if (!token) {
      return { active: false, error: 'Not logged in' };
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
    };
    if (this.sessionState?.instanceId) {
      headers['x-freebuff-instance-id'] = this.sessionState.instanceId;
    }

    try {
      const { statusCode, data } = await httpRequest(
        `${CODEBUFF_API_BASE_URL}/api/v1/freebuff/session`,
        { method: 'GET', headers, timeout: 20_000 },
      );

      if (statusCode === 404) {
        this.sessionState = null;
        return { active: false, status: 'none' };
      }

      if (statusCode >= 200 && statusCode < 300) {
        const body = JSON.parse(data);
        if (body.status === 'active') {
          this.sessionState = {
            status: 'active',
            instanceId: body.instanceId,
            model: body.model,
            expiresAt: body.expiresAt,
            admittedAt: body.admittedAt,
          };
          return {
            active: true,
            status: 'active',
            instanceId: body.instanceId,
            model: body.model,
            expiresAt: body.expiresAt,
          };
        }
        // Session is no longer active — stop heartbeat and clear state.
        this.sessionState = body.status ? { status: body.status } : null;
        this.stopHeartbeat();
        return { active: false, status: body.status || 'unknown' };
      }

      return { active: false, error: `HTTP ${statusCode}` };
    } catch (err) {
      return { active: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * End the current free-mode session.
   * DELETE /api/v1/freebuff/session.
   */
  async endSession(): Promise<void> {
    this.stopHeartbeat();
    const token = await this.getAccessToken();
    if (!token || !this.sessionState?.instanceId) {
      this.sessionState = null;
      return;
    }

    try {
      await httpRequest(
        `${CODEBUFF_API_BASE_URL}/api/v1/freebuff/session`,
        {
          method: 'DELETE',
          headers: {
            Authorization: `Bearer ${token}`,
            'x-freebuff-instance-id': this.sessionState.instanceId,
          },
          timeout: 10_000,
        },
      );
    } catch {
      // Best-effort DELETE — ignore errors
    }
    this.sessionState = null;
  }

  // ── Heartbeat polling ────────────────────────────────────────────────────
  //
  // The official Freebuff CLI polls GET /session every 30s to keep the
  // session row alive. Without this, the server expires the session after
  // 1 hour and subsequent chat-completions requests return 428
  // waiting_room_required.
  //
  // Reference: freebuff-main cli/src/hooks/use-freebuff-session.ts
  //   POLL_INTERVAL_ACTIVE_MS = 30_000

  private startHeartbeat(): void {
    this.stopHeartbeat();
    // Only heartbeat for sessions with an expiresAt (normal sessions).
    // Sessions without expiry are edge cases — don't poll unnecessarily.
    if (!this.sessionState?.expiresAt) return;

    this.sessionHeartbeatTimer = setInterval(async () => {
      if (!this.sessionState?.instanceId) {
        this.stopHeartbeat();
        return;
      }
      try {
        const result = await this.getSessionStatus();
        if (!result.active) {
          console.log('[FreebuffAuth] Heartbeat detected session ended:', result.status);
          this.sessionState = null;
          this.stopHeartbeat();
        }
      } catch (err) {
        // Network error during heartbeat — don't kill the session, just log.
        // The next heartbeat tick or the next chat request will catch the real failure.
        console.warn('[FreebuffAuth] Heartbeat poll failed:', err);
      }
    }, 30_000);
  }

  private stopHeartbeat(): void {
    if (this.sessionHeartbeatTimer) {
      clearInterval(this.sessionHeartbeatTimer);
      this.sessionHeartbeatTimer = null;
    }
  }

  /**
   * Get the current instance ID for outgoing chat-completions requests.
   * Returns undefined when no active session is held.
   */
  getInstanceId(): string | undefined {
    if (!this.sessionState || this.sessionState.status !== 'active') return undefined;
    return this.sessionState.instanceId;
  }
}

// ── Session types ────────────────────────────────────────────────────────────

interface FreebuffSessionState {
  status: string;
  instanceId?: string;
  model?: string;
  expiresAt?: string;
  admittedAt?: string;
}

export interface FreebuffSessionResult {
  active: boolean;
  status?: string;
  instanceId?: string;
  model?: string;
  expiresAt?: string;
  error?: string;
}

// Singleton instance
export const freebuffAuthService = new FreebuffAuthService();