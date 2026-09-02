import type { Message, LLMConfig, StreamChunk } from '@xai/shared';
import type { HttpRequest, LLMAdapter } from './types.js';
import { randomUUID } from './crypto-polyfill.js';
import { createHash } from './crypto-polyfill.js';
import { StringDecoder } from 'string_decoder';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';

export interface GeminiAdapterOptions {
  cookies?: string;
  sapisid?: string;
  authUser?: string;
  geminiBl?: string;
  xsrfToken?: string;
}

export interface GeminiConversationItem {
  conversationId: string;
  title: string;
  createTime: string;
  updateTime: string;
}

export interface GeminiDialogItem {
  dialogId: string;
  role: string;
  content: string;
  createTime: number;
}

// ─── Model mapping: MODE_CATEGORY enum from Gemini JS source ─────────────────
// 1=FAST, 2=THINKING, 3=PRO, 4=AUTO, 5=FAST_DYNAMIC_THINKING, 6=FLASH_LITE
const GEMINI_MODELS: Record<string, { mode: number; think: number; desc: string }> = {
  'gemini-3.5-flash':           { mode: 1, think: 4, desc: 'Fast general-purpose model' },
  'gemini-3.5-flash-thinking':  { mode: 2, think: 0, desc: 'Deep thinking mode' },
  'gemini-3.1-pro':             { mode: 3, think: 4, desc: 'Pro model' },
  'gemini-auto':                { mode: 4, think: 4, desc: 'Auto model selection' },
  'gemini-3.5-flash-thinking-lite': { mode: 5, think: 0, desc: 'Dynamic thinking with adaptive depth' },
  'gemini-flash-lite':          { mode: 6, think: 4, desc: 'Lightweight fast model' },
};

const DEFAULT_GEMINI_BL = 'boq_assistant-bard-web-server_20260603.11_p0';
const DEFAULT_BASE_URL = 'https://gemini.google.com';

// ─── Local conversation storage (tracks Gemini server-side session IDs) ──────
interface LocalConversation {
  id: string;
  title: string;
  messages: GeminiDialogItem[];
  createTime: number;
  updateTime: number;
  // Gemini server-side session context
  fSid: string;                   // f.sid from URL (session ID)
  conversationId: string;         // inner[2][0] e.g. "c_49f0024ccdd312de"
  replyId: string;                // inner[2][1] e.g. "r_a41491a7d2213b50"
  replyContextId: string;         // inner[2][2] e.g. "rc_f298f92cec03f89a"
  sessionToken: string;           // inner[2][9] e.g. "AwAAAAAAAAAQANM7..."
  continuationToken: string;      // inner[3] long base64 token
  hashId: string;                 // inner[4] e.g. "f57a362cb3a31136..."
  atToken: string;                // at= parameter for XSRF
}

export class GeminiAdapter implements LLMAdapter {
  private options: GeminiAdapterOptions;
  private abortController: AbortController | null = null;

  // Local conversation management (tracks Gemini server-side session context)
  private _conversations: LocalConversation[] = [];
  private _currentConversation: LocalConversation | null = null;

  // Init() state — extracted from gemini.google.com/app page HTML
  private _initialized = false;
  private _initAtToken: string | null = null;  // SNlM0e from page HTML
  private _initBl: string | null = null;       // bl version from page HTML

  constructor(options: GeminiAdapterOptions = {}) {
    this.options = { ...options };
    this.loadLocalConversations();
  }

  // ─── Init(): fetch SNlM0e (at token) and bl from gemini.google.com/app ──────

  /**
   * Initializes the adapter by fetching the Gemini app page and extracting:
   *   - SNlM0e: XSRF token used as `at` parameter for all API calls
   *   - bl: build version string (auto-detects latest version)
   *
   * Call this once before the first request. Auto-called if not invoked manually.
   * Inspired by Mag1cFall/Gemini-Web2API Go project's Init() method.
   */
  async init(): Promise<void> {
    if (this._initialized) return;

    const accountPrefix = this.options.authUser ? `/u/${this.options.authUser}` : '';
    const url = `${DEFAULT_BASE_URL}${accountPrefix}/app`;

    try {
      const headers: Record<string, string> = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'same-origin',
      };
      if (this.options.cookies) {
        headers['Cookie'] = this.options.cookies;
      }
      // Add SAPISIDHASH auth — required for the page to return SNlM0e token
      const sapisid = this.options.sapisid || (this.options.cookies ? this.extractSapisidFromCookies(this.options.cookies) : null);
      if (sapisid) {
        headers['Authorization'] = this.makeSapisidHash(sapisid);
      }

      const response = await fetch(url, { method: 'GET', headers });
      if (response.status !== 200) {
        console.warn(`[Gemini] Init failed: HTTP ${response.status}`);
        return;
      }

      const html = await response.text();
      console.log(`[Gemini] Init page: ${html.length} chars`);

      // Extract SNlM0e (at token / XSRF) — try both normal and escaped quotes
      const snlmPatterns = [
        /"SNlM0e":"(.*?)"/,
        /\\"SNlM0e\\":\\"(.*?)\\"/,
      ];
      for (const pattern of snlmPatterns) {
        const m = html.match(pattern);
        if (m) {
          this._initAtToken = m[1];
          break;
        }
      }

      // Extract bl (version) — try multiple patterns
      let bl: string | null = null;
      const blPatterns = [
        /"bl":"(.*?)"/,
        /\\"bl\\":\\"(.*?)\\"/,
        /data-bl="(.*?)"/,
        /boq_assistant-bard-web-server_[a-zA-Z0-9._]+/,
      ];
      for (const pattern of blPatterns) {
        const m = html.match(pattern);
        if (m) {
          bl = m[1] || m[0];
          break;
        }
      }
      if (bl) {
        this._initBl = bl;
      }

      this._initialized = true;
      console.log(`[Gemini] Init complete: at=${this._initAtToken ? '✅' : '❌'}, bl=${this._initBl || 'fallback'}`);
    } catch (err) {
      console.warn('[Gemini] Init failed:', err instanceof Error ? err.message : err);
    }
  }

  /** Returns the effective at token (init-extracted > manually configured) */
  private getAtToken(): string | null {
    return this._initAtToken || this.options.xsrfToken || null;
  }

  /** Returns the effective bl version (init-extracted > configured > default) */
  private getBl(): string {
    return this._initBl || this.options.geminiBl || DEFAULT_GEMINI_BL;
  }

  // ─── Session management ──────────────────────────────────────────────────────

  get conversationId(): string | null {
    return this._currentConversation?.id ?? null;
  }

  resetSession(): void {
    this._currentConversation = null;
  }

  loadSession(conversationId: string): void {
    const conv = this._conversations.find(c => c.id === conversationId);
    if (conv) {
      this._currentConversation = conv;
    }
  }

  // ─── Local conversation persistence ──────────────────────────────────────────

  private getStoragePath(): string {
    return join(homedir(), '.xai', 'gemini-conversations.json');
  }

  private loadLocalConversations(): void {
    try {
      const storagePath = this.getStoragePath();
      if (existsSync(storagePath)) {
        const data = JSON.parse(readFileSync(storagePath, 'utf-8'));
        this._conversations = data || [];
      }
    } catch {
      this._conversations = [];
    }
  }

  private saveLocalConversations(): void {
    try {
      const storagePath = this.getStoragePath();
      const dir = dirname(storagePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      writeFileSync(storagePath, JSON.stringify(this._conversations, null, 2), 'utf-8');
    } catch (err) {
      console.error('[Gemini] Failed to save conversations:', err);
    }
  }

  // ─── Conversation CRUD ───────────────────────────────────────────────────────

  private ensureCurrentConversation(): LocalConversation {
    if (!this._currentConversation) {
      this._currentConversation = {
        id: randomUUID().replace(/-/g, ''),
        title: 'New Conversation',
        messages: [],
        createTime: Date.now(),
        updateTime: Date.now(),
        fSid: '',
        conversationId: '',
        replyId: '',
        replyContextId: '',
        sessionToken: '',
        continuationToken: '',
        hashId: '',
        atToken: '',
      };
      this._conversations.unshift(this._currentConversation);
      this.saveLocalConversations();
    }
    return this._currentConversation;
  }

  saveCurrentMessage(role: string, content: string): void {
    const conv = this.ensureCurrentConversation();
    conv.messages.push({
      dialogId: randomUUID().replace(/-/g, ''),
      role,
      content,
      createTime: Date.now(),
    });
    conv.updateTime = Date.now();
    this.saveLocalConversations();
  }

  async getConversationList(pageNum: number = 1, pageSize: number = 20): Promise<{ list: GeminiConversationItem[]; total: number } | null> {
    this.loadLocalConversations();
    const start = (pageNum - 1) * pageSize;
    const end = start + pageSize;
    const sliced = this._conversations.slice(start, end);

    const list: GeminiConversationItem[] = sliced.map(c => ({
      conversationId: c.id,
      title: c.title,
      createTime: new Date(c.createTime).toISOString(),
      updateTime: new Date(c.updateTime).toISOString(),
    }));

    return { list, total: this._conversations.length };
  }

  async getDialogList(conversationId: string): Promise<GeminiDialogItem[] | null> {
    // 查找本地会话以获取 Gemini 服务器端 conversationId (c_xxx)
    this.loadLocalConversations();
    const conv = this._conversations.find(c => c.id === conversationId);
    const geminiConvId = conv?.conversationId || conversationId;

    // 优先尝试远程获取（仅当有 c_xxx 格式的 ID 时）
    if (geminiConvId.startsWith('c_')) {
      const remoteDialogs = await this.fetchConversationHistory(geminiConvId);
      if (remoteDialogs && remoteDialogs.length > 0) {
        return remoteDialogs;
      }
    }

    // 回退到本地存储
    if (!conv) return null;
    return conv.messages;
  }

  // ─── Remote conversation history via batchexecute hNvQHb ─────────────────────

  /**
   * 通过 batchexecute hNvQHb 接口从 Gemini 服务器获取会话历史。
   * 响应格式: [[["wrb.fr","hNvQHb","<inner-json>",...]]]
   * Inner JSON: [messageList, ...]
   * 每条消息: [userText, [aiResponse, ...], null, 1, hashId, ...]
   */
  private async fetchConversationHistory(conversationId: string): Promise<GeminiDialogItem[] | null> {
    try {
      // 第一步：获取 at token（首次请求返回 400 + xsrf token）
      const res1 = await this.batchExecuteRequest(conversationId, null);
      if (res1.status === 400) {
        const atToken = this.extractXsrfToken(res1.body);
        if (atToken) {
          // 第二步：携带 at token 重试
          const res2 = await this.batchExecuteRequest(conversationId, atToken);
          if (res2.status === 200) {
            return this.parseHistoryResponse(res2.body);
          }
        }
      } else if (res1.status === 200) {
        return this.parseHistoryResponse(res1.body);
      }
      return null;
    } catch (err) {
      console.error('[Gemini] fetchConversationHistory error:', err);
      return null;
    }
  }

  private async batchExecuteRequest(conversationId: string, atToken: string | null): Promise<{ status: number; body: string }> {
    const bl = this.getBl();
    const reqid = Math.floor(Date.now() / 1000) % 1000000;
    // source-path 使用不带 c_ 前缀的 ID
    const sourceId = conversationId.startsWith('c_') ? conversationId.substring(2) : conversationId;
    const url = `${DEFAULT_BASE_URL}/_/BardChatUi/data/batchexecute?rpcids=hNvQHb&source-path=%2Fapp%2F${sourceId}&bl=${bl}&hl=zh&_reqid=${reqid}&rt=c`;

    // Payload: [[["hNvQHb", "[\"c_xxx\",10,null,1,[0],[4],null,1]", null, "generic"]]]
    const innerPayload = JSON.stringify([conversationId, 10, null, 1, [0], [4], null, 1]);
    const outer = [['hNvQHb', innerPayload, null, 'generic']];

    const params = new URLSearchParams();
    params.set('f.req', JSON.stringify(outer));
    if (atToken) {
      params.set('at', atToken);
    }

    const headers = this.buildHeaders();
    // 使用 fetch 发请求（Electron 环境支持）
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: params.toString(),
    });
    const body = await response.text();
    return { status: response.status, body };
  }

  private extractXsrfToken(responseText: string): string | null {
    const match = responseText.match(/\["xsrf","([^"]+)"/);
    return match ? match[1] : null;
  }

  private parseHistoryResponse(responseText: string): GeminiDialogItem[] | null {
    const lines = responseText.split('\n');
    const dialogs: GeminiDialogItem[] = [];

    for (const line of lines) {
      if (!line.includes('"wrb.fr"') || !line.includes('"hNvQHb"')) continue;
      if (line.length < 200) continue;

      try {
        const arr = JSON.parse(line);
        for (const item of arr) {
          if (!Array.isArray(item)) continue;
          if (item[0] !== 'wrb.fr' || item[1] !== 'hNvQHb') continue;
          const innerStr = item[2];
          if (typeof innerStr !== 'string' || innerStr.length < 50) continue;

          // inner = [[[context],[replyCtx], userMsg, aiResp, userMsg, aiResp, ...]]
          const inner = JSON.parse(innerStr);
          if (!Array.isArray(inner) || !Array.isArray(inner[0])) continue;

          const flat = inner[0];
          console.log(`[Gemini] History flat array length: ${flat.length}`);

          // flat[0] = conversation context, flat[1] = reply context
          // flat[2], flat[4], flat[6], ... = user messages
          // flat[3], flat[5], flat[7], ... = AI responses
          let timestamp = Date.now();
          for (let i = 2; i < flat.length; i++) {
            const elem = flat[i];
            if (!Array.isArray(elem) || elem.length === 0) continue;

            // User message: first element is a string
            if (typeof elem[0] === 'string' && elem[0].length > 0) {
              dialogs.push({
                dialogId: `turn_${i}_user`,
                role: 'user',
                content: elem[0],
                createTime: timestamp++,
              });
              continue;
            }

            // AI response: first element is an array [[rc_xxx, ["text"]]]
            if (Array.isArray(elem[0]) && elem[0].length >= 2) {
              const aiInner = elem[0];
              // aiInner[1] might be the text directly or an array with text
              let aiText = '';
              if (typeof aiInner[1] === 'string') {
                aiText = aiInner[1];
              } else if (Array.isArray(aiInner[1]) && aiInner[1].length > 0 && typeof aiInner[1][0] === 'string') {
                aiText = aiInner[1][0];
              }
              if (aiText) {
                const rcId = typeof aiInner[0] === 'string' ? aiInner[0] : '';
                dialogs.push({
                  dialogId: rcId || `turn_${i}_assistant`,
                  role: 'assistant',
                  content: aiText,
                  createTime: timestamp++,
                });
              }
            }
          }
        }
      } catch {
        // Ignore parse errors
      }
    }

    return dialogs.length > 0 ? dialogs : null;
  }

  async deleteConversation(): Promise<boolean> {
    if (!this._currentConversation) return false;
    return this.deleteConversationById(this._currentConversation.id);
  }

  async deleteConversationById(conversationId: string): Promise<boolean> {
    this.loadLocalConversations();
    const idx = this._conversations.findIndex(c => c.id === conversationId);
    if (idx === -1) return false;
    this._conversations.splice(idx, 1);
    if (this._currentConversation?.id === conversationId) {
      this._currentConversation = null;
    }
    this.saveLocalConversations();
    return true;
  }

  async genTitle(aiResponse: string): Promise<string | null> {
    if (!this._currentConversation) return null;
    // Simple heuristic: take first 40 chars of AI response as title
    const title = aiResponse.replace(/\n/g, ' ').trim().substring(0, 40) || 'New Conversation';
    this._currentConversation.title = title;
    this.saveLocalConversations();
    return title;
  }

  // ─── SAPISID hash for Authorization header ────────────────────────────────────

  private makeSapisidHash(sapisid: string): string {
    const ts = Math.floor(Date.now() / 1000);
    const hash = createHash('sha1')
      .update(`${ts} ${sapisid} https://gemini.google.com`)
      .digest('hex');
    return `SAPISIDHASH ${ts}_${hash}`;
  }

  private extractSapisidFromCookies(cookies: string): string | null {
    const match = cookies.match(/SAPISID=([^;]+)/);
    return match ? match[1] : null;
  }

  // ─── Build Gemini request ─────────────────────────────────────────────────────

  private buildHeaders(): Record<string, string> {
    const accountPrefix = this.options.authUser ? `/u/${this.options.authUser}` : '';
    const headers: Record<string, string> = {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Origin': 'https://gemini.google.com',
      'Referer': `https://gemini.google.com${accountPrefix}/app`,
      'X-Same-Domain': '1',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
    };
    if (this.options.authUser) {
      headers['X-Goog-AuthUser'] = this.options.authUser;
    }
    if (this.options.cookies) {
      headers['Cookie'] = this.options.cookies;
    }
    const sapisid = this.options.sapisid || (this.options.cookies ? this.extractSapisidFromCookies(this.options.cookies) : null);
    if (sapisid) {
      headers['Authorization'] = this.makeSapisidHash(sapisid);
    }
    return headers;
  }

  private buildUrl(): string {
    const accountPrefix = this.options.authUser ? `/u/${this.options.authUser}` : '';
    const bl = this.getBl();
    const reqid = Math.floor(Date.now() / 1000) % 1000000;
    return `${DEFAULT_BASE_URL}${accountPrefix}/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate?bl=${bl}&hl=zh&_reqid=${reqid}&rt=c`;
  }

  private buildPayload(prompt: string, modelId: number, thinkMode: number): string {
    const conv = this._currentConversation;
    // Build the inner array matching Gemini's protocol
    // For continuing conversations, inner[2] carries conversation context IDs
    // and inner[3] carries the continuation token
    const inner: unknown[] = new Array(80).fill(null);
    inner[0] = [prompt, 0, null, null, null, null, 0];
    inner[1] = ['zh'];
    inner[2] = [
      conv?.conversationId || '',   // c_xxx
      conv?.replyId || '',          // r_xxx
      conv?.replyContextId || '',   // rc_xxx
      null, null, null, null, null, null,
      conv?.sessionToken || '',     // session token at index 9
    ];
    // inner[3] is the continuation token for multi-turn conversations
    inner[3] = conv?.continuationToken || null;
    inner[4] = conv?.hashId || null;
    inner[6] = [0];
    inner[7] = 1;
    inner[10] = 1;
    inner[11] = 0;
    inner[17] = [[thinkMode]];
    inner[18] = 0;
    inner[27] = 1;
    inner[30] = [4];
    inner[41] = [2];
    inner[53] = 0;
    inner[59] = randomUUID();
    inner[61] = [];
    inner[68] = 1;
    inner[79] = modelId;

    const outer = [null, JSON.stringify(inner)];
    const params = new URLSearchParams();
    params.set('f.req', JSON.stringify(outer));
    // Use at token: init-extracted > manually configured
    const atToken = this.getAtToken();
    if (atToken) {
      params.set('at', atToken);
    }
    return params.toString();
  }

  private resolveModel(modelName: string): { mode: number; think: number } {
    const cfg = GEMINI_MODELS[modelName];
    if (cfg) return { mode: cfg.mode, think: cfg.think };
    // Default to flash
    return { mode: 1, think: 4 };
  }

  // ─── Convert messages to prompt (only send latest user message) ──────────────

  private extractLatestUserMessage(messages: Message[]): string {
    // For stateful conversations, only send the latest user message
    // (Gemini server maintains history via f.sid and conversation tokens)
    const toolResults: Message[] = [];
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'tool') {
        toolResults.unshift(messages[i]);
      } else {
        break;
      }
    }

    if (toolResults.length > 0) {
      const parts = toolResults.map(r => `[Tool Result] ${r.toolName || 'unknown'}\n${r.content}`);
      return parts.join('\n\n') + '\n\nBased on the tool results above, continue your response.';
    }

    // For first message of new conversation, include system message
    const systemMessage = messages.find(m => m.role === 'system');
    const lastUserMessage = [...messages].reverse().find(m => m.role === 'user');

    if (lastUserMessage) {
      if (systemMessage && (!this._currentConversation || !this._currentConversation.conversationId)) {
        return `${systemMessage.content}\n\n---\n\nUser: ${lastUserMessage.content}`;
      }
      return lastUserMessage.content;
    }

    return '';
  }

  // ─── LLMAdapter interface ─────────────────────────────────────────────────────

  async translateInput(messages: Message[], config: LLMConfig): Promise<HttpRequest> {
    // Auto-init on first request if not done manually
    if (!this._initialized) {
      await this.init();
    }

    const modelName = config.model || 'gemini-3.5-flash';
    const { mode, think } = this.resolveModel(modelName);

    // Only send latest user message (server maintains context via conversation tokens)
    const prompt = this.extractLatestUserMessage(messages);
    if (!prompt.trim()) {
      throw new Error('Empty prompt');
    }

    // Ensure conversation exists and save user message
    const conv = this.ensureCurrentConversation();
    this.saveCurrentMessage('user', prompt);

    const url = this.buildUrl();
    const headers = this.buildHeaders();
    const body = this.buildPayload(prompt, mode, think);

    return {
      url,
      method: 'POST',
      headers,
      body,
      conversationId: conv.id,
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
    let prevText = '';
    let accumulatedText = '';
    // StringDecoder handles multi-byte UTF-8 characters split across chunks
    const decoder = new StringDecoder('utf-8');

    for await (const chunk of stream) {
      buffer += decoder.write(chunk);

      // Process complete lines
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        // Try to extract conversation context from response
        this.extractConversationContext(line);
        const texts = this.extractTextsFromLine(line);
        for (const t of texts) {
          if (t.length > prevText.length) {
            const delta = this.cleanGeminiText(t.substring(prevText.length));
            if (delta) {
              accumulatedText += delta;
              yield { type: 'text', content: delta };
            }
            prevText = t;
          }
        }
      }
    }

    // Flush any remaining bytes in the decoder
    buffer += decoder.end();

    // Process remaining buffer
    if (buffer.trim()) {
      this.extractConversationContext(buffer);
      const texts = this.extractTextsFromLine(buffer);
      for (const t of texts) {
        if (t.length > prevText.length) {
          const delta = this.cleanGeminiText(t.substring(prevText.length));
          if (delta) {
            accumulatedText += delta;
            yield { type: 'text', content: delta };
          }
          prevText = t;
        }
      }
    }

    // Save assistant response to local conversation
    if (accumulatedText) {
      this.saveCurrentMessage('assistant', accumulatedText);
    }

    yield { type: 'done', content: '' };
  }

  // ─── Response parsing & conversation context extraction ─────────────────────

  /**
   * Extract conversation context IDs from response lines.
   * After each response, Gemini returns updated conversation IDs that
   * must be sent with the next request to maintain session continuity.
   *
   * Actual response inner[1] structure (verified by test):
   *   inner[1] = [conversationId("c_xxx"), replyId("r_xxx")]
   * Only 2 elements, no rc_, no continuation token, no session token.
   */
  private extractConversationContext(line: string): void {
    if (!line.includes('"wrb.fr"') || line.length < 200) return;
    if (!this._currentConversation) return;

    try {
      const arr = JSON.parse(line);
      const innerStr = arr[0][2];
      if (!innerStr || innerStr.length < 50) return;
      const inner = JSON.parse(innerStr);
      if (!Array.isArray(inner) || inner.length <= 4) return;

      // Extract conversation IDs from inner[1]
      // Verified: inner[1] = [conversationId, replyId] (only 2 elements)
      if (Array.isArray(inner[1]) && inner[1].length >= 2) {
        const convCtx = inner[1];
        if (typeof convCtx[0] === 'string' && convCtx[0].startsWith('c_')) {
          this._currentConversation.conversationId = convCtx[0];
          console.log('[Gemini] Captured conversationId:', convCtx[0]);
        }
        if (typeof convCtx[1] === 'string' && convCtx[1].startsWith('r_')) {
          this._currentConversation.replyId = convCtx[1];
        }
        // rc_ may exist at index 2 in some responses
        if (typeof convCtx[2] === 'string' && convCtx[2].startsWith('rc_')) {
          this._currentConversation.replyContextId = convCtx[2];
        }
        // Session token may exist at index 9 in some responses
        if (convCtx.length > 9 && typeof convCtx[9] === 'string' && convCtx[9].length > 10) {
          this._currentConversation.sessionToken = convCtx[9];
        }
      }

      // Some responses may include continuation token at inner[3]
      if (typeof inner[3] === 'string' && inner[3].length > 50) {
        this._currentConversation.continuationToken = inner[3];
      }

      // Some responses may include hash ID at inner[4]
      if (typeof inner[4] === 'string' && inner[4].length > 10) {
        this._currentConversation.hashId = inner[4];
      }

      // Persist updated context
      this.saveLocalConversations();
    } catch {
      // Ignore parse errors for context extraction
    }
  }

  private extractTextsFromLine(line: string): string[] {
    if (!line.includes('"wrb.fr"') || line.length < 200) return [];
    try {
      const arr = JSON.parse(line);
      const innerStr = arr[0][2];
      if (!innerStr || innerStr.length < 50) return [];
      const inner = JSON.parse(innerStr);
      if (!Array.isArray(inner) || inner.length <= 4 || !inner[4]) return [];

      const texts: string[] = [];
      for (const part of inner[4]) {
        if (Array.isArray(part) && part.length > 1 && part[1] && Array.isArray(part[1])) {
          for (const t of part[1]) {
            if (typeof t === 'string' && t.length > 0) {
              texts.push(t);
            }
          }
        }
      }
      return texts;
    } catch {
      return [];
    }
  }

  private cleanGeminiText(text: string): string {
    // Remove internal code execution artifacts
    return text
      .replace(/```(?:python|javascript|text)\?code_(?:reference|stdout)&code_event_index=\d+\n.*?```\n?/gs, '')
      .replace(/http:\/\/googleusercontent\.com\/card_content\/\d+\n?/g, '')
      .trim();
  }

  abort(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }
}
