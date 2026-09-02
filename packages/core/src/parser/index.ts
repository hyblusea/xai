import type { StreamParser, StreamParserOptions } from './types.js';
import { AiderStyleParser, extractAiderBlocks } from './aider-style-parser.js';

export type { ParserState, ParsedToolCall, ParseEvent, StreamParserOptions, StreamParser } from './types.js';
export { AiderStyleParser, extractAiderBlocks } from './aider-style-parser.js';

export function createParser(options?: StreamParserOptions): StreamParser {
  return new AiderStyleParser(options);
}
