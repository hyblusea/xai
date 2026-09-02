/**
 * LSP Client — communicates with typescript-language-server via MessagePort.
 *
 * The MessagePort is transferred from the main process (which spawns the
 * language server and bridges its stdio to the port). This class handles:
 *   1. JSON-RPC request/response matching
 *   2. LSP protocol (initialize, didOpen, didChange, didClose, completion, etc.)
 *   3. Monaco editor provider registration (completion, hover, definition, references)
 *   4. Diagnostic markers from server → monaco
 */

// ── URI utilities ──────────────────────────────────────────────────────────

/** Convert a file system path to a file:// URI. */
function pathToUri(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  // Windows: D:\path → file:///D:/path
  if (/^[A-Za-z]:/.test(normalized)) {
    return 'file:///' + normalized;
  }
  // Unix: /path → file:///path
  return 'file://' + normalized;
}

/** Convert a file:// URI back to a file system path.
 *  Used to read file content when creating Monaco models for cross-file
 *  definition/reference navigation. */
function uriToPath(uri: string): string | null {
  try {
    // file:///D:/path → D:\path (Windows)
    // file:///path → /path (Unix)
    const match = uri.match(/^file:\/\/+\/?(.*)$/);
    if (!match) return null;
    const decoded = decodeURIComponent(match[1]);
    // Windows: D:/path → D:\path
    if (/^[A-Za-z]:/.test(decoded)) {
      return decoded.replace(/\//g, '\\');
    }
    return '/' + decoded;
  } catch {
    return null;
  }
}

/** Callback for reading file content from disk (via IPC to main process).
 *  Used to create Monaco models on demand for cross-file navigation. */
export type ReadFileCallback = (filePath: string) => Promise<string | null>;

/** Map file extensions to Monaco language IDs for model creation. */
const EXT_TO_LANGUAGE: Record<string, string> = {
  java: 'java',
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
};

/** Compare two file:// URIs for equality, accounting for case differences
 *  (Windows drive letters), URL-encoding, and trailing slashes.
 *
 *  JDT.LS and pathToUri() may produce slightly different URI strings for the
 *  same file:
 *  - Drive letter case: file:///D:/... vs file:///d:/...
 *  - URL-encoding: file:///D:/My%20Project/... vs file:///D:/My Project/...
 *  - Path separators: file:///D:\... vs file:///D:/...
 *
 *  We normalize both to lowercase file paths and compare those. */
function uriEquals(uri1: string, uri2: string): boolean {
  if (uri1 === uri2) return true;
  const path1 = uriToPath(uri1)?.toLowerCase();
  const path2 = uriToPath(uri2)?.toLowerCase();
  if (path1 && path2) return path1 === path2;
  // Fallback: case-insensitive URI comparison
  return uri1.toLowerCase() === uri2.toLowerCase();
}

// ── Kind/severity mapping ──────────────────────────────────────────────────

/** LSP CompletionItemKind → monaco CompletionItemKind. */
function mapCompletionKind(lspKind: number, monaco: any): number {
  const K = monaco.languages.CompletionItemKind;
  const map: Record<number, number> = {
    1: K.Text, 2: K.Method, 3: K.Function, 4: K.Constructor,
    5: K.Field, 6: K.Variable, 7: K.Class, 8: K.Interface,
    9: K.Module, 10: K.Property, 11: K.Unit, 12: K.Value,
    13: K.Enum, 14: K.Keyword, 15: K.Snippet, 16: K.Color,
    17: K.File, 18: K.Reference, 19: K.Folder, 20: K.EnumMember,
    21: K.Constant, 22: K.Struct, 23: K.Event, 24: K.Operator,
    25: K.TypeParameter,
  };
  return map[lspKind] ?? K.Method;
}

/** LSP DiagnosticSeverity → monaco MarkerSeverity. */
function mapSeverity(lspSeverity: number, monaco: any): number {
  const S = monaco.MarkerSeverity;
  return ({ 1: S.Error, 2: S.Warning, 3: S.Info, 4: S.Hint } as Record<number, number>)[lspSeverity] ?? S.Info;
}

/**
 * Maps a language key (used in IPC) to the Monaco language IDs that the
 * corresponding LSP server should handle.
 * Each LSPClient only registers providers on its own languages — this
 * prevents duplicate registrations and wrong-server routing when multiple
 * servers (TS + Java) run concurrently.
 */
const LANGUAGE_KEY_TO_MONACO_IDS: Record<string, string[]> = {
  typescript: ['typescript', 'typescriptreact', 'javascript', 'javascriptreact'],
  java: ['java'],
};

// ── LSP Client ─────────────────────────────────────────────────────────────

/**
 * Minimal port interface — implemented by the preload's port wrapper.
 *
 * The raw MessagePort from Electron's IPC cannot cross the contextBridge
 * boundary (it's transferable, not cloneable), so the preload creates a
 * plain-object wrapper with these function properties. contextBridge safely
 * proxies function properties, so calls from the renderer reach the real
 * port in the preload's isolated context.
 */
export interface PortLike {
  postMessage(data: unknown): void;
  close(): void;
  start(): void;
  /** Set the message handler. Pass null to clear. Replaces raw onmessage setter. */
  onMessage(handler: ((data: any) => void) | null): void;
}

interface ActiveDocument {
  uri: string;
  languageId: string;
  version: number;
}

export class LSPClient {
  private port: PortLike;
  /** Language key — determines which Monaco language IDs this client handles. */
  private languageKey: string;
  /**
   * Initialization options provided by the descriptor (main process).
   * These are merged into the LSP `initialize` request as the base layer;
   * renderer-built options (e.g. Java settings.java) take precedence on
   * shared top-level keys.
   */
  private descriptorInitOptions: Record<string, unknown> | null;
  /** Callback to read file content from disk (via IPC). Used to create
   *  Monaco models on demand for cross-file definition/reference navigation. */
  private readFile: ReadFileCallback | null;
  private seq = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
  private monaco: any = null;
  private editor: any = null;
  private disposables: any[] = [];
  private activeDoc: ActiveDocument | null = null;
  private ready = false;
  private readyResolvers: (() => void)[] = [];
  private progressListeners: ((message: string, percent: number) => void)[] = [];
  /** Cache of file URIs currently being model-created (prevents duplicate
   *  concurrent creation requests for the same cross-file target). */
  private pendingModels = new Map<string, Promise<any | null>>();

  constructor(
    port: PortLike,
    languageKey: string,
    initOptions?: Record<string, unknown>,
    readFile?: ReadFileCallback,
  ) {
    this.port = port;
    this.languageKey = languageKey;
    this.descriptorInitOptions = initOptions ?? null;
    this.readFile = readFile ?? null;
    // Use onMessage() — the preload's port wrapper exposes this method
    // instead of the raw onmessage property (MessagePort can't cross the
    // contextBridge boundary). Setting onmessage on the real port in the
    // preload's context also auto-starts it.
    this.port.onMessage((data: any) => this.handlePortMessage(data));
    this.port.start();
  }

  // ── Message handling ──────────────────────────────────────────────────

  private handlePortMessage(msg: any): void {
    if (msg.type === 'message') {
      this.onLSPMessage(msg.data);
    } else if (msg.type === 'progress') {
      // Forwarded from descriptor.prepare() — e.g. JDT.LS download progress.
      // Listeners can attach via onProgress.
      this.progressListeners.forEach(fn => fn(msg.message, msg.percent));
    } else if (msg.type === 'exit') {
      console.warn('[LSP] Server exited:', msg.code, msg.signal);
    } else if (msg.type === 'error') {
      console.error('[LSP] Server error:', msg.error);
    }
  }

  private onLSPMessage(msg: any): void {
    // Response to a request
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        if (msg.error) p.reject(msg.error);
        else p.resolve(msg.result);
      }
      return;
    }
    // Notification from server
    if (msg.method) {
      switch (msg.method) {
        case 'textDocument/publishDiagnostics':
          this.handleDiagnostics(msg.params.uri, msg.params.diagnostics);
          break;
        case 'window/logMessage':
          console.log('[LSP]', msg.params.message);
          break;
        case 'language/status':
          // JDT.LS custom notification — reports project import progress.
          // params: { type: 'Starting'|'Started'|'ServiceReady'|'ProjectStatus'|'Error', message: string }
          this.handleLanguageStatus(msg.params);
          break;
        case '$/progress':
          // Standard progress notification — JDT.LS uses this for Maven import.
          this.handleProgress(msg.params);
          break;
      }
    }
  }

  /** Handle JDT.LS language/status notification — reports project import state. */
  private handleLanguageStatus(params: any): void {
    const type = params?.type ?? '';
    const message = params?.message ?? '';
    console.log(`[LSP:${this.languageKey}] language/status: ${type} — ${message}`);
    // Map JDT.LS status types to progress events for the UI.
    // ServiceReady = completion/hover/etc. are now available.
    if (type === 'ServiceReady') {
      this.progressListeners.forEach(fn => fn('Java 语言服务就绪', 100));
    } else if (type === 'Error') {
      console.error(`[LSP:${this.languageKey}] JDT.LS error: ${message}`);
    } else if (type === 'Starting' || type === 'Started' || type === 'ProjectStatus') {
      // Report import progress — JDT.LS is indexing the project.
      this.progressListeners.forEach(fn => fn(message || `JDT.LS: ${type}`, 50));
    }
  }

  /** Handle $/progress notification — used by JDT.LS for Maven import progress. */
  private handleProgress(params: any): void {
    if (!params) return;
    const token = params.token;
    const value = params.value;
    if (!value) return;
    if (value.kind === 'begin') {
      this.progressListeners.forEach(fn => fn(value.title || '正在导入项目...', 10));
    } else if (value.kind === 'report') {
      const percent = value.percentage ?? 50;
      this.progressListeners.forEach(fn => fn(value.message || value.title || '正在导入项目...', percent));
    } else if (value.kind === 'end') {
      this.progressListeners.forEach(fn => fn(value.message || '导入完成', 100));
    }
  }

  // ── JSON-RPC transport ────────────────────────────────────────────────

  private sendRequest(method: string, params: any, timeoutMs?: number): Promise<any> {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const entry = {
        resolve: (v: any) => {
          if (timer) clearTimeout(timer);
          resolve(v);
        },
        reject: (e: any) => {
          if (timer) clearTimeout(timer);
          reject(e);
        },
      };
      this.pending.set(id, entry);
      if (timeoutMs && timeoutMs > 0) {
        timer = setTimeout(() => {
          if (this.pending.has(id)) {
            this.pending.delete(id);
            reject(new Error(`LSP 请求超时 (${method}, ${timeoutMs}ms)`));
          }
        }, timeoutMs);
      }
      this.port.postMessage({
        type: 'message',
        data: { jsonrpc: '2.0', id, method, params },
      });
    });
  }

  private sendNotification(method: string, params: any): void {
    this.port.postMessage({
      type: 'message',
      data: { jsonrpc: '2.0', method, params },
    });
  }

  // ── LSP protocol ──────────────────────────────────────────────────────

  async initialize(workspaceRoot: string): Promise<void> {
    const rootUri = pathToUri(workspaceRoot);

    // Build initializationOptions.
    // Layer 1 (base): descriptor-provided options from the main process —
    //   e.g. tsserver.path for typescript-language-server v5.x (which removed
    //   the --tsserver-path CLI flag and now reads the path from here).
    // Layer 2 (override): renderer-built options — JDT.LS (Java) requires a
    //   settings.java object to enable Maven import. Renderer options take
    //   precedence on shared top-level keys.
    const initializationOptions: Record<string, unknown> = {
      ...(this.descriptorInitOptions ?? {}),
    };

    if (this.languageKey === 'java') {
      initializationOptions.settings = {
        java: {
          // Enable Maven import — JDT.LS will detect pom.xml and download deps.
          import: {
            maven: { enabled: true },
            // Don't exclude common source dirs
            exclusions: [
              '**/node_modules/**',
              '**/.metadata/**',
              '**/archetype-resources/**',
              '**/META-INF/maven/**',
            ],
          },
          // Let JDT.LS use JAVA_HOME (set in the descriptor) as project JDK.
          // home is left undefined → JDT.LS falls back to the JDK that launched it.
          configuration: {
            // Detect user Maven settings.xml if present
            userSettings: null,
            // Use default local repository (~/.m2/repository)
            maven: { userSettings: null, globalSettings: null },
          },
          // Avoid blocking on long imports — import happens in background
          importMode: 'automatic',
          // Enable completion for chain calls, method params, etc.
          completion: {
            enabled: true,
            guessMethodArguments: 'insertBestGuessedArguments',
          },
          signatureHelp: { enabled: true },
          format: { enabled: true, insertSpaces: true, tabSize: 2 },
        },
      };
      // extendedClientCapabilities — tells JDT.LS which advanced features we support
      initializationOptions.extendedClientCapabilities = {
        classFileContentsSupport: false,
        overrideMethodsPromptSupport: false,
        hashCodeEqualsPromptSupport: false,
        advancedOrganizeImportsSupport: false,
        generateToStringPromptSupport: false,
        advancedExtractRefactoringSupport: false,
        extractInterfaceSupport: false,
        moveRefactoringSupport: false,
        clientHoverProvider: true,
        clientDocumentSymbolProvider: true,
        shouldLanguageServerExitOnShutdown: true,
        onUpdateClasspathListener: false,
        onCompletionItemSelectedNotification: false,
        extractMethodArgumentsInputSupport: false,
      };
      // bundles — 保留 descriptor 传入的值（如 lombok.jar）。
      // 如果 descriptor 没有传入 bundles，则使用空数组（无 vscode-java 扩展）。
      // 注意：之前这里硬编码 bundles = []，会覆盖 descriptor 传入的 lombok bundle，
      // 导致 @Data 等注解生成的方法无法识别。现在只在 descriptor 未提供时才设为空。
      if (!Array.isArray(initializationOptions.bundles)) {
        initializationOptions.bundles = [];
      }
    }

    await this.sendRequest('initialize', {
      processId: null,
      rootUri,
      capabilities: {
        textDocument: {
          synchronization: { didSave: true },
          completion: { completionItem: { snippetSupport: true, documentationFormat: ['markdown', 'plaintext'] } },
          hover: { contentFormat: ['markdown', 'plaintext'] },
          definition: {},
          references: {},
          signatureHelp: {},
        },
        workspace: { workspaceFolders: true },
      },
      initializationOptions,
      workspaceFolders: [{ uri: rootUri, name: 'workspace', index: 0 }],
    });
    this.sendNotification('initialized', {});
    this.ready = true;
    this.readyResolvers.forEach(r => r());
    this.readyResolvers = [];
    console.log(`[LSP:${this.languageKey}] Initialized, root:`, rootUri);
  }

  /** Switch the active document — sends didClose for the old, didOpen for the new. */
  setActiveDocument(filePath: string, languageId: string, content: string): void {
    // Close previous document
    if (this.activeDoc) {
      this.sendNotification('textDocument/didClose', {
        textDocument: { uri: this.activeDoc.uri },
      });
    }

    const uri = pathToUri(filePath);
    this.activeDoc = { uri, languageId, version: 1 };

    if (this.handlesLanguageId(languageId)) {
      this.sendNotification('textDocument/didOpen', {
        textDocument: { uri, languageId, version: 1, text: content },
      });
    }
  }

  /** Check if this client is responsible for the given LSP languageId. */
  private handlesLanguageId(languageId: string): boolean {
    const ids = LANGUAGE_KEY_TO_MONACO_IDS[this.languageKey] || [];
    return ids.includes(languageId);
  }

  /** Notify content change from user editing. */
  onContentChange(content: string): void {
    if (!this.activeDoc || !this.handlesLanguageId(this.activeDoc.languageId)) return;
    this.activeDoc.version++;
    this.sendNotification('textDocument/didChange', {
      textDocument: { uri: this.activeDoc.uri, version: this.activeDoc.version },
      contentChanges: [{ text: content }],
    });
  }

  /** Close the active document (e.g. switching to a non-code file). */
  closeActiveDocument(): void {
    if (this.activeDoc) {
      this.sendNotification('textDocument/didClose', {
        textDocument: { uri: this.activeDoc.uri },
      });
      this.activeDoc = null;
    }
  }

  // ── Cross-file model management ──────────────────────────────────────

  /** Ensure a Monaco model exists for the given file:// URI.
   *  If a model already exists (e.g. the file is open in another tab),
   *  returns it immediately. Otherwise, reads the file content via IPC and
   *  creates a model with the file:// URI so Monaco's peek widget and
   *  go-to-definition navigation can display it.
   *
   *  This is critical for cross-file definition/reference navigation:
   *  JDT.LS returns file:// URIs for target files, but Monaco only has
   *  models for currently-open files (with inmemory:// URIs). Without
   *  creating a model for the target file, Monaco can't navigate to it
   *  and the definition lookup silently fails. */
  private async ensureModel(uri: string): Promise<any | null> {
    if (!this.monaco) return null;
    const parsedUri = this.monaco.Uri.parse(uri);

    // Fast path: model already exists (file might be open in another tab).
    const existing = this.monaco.editor.getModel(parsedUri);
    if (existing) return existing;

    // Avoid duplicate concurrent creation for the same URI.
    const pending = this.pendingModels.get(uri);
    if (pending) return pending;

    if (!this.readFile) {
      console.warn(`[LSP:${this.languageKey}] No readFile callback — cannot create model for ${uri}`);
      return null;
    }

    const filePath = uriToPath(uri);
    if (!filePath) {
      console.warn(`[LSP:${this.languageKey}] Cannot parse file path from URI: ${uri}`);
      return null;
    }

    // Capture into a local so TS control-flow narrowing survives the closure
    // (this.readFile is `ReadFileCallback | null`; the guard above ruled out null).
    const readFile = this.readFile;
    const createPromise = (async () => {
      const content = await readFile(filePath);
      if (content === null) {
        console.warn(`[LSP:${this.languageKey}] Failed to read file for cross-file navigation: ${filePath}`);
        return null;
      }

      // Determine language from file extension.
      const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
      const languageId = EXT_TO_LANGUAGE[ext] || 'plaintext';

      try {
        const model = this.monaco.editor.createModel(content, languageId, parsedUri);
        console.log(`[LSP:${this.languageKey}] Created model for cross-file navigation: ${uri}`);
        return model;
      } catch (err) {
        console.error(`[LSP:${this.languageKey}] Failed to create model for ${uri}:`, err);
        return null;
      }
    })();

    this.pendingModels.set(uri, createPromise);
    try {
      return await createPromise;
    } finally {
      this.pendingModels.delete(uri);
    }
  }

  /** Map an LSP Location[] or LocationLink[] result to Monaco locations.
   *
   *  Handles two cases:
   *  1. Same-file locations: JDT.LS returns file:// URIs, but the current
   *     Monaco model has an inmemory:// URI (created by @monaco-editor/react
   *     without a `path` prop). We map the file:// URI → current model's URI
   *     so Monaco can navigate within the visible editor.
   *  2. Cross-file locations: Create a Monaco model on demand (reading file
   *     content via IPC) so Monaco's peek widget / navigation can display it.
   *
   *  Also handles LocationLink[] (LSP 3.14+): { targetUri, targetRange,
   *  targetSelectionRange } — normalizes them to the Location format
   *  { uri, range } before mapping.
   */
  private async mapLocationsToMonaco(locations: any[], currentModelUri: any): Promise<any[]> {
    const result: any[] = [];
    for (const loc of locations) {
      if (!loc) continue;

      // Normalize LocationLink → Location (LSP 3.14+ format)
      // LocationLink: { originSelectionRange, targetUri, targetRange, targetSelectionRange }
      // Location:     { uri, range }
      const uri = loc.uri ?? loc.targetUri;
      const range = loc.range ?? loc.targetSelectionRange ?? loc.targetRange;
      if (!uri || !range) continue;

      // Same file as the active document → map to current model's URI.
      // This is the fix for same-file definitions (conn, jdbcUrl, getLimit, etc.)
      // which were previously filtered out because file:// ≠ inmemory://.
      //
      // IMPORTANT: JDT.LS and pathToUri may produce slightly different URI
      // strings (case differences in drive letters, URL-encoding of spaces,
      // trailing slashes, etc.). We compare via normalized file paths, not
      // raw string equality.
      if (this.activeDoc && uriEquals(uri, this.activeDoc.uri)) {
        console.log(`[LSP:${this.languageKey}] mapLocation: same-file match → mapping to current model URI`);
        result.push({
          uri: currentModelUri,
          range: new this.monaco.Range(
            range.start.line + 1, range.start.character + 1,
            range.end.line + 1, range.end.character + 1,
          ),
        });
        continue;
      }

      // Cross-file → ensure a Monaco model exists, then include the location.
      console.log(`[LSP:${this.languageKey}] mapLocation: cross-file → ensuring model for ${uri}`);
      const model = await this.ensureModel(uri);
      if (model) {
        result.push({
          uri: this.monaco.Uri.parse(uri),
          range: new this.monaco.Range(
            range.start.line + 1, range.start.character + 1,
            range.end.line + 1, range.end.character + 1,
          ),
        });
      } else {
        console.warn(`[LSP:${this.languageKey}] mapLocation: could not create model for ${uri}`);
      }
    }
    return result;
  }

  // ── Monaco integration ────────────────────────────────────────────────

  /** Register Monaco providers for this client's languages only.
   *  Also disables Monaco's built-in TS worker (only relevant for the TS client).
   *  Safe to call multiple times (e.g. when editor remounts) — previous providers are disposed first. */
  registerMonaco(monaco: any, editor: any): void {
    this.monaco = monaco;
    this.editor = editor;

    // Only the typescript client needs to disable Monaco's built-in TS worker.
    if (this.languageKey === 'typescript') {
      this.disableBuiltinTSWorker(monaco);
    }

    // Dispose previous provider registrations (editor may remount on tab switch)
    this.disposables.forEach(d => { try { d.dispose(); } catch { /* ignore */ } });
    this.disposables = [];

    // Only register providers on this client's own languages — prevents
    // duplicate registrations when TS and Java clients coexist.
    const languages = LANGUAGE_KEY_TO_MONACO_IDS[this.languageKey] || [];
    if (languages.length === 0) return;
    const ts = monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet;

    // Completion
    this.disposables.push(
      monaco.languages.registerCompletionItemProvider(languages, {
        triggerCharacters: ['.', '/', '<', '"', "'", '`'],
        provideCompletionItems: async (_model: any, position: any) => {
          if (!this.activeDoc) return { suggestions: [] };
          try {
            // 10s timeout — JDT.LS may not respond while importing project.
            const result = await this.sendRequest('textDocument/completion', {
              textDocument: { uri: this.activeDoc.uri },
              position: { line: position.lineNumber - 1, character: position.column - 1 },
            }, 10000);
            if (!result) return { suggestions: [] };
            const items = Array.isArray(result) ? result : (result.items || []);
            if (items.length === 0) {
              console.log(`[LSP:${this.languageKey}] completion returned 0 items at ${position.lineNumber}:${position.column}`);
            }
            const word = _model.getWordUntilPosition(position);
            const range = new monaco.Range(
              position.lineNumber, word.startColumn, position.lineNumber, word.endColumn,
            );
            return {
              suggestions: items.map((item: any) => ({
                label: item.label,
                kind: mapCompletionKind(item.kind, monaco),
                insertText: item.insertText || item.label,
                insertTextRules: item.insertTextFormat === 2 ? ts : 0,
                detail: item.detail,
                documentation: typeof item.documentation === 'object' ? item.documentation.value : item.documentation,
                sortText: item.sortText,
                filterText: item.filterText,
                range,
              })),
            };
          } catch (err) {
            console.error(`[LSP:${this.languageKey}] completion request failed:`, err);
            return { suggestions: [] };
          }
        },
      }),
    );

    // Hover
    this.disposables.push(
      monaco.languages.registerHoverProvider(languages, {
        provideHover: async (_model: any, position: any) => {
          if (!this.activeDoc) return null;
          try {
            const result = await this.sendRequest('textDocument/hover', {
              textDocument: { uri: this.activeDoc.uri },
              position: { line: position.lineNumber - 1, character: position.column - 1 },
            });
            if (!result) return null;
            const range = result.range ? new monaco.Range(
              result.range.start.line + 1, result.range.start.character + 1,
              result.range.end.line + 1, result.range.end.character + 1,
            ) : undefined;
            const contents = Array.isArray(result.contents)
              ? result.contents.map((c: any) => typeof c === 'object' ? c.value : c)
              : [typeof result.contents === 'object' ? result.contents.value : result.contents];
            return { range, contents };
          } catch {
            return null;
          }
        },
      }),
    );

    // Definition
    this.disposables.push(
      monaco.languages.registerDefinitionProvider(languages, {
        provideDefinition: async (_model: any, position: any) => {
          if (!this.activeDoc) return null;
          try {
            const result = await this.sendRequest('textDocument/definition', {
              textDocument: { uri: this.activeDoc.uri },
              position: { line: position.lineNumber - 1, character: position.column - 1 },
            }, 10000);
            if (!result) {
              console.log(`[LSP:${this.languageKey}] definition: server returned null/undefined`);
              return null;
            }
            const locations = Array.isArray(result) ? result : [result];
            console.log(`[LSP:${this.languageKey}] definition: received ${locations.length} location(s), first.uri=${locations[0]?.uri ?? locations[0]?.targetUri}, activeDoc.uri=${this.activeDoc.uri}`);

            // Map LSP locations → Monaco locations.
            // - Same-file: map file:// URI → current model's inmemory:// URI
            //   (fixes "No definition found" for same-file symbols)
            // - Cross-file: create Monaco model on demand so peek/navigate works
            const mapped = await this.mapLocationsToMonaco(locations, _model.uri);
            if (mapped.length === 0) {
              console.log(`[LSP:${this.languageKey}] definition: 0 mapped (from ${locations.length} LSP results)`);
              return null;
            }
            console.log(`[LSP:${this.languageKey}] definition: returning ${mapped.length} mapped location(s), first.uri=${mapped[0].uri?.toString()}`);
            return mapped;
          } catch (err) {
            console.error(`[LSP:${this.languageKey}] definition request failed:`, err);
            return null;
          }
        },
      }),
    );

    // References
    this.disposables.push(
      monaco.languages.registerReferenceProvider(languages, {
        provideReferences: async (_model: any, position: any) => {
          if (!this.activeDoc) return [];
          try {
            const result = await this.sendRequest('textDocument/references', {
              textDocument: { uri: this.activeDoc.uri },
              position: { line: position.lineNumber - 1, character: position.column - 1 },
              context: { includeDeclaration: true },
            });
            if (!result) return [];
            const locations = Array.isArray(result) ? result : [result];
            const mapped = await this.mapLocationsToMonaco(locations, _model.uri);
            return mapped;
          } catch (err) {
            console.error(`[LSP:${this.languageKey}] references request failed:`, err);
            return [];
          }
        },
      }),
    );

    // ── Override openCodeEditor for cross-file navigation ───────────────
    // Monaco standalone mode's ICodeEditorService.openCodeEditor is a no-op,
    // so built-in actions (context menu "Go to Definition", Ctrl+click, F12)
    // silently fail for cross-file targets. We override it to dispatch
    // lsp:openFile so EditorPanel can open the file.
    const codeEditorService = (editor as any)._codeEditorService;
    if (codeEditorService) {
      const originalOpen = codeEditorService.openCodeEditor.bind(codeEditorService);
      codeEditorService.openCodeEditor = async (input: any, source: any, sideBySide?: boolean) => {
        const result = await originalOpen(input, source, sideBySide);
        // If Monaco couldn't open the editor (standalone mode), handle cross-file
        if (result === null && input?.resource) {
          const uriStr = input.resource.toString();
          const filePath = uriToPath(uriStr);
          if (filePath && !(this.activeDoc && uriEquals(uriStr, this.activeDoc.uri))) {
            const sel = input.options?.selection;
            window.dispatchEvent(new CustomEvent('lsp:openFile', {
              detail: {
                filePath,
                line: sel?.startLineNumber ?? sel?.selectionStartLineNumber,
                column: sel?.startColumn ?? sel?.selectionStartColumn,
              },
            }));
            console.log(`[LSP:${this.languageKey}] openCodeEditor: dispatched lsp:openFile for ${filePath}`);
          } else if (filePath && this.activeDoc && uriEquals(uriStr, this.activeDoc.uri)) {
            // Same file but in a different model — navigate within current editor
            const sel = input.options?.selection;
            if (sel && source) {
              const targetRange = new monaco.Range(
                sel.startLineNumber, sel.startColumn,
                sel.endLineNumber ?? sel.startLineNumber, sel.endColumn ?? sel.startColumn,
              );
              source.revealRangeInCenterIfOutsideViewport(targetRange);
              source.setSelection(targetRange);
              source.focus();
            }
            return source;
          }
        }
        return result;
      };
    }

    // ── Ctrl+Left-click → Go to Definition ────────────────────────────
    // Enable standard IDE Ctrl+click go-to-definition. We trigger Monaco's
    // built-in "editor.action.revealDefinition" which calls provideDefinition
    // and then openCodeEditor (overridden above) for cross-file navigation.
    this.disposables.push(editor.onMouseDown((e: any) => {
      // Only trigger on Ctrl+left-click (not right-click, not middle-click)
      if (!e.event?.leftButton || !e.event?.ctrlKey) return;
      if (!this.activeDoc) return;
      const ed = this.editor;
      if (!ed) return;
      const pos = e.target?.position;
      if (!pos) return;
      // Prevent default to avoid text selection, then trigger the action
      e.event.preventDefault?.();
      e.event.stopPropagation?.();
      ed.trigger('lsp-ctrl-click', 'editor.action.revealDefinition', undefined);
    }));
  }

  /** Disable monaco's built-in TS/JS worker semantic features (keep syntax highlighting). */
  private disableBuiltinTSWorker(monaco: any): void {
    const modeConfig = {
      completionItems: false, diagnostics: false, documentFormattingEdits: false,
      documentSymbols: false, fileReferences: false, documentHighlights: false,
      definition: false, hover: false, references: false, implementation: false,
      signatureHelp: false, typeDefinition: false, codeActions: false,
      rename: false, inlayHints: false,
    };
    const diagOpts = { noSemanticValidation: true, noSyntaxValidation: true };
    try {
      monaco.languages.typescript.typescriptDefaults.setModeConfiguration(modeConfig);
      monaco.languages.typescript.javascriptDefaults.setModeConfiguration(modeConfig);
      monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions(diagOpts);
      monaco.languages.typescript.javascriptDefaults.setDiagnosticsOptions(diagOpts);
    } catch (err) {
      console.warn('[LSP] Failed to disable built-in TS worker:', err);
    }
  }

  /** Convert server diagnostics to monaco markers on the current model. */
  private handleDiagnostics(uri: string, diagnostics: any[]): void {
    if (!this.monaco || !this.editor) return;
    // Only apply diagnostics for the currently active document.
    // (typescript-language-server may also report for other files in the project,
    // but we can only show markers on the visible model.)
    if (!this.activeDoc || uri !== this.activeDoc.uri) return;

    const model = this.editor.getModel();
    if (!model || model.isDisposed?.()) return;

    const markers = diagnostics.map((d: any) => ({
      startLineNumber: d.range.start.line + 1,
      startColumn: d.range.start.character + 1,
      endLineNumber: d.range.end.line + 1,
      endColumn: d.range.end.character + 1,
      message: d.message,
      severity: mapSeverity(d.severity, this.monaco),
      source: d.source || 'ts',
    }));
    this.monaco.editor.setModelMarkers(model, 'lsp', markers);
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────

  /** Subscribe to server preparation progress (e.g. JDT.LS download). */
  onProgress(fn: (message: string, percent: number) => void): () => void {
    this.progressListeners.push(fn);
    return () => {
      this.progressListeners = this.progressListeners.filter(f => f !== fn);
    };
  }

  get isReady(): boolean {
    return this.ready;
  }

  whenReady(): Promise<void> {
    if (this.ready) return Promise.resolve();
    return new Promise(resolve => this.readyResolvers.push(resolve));
  }

  dispose(): void {
    this.disposables.forEach(d => { try { d.dispose(); } catch { /* ignore */ } });
    this.disposables = [];
    this.pending.clear();
    this.progressListeners = [];
    try { this.port.close(); } catch { /* ignore */ }
    this.activeDoc = null;
    this.ready = false;
  }
}
