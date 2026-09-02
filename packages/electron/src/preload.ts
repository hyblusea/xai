const { contextBridge, ipcRenderer } = require('electron');

const validChannels = [
  'agent:state-update',
  'agent:message',
  'agent:stream-chunk',
  'agent:stream-thinking',
  'agent:stream-reset',
  'agent:stream-tool-summary',
  'agent:tool-call',
  'agent:tool-call-start',
  'agent:tool-call-end',
  'agent:confirmation-request',
  'agent:confirmation-response',
  'agent:start',
  'agent:stop',
  'agent:get-state',
  'agent:error',
  'agent:completed',
  'agent:tool-names',
  'agent:context-update',
  'agent:compressing',
  'agent:compressed',
  'agent:compress-error',
  'session:compress',
  'command:execute',
  'command:result',
  'command:stop',
  'command:output',
  'terminal:session-opened',
  'terminal:session-data',
  'terminal:session-exited',
  'terminal:session-spawn',
  'terminal:session-send',
  'terminal:session-close',
  'terminal:session-resize',
  'terminal:session-get-buffer',
  'tool:executing',
  'tool:result',
  'file:read',
  'file:write',
  'file:list',
  'file:search',
  'config:get',
  'config:set',
  'config:reset',
  'workspace:open',
  'workspace:info',
  'window:minimize',
  'window:maximize',
  'window:close',
  'window:close-requested',
  'window:force-close',
  'window:fullscreen',
  'menu:new-session',
  'menu:open-settings',
  'menu:toggle-devtools',
  'menu:show-about',
  'menu:get-system-prompt',
  'session:new',
  'delete-conversation',
  'conversation:list',
  'conversation:load',
  'file:changed',
  'file:delete',
  'file:rename',
  'file:copy-path',
  'file:show-in-explorer',
  'file:create-file',
  'file:create-directory',
  'file:replace-in-file',
  'conversation:delete',
  'session:title',
  'workspace:changed',
  'llm:test-connection',
  'deveco:models',
  'openai:fetch-models',
  'openai:model-reasoning',
  'openai:model-context-info',
  'deveco:login',
  'deveco:login-progress',
  'deveco:logout',
  'deveco:auth-status',
  'cline:login',
  'cline:login-progress',
  'cline:logout',
  'cline:auth-status',
  'cline:models',
  'cline:model-reasoning',
  'cline:model-context-info',
  'freebuff:login',
  'freebuff:login-progress',
  'freebuff:logout',
  'freebuff:auth-status',
  'freebuff:models',
  'freebuff:model-reasoning',
  'freebuff:model-context-info',
  'freebuff:session-start',
  'freebuff:session-status',
  'freebuff:session-end',
  'mcp:list',
  'mcp:add',
  'mcp:update',
  'mcp:remove',
  'mcp:server-status',
  'config:changed',
  'mqtt:pairing-status',
  'mqtt:get-status',
  'mqtt:generate-pair-code',
  'mqtt:invalidate-pair-code',
  'mqtt:connect',
  'mqtt:disconnect',
  'mqtt:update-config',
  'git:status',
  'git:diff',
  'git:file-diff',
  'git:stage',
  'git:unstage',
  'git:stage-all',
  'git:unstage-all',
  'git:commit',
  'git:push',
  'git:pull',
  'git:fetch',
  'git:log',
  'git:branches',
  'git:checkout',
  'git:create-branch',
  'git:discard',
  'git:discard-all',
  'git:remote-url',
  'git:init',
  'git:delete-branch',
  'git:merge-branch',
  'git:stash',
  'git:stash-list',
  'git:stash-pop',
  'git:stash-apply',
  'git:stash-drop',
  'git:commit-detail',
  'git:commit-file-diff',
  'git:add-remote',
  'git:set-remote-url',
  'git:remotes',
  'update:check-result',
  'update:download-progress',
  'update:downloaded',
  'update:error',
  'update:check',
  'update:install',
  'update:config-changed',
  'db:load-config',
  'db:save-config',
  'db:list-schemas',
  'db:list-tables',
  'db:table-structure',
  'db:table-ddl',
  'db:generate-sql',
  'db:execute-sql',
  'db:cancel-sql',
  'db:export',
  'db:import',
  'web:search-test',
  'web:search-test-result',
  'web:fetch-request',
  'web:fetch-result',
  'web:fetch-progress',
  'web:captcha-detected',
  'web:captcha-resolved',
  'shell:open-external',
  'browser:create-session',
  'browser:register-webview',
  'browser:navigate',
  'browser:go-back',
  'browser:go-forward',
  'browser:reload',
  'browser:close',
  'browser:mouse-click',
  'browser:api-request',
  'browser:type',
  'browser:screenshot',
  'browser:evaluate',
  'browser:extract',
  'browser:cdp-command',
  'browser:wait',
  'browser:query',
  'browser:storage',
  'browser:network',
  'browser:press-key',
  'browser:hover',
  'browser:scroll',
  'browser:select',
  'browser:drag',
  'browser:console',
  'browser:dialog',
  'browser:file',
  'browser:title-update',
  'browser:url-update',
  'browser:loading-state',
  'ocr:test-connection',
  'ocr:test-image',
  'ocr:recognize-image',
  'office2md:convert',
  // Designer
  'designer:generate',
  'designer:stream-chunk',
  'designer:stream-message',
  'designer:stream-thinking',
  'designer:stream-done',
  'designer:stream-error',
  'designer:abort',
  'designer:save-html',
  'designer:list-projects',
  'designer:create-project',
  'designer:delete-project',
  'designer:load-project',
  'designer:load-screen',
  'designer:rename-project',
  'designer:update-project-theme',
  'designer:delete-screen',
  'designer:rename-screen',
  'designer:duplicate-screen',
  'designer:select-path',
  'designer:show-in-explorer',
  'designer:move-screen',
  'designer:create-folder',
  'designer:delete-folder',
  'designer:rename-folder',
  'designer:export-vue',
  'designer:export-dialog',
  'designer:export-multi-html',
  'designer:export-progress',
  'designer:list-dirs',
  'designer:create-dir',
  // Auth
  'auth:login',
  'auth:register',
  'auth:refresh',
  'auth:logout',
  'auth:get-current',
  'auth:change-password',
  'auth:update-profile',
  'auth:restore-session',
  'auth:get-remembered-credentials',
  'auth:forgot-password',
  'auth:reset-password',
  // Designer team / permission
  'designer:list-members',
  'designer:add-member',
  'designer:update-member-role',
  'designer:remove-member',
  'designer:search-users',
  'designer:list-folder-permissions',
  'designer:grant-folder-permission',
  'designer:revoke-folder-permission',
  'designer:load-tree',
  'designer:check-write-permission',
  'designer:list-writable-folders',
  'designer:set-home-screen',
  'designer:reorder-screen',
  // Designer publication
  'designer:create-publication',
  'designer:list-publications',
  'designer:delete-publication',
  'designer:refresh-publication',
  // Designer screen history
  'designer:list-screen-history',
  'designer:get-screen-history-content',
  'designer:restore-screen-history',
  // Designer master layout (共享母版 / 菜单注入)
  'designer:save-master-layout',
  'designer:delete-master-layout',
  'designer:inject-master-layout-all',
  'designer:master-layout-progress',
  // LSP (Language Server Protocol)
  'lsp:connect',
  'lsp:restart',
  'lsp:stop',
  'lsp:port',
  // Local conversation persistence (OpenAI / DevEco / Cline)
  'local-conversation:save',
  'local-conversation:list',
  'local-conversation:load',
  'local-conversation:delete',
  'local-conversation:request-save',
];

function isValidChannel(channel: string) {
  const valid = validChannels.includes(channel);
  if (!valid) {
    console.warn(`[preload] IPC channel "${channel}" is not in validChannels whitelist — call will be ignored. If this is intentional, add it to the list.`);
  }
  return valid;
}

/**
 * Listener tracking — maps the user-supplied callback (by reference) to its
 * wrapped listener and channel. Using a Map keyed by the callback reference
 * avoids the old `_ipcListenerId` property-override bug: previously, if the
 * same callback was registered on multiple channels (or re-registered after
 * an effect cleanup), the new id overwrote the old one and the old wrapped
 * listener was leaked forever on ipcRenderer. With a Map, each (callback)
 * key maps to exactly one entry, and remove always finds the right one.
 */
type ListenerEntry = { channel: string; wrappedListener: (...args: unknown[]) => void };
const listenerMap = new Map<(...args: unknown[]) => void, ListenerEntry>();

const api = {
  invoke: (channel: string, ...args: unknown[]) => {
    if (isValidChannel(channel)) {
      return ipcRenderer.invoke(channel, ...args);
    }
    return Promise.reject(new Error('Invalid IPC channel: ' + channel));
  },

  send: (channel: string, ...args: unknown[]) => {
    if (isValidChannel(channel)) {
      ipcRenderer.send(channel, ...args);
    }
  },

  on: (channel: string, callback: (...args: unknown[]) => void) => {
    if (!isValidChannel(channel)) return;
    // If this callback was previously registered (e.g. on another channel or
    // due to a missed cleanup), remove the old wrapped listener first so we
    // never accumulate duplicate ipcRenderer listeners for the same callback.
    const prev = listenerMap.get(callback);
    if (prev) {
      try { ipcRenderer.removeListener(prev.channel, prev.wrappedListener); } catch { /* ignore */ }
    }
    const wrappedListener = (_event: unknown, ...args: unknown[]) => callback(...args);
    listenerMap.set(callback, { channel, wrappedListener });
    ipcRenderer.on(channel, wrappedListener);
  },

  /** Like `on`, but also passes a port wrapper for the first transferred
   *  MessagePort to the callback.
   *
   *  IMPORTANT: The raw MessagePort from `event.ports[0]` CANNOT be passed
   *  directly through the contextBridge boundary — it is a transferable
   *  object, not a structured-cloneable one, so it arrives in the renderer
   *  as a broken object with no methods (no `start`, `postMessage`, `close`).
   *
   *  Instead, we keep the real port in the preload's isolated context and
   *  create a plain-object wrapper whose function properties are safely
   *  proxied by contextBridge. The wrapper exposes:
   *    - postMessage(data)   → forwards to realPort.postMessage
   *    - close()             → forwards to realPort.close
   *    - start()             → forwards to realPort.start
   *    - onMessage(handler)  → sets realPort.onmessage internally
   */
  onPort: (channel: string, callback: (portWrapper: any, ...args: unknown[]) => void) => {
    if (!isValidChannel(channel)) return;
    // Same dedup-by-callback-reference as `on` above.
    const prev = listenerMap.get(callback);
    if (prev) {
      try { ipcRenderer.removeListener(prev.channel, prev.wrappedListener); } catch { /* ignore */ }
    }
    const wrappedListener = (_event: unknown, ...args: unknown[]) => {
      const event = _event as Electron.IpcRendererEvent;
      const realPort = event.ports[0];
      if (realPort) {
        const portWrapper = {
          postMessage: (data: unknown) => {
            try { realPort.postMessage(data); } catch { /* port closed */ }
          },
          close: () => {
            try { realPort.close(); } catch { /* ignore */ }
          },
          start: () => {
            try { realPort.start(); } catch { /* auto-started by onmessage */ }
          },
          onMessage: (handler: ((data: unknown) => void) | null) => {
            realPort.onmessage = handler
              ? (e: MessageEvent) => handler(e.data)
              : null;
          },
        };
        callback(portWrapper, ...args);
      }
    };
    listenerMap.set(callback, { channel, wrappedListener });
    ipcRenderer.on(channel, wrappedListener);
  },

  removeListener: (channel: string, callback: (...args: unknown[]) => void) => {
    if (!isValidChannel(channel)) return;
    const entry = listenerMap.get(callback);
    if (entry) {
      try { ipcRenderer.removeListener(entry.channel, entry.wrappedListener); } catch { /* ignore */ }
      listenerMap.delete(callback);
    }
  },
};

contextBridge.exposeInMainWorld('electronAPI', api);
