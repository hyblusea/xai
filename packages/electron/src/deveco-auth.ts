/**
 * DevEco (Huawei) OAuth Authentication Service.
 *
 * Implements the full OAuth login flow:
 *   1. Start a local HTTP server on port 10101
 *   2. Open browser to Huawei OAuth login page
 *   3. Receive callback with tempToken
 *   4. Exchange tempToken → jwtToken → accessToken + refreshToken
 *   5. Persist tokens to disk, auto-refresh when expired (30 min TTL)
 *
 * Reference: openharmony-sig/deveco-code deveco plugin
 */
import { app, shell } from 'electron';
import http, { type IncomingMessage, type ServerResponse } from 'http';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { URL } from 'url';

// ── Constants ────────────────────────────────────────────────────────────────

const BASE_URL = 'https://cn.devecostudio.huawei.com';
const AUTH_URL = 'console/DevEcoIDE/apply';
const TEMP_TOKEN_CHECK_URL = 'authrouter/auth/api/temptoken/check';
const JWT_TOKEN_CHECK_URL = 'authrouter/auth/api/jwToken/check';
const SUCCESS_REDIRECT_URL = 'console/DevEcoCode/loginSuccess';
const FAILED_REDIRECT_URL = 'console/DevEcoCode/loginFailed';
const APP_ID = '1008';
const DEFAULT_PORT = 10101;
const FALLBACK_PORTS = [DEFAULT_PORT, 34567, 34568, 34569, 34570];
const LOGIN_TIMEOUT_MS = 600_000; // 10 minutes
export const ACCESS_TOKEN_EXPIRES_MS = 30 * 60 * 1000; // 30 minutes

// ── Types ────────────────────────────────────────────────────────────────────

interface StoredAuth {
  type: 'oauth';
  access: string;
  refresh: string;
  jwtToken: string;
  userId: string;
  userName: string;
  expires: number;
}

export interface AuthStatus {
  loggedIn: boolean;
  userName: string;
  expired: boolean;
}

export interface LoginResult {
  success: boolean;
  userName?: string;
  error?: string;
}

export type LoginProgressFn = (message: string) => void;

interface JwtPayload {
  userId: string;
  userName: string;
  exp?: number;
  iat?: number;
}

interface TokenCheckResponse {
  status: boolean;
  userInfo?: {
    accessToken: string;
    refreshToken?: string;
    nationalCode: string;
    realName: string;
  };
}

// ── Token persistence ────────────────────────────────────────────────────────

function getAuthFilePath(): string {
  return path.join(app.getPath('userData'), 'deveco-auth.json');
}

function loadAuth(): StoredAuth | null {
  try {
    const filePath = getAuthFilePath();
    if (!fs.existsSync(filePath)) return null;
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as StoredAuth;
    if (data.type === 'oauth' && data.access) return data;
  } catch {
    // ignore
  }
  return null;
}

function saveAuth(auth: StoredAuth): void {
  try {
    const filePath = getAuthFilePath();
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(auth, null, 2), { mode: 0o600 });
  } catch (err) {
    console.error('[DevEcoAuth] Failed to save auth:', err);
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

// ── HTTP helpers ─────────────────────────────────────────────────────────────

/**
 * HTTP GET using global fetch().
 *
 * MUST use fetch() instead of Node's native https.request — fetch() goes
 * through undici's global dispatcher, which is configured by proxy-manager.ts
 * to honour the user's proxy settings.  Native https.request bypasses the
 * proxy entirely, causing token-exchange requests to hang (~20s timeout each,
 * ~40s total) whenever the user is behind a proxy that can't reach
 * cn.devecostudio.huawei.com directly.
 */
async function httpGet(url: string, headers?: Record<string, string>, timeout = 20000): Promise<{ statusCode: number; data: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'accept-language': 'zh-CN',
        ...headers,
      },
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

function parseJwt(token: string): JwtPayload {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Invalid JWT format');
  const base64Url = parts[1].replace(/-/g, '+').replace(/_/g, '/');
  const base64 = base64Url.padEnd(base64Url.length + ((4 - (base64Url.length % 4)) % 4), '=');
  const json = Buffer.from(base64, 'base64').toString('utf8');
  const parsed = JSON.parse(json);
  return {
    userId: parsed.userId ?? '',
    userName: parsed.userName ?? '',
    exp: parsed.exp,
    iat: parsed.iat,
  };
}

// ── Local auth server ────────────────────────────────────────────────────────

interface CallbackData {
  tempToken: string;
  siteId: string;
}

class LocalAuthServer {
  private server: http.Server | null = null;
  private port = DEFAULT_PORT;
  private clientSecret: string;
  private resolveCallback: ((value: CallbackData) => void) | null = null;
  private rejectCallback: ((reason: Error) => void) | null = null;
  private timeoutId: ReturnType<typeof setTimeout> | null = null;

  constructor(clientSecret: string) {
    this.clientSecret = clientSecret;
  }

  async start(): Promise<number> {
    for (const port of FALLBACK_PORTS) {
      try {
        const actualPort = await this.tryPort(port);
        this.port = actualPort;
        return actualPort;
      } catch {
        if (port === FALLBACK_PORTS[FALLBACK_PORTS.length - 1]) {
          throw new Error('All auth server ports are in use');
        }
      }
    }
    throw new Error('Failed to start auth server');
  }

  private tryPort(port: number): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => this.handleRequest(req, res));
      server.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') reject(new Error('Port in use'));
        else reject(err);
      });
      server.listen(port, '127.0.0.1', () => {
        this.server = server;
        resolve(port);
      });
    });
  }

  waitForCallback(timeout: number): Promise<CallbackData> {
    return new Promise((resolve, reject) => {
      this.resolveCallback = resolve;
      this.rejectCallback = reject;
      this.timeoutId = setTimeout(() => {
        this.rejectCallback?.(new Error('Login callback timeout'));
        this.rejectCallback = null;
        this.resolveCallback = null;
      }, timeout);
    });
  }

  cancel(): void {
    this.rejectCallback?.(new Error('Login cancelled'));
    this.cleanup();
  }

  async stop(): Promise<void> {
    this.cleanup();
    return new Promise((resolve) => {
      if (!this.server) { resolve(); return; }
      // closeAllConnections() immediately destroys lingering keep-alive
      // sockets. Without it, server.close() waits up to keepAliveTimeout
      // (default 5s) for the browser's callback connection to drain,
      // delaying the login result returned to the renderer.
      this.server.closeAllConnections?.();
      this.server.close(() => resolve());
    });
  }

  private cleanup(): void {
    if (this.timeoutId) { clearTimeout(this.timeoutId); this.timeoutId = null; }
    this.resolveCallback = null;
    this.rejectCallback = null;
  }

  getPort(): number { return this.port; }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? '', `http://127.0.0.1:${this.port}`);
    if (url.pathname !== '/callback') {
      res.writeHead(404); res.end('Not Found'); return;
    }

    let body = '';
    const processParams = (params: URLSearchParams) => {
      const code = params.get('code');
      const tempToken = params.get('tempToken');
      const siteId = params.get('siteId');
      const quit = params.get('quit');

      if (!code || code !== this.clientSecret) return; // ignore non-matching requests

      if (quit === 'true' || quit === 'access_denied') {
        this.rejectCallback?.(new Error('Login cancelled by user'));
        res.writeHead(302, { Location: `${BASE_URL}/${FAILED_REDIRECT_URL}` });
        res.end();
        return;
      }

      if (!tempToken || !siteId) {
        this.rejectCallback?.(new Error('Missing tempToken or siteId'));
        res.writeHead(302, { Location: `${BASE_URL}/${FAILED_REDIRECT_URL}` });
        res.end();
        return;
      }

      if (siteId !== '1') {
        this.rejectCallback?.(new Error('Unsupported region (only China site supported)'));
        res.writeHead(302, { Location: `${BASE_URL}/${FAILED_REDIRECT_URL}` });
        res.end();
        return;
      }

      this.resolveCallback?.({ tempToken, siteId });
      res.writeHead(302, { Location: `${BASE_URL}/${SUCCESS_REDIRECT_URL}` });
      res.end();
    };

    if (req.method === 'POST') {
      req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      req.on('end', () => processParams(new URLSearchParams(body)));
    } else {
      processParams(url.searchParams);
    }
  }
}

// ── Token exchange ───────────────────────────────────────────────────────────

async function exchangeTempTokenForJwt(tempToken: string): Promise<string> {
  const actualToken = tempToken.split('&')[0];
  const params = new URLSearchParams({ tempToken: actualToken, site: 'CN', version: '1.0.0', appid: APP_ID });
  const url = `${BASE_URL}/${TEMP_TOKEN_CHECK_URL}?${params.toString()}`;
  const response = await httpGet(url);
  if (response.statusCode !== 200) {
    throw new Error(`Failed to get jwtToken: HTTP ${response.statusCode}`);
  }
  const jwtToken = response.data.trim();
  if (jwtToken.split('.').length !== 3) {
    throw new Error('Invalid jwtToken format');
  }
  return jwtToken;
}

async function checkJwtToken(jwtToken: string, refresh: boolean): Promise<TokenCheckResponse> {
  const url = `${BASE_URL}/${JWT_TOKEN_CHECK_URL}`;
  const response = await httpGet(url, { jwtToken, refresh: String(refresh) });
  if (response.statusCode !== 200) {
    throw new Error(`Token check failed: HTTP ${response.statusCode}`);
  }
  return JSON.parse(response.data) as TokenCheckResponse;
}

// ── DevecoAuthService ────────────────────────────────────────────────────────

export class DevecoAuthService {
  private authServer: LocalAuthServer | null = null;
  private cachedAuth: StoredAuth | null = null;

  constructor() {
    this.cachedAuth = loadAuth();
  }

  /**
   * Perform the full OAuth login flow.
   * Opens the browser, waits for callback, exchanges tokens, persists result.
   * onProgress receives human-readable status messages for each phase, so the
   * caller can surface them in the UI while the (potentially slow) token
   * exchange with Huawei's servers runs.
   */
  async login(onProgress?: LoginProgressFn): Promise<LoginResult> {
    const progress = onProgress ?? (() => {});
    const t0 = Date.now();
    const clientSecret = crypto.randomUUID().replace(/-/g, '');
    this.authServer = new LocalAuthServer(clientSecret);

    try {
      const port = await this.authServer.start();
      const callbackPromise = this.authServer.waitForCallback(LOGIN_TIMEOUT_MS);

      const loginUrl = `${BASE_URL}/${AUTH_URL}?port=${port}&appid=${APP_ID}&code=${clientSecret}`;
      await shell.openExternal(loginUrl);
      progress('等待浏览器登录完成...');

      const callbackData = await callbackPromise;
      progress('正在换取令牌...');
      console.log('[DevEcoAuth] callback received after', Date.now() - t0, 'ms');

      const tJwt = Date.now();
      const jwtToken = await exchangeTempTokenForJwt(callbackData.tempToken);
      console.log('[DevEcoAuth] tempToken→jwtToken took', Date.now() - tJwt, 'ms');

      const tCheck = Date.now();
      const tokenInfo = await checkJwtToken(jwtToken, false);
      console.log('[DevEcoAuth] jwtToken check took', Date.now() - tCheck, 'ms');

      if (!tokenInfo.status || !tokenInfo.userInfo) {
        throw new Error('Invalid token check response');
      }

      const jwtPayload = parseJwt(jwtToken);
      const storedAuth: StoredAuth = {
        type: 'oauth',
        access: tokenInfo.userInfo.accessToken,
        refresh: tokenInfo.userInfo.refreshToken ?? '',
        jwtToken,
        userId: jwtPayload.userId,
        userName: jwtPayload.userName,
        expires: Date.now() + ACCESS_TOKEN_EXPIRES_MS,
      };

      saveAuth(storedAuth);
      this.cachedAuth = storedAuth;

      console.log('[DevEcoAuth] login completed in', Date.now() - t0, 'ms total');
      return { success: true, userName: jwtPayload.userName };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[DevEcoAuth] Login failed after', Date.now() - t0, 'ms:', message);
      return { success: false, error: message };
    } finally {
      if (this.authServer) {
        await this.authServer.stop();
        this.authServer = null;
      }
    }
  }

  /** Cancel an in-progress login. */
  cancelLogin(): void {
    this.authServer?.cancel();
  }

  /** Clear stored tokens and log out. */
  logout(): void {
    clearAuth();
    this.cachedAuth = null;
  }

  /**
   * Get a valid accessToken, refreshing automatically if expired.
   * Returns empty string if not logged in or refresh fails.
   */
  async getAccessToken(): Promise<string> {
    const auth = this.cachedAuth ?? loadAuth();
    if (!auth) return '';

    // If not expired, return cached token
    if (auth.expires > Date.now()) {
      return auth.access;
    }

    // Try to refresh using jwtToken
    if (!auth.jwtToken) {
      console.warn('[DevEcoAuth] Token expired and no jwtToken for refresh');
      return '';
    }

    try {
      const tokenInfo = await checkJwtToken(auth.jwtToken, true);
      if (!tokenInfo.status || !tokenInfo.userInfo) {
        console.error('[DevEcoAuth] Token refresh failed: invalid response');
        return '';
      }

      // Update stored auth with new tokens
      auth.access = tokenInfo.userInfo.accessToken;
      auth.refresh = tokenInfo.userInfo.refreshToken ?? auth.refresh;
      auth.expires = Date.now() + ACCESS_TOKEN_EXPIRES_MS;
      saveAuth(auth);
      this.cachedAuth = auth;

      console.log('[DevEcoAuth] Token refreshed successfully');
      return auth.access;
    } catch (err) {
      console.error('[DevEcoAuth] Token refresh error:', err);
      return '';
    }
  }

  /** Get current authentication status. */
  getAuthStatus(): AuthStatus {
    const auth = this.cachedAuth ?? loadAuth();
    if (!auth) {
      return { loggedIn: false, userName: '', expired: false };
    }
    return {
      loggedIn: true,
      userName: auth.userName || auth.userId || 'Unknown',
      expired: auth.expires <= Date.now(),
    };
  }
}

// Singleton instance
export const devecoAuthService = new DevecoAuthService();
