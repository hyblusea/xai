/**
 * 认证 hook：管理登录态、登录/注册/登出/改密。
 * 启动时尝试静默恢复会话（refresh token）。
 */
import { useState, useEffect, useCallback } from 'react';
import { IPCChannel, type IdeUser, type LoginRequest, type RegisterRequest, type ChangePasswordRequest, type UpdateProfileRequest, type ForgotPasswordRequest, type ResetPasswordRequest } from '@xai/shared';

interface AuthState {
  user: IdeUser | null;
  loading: boolean;
  initialized: boolean;
}

export function useAuth() {
  const [state, setState] = useState<AuthState>({ user: null, loading: false, initialized: false });

  // 启动时尝试恢复会话
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setState(s => ({ ...s, loading: true }));
      try {
        const user = await window.electronAPI.invoke(IPCChannel.AuthRestoreSession) as IdeUser | null;
        if (!cancelled) setState({ user, loading: false, initialized: true });
      } catch {
        if (!cancelled) setState({ user: null, loading: false, initialized: true });
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const login = useCallback(async (req: LoginRequest) => {
    const user = await window.electronAPI.invoke(IPCChannel.AuthLogin, req) as IdeUser;
    setState({ user, loading: false, initialized: true });
    return user;
  }, []);

  const register = useCallback(async (req: RegisterRequest) => {
    const user = await window.electronAPI.invoke(IPCChannel.AuthRegister, req) as IdeUser;
    setState({ user, loading: false, initialized: true });
    return user;
  }, []);

  const logout = useCallback(async () => {
    try { await window.electronAPI.invoke(IPCChannel.AuthLogout); } catch { /* ignore */ }
    setState({ user: null, loading: false, initialized: true });
  }, []);

  const changePassword = useCallback(async (req: ChangePasswordRequest) => {
    await window.electronAPI.invoke(IPCChannel.AuthChangePassword, req);
  }, []);

  const updateProfile = useCallback(async (req: UpdateProfileRequest) => {
    const updated = await window.electronAPI.invoke(IPCChannel.AuthUpdateProfile, req) as IdeUser;
    setState(s => ({ ...s, user: updated }));
    return updated;
  }, []);

  /** 忘记密码：请求向注册邮箱发送 6 位验证码 */
  const forgotPassword = useCallback(async (req: ForgotPasswordRequest) => {
    await window.electronAPI.invoke(IPCChannel.AuthForgotPassword, req);
  }, []);

  /** 重置密码：校验验证码并设置新密码 */
  const resetPassword = useCallback(async (req: ResetPasswordRequest) => {
    await window.electronAPI.invoke(IPCChannel.AuthResetPassword, req);
  }, []);

  return { ...state, login, register, logout, changePassword, updateProfile, forgotPassword, resetPassword };
}
