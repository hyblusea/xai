import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import * as pty from '@lydell/node-pty';
import { Terminal as HeadlessTerminal } from '@xterm/headless';

// ============ Types ============

export type ShellType = 'cmd' | 'powershell' | 'pwsh' | 'bash' | 'zsh' | 'sh';

export interface SessionInfo {
  id: string;
  shell: ShellType;
  cwd: string;
  startTime: number;
  lastActivity: number;
  status: 'active' | 'closed';
  pid?: number;
}

export interface SpawnOptions {
  shell?: ShellType;
  cwd?: string;
  env?: Record<string, string>;
}

export interface SendOptions {
  timeout?: number;
  background?: boolean;
  interactive?: boolean;
  expectPrompt?: string;
  /**
   * Append a newline after the command. Default: true.
   * Set to false to send a raw sequence (e.g. a single Ctrl+C) without
   * a trailing carriage return.
   */
  appendNewline?: boolean;
  signal?: AbortSignal;
}

export interface SendResult {
  output: string;
  status: 'completed' | 'still_running' | 'background';
}

// ============ Constants ============

const DEFAULT_IDLE_TIMEOUT = 10 * 60 * 1000; // 10 minutes
const DEFAULT_COMMAND_TIMEOUT = 30_000;
const IDLE_DETECT_MS = 500;
const MAX_OUTPUT_LENGTH = 50_000;
const HEAD_TAIL_THRESHOLD = 30_000;
const HEAD_SIZE = 15_000;
const TAIL_SIZE = 15_000;
// ANSI escape sequence patterns:
const ANSI_REGEX = /\x1B(?:\][\s\S]*?(?:\x07|\x1B\\)|\[[0-?]*[ -/]*[@-~]|[@-Z\\-_])/g;

/**
 * Translate `Ctrl+<key>` escape sequences in the user-supplied command
 * into the actual control bytes (e.g. `Ctrl+C` → 0x03, `Ctrl+D` → 0x04).
 */
export function translateControlChars(input: string): string {
  return input.replace(/ctrl\+([a-z^\\\[\]_])/gi, (_match, ch: string) => {
    if (ch === '[') return '\x1b';
    if (ch === '\\') return '\x1c';
    if (ch === ']') return '\x1d';
    if (ch === '^') return '\x1e';
    if (ch === '_') return '\x1f';
    // Letter: A=0x01, B=0x02, ..., Z=0x1A
    const code = ch.toUpperCase().charCodeAt(0) - 64;
    return String.fromCharCode(code);
  });
}

// ============ Shell Configuration ============

interface ShellConfig {
  executable: string;
  args: string[];
  initCommand?: string;
}

function getShellConfig(shell: ShellType, isWindows: boolean): ShellConfig {
  switch (shell) {
    case 'cmd':
      return {
        executable: 'cmd.exe',
        args: [],
        initCommand: 'chcp 65001 >nul 2>&1\r',
      };
    case 'powershell':
      return {
        executable: 'powershell.exe',
        args: ['-NoLogo', '-NoProfile', '-NoExit'],
        initCommand: '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\r',
      };
    case 'pwsh':
      return {
        executable: 'pwsh',
        args: ['-NoLogo', '-NoProfile', '-NoExit'],
        initCommand: '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\r',
      };
    case 'bash':
      return {
        executable: isWindows ? 'bash' : '/bin/bash',
        args: ['--norc', '--noprofile'],
      };
    case 'zsh':
      return { executable: '/bin/zsh', args: ['--no-rcs'] };
    case 'sh':
      return { executable: isWindows ? 'sh' : '/bin/sh', args: [] };
    default:
      return isWindows
        ? { executable: 'cmd.exe', args: [], initCommand: 'chcp 65001 >nul 2>&1\r' }
        : { executable: '/bin/bash', args: ['--norc', '--noprofile'] };
  }
}

function detectDefaultShell(): ShellType {
  if (process.platform === 'win32') return 'powershell';
  if (process.platform === 'darwin') return 'zsh';
  return 'bash';
}

/**
 * Line terminator for submitting a command through the PTY. Must be a SINGLE
 * byte: ConPTY delivers CR and LF as separate key events, so a trailing LF
 * after the CR that submits the command is read at the NEXT prompt —
 * PSReadLine maps a lone LF to "insert line feed" (Shift+Enter), leaving the
 * session stuck on the `>>` continuation prompt, while bash readline treats
 * it as Enter and submits an empty line (duplicate prompt). cmd's console
 * line-input layer silently drops the lone LF, but we still send CR only for
 * consistency across Windows shells.
 */
function lineTerminator(shell: ShellType): string {
  switch (shell) {
    case 'cmd':
    case 'powershell':
    case 'pwsh':
      return '\r';
    default:
      return '\n';
  }
}

// ============ Output Helpers ============

function stripAnsi(text: string): string {
  // Remove ANSI escape sequences
  let result = text.replace(ANSI_REGEX, '');
  // Remove other control characters (except \n, \r, \t)
  // Note: we do NOT process \b (backspace) here because PSReadLine uses
  // complex backspace sequences that can't be simplified by simple
  // char+backspace removal. The headless terminal handles this correctly.
  result = result.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
  return result;
}

function truncateOutput(text: string): string {
  if (text.length <= MAX_OUTPUT_LENGTH) return text;
  const head = text.substring(0, HEAD_SIZE);
  const tail = text.substring(text.length - TAIL_SIZE);
  return `${head}\n\n... [truncated ${text.length - HEAD_SIZE - TAIL_SIZE} chars total] ...\n\n${tail}`;
}

/**
 * Collapse runs of 3+ consecutive blank lines down to 2.
 * PTY streams (especially SSH sessions) often produce many blank lines
 * during terminal initialization that add noise without information.
 */
function collapseBlankLines(text: string): string {
  return text.replace(/(\n\s*){3,}/g, '\n\n');
}

// ============ Internal Session ============

interface Session {
  info: SessionInfo;
  pty: pty.IPty;
  dataHandlers: Set<(data: string) => void>;
  exitHandlers: Set<(code: number) => void>;
  sendLock: Promise<SendResult> | null;
  // Persistent output tracking for poll / still-running
  commandRunning: boolean;
  commandOutput: string;
  commandMarker: string | null;
  commandFullText: string;
  /**
   * Output-only marker that does NOT appear in the command echo text.
   * Only present after the command actually executes, solving the
   * "marker detected in echo" problem on ALL shells (cmd, PowerShell, bash).
   */
  outputMarker: string | null;
  /**
   * The completion marker pre-set in the PTY's environment at spawn time.
   * The command suffix references it via `%XAI_MARKER%` (cmd),
   * `$env:XAI_MARKER` (PowerShell), or `$XAI_MARKER` (bash), so the marker
   * TEXT never appears in the command echo. This avoids cmd.exe's "double
   * echo" false-completion problem.
   */
  envMarker: string;
  /**
   * Headless xterm.js terminal that mirrors the PTY output. It strips ANSI
   * escape codes, coalesces PSReadLine re-draws, and resolves cursor
   * movements — giving us a clean 2D buffer we can extract command output
   * from without hand-rolled regexes.
   */
  headlessTerminal: HeadlessTerminal;
  /**
   * Snapshot of `headlessTerminal.buffer.active.length` taken right before
   * a command is written to the PTY. Used as the start index when reading
   * the command's output region out of the headless buffer.
   */
  preCommandBufferLength: number;
  /**
   * Number of headless terminal writes that haven't been parsed yet.
   * When this is > 0, the headless buffer is stale and we must wait
   * or fall back to raw output.
   */
  pendingHeadlessWrites: number;
  /**
   * Resolvers for promises waiting on pendingHeadlessWrites to reach 0.
   */
  headlessWriteResolvers: Set<() => void>;
}

// ============ TerminalSessionManager ============

export interface TerminalSessionEvents {
  onSessionOpened?: (info: SessionInfo, initialOutput: string) => void;
  onSessionData?: (sessionId: string, data: string) => void;
  onSessionExited?: (sessionId: string, code: number) => void;
}

export class TerminalSessionManager {
  private sessions = new Map<string, Session>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private workspacePath: string;
  private idleTimeout: number;
  private events: TerminalSessionEvents;

  constructor(workspacePath: string, idleTimeout: number = DEFAULT_IDLE_TIMEOUT, events?: TerminalSessionEvents) {
    this.workspacePath = workspacePath;
    this.idleTimeout = idleTimeout;
    this.events = events ?? {};
    this.cleanupTimer = setInterval(() => this.cleanupIdleSessions(), 60_000);
  }

  /**
   * Open a new persistent terminal session.
   */
  async spawn(options: SpawnOptions = {}): Promise<{
    sessionId: string;
    initialOutput: string;
    shell: ShellType;
  }> {
    const id = `term_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const shell = options.shell || detectDefaultShell();
    const cwd = options.cwd
      ? this.resolvePath(options.cwd)
      : this.workspacePath;
    const isWindows = process.platform === 'win32';

    // Validate cwd exists before spawning — node-pty throws an opaque
    // "Cannot create process, error code: 267" asynchronously (uncaught)
    // when the directory doesn't exist, which crashes the process.
    if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
      throw new Error(`Working directory does not exist: ${cwd}`);
    }

    const shellConfig = getShellConfig(shell, isWindows);

    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      PYTHONIOENCODING: 'utf-8',
      PYTHONUTF8: '1',
      TERM: 'xterm-256color',
      // Pre-set the completion marker in the PTY's environment. The command
      // suffix references it via `%XAI_MARKER%` (cmd) or `$env:XAI_MARKER`
      // (PowerShell), so the marker TEXT never appears in the command echo.
      // This avoids cmd.exe's "double echo" false-completion problem (the
      // command can be echoed twice — once as a flash, once as the proper
      // prompt echo — and BOTH echoes would otherwise contain the marker
      // text, making the count reach 2 before the user command even runs).
      XAI_MARKER: `__XAIB_pty_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}__`,
      ...(options.env || {}),
    };

    // The completion marker is pre-set in the PTY's environment. Store it
    // on the session so doSend() can reference the same value (and the
    // completion detector can match it against the output).
    const envMarker = env.XAI_MARKER!;

    const child = pty.spawn(shellConfig.executable, shellConfig.args, {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd,
      env,
      // ConPTY on Windows; falls back to winpty on older Windows.
      useConpty: process.platform === 'win32',
    });
    const spawnDebugStart = Date.now();
    if (process.env.XAI_PTY_DEBUG) {
      console.log(`[pty 0ms] spawned ${shellConfig.executable} pid=${child.pid}`);
    }

    const dataHandlers = new Set<(data: string) => void>();
    const exitHandlers = new Set<(code: number) => void>();

    // Create a headless xterm.js terminal that mirrors the PTY output. It
    // handles ANSI escape sequences, cursor movements, and PSReadLine
    // re-draws so we can extract clean command output via its buffer
    // instead of relying on hand-rolled regexes.
    const headlessTerminal = new HeadlessTerminal({
      cols: 120,
      rows: 30,
      scrollback: 10_000,
      allowProposedApi: true,
    });

    child.onData((data: string) => {
      if (process.env.XAI_PTY_DEBUG) {
        const ms = Date.now() - spawnDebugStart;
        console.log(`[pty ${ms}ms] ${JSON.stringify(data).slice(0, 200)}`);
      }
      // Mirror raw PTY bytes into the headless terminal so its buffer
      // stays in sync with what the user would see on screen.
      // Track pending writes so extractHeadlessOutput can wait for the
      // buffer to be up-to-date before reading.
      //
      // IMPORTANT: wrap in try-catch — @xterm/headless ships pre-minified ESM
      // and tsup/esbuild re-minifies it, which can cause runtime errors in
      // requestMode/DCS handlers. A thrown error here would prevent
      // dataHandlers from running, blocking ALL PTY data from reaching
      // the renderer's xterm (TUI apps like mimo/vim would appear blank).
      try {
        session.pendingHeadlessWrites++;
        headlessTerminal.write(data, () => {
          session.pendingHeadlessWrites--;
          if (session.pendingHeadlessWrites === 0) {
            for (const resolve of session.headlessWriteResolvers) resolve();
            session.headlessWriteResolvers.clear();
          }
        });
      } catch (err) {
        session.pendingHeadlessWrites--;
        if (process.env.XAI_PTY_DEBUG) {
          console.error('[headless write error]', err);
        }
      }
      if (process.env.XAI_PTY_DEBUG) {
      const bufLen = headlessTerminal.buffer.active.length;
      const lastLine = headlessTerminal.buffer.active.getLine(bufLen - 1);
      const lastLineText = lastLine ? lastLine.translateToString(true) : '(null)';
      console.log(`[headless write] pending=${session.pendingHeadlessWrites} bufLen=${bufLen} lastLine="${lastLineText.substring(0, 80)}"`);
    }
      for (const handler of dataHandlers) handler(data);
    });

    child.onExit(({ exitCode }) => {
      session.info.status = 'closed';
      for (const handler of exitHandlers) handler(exitCode);
    });

    const session: Session = {
      info: {
        id,
        shell,
        cwd,
        startTime: Date.now(),
        lastActivity: Date.now(),
        status: 'active',
        pid: child.pid,
      },
      pty: child,
      dataHandlers,
      exitHandlers,
      sendLock: null,
      commandRunning: false,
      commandOutput: '',
      commandMarker: null,
      commandFullText: '',
      outputMarker: null,
      envMarker,
      headlessTerminal,
      preCommandBufferLength: 0,
      pendingHeadlessWrites: 0,
      headlessWriteResolvers: new Set(),
    };

    this.sessions.set(id, session);

    const rawInitialOutput = await this.waitForIdle(session, IDLE_DETECT_MS);
    if (process.env.XAI_PTY_DEBUG) {
      console.log(`[pty idle] waited ${Date.now() - spawnDebugStart}ms, got ${rawInitialOutput.length} chars`);
    }
    // Note: we intentionally do NOT send \x1b[2J\x1b[H to clear the PTY here.
    // The clear causes ConPTY to re-render, but the re-render data may be
    // consumed by the second waitForIdle before data handlers are registered,
    // leaving the xterm display empty (cursor at top-left with no text).
    // The initial PTY output flows naturally through the data handlers below.

    dataHandlers.add((data: string) => {
      if (session.commandRunning) {
        session.commandOutput += data;
      }
      if (this.events.onSessionData) {
        this.events.onSessionData(id, data);
      }
    });

    exitHandlers.add((code: number) => {
      session.commandRunning = false;
      if (this.events.onSessionExited) {
        this.events.onSessionExited(id, code);
      }
    });

    if (rawInitialOutput && this.events.onSessionData) {
      this.events.onSessionData(id, rawInitialOutput);
    }

    const result = {
      sessionId: id,
      // ANSI-stripped version for AI text consumption only (not for xterm display)
      initialOutput: stripAnsi(rawInitialOutput).trim(),
      shell,
    };

    // Notify UI about the new session (initialOutput is for tab labels /
    // AI consumption only — NOT written to the xterm buffer)
    if (this.events.onSessionOpened) {
      this.events.onSessionOpened(session.info, result.initialOutput);
    }

    return result;
  }

  /**
   * Send a command to an existing session and wait for output.
   * Commands are queued per-session to prevent interleaving.
   */
  async send(
    sessionId: string,
    command: string,
    options: SendOptions = {},
  ): Promise<SendResult> {
    const session = this.sessions.get(sessionId);
    if (!session || session.info.status !== 'active') {
      throw new Error(`Session ${sessionId} not found or already closed`);
    }

    // If a previous command is still running (timed out), reject new sends
    // Exception: interactive mode allows sending input to a running command
    // (e.g. typing a password into an SSH session)
    if (session.commandRunning && !options.background && !options.interactive) {
      const recentOutput = await this.extractHeadlessOutput(session, 'progress');
      return {
        output: `Terminal is busy: previous command is still running.\nRecent output:\n${recentOutput || '(no output yet)'}\n\nUse terminal_poll sessionId:${sessionId} wait:true to wait for completion, or terminal_poll sessionId:${sessionId} to check progress.`,
        status: 'still_running',
      };
    }

    // Chain onto any existing send to ensure serial execution
    const previousSend = session.sendLock || Promise.resolve({ output: '', status: 'completed' as const });
    const currentSend = previousSend
      .catch(() => ({ output: '', status: 'completed' as const }))
      .then(() => this.doSend(session, command, options));
    session.sendLock = currentSend;

    try {
      return await currentSend;
    } finally {
      if (session.sendLock === currentSend) {
        session.sendLock = null;
      }
    }
  }

  /**
   * Close a terminal session and clean up resources.
   */
  async close(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.info.status = 'closed';
    session.commandRunning = false;
    session.outputMarker = null;
    session.dataHandlers.clear();

    // Dispose the headless terminal to free memory
    try { session.headlessTerminal.dispose(); } catch { /* ignore */ }

    // Notify UI before clearing exit handlers so the tab status updates
    if (this.events.onSessionExited) {
      this.events.onSessionExited(sessionId, 0);
    }
    session.exitHandlers.clear();

    // Kill the PTY process (and its child tree on Windows)
    this.killPty(session.pty);

    this.sessions.delete(sessionId);
  }

  /**
   * List all active sessions.
   */
  listSessions(): SessionInfo[] {
    return Array.from(this.sessions.values()).map((s) => ({ ...s.info }));
  }

  /**
   * Check if a session exists and is active.
   */
  isSessionActive(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    return !!session && session.info.status === 'active';
  }

  /**
   * Resize a session's PTY and headless terminal to match the
   * frontend xterm dimensions. Without this, the PTY keeps its
   * original cols/rows and output wraps or truncates incorrectly.
   */
  resize(sessionId: string, cols: number, rows: number): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.info.status !== 'active') return;
    try {
      session.pty.resize(cols, rows);
      session.headlessTerminal.resize(cols, rows);
    } catch {
      // pty.resize can throw if the process has already exited
    }
  }

  /**
   * Return the headless terminal's current VISIBLE display content as
   * plain text (scrollback is excluded). Used by the renderer to "replay"
   * the correct display when the UI xterm has been corrupted by ConPTY
   * dimension mismatches or clear-screen sequences.
   *
   * Only the visible viewport is returned. Trailing blank lines are trimmed
   * so that xterm's cursor ends up on the last content line (where the shell
   * prompt is), matching ConPTY's expectation. The cursorRow field tells
   * the renderer the 0-based row of the cursor within the visible area,
   * used to precisely position xterm's cursor via ANSI escape.
   *
   * Waits for any pending headless writes before reading the buffer.
   */
  async getDisplayBuffer(sessionId: string): Promise<{ text: string; cursorRow: number; totalRows: number }> {
    const session = this.sessions.get(sessionId);
    if (!session || session.info.status !== 'active') {
      return { text: '', cursorRow: 0, totalRows: 0 };
    }

    // Wait for pending headless writes to be processed
    if (session.pendingHeadlessWrites > 0) {
      await Promise.race([
        new Promise<void>((resolve) => {
          session.headlessWriteResolvers.add(() => resolve());
        }),
        new Promise<void>((resolve) => setTimeout(() => resolve(), 200)),
      ]);
    }

    const buf = session.headlessTerminal.buffer.active;
    const totalRows = buf.length - buf.viewportY;
    // Read only the VISIBLE viewport (skip scrollback).
    const lines: string[] = [];
    for (let y = buf.viewportY; y < buf.length; y++) {
      const line = buf.getLine(y);
      lines.push(line ? line.translateToString(true) : '');
    }

    // Find the cursor row: the last non-blank line in the visible area.
    // This is where the shell prompt is and where ConPTY expects the cursor.
    let cursorRow = totalRows - 1;
    while (cursorRow > 0 && lines[cursorRow].trim() === '') {
      cursorRow--;
    }

    // Trim trailing blank lines so xterm's cursor stays on the last
    // content line instead of being pushed to a blank row below.
    while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
      lines.pop();
    }

    return {
      text: lines.join('\n'),
      cursorRow,
      totalRows,
    };
  }

  /**
   * Clean up all sessions and stop the cleanup timer.
   */
  dispose(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    for (const id of Array.from(this.sessions.keys())) {
      this.close(id);
    }
  }

  // ============ Private ============

  private resolvePath(inputPath: string): string {
    if (path.isAbsolute(inputPath)) return path.normalize(inputPath);
    return path.resolve(this.workspacePath, inputPath);
  }

  /**
   * Core send logic: wrap command with echo marker, wait for marker in output.
   * Supports background mode and returns still_running on timeout.
   */
  private async doSend(
    session: Session,
    command: string,
    options: SendOptions,
  ): Promise<SendResult> {
    const timeout = options.timeout ?? DEFAULT_COMMAND_TIMEOUT;
    const shell = session.info.shell;

    // ── Interactive mode ──
    // For interactive commands (ssh, python REPL, mysql, etc.),
    // don't append a marker. Wait for either:
    //   1) `expectPrompt` to appear in the output (e.g. "password:")
    //   2) idle detection (no new output for IDLE_DETECT_MS)
    //   3) timeout
    // Then return whatever has been produced so the AI can see prompts
    // and send further input.
    if (options.interactive) {
      // Translate Ctrl+<key> sequences to control bytes (e.g. Ctrl+C → 0x03).
      const translated = translateControlChars(command);
      const appendNewline = options.appendNewline !== false;
      const fullCommand = translated + (appendNewline ? lineTerminator(shell) : '');

      // Reset persistent tracking (no marker in interactive mode)
      session.commandOutput = '';
      session.commandMarker = null;
      session.commandFullText = fullCommand;
      session.commandRunning = true;

      try {
        session.pty.write(fullCommand);
      } catch (err) {
        session.commandRunning = false;
        throw new Error('Failed to write to PTY: ' + (err instanceof Error ? err.message : String(err)));
      }

      // Wait for expected prompt, or idle, or timeout.
      // This is the KEY fix: previously we only waited IDLE_DETECT_MS,
      // which meant a slow SSH connection would return "no output" before
      // the password prompt even appeared.
      const waited = await this.waitForInteractiveSignal(session, {
        timeout,
        expectPrompt: options.expectPrompt,
        signal: options.signal,
      });

      const output = collapseBlankLines(stripAnsi(session.commandOutput)).trim();
      const cleanedOutput = this.removeCommandEcho(output, command);

      if (waited === 'expectPrompt') {
        // Saw the expected prompt — the command is waiting for input.
        return {
          output: cleanedOutput,
          status: 'still_running',
        };
      }
      if (waited === 'exit') {
        // The shell / command exited.
        return {
          output: cleanedOutput || '(interactive command exited)',
          status: 'completed',
        };
      }
      if (waited === 'timeout') {
        return {
          output: cleanedOutput || '(no output yet — timeout reached, command may be waiting for input)',
          status: 'still_running',
        };
      }
      // 'idle' — output stabilized but neither prompt nor exit seen.
      return {
        output: cleanedOutput || '(no output yet — the command may be waiting for input)',
        status: 'still_running',
      };
    }

    // ── Normal (marker-based) mode ──
    // markerA appears in the command TEXT (so it's always present in the
    // echo, used by cleanOutput to find/remove the command echo).
    // markerB is the env-var marker (pre-set in the PTY's environment at
    // spawn time). The command suffix references it via `%XAI_MARKER%` /
    // `$env:XAI_MARKER` / `$XAI_MARKER`, so the marker TEXT never appears
    // in the command echo. It only appears in the output from the marker-
    // producing subcommand that runs AFTER the user's command succeeds.
    // This avoids cmd.exe's "double echo" false-completion problem.
    const ts = Date.now().toString(36);
    const markerA = `__XAIA_${ts}_${Math.random().toString(36).slice(2, 8)}__`;
    const markerB = session.envMarker;
  
    // Build wrapped command: markerA in text (echo), markerB in output only
    const translatedCommand = translateControlChars(command);
    let markerSuffix: string;
    switch (shell) {
      case 'cmd':
        // The marker is pre-set in the PTY's environment as `XAI_MARKER`
        // (see spawn()). The command suffix references it via
        // `%XAI_MARKER%` so the marker TEXT never appears in the command
        // echo. This avoids cmd.exe's "double echo" false-completion
        // problem: cmd.exe can echo the command twice (flash + proper),
        // and BOTH echoes would otherwise contain the marker text.
        //
        // Use `&&` so the marker echoes only run AFTER the user's command
        // succeeds:
        //   - Short commands (cd, dir): succeed → markers echo → count=1
        //     → completed correctly.
        //   - Long-running (pnpm dev, java -jar): never succeed while
        //     running → markers never echo → count stays 0 → times out
        //     as "still_running", caller polls for incremental output.
        //
        // markerA is still in the command text (as `echo __XAIA_...`)
        // because it's used by cleanOutput to find/remove the command
        // echo from the output. It does NOT contribute to completion
        // detection (we only count markerB).
        markerSuffix = ` && echo ${markerA} && call echo %XAI_MARKER%`;
        break;
      case 'powershell':
      case 'pwsh':
        // PowerShell's PSReadLine (active in interactive mode) eats
        // `$env:XAI_MARKER` and `$?` as you type, so we can't use the
        // env-var `$` syntax. Instead we read the env var via the
        // .NET API — PSReadLine doesn't touch this syntax, and the
        // marker TEXT (the env-var name `"XAI_MARKER"`) never appears
        // in the output, so it still triggers count=1 on success.
        //
        // `if ($?)` gates on the previous command's success, so the
        // marker echo only runs AFTER the user's command succeeds.
        // This is critical for long-running commands (pnpm dev, java
        // -jar) — without it, the marker echo would run immediately
        // and the command would falsely report as completed.
        markerSuffix = `; if ($?) { [System.Environment]::GetEnvironmentVariable('XAI_MARKER') }`;
        break;
      default:
        // bash/zsh: `$XAI_MARKER` references the env var pre-set at spawn
        // time. The marker TEXT never appears in the command echo.
        markerSuffix = `; echo "$XAI_MARKER" # ${markerA}`;
        break;
    }
    const fullCommand = translatedCommand + markerSuffix + lineTerminator(shell);
    
    // Reset persistent tracking
    session.commandOutput = '';
    session.commandMarker = markerA;     // used by cleanOutput for echo removal
    session.outputMarker = markerB;       // used for completion detection
    session.commandFullText = fullCommand;
    session.commandRunning = true;

    // Snapshot the headless buffer length BEFORE writing the command so we
    // can extract just this command's output region later. We need to call
    // this AFTER all initial output has settled (which the spawn() idle
    // wait guarantees) so the snapshot reflects the post-prompt position.
    session.preCommandBufferLength = session.headlessTerminal.buffer.active.length;

    // Write command to PTY
    try {
      session.pty.write(fullCommand);
    } catch (err) {
      session.commandRunning = false;
      throw new Error('Failed to write to PTY: ' + (err instanceof Error ? err.message : String(err)));
    }
    
    // Background mode: brief check for immediate failure/completion before returning
    if (options.background) {
      const earlyResult = await this.earlyFailureCheck(session);
      if (earlyResult) {
        return earlyResult;
      }
      return {
        output: `Command started in background. Use terminal_poll sessionId:${session.info.id} to check progress and results.`,
        status: 'background',
      };
    }
    
    // Wait for outputMarker (markerB) to appear, or process exit, or timeout
    const result = await new Promise<SendResult>((resolve, reject) => {
      const timer = setTimeout(async () => {
        session.dataHandlers.delete(dataHandler);
        session.exitHandlers.delete(exitHandler);
        // Timeout: command is still running. markerB has not fired yet, so
        // extractHeadlessOutput in 'progress' mode surfaces whatever has
        // accumulated so far.
        const currentOutput = await this.extractHeadlessOutput(session, 'progress');
        resolve({
          output: currentOutput || '(no output yet)',
          status: 'still_running',
        });
      }, timeout);
    
      const dataHandler = async (data: string) => {
        try {
          session.info.lastActivity = Date.now();

          // The marker is pre-set in the PTY's environment and referenced via
          // `%XAI_MARKER%` (cmd), `[System.Environment]::GetEnvironmentVariable('XAI_MARKER')`
          // (PowerShell — `$env:XAI_MARKER` would be eaten by PSReadLine), or
          // `$XAI_MARKER` (bash) in the command suffix. The marker TEXT
          // therefore never appears in the command echo — it only appears in
          // the output from the marker-producing subcommand that runs AFTER
          // the user's command succeeds. So threshold = 1 for all shells.
          //
          // Strip \r\n before counting to handle terminal line-wrap splitting.
          const escapedB = markerB.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const bufferForCount = session.commandOutput.replace(/[\r\n]+/g, '');
          const markerBCount = (bufferForCount.match(new RegExp(escapedB, 'g')) || []).length;
          if (process.env.XAI_PTY_DEBUG) {
            console.log(`[doSend dataHandler] markerB=${markerB} count=${markerBCount} bufLen=${session.commandOutput.length} dataLen=${data.length}`);
          }
          if (markerBCount >= 1) {
            clearTimeout(timer);
            session.dataHandlers.delete(dataHandler);
            session.exitHandlers.delete(exitHandler);
            session.commandRunning = false;
            const output = await this.extractHeadlessOutput(session, 'completed');
            resolve({ output, status: 'completed' });
          }
        } catch (err) {
          // If extractHeadlessOutput throws, still resolve with fallback
          clearTimeout(timer);
          session.dataHandlers.delete(dataHandler);
          session.exitHandlers.delete(exitHandler);
          session.commandRunning = false;
          const fallback = stripAnsi(session.commandOutput).trim();
          resolve({ output: fallback || '(error extracting output)', status: 'completed' });
        }
      };
    
      const exitHandler = (code: number) => {
        clearTimeout(timer);
        session.dataHandlers.delete(dataHandler);
        session.exitHandlers.delete(exitHandler);
        session.commandRunning = false;
        reject(new Error(`Process exited with code ${code} before command completed`));
      };
    
      session.dataHandlers.add(dataHandler);
      session.exitHandlers.add(exitHandler);
    
      // Handle abort signal
      if (options.signal) {
        const onAbort = () => {
          clearTimeout(timer);
          session.dataHandlers.delete(dataHandler);
          session.exitHandlers.delete(exitHandler);
          session.commandRunning = false;
          reject(new Error('Command aborted by user'));
        };
        if (options.signal.aborted) {
          onAbort();
          return;
        }
        options.signal.addEventListener('abort', onAbort, { once: true });
      }
    });
    
    return result;
  }
  
  /**
   * Brief post-write check for background commands. Waits up to 2 seconds
   * to detect immediate failure (syntax errors, PSReadLine text corruption,
   * process crash) or quick completion. Returns the actual result if detected,
   * or null if the command appears to be genuinely running in the background.
   *
   * Detection signals (whichever fires first):
   *   1. markerB appears in output → command completed successfully
   *   2. PTY process exits → command crashed
   *   3. 2s timeout + 500ms idle → check headless buffer for shell prompt:
   *      prompt visible = command failed; no prompt = still running (return null)
   */
  private async earlyFailureCheck(session: Session): Promise<SendResult | null> {
    const EARLY_CHECK_TIMEOUT = 2000;
    const EARLY_IDLE_MS = 500;
    const markerB = session.outputMarker;
    if (!markerB) return null;

    return new Promise<SendResult | null>((resolve) => {
      let resolved = false;
      let idleTimer: ReturnType<typeof setTimeout>;
      let processExited = false;

      const cleanup = () => {
        clearTimeout(idleTimer);
        clearTimeout(hardTimer);
        session.dataHandlers.delete(dataHandler);
        session.exitHandlers.delete(exitHandler);
      };

      const finish = async () => {
        if (resolved) return;
        resolved = true;
        cleanup();

        // Check markerB in accumulated raw output (persistent handler in
        // spawn() accumulates into session.commandOutput while commandRunning)
        const escapedB = markerB.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const bufferForCount = session.commandOutput.replace(/[\r\n]+/g, '');
        const markerBCount = (bufferForCount.match(new RegExp(escapedB, 'g')) || []).length;

        if (markerBCount >= 1) {
          // Command completed successfully within the check window
          session.commandRunning = false;
          const output = await this.extractHeadlessOutput(session, 'completed');
          session.commandMarker = null;
          session.outputMarker = null;
          session.commandOutput = '';
          session.commandFullText = '';
          resolve({ output, status: 'completed' });
          return;
        }

        // Marker NOT detected — distinguish between:
        //   a) Command failed (shell returned to prompt)
        //   b) Command still running (actively producing output)
        //
        // Check the headless terminal buffer: if the last non-blank line
        // looks like a shell prompt, the shell is idle (command failed).
        // Otherwise, the command is still running.
        const shellAtPrompt = this.isShellAtPrompt(session);

        if (processExited || shellAtPrompt) {
          const output = await this.extractHeadlessOutput(session, 'progress');
          session.commandRunning = false;
          session.commandMarker = null;
          session.outputMarker = null;
          session.commandOutput = '';
          session.commandFullText = '';
          resolve({
            output: output || '(process exited without completion marker)',
            status: 'completed',
          });
          return;
        }

        // Command is still running — return null so caller uses normal background path
        resolve(null);
      };

      // Temporary data handler: reset idle timer on each chunk
      const dataHandler = (_data: string) => {
        if (resolved) return;
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => finish(), EARLY_IDLE_MS);
      };

      const exitHandler = (_code: number) => {
        if (resolved) return;
        processExited = true;
        finish();
      };

      session.dataHandlers.add(dataHandler);
      session.exitHandlers.add(exitHandler);

      // Start idle timer — resolves if no output within EARLY_IDLE_MS
      idleTimer = setTimeout(() => finish(), EARLY_IDLE_MS);

      // Hard timeout — stop checking after EARLY_CHECK_TIMEOUT
      const hardTimer = setTimeout(() => finish(), EARLY_CHECK_TIMEOUT);
    });
  }

  /**
   * Check if the shell in the headless terminal is at a prompt (idle, waiting
   * for input). Used by earlyFailureCheck to distinguish between "command failed
   * and shell returned to prompt" vs "command is still running".
   */
  private isShellAtPrompt(session: Session): boolean {
    const shell = session.info.shell;
    const buf = session.headlessTerminal.buffer.active;

    // Find the last non-blank line in the headless buffer
    let lastLine = '';
    for (let y = buf.length - 1; y >= 0; y--) {
      const line = buf.getLine(y);
      if (line) {
        const text = line.translateToString(true);
        if (text.trim()) {
          lastLine = text.trim();
          break;
        }
      }
    }

    if (!lastLine) return false;

    switch (shell) {
      case 'powershell':
      case 'pwsh':
        // PowerShell prompt: "PS C:\path>" or "PS C:\path>>"
        return /^PS\s+.+[>$]$/.test(lastLine);
      case 'cmd':
        // CMD prompt: "C:\path>" or "D:\path>"
        return /^[A-Z]:\\.*>\s*$/.test(lastLine);
      case 'bash':
      case 'zsh':
      case 'sh':
        // Bash/zsh prompt ends with $ or % or #
        return /[$%#]\s*$/.test(lastLine);
      default:
        return false;
    }
  }

  /**
   * Poll a session for the result of a running/completed command.
   */
  async poll(sessionId: string): Promise<SendResult> {
    const session = this.sessions.get(sessionId);
    if (!session || session.info.status !== 'active') {
      throw new Error(`Session ${sessionId} not found or already closed`);
    }
  
    if (!session.commandRunning && !session.commandMarker) {
      return { output: 'No command is currently running in this session.', status: 'completed' };
    }
  
    const marker = session.commandMarker || '';
    const outputMarker = session.outputMarker;
    const shell = session.info.shell;
    const fullCommand = session.commandFullText;
      
    // Check if outputMarker has appeared (command completed)
    // Use count-based detection: markerB must appear at least twice on ALL
    // shells — once in the command echo text, once from the actual markerB-
    // producing subcommand.  (Position-based detection does not work for
    // cmd.exe because markerB is placed right after markerA in the echo.)
    //
    // Strip \r\n before counting to handle terminal line-wrap splitting.
    if (outputMarker) {
      const escapedB = outputMarker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const bufferForCount = session.commandOutput.replace(/[\r\n]+/g, '');
      const markerBCount = (bufferForCount.match(new RegExp(escapedB, 'g')) || []).length;
      if (markerBCount >= 1) {
        session.commandRunning = false;
        const output = await this.extractHeadlessOutput(session, 'completed');
        // Reset tracking
        session.commandMarker = null;
        session.outputMarker = null;
        session.commandOutput = '';
        session.commandFullText = '';
        return { output, status: 'completed' };
      }
    }
      
    if (!session.commandRunning) {
      // Process exited without outputMarker
      const output = await this.extractHeadlessOutput(session, 'completed');
      session.commandMarker = null;
      session.outputMarker = null;
      session.commandOutput = '';
      session.commandFullText = '';
      return { output: output || '(process exited without completion marker)', status: 'completed' };
    }
      
    // Still running — return current output without waiting for markerB
    const currentOutput = await this.extractHeadlessOutput(session, 'progress');
    return {
      output: currentOutput || '(no output yet)',
      status: 'still_running',
    };
  }
  
  /**
   * Wait for a running command to complete, blocking server-side.
   * Returns immediately if the command is already completed.
   * If timeout is reached while still running, returns current output with still_running status.
   */
  async waitUntilComplete(sessionId: string, options: { timeout?: number; signal?: AbortSignal } = {}): Promise<SendResult> {
    const session = this.sessions.get(sessionId);
    if (!session || session.info.status !== 'active') {
      throw new Error(`Session ${sessionId} not found or already closed`);
    }

    // If no command is running, check immediately
    if (!session.commandRunning && !session.commandMarker) {
      return { output: 'No command is currently running in this session.', status: 'completed' };
    }

    // Check if already completed
    const instantResult = await this.poll(sessionId);
    if (instantResult.status === 'completed') {
      return instantResult;
    }

    // Wait for completion with timeout
    const timeout = options.timeout ?? 120_000;
    const shell = session.info.shell;

    return new Promise<SendResult>((resolve) => {
      const timer = setTimeout(async () => {
        session.dataHandlers.delete(dataHandler);
        session.exitHandlers.delete(exitHandler);
        // Return current output with still_running status. markerB has not
        // fired yet, so use 'progress' mode.
        const currentOutput = await this.extractHeadlessOutput(session, 'progress');
        resolve({
          output: currentOutput || '(no output yet, command still running)',
          status: 'still_running',
        });
      }, timeout);
      
      const dataHandler = async (_data: string) => {
        try {
        session.info.lastActivity = Date.now();

        const outMarker = session.outputMarker;
        if (!outMarker) return;

        const escapedB = outMarker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const bufferForCount = session.commandOutput.replace(/[\r\n]+/g, '');
        const markerBCount = (bufferForCount.match(new RegExp(escapedB, 'g')) || []).length;
        if (markerBCount >= 1) {
          clearTimeout(timer);
          session.dataHandlers.delete(dataHandler);
          session.exitHandlers.delete(exitHandler);
          session.commandRunning = false;
          const output = await this.extractHeadlessOutput(session, 'completed');
          session.commandMarker = null;
          session.outputMarker = null;
          session.commandOutput = '';
          session.commandFullText = '';
          resolve({ output, status: 'completed' });
        }
        } catch (err) {
          clearTimeout(timer);
          session.dataHandlers.delete(dataHandler);
          session.exitHandlers.delete(exitHandler);
          session.commandRunning = false;
          const fallback = collapseBlankLines(stripAnsi(session.commandOutput)).trim();
          resolve({ output: fallback || '(error extracting output)', status: 'completed' });
        }
      };
      
      const exitHandler = async (code: number) => {
        clearTimeout(timer);
        session.dataHandlers.delete(dataHandler);
        session.exitHandlers.delete(exitHandler);
        session.commandRunning = false;
        const output = await this.extractHeadlessOutput(session, 'completed');
        session.commandMarker = null;
        session.outputMarker = null;
        session.commandOutput = '';
        session.commandFullText = '';
        resolve({
          output: output || `(process exited with code ${code})`,
          status: 'completed',
        });
      };

      session.dataHandlers.add(dataHandler);
      session.exitHandlers.add(exitHandler);

      // Handle abort signal
      if (options.signal) {
        const onAbort = () => {
          clearTimeout(timer);
          session.dataHandlers.delete(dataHandler);
          session.exitHandlers.delete(exitHandler);
          resolve({
            output: 'Poll wait aborted by user.',
            status: 'still_running',
          });
        };
        if (options.signal.aborted) {
          onAbort();
          return;
        }
        options.signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  }

  /**
   * Kill a PTY process and its entire child process tree.
   */
  private killPty(child: pty.IPty): void {
    try { child.kill(); } catch { /* ignore */ }
    // On Windows, pty.kill() may not always terminate the whole conhost tree.
    // Use taskkill as a fallback to be safe.
    if (process.platform === 'win32' && child.pid) {
      try {
        execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: 'ignore', timeout: 5000 });
      } catch { /* process may already be dead */ }
    }
  }

  /**
   * Wait until no new output for `idleMs` milliseconds.
   */
  private waitForIdle(session: Session, idleMs: number): Promise<string> {
    return new Promise((resolve) => {
      let buffer = '';
      let idleTimer: ReturnType<typeof setTimeout>;

      const handler = (data: string) => {
        buffer += data;
        session.info.lastActivity = Date.now();
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          session.dataHandlers.delete(handler);
          resolve(buffer);
        }, idleMs);
      };

      session.dataHandlers.add(handler);

      // Resolve even if no output comes at all
      idleTimer = setTimeout(() => {
        session.dataHandlers.delete(handler);
        resolve(buffer);
      }, idleMs);
    });
  }

  /**
   * Wait for one of these signals in interactive mode:
   *   - `expectPrompt` appears in the output (e.g. "password:")
   *   - the underlying PTY process exits
   *   - output is idle for IDLE_DETECT_MS (no new data)
   *   - hard timeout reached
   * Returns the reason we stopped waiting.
   */
  private waitForInteractiveSignal(
    session: Session,
    options: { timeout: number; expectPrompt?: string; signal?: AbortSignal },
  ): Promise<'expectPrompt' | 'exit' | 'idle' | 'timeout' | 'abort'> {
    return new Promise((resolve) => {
      let resolved = false;
      let idleTimer: ReturnType<typeof setTimeout>;
      let hardTimer: ReturnType<typeof setTimeout>;

      const cleanup = () => {
        clearTimeout(idleTimer);
        clearTimeout(hardTimer);
        session.dataHandlers.delete(dataHandler);
        session.exitHandlers.delete(exitHandler);
        if (options.signal && abortHandler) {
          options.signal.removeEventListener('abort', abortHandler);
        }
      };

      const finish = (reason: 'expectPrompt' | 'exit' | 'idle' | 'timeout' | 'abort') => {
        if (resolved) return;
        resolved = true;
        cleanup();
        resolve(reason);
      };

      const dataHandler = (data: string) => {
        if (resolved) return;
        session.info.lastActivity = Date.now();

        // Check for expected prompt
        if (options.expectPrompt && data.includes(options.expectPrompt)) {
          finish('expectPrompt');
          return;
        }
        // Also re-check full accumulated output in case the prompt is split
        // across multiple chunks (e.g. "pass" + "word:")
        if (options.expectPrompt && session.commandOutput.includes(options.expectPrompt)) {
          finish('expectPrompt');
          return;
        }

        // Reset idle timer — we just got new data
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          finish('idle');
        }, IDLE_DETECT_MS);
      };

      const exitHandler = (_code: number) => {
        finish('exit');
      };

      session.dataHandlers.add(dataHandler);
      session.exitHandlers.add(exitHandler);

      // Start idle timer immediately in case no output comes at all
      idleTimer = setTimeout(() => {
        finish('idle');
      }, IDLE_DETECT_MS);

      // Hard timeout
      hardTimer = setTimeout(() => {
        finish('timeout');
      }, options.timeout);

      // Abort signal
      let abortHandler: (() => void) | null = null;
      if (options.signal) {
        if (options.signal.aborted) {
          finish('abort');
          return;
        }
        abortHandler = () => finish('abort');
        options.signal.addEventListener('abort', abortHandler, { once: true });
      }
    });
  }

  /**
   * Remove the command echo from interactive-mode output.
   * Simpler than cleanOutput because there's no marker to deal with.
   */
  private removeCommandEcho(output: string, command: string): string {
    // Try to find and remove the echoed command line
    const cmdIdx = output.indexOf(command);
    if (cmdIdx !== -1) {
      // Remove the command echo and any trailing whitespace on that line
      const afterCmd = output.substring(cmdIdx + command.length);
      const newlineIdx = afterCmd.indexOf('\n');
      if (newlineIdx !== -1) {
        let result = afterCmd.substring(newlineIdx + 1);
        // Skip shell continuation prompts (PowerShell '>> ' lines from
        // wrapped command echo, cmd.exe backtick continuation lines)
        const lines = result.split('\n');
        let start = 0;
        for (let i = 0; i < lines.length; i++) {
          const trimmed = lines[i].trim();
          if (trimmed === '>> ' || trimmed === '>>' || trimmed.startsWith('`')) {
            start = i + 1;
            continue;
          }
          break;
        }
        return lines.slice(start).join('\n').trim();
      }
      return afterCmd.trim();
    }
    // Fallback: if command not found as-is, try removing the first line
    // (which is usually the command echo)
    const firstNewline = output.indexOf('\n');
    if (firstNewline !== -1 && command.length > 3) {
      const firstLine = output.substring(0, firstNewline).trim();
      // If first line starts with the command text, likely the echo
      if (firstLine.startsWith(command.substring(0, Math.min(15, command.length)))) {
        let result = output.substring(firstNewline + 1);
        // Skip continuation lines
        const lines = result.split('\n');
        let start = 0;
        for (let i = 0; i < lines.length; i++) {
          const trimmed = lines[i].trim();
          if (trimmed === '>> ' || trimmed === '>>' || trimmed.startsWith('`')) {
            start = i + 1;
            continue;
          }
          break;
        }
        return lines.slice(start).join('\n').trim();
      }
    }
    return output;
  }

  /**
   * Extract clean command output from the headless xterm.js terminal buffer.
   *
   * The headless terminal mirrors all raw PTY bytes and handles ANSI escape
   * sequences, cursor movements, and PSReadLine re-draws automatically. So
   * instead of hand-rolling regexes to strip ANSI / remove echoes, we read
   * the 2D buffer directly.
   *
   * @param session  The session whose headless buffer to read.
   * @param mode     'completed' = markerB was seen, strip echo + markers.
   *                 'progress'  = markerB NOT seen yet, strip echo only.
   */
  private async extractHeadlessOutput(session: Session, mode: 'completed' | 'progress'): Promise<string> {
    // Wait for all pending headless writes to be parsed so the buffer is up-to-date.
    if (session.pendingHeadlessWrites > 0) {
      const resolved = await Promise.race([
        new Promise<boolean>((resolve) => {
          session.headlessWriteResolvers.add(() => resolve(true));
        }),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 100)),
      ]);
      if (!resolved) {
        return this.extractFallbackOutput(session, mode);
      }
    }

    const buf = session.headlessTerminal.buffer.active;
    const markerA = session.commandMarker || '';
    const markerB = session.outputMarker || '';
    const userCmd = this.extractUserCommand(session.commandFullText.replace(/\r?\n$/, ''));

    // Read ALL lines from the headless buffer (including scrollback).
    // PowerShell reuses lines via cursor movement, so buf.length may not
    // increase — we must read the full buffer and search for the output.
    const allLines: string[] = [];
    for (let y = 0; y < buf.length; y++) {
      const line = buf.getLine(y);
      if (line) {
        allLines.push(line.translateToString(true)); // trimRight
      }
    }

    if (process.env.XAI_PTY_DEBUG) {
      console.log(`[extractHeadlessOutput] mode=${mode} bufLen=${buf.length} userCmd="${userCmd}"`);
      // Print last 10 non-empty lines for debugging
      const nonEmpty: string[] = [];
      for (let i = 0; i < allLines.length; i++) {
        if (allLines[i].trim()) nonEmpty.push(`[${i}]="${allLines[i].substring(0, 60)}"`);
      }
      console.log(`[extractHeadlessOutput] non-empty lines (last 10): ${nonEmpty.slice(-10).join(' | ')}`);
    }

    // Find the LAST occurrence of the user command echo, then take
    // everything after it as output. PowerShell's PSReadLine redraws
    // the command line, causing the user command text to appear multiple
    // times. The LAST occurrence is the actual command echo.
    let echoEndIdx = 0;
    if (userCmd.length > 0) {
      const searchPrefix = userCmd.substring(0, Math.min(20, userCmd.length));
      for (let i = allLines.length - 1; i >= 0; i--) {
        if (allLines[i].includes(searchPrefix)) {
          echoEndIdx = i + 1;
          break;
        }
      }
    }

    // Skip continuation lines after the echo (marker suffix fragments, etc.)
    const maxSkip = 8;
    for (let i = echoEndIdx; i < allLines.length && i < echoEndIdx + maxSkip; i++) {
      const trimmed = allLines[i].trim();
      if (trimmed === '' && i === echoEndIdx) {
        echoEndIdx = i + 1;
        continue;
      }
      if (trimmed === '>>' || trimmed === '>> ' || trimmed.startsWith('`') ||
          /__XAI[AB]_[a-z0-9_]+/.test(trimmed) ||
          (trimmed.startsWith('&&') || trimmed.startsWith(';')) ||
          trimmed.startsWith('echo ') || trimmed.startsWith('call echo') ||
          trimmed.includes('Write-Output') || trimmed.includes('GetEnvironmentVariable') ||
          trimmed.includes('%XAI_MARKER%') || trimmed.includes('$env:XAI_MARKER') ||
          trimmed.includes('$XAI_MARKER') ||
          trimmed.includes('[System.Environment]') ||
          trimmed.includes('if ($?)')) {
        echoEndIdx = i + 1;
        continue;
      }
      break;
    }

    let outputLines = allLines.slice(echoEndIdx);

    // In completed mode, strip marker text from the end
    if (mode === 'completed' && (markerA || markerB)) {
      const markerPieces = [markerA, markerB].filter((m): m is string => !!m && m.length > 0);
      while (outputLines.length > 0) {
        const lastLine = outputLines[outputLines.length - 1].trim();
        const isMarkerOnly = markerPieces.some(m => lastLine === m);
        if (isMarkerOnly) {
          outputLines.pop();
        } else if (lastLine === '') {
          outputLines.pop();
        } else {
          // The line may contain both output and a marker (e.g. "first __XAIB_...")
          let cleaned = lastLine;
          for (const marker of markerPieces) {
            cleaned = cleaned.replace(marker, '').trim();
          }
          if (cleaned) {
            outputLines[outputLines.length - 1] = cleaned;
          } else {
            outputLines.pop();
          }
          break;
        }
      }
    }

    let output = collapseBlankLines(outputLines.join('\n')).trim();

    // If the headless buffer produced empty output, fall back to raw output
    if (!output && session.commandOutput) {
      if (process.env.XAI_PTY_DEBUG) {
        console.log(`[extractHeadlessOutput] headless buffer empty but raw output exists, falling back`);
      }
      return this.extractFallbackOutput(session, mode);
    }

    return truncateOutput(output);
  }

  /**
   * Fallback output extraction when the headless terminal buffer hasn't
   * processed writes yet. Uses stripAnsi on the raw commandOutput.
   */
  private extractFallbackOutput(session: Session, mode: 'completed' | 'progress'): string {
    const raw = session.commandOutput;
    if (!raw) return '';

    const stripped = stripAnsi(raw);
    const markerA = session.commandMarker || '';
    const markerB = session.outputMarker || '';
    const userCmd = this.extractUserCommand(session.commandFullText.replace(/\r?\n$/, ''));

    // Split into lines for line-by-line processing
    const allLines = stripped.split(/\r?\n/);

    if (process.env.XAI_PTY_DEBUG) {
      console.log(`[extractFallbackOutput] userCmd="${userCmd}" lines=${allLines.length} mode=${mode} rawLen=${raw.length} strippedLen=${stripped.length}`);
      console.log(`[extractFallbackOutput] stripped preview: ${JSON.stringify(stripped.substring(0, 500))}`);
    }

    // Strategy: find the LAST occurrence of the user command echo, then
    // take everything after it (and its continuation lines) as output.
    // PowerShell's PSReadLine redraws the command line, causing the user
    // command text to appear multiple times. The LAST occurrence is the
    // actual command echo; everything after it is the real output.
    let echoEndIdx = 0;
    if (userCmd.length > 0) {
      const searchPrefix = userCmd.substring(0, Math.min(20, userCmd.length));
      // Find the last line that contains the user command prefix
      for (let i = allLines.length - 1; i >= 0; i--) {
        if (allLines[i].includes(searchPrefix)) {
          echoEndIdx = i + 1;
          break;
        }
      }
    }

    // Skip continuation lines after the echo (marker suffix fragments, etc.)
    const maxSkip = 8;
    for (let i = echoEndIdx; i < allLines.length && i < echoEndIdx + maxSkip; i++) {
      const trimmed = allLines[i].trim();
      if (trimmed === '' && i === echoEndIdx) {
        // Skip blank line immediately after echo
        echoEndIdx = i + 1;
        continue;
      }
      if (trimmed === '>>' || trimmed === '>> ' || trimmed.startsWith('`') ||
          /__XAI[AB]_[a-z0-9_]+/.test(trimmed) ||
          (trimmed.startsWith('&&') || trimmed.startsWith(';')) ||
          trimmed.startsWith('echo ') || trimmed.startsWith('call echo') ||
          trimmed.includes('Write-Output') || trimmed.includes('GetEnvironmentVariable') ||
          trimmed.includes('%XAI_MARKER%') || trimmed.includes('$env:XAI_MARKER') ||
          trimmed.includes('$XAI_MARKER') ||
          trimmed.includes('[System.Environment]') ||
          trimmed.includes('if ($?)')) {
        echoEndIdx = i + 1;
        continue;
      }
      break;
    }

    let outputLines = allLines.slice(echoEndIdx);

    // In completed mode, strip marker text from the end
    if (mode === 'completed' && (markerA || markerB)) {
      const markerPieces = [markerA, markerB].filter((m): m is string => !!m && m.length > 0);
      while (outputLines.length > 0) {
        const lastLine = outputLines[outputLines.length - 1].trim();
        const isMarkerOnly = markerPieces.some(m => lastLine === m);
        if (isMarkerOnly) {
          outputLines.pop();
        } else if (lastLine === '') {
          outputLines.pop();
        } else {
          // The line may contain both output and a marker (e.g. "first __XAIB_...")
          // Remove just the marker text, preserving the output portion
          let cleaned = lastLine;
          for (const marker of markerPieces) {
            cleaned = cleaned.replace(marker, '').trim();
          }
          if (cleaned) {
            outputLines[outputLines.length - 1] = cleaned;
          } else {
            outputLines.pop();
          }
          break;
        }
      }
    }

    return truncateOutput(collapseBlankLines(outputLines.join('\n')).trim());
  }

  /**
   * Extract the user-visible command from the full command string
   * (which includes the marker suffix). Returns just the part the user typed.
   */
  private extractUserCommand(fullCommand: string): string {
    // cmd: "userCmd && echo __XAIA_... && call echo %XAI_MARKER%"
    const cmdAndIdx = fullCommand.indexOf(' && echo ');
    if (cmdAndIdx > 0) return fullCommand.substring(0, cmdAndIdx).trimEnd();
    // PowerShell: "userCmd; if ($?) { ... }"
    const psIdx = fullCommand.indexOf('; if ($?)');
    if (psIdx > 0) return fullCommand.substring(0, psIdx).trimEnd();
    // PowerShell old: "userCmd; Write-Output ..."
    const psWriteIdx = fullCommand.indexOf('; Write-Output');
    if (psWriteIdx > 0) return fullCommand.substring(0, psWriteIdx).trimEnd();
    // PowerShell .NET: "userCmd; [System.Environment]..."
    const psNetIdx = fullCommand.indexOf('; [System.Environment]');
    if (psNetIdx > 0) return fullCommand.substring(0, psNetIdx).trimEnd();
    // bash: "userCmd; echo "$XAI_MARKER" # __XAIA_..."
    const bashIdx = fullCommand.indexOf('; echo ');
    if (bashIdx > 0) return fullCommand.substring(0, bashIdx).trimEnd();
    // Fallback: return as-is (without trailing \r\n)
    return fullCommand.replace(/\r?\n$/, '').trimEnd();
  }

  /**
   * Close sessions that have been idle longer than the timeout.
   * Sessions with a running command (e.g. pnpm dev, java -jar) are
   * NEVER auto-closed — they are long-lived processes the user expects
   * to keep running even when output has stabilized.
   */
  private cleanupIdleSessions(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (
        session.info.status === 'active' &&
        !session.commandRunning &&
        now - session.info.lastActivity > this.idleTimeout
      ) {
        console.log(`[TerminalSessionManager] Auto-closing idle session: ${id}`);
        this.close(id);
      }
    }
  }
}