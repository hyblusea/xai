/**
 * Cline OAuth Authentication Service (WorkOS Device Auth Flow).
 *
 * Implements the WorkOS Device Authorization Grant:
 *   1. Request device_code + user_code from WorkOS
 *   2. Display user_code + verification URL to the user
 *   3. Poll WorkOS for token after user authenticates in browser
 *   4. Exchange WorkOS tokens for Cline API tokens via /api/v1/auth/register
 *   5. Persist tokens to disk, auto-refresh when expired
 *
 * Reference: Cline source sdk/packages/core/src/auth/cline.ts
 */
import { app, shell } from 'electron';
import fs from 'fs';
import path from 'path';

// ── Constants ────────────────────────────────────────────────────────────────

const WORKOS_CLIENT_ID = 'client_01K3A541FN8TA3EPPHTD2325AR';
const WORKOS_API_BASE_URL = 'https://api.workos.com';
const CLINE_API_BASE_URL = 'https://api.cline.bot';
const DEVICE_AUTH_ENDPOINT = '/user_management/authorize/device';
const TOKEN_AUTHENTICATE_ENDPOINT = '/user_management/authenticate';
const CLINE_REGISTER_ENDPOINT = '/api/v1/auth/register';
const CLINE_REFRESH_ENDPOINT = '/api/v1/auth/refresh';
const CLINE_RECOMMENDED_MODELS_ENDPOINT = '/api/v1/ai/cline/recommended-models';

const WORKOS_TOKEN_PREFIX = 'workos:';

const DEVICE_AUTH_EXPIRES_SECONDS = 300; // 5 minutes
const DEVICE_AUTH_INTERVAL_SECONDS = 5;
const ACCESS_TOKEN_EXPIRES_MS = 60 * 60 * 1000; // 1 hour (conservative)
const LOGIN_TIMEOUT_MS = 300_000; // 5 minutes
const HTTP_TIMEOUT_MS = 30_000;
const REFRESH_BUFFER_MS = 5 * 60 * 1000; // 5 minutes — refresh early

// ── Types ────────────────────────────────────────────────────────────────────

interface StoredAuth {
  type: 'cline-workos';
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  accountId?: string;
  email?: string;
}

export interface ClineAuthStatus {
  loggedIn: boolean;
  email: string;
  expired: boolean;
}

export interface ClineLoginResult {
  success: boolean;
  email?: string;
  error?: string;
}

export interface ClineRecommendedModel {
  id: string;
  name: string;
  description: string;
  tags: string[];
}

export interface ClineRecommendedModelsData {
  recommended: ClineRecommendedModel[];
  free: ClineRecommendedModel[];
  clinePass: ClineRecommendedModel[];
}

export type LoginProgressFn = (message: string) => void;

// ── Token persistence ────────────────────────────────────────────────────────

function getAuthFilePath(): string {
  return path.join(app.getPath('userData'), 'cline-auth.json');
}

function loadAuth(): StoredAuth | null {
  try {
    const filePath = getAuthFilePath();
    if (!fs.existsSync(filePath)) return null;
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as StoredAuth;
    if (data.type === 'cline-workos' && data.accessToken) return data;
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
    console.error('[ClineAuth] Failed to save auth:', err);
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

async function httpPost(url: string, body: URLSearchParams | string, headers?: Record<string, string>, timeout = HTTP_TIMEOUT_MS): Promise<{ statusCode: number; data: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const isForm = body instanceof URLSearchParams;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': isForm ? 'application/x-www-form-urlencoded' : 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        ...headers,
      },
      body: isForm ? body : body,
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

async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Ensure the access token has the `workos:` prefix required by the Cline API.
 * Matches Cline SDK's `formatClineApiKey()` in provider-auth-registry.ts.
 */
function formatClineApiKey(accessToken: string): string {
  const token = accessToken.trim();
  return token.toLowerCase().startsWith(WORKOS_TOKEN_PREFIX)
    ? token
    : `${WORKOS_TOKEN_PREFIX}${token}`;
}

// ── WorkOS Device Auth ──────────────────────────────────────────────────────

interface WorkOSDeviceAuthResponse {
  device_code?: string;
  user_code?: string;
  verification_uri?: string;
  verification_uri_complete?: string;
  expires_in?: number;
  interval?: number;
  error?: string;
  error_description?: string;
}

interface WorkOSTokenResponse {
  access_token?: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

interface ClineRegisterResponse {
  success: boolean;
  data?: {
    accessToken: string;
    refreshToken?: string;
    tokenType: string;
    expiresAt: string;
    userInfo?: {
      email?: string;
      clineUserId?: string;
    };
  };
}

async function requestDeviceAuthorization(): Promise<{
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresInSeconds: number;
  pollIntervalSeconds: number;
}> {
  const { statusCode, data } = await httpPost(
    `${WORKOS_API_BASE_URL}${DEVICE_AUTH_ENDPOINT}`,
    new URLSearchParams({ client_id: WORKOS_CLIENT_ID }),
  );

  const json = JSON.parse(data) as WorkOSDeviceAuthResponse;
  if (statusCode < 200 || statusCode >= 300) {
    throw new Error(`Device authorization failed: HTTP ${statusCode} - ${json.error_description || json.error || data}`);
  }
  if (!json.device_code || !json.user_code || !json.verification_uri) {
    throw new Error('Invalid WorkOS device authorization response');
  }

  return {
    deviceCode: json.device_code,
    userCode: json.user_code,
    verificationUri: json.verification_uri,
    verificationUriComplete: json.verification_uri_complete,
    expiresInSeconds: json.expires_in || DEVICE_AUTH_EXPIRES_SECONDS,
    pollIntervalSeconds: json.interval || DEVICE_AUTH_INTERVAL_SECONDS,
  };
}

async function pollForTokens(
  deviceCode: string,
  expiresInSeconds: number,
  initialIntervalSeconds: number,
): Promise<{ accessToken: string; refreshToken: string; tokenType: string }> {
  const deadline = Date.now() + expiresInSeconds * 1000;
  let intervalSeconds = Math.max(1, initialIntervalSeconds);

  while (Date.now() <= deadline) {
    const { statusCode, data } = await httpPost(
      `${WORKOS_API_BASE_URL}${TOKEN_AUTHENTICATE_ENDPOINT}`,
      new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: deviceCode,
        client_id: WORKOS_CLIENT_ID,
      }),
    );

    const json = JSON.parse(data) as WorkOSTokenResponse;
    if (statusCode >= 200 && statusCode < 300) {
      if (!json.access_token || !json.refresh_token) {
        throw new Error('Invalid WorkOS token response');
      }
      return {
        accessToken: json.access_token,
        refreshToken: json.refresh_token,
        tokenType: json.token_type ?? 'Bearer',
      };
    }

    switch (json.error) {
      case 'authorization_pending':
        await sleep(intervalSeconds * 1000);
        break;
      case 'slow_down':
        intervalSeconds += 1;
        await sleep(intervalSeconds * 1000);
        break;
      case 'access_denied':
      case 'expired_token':
      case 'invalid_grant':
        throw new Error(json.error_description || `WorkOS auth failed: ${json.error}`);
      default:
        throw new Error(`WorkOS token polling failed: HTTP ${statusCode} - ${json.error_description || data}`);
    }
  }

  throw new Error('WorkOS device authorization timed out');
}

async function registerWithCline(
  workosAccessToken: string,
  workosRefreshToken: string,
): Promise<StoredAuth> {
  const { statusCode, data } = await httpPost(
    `${CLINE_API_BASE_URL}${CLINE_REGISTER_ENDPOINT}`,
    JSON.stringify({
      accessToken: workosAccessToken,
      refreshToken: workosRefreshToken,
    }),
    { 'Content-Type': 'application/json' },
  );

  const json = JSON.parse(data) as ClineRegisterResponse;
  if (statusCode < 200 || statusCode >= 300 || !json.success || !json.data?.accessToken) {
    throw new Error(`Cline token registration failed: HTTP ${statusCode} - ${data.substring(0, 300)}`);
  }

  return {
    type: 'cline-workos',
    accessToken: json.data.accessToken,
    refreshToken: json.data.refreshToken || workosRefreshToken,
    expiresAt: Date.parse(json.data.expiresAt) || (Date.now() + ACCESS_TOKEN_EXPIRES_MS),
    accountId: json.data.userInfo?.clineUserId,
    email: json.data.userInfo?.email,
  };
}

async function refreshClineToken(refreshToken: string): Promise<StoredAuth | null> {
  try {
    const { statusCode, data } = await httpPost(
      `${CLINE_API_BASE_URL}${CLINE_REFRESH_ENDPOINT}`,
      JSON.stringify({ refreshToken, grantType: 'refresh_token' }),
      { 'Content-Type': 'application/json' },
    );

    const json = JSON.parse(data) as ClineRegisterResponse;
    if (statusCode >= 200 && statusCode < 300 && json.success && json.data?.accessToken) {
      return {
        type: 'cline-workos',
        accessToken: json.data.accessToken,
        refreshToken: json.data.refreshToken || refreshToken,
        expiresAt: Date.parse(json.data.expiresAt) || (Date.now() + ACCESS_TOKEN_EXPIRES_MS),
        accountId: json.data.userInfo?.clineUserId,
        email: json.data.userInfo?.email,
      };
    }
  } catch (err) {
    console.error('[ClineAuth] Token refresh failed:', err);
  }
  return null;
}

// ── Public service ───────────────────────────────────────────────────────────

class ClineAuthService {
  private cachedAuth: StoredAuth | null = null;
  /** Cached OpenRouter model list to avoid re-fetching on every model change. */
  private openRouterModelsCache: Array<{
    id: string;
    context_length?: number;
    reasoning?: { mandatory?: boolean; default_enabled?: boolean; supported_efforts?: string[]; default_effort?: string };
    top_provider?: { context_length?: number; max_completion_tokens?: number };
  }> | null = null;
  private openRouterModelsCacheExpiry = 0;
  private static readonly OR_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

  constructor() {
    // Load persisted auth on startup
    this.cachedAuth = loadAuth();
  }

  getAuthStatus(): ClineAuthStatus {
    const auth = this.cachedAuth;
    if (!auth) return { loggedIn: false, email: '', expired: false };
    const expired = Date.now() > auth.expiresAt;
    return { loggedIn: true, email: auth.email || '', expired };
  }

  /**
   * Returns the current access token WITH the `workos:` prefix.
   *
   * The Cline API backend requires the `workos:` prefix on the Bearer token
   * to route verification to the WorkOS identity provider. Without it the
   * server returns HTTP 401 "Unauthorized".
   *
   * This matches the Cline VS Code extension's AuthService.getAuthToken()
   * which always returns `workos:${idToken}`.
   */
  async getAccessToken(): Promise<string | null> {
    const auth = this.cachedAuth;
    if (!auth) return null;

    // Not expired (with 5-minute buffer) — return directly with prefix
    if (Date.now() < auth.expiresAt - REFRESH_BUFFER_MS) {
      return formatClineApiKey(auth.accessToken);
    }

    // About to expire or expired — try refresh
    const refreshed = await refreshClineToken(auth.refreshToken);
    if (refreshed) {
      this.cachedAuth = refreshed;
      saveAuth(refreshed);
      return formatClineApiKey(refreshed.accessToken);
    }

    // Refresh failed but token hasn't hard-expired yet — keep using it
    // (matches Cline SDK's transient-failure-kept-current behavior)
    if (Date.now() < auth.expiresAt) {
      return formatClineApiKey(auth.accessToken);
    }

    // Refresh failed and token is stale
    return null;
  }

  async login(onProgress?: LoginProgressFn): Promise<ClineLoginResult> {
    try {
      onProgress?.('正在请求设备授权...');
      const deviceAuth = await requestDeviceAuthorization();

      const displayUrl = deviceAuth.verificationUriComplete || deviceAuth.verificationUri;
      onProgress?.(`请在浏览器中打开并输入验证码: ${deviceAuth.userCode}`);

      // Open browser
      shell.openExternal(displayUrl);

      onProgress?.('等待浏览器授权完成...');
      const workosTokens = await pollForTokens(
        deviceAuth.deviceCode,
        deviceAuth.expiresInSeconds,
        deviceAuth.pollIntervalSeconds,
      );

      onProgress?.('正在注册 Cline 令牌...');
      const auth = await registerWithCline(workosTokens.accessToken, workosTokens.refreshToken);

      this.cachedAuth = auth;
      saveAuth(auth);

      return { success: true, email: auth.email };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error('[ClineAuth] Login failed:', errorMsg);
      return { success: false, error: errorMsg };
    }
  }

  logout(): void {
    this.cachedAuth = null;
    clearAuth();
  }

  /** Fetch recommended models from Cline API (public endpoint, no auth required). */
  async fetchRecommendedModels(): Promise<ClineRecommendedModelsData | null> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      const response = await fetch(`${CLINE_API_BASE_URL}${CLINE_RECOMMENDED_MODELS_ENDPOINT}`, {
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (!response.ok) return null;
      const json = await response.json() as ClineRecommendedModelsData;
      if (json.recommended || json.free || json.clinePass) return json;
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Fetch OpenRouter model list with caching.
   * Returns cached data if still within TTL, otherwise fetches fresh data.
   */
  private async fetchOpenRouterModels(): Promise<Array<{
    id: string;
    context_length?: number;
    reasoning?: { mandatory?: boolean; default_enabled?: boolean; supported_efforts?: string[]; default_effort?: string };
    top_provider?: { context_length?: number; max_completion_tokens?: number };
  }> | null> {
    // Return cached data if still valid
    if (this.openRouterModelsCache && Date.now() < this.openRouterModelsCacheExpiry) {
      return this.openRouterModelsCache;
    }

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      const response = await fetch(`https://openrouter.ai/api/v1/models`, {
        signal: controller.signal,
        headers: { 'User-Agent': 'xai-ide/1.0.0' },
      });
      clearTimeout(timer);

      if (response.ok) {
        const json = await response.json() as { data?: Array<{
          id: string;
          context_length?: number;
          reasoning?: { mandatory?: boolean; default_enabled?: boolean; supported_efforts?: string[]; default_effort?: string };
          top_provider?: { context_length?: number; max_completion_tokens?: number };
        }> };
        const models = json.data ?? [];
        // Cache the result
        this.openRouterModelsCache = models;
        this.openRouterModelsCacheExpiry = Date.now() + ClineAuthService.OR_CACHE_TTL_MS;
        return models;
      }
    } catch {
      // Return stale cache if available, otherwise null
      return this.openRouterModelsCache;
    }
    return null;
  }

  /**
   * Check whether a given model supports reasoning/thinking via OpenRouter's model API.
   *
   * Resolution strategy (mirrors Cline's approach):
   *   1. Query OpenRouter `/api/v1/models` and match by model id or slug.
   *   2. If the model has `reasoning` metadata, return its supported efforts.
   *   3. Fall back to heuristic matching (model id pattern) when OpenRouter
   *      doesn't list the model (e.g. cline-free/ or cline-pass/ prefixed ids).
   *
   * Returns: { supportsReasoning, supportedEfforts, defaultEffort }
   */
  async checkModelReasoning(modelId: string): Promise<{
    supportsReasoning: boolean;
    supportedEfforts: string[];
    defaultEffort: string;
  }> {
    // ── Step 1: Try OpenRouter model lookup ──
    try {
      const orModelId = this.toOpenRouterModelId(modelId);
      const models = await this.fetchOpenRouterModels();
      if (models) {
        const match = models.find(m => m.id === orModelId);
        if (match?.reasoning) {
          const r = match.reasoning;
          if (r.mandatory || r.default_enabled || r.supported_efforts?.length) {
            return {
              supportsReasoning: true,
              supportedEfforts: r.supported_efforts?.length ? r.supported_efforts : ['low', 'medium', 'high'],
              defaultEffort: r.default_effort || 'medium',
            };
          }
        }
        // Model found but no reasoning support
        if (match) {
          return { supportsReasoning: false, supportedEfforts: [], defaultEffort: '' };
        }
      }
    } catch {
      // Fall through to heuristic
    }

    // ── Step 2: Heuristic matching (Cline's reasoning-support.ts approach) ──
    return this.heuristicReasoningCheck(modelId);
  }

  /**
   * Convert a Cline model id to its OpenRouter equivalent for lookup.
   * cline-free/glm-5.2 → zai/glm-5.2
   * cline-pass/deepseek-v4-pro → deepseek/deepseek-v4-pro
   * anthropic/claude-opus-5 → anthropic/claude-opus-5 (already OR format)
   */
  private toOpenRouterModelId(modelId: string): string {
    // Strip cline-free/ and cline-pass/ prefixes
    const stripped = modelId.replace(/^(cline-free|cline-pass)\//, '');
    // For cline-free/ ids, try common provider prefixes
    if (modelId.startsWith('cline-free/')) {
      // Known mappings from Cline recommended-models API → OpenRouter model ids
      const knownMappings: Record<string, string> = {
        'glm-5.2': 'z-ai/glm-5.2',          // OpenRouter id is z-ai/glm-5.2 (not zai/)
        'kat-coder-pro': 'kwaipilot/kat-coder-pro',
      };
      if (knownMappings[stripped]) return knownMappings[stripped];
      // Try with :free suffix stripped
      const withoutFree = stripped.replace(/:free$/, '');
      return withoutFree;
    }
    // For cline-pass/ ids, try common provider prefixes
    if (modelId.startsWith('cline-pass/')) {
      const knownMappings: Record<string, string> = {
        'glm-5.2': 'z-ai/glm-5.2',          // OpenRouter id is z-ai/glm-5.2 (not zai/)
        'kimi-k3': 'moonshotai/kimi-k3',
        'deepseek-v4-pro': 'deepseek/deepseek-v4-pro',
        'deepseek-v4-flash': 'deepseek/deepseek-v4-flash',
        'kimi-k2.7-code': 'moonshotai/kimi-k2.7-code',
        'kimi-k2.6': 'moonshotai/kimi-k2.6',
        'mimo-v2.5-pro': 'minimax/mimo-v2.5-pro',
        'mimo-v2.5': 'minimax/mimo-v2.5',
        'minimax-m3': 'minimax/minimax-m3',
        'qwen3.7-max': 'qwen/qwen3.7-max',
        'qwen3.7-plus': 'qwen/qwen3.7-plus',
      };
      if (knownMappings[stripped]) return knownMappings[stripped];
      return stripped;
    }
    // Already in OpenRouter format (e.g. deepseek/deepseek-v4-flash)
    // Fix: zai/ prefix should be z-ai/ on OpenRouter
    if (modelId.startsWith('zai/')) {
      return 'z-ai/' + modelId.slice(4);
    }
    return modelId;
  }

  /**
   * Check a model's context window and max output tokens via OpenRouter's model API.
   *
   * Resolution strategy (mirrors Cline's approach):
   *   1. Query OpenRouter `/api/v1/models` and match by model id or slug.
   *   2. Extract `context_length` and `top_provider.max_completion_tokens`.
   *   3. Fall back to heuristic matching when OpenRouter doesn't list the model.
   *
   * Returns: { contextWindow, maxInputTokens, maxOutputTokens }
   */
  async checkModelContextInfo(modelId: string): Promise<{
    contextWindow: number;
    maxInputTokens: number;
    maxOutputTokens: number;
  }> {
    // ── Step 1: Try OpenRouter model lookup ──
    try {
      const orModelId = this.toOpenRouterModelId(modelId);
      const models = await this.fetchOpenRouterModels();
      if (models) {
        const match = models.find(m => m.id === orModelId);
        if (match) {
          const contextWindow = match.top_provider?.context_length ?? match.context_length ?? 128_000;
          const maxOutputTokens = match.top_provider?.max_completion_tokens ?? 4096;
          // maxInputTokens = contextWindow - maxOutputTokens (conservative estimate)
          // but never less than 90% of contextWindow (some output budget is optional)
          const maxInputTokens = Math.min(
            contextWindow,
            Math.max(Math.floor(contextWindow * 0.9), contextWindow - maxOutputTokens),
          );
          return { contextWindow, maxInputTokens, maxOutputTokens };
        }
      }
    } catch {
      // Fall through to heuristic
    }

    // ── Step 2: Heuristic matching ──
    return this.heuristicContextInfo(modelId);
  }

  /**
   * Heuristic context window / max tokens based on model id patterns.
   * Mirrors Cline's model catalog data and session-compressor logic.
   */
  private heuristicContextInfo(modelId: string): {
    contextWindow: number;
    maxInputTokens: number;
    maxOutputTokens: number;
  } {
    const id = modelId.toLowerCase();

    // Claude models — 200K context (Opus 5+ has 1M but conservative)
    if (/claude/.test(id)) {
      if (/opus-5|opus-4-7|sonnet-4[.-]5|sonnet-4[.-]6/.test(id)) {
        return { contextWindow: 1_000_000, maxInputTokens: 900_000, maxOutputTokens: 128_000 };
      }
      return { contextWindow: 200_000, maxInputTokens: 180_000, maxOutputTokens: 8_192 };
    }
    // Gemini models — 1M context
    if (/gemini/.test(id)) {
      return { contextWindow: 1_000_000, maxInputTokens: 900_000, maxOutputTokens: 65_536 };
    }
    // GPT-5 / GPT-4.1 — 1M context
    if (/gpt-5|gpt-4\.1/.test(id)) {
      return { contextWindow: 1_000_000, maxInputTokens: 900_000, maxOutputTokens: 128_000 };
    }
    // GPT-4o — 128K context
    if (/gpt-4o/.test(id)) {
      return { contextWindow: 128_000, maxInputTokens: 115_000, maxOutputTokens: 16_384 };
    }
    // OpenAI o-series — 200K context
    if (/\/o[1-9]|^o[1-9]/.test(id)) {
      return { contextWindow: 200_000, maxInputTokens: 180_000, maxOutputTokens: 100_000 };
    }
    // DeepSeek models — 1M context for v4+, 128K for others
    if (/deepseek/.test(id)) {
      if (/v[4-9]|r1|reasoner/.test(id)) {
        return { contextWindow: 1_000_000, maxInputTokens: 900_000, maxOutputTokens: 65_536 };
      }
      return { contextWindow: 128_000, maxInputTokens: 115_000, maxOutputTokens: 8_192 };
    }
    // Qwen models — 1M for 3.7+, 128K for others
    if (/qwen/.test(id)) {
      if (/3\.[5-9]|3\.7/.test(id)) {
        return { contextWindow: 1_000_000, maxInputTokens: 900_000, maxOutputTokens: 65_536 };
      }
      return { contextWindow: 128_000, maxInputTokens: 115_000, maxOutputTokens: 8_192 };
    }
    // MiniMax / MiMo models — 1M context
    if (/minimax|mimo/.test(id)) {
      return { contextWindow: 1_000_000, maxInputTokens: 900_000, maxOutputTokens: 65_536 };
    }
    // GLM models — 128K context
    if (/glm/.test(id)) {
      return { contextWindow: 128_000, maxInputTokens: 115_000, maxOutputTokens: 8_192 };
    }
    // Kimi models — 128K context
    if (/kimi/.test(id)) {
      return { contextWindow: 128_000, maxInputTokens: 115_000, maxOutputTokens: 8_192 };
    }
    // Grok models — 200K context
    if (/grok/.test(id)) {
      return { contextWindow: 200_000, maxInputTokens: 180_000, maxOutputTokens: 32_768 };
    }
    // Cline-free / Cline-pass — 128K default
    if (/cline-free|cline-pass/.test(id)) {
      return { contextWindow: 128_000, maxInputTokens: 115_000, maxOutputTokens: 8_192 };
    }

    // Default fallback
    return { contextWindow: 128_000, maxInputTokens: 115_000, maxOutputTokens: 4_096 };
  }

  /**
   * Heuristic reasoning support check based on model id patterns.
   * Mirrors Cline's supportsReasoningEffortForModel() logic.
   */
  private heuristicReasoningCheck(modelId: string): {
    supportsReasoning: boolean;
    supportedEfforts: string[];
    defaultEffort: string;
  } {
    const id = modelId.toLowerCase();

    // Models known to support reasoning/thinking
    // NOTE: effort levels should match OpenRouter's `reasoning.supported_efforts` for each model.
    // GPT-4o does NOT support reasoning — it lacks the `reasoning` field on OpenRouter.
    const reasoningPatterns = [
      // Claude models (extended thinking) — supports max/xhigh/high/medium/low
      { pattern: /claude/, efforts: ['low', 'medium', 'high', 'xhigh', 'max'], default: 'high' },
      // OpenAI o-series and GPT-5 reasoning models (NOT gpt-4o which doesn't support reasoning)
      // Per OpenRouter: supports max/xhigh/high/medium/low/minimal/none
      { pattern: /\/o[1-9]|^o[1-9]|gpt-5|codex/, efforts: ['low', 'medium', 'high', 'xhigh', 'max'], default: 'medium' },
      // Gemini models — supports high/medium/low/minimal
      { pattern: /gemini/, efforts: ['low', 'medium', 'high'], default: 'medium' },
      // Grok models — supports high/medium/low
      { pattern: /grok/, efforts: ['low', 'medium', 'high'], default: 'medium' },
      // DeepSeek V4 Pro/Flash — supports xhigh/high only (per OpenRouter)
      { pattern: /deepseek.*(v4-pro|v4-flash)/, efforts: ['high', 'xhigh'], default: 'high' },
      // DeepSeek R1/Reasoner — supports high/medium/low
      { pattern: /deepseek.*(r1|reasoner)/, efforts: ['low', 'medium', 'high'], default: 'medium' },
      // Qwen reasoning models — supports high/medium/low
      { pattern: /qwen.*3\.7/, efforts: ['low', 'medium', 'high'], default: 'medium' },
      // GLM reasoning models — supports high/medium/low
      { pattern: /glm-5/, efforts: ['low', 'medium', 'high'], default: 'medium' },
      // Kimi reasoning models — supports high/medium/low
      { pattern: /kimi-k[23]/, efforts: ['low', 'medium', 'high'], default: 'medium' },
      // MiniMax reasoning models — supports high/medium/low
      { pattern: /minimax-m[23]|mimo-v2/, efforts: ['low', 'medium', 'high'], default: 'medium' },
    ];

    for (const { pattern, efforts, default: def } of reasoningPatterns) {
      if (pattern.test(id)) {
        return { supportsReasoning: true, supportedEfforts: efforts, defaultEffort: def };
      }
    }

    return { supportsReasoning: false, supportedEfforts: [], defaultEffort: '' };
  }
}

export const clineAuthService = new ClineAuthService();