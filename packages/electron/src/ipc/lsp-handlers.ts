/**
 * LSP IPC handlers — bridges renderer requests to LSPServerManager.
 *
 * Channels:
 *   lsp:connect  (send)  → main spawns server for given language, transfers MessagePort back via 'lsp:port'
 *   lsp:stop     (invoke)→ main stops server for given language
 *   lsp:restart  (send)  → main restarts server for given language, transfers new MessagePort back via 'lsp:port'
 *
 * The renderer sends the language key ('typescript' | 'java') as the first
 * argument; the main process looks up the corresponding descriptor and spawns
 * the server. Each language gets its own LSPServerManager instance so they
 * can run in parallel (TS and Java at the same time).
 */
import { ipcMain } from 'electron';
import { LSPServerManager, registerLanguageServer } from '../lsp/server-manager.js';
import { typescriptDescriptor } from '../lsp/descriptors/typescript-descriptor.js';
import { javaDescriptor } from '../lsp/descriptors/java-descriptor.js';

// Register all built-in language servers at module load time.
registerLanguageServer(typescriptDescriptor);
registerLanguageServer(javaDescriptor);

/** One manager per language — allows TS and Java to run concurrently. */
const managers = new Map<string, LSPServerManager>();

function getManager(language: string): LSPServerManager {
  let m = managers.get(language);
  if (!m) {
    m = new LSPServerManager();
    managers.set(language, m);
  }
  return m;
}

export function registerLSPHandlers(): void {
  // Renderer requests a new LSP connection for a specific language.
  // Args: (language: string, workspaceRoot: string)
  ipcMain.on('lsp:connect', async (event, language: string, workspaceRoot: string) => {
    try {
      const manager = getManager(language);
      const portForRenderer = await manager.start({ workspaceRoot, language });
      // Pass descriptor-provided initOptions (e.g. tsserver.path) to the
      // renderer so it can include them in the LSP initialize request.
      event.sender.postMessage(
        'lsp:port',
        { ok: true, language, initOptions: manager.getInitOptions() ?? undefined },
        [portForRenderer],
      );
    } catch (err) {
      event.sender.postMessage('lsp:port', {
        ok: false,
        language,
        error: (err as Error).message,
      });
    }
  });

  // Renderer requests server restart (e.g. workspace changed).
  ipcMain.on('lsp:restart', async (event, language: string, workspaceRoot: string) => {
    try {
      const manager = getManager(language);
      const portForRenderer = await manager.restart({ workspaceRoot, language });
      event.sender.postMessage(
        'lsp:port',
        { ok: true, restarted: true, language, initOptions: manager.getInitOptions() ?? undefined },
        [portForRenderer],
      );
    } catch (err) {
      event.sender.postMessage('lsp:port', {
        ok: false,
        language,
        error: (err as Error).message,
      });
    }
  });

  // Renderer requests server stop for a specific language.
  // Args: (language?: string) — if omitted, stops all.
  ipcMain.handle('lsp:stop', async (_event, language?: string) => {
    try {
      if (language) {
        managers.get(language)?.stop();
      } else {
        for (const m of managers.values()) m.stop();
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });
}

/** Clean up all server managers — called on app quit. */
export function disposeLSP(): void {
  for (const m of managers.values()) m.dispose();
  managers.clear();
}
