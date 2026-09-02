/**
 * useLSP — React hook that encapsulates LSP client lifecycle for multiple
 * language servers.
 *
 * The renderer may need TS and Java LSP servers running concurrently. Each
 * language gets its own LSPClient instance, connected to a separate server
 * process in the main process.
 *
 * The hook handles:
 *   - Per-language server startup on demand (lazy: only connects when a file
 *     of that language is opened)
 *   - Timing races (editor mounts before/after client is ready)
 *   - Workspace changes (reconnects all active servers)
 *   - Progress events from the main process (e.g. JDT.LS download)
 */
import { useEffect, useRef, useCallback, useState } from 'react';
import { LSPClient, type PortLike, type ReadFileCallback } from '../lsp/lsp-client';
import { useIpc } from './useIpc';

// ── Helpers ────────────────────────────────────────────────────────────────

/** Map a file path to an LSP languageId ('typescript' | 'javascript' | 'java' | ''). */
function getLanguageIdForLSP(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  if (ext === 'ts') return 'typescript';
  if (ext === 'tsx') return 'typescriptreact';
  if (ext === 'js' || ext === 'mjs' || ext === 'cjs') return 'javascript';
  if (ext === 'jsx') return 'javascriptreact';
  if (ext === 'java') return 'java';
  return '';
}

/** Map a languageId to the language key used in IPC ('typescript' | 'java'). */
function getLanguageKey(languageId: string): string {
  if (languageId === 'typescript' || languageId === 'typescriptreact' ||
      languageId === 'javascript' || languageId === 'javascriptreact') {
    return 'typescript';
  }
  if (languageId === 'java') return 'java';
  return '';
}

// ── Types ──────────────────────────────────────────────────────────────────

export interface LSPProgressEvent {
  language: string;
  message: string;
  percent: number;
}

export interface LSPHandle {
  /** Call from Monaco's onMount — stores refs and registers providers.
   *  Note: in multi-language mode, providers are registered on ALL supported
   *  languages at once, so this can be called once per editor mount. */
  onEditorMount: (monaco: any, editor: any) => void;
  /** Call when the active file changes — opens/closes documents as needed. */
  onActiveFileChange: (filePath: string, content: string) => void;
  /** Call when user edits content — sends didChange to the right server. */
  onContentChange: (content: string) => void;
  /** Call when switching to a non-code file — closes any active document. */
  onCloseDocument: () => void;
}

// ── Hook ───────────────────────────────────────────────────────────────────

export function useLSP(workspace: string, onProgress?: (e: LSPProgressEvent) => void): LSPHandle {
  // Per-language client instances.
  const clientsRef = useRef<Map<string, LSPClient>>(new Map());
  const monacoRef = useRef<any>(null);
  const editorRef = useRef<any>(null);
  // The currently active document's language key — determines which client
  // receives content changes.
  const activeLanguageRef = useRef<string>('');
  // The latest active document, so we can (re)send didOpen when a client
  // finishes initializing.
  const activeDocRef = useRef<{ path: string; content: string; languageId: string } | null>(null);
  const ipc = useIpc();
  const [progress, setProgress] = useState<LSPProgressEvent | null>(null);

  // readFile callback — reads file content from disk via IPC.
  // Passed to LSPClient so it can create Monaco models on demand for
  // cross-file definition/reference navigation.
  const readFileRef = useRef<ReadFileCallback>(async (filePath: string) => {
    try {
      const result = await ipc.invoke('file:read', filePath) as { success: boolean; content?: string };
      return result.success ? (result.content ?? '') : null;
    } catch {
      return null;
    }
  });

  // Expose progress via callback (separate effect so callback identity
  // changes don't cause reconnection).
  useEffect(() => {
    if (progress && onProgress) onProgress(progress);
  }, [progress, onProgress]);

  // ── Connect to a language server on demand ──────────────────────────

  // Track languages currently being connected (to avoid duplicate requests).
  const connectingRef = useRef<Set<string>>(new Set());

  // Track pending resolvers for each connecting language — used by the
  // global onPort listener to route the port to the right language.
  // The resolver receives both the MessagePort and any descriptor-provided
  // initOptions (e.g. tsserver.path) that the main process forwards.
  const pendingResolversRef = useRef<Map<string, { resolve: (port: PortLike, initOptions?: Record<string, unknown>) => void; reject: (err: Error) => void }>>(new Map());

  // Global onPort listener — registered once, routes ports by language.
  // Using one listener avoids the leak of per-connectLanguage listeners.
  useEffect(() => {
    const onPort = (...args: unknown[]) => {
      const port = args[0] as PortLike;
      const payload = args[1] as { ok?: boolean; language?: string; error?: string; restarted?: boolean; initOptions?: Record<string, unknown> } | undefined;
      const language = payload?.language ?? '';
      const resolvers = pendingResolversRef.current.get(language);
      if (!resolvers) {
        // No pending request for this language — close the port.
        try { port.close(); } catch { /* ignore */ }
        return;
      }
      pendingResolversRef.current.delete(language);

      if (payload && payload.ok === false) {
        resolvers.reject(new Error(payload.error || 'Unknown LSP connection error'));
        return;
      }
      // Forward both port and descriptor initOptions to the pending resolver.
      resolvers.resolve(port, payload?.initOptions);
    };

    ipc.onPort('lsp:port', onPort);
    return () => {
      ipc.removeListener('lsp:port', onPort);
    };
  }, [ipc]);

  const connectLanguage = useCallback((language: string) => {
    if (!workspace || !language) return;
    if (clientsRef.current.has(language) || connectingRef.current.has(language)) return;

    connectingRef.current.add(language);

    // Wait for the port + initOptions from the main process.
    const connectPromise = new Promise<{ port: PortLike; initOptions?: Record<string, unknown> }>((resolve, reject) => {
      pendingResolversRef.current.set(language, {
        resolve: (port, initOptions) => resolve({ port, initOptions }),
        reject,
      });
      ipc.send('lsp:connect', language, workspace);
    });

    connectPromise.then(({ port, initOptions }) => {
      const client = new LSPClient(port, language, initOptions, readFileRef.current);

      // Subscribe to progress events (e.g. JDT.LS download)
      client.onProgress((message, percent) => {
        setProgress({ language, message, percent });
      });

      return client.initialize(workspace).then(() => {
        clientsRef.current.set(language, client);
        connectingRef.current.delete(language);

        // If the editor already mounted, register providers now.
        if (monacoRef.current && editorRef.current) {
          client.registerMonaco(monacoRef.current, editorRef.current);
        }
        // If this language is currently active, send didOpen.
        if (activeDocRef.current && getLanguageKey(activeDocRef.current.languageId) === language) {
          client.setActiveDocument(
            activeDocRef.current.path,
            activeDocRef.current.languageId,
            activeDocRef.current.content,
          );
        }
        console.log(`[LSP:${language}] Client ready for workspace:`, workspace);
      });
    }).catch((err) => {
      console.error(`[LSP:${language}] Connection/initialize failed:`, err);
      connectingRef.current.delete(language);
      // Surface the error as a progress event so the UI can show it.
      setProgress({ language, message: `LSP 连接失败: ${err.message}`, percent: -1 });
    });
  }, [workspace, ipc]);

  // ── Reconnect when workspace changes ────────────────────────────────

  useEffect(() => {
    if (!workspace) return;

    // On workspace change, disconnect all existing clients and reset state.
    // New connections will be established lazily when files are opened.
    return () => {
      for (const client of clientsRef.current.values()) {
        try { client.dispose(); } catch { /* ignore */ }
      }
      clientsRef.current.clear();
      connectingRef.current.clear();
    };
  }, [workspace]);

  // ── Stable callbacks ────────────────────────────────────────────────

  const onEditorMount = useCallback((monaco: any, editor: any) => {
    monacoRef.current = monaco;
    editorRef.current = editor;
    // Register providers on all already-ready clients.
    for (const client of clientsRef.current.values()) {
      if (client.isReady) {
        client.registerMonaco(monaco, editor);
      }
    }
  }, []);

  const onActiveFileChange = useCallback((filePath: string, content: string) => {
    const languageId = getLanguageIdForLSP(filePath);
    const languageKey = getLanguageKey(languageId);

    // If switching to a different language, close the previous active doc.
    if (activeLanguageRef.current && activeLanguageRef.current !== languageKey) {
      const prevClient = clientsRef.current.get(activeLanguageRef.current);
      if (prevClient) {
        prevClient.closeActiveDocument();
      }
    }

    activeLanguageRef.current = languageKey;
    activeDocRef.current = { path: filePath, content, languageId };

    if (!languageKey) {
      // Non-code file — no LSP action.
      return;
    }

    // Ensure the server for this language is connected (lazy connect).
    if (!clientsRef.current.has(languageKey) && !connectingRef.current.has(languageKey)) {
      connectLanguage(languageKey);
    }

    const client = clientsRef.current.get(languageKey);
    if (client && client.isReady) {
      client.setActiveDocument(filePath, languageId, content);
    }
    // If client is not ready yet, didOpen will be sent when it becomes ready
    // (see the onPort callback above).
  }, [connectLanguage]);

  const onContentChange = useCallback((content: string) => {
    if (activeDocRef.current) {
      activeDocRef.current.content = content;
    }
    const languageKey = activeLanguageRef.current;
    if (!languageKey) return;
    const client = clientsRef.current.get(languageKey);
    if (client && client.isReady) {
      client.onContentChange(content);
    }
  }, []);

  const onCloseDocument = useCallback(() => {
    const languageKey = activeLanguageRef.current;
    activeDocRef.current = null;
    activeLanguageRef.current = '';
    if (languageKey) {
      const client = clientsRef.current.get(languageKey);
      if (client) client.closeActiveDocument();
    }
  }, []);

  return { onEditorMount, onActiveFileChange, onContentChange, onCloseDocument };
}
