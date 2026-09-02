import { isEditorBlockTool, isTextModeTool } from './toolNamesStore';

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function unescapeHtmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

export function stripThinkTags(text: string): string {
  const normalized = unescapeHtmlEntities(text);
  const stripped = normalized.replace(/<think[\s\S]*?(?:<\/think>|$)/gi, '').trim();
  return stripped || text;
}

export type ContentSegment =
  | { type: 'text'; content: string }
  | { type: 'toolInstruction'; content: string; label: string; instructionType: 'editorBlock' };

interface ToolInstructionMatch {
  start: number;
  end: number;
  content: string;
  label: string;
  instructionType: 'editorBlock';
}

const EDITOR_BLOCK_START = '++++';
const EDITOR_BLOCK_END = '++++ end';

export function parseContentSegments(content: string): ContentSegment[] {
  const normalized = unescapeHtmlEntities(content);
  const matches = findEditorBlockMatches(normalized);

  matches.sort((a, b) => a.start - b.start);

  const filtered: ToolInstructionMatch[] = [];
  for (const m of matches) {
    if (filtered.length === 0 || m.start >= filtered[filtered.length - 1].end) {
      filtered.push(m);
    }
  }

  const segments: ContentSegment[] = [];
  let lastEnd = 0;
  for (const m of filtered) {
    if (m.start > lastEnd) {
      segments.push({ type: 'text', content: normalized.slice(lastEnd, m.start) });
    }
    segments.push({
      type: 'toolInstruction',
      content: m.content,
      label: m.label,
      instructionType: m.instructionType,
    });
    lastEnd = m.end;
  }
  if (lastEnd < normalized.length) {
    segments.push({ type: 'text', content: normalized.slice(lastEnd) });
  }

  return segments.length > 0 ? segments : [{ type: 'text', content: normalized }];
}

function findEditorBlockMatches(content: string): ToolInstructionMatch[] {
  const matches: ToolInstructionMatch[] = [];
  let searchIndex = 0;

  while (searchIndex < content.length) {
    const nextBlock = findNextEditorBlock(content, searchIndex);
    if (!nextBlock) break;
    matches.push(nextBlock);
    searchIndex = nextBlock.end;
  }

  return matches;
}

function findNextEditorBlock(content: string, fromIndex: number): ToolInstructionMatch | null {
  let searchIndex = fromIndex;

  while (searchIndex < content.length) {
    const start = content.indexOf(EDITOR_BLOCK_START, searchIndex);
    if (start === -1) {
      return null;
    }

    searchIndex = start + EDITOR_BLOCK_START.length;

    const headerEnd = findLineEnd(content, start);
    const headerLine = content.slice(start, headerEnd);
    const label = parseEditorBlockLabel(headerLine);
    if (!label) {
      continue;
    }

    const end = findEditorBlockEnd(content, start);
    if (end === -1) {
      return null;
    }

    return {
      start,
      end,
      content: content.slice(start, end),
      label,
      instructionType: 'editorBlock',
    };
  }

  return null;
}

function findEditorBlockEnd(content: string, start: number): number {
  let searchIndex = start;

  while (searchIndex < content.length) {
    const closeIndex = content.indexOf(EDITOR_BLOCK_END, searchIndex);
    if (closeIndex === -1) {
      return -1;
    }

    searchIndex = closeIndex + 1;

    if (!isLineStart(content, closeIndex) || !isMarkerBoundary(content, closeIndex + EDITOR_BLOCK_END.length)) {
      continue;
    }

    let end = closeIndex + EDITOR_BLOCK_END.length;
    while (end < content.length && (content[end] === ' ' || content[end] === '\t')) {
      end++;
    }
    if (content[end] === '\r') end++;
    if (content[end] === '\n') end++;
    return end;
  }

  return -1;
}

function parseEditorBlockLabel(headerLine: string): string | null {
  if (!headerLine.startsWith(EDITOR_BLOCK_START)) {
    return null;
  }

  const headerContent = headerLine.slice(EDITOR_BLOCK_START.length).trim();
  if (!headerContent || headerContent === 'end') {
    return null;
  }

  const toolName = headerContent.split(/\s+/, 1)[0];
  return isEditorBlockTool(toolName) ? toolName : null;
}

function findLineEnd(content: string, start: number): number {
  const newlineIndex = content.indexOf('\n', start);
  return newlineIndex === -1 ? content.length : newlineIndex;
}

function isLineStart(content: string, index: number): boolean {
  return index === 0 || content[index - 1] === '\n';
}

function isMarkerBoundary(content: string, index: number): boolean {
  if (index >= content.length) return true;
  const char = content[index];
  return char === ' ' || char === '\t' || char === '\r' || char === '\n';
}

export type TextPart =
  | { type: 'text'; content: string }
  | { type: 'codeBlock'; language: string; code: string };

/**
 * Parse text containing fenced code blocks (```lang\n...\n```) into parts.
 * Returns an array of plain-text and code-block parts.
 */
export function parseTextWithCodeBlocks(text: string): TextPart[] {
  const parts: TextPart[] = [];
  const lines = text.split('\n');
  let i = 0;
  let textBuf: string[] = [];

  const flushText = () => {
    if (textBuf.length > 0) {
      const joined = textBuf.join('\n');
      if (joined) parts.push({ type: 'text', content: joined });
      textBuf = [];
    }
  };

  while (i < lines.length) {
    const fenceMatch = lines[i].match(/^```([\w+#.-]*)\s*$/);
    if (fenceMatch) {
      flushText();
      const lang = fenceMatch[1] || '';
      const codeLines: string[] = [];
      i++;
      let closed = false;
      while (i < lines.length) {
        if (/^```\s*$/.test(lines[i])) {
          closed = true;
          i++;
          break;
        }
        codeLines.push(lines[i]);
        i++;
      }
      parts.push({ type: 'codeBlock', language: lang, code: codeLines.join('\n') });
      if (!closed) break;
    } else {
      textBuf.push(lines[i]);
      i++;
    }
  }
  flushText();

  return parts.length > 0 ? parts : [{ type: 'text', content: text }];
}

export type RenderableItem =
  | { type: 'user'; message: Message; key: string }
  | { type: 'assistant'; message: Message; key: string; isStreaming: boolean; isPendingConfirmation: boolean }
  | { type: 'toolCall'; item: ToolBatchItem; key: string; isWaitingConfirmation: boolean };

import type { Message, ToolBatchItem, AgentState } from '@xai/shared';

export function processMessages(messages: Message[], agentState: AgentState): RenderableItem[] {
  const items: RenderableItem[] = [];
  const isStreaming = agentState === 'thinking';
  const isWaitingConfirmation = agentState === 'waiting_confirmation';

  let lastAssistantIndex = -1;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    if (msg.role === 'user') {
      items.push({ type: 'user', message: msg, key: `msg-${i}` });
    } else if (msg.role === 'assistant') {
      if (msg.toolName === '__tool_batch__' && msg.toolBatch) {
        for (let j = 0; j < msg.toolBatch.length; j++) {
          const toolItem = msg.toolBatch[j];
          const isTextModeToolType = isTextModeTool(toolItem.toolName);
          const shouldRenderSeparately = !isTextModeToolType || !!toolItem.result || (isWaitingConfirmation && !toolItem.result);
          if (!shouldRenderSeparately) {
            continue;
          }
          items.push({
            type: 'toolCall',
            item: toolItem,
            key: `msg-${i}-tool-${j}`,
            isWaitingConfirmation: isWaitingConfirmation && !toolItem.result,
          });
        }
      } else if (msg.toolName && msg.toolName !== '__tool_batch__') {
        // skip confirmation/tool messages - handled separately
      } else {
        const itemIndex = items.length;
        items.push({
          type: 'assistant',
          message: msg,
          key: `msg-${i}`,
          isStreaming: isStreaming && i === messages.length - 1,
          isPendingConfirmation: false,
        });
        lastAssistantIndex = itemIndex;
      }
    }
  }

  if (isWaitingConfirmation && lastAssistantIndex >= 0) {
    const lastItem = items[lastAssistantIndex];
    if (lastItem.type === 'assistant') {
      items[lastAssistantIndex] = {
        ...lastItem,
        isStreaming: true,
        isPendingConfirmation: true,
      };
    }
  }

  return items;
}
