/**
 * Unified adapter management.
 * Centralizes provider-specific adapter creation, lookup, and delegation.
 * Eliminates the repeated if/else provider-switch pattern across the codebase.
 */
import { MiMoAdapter, OpenAIAdapter, DeepSeekAdapter, QwenAiAdapter, DevecoAdapter, ZaiAdapter, ClineAdapter, FreebuffAdapter, LLMRouter } from '@xai/core';
import type { MigratableSnapshot } from '@xai/core';
import type { SessionConfig, ProxyConfig } from '@xai/shared';
import { getProxyUrl } from './proxy-manager.js';
import { ZaiCaptchaMinter } from './zai-captcha-minter.js';
import { devecoAuthService } from './deveco-auth.js';
import { clineAuthService } from './cline-auth.js';
import { freebuffAuthService } from './freebuff-auth.js';

type AnyAdapter = MiMoAdapter | OpenAIAdapter | DeepSeekAdapter | QwenAiAdapter | DevecoAdapter | ZaiAdapter | ClineAdapter | FreebuffAdapter;

export class AdapterManager {
  private adapters = new Map<string, AnyAdapter>();
  private llmRouter: LLMRouter | null = null;
  private zaiCaptchaMinter: ZaiCaptchaMinter | null = null;

  /** Create / recreate only the adapter for the given provider and register it on the router. */
  async createAdapterForProvider(provider: string, sessionConfig: SessionConfig, llmRouter: LLMRouter): Promise<void> {
    this.llmRouter = llmRouter;
    const cookies = sessionConfig.llm.cookies || '';
    const proxyUrl = getProxyUrl(sessionConfig.proxy);

    switch (provider) {
      case 'mimo': {
        const adapter = new MiMoAdapter({ cookies, botId: sessionConfig.llm.botId });
        this.adapters.set('mimo', adapter);
        llmRouter.registerAdapter('mimo', adapter);
        break;
      }
      case 'openai': {
        const adapter = new OpenAIAdapter();
        this.adapters.set('openai', adapter);
        llmRouter.registerAdapter('openai', adapter);
        break;
      }
      case 'deepseek': {
        const adapter = new DeepSeekAdapter({
          token: sessionConfig.llm.deepseekToken,
        });
        this.adapters.set('deepseek', adapter);
        llmRouter.registerAdapter('deepseek', adapter);
        break;
      }
      case 'qwenai': {
        const adapter = new QwenAiAdapter({
          token: sessionConfig.llm.qwenaiToken,
          cookies: sessionConfig.llm.qwenaiCookies,
        });
        this.adapters.set('qwenai', adapter);
        llmRouter.registerAdapter('qwenai', adapter);
        break;
      }
      case 'deveco': {
        const adapter = new DevecoAdapter({
          baseUrl: sessionConfig.llm.baseUrl,
          getToken: () => devecoAuthService.getAccessToken(),
        });
        this.adapters.set('deveco', adapter);
        llmRouter.registerAdapter('deveco', adapter);
        break;
      }
      case 'zai': {
        // Lazily create the captcha minter (no credentials needed — harness approach)
        if (!this.zaiCaptchaMinter) {
          this.zaiCaptchaMinter = new ZaiCaptchaMinter();
        }
        const minter = this.zaiCaptchaMinter;
        const adapter = new ZaiAdapter({
          token: sessionConfig.llm.zaiToken,
          cookies: sessionConfig.llm.zaiCookies,
          captchaParam: sessionConfig.llm.zaiCaptchaParam,
          region: sessionConfig.llm.zaiRegion,
          captchaMinter: async () => {
            await minter.start();
            return minter.mint();
          },
        });
        this.adapters.set('zai', adapter);
        llmRouter.registerAdapter('zai', adapter);
        break;
      }
      case 'cline': {
        const adapter = new ClineAdapter({
          getToken: () => clineAuthService.getAccessToken(),
        });
        this.adapters.set('cline', adapter);
        llmRouter.registerAdapter('cline', adapter);
        break;
      }
      case 'freebuff': {
        // Freebuff uses a built-in base URL (www.codebuff.com). Do NOT pass
        // sessionConfig.llm.baseUrl — it may contain a stale value from an older
        // config (e.g. codebuff.com) which 307-redirects and strips Authorization.
        const adapter = new FreebuffAdapter({
          getToken: () => freebuffAuthService.getAccessToken(),
          getInstanceId: () => Promise.resolve(freebuffAuthService.getInstanceId()),
          handleSessionExpired: (model?: string) => freebuffAuthService.handleSessionExpired(model),
        });
        this.adapters.set('freebuff', adapter);
        llmRouter.registerAdapter('freebuff', adapter);
        break;
      }
    }
  }

  /** Get the adapter for the given provider name */
  get(provider: string): AnyAdapter | undefined {
    return this.adapters.get(provider);
  }

  /** Get the adapter for the currently configured provider */
  getCurrent(sessionConfig: SessionConfig): AnyAdapter | undefined {
    const provider = sessionConfig.llm.provider || 'mimo';
    return this.adapters.get(provider);
  }

  /** Reset the session for the current provider's adapter */
  resetCurrent(sessionConfig: SessionConfig): void {
    const adapter = this.getCurrent(sessionConfig);
    if (adapter && 'resetSession' in adapter) {
      (adapter as any).resetSession();
    }
  }

  /** Delete the current conversation and reset session */
  async deleteConversation(sessionConfig: SessionConfig): Promise<boolean> {
    const adapter = this.getCurrent(sessionConfig);
    if (!adapter) return false;
    if ('deleteConversation' in adapter) {
      const success = await (adapter as any).deleteConversation();
      if (success && 'resetSession' in adapter) {
        (adapter as any).resetSession();
      }
      return success;
    }
    return false;
  }

  /** Delete a conversation by ID */
  async deleteConversationById(sessionConfig: SessionConfig, conversationId: string): Promise<boolean> {
    const adapter = this.getCurrent(sessionConfig);
    if (!adapter) return false;
    if ('deleteConversationById' in adapter) {
      return await (adapter as any).deleteConversationById(conversationId);
    }
    return false;
  }

  /** Get conversation list */
  async getConversationList(sessionConfig: SessionConfig, page?: number, pageSize?: number): Promise<any> {
    const adapter = this.getCurrent(sessionConfig);
    if (!adapter) return null;
    const provider = sessionConfig.llm.provider;
    if (provider === 'deepseek') {
      // DeepSeek uses cursor-based pagination via fetch_page API
      const cursor = typeof page === 'string' ? page : undefined;
      return await (adapter as any).getConversationList(cursor);
    }
    return await (adapter as any).getConversationList(page ?? 1, pageSize ?? 20);
  }

  /** Get dialog list for a conversation */
  async getDialogList(sessionConfig: SessionConfig, conversationId: string): Promise<any> {
    const adapter = this.getCurrent(sessionConfig);
    if (!adapter) return null;
    return await (adapter as any).getDialogList(conversationId);
  }

  /** Load a session by conversation ID */
  loadSession(sessionConfig: SessionConfig, conversationId: string): void {
    const adapter = this.getCurrent(sessionConfig);
    if (!adapter) return;
    if ('loadSession' in adapter) {
      (adapter as any).loadSession(conversationId);
    }
  }

  /** Generate a title from content using the current adapter */
  async genTitle(sessionConfig: SessionConfig, content: string): Promise<string | null> {
    const adapter = this.getCurrent(sessionConfig);
    if (!adapter) return null;
    if ('genTitle' in adapter) {
      try {
        return await (adapter as any).genTitle(content);
      } catch {
        return null;
      }
    }
    return null;
  }

  /** Save conversation (mimo-specific) */
  async saveConversation(sessionConfig: SessionConfig, title?: string): Promise<void> {
    const provider = sessionConfig.llm.provider;
    if (provider === 'mimo') {
      const adapter = this.adapters.get('mimo');
      if (adapter && 'saveConversation' in adapter) {
        try {
          await (adapter as MiMoAdapter).saveConversation(title);
        } catch {}
      }
    }
  }

  /** Get the LLMRouter */
  getLLMRouter(): LLMRouter | null {
    return this.llmRouter;
  }

  /** Set the LLMRouter */
  setLLMRouter(router: LLMRouter | null): void {
    this.llmRouter = router;
  }

  /** Clear all adapters (used when re-initializing) */
  clear(): void {
    this.adapters.clear();
    this.llmRouter = null;
    this.zaiCaptchaMinter?.stop().catch(() => {});
    this.zaiCaptchaMinter = null;
  }

  // ── Cross-adapter context migration ────────────────────────────────────────

  /** Providers that support cross-adapter context migration (OpenAI-compatible format). */
  private static readonly MIGRATABLE_PROVIDERS = new Set(['openai', 'deveco', 'cline', 'freebuff']);

  /** Check whether context can be migrated between two providers. */
  canMigrateContext(from: string, to: string): boolean {
    return AdapterManager.MIGRATABLE_PROVIDERS.has(from) && AdapterManager.MIGRATABLE_PROVIDERS.has(to);
  }

  /** Export the current session snapshot from the given provider's adapter. */
  exportContext(provider: string): MigratableSnapshot | null {
    const adapter = this.adapters.get(provider);
    if (adapter && typeof (adapter as any).exportSnapshot === 'function') {
      try {
        return (adapter as { exportSnapshot: () => MigratableSnapshot }).exportSnapshot();
      } catch (err) {
        console.error(`[AdapterManager] exportContext failed for ${provider}:`, err);
        return null;
      }
    }
    return null;
  }

  /** Import a session snapshot into the given provider's adapter. */
  importContext(provider: string, snapshot: MigratableSnapshot): boolean {
    const adapter = this.adapters.get(provider);
    if (adapter && typeof (adapter as any).importSnapshot === 'function') {
      try {
        (adapter as { importSnapshot: (s: MigratableSnapshot) => void }).importSnapshot(snapshot);
        console.log(`[AdapterManager] Imported ${snapshot.history.length} messages into ${provider} adapter`);
        return true;
      } catch (err) {
        console.error(`[AdapterManager] importContext failed for ${provider}:`, err);
        return false;
      }
    }
    return false;
  }
}
