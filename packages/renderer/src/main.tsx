import React from 'react';
import ReactDOM from 'react-dom/client';
import { loader } from '@monaco-editor/react';
import App from './App';
import './styles/global.css';

// Configure Monaco to load from local monaco-editor package instead of CDN.
// Without this, @monaco-editor/react tries to fetch from cdn.jsdelivr.net
// which fails in Electron (ERR_CONNECTION_RESET).
import * as monaco from 'monaco-editor';
// Vite's ?worker suffix bundles the file as a Web Worker constructor.
//
// We provide the TS worker for TypeScript/JavaScript languages and the base
// editor worker for everything else. Even though we disable Monaco's built-in
// TS semantic features via setModeConfiguration (in lsp-client.ts), Monaco's
// internal IInlayHintsService may still send provideInlayHints requests to
// the worker. The TS worker has a handler for this (returns empty when
// inlayHints is disabled), while the base editor.worker does not — causing
// "Missing requestHandler or method: provideInlayHints" errors.
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';

(self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
  getWorker(_, label) {
    if (label === 'typescript' || label === 'typescriptreact' ||
        label === 'javascript' || label === 'javascriptreact') {
      return new tsWorker();
    }
    return new editorWorker();
  },
};

loader.config({ monaco });

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
