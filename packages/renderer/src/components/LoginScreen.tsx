/**
 * 登录/注册页：邮箱+密码登录，可切换到注册（邮箱、密码、密码确认、姓名）。
 * 支持忘记密码：输入注册邮箱 → 后端发送 6 位验证码（10 分钟有效）→ 校验后重置密码。
 * 未登录时由 App 渲染此组件。启动时自动填充已记住的邮箱与密码。
 */
import { useState, useEffect, useRef } from 'react';
import type { LoginRequest, RegisterRequest, IdeUser, ForgotPasswordRequest, ResetPasswordRequest } from '@xai/shared';
import { IPCChannel } from '@xai/shared';

interface Props {
  onLogin: (req: LoginRequest) => Promise<IdeUser>;
  onRegister: (req: RegisterRequest) => Promise<IdeUser>;
  onForgotPassword: (req: ForgotPasswordRequest) => Promise<void>;
  onResetPassword: (req: ResetPasswordRequest) => Promise<void>;
}

type Mode = 'login' | 'register' | 'forgot';

export default function LoginScreen({ onLogin, onRegister, onForgotPassword, onResetPassword }: Props) {
  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [loading, setLoading] = useState(false);

  // 忘记密码流程：code=验证码，newPassword=新密码，step=1 输入邮箱发码 / step=2 填写验证码与新密码
  const [forgotStep, setForgotStep] = useState<1 | 2>(1);
  const [code, setCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmNewPassword, setConfirmNewPassword] = useState('');
  const [resendCooldown, setResendCooldown] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // 启动时加载已记住的登录凭据并自动填充
  useEffect(() => {
    (async () => {
      try {
        const creds = await window.electronAPI.invoke(IPCChannel.AuthGetRememberedCredentials) as { email: string; password: string } | null;
        if (creds?.email) {
          setEmail(creds.email);
          if (creds.password) setPassword(creds.password);
        }
      } catch {
        /* ignore */
      }
    })();
  }, []);

  // 重发验证码倒计时
  useEffect(() => {
    if (resendCooldown <= 0) {
      if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
      return;
    }
    timerRef.current = setInterval(() => {
      setResendCooldown(s => (s <= 1 ? 0 : s - 1));
    }, 1000);
    return () => {
      if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    };
  }, [resendCooldown]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setInfo('');
    setLoading(true);
    try {
      if (mode === 'login') {
        await onLogin({ email: email.trim(), password });
      } else if (mode === 'register') {
        if (!email.trim() || !displayName.trim()) {
          throw new Error('请填写邮箱与姓名');
        }
        if (password.length < 6) {
          throw new Error('密码至少 6 位');
        }
        if (password !== confirmPassword) {
          throw new Error('两次密码不一致');
        }
        await onRegister({
          email: email.trim(),
          password,
          confirmPassword,
          displayName: displayName.trim(),
        });
      } else {
        // forgot
        if (forgotStep === 1) {
          if (!email.trim()) throw new Error('请填写邮箱');
          await onForgotPassword({ email: email.trim() });
          setInfo('验证码已发送至该邮箱，10 分钟内有效。请在未收到时检查垃圾邮件箱。');
          setForgotStep(2);
          setResendCooldown(60);
        } else {
          if (!email.trim()) throw new Error('请填写邮箱');
          if (!/^\d{6}$/.test(code.trim())) throw new Error('请输入 6 位数字验证码');
          if (newPassword.length < 6) throw new Error('新密码至少 6 位');
          if (newPassword !== confirmNewPassword) throw new Error('两次新密码不一致');
          await onResetPassword({
            email: email.trim(),
            code: code.trim(),
            newPassword,
          });
          setInfo('密码已重置，请使用新密码登录。');
          // 切回登录态，保留邮箱，清空密码与验证码字段
          setMode('login');
          setForgotStep(1);
          setCode('');
          setNewPassword('');
          setConfirmNewPassword('');
          setPassword('');
          setConfirmPassword('');
        }
      }
    } catch (err: any) {
      setError(err.message || '操作失败');
    } finally {
      setLoading(false);
    }
  }

  function switchMode(m: Mode) {
    setMode(m);
    setError('');
    setInfo('');
    setPassword('');
    setConfirmPassword('');
    if (m !== 'forgot') {
      setForgotStep(1);
      setCode('');
      setNewPassword('');
      setConfirmNewPassword('');
    }
  }

  async function resendCode() {
    if (resendCooldown > 0 || loading) return;
    setError('');
    setInfo('');
    setLoading(true);
    try {
      if (!email.trim()) throw new Error('请填写邮箱');
      await onForgotPassword({ email: email.trim() });
      setInfo('验证码已重新发送，10 分钟内有效。');
      setResendCooldown(60);
    } catch (err: any) {
      setError(err.message || '发送失败');
    } finally {
      setLoading(false);
    }
  }

  const submitLabel = loading
    ? '处理中...'
    : mode === 'login'
      ? '登录'
      : mode === 'register'
        ? '注册并登录'
        : forgotStep === 1
          ? '发送验证码'
          : '重置密码';

  return (
    <div className="xai-login-wrap">
      <form className="xai-login-card" onSubmit={submit}>
        <div className="xai-login-logo">xAI IDE</div>
        <h1 className="xai-login-title">
          {mode === 'login' ? '登录' : mode === 'register' ? '注册新账号' : '重置密码'}
        </h1>
        <p className="xai-login-sub">
          {mode === 'login'
            ? '请输入邮箱与密码登录'
            : mode === 'register'
              ? '填写以下信息创建账号'
              : forgotStep === 1
                ? '输入注册邮箱，我们将发送验证码'
                : '输入收到的验证码与新密码'}
        </p>

        <label className="xai-login-field">
          <span>邮箱</span>
          <input
            type="email"
            value={email}
            onChange={e => setEmail(e.target.value)}
            autoComplete="email"
            required
            autoFocus
          />
        </label>

        {mode === 'register' && (
          <label className="xai-login-field">
            <span>用户姓名</span>
            <input
              type="text"
              value={displayName}
              onChange={e => setDisplayName(e.target.value)}
              autoComplete="name"
              required
            />
          </label>
        )}

        {mode === 'login' && (
          <label className="xai-login-field">
            <span>密码</span>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
          </label>
        )}

        {mode === 'register' && (
          <>
            <label className="xai-login-field">
              <span>密码</span>
              <input
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                autoComplete="new-password"
                required
              />
            </label>
            <label className="xai-login-field">
              <span>确认密码</span>
              <input
                type="password"
                value={confirmPassword}
                onChange={e => setConfirmPassword(e.target.value)}
                autoComplete="new-password"
                required
              />
            </label>
          </>
        )}

        {mode === 'forgot' && forgotStep === 2 && (
          <>
            <label className="xai-login-field">
              <span>验证码</span>
              <input
                type="text"
                inputMode="numeric"
                maxLength={6}
                value={code}
                onChange={e => setCode(e.target.value.replace(/\D/g, ''))}
                placeholder="6 位数字验证码"
                autoComplete="one-time-code"
                required
                autoFocus
              />
            </label>
            <label className="xai-login-field">
              <span>新密码</span>
              <input
                type="password"
                value={newPassword}
                onChange={e => setNewPassword(e.target.value)}
                autoComplete="new-password"
                required
              />
            </label>
            <label className="xai-login-field">
              <span>确认新密码</span>
              <input
                type="password"
                value={confirmNewPassword}
                onChange={e => setConfirmNewPassword(e.target.value)}
                autoComplete="new-password"
                required
              />
            </label>
            <div className="xai-login-switch" style={{ justifyContent: 'space-between' }}>
              <a onClick={() => switchMode('login')}>返回登录</a>
              <a
                onClick={resendCode}
                style={{ opacity: resendCooldown > 0 || loading ? 0.5 : 1, pointerEvents: resendCooldown > 0 || loading ? 'none' : 'auto' }}
              >
                {resendCooldown > 0 ? `${resendCooldown}s 后可重发` : '重新发送验证码'}
              </a>
            </div>
          </>
        )}

        {error && <div className="xai-login-error">{error}</div>}
        {info && <div className="xai-login-info">{info}</div>}

        <button type="submit" className="xai-login-btn" disabled={loading}>
          {submitLabel}
        </button>

        {mode === 'forgot' && forgotStep === 1 && (
          <div className="xai-login-switch">
            <a onClick={() => switchMode('login')}>返回登录</a>
          </div>
        )}

        <div className="xai-login-switch">
          {mode === 'login' ? (
            <>
              <span>还没有账号？<a onClick={() => switchMode('register')}>立即注册</a></span>
              <a onClick={() => switchMode('forgot')}>忘记密码？</a>
            </>
          ) : mode === 'register' ? (
            <span>已有账号？<a onClick={() => switchMode('login')}>返回登录</a></span>
          ) : null}
        </div>
      </form>
    </div>
  );
}
