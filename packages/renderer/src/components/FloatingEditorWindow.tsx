import { useRef, useEffect, useCallback, useState, memo } from 'react';
import { createPortal } from 'react-dom';
import Editor, { OnMount, BeforeMount } from '@monaco-editor/react';
type MonacoEditor = Parameters<OnMount>[0];
import { X, Minus, Square, Copy } from 'lucide-react';
import type { CodeViewTheme } from '@xai/shared';
import { defineXaiDarkTheme, defineXaiLightTheme } from '../monaco/theme';

interface FloatingEditorFile {
  path: string;
  content: string;
  modified: boolean;
  externalModified?: boolean;
  readOnly?: boolean;
  isGitDiff?: boolean;
  line?: number;
}

export interface FloatingWindowState {
  file: FloatingEditorFile;
  x: number;
  y: number;
  width: number;
  height: number;
  isMaximized: boolean;
  isMinimized: boolean;
  zIndex: number;
  restoreRect?: { x: number; y: number; width: number; height: number };
}

interface FloatingEditorWindowProps {
  state: FloatingWindowState;
  /** 跟随 EditorPanel 的皮肤主题（浮窗从 EditorPanel 派生）。 */
  codeViewTheme?: CodeViewTheme;
  onClose: () => void;          // dock back to tab bar
  onMinimize: () => void;
  onMaximize: () => void;
  onFocus: () => void;
  onContentChange: (value: string | undefined) => void;
  onSave: () => void;
  onReload: () => void;
  onDragEnd: (x: number, y: number) => void;  // for dock-back detection
  onPositionChange: (x: number, y: number) => void;
  onResize: (x: number, y: number, width: number, height: number) => void;
  tabbarRef: React.RefObject<HTMLElement | null>;
  containerRef: React.RefObject<HTMLElement | null>;
}

function getLanguage(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
    json: 'json', md: 'markdown', css: 'css', scss: 'scss', less: 'less',
    html: 'html', py: 'python', rs: 'rust', go: 'go',
    java: 'java', c: 'c', cpp: 'cpp', h: 'c', hpp: 'cpp',
    cs: 'csharp', php: 'php', rb: 'ruby', swift: 'swift',
    kt: 'kotlin', scala: 'scala', dart: 'dart', lua: 'lua', r: 'r', vue: 'html',
    yaml: 'yaml', yml: 'yaml', toml: 'toml',
    sh: 'shell', bash: 'shell', sql: 'sql', xml: 'xml', svg: 'xml',
    properties: 'ini', ini: 'ini', cfg: 'ini', conf: 'ini',
    graphql: 'graphql', dockerfile: 'dockerfile',
  };
  const fileName = filePath.split(/[\\/]/).pop()?.toLowerCase() ?? '';
  if (fileName === 'dockerfile') return 'dockerfile';
  return map[ext] ?? 'plaintext';
}

function fileName(path: string): string {
  if (path.startsWith('git-commit-diff:')) {
    const parts = path.substring(16);
    const colonIdx = parts.indexOf(':');
    if (colonIdx >= 0) return parts.substring(colonIdx + 1).split(/[\\/]/).pop() ?? parts;
    return parts.split(/[\\/]/).pop() ?? parts;
  }
  if (path.startsWith('git-diff:')) return path.substring(9).split(/[\\/]/).pop() ?? path;
  return path.split(/[\\/]/).pop() ?? path;
}

function FloatingEditorWindow({
  state,
  codeViewTheme = 'dark',
  onClose,
  onMinimize,
  onMaximize,
  onFocus,
  onContentChange,
  onSave,
  onReload,
  onDragEnd,
  onPositionChange,
  onResize,
  tabbarRef,
  containerRef,
}: FloatingEditorWindowProps) {
  const { file, x, y, width, height, isMaximized, isMinimized, zIndex } = state;

  const editorRef = useRef<MonacoEditor | null>(null);
  const dragRef = useRef({ dragging: false, startX: 0, startY: 0, origX: 0, origY: 0 });
  const resizeRef = useRef<{ dir: string; startX: number; startY: number; origX: number; origY: number; origW: number; origH: number } | null>(null);
  const [showDropZone, setShowDropZone] = useState(false);

  // Scroll to line on mount
  useEffect(() => {
    if (file.line && editorRef.current) {
      const ln = file.line;
      requestAnimationFrame(() => {
        editorRef.current?.revealLineInCenter(ln);
        editorRef.current?.setPosition({ lineNumber: ln, column: 1 });
        editorRef.current?.focus();
      });
    }
  }, [file.path, file.line]);

  const handleBeforeMount: BeforeMount = (monaco) => {
    // 注册深浅两套主题，使 theme prop 可在运行时切换。
    defineXaiDarkTheme(monaco);
    defineXaiLightTheme(monaco);
  };

  const handleEditorMount: OnMount = (editor) => {
    editorRef.current = editor;
  };

  // Drag handlers
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('.fw-btn')) return;
    if (isMaximized) return; // Must restore first before dragging
    e.preventDefault();
    onFocus();

    dragRef.current = { dragging: true, startX: e.clientX, startY: e.clientY, origX: x, origY: y };

    const onMouseMove = (ev: MouseEvent) => {
      if (!dragRef.current.dragging) return;
      const dx = ev.clientX - dragRef.current.startX;
      const dy = ev.clientY - dragRef.current.startY;
      onPositionChange(dragRef.current.origX + dx, dragRef.current.origY + dy);

      // Show drop zone if over tab bar
      if (tabbarRef.current) {
        const rect = tabbarRef.current.getBoundingClientRect();
        const inZone = ev.clientX >= rect.left && ev.clientX <= rect.right &&
                       ev.clientY >= rect.top - 20 && ev.clientY <= rect.bottom + 20;
        setShowDropZone(inZone);
      }
    };

    const onMouseUp = (ev: MouseEvent) => {
      dragRef.current.dragging = false;
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);

      // Check if dropped on tab bar
      if (tabbarRef.current) {
        const rect = tabbarRef.current.getBoundingClientRect();
        const inZone = ev.clientX >= rect.left && ev.clientX <= rect.right &&
                       ev.clientY >= rect.top - 20 && ev.clientY <= rect.bottom + 20;
        if (inZone) {
          setShowDropZone(false);
          onDragEnd(ev.clientX, ev.clientY);
          return;
        }
      }
      setShowDropZone(false);
      onDragEnd(ev.clientX, ev.clientY);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, [isMaximized, x, y, onFocus, onMaximize, onPositionChange, onDragEnd, tabbarRef]);

  // Double-click title bar to maximize/restore
  const handleDoubleClickTitle = useCallback(() => {
    onMaximize();
  }, [onMaximize]);

  // Resize handler
  const MIN_W = 320, MIN_H = 200;
  const handleResizeMouseDown = useCallback((e: React.MouseEvent, dir: string) => {
    if (isMaximized) return;
    e.preventDefault();
    e.stopPropagation();
    onFocus();
    resizeRef.current = { dir, startX: e.clientX, startY: e.clientY, origX: x, origY: y, origW: width, origH: height };

    const onMouseMove = (ev: MouseEvent) => {
      const r = resizeRef.current;
      if (!r) return;
      const dx = ev.clientX - r.startX;
      const dy = ev.clientY - r.startY;
      let nx = r.origX, ny = r.origY, nw = r.origW, nh = r.origH;

      if (r.dir.includes('e')) { nw = Math.max(MIN_W, r.origW + dx); }
      if (r.dir.includes('w')) { nw = Math.max(MIN_W, r.origW - dx); if (nw > MIN_W) nx = r.origX + dx; }
      if (r.dir.includes('s')) { nh = Math.max(MIN_H, r.origH + dy); }
      if (r.dir.includes('n')) { nh = Math.max(MIN_H, r.origH - dy); if (nh > MIN_H) ny = r.origY + dy; }

      onResize(nx, ny, nw, nh);
    };

    const onMouseUp = () => {
      resizeRef.current = null;
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = '';
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    // Set cursor for resize direction
    const cursors: Record<string, string> = { n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize', ne: 'nesw-resize', sw: 'nesw-resize', nw: 'nwse-resize', se: 'nwse-resize' };
    document.body.style.cursor = cursors[dir] || 'default';
  }, [isMaximized, x, y, width, height, onFocus, onResize]);

  // Resize handling: if maximized and window resizes, keep maximized
  useEffect(() => {
    if (!isMaximized) return;
    const handleResize = () => {
      // Re-maximize on window resize
      onMaximize(); // toggle off then on again — parent handles the logic
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [isMaximized, onMaximize]);

  if (isMinimized) return null; // minimized → badge rendered by parent

  // Measure main app title bar height to avoid overlap when maximized
  const titleBarEl = typeof document !== 'undefined' ? document.querySelector('.title-bar') : null;
  const titleBarH = titleBarEl ? titleBarEl.getBoundingClientRect().height : 0;

  const style: React.CSSProperties = isMaximized
    ? { position: 'fixed', left: 0, top: titleBarH, width: '100vw', height: `calc(100vh - ${titleBarH}px)`, zIndex }
    : { position: 'fixed', left: x, top: y, width, height, zIndex };

  return createPortal(
    <>
      {showDropZone && containerRef.current && createPortal(
        <div className="fw-drop-indicator">
          <span>释放以还原为标签页</span>
        </div>,
        containerRef.current,
      )}
      <div
        className={`floating-editor-window ${isMaximized ? 'maximized' : ''}`}
        style={style}
        onMouseDown={onFocus}
      >
        {/* Resize handles (hidden when maximized) */}
        {!isMaximized && (
          <>
            <div className="fw-resize fw-resize-n"  onMouseDown={e => handleResizeMouseDown(e, 'n')} />
            <div className="fw-resize fw-resize-s"  onMouseDown={e => handleResizeMouseDown(e, 's')} />
            <div className="fw-resize fw-resize-e"  onMouseDown={e => handleResizeMouseDown(e, 'e')} />
            <div className="fw-resize fw-resize-w"  onMouseDown={e => handleResizeMouseDown(e, 'w')} />
            <div className="fw-resize fw-resize-ne" onMouseDown={e => handleResizeMouseDown(e, 'ne')} />
            <div className="fw-resize fw-resize-nw" onMouseDown={e => handleResizeMouseDown(e, 'nw')} />
            <div className="fw-resize fw-resize-se" onMouseDown={e => handleResizeMouseDown(e, 'se')} />
            <div className="fw-resize fw-resize-sw" onMouseDown={e => handleResizeMouseDown(e, 'sw')} />
          </>
        )}

        {/* Title bar */}
        <div
          className="fw-titlebar"
          onMouseDown={handleMouseDown}
          onDoubleClick={handleDoubleClickTitle}
        >
          <div className="fw-title">
            {file.isGitDiff && <span className="fw-title-icon">⑂</span>}
            <span>{fileName(file.path)}</span>
            {file.modified && <span className="fw-modified-dot" />}
          </div>
          <div className="fw-controls">
            <button className="fw-btn" onClick={onMinimize} title="最小化">
              <Minus size={12} />
            </button>
            <button className="fw-btn" onClick={() => onMaximize()} title={isMaximized ? '还原' : '最大化'}>
              {isMaximized ? <Copy size={11} /> : <Square size={11} />}
            </button>
            <button className="fw-btn fw-btn-close" onClick={onClose} title="还原为标签页">
              <X size={12} />
            </button>
          </div>
        </div>

        {/* Editor content */}
        <div className="fw-editor-content">
          {file.externalModified && (
            <div className="fw-reload-bar">
              <span className="fw-reload-icon">&#x26A0;</span>
              <span className="fw-reload-text">
                {file.modified
                  ? 'This file has been modified externally and has unsaved local changes.'
                  : 'This file has been modified externally.'}
              </span>
              <button className="fw-reload-btn" onClick={onReload}>Reload</button>
            </div>
          )}
          {file.readOnly && file.isGitDiff && (
            <div className="fw-readonly-bar">Git Diff (read-only)</div>
          )}
          <Editor
            height="100%"
            language={file.isGitDiff ? 'diff' : getLanguage(file.path)}
            value={file.content}
            onChange={file.readOnly ? undefined : onContentChange}
            onMount={handleEditorMount}
            beforeMount={handleBeforeMount}
            theme={codeViewTheme === 'light' ? 'xai-light' : 'xai-dark'}
            options={{
              fontSize: 13,
              fontFamily: 'var(--font-mono)',
              minimap: { enabled: false },
              readOnly: file.readOnly ?? false,
              scrollBeyondLastLine: false,
              wordWrap: 'on',
              automaticLayout: true,
              padding: { top: 8 },
              lineNumbers: 'on',
              renderLineHighlight: 'line',
              cursorBlinking: 'smooth',
              smoothScrolling: true,
              scrollbar: {
                verticalScrollbarSize: 6,
                horizontalScrollbarSize: 6,
                useShadows: false,
                alwaysConsumeMouseWheel: false,
              },
              overviewRulerBorder: false,
              hideCursorInOverviewRuler: true,
              guides: { indentation: true, bracketPairs: true },
            }}
          />
        </div>
      </div>
    </>,
    document.body,
  );
}

export default memo(FloatingEditorWindow);
