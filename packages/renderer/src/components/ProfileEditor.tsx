/**
 * 个人信息编辑弹窗：修改 displayName 与修改密码。
 */
import { useState } from 'react';
import { X, Save, Lock, User } from 'lucide-react';
import type { IdeUser, ChangePasswordRequest, UpdateProfileRequest } from '@xai/shared';

interface ProfileEditorProps {
  user: IdeUser;
  onClose: () => void;
  onChangePassword: (req: ChangePasswordRequest) => Promise<void>;
  onUpdateProfile: (req: UpdateProfileRequest) => Promise<IdeUser>;
}

export default function ProfileEditor({ user, onClose, onChangePassword, onUpdateProfile }: ProfileEditorProps) {
  const [displayName, setDisplayName] = useState(user.displayName || '');
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmNewPassword, setConfirmNewPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [successMsg, setSuccessMsg] = useState('');

  async function handleSaveProfile() {
    setError('');
    setSuccessMsg('');
    if (!displayName.trim()) {
      setError('用户姓名不能为空');
      return;
    }
    setSaving(true);
    try {
      await onUpdateProfile({ displayName: displayName.trim() });
      setSuccessMsg('姓名更新成功');
    } catch (err: any) {
      setError(err.message || '更新失败');
    } finally {
      setSaving(false);
    }
  }

  async function handleChangePassword() {
    setError('');
    setSuccessMsg('');
    if (!oldPassword) {
      setError('请输入当前密码');
      return;
    }
    if (!newPassword || newPassword.length < 6) {
      setError('新密码至少 6 位');
      return;
    }
    if (newPassword !== confirmNewPassword) {
      setError('两次新密码不一致');
      return;
    }
    setSaving(true);
    try {
      await onChangePassword({ oldPassword, newPassword });
      setOldPassword('');
      setNewPassword('');
      setConfirmNewPassword('');
      setSuccessMsg('密码修改成功');
    } catch (err: any) {
      setError(err.message || '修改密码失败');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="profile-editor-overlay" onClick={onClose}>
      <div className="profile-editor" onClick={e => e.stopPropagation()}>
        <div className="profile-editor-header">
          <span className="profile-editor-title">
            <User size={14} /> 个人信息编辑
          </span>
          <button className="profile-editor-close" onClick={onClose}>
            <X size={14} />
          </button>
        </div>

        <div className="profile-editor-body">
          {error && <div className="profile-editor-error">{error}</div>}
          {successMsg && <div className="profile-editor-success">{successMsg}</div>}

          {/* 基本信息 */}
          <div className="profile-editor-section">
            <div className="profile-editor-section-title">基本信息</div>
            <div className="profile-editor-field">
              <label>邮箱</label>
              <input
                type="email"
                value={user.email}
                disabled
                className="profile-editor-input profile-editor-input-disabled"
              />
            </div>
            <div className="profile-editor-field">
              <label>用户姓名</label>
              <div className="profile-editor-input-row">
                <input
                  type="text"
                  value={displayName}
                  onChange={e => setDisplayName(e.target.value)}
                  placeholder="输入您的姓名"
                  className="profile-editor-input"
                />
                <button
                  className="profile-editor-btn"
                  onClick={handleSaveProfile}
                  disabled={saving || displayName === user.displayName}
                >
                  <Save size={12} /> 保存
                </button>
              </div>
            </div>
          </div>

          <div className="profile-editor-divider" />

          {/* 修改密码 */}
          <div className="profile-editor-section">
            <div className="profile-editor-section-title">
              <Lock size={12} /> 修改密码
            </div>
            <div className="profile-editor-field">
              <label>当前密码</label>
              <input
                type="password"
                value={oldPassword}
                onChange={e => setOldPassword(e.target.value)}
                placeholder="输入当前密码"
                className="profile-editor-input"
                autoComplete="current-password"
              />
            </div>
            <div className="profile-editor-field">
              <label>新密码</label>
              <input
                type="password"
                value={newPassword}
                onChange={e => setNewPassword(e.target.value)}
                placeholder="至少 6 位"
                className="profile-editor-input"
                autoComplete="new-password"
              />
            </div>
            <div className="profile-editor-field">
              <label>确认新密码</label>
              <input
                type="password"
                value={confirmNewPassword}
                onChange={e => setConfirmNewPassword(e.target.value)}
                placeholder="再次输入新密码"
                className="profile-editor-input"
                autoComplete="new-password"
              />
            </div>
            <button
              className="profile-editor-btn profile-editor-btn-primary"
              onClick={handleChangePassword}
              disabled={saving}
            >
              <Lock size={12} /> 修改密码
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
