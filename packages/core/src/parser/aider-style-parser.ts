import type { ParsedToolCall, ParseEvent, StreamParser, StreamParserOptions } from './types.js';
import type { ToolRegistry } from '../tools/tool-registry.js';

type AiderParserState = 'TEXT' | 'BLOCK';

const BLOCK_START = '++++';
const BLOCK_END = '++++ end';

/**
 * Tool-specific parameter parser. Receives the raw header line (including
 * the `++++ tool_name` marker) and the raw body content. Returns the
 * parameter dict, or `null` if the block is invalid.
 */
export type ToolBlockParamParser = (
  rawHeaderLine: string,
  body: string,
) => Record<string, unknown> | null;

export interface AiderStyleParserOptions extends StreamParserOptions {
  /**
   * A ToolRegistry. If provided, the parser registers every tool in the
   * registry as a valid tool name and uses `tool.parseBlockParams` to
   * extract parameters. This is the recommended way to configure the
   * parser in production.
   */
  toolRegistry?: ToolRegistry;
  /**
   * Alternatively, an explicit map of `tool name -> parameter parser`.
   * Useful for tests or for tools that aren't backed by a ToolRegistry
   * (e.g. dynamically generated MCP tools).
   */
  parameterParsers?: Map<string, ToolBlockParamParser>;
}

export class AiderStyleParser implements StreamParser {
  private state: AiderParserState = 'TEXT';
  private buffer = '';
  private readonly maxBufferSize: number;
  private currentToolName = '';
  private streamedBlockLength: number = 0;
  private readonly toolNames: Set<string>;
  private readonly parameterParsers: Map<string, ToolBlockParamParser>;
  private readonly maxOpenMarkerLength: number;

  constructor(options?: AiderStyleParserOptions) {
    this.maxBufferSize = options?.maxBufferSize ?? 2 * 1024 * 1024;

    this.parameterParsers = new Map(options?.parameterParsers ?? []);
    this.toolNames = new Set(this.parameterParsers.keys());

    if (options?.toolRegistry) {
      for (const tool of options.toolRegistry.getAll()) {
        const name = tool.definition.name;
        this.toolNames.add(name);
        this.parameterParsers.set(name, (header, body) => tool.parseBlockParams(header, body));
      }
    }

    // If the parser is given a registry, only registered tool names are
    // valid markers. Otherwise, allow any non-`end` tool name (the
    // parser becomes permissive and uses a generic key:value fallback
    // for unknown tools).
    if (!options?.toolRegistry) {
      this.toolNames.add('*');
    }

    this.maxOpenMarkerLength = this.computeMaxOpenMarkerLength();
  }

  feed(chunk: string): ParseEvent[] {
    this.buffer += chunk;

    if (this.buffer.length > this.maxBufferSize) {
      return this.handleBufferOverflow();
    }

    return this.process();
  }

  flush(): ParseEvent[] {
    const events: ParseEvent[] = [];

    if (this.state === 'TEXT' && this.buffer.length > 0) {
      const text = this.stripCodeFences(this.buffer);
      if (text) events.push({ type: 'text', content: text });
      this.buffer = '';
    } else if (this.state === 'BLOCK' && this.buffer.length > 0) {
      // Incomplete block (no `++++ end` seen) — emit a summary only,
      // never a tool_call, because we can't trust the contents.
      if (this.buffer.length > this.streamedBlockLength) {
        events.push({ type: 'tool_summary', content: this.buffer.substring(this.streamedBlockLength) });
      }
      this.buffer = '';
    }

    this.state = 'TEXT';
    this.currentToolName = '';
    this.streamedBlockLength = 0;
    return events;
  }

  reset(): void {
    this.state = 'TEXT';
    this.buffer = '';
    this.currentToolName = '';
    this.streamedBlockLength = 0;
  }

  private computeMaxOpenMarkerLength(): number {
    if (this.toolNames.size === 0) {
      // Without registered tools we can't recognise any tool name, so the
      // minimal valid marker is `++++ x`. This still keeps a little look-ahead
      // for the parser.
      return BLOCK_START.length + 2;
    }
    const lengths = Array.from(this.toolNames, (n) => `${BLOCK_START} ${n}`.length);
    return Math.max(...lengths);
  }

  private process(): ParseEvent[] {
    const events: ParseEvent[] = [];
    let continueProcessing = true;

    while (continueProcessing) {
      continueProcessing = false;

      if (this.state === 'TEXT') {
        const result = this.processTextState();
        if (result.length > 0) {
          events.push(...result);
          continueProcessing = true;
        }
      } else if (this.state === 'BLOCK') {
        const result = this.processBlockState();
        if (result.length > 0) {
          events.push(...result);
          continueProcessing = true;
        }
      }
    }

    if (this.state === 'BLOCK' && this.buffer.length > this.streamedBlockLength) {
      events.push({ type: 'tool_summary', content: this.buffer.substring(this.streamedBlockLength) });
      this.streamedBlockLength = this.buffer.length;
    }

    return events;
  }

  private processTextState(): ParseEvent[] {
    const events: ParseEvent[] = [];
    const blockStart = this.findNextBlockStart(this.buffer, 0);
    if (!blockStart) {
      const keepLength = this.maxOpenMarkerLength - 1;
      if (this.buffer.length > keepLength) {
        const emitLength = this.buffer.length - keepLength;
        const text = this.stripCodeFences(this.buffer.substring(0, emitLength));
        if (text) events.push({ type: 'text', content: text });
        this.buffer = this.buffer.substring(emitLength);
      }
      return events;
    }

    if (blockStart.index > 0) {
      const text = this.stripCodeFences(this.buffer.substring(0, blockStart.index));
      if (text) events.push({ type: 'text', content: text });
    }

    this.buffer = this.buffer.substring(blockStart.index);
    this.state = 'BLOCK';
    this.currentToolName = blockStart.toolName;
    this.streamedBlockLength = 0;
    events.push({ type: 'tool_call_start', content: '' });
    return events;
  }

  private processBlockState(): ParseEvent[] {
    const events: ParseEvent[] = [];

    const closeTagIndex = this.findBlockEnd(this.buffer);
    if (closeTagIndex === -1) {
      return events;
    }

    const rawBlock = this.buffer.substring(0, closeTagIndex);
    const remaining = this.buffer.substring(closeTagIndex);

    if (rawBlock.length > this.streamedBlockLength) {
      events.push({ type: 'tool_summary', content: rawBlock.substring(this.streamedBlockLength) });
    }

    const toolCall = this.parseBlock(rawBlock);
    if (toolCall) {
      events.push({ type: 'tool_call', content: rawBlock, toolCall });
      events.push({ type: 'tool_call_end', content: this.formatToolCallSummary(toolCall), toolCall });
    }

    this.buffer = remaining;
    this.state = 'TEXT';
    this.currentToolName = '';
    this.streamedBlockLength = 0;
    return events;
  }

  private findNextBlockStart(text: string, fromIndex: number): { index: number; toolName: string } | null {
    let searchIndex = fromIndex;

    while (searchIndex < text.length) {
      const startIndex = text.indexOf(BLOCK_START, searchIndex);
      if (startIndex === -1) {
        return null;
      }

      const lineEnd = this.findLineEnd(text, startIndex);
      const headerLine = text.slice(startIndex, lineEnd);
      const parsedHeader = this.parseHeaderLine(headerLine);

      if (parsedHeader) {
        return { index: startIndex, toolName: parsedHeader.toolName };
      }

      searchIndex = startIndex + BLOCK_START.length;
    }

    return null;
  }

  /**
   * Parse a single block. This method is intentionally simple: it identifies
   * the tool and delegates parameter extraction to the tool's registered
   * `parseBlockParams` function. The AiderStyleParser no longer hard-codes
   * any tool-specific parsing logic.
   */
  private parseBlock(raw: string): ParsedToolCall | null {
    const firstNewline = raw.indexOf('\n');
    const headerLine = firstNewline === -1 ? raw : raw.substring(0, firstNewline);
    const parsedHeader = this.parseHeaderLine(headerLine);
    if (!parsedHeader) return null;

    this.currentToolName = parsedHeader.toolName;

    // Extract the body (text between the first newline and the `++++ end` marker).
    let body = '';
    if (firstNewline !== -1) {
      const closeStart = this.findBlockCloseStart(raw);
      const bodyEnd = closeStart === -1 ? raw.length : closeStart;
      body = raw.substring(firstNewline + 1, bodyEnd);
    }

    const parser = this.parameterParsers.get(parsedHeader.toolName);
    if (!parser) {
      // Fallback: generic `key:value` parser used when a tool is not
      // registered (e.g. `tool_search` in tests, or dynamic MCP tools).
      // Body is assigned to a key matching the body-only parameter name,
      // or to `_body` if the tool has no body params at all.
      return this.fallbackParseBlock(parsedHeader.toolName, headerLine, body, raw);
    }

    const parameters = parser(headerLine, body);
    if (!parameters) return null;

    return { name: parsedHeader.toolName, parameters, rawXml: raw };
  }

  /**
   * Generic header parsing fallback for tools that don't have a
   * registered `parseBlockParams`. Scans the header for `name:value`
   * tokens where `value` may contain colons and spaces. The slice
   * for each value is bounded by the next `name:` token, mirroring
   * the algorithm used by `defaultParseBlockParams` for known tools.
   * The raw body is exposed as `_body` for tools without a body
   * parameter definition.
   */
  private fallbackParseBlock(
    toolName: string,
    rawHeaderLine: string,
    body: string,
    raw: string,
  ): ParsedToolCall | null {
    const headerPart = rawHeaderLine.replace(/^\s*\+\+\+\+\s+\S+/, '').trim();

    const parameters: Record<string, unknown> = {};

    if (headerPart) {
      interface Hit {
        name: string;
        start: number;
        valueStart: number;
      }
      const hits: Hit[] = [];
      const tokenRegex = /(\w+):/g;
      let m: RegExpExecArray | null;
      while ((m = tokenRegex.exec(headerPart)) !== null) {
        // The regex matches `name:` anywhere; we only accept matches
        // whose preceding character is a boundary (start-of-string or
        // whitespace). This avoids splitting values like `foo:bar:baz`
        // into `foo` and `bar:baz`.
        if (m.index > 0 && !/\s/.test(headerPart[m.index - 1])) {
          continue;
        }
        hits.push({
          name: m[1],
          start: m.index,
          valueStart: m.index + m[0].length,
        });
      }
      hits.sort((a, b) => a.start - b.start);

      for (let i = 0; i < hits.length; i++) {
        const hit = hits[i];
        const next = hits[i + 1];
        const valueEnd = next ? next.start : headerPart.length;
        const value = headerPart.substring(hit.valueStart, valueEnd).trim();
        if (value === '') continue;
        const boolish = value.toLowerCase();
        if (boolish === 'true') parameters[hit.name] = true;
        else if (boolish === 'false') parameters[hit.name] = false;
        else if (/^-?\d+(?:\.\d+)?$/.test(value)) parameters[hit.name] = Number(value);
        else parameters[hit.name] = value;
      }
    }

    if (body && body.length > 0) {
      let value = body;
      if (value.endsWith('\n')) value = value.slice(0, -1);
      parameters['_body'] = value;
    }

    return { name: toolName, parameters, rawXml: raw };
  }

  private parseHeaderLine(headerLine: string): { toolName: string; headerParams: string } | null {
    if (!headerLine.startsWith(BLOCK_START) || !this.isLineStart(headerLine, 0)) {
      return null;
    }

    const headerContent = headerLine.substring(BLOCK_START.length).trim();
    if (!headerContent || headerContent === 'end') {
      return null;
    }

    const firstSpaceIndex = headerContent.search(/\s/);
    const toolName = firstSpaceIndex === -1 ? headerContent : headerContent.substring(0, firstSpaceIndex);

    const headerParams = firstSpaceIndex === -1 ? '' : headerContent.substring(firstSpaceIndex + 1).trim();
    return { toolName, headerParams };
  }

  private findBlockEnd(content: string): number {
    const closeIndex = this.findBlockCloseStart(content);
    if (closeIndex === -1) return -1;

    let end = closeIndex + BLOCK_END.length;
    while (end < content.length && (content[end] === ' ' || content[end] === '\t')) {
      end++;
    }
    if (content[end] === '\r') end++;
    if (content[end] === '\n') end++;
    return end;
  }

  private findBlockCloseStart(content: string): number {
    let searchIndex = 0;

    while (searchIndex < content.length) {
      const closeIndex = content.indexOf(BLOCK_END, searchIndex);
      if (closeIndex === -1) return -1;
      if (!this.isCloseMarkerValid(content, closeIndex)) {
        searchIndex = closeIndex + BLOCK_START.length;
        continue;
      }
      return closeIndex;
    }

    return -1;
  }

  /**
   * Validate a `++++ end` occurrence. The marker does NOT need to start at
   * the beginning of a line — LLMs sometimes glue it to preceding content
   * (e.g. `...table cell |++++ end`) and requiring a line break there made
   * the whole block unparseable, silently dropping the tool call. We match
   * it anywhere and only guard against the marker being glued to word
   * characters (`++++ ended`, `++++ ending`), which is normal prose.
   */
  private isCloseMarkerValid(content: string, closeIndex: number): boolean {
    return this.isMarkerBoundary(content, closeIndex + BLOCK_END.length);
  }

  private findLineEnd(text: string, startIndex: number): number {
    const newlineIndex = text.indexOf('\n', startIndex);
    return newlineIndex === -1 ? text.length : newlineIndex;
  }

  private isLineStart(content: string, index: number): boolean {
    return index === 0 || content[index - 1] === '\n' || content[index - 1] === '\r';
  }

  private isMarkerBoundary(content: string, index: number): boolean {
    if (index >= content.length) return true;
    const char = content[index];
    // Accept whitespace, newlines, and non-alphanumeric characters (e.g., markdown code fences `)
    // GPT models often wrap command blocks in markdown code fences like ```
    return char === ' ' || char === '\t' || char === '\r' || char === '\n' || char === '`' || char === '~';
  }

  private handleBufferOverflow(): ParseEvent[] {
    const events: ParseEvent[] = [];

    if (this.state === 'TEXT') {
      const text = this.stripCodeFences(this.buffer);
      if (text) events.push({ type: 'text', content: text });
      this.buffer = '';
    } else if (this.state === 'BLOCK') {
      if (this.buffer.length > this.streamedBlockLength) {
        events.push({ type: 'tool_summary', content: this.buffer.substring(this.streamedBlockLength) });
      }
      const toolCall = this.parseBlock(this.buffer);
      if (toolCall) {
        events.push({ type: 'tool_call', content: this.buffer, toolCall });
        events.push({ type: 'tool_call_end', content: this.formatToolCallSummary(toolCall), toolCall });
      }
      this.buffer = '';
    }

    this.state = 'TEXT';
    this.currentToolName = '';
    this.streamedBlockLength = 0;
    return events;
  }

  private stripCodeFences(text: string): string {
    return text.replace(/```\s*\n?/g, '');
  }

  private formatToolCallSummary(toolCall: ParsedToolCall): string {
    const name = toolCall.name;
    const params = toolCall.parameters;
    const parts: string[] = [name];

    if (params['path']) parts.push(String(params['path']));
    if (params['pattern']) parts.push(`pattern:${params['pattern']}`);
    if (params['command']) parts.push(String(params['command']).split('\n')[0]);

    return parts.join(' ');
  }
}

export function extractAiderBlocks(
  text: string,
  options?: AiderStyleParserOptions,
): ParsedToolCall[] {
  const results: ParsedToolCall[] = [];
  const parser = new AiderStyleParser(options);
  const events = parser.feed(text);
  const flushEvents = parser.flush();
  const allEvents = [...events, ...flushEvents];

  for (const event of allEvents) {
    if (event.type === 'tool_call' && event.toolCall && event.toolCall.name) {
      results.push(event.toolCall);
    }
  }

  return results;
}
