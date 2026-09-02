export type ParserState = 'TEXT' | 'TOOL_CALL' | 'THINKING' | 'COMPLETE';

export interface ParsedToolCall {
  name: string;
  parameters: Record<string, unknown>;
  rawXml: string;
}

export interface ParseEvent {
  type: 'text' | 'tool_call' | 'tool_call_start' | 'tool_call_end' | 'tool_summary';
  content: string;
  toolCall?: ParsedToolCall;
}

export interface StreamParserOptions {
  toolCallTag?: string;
  parameterTag?: string;
  maxBufferSize?: number;
}

export interface StreamParser {
  feed(chunk: string): ParseEvent[];
  flush(): ParseEvent[];
  reset(): void;
}
