import type { Message, LLMConfig, StreamChunk } from '@xai/shared';
import type { HttpRequest, LLMAdapter } from './types.js';
import { randomUUID } from './crypto-polyfill.js';

export interface QwenAiAdapterOptions {
  token?: string;
  cookies?: string;
  baseUrl?: string;
}

export interface QwenAiConversationItem {
  conversationId: string;
  title: string;
  createTime: string;
  updateTime: string;
}

export interface QwenAiDialogItem {
  dialogId: string;
  role: string;
  content: string;
  createTime: number;
}

const QWEN_AI_BASE = 'https://chat.qwen.ai';

const DEFAULT_HEADERS: Record<string, string> = {
  Accept: 'application/json',
  'Accept-Language': 'zh-CN,zh;q=0.9',
  'Content-Type': 'application/json',
  source: 'web',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
  'sec-ch-ua': '"Not:A-Brand";v="99", "Google Chrome";v="145", "Chromium";v="145"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"macOS"',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-origin',
  'bx-v': '2.5.36',
  'bx-umidtoken': 'T2gAr9z8byN8sNOmfQ3X9j61MNTNmSqDO5L1rs2jMcQCVhOKgZICcBN-UdTuJGig-NM=',
  Timezone: `Mon ${new Date().toString().match(/\w+ \w+ \d+ \d+/)?.[0] ?? 'Feb 23 2026'} ${new Date().toString().match(/\d+:\d+:\d+/)?.[0] ?? '22:06:02'} GMT+0800`,
  Version: '0.2.7',
  Origin: 'https://chat.qwen.ai',
};

const REQUIRED_COOKIES = ['cnaui', 'aui', 'sca', 'xlly_s', 'cna', 'token', '_bl_uid', 'x-ap'];

const MODEL_ALIASES: Record<string, string> = {
  qwen: 'qwen3.7-max',
  qwen3: 'qwen3.7-max',
  'qwen3.7': 'qwen3.7-max',
  'qwen3.6': 'qwen3.6-plus',
  'qwen3-coder': 'qwen3-coder-plus',
};

function uuid(): string {
  return randomUUID();
}

export class QwenAiAdapter implements LLMAdapter {
  private options: QwenAiAdapterOptions;
  private _chatId: string;
  private abortController: AbortController | null = null;

  constructor(options: QwenAiAdapterOptions = {}) {
    this.options = { ...options };
    this._chatId = '';
  }

  get chatId(): string {
    return this._chatId;
  }

  get conversationId(): string {
    return this._chatId;
  }

  resetSession(): void {
    this._chatId = '';
  }

  loadSession(chatId: string): void {
    this._chatId = chatId;
  }

  private getToken(): string {
    return this.options.token || '';
  }

  private mapModel(model: string): { mapped: string; forceThinking?: boolean } {
    let m = model;
    let forceThinking: boolean | undefined;
    if (m.endsWith('-thinking')) {
      forceThinking = true;
      m = m.slice(0, -9);
    } else if (m.endsWith('-fast')) {
      forceThinking = false;
      m = m.slice(0, -5);
    }
    const lower = m.toLowerCase();
    if (MODEL_ALIASES[lower]) {
      return { mapped: MODEL_ALIASES[lower], forceThinking };
    }
    return { mapped: m, forceThinking };
  }

  private buildHeaders(chatId?: string): Record<string, string> {
    const token = this.getToken();
    const headers: Record<string, string> = {
      ...DEFAULT_HEADERS,
      'X-Request-Id': uuid(),
    };
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
    if (chatId) {
      headers['Referer'] = `https://chat.qwen.ai/c/${chatId}`;
    }
    if (this.options.cookies) {
      headers['Cookie'] = this.options.cookies;
      const missing = REQUIRED_COOKIES.filter(c => !this.options.cookies!.includes(`${c}=`));
      if (missing.length > 0) {
        console.warn(`[QwenAI] Missing cookies: ${missing.join(', ')}. This may cause Bad_Request error.`);
      }
    } else {
      console.warn('[QwenAI] No cookies provided. This may cause Bad_Request error.');
      console.warn(`[QwenAI] Required cookies: ${REQUIRED_COOKIES.join(', ')}`);
    }
    return headers;
  }

  async createChat(modelId: string, title: string = 'New Chat'): Promise<string> {
    const response = await fetch(`${QWEN_AI_BASE}/api/v2/chats/new`, {
      method: 'POST',
      headers: this.buildHeaders(),
      body: JSON.stringify({
        title,
        models: [modelId],
        chat_mode: 'normal',
        chat_type: 't2t',
        timestamp: Date.now(),
        project_id: '',
      }),
      signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`QwenAI create chat failed: HTTP ${response.status} ${text.substring(0, 200)}`);
    }

    const data = await response.json() as Record<string, unknown>;
    const inner = (data.data || data) as Record<string, unknown>;
    const chatId = (inner.id as string) || '';
    if (!chatId) {
      throw new Error('QwenAI create chat failed: no chat id returned');
    }
    return chatId;
  }

  /**
   * Single-turn semantics: collapse all messages into one user prompt.
   * For server-side context, the caller provides the full history; we still
   * keep the upstream behavior of concatenating into a single user message
   * with the system prompt at the top.
   */
  private messagesToSinglePrompt(messages: Message[]): string {
    let systemContent = '';
    let userContent = '';
    for (const msg of messages) {
      if (msg.role === 'system') {
        systemContent += (systemContent ? '\n\n' : '') + msg.content;
      } else if (msg.role === 'user') {
        userContent = msg.content;
      }
      // assistant/tool messages are ignored: server has no context
    }
    if (systemContent) {
      return `${systemContent}\n\nUser: ${userContent}`;
    }
    return userContent;
  }

  async translateInput(messages: Message[], config: LLMConfig): Promise<HttpRequest> {
    const token = this.getToken();
    if (!token) {
      throw new Error('QwenAI Token not configured, please add Token in Settings');
    }

    const model = config.model || 'qwen3.7-max';
    const { mapped: modelId, forceThinking } = this.mapModel(model);
    const modelLower = model.toLowerCase();
    const nameSuggestsThinking = modelLower.includes('think') || modelLower.includes('r1');
    const shouldEnableThinking = forceThinking !== undefined
      ? forceThinking
      : nameSuggestsThinking;

    // Always create a new chat for single-turn semantics
    if (!this._chatId) {
      this._chatId = await this.createChat(modelId);
    }

    const userContent = this.messagesToSinglePrompt(messages);

    const fid = uuid();
    const childId = uuid();
    const ts = Math.floor(Date.now() / 1000);

    const featureConfig: Record<string, unknown> = {
      thinking_enabled: shouldEnableThinking,
      output_schema: 'phase',
      research_mode: 'normal',
      auto_thinking: shouldEnableThinking,
      thinking_format: 'summary',
      auto_search: false,
    };

    const payload = {
      stream: true,
      version: '2.1',
      incremental_output: true,
      chat_id: this._chatId,
      chat_mode: 'normal',
      model: modelId,
      parent_id: null,
      messages: [
        {
          fid,
          parentId: null,
          childrenIds: [childId],
          role: 'user',
          content: userContent,
          user_action: 'chat',
          files: [],
          timestamp: ts,
          models: [modelId],
          chat_type: 't2t',
          feature_config: featureConfig,
          extra: { meta: { subChatType: 't2t' } },
          sub_chat_type: 't2t',
          parent_id: null,
        },
      ],
      timestamp: ts + 1,
    };

    return {
      url: `${QWEN_AI_BASE}/api/v2/chat/completions?chat_id=${this._chatId}`,
      method: 'POST',
      headers: {
        ...this.buildHeaders(this._chatId),
        'x-accel-buffering': 'no',
      },
      body: JSON.stringify(payload),
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
    let responseId = '';
    let anySSESeen = false;

    for await (const chunk of stream) {
      buffer += decoder.decode(chunk, { stream: true });
      const parts = buffer.split('\n\n');
      buffer = parts.pop() ?? '';

      for (const part of parts) {
        if (part.includes('data:')) anySSESeen = true;
        for (const ev of this.parseSSEBlock(part, responseId)) {
          if (ev.type === 'text' && (ev as any).__responseId) {
            responseId = (ev as any).__responseId;
            delete (ev as any).__responseId;
          }
          yield ev;
        }
      }
    }

    // 冲刷解码器缓存的不完整字节（正常结束时应为空字符串）。
    buffer += decoder.decode();

    if (buffer.trim()) {
      if (buffer.includes('data:')) anySSESeen = true;
      for (const ev of this.parseSSEBlock(buffer, responseId)) {
        yield ev;
      }
    }

    // If no SSE data was ever seen, the response body is likely a plain JSON
    // error envelope (HTTP 200 but `{"success":false,...}`).  Surface it as an
    // error so the agent loop does not silently complete with 0 content.
    if (!anySSESeen) {
      const fullBody = buffer.length > 0 ? buffer : '';
      // Attempt to reconstruct the full body from the raw chunks that the
      // Router already consumed; the caller stores them in `rawChunks` so we
      // cannot access them here. Instead, try to parse whatever we have left
      // in `buffer` combined with any prior `parts` (the split already popped
      // them so `buffer` is the remainder).  If the Router gave us the entire
      // body in one chunk it will still be in `buffer`.
      const errorMsg = this.extractJsonError(fullBody);
      if (errorMsg) {
        yield { type: 'error', content: errorMsg };
        return;
      }
    }

    yield { type: 'done', content: '' };
  }

  /**
   * Try to extract a human-readable error from a non-SSE JSON response body.
   * Returns `null` when the body does not look like a Qwen AI error envelope.
   */
  private extractJsonError(body: string): string | null {
    if (!body || !body.startsWith('{')) return null;
    try {
      const data = JSON.parse(body) as Record<string, unknown>;
      if (data['success'] === false) {
        const inner = data['data'] as Record<string, unknown> | undefined;
        const code = (inner?.['code'] as string) || (data['code'] as string) || 'UnknownError';
        const details = (inner?.['details'] as string) || (data['message'] as string) || '';
        return `Qwen AI error (${code}): ${details || 'No details provided'}`;
      }
    } catch {
      // Not valid JSON — ignore.
    }
    return null;
  }

  private *parseSSEBlock(block: string, currentResponseId: string): Generator<StreamChunk> {
    const lines = block.split('\n');
    let dataStr = '';
    for (const line of lines) {
      if (line.startsWith('data:')) {
        dataStr += line.substring(5).trim();
      }
    }
    if (!dataStr) return;

    // Multiple events may be in one data: line; split on top-level JSON objects
    const jsonChunks = this.splitConcatenatedJson(dataStr);
    for (const jsonStr of jsonChunks) {
      try {
        const data = JSON.parse(jsonStr) as Record<string, unknown>;
        if (data['response.created'] && typeof data['response.created'] === 'object') {
          const rc = data['response.created'] as Record<string, unknown>;
          if (rc['response_id']) {
            currentResponseId = String(rc['response_id']);
          }
        }
        if (data.choices && Array.isArray(data.choices) && data.choices.length > 0) {
          const choice = data.choices[0] as Record<string, unknown>;
          const delta = (choice.delta as Record<string, unknown>) || {};
          const phase = delta.phase as string | null | undefined;
          const status = delta.status as string | null | undefined;
          const content = (delta.content as string) || '';
          const finishReason = choice.finish_reason as string | null | undefined;

          if (phase === 'think') {
            if (status !== 'finished' && content) {
              const ev: any = { type: 'thinking', content };
              if (currentResponseId) ev.__responseId = currentResponseId;
              yield ev;
            }
          } else if (phase === 'thinking_summary') {
            const extra = (delta.extra as Record<string, unknown>) || {};
            const summary = extra.summary_thought as Record<string, unknown> | undefined;
            if (summary && Array.isArray(summary.content)) {
              const joined = (summary.content as string[]).join('\n');
              if (joined) {
                const ev: any = { type: 'thinking', content: joined };
                if (currentResponseId) ev.__responseId = currentResponseId;
                yield ev;
              }
            }
          } else if (phase === 'answer' || phase === null) {
            if (content) {
              const ev: any = { type: 'text', content };
              if (currentResponseId) ev.__responseId = currentResponseId;
              yield ev;
            }
            if (status === 'finished') {
              return;
            }
          }
          if (finishReason === 'stop' || finishReason === 'length') {
            return;
          }
        }
      } catch {
        // ignore
      }
    }
  }

  /**
   * Split a string containing one or more concatenated JSON objects.
   * The QwenAI stream may emit several events in a single SSE `data:` field.
   */
  private splitConcatenatedJson(input: string): string[] {
    const result: string[] = [];
    let depth = 0;
    let start = -1;
    let inString = false;
    let escape = false;
    for (let i = 0; i < input.length; i++) {
      const ch = input[i];
      if (escape) { escape = false; continue; }
      if (inString) {
        if (ch === '\\') escape = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') { inString = true; continue; }
      if (ch === '{') {
        if (depth === 0) start = i;
        depth++;
      } else if (ch === '}') {
        depth--;
        if (depth === 0 && start >= 0) {
          result.push(input.substring(start, i + 1));
          start = -1;
        }
      }
    }
    if (depth > 0 && start >= 0) {
      result.push(input.substring(start));
    }
    return result;
  }

  abort(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }

  async getConversationList(pageNum: number = 1, pageSize: number = 20): Promise<{ list: QwenAiConversationItem[]; total: number } | null> {
    if (!this.options.token) {
      console.log('[QwenAI] getConversationList skipped: no token');
      return null;
    }

    try {
      const response = await fetch(`${QWEN_AI_BASE}/api/v2/chats?page=${pageNum}&page_size=${pageSize}`, {
        method: 'GET',
        headers: this.buildHeaders(),
        signal: AbortSignal.timeout(30000),
      });

      if (!response.ok) {
        console.error('[QwenAI] getConversationList failed:', response.status);
        return null;
      }

      const data = await response.json() as Record<string, unknown>;
      const inner = (data.data || data) as Record<string, unknown>;
      const list = (inner.chats as Array<Record<string, unknown>>)
        || (inner.items as Array<Record<string, unknown>>)
        || (inner.list as Array<Record<string, unknown>>)
        || (Array.isArray(inner) ? (inner as Array<Record<string, unknown>>) : []);
      const total = typeof inner.total === 'number' ? inner.total : list.length;

      return {
        list: list.map((c) => ({
          conversationId: String(c.id || c.chat_id || ''),
          title: String(c.title || c.name || ''),
          createTime: String(c.created_at || c.create_time || ''),
          updateTime: String(c.updated_at || c.update_time || ''),
        })),
        total,
      };
    } catch (err) {
      console.error('[QwenAI] getConversationList error:', err);
      return null;
    }
  }

  async getDialogList(conversationId: string): Promise<QwenAiDialogItem[] | null> {
    if (!this.options.token) {
      return null;
    }

    try {
      const response = await fetch(`${QWEN_AI_BASE}/api/v2/chats/${conversationId}/messages`, {
        method: 'GET',
        headers: this.buildHeaders(conversationId),
        signal: AbortSignal.timeout(30000),
      });

      if (!response.ok) {
        console.error('[QwenAI] getDialogList failed:', response.status);
        return null;
      }

      const data = await response.json() as Record<string, unknown>;
      const inner = (data.data || data) as Record<string, unknown>;
      const messages = (inner.messages as Array<Record<string, unknown>>) || [];

      return messages.map((m) => ({
        dialogId: String(m.message_id || m.fid || m.id || ''),
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: String(m.content || m.text || ''),
        createTime: Number(m.created_at || m.create_time || m.timestamp || 0),
      }));
    } catch (err) {
      console.error('[QwenAI] getDialogList error:', err);
      return null;
    }
  }

  async deleteConversation(): Promise<boolean> {
    return this.deleteConversationById(this._chatId);
  }

  async deleteConversationById(conversationId: string): Promise<boolean> {
    if (!this.options.token) {
      console.log('[QwenAI] deleteConversationById skipped: no token');
      return false;
    }
    if (!conversationId) {
      console.log('[QwenAI] deleteConversationById skipped: no chatId');
      return false;
    }

    try {
      const response = await fetch(`${QWEN_AI_BASE}/api/v2/chats/${conversationId}`, {
        method: 'DELETE',
        headers: this.buildHeaders(conversationId),
        signal: AbortSignal.timeout(15000),
      });

      if (!response.ok) {
        console.error('[QwenAI] deleteConversation failed:', response.status);
        return false;
      }

      const data = await response.json().catch(() => ({})) as Record<string, unknown>;
      const success = data.success !== false;
      console.log('[QwenAI] Delete chat:', conversationId, 'success:', success);
      if (this._chatId === conversationId) {
        this._chatId = '';
      }
      return success;
    } catch (err) {
      console.error('[QwenAI] deleteConversation failed:', err);
      return false;
    }
  }
}
