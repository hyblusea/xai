import type { Message, LLMConfig, StreamChunk } from '@xai/shared';
import type { HttpRequest, LLMAdapter } from './types.js';
import { randomUUID, createHash } from './crypto-polyfill.js';

export interface ZaiAdapterOptions {
  /** JWT token from chat.z.ai (Bearer auth). */
  token?: string;
  /** Optional cookies (e.g. acw_tc, ssxmod_itna). */
  cookies?: string;
  /** Optional single-use captcha_verify_param (base64 JSON from Aliyun TRACELESS).
   *  Deprecated — use captchaMinter instead for automatic minting. */
  captchaParam?: string;
  /** Region: 'domestic' or 'overseas'. */
  region?: string;
  /** Callback that mints a fresh captcha_verify_param on demand.
   *  When provided, translateInput will call this before each request
   *  to obtain a fresh single-use param automatically. */
  captchaMinter?: () => Promise<string>;
}

export interface ZaiConversationItem {
  conversationId: string;
  title: string;
  createTime: string;
  updateTime: string;
}

export interface ZaiDialogItem {
  dialogId: string;
  role: string;
  content: string;
  createTime: number;
}

/** A single message node in the Z.ai chat history tree. */
export interface ZaiHistoryMessage {
  id: string;
  parentId: string | null;
  childrenIds: string[];
  role: string;
  timestamp: number;
  content?: string;
  models?: string[];
}

/** The history section returned by GET /api/v1/chats/{id}. */
export interface ZaiChatHistory {
  chatId: string;
  title: string;
  models: string[];
  messages: ZaiHistoryMessage[];
  currentMessageId: string;
}

const ZAI_BASE = 'https://chat.z.ai';
const ZAI_FE_VERSION = 'prod-fe-1.1.66';
// Mobile UA — matches glm2api; the captcha SDK fingerprint is independent of this.
const ZAI_USER_AGENT =
  'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Mobile Safari/537.36';
const ZAI_PAGE_TITLE = 'Z.ai';

// Signing constants — reverse-engineered from the prod frontend bundle (prod-fe-1.1.66).
// See glm2api-main/glm2api/signing.py for the full derivation.
const SIGN_SECRET = 'key-@@@@)))()((9))-xxxx&&&%%%%%';
const BUCKET_MS = 5 * 60 * 1000;

// --------------------------------------------------------------------------- //
// JWT helpers
// --------------------------------------------------------------------------- //
function base64UrlDecode(seg: string): string {
  let s = seg.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64').toString('utf-8');
}

function jwtPayload(token: string): Record<string, unknown> {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return {};
    return JSON.parse(base64UrlDecode(parts[1]));
  } catch {
    return {};
  }
}

function userIdOf(token: string): string {
  return String(jwtPayload(token).id ?? '');
}

// --------------------------------------------------------------------------- //
// HMAC-SHA256 (built on top of the sync createHash polyfill)
// --------------------------------------------------------------------------- //
function hmacSha256Hex(key: string | Uint8Array, msg: string): string {
  const blockSize = 64;
  let keyBytes: Uint8Array;
  if (typeof key === 'string') {
    keyBytes = new TextEncoder().encode(key);
  } else {
    keyBytes = key;
  }
  if (keyBytes.length > blockSize) {
    keyBytes = new Uint8Array(createHash('sha256').update(Buffer.from(keyBytes)).digest() as Buffer);
  }
  const paddedKey = new Uint8Array(blockSize);
  paddedKey.set(keyBytes);

  const ipad = new Uint8Array(blockSize);
  const opad = new Uint8Array(blockSize);
  for (let i = 0; i < blockSize; i++) {
    ipad[i] = paddedKey[i] ^ 0x36;
    opad[i] = paddedKey[i] ^ 0x5c;
  }

  const msgBytes = new TextEncoder().encode(msg);
  const innerInput = new Uint8Array(ipad.length + msgBytes.length);
  innerInput.set(ipad);
  innerInput.set(msgBytes, ipad.length);
  const innerHash = new Uint8Array(createHash('sha256').update(Buffer.from(innerInput)).digest() as Buffer);

  const outerInput = new Uint8Array(opad.length + innerHash.length);
  outerInput.set(opad);
  outerInput.set(innerHash, opad.length);
  return createHash('sha256').update(Buffer.from(outerInput)).digest('hex') as string;
}

// --------------------------------------------------------------------------- //
// Request signing
// --------------------------------------------------------------------------- //
function buildSortedPayload(timestampMs: number, requestId: string, userId: string): string {
  // Keys sorted ascending (ascii): requestId, timestamp, user_id
  return `requestId,${requestId},timestamp,${timestampMs},user_id,${userId}`;
}

function signRequest(prompt: string, requestId: string, userId: string, timestampMs: number): string {
  const sortedPayload = buildSortedPayload(timestampMs, requestId, userId);
  const p = Buffer.from(prompt, 'utf-8').toString('base64');
  const msg = `${sortedPayload}|${p}|${timestampMs}`;
  const bucket = Math.floor(timestampMs / BUCKET_MS);
  const derivedKey = hmacSha256Hex(SIGN_SECRET, String(bucket));
  return hmacSha256Hex(derivedKey, msg);
}

// --------------------------------------------------------------------------- //
// Fingerprint query & body builder
// --------------------------------------------------------------------------- //
function buildFingerprintQuery(
  token: string,
  userId: string,
  tsMs: number,
  requestId: string,
): Record<string, string> {
  // Mobile fingerprint — matches glm2api (mobile Android client).
  return {
    timestamp: String(tsMs),
    requestId,
    user_id: userId,
    version: '0.0.1',
    platform: 'web',
    token,
    user_agent: ZAI_USER_AGENT,
    language: 'en-US',
    languages: 'en-US',
    timezone: 'Asia/Dhaka',
    cookie_enabled: 'true',
    screen_width: '360',
    screen_height: '800',
    screen_resolution: '360x800',
    viewport_height: '656',
    viewport_width: '360',
    viewport_size: '360x656',
    color_depth: '24',
    pixel_ratio: '2',
    current_url: `${ZAI_BASE}/`,
    pathname: '/',
    search: '',
    hash: '',
    host: 'chat.z.ai',
    hostname: 'chat.z.ai',
    protocol: 'https:',
    referrer: '',
    title: ZAI_PAGE_TITLE,
    timezone_offset: '-360',
    is_mobile: 'true',
    is_touch: 'true',
    max_touch_points: '2',
    browser_name: 'Chrome',
    os_name: 'Android',
    signature_timestamp: String(tsMs),
  };
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function buildBody(
  model: string,
  messages: Array<{ role: string; content: string }>,
  prompt: string,
  enableThinking: boolean,
  reasoningEffort: string | undefined,
  captchaParam: string | undefined,
  chatId: string,
  messageId: string,
  userMessageId: string,
  parentMessageId: string | null,
): Record<string, unknown> {
  const now = new Date();
  const dateStr = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
  const timeStr = `${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`;
  const weekday = now.toLocaleDateString('en-US', { weekday: 'long' });
  const datetime = `${dateStr} ${timeStr}`;

  const features: Record<string, unknown> = {
    image_generation: false,
    web_search: false,
    auto_web_search: false,
    preview_mode: true,
    flags: [],
    vlm_tools_enable: false,
    vlm_web_search_enable: false,
    vlm_website_mode: false,
    enable_thinking: enableThinking,
  };
  if (enableThinking && reasoningEffort) {
    features.reasoning_effort = reasoningEffort;
  }

  const body: Record<string, unknown> = {
    stream: true,
    model,
    messages,
    signature_prompt: prompt,
    params: {},
    extra: {},
    features,
    variables: {
      '{{USER_NAME}}': 'User',
      '{{USER_LOCATION}}': 'Unknown',
      '{{CURRENT_DATETIME}}': datetime,
      '{{CURRENT_DATE}}': dateStr,
      '{{CURRENT_TIME}}': timeStr,
      '{{CURRENT_WEEKDAY}}': weekday,
      '{{CURRENT_TIMEZONE}}': 'Asia/Dhaka',
      '{{USER_LANGUAGE}}': 'en-US',
    },
    chat_id: chatId,
    id: messageId,
    background_tasks: { title_generation: false, tags_generation: false },
  };
  if (captchaParam) {
    body.captcha_verify_param = captchaParam;
  }
  return body;
}

function buildHeaders(token: string, cookies: string | undefined, signature: string, region: string): Record<string, string> {
  // Match glm2api's header set exactly — no Cookie, no sec-ch-ua, no Sec-Fetch-*.
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    Accept: '*/*',
    'Accept-Language': 'en-US',
    'X-FE-Version': ZAI_FE_VERSION,
    'X-Region': region,
    'X-Signature': signature,
    'User-Agent': ZAI_USER_AGENT,
    Origin: ZAI_BASE,
  };
  // glm2api sends no Cookie header; the token in Authorization + query is sufficient.
  // Only add cookies if explicitly provided (e.g. acw_tc for anti-bot).
  if (cookies) {
    headers['Cookie'] = cookies;
  }
  return headers;
}

function buildQueryString(query: Record<string, string>): string {
  return Object.entries(query)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

function lastUserText(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'user') {
      return m.content.trim();
    }
  }
  return '';
}

// --------------------------------------------------------------------------- //
// Adapter
// --------------------------------------------------------------------------- //
export class ZaiAdapter implements LLMAdapter {
  private options: ZaiAdapterOptions;
  private _chatId: string;
  private _lastMessageId: string | null = null;
  private abortController: AbortController | null = null;

  constructor(options: ZaiAdapterOptions = {}) {
    this.options = { ...options };
    this._chatId = '';
  }

  get chatId(): string {
    return this._chatId;
  }

  get conversationId(): string {
    return this._chatId;
  }

  get token(): string {
    return this.options.token || '';
  }

  resetSession(): void {
    this._chatId = '';
    this._lastMessageId = null;
  }

  loadSession(chatId: string, lastMessageId?: string): void {
    this._chatId = chatId;
    this._lastMessageId = lastMessageId ?? null;
  }

  /** Load a session from the server, fetching the full chat history and
   *  setting the adapter state so subsequent messages continue the thread. */
  async loadSessionFromServer(chatId: string): Promise<ZaiChatHistory | null> {
    const history = await this.getChatHistory(chatId);
    if (history) {
      this._chatId = history.chatId;
      this._lastMessageId = history.currentMessageId;
    }
    return history;
  }

  private getRegion(): string {
    return this.options.region || 'overseas';
  }

  async translateInput(messages: Message[], config: LLMConfig): Promise<HttpRequest> {
    const token = this.token;
    if (!token) {
      throw new Error('Z.ai Token not configured, please add JWT Token in Settings');
    }

    const model = config.model || 'glm-5.2';
    const enableThinking = config.options?.enableThinking !== false;
    // 'off' is the UI-level "reasoning disabled" marker (used by the cline/openai
    // providers) — treat it as unset here so an inherited value never produces an
    // invalid reasoning_effort. Thinking on/off for zai is controlled by enableThinking.
    const rawReasoningEffort = config.options?.reasoningEffort as string | undefined;
    const reasoningEffort = (rawReasoningEffort && rawReasoningEffort !== 'off' ? rawReasoningEffort : undefined) || 'high';

    // Start a new chat if we don't have one
    if (!this._chatId) {
      this._chatId = randomUUID();
    }

    // Build the user content: combine system prompt + last user message (and tool results)
    const systemMessage = messages.find(m => m.role === 'system');
    const nonSystemMessages = messages.filter(m => m.role !== 'system');

    // Collect trailing tool results
    const toolResults: Message[] = [];
    for (let i = nonSystemMessages.length - 1; i >= 0; i--) {
      if (nonSystemMessages[i].role === 'tool') {
        toolResults.unshift(nonSystemMessages[i]);
      } else {
        break;
      }
    }

    let userContent: string;
    if (toolResults.length > 0) {
      const parts = toolResults.map(r => `[Tool Result] ${r.toolName || 'unknown'}\n${r.content}`);
      userContent = parts.join('\n\n') + '\n\nBased on the tool results above, continue your response.';
    } else {
      const lastUserMessage = [...nonSystemMessages].reverse().find(m => m.role === 'user');
      if (lastUserMessage) {
        if (systemMessage) {
          userContent = `${systemMessage.content}\n\n---\n\nUser: ${lastUserMessage.content}`;
        } else {
          userContent = lastUserMessage.content;
        }
      } else {
        userContent = '';
      }
    }

    const prompt = lastUserText(messages);
    const userId = userIdOf(token);
    const tsMs = Date.now();
    const requestId = randomUUID();
    const messageId = randomUUID();
    const userMessageId = randomUUID();
    const parentMessageId = this._lastMessageId;

    const signature = signRequest(prompt, requestId, userId, tsMs);
    const query = buildFingerprintQuery(token, userId, tsMs, requestId);

    // Mint a fresh captcha param automatically if a minter is provided
    let captchaParam = this.options.captchaParam;
    if (this.options.captchaMinter) {
      try {
        captchaParam = await this.options.captchaMinter();
        console.log('[Zai] Minted fresh captcha param:', captchaParam?.substring(0, 40) + '...');
      } catch (err) {
        console.error('[Zai] Captcha minting failed:', err);
        // Continue without captcha — the request may still work or will return
        // FRONTEND_CAPTCHA_REQUIRED which the user can see as an error
      }
    }

    const body = buildBody(
      model,
      [{ role: 'user', content: userContent }],
      prompt,
      enableThinking,
      reasoningEffort,
      captchaParam,
      this._chatId,
      messageId,
      userMessageId,
      parentMessageId,
    );

    // Save the message id to use as parent for the next turn
    this._lastMessageId = messageId;

    const headers = buildHeaders(token, this.options.cookies, signature, this.getRegion());
    const url = `${ZAI_BASE}/api/v2/chat/completions?${buildQueryString(query)}`;

    return {
      url,
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      conversationId: this._chatId,
    };
  }

  translateOutput(response: unknown): Message {
    const data = response as Record<string, unknown>;
    if (data.choices && Array.isArray(data.choices)) {
      const choice = data.choices[0] as Record<string, unknown>;
      const message = choice.message as Record<string, unknown> | undefined;
      return {
        role: 'assistant',
        content: (message?.content as string) ?? '',
        timestamp: Date.now(),
      };
    }
    const content =
      (data.content as string) ??
      (data.text as string) ??
      (typeof data === 'string' ? (data as string) : JSON.stringify(data));
    return { role: 'assistant', content, timestamp: Date.now() };
  }

  async *translateStream(stream: AsyncIterable<Buffer>): AsyncIterable<StreamChunk> {
    let buffer = '';
    // 流式 UTF-8 解码器：暂存跨 chunk 被切断的多字节字符，避免单独 decode 产生 U+FFFD 乱码。
    const decoder = new TextDecoder('utf-8');
    let anySSESeen = false;
    let yieldedContent = false;

    for await (const chunk of stream) {
      buffer += decoder.decode(chunk, { stream: true });
      const parts = buffer.split('\n\n');
      buffer = parts.pop() ?? '';

      for (const part of parts) {
        if (part.includes('data:')) anySSESeen = true;
        for (const c of this.parseSSEBlock(part)) {
          if (c.type === 'thinking' || c.type === 'text') {
            yieldedContent = true;
          }
          // Spurious post-completion INTERNAL_ERROR — Z.ai sends this after the
          // answer has fully streamed (see glm2api zai_client.py). Ignore it
          // once we've already yielded real content.
          if (c.type === 'error' && yieldedContent && /INTERNAL_ERROR/i.test(c.content)) {
            continue;
          }
          yield c;
        }
      }
    }

    // 冲刷解码器缓存的不完整字节（正常结束时应为空字符串）。
    buffer += decoder.decode();

    if (buffer.trim()) {
      if (buffer.includes('data:')) anySSESeen = true;
      for (const c of this.parseSSEBlock(buffer)) {
        if (c.type === 'thinking' || c.type === 'text') {
          yieldedContent = true;
        }
        if (c.type === 'error' && yieldedContent && /INTERNAL_ERROR/i.test(c.content)) {
          continue;
        }
        yield c;
      }
    }

    if (!anySSESeen) {
      const errorMsg = this.extractJsonError(buffer);
      if (errorMsg) {
        yield { type: 'error', content: errorMsg };
        return;
      }
    }

    yield { type: 'done', content: '' };
  }

  private extractJsonError(body: string): string | null {
    if (!body || !body.startsWith('{')) return null;
    try {
      const data = JSON.parse(body) as Record<string, unknown>;
      const detail = (data.detail as string) || (data.message as string) || (data.error as string);
      if (detail) {
        return `Z.ai error: ${detail}`;
      }
    } catch {
      // not JSON
    }
    return null;
  }

  private *parseSSEBlock(block: string): Generator<StreamChunk> {
    const lines = block.split('\n');
    let dataStr = '';
    for (const line of lines) {
      if (line.startsWith('data:')) {
        dataStr += line.substring(5).trim();
      }
    }
    if (!dataStr) return;

    if (dataStr === '[DONE]') return;

    try {
      const parsed = JSON.parse(dataStr) as Record<string, unknown>;
      const type = parsed.type as string;

      if (type !== 'chat:completion') {
        // Other event types (e.g. chat:title, chat:tags) — ignore
        return;
      }

      const data = parsed.data as Record<string, unknown> | undefined;
      if (!data || typeof data !== 'object') return;

      // Error handling
      const err = data.error as Record<string, unknown> | undefined;
      if (err) {
        const code = (err.code as string) || (err.error_code as string) || '';
        const detail = (err.detail as string) || JSON.stringify(err);
        if (code === 'FRONTEND_CAPTCHA_REQUIRED' || code === 'CAPTCHA_VERIFICATION_FAILED') {
          yield {
            type: 'error',
            content: `Z.ai captcha required (${code}). Please provide a fresh captcha_verify_param in Settings. Detail: ${detail}`,
          };
        } else if (code === '403' || /user level/i.test(detail)) {
          yield {
            type: 'error',
            content: `Z.ai model access denied (${code}): ${detail}. Your token tier may be too low for this model.`,
          };
        } else {
          yield { type: 'error', content: `Z.ai error (${code}): ${detail}` };
        }
        return;
      }

      const phase = data.phase as string | undefined;
      const deltaContent = data.delta_content as string | undefined;

      if (phase === 'thinking' && deltaContent) {
        yield { type: 'thinking', content: deltaContent };
      } else if (phase === 'answer' && deltaContent) {
        yield { type: 'text', content: deltaContent };
      } else if (phase === 'done') {
        // Stream complete
        return;
      }
      // phase 'other' carries usage stats — ignore
    } catch {
      // ignore non-JSON lines
    }
  }

  abort(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }

  // ----------------------------------------------------------------------- //
  // Conversation management
  // ----------------------------------------------------------------------- //
  private buildAuthHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'Accept-Language': 'en-US',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.token}`,
      Origin: ZAI_BASE,
      'User-Agent': ZAI_USER_AGENT,
      'X-Region': this.getRegion(),
    };
    if (this.options.cookies) {
      headers['Cookie'] = this.options.cookies;
    }
    return headers;
  }

  async getConversationList(
    pageNum: number = 1,
    _pageSize: number = 20,
  ): Promise<{ list: ZaiConversationItem[]; total: number } | null> {
    if (!this.token) {
      console.log('[Zai] getConversationList skipped: no token');
      return null;
    }

    try {
      const response = await fetch(`${ZAI_BASE}/api/v1/chats/?page=${pageNum}&type=default`, {
        method: 'GET',
        headers: this.buildAuthHeaders(),
        signal: AbortSignal.timeout(30000),
      });

      if (!response.ok) {
        console.error('[Zai] getConversationList failed:', response.status);
        return null;
      }

      const data = await response.json();
      const list = Array.isArray(data) ? data : [];
      const total = list.length;

      return {
        list: list.map((c: Record<string, unknown>) => ({
          conversationId: String(c.id ?? ''),
          title: String(c.title ?? ''),
          createTime: String(c.created_at ?? ''),
          updateTime: String(c.updated_at ?? ''),
        })),
        total,
      };
    } catch (err) {
      console.error('[Zai] getConversationList error:', err);
      return null;
    }
  }

  async getDialogList(conversationId: string): Promise<ZaiDialogItem[] | null> {
    if (!this.token) {
      return null;
    }

    // Z.ai stores messages in a tree structure inside the chat object,
    // not via a separate /messages endpoint. Reuse getChatHistory to
    // correctly parse the message tree and flatten it into a dialog list.
    const history = await this.getChatHistory(conversationId);
    if (!history) {
      return null;
    }

    const messages: ZaiDialogItem[] = [];
    for (const msg of history.messages) {
      const role = msg.role === 'assistant' ? 'assistant' : 'user';
      const content = msg.content ?? '';
      if (content) {
        messages.push({
          dialogId: msg.id,
          role,
          content,
          createTime: msg.timestamp,
        });
      }
    }

    return messages;
  }

  async getChatHistory(chatId: string): Promise<ZaiChatHistory | null> {
    if (!this.token) {
      console.log('[Zai] getChatHistory skipped: no token');
      return null;
    }
    if (!chatId) {
      console.log('[Zai] getChatHistory skipped: no chatId');
      return null;
    }

    try {
      const response = await fetch(`${ZAI_BASE}/api/v1/chats/${chatId}`, {
        method: 'GET',
        headers: this.buildAuthHeaders(),
        signal: AbortSignal.timeout(30000),
      });

      if (!response.ok) {
        console.error('[Zai] getChatHistory failed:', response.status);
        return null;
      }

      const data = (await response.json()) as Record<string, unknown>;
      const chat = data.chat as Record<string, unknown> | undefined;
      if (!chat) {
        console.error('[Zai] getChatHistory: no chat field in response');
        return null;
      }

      const history = chat.history as Record<string, unknown> | undefined;
      if (!history) {
        console.error('[Zai] getChatHistory: no history field in response');
        return null;
      }

      const msgMap = history.messages as Record<string, Record<string, unknown>> | undefined;
      const currentId = String(history.currentId ?? '');

      if (!msgMap || typeof msgMap !== 'object') {
        console.error('[Zai] getChatHistory: invalid messages field');
        return null;
      }

      // Traverse the tree from currentId back to root via parentId, then reverse
      const ordered: ZaiHistoryMessage[] = [];
      let cursor: string | null = currentId;
      const visited = new Set<string>();

      while (cursor && !visited.has(cursor)) {
        visited.add(cursor);
        const node: Record<string, unknown> | undefined = msgMap[cursor];
        if (!node) break;

        ordered.push({
          id: String(node.id ?? cursor),
          parentId: node.parentId ? String(node.parentId) : null,
          childrenIds: Array.isArray(node.childrenIds)
            ? (node.childrenIds as string[]).map(String)
            : [],
          role: String(node.role ?? ''),
          timestamp: Number(node.timestamp ?? 0),
          content: node.content != null ? String(node.content) : undefined,
          models: Array.isArray(node.models)
            ? (node.models as string[]).map(String)
            : undefined,
        });

        cursor = node.parentId ? String(node.parentId) : null;
      }

      // Reverse so messages are in chronological order (root → leaf)
      ordered.reverse();

      const models = Array.isArray(chat.models)
        ? (chat.models as string[]).map(String)
        : [];

      return {
        chatId: String(data.id ?? chatId),
        title: String(data.title ?? ''),
        models,
        messages: ordered,
        currentMessageId: currentId,
      };
    } catch (err) {
      console.error('[Zai] getChatHistory error:', err);
      return null;
    }
  }

  async deleteConversation(): Promise<boolean> {
    return this.deleteConversationById(this._chatId);
  }

  async deleteConversationById(conversationId: string): Promise<boolean> {
    if (!this.token) {
      console.log('[Zai] deleteConversationById skipped: no token');
      return false;
    }
    if (!conversationId) {
      console.log('[Zai] deleteConversationById skipped: no chatId');
      return false;
    }

    try {
      const response = await fetch(`${ZAI_BASE}/api/v1/chats/${conversationId}`, {
        method: 'DELETE',
        headers: this.buildAuthHeaders(),
        signal: AbortSignal.timeout(15000),
      });

      if (!response.ok) {
        console.error('[Zai] deleteConversation failed:', response.status);
        return false;
      }

      console.log('[Zai] Delete chat:', conversationId, 'status:', response.status);
      if (this._chatId === conversationId) {
        this._chatId = '';
        this._lastMessageId = null;
      }
      return true;
    } catch (err) {
      console.error('[Zai] deleteConversation failed:', err);
      return false;
    }
  }
}
