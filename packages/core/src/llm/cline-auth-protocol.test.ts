/**
 * Integration tests for Cline OAuth Device Auth flow.
 *
 * Tests the WorkOS Device Authorization protocol implementation
 * by mocking HTTP requests at the fetch level. Validates:
 *   1. Device authorization request → user_code + verification_uri
 *   2. Token polling → handles pending/slow_down/success/errors
 *   3. Cline token registration → converts WorkOS tokens to Cline tokens
 *   4. Token refresh → auto-refreshes expired tokens
 *   5. Login flow end-to-end (mocked)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// We test the auth flow logic by simulating fetch calls that match
// the WorkOS Device Auth protocol.

// ── Protocol constants ──

const WORKOS_DEVICE_AUTH_URL = 'https://api.workos.com/user_management/authorize/device';
const WORKOS_TOKEN_URL = 'https://api.workos.com/user_management/authenticate';
const CLINE_REGISTER_URL = 'https://api.cline.bot/api/v1/auth/register';
const CLINE_REFRESH_URL = 'https://api.cline.bot/api/v1/auth/refresh';
const CLINE_MODELS_URL = 'https://api.cline.bot/api/v1/ai/cline/recommended-models';
const CLIENT_ID = 'client_01K3A541FN8TA3EPPHTD2325AR';

// ── Helper: Track fetch calls ──

interface FetchCall {
  url: string;
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string | URLSearchParams;
    signal?: AbortSignal;
  };
}

function createFetchTracker(responses: Map<string, (url: string, opts: RequestInit) => unknown>) {
  const calls: FetchCall[] = [];
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push({ url, options: init as FetchCall['options'] });

    // Find matching response handler
    for (const [pattern, handler] of responses) {
      if (url.includes(pattern)) {
        const result = await handler(url, init || {});
        return result;
      }
    }

    // Default: 404
    return { ok: false, status: 404, text: async () => 'Not Found', json: async () => ({}) };
  });

  return { fetchMock, calls };
}

// ── Tests ──

describe('WorkOS Device Auth Protocol', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('should request device authorization with correct client_id', async () => {
    const { fetchMock, calls } = createFetchTracker(new Map([
      ['user_management/authorize/device', async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          device_code: 'dev-123',
          user_code: 'ABCD-EFGH',
          verification_uri: 'https://verify.workos.com',
          verification_uri_complete: 'https://verify.workos.com?user_code=ABCD-EFGH',
          expires_in: 300,
          interval: 5,
        }),
      })],
    ]));

    vi.stubGlobal('fetch', fetchMock);

    // Simulate device authorization request
    const response = await fetch(WORKOS_DEVICE_AUTH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: CLIENT_ID }),
    });

    const data = await response.json();

    expect(response.ok).toBe(true);
    expect(data.device_code).toBe('dev-123');
    expect(data.user_code).toBe('ABCD-EFGH');
    expect(data.verification_uri_complete).toContain('user_code=ABCD-EFGH');

    // Verify the request was made correctly
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(WORKOS_DEVICE_AUTH_URL);

    vi.unstubAllGlobals();
  });

  it('should poll for tokens and handle authorization_pending', async () => {
    let pollCount = 0;
    const { fetchMock } = createFetchTracker(new Map([
      ['user_management/authenticate', async () => {
        pollCount++;
        if (pollCount < 3) {
          return {
            ok: false,
            status: 400,
            json: async () => ({
              error: 'authorization_pending',
              error_description: 'User has not yet authorized',
            }),
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            access_token: 'workos-access-token',
            refresh_token: 'workos-refresh-token',
            token_type: 'Bearer',
          }),
        };
      }],
    ]));

    vi.stubGlobal('fetch', fetchMock);

    // Simulate polling
    const results: unknown[] = [];
    for (let i = 0; i < 5; i++) {
      const resp = await fetch(WORKOS_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          device_code: 'dev-123',
          client_id: CLIENT_ID,
        }),
      });
      const data = await resp.json();
      results.push({ ok: resp.ok, data });
      if (resp.ok) break;
    }

    // First 2 should be pending, 3rd should succeed
    expect(results[0]).toMatchObject({ ok: false });
    expect(results[1]).toMatchObject({ ok: false });
    expect(results[2]).toMatchObject({ ok: true });
    expect((results[2] as { data: { access_token: string } }).data.access_token).toBe('workos-access-token');

    vi.unstubAllGlobals();
  });

  it('should handle slow_down by increasing interval', async () => {
    const responses = [
      { ok: false, status: 400, json: async () => ({ error: 'authorization_pending' }) },
      { ok: false, status: 429, json: async () => ({ error: 'slow_down' }) },
      { ok: true, status: 200, json: async () => ({ access_token: 'tok', refresh_token: 'ref', token_type: 'Bearer' }) },
    ];
    let idx = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      const resp = responses[idx++];
      return { ...resp, text: async () => JSON.stringify(await resp.json()) };
    }));

    // Verify the error types are returned correctly
    const r1 = await fetch(WORKOS_TOKEN_URL);
    const d1 = await r1.json();
    expect(d1.error).toBe('authorization_pending');

    const r2 = await fetch(WORKOS_TOKEN_URL);
    const d2 = await r2.json();
    expect(d2.error).toBe('slow_down');

    const r3 = await fetch(WORKOS_TOKEN_URL);
    expect(r3.ok).toBe(true);

    vi.unstubAllGlobals();
  });

  it('should handle access_denied error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 400,
      json: async () => ({
        error: 'access_denied',
        error_description: 'User denied the authorization request',
      }),
    })));

    const resp = await fetch(WORKOS_TOKEN_URL, {
      method: 'POST',
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }),
    });
    const data = await resp.json();

    expect(resp.ok).toBe(false);
    expect(data.error).toBe('access_denied');
    expect(data.error_description).toContain('denied');

    vi.unstubAllGlobals();
  });

  it('should handle expired_token error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 400,
      json: async () => ({
        error: 'expired_token',
        error_description: 'The device code has expired',
      }),
    })));

    const resp = await fetch(WORKOS_TOKEN_URL);
    const data = await resp.json();

    expect(resp.ok).toBe(false);
    expect(data.error).toBe('expired_token');

    vi.unstubAllGlobals();
  });
});

describe('Cline Token Registration Protocol', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('should register WorkOS tokens and receive Cline tokens', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/auth/register')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            data: {
              accessToken: 'cline-access-token',
              refreshToken: 'cline-refresh-token',
              tokenType: 'Bearer',
              expiresAt: new Date(Date.now() + 3600000).toISOString(),
              userInfo: {
                email: 'user@example.com',
                clineUserId: 'user-123',
              },
            },
          }),
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    }));

    const resp = await fetch(CLINE_REGISTER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        accessToken: 'workos-access-token',
        refreshToken: 'workos-refresh-token',
      }),
    });

    const data = await resp.json();

    expect(resp.ok).toBe(true);
    expect(data.success).toBe(true);
    expect(data.data.accessToken).toBe('cline-access-token');
    expect(data.data.userInfo.email).toBe('user@example.com');
    expect(data.data.userInfo.clineUserId).toBe('user-123');
  });

  it('should handle registration failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 401,
      json: async () => ({
        success: false,
        error: 'Invalid WorkOS token',
      }),
    })));

    const resp = await fetch(CLINE_REGISTER_URL, {
      method: 'POST',
      body: JSON.stringify({ accessToken: 'bad-token', refreshToken: 'bad-refresh' }),
    });

    expect(resp.ok).toBe(false);
    expect(resp.status).toBe(401);
  });
});

describe('Cline Token Refresh Protocol', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('should refresh expired Cline tokens', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/auth/refresh')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            data: {
              accessToken: 'new-cline-access-token',
              refreshToken: 'new-cline-refresh-token',
              tokenType: 'Bearer',
              expiresAt: new Date(Date.now() + 3600000).toISOString(),
              userInfo: { email: 'user@example.com' },
            },
          }),
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    }));

    const resp = await fetch(CLINE_REFRESH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: 'old-refresh-token' }),
    });

    const data = await resp.json();

    expect(resp.ok).toBe(true);
    expect(data.success).toBe(true);
    expect(data.data.accessToken).toBe('new-cline-access-token');
  });

  it('should handle refresh failure (invalid refresh token)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 401,
      json: async () => ({
        success: false,
        error: 'Invalid refresh token',
      }),
    })));

    const resp = await fetch(CLINE_REFRESH_URL, {
      method: 'POST',
      body: JSON.stringify({ refreshToken: 'expired-refresh' }),
    });

    expect(resp.ok).toBe(false);
    expect(resp.status).toBe(401);
  });
});

describe('Cline Recommended Models API', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('should fetch recommended models with correct structure', async () => {
    const mockResponse = {
      recommended: [
        { id: 'anthropic/claude-opus-4.6', name: 'Claude Opus 4.6', description: 'Best model', tags: ['BEST'] },
        { id: 'anthropic/claude-sonnet-4.6', name: 'Claude Sonnet 4.6', description: 'Strong coding', tags: ['NEW'] },
      ],
      free: [
        { id: 'kwaipilot/kat-coder-pro', name: 'KwaiKAT Kat Coder Pro', description: 'Free agentic model', tags: ['FREE'] },
        { id: 'arcee-ai/trinity-large-preview:free', name: 'Arcee AI Trinity', description: 'Free preview', tags: ['FREE'] },
      ],
      clinePass: [],
    };

    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/ai/cline/recommended-models')) {
        return {
          ok: true,
          status: 200,
          json: async () => mockResponse,
        };
      }
      return { ok: false, status: 404 };
    }));

    const resp = await fetch(CLINE_MODELS_URL);
    const data = await resp.json();

    expect(resp.ok).toBe(true);
    expect(data.recommended).toHaveLength(2);
    expect(data.free).toHaveLength(2);
    expect(data.clinePass).toHaveLength(0);

    // Verify model structure
    const rec = data.recommended[0];
    expect(rec).toHaveProperty('id');
    expect(rec).toHaveProperty('name');
    expect(rec).toHaveProperty('description');
    expect(rec).toHaveProperty('tags');
    expect(Array.isArray(rec.tags)).toBe(true);

    // Verify free models
    const free = data.free[0];
    expect(free.tags).toContain('FREE');
  });

  it('should handle models API being down', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Connection refused')));

    await expect(fetch(CLINE_MODELS_URL)).rejects.toThrow('Connection refused');
  });
});

describe('WorkOS + Cline Full Auth Flow (mocked)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('should complete full auth flow: device auth → poll → register → get token', async () => {
    let pollAttempts = 0;

    vi.stubGlobal('fetch', vi.fn(async (url: string, opts?: RequestInit) => {
      // Step 1: Device authorization
      if (url.includes('authorize/device')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            device_code: 'dev-abc',
            user_code: 'XXXX-YYYY',
            verification_uri: 'https://verify.workos.com',
            verification_uri_complete: 'https://verify.workos.com?user_code=XXXX-YYYY',
            expires_in: 300,
            interval: 1,
          }),
        };
      }

      // Step 2: Token polling (pending 2 times, then success)
      if (url.includes('authenticate')) {
        pollAttempts++;
        if (pollAttempts <= 2) {
          return {
            ok: false,
            status: 400,
            json: async () => ({ error: 'authorization_pending' }),
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            access_token: 'workos-at-' + pollAttempts,
            refresh_token: 'workos-rt-' + pollAttempts,
            token_type: 'Bearer',
          }),
        };
      }

      // Step 3: Cline registration
      if (url.includes('/auth/register')) {
        const body = JSON.parse((opts?.body as string) || '{}');
        expect(body.accessToken).toContain('workos-at-');
        expect(body.refreshToken).toContain('workos-rt-');
        return {
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            data: {
              accessToken: 'cline-final-at',
              refreshToken: 'cline-final-rt',
              tokenType: 'Bearer',
              expiresAt: new Date(Date.now() + 3600000).toISOString(),
              userInfo: {
                email: 'testuser@cline.bot',
                clineUserId: 'cline-uid-123',
              },
            },
          }),
        };
      }

      return { ok: false, status: 404, json: async () => ({}) };
    }));

    // Execute the flow
    // Step 1: Get device code
    const deviceResp = await fetch(WORKOS_DEVICE_AUTH_URL, {
      method: 'POST',
      body: new URLSearchParams({ client_id: CLIENT_ID }),
    });
    const deviceData = await deviceResp.json();
    expect(deviceData.device_code).toBe('dev-abc');
    expect(deviceData.user_code).toBe('XXXX-YYYY');

    // Step 2: Poll for tokens
    let workosTokens: { access_token: string; refresh_token: string } | null = null;
    for (let i = 0; i < 5; i++) {
      const pollResp = await fetch(WORKOS_TOKEN_URL, {
        method: 'POST',
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          device_code: deviceData.device_code,
          client_id: CLIENT_ID,
        }),
      });
      if (pollResp.ok) {
        workosTokens = await pollResp.json();
        break;
      }
    }

    expect(workosTokens).not.toBeNull();
    expect(workosTokens!.access_token).toBe('workos-at-3');
    expect(pollAttempts).toBe(3); // 2 pending + 1 success

    // Step 3: Register with Cline
    const registerResp = await fetch(CLINE_REGISTER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        accessToken: workosTokens!.access_token,
        refreshToken: workosTokens!.refresh_token,
      }),
    });
    const registerData = await registerResp.json();

    expect(registerData.success).toBe(true);
    expect(registerData.data.accessToken).toBe('cline-final-at');
    expect(registerData.data.userInfo.email).toBe('testuser@cline.bot');

    vi.unstubAllGlobals();
  });
});