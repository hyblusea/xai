import { useState, useCallback, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X, Shield, UserPlus, Trash2, Search } from 'lucide-react';
import { IPCChannel } from '@xai/shared';
import type { FolderPermission, FolderPermissionGrant, ProjectRole, ProjectMember } from '@xai/shared';

interface FolderPermissionDialogProps {
  projectId: string;
  folderPath: string;
  folderName: string;
  /** 当前用户在该项目中的角色,决定是否可授权。 */
  currentRole: ProjectRole;
  onClose: () => void;
}

interface SearchUser {
  id: number;
  email: string;
  displayName: string;
}

export default function FolderPermissionDialog({
  projectId,
  folderPath,
  folderName,
  currentRole,
  onClose,
}: FolderPermissionDialogProps) {
  const [permissions, setPermissions] = useState<FolderPermissionGrant[]>([]);
  const [members, setMembers] = useState<ProjectMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // 左侧筛选关键字（本地过滤）
  const [filterKeyword, setFilterKeyword] = useState('');
  // 每个待授权成员独立的权限选择（按 userId 索引），避免共享状态导致改一人全员同步变化
  const [grantPerms, setGrantPerms] = useState<Record<number, FolderPermission>>({});
  const getGrantPerm = (userId: number) => grantPerms[userId] ?? 'READ';
  const setGrantPerm = (userId: number, perm: FolderPermission) =>
    setGrantPerms(prev => (prev[userId] === perm ? prev : { ...prev, [userId]: perm }));
  const [submittingId, setSubmittingId] = useState<number | null>(null);
  const [actionError, setActionError] = useState('');

  const canManage = currentRole === 'OWNER' || currentRole === 'ADMIN';

  const loadPermissions = useCallback(async () => {
    try {
      const result = await window.electronAPI.invoke(IPCChannel.DesignerListFolderPermissions, {
        projectId,
        folderPath,
      }) as { success: boolean; permissions?: FolderPermissionGrant[]; error?: string };
      if (result.success && result.permissions) {
        setPermissions(result.permissions);
      } else if (result.error) {
        setError(result.error);
      }
    } catch (err) {
      setError(String(err));
    }
  }, [projectId, folderPath]);

  const loadMembers = useCallback(async () => {
    try {
      const result = await window.electronAPI.invoke(IPCChannel.DesignerListMembers, projectId) as { success: boolean; members?: ProjectMember[]; error?: string };
      if (result.success && result.members) {
        setMembers(result.members);
      } else if (result.error) {
        setError(result.error);
      }
    } catch (err) {
      setError(String(err));
    }
  }, [projectId]);

  useEffect(() => {
    (async () => {
      setLoading(true);
      await Promise.all([loadPermissions(), loadMembers()]);
      setLoading(false);
    })();
  }, [loadPermissions, loadMembers]);

  const handleGrant = useCallback(async (userId: number, permission: FolderPermission) => {
    setSubmittingId(userId);
    setActionError('');
    try {
      const result = await window.electronAPI.invoke(IPCChannel.DesignerGrantFolderPermission, {
        projectId,
        folderPath,
        userId,
        permission,
      }) as { success: boolean; error?: string };
      if (result.success) {
        await loadPermissions();
      } else {
        setActionError(result.error || '授权失败');
      }
    } catch (err) {
      setActionError(String(err));
    } finally {
      setSubmittingId(null);
    }
  }, [projectId, folderPath, loadPermissions]);

  const handleRevoke = useCallback(async (userId: number) => {
    setActionError('');
    try {
      const result = await window.electronAPI.invoke(IPCChannel.DesignerRevokeFolderPermission, {
        projectId,
        folderPath,
        userId,
      }) as { success: boolean; error?: string };
      if (!result.success) {
        setActionError(result.error || '撤销权限失败');
        return;
      }
      await loadPermissions();
    } catch (err) {
      setActionError(String(err));
    }
  }, [projectId, folderPath, loadPermissions]);

  const permLabel = (p: FolderPermission) => p === 'WRITE' ? '可编辑' : '只读';

  // 左侧：项目成员中尚未被授予目录权限的用户（本地过滤）
  const grantedUserIds = new Set(permissions.map(p => p.userId));
  const kw = filterKeyword.trim().toLowerCase();
  const filteredMembers = members.filter(m => {
    if (grantedUserIds.has(m.userId)) return false;
    if (!kw) return true;
    return m.email.toLowerCase().includes(kw) || m.displayName.toLowerCase().includes(kw);
  });

  return createPortal(
    <div className="designer-dialog-overlay" onClick={onClose}>
      <div className="designer-dialog designer-team-dialog" onClick={e => e.stopPropagation()}>
        <div className="designer-dialog-header">
          <span className="designer-dialog-title">
            <Shield size={14} />
            目录权限 — {folderName}
          </span>
          <button className="designer-dialog-close" onClick={onClose}>
            <X size={14} />
          </button>
        </div>
        <div className="designer-dialog-body designer-team-body">
          <div className="designer-team-folder-path">路径: {folderPath || '(根目录)'}</div>
          {error && <div className="designer-team-error">{error}</div>}
          {actionError && <div className="designer-team-error">{actionError}</div>}

          <div className="designer-team-columns">
            {/* 左侧：所有项目成员（可按邮箱/姓名过滤） */}
            <div className="designer-team-col">
              <div className="designer-team-col-head">
                <span className="designer-team-col-title">项目成员</span>
                <div className="designer-team-search">
                  <Search size={12} />
                  <input
                    className="designer-team-search-input"
                    placeholder="按邮箱/姓名过滤"
                    value={filterKeyword}
                    onChange={e => setFilterKeyword(e.target.value)}
                  />
                </div>
              </div>
              <div className="designer-team-col-list">
                {loading ? (
                  <div className="designer-team-empty">加载中…</div>
                ) : filteredMembers.length === 0 ? (
                  <div className="designer-team-empty">{kw ? '无匹配成员' : '所有成员均已授权'}</div>
                ) : (
                  filteredMembers.map(m => (
                    <div key={m.userId} className="designer-team-user-row">
                      <div className="designer-team-user-info">
                        <span className="designer-team-user-name">{m.displayName}</span>
                        <span className="designer-team-user-email">{m.email}</span>
                      </div>
                      {canManage ? (
                        <>
                          <select
                            className="designer-team-role-select sm"
                            value={getGrantPerm(m.userId)}
                            onChange={e => setGrantPerm(m.userId, e.target.value as FolderPermission)}
                            onClick={e => e.stopPropagation()}
                          >
                            <option value="READ">只读</option>
                            <option value="WRITE">可编辑</option>
                          </select>
                          <button
                            className="designer-team-add-btn"
                            title="授予目录权限"
                            disabled={submittingId === m.userId}
                            onClick={() => handleGrant(m.userId, getGrantPerm(m.userId))}
                          >
                            <UserPlus size={12} />
                          </button>
                        </>
                      ) : null}
                    </div>
                  ))
                )}
              </div>
            </div>

            {/* 右侧：已有目录权限的用户 */}
            <div className="designer-team-col">
              <div className="designer-team-col-head">
                <span className="designer-team-col-title">已授权 ({permissions.length})</span>
              </div>
              <div className="designer-team-col-list">
                {loading ? (
                  <div className="designer-team-empty">加载中…</div>
                ) : permissions.length === 0 ? (
                  <div className="designer-team-empty">暂无显式授权</div>
                ) : (
                  permissions.map(p => (
                    <div key={p.userId} className="designer-team-member">
                      <div className="designer-team-member-info">
                        <span className="designer-team-member-name">{p.displayName}</span>
                        <span className="designer-team-member-email">{p.email}</span>
                      </div>
                      <div className="designer-team-member-actions">
                        <span className={`designer-team-role-badge ${p.permission === 'WRITE' ? 'write' : ''}`}>
                          {permLabel(p.permission)}
                        </span>
                        {canManage && (
                          <button
                            className="designer-team-remove-btn"
                            title="撤销权限"
                            onClick={() => handleRevoke(p.userId)}
                          >
                            <Trash2 size={12} />
                          </button>
                        )}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>

          {!canManage && (
            <div className="designer-team-hint">
              <Shield size={11} />
              仅项目管理员可管理目录权限
            </div>
          )}
        </div>
        <div className="designer-dialog-footer">
          <button className="designer-dialog-btn cancel" onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}