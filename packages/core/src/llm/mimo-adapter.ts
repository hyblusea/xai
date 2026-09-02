import type { Message, LLMConfig, StreamChunk } from '@xai/shared';
import type { HttpRequest, LLMAdapter } from './types.js';
import { randomUUID } from './crypto-polyfill.js';

export interface MiMoAdapterOptions {
  cookies?: string;
  botId?: string;
}

export interface ConversationItem {
  conversationId: string;
  title: string;
  createTime: string;
  updateTime: string;
}

export interface DialogItem {
  dialogId: string;
  role: string;
  content: string;
  createTime: number;
}

const MIMO_STUDIO_API_URL = 'https://aistudio.xiaomimimo.com/open-apis/bot/chat';
const MIMO_OFFICIAL_API_URL = 'https://api.xiaomimimo.com/v1/chat/completions';
const MIMO_DELETE_URL = 'https://aistudio.xiaomimimo.com/open-apis/chat/conversation/delete';
const MIMO_CONVERSATION_LIST_URL = 'https://aistudio.xiaomimimo.com/open-apis/chat/conversation/list';
const MIMO_DIALOG_LIST_URL = 'https://aistudio.xiaomimimo.com/open-apis/chat/dialog/list';

export function cleanCookies(raw: string): string {
  let cleaned = raw.trim();
  const pairs = cleaned.split(';');
  const result: string[] = [];
  for (let pair of pairs) {
    pair = pair.trim();
    if (!pair) continue;
    const eqIndex = pair.indexOf('=');
    if (eqIndex === -1) {
      result.push(pair);
      continue;
    }
    const key = pair.substring(0, eqIndex).trimEnd();
    let value = pair.substring(eqIndex + 1).trimStart();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.substring(1, value.length - 1);
    }
    result.push(`${key}=${value}`);
  }
  return result.join('; ');
}

function extractCookieValue(cookies: string, name: string): string | undefined {
  const prefix = `${name}=`;
  const pairs = cookies.split(';');
  for (let pair of pairs) {
    pair = pair.trim();
    if (pair.startsWith(prefix)) {
      let value = pair.substring(prefix.length);
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.substring(1, value.length - 1);
      }
      return value;
    }
  }
  return undefined;
}

function buildStudioHeaders(cookies?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': '*/*',
    'Origin': 'https://aistudio.xiaomimimo.com',
    'Referer': 'https://aistudio.xiaomimimo.com/',
    'X-Timezone': Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai',
  };
  if (cookies) {
    headers['Cookie'] = cookies;
  }
  return headers;
}

function buildStudioUrl(baseUrl: string, cookies?: string): string {
  let url = baseUrl;
  const phValue = cookies ? extractCookieValue(cookies, 'xiaomichatbot_ph') : undefined;
  if (phValue) {
    const separator = url.includes('?') ? '&' : '?';
    url += `${separator}xiaomichatbot_ph=${encodeURIComponent(phValue)}`;
  }
  return url;
}

interface MiMoStreamChoice {
  index: number;
  delta?: {
    role?: string;
    content?: string;
    reasoning_content?: string;
  };
  finish_reason?: string | null;
}

export class MiMoAdapter implements LLMAdapter {
  private options: MiMoAdapterOptions;
  private _conversationId: string;
  private _dialogId: string | null = null;
  private _isStudioMode: boolean = false;

  constructor(options: MiMoAdapterOptions) {
    this.options = {
      ...options,
      cookies: options.cookies ? cleanCookies(options.cookies) : undefined,
    };
    this._conversationId = this.generateId();
  }

  get conversationId(): string {
    return this._conversationId;
  }

  get dialogId(): string | null {
    return this._dialogId;
  }

  get isStudioMode(): boolean {
    return this._isStudioMode;
  }

  private generateId(): string {
    return randomUUID().replace(/-/g, '');
  }

  resetSession(): string {
    this._conversationId = this.generateId();
    this._dialogId = null;
    return this._conversationId;
  }

  loadSession(conversationId: string): void {
    this._conversationId = conversationId;
    this._dialogId = null;
  }

  async deleteConversation(): Promise<boolean> {
    if (!this.options.cookies) {
      return false;
    }

    const idToDelete = this._dialogId || this._conversationId;
    if (!idToDelete) {
      return false;
    }

    try {
      const url = buildStudioUrl(MIMO_DELETE_URL, this.options.cookies);
      const headers = buildStudioHeaders(this.options.cookies);

      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify([idToDelete]),
      });

      console.log('[MiMo] Delete conversation:', idToDelete, 'status:', response.status);
      return response.ok;
    } catch (err) {
      console.error('[MiMo] Delete conversation failed:', err);
      return false;
    }
  }

  async deleteConversationById(conversationId: string): Promise<boolean> {
    if (!this.options.cookies) {
      return false;
    }
    try {
      const url = buildStudioUrl(MIMO_DELETE_URL, this.options.cookies);
      const headers = buildStudioHeaders(this.options.cookies);
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify([conversationId]),
      });
      console.log('[MiMo] Delete conversation by ID:', conversationId, 'status:', response.status);
      return response.ok;
    } catch (err) {
      console.error('[MiMo] Delete conversation by ID failed:', err);
      return false;
    }
  }

  async getConversationList(pageNum: number = 1, pageSize: number = 20): Promise<{ list: ConversationItem[]; total: number } | null> {
    if (!this.options.cookies) {
      console.log('[MiMo] getConversationList skipped: no cookies');
      return null;
    }

    try {
      const url = buildStudioUrl(MIMO_CONVERSATION_LIST_URL, this.options.cookies);
      const headers = buildStudioHeaders(this.options.cookies);

      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          pageInfo: { pageNum, pageSize },
        }),
      });

      if (!response.ok) {
        console.error('[MiMo] getConversationList failed:', response.status);
        return null;
      }

      const data = await response.json() as Record<string, unknown>;
      console.log('[MiMo] getConversationList raw response code:', data.code, 'type:', typeof data.code);

      const code = data.code;
      if (code !== 0 && code !== 200 && code !== '0' && code !== '200' && code !== 'success' && data.status === 'error') {
        console.error('[MiMo] getConversationList error response:', JSON.stringify(data).substring(0, 500));
        return null;
      }

      const result = (data.data ?? data.result ?? data) as Record<string, unknown>;
      console.log('[MiMo] getConversationList result keys:', Object.keys(result), 'isArray:', Array.isArray(result));

      let list: unknown[];
      if (Array.isArray(result)) {
        list = result;
      } else if (result.dataList && Array.isArray(result.dataList)) {
        list = result.dataList;
      } else if (result.list && Array.isArray(result.list)) {
        list = result.list;
      } else if (result.records && Array.isArray(result.records)) {
        list = result.records;
      } else if (result.items && Array.isArray(result.items)) {
        list = result.items;
      } else if (result.conversations && Array.isArray(result.conversations)) {
        list = result.conversations;
      } else {
        console.log('[MiMo] getConversationList: could not find list array in result, keys:', Object.keys(result));
        list = [];
      }

      const total = typeof result.total === 'number' ? result.total : (typeof result.totalCount === 'number' ? result.totalCount : list.length);
      console.log('[MiMo] getConversationList: found', list.length, 'items, total:', total);

      return {
        list: list.map((item: unknown) => {
          const c = item as Record<string, unknown>;
          return {
            conversationId: String(c.conversationId ?? c.id ?? ''),
            title: String(c.title ?? c.name ?? ''),
            createTime: String(c.createTime ?? c.createdAt ?? c.createAt ?? ''),
            updateTime: String(c.updateTime ?? c.updatedAt ?? c.updateAt ?? ''),
          };
        }),
        total,
      };
    } catch (err) {
      console.error('[MiMo] getConversationList error:', err);
      return null;
    }
  }

  async getDialogList(conversationId: string, pageNum: number = 1, pageSize: number = 20): Promise<DialogItem[] | null> {
    if (!this.options.cookies) {
      return null;
    }

    try {
      const url = buildStudioUrl(MIMO_DIALOG_LIST_URL, this.options.cookies);
      const headers = buildStudioHeaders(this.options.cookies);

      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          queryParam: { conversationId },
          pageInfo: { pageNum, pageSize },
        }),
      });

      if (!response.ok) {
        console.error('[MiMo] getDialogList failed:', response.status);
        return null;
      }

      const data = await response.json() as Record<string, unknown>;
      const code = data.code;
      if (code !== 0 && code !== 200 && code !== '0' && code !== '200') {
        console.error('[MiMo] getDialogList error:', JSON.stringify(data).substring(0, 300));
        return null;
      }

      const rawList = data.data as Array<Record<string, unknown>> | undefined;
      if (!Array.isArray(rawList)) {
        console.error('[MiMo] getDialogList: data is not array');
        return null;
      }

      const messages: DialogItem[] = [];
      for (const turn of rawList) {
        const inputInfo = turn.inputInfo as Record<string, unknown> | undefined;
        const userQuery = inputInfo?.query;
        if (userQuery) {
          messages.push({
            dialogId: String(turn.msgId ?? ''),
            role: 'user',
            content: String(userQuery),
            createTime: Number(turn.createTime ?? 0),
          });
        }

        const detailList = turn.dialogLogDetailList as Array<Record<string, unknown>> | undefined;
        if (Array.isArray(detailList) && detailList.length > 0) {
          const assistantContent = detailList[0].result;
          if (assistantContent) {
            messages.push({
              dialogId: String(detailList[0].id ?? ''),
              role: 'assistant',
              content: String(assistantContent),
              createTime: Number(turn.updateTime ?? turn.createTime ?? 0),
            });
          }
        }
      }

      return messages;
    } catch (err) {
      console.error('[MiMo] getDialogList error:', err);
      return null;
    }
  }

  async translateInput(messages: Message[], config: LLMConfig): Promise<HttpRequest> {
    // MiMo only uses Cookies (Studio mode). The shared apiKey field belongs to OpenAI.
    this._isStudioMode = true;
    return this.translateStudioInput(messages, config);
  }

  private async translateOfficialInput(messages: Message[], config: LLMConfig): Promise<HttpRequest> {
    const openaiMessages = messages.map((msg) => ({
      role: msg.role === 'tool' ? 'user' : msg.role,
      content: msg.content,
    }));

    const model = config.model || 'mimo-v2.5-pro';

    const body: Record<string, unknown> = {
      model,
      messages: openaiMessages,
      stream: true,
      temperature: config.temperature ?? 0.3,
      max_tokens: config.maxTokens ?? 65536,
    };

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'api-key': config.apiKey!,
    };

    return {
      url: MIMO_OFFICIAL_API_URL,
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      conversationId: this._conversationId,
    };
  }


  private async translateStudioInput(messages: Message[], config: LLMConfig): Promise<HttpRequest> {
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

    let queryContent: string;

    if (toolResults.length > 0) {
      const parts = toolResults.map(r => `[Tool Result] ${r.toolName || 'unknown'}\n${r.content}`);
      queryContent = parts.join('\n\n') + '\n\nBased on the tool results above,continue your response,Use ++++ to start commands';
    } else {
      const lastUserMessage = [...nonSystemMessages].reverse().find(m => m.role === 'user');
      if (lastUserMessage) {
        if (systemMessage) {
          queryContent = `${systemMessage.content}\n\n---\n\nUser: ${lastUserMessage.content}`;
        } else {
          queryContent = lastUserMessage.content;
        }
      } else {
        queryContent = '';
      }
    }

    const body: Record<string, unknown> = {
      msgId: this.generateId(),
      query: queryContent,
      stream: true,
      conversationId: this._conversationId,
      isEditedQuery: false,
      modelConfig: {
        enableThinking: true,
        webSearchStatus: 'disabled',
        model: config.model || 'mimo-v2.5-pro',
        temperature: config.temperature ?? 0.7,
        topP: 0.95,
      },
      multiMedias: [],
    };

    if (this.options.botId) {
      body.botId = this.options.botId;
    }

    const url = buildStudioUrl(MIMO_STUDIO_API_URL, this.options.cookies);
    const headers = buildStudioHeaders(this.options.cookies);
    return {
      url,
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    };
  }

  translateOutput(response: unknown): Message {


    const data = response as Record<string, unknown>;

    if (data.choices && Array.isArray(data.choices)) {
      const choice = data.choices[0] as Record<string, unknown>;
      const message = choice.message as Record<string, unknown> | undefined;
      const content = (message?.content as string) ?? '';
      return {
        role: 'assistant',
        content,
        timestamp: Date.now(),
      };
    }

    const content: string =
      this.extractText(data) ??
      (typeof data === 'string'
        ? (data as string)
        : JSON.stringify(data));

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
    let isInThinkBlock = false;
    let pendingThink = '';

    for await (const chunk of stream) {
      buffer += decoder.decode(chunk, { stream: true });

      const parts = buffer.split('\n\n');
      buffer = parts.pop() ?? '';

      for (const part of parts) {
        const sseChunks = [...this.parseSSEBlock(part)];
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
      const sseChunks = [...this.parseSSEBlock(buffer)];
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
        content: pendingThink.replace(MiMoAdapter.OUTPUT_CONTROL_CHAR_REGEX, ''),
      };
    }

    yield { type: 'done', content: '' };
  }

  processThinkTagsInternal(
    chunk: StreamChunk,
    isInThinkBlock: boolean,
    pendingThink: string,
    setState: (isInThink: boolean, pendingThink: string) => void
  ): Generator<StreamChunk> {
    const result = this.processThinkTags(chunk, isInThinkBlock, pendingThink);
    setState(result.isInThinkBlock, result.pendingThink);
    return (function* () { yield* result.events; })();
  }

  findPartialThinkTagInternal(content: string): number {
    return -1;
  }

  private static readonly THINK_DELIMITER = '\u0000';
  private static readonly THINK_OPEN_MARKER = `<think>${MiMoAdapter.THINK_DELIMITER}`;
  private static readonly THINK_CLOSE_MARKER = `</think>${MiMoAdapter.THINK_DELIMITER}`;

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
        ? MiMoAdapter.THINK_CLOSE_MARKER
        : MiMoAdapter.THINK_OPEN_MARKER;
      const taggedMarkerIdx = content.indexOf(taggedMarker);
      const delimIdx = content.indexOf(MiMoAdapter.THINK_DELIMITER);
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
      content = content.substring(markerIdx + (useTaggedMarker ? taggedMarker.length : MiMoAdapter.THINK_DELIMITER.length));
    }

    for (const event of events) {
      if (event.content) {
        event.content = event.content.replace(MiMoAdapter.OUTPUT_CONTROL_CHAR_REGEX, '');
      }
    }

    return { events, isInThinkBlock: currentInThink, pendingThink: newPendingThink };
  }

  private getSafeThinkContentLength(content: string, isInThinkBlock: boolean): number {
    const taggedMarker = isInThinkBlock
      ? MiMoAdapter.THINK_CLOSE_MARKER
      : MiMoAdapter.THINK_OPEN_MARKER;
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

  private static readonly CONTROL_CHAR_REGEX = /[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]/g;
  private static readonly OUTPUT_CONTROL_CHAR_REGEX = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

  private cleanContent(text: string): string {
    return text.replace(MiMoAdapter.CONTROL_CHAR_REGEX, '');
  }

  private *parseSSEBlock(block: string): Generator<StreamChunk> {
    const lines = block.split('\n');
    let eventType = '';
    let dataStr = '';

    for (const line of lines) {
      if (line.startsWith('event:')) {
        eventType = line.substring(6).trim();
      } else if (line.startsWith('data:')) {
        dataStr = line.substring(5).trim();
      } else if (line.startsWith('id:') || line.trim() === '') {
        continue;
      }
    }

    if (!dataStr) return;

    if (dataStr === '[DONE]') {
      return;
    }

    try {
      const parsed = JSON.parse(dataStr) as Record<string, unknown>;

      if (parsed.code === 401) {
        yield {
          type: 'error',
          content: 'Authentication failed (401). Your cookies may have expired.',
        };
        return;
      }

      if (eventType === 'error') {
        const content = parsed.content as string;
        yield { type: 'error', content: content || JSON.stringify(parsed) };
        return;
      }

      if (eventType === 'dialogId') {
        const content = parsed.content as string;
        if (content) {
          this._dialogId = content;
          console.log('[MiMo] Captured dialogId:', content);
        }
        return;
      }

      if (eventType === 'message' || eventType === 'thinking' || eventType === '') {
        const type = parsed.type as string;
        const content = this.cleanContent(parsed.content as string);

        // console.log(`[MiMo SSE] eventType=${eventType}, parsed.type=${type}, content=${content.substring(0, 80)}`);

        if (type === 'thinking' && content) {
          yield { type: 'thinking', content };
        } else if (type === 'text' && content) {
          yield { type: 'text', content };
        } else if (type === 'tool_call') {
          yield { type: 'tool_call', content: JSON.stringify(parsed) };
        } else if (type === 'error') {
          yield { type: 'error', content: content || JSON.stringify(parsed) };
        } else if (eventType === 'thinking' && content) {
          yield { type: 'thinking', content };
        }
      }

      if (parsed.choices && Array.isArray(parsed.choices)) {
        const choice = parsed.choices[0] as MiMoStreamChoice;
        if (choice?.delta?.content) {
          const content = this.cleanContent(choice.delta.content);
          if (content) yield { type: 'text', content };
        }
        if (choice?.delta?.reasoning_content) {
          const content = this.cleanContent(choice.delta.reasoning_content);
          if (content) yield { type: 'thinking', content };
        }
        if (choice?.finish_reason === 'stop' || choice?.finish_reason === 'length') {
          return;
        }
      }
    } catch {
      const cleaned = this.cleanContent(dataStr);
      if (cleaned.length > 0 && cleaned !== '{}') {
        yield { type: 'text', content: cleaned };
      }
    }
  }

  abort(): void {
  }

  async saveConversation(title?: string): Promise<boolean> {
    if (!this.options.cookies) {
      console.log('[MiMo] saveConversation skipped: no cookies');
      return false;
    }

    try {
      const url = buildStudioUrl(
        'https://aistudio.xiaomimimo.com/open-apis/chat/conversation/save',
        this.options.cookies
      );
      const headers = buildStudioHeaders(this.options.cookies);

      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          conversationId: this._conversationId,
          title: title || '新对话',
          type: 'chat',
        }),
      });

      if (!response.ok) {
        console.log('[MiMo] saveConversation failed: status', response.status);
        return false;
      }

      const data = await response.json() as Record<string, unknown>;
      console.log('[MiMo] saveConversation result:', JSON.stringify(data));
      return (data.code as number) === 0;
    } catch (err) {
      console.error('[MiMo] saveConversation error:', err);
      return false;
    }
  }

  async genTitle(aiResponse: string): Promise<string | null> {
    if (!this._dialogId || !this.options.cookies) {
      console.log('[MiMo] genTitle skipped: no dialogId or cookies');
      return null;
    }

    const content = aiResponse.substring(0, 500);

    try {
      const url = buildStudioUrl(
        'https://aistudio.xiaomimimo.com/open-apis/chat/conversation/genTitle',
        this.options.cookies
      );
      const headers = buildStudioHeaders(this.options.cookies);

      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          conversationId: this._conversationId,
          content,
        }),
      });

      if (!response.ok) {
        console.log('[MiMo] genTitle failed: status', response.status);
        return null;
      }

      const data = await response.json() as Record<string, unknown>;
      const title = (data.data as string) || (data.title as string) || (data.content as string) || null;
      console.log('[MiMo] genTitle result:', title);
      return title;
    } catch (err) {
      console.error('[MiMo] genTitle error:', err);
      return null;
    }
  }

  private extractText(data: Record<string, unknown>): string | null {
    for (const key of ['text', 'content', 'data']) {
      const value = data[key];
      if (typeof value === 'string' && value.length > 0) {
        return value;
      }
      if (typeof value === 'object' && value !== null) {
        const nested = value as Record<string, unknown>;
        const nestedText = this.extractText(nested);
        if (nestedText !== null) return nestedText;
      }
    }
    return null;
  }
}
