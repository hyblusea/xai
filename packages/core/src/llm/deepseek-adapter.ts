import type { Message, LLMConfig, StreamChunk } from '@xai/shared';
import type { HttpRequest, LLMAdapter } from './types.js';
import { randomUUID } from './crypto-polyfill.js';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { solvePowChallenge } from './deepseek-hash.js';

export interface DeepSeekAdapterOptions {
  token?: string;
  baseUrl?: string;
  /**
   * Optional path to the DeepSeek PoW WASM. When omitted we look for
   * `sha3_wasm_bg.7b9ca65ddd.wasm` next to the built adapter output.
   */
  wasmPath?: string;
}

export interface DeepSeekConversationItem {
  conversationId: string;
  title: string;
  createTime: string;
  updateTime: string;
  modelType?: string;
  pinned?: boolean;
}

export interface DeepSeekDialogItem {
  dialogId: string;
  role: string;
  content: string;
  createTime: number;
}

const DEEPSEEK_API_BASE = 'https://chat.deepseek.com/api';

const FAKE_HEADERS: Record<string, string> = {
  Accept: '*/*',
  'Accept-Encoding': 'gzip, deflate, br, zstd',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6',
  Origin: 'https://chat.deepseek.com',
  Referer: 'https://chat.deepseek.com/',
  'Sec-Ch-Ua': '"Not/A)Brand";v="99", "Chromium";v="148"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"macOS"',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-origin',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
  'X-App-Version': '2.0.0',
  'X-Client-Locale': 'zh_CN',
  'X-Client-Platform': 'web',
  'X-Client-Timezone-Offset': '28800',
  'X-Client-Version': '2.0.0',
};

const WASM_FILE_NAME = 'sha3_wasm_bg.7b9ca65ddd.wasm';

/**
 * Resolve a default path to the PoW WASM. The file ships next to the bundled
 * adapter output (see `tsup.config.ts`).
 */
function defaultWasmPath(): string {
  try {
    // When running from source, the WASM lives next to this file.
    const here = dirname(fileURLToPath(import.meta.url));
    return join(here, WASM_FILE_NAME);
  } catch {
    return WASM_FILE_NAME;
  }
}

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

const tokenCache = new Map<string, CachedToken>();

function generateRandomString(length: number, charset: string = 'alphanumeric'): string {
  const sets: Record<string, string> = {
    numeric: '0123456789',
    alphabetic: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz',
    alphanumeric: '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz',
    hex: '0123456789abcdef',
  };
  const chars = sets[charset] || sets.alphanumeric;
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

function uuid(dashed: boolean = true): string {
  const s = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
  return dashed ? s : s.replace(/-/g, '');
}

function generateCookie(): string {
  const timestamp = Date.now();
  const a = uuid(false);
  const b = uuid(false);
  const c = uuid(false);
  return [
    `intercom-HWWAFSESTIME=${timestamp}`,
    `HWWAFSESID=${generateRandomString(18, 'hex')}`,
    `Hm_lvt_${a}=${Math.floor(timestamp / 1000)},${Math.floor(timestamp / 1000)},${Math.floor(timestamp / 1000)}`,
    `Hm_lpvt_${a}=${Math.floor(timestamp / 1000)}`,
    `_frid=${b}`,
    `_fr_ssid=${b}`,
    `_fr_pvid=${c}`,
  ].join('; ');
}

interface ChallengeResponse {
  algorithm: string;
  challenge: string;
  salt: string;
  difficulty: number;
  expire_at: number;
  signature: string;
}

/**
 * Solve a DeepSeek PoW challenge using the official `sha3_wasm_bg` module.
 *
 * The WASM exposes `wasm_solve(retptr, challenge_ptr, challenge_len,
 * prefix_ptr, prefix_len, difficulty) -> (i32 status, f64 answer)` where
 * `prefix = ${salt}_${expire_at}_`. `status === 0` means a valid `answer`
 * was found (we always reach the answer via the smallest u32 that yields
 * the required leading-zero bit count for the SHA-3 digest).
 */
async function solveChallenge(
  challenge: ChallengeResponse,
  targetPath: string,
  wasmPath: string,
): Promise<string> {
  const { algorithm, challenge: challengeStr, salt, difficulty, expire_at, signature } = challenge;

  if (algorithm !== 'DeepSeekHashV1') {
    throw new Error(`Unsupported PoW algorithm: ${algorithm}`);
  }
  if (Date.now() / 1000 > expire_at) {
    throw new Error('PoW challenge already expired');
  }

  const answer = await solvePowChallenge(
    algorithm,
    challengeStr,
    salt,
    difficulty,
    expire_at,
    wasmPath,
  );

  if (answer === undefined) {
    throw new Error('PoW challenge could not be solved (WASM and JS fallback both failed)');
  }

  const payload = JSON.stringify({
    algorithm,
    challenge: challengeStr,
    salt,
    answer,
    signature,
    target_path: targetPath,
  });
  return Buffer.from(payload, 'utf-8').toString('base64');
}

export class DeepSeekAdapter implements LLMAdapter {
  private options: DeepSeekAdapterOptions;
  private _conversationId: string;
  private _messageId: string | null = null;
  private abortController: AbortController | null = null;
  private sessionCache = new Map<string, { sessionId: string; createdAt: number }>();
  private _lastGeneratedId: string | null = null;

  constructor(options: DeepSeekAdapterOptions = {}) {
    this.options = { ...options };
    this._conversationId = this.generateId();
    // Resolve the WASM path lazily on first PoW to keep startup cheap.
    this.wasmPath = options.wasmPath || defaultWasmPath();
  }

  private wasmPath: string;

  get conversationId(): string {
    return this._conversationId;
  }

  get messageId(): string | null {
    return this._messageId;
  }

  private generateId(): string {
    const id = randomUUID().replace(/-/g, '');
    this._lastGeneratedId = id;
    return id;
  }

  resetSession(): string {
    this._conversationId = this.generateId();
    this._messageId = null;
    return this._conversationId;
  }

  loadSession(conversationId: string): void {
    this._conversationId = conversationId;
    this._messageId = null;
    this._lastGeneratedId = null;
  }

  private getToken(): string {
    return this.options.token || '';
  }

  private async acquireToken(): Promise<string> {
    const token = this.getToken();
    if (!token) {
      throw new Error('DeepSeek Token not configured, please add Token in Settings');
    }

    const cached = tokenCache.get(token);
    const now = Math.floor(Date.now() / 1000);
    if (cached && cached.expiresAt > now) {
      return cached.accessToken;
    }

    console.log('[DeepSeek] Acquiring access token...');
    const response = await fetch(`${DEEPSEEK_API_BASE}/v0/users/current`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        ...FAKE_HEADERS,
      },
      signal: AbortSignal.timeout(15000),
    });

    if (response.status === 401 || response.status === 403) {
      throw new Error('DeepSeek Token invalid or expired, please get a new Token');
    }
    if (!response.ok) {
      throw new Error(`Failed to acquire DeepSeek token: HTTP ${response.status}`);
    }

    const data = await response.json() as Record<string, unknown>;
    const innerData = (data.data || data) as Record<string, unknown>;
    const bizData = (innerData.biz_data || data.biz_data || innerData) as Record<string, unknown>;
    const accessToken = (bizData.token as string) || '';
    if (!accessToken) {
      const message = (data.msg as string) || (innerData.biz_msg as string) || 'Unknown error';
      throw new Error(`Failed to acquire DeepSeek token: ${message}`);
    }

    tokenCache.set(token, {
      accessToken,
      expiresAt: now + 3600,
    });

    console.log('[DeepSeek] Token acquired successfully');
    return accessToken;
  }

  /**
   * Build full set of request headers including Bearer access token and a fresh
   * cookie jar (DeepSeek requires certain anti-bot cookies on each request).
   */
  private async buildHeaders(): Promise<Record<string, string>> {
    const accessToken = await this.acquireToken();
    return {
      Authorization: `Bearer ${accessToken}`,
      ...FAKE_HEADERS,
      'Content-Type': 'application/json',
      Cookie: generateCookie(),
    };
  }

  /**
   * Create (or reuse) a real chat session on the DeepSeek server.
   * The returned `sessionId` is what we then pass as `chat_session_id` and
   * interpolate into the Referer header.
   */
  private async createSession(accessToken: string): Promise<string> {
    const cached = this.sessionCache.get(this.options.token || '');
    if (cached && Date.now() - cached.createdAt < 5 * 60 * 1000) {
      return cached.sessionId;
    }

    const response = await fetch(`${DEEPSEEK_API_BASE}/v0/chat_session/create`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...FAKE_HEADERS,
        'Content-Type': 'application/json',
        Cookie: generateCookie(),
      },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      throw new Error(`Failed to create DeepSeek session: HTTP ${response.status}`);
    }

    const data = (await response.json()) as Record<string, unknown>;
    if (data.code !== 0) {
      throw new Error(`DeepSeek session create error: ${String(data.msg || data.code)}`);
    }

    const inner = (data.data || data) as Record<string, unknown>;
    const bizData = (inner.biz_data || inner) as Record<string, unknown>;
    const session = bizData.chat_session as Record<string, unknown> | undefined;
    const sessionId =
      String(session?.id || bizData.id || inner.id || '');
    if (!sessionId) {
      throw new Error('DeepSeek session create returned no session id');
    }

    this.sessionCache.set(this.options.token || '', { sessionId, createdAt: Date.now() });
    return sessionId;
  }

  /**
   * Fetch and solve a PoW challenge for the given target path.
   */
  private async acquireChallenge(accessToken: string, targetPath: string): Promise<string> {
    const response = await fetch(`${DEEPSEEK_API_BASE}/v0/chat/create_pow_challenge`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...FAKE_HEADERS,
        'Content-Type': 'application/json',
        Cookie: generateCookie(),
      },
      body: JSON.stringify({ target_path: targetPath }),
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      throw new Error(`Failed to acquire PoW challenge: HTTP ${response.status}`);
    }

    const data = (await response.json()) as Record<string, unknown>;
    if (data.code !== 0) {
      throw new Error(`PoW challenge error: ${String(data.msg || data.code)}`);
    }

    const inner = (data.data || data) as Record<string, unknown>;
    const bizData = (inner.biz_data || inner) as Record<string, unknown>;
    const challenge = bizData.challenge as ChallengeResponse | undefined;
    if (!challenge) {
      throw new Error('PoW challenge response missing challenge payload');
    }

    return solveChallenge(challenge, targetPath, this.wasmPath);
  }

  /**
   * DeepSeek uses a DeepSeek-special prompt format. Since we run in
   * server-side context mode (caller passes full history each turn), we
   * serialize messages using the special tokens emitted by the web client.
   */
  private messagesToPrompt(messages: Message[]): string {
    const blocks: { role: string; text: string }[] = [];
    for (const msg of messages) {
      const text = typeof msg.content === 'string' ? msg.content : '';
      if (!text) continue;
      blocks.push({ role: msg.role, text });
    }
    if (blocks.length === 0) return '';

    const merged: { role: string; text: string }[] = [{ ...blocks[0] }];
    for (let i = 1; i < blocks.length; i++) {
      const cur = blocks[i];
      if (merged[merged.length - 1].role === cur.role) {
        merged[merged.length - 1].text += '\n\n' + cur.text;
      } else {
        merged.push({ ...cur });
      }
    }

    return merged
      .map((b, idx) => {
        if (b.role === 'assistant') {
          return `<｜Assistant｜>${b.text}<｜end of sentence｜>`;
        }
        if (b.role === 'system') {
          return idx > 0 ? `<｜User｜>${b.text}` : b.text;
        }
        return idx > 0 ? `<｜User｜>${b.text}` : b.text;
      })
      .join('')
      .replace(/!\[.+\]\(.+\)/g, '');
  }

  async translateInput(messages: Message[], config: LLMConfig): Promise<HttpRequest> {
    const headers = await this.buildHeaders();
    const model = config.model || 'deepseek-v4-flash';
    const modelLower = model.toLowerCase();

    // Determine thinking & search modes from model name
    const searchEnabled = modelLower.includes('search');
    const thinkingEnabled = modelLower.includes('think') || modelLower.includes('r1') || modelLower.includes('reasoner');

    // Pick a model_type compatible with the official web client.
    // Per Chat2API's providerModelOptions.resolveDeepSeekChatOptions the
    // server only accepts two model_type values today:
    //   - 'expert'  : deepseek-v4-pro (and any 'expert' alias)
    //   - 'default' : deepseek-v4-flash (V3 / R1 / reasoner all collapse here)
    const isProModel = modelLower.includes('deepseek-v4-pro') || modelLower.includes('expert');
    const modelType: 'default' | 'expert' = isProModel ? 'expert' : 'default';

    // Reuse the existing conversation's session id when continuing a chat
    // so that the server groups messages under the same chat_session_id.
    // Only create a new server-side session for brand-new conversations.
    const accessToken = String(headers.Authorization || '').replace(/^Bearer\s+/i, '');
    const targetPath = '/api/v0/chat/completion';

    let serverSessionId: string;
    const hasExistingSession = this._messageId !== null && this._conversationId && this._conversationId !== this._lastGeneratedId;
    if (hasExistingSession) {
      serverSessionId = this._conversationId;
    } else {
      serverSessionId = await this.createSession(accessToken);
      this._conversationId = serverSessionId;
      this._lastGeneratedId = serverSessionId;
    }

    const powResponse = await this.acquireChallenge(accessToken, targetPath);

    const prompt = this.messagesToPrompt(messages);

    const body: Record<string, unknown> = {
      chat_session_id: serverSessionId,
      parent_message_id: this._messageId !== null ? Number(this._messageId) : null,
      prompt,
      model_type: modelType,
      ref_file_ids: [],
      search_enabled: searchEnabled,
      thinking_enabled: thinkingEnabled,
      preempt: false,
    };

    return {
      url: `${DEEPSEEK_API_BASE}/v0/chat/completion`,
      method: 'POST',
      headers: {
        ...headers,
        Referer: `https://chat.deepseek.com/a/chat/s/${serverSessionId}`,
        'X-Ds-Pow-Response': powResponse,
      },
      body: JSON.stringify(body),
      conversationId: serverSessionId,
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
    let currentPath: 'thinking' | 'content' | '' = '';
    // Always start with null so we capture the NEW response_message_id from this stream,
    // not the previous one. Otherwise _messageId would never be updated after the first call,
    // breaking the parent_message_id chain for subsequent messages.
    let messageId: string | null = null;

    for await (const chunk of stream) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.trim() || !line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') {
          yield { type: 'done', content: '' };
          return;
        }
        const parsed = this.parseSSE(data);
        if (!parsed) continue;

        if (parsed.response_message_id && !messageId) {
          messageId = String(parsed.response_message_id);
          this._messageId = messageId;
        }

        for (const ev of this.processChunk(parsed, currentPath)) {
          if (ev.type === 'text' || ev.type === 'thinking') {
            currentPath = ev.type === 'thinking' ? 'thinking' : 'content';
          }
          yield ev;
        }
      }
    }

    // 冲刷解码器缓存的不完整字节（正常结束时应为空字符串）。
    buffer += decoder.decode();

    yield { type: 'done', content: '' };
  }

  private parseSSE(data: string): Record<string, unknown> | null {
    try {
      return JSON.parse(data) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  private *processChunk(
    chunk: Record<string, unknown>,
    currentPath: string
  ): Generator<StreamChunk> {
    // Track thinking/content path from the v.response object
    if (chunk.v && typeof chunk.v === 'object' && !Array.isArray(chunk.v)) {
      const v = chunk.v as Record<string, unknown>;
      const response = v.response as Record<string, unknown> | undefined;
      if (response) {
        if (typeof response.thinking_enabled === 'boolean') {
          currentPath = response.thinking_enabled ? 'thinking' : 'content';
        }
        const fragments = response.fragments;
        if (Array.isArray(fragments)) {
          for (const frag of fragments as Array<Record<string, unknown>>) {
            if (typeof frag.content === 'string' && frag.content.length > 0) {
              if (frag.type === 'THINK') {
                currentPath = 'thinking';
                yield { type: 'thinking', content: frag.content };
              } else if (frag.type === 'ANSWER' || frag.type === 'RESPONSE') {
                currentPath = 'content';
                yield { type: 'text', content: frag.content };
              }
            }
          }
        }
      }
    }

    if (chunk.p === 'response/fragments' && Array.isArray(chunk.v)) {
      for (const frag of chunk.v as Array<Record<string, unknown>>) {
        if (typeof frag.content === 'string' && frag.content.length > 0) {
          if (frag.type === 'THINK') {
            currentPath = 'thinking';
            yield { type: 'thinking', content: frag.content };
          } else if (frag.type === 'ANSWER' || frag.type === 'RESPONSE') {
            currentPath = 'content';
            yield { type: 'text', content: frag.content };
          }
        }
      }
    }

    if (chunk.p === 'response' && Array.isArray(chunk.v)) {
      for (const e of chunk.v as Array<Record<string, unknown>>) {
        if (e.p === 'response' && e.v && typeof e.v === 'object') {
          const inner = e.v as Record<string, unknown>;
          if (typeof inner.thinking_enabled === 'boolean') {
            currentPath = inner.thinking_enabled ? 'thinking' : 'content';
          }
        }
      }
    }

    let content = '';
    if (typeof chunk.v === 'string') {
      content = chunk.v;
    } else if (Array.isArray(chunk.v)) {
      content = (chunk.v as Array<Record<string, unknown>>)
        .map((e) => {
          if (Array.isArray(e.v)) {
            return (e.v as Array<Record<string, unknown>>)
              .map((v) => (typeof v.content === 'string' ? v.content : ''))
              .join('');
          }
          return '';
        })
        .join('');
    }
    if (content) {
      const cleaned = content.replace(/FINISHED/g, '');
      if (currentPath === 'thinking') {
        yield { type: 'thinking', content: cleaned };
      } else {
        yield { type: 'text', content: cleaned };
      }
    }
  }

  abort(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }

  async getConversationList(cursor?: string): Promise<{ list: DeepSeekConversationItem[]; hasMore: boolean; nextCursor?: string } | null> {
    if (!this.options.token) {
      console.log('[DeepSeek] getConversationList skipped: no token');
      return null;
    }

    try {
      const accessToken = await this.acquireToken();
      const params = new URLSearchParams({ 'lte_cursor.pinned': 'false' });
      if (cursor) {
        params.set('lte_cursor', cursor);
      }
      const response = await fetch(`${DEEPSEEK_API_BASE}/v0/chat_session/fetch_page?${params.toString()}`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          ...FAKE_HEADERS,
          Cookie: generateCookie(),
        },
        signal: AbortSignal.timeout(30000),
      });

      if (!response.ok) {
        console.error('[DeepSeek] getConversationList failed:', response.status);
        return null;
      }

      const data = await response.json() as Record<string, unknown>;
      if (data.code !== 0) {
        console.error('[DeepSeek] getConversationList error:', JSON.stringify(data).substring(0, 300));
        return null;
      }

      const inner = (data.data || data) as Record<string, unknown>;
      const bizData = (inner.biz_data || inner) as Record<string, unknown>;
      const list = (bizData.chat_sessions as Array<Record<string, unknown>>) || [];
      const hasMore = bizData.has_more === true;

      const items: DeepSeekConversationItem[] = list.map((c) => ({
        conversationId: String(c.id || ''),
        title: String(c.title || ''),
        createTime: '',
        updateTime: String(c.updated_at || ''),
        modelType: c.model_type as string | undefined,
        pinned: c.pinned as boolean | undefined,
      }));

      // Use updated_at of last item as next cursor for pagination
      const nextCursor = hasMore && items.length > 0
        ? items[items.length - 1].updateTime
        : undefined;

      return { list: items, hasMore, nextCursor };
    } catch (err) {
      console.error('[DeepSeek] getConversationList error:', err);
      return null;
    }
  }

  async getDialogList(conversationId: string): Promise<DeepSeekDialogItem[] | null> {
    if (!this.options.token) {
      return null;
    }

    try {
      const headers = await this.buildHeaders();
      const response = await fetch(`${DEEPSEEK_API_BASE}/v0/chat_session/messages`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ chat_session_id: conversationId }),
        signal: AbortSignal.timeout(30000),
      });

      if (!response.ok) {
        console.error('[DeepSeek] getDialogList failed:', response.status);
        return null;
      }

      const data = await response.json() as Record<string, unknown>;
      if (data.code !== 0) {
        console.error('[DeepSeek] getDialogList error:', JSON.stringify(data).substring(0, 300));
        return null;
      }

      const inner = (data.data || data) as Record<string, unknown>;
      const bizData = (inner.biz_data || inner) as Record<string, unknown>;
      const messages = (bizData.messages as Array<Record<string, unknown>>) || [];

      return messages.map((m) => ({
        dialogId: String(m.message_id || m.id || ''),
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: String(m.content || m.text || ''),
        createTime: Number(m.created_at || m.create_time || 0),
      }));
    } catch (err) {
      console.error('[DeepSeek] getDialogList error:', err);
      return null;
    }
  }

  async deleteConversation(): Promise<boolean> {
    return this.deleteConversationById(this._conversationId);
  }

  async deleteConversationById(conversationId: string): Promise<boolean> {
    if (!this.options.token) {
      console.log('[DeepSeek] deleteConversationById skipped: no token');
      return false;
    }

    try {
      const headers = await this.buildHeaders();
      const response = await fetch(`${DEEPSEEK_API_BASE}/v0/chat_session/delete`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ chat_session_id: conversationId }),
        signal: AbortSignal.timeout(15000),
      });

      if (!response.ok) {
        console.error('[DeepSeek] deleteConversation failed:', response.status);
        return false;
      }

      const data = await response.json() as Record<string, unknown>;
      const success = data.code === 0;
      console.log('[DeepSeek] Delete conversation:', conversationId, 'success:', success);
      return success;
    } catch (err) {
      console.error('[DeepSeek] Delete conversation failed:', err);
      return false;
    }
  }
}
