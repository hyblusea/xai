import { GptAdapter } from './gpt-adapter.js';
import type { StreamChunk } from '../../shared/src/types.js';

// Mock SSE stream that simulates ChatGPT response with thinking and tool calls
async function* mockSSEStream(): AsyncIterable<Buffer> {
  const mockData = [
    // Thinking start
    'event: delta\ndata: {"p": "/message/content/parts/0", "o": "append", "v": "<think>\\u0000"}\n\n',
    // Thinking content
    'event: delta\ndata: {"p": "/message/content/parts/0", "o": "append", "v": "Let me analyze the request..."}\n\n',
    // Thinking end
    'event: delta\ndata: {"p": "/message/content/parts/0", "o": "append", "v": "\\u0000</think>\\u0000"}\n\n',
    // Regular text
    'event: delta\ndata: {"p": "/message/content/parts/0", "o": "append", "v": "I will list the files for you.\\n\\n"}\n\n',
    // Tool call
    'event: delta\ndata: {"p": "/message/content/parts/0", "o": "append", "v": "++++ list_files path:. recursive:true pattern:*.*\\n++++ end"}\n\n',
  ];

  for (const data of mockData) {
    yield Buffer.from(data);
  }
}

async function testGPTStreamParsing() {
  console.log('=== Testing GPT Adapter Stream Parsing ===\n');

  const adapter = new GptAdapter({
    baseUrl: 'https://chatgpt.com',
    authorization: 'Bearer test-token',
  });

  const stream = mockSSEStream();
  const chunks: StreamChunk[] = [];

  for await (const chunk of adapter.translateStream(stream)) {
    chunks.push(chunk);
    console.log(`Chunk type: ${chunk.type}`);
    if (chunk.content) {
      console.log(`  Content: ${chunk.content.substring(0, 100)}${chunk.content.length > 100 ? '...' : ''}`);
    }
    if (chunk.toolCall) {
      console.log(`  Tool: ${chunk.toolCall.name}`);
    }
    console.log('');
  }

  console.log('\n=== Summary ===');
  const thinkingChunks = chunks.filter(c => c.type === 'thinking');
  const textChunks = chunks.filter(c => c.type === 'text');
  const toolCallChunks = chunks.filter(c => c.type === 'tool_call');

  console.log(`Total chunks: ${chunks.length}`);
  console.log(`Thinking chunks: ${thinkingChunks.length}`);
  console.log(`Text chunks: ${textChunks.length}`);
  console.log(`Tool call chunks: ${toolCallChunks.length}`);

  if (thinkingChunks.length > 0 && textChunks.length > 0) {
    console.log('\n✅ GPT adapter correctly separates thinking and text content!');
  } else {
    console.log('\n❌ GPT adapter failed to separate thinking and text content');
  }
}

testGPTStreamParsing().catch(console.error);
