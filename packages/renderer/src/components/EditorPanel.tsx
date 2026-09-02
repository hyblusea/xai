import { useRef, useEffect, useCallback, useState } from 'react';
import Editor, { OnMount, BeforeMount } from '@monaco-editor/react';
type MonacoEditor = Parameters<OnMount>[0];
import { X, MessageSquare, GitBranch, Database, Columns3, Globe } from 'lucide-react';
import type { CodeViewTheme } from '@xai/shared';
import FloatingEditorWindow, { FloatingWindowState } from './FloatingEditorWindow';
import DbQueryPanel from './DbQueryPanel';
import type { DisplayResult } from './DbQueryPanel';
import BrowserPanel from './BrowserPanel';
import { useLSP } from '../hooks/useLSP';
import { defineXaiDarkTheme, defineXaiLightTheme } from '../monaco/theme';

interface OpenFile {
  path: string;
  content: string;
  modified: boolean;
  externalModified?: boolean;
  line?: number;
  readOnly?: boolean;
  isGitDiff?: boolean;
  isBrowser?: boolean;
  browserSessionId?: string;
  isDbQuery?: boolean;
  isTableStructure?: boolean;
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

interface EditorPanelProps {
  openFiles: OpenFile[];
  workspace?: string;
  activeFile: OpenFile | null;
  /** Code 视图皮肤主题：决定 Monaco 编辑器主题与浅色样式覆盖。 */
  codeViewTheme?: CodeViewTheme;
  onFileSelect: (path: string) => void;
  onFileClose: (path: string) => void;
  onFileCloseOthers: (path: string) => void;
  onFileCloseRight: (path: string) => void;
  onFileCloseAll: () => void;
  onFileChange: (value: string | undefined) => void;
  onFileChangeByPath: (path: string, value: string | undefined) => void;
  onFileReload: (path: string) => void;
  onFileSave: (path: string) => void;
  commandOutput?: unknown[];
  onAddCodeToChat?: (tag: { type: 'code'; filePath: string; startLine: number; endLine: number; content: string }) => void;
}

function getLanguage(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    mjs: 'javascript',
    cjs: 'javascript',
    json: 'json',
    md: 'markdown',
    css: 'css',
    scss: 'scss',
    less: 'less',
    html: 'html',
    py: 'python',
    rs: 'rust',
    go: 'go',
    java: 'java',
    c: 'c',
    cpp: 'cpp',
    h: 'c',
    hpp: 'cpp',
    cs: 'csharp',
    php: 'php',
    rb: 'ruby',
    swift: 'swift',
    kt: 'kotlin',
    scala: 'scala',
    dart: 'dart',
    lua: 'lua',
    r: 'r',
    vue: 'html',
    yaml: 'yaml',
    yml: 'yaml',
    toml: 'toml',
    sh: 'shell',
    bash: 'shell',
    bat: 'bat',
    cmd: 'bat',
    ps1: 'powershell',
    psm1: 'powershell',
    sql: 'sql',
    xml: 'xml',
    svg: 'xml',
    properties: 'ini',
    ini: 'ini',
    cfg: 'ini',
    conf: 'ini',
    graphql: 'graphql',
    dockerfile: 'dockerfile',
  };
  // Special case: Dockerfile (no extension)
  const fileName = filePath.split(/[\\/]/).pop()?.toLowerCase() ?? '';
  if (fileName === 'dockerfile') return 'dockerfile';
  return map[ext] ?? 'plaintext';
}

export default function EditorPanel({
  openFiles,
  workspace,
  activeFile,
  codeViewTheme = 'dark',
  onFileSelect,
  onFileClose,
  onFileCloseOthers,
  onFileCloseRight,
  onFileCloseAll,
  onFileChange,
  onFileChangeByPath,
  onFileReload,
  onFileSave,
  onAddCodeToChat,
}: EditorPanelProps) {
  const editorRef = useRef<MonacoEditor | null>(null);
  const monacoRef = useRef<any>(null);
  const onSaveRef = useRef(onFileSave);
  const activePathRef = useRef(activeFile?.path);
  const pendingLineRef = useRef<number | undefined>(undefined);
  // IDEA-style Back/Forward navigation history
  const navHistoryRef = useRef<Array<{ path: string; line: number; column: number }>>([]);
  const navIndexRef = useRef<number>(-1);
  const isNavigatingRef = useRef<boolean>(false);
  const pendingNavRef = useRef<{ path: string; line: number; column: number } | null>(null);
  const cursorDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  onSaveRef.current = onFileSave;
  activePathRef.current = activeFile?.path;
  pendingLineRef.current = activeFile?.line;

  // When activeFile.line changes (e.g. cross-file go-to-definition via
  // lsp:openFile event), scroll to the target line. handleEditorMount only
  // fires on first mount, so we need this effect for subsequent navigations.
  useEffect(() => {
    // Skip when navigating via Back/Forward (pendingNavRef handles position)
    if (isNavigatingRef.current || pendingNavRef.current) return;
    const line = activeFile?.line;
    if (line && editorRef.current) {
      requestAnimationFrame(() => {
        if (editorRef.current) {
          editorRef.current.revealLineInCenter(line);
          editorRef.current.setPosition({ lineNumber: line, column: 1 });
          editorRef.current.focus();
        }
      });
    }
  }, [activeFile?.line, activeFile?.path]);

  // LSP integration — connects to language servers via MessagePort
  const [lspProgress, setLspProgress] = useState<{ message: string; percent: number } | null>(null);
  const lsp = useLSP(workspace ?? '', (e) => {
    if (e.percent >= 0 && e.percent < 100) {
      setLspProgress({ message: e.message, percent: e.percent });
    } else if (e.percent >= 100 || e.percent < 0) {
      // Completed or error — hide after a short delay (for error messages).
      if (e.percent < 0) {
        // Keep error visible for 5s so user can read it
        setLspProgress({ message: e.message, percent: e.percent });
        setTimeout(() => setLspProgress(null), 5000);
      } else {
        setLspProgress(null);
      }
    }
  });

  // Floating window state
  const [poppedOutFiles, setPoppedOutFiles] = useState<Map<string, FloatingWindowState>>(new Map());
  // Cache DbQueryPanel results to avoid re-executing queries on tab switch
  const dbResultCache = useRef<Map<string, DisplayResult | null>>(new Map());
  const [nextZIndex, setNextZIndex] = useState(100);
  const tabbarRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  // ── Floating window handlers ──
  const handleTabDoubleClick = useCallback((file: OpenFile) => {
    const rect = tabbarRef.current?.getBoundingClientRect();
    const x = rect ? rect.left + 50 : 100;
    const y = rect ? rect.bottom + 10 : 50;
    setNextZIndex(prev => prev + 1);
    setPoppedOutFiles(prev => {
      const next = new Map(prev);
      next.set(file.path, {
        file: { path: file.path, content: file.content, modified: file.modified, readOnly: file.readOnly, isGitDiff: file.isGitDiff, line: file.line },
        x, y, width: 700, height: 500,
        isMaximized: false, isMinimized: false, zIndex: nextZIndex,
      });
      return next;
    });
    // Switch active file to next visible tab
    const visible = openFiles.filter(f => f.path !== file.path && !poppedOutFiles.has(f.path));
    const nextActive = visible.length > 0 ? visible[0].path : null;
    if (nextActive) onFileSelect(nextActive);
  }, [nextZIndex, openFiles, poppedOutFiles, onFileSelect]);

  const handleFloatingClose = useCallback((path: string) => {
    setPoppedOutFiles(prev => {
      const next = new Map(prev);
      next.delete(path);
      return next;
    });
    onFileSelect(path);
  }, [onFileSelect]);

  const handleFloatingMinimize = useCallback((path: string) => {
    setPoppedOutFiles(prev => {
      const next = new Map(prev);
      const s = next.get(path);
      if (s) next.set(path, { ...s, isMinimized: true });
      return next;
    });
  }, []);

  const handleFloatingMaximize = useCallback((path: string) => {
    setPoppedOutFiles(prev => {
      const next = new Map(prev);
      const s = next.get(path);
      if (!s) return prev;
      if (s.isMaximized) {
        // Restore from saved rect
        const r = s.restoreRect ?? { x: 100, y: 80, width: 700, height: 500 };
        next.set(path, { ...s, isMaximized: false, x: r.x, y: r.y, width: r.width, height: r.height });
      } else {
        // Save current rect before maximizing
        next.set(path, { ...s, isMaximized: true, restoreRect: { x: s.x, y: s.y, width: s.width, height: s.height } });
      }
      return next;
    });
  }, []);

  const handleFloatingFocus = useCallback((path: string) => {
    setNextZIndex(prev => {
      const newZ = prev + 1;
      setPoppedOutFiles(p => {
        const next = new Map(p);
        const s = next.get(path);
        if (s) next.set(path, { ...s, zIndex: newZ });
        return next;
      });
      return newZ;
    });
  }, []);

  const handleFloatingContentChange = useCallback((path: string, value: string | undefined) => {
    setPoppedOutFiles(prev => {
      const next = new Map(prev);
      const s = next.get(path);
      if (s) next.set(path, { ...s, file: { ...s.file, content: value ?? '', modified: true } });
      return next;
    });
    // Always sync content back to parent's openFiles
    onFileChangeByPath(path, value);
  }, [onFileChangeByPath]);

  const handleFloatingSave = useCallback((path: string) => {
    onFileSave(path);
    setPoppedOutFiles(prev => {
      const next = new Map(prev);
      const s = next.get(path);
      if (s) next.set(path, { ...s, file: { ...s.file, modified: false } });
      return next;
    });
  }, [onFileSave]);

  const handleFloatingDragEnd = useCallback((path: string, _x: number, _y: number) => {
    // Check if drop position is over the tab bar
    if (tabbarRef.current) {
      const rect = tabbarRef.current.getBoundingClientRect();
      // Use last known mouse position from the event
      if (_y >= rect.top - 20 && _y <= rect.bottom + 20 && _x >= rect.left && _x <= rect.right) {
        // Dock back: remove floating window, file returns to tab
        setPoppedOutFiles(prev => {
          const next = new Map(prev);
          next.delete(path);
          return next;
        });
        onFileSelect(path);
      }
    }
  }, [onFileSelect]);

  const handleFloatingPositionChange = useCallback((path: string, x: number, y: number) => {
    setPoppedOutFiles(prev => {
      const next = new Map(prev);
      const s = next.get(path);
      if (s && !s.isMaximized) next.set(path, { ...s, x, y });
      return next;
    });
  }, []);

  const handleFloatingResize = useCallback((path: string, x: number, y: number, width: number, height: number) => {
    setPoppedOutFiles(prev => {
      const next = new Map(prev);
      const s = next.get(path);
      if (s && !s.isMaximized) next.set(path, { ...s, x, y, width, height });
      return next;
    });
  }, []);

  const handleFloatingReload = useCallback((path: string) => {
    onFileReload(path);
    // Clear externalModified in the popped-out state
    setPoppedOutFiles(prev => {
      const next = new Map(prev);
      const s = next.get(path);
      if (s) next.set(path, { ...s, file: { ...s.file, externalModified: false } });
      return next;
    });
  }, [onFileReload]);

  const handleMinimizedBadgeClick = useCallback((path: string) => {
    setPoppedOutFiles(prev => {
      const next = new Map(prev);
      const s = next.get(path);
      if (s) next.set(path, { ...s, isMinimized: false });
      return next;
    });
    handleFloatingFocus(path);
  }, [handleFloatingFocus]);

  // ── IDEA-style Back/Forward navigation ──
  const pushNavEntry = useCallback((path: string, line: number, column: number) => {
    if (isNavigatingRef.current) return;
    if (!path) return;
    const hist = navHistoryRef.current;
    const current = navIndexRef.current >= 0 ? hist[navIndexRef.current] : null;
    // Skip if same file and adjacent line (avoid noise from typing / tiny moves)
    if (current && current.path === path && Math.abs(current.line - line) <= 2) return;
    // Truncate forward history (like browsers do)
    const base = navIndexRef.current >= 0 ? hist.slice(0, navIndexRef.current + 1) : [];
    base.push({ path, line, column });
    navHistoryRef.current = base;
    navIndexRef.current = base.length - 1;
  }, []);

  const applyNavEntry = useCallback((entry: { path: string; line: number; column: number }) => {
    isNavigatingRef.current = true;
    if (entry.path === activePathRef.current) {
      // Same file already active — just move the cursor
      const editor = editorRef.current;
      if (editor) {
        editor.setPosition({ lineNumber: entry.line, column: entry.column });
        editor.revealLineInCenter(entry.line);
        editor.focus();
      }
      setTimeout(() => { isNavigatingRef.current = false; }, 200);
    } else if (poppedOutFiles.has(entry.path)) {
      // Target is in a floating window — bring it to front instead of switching tabs
      handleFloatingFocus(entry.path);
      setTimeout(() => { isNavigatingRef.current = false; }, 100);
    } else {
      // Target is a regular tab — switch file and apply position once loaded
      pendingNavRef.current = entry;
      onFileSelect(entry.path);
      // Fallback: if the file switch doesn't happen within 1s (e.g., file no
      // longer in openFiles), reset nav state so future tracking isn't blocked.
      setTimeout(() => {
        if (pendingNavRef.current === entry) {
          pendingNavRef.current = null;
          isNavigatingRef.current = false;
        }
      }, 1000);
    }
  }, [onFileSelect, poppedOutFiles, handleFloatingFocus]);

  const goBack = useCallback(() => {
    if (navIndexRef.current <= 0) return;
    const targetIdx = navIndexRef.current - 1;
    const entry = navHistoryRef.current[targetIdx];
    if (!entry) return;
    if (!openFiles.find(f => f.path === entry.path)) return;
    navIndexRef.current = targetIdx;
    applyNavEntry(entry);
  }, [applyNavEntry, openFiles]);

  const goForward = useCallback(() => {
    if (navIndexRef.current >= navHistoryRef.current.length - 1) return;
    const targetIdx = navIndexRef.current + 1;
    const entry = navHistoryRef.current[targetIdx];
    if (!entry) return;
    if (!openFiles.find(f => f.path === entry.path)) return;
    navIndexRef.current = targetIdx;
    applyNavEntry(entry);
  }, [applyNavEntry, openFiles]);

  // Apply pending Back/Forward navigation once the target file is loaded
  useEffect(() => {
    if (!pendingNavRef.current) return;
    if (pendingNavRef.current.path !== activeFile?.path) return;
    const entry = pendingNavRef.current;
    pendingNavRef.current = null;
    requestAnimationFrame(() => {
      if (editorRef.current) {
        editorRef.current.setPosition({ lineNumber: entry.line, column: entry.column });
        editorRef.current.revealLineInCenter(entry.line);
        editorRef.current.focus();
      }
      isNavigatingRef.current = false;
    });
  }, [activeFile?.path]);

  // Track nav entry on file switch (skip while navigating via Back/Forward)
  useEffect(() => {
    if (isNavigatingRef.current || pendingNavRef.current) return;
    if (!activeFile?.path) return;
    const line = activeFile.line ?? 1;
    pushNavEntry(activeFile.path, line, 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeFile?.path]);

  // Track nav entry on cross-file jump (go-to-def sets activeFile.line)
  useEffect(() => {
    if (isNavigatingRef.current || pendingNavRef.current) return;
    if (!activeFile?.path || !activeFile?.line) return;
    pushNavEntry(activeFile.path, activeFile.line, 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeFile?.line]);

  // Sync popped-out file content when openFiles change externally
  useEffect(() => {
    setPoppedOutFiles(prev => {
      let changed = false;
      const next = new Map(prev);
      for (const [path, ws] of next) {
        const src = openFiles.find(f => f.path === path);
        if (src && (src.content !== ws.file.content || src.modified !== ws.file.modified || src.externalModified !== ws.file.externalModified)) {
          next.set(path, { ...ws, file: { ...ws.file, content: src.content, modified: src.modified, externalModified: src.externalModified } });
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [openFiles]);

  // Remove popped-out entries when files are closed
  useEffect(() => {
    setPoppedOutFiles(prev => {
      let changed = false;
      const next = new Map(prev);
      for (const path of next.keys()) {
        if (!openFiles.find(f => f.path === path)) { next.delete(path); changed = true; }
      }
      return changed ? next : prev;
    });
  }, [openFiles]);

  const visibleOpenFiles = openFiles.filter(f => !poppedOutFiles.has(f.path));

  const fileName = (path: string) => {
    if (path.startsWith('git-commit-diff:')) {
      // format: git-commit-diff:{hash}:{filePath}
      const parts = path.substring(16);
      const colonIdx = parts.indexOf(':');
      if (colonIdx >= 0) {
        const fp = parts.substring(colonIdx + 1);
        return fp.split(/[\\/]/).pop() ?? fp;
      }
      return parts.split(/[\\/]/).pop() ?? parts;
    }
    if (path.startsWith('git-diff:')) {
      return path.substring(9).split(/[\\/]/).pop() ?? path;
    }
    return path.split(/[\\/]/).pop() ?? path;
  };
  const [selectionInfo, setSelectionInfo] = useState<{ startLine: number; endLine: number; content: string; x: number; y: number } | null>(null);
  const [tabContextMenu, setTabContextMenu] = useState<{ x: number; y: number; path: string } | null>(null);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setTabContextMenu(null);
    };
    if (tabContextMenu) {
      document.addEventListener('keydown', handleKeyDown);
      return () => document.removeEventListener('keydown', handleKeyDown);
    }
  }, [tabContextMenu]);

  const handleEditorMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;
    monacoRef.current = monaco;

    // Register LSP providers (disables built-in TS worker, registers completion/hover/definition/references)
    lsp.onEditorMount(monaco, editor);

    // Scroll to pending line (first mount after opening from search result)
    if (pendingLineRef.current) {
      const lineNumber = pendingLineRef.current;
      pendingLineRef.current = undefined;
      requestAnimationFrame(() => {
        if (editorRef.current) {
          editorRef.current.revealLineInCenter(lineNumber);
          editorRef.current.setPosition({ lineNumber, column: 1 });
          editorRef.current.focus();
        }
      });
    }

    // Listen for selection changes to show floating button
    editor.onDidChangeCursorSelection((e) => {
      const sel = editor.getSelection();
      if (!sel || sel.isEmpty()) {
        setSelectionInfo(null);
        return;
      }
      const startLine = sel.startLineNumber;
      const endLine = sel.endLineNumber;
      if (startLine === endLine && sel.startColumn === sel.endColumn) {
        setSelectionInfo(null);
        return;
      }
      const content = editor.getModel()?.getValueInRange(sel) ?? '';
      if (!content.trim()) {
        setSelectionInfo(null);
        return;
      }
      // Get bottom-right position of selection in editor coordinates
      const endPos = { lineNumber: endLine, column: sel.endColumn };
      const pixelPos = editor.getScrolledVisiblePosition(endPos);
      if (!pixelPos) {
        setSelectionInfo(null);
        return;
      }
      const editorDom = editor.getContainerDomNode();
      const editorRect = editorDom.getBoundingClientRect();
      setSelectionInfo({
        startLine,
        endLine,
        content,
        x: editorRect.left + pixelPos.left + 8,
        y: editorRect.top + pixelPos.top + 20,
      });
    });

    // Track cursor position for Back/Forward navigation history
    editor.onDidChangeCursorPosition((e) => {
      if (isNavigatingRef.current) return;
      // Only track explicit user movements (mouse click, keyboard nav); skip typing-induced moves
      if (e.reason !== monaco.editor.CursorChangeReason.Explicit) return;
      const path = activePathRef.current;
      if (!path) return;
      if (cursorDebounceRef.current) clearTimeout(cursorDebounceRef.current);
      cursorDebounceRef.current = setTimeout(() => {
        const pos = editor.getPosition();
        if (pos && activePathRef.current === path) {
          pushNavEntry(path, pos.lineNumber, pos.column);
        }
        cursorDebounceRef.current = null;
      }, 500);
    });

    // Apply pending Back/Forward navigation if Editor just (re)mounted for the target file
    if (pendingNavRef.current && pendingNavRef.current.path === activePathRef.current) {
      const entry = pendingNavRef.current;
      pendingNavRef.current = null;
      requestAnimationFrame(() => {
        if (editorRef.current) {
          editorRef.current.setPosition({ lineNumber: entry.line, column: entry.column });
          editorRef.current.revealLineInCenter(entry.line);
          editorRef.current.focus();
        }
        isNavigatingRef.current = false;
      });
    }

    // Ctrl+S to save
    editor.addAction({
      id: 'save-file',
      label: 'Save File',
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
      run: () => {
        if (activePathRef.current) {
          onSaveRef.current(activePathRef.current);
        }
      },
    });
  };

  const handleBeforeMount: BeforeMount = (monaco) => {
    // 注册深浅两套主题，使 theme prop 可在运行时切换而无需重新挂载。
    defineXaiDarkTheme(monaco);
    defineXaiLightTheme(monaco);
  };

  // Global Ctrl+S handler
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        if (activePathRef.current) {
          onSaveRef.current(activePathRef.current);
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Ctrl+Tab to cycle tabs; Ctrl+Alt+Left/Right for IDEA-style Back/Forward
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ctrl+Tab / Ctrl+Shift+Tab: cycle through open tabs (skip popped-out ones)
      if ((e.ctrlKey || e.metaKey) && e.key === 'Tab') {
        const files = openFiles.filter(f => !poppedOutFiles.has(f.path));
        if (files.length < 2) return;
        e.preventDefault();
        e.stopPropagation();
        const currentIdx = files.findIndex(f => f.path === activePathRef.current);
        let nextIdx: number;
        if (e.shiftKey) {
          nextIdx = currentIdx <= 0 ? files.length - 1 : currentIdx - 1;
        } else {
          nextIdx = currentIdx < 0 || currentIdx >= files.length - 1 ? 0 : currentIdx + 1;
        }
        onFileSelect(files[nextIdx].path);
        return;
      }
      // Ctrl+Alt+Left/Right: Back/Forward navigation
      if ((e.ctrlKey || e.metaKey) && e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        e.preventDefault();
        e.stopPropagation();
        if (e.key === 'ArrowLeft') goBack();
        else goForward();
      }
    };
    // Use capture phase so Monaco/editor keydown handlers don't get a chance to swallow these
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [openFiles, poppedOutFiles, onFileSelect, goBack, goForward]);

  // Clear selection info on file switch
  useEffect(() => {
    setSelectionInfo(null);
  }, [activeFile?.path]);

  // LSP: notify active document changes (didOpen/didClose)
  useEffect(() => {
    if (!activeFile || activeFile.isBrowser || activeFile.isDbQuery || activeFile.isGitDiff || activeFile.readOnly) {
      lsp.onCloseDocument();
      return;
    }
    lsp.onActiveFileChange(activeFile.path, activeFile.content);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeFile?.path]);

  // Apply diff line decorations for git diff files
  useEffect(() => {
    if (!activeFile?.isGitDiff || !editorRef.current || !monacoRef.current) return;

    const editor = editorRef.current;
    const monaco = monacoRef.current;
    const model = editor.getModel();
    if (!model) return;

    const lines = model.getValue().split('\n');
    const decos: any[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith('+') && !line.startsWith('+++')) {
        decos.push({
          range: new monaco.Range(i + 1, 1, i + 1, 1),
          options: {
            isWholeLine: true,
            className: 'diff-line-add',
            overviewRuler: { color: '#5ac8a066', position: monaco.editor.OverviewRulerLane.Left },
          },
        });
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        decos.push({
          range: new monaco.Range(i + 1, 1, i + 1, 1),
          options: {
            isWholeLine: true,
            className: 'diff-line-del',
            overviewRuler: { color: '#ff6b6b66', position: monaco.editor.OverviewRulerLane.Left },
          },
        });
      } else if (line.startsWith('@@')) {
        decos.push({
          range: new monaco.Range(i + 1, 1, i + 1, 1),
          options: {
            isWholeLine: true,
            className: 'diff-line-hunk',
          },
        });
      } else if (line.startsWith('diff --git') || line.startsWith('index ')) {
        decos.push({
          range: new monaco.Range(i + 1, 1, i + 1, 1),
          options: {
            isWholeLine: true,
            className: 'diff-line-header',
          },
        });
      } else if (line.startsWith('--- ') || line.startsWith('+++ ')) {
        decos.push({
          range: new monaco.Range(i + 1, 1, i + 1, 1),
          options: {
            isWholeLine: true,
            className: 'diff-line-file-header',
          },
        });
      }
    }

    const prev = editor.deltaDecorations([], decos);
    return () => {
      // Only clear if editor still mounted and model unchanged
      try { editor.deltaDecorations(prev, []); } catch { /* model replaced */ }
    };
  }, [activeFile?.path, activeFile?.content, activeFile?.isGitDiff]);

  // Scroll to line when activeFile.line changes
  useEffect(() => {
    // Skip when navigating via Back/Forward (pendingNavRef handles position)
    if (isNavigatingRef.current || pendingNavRef.current) return;
    if (activeFile?.line && editorRef.current) {
      const lineNumber = activeFile.line;
      // Use requestAnimationFrame to ensure the editor has rendered
      requestAnimationFrame(() => {
        if (editorRef.current) {
          editorRef.current.revealLineInCenter(lineNumber);
          editorRef.current.setPosition({ lineNumber, column: 1 });
          editorRef.current.focus();
        }
      });
    }
  }, [activeFile?.path, activeFile?.line]);

  return (
    <div className="editor-panel" ref={panelRef}>

      <div className="editor-tabs" ref={tabbarRef}>
        {visibleOpenFiles.length === 0 && poppedOutFiles.size === 0 && (
          <span className="editor-tabs-placeholder">EDITOR</span>
        )}
        {visibleOpenFiles.map((file) => (
          <div
            key={file.path}
            className={`editor-tab ${file.path === activeFile?.path ? 'active' : ''} ${file.isGitDiff ? 'git-diff-tab' : ''}`}
            onClick={() => onFileSelect(file.path)}
            onDoubleClick={() => handleTabDoubleClick(file)}
            onContextMenu={(e) => {
              e.preventDefault();
              setTabContextMenu({ x: e.clientX, y: e.clientY, path: file.path });
            }}
          >
            {file.isGitDiff && <GitBranch size={12} className="tab-git-icon" />}
            {file.isDbQuery && !file.isTableStructure && <Database size={12} className="tab-git-icon" style={{ color: '#60a5fa' }} />}
            {file.isTableStructure && <Columns3 size={12} className="tab-git-icon" style={{ color: '#d4a76a' }} />}
            {file.isBrowser && <Globe size={12} className="tab-git-icon" style={{ color: '#60a5fa' }} />}
            <span className="tab-name">{file.isTableStructure ? `${file.dbQuery?.tableName || fileName(file.path)} 结构` : file.isDbQuery ? (file.dbQuery?.tableName || `SQL编辑器 - ${file.dbQuery?.connName || ''}/${file.dbQuery?.schema || ''}`) : file.isBrowser ? (file.content && file.content !== 'about:blank' ? file.content.replace(/^https?:\/\//, '').replace(/\/$/, '').substring(0, 30) : '新标签页') : fileName(file.path)}</span>
            {file.modified && <span className="tab-dot" />}
            <button
              className="tab-close"
              onClick={(e) => {
                e.stopPropagation();
                onFileClose(file.path);
              }}
            >
              <X size={12} />
            </button>
          </div>
        ))}
      </div>

      {tabContextMenu && (
        <>
          <div className="tab-context-overlay" onClick={() => setTabContextMenu(null)} />
          <div className="tab-context-menu" style={{ left: tabContextMenu.x, top: tabContextMenu.y }}>
            <div className="tab-context-item" onClick={() => { onFileClose(tabContextMenu.path); setTabContextMenu(null); }}>
              关闭
            </div>
            <div className="tab-context-item" onClick={() => { onFileCloseOthers(tabContextMenu.path); setTabContextMenu(null); }}>
              关闭其他
            </div>
            {visibleOpenFiles.indexOf(visibleOpenFiles.find(f => f.path === tabContextMenu.path)!) < visibleOpenFiles.length - 1 && (
              <div className="tab-context-item" onClick={() => { onFileCloseRight(tabContextMenu.path); setTabContextMenu(null); }}>
                关闭右侧
              </div>
            )}
            <div className="tab-context-item" onClick={() => { onFileCloseAll(); setTabContextMenu(null); }}>
              关闭全部
            </div>
            <div className="tab-context-separator" />
            <div className="tab-context-item" onClick={() => {
              const file = visibleOpenFiles.find(f => f.path === tabContextMenu.path);
              if (file) handleTabDoubleClick(file);
              setTabContextMenu(null);
            }}>
              弹出窗口
            </div>
            <div className="tab-context-item" onClick={async () => { const p = tabContextMenu.path; setTabContextMenu(null); try { await window.electronAPI.invoke('file:show-in-explorer', p); } catch {} }}>
              在资源管理器中显示
            </div>
          </div>
        </>
      )}

      <div className="editor-content">
        {activeFile && !poppedOutFiles.has(activeFile.path) ? (
          activeFile.isBrowser && activeFile.browserSessionId ? (
            <BrowserPanel
              key={activeFile.path}
              sessionId={activeFile.browserSessionId}
              initialUrl={activeFile.content}
            />
          ) : activeFile.isDbQuery && activeFile.dbQuery ? (
            <DbQueryPanel
              key={activeFile.path}
              sql={activeFile.content}
              connName={activeFile.dbQuery.connName}
              connId={activeFile.path}
              dbType={activeFile.dbQuery.dbType}
              jdbcUrl={activeFile.dbQuery.jdbcUrl}
              username={activeFile.dbQuery.username}
              password={activeFile.dbQuery.password}
              schema={activeFile.dbQuery.schema}
              isModified={activeFile.modified}
              isTableStructure={activeFile.isTableStructure}
              tableName={activeFile.dbQuery.tableName}
              onSqlChange={onFileChange}
              initialResult={dbResultCache.current.get(activeFile.path) ?? null}
              onResultChange={(r) => { dbResultCache.current.set(activeFile.path, r); }}
            />
          ) : (
          <>
            {activeFile.externalModified && (
              <div className="editor-reload-bar">
                <span className="reload-bar-icon">&#x26A0;</span>
                <span className="reload-bar-text">
                  {activeFile.modified
                    ? 'This file has been modified externally and has unsaved local changes.'
                    : 'This file has been modified externally.'}
                </span>
                <button
                  className="reload-bar-btn"
                  onClick={() => onFileReload(activeFile.path)}
                >
                  Reload
                </button>
              </div>
            )}
            {activeFile.readOnly && (
              <div className="editor-readonly-bar">
                <span className="readonly-text">{activeFile.isGitDiff ? 'Git Diff (read-only)' : 'Read-only'}</span>
              </div>
            )}
            {lspProgress && (
              <div className={`lsp-progress-bar ${lspProgress.percent < 0 ? 'lsp-progress-error' : ''}`}>
                <span className="lsp-progress-text">{lspProgress.message}</span>
                {lspProgress.percent >= 0 && (
                  <div className="lsp-progress-track">
                    <div className="lsp-progress-fill" style={{ width: `${lspProgress.percent}%` }} />
                  </div>
                )}
              </div>
            )}
            <Editor
              height="100%"
              language={activeFile.isGitDiff ? 'diff' : getLanguage(activeFile.path)}
              value={activeFile.content}
              onChange={activeFile.readOnly ? undefined : (value) => {
                onFileChange(value);
                lsp.onContentChange(value ?? '');
              }}
              onMount={handleEditorMount}
              beforeMount={handleBeforeMount}
              theme={codeViewTheme === 'light' ? 'xai-light' : 'xai-dark'}
              options={{
                fontSize: 13,
                fontFamily: "var(--font-mono)",
                minimap: { enabled: false },
                readOnly: activeFile.readOnly ?? false,
                scrollBeyondLastLine: false,
                wordWrap: 'on',
                automaticLayout: true,
                padding: { top: 8 },
                lineNumbers: 'on',
                renderLineHighlight: 'line',
                cursorBlinking: 'smooth',
                links: false,
                smoothScrolling: true,
                scrollbar: {
                  verticalScrollbarSize: 6,
                  horizontalScrollbarSize: 6,
                  useShadows: false,
                  verticalHasArrows: false,
                  horizontalHasArrows: false,
                  alwaysConsumeMouseWheel: false,
                },
                overviewRulerBorder: false,
                hideCursorInOverviewRuler: true,
                guides: {
                  indentation: true,
                  bracketPairs: true,
                },
                renderLineHighlightOnlyWhenFocus: false,
              }}
            />
          </>
          )
        ) : (
          <div className="editor-empty">
            <span>No file open</span>
          </div>
        )}
      </div>

      {selectionInfo && onAddCodeToChat && activeFile && (
        <div
          className="editor-add-to-chat-btn"
          style={{ 
            position: 'fixed', 
            left: Math.min(selectionInfo.x, window.innerWidth - 120), // Ensure button doesn't go off-screen
            top: Math.min(selectionInfo.y, window.innerHeight - 30)  // Ensure button doesn't go off-screen at bottom
          }}
          onClick={() => {
            onAddCodeToChat({
              type: 'code',
              filePath: activeFile.path,
              startLine: selectionInfo.startLine,
              endLine: selectionInfo.endLine,
              content: selectionInfo.content,
            });
            setSelectionInfo(null);
          }}
        >
          <MessageSquare size={12} />
          <span>添加到对话</span>
        </div>
      )}

      {/* Floating editor windows */}
      {Array.from(poppedOutFiles.entries()).map(([path, ws]) => (
        <FloatingEditorWindow
          key={path}
          state={ws}
          codeViewTheme={codeViewTheme}
          onClose={() => handleFloatingClose(path)}
          onMinimize={() => handleFloatingMinimize(path)}
          onMaximize={() => handleFloatingMaximize(path)}
          onFocus={() => handleFloatingFocus(path)}
          onContentChange={(v) => handleFloatingContentChange(path, v)}
          onSave={() => handleFloatingSave(path)}
          onReload={() => handleFloatingReload(path)}
          onDragEnd={(x, y) => handleFloatingDragEnd(path, x, y)}
          onPositionChange={(x, y) => handleFloatingPositionChange(path, x, y)}
          onResize={(x, y, w, h) => handleFloatingResize(path, x, y, w, h)}
          tabbarRef={tabbarRef}
          containerRef={panelRef}
        />
      ))}

      {/* Minimized badges */}
      {Array.from(poppedOutFiles.entries()).filter(([, ws]) => ws.isMinimized).length > 0 && (
        <div className="fw-minimized-badges">
          {Array.from(poppedOutFiles.entries()).filter(([, ws]) => ws.isMinimized).map(([path, ws]) => (
            <div
              key={path}
              className="fw-minimized-badge"
              onClick={() => handleMinimizedBadgeClick(path)}
              title={ws.file.path}
            >
              <span className="fw-badge-name">{fileName(path)}</span>
              <button
                className="fw-badge-close"
                onClick={(e) => { e.stopPropagation(); handleFloatingClose(path); }}
              >
                <X size={10} />
              </button>
            </div>
          ))}
        </div>
      )}

      <style>{`
        .editor-panel {
          display: flex;
          flex-direction: column;
          height: 100%;
          overflow: hidden;
        }
        .panel-header {
          padding: 4px 12px;
          min-height: 32px;
        }
        .editor-tabs {
          display: flex;
          background: var(--bg-primary);
          border-bottom: 1px solid var(--border);
          overflow-x: auto;
          overflow-y: hidden;
          min-height: 32px;
          scrollbar-width: none;
        }
        .editor-tabs::-webkit-scrollbar {
          height: 0;
          display: none;
        }
        .editor-tabs-placeholder {
          display: flex;
          align-items: center;
          justify-content: center;
          flex: 1;
          font-size: 11px;
          letter-spacing: 0.15em;
          color: var(--text-secondary);
          user-select: none;
          pointer-events: none;
        }
        .editor-tab {
          display: flex;
          align-items: center;
          gap: 4px;
          padding: 6px 14px;
          font-size: 12px;
          cursor: pointer;
          border-right: 1px solid var(--border);
          white-space: nowrap;
          user-select: none;
          color: var(--text-secondary);
          background: var(--bg-secondary);
          min-width: 0;
          transition: background 0.15s ease, color 0.15s ease;
        }
        .editor-tab:hover {
          background: var(--bg-hover);
          color: var(--text-primary);
        }
        .editor-tab.active {
          background: var(--bg-primary);
          color: var(--text-primary);
          border-bottom: 2px solid var(--accent);
          margin-bottom: -1px;
        }
        .tab-name {
          overflow: hidden;
          text-overflow: ellipsis;
          font-family: var(--font-mono);
          font-size: 11px;
        }
        .tab-dot {
          width: 5px;
          height: 5px;
          border-radius: 50%;
          background: var(--accent);
          flex-shrink: 0;
        }
        .tab-close {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 18px;
          height: 18px;
          border-radius: var(--radius-sm);
          color: var(--text-muted);
          opacity: 0;
          transition: opacity 0.15s ease, background 0.15s ease, color 0.15s ease;
        }
        .editor-tab:hover .tab-close {
          opacity: 1;
        }
        .tab-close:hover {
          background: rgba(255, 255, 255, 0.08);
          color: var(--error);
        }
        .git-diff-tab {
          border-bottom: 2px solid transparent;
        }
        .git-diff-tab .tab-name {
          color: #a78bfa;
        }
        .git-diff-tab.active {
          border-bottom: 2px solid #a78bfa;
        }
        .tab-git-icon {
          color: #a78bfa;
          flex-shrink: 0;
        }
        .editor-readonly-bar {
          display: flex;
          align-items: center;
          justify-content: flex-start;
          padding: 4px 12px;
          background: rgba(167, 139, 250, 0.08);
          border-bottom: 1px solid rgba(167, 139, 250, 0.15);
        }
        .readonly-text {
          font-size: 11px;
          color: #a78bfa;
          letter-spacing: 0.03em;
        }
        .lsp-progress-bar {
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 5px 12px;
          background: rgba(96, 165, 250, 0.06);
          border-bottom: 1px solid rgba(96, 165, 250, 0.12);
          font-size: 11px;
          flex-shrink: 0;
        }
        .lsp-progress-bar.lsp-progress-error {
          background: rgba(255, 107, 107, 0.08);
          border-bottom-color: rgba(255, 107, 107, 0.2);
        }
        .lsp-progress-text {
          flex: 1;
          color: #60a5fa;
          font-family: var(--font-mono);
          font-size: 11px;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .lsp-progress-error .lsp-progress-text {
          color: #ff6b6b;
        }
        .lsp-progress-track {
          width: 120px;
          height: 3px;
          background: rgba(96, 165, 250, 0.15);
          border-radius: 2px;
          overflow: hidden;
          flex-shrink: 0;
        }
        .lsp-progress-fill {
          height: 100%;
          background: #60a5fa;
          transition: width 0.2s ease;
        }
        .editor-content {
          flex: 1;
          overflow: hidden;
          min-height: 0;
        }
        /* Monaco Editor scrollbar styling */
        .editor-content .monaco-scrollable-element > .scrollbar {
          width: 6px !important;
        }
        .editor-content .monaco-scrollable-element > .scrollbar > .slider {
          background: rgba(255, 255, 255, 0.08) !important;
          border-radius: 3px !important;
        }
        .editor-content .monaco-scrollable-element > .scrollbar > .slider:hover {
          background: rgba(255, 255, 255, 0.18) !important;
        }
        .editor-content .minimap-slider {
          background: rgba(255, 255, 255, 0.03) !important;
        }
        .editor-reload-bar {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 6px 12px;
          background: #2a2a1a;
          border-bottom: 1px solid #4a4a2a;
          font-size: 12px;
          flex-shrink: 0;
          animation: reloadBarSlideIn 0.2s ease;
        }
        @keyframes reloadBarSlideIn {
          from { opacity: 0; transform: translateY(-100%); }
          to { opacity: 1; transform: translateY(0); }
        }
        .reload-bar-icon {
          font-size: 14px;
          color: #e8c547;
          flex-shrink: 0;
        }
        .reload-bar-text {
          flex: 1;
          color: #c8c0b0;
          font-family: var(--font-mono);
          font-size: 11px;
        }
        .reload-bar-btn {
          padding: 3px 10px;
          border: 1px solid #4a4a2a;
          border-radius: var(--radius-sm);
          background: transparent;
          color: #e8c547;
          font-size: 11px;
          font-family: var(--font-mono);
          cursor: pointer;
          flex-shrink: 0;
          transition: background 0.15s ease, color 0.15s ease;
        }
        .reload-bar-btn:hover {
          background: #e8c547;
          color: #0e0f14;
        }
        .editor-empty {
          display: flex;
          align-items: center;
          justify-content: center;
          height: 100%;
          color: var(--text-muted);
          font-size: 14px;
        }
        .editor-add-to-chat-btn {
          display: flex;
          align-items: center;
          gap: 5px;
          padding: 4px 10px;
          border-radius: var(--radius-sm);
          background: #f8f9fa;
          border: 1px solid var(--border);
          color: #0e0f14;
          font-size: 11px;
          font-family: var(--font-mono);
          cursor: pointer;
          z-index: 1000;
          box-shadow: 0 4px 12px rgba(0,0,0,0.4);
          animation: addToChatFadeIn 0.15s ease;
          transition: background 0.15s ease, color 0.15s ease;
          white-space: nowrap;
        }
        .editor-add-to-chat-btn:hover {
          background: var(--accent);
          color: var(--bg-primary);
        }
        @keyframes addToChatFadeIn {
          from { opacity: 0; transform: translateY(-4px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .tab-context-overlay {
          position: fixed;
          inset: 0;
          z-index: 10000;
        }
        .tab-context-menu {
          position: fixed;
          z-index: 10001;
          background: var(--bg-secondary);
          border: 1px solid var(--border);
          border-radius: var(--radius-md);
          box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
          padding: 4px 0;
          min-width: 140px;
        }
        .tab-context-item {
          padding: 6px 12px;
          font-size: 12px;
          color: var(--text-primary);
          cursor: pointer;
          transition: background 0.1s;
        }
        .tab-context-item:hover {
          background: var(--bg-hover);
        }
        .tab-context-separator {
          height: 1px;
          background: var(--border);
          margin: 4px 0;
        }
        /* Diff line decorations */
        .diff-line-add {
          background: rgba(90, 200, 160, 0.10) !important;
        }
        .diff-line-add .line-numbers {
          color: #5ac8a0;
        }
        .diff-line-del {
          background: rgba(255, 107, 107, 0.10) !important;
        }
        .diff-line-del .line-numbers {
          color: #ff6b6b;
        }
        .diff-line-hunk {
          background: rgba(167, 139, 250, 0.08) !important;
        }
        .diff-line-header {
          background: rgba(100, 160, 220, 0.07) !important;
        }
        .diff-line-header .line-numbers {
          color: #6ec6ff;
        }
        .diff-line-file-header {
          background: rgba(100, 160, 220, 0.05) !important;
        }
        .diff-line-file-header .line-numbers {
          color: #6ec6ff;
        }
        /* ── Floating Editor Window ── */
        .fw-minimized-badges {
          position: absolute;
          bottom: 8px;
          right: 8px;
          display: flex;
          flex-direction: column;
          gap: 4px;
          z-index: 9999;
        }
        .fw-minimized-badge {
          display: flex;
          align-items: center;
          gap: 6px;
          padding: 4px 10px;
          background: var(--bg-secondary);
          border: 1px solid var(--border);
          border-radius: var(--radius-md);
          cursor: pointer;
          font-size: 11px;
          font-family: var(--font-mono);
          color: var(--text-secondary);
          transition: background 0.15s, color 0.15s, box-shadow 0.15s;
          box-shadow: 0 2px 8px rgba(0,0,0,0.4);
          user-select: none;
          max-width: 160px;
        }
        .fw-minimized-badge:hover {
          background: var(--bg-hover);
          color: var(--text-primary);
          box-shadow: 0 4px 12px rgba(0,0,0,0.5);
        }
        .fw-badge-name {
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .fw-badge-close {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 16px;
          height: 16px;
          border: none;
          background: transparent;
          color: var(--text-muted);
          border-radius: var(--radius-sm);
          cursor: pointer;
          flex-shrink: 0;
          transition: background 0.15s, color 0.15s;
        }
        .fw-badge-close:hover {
          background: rgba(255,255,255,0.1);
          color: var(--error);
        }
        /* ── Code 视图浅色皮肤覆盖 ──
           下方规则仅在 <body data-code-theme="light"> 时生效。
           覆盖本组件内联样式中硬编码的 rgba(255,255,255,*)（白底上不可见）
           与 Monaco 滚动条 !important 白色覆盖。reload-bar / diff 装饰等
           自包含颜色在深浅背景下均可读，不覆盖。 */
        body[data-code-theme="light"] .tab-close:hover {
          background: rgba(0, 0, 0, 0.06);
        }
        body[data-code-theme="light"] .editor-content .monaco-scrollable-element > .scrollbar > .slider {
          background: rgba(0, 0, 0, 0.18) !important;
        }
        body[data-code-theme="light"] .editor-content .monaco-scrollable-element > .scrollbar > .slider:hover {
          background: rgba(0, 0, 0, 0.3) !important;
        }
        body[data-code-theme="light"] .editor-content .minimap-slider {
          background: rgba(0, 0, 0, 0.06) !important;
        }
        body[data-code-theme="light"] .fw-badge-close:hover {
          background: rgba(0, 0, 0, 0.06);
        }
        /* 添加到对话浮钮：深色下用 #f8f9fa 浅底，浅色下改为 accent 描边白底，阴影柔化 */
        body[data-code-theme="light"] .editor-add-to-chat-btn {
          background: #ffffff;
          border-color: var(--border);
          color: var(--text-primary);
          box-shadow: 0 4px 12px rgba(0, 0, 0, 0.12);
        }
      `}</style>
    </div>
  );
}
