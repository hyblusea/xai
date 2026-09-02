/**
 * LLM & conversation IPC handlers.
 */
import { ipcMain } from 'electron';
import { IPCChannel, type Message } from '@xai/shared';
import { cleanCookies, DevecoAdapter } from '@xai/core';
import { getProxyDispatcher } from '../proxy-manager.js';
import { devecoAuthService } from '../deveco-auth.js';
import { clineAuthService } from '../cline-auth.js';
import { freebuffAuthService } from '../freebuff-auth.js';
import type { IpcDeps } from './types.js';
import { LOCAL_PERSISTENCE_PROVIDERS, type CapturedConversationState } from '../agent/persist.js';

export function registerLLMHandlers(deps: IpcDeps): void {
  // OpenAI-compatible: fetch available models via GET {baseUrl}/v1/models
  ipcMain.handle(IPCChannel.FetchOpenaiModels, async (_event, params?: { baseUrl?: string; apiKey?: string }) => {
    try {
      // Use frontend-provided values (from the current settings UI) when available,
      // falling back to saved config. This ensures the request goes to the URL
      // the user is actually editing, not a stale provider's baseUrl.
      const baseUrl = params?.baseUrl || deps.sessionConfig.llm.baseUrl || 'https://api.openai.com/v1/chat/completions';
      const apiKey = params?.apiKey ?? deps.sessionConfig.llm.apiKey;
      const customHeaders = deps.sessionConfig.llm.customHeaders;
      // Derive /v1/models URL from the configured baseUrl
      let rawUrl = baseUrl.trim();
      // Strip trailing slashes
      rawUrl = rawUrl.replace(/\/+$/, '');
      // Remove /chat/completions, /completions, /embeddings suffix if present
      rawUrl = rawUrl.replace(/\/(chat\/)?(completions|embeddings)(\/.*)?$/i, '');
      // Ensure it ends with /v1/models
      if (!rawUrl.endsWith('/v1/models')) {
        rawUrl = rawUrl.replace(/\/v1\/?$/, '') + '/v1/models';
      }

      const headers: Record<string, string> = {
        Accept: 'application/json',
      };
      if (apiKey) {
        headers['Authorization'] = `Bearer ${apiKey}`;
      }
      if (customHeaders) {
        Object.assign(headers, customHeaders);
      }

      const dispatcher = await getProxyDispatcher();
      const fetchOptions: Record<string, unknown> = { headers };
      if (dispatcher) fetchOptions.dispatcher = dispatcher;

      const response = await fetch(rawUrl, fetchOptions);
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        return { success: false, error: `HTTP ${response.status}: ${body.substring(0, 300)}` };
      }

      const data = await response.json() as { data?: Array<{ id: string; object?: string; owned_by?: string }> };
      if (!Array.isArray(data.data)) {
        return { success: false, error: 'Invalid response format: missing "data" array' };
      }

      const models = data.data.map(m => ({ id: m.id, name: m.id, ownedBy: m.owned_by || '' }));
      return { success: true, models };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle(IPCChannel.OpenAIModelReasoning, async (_event, modelId: string) => {
    try {
      const result = await clineAuthService.checkModelReasoning(modelId);
      return { success: true, ...result };
    } catch (err) {
      return { success: false, supportsReasoning: false, supportedEfforts: [], defaultEffort: '', error: String(err) };
    }
  });

  ipcMain.handle(IPCChannel.OpenAIModelContextInfo, async (_event, modelId: string) => {
    try {
      const result = await clineAuthService.checkModelContextInfo(modelId);
      return { success: true, ...result };
    } catch (err) {
      return { success: false, contextWindow: 128_000, maxInputTokens: 115_000, maxOutputTokens: 4_096, error: String(err) };
    }
  });

  // DevEco: fetch available models from remote service
  ipcMain.handle(IPCChannel.DevEcoModels, async () => {
    const llmConfig = deps.sessionConfig.llm;
    if (llmConfig.provider !== 'deveco') {
      return { success: false, error: 'Current provider is not deveco' };
    }
    const accessToken = await devecoAuthService.getAccessToken();
    if (!accessToken) {
      return { success: false, error: 'Not logged in to DevEco. Please login first.' };
    }
    try {
      const adapter = new DevecoAdapter({
        accessToken,
        baseUrl: llmConfig.baseUrl,
      });
      const models = await adapter.fetchModels();
      if (!models) {
        return { success: false, error: 'Failed to fetch models. Please re-login.' };
      }
      return { success: true, models };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('llm:test-connection', async () => {
    try {
      const llmConfig = deps.sessionConfig.llm;
      const dispatcher = await getProxyDispatcher();
      const fetchOptions: Record<string, unknown> = {};
      if (dispatcher) {
        fetchOptions.dispatcher = dispatcher;
        console.log('[Main] Using proxy dispatcher for test connection');
      }

      if (llmConfig.provider === 'deepseek') {
        if (!llmConfig.deepseekToken) {
          return { success: false, status: 0, message: 'No Token configured for DeepSeek. Please add it in Settings.' };
        }
        try {
          const response = await fetch('https://chat.deepseek.com/api/v0/users/current', {
            method: 'GET',
            headers: {
              Authorization: `Bearer ${llmConfig.deepseekToken}`,
              Accept: '*/*',
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
            },
            ...fetchOptions,
          });

          if (response.ok) {
            return { success: true, status: response.status, message: 'DeepSeek connection successful!' };
          } else if (response.status === 401 || response.status === 403) {
            return { success: false, status: response.status, message: 'DeepSeek authentication failed (401/403). Your Token may have expired.' };
          } else {
            const body = await response.text().catch(() => '');
            return { success: false, status: response.status, message: `DeepSeek connection failed: HTTP ${response.status} - ${body.substring(0, 200)}` };
          }
        } catch (err) {
          return { success: false, status: 0, message: `DeepSeek connection error: ${String(err)}` };
        }
      }

      // Qwen AI test-connection
      if (llmConfig.provider === 'qwenai') {
        if (!llmConfig.qwenaiToken) {
          return { success: false, status: 0, message: 'No Token configured for Qwen AI. Please add it in Settings.' };
        }
        try {
          const response = await fetch('https://chat.qwen.ai/api/v2/chats?page=1&page_size=1', {
            method: 'GET',
            headers: {
              Authorization: `Bearer ${llmConfig.qwenaiToken}`,
              Accept: 'application/json',
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
            },
            ...fetchOptions,
          });

          if (response.ok) {
            return { success: true, status: response.status, message: 'Qwen AI connection successful!' };
          } else if (response.status === 401 || response.status === 403) {
            return { success: false, status: response.status, message: 'Qwen AI authentication failed (401/403). Your Token may have expired.' };
          } else {
            const body = await response.text().catch(() => '');
            return { success: false, status: response.status, message: `Qwen AI connection failed: HTTP ${response.status} - ${body.substring(0, 200)}` };
          }
        } catch (err) {
          return { success: false, status: 0, message: `Qwen AI connection error: ${String(err)}` };
        }
      }

      // Cline test-connection
      if (llmConfig.provider === 'cline') {
        const accessToken = await clineAuthService.getAccessToken();
        if (!accessToken) {
          return { success: false, status: 0, message: 'Not logged in to Cline. Please login first via Cline OAuth in Settings.' };
        }
        try {
          // Use a free model for testing to avoid consuming credits.
          // The accessToken now includes the `workos:` prefix (required by Cline API).
          const testModel = llmConfig.model || 'cline-free/glm-5.2';
          const response = await fetch('https://api.cline.bot/api/v1/chat/completions', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${accessToken}`,
              'Content-Type': 'application/json',
              'HTTP-Referer': 'https://cline.bot',
              'X-Title': 'Cline',
              'X-CLIENT-TYPE': 'xai-ide',
              'X-CLIENT-VERSION': '1.0.0',
              'X-PLATFORM': 'xai-ide',
              'X-PLATFORM-VERSION': '1.0.0',
              'X-CORE-VERSION': '1.0.0',
              'X-IS-MULTIROOT': 'false',
              'User-Agent': 'Cline/1.0.0',
            },
            body: JSON.stringify({
              model: testModel,
              messages: [{ role: 'user', content: 'Say OK' }],
              stream: false,
              max_tokens: 8,
            }),
            ...fetchOptions,
          });

          if (response.ok) {
            return { success: true, status: response.status, message: `Cline connection successful! Model: ${llmConfig.model || 'default'}` };
          } else {
            const body = await response.text().catch(() => '');
            let detail = '';
            try {
              const errJson = JSON.parse(body);
              detail = errJson.error?.message || errJson.message || body.substring(0, 300);
            } catch {
              detail = body.substring(0, 300);
            }
            if (response.status === 401 || response.status === 403) {
              return { success: false, status: response.status, message: `Cline authentication failed (HTTP ${response.status}): ${detail}. Please re-login via Cline OAuth.` };
            }
            return { success: false, status: response.status, message: `Cline connection failed (HTTP ${response.status}): ${detail}` };
          }
        } catch (err) {
          return { success: false, status: 0, message: `Cline connection error: ${String(err)}` };
        }
      }

      // DevEco test-connection
      if (llmConfig.provider === 'deveco') {
        const accessToken = await devecoAuthService.getAccessToken();
        if (!accessToken) {
          return { success: false, status: 0, message: 'Not logged in to DevEco. Please login first via Huawei OAuth in Settings.' };
        }
        try {
          const base = (llmConfig.baseUrl || 'https://cn.devecostudio.huawei.com').replace(/\/+$/, '');
          const response = await fetch(`${base}/codeGenie/modelConfig?localVersion=0&pluginVersion=CLI.1.0.0`, {
            method: 'GET',
            headers: {
              Authorization: `Bearer ${accessToken}`,
              'Content-Type': 'application/json',
            },
            ...fetchOptions,
          });

          if (response.ok) {
            const data = await response.json() as Record<string, unknown>;
            const body = data.body as Record<string, unknown> | undefined;
            const innerModels = body?.inner_models as Array<Record<string, unknown>> | undefined;
            let modelCount = 0;
            let modelNames: string[] = [];
            if (Array.isArray(innerModels)) {
              for (const group of innerModels) {
                const configs = group.model_configs as Array<Record<string, unknown>> | undefined;
                if (Array.isArray(configs)) {
                  modelCount += configs.length;
                  modelNames.push(...configs.map(c => String(c.model_id || '')).filter(Boolean));
                }
              }
            }
            return { success: true, status: response.status, message: `DevEco connection successful! Models: ${modelNames.join(', ') || modelCount}` };
          } else if (response.status === 401 || response.status === 403) {
            return { success: false, status: response.status, message: 'DevEco authentication failed (401/403). Token may have expired. Please re-login.' };
          } else {
            const body = await response.text().catch(() => '');
            return { success: false, status: response.status, message: `DevEco connection failed: HTTP ${response.status} - ${body.substring(0, 200)}` };
          }
        } catch (err) {
          return { success: false, status: 0, message: `DevEco connection error: ${String(err)}` };
        }
      }

      // Freebuff test-connection
      if (llmConfig.provider === 'freebuff') {
        const accessToken = await freebuffAuthService.getAccessToken();
        if (!accessToken) {
          return { success: false, status: 0, message: 'Not logged in to Freebuff. Please login first via Device Code Auth in Settings.' };
        }

        // Freebuff free-mode requires an active session (obtained via
        // POST /api/v1/freebuff/session) before chat-completions requests
        // are accepted. Without a session the server returns 401.
        // Reference: freebuff-main cli/src/hooks/use-freebuff-session.ts,
        //   cli/src/utils/freebuff-session-api.ts
        const model = llmConfig.model || 'deepseek/deepseek-v4-flash';
        // Use ensureActiveSession to auto-detect expired sessions and re-admit.
        const sessionResult = await freebuffAuthService.ensureActiveSession(model);
        if (!sessionResult.active) {
          const errMsg = sessionResult.error
            ? `Freebuff session start failed: ${sessionResult.error}`
            : 'Freebuff session not available. Please try again later.';
          return { success: false, status: 0, message: errMsg };
        }
        const instanceId = sessionResult.instanceId;

        // The API backend is at www.codebuff.com, NOT freebuff.com or codebuff.com.
        // freebuff.com only serves the marketing site and login flow.
        // codebuff.com 307-redirects to www.codebuff.com, which strips the
        // Authorization header on cross-origin redirect → 401.
        // See: freebuff-main sdk/src/impl/model-provider.ts line 147,
        // cli/src/utils/freebuff-session-api.ts line 98,
        // common/src/env-schema.ts NEXT_PUBLIC_CODEBUFF_APP_URL.
        //
        // Freebuff always uses its built-in base URL. llmConfig.baseUrl is a
        // shared field that can leak from other providers (config.ts
        // normalizeLlmConfig cleans it up, but a stale copy may still exist in
        // memory), so it must NOT be consulted here — honoring it would send
        // the test request to e.g. aistudio.xiaomimimo.com and fail with a
        // misleading 401.
        let baseUrl = 'https://www.codebuff.com';
        // Normalize legacy domains: codebuff.com and freebuff.com 307-redirect
        // to www.codebuff.com, stripping Authorization on cross-origin redirect.
        baseUrl = baseUrl.replace(/^https:\/\/codebuff\.com(?=$|\/)/i, 'https://www.codebuff.com');
        baseUrl = baseUrl.replace(/^https:\/\/freebuff\.com(?=$|\/)/i, 'https://www.codebuff.com');
        baseUrl = baseUrl.replace(/\/(chat\/)?(completions|embeddings)(\/.*)?$/i, '');
        baseUrl = baseUrl.replace(/\/v1\/?$/, '');
        try {
          // Validate connection by querying the session status endpoint.
          // GET /api/v1/freebuff/session returns session info when token is
          // valid and an active session exists. This avoids the chat-completions
          // endpoint which requires a server-registered runId.
          const sessionUrl = `${baseUrl}/api/v1/freebuff/session`;
          const sessionHeaders: Record<string, string> = {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          };
          if (instanceId) {
            sessionHeaders['x-freebuff-instance-id'] = instanceId;
          }
          const resp = await fetch(sessionUrl, {
            method: 'GET',
            headers: sessionHeaders,
            signal: AbortSignal.timeout(30_000),
          });
          const text = await resp.text().catch(() => '');
          if (resp.ok) {
            let sessionInfo = '';
            try {
              const json = JSON.parse(text);
              sessionInfo = ` (session: ${json.status || 'ok'}, model: ${json.model || model})`;
            } catch { /* ignore */ }
            return { success: true, status: resp.status, message: `Freebuff connected${sessionInfo}` };
          }
          if (resp.status === 401) {
            // Token may be invalid — surface clear guidance
            return { success: false, status: 401, message: `Freebuff authentication failed (401). Token may be invalid or expired. Try re-login. Server: ${text.slice(0, 200)}` };
          }
          // 404 = no active session, but token is valid (user is logged in)
          if (resp.status === 404) {
            return { success: true, status: 404, message: `Freebuff token valid, no active session. The session will start automatically when you begin a chat.` };
          }
          return { success: false, status: resp.status, message: `Freebuff returned ${resp.status}: ${text.slice(0, 200)}` };
        } catch (err) {
          return { success: false, status: 0, message: `Freebuff connection error: ${String(err)}` };
        }
      }

      // apiKey is only for OpenAI. MiMo never uses apiKey.
      const hasApiKey = !!llmConfig.apiKey && llmConfig.provider === 'openai';
      const hasCookies = !!llmConfig.cookies;

      // OpenAI provider: allow Zen free models without API key
      if (llmConfig.provider === 'openai') {
        const url = llmConfig.baseUrl || 'https://api.openai.com/v1/chat/completions';
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
        };
        // Zen free models don't need auth; paid models need API key
        if (hasApiKey) {
          headers['Authorization'] = `Bearer ${llmConfig.apiKey!}`;
        }

        const response = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model: llmConfig.model || 'gpt-4o',
            messages: [{ role: 'user', content: 'hi' }],
            stream: false,
            max_tokens: 10,
          }),
          ...fetchOptions,
        });

        const body = await response.text();

        if (response.ok) {
          return { success: true, status: response.status, message: hasApiKey ? 'API Key connection successful!' : 'Connection successful (no auth needed for free model)!' };
        } else {
          return { success: false, status: response.status, message: `HTTP ${response.status}: ${body.substring(0, 200)}` };
        }
      }

      if (!hasCookies) {
        return { success: false, status: 0, message: 'No Cookies configured for MiMo. Please add cookies in Settings.' };
      }

      {
        const rawCookies = llmConfig.cookies || '';
        const cookies = cleanCookies(rawCookies);

        let url = llmConfig.baseUrl || 'https://aistudio.xiaomimimo.com/open-apis/bot/chat';

        const phMatch = cookies.match(/xiaomichatbot_ph=([^;]+)/);
        if (phMatch) {
          url += `?xiaomichatbot_ph=${encodeURIComponent(phMatch[1])}`;
        }

        const msgId = Math.random().toString(36).substring(2) + Date.now().toString(36);
        const convId = Math.random().toString(36).substring(2) + Date.now().toString(36);

        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': '*/*',
            'Origin': 'https://aistudio.xiaomimimo.com',
            'Referer': 'https://aistudio.xiaomimimo.com/',
            'X-Timezone': Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai',
            'Cookie': cookies,
          },
          body: JSON.stringify({
            msgId,
            conversationId: convId,
            query: 'hi',
            isEditedQuery: false,
            modelConfig: {
              enableThinking: false,
              webSearchStatus: 'disabled',
              model: llmConfig.model || 'mimo-v2.5',
              temperature: 0.7,
              topP: 0.95,
            },
            multiMedias: [],
          }),
          ...fetchOptions,
        });

        const body = await response.text();

        if (response.ok) {
          return { success: true, status: response.status, message: 'Cookie connection successful!' };
        } else if (response.status === 401) {
          return { success: false, status: response.status, message: 'Cookie authentication failed (401). Your cookies may have expired.' };
        } else {
          return { success: false, status: response.status, message: `HTTP ${response.status}: ${body.substring(0, 200)}` };
        }
      }
    } catch (err) {
      const errorMessage = String(err);
      console.error('[Main] LLM test connection error:', err);

      let helpfulMessage = '';
      if (errorMessage.includes('ECONNREFUSED') || errorMessage.includes('connect ECONNREFUSED')) {
        helpfulMessage = '\n\n提示: 连接被拒绝。请检查:\n1. 代理软件是否正在运行\n2. 代理端口是否正确\n3. 代理地址是否可达';
      } else if (errorMessage.includes('ETIMEDOUT') || errorMessage.includes('timeout')) {
        helpfulMessage = '\n\n提示: 连接超时。请检查:\n1. 代理服务器是否响应\n2. 网络连接是否正常\n3. 防火墙是否阻止了连接';
      } else if (errorMessage.includes('ENOTFOUND') || errorMessage.includes('getaddrinfo')) {
        helpfulMessage = '\n\n提示: 域名解析失败。请检查代理地址是否正确';
      } else if (errorMessage.includes('ERR_PROXY')) {
        helpfulMessage = '\n\n提示: 代理配置错误。请检查代理 URL 格式是否正确 (例如: http://127.0.0.1:7890)';
      }

      return { success: false, status: 0, message: `Network error: ${errorMessage}${helpfulMessage}` };
    }
  });

  // ── Local conversation persistence (OpenAI / DevEco / Cline) ──────────────
  // These stateless providers keep conversation history in the adapter's memory,
  // so we persist conversations to local JSON files (shared store, not partitioned
  // by provider). The save handler receives displayMessages from the renderer
  // (the rich UI layer) and pulls adapterState + compressionInfo from the current
  // adapter in the main process. This path is Code-view only — Designer uses the
  // adapter's snapshotSession/restoreSession and never hits these handlers.

  // Save the current conversation. The renderer triggers this via the
  // 'local-conversation:request-save' round-trip after each completed turn.
  ipcMain.handle(IPCChannel.LocalConversationSave, async (_event, params: {
    displayMessages: Message[];
    title?: string;
    /**
     * Pre-captured snapshot (old provider's adapter state) taken before a
     * mid-run provider/model switch. When present it wins over pulling state
     * from the current adapter, which may already have been re-created.
     */
    capturedState?: CapturedConversationState;
  }) => {
    try {
      // Teardown snapshot (mid-run switch): the renderer forwards the captured
      // state verbatim, so we don't touch the (possibly re-created) adapter.
      if (params.capturedState) {
        const captured = params.capturedState;
        const now = Date.now();
        const meta = {
          conversationId: captured.conversationId,
          title: params.title || deps.currentSessionTitle || 'Untitled',
          provider: captured.provider,
          model: captured.model,
          createTime: now,
          updateTime: now,
          messageCount: params.displayMessages.length,
          isCompressed: captured.compressionInfo.isCompressed,
        };
        await deps.conversationStore.save(meta, params.displayMessages, captured.adapterState, captured.compressionInfo);
        return { success: true, conversationId: captured.conversationId };
      }

      const provider = deps.sessionConfig.llm.provider;
      if (!LOCAL_PERSISTENCE_PROVIDERS.includes(provider)) {
        return { success: false, error: 'Provider does not support local saving' };
      }
      const adapter = deps.adapterManager.getCurrent(deps.sessionConfig);
      if (!adapter || typeof (adapter as { getAdapterState?: unknown }).getAdapterState !== 'function') {
        return { success: false, error: 'Adapter does not support state export' };
      }
      const adapterAny = adapter as {
        getAdapterState: () => { conversationHistory: unknown[]; pendingToolCallIds: string[] };
        getCompressionInfo?: () => { isCompressed: boolean; summary: string | null };
        conversationId?: string;
      };
      const adapterState = adapterAny.getAdapterState();
      const ci = adapterAny.getCompressionInfo?.() ?? { isCompressed: false, summary: null };
      const compressionInfo = {
        isCompressed: !!ci.isCompressed,
        originalMessageCount: null,
        summary: ci.summary ?? null,
        compressedAt: null as number | null,
      };
      const conversationId = adapterAny.conversationId ?? String(Date.now());
      const title = params.title || deps.currentSessionTitle || 'Untitled';
      const now = Date.now();
      // createTime is preserved by the store for existing conversations, so
      // passing `now` here only takes effect on the first save of this ID.
      const meta = {
        conversationId,
        title,
        provider,
        model: deps.sessionConfig.llm.model,
        createTime: now,
        updateTime: now,
        messageCount: params.displayMessages.length,
        isCompressed: compressionInfo.isCompressed,
      };
      await deps.conversationStore.save(meta, params.displayMessages, adapterState, compressionInfo);
      return { success: true, conversationId };
    } catch (err) {
      console.error('[Main] local-conversation:save failed:', err);
      return { success: false, error: String(err) };
    }
  });

  // Delete the CURRENT conversation (trash icon). For local providers we delete
  // the on-disk file for the adapter's current conversationId, then reset the
  // adapter so the next turn starts a fresh conversation.
  ipcMain.handle('delete-conversation', async () => {
    try {
      const provider = deps.sessionConfig.llm.provider;
      if (LOCAL_PERSISTENCE_PROVIDERS.includes(provider)) {
        const adapter = deps.adapterManager.getCurrent(deps.sessionConfig) as { conversationId?: string } | undefined;
        const cid = adapter?.conversationId;
        if (cid) {
          await deps.conversationStore.deleteConversation(cid);
        }
        deps.adapterManager.resetCurrent(deps.sessionConfig);
        deps.isFirstMessageOfSession = true;
        deps.titleGenerated = false;
        deps.currentSessionTitle = '';
        return { success: true };
      }
      const success = await deps.adapterManager.deleteConversation(deps.sessionConfig);
      return { success, error: success ? undefined : 'Failed to delete conversation' };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  // List conversations. Local providers read from the shared on-disk index;
  // remote providers (MiMo/DeepSeek/QwenAI/Zai) query their server APIs.
  ipcMain.handle('conversation:list', async (_event, pageNum?: number, pageSize?: number) => {
    try {
      const provider = deps.sessionConfig.llm.provider;
      if (LOCAL_PERSISTENCE_PROVIDERS.includes(provider)) {
        const list = await deps.conversationStore.listConversations();
        // Map to the ConversationItem shape the renderer expects (string times).
        const mapped = list.map(c => ({
          conversationId: c.conversationId,
          title: c.title,
          createTime: new Date(c.createTime).toISOString(),
          updateTime: new Date(c.updateTime).toISOString(),
        }));
        return { success: true, data: { list: mapped, total: mapped.length } };
      }
      const result = await deps.adapterManager.getConversationList(deps.sessionConfig, pageNum, pageSize);
      if (!result) return { success: false, error: 'Failed to get conversation list' };
      // Normalize: DeepSeek returns { list, hasMore, nextCursor }, others return { list, total }
      if (!('total' in result) && 'hasMore' in result) {
        result.total = result.list.length;
      }
      return { success: true, data: result };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  // Load a conversation. Local providers restore both the display layer
  // (displayMessages, returned to the renderer) and the API layer (adapterState
  // restored into the current adapter). Cross-provider loads migrate the history
  // via importSnapshot since all three use the OpenAI-compatible message format.
  ipcMain.handle('conversation:load', async (_event, conversationId: string) => {
    try {
      const provider = deps.sessionConfig.llm.provider;
      if (LOCAL_PERSISTENCE_PROVIDERS.includes(provider)) {
        const saved = await deps.conversationStore.loadConversation(conversationId);
        if (!saved) return { success: false, error: 'Conversation not found' };
        const adapter = deps.adapterManager.getCurrent(deps.sessionConfig) as
          | {
              setAdapterState?: (s: { conversationHistory: unknown[]; pendingToolCallIds: string[] }) => void;
              importSnapshot?: (s: { history: unknown[]; pendingToolCallIds: string[] }) => void;
              setConversationId?: (id: string) => void;
            }
          | undefined;
        if (adapter) {
          if (saved.provider === provider) {
            // Same provider: restore the exact adapter state.
            adapter.setAdapterState?.({
              conversationHistory: saved.adapterState.conversationHistory,
              pendingToolCallIds: saved.adapterState.pendingToolCallIds,
            });
          } else {
            // Cross-provider: migrate via the OpenAI-compatible snapshot.
            adapter.importSnapshot?.({
              history: saved.adapterState.conversationHistory,
              pendingToolCallIds: saved.adapterState.pendingToolCallIds,
            });
          }
          // Restore the conversation ID so subsequent saves update this file
          // instead of creating a duplicate under a freshly generated ID.
          adapter.setConversationId?.(saved.conversationId);
        }
        deps.isFirstMessageOfSession = false;
        deps.titleGenerated = true;
        deps.currentSessionTitle = saved.title || '';
        // Retroactively repair conversations saved before title generation was
        // wired up (title missing or still the 'Untitled' placeholder): re-derive
        // a concise title from the first user message and persist the fix. This is
        // a one-time repair — subsequent loads see the corrected title.
        if (!deps.currentSessionTitle || deps.currentSessionTitle === 'Untitled') {
          const firstUser = saved.displayMessages.find(m => m.role === 'user');
          const raw = firstUser?.content?.trim();
          if (raw) {
            const collapsed = raw.replace(/\s+/g, ' ').trim();
            const derived = collapsed.length > 30 ? collapsed.slice(0, 30) + '…' : collapsed;
            deps.currentSessionTitle = derived;
            await deps.conversationStore.updateTitle(saved.conversationId, derived);
          }
        }
        return { success: true, data: saved.displayMessages };
      }
      const dialogs = await deps.adapterManager.getDialogList(deps.sessionConfig, conversationId);
      if (!dialogs) return { success: false, error: 'Failed to load conversation' };
      deps.adapterManager.loadSession(deps.sessionConfig, conversationId);
      deps.isFirstMessageOfSession = false;
      deps.titleGenerated = true; // Existing conversation, title already generated
      // Map dialogs to the same format
      const mappedDialogs = dialogs.map((d: any) => ({
        dialogId: d.dialogId,
        role: d.role,
        content: d.content,
        createTime: d.createTime,
      }));
      return { success: true, data: provider === 'mimo' ? dialogs : mappedDialogs };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  // Delete a conversation by ID (from the history panel).
  ipcMain.handle('conversation:delete', async (_event, conversationId: string) => {
    try {
      const provider = deps.sessionConfig.llm.provider;
      if (LOCAL_PERSISTENCE_PROVIDERS.includes(provider)) {
        const success = await deps.conversationStore.deleteConversation(conversationId);
        return { success };
      }
      const success = await deps.adapterManager.deleteConversationById(deps.sessionConfig, conversationId);
      return { success };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

}
