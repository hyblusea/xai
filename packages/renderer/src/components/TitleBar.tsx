import { useState, useEffect, useRef, useCallback } from 'react';
import { Minus, Square, X, Copy, FolderOpen, Settings, Info, Maximize2, RotateCcw, FileText, Code2, Palette, LogOut, User, Edit3, Check } from 'lucide-react';
import type { ViewMode, IdeUser, ChangePasswordRequest, UpdateProfileRequest, CodeViewTheme } from '@xai/shared';
import ProfileEditor from './ProfileEditor';

interface MenuItemDef {
  label: string;
  accelerator?: string;
  action?: () => void;
  separator?: boolean;
  enabled?: boolean;
  /** 为 true 时在下拉项左侧显示勾选标记，用于表示当前生效的选项（如皮肤）。 */
  checked?: boolean;
}

interface MenuDef {
  label: string;
  items: MenuItemDef[];
}

interface TitleBarProps {
  onOpenSettings?: () => void;
  onWorkspaceChanged?: (path: string) => void;
  onOpenBrowser?: (url?: string) => void;
  viewMode?: ViewMode;
  onViewModeChange?: (mode: ViewMode) => void;
  /** Code 视图当前皮肤主题（仅 Code 视图生效，Designer 不受影响）。 */
  codeViewTheme?: CodeViewTheme;
  /** 切换 Code 视图皮肤主题。 */
  onCodeViewThemeChange?: (theme: CodeViewTheme) => void;
  /** 当前登录用户，已登录时在右侧标题栏显示用户信息与注销按钮 */
  user?: IdeUser | null;
  /** 注销登录回调 */
  onLogout?: () => void;
  /** 修改密码回调 */
  onChangePassword?: (req: ChangePasswordRequest) => Promise<void>;
  /** 更新个人信息回调 */
  onUpdateProfile?: (req: UpdateProfileRequest) => Promise<IdeUser>;
}

export default function TitleBar({ onOpenSettings, onWorkspaceChanged, onOpenBrowser, viewMode = 'code', onViewModeChange, codeViewTheme = 'dark', onCodeViewThemeChange, user, onLogout, onChangePassword, onUpdateProfile }: TitleBarProps) {
  const [activeMenu, setActiveMenu] = useState<number | null>(null);
  const [isMaximized, setIsMaximized] = useState(false);
  const [showPrompt, setShowPrompt] = useState(false);
  const [promptContent, setPromptContent] = useState('');
  const [promptLoading, setPromptLoading] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [showProfileEditor, setShowProfileEditor] = useState(false);
  const menuBarRef = useRef<HTMLDivElement>(null);
  const userMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleMaximizeChange = () => {
      setIsMaximized(!!window.electronAPI && document.title.includes('XAI'));
    };
    // Poll for maximize state (no direct IPC for this in our current setup)
    const interval = setInterval(async () => {
      try {
        // We'll use a simple heuristic based on screen size
      } catch {}
    }, 500);
    return () => clearInterval(interval);
  }, []);

  // Close menu on click outside
  useEffect(() => {
    if (activeMenu === null && !userMenuOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (menuBarRef.current && !menuBarRef.current.contains(e.target as Node)) {
        setActiveMenu(null);
      }
      if (userMenuRef.current && !userMenuRef.current.contains(e.target as Node)) {
        setUserMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [activeMenu, userMenuOpen]);

  const handleLogout = useCallback(() => {
    setUserMenuOpen(false);
    onLogout?.();
  }, [onLogout]);

  const handleMinimize = useCallback(() => {
    window.electronAPI?.send('window:minimize');
  }, []);

  const handleMaximize = useCallback(() => {
    window.electronAPI?.send('window:maximize');
    setIsMaximized(prev => !prev);
  }, []);

  const handleClose = useCallback(() => {
    window.electronAPI?.send('window:close');
  }, []);

  const menus: MenuDef[] = [
    {
      label: '文件',
      items: [
        {
          label: '打开工作区...',
          accelerator: 'Ctrl+Shift+O',
          action: async () => {
            setActiveMenu(null);
            const result = await window.electronAPI.invoke('workspace:open') as string | null;
            if (result) {
              onWorkspaceChanged?.(result);
            }
          },
        },
        {
          label: '关闭工作区',
          action: async () => {
            setActiveMenu(null);
            await window.electronAPI.invoke('workspace:info', '');
            onWorkspaceChanged?.('');
          },
        },
        { separator: true, label: '' },
        {
          label: '打开浏览器',
          accelerator: 'Ctrl+Shift+B',
          action: () => {
            setActiveMenu(null);
            onOpenBrowser?.();
          },
        },
        { separator: true, label: '' },
        {
          label: '查看提示词...',
          action: async () => {
            setActiveMenu(null);
            setPromptLoading(true);
            setShowPrompt(true);
            try {
              const result = await window.electronAPI.invoke('menu:get-system-prompt', { viewMode }) as { success: boolean; prompt?: string; error?: string };
              if (result.success && result.prompt) {
                setPromptContent(result.prompt);
              } else {
                setPromptContent('获取提示词失败: ' + (result.error || '未知错误'));
              }
            } catch (err) {
              setPromptContent('获取提示词失败: ' + String(err));
            } finally {
              setPromptLoading(false);
            }
          },
        },
        {
          label: '设置...',
          accelerator: 'Ctrl+,',
          action: () => {
            setActiveMenu(null);
            onOpenSettings?.();
          },
        },
        { separator: true, label: '' },
        {
          label: '退出',
          accelerator: 'Ctrl+Q',
          action: () => {
            window.electronAPI?.send('window:close');
          },
        },
      ],
    },
    {
      label: '视图',
      items: [
        {
          label: '开发者工具',
          accelerator: 'Ctrl+Shift+I',
          action: async () => {
            setActiveMenu(null);
            try {
              await window.electronAPI.invoke('menu:toggle-devtools');
            } catch {}
          },
        },
        { separator: true, label: '' },
        {
          label: '全屏',
          accelerator: 'F11',
          action: () => {
            setActiveMenu(null);
            window.electronAPI?.send('window:fullscreen');
          },
        },
        // Code 视图皮肤切换：仅 Code 视图显示，Designer 视图不显示（Designer 始终深色）。
        ...(onCodeViewThemeChange && viewMode === 'code' ? ([
          { separator: true, label: '' },
          {
            label: '浅色',
            checked: codeViewTheme === 'light',
            action: () => {
              setActiveMenu(null);
              onCodeViewThemeChange('light');
            },
          },
          {
            label: '深色',
            checked: codeViewTheme === 'dark',
            action: () => {
              setActiveMenu(null);
              onCodeViewThemeChange('dark');
            },
          },
        ] as MenuItemDef[]) : []),
      ],
    },
    {
      label: '帮助',
      items: [
        {
          label: '关于 X-AI',
          action: async () => {
            setActiveMenu(null);
            try {
              await window.electronAPI.invoke('menu:show-about');
            } catch {}
          },
        },
      ],
    },
  ];

  return (
    <div className="title-bar">
      <div className="title-bar-drag">
        <div className="title-bar-brand">
          <span className="title-bar-icon">X</span>
          <span className="title-bar-text">X-AI</span>
        </div>

        {/* Stitch View Switcher */}
        {onViewModeChange && (
          <div className="title-bar-view-switch">
            <button
              className={`title-bar-view-btn ${viewMode === 'code' ? 'active' : ''}`}
              onClick={() => onViewModeChange('code')}
              title="Code 视图"
            >
              <Code2 size={12} />
              Code
            </button>
            <button
              className={`title-bar-view-btn ${viewMode === 'designer' ? 'active' : ''}`}
              onClick={() => onViewModeChange('designer')}
              title="Designer 视图 (Designer)"
            >
              <Palette size={12} />
              Designer
            </button>
          </div>
        )}

        <div className="title-bar-menu" ref={menuBarRef}>
          {menus.map((menu, menuIdx) => (
            <div
              key={menu.label}
              className={`title-bar-menu-item ${activeMenu === menuIdx ? 'active' : ''}`}
              onMouseDown={(e) => {
                e.preventDefault();
                setActiveMenu(activeMenu === menuIdx ? null : menuIdx);
              }}
              onMouseEnter={() => {
                if (activeMenu !== null) setActiveMenu(menuIdx);
              }}
            >
              <span className="title-bar-menu-label">{menu.label}</span>
              {activeMenu === menuIdx && (
                <div className="title-bar-dropdown">
                  {menu.items.map((item, itemIdx) =>
                    item.separator ? (
                      <div key={itemIdx} className="title-bar-dropdown-separator" />
                    ) : (
                      <div
                        key={item.label}
                        className={`title-bar-dropdown-item ${item.enabled === false ? 'disabled' : ''}`}
                        onMouseDown={(e) => {
                          e.stopPropagation();
                          if (item.enabled !== false) item.action?.();
                        }}
                      >
                        <span className="dropdown-item-label">{item.label}</span>
                        {item.accelerator && (
                          <span className="dropdown-item-accelerator">{item.accelerator}</span>
                        )}
                        {item.checked && (
                          <Check size={12} style={{ color: 'var(--accent)', flexShrink: 0 }} />
                        )}
                      </div>
                    ),
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      <div className="title-bar-controls">
        {user && (
          <div className="title-bar-user" ref={userMenuRef}>
            <button
              className="title-bar-user-btn"
              onClick={() => setUserMenuOpen(v => !v)}
              title={user.email}
            >
              <span className="title-bar-user-avatar">
                <User size={12} />
              </span>
              <span className="title-bar-user-name">{user.displayName || user.email}</span>
            </button>
            {userMenuOpen && (
              <div className="title-bar-user-menu">
                <div className="title-bar-user-menu-header">
                  <div className="title-bar-user-menu-name">{user.displayName || '—'}</div>
                  <div className="title-bar-user-menu-email">{user.email}</div>
                </div>
                <div className="title-bar-dropdown-separator" />
                <div
                  className="title-bar-dropdown-item"
                  onMouseDown={(e) => {
                    e.stopPropagation();
                    setUserMenuOpen(false);
                    setShowProfileEditor(true);
                  }}
                >
                  <span className="dropdown-item-label" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <Edit3 size={12} /> 编辑
                  </span>
                </div>
                <div
                  className="title-bar-dropdown-item"
                  onMouseDown={(e) => {
                    e.stopPropagation();
                    handleLogout();
                  }}
                >
                  <span className="dropdown-item-label" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <LogOut size={12} /> 注销登录
                  </span>
                </div>
              </div>
            )}
          </div>
        )}
        <button className="title-bar-control minimize" onClick={handleMinimize}>
          <Minus size={14} />
        </button>
        <button className="title-bar-control maximize" onClick={handleMaximize}>
          {isMaximized ? <Copy size={13} /> : <Square size={12} />}
        </button>
        <button className="title-bar-control close" onClick={handleClose}>
          <X size={14} />
        </button>
      </div>

      {showPrompt && (
        <div className="prompt-viewer-overlay" onClick={() => setShowPrompt(false)}>
          <div className="prompt-viewer" onClick={e => e.stopPropagation()}>
            <div className="prompt-viewer-header">
              <span className="prompt-viewer-title"><FileText size={14} /> 系统提示词</span>
              <button className="prompt-viewer-close" onClick={() => setShowPrompt(false)}>
                <X size={14} />
              </button>
            </div>
            <div className="prompt-viewer-body">
              {promptLoading ? (
                <div className="prompt-viewer-loading">加载中...</div>
              ) : (
                <pre className="prompt-viewer-content">{promptContent.split('\n').map((line, i) => (
                  <div key={i} className="prompt-line">
                    <span className="prompt-line-number">{i + 1}</span>
                    <span className="prompt-line-text">{line}</span>
                  </div>
                ))}</pre>
              )}
            </div>
            <div className="prompt-viewer-footer">
              <button
                className="prompt-viewer-copy-btn"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(promptContent);
                  } catch {}
                }}
              >
                <Copy size={12} /> 复制
              </button>
            </div>
          </div>
        </div>
      )}

      {showProfileEditor && user && onChangePassword && onUpdateProfile && (
        <ProfileEditor
          user={user}
          onClose={() => setShowProfileEditor(false)}
          onChangePassword={onChangePassword}
          onUpdateProfile={onUpdateProfile}
        />
      )}
    </div>
  );
}
