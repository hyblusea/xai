/**
 * Auth IPC handlers：登录、注册、刷新、登出、当前用户、改密、会话恢复。
 * access token 存内存（AppState.accessToken + adminClient），refresh token 用 safeStorage 加密落盘，
 * 启动时尝试静默恢复。
 */
import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { IPCChannel, type LoginRequest, type RegisterRequest, type ChangePasswordRequest, type UpdateProfileRequest, type ForgotPasswordRequest, type ResetPasswordRequest } from '@xai/shared';
import type { AppState } from '../app-state.js';
import { loadRefreshToken, persistRefreshToken, persistCredentials, loadCredentials, AdminClientError } from '../admin-client.js';

/** 启动时尝试用 refresh token 静默恢复会话；若失败，再用记住的凭据自动登录。
 *  使用 in-flight 去重 + 完成态缓存，避免 main.ts 的 fire-and-forget 调用与 renderer 的
 *  AuthRestoreSession IPC 调用（无论并发还是串行）导致日志/网络请求重复。
 *  失败时不置完成态，允许后续调用重试。 */
let _initAuthSessionPromise: Promise<void> | null = null;
let _initAuthSessionDone = false;

export function initAuthSession(state: AppState): Promise<void> {
  if (_initAuthSessionDone) return Promise.resolve();
  if (_initAuthSessionPromise) return _initAuthSessionPromise;
  _initAuthSessionPromise = (async () => {
    try {
      await doInitAuthSession(state);
      _initAuthSessionDone = true;
    } finally {
      _initAuthSessionPromise = null;
    }
  })();
  return _initAuthSessionPromise;
}

async function doInitAuthSession(state: AppState): Promise<void> {
  const refresh = await loadRefreshToken();
  if (refresh) {
    try {
      const r = await state.adminClient.refresh(refresh);
      state.accessToken = r.accessToken;
      state.currentUser = r.user;
      await persistRefreshToken(r.refreshToken);
      console.log('[XAI][auth] 会话已恢复:', r.user.email);
      return;
    } catch (e) {
      console.log('[XAI][auth] 会话恢复失败:', (e as Error).message);
      await persistRefreshToken(null);
      state.accessToken = null;
      state.currentUser = null;
    }
  }

  // refresh token 不可用或已失效：尝试用记住的邮箱+密码自动登录
  try {
    const creds = await loadCredentials();
    if (creds?.email && creds?.password) {
      console.log('[XAI][auth] 尝试用记住的凭据自动登录:', creds.email);
      const r = await state.adminClient.login({ email: creds.email, password: creds.password });
      state.accessToken = r.accessToken;
      state.currentUser = r.user;
      await persistRefreshToken(r.refreshToken);
      console.log('[XAI][auth] 自动登录成功:', r.user.email);
    }
  } catch (e) {
    console.log('[XAI][auth] 自动登录失败:', (e as Error).message);
    state.accessToken = null;
    state.currentUser = null;
  }
}

export function registerAuthHandlers(state: AppState): void {
  const handle = (channel: string, fn: (e: IpcMainInvokeEvent, ...args: any[]) => Promise<any> | any) => {
    ipcMain.handle(channel, fn);
  };

  handle(IPCChannel.AuthLogin, async (_e, req: LoginRequest) => {
    const r = await state.adminClient.login(req);
    state.accessToken = r.accessToken;
    state.currentUser = r.user;
    await persistRefreshToken(r.refreshToken);
    // 登录成功后记住邮箱与密码，便于下次启动自动填充
    try { await persistCredentials({ email: req.email, password: req.password }); } catch { /* ignore */ }
    return r;
  });

  handle(IPCChannel.AuthRegister, async (_e, req: RegisterRequest) => {
    const r = await state.adminClient.register(req);
    state.accessToken = r.accessToken;
    state.currentUser = r.user;
    await persistRefreshToken(r.refreshToken);
    // 注册成功后记住邮箱与密码
    try { await persistCredentials({ email: req.email, password: req.password }); } catch { /* ignore */ }
    return r;
  });

  handle(IPCChannel.AuthRefresh, async () => {
    const refresh = await loadRefreshToken();
    if (!refresh) throw new AdminClientError('无 refresh token', 401, 'NO_REFRESH');
    const r = await state.adminClient.refresh(refresh);
    state.accessToken = r.accessToken;
    state.currentUser = r.user;
    await persistRefreshToken(r.refreshToken);
    return r;
  });

  handle(IPCChannel.AuthLogout, async () => {
    const refresh = await loadRefreshToken();
    if (refresh) {
      try { await state.adminClient.logout(refresh); } catch { /* ignore */ }
    }
    await persistRefreshToken(null);
    // 注销时清除记住的凭据，避免下次启动自动登录
    try { await persistCredentials(null); } catch { /* ignore */ }
    state.accessToken = null;
    state.currentUser = null;
    state.adminClient.setAccessToken(null);
  });

  handle(IPCChannel.AuthGetCurrent, async () => {
    return state.currentUser;
  });

  handle(IPCChannel.AuthChangePassword, async (_e, req: ChangePasswordRequest) => {
    await state.adminClient.changePassword(req);
  });

  handle(IPCChannel.AuthUpdateProfile, async (_e, req: UpdateProfileRequest) => {
    const updated = await state.adminClient.updateProfile(req);
    state.currentUser = updated;
    return updated;
  });

  handle(IPCChannel.AuthForgotPassword, async (_e, req: ForgotPasswordRequest) => {
    await state.adminClient.forgotPassword(req);
  });

  handle(IPCChannel.AuthResetPassword, async (_e, req: ResetPasswordRequest) => {
    await state.adminClient.resetPassword(req);
  });

  handle(IPCChannel.AuthRestoreSession, async () => {
    await initAuthSession(state);
    return state.currentUser;
  });

  handle(IPCChannel.AuthGetRememberedCredentials, async () => {
    return await loadCredentials();
  });
}
