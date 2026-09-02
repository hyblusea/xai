import os from 'os';
import path from 'path';
import { AiderStyleParser } from './aider-style-parser.js';
import { createDefaultRegistry } from '../tools/index.js';

// Test the problematic input
const input = '++++ list_files path:. recursive:true pattern:*.*\n++++ end';

console.log('Testing parser with:', input);
console.log('');

const registry = createDefaultRegistry(path.join(os.tmpdir(), 'aider-parser-test'));
const parser = new AiderStyleParser({ toolRegistry: registry });
const events = [...parser.feed(input), ...parser.flush()];

console.log('Events generated:');
for (const event of events) {
  console.log(`  Type: ${event.type}`);
  if (event.toolCall) {
    console.log(`    Tool: ${event.toolCall.name}`);
    console.log(`    Params:`, event.toolCall.parameters);
  }
  if (event.content && event.type === 'text') {
    console.log(`    Content: ${event.content.substring(0, 100)}`);
  }
}

const toolCalls = events.filter(e => e.type === 'tool_call' && e.toolCall);
console.log('');
console.log(`Total tool calls parsed: ${toolCalls.length}`);
if (toolCalls.length > 0) {
  console.log('✅ Parser works correctly!');
} else {
  console.log('❌ Parser failed to parse the tool call');
}
