/**
 * TypeScript language server descriptor.
 *
 * Spawns typescript-language-server using the Electron binary as a pure Node
 * runtime (ELECTRON_RUN_AS_NODE=1), so it works in packaged apps without a
 * system Node.js installation.
 *
 * Note: typescript-language-server v5.x removed the `--tsserver-path` CLI flag.
 * The tsserver path must be passed via `initializationOptions.tsserver.path`
 * in the LSP initialize request (see lsp-client.ts).
 */
import { createRequire } from 'module';
import type { LanguageServerDescriptor, PreparedServer } from '../descriptor.js';

const esmRequire = createRequire(import.meta.url);

function resolveServerPath(): string {
  try {
    return esmRequire.resolve('typescript-language-server/lib/cli.mjs');
  } catch {
    throw new Error('[LSP:ts] Failed to resolve typescript-language-server. Is it installed?');
  }
}

/** Resolve the absolute path to tsserverlibrary.js — passed to the server
 *  via initializationOptions.tsserver.path at initialize time. */
export function resolveTsServerPath(): string {
  try {
    return esmRequire.resolve('typescript/lib/tsserverlibrary.js');
  } catch {
    throw new Error('[LSP:ts] Failed to resolve typescript/lib/tsserverlibrary.js.');
  }
}

export const typescriptDescriptor: LanguageServerDescriptor = {
  language: 'typescript',

  async prepare(): Promise<PreparedServer> {
    const serverPath = resolveServerPath();
    const tsServerPath = resolveTsServerPath();

    // Use ELECTRON_RUN_AS_NODE so process.execPath (Electron binary) runs as
    // pure Node — no browser runtime overhead, and works in packaged apps
    // where a system `node` may not be available.
    return {
      command: process.execPath,
      args: [serverPath, '--stdio'],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      cwd: process.cwd(),
      // v5.x reads tsserver path from initializationOptions.tsserver.path,
      // NOT from a CLI flag (the old --tsserver-path flag was removed).
      initOptions: {
        tsserver: { path: tsServerPath },
        // Provide TS preferences so the server doesn't need a tsconfig.json
        // to begin offering completions (it will still pick up one if present).
        preferences: {
          allowIncompleteCompletions: true,
          displayPartsForJSDoc: true,
          generateReturnInDocumentationTemplate: true,
          includeAutomaticOptionalChainCompletions: true,
          includeCompletionsForImportStatements: true,
          includeCompletionsWithSnippetText: true,
          jsxAttributeCompletionStyle: 'auto',
        },
      },
    };
  },
};
