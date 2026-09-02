/**
 * LanguageServerDescriptor — describes how to launch a language server.
 *
 * Each language (typescript, java, ...) implements this interface and
 * registers itself via registerLanguageServer() at app startup.
 *
 * The prepare() method is async so descriptors can perform one-time setup
 * such as downloading the server binary, resolving JDK path, etc.
 */

export interface PrepareContext {
  /** Absolute path to the workspace root. */
  workspaceRoot: string;
  /** Called to report progress for long-running prepare steps (e.g. download). */
  onProgress: (message: string, percent: number) => void;
}

export interface PreparedServer {
  /** Executable to spawn (e.g. process.execPath, 'java'). */
  command: string;
  /** Command-line arguments. */
  args: string[];
  /** Environment variables for the child process. */
  env: NodeJS.ProcessEnv;
  /** Working directory for the child process. */
  cwd: string;
  /**
   * Optional initialization options to pass through to the renderer, which
   * will include them in the LSP `initialize` request's `initializationOptions`.
   *
   * Some servers require path information that only the main process can
   * resolve (e.g. the absolute path to tsserverlibrary.js). These are merged
   * with the renderer-built options (renderer takes precedence for shared keys).
   */
  initOptions?: Record<string, unknown>;
  /** Optional cleanup callback — called when the server stops, before re-spawn. */
  cleanup?: () => void;
}

export interface LanguageServerDescriptor {
  /** Language key — matches the `language` field in LSPServerOptions. */
  language: string;
  /**
   * Prepare the server launch. This is the right place to:
   *   - Resolve runtime paths (JDK, npm package entry)
   *   - Download the server on first use (with progress)
   *   - Set up workspace data directories
   * Returns the command/args to spawn.
   */
  prepare(ctx: PrepareContext): Promise<PreparedServer>;
}
