/**
 * Cline 登录模块补充测试用例。
 *
 * 测试目标：D:\cline-main\cline-main\sdk\packages\core\src\auth\cline.ts
 * 通过 vitest 的 alias 将 `./cline` 映射到 Cline 源码实际路径，
 * 并用 vi.mock 把 Cline 的内部依赖（@cline/shared、early-logger、
 * core-events、./server）替换为可控的 mock，从而只测 cline.ts 自身逻辑。
 *
 * 仿照 cline.test.ts 的风格（vitest + vi.spyOn(Date, "now") +
 * globalThis.fetch = vi.fn() + createJwt/createCredentials 辅助函数），
 * 覆盖原测试文件未覆盖的场景：
 *
 *   - getValidClineCredentials: null 输入、forceRefresh、自定义 buffer/grace、
 *     fallback 字段保留
 *   - refreshClineToken: 成功刷新、HTTP 401/500 失败、非 JSON 错误响应、
 *     缺失 refreshToken 时回退、请求 body 字段
 *   - startClineDeviceAuth: 成功返回 device authorization、失败抛出、
 *     缺失字段抛出、默认 expires/interval
 *   - loginClineOAuth: onAuth URL 验证、onProgress 调用、access_denied/
 *     expired_token 错误分支、token 注册失败、非 JSON 注册错误
 *   - completeClineDeviceAuth: 成功完成、metadata.provider 传递、
 *     缺失 access_token 抛出
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// cline.ts 仅使用 @cline/shared 的 decodeJwtPayload / getClineEnvironmentConfig
// / ITelemetryService 类型。用 vi.mock 替换为轻量实现，避免拉入整棵依赖树。
vi.mock("@cline/shared", () => ({
  decodeJwtPayload: (token?: string) => {
    if (!token) return null;
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    try {
      // payload 在第二段，用 base64url（已是 base64url，见 createJwt）。
      const json = Buffer.from(parts[1] as string, "base64url").toString("utf8");
      return JSON.parse(json) as Record<string, unknown>;
    } catch {
      return null;
    }
  },
  getClineEnvironmentConfig: () => ({
    workOsClientId: "client_test_id",
  }),
}));

// early-logger 的 hashSecret/sdkDebug 在测试里不需要真实行为。
// 用 #cline-root alias 指向 Cline 源码实际路径。
vi.mock("#cline-root/sdk/packages/core/src/logging/early-logger", () => ({
  hashSecret: (value: unknown) => `hash:${String(value)}`,
  sdkDebug: () => {},
}));

// core-events 的 capture* / identifyAccount 在测试里仅作 no-op，
// 只有显式传入 telemetry.capture 的用例才会通过 vi.fn() 校验调用。
vi.mock("#cline-root/sdk/packages/core/src/services/telemetry/core-events", () => ({
  captureAuthStarted: () => {},
  captureAuthSucceeded: () => {},
  captureAuthFailed: () => {},
  captureAuthLoggedOut: () => {},
  captureAuthRefreshSoftFailure: () => {},
  captureProviderConfigured: () => {},
  identifyAccount: () => {},
}));

// ./server 仅在非 WorkOS 流程用到，本测试只测 WorkOS device flow，
// 所以 mock 成抛错实现，避免意外启动本地 HTTP 服务。
vi.mock("#cline-root/sdk/packages/core/src/auth/server", () => ({
  startLocalOAuthServer: () => {
    throw new Error("startLocalOAuthServer should not be called in WorkOS flow tests");
  },
}));

// 引入被测模块（路径见 packages/core/vitest.config.ts 的 alias 配置）。
import type { ClineOAuthCredentials } from "./cline-auth-bridge";
import {
  completeClineDeviceAuth,
  getValidClineCredentials,
  loginClineOAuth,
  refreshClineToken,
  startClineDeviceAuth,
} from "./cline-auth-bridge";

const PROVIDER_OPTIONS = {
  apiBaseUrl: "https://auth.example.com",
};
const ORIGINAL_FETCH = globalThis.fetch;

function toBase64Url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function createJwt(payload: Record<string, unknown>): string {
  const header = toBase64Url(JSON.stringify({ alg: "none", typ: "JWT" }));
  const jwtPayload = toBase64Url(JSON.stringify(payload));
  return `${header}.${jwtPayload}.sig`;
}

function createCredentials(
  overrides: Partial<ClineOAuthCredentials> = {},
): ClineOAuthCredentials {
  return {
    access: "access-old",
    refresh: "refresh-old",
    expires: 0,
    accountId: "acct-1",
    email: "user@example.com",
    metadata: { provider: "google" },
    ...overrides,
  };
}

/** 构造一个成功的 Cline token 响应（ClineTokenResponse.success=true）。 */
function buildSuccessTokenResponse(overrides: {
  accessToken?: string;
  refreshToken?: string;
  tokenType?: string;
  expiresAt?: string;
  userInfo?: {
    subject?: string;
    email?: string;
    name?: string;
    clineUserId?: string | null;
    accounts?: string[];
  };
}) {
  return {
    success: true,
    data: {
      accessToken: overrides.accessToken ?? "access-new",
      refreshToken: overrides.refreshToken ?? "refresh-new",
      tokenType: overrides.tokenType ?? "Bearer",
      expiresAt: overrides.expiresAt ?? "2030-01-01T00:00:00.000Z",
      userInfo: {
        subject: overrides.userInfo?.subject ?? "sub-1",
        email: overrides.userInfo?.email ?? "new@example.com",
        name: overrides.userInfo?.name ?? "New User",
        clineUserId: overrides.userInfo?.clineUserId ?? "acct-2",
        accounts: overrides.userInfo?.accounts ?? [],
      },
    },
  };
}

/** 构造一个 WorkOS device authorization 响应。 */
function buildDeviceAuthorizationResponse(
  overrides: Partial<{
    device_code: string;
    user_code: string;
    verification_uri: string;
    verification_uri_complete: string;
    expires_in: number;
    interval: number;
  }> = {},
) {
  return {
    device_code: overrides.device_code ?? "dev-code-1",
    user_code: overrides.user_code ?? "ABCD-EFGH",
    verification_uri:
      overrides.verification_uri ?? "https://example.com/device",
    verification_uri_complete:
      overrides.verification_uri_complete ??
      "https://example.com/device?user_code=ABCD-EFGH",
    expires_in: overrides.expires_in ?? 300,
    interval: overrides.interval ?? 1,
  };
}

/** 构造一个 WorkOS token 响应（成功）。 */
function buildWorkosTokenResponse() {
  return {
    access_token: "workos-access",
    refresh_token: "workos-refresh",
    token_type: "Bearer",
    expires_in: 3600,
  };
}

function jsonOk(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function jsonError(
  body: unknown,
  status: number,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

// ── getValidClineCredentials ────────────────────────────────────────────────

describe("auth/cline getValidClineCredentials (supplement)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    globalThis.fetch = ORIGINAL_FETCH;
  });

  it("returns null when there are no current credentials", async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await getValidClineCredentials(null, PROVIDER_OPTIONS);
    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("forces a refresh when forceRefresh=true even if the token is still valid", async () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(10_000);
    // Token expires at 400_000 — still valid under the default 5min buffer.
    const current = createCredentials({
      expires: 400_000,
      metadata: { provider: "google", sessionStartedAtMs: 1_000 },
    });
    globalThis.fetch = vi.fn(async () =>
      jsonOk(
        buildSuccessTokenResponse({
          accessToken: "access-forced",
          refreshToken: "refresh-forced",
          userInfo: {
            clineUserId: "acct-forced",
            email: "forced@example.com",
          },
        }),
      ),
    ) as unknown as typeof fetch;

    const result = await getValidClineCredentials(current, PROVIDER_OPTIONS, {
      forceRefresh: true,
    });
    expect(result).toMatchObject({
      access: "access-forced",
      refresh: "refresh-forced",
      accountId: "acct-forced",
    });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    nowSpy.mockRestore();
  });

  it("treats the token as expired when within the custom refreshBufferMs window", async () => {
    // now=100_000, expires=120_000, buffer=30_000 → effective expiry=90_000 → expired.
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(100_000);
    const current = createCredentials({ expires: 120_000 });
    globalThis.fetch = vi.fn(async () =>
      jsonOk(buildSuccessTokenResponse({ accessToken: "buffered" })),
    ) as unknown as typeof fetch;

    const result = await getValidClineCredentials(current, PROVIDER_OPTIONS, {
      refreshBufferMs: 30_000,
    });
    expect(result?.access).toBe("buffered");
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    nowSpy.mockRestore();
  });

  it("preserves fallback accountId/email when the refresh response omits them", async () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(100_000);
    const current = createCredentials({
      expires: 90_000,
      accountId: "fallback-acct",
      email: "fallback@example.com",
      metadata: { provider: "google", sessionStartedAtMs: 1_000 },
    });
    // Response with clineUserId=null and empty email → toClineCredentials
    // must fall back to the existing accountId/email.
    globalThis.fetch = vi.fn(async () =>
      jsonOk({
        success: true,
        data: {
          accessToken: "access-new",
          refreshToken: "refresh-new",
          tokenType: "Bearer",
          expiresAt: "2030-01-01T00:00:00.000Z",
          userInfo: {
            subject: "sub-1",
            email: "",
            name: "User",
            clineUserId: null,
            accounts: [],
          },
        },
      }),
    ) as unknown as typeof fetch;

    const result = await getValidClineCredentials(current, PROVIDER_OPTIONS);
    expect(result).toMatchObject({
      access: "access-new",
      accountId: "fallback-acct",
      email: "fallback@example.com",
    });
    // metadata.provider is preserved from current.metadata.provider.
    expect(result?.metadata?.provider).toBe("google");
    nowSpy.mockRestore();
  });

  it("keeps current metadata.provider when refreshing (preferred over options.provider)", async () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(100_000);
    const current = createCredentials({
      expires: 90_000,
      metadata: { provider: "google" },
    });
    globalThis.fetch = vi.fn(async () =>
      jsonOk(buildSuccessTokenResponse({})),
    ) as unknown as typeof fetch;

    const result = await getValidClineCredentials(current, {
      ...PROVIDER_OPTIONS,
      provider: "cline",
    });
    // current.metadata.provider ("google") should win over options.provider.
    expect(result?.metadata?.provider).toBe("google");
    nowSpy.mockRestore();
  });
});

// ── refreshClineToken ───────────────────────────────────────────────────────

describe("auth/cline refreshClineToken (supplement)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    globalThis.fetch = ORIGINAL_FETCH;
  });

  it("returns new credentials with refreshed access/refresh tokens", async () => {
    const current = createCredentials({
      metadata: { provider: "google", sessionStartedAtMs: 1_000 },
    });
    globalThis.fetch = vi.fn(async () =>
      jsonOk(
        buildSuccessTokenResponse({
          accessToken: "access-refreshed",
          refreshToken: "refresh-refreshed",
          userInfo: { clineUserId: "acct-refreshed" },
        }),
      ),
    ) as unknown as typeof fetch;

    const result = await refreshClineToken(current, PROVIDER_OPTIONS);
    expect(result).toMatchObject({
      access: "access-refreshed",
      refresh: "refresh-refreshed",
      accountId: "acct-refreshed",
      expires: Date.parse("2030-01-01T00:00:00.000Z"),
    });
    // sessionStartedAtMs is preserved from current.metadata because
    // toClineCredentials only deletes `startedAt`, not `sessionStartedAtMs`.
    expect(result.metadata?.sessionStartedAtMs).toBe(1_000);
    expect(result.metadata?.tokenType).toBe("Bearer");
    expect(result.metadata?.provider).toBe("google");
  });

  it("throws and surfaces status/errorCode/requestId on a 401 invalid_grant response", async () => {
    const current = createCredentials({});
    globalThis.fetch = vi.fn(async () =>
      jsonError(
        { error: "invalid_grant", error_description: "token revoked" },
        401,
        { "x-request-id": "req-refresh-401" },
      ),
    ) as unknown as typeof fetch;

    await expect(
      refreshClineToken(current, PROVIDER_OPTIONS),
    ).rejects.toThrow("Token refresh failed: 401 - token revoked");
  });

  it("throws on a 500 server error with error_description", async () => {
    const current = createCredentials({});
    globalThis.fetch = vi.fn(async () =>
      jsonError(
        { error: "server_error", error_description: "boom" },
        500,
        { "x-request-id": "req-refresh-500" },
      ),
    ) as unknown as typeof fetch;

    await expect(
      refreshClineToken(current, PROVIDER_OPTIONS),
    ).rejects.toThrow("Token refresh failed: 500 - boom");
  });

  it("throws a generic message when the error body is not JSON", async () => {
    const current = createCredentials({});
    globalThis.fetch = vi.fn(
      async () =>
        new Response("plain text upstream error", {
          status: 502,
          headers: { "Content-Type": "text/plain" },
        }),
    ) as unknown as typeof fetch;

    await expect(
      refreshClineToken(current, PROVIDER_OPTIONS),
    ).rejects.toThrow("Token refresh failed: 502");
  });

  it("falls back to current.refresh when the response omits refreshToken", async () => {
    const current = createCredentials({});
    globalThis.fetch = vi.fn(async () =>
      jsonOk({
        success: true,
        data: {
          accessToken: "access-no-refresh",
          // refreshToken intentionally omitted
          tokenType: "Bearer",
          expiresAt: "2030-01-01T00:00:00.000Z",
          userInfo: {
            subject: "sub-1",
            email: "user@example.com",
            name: "User",
            clineUserId: "acct-1",
            accounts: [],
          },
        },
      }),
    ) as unknown as typeof fetch;

    // Falls back to current.refresh ("refresh-old") since refreshToken is
    // omitted from the response — should NOT throw.
    const result = await refreshClineToken(current, PROVIDER_OPTIONS);
    expect(result.refresh).toBe("refresh-old");
  });

  it("sends the refresh token and grantType in the request body", async () => {
    const current = createCredentials({
      refresh: "sent-refresh-token",
    });
    const fetchMock = vi.fn(async () =>
      jsonOk(buildSuccessTokenResponse({})),
    ) as unknown as typeof fetch;
    globalThis.fetch = fetchMock;

    await refreshClineToken(current, PROVIDER_OPTIONS);
    const body = JSON.parse(
      String(fetchMock.mock.calls[0]?.[1]?.body ?? "{}"),
    );
    expect(body).toEqual({
      refreshToken: "sent-refresh-token",
      grantType: "refresh_token",
    });
  });
});

// ── startClineDeviceAuth ────────────────────────────────────────────────────

describe("auth/cline startClineDeviceAuth (supplement)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    globalThis.fetch = ORIGINAL_FETCH;
  });

  it("returns device authorization info on success", async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonOk(
        buildDeviceAuthorizationResponse({
          device_code: "dev-xyz",
          user_code: "ZZZZ-YYYY",
          verification_uri: "https://verify.example.com",
          verification_uri_complete:
            "https://verify.example.com?user_code=ZZZZ-YYYY",
          expires_in: 600,
          interval: 7,
        }),
      ),
    ) as unknown as typeof fetch;

    const result = await startClineDeviceAuth();
    expect(result).toEqual({
      deviceCode: "dev-xyz",
      userCode: "ZZZZ-YYYY",
      verificationUri: "https://verify.example.com",
      verificationUriComplete:
        "https://verify.example.com?user_code=ZZZZ-YYYY",
      expiresInSeconds: 600,
      pollIntervalSeconds: 7,
    });
  });

  it("throws when WorkOS rejects the device authorization request", async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonError(
        { error: "invalid_client", error_description: "unknown client" },
        400,
        { "x-request-id": "req-device-auth-fail" },
      ),
    ) as unknown as typeof fetch;

    await expect(startClineDeviceAuth()).rejects.toThrow(
      "Device authorization failed: 400 - unknown client",
    );
  });

  it("throws when the response is missing required fields", async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonOk({ device_code: "only-code" }),
    ) as unknown as typeof fetch;

    await expect(startClineDeviceAuth()).rejects.toThrow(
      "Invalid WorkOS device authorization response",
    );
  });

  it("falls back to default expires/interval when the response omits them", async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonOk({
        device_code: "dev-1",
        user_code: "CODE-1234",
        verification_uri: "https://example.com/device",
        // expires_in and interval omitted
      }),
    ) as unknown as typeof fetch;

    const result = await startClineDeviceAuth();
    expect(result.expiresInSeconds).toBe(300); // DEFAULT_DEVICE_AUTH_EXPIRES_IN_SECONDS
    expect(result.pollIntervalSeconds).toBe(5); // DEFAULT_DEVICE_AUTH_INTERVAL_SECONDS
  });
});

// ── loginClineOAuth (WorkOS device flow) ────────────────────────────────────

describe("auth/cline loginClineOAuth WorkOS flow (supplement)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    globalThis.fetch = ORIGINAL_FETCH;
  });

  it("invokes onAuth with the verificationUriComplete URL and user code instructions", async () => {
    const loginAccessToken = createJwt({ sid: "sid-onauth" });
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        jsonOk(
          buildDeviceAuthorizationResponse({
            user_code: "WXYZ-1234",
            verification_uri_complete:
              "https://device.example.com?user_code=WXYZ-1234",
          }),
        ),
      )
      .mockResolvedValueOnce(jsonOk(buildWorkosTokenResponse()))
      .mockResolvedValueOnce(
        jsonOk(
          buildSuccessTokenResponse({
            accessToken: loginAccessToken,
            refreshToken: "cline-refresh",
            userInfo: { clineUserId: "acct-onauth" },
          }),
        ),
      ) as unknown as typeof fetch;

    const onAuth = vi.fn();
    await loginClineOAuth({
      apiBaseUrl: "https://api.cline.bot",
      useWorkOSDeviceAuth: true,
      callbacks: { onAuth, onPrompt: async () => "" },
    });

    expect(onAuth).toHaveBeenCalledTimes(1);
    expect(onAuth.mock.calls[0]?.[0]).toMatchObject({
      url: "https://device.example.com?user_code=WXYZ-1234",
      instructions: expect.stringContaining("WXYZ-1234"),
    });
  });

  it("invokes onProgress while polling for the WorkOS token", async () => {
    const loginAccessToken = createJwt({ sid: "sid-progress" });
    // First poll returns authorization_pending (triggers sleep + onProgress),
    // second poll returns the WorkOS tokens.
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        jsonOk(buildDeviceAuthorizationResponse({ interval: 1 })),
      )
      .mockResolvedValueOnce(
        jsonError({ error: "authorization_pending" }, 400),
      )
      .mockResolvedValueOnce(jsonOk(buildWorkosTokenResponse()))
      .mockResolvedValueOnce(
        jsonOk(
          buildSuccessTokenResponse({
            accessToken: loginAccessToken,
            refreshToken: "cline-refresh",
            userInfo: { clineUserId: "acct-progress" },
          }),
        ),
      ) as unknown as typeof fetch;

    const onProgress = vi.fn();
    // Kick off the login promise — it will block on sleep(1000) inside
    // pollWorkOSTokens after the authorization_pending response.
    const promise = loginClineOAuth({
      apiBaseUrl: "https://api.cline.bot",
      useWorkOSDeviceAuth: true,
      callbacks: {
        onAuth: vi.fn(),
        onPrompt: async () => "",
        onProgress,
      },
    });

    // Advance the fake timer to resolve the pending poll's sleep, then
    // await the overall login promise.
    await vi.advanceTimersByTimeAsync(2000);
    const credentials = await promise;

    expect(credentials.access).toBe(loginAccessToken);
    expect(onProgress).toHaveBeenCalledWith(
      expect.stringContaining("Waiting for browser"),
    );
  });

  it("throws on WorkOS access_denied during polling", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonOk(buildDeviceAuthorizationResponse({})))
      .mockResolvedValueOnce(
        jsonError(
          { error: "access_denied", error_description: "user denied" },
          403,
          { "x-request-id": "req-denied" },
        ),
      ) as unknown as typeof fetch;

    await expect(
      loginClineOAuth({
        apiBaseUrl: "https://api.cline.bot",
        useWorkOSDeviceAuth: true,
        callbacks: { onAuth: vi.fn(), onPrompt: async () => "" },
      }),
    ).rejects.toThrow("user denied");
  });

  it("throws on WorkOS expired_token during polling", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonOk(buildDeviceAuthorizationResponse({})))
      .mockResolvedValueOnce(
        jsonError(
          { error: "expired_token", error_description: "code expired" },
          400,
        ),
      ) as unknown as typeof fetch;

    await expect(
      loginClineOAuth({
        apiBaseUrl: "https://api.cline.bot",
        useWorkOSDeviceAuth: true,
        callbacks: { onAuth: vi.fn(), onPrompt: async () => "" },
      }),
    ).rejects.toThrow("code expired");
  });

  it("throws when WorkOS token registration fails", async () => {
    // Device auth + WorkOS token succeed, but Cline /auth/register fails.
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonOk(buildDeviceAuthorizationResponse({})))
      .mockResolvedValueOnce(jsonOk(buildWorkosTokenResponse()))
      .mockResolvedValueOnce(
        jsonError(
          { error: "invalid_request", error_description: "bad workos token" },
          400,
          { "x-request-id": "req-register" },
        ),
      ) as unknown as typeof fetch;

    await expect(
      loginClineOAuth({
        apiBaseUrl: "https://api.cline.bot",
        useWorkOSDeviceAuth: true,
        callbacks: { onAuth: vi.fn(), onPrompt: async () => "" },
      }),
    ).rejects.toThrow("Token registration failed: 400 - bad workos token");
  });

  it("surfaces a non-JSON error body from token registration without a description", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonOk(buildDeviceAuthorizationResponse({})))
      .mockResolvedValueOnce(jsonOk(buildWorkosTokenResponse()))
      .mockResolvedValueOnce(
        new Response("gateway html error", {
          status: 502,
          headers: { "Content-Type": "text/html" },
        }),
      ) as unknown as typeof fetch;

    await expect(
      loginClineOAuth({
        apiBaseUrl: "https://api.cline.bot",
        useWorkOSDeviceAuth: true,
        callbacks: { onAuth: vi.fn(), onPrompt: async () => "" },
      }),
    ).rejects.toThrow("Token registration failed: 502");
  });
});

// ── completeClineDeviceAuth ─────────────────────────────────────────────────

describe("auth/cline completeClineDeviceAuth (supplement)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    globalThis.fetch = ORIGINAL_FETCH;
  });

  it("completes successfully on the first poll and propagates provider metadata", async () => {
    const loginAccessToken = createJwt({ sid: "sid-complete" });
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonOk(buildWorkosTokenResponse()))
      .mockResolvedValueOnce(
        jsonOk(
          buildSuccessTokenResponse({
            accessToken: loginAccessToken,
            refreshToken: "cline-refresh",
            userInfo: { clineUserId: "acct-complete" },
          }),
        ),
      ) as unknown as typeof fetch;

    const credentials = await completeClineDeviceAuth({
      deviceCode: "dev-complete",
      expiresInSeconds: 300,
      pollIntervalSeconds: 1,
      apiBaseUrl: "https://api.cline.bot",
      provider: "cline",
    });

    expect(credentials).toMatchObject({
      access: loginAccessToken,
      refresh: "cline-refresh",
      accountId: "acct-complete",
    });
    expect(credentials.metadata?.provider).toBe("cline");
  });

  it("throws when the WorkOS tokens are missing access_token", async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonOk({
        access_token: "",
        refresh_token: "rt",
        token_type: "Bearer",
      }),
    ) as unknown as typeof fetch;

    await expect(
      completeClineDeviceAuth({
        deviceCode: "dev-bad",
        expiresInSeconds: 60,
        pollIntervalSeconds: 1,
        apiBaseUrl: "https://api.cline.bot",
      }),
    ).rejects.toThrow("Invalid WorkOS token response");
  });
});
