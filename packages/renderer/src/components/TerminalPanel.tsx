import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { Trash2, Minimize2, Maximize2, X, Plus, Loader2 } from 'lucide-react';
import { IPCChannel } from '@xai/shared';
import { Terminal as XtermTerminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

// ============ Types ============

interface TerminalTab {
  id: string;           // sessionId or 'cmd' for the built-in command tab
  label: string;        // display name like "cmd #1"
  shell: string;        // shell type
  isBuiltin: boolean;   // true = the cmd execute_command tab
  isUserTerminal?: boolean; // true = user-created terminal
  status: 'active' | 'closed';
  output: string;
  sessionId?: string;   // real sessionId for tooltip
}

interface TerminalPanelProps {
  commandOutput: { commandId: string; command: string; output: string; status: string }[];
  onClearCommandOutput: () => void;
  minimized: boolean;
  onToggleMinimize: () => void;
  onAutoExpand?: () => void;
}

// ============ Helpers ============


function getShellDisplayName(shell: string, existingTabs: TerminalTab[]): string {
  const name = shell.toLowerCase();
  const displayNames: Record<string, string> = {
    cmd: 'cmd',
    powershell: 'PowerShell',
    pwsh: 'pwsh',
    bash: 'bash',
    zsh: 'zsh',
    sh: 'sh',
  };
  const displayName = displayNames[name] ?? name;
  const count = existingTabs.filter((t) => t.shell.toLowerCase() === name).length;
  return `${displayName} #${count + 1}`;
}

function normalizeLabel(tab: TerminalTab): string {
  if (tab.isBuiltin) return 'CMD';
  return tab.label;
}

// Strip ANSI escape codes for plain-text display (tab labels, etc.)
const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]|\x1b\].*?(?:\x07|\x1b\\)|\x1b[()][AB012]|\x1b[=>]/g;
function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '');
}

// ============ Xterm Container Component ============

function XtermContainer({
  sessionId,
  outputBuffers,
  xtermInstances,
}: {
  sessionId: string;
  outputBuffers: React.MutableRefObject<Map<string, string>>;
  xtermInstances: React.MutableRefObject<Map<string, { term: XtermTerminal; fitAddon: FitAddon; container: HTMLDivElement }>>;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const initialized = useRef(false);

  useEffect(() => {
    if (!containerRef.current || initialized.current) return;
    initialized.current = true;

    const term = new XtermTerminal({
      theme: {
        background: '#1e1e1e',
        foreground: '#d4d4d4',
        cursor: '#d4d4d4',
        selectionBackground: '#264f78',
        scrollbarSliderBackground: 'rgba(212,167,106,0.2)',
        scrollbarSliderHoverBackground: 'rgba(212,167,106,0.4)',
      },
      fontSize: 13,
      fontFamily: 'Consolas, "Courier New", monospace',
      cursorBlink: true,
      convertEol: false,
      scrollback: 5000,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(containerRef.current);

    // ── Synchronous fit + PTY resize ──
    // Fit IMMEDIATELY so xterm has the correct cols/rows before any buffered
    // data is processed. Previously this was inside requestAnimationFrame,
    // which left a window where xterm was at its default 80×24 while PTY
    // data formatted for 120×30 was already being written — causing wrapping
    // mismatches and incomplete display.
    try {
      fitAddon.fit();
    } catch { /* ignore */ }

    // Flush all buffered PTY output that arrived before xterm mounted.
    // The buffer is a synchronous ref, so no data is lost regardless of
    // React's state batching or component mount timing.
    const buffered = outputBuffers.current.get(sessionId);
    if (buffered) {
      term.write(buffered);
    }

    // Forward user keyboard input directly to the PTY session
    const dataDisposable = term.onData((data: string) => {
      window.electronAPI.invoke(IPCChannel.TerminalSessionSend, sessionId, data).catch(() => {});
    });

    // Store the instance so the data handler can write to it.
    // Any data that arrived before this point is already in the buffer
    // and was flushed above; future data will be written directly.
    xtermInstances.current.set(sessionId, { term, fitAddon, container: containerRef.current });

    // ── Sync PTY dimensions ──
    // After fit, sync xterm dimensions to the PTY so future output is
    // formatted for the correct column count. ConPTY will re-render the
    // screen at the correct dimensions, which flows naturally to xterm.
    let disposed = false;
    const syncDimensions = async () => {
      await window.electronAPI.invoke(
        IPCChannel.TerminalSessionResize,
        sessionId,
        term.cols,
        term.rows,
      ).catch(() => {});
    };
    syncDimensions();

    // Handle resize — skip when the container is hidden (display: none)
    // to avoid fitting to 0-dimension containers, which would cause
    // ConPTY to truncate the last line on re-render.
    //
    // Debounced: during panel drag the ResizeObserver fires rapidly.
    // Without debouncing, each event triggers a PTY resize + ConPTY
    // re-render, causing flicker and wasted work.
    //
    // On resize, we clear xterm's screen before syncing dimensions to
    // the PTY. Without the clear, ConPTY's re-render data overlaps
    // with stale content already in xterm, causing display garble.
    // The clear gives ConPTY a clean canvas to re-render on; the
    // re-render data arrives via the normal onSessionData path.
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    const resizeObserver = new ResizeObserver(() => {
      if (!containerRef.current || containerRef.current.offsetParent === null) return;
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        try {
          fitAddon.fit();
          // Clear screen + home cursor so ConPTY re-renders to a clean viewport
          // term.write('\x1b[2J\x1b[H');
          // Keep PTY dimensions in sync with xterm so ConPTY wraps
          // lines at the correct column count and its re-render
          // targets the correct dimensions.
          window.electronAPI.invoke(
            IPCChannel.TerminalSessionResize,
            sessionId,
            term.cols,
            term.rows,
          ).catch(() => {});
        } catch { /* ignore */ }
      }, 150);
    });
    resizeObserver.observe(containerRef.current);

    return () => {
      disposed = true;
      if (resizeTimer) clearTimeout(resizeTimer);
      dataDisposable.dispose();
      resizeObserver.disconnect();
      xtermInstances.current.delete(sessionId);
      term.dispose();
    };
  }, [sessionId, outputBuffers, xtermInstances]);

  return <div ref={containerRef} className="terminal-xterm-container" style={{ width: '100%', height: '100%' }} />;
}

// ============ Component ============

export default function TerminalPanel({
  commandOutput,
  onClearCommandOutput,
  minimized,
  onToggleMinimize,
  onAutoExpand,
}: TerminalPanelProps) {
  // Renderer 运行在 Chromium 里，通过 UA 判断平台以决定终端菜单选项
  const isMac = /Macintosh|Mac OS X/i.test(navigator.userAgent);
  const [tabs, setTabs] = useState<TerminalTab[]>([
    {
      id: 'cmd',
      label: 'CMD',
      shell: 'cmd',
      isBuiltin: true,
      status: 'active',
      output: '',
    },
  ]);
  const [activeTabId, setActiveTabId] = useState<string>('cmd');
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [spawning, setSpawning] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const cmdContentRef = useRef<HTMLDivElement>(null);
  const addMenuRef = useRef<HTMLDivElement>(null);
  const minimizedRef = useRef(minimized);
  minimizedRef.current = minimized;
  // xterm.js instances keyed by sessionId
  const xtermInstances = useRef<Map<string, { term: XtermTerminal; fitAddon: FitAddon; container: HTMLDivElement }>>(new Map());
  // Synchronous PTY output buffer per session. Unlike React state, this ref
  // is updated immediately on every IPC event, guaranteeing no data loss
  // regardless of React's batching or component mount timing.
  const outputBuffers = useRef<Map<string, string>>(new Map());

  // ---- Listen for terminal session IPC events ----
  useEffect(() => {
    const handleOpened = (data: unknown) => {
      const d = data as { sessionId: string; shell: string; cwd: string; initialOutput: string; status: string };
      // Do NOT write initialOutput to outputBuffers / xterm. The raw PTY
      // data (with ANSI sequences) is already sent via onSessionData,
      // which xterm processes correctly. Writing ANSI-stripped text here
      // would cause duplicates when ConPTY re-emits the screen with
      // proper ANSI cursor positioning.
      setTabs((prev) => {
        if (prev.some((t) => t.id === d.sessionId)) return prev;
        const label = getShellDisplayName(d.shell, prev);
        const newTab: TerminalTab = {
          id: d.sessionId,
          label,
          shell: d.shell,
          isBuiltin: false,
          isUserTerminal: true,
          status: d.status === 'active' ? 'active' : 'closed',
          output: d.initialOutput ? d.initialOutput + '\n' : '',
          sessionId: d.sessionId,
        };
        setActiveTabId(d.sessionId);
        return [...prev, newTab];
      });
      // Auto-expand the terminal panel when a new AI-created session opens
      // so the user can see the real-time PTY output in xterm.js.
      if (minimizedRef.current && onAutoExpand) {
        onAutoExpand();
      }
    };

    const handleData = (data: unknown) => {
      const d = data as { sessionId: string; data: string };
      // Buffer data synchronously — this is the single source of truth for
      // xterm output, immune to React's state batching.
      outputBuffers.current.set(d.sessionId, (outputBuffers.current.get(d.sessionId) || '') + d.data);

      // Write raw PTY data to the xterm.js instance if mounted.
      const xterm = xtermInstances.current.get(d.sessionId);
      if (xterm) {
        xterm.term.write(d.data);
      }

      // Keep a plain-text fallback in state for the minimized tab bar.
      // Strip ANSI escape codes so tab labels don't show garbled sequences.
      const plain = stripAnsi(d.data);
      if (plain) {
        setTabs((prev) =>
          prev.map((t) =>
            t.id === d.sessionId
              ? { ...t, output: t.output + plain }
              : t
          )
        );
      }
    };

    const handleExited = (data: unknown) => {
      const d = data as { sessionId: string; code: number };
      outputBuffers.current.set(d.sessionId, (outputBuffers.current.get(d.sessionId) || '') + `\n[Process exited with code ${d.code}]`);
      setTabs((prev) =>
        prev.map((t) =>
          t.id === d.sessionId
            ? { ...t, status: 'closed' as const, output: t.output + `\n[Process exited with code ${d.code}]` }
            : t
        )
      );
    };

    window.electronAPI?.on(IPCChannel.TerminalSessionOpened, handleOpened);
    window.electronAPI?.on(IPCChannel.TerminalSessionData, handleData);
    window.electronAPI?.on(IPCChannel.TerminalSessionExited, handleExited);

    return () => {
      window.electronAPI?.removeListener?.(IPCChannel.TerminalSessionOpened, handleOpened);
      window.electronAPI?.removeListener?.(IPCChannel.TerminalSessionData, handleData);
      window.electronAPI?.removeListener?.(IPCChannel.TerminalSessionExited, handleExited);
    };
  }, []);

  // ---- Close add menu on outside click ----
  useEffect(() => {
    if (!addMenuOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (addMenuRef.current && !addMenuRef.current.contains(e.target as Node)) {
        setAddMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [addMenuOpen]);

  // ---- Active tab data (must be before hooks that reference it) ----
  const activeTab = tabs.find((t) => t.id === activeTabId) ?? tabs[0];

  // ---- Keyboard shortcuts: Ctrl+Shift+C (copy) / Ctrl+Shift+V (paste) ----
  useEffect(() => {
    const handleKeyDown = async (e: KeyboardEvent) => {
      if (!e.ctrlKey || !e.shiftKey) return;
      // Only handle when the terminal panel has focus
      if (!bodyRef.current?.contains(document.activeElement) &&
          !bodyRef.current?.querySelector('.xterm')?.contains(document.activeElement)) {
        return;
      }

      if (e.key === 'C' || e.key === 'c') {
        // Copy: get selected text from the active xterm instance
        e.preventDefault();
        const xterm = xtermInstances.current.get(activeTabId);
        if (xterm) {
          const selection = xterm.term.getSelection();
          if (selection) {
            try {
              await navigator.clipboard.writeText(selection);
            } catch {
              // Fallback for environments where clipboard API is unavailable
              const textarea = document.createElement('textarea');
              textarea.value = selection;
              textarea.style.position = 'fixed';
              textarea.style.opacity = '0';
              document.body.appendChild(textarea);
              textarea.select();
              document.execCommand('copy');
              document.body.removeChild(textarea);
            }
          }
        }
      } else if (e.key === 'V' || e.key === 'v') {
        // Paste: read clipboard and send to PTY
        e.preventDefault();
        try {
          const text = await navigator.clipboard.readText();
          if (text && activeTab.sessionId) {
            window.electronAPI.invoke(IPCChannel.TerminalSessionSend, activeTab.sessionId, text).catch(() => {});
          }
        } catch {
          // Clipboard read may be blocked in some environments
        }
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [activeTabId, activeTab]);

  // ---- Auto-scroll active tab ----
  useEffect(() => {
    if (cmdContentRef.current) {
      cmdContentRef.current.scrollTop = cmdContentRef.current.scrollHeight;
    }
  }, [tabs, activeTabId, commandOutput]);

  // ---- Re-fit xterm when switching tabs (display: none → block) ----
  useEffect(() => {
    const xterm = xtermInstances.current.get(activeTabId);
    if (xterm) {
      // Small delay to let the layout settle after display change
      requestAnimationFrame(() => {
        try {
          xterm.fitAddon.fit();
          // Sync PTY dimensions after tab switch re-fit so ConPTY
          // re-renders at the correct dimensions.
          window.electronAPI.invoke(
            IPCChannel.TerminalSessionResize,
            activeTabId,
            xterm.term.cols,
            xterm.term.rows,
          ).catch(() => {});
        } catch { /* ignore */ }
      });
    }
  }, [activeTabId, xtermInstances]);

  // ---- Close tab ----
  const handleCloseTab = useCallback((tabId: string) => {
    setTabs((prev) => {
      const idx = prev.findIndex((t) => t.id === tabId);
      if (idx < 0 || prev[idx].isBuiltin) return prev;
      // Close the PTY session on the main process
      const tab = prev[idx];
      if (tab.sessionId) {
        window.electronAPI.invoke(IPCChannel.TerminalSessionClose, tab.sessionId).catch(() => {});
        // Dispose the xterm.js instance
        const xterm = xtermInstances.current.get(tab.sessionId);
        if (xterm) {
          xterm.term.dispose();
          xtermInstances.current.delete(tab.sessionId);
        }
        outputBuffers.current.delete(tab.sessionId);
      }
      const next = prev.filter((t) => t.id !== tabId);
      // If we closed the active tab, switch to nearest
      setActiveTabId((current) => {
        if (current === tabId) {
          return next[Math.min(idx, next.length - 1)]?.id ?? 'cmd';
        }
        return current;
      });
      return next;
    });
  }, []);

  // ---- Close all except cmd ----
  const handleCloseAll = useCallback(() => {
    // Close all non-builtin PTY sessions and dispose xterm instances
    tabs.forEach((t) => {
      if (!t.isBuiltin && t.sessionId) {
        window.electronAPI.invoke(IPCChannel.TerminalSessionClose, t.sessionId).catch(() => {});
        const xterm = xtermInstances.current.get(t.sessionId);
        if (xterm) {
          xterm.term.dispose();
          xtermInstances.current.delete(t.sessionId);
        }
        outputBuffers.current.delete(t.sessionId);
      }
    });
    setTabs((prev) => prev.filter((t) => t.isBuiltin));
    setActiveTabId('cmd');
    setContextMenu(null);
  }, [tabs]);

  // ---- Spawn new terminal ----
  const handleSpawnTerminal = useCallback(async (shell: string) => {
    setAddMenuOpen(false);
    setSpawning(true);
    try {
      const result = await window.electronAPI.invoke(IPCChannel.TerminalSessionSpawn, { shell }) as {
        success: boolean;
        sessionId?: string;
        shell?: string;
        error?: string;
      };
      if (!result.success) {
        console.error('Failed to spawn terminal:', result.error);
      }
      // The tab will be created by the TerminalSessionOpened event handler
    } catch (err) {
      console.error('Failed to spawn terminal:', err);
    } finally {
      setSpawning(false);
    }
  }, []);

  // ---- Context menu ----
  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY });
  }, []);

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [contextMenu]);

  // ---- Build cmd output display ----
  const cmdTabContent = useMemo(() => {
    if (commandOutput.length === 0) {
      return <div className="terminal-panel-empty">No command output yet</div>;
    }
    return commandOutput.map((entry, i) => (
      <div key={`${entry.commandId}-${i}`} className="terminal-entry">
        <div className="terminal-cmd-line">
          <span className={`terminal-status-dot terminal-status-${entry.status}`} />
          <span className="terminal-cmd-text">{entry.command}</span>
        </div>
        {entry.output && <pre className="terminal-cmd-output">{entry.output}</pre>}
      </div>
    ));
  }, [commandOutput]);

  // ---- Render ----
  if (minimized) {
    // Show a compact tab bar even when minimized
    return (
      <div className="terminal-minimized-bar" onContextMenu={handleContextMenu}>
        <div className="terminal-minimized-tabs">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              className={`terminal-minimized-tab ${tab.id === activeTabId ? 'active' : ''}`}
              onClick={() => {
                setActiveTabId(tab.id);
                onToggleMinimize();
              }}
              title={tab.sessionId ?? tab.label}
            >
              {!tab.isBuiltin && <span className={`terminal-tab-dot ${tab.status === 'active' ? 'active' : 'closed'}`} />}
              <span className="terminal-minimized-tab-label">{normalizeLabel(tab)}</span>
            </button>
          ))}
        </div>
        <button
          className="terminal-expand-btn"
          onClick={onToggleMinimize}
          title="展开终端"
        >
          <Maximize2 size={12} />
        </button>
      </div>
    );
  }

  return (
    <div className="terminal-panel">
      {/* Tab bar */}
      <div className="terminal-panel-header" onContextMenu={handleContextMenu}>
        <div className="terminal-tabs">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              className={`terminal-tab ${tab.id === activeTabId ? 'active' : ''}`}
              onClick={() => setActiveTabId(tab.id)}
              title={tab.sessionId ?? tab.label}
            >
              {!tab.isBuiltin && <span className={`terminal-tab-dot ${tab.status === 'active' ? 'active' : 'closed'}`} />}
              <span className="terminal-tab-label">{normalizeLabel(tab)}</span>
              {!tab.isBuiltin && (
                <button
                  className="terminal-tab-close"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleCloseTab(tab.id);
                  }}
                  title="关闭"
                >
                  <X size={10} />
                </button>
              )}
            </button>
          ))}
        </div>
        <div className="terminal-header-actions">
          <div className="terminal-add-wrapper" ref={addMenuRef}>
            <button
              className={`terminal-add-btn${spawning ? ' spinning' : ''}`}
              onClick={() => !spawning && setAddMenuOpen((prev) => !prev)}
              title="新建终端"
              disabled={spawning}
            >
              {spawning ? <Loader2 size={12} /> : <Plus size={12} />}
            </button>
            {addMenuOpen && (
              <div className="terminal-add-menu">
                {isMac ? (
                  <>
                    <button
                      className="terminal-add-menu-item"
                      onClick={() => handleSpawnTerminal('zsh')}
                    >
                      新建zsh终端
                    </button>
                    <button
                      className="terminal-add-menu-item"
                      onClick={() => handleSpawnTerminal('bash')}
                    >
                      新建bash终端
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      className="terminal-add-menu-item"
                      onClick={() => handleSpawnTerminal('cmd')}
                    >
                      新建CMD终端
                    </button>
                    <button
                      className="terminal-add-menu-item"
                      onClick={() => handleSpawnTerminal('powershell')}
                    >
                      新建PowerShell终端
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
          <button
            className="terminal-clear-btn"
            onClick={() => {
              if (activeTab.isBuiltin) {
                onClearCommandOutput();
              } else {
                // Clear tab output state
                setTabs((prev) =>
                  prev.map((t) => (t.id === activeTabId ? { ...t, output: '' } : t))
                );
                // Clear xterm display and output buffer
                const xterm = xtermInstances.current.get(activeTabId);
                if (xterm) {
                  xterm.term.reset();
                }
                outputBuffers.current.set(activeTabId, '');
              }
            }}
            title="清空"
          >
            <Trash2 size={12} />
          </button>
          <button
            className="terminal-minimize-btn"
            onClick={onToggleMinimize}
            title="最小化终端"
          >
            <Minimize2 size={12} />
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="terminal-panel-body" ref={bodyRef}>
        {activeTab?.isBuiltin && (
          <div className="terminal-cmd-content" ref={cmdContentRef}>
            {cmdTabContent}
          </div>
        )}
        {tabs
          .filter((t) => !t.isBuiltin)
          .map((tab) => (
            <div
              key={tab.id}
              className="terminal-xterm-wrapper"
              style={{ display: tab.id === activeTabId ? 'block' : 'none' }}
            >
              <XtermContainer
                sessionId={tab.id}
                outputBuffers={outputBuffers}
                xtermInstances={xtermInstances}
              />
            </div>
          ))}
      </div>

      {/* Context menu */}
      {contextMenu && (
        <div
          className="terminal-context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <button className="terminal-context-item" onClick={handleCloseAll}>
            Close All (except CMD)
          </button>
        </div>
      )}
    </div>
  );
}
