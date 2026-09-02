import { useState, useCallback, useRef, useEffect } from 'react';
import type { AgentState, ConfirmationRequest, ChatTag, ViewMode, CodeViewTheme } from '@xai/shared';
import { IPCChannel } from '@xai/shared';

import FileExplorer from './components/FileExplorer';
import ChatPanel from './components/ChatPanel';
import EditorPanel from './components/EditorPanel';
import ConfirmationDialog from './components/ConfirmationDialog';
import SettingsPanel from './components/SettingsPanel';
import TitleBar from './components/TitleBar';
import ErrorBoundary from './components/ErrorBoundary';
import TerminalPanel from './components/TerminalPanel';
import UpdateNotification from './components/UpdateNotification';
import CaptchaView from './components/CaptchaView';
import DesignerView from './components/designer/DesignerView';
import type { DesignerViewHandle } from './components/designer/DesignerView';
import LoginScreen from './components/LoginScreen';
import { useAgent } from './hooks/useAgent';
import { useAuth } from './hooks/useAuth';
import { refreshToolNames } from './components/chat/toolNamesStore';
import { AlertTriangle } from 'lucide-react';

interface OpenFile {
  path: string;
  content: string;
  modified: boolean;
  externalModified?: boolean;
  line?: number;
  readOnly?: boolean;
  isGitDiff?: boolean;
  isDbQuery?: boolean;
  isTableStructure?: boolean;
  isBrowser?: boolean;
  browserSessionId?: string;
  dbQuery?: {
    connName: string;
    dbType: string;
    jdbcUrl: string;
    username: string;
    password: string;
    schema: string;
    tableName: string;
  };
}

const BINARY_EXTENSIONS = new Set([
  // Images
  'png', 'jpg', 'jpeg', 'gif', 'bmp', 'ico', 'webp', 'avif', 'tiff', 'tif', 'psd', 'raw', 'cr2', 'nef', 'heic', 'heif',
  // Audio
  'mp3', 'wav', 'ogg', 'flac', 'aac', 'wma', 'm4a', 'opus', 'aiff',
  // Video
  'mp4', 'avi', 'mkv', 'mov', 'wmv', 'flv', 'webm', 'm4v', 'mpg', 'mpeg', '3gp',
  // Fonts
  'ttf', 'otf', 'woff', 'woff2', 'eot',
  // Archives
  'zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'lz', 'lzma', 'zst',
  // Documents (binary)
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp',
  // Compiled / binary
  'exe', 'dll', 'so', 'dylib', 'class', 'pyc', 'pyo', 'o', 'obj', 'a', 'lib', 'bin', 'dat', 'db', 'sqlite', 'sqlite3',
  // Other binary
  'iso', 'img', 'dmg', 'whl', 'jar', 'war', 'ear', 'wasm',
]);

function isBinaryFile(filePath: string): boolean {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  return BINARY_EXTENSIONS.has(ext);
}

export default function App() {
  // 登录鉴权：未登录显示登录/注册页，已登录显示 IDE 工作区
  const { user, loading, initialized, login, register, logout, changePassword, updateProfile, forgotPassword, resetPassword } = useAuth();

  /**
   * Process \r (carriage return) as "move to start of current line and overwrite",
   * matching real terminal behavior. Without this, curl-style progress bars that
   * use \r to refresh in-place produce one line per update instead of one final line.
   */
  function processCarriageReturns(text: string): string {
    const lines: string[] = [];
    for (const segment of text.split('\n')) {
      let currentLine = '';
      for (const part of segment.split('\r')) {
        if (part.length >= currentLine.length) {
          currentLine = part;
        } else {
          currentLine = part + currentLine.slice(part.length);
        }
      }
      lines.push(currentLine);
    }
    return lines.join('\n');
  }

  const { state, messages, sendMessage, abort, respondConfirmation, clearMessages, deleteConversation, loadHistory, confirmationRequest, isLoadingHistory, contextUsage, autoCompressToast, compressSession } = useAgent();
  const [viewMode, setViewModeState] = useState<ViewMode>('code');
  // Code 视图皮肤主题：仅影响 Code 视图，Designer 视图始终深色。
  const [codeViewTheme, setCodeViewThemeState] = useState<CodeViewTheme>('dark');
  const designerViewRef = useRef<DesignerViewHandle>(null);
  const viewModeRef = useRef<ViewMode>(viewMode);
  useEffect(() => { viewModeRef.current = viewMode; }, [viewMode]);
  // 未保存修改提示：当从 designer 视图切换到 code 视图、或关闭窗口时，
  // 若 designer 有未保存的页面，弹出此对话框让用户选择 保存/不保存/取消。
  // action 指明触发场景，targetMode 仅 switch 场景使用。
  const [unsavedPrompt, setUnsavedPrompt] = useState<{ count: number; action: 'switch' | 'close'; targetMode?: ViewMode } | null>(null);

  // 将当前视图模式持久化到配置文件，下次启动时还原。fire-and-forget，失败不影响切换。
  const persistViewMode = useCallback((mode: ViewMode) => {
    window.electronAPI?.invoke('config:set', { lastViewMode: mode }).catch(() => { /* 忽略持久化失败 */ });
  }, []);

  // 将 Code 视图皮肤选择持久化，下次启动时还原。与 persistViewMode 同模式。
  const persistCodeViewTheme = useCallback((theme: CodeViewTheme) => {
    window.electronAPI?.invoke('config:set', { lastCodeViewTheme: theme }).catch(() => { /* 忽略持久化失败 */ });
  }, []);

  const handleViewModeChange = useCallback((mode: ViewMode) => {
    // 仅当从 designer 切换到 code 且有未保存页面时拦截
    if (viewModeRef.current === 'designer' && mode === 'code') {
      const count = designerViewRef.current?.getUnsavedCount() ?? 0;
      if (count > 0) {
        setUnsavedPrompt({ count, action: 'switch', targetMode: mode });
        return;
      }
    }
    setViewModeState(mode);
    persistViewMode(mode);
  }, [persistViewMode]);

  const handleCodeViewThemeChange = useCallback((theme: CodeViewTheme) => {
    setCodeViewThemeState(theme);
    persistCodeViewTheme(theme);
  }, [persistCodeViewTheme]);

  // 同步 body 上的 data-code-theme 属性：仅在 Code 视图且选择浅色时启用。
  // Designer 视图（或 Code 视图深色）不设置该属性，因此 Designer 始终保持深色，
  // 浮窗 portal 到 body 也能继承到该属性。
  useEffect(() => {
    if (viewMode === 'code' && codeViewTheme === 'light') {
      document.body.setAttribute('data-code-theme', 'light');
    } else {
      document.body.removeAttribute('data-code-theme');
    }
  }, [viewMode, codeViewTheme]);
  const [openFiles, setOpenFiles] = useState<OpenFile[]>([]);
  const [activeFilePath, setActiveFilePath] = useState<string | null>(null);
  const [commandOutput, setCommandOutput] = useState<{ commandId: string; command: string; output: string; status: string }[]>([]);
  const [showSettings, setShowSettings] = useState(false);
  const [workspace, setWorkspace] = useState<string>('');
  const [configLoaded, setConfigLoaded] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [sessionTitle, setSessionTitle] = useState<string>('');
  const [chatTags, setChatTags] = useState<ChatTag[]>([]);
  const [editorHeight, setEditorHeight] = useState(67);
  const [leftWidth, setLeftWidth] = useState(250);
  const [rightWidth, setRightWidth] = useState(0);
  const [isRightResizing, setIsRightResizing] = useState(false);
  const [isVerticalResizing, setIsVerticalResizing] = useState(false);
  const [terminalMinimized, setTerminalMinimized] = useState(true);
  const [captchaInfo, setCaptchaInfo] = useState<{ engine: string; url: string } | null>(null);
  const resizingRef = useRef(false);
  const rightPanelRef = useRef<HTMLDivElement>(null);
  const appLayoutRef = useRef<HTMLDivElement>(null);
  const savingFilesRef = useRef<Set<string>>(new Set());
  // ── 命令输出节流（性能优化）────────────────────────────────────────────
  // execute_command 实时输出每数据块触发一次 IPC → setCommandOutput。
  // 旧实现每块都做 O(累积输出) 的 includes('\r')/processCarriageReturns +
  // React 全量重渲染，输出大时（几百 KB / 几百块）累积阻塞可达秒级 →
  // renderer unresponsive → forcefullyCrashRenderer (window.ts:140)。
  // 修复：把 100ms 窗口内的 chunk 累积到 pendingChunksRef，一次性合并后
  // 只调用一次 setCommandOutput。AI 交互走 ToolResult 通道，不受影响。
  const pendingCmdChunksRef = useRef<
    { commandId: string; outputType: 'stdout' | 'stderr'; data: string; command: string }[]
  >([]);
  const cmdFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 供 handleToolResult 在命令结束时立即冲刷 pending chunk，避免竞态
  const flushCmdChunksRef = useRef<() => void>(() => {});

  const activeFile = openFiles.find((f) => f.path === activeFilePath) ?? null;


  const handleFileOpen = useCallback(async (filePath: string, line?: number) => {
    if (isBinaryFile(filePath)) return;
    setOpenFiles((prev) => {
      const existing = prev.find((f) => f.path === filePath);
      if (existing) {
        if (line) {
          return prev.map((f) => f.path === filePath ? { ...f, line } : f);
        }
        return prev;
      }

      (async () => {
        try {
          const result = await window.electronAPI.invoke('file:read', filePath) as { success: boolean; content?: string; error?: string };
          const content = result.success ? (result.content ?? '') : `// Error loading file: ${result.error}`;
          setOpenFiles((p) => {
            if (p.find((f) => f.path === filePath)) return p;
            return [...p, { path: filePath, content, modified: false, line }];
          });
          setActiveFilePath(filePath);
        } catch (err) {
          setOpenFiles((p) => {
            if (p.find((f) => f.path === filePath)) return p;
            return [...p, { path: filePath, content: `// Failed to load: ${err}`, modified: false, line }];
          });
          setActiveFilePath(filePath);
        }
      })();

      return prev;
    });
    setActiveFilePath(filePath);
  }, []);

  // Listen for cross-file navigation events from the LSP client (go-to-definition).
  // When the user jumps to a definition in another file, the LSP client dispatches
  // a DOM event; we open the target file and scroll to the definition line.
  useEffect(() => {
    const handler = (e: Event) => {
      const { filePath, line, column } = (e as CustomEvent).detail;
      handleFileOpen(filePath, line);
    };
    window.addEventListener('lsp:openFile', handler as EventListener);
    return () => window.removeEventListener('lsp:openFile', handler as EventListener);
  }, [handleFileOpen]);

  const handleFileClose = useCallback((filePath: string) => {
    setOpenFiles((prev) => {
      const next = prev.filter((f) => f.path !== filePath);
      setActiveFilePath((ap) => {
        if (ap === filePath) {
          return next.length > 0 ? next[0].path : null;
        }
        return ap;
      });
      return next;
    });
  }, []);

  const handleFileCloseOthers = useCallback((filePath: string) => {
    setOpenFiles((prev) => {
      const target = prev.find((f) => f.path === filePath);
      if (!target) return prev;
      setActiveFilePath(filePath);
      return [target];
    });
  }, []);

  const handleFileCloseRight = useCallback((filePath: string) => {
    setOpenFiles((prev) => {
      const idx = prev.findIndex((f) => f.path === filePath);
      if (idx < 0) return prev;
      const next = prev.slice(0, idx + 1);
      setActiveFilePath((ap) => {
        if (next.some((f) => f.path === ap)) return ap;
        return filePath;
      });
      return next;
    });
  }, []);

  const handleFileCloseAll = useCallback(() => {
    setOpenFiles([]);
    setActiveFilePath(null);
  }, []);
  const handleFileChange = useCallback((value: string | undefined) => {
    if (!activeFilePath) return;
    setOpenFiles((prev) =>
      prev.map((f) => (f.path === activeFilePath ? { ...f, content: value ?? '', modified: true } : f)),
    );
  }, [activeFilePath]);

  const handleFileChangeByPath = useCallback((path: string, value: string | undefined) => {
    setOpenFiles((prev) =>
      prev.map((f) => (f.path === path ? { ...f, content: value ?? '', modified: true } : f)),
    );
  }, []);

  // Listen for external file changes and mark open files as externally modified
  useEffect(() => {
    const handler = async (data: unknown) => {
      const { filename } = data as { eventType: string; filename: string };
      if (!filename) return;

      const normalizedFilename = filename.replace(/\\/g, '/').replace(/^\/+/, '');

      // Collect files that match the changed filename
      const matchedFiles: OpenFile[] = [];
      setOpenFiles((prev) => {
        matchedFiles.length = 0;
        for (const f of prev) {
          if (f.externalModified) continue;
          if (savingFilesRef.current.has(f.path)) continue;
          const normalizedPath = f.path.replace(/\\/g, '/');
          if (normalizedPath.endsWith('/' + normalizedFilename) || normalizedPath === normalizedFilename) {
            matchedFiles.push(f);
          }
        }
        return prev;
      });

      if (matchedFiles.length === 0) return;

      // Verify content actually changed before marking as externalModified
      // This avoids spurious fs.watch events on Windows (antivirus, indexer, etc.)
      const actuallyChanged: string[] = [];
      await Promise.all(
        matchedFiles.map(async (f) => {
          try {
            const result = await window.electronAPI.invoke('file:read', f.path) as { success: boolean; content?: string };
            if (result.success && result.content !== f.content) {
              actuallyChanged.push(f.path);
            }
          } catch {
            // If we can't read, skip — don't show false reload prompt
          }
        }),
      );

      if (actuallyChanged.length === 0) return;

      setOpenFiles((prev) => {
        let changed = false;
        const changedSet = new Set(actuallyChanged);
        const next = prev.map((f) => {
          if (!changedSet.has(f.path) || f.externalModified) return f;
          if (savingFilesRef.current.has(f.path)) return f;
          changed = true;
          return { ...f, externalModified: true };
        });
        return changed ? next : prev;
      });
    };
    window.electronAPI?.on('file:changed', handler);
    return () => {
      window.electronAPI?.removeListener?.('file:changed', handler);
    };
  }, []);


  const handleFileReload = useCallback(async (filePath: string) => {
    try {
      const result = await window.electronAPI.invoke('file:read', filePath) as { success: boolean; content?: string; error?: string };
      if (result.success) {
        setOpenFiles((prev) =>
          prev.map((f) => f.path === filePath ? { ...f, content: result.content ?? '', modified: false, externalModified: false } : f),
        );
      }
    } catch {
      // ignore
    }
  }, []);

  const handleFileSave = useCallback(async (filePath: string) => {
    const file = openFiles.find((f) => f.path === filePath);
    if (!file) return;
    if (file.readOnly) return;
    savingFilesRef.current.add(filePath);
    try {
      const result = await window.electronAPI.invoke('file:write', filePath, file.content) as { success: boolean; error?: string };
      if (result.success) {
        setOpenFiles((prev) =>
          prev.map((f) => f.path === filePath ? { ...f, modified: false, externalModified: false } : f),
        );
      } else {
        console.error('Save failed:', result.error);
      }
    } catch (err) {
      console.error('Save failed:', err);
    } finally {
      // Clear the flag after a short delay to let the fs.watch event arrive and be ignored
      setTimeout(() => savingFilesRef.current.delete(filePath), 500);
    }
  }, [openFiles]);

  const handleGitDiffOpen = useCallback(async (filePath: string, staged: boolean) => {
    const diffKey = `git-diff:${filePath}`;
    const existing = openFiles.find((f) => f.path === diffKey);
    if (existing) {
      setActiveFilePath(diffKey);
      return;
    }
    try {
      const diff = await window.electronAPI.invoke('git:file-diff', { filePath, staged }) as { filePath: string; hunks: string; additions: number; deletions: number };
      if (diff) {
        const header = `--- ${filePath}\n+++ ${filePath}\n`;
        const content = header + (diff.hunks || '');
        setOpenFiles((prev) => {
          if (prev.find((f) => f.path === diffKey)) return prev;
          return [...prev, { path: diffKey, content, modified: false, readOnly: true, isGitDiff: true }];
        });
        setActiveFilePath(diffKey);
      }
    } catch {
      // ignore
    }
  }, [openFiles]);

  const handleCommitDiffOpen = useCallback(async (hash: string, filePath: string) => {
    const diffKey = `git-commit-diff:${hash}:${filePath}`;
    const existing = openFiles.find((f) => f.path === diffKey);
    if (existing) {
      setActiveFilePath(diffKey);
      return;
    }
    try {
      const diff = await window.electronAPI.invoke('git:commit-file-diff', { hash, filePath }) as { filePath: string; hunks: string; additions: number; deletions: number } | null;
      if (diff) {
        const header = `--- ${filePath}\n+++ ${filePath}\n`;
        const content = header + (diff.hunks || '');
        setOpenFiles((prev) => {
          if (prev.find((f) => f.path === diffKey)) return prev;
          return [...prev, { path: diffKey, content, modified: false, readOnly: true, isGitDiff: true }];
        });
        setActiveFilePath(diffKey);
      }
    } catch {
      // ignore
    }
  }, [openFiles]);

  const handleDbTableClick = useCallback(async (params: {
    connId: string;
    connName: string;
    dbType: string;
    jdbcUrl: string;
    username: string;
    password: string;
    schema: string;
    tableName: string;
  }) => {
    const tabPath = `db://${params.connId}/${params.schema}/${params.tableName}`;

    // If tab already exists, just activate it
    const existing = openFiles.find((f) => f.path === tabPath);
    if (existing) {
      setActiveFilePath(tabPath);
      return;
    }

    // Generate SQL from backend
    try {
      const genResult = await window.electronAPI.invoke('db:generate-sql', {
        dbType: params.dbType,
        tableName: params.tableName,
        schema: params.schema,
        limit: 50,
      }) as { success: boolean; sql?: string; error?: string };

      const sql = genResult.success && genResult.sql
        ? genResult.sql
        : `SELECT * FROM ${params.tableName} LIMIT 50;`;

      const newFile: OpenFile = {
        path: tabPath,
        content: sql,
        modified: false,
        readOnly: true,
        isDbQuery: true,
        dbQuery: {
          connName: params.connName,
          dbType: params.dbType,
          jdbcUrl: params.jdbcUrl,
          username: params.username,
          password: params.password,
          schema: params.schema,
          tableName: params.tableName,
        },
      };

      setOpenFiles((prev) => [...prev, newFile]);
      setActiveFilePath(tabPath);
    } catch (err) {
      // Fallback: create tab with default SQL
      const newFile: OpenFile = {
        path: tabPath,
        content: `SELECT * FROM ${params.tableName} LIMIT 50;`,
        modified: false,
        readOnly: true,
        isDbQuery: true,
        dbQuery: {
          connName: params.connName,
          dbType: params.dbType,
          jdbcUrl: params.jdbcUrl,
          username: params.username,
          password: params.password,
          schema: params.schema,
          tableName: params.tableName,
        },
      };

      setOpenFiles((prev) => [...prev, newFile]);
      setActiveFilePath(tabPath);
    }
  }, [openFiles]);

  const handleShowTableStructure = useCallback(async (params: {
    connId: string;
    connName: string;
    dbType: string;
    jdbcUrl: string;
    username: string;
    password: string;
    schema: string;
    tableName: string;
  }) => {
    const tabPath = `db-struct://${params.connId}/${params.schema}/${params.tableName}`;

    // If tab already exists, just activate it
    const existing = openFiles.find((f) => f.path === tabPath);
    if (existing) {
      setActiveFilePath(tabPath);
      return;
    }

    // Fetch DDL from backend
    try {
      const ddlResult = await window.electronAPI.invoke('db:table-ddl', {
        jdbcUrl: params.jdbcUrl,
        username: params.username,
        password: params.password,
        dbType: params.dbType,
        schema: params.schema,
        tableName: params.tableName,
      }) as { success: boolean; ddl?: string; error?: string };

      const ddl = ddlResult.success && ddlResult.ddl
        ? ddlResult.ddl
        : `-- 获取DDL失败: ${ddlResult.error || '未知错误'}`;

      const newFile: OpenFile = {
        path: tabPath,
        content: ddl,
        modified: false,
        readOnly: true,
        isDbQuery: true,
        isTableStructure: true,
        dbQuery: {
          connName: params.connName,
          dbType: params.dbType,
          jdbcUrl: params.jdbcUrl,
          username: params.username,
          password: params.password,
          schema: params.schema,
          tableName: params.tableName,
        },
      };

      setOpenFiles((prev) => [...prev, newFile]);
      setActiveFilePath(tabPath);
    } catch (err) {
      const newFile: OpenFile = {
        path: tabPath,
        content: `-- 获取DDL异常: ${err}`,
        modified: false,
        readOnly: true,
        isDbQuery: true,
        isTableStructure: true,
        dbQuery: {
          connName: params.connName,
          dbType: params.dbType,
          jdbcUrl: params.jdbcUrl,
          username: params.username,
          password: params.password,
          schema: params.schema,
          tableName: params.tableName,
        },
      };

      setOpenFiles((prev) => [...prev, newFile]);
      setActiveFilePath(tabPath);
    }
  }, [openFiles]);

  const handleNewSqlEditor = useCallback((params: {
    connId: string;
    connName: string;
    dbType: string;
    jdbcUrl: string;
    username: string;
    password: string;
    schema: string;
  }) => {
    const tabId = Date.now();
    const tabPath = `db-editor://${params.connId}/${params.schema}/new-${tabId}`;

    const newFile: OpenFile = {
      path: tabPath,
      content: `-- ${params.connName} / ${params.schema}\n`,
      modified: false,
      isDbQuery: true,
      dbQuery: {
        connName: params.connName,
        dbType: params.dbType,
        jdbcUrl: params.jdbcUrl,
        username: params.username,
        password: params.password,
        schema: params.schema,
        tableName: '',
      },
    };

    setOpenFiles((prev) => [...prev, newFile]);
    setActiveFilePath(tabPath);
  }, []);

  const handleOpenBrowser = useCallback((url?: string) => {
    const sessionId = `br-${Date.now()}`;
    const tabPath = `browser://${sessionId}`;

    const newFile: OpenFile = {
      path: tabPath,
      content: url || 'about:blank',
      modified: false,
      readOnly: true,
      isBrowser: true,
      browserSessionId: sessionId,
    };

    setOpenFiles((prev) => [...prev, newFile]);
    setActiveFilePath(tabPath);

    // Notify main process to create session
    window.electronAPI.invoke('browser:create-session', { sessionId, url });
  }, []);

  // Listen for browser session creation from main process (triggered by AI tools)
  useEffect(() => {
    const handler = (data: unknown) => {
      const { sessionId, url } = data as { sessionId: string; url?: string };
      if (!sessionId) return;
      // Check if tab already exists
      const tabPath = `browser://${sessionId}`;
      setOpenFiles(prev => {
        if (prev.find(f => f.path === tabPath)) return prev;
        const newFile: OpenFile = {
          path: tabPath,
          content: url || 'about:blank',
          modified: false,
          readOnly: true,
          isBrowser: true,
          browserSessionId: sessionId,
        };
        return [...prev, newFile];
      });
      setActiveFilePath(tabPath);
    };
    window.electronAPI?.on('browser:create-session', handler);
    return () => {
      window.electronAPI?.removeListener?.('browser:create-session', handler);
    };
  }, []);

  // Listen for browser title updates from main process
  useEffect(() => {
    const handler = (_data: unknown) => {
      // BrowserPanel handles its own title display via webview events
    };
    window.electronAPI?.on('browser:title-update', handler);
    return () => {
      window.electronAPI?.removeListener?.('browser:title-update', handler);
    };
  }, []);

  const handleSendMessage = useCallback((content: string) => {
    // Tags are already embedded in content via getEditorText()
    sendMessage(content);
    setChatTags([]);
  }, [sendMessage]);

  const handleConfirmation = useCallback((approved: boolean, approveAll?: boolean) => {
    respondConfirmation(approved, approveAll);
  }, [respondConfirmation]);

  const handleSessionTitleChange = useCallback((title: string) => {
    setSessionTitle(title);
  }, []);

  const handleAddChatTag = useCallback((tag: Omit<ChatTag, 'id'>) => {
    const id = `${tag.type}-${tag.filePath}-${tag.startLine ?? 0}-${Date.now()}`;
    setChatTags((prev) => {
      // Avoid duplicate tags
      const exists = prev.some((t) =>
      t.type === tag.type &&
      t.filePath === tag.filePath &&
      t.startLine === tag.startLine &&
      t.endLine === tag.endLine &&
      t.tableName === tag.tableName
      );
      if (exists) return prev;
      return [...prev, { ...tag, id }];
    });
  }, []);

  const handleRemoveChatTag = useCallback((tagId: string) => {
    setChatTags((prev) => prev.filter((t) => t.id !== tagId));
  }, []);

  const handleWorkspaceChanged = useCallback((newWorkspace: string) => {
    setWorkspace(newWorkspace);
    setRefreshKey((k) => k + 1);
  }, []);

  const handleToolResult = useCallback((data: unknown) => {
    const result = data as { toolCall?: { name: string; parameters?: Record<string, string> }; result: { success: boolean; output: string; error?: string; executionTime?: number } };
    if (result.toolCall?.name === 'execute_command') {
      // 命令结束：先冲刷 pending 的实时输出 chunk，再追加最终结果并标记完成
      // 避免竞态：pending chunk 在 status='completed' 之后才 flush → 丢失尾部输出
      flushCmdChunksRef.current();
      // 取消可能还在等待的 flush timer（命令已结束，不需要了）
      if (cmdFlushTimerRef.current) {
        clearTimeout(cmdFlushTimerRef.current);
        cmdFlushTimerRef.current = null;
      }
      const cmd = result.toolCall.parameters?.command || 'command';
      setCommandOutput((prev) => {
        const lastIndex = prev.length - 1;
        if (lastIndex >= 0 && prev[lastIndex].command === cmd && prev[lastIndex].status === 'running') {
          const updated = [...prev];
          updated[lastIndex] = {
            ...updated[lastIndex],
            output: updated[lastIndex].output + (result.result.output || result.result.error || ''),
            status: result.result.success ? 'completed' : 'failed',
          };
          return updated;
        } else {
          return [
            ...prev,
            {
              commandId: `result_${Date.now()}`,
              command: cmd,
              output: result.result.output || result.result.error || '',
              status: result.result.success ? 'completed' : 'failed',
            },
          ];
        }
      });
    }
    if (result.toolCall?.name === 'write_to_file' || result.toolCall?.name === 'replace_in_file' || result.toolCall?.name === 'remove_line') {
      setRefreshKey((k) => k + 1);
    }
  }, []);


  /** 冲刷 pending 的 command output chunk：合并 → setCommandOutput 一次 */
  const flushCmdChunks = useCallback(() => {
    const chunks = pendingCmdChunksRef.current;
    if (chunks.length === 0) return;
    pendingCmdChunksRef.current = [];
    // 按 commandId 合并同一命令的所有 chunk
    const merged = new Map<string, { commandId: string; data: string; command: string }>();
    for (const c of chunks) {
      const existing = merged.get(c.commandId);
      if (existing) {
        existing.data += c.data;
      } else {
        merged.set(c.commandId, { commandId: c.commandId, data: c.data, command: c.command });
      }
    }
    setCommandOutput((prev) => {
      const updated = [...prev];
      for (const [, m] of merged) {
        // 策略 1：按 commandId 精确匹配
        const exactIdx = updated.findIndex(
          (entry) => entry.commandId === m.commandId && entry.status === 'running'
        );
        if (exactIdx >= 0) {
          const combined = updated[exactIdx].output + m.data;
          updated[exactIdx] = {
            ...updated[exactIdx],
            output: combined.includes('\r') ? processCarriageReturns(combined) : combined,
          };
          continue;
        }
        // 策略 2：按命令名模糊匹配最后一条 running 条目
        const lastIdx = updated.length - 1;
        if (lastIdx >= 0 && updated[lastIdx].command === m.command && updated[lastIdx].status === 'running') {
          const combined = updated[lastIdx].output + m.data;
          updated[lastIdx] = {
            ...updated[lastIdx],
            output: combined.includes('\r') ? processCarriageReturns(combined) : combined,
          };
          continue;
        }
        // 新增条目
        const initialOutput = m.data.includes('\r') ? processCarriageReturns(m.data) : m.data;
        updated.push({
          commandId: m.commandId,
          command: m.command,
          output: initialOutput,
          status: 'running',
        });
      }
      return updated;
    });
  }, []);

  // 把 flushCmdChunks 暴露给 ref，供 handleToolResult 在命令结束时冲刷
  flushCmdChunksRef.current = flushCmdChunks;

  const handleCommandOutput = useCallback((data: unknown) => {
    const output = data as { commandId: string; outputType: 'stdout' | 'stderr'; data: string; command: string };
    // 累积到 pending 队列，100ms 合并一次 → 大幅减少 React 重渲染次数
    pendingCmdChunksRef.current.push(output);
    if (!cmdFlushTimerRef.current) {
      cmdFlushTimerRef.current = setTimeout(() => {
        cmdFlushTimerRef.current = null;
        flushCmdChunksRef.current();
      }, 100);
    }
  }, []);

  useEffect(() => {
    const handler = (data: unknown) => {
      handleToolResult(data);
    };
    window.electronAPI?.on(IPCChannel.ToolResult, handler);
    return () => {
      window.electronAPI?.removeListener?.(IPCChannel.ToolResult, handler);
    };
  }, [handleToolResult]);

  useEffect(() => {
    const handler = (data: unknown) => {
      handleCommandOutput(data);
    };
    window.electronAPI?.on(IPCChannel.CommandOutput, handler);
    return () => {
      window.electronAPI?.removeListener?.(IPCChannel.CommandOutput, handler);
    };
  }, [handleCommandOutput]);
  // Initialize workspace and last view mode from config on mount
  useEffect(() => {
    (async () => {
      try {
        const config = await window.electronAPI.invoke('config:get') as { workspace?: string; lastViewMode?: ViewMode; lastCodeViewTheme?: CodeViewTheme };
        if (config?.workspace) {
          setWorkspace(config.workspace);
        }
        // 还原上次退出前的视图模式（缺省/非法值保持默认 'code'）
        if (config?.lastViewMode === 'designer' || config?.lastViewMode === 'code') {
          setViewModeState(config.lastViewMode);
        }
        // 还原 Code 视图皮肤（缺省/非法值保持默认 'dark'）
        if (config?.lastCodeViewTheme === 'dark' || config?.lastCodeViewTheme === 'light') {
          setCodeViewThemeState(config.lastCodeViewTheme);
        }
        setConfigLoaded(true);
        await refreshToolNames();
      } catch {
        setConfigLoaded(true);
        await refreshToolNames();
      }
    })();
  }, []);

  useEffect(() => {
    const handler = (ws: unknown) => {
      const newWs = String(ws);
      setWorkspace(newWs);
      setRefreshKey((k) => k + 1);
    };
    window.electronAPI?.on('workspace:changed', handler);
    return () => {
      window.electronAPI?.removeListener?.('workspace:changed', handler);
    };
  }, []);

  useEffect(() => {
    const handler = () => {
      setShowSettings(true);
    };
    window.electronAPI?.on('menu:open-settings', handler);
    return () => {
      window.electronAPI?.removeListener?.('menu:open-settings', handler);
    };
  }, []);

  useEffect(() => {
    const handler = (title: unknown) => {
      if (typeof title === 'string' && title) {
        setSessionTitle(title);
      }
    };
    window.electronAPI?.on('session:title', handler);
    return () => {
      window.electronAPI?.removeListener?.('session:title', handler);
    };
  }, []);

  // CAPTCHA detection listener: show CaptchaView in the right panel
  useEffect(() => {
    const handler = (data: unknown) => {
      const info = data as { engine: string; url: string };
      if (info?.engine && info?.url) {
        setCaptchaInfo(info);
      }
    };
    window.electronAPI?.on(IPCChannel.WebCaptchaDetected, handler);
    return () => {
      window.electronAPI?.removeListener?.(IPCChannel.WebCaptchaDetected, handler);
    };
  }, []);

  const handleCaptchaResolved = useCallback(() => {
    setCaptchaInfo(null);
    window.electronAPI?.send(IPCChannel.WebCaptchaResolved, { resolved: true });
  }, []);

  const handleCaptchaDismiss = useCallback(() => {
    setCaptchaInfo(null);
    window.electronAPI?.send(IPCChannel.WebCaptchaResolved, { resolved: false });
  }, []);

  // 窗口关闭请求（主进程拦截 close 事件后发来）：若 designer 视图有未保存页面，
  // 弹出保存提示；否则直接强制关闭。
  useEffect(() => {
    const handler = () => {
      if (viewModeRef.current === 'designer') {
        const count = designerViewRef.current?.getUnsavedCount() ?? 0;
        if (count > 0) {
          setUnsavedPrompt({ count, action: 'close' });
          return;
        }
      }
      window.electronAPI?.send(IPCChannel.WindowForceClose);
    };
    window.electronAPI?.on(IPCChannel.WindowCloseRequested, handler);
    return () => {
      window.electronAPI?.removeListener?.(IPCChannel.WindowCloseRequested, handler);
    };
  }, []);

  // 未保存提示对话框的三个动作
  const handleUnsavedSave = useCallback(async () => {
    const prompt = unsavedPrompt;
    setUnsavedPrompt(null);
    await designerViewRef.current?.saveAll();
    if (prompt?.action === 'switch' && prompt.targetMode) {
      setViewModeState(prompt.targetMode);
      persistViewMode(prompt.targetMode);
    } else if (prompt?.action === 'close') {
      window.electronAPI?.send(IPCChannel.WindowForceClose);
    }
  }, [unsavedPrompt, persistViewMode]);

  const handleUnsavedDiscard = useCallback(() => {
    const prompt = unsavedPrompt;
    setUnsavedPrompt(null);
    if (prompt?.action === 'switch' && prompt.targetMode) {
      setViewModeState(prompt.targetMode);
      persistViewMode(prompt.targetMode);
    } else if (prompt?.action === 'close') {
      window.electronAPI?.send(IPCChannel.WindowForceClose);
    }
  }, [unsavedPrompt, persistViewMode]);

  const handleUnsavedCancel = useCallback(() => {
    setUnsavedPrompt(null);
    // 取消：不切换视图、不关闭窗口
  }, []);

  const handleVerticalResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    resizingRef.current = true;
    setIsVerticalResizing(true);

    const handleMouseMove = (moveEvent: MouseEvent) => {
      if (!resizingRef.current || !rightPanelRef.current) return;
      const rect = rightPanelRef.current.getBoundingClientRect();
      const relativeY = moveEvent.clientY - rect.top;
      const percentage = Math.max(20, Math.min(80, (relativeY / rect.height) * 100));
      setEditorHeight(percentage);
    };

    const handleMouseUp = () => {
      resizingRef.current = false;
      setIsVerticalResizing(false);
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, []);

  const handleLeftResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = leftWidth;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const delta = moveEvent.clientX - startX;
      const newWidth = Math.max(150, Math.min(500, startWidth + delta));
      setLeftWidth(newWidth);
    };

    const handleMouseUp = () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, [leftWidth]);

  const handleRightResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = rightPanelRef.current?.offsetWidth ?? rightWidth;

    // If currently in flex mode (rightWidth=0), lock to actual width first
    if (rightWidth === 0 && rightPanelRef.current) {
      setRightWidth(rightPanelRef.current.offsetWidth);
    }

    setIsRightResizing(true);

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const delta = startX - moveEvent.clientX;
      const newWidth = Math.max(250, startWidth + delta);
      setRightWidth(newWidth);
    };

    const handleMouseUp = () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      setIsRightResizing(false);
    };

    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, [rightWidth]);

  // 未初始化或加载中：显示启动闪屏；未登录：显示登录/注册页
  if (!initialized || loading) {
    if (!user) {
      return (
        <div className="xai-login-wrap">
          <div className="xai-login-card" style={{ textAlign: 'center' }}>
            <div className="xai-login-logo">xAI IDE</div>
            <p className="xai-login-sub">正在加载...</p>
          </div>
        </div>
      );
    }
  }
  if (!user) {
    return <LoginScreen onLogin={login} onRegister={register} onForgotPassword={forgotPassword} onResetPassword={resetPassword} />;
  }

  return (
    <div className={`app-layout ${viewMode === 'designer' ? 'app-layout-designer' : ''}`} ref={appLayoutRef}>
      <UpdateNotification />
      <TitleBar
        onOpenSettings={() => setShowSettings(true)}
        onWorkspaceChanged={handleWorkspaceChanged}
        onOpenBrowser={handleOpenBrowser}
        viewMode={viewMode}
        onViewModeChange={handleViewModeChange}
        codeViewTheme={codeViewTheme}
        onCodeViewThemeChange={handleCodeViewThemeChange}
        user={user}
        onLogout={logout}
        onChangePassword={changePassword}
        onUpdateProfile={updateProfile}
      />
      <div className="app-body">
      {viewMode === 'designer' ? (
        <ErrorBoundary>
          <DesignerView ref={designerViewRef} />
        </ErrorBoundary>
      ) : (
      <>
      <div className="panel-left" style={{ width: leftWidth }}>
        {configLoaded && (
        <ErrorBoundary key={workspace + refreshKey}>
          <FileExplorer key={workspace} refreshKey={refreshKey} workspace={workspace} onFileOpen={handleFileOpen} onWorkspaceChanged={handleWorkspaceChanged} onAddToChat={handleAddChatTag} onGitDiffOpen={handleGitDiffOpen} onCommitDiffOpen={handleCommitDiffOpen} onDbTableClick={handleDbTableClick} onShowTableStructure={handleShowTableStructure} onNewSqlEditor={handleNewSqlEditor} />
        </ErrorBoundary>
        )}
      </div>
      <div className="col-resize-handle" onMouseDown={handleLeftResizeStart} />
      <div className="panel-center">
        <ChatPanel
          messages={messages}
          agentState={state}
          onSendMessage={handleSendMessage}
          onAbort={abort}
          onConfirmationRequest={() => {}}
          onClearMessages={clearMessages}
          onDeleteConversation={deleteConversation}
          onLoadHistory={loadHistory}
          onOpenSettings={() => setShowSettings(true)}
          onSessionTitleChange={handleSessionTitleChange}
          sessionTitle={sessionTitle}
          chatTags={chatTags}
          onRemoveChatTag={handleRemoveChatTag}
          confirmationRequest={confirmationRequest}
          onConfirmationRespond={handleConfirmation}
          isLoadingHistory={isLoadingHistory}
          contextUsage={contextUsage}
          autoCompressToast={autoCompressToast}
          onCompressSession={compressSession}
        />
      </div>
      <div className="col-resize-handle" onMouseDown={handleRightResizeStart} />
      <div className="panel-right" style={rightWidth ? { width: rightWidth } : { flex: 1 }} ref={rightPanelRef}>
        {(isRightResizing || isVerticalResizing) && <div className="resize-overlay" style={{ cursor: isVerticalResizing ? 'row-resize' : 'col-resize' }} />}
        <div className="panel-right-top" style={{ height: terminalMinimized ? 'auto' : `${editorHeight}%`, flex: terminalMinimized ? 1 : 'none' }}>
          {captchaInfo ? (
            <CaptchaView
              captcha={captchaInfo}
              onResolved={handleCaptchaResolved}
              onDismiss={handleCaptchaDismiss}
            />
          ) : (
          <EditorPanel
            openFiles={openFiles}
            workspace={workspace}
            activeFile={activeFile}
            codeViewTheme={codeViewTheme}
            onFileSelect={(path) => {
              setActiveFilePath(path);
              setOpenFiles(prev => prev.map(f => f.path === path ? { ...f, line: undefined } : f));
            }}
            onFileClose={handleFileClose}
            onFileCloseOthers={handleFileCloseOthers}
            onFileCloseRight={handleFileCloseRight}
            onFileCloseAll={handleFileCloseAll}
            onFileChange={handleFileChange}
            onFileChangeByPath={handleFileChangeByPath}
            onFileReload={handleFileReload}
            onFileSave={handleFileSave}
            onAddCodeToChat={handleAddChatTag}
          />
          )}
        </div>
        {!terminalMinimized && <div className="panel-resize-handle" onMouseDown={handleVerticalResizeStart} />}
        <div className="panel-right-bottom" style={{ height: terminalMinimized ? 'auto' : `${100 - editorHeight}%` }}>
          <TerminalPanel
            commandOutput={commandOutput}
            onClearCommandOutput={() => setCommandOutput([])}
            minimized={terminalMinimized}
            onToggleMinimize={() => setTerminalMinimized(!terminalMinimized)}
            onAutoExpand={() => setTerminalMinimized(false)}
          />
        </div>
      </div>
      </>
      )}
      </div>
      {confirmationRequest && (
        <ConfirmationDialog
          request={confirmationRequest}
          onRespond={handleConfirmation}
        />
      )}
      {showSettings && (
        <ErrorBoundary>
          <SettingsPanel onClose={() => setShowSettings(false)} onWorkspaceChanged={handleWorkspaceChanged} />
        </ErrorBoundary>
      )}

      {/* Designer 未保存修改提示（切换视图 / 关闭窗口前） */}
      {unsavedPrompt && (
        <div className="unsaved-prompt-overlay">
          <div className="unsaved-prompt-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="unsaved-prompt-header">
              <AlertTriangle size={16} />
              未保存的修改
            </div>
            <div className="unsaved-prompt-body">
              Designer 视图中有 <strong>{unsavedPrompt.count}</strong> 个页面未保存。
              {unsavedPrompt.action === 'close' ? '关闭窗口前' : '切换视图前'}是否保存修改？
            </div>
            <div className="unsaved-prompt-footer">
              <button className="unsaved-prompt-btn cancel" onClick={handleUnsavedCancel}>取消</button>
              <button className="unsaved-prompt-btn discard" onClick={handleUnsavedDiscard}>不保存</button>
              <button className="unsaved-prompt-btn save" onClick={handleUnsavedSave}>保存</button>
            </div>
          </div>
        </div>
      )}

      <style>{`
        .panel-right {
          display: flex;
          flex-direction: column;
          overflow: hidden;
        }
        .panel-right-top {
          overflow: hidden;
          min-height: 0;
        }
        .panel-right-bottom {
          overflow: hidden;
          min-height: 0;
          flex-shrink: 1;
        }
        .panel-resize-handle {
          height: 4px;
          background: var(--border);
          cursor: row-resize;
          flex-shrink: 0;
          transition: background 0.15s;
        }
        .panel-resize-handle:hover {
          background: var(--accent);
        }
        .terminal-panel {
          display: flex;
          flex-direction: column;
          height: 100%;
          overflow: hidden;
        }
        .terminal-panel-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 0 8px;
          font-size: 12px;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.5px;
          color: var(--text-secondary);
          border-bottom: 1px solid var(--border);
          background: var(--bg-secondary);
          flex-shrink: 0;
          min-height: 32px;
        }
        .terminal-tabs {
          display: flex;
          align-items: center;
          gap: 0;
          flex: 1;
          min-width: 0;
          overflow-x: auto;
          overflow-y: hidden;
          scrollbar-width: none;
        }
        .terminal-tabs::-webkit-scrollbar { display: none; }
        .terminal-tab {
          display: flex;
          align-items: center;
          gap: 6px;
          padding: 6px 10px;
          font-size: 11px;
          font-family: var(--font-mono);
          font-weight: 500;
          color: var(--text-muted);
          border-bottom: 2px solid transparent;
          cursor: pointer;
          flex-shrink: 0;
          transition: color 0.15s, border-color 0.15s, background 0.15s;
          text-transform: none;
          letter-spacing: 0;
          white-space: nowrap;
        }
        .terminal-tab:hover {
          color: var(--text-secondary);
          background: rgba(212, 167, 106, 0.04);
        }
        .terminal-tab.active {
          color: var(--text-primary);
          border-bottom-color: var(--accent);
        }
        .terminal-tab-dot {
          width: 6px;
          height: 6px;
          border-radius: 50%;
          flex-shrink: 0;
        }
        .terminal-tab-dot.active {
          background: #d4a76a;
          box-shadow: 0 0 4px rgba(212, 167, 106, 0.6);
        }
        .terminal-tab-dot.closed {
          background: #4a4a5a;
        }
        .terminal-tab-label {
          pointer-events: none;
        }
        .terminal-tab-close {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 16px;
          height: 16px;
          border-radius: 3px;
          color: var(--text-muted);
          opacity: 0;
          transition: opacity 0.12s, color 0.12s, background 0.12s;
        }
        .terminal-tab:hover .terminal-tab-close {
          opacity: 1;
        }
        .terminal-tab-close:hover {
          color: var(--error);
          background: rgba(232, 93, 93, 0.12);
        }
        .terminal-header-actions {
          display: flex;
          align-items: center;
          gap: 2px;
          flex-shrink: 0;
        }
        .terminal-add-wrapper {
          position: relative;
        }
        .terminal-add-btn {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 22px;
          height: 22px;
          border-radius: var(--radius-sm);
          color: var(--text-muted);
          transition: color 0.15s, background 0.15s;
        }
        .terminal-add-btn:hover {
          color: var(--accent);
          background: var(--bg-hover);
        }
        .terminal-add-btn.spinning {
          color: var(--accent);
          pointer-events: none;
        }
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
        .spinning svg {
          animation: spin 1s linear infinite;
        }
        .terminal-add-menu {
          position: absolute;
          top: 100%;
          right: 0;
          margin-top: 4px;
          background: var(--bg-secondary);
          border: 1px solid var(--border);
          border-radius: var(--radius-md);
          box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
          z-index: 100;
          min-width: 160px;
          padding: 4px 0;
        }
        .terminal-add-menu-item {
          display: block;
          width: 100%;
          padding: 6px 12px;
          font-size: 12px;
          font-family: var(--font-mono);
          color: var(--text-secondary);
          text-align: left;
          transition: color 0.12s, background 0.12s;
        }
        .terminal-add-menu-item:hover {
          color: var(--text-primary);
          background: var(--bg-hover);
        }
        .terminal-clear-btn {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 22px;
          height: 22px;
          border-radius: var(--radius-sm);
          color: var(--text-muted);
          transition: color 0.15s, background 0.15s;
        }
        .terminal-clear-btn:hover {
          color: var(--error);
          background: var(--bg-hover);
        }
        .terminal-minimize-btn {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 22px;
          height: 22px;
          border-radius: var(--radius-sm);
          color: var(--text-muted);
          transition: color 0.15s, background 0.15s;
        }
        .terminal-minimize-btn:hover {
          color: var(--text-primary);
          background: var(--bg-hover);
        }
        .terminal-minimized-bar {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 0 8px;
          font-size: 11px;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.5px;
          color: var(--text-secondary);
          background: var(--bg-secondary);
          border-top: 1px solid var(--border);
          flex-shrink: 0;
          min-height: 30px;
          transition: background 0.15s;
        }
        .terminal-minimized-tabs {
          display: flex;
          align-items: center;
          gap: 0;
          flex: 1;
          min-width: 0;
          overflow-x: auto;
          overflow-y: hidden;
          scrollbar-width: none;
        }
        .terminal-minimized-tabs::-webkit-scrollbar { display: none; }
        .terminal-minimized-tab {
          display: flex;
          align-items: center;
          gap: 5px;
          padding: 4px 8px;
          font-size: 10px;
          font-family: var(--font-mono);
          color: var(--text-muted);
          cursor: pointer;
          flex-shrink: 0;
          border-bottom: 2px solid transparent;
          transition: color 0.15s, border-color 0.15s, background 0.15s;
          text-transform: none;
          letter-spacing: 0;
          white-space: nowrap;
        }
        .terminal-minimized-tab:hover {
          color: var(--text-secondary);
          background: rgba(212, 167, 106, 0.04);
        }
        .terminal-minimized-tab.active {
          color: var(--text-primary);
          border-bottom-color: var(--accent);
        }
        .terminal-minimized-tab-label {
          pointer-events: none;
        }
        .terminal-expand-btn {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 22px;
          height: 22px;
          border-radius: var(--radius-sm);
          color: var(--text-muted);
          flex-shrink: 0;
          transition: color 0.15s, background 0.15s;
        }
        .terminal-expand-btn:hover {
          color: var(--text-primary);
          background: var(--bg-hover);
        }
        .terminal-panel-body {
          flex: 1;
          overflow: hidden;
          position: relative;
          font-family: var(--font-mono);
          font-size: 12px;
          background: #1e1e1e;
          color: #cccccc;
        }
        .terminal-cmd-content {
          position: absolute;
          inset: 0;
          overflow-y: auto;
          padding: 8px 12px;
          background: #0c0c0c;
        }
        .terminal-xterm-wrapper {
          position: absolute;
          inset: 0;
          background: #1e1e1e;
        }
        .terminal-panel-empty {
          color: #666;
          font-style: italic;
        }
        .terminal-entry {
          margin-bottom: 8px;
        }
        .terminal-cmd-line {
          display: flex;
          align-items: center;
          gap: 8px;
          color: #e0e0e0;
        }
        .terminal-status-dot {
          font-size: 10px;
          flex-shrink: 0;
        }
        .terminal-status-dot.terminal-status-running {
          color: var(--accent);
          animation: pulse 1.5s ease-in-out infinite;
        }
        .terminal-status-dot.terminal-status-completed {
          color: var(--success);
        }
        .terminal-status-dot.terminal-status-failed {
          color: var(--error);
        }
        .terminal-cmd-text {
          font-weight: 500;
        }
        .terminal-cmd-output {
          margin: 4px 0 0 18px;
          color: #aaa;
          white-space: pre-wrap;
          word-break: break-word;
          font-size: 11px;
          line-height: 1.5;
        }
        .terminal-stream-output {
          margin: 0;
          color: #ccc;
          white-space: pre-wrap;
          word-break: break-word;
          font-size: 12px;
          line-height: 1.6;
          font-family: var(--font-mono);
        }
        .terminal-input-bar {
          display: flex;
          align-items: center;
          gap: 6px;
          padding: 4px 12px;
          background: #0c0c0c;
          border-top: 1px solid #333;
          flex-shrink: 0;
        }
        .terminal-input-prompt {
          color: var(--accent);
          font-family: var(--font-mono);
          font-size: 12px;
          font-weight: 600;
          flex-shrink: 0;
        }
        .terminal-input {
          flex: 1;
          background: transparent;
          border: none;
          outline: none;
          color: #ccc;
          font-family: var(--font-mono);
          font-size: 12px;
          line-height: 1.5;
          padding: 2px 0;
        }
        .terminal-input::placeholder {
          color: #555;
        }
        .terminal-context-menu {
          position: fixed;
          background: var(--bg-secondary);
          border: 1px solid var(--border);
          border-radius: var(--radius-md);
          box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
          padding: 4px 0;
          z-index: 1000;
          min-width: 180px;
        }
        .terminal-context-item {
          display: block;
          width: 100%;
          text-align: left;
          padding: 6px 14px;
          font-size: 12px;
          color: var(--text-primary);
          cursor: pointer;
          transition: background 0.12s;
        }
        .terminal-context-item:hover {
          background: var(--bg-hover);
        }
        .unsaved-prompt-overlay {
          position: fixed;
          inset: 0;
          background: rgba(0, 0, 0, 0.45);
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 10001;
        }
        .unsaved-prompt-dialog {
          width: 380px;
          max-width: 92vw;
          background: var(--bg-secondary, #1e1e24);
          border: 1px solid var(--border, #333);
          border-radius: 10px;
          box-shadow: 0 12px 32px rgba(0, 0, 0, 0.4);
          overflow: hidden;
        }
        .unsaved-prompt-header {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 14px 16px;
          background: rgba(245, 158, 11, 0.12);
          color: #d97706;
          font-size: 13px;
          font-weight: 600;
        }
        .unsaved-prompt-body {
          padding: 16px;
          font-size: 12px;
          color: var(--text-secondary, #9ca3af);
          line-height: 1.6;
        }
        .unsaved-prompt-body strong {
          color: var(--text-primary, #e5e7eb);
        }
        .unsaved-prompt-footer {
          display: flex;
          justify-content: flex-end;
          gap: 8px;
          padding: 0 16px 16px;
        }
        .unsaved-prompt-btn {
          padding: 6px 14px;
          border-radius: var(--radius-sm, 6px);
          font-size: 12px;
          font-weight: 500;
          cursor: pointer;
          transition: background 0.15s, opacity 0.15s;
        }
        .unsaved-prompt-btn.cancel {
          background: transparent;
          border: 1px solid var(--border, #333);
          color: var(--text-secondary, #9ca3af);
        }
        .unsaved-prompt-btn.cancel:hover {
          background: var(--bg-hover, rgba(255,255,255,0.06));
          color: var(--text-primary, #e5e7eb);
        }
        .unsaved-prompt-btn.discard {
          background: transparent;
          border: 1px solid var(--border, #333);
          color: var(--error, #ef4444);
        }
        .unsaved-prompt-btn.discard:hover {
          background: rgba(239, 68, 68, 0.12);
        }
        .unsaved-prompt-btn.save {
          background: var(--accent, #d4a76a);
          color: #1a1a1a;
          border: none;
        }
        .unsaved-prompt-btn.save:hover {
          opacity: 0.9;
        }
      `}</style>
    </div>
  );
}
