/**
 * Proxy configuration management.
 * Extracted from main.ts for modularity.
 */
import type { ProxyConfig } from '@xai/shared';

export function applyProxyConfig(proxy: ProxyConfig): void {
  const server = proxy.enabled && !proxy.useSystemProxy ? proxy.server?.trim() : '';
  if (server) {
    process.env.HTTP_PROXY = server;
    process.env.HTTPS_PROXY = server;
    process.env.http_proxy = server;
    process.env.https_proxy = server;
    // localhost 和 127.0.0.1 必须绕过代理（更新服务器等本地服务）
    process.env.NO_PROXY = 'localhost,127.0.0.1,::1';
    process.env.no_proxy = 'localhost,127.0.0.1,::1';
    console.log('[Main] Proxy enabled:', server, '| NO_PROXY: localhost,127.0.0.1');
  } else {
    delete process.env.HTTP_PROXY;
    delete process.env.HTTPS_PROXY;
    delete process.env.http_proxy;
    delete process.env.https_proxy;
    delete process.env.NO_PROXY;
    delete process.env.no_proxy;
    if (proxy.enabled && proxy.useSystemProxy) {
      console.log('[Main] System proxy mode - environment variables not set');
    } else {
      console.log('[Main] Proxy disabled');
    }
  }
}

export async function applyUndiciProxyDispatcher(proxy: ProxyConfig | null | undefined): Promise<void> {
  try {
    const { setGlobalDispatcher, Agent } = await import('undici');
    const server = proxy?.enabled && !proxy.useSystemProxy ? proxy.server?.trim() : '';
    if (server) {
      console.log('[Main] Setting undici proxy dispatcher (with localhost bypass):', server);
      try {
        const { EnvHttpProxyAgent } = await import('undici');
        const envAgent = new EnvHttpProxyAgent();
        setGlobalDispatcher(envAgent);
        console.log('[Main] Undici EnvHttpProxyAgent set (respects NO_PROXY)');
      } catch {
        const { ProxyAgent } = await import('undici');
        const proxyAgent = new ProxyAgent(server);
        setGlobalDispatcher(proxyAgent);
        console.warn('[Main] EnvHttpProxyAgent not available, using ProxyAgent (localhost may not bypass)');
      }
    } else {
      console.log('[Main] Resetting undici global dispatcher to default');
      setGlobalDispatcher(new Agent());
    }
  } catch (err) {
    console.error('[Main] Failed to set/reset undici global dispatcher:', err);
  }
}

export async function getProxyDispatcher(): Promise<any> {
  // Global dispatcher is managed by applyUndiciProxyDispatcher.
  // Return undefined since Node.js native fetch uses the global dispatcher.
  return undefined;
}

export function getProxyUrl(proxy: ProxyConfig | undefined): string | undefined {
  return proxy?.enabled && !proxy.useSystemProxy
    ? proxy.server?.trim() || undefined
    : undefined;
}
