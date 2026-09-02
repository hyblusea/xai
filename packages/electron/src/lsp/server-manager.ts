/**
 * LSP Server Manager — generic host for language servers.
 *
 * The manager is language-agnostic: it spawns a child process described by
 * a LanguageServerDescriptor and bridges the process's stdio JSON-RPC to a
 * MessagePortMain that gets transferred to the renderer.
 *
 * The main process is a transparent relay: it does not parse LSP message
 * semantics, only converts between raw stdio (Content-Length framed) and
 * structured JS objects over MessagePort.
 */
import { spawn, type ChildProcess } from 'child_process';
import { MessageChannelMain, type MessagePortMain } from 'electron';
import {
  StreamMessageReader,
  StreamMessageWriter,
} from 'vscode-languageserver-protocol/node';
import type { LanguageServerDescriptor, PreparedServer } from './descriptor.js';

export interface LSPServerOptions {
  workspaceRoot: string;
  /** Language key — determines which descriptor to use ('typescript' | 'java'). */
  language: string;
}

/** Registry of language → descriptor. */
const descriptors = new Map<string, LanguageServerDescriptor>();

export function registerLanguageServer(descriptor: LanguageServerDescriptor): void {
  descriptors.set(descriptor.language, descriptor);
}

export function getRegisteredLanguages(): string[] {
  return Array.from(descriptors.keys());
}

function getDescriptor(language: string): LanguageServerDescriptor {
  const d = descriptors.get(language);
  if (!d) {
    throw new Error(`[LSP] No language server registered for "${language}". Registered: ${getRegisteredLanguages().join(', ')}`);
  }
  return d;
}

export class LSPServerManager {
  private process: ChildProcess | null = null;
  private reader: StreamMessageReader | null = null;
  private writer: StreamMessageWriter | null = null;
  private port: MessagePortMain | null = null;
  private disposed = false;
  /** Optional cleanup callback returned by the descriptor's prepare(). */
  private cleanup: (() => void) | null = null;
  /** Initialization options from the descriptor — passed to the renderer
   *  so it can include them in the LSP initialize request. */
  private initOptions: Record<string, unknown> | null = null;
  /** Buffered progress messages from prepare() — flushed to the port once
   *  it's created. Without this, download progress (e.g. JDT.LS) is lost
   *  because this.port is null during prepare(). */
  private pendingProgress: Array<{ message: string; percent: number }> = [];

  /** Spawn the language server and return the MessagePortMain for the renderer. */
  async start(options: LSPServerOptions): Promise<MessagePortMain> {
    // Clean up any existing server first.
    this.stopInternal();

    const descriptor = getDescriptor(options.language);
    const prepared = await descriptor.prepare({
      workspaceRoot: options.workspaceRoot,
      onProgress: (message, percent) => {
        // Buffer progress messages — port is not yet created during prepare().
        // They will be flushed to the renderer once the port is established.
        this.pendingProgress.push({ message, percent });
        // Also try sending directly in case port already exists (restart scenario).
        try {
          this.port?.postMessage({ type: 'progress', message, percent });
        } catch { /* port not yet attached */ }
      },
    });
    this.cleanup = prepared.cleanup ?? null;
    this.initOptions = prepared.initOptions ?? null;

    this.process = spawn(prepared.command, prepared.args, {
      cwd: prepared.cwd,
      env: prepared.env,
    });

    if (!this.process.stdout || !this.process.stdin) {
      throw new Error('[LSP] Failed to open stdio for language server process.');
    }

    this.reader = new StreamMessageReader(this.process.stdout);
    this.writer = new StreamMessageWriter(this.process.stdin);

    const { port1, port2 } = new MessageChannelMain();
    this.port = port1;

    // Flush buffered progress messages (from prepare()) to the renderer.
    for (const p of this.pendingProgress) {
      try {
        port1.postMessage({ type: 'progress', message: p.message, percent: p.percent });
      } catch { /* ignore */ }
    }
    this.pendingProgress = [];

    // server stdout → port1 → renderer
    this.reader.listen((message: unknown) => {
      try {
        port1.postMessage({ type: 'message', data: message });
      } catch {
        // Port may have been closed by the renderer; ignore.
      }
    });

    // renderer → port1 → server stdin
    port1.on('message', (event: { data: unknown }) => {
      const msg = event.data as { type: string; data?: unknown } | undefined;
      if (msg?.type === 'message' && msg.data) {
        try {
          this.writer?.write(msg.data as any);
        } catch (err) {
          console.error('[LSP] Failed to write to server stdin:', err);
        }
      }
    });
    port1.start();

    this.process.on('exit', (code, signal) => {
      console.log(`[LSP] Server exited: code=${code}, signal=${signal}`);
      try {
        port1.postMessage({ type: 'exit', code: code ?? -1, signal: signal ?? null });
      } catch { /* port closed */ }
      this.cleanupRefs();
    });

    this.process.on('error', (err) => {
      console.error('[LSP] Server process error:', err);
      try {
        port1.postMessage({ type: 'error', error: err.message });
      } catch { /* port closed */ }
      this.cleanupRefs();
    });

    return port2;
  }

  /** Restart the server with new options. */
  async restart(options: LSPServerOptions): Promise<MessagePortMain> {
    this.stopInternal();
    return this.start(options);
  }

  /** Stop the server and close the port. */
  stop(): void {
    this.stopInternal();
  }

  private stopInternal(): void {
    if (this.cleanup) {
      try { this.cleanup(); } catch { /* ignore */ }
      this.cleanup = null;
    }
    this.initOptions = null;
    this.pendingProgress = [];
    if (this.port) {
      try { this.port.postMessage({ type: 'closing' }); } catch { /* ignore */ }
      try { this.port.removeAllListeners(); } catch { /* ignore */ }
      try { this.port.close(); } catch { /* ignore */ }
      this.port = null;
    }
    if (this.reader) {
      try { this.reader.dispose(); } catch { /* ignore */ }
      this.reader = null;
    }
    if (this.writer) {
      try { this.writer.dispose(); } catch { /* ignore */ }
      this.writer = null;
    }
    if (this.process) {
      try { this.process.kill('SIGTERM'); } catch { /* ignore */ }
      // Give it a moment, then force kill if still alive.
      const proc = this.process;
      setTimeout(() => {
        try {
          if (!proc.killed) proc.kill('SIGKILL');
        } catch { /* already dead */ }
      }, 3000);
      this.process = null;
    }
  }

  private cleanupRefs(): void {
    this.process = null;
    this.reader = null;
    this.writer = null;
    this.port = null;
  }

  /** Permanently dispose — no further start() calls allowed. */
  dispose(): void {
    this.disposed = true;
    this.stopInternal();
  }

  get isRunning(): boolean {
    return this.process !== null && !this.process.killed;
  }

  /** Initialization options provided by the descriptor (e.g. tsserver.path).
   *  The renderer merges these into the LSP initialize request. */
  getInitOptions(): Record<string, unknown> | null {
    return this.initOptions;
  }
}

/** Re-export descriptor types for callers that import from the manager module. */
export type { LanguageServerDescriptor };
