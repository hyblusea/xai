import { useState, useCallback, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X, Users, UserPlus, Trash2, Search } from 'lucide-react';
import { IPCChannel } from '@xai/shared';
import type { ProjectMember, ProjectRole } from '@xai/shared';

interface TeamManagementDialogProps {
  projectId: string;
  projectName: string;
  /** 当前用户在该项目中的角色,用于决定可执行操作。 */
  currentRole: ProjectRole;
  onClose: () => void;
}

interface SearchUser {
  id: number;
  email: string;
  displayName: string;
}

export default function TeamManagementDialog({ projectId, projectName, currentRole, onClose }: TeamManagementDialogProps) {
  const [members, setMembers] = useState<ProjectMember[]>([]);
  const [allUsers, setAllUsers] = useState<SearchUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // 左侧筛选关键字（按邮箱/姓名模糊过滤，本地过滤）
  const [filterKeyword, setFilterKeyword] = useState('');
  // 每个待添加用户独立的角色选择（按 userId 索引），避免共享状态导致改一人全员同步变化
  const [newRoles, setNewRoles] = useState<Record<number, ProjectRole>>({});
  const getNewRole = (userId: number) => newRoles[userId] ?? 'MEMBER';
  const setNewRole = (userId: number, role: ProjectRole) =>
    setNewRoles(prev => (prev[userId] === role ? prev : { ...prev, [userId]: role }));
  const [submittingId, setSubmittingId] = useState<number | null>(null);
  const [actionError, setActionError] = useState('');

  const canManage = currentRole === 'OWNER' || currentRole === 'ADMIN';

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

  const loadAllUsers = useCallback(async () => {
    // 关键字为空时后端返回所有启用用户
    try {
      const result = await window.electronAPI.invoke(IPCChannel.DesignerSearchUsers, '') as { success: boolean; users?: SearchUser[] };
      if (result.success && result.users) {
        setAllUsers(result.users);
      }
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    (async () => {
      setLoading(true);
      await Promise.all([loadMembers(), loadAllUsers()]);
      setLoading(false);
    })();
  }, [loadMembers, loadAllUsers]);

  const handleAddMember = useCallback(async (user: SearchUser, role: ProjectRole) => {
    setSubmittingId(user.id);
    setActionError('');
    try {
      const result = await window.electronAPI.invoke(IPCChannel.DesignerAddMember, {
        projectId,
        email: user.email,
        role,
      }) as { success: boolean; error?: string };
      if (result.success) {
        await loadMembers();
      } else {
        setActionError(result.error || '添加失败');
      }
    } catch (err) {
      setActionError(String(err));
    } finally {
      setSubmittingId(null);
    }
  }, [projectId, loadMembers]);

  const handleChangeRole = useCallback(async (userId: number, role: ProjectRole) => {
    setActionError('');
    try {
      const result = await window.electronAPI.invoke(IPCChannel.DesignerUpdateMemberRole, {
        projectId,
        userId,
        role,
      }) as { success: boolean; error?: string };
      if (!result.success) {
        setActionError(result.error || '修改角色失败');
        return;
      }
      await loadMembers();
    } catch (err) {
      setActionError(String(err));
    }
  }, [projectId, loadMembers]);

  const handleRemoveMember = useCallback(async (userId: number) => {
    setActionError('');
    try {
      const result = await window.electronAPI.invoke(IPCChannel.DesignerRemoveMember, {
        projectId,
        userId,
      }) as { success: boolean; error?: string };
      if (!result.success) {
        setActionError(result.error || '移除成员失败');
        return;
      }
      await loadMembers();
    } catch (err) {
      setActionError(String(err));
    }
  }, [projectId, loadMembers]);

  const roleLabel = (r: ProjectRole) => r === 'OWNER' ? '创建人' : r === 'ADMIN' ? '管理员' : '成员';

  // 左侧：本地按邮箱/姓名模糊过滤；排除已是成员的用户
  const memberIds = new Set(members.map(m => m.userId));
  const kw = filterKeyword.trim().toLowerCase();
  const filteredUsers = allUsers.filter(u => {
    if (memberIds.has(u.id)) return false;
    if (!kw) return true;
    return u.email.toLowerCase().includes(kw) || u.displayName.toLowerCase().includes(kw);
  });

  return createPortal(
    <div className="designer-dialog-overlay" onClick={onClose}>
      <div className="designer-dialog designer-team-dialog" onClick={e => e.stopPropagation()}>
        <div className="designer-dialog-header">
          <span className="designer-dialog-title">
            <Users size={14} />
            团队管理 — {projectName}
          </span>
          <button className="designer-dialog-close" onClick={onClose}>
            <X size={14} />
          </button>
        </div>
        <div className="designer-dialog-body designer-team-body">
          {error && <div className="designer-team-error">{error}</div>}
          {actionError && <div className="designer-team-error">{actionError}</div>}

          <div className="designer-team-columns">
            {/* 左侧：所有人员（可按邮箱/姓名模糊过滤） */}
            <div className="designer-team-col">
              <div className="designer-team-col-head">
                <span className="designer-team-col-title">所有人员</span>
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
                ) : filteredUsers.length === 0 ? (
                  <div className="designer-team-empty">{kw ? '无匹配用户' : '暂无可添加的用户'}</div>
                ) : (
                  filteredUsers.map(u => (
                    <div key={u.id} className="designer-team-user-row">
                      <div className="designer-team-user-info">
                        <span className="designer-team-user-name">{u.displayName}</span>
                        <span className="designer-team-user-email">{u.email}</span>
                      </div>
                      {canManage ? (
                        <>
                          <select
                            className="designer-team-role-select sm"
                            value={getNewRole(u.id)}
                            onChange={e => setNewRole(u.id, e.target.value as ProjectRole)}
                            onClick={e => e.stopPropagation()}
                          >
                            <option value="MEMBER">成员</option>
                            <option value="ADMIN">管理员</option>
                          </select>
                          <button
                            className="designer-team-add-btn"
                            title="添加为成员"
                            disabled={submittingId === u.id}
                            onClick={() => handleAddMember(u, getNewRole(u.id))}
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

            {/* 右侧：已有成员（可移除） */}
            <div className="designer-team-col">
              <div className="designer-team-col-head">
                <span className="designer-team-col-title">项目成员 ({members.length})</span>
              </div>
              <div className="designer-team-col-list">
                {loading ? (
                  <div className="designer-team-empty">加载中…</div>
                ) : members.length === 0 ? (
                  <div className="designer-team-empty">暂无成员</div>
                ) : (
                  members.map(m => (
                    <div key={m.userId} className="designer-team-member">
                      <div className="designer-team-member-info">
                        <span className="designer-team-member-name">{m.displayName}</span>
                        <span className="designer-team-member-email">{m.email}</span>
                      </div>
                      <div className="designer-team-member-actions">
                        {m.role === 'OWNER' ? (
                          <span className="designer-team-role-badge owner">{roleLabel(m.role)}</span>
                        ) : canManage ? (
                          <>
                            <select
                              className="designer-team-role-select sm"
                              value={m.role}
                              onChange={e => handleChangeRole(m.userId, e.target.value as ProjectRole)}
                            >
                              <option value="MEMBER">成员</option>
                              <option value="ADMIN">管理员</option>
                            </select>
                            <button
                              className="designer-team-remove-btn"
                              title="移除成员"
                              onClick={() => handleRemoveMember(m.userId)}
                            >
                              <Trash2 size={12} />
                            </button>
                          </>
                        ) : (
                          <span className="designer-team-role-badge">{roleLabel(m.role)}</span>
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
              <UserPlus size={11} />
              仅项目管理员可管理成员
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
