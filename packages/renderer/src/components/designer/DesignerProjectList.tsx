import { useState, useCallback, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Plus, RefreshCw, Globe, Smartphone, Tablet, FileCode, ChevronRight, Trash2, Pencil, Copy, Check, X, MessageSquare, FolderPlus, Users, Shield, Sliders, Info, History, Upload, Loader2 } from 'lucide-react';
import { IPCChannel } from '@xai/shared';
import type { DesignerProject, ProjectType, ProjectRole } from '@xai/shared';
import FolderTree from './FolderTree';
import TeamManagementDialog from './TeamManagementDialog';
import FolderPermissionDialog from './FolderPermissionDialog';


interface DesignerProjectListProps {
  projects: DesignerProject[];
  currentProjectId: string | null;
  currentScreenId: string | null;
  onSelectProject: (projectId: string) => void;
  onSelectScreen: (projectId: string, screenId: string) => void;
  onCreateProject: (name: string, type: ProjectType, themePrompt?: string) => Promise<void>;
  onDeleteProject: (projectId: string) => Promise<void>;
  onRenameProject: (projectId: string, newName: string) => Promise<void>;
  onSystemDesign?: (projectId: string, projectName: string) => void;
  onDeleteScreen: (projectId: string, screenId: string) => Promise<void>;
  onRenameScreen: (projectId: string, screenId: string, newName: string) => Promise<void>;
  onDuplicateScreen: (projectId: string, screenId: string) => Promise<void>;
  onAddScreenToChat: (projectId: string, screenId: string) => void;
  onShowScreenHistory?: (projectId: string, screenId: string, screenName: string) => void;
  onDeselectScreen: () => void;
  onRefresh: () => Promise<void>;
  onMoveScreen?: (projectId: string, screenId: string, folderPath: string) => Promise<void>;
  onCreateFolder?: (projectId: string, folderPath: string) => Promise<void>;
  onDeleteFolder?: (projectId: string, folderPath: string) => Promise<void>;
  onRenameFolder?: (projectId: string, folderPath: string, newName: string) => Promise<void>;
  onSetHomeScreen?: (projectId: string, screenId: string | null) => Promise<void>;
  onReorderScreen?: (screenId: string, targetScreenId: string, insertBefore: boolean) => Promise<void>;
  onHeaderMouseDown?: (e: React.MouseEvent) => void;
  onCreateProjectClick?: () => void;
  isGenerating?: boolean;
  /** Screen ids with unsaved manual edits (shown as "*" next to file names). */
  dirtyScreenIds?: Set<string>;
  /** 导入 HTML 文件作为新页面，逻辑与新建相同。folderPath 可指定保存到某个文件夹。 */
  onImportHtml?: (html: string, screenName: string, folderPath?: string) => Promise<void>;
}

type ContextMenuType = 'project' | 'screen' | 'folder';

interface ContextMenu {
  x: number;
  y: number;
  type: ContextMenuType;
  projectId: string;
  screenId?: string;
  folderPath?: string;
  folderName?: string;
  /** 右键目标位置（项目根/具体目录）当前用户是否有写权限，用于控制"导入HTML"是否显示。 */
  canWriteTarget?: boolean;
}

/** Loading state keys — one per async operation that needs a loading indicator. */
type LoadingKey =
  | 'refresh'
  | 'deleteProject'
  | 'renameProject'
  | 'deleteScreen'
  | 'renameScreen'
  | 'duplicateScreen'
  | 'setHomeScreen'
  | 'createFolder'
  | 'deleteFolder'
  | 'renameFolder'
  | 'moveScreen'
  | 'reorderScreen'
  | 'importHtml'
  | 'checkPermission';

export default function DesignerProjectList({
  projects,
  currentProjectId,
  currentScreenId,
  onSelectProject,
  onSelectScreen,
  onCreateProject,
  onDeleteProject,
  onRenameProject,
  onSystemDesign,
  onDeleteScreen,
  onRenameScreen,
  onDuplicateScreen,
  onAddScreenToChat,
  onShowScreenHistory,
  onDeselectScreen,
  onRefresh,
  onMoveScreen,
  onCreateFolder,
  onDeleteFolder,
  onRenameFolder,
  onSetHomeScreen,
  onReorderScreen,
  onHeaderMouseDown,
  onCreateProjectClick,
  isGenerating = false,
  dirtyScreenIds,
  onImportHtml,
}: DesignerProjectListProps) {
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(new Set());
  const [contextMenu, setContextMenu] = useState<ContextMenu | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<{ projectId: string; projectName: string } | null>(null);
  const [confirmDeleteFolder, setConfirmDeleteFolder] = useState<{ projectId: string; folderPath: string; folderName: string } | null>(null);
  const [confirmDeleteScreen, setConfirmDeleteScreen] = useState<{ projectId: string; screenId: string; screenName: string } | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [renamingScreenId, setRenamingScreenId] = useState<string | null>(null);
  const [screenRenameValue, setScreenRenameValue] = useState('');
  const [renamingFolderPath, setRenamingFolderPath] = useState<string | null>(null);
  const [folderRenameValue, setFolderRenameValue] = useState('');
  const [teamDialog, setTeamDialog] = useState<{ projectId: string; projectName: string; role: ProjectRole } | null>(null);
  const [folderPermDialog, setFolderPermDialog] = useState<{ projectId: string; folderPath: string; folderName: string; role: ProjectRole } | null>(null);
  const [loadingKeys, setLoadingKeys] = useState<Set<LoadingKey>>(new Set());
  const menuRef = useRef<HTMLDivElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const screenRenameInputRef = useRef<HTMLInputElement>(null);
  const folderRenameInputRef = useRef<HTMLInputElement>(null);
  const importInputRef = useRef<HTMLInputElement>(null);
  const importTargetRef = useRef<{ projectId: string; folderPath?: string } | null>(null);
  const projectListRef = useRef<HTMLDivElement>(null);

  /** Helper: wrap an async operation with loading state. */
  const withLoading = useCallback(<T,>(key: LoadingKey, fn: () => Promise<T>): Promise<T> => {
    setLoadingKeys(prev => new Set(prev).add(key));
    return fn().finally(() => {
      setLoadingKeys(prev => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    });
  }, []);

  /** Check if any loading key is active. */
  const isLoading = useCallback((key: LoadingKey) => loadingKeys.has(key), [loadingKeys]);

  /** Check if ANY loading key is active (for global disable). */
  const isAnyLoading = loadingKeys.size > 0;

  // 打开文件选择对话框，记录目标项目和文件夹路径
  const handleImportClick = useCallback((projectId: string, folderPath?: string) => {
    importTargetRef.current = { projectId, folderPath };
    importInputRef.current?.click();
    setContextMenu(null);
  }, []);

  // 读取选中的 HTML 文件并调用导入回调
  const handleImportFileChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !onImportHtml) return;
    // 重置 input 以便同一文件可再次选择
    e.target.value = '';
    await withLoading('importHtml', async () => {
      try {
        const html = await file.text();
        const screenName = file.name.replace(/\.html?$/i, '') || 'Imported';
        await onImportHtml(html, screenName, importTargetRef.current?.folderPath);
      } catch (err) {
        console.error('[DesignerProjectList] Failed to import HTML file:', err);
      }
    });
  }, [onImportHtml, withLoading]);

  // Close context menu on outside click
  useEffect(() => {
    if (!contextMenu) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setContextMenu(null);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [contextMenu]);

  // Focus rename input when renaming starts
  useEffect(() => {
    if (renamingId) renameInputRef.current?.focus();
  }, [renamingId]);

  useEffect(() => {
    if (renamingScreenId) screenRenameInputRef.current?.focus();
  }, [renamingScreenId]);

  useEffect(() => {
    if (renamingFolderPath) folderRenameInputRef.current?.focus();
  }, [renamingFolderPath]);

  // 切换项目时折叠非当前项目并展开当前项目（覆盖点击切换与新建项目等外部触发的切换）
  useEffect(() => {
    if (!currentProjectId) return;
    setExpandedProjects(prev => {
      if (prev.size === 1 && prev.has(currentProjectId)) return prev;
      return new Set([currentProjectId]);
    });
  }, [currentProjectId]);

  // 当前项目或展开状态变化时，将其滚动到可视区域
  useEffect(() => {
    if (!currentProjectId || !projectListRef.current) return;
    const el = projectListRef.current.querySelector(`[data-project-id="${currentProjectId}"]`);
    if (el) {
      el.scrollIntoView({ block: 'nearest' });
    }
  }, [currentProjectId, expandedProjects]);

  const toggleExpand = useCallback((projectId: string) => {
    setExpandedProjects(prev => {
      const next = new Set(prev);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
  }, []);

  const handleContextMenu = useCallback(async (e: React.MouseEvent, type: ContextMenuType, projectId: string, screenId?: string, folderPath?: string, folderName?: string) => {
    e.preventDefault();
    e.stopPropagation();
    // 计算"导入HTML"所需的写权限：项目根目录仅 OWNER/ADMIN 可写；
    // 子目录按角色/创建者/显式授权综合判断（与后端 PermissionService.canWriteFolder 一致）。
    let canWriteTarget: boolean | undefined;
    if (type === 'project' || type === 'folder') {
      const proj = projects.find(p => p.id === projectId);
      const role = proj?.role;
      if (role === 'OWNER' || role === 'ADMIN') {
        canWriteTarget = true;
      } else if (type === 'project') {
        // 普通成员对项目根目录无写权限
        canWriteTarget = false;
      } else {
        // 普通成员对子目录：查询后端写权限（创建者或被授予 WRITE）
        try {
          const res = await withLoading('checkPermission', async () =>
            window.electronAPI.invoke(IPCChannel.DesignerCheckWritePermission, {
              projectId,
              folderPath,
            }) as Promise<{ success: boolean; canWrite?: boolean }>
          );
          canWriteTarget = !!(res?.success && res?.canWrite);
        } catch {
          canWriteTarget = false;
        }
      }
    }
    setContextMenu({ x: e.clientX, y: e.clientY, type, projectId, screenId, folderPath, folderName, canWriteTarget });
  }, [projects, withLoading]);

  const startRenameProject = useCallback((projectId: string, currentName: string) => {
    setRenamingId(projectId);
    setRenameValue(currentName);
    setContextMenu(null);
  }, []);

  const confirmRenameProject = useCallback(async () => {
    if (renamingId && renameValue.trim()) {
      await withLoading('renameProject', () => onRenameProject(renamingId, renameValue.trim()));
    }
    setRenamingId(null);
  }, [renamingId, renameValue, onRenameProject, withLoading]);

  const startRenameScreen = useCallback((screenId: string, currentName: string) => {
    setRenamingScreenId(screenId);
    setScreenRenameValue(currentName);
    setContextMenu(null);
  }, []);

  const confirmRenameScreen = useCallback(async (projectId: string) => {
    if (renamingScreenId && screenRenameValue.trim()) {
      await withLoading('renameScreen', () => onRenameScreen(projectId, renamingScreenId, screenRenameValue.trim()));
    }
    setRenamingScreenId(null);
  }, [renamingScreenId, screenRenameValue, onRenameScreen, withLoading]);

  const startRenameFolder = useCallback((folderPath: string, currentName: string) => {
    setRenamingFolderPath(folderPath);
    setFolderRenameValue(currentName);
    setContextMenu(null);
  }, []);

  const confirmRenameFolder = useCallback(async (projectId: string) => {
    if (renamingFolderPath && folderRenameValue.trim()) {
      await withLoading('renameFolder', () => onRenameFolder!(projectId, renamingFolderPath, folderRenameValue.trim()));
    }
    setRenamingFolderPath(null);
  }, [renamingFolderPath, folderRenameValue, onRenameFolder, withLoading]);

  const formatDate = (ts: number) => {
    const d = new Date(ts);
    return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
  };

  // Compute context menu position with boundary detection
  const menuStyle: React.CSSProperties = contextMenu
    ? { left: Math.min(contextMenu.x, window.innerWidth - 180), top: Math.min(contextMenu.y, window.innerHeight - 200) }
    : {};

  // Wrap onRefresh with loading
  const handleRefresh = useCallback(() => {
    return withLoading('refresh', () => onRefresh());
  }, [onRefresh, withLoading]);

  // Wrap onCreateFolder with loading
  const handleCreateFolder = useCallback((projectId: string, folderPath: string) => {
    return withLoading('createFolder', () => onCreateFolder!(projectId, folderPath));
  }, [onCreateFolder, withLoading]);

  // Wrap onMoveScreen with loading
  const handleMoveScreen = useCallback((projectId: string, screenId: string, folderPath: string) => {
    return withLoading('moveScreen', () => onMoveScreen!(projectId, screenId, folderPath));
  }, [onMoveScreen, withLoading]);

  // Wrap onReorderScreen with loading
  const handleReorderScreen = useCallback((screenId: string, targetScreenId: string, insertBefore: boolean) => {
    return withLoading('reorderScreen', () => onReorderScreen!(screenId, targetScreenId, insertBefore));
  }, [onReorderScreen, withLoading]);

  return (
    <div className={`designer-sidebar ${isGenerating ? 'is-generating' : ''}`}>
      <div className="designer-sidebar-header" onMouseDown={onHeaderMouseDown}>
        <span className="designer-sidebar-title">Designer 项目</span>
        <div className="designer-sidebar-actions">
          <button className="designer-sidebar-btn" onClick={handleRefresh} title="刷新" disabled={isGenerating || isAnyLoading}>
            <RefreshCw size={12} className={isLoading('refresh') ? 'designer-spin' : ''} />
          </button>
          <button className="designer-sidebar-btn" onClick={onCreateProjectClick} title="新建项目" disabled={isGenerating || isAnyLoading}>
            <Plus size={14} />
          </button>
        </div>
      </div>

      <div className="designer-project-list" ref={projectListRef}>
        {projects.length === 0 && !isLoading('refresh') ? (
          <div className="designer-empty-projects">
            <FileCode size={24} />
            <span>暂无项目</span>
            <span style={{ fontSize: 11 }}>点击 + 创建第一个设计项目</span>
          </div>
        ) : projects.length === 0 && isLoading('refresh') ? (
          <div className="designer-list-loading">
            <Loader2 size={16} className="designer-spin" />
            <span>加载中…</span>
          </div>
        ) : (
          projects.map(project => {
            const isExpanded = expandedProjects.has(project.id);
            const isActive = currentProjectId === project.id;
            const isRenaming = renamingId === project.id;

            return (
              <div key={project.id}>
                <div
                  className={`designer-project-item ${isActive ? 'active' : ''}`}
                  data-project-id={project.id}
                  onClick={() => {
                    onSelectProject(project.id);
                    setExpandedProjects(new Set([project.id]));
                  }}
                  onContextMenu={e => handleContextMenu(e, 'project', project.id)}
                >
                  <div className="designer-project-name">
                    <button
                      type="button"
                      className="designer-project-toggle"
                      onClick={e => {
                        e.stopPropagation();
                        toggleExpand(project.id);
                      }}
                      title={isExpanded ? '折叠' : '展开'}
                    >
                      <ChevronRight
                        size={12}
                        style={{
                          transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
                          transition: 'transform 0.15s',
                        }}
                      />
                    </button>
                    {project.type === 'WEB' ? <Globe size={13} /> : project.type === 'PDA' ? <Tablet size={13} /> : <Smartphone size={13} />}
                    {isRenaming ? (
                    <input
                        ref={renameInputRef}
                        className="designer-rename-input"
                        value={renameValue}
                        onChange={e => setRenameValue(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === 'Enter') confirmRenameProject();
                          if (e.key === 'Escape') setRenamingId(null);
                        }}
                        onBlur={confirmRenameProject}
                        onClick={e => e.stopPropagation()}
                      />
                    ) : (
                      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {project.name}
                      </span>
                    )}
                    {!isRenaming && (
                      <>
                        <span className={`designer-project-type ${project.type === 'APP' ? 'app' : project.type === 'PDA' ? 'pda' : ''}`}>
                          {project.type}
                        </span>
                        <span
                          className="designer-project-info-icon"
                          title={`${project.screenCount ?? project.screens.length} 个页面 · ${formatDate(project.updatedAt)}`}
                          onClick={e => e.stopPropagation()}
                        >
                          <Info size={11} />
                        </span>
                      </>
                    )}
                  </div>
                </div>

                {isExpanded && (
                  <div className="designer-screen-list">
                    <FolderTree
                      screens={project.screens}
                      folders={project.folders}
                      currentScreenId={currentScreenId}
                      onSelectScreen={onSelectScreen}
                      onDeselectScreen={onDeselectScreen}
                      projectId={project.id}
                      onMoveScreen={handleMoveScreen}
                      onReorderScreen={handleReorderScreen}
                      onScreenContextMenu={(e, pid, sid) => handleContextMenu(e, 'screen', pid, sid)}
                      onFolderContextMenu={(e, pid, folderPath, folderName) => handleContextMenu(e, 'folder', pid, undefined, folderPath, folderName)}
                      onCreateFolder={handleCreateFolder}
                      onRenameFolder={onRenameFolder}
                      onRenameScreen={onRenameScreen}
                      renamingFolderPath={renamingFolderPath}
                      renamingScreenId={renamingScreenId}
                      onRenameDone={() => {
                        setRenamingFolderPath(null);
                        setRenamingScreenId(null);
                      }}
                      dirtyScreenIds={dirtyScreenIds}
                      homeScreenId={project.homeScreenId}
                      folderPermissions={project.folderPermissions}
                    />
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* Context Menu */}
      {contextMenu && createPortal(
        <div
          ref={menuRef}
          className="designer-context-menu"
          style={menuStyle}
        >
          {contextMenu.type === 'project' ? (
            <>
              <div
                className="designer-context-item"
                onClick={() => {
                  const proj = projects.find(p => p.id === contextMenu.projectId);
                  if (proj) startRenameProject(proj.id, proj.name);
                }}
              >
                <Pencil size={12} />
                重命名
              </div>
              <div
                className="designer-context-item"
                onClick={() => {
                  const proj = projects.find(p => p.id === contextMenu.projectId);
                  if (proj) {
                    setTeamDialog({
                      projectId: proj.id,
                      projectName: proj.name,
                      role: proj.role || 'MEMBER',
                    });
                  }
                  setContextMenu(null);
                }}
              >
                <Users size={12} />
                团队管理
              </div>
              {projects.find(p => p.id === contextMenu.projectId)?.type !== 'DIAGRAM' && (
              <div
              className="designer-context-item"
              onClick={() => {
              const proj = projects.find(p => p.id === contextMenu.projectId);
              if (proj && onSystemDesign) {
              onSystemDesign(proj.id, proj.name);
              }
              setContextMenu(null);
              }}
              >
              <Sliders size={12} />
              系统设计
              </div>
              )}
              {onImportHtml && contextMenu.canWriteTarget && (
              <div
                className={`designer-context-item ${isLoading('importHtml') ? 'loading' : ''}`}
                onClick={() => handleImportClick(contextMenu.projectId)}
              >
                {isLoading('importHtml') ? <Loader2 size={12} className="designer-spin" /> : <Upload size={12} />}
                导入HTML
              </div>
              )}
              <div
                className="designer-context-item danger"
                onClick={() => {
                  const proj = projects.find(p => p.id === contextMenu.projectId);
                  setConfirmDelete({ projectId: contextMenu.projectId, projectName: proj?.name || '' });
                  setContextMenu(null);
                }}
              >
                <Trash2 size={12} />
                删除项目
              </div>
            </>
          ) : contextMenu.type === 'folder' ? (
            <>
              <div
                className="designer-context-item"
                onClick={() => {
                  if (contextMenu.folderPath && contextMenu.folderName) {
                    startRenameFolder(contextMenu.folderPath, contextMenu.folderName);
                  }
                }}
              >
                <Pencil size={12} />
                重命名
              </div>
              <div
                className="designer-context-item"
                onClick={() => {
                  const proj = projects.find(p => p.id === contextMenu.projectId);
                  if (proj && contextMenu.folderPath && contextMenu.folderName) {
                    setFolderPermDialog({
                      projectId: proj.id,
                      folderPath: contextMenu.folderPath,
                      folderName: contextMenu.folderName,
                      role: proj.role || 'MEMBER',
                    });
                  }
                  setContextMenu(null);
                }}
              >
                <Shield size={12} />
                目录权限
              </div>
              {onImportHtml && contextMenu.canWriteTarget && (
              <div
                className={`designer-context-item ${isLoading('importHtml') ? 'loading' : ''}`}
                onClick={() => handleImportClick(contextMenu.projectId, contextMenu.folderPath)}
              >
                {isLoading('importHtml') ? <Loader2 size={12} className="designer-spin" /> : <Upload size={12} />}
                导入HTML
              </div>
              )}
              <div
                className="designer-context-item danger"
                onClick={() => {
                  if (contextMenu.folderPath && contextMenu.folderName) {
                    setConfirmDeleteFolder({ projectId: contextMenu.projectId, folderPath: contextMenu.folderPath, folderName: contextMenu.folderName });
                  }
                  setContextMenu(null);
                }}
              >
                <Trash2 size={12} />
                删除文件夹
              </div>
            </>
          ) : (
            <>
              <div
                className="designer-context-item"
                onClick={() => {
                  const proj = projects.find(p => p.id === contextMenu.projectId);
                  const scr = proj?.screens.find(s => s.id === contextMenu.screenId);
                  if (scr) startRenameScreen(scr.id, scr.name);
                }}
              >
                <Pencil size={12} />
                重命名
              </div>
              <div
                className={`designer-context-item ${isLoading('duplicateScreen') ? 'loading' : ''}`}
                onClick={async () => {
                  await withLoading('duplicateScreen', () => onDuplicateScreen(contextMenu.projectId, contextMenu.screenId!));
                  setContextMenu(null);
                }}
              >
                {isLoading('duplicateScreen') ? <Loader2 size={12} className="designer-spin" /> : <Copy size={12} />}
                复制页面
              </div>
              {onSetHomeScreen && (() => {
                const proj = projects.find(p => p.id === contextMenu.projectId);
                const isHome = proj?.homeScreenId === contextMenu.screenId;
                return (
                  <div
                    className={`designer-context-item ${isLoading('setHomeScreen') ? 'loading' : ''}`}
                    onClick={async () => {
                      await withLoading('setHomeScreen', () => onSetHomeScreen!(contextMenu.projectId, isHome ? null : contextMenu.screenId!));
                      setContextMenu(null);
                    }}
                  >
                    {isLoading('setHomeScreen') ? <Loader2 size={12} className="designer-spin" /> : <Globe size={12} style={isHome ? { color: 'var(--accent)' } : undefined} />}
                    {isHome ? '取消首页设置' : '设置为首页'}
                  </div>
                );
              })()}
              {onShowScreenHistory && (
                <div
                  className="designer-context-item"
                  onClick={() => {
                    const proj = projects.find(p => p.id === contextMenu.projectId);
                    const scr = proj?.screens.find(s => s.id === contextMenu.screenId);
                    if (scr) {
                      onShowScreenHistory(contextMenu.projectId, scr.id, scr.name);
                    }
                    setContextMenu(null);
                  }}
                >
                  <History size={12} />
                  查看历史版本
                </div>
              )}
              <div
                className="designer-context-item"
                onClick={() => {
                  onAddScreenToChat(contextMenu.projectId, contextMenu.screenId!);
                  setContextMenu(null);
                }}
              >
                <MessageSquare size={12} />
                添加到对话
              </div>
              <div
                className="designer-context-item danger"
                onClick={() => {
                  const proj = projects.find(p => p.id === contextMenu.projectId);
                  const scr = proj?.screens.find(s => s.id === contextMenu.screenId);
                  setConfirmDeleteScreen({ projectId: contextMenu.projectId, screenId: contextMenu.screenId!, screenName: scr?.name || '' });
                  setContextMenu(null);
                }}
              >
                <Trash2 size={12} />
                删除页面
              </div>
            </>
          )}
        </div>,
        document.body
      )}

      {/* Confirm Delete Dialog */}
      {confirmDelete && createPortal(
        <div className="designer-dialog-overlay" onClick={() => { if (!isLoading('deleteProject')) setConfirmDelete(null); }}>
          <div className="designer-dialog designer-dialog-sm" onClick={e => e.stopPropagation()}>
            <div className="designer-dialog-header">
              <span className="designer-dialog-title">确认删除</span>
              <button className="designer-dialog-close" onClick={() => setConfirmDelete(null)} disabled={isLoading('deleteProject')}>
                <X size={14} />
              </button>
            </div>
            <div className="designer-dialog-body">
              <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                确定要删除项目 <strong>"{confirmDelete.projectName}"</strong> 吗？<br />
                所有页面数据将被永久删除。
              </p>
            </div>
            <div className="designer-dialog-footer">
              <button className="designer-dialog-btn cancel" onClick={() => setConfirmDelete(null)} disabled={isLoading('deleteProject')}>取消</button>
              <button
                className="designer-dialog-btn danger"
                disabled={isLoading('deleteProject')}
                onClick={async () => {
                  await withLoading('deleteProject', () => onDeleteProject(confirmDelete.projectId));
                  setConfirmDelete(null);
                }}
              >
                {isLoading('deleteProject') && <Loader2 size={12} className="designer-spin" />}
                删除
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}

      {/* Confirm Delete Folder Dialog */}
      {confirmDeleteFolder && createPortal(
        <div className="designer-dialog-overlay" onClick={() => { if (!isLoading('deleteFolder')) setConfirmDeleteFolder(null); }}>
          <div className="designer-dialog designer-dialog-sm" onClick={e => e.stopPropagation()}>
            <div className="designer-dialog-header">
              <span className="designer-dialog-title">确认删除</span>
              <button className="designer-dialog-close" onClick={() => setConfirmDeleteFolder(null)} disabled={isLoading('deleteFolder')}>
                <X size={14} />
              </button>
            </div>
            <div className="designer-dialog-body">
              <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                确定要删除文件夹 <strong>"{confirmDeleteFolder.folderName}"</strong> 吗？<br />
                仅可删除空文件夹（无子文件夹和页面）。
              </p>
            </div>
            <div className="designer-dialog-footer">
              <button className="designer-dialog-btn cancel" onClick={() => setConfirmDeleteFolder(null)} disabled={isLoading('deleteFolder')}>取消</button>
              <button
                className="designer-dialog-btn danger"
                disabled={isLoading('deleteFolder')}
                onClick={async () => {
                  await withLoading('deleteFolder', () => onDeleteFolder!(confirmDeleteFolder.projectId, confirmDeleteFolder.folderPath));
                  setConfirmDeleteFolder(null);
                }}
              >
                {isLoading('deleteFolder') && <Loader2 size={12} className="designer-spin" />}
                删除
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}

      {/* Confirm Delete Screen Dialog */}
      {confirmDeleteScreen && createPortal(
        <div className="designer-dialog-overlay" onClick={() => { if (!isLoading('deleteScreen')) setConfirmDeleteScreen(null); }}>
          <div className="designer-dialog designer-dialog-sm" onClick={e => e.stopPropagation()}>
            <div className="designer-dialog-header">
              <span className="designer-dialog-title">确认删除</span>
              <button className="designer-dialog-close" onClick={() => setConfirmDeleteScreen(null)} disabled={isLoading('deleteScreen')}>
                <X size={14} />
              </button>
            </div>
            <div className="designer-dialog-body">
              <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                确定要删除页面 <strong>"{confirmDeleteScreen.screenName}"</strong> 吗？<br />
                页面数据将被永久删除。
              </p>
            </div>
            <div className="designer-dialog-footer">
              <button className="designer-dialog-btn cancel" onClick={() => setConfirmDeleteScreen(null)} disabled={isLoading('deleteScreen')}>取消</button>
              <button
                className="designer-dialog-btn danger"
                disabled={isLoading('deleteScreen')}
                onClick={async () => {
                  await withLoading('deleteScreen', () => onDeleteScreen(confirmDeleteScreen.projectId, confirmDeleteScreen.screenId));
                  setConfirmDeleteScreen(null);
                }}
              >
                {isLoading('deleteScreen') && <Loader2 size={12} className="designer-spin" />}
                删除
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}

      {/* 团队管理对话框 */}
      {teamDialog && (
        <TeamManagementDialog
          projectId={teamDialog.projectId}
          projectName={teamDialog.projectName}
          currentRole={teamDialog.role}
          onClose={() => setTeamDialog(null)}
        />
      )}

      {/* 目录权限管理对话框 */}
      {folderPermDialog && (
        <FolderPermissionDialog
          projectId={folderPermDialog.projectId}
          folderPath={folderPermDialog.folderPath}
          folderName={folderPermDialog.folderName}
          currentRole={folderPermDialog.role}
          onClose={() => setFolderPermDialog(null)}
        />
      )}

      {/* 隐藏的文件选择 input，用于导入 HTML */}
      <input
        ref={importInputRef}
        type="file"
        accept=".html,.htm"
        style={{ display: 'none' }}
        onChange={handleImportFileChange}
      />

    </div>
  );
}
