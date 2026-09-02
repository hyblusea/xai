import type { Message, LLMConfig, StreamChunk } from '@xai/shared';
import type { HttpRequest, LLMAdapter } from './types.js';
import { randomUUID } from './crypto-polyfill.js';
// Use default import for js-sha3
import sha3Lib from 'js-sha3';

export interface GptAdapterOptions {
  baseUrl?: string;
  authorization?: string;
  cookies?: string;
  deviceId?: string;
  xOaiIs?: string;
  userAgent?: string;
  secChUa?: string;
  secChUaMobile?: string;
  secChUaPlatform?: string;
  acceptLanguage?: string;
  clientBuildNumber?: string;
  clientVersion?: string;
  oaiLanguage?: string;
  timezone?: string;
  timezoneOffset?: number;
  proxyUrl?: string;
  onTokenRefreshed?: (newToken: string) => void;
}

export interface GptConversationItem {
  conversationId: string;
  title: string;
  createTime: string;
  updateTime: string;
}

export interface GptDialogItem {
  dialogId: string;
  role: string;
  content: string;
  createTime: number;
}

const DEFAULT_BASE_URL = 'https://chatgpt.com';

const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';
const DEFAULT_SEC_CH_UA = '"Google Chrome";v="147", "Not.A/Brand";v="8", "Chromium";v="147"';
const DEFAULT_SEC_CH_UA_MOBILE = '?0';
const DEFAULT_SEC_CH_UA_PLATFORM = '"Windows"';
const DEFAULT_ACCEPT_LANGUAGE = 'zh-CN,zh-TW;q=0.9,zh;q=0.8';
const DEFAULT_OAI_LANGUAGE = 'zh-CN';
const DEFAULT_TIMEZONE = 'Asia/Shanghai';
const DEFAULT_TIMEZONE_OFFSET = -480;

export class GptAdapter implements LLMAdapter {
  private options: GptAdapterOptions;
  private _conversationId: string | null = null;
  private _parentMessageId: string = 'client-created-root';
  private _assistantMessageId: string | null = null;
  private _authorization: string;
  private abortController: AbortController | null = null;
  private _streamAccumulatedText = '';
  private _proxyDispatcher: unknown = null;
  private _proxyUrl: string | null = null;

  constructor(options: GptAdapterOptions = {}) {
    const opts = options || {};
    let baseUrl = opts.baseUrl || DEFAULT_BASE_URL;
    
    // Detect and warn if baseUrl contains OpenAI-compatible API path
    if (baseUrl.includes('/v1/chat/completions') || baseUrl.includes('/v1/')) {
      console.warn('[GPT] Warning: baseUrl appears to be an OpenAI-compatible API endpoint, not ChatGPT web URL');
      console.warn('[GPT] GPT adapter requires ChatGPT web URL (e.g., https://chatgpt.com), not API URL');
      console.warn('[GPT] Falling back to default: ' + DEFAULT_BASE_URL);
      baseUrl = DEFAULT_BASE_URL;
    }
    
    this.options = { ...opts, baseUrl: baseUrl.replace(/\/+$/, '') };
    this._authorization = opts.authorization || '';
    if (opts.proxyUrl) {
      this._proxyUrl = opts.proxyUrl;
    }
  }

  private async ensureProxy(): Promise<void> {
    if (this._proxyUrl && !this._proxyDispatcher) {
      try {
        console.log('[GPT] Initializing proxy:', this._proxyUrl);
        // Use undici's ProxyAgent and set it as global dispatcher
        const { setGlobalDispatcher, ProxyAgent } = await import('undici');
        const proxyAgent = new ProxyAgent(this._proxyUrl);
        setGlobalDispatcher(proxyAgent);
        this._proxyDispatcher = proxyAgent;
        console.log('[GPT] Global proxy dispatcher set successfully');
      } catch (err) {
        console.error('[GPT] Failed to initialize proxy:', err);
        console.error('[GPT] Proxy URL:', this._proxyUrl);
        console.error('[GPT] Please check: 1) Proxy server is running 2) URL format is correct 3) Port is accessible');
      }
    }
  }

  private async getFetchOptions(): Promise<Record<string, unknown>> {
    await this.ensureProxy();
    // Node.js native fetch will automatically use proxy from environment variables
    return {};
  }

  private getBaseUrl(): string {
    return this.options.baseUrl || DEFAULT_BASE_URL;
  }

  get conversationId(): string | null {
    return this._conversationId;
  }

  get parentMessageId(): string {
    return this._parentMessageId;
  }

  get assistantMessageId(): string | null {
    return this._assistantMessageId;
  }

  resetSession(): void {
    this._conversationId = null;
    this._parentMessageId = 'client-created-root';
    this._assistantMessageId = null;
  }

  loadSession(conversationId: string, parentMessageId?: string): void {
    this._conversationId = conversationId;
    if (parentMessageId) {
      this._parentMessageId = parentMessageId;
    }
  }

  private getUserAgent(): string {
    return this.options.userAgent || DEFAULT_USER_AGENT;
  }

  private decodeJWT(token: string): { exp?: number; [key: string]: unknown } | null {
    try {
      const raw = token.replace(/^Bearer\s+/, '');
      const parts = raw.split('.');
      if (parts.length !== 3) return null;
      const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());
      return payload;
    } catch {
      return null;
    }
  }

  private isTokenExpiringSoon(thresholdSeconds: number = 120): boolean {
    const payload = this.decodeJWT(this._authorization);
    if (!payload || !payload.exp) return true;
    const remaining = payload.exp - Date.now() / 1000;
    return remaining < thresholdSeconds;
  }

  private async refreshToken(): Promise<boolean> {
    if (!this.isTokenExpiringSoon()) {
      return true;
    }

    console.log('[GPT] JWT expired or expiring soon, refreshing...');

    const headers: Record<string, string> = {
      'accept': '*/*',
      'accept-language': this.options.acceptLanguage || DEFAULT_ACCEPT_LANGUAGE,
      'cookie': this.options.cookies || '',
      'oai-device-id': this.options.deviceId || '',
      'oai-language': this.options.oaiLanguage || DEFAULT_OAI_LANGUAGE,
      'origin': this.getBaseUrl(),
      'priority': 'u=1, i',
      'referer': `${this.getBaseUrl()}/`,
      'sec-ch-ua': this.options.secChUa || DEFAULT_SEC_CH_UA,
      'sec-ch-ua-mobile': this.options.secChUaMobile || DEFAULT_SEC_CH_UA_MOBILE,
      'sec-ch-ua-platform': this.options.secChUaPlatform || DEFAULT_SEC_CH_UA_PLATFORM,
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-origin',
      'user-agent': this.getUserAgent(),
    };

    try {
      const response = await fetch(`${this.getBaseUrl()}/api/auth/session`, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(30000),
        ...(await this.getFetchOptions()),
      });

      if (!response.ok) {
        console.error('[GPT] Session refresh failed:', response.status);
        return false;
      }

      const data = await response.json() as Record<string, unknown>;
      const newToken = data.accessToken as string | undefined;

      if (newToken) {
        this._authorization = `Bearer ${newToken}`;
        console.log('[GPT] JWT refreshed successfully');
        
        // Notify callback to persist the new token
        if (this.options.onTokenRefreshed) {
          this.options.onTokenRefreshed(`Bearer ${newToken}`);
        }
        
        return true;
      } else {
        console.error('[GPT] Refresh returned no accessToken');
        return false;
      }
    } catch (err) {
      console.error('[GPT] JWT refresh failed:', err);
      return false;
    }
  }

  private buildBaseHeaders(): Record<string, string> {
    return {
      'accept': '*/*',
      'accept-language': this.options.acceptLanguage || DEFAULT_ACCEPT_LANGUAGE,
      'authorization': this._authorization,
      'cookie': this.options.cookies || '',
      'oai-device-id': this.options.deviceId || '',
      'oai-language': this.options.oaiLanguage || DEFAULT_OAI_LANGUAGE,
      'origin': this.getBaseUrl(),
      'priority': 'u=1, i',
      'referer': `${this.getBaseUrl()}/`,
      'sec-ch-ua': this.options.secChUa || DEFAULT_SEC_CH_UA,
      'sec-ch-ua-mobile': this.options.secChUaMobile || DEFAULT_SEC_CH_UA_MOBILE,
      'sec-ch-ua-platform': this.options.secChUaPlatform || DEFAULT_SEC_CH_UA_PLATFORM,
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-origin',
      'user-agent': this.getUserAgent(),
      'x-oai-is': this.options.xOaiIs || '',
      'x-oai-turn-trace-id': randomUUID(),
      'oai-client-build-number': this.options.clientBuildNumber || '',
      'oai-client-version': this.options.clientVersion || '',
    };
  }

  private generateRequirementsToken(): string {
    const userAgent = this.getUserAgent();
    const arr = [
      Math.floor(Math.random() * 3000 + 3000),
      new Date().toUTCString().replace('GMT', 'GMT+0800 (China Standard Time)'),
      4294705152,
      0,
      userAgent,
      'zh-CN',
      'zh-CN,zh-TW',
      401,
      'mediaSession',
      'location',
      'scrollX',
      (Math.random() * 4000 + 1000).toFixed(4),
      randomUUID(),
      '',
      12,
      Date.now(),
    ];
    return 'gAAAAAC' + Buffer.from(JSON.stringify(arr)).toString('base64');
  }

  private solveProofOfWork(seed: string, difficulty: string): string {
    const userAgent = this.getUserAgent();
    const screenArr = [3008, 4010, 6000];
    const multArr = [1, 2, 4];
    const screen = screenArr[Math.floor(Math.random() * screenArr.length)]
      * multArr[Math.floor(Math.random() * multArr.length)];
    const now = new Date().toUTCString().replace('GMT', 'GMT+0800 (China Standard Time)');
    const diffLen = difficulty.length / 2;

    const proofArr: (number | string)[] = [screen, now, 4294705152, 0, userAgent];

    for (let i = 0; i < 100000; i++) {
      proofArr[3] = i;
      const base = Buffer.from(JSON.stringify(proofArr)).toString('base64');
      const hashHex = sha3Lib.sha3_512(seed + base);
      if (hashHex.substring(0, diffLen) <= difficulty) {
        console.log(`[GPT] PoW solved! nonce=${i}`);
        return 'gAAAAAB' + base;
      }
    }

    console.log('[GPT] PoW: fallback');
    return 'gAAAAABwQ8Lk5FbGpA2NcR9dShT6gYjU7VxZ4D'
      + Buffer.from(`"${seed}"`).toString('base64');
  }

  private extractUserMessage(messages: Message[]): string {
    const systemMessage = messages.find(m => m.role === 'system');
    const nonSystemMessages = messages.filter(m => m.role !== 'system');

    const toolResults: Message[] = [];
    for (let i = nonSystemMessages.length - 1; i >= 0; i--) {
      if (nonSystemMessages[i].role === 'tool') {
        toolResults.unshift(nonSystemMessages[i]);
      } else {
        break;
      }
    }

    if (toolResults.length > 0) {
      const parts = toolResults.map(r => `[Tool Result] ${r.toolName || 'unknown'}\n${r.content}`);
      return parts.join('\n\n') + '\n\nBased on the tool results above, continue your response. Use ++++ to start commands.';
    }

    const lastUserMessage = [...nonSystemMessages].reverse().find(m => m.role === 'user');
    if (lastUserMessage) {
      if (systemMessage) {
        return `${systemMessage.content}\n\n---\n\nUser: ${lastUserMessage.content}`;
      }
      return lastUserMessage.content;
    }

    return '';
  }

  private async prepareConversation(
    baseHeaders: Record<string, string>,
    model: string,
    timezone: string,
    timezoneOffset: number,
  ): Promise<string | null> {
    console.log('[GPT] Step 1: /conversation/prepare');

    const headers: Record<string, string> = {
      ...baseHeaders,
      'content-type': 'application/json',
    };

    const body: Record<string, unknown> = {
      action: 'next',
      fork_from_shared_post: false,
      parent_message_id: this._parentMessageId,
      ...(this._conversationId ? { conversation_id: this._conversationId } : {}),
      model,
      client_prepare_state: this._conversationId ? 'success' : 'none',
      timezone_offset_min: timezoneOffset,
      timezone,
      conversation_mode: { kind: 'primary_assistant' },
      system_hints: [],
      partial_query: {
        id: randomUUID(),
        author: { role: 'user' },
        content: { content_type: 'text', parts: [''] },
      },
      supports_buffering: true,
      supported_encodings: ['v1'],
      client_contextual_info: { app_name: 'chatgpt.com' },
    };

    try {
      const response = await fetch(`${this.getBaseUrl()}/backend-api/f/conversation/prepare`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30000),
        ...(await this.getFetchOptions()),
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        console.error('[GPT] Prepare failed:', response.status, errorText.substring(0, 200));
        return null;
      }

      const data = await response.json() as Record<string, unknown>;
      const conduitToken = data.conduit_token as string | undefined;
      console.log('[GPT] conduit_token:', conduitToken ? 'OK' : 'NONE');
      return conduitToken || null;
    } catch (err) {
      console.error('[GPT] Prepare error:', err);
      return null;
    }
  }

  private async prepareSentinel(
    baseHeaders: Record<string, string>,
    conduitToken: string,
  ): Promise<{ prepareToken: string | null; proofToken: string | null }> {
    console.log('[GPT] Step 2: /sentinel/chat-requirements/prepare');

    const headers: Record<string, string> = {
      ...baseHeaders,
      'content-type': 'application/json',
      'x-conduit-token': conduitToken,
      'x-openai-target-path': '/backend-api/sentinel/chat-requirements/prepare',
      'x-openai-target-route': '/backend-api/sentinel/chat-requirements/prepare',
    };

    const pToken = this.generateRequirementsToken();

    try {
      const response = await fetch(`${this.getBaseUrl()}/backend-api/sentinel/chat-requirements/prepare`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ p: pToken }),
        signal: AbortSignal.timeout(30000),
        ...(await this.getFetchOptions()),
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        console.error('[GPT] Sentinel failed:', response.status, errorText.substring(0, 200));
        return { prepareToken: null, proofToken: null };
      }

      const data = await response.json() as Record<string, unknown>;
      const prepareToken = (data.prepare_token as string) || null;
      const proofofwork = data.proofofwork as Record<string, unknown> | undefined;

      let proofToken: string | null = null;
      if (proofofwork?.required) {
        console.log('[GPT] PoW required, solving...');
        proofToken = this.solveProofOfWork(
          proofofwork.seed as string,
          proofofwork.difficulty as string,
        );
      }

      console.log('[GPT] prepare_token:', prepareToken ? 'YES' : 'NO', 'proof_token:', proofToken ? 'YES' : 'NO');
      return { prepareToken, proofToken };
    } catch (err) {
      console.error('[GPT] Sentinel error:', err);
      return { prepareToken: null, proofToken: null };
    }
  }

  async translateInput(messages: Message[], config: LLMConfig): Promise<HttpRequest> {
    await this.refreshToken();

    const baseHeaders = this.buildBaseHeaders();
    const userMessage = this.extractUserMessage(messages);
    const model = config.model || 'auto';
    const timezone = config.gptTimezone || this.options.timezone || DEFAULT_TIMEZONE;
    const timezoneOffset = config.gptTimezoneOffset ?? this.options.timezoneOffset ?? DEFAULT_TIMEZONE_OFFSET;

    const conduitToken = await this.prepareConversation(baseHeaders, model, timezone, timezoneOffset);
    if (!conduitToken) {
      throw new Error('Failed to get conduit_token from /conversation/prepare');
    }

    const { prepareToken, proofToken } = await this.prepareSentinel(baseHeaders, conduitToken);

    const messageId = randomUUID();
    const conversationHeaders: Record<string, string> = {
      ...baseHeaders,
      'accept': 'text/event-stream',
      'content-type': 'application/json',
      'x-conduit-token': conduitToken,
      'x-openai-target-path': '/backend-api/f/conversation',
      'x-openai-target-route': '/backend-api/f/conversation',
    };

    if (prepareToken) {
      conversationHeaders['openai-sentinel-chat-requirements-prepare-token'] = prepareToken;
    }
    if (proofToken) {
      conversationHeaders['openai-sentinel-proof-token'] = proofToken;
    }

    const body: Record<string, unknown> = {
      action: 'next',
      messages: [{
        id: messageId,
        author: { role: 'user' },
        create_time: Date.now() / 1000,
        content: { content_type: 'text', parts: [userMessage] },
        metadata: {},
      }],
      parent_message_id: this._parentMessageId,
      ...(this._conversationId ? { conversation_id: this._conversationId } : {}),
      model,
      client_prepare_state: 'sent',
      timezone_offset_min: timezoneOffset,
      timezone,
      conversation_mode: { kind: 'primary_assistant' },
      enable_message_followups: true,
      system_hints: [],
      supports_buffering: true,
      supported_encodings: ['v1'],
      client_contextual_info: {
        is_dark_mode: false,
        time_since_loaded: Math.floor(Math.random() * 3000 + 1000),
        page_height: 919,
        page_width: 882,
        pixel_ratio: 1,
        screen_height: 1080,
        screen_width: 1920,
        app_name: 'chatgpt.com',
      },
      paragen_cot_summary_display_override: 'allow',
      force_parallel_switch: 'auto',
    };

    return {
      url: `${this.getBaseUrl()}/backend-api/f/conversation`,
      method: 'POST',
      headers: conversationHeaders,
      body: JSON.stringify(body),
      conversationId: this._conversationId || undefined,
    };
  }

  translateOutput(response: unknown): Message {
    const data = response as Record<string, unknown>;
    const content = typeof data === 'string' ? data : JSON.stringify(data);
    return {
      role: 'assistant',
      content,
      timestamp: Date.now(),
    };
  }

  async *translateStream(stream: AsyncIterable<Buffer>): AsyncIterable<StreamChunk> {
    let buffer = '';
    // 流式 UTF-8 解码器：暂存跨 chunk 被切断的多字节字符，避免单独 decode 产生 U+FFFD 乱码。
    const decoder = new TextDecoder('utf-8');
    this._streamAccumulatedText = '';
    let isInThinkBlock = false;
    let pendingThink = '';

    for await (const chunk of stream) {
      buffer += decoder.decode(chunk, { stream: true });

      const parts = buffer.split('\n\n');
      buffer = parts.pop() ?? '';

      for (const part of parts) {
        const sseChunks = [...this.parseGPTSSEBlock(part)];
        for (const sseChunk of sseChunks) {
          const result = this.processThinkTags(sseChunk, isInThinkBlock, pendingThink);
          isInThinkBlock = result.isInThinkBlock;
          pendingThink = result.pendingThink;
          yield* result.events;
        }
      }
    }

    // 冲刷解码器缓存的不完整字节（正常结束时应为空字符串）。
    buffer += decoder.decode();

    if (buffer.trim()) {
      const sseChunks = [...this.parseGPTSSEBlock(buffer)];
      for (const sseChunk of sseChunks) {
        const result = this.processThinkTags(sseChunk, isInThinkBlock, pendingThink);
        isInThinkBlock = result.isInThinkBlock;
        pendingThink = result.pendingThink;
        yield* result.events;
      }
    }

    if (pendingThink) {
      yield {
        type: isInThinkBlock ? 'thinking' : 'text',
        content: pendingThink,
      };
    }

    yield { type: 'done', content: '' };
  }

  private *parseGPTSSEBlock(block: string): Generator<StreamChunk> {
    const lines = block.split('\n');
    let dataStr = '';

    for (const line of lines) {
      if (line.startsWith('data: ')) {
        dataStr = line.substring(6).trim();
      }
    }

    if (!dataStr || dataStr === '[DONE]') return;

    try {
      const parsed = JSON.parse(dataStr) as Record<string, unknown>;

      if (parsed.conversation_id) {
        this._conversationId = parsed.conversation_id as string;
      }

      const v = parsed.v as Record<string, unknown> | undefined;

      if (v?.conversation_id) {
        this._conversationId = v.conversation_id as string;
      }

      if (parsed.o === 'append' && parsed.p === '/message/content/parts/0' && typeof parsed.v === 'string') {
        this._streamAccumulatedText += parsed.v;
        yield { type: 'text', content: parsed.v };
        return;
      }

      // Handle v1 delta encoding continuation events:
      // These events only have {"v": "text"} with no o/p fields,
      // meaning they are implicit continuations of the previous append operation.
      if (typeof parsed.v === 'string' && !parsed.o && !parsed.p &&
          !parsed.conversation_id && !parsed.type && !v?.message) {
        this._streamAccumulatedText += parsed.v;
        yield { type: 'text', content: parsed.v };
        return;
      }

      if (Array.isArray(parsed.v)) {
        for (const item of parsed.v as Record<string, unknown>[]) {
          if (item.o === 'append' && item.p === '/message/content/parts/0' && typeof item.v === 'string') {
            this._streamAccumulatedText += item.v;
            yield { type: 'text', content: item.v };
          }
        }
        return;
      }

      if (parsed.o === 'add' && v?.message) {
        const message = v.message as Record<string, unknown>;
        const author = message.author as Record<string, unknown> | undefined;
        if (author?.role === 'assistant') {
          if (message.id) {
            this._assistantMessageId = message.id as string;
            this._parentMessageId = message.id as string;
          }
          const content = message.content as Record<string, unknown> | undefined;
          if (content?.parts && Array.isArray(content.parts)) {
            const fullText = (content.parts[0] as string) || '';
            if (fullText.length > this._streamAccumulatedText.length) {
              const diff = fullText.substring(this._streamAccumulatedText.length);
              this._streamAccumulatedText = fullText;
              if (diff) yield { type: 'text', content: diff };
            }
          }
        }
        return;
      }

      if (v?.message) {
        const message = v.message as Record<string, unknown>;
        const author = message.author as Record<string, unknown> | undefined;
        if (author?.role === 'assistant') {
          if (message.id) {
            this._assistantMessageId = message.id as string;
            this._parentMessageId = message.id as string;
          }
          const content = message.content as Record<string, unknown> | undefined;
          if (content?.parts && Array.isArray(content.parts)) {
            const fullText = (content.parts[0] as string) || '';
            if (fullText.length > this._streamAccumulatedText.length) {
              const diff = fullText.substring(this._streamAccumulatedText.length);
              this._streamAccumulatedText = fullText;
              if (diff) yield { type: 'text', content: diff };
            }
          }
        }
      }

      if (parsed.error) {
        yield { type: 'error', content: String(parsed.error) };
      }
    } catch {
      // ignore parse errors
    }
  }

  private static readonly THINK_DELIMITER = '\u0000';
  private static readonly THINK_OPEN_MARKER = `<think>${GptAdapter.THINK_DELIMITER}`;
  private static readonly THINK_CLOSE_MARKER = `</think>${GptAdapter.THINK_DELIMITER}`;

  private processThinkTags(
    chunk: StreamChunk,
    isInThinkBlock: boolean,
    pendingThink: string
  ): { events: StreamChunk[]; isInThinkBlock: boolean; pendingThink: string } {
    if (chunk.type !== 'text') {
      return { events: [chunk], isInThinkBlock, pendingThink };
    }

    const events: StreamChunk[] = [];
    let content = pendingThink + chunk.content;
    let currentInThink = isInThinkBlock;
    const safeLength = this.getSafeThinkContentLength(content, currentInThink);
    const newPendingThink = content.substring(safeLength);
    content = content.substring(0, safeLength);

    while (content.length > 0) {
      const taggedMarker = currentInThink
        ? GptAdapter.THINK_CLOSE_MARKER
        : GptAdapter.THINK_OPEN_MARKER;
      const taggedMarkerIdx = content.indexOf(taggedMarker);
      const delimIdx = content.indexOf(GptAdapter.THINK_DELIMITER);
      const useTaggedMarker = taggedMarkerIdx !== -1 && (delimIdx === -1 || taggedMarkerIdx <= delimIdx);
      const markerIdx = useTaggedMarker ? taggedMarkerIdx : delimIdx;

      if (markerIdx === -1) {
        if (currentInThink) {
          events.push({ type: 'thinking', content });
        } else {
          events.push({ type: 'text', content });
        }
        break;
      }

      const beforeMarker = content.substring(0, markerIdx);
      if (beforeMarker) {
        events.push({ type: currentInThink ? 'thinking' : 'text', content: beforeMarker });
      }

      currentInThink = !currentInThink;
      content = content.substring(markerIdx + (useTaggedMarker ? taggedMarker.length : GptAdapter.THINK_DELIMITER.length));
    }

    return { events, isInThinkBlock: currentInThink, pendingThink: newPendingThink };
  }

  private getSafeThinkContentLength(content: string, isInThinkBlock: boolean): number {
    const taggedMarker = isInThinkBlock
      ? GptAdapter.THINK_CLOSE_MARKER
      : GptAdapter.THINK_OPEN_MARKER;
    const longestPartialLength = this.getLongestPartialMarkerPrefix(content, taggedMarker);
    return content.length - longestPartialLength;
  }

  private getLongestPartialMarkerPrefix(content: string, marker: string): number {
    const maxPartialLength = Math.min(content.length, marker.length - 1);

    for (let length = maxPartialLength; length > 0; length--) {
      if (content.endsWith(marker.substring(0, length))) {
        return length;
      }
    }

    return 0;
  }

  async getConversationList(offset: number = 0, limit: number = 28): Promise<{ list: GptConversationItem[]; total: number } | null> {
    if (!this._authorization) {
      console.log('[GPT] getConversationList skipped: no authorization');
      return null;
    }

    await this.refreshToken();

    const headers: Record<string, string> = {
      ...this.buildBaseHeaders(),
      'x-openai-target-path': '/backend-api/conversations',
      'x-openai-target-route': '/backend-api/conversations',
    };

    const params = new URLSearchParams({
      offset: String(offset),
      limit: String(limit),
      order: 'updated',
      is_archived: 'false',
      is_starred: 'false',
    });

    try {
      const response = await fetch(`${this.getBaseUrl()}/backend-api/conversations?${params}`, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(30000),
        ...(await this.getFetchOptions()),
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        console.error('[GPT] getConversationList failed:', response.status, errorText.substring(0, 200));
        return null;
      }

      const data = await response.json() as Record<string, unknown>;
      const items = data.items as Array<Record<string, unknown>> | undefined;
      const total = (data.total as number) ?? 0;

      if (!Array.isArray(items)) {
        console.log('[GPT] getConversationList: items is not an array');
        return { list: [], total: 0 };
      }

      const list: GptConversationItem[] = items.map((item) => ({
        conversationId: String(item.id ?? ''),
        title: String(item.title ?? ''),
        createTime: String(item.create_time ?? ''),
        updateTime: String(item.update_time ?? ''),
      }));

      console.log(`[GPT] getConversationList: found ${list.length} items, total: ${total}`);
      return { list, total };
    } catch (err) {
      console.error('[GPT] getConversationList error:', err);
      return null;
    }
  }

  async deleteConversation(): Promise<boolean> {
    if (!this._conversationId) {
      console.log('[GPT] deleteConversation skipped: no conversationId');
      return false;
    }
    return this.deleteConversationById(this._conversationId);
  }

  async deleteConversationById(conversationId: string): Promise<boolean> {
    if (!this._authorization) {
      console.log('[GPT] deleteConversationById skipped: no authorization');
      return false;
    }

    await this.refreshToken();

    const headers: Record<string, string> = {
      ...this.buildBaseHeaders(),
      'content-type': 'application/json',
      'x-openai-target-path': `/backend-api/conversation/${conversationId}`,
      'x-openai-target-route': '/backend-api/conversation/{conversation_id}',
    };

    try {
      const response = await fetch(`${this.getBaseUrl()}/backend-api/conversation/${conversationId}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ is_visible: false }),
        signal: AbortSignal.timeout(30000),
        ...(await this.getFetchOptions()),
      });

      console.log('[GPT] deleteConversationById:', conversationId, 'status:', response.status);
      return response.ok;
    } catch (err) {
      console.error('[GPT] deleteConversationById failed:', err);
      return false;
    }
  }

  async getDialogList(conversationId: string): Promise<GptDialogItem[] | null> {
    if (!this._authorization) {
      console.log('[GPT] getDialogList skipped: no authorization');
      return null;
    }

    await this.refreshToken();

    const headers: Record<string, string> = {
      ...this.buildBaseHeaders(),
      'x-openai-target-path': `/backend-api/conversation/${conversationId}`,
      'x-openai-target-route': '/backend-api/conversation/{conversation_id}',
    };

    try {
      const response = await fetch(`${this.getBaseUrl()}/backend-api/conversation/${conversationId}`, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(30000),
        ...(await this.getFetchOptions()),
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        console.error('[GPT] getDialogList failed:', response.status, errorText.substring(0, 200));
        return null;
      }

      const data = await response.json() as Record<string, unknown>;
      const mapping = data.mapping as Record<string, Record<string, unknown>> | undefined;

      if (!mapping) {
        console.log('[GPT] getDialogList: no mapping found');
        return [];
      }

      // Build a linear message chain from the tree structure
      // Find the root node (no parent), then follow children
      const nodes: Array<{ id: string; node: Record<string, unknown> }> = [];
      for (const [id, node] of Object.entries(mapping)) {
        nodes.push({ id, node });
      }

      // Find root node (parent is null)
      const root = nodes.find(n => !n.node.parent);
      if (!root) {
        console.log('[GPT] getDialogList: no root node found');
        return [];
      }

      // Traverse the tree depth-first to get message order
      const messages: GptDialogItem[] = [];
      const visited = new Set<string>();

      const traverse = (nodeId: string) => {
        if (visited.has(nodeId)) return;
        visited.add(nodeId);

        const node = mapping[nodeId];
        if (!node) return;

        const message = node.message as Record<string, unknown> | undefined;
        if (message) {
          const author = message.author as Record<string, unknown> | undefined;
          const content = message.content as Record<string, unknown> | undefined;
          const role = author?.role as string | undefined;
          const createTime = (message.create_time as number) ?? 0;

          // Extract text from content.parts
          let text = '';
          if (content?.parts && Array.isArray(content.parts)) {
            text = content.parts
              .filter((p: unknown) => typeof p === 'string')
              .join('');
          } else if (typeof content?.text === 'string') {
            text = content.text;
          }

          // Only include user and assistant messages with actual content
          if ((role === 'user' || role === 'assistant') && text.trim()) {
            messages.push({
              dialogId: String(message.id ?? nodeId),
              role: role!,
              content: text,
              createTime: Math.floor(createTime * 1000),
            });
          }
        }

        // Follow children
        const children = node.children as string[] | undefined;
        if (Array.isArray(children)) {
          for (const childId of children) {
            traverse(childId);
          }
        }
      };

      traverse(root.id);

      console.log(`[GPT] getDialogList: extracted ${messages.length} messages from conversation ${conversationId}`);
      return messages;
    } catch (err) {
      console.error('[GPT] getDialogList error:', err);
      return null;
    }
  }

  abort(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }
}
