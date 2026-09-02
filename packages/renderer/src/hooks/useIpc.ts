import { useMemo } from 'react';
import type { PortLike } from '../lsp/lsp-client';

interface ElectronAPI {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
  send: (channel: string, ...args: unknown[]) => void;
  on: (channel: string, callback: (...args: unknown[]) => void) => void;
  onPort: (channel: string, callback: (port: PortLike, ...args: unknown[]) => void) => void;
  removeListener: (channel: string, callback: (...args: unknown[]) => void) => void;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}

const noop = () => {};
const noopPromise = async () => undefined;

function getAPI(): ElectronAPI | null {
  if (typeof window !== 'undefined' && window.electronAPI) {
    return window.electronAPI;
  }
  return null;
}

const stableInvoke = (channel: string, ...args: unknown[]): Promise<unknown> => {
  const api = getAPI();
  if (api) return api.invoke(channel, ...args);
  return noopPromise();
};

const stableSend = (channel: string, ...args: unknown[]): void => {
  const api = getAPI();
  if (api) api.send(channel, ...args);
};

const stableOn = (channel: string, callback: (...args: unknown[]) => void): void => {
  const api = getAPI();
  if (api) api.on(channel, callback);
};

const stableOnPort = (channel: string, callback: (port: PortLike, ...args: unknown[]) => void): void => {
  const api = getAPI();
  if (api) api.onPort(channel, callback);
};

const stableRemoveListener = (channel: string, callback: (...args: unknown[]) => void): void => {
  const api = getAPI();
  if (api) api.removeListener(channel, callback);
};

/**
 * Stable IPC API — the returned object is memoized with an empty dependency
 * array so it never changes identity across renders. This is critical:
 * useEffect hooks in useLSP (and elsewhere) depend on this object, and an
 * unstable reference would cause them to re-run on every render, leaking
 * ipcRenderer listeners (the "MaxListenersExceededWarning: 11 lsp:port
 * listeners" error).
 */
export function useIpc() {
  return useMemo(() => ({
    invoke: stableInvoke,
    send: stableSend,
    on: stableOn,
    onPort: stableOnPort,
    removeListener: stableRemoveListener,
  }), []);
}
