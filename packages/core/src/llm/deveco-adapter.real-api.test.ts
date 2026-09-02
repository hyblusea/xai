import { describe, it } from 'vitest';
import { DevecoAdapter } from './deveco-adapter.js';
import type { Message, LLMConfig, StreamChunk } from '@xai/shared';
import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * 真实 API 集成测试：调用 DevEco GLM-5.1 真实接口，诊断多轮工具调用中
 * reasoning_content 的产出行为。
 *
 * 此测试为诊断性质，不做硬性断言，只报告每轮的 reasoning 状态。
 * 目标：找到 reasoning 断裂的根因。
 *
 * 运行前提：用户已通过 OAuth 登录 DevEco，deveco-auth.json 存在且 jwtToken 有效。
 */

const AUTH_FILE = path.join(os.homedir(), 'AppData', 'Roaming', 'Electron', 'deveco-auth.json');
const BASE_URL = 'https://cn.devecostudio.huawei.com';
const JWT_CHECK_URL = `${BASE_URL}/authrouter/auth/api/jwToken/check`;

interface StoredAuth {
  type: 'oauth';
  access: string;
  refresh: string;
  jwtToken: string;
  userId: string;
  userName: string;
  expires: number;
}

function loadAuth(): StoredAuth | null {
  try {
    if (!fs.existsSync(AUTH_FILE)) return null;
    const data = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf-8')) as StoredAuth;
    if (data.type === 'oauth' && data.access && data.jwtToken) return data;
  } catch { /* ignore */ }
  return null;
}

async function refreshAccessToken(jwtToken: string): Promise<string> {
  const response = await fetch(JWT_CHECK_URL, {
    method: 'GET',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'accept-language': 'zh-CN',
      'jwtToken': jwtToken,
      'refresh': 'true',
    },
  });
  if (!response.ok) throw new Error(`Token refresh failed: HTTP ${response.status}`);
  const data = await response.json() as { status: boolean; userInfo?: { accessToken: string } };
  if (!data.status || !data.userInfo?.accessToken) throw new Error('Token refresh failed: invalid response');
  return data.userInfo.accessToken;
}

async function getValidToken(): Promise<string | null> {
  const auth = loadAuth();
  if (!auth) return null;
  if (auth.expires > Date.now()) return auth.access;
  try {
    console.log('[RealAPI] Token expired, refreshing...');
    return await refreshAccessToken(auth.jwtToken);
  } catch (err) {
    console.error('[RealAPI] Token refresh failed:', err);
    return null;
  }
}

async function* toAsyncIterable(stream: ReadableStream<Uint8Array>): AsyncIterable<Buffer> {
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      yield Buffer.from(value);
    }
  } finally {
    reader.releaseLock();
  }
}

interface RoundResult {
  thinking: string;
  text: string;
  toolCalls: Array<{ name: string; parameters: Record<string, unknown> }>;
  deltaSummary: { reasoningCount: number; contentCount: number; toolCallCount: number };
}

async function callRealApi(
  adapter: DevecoAdapter,
  messages: Message[],
  config: LLMConfig,
  roundLabel: string,
  printBody: boolean = false,
): Promise<RoundResult> {
  const request = await adapter.translateInput(messages, config);

  if (printBody) {
    const parsed = JSON.parse(request.body);
    console.log(`\n[${roundLabel}] 请求体:`);
    console.log(JSON.stringify(parsed, null, 2));
  }

  console.log(`\n[${roundLabel}] 发送请求...`);

  const response = await fetch(request.url, {
    method: request.method,
    headers: request.headers as Record<string, string>,
    body: request.body,
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`API ${response.status}: ${errorBody.substring(0, 500)}`);
  }

  if (!response.body) throw new Error('Response body is null');

  let thinking = '';
  let text = '';
  const toolCalls: Array<{ name: string; parameters: Record<string, unknown> }> = [];
  let reasoningCount = 0;
  let contentCount = 0;
  let toolCallCount = 0;

  for await (const chunk of adapter.translateStream(toAsyncIterable(response.body))) {
    if (chunk.type === 'thinking') {
      thinking += chunk.content;
      if (thinking.length === chunk.content.length) reasoningCount = 1; // first reasoning delta
    } else if (chunk.type === 'text') {
      text += chunk.content;
    } else if (chunk.type === 'tool_call' && chunk.toolCall) {
      toolCalls.push({ name: chunk.toolCall.name, parameters: chunk.toolCall.parameters });
    }
  }

  // 通过 thinking 长度判断是否有 reasoning delta
  reasoningCount = thinking.length > 0 ? 1 : 0;
  contentCount = text.length > 0 ? 1 : 0;
  toolCallCount = toolCalls.length > 0 ? 1 : 0;

  console.log(`[${roundLabel}] 完成: reasoning=${reasoningCount > 0} content=${contentCount > 0} tool_calls=${toolCallCount > 0}`);

  return { thinking, text, toolCalls, deltaSummary: { reasoningCount, contentCount, toolCallCount } };
}

// ── 工具定义 ──────────────────────────────────────────────────────────────────

const TEST_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: '列出指定目录下的文件和子目录',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: '要列出的目录路径' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: '读取指定文件的内容',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: '要读取的文件路径' } },
        required: ['path'],
      },
    },
  },
];

function makeToolResult(toolName: string, output: string): Message {
  return {
    role: 'tool',
    content: `[Tool Result] ${toolName} - 成功\nOutput:\n${output}`,
    timestamp: Date.now(),
    toolName,
    toolResult: { toolName, success: true, output },
  };
}

// ── 模拟 react-loop 的系统提示词（接近 778 字符） ─────────────────────────────

const SYSTEM_PROMPT = `## WORKSPACE

Path: D:\\myProject\\xAI
All file paths are relative to this path.

## EXTENDED TOOL CALL RULE Example:
++++ tool_name headerParam1:value1 headerParam2:value2
body content here (free-form text, can be multiple lines)
++++ end 

## EXTENDED TOOL LIST. 

### list_files
列出指定目录下的文件和子目录

Parameters:
  - path (string) [required]
  - 要列出的目录路径

### read_file
读取指定文件的内容

Parameters:
  - path (string) [required]
  - 要读取的文件路径`;

// ── 测试 ──────────────────────────────────────────────────────────────────────

const TOKEN_AVAILABLE = (() => {
  const auth = loadAuth();
  return !!auth;
})();

describe('DevecoAdapter 真实 API reasoning 诊断测试', () => {
  it.skipIf(!TOKEN_AVAILABLE)(
    '多轮工具调用 reasoning 诊断（真实 GLM-5.1）',
    async () => {
      const token = await getValidToken();
      if (!token) {
        console.log('[RealAPI] 无法获取有效 token，跳过');
        return;
      }

      const adapter = new DevecoAdapter({ accessToken: token });

      // ★ 使用 temperature 0.3 对齐用户配置
      const config: LLMConfig = {
        provider: 'deveco',
        model: 'GLM-5.1',
        temperature: 0.3,
        stream: true,
        options: { tools: TEST_TOOLS },
      };

      const rounds: Array<{
        round: number;
        hasThinking: boolean;
        thinkingLen: number;
        thinkingPreview: string;
        textPreview: string;
        toolCallCount: number;
        toolCallNames: string[];
      }> = [];

      // ── 第 1 轮 ──
      console.log('\n\n██████ 第 1 轮：用户提问 ██████');
      const messages1: Message[] = [
        { role: 'system', content: SYSTEM_PROMPT, timestamp: 1 },
        {
          role: 'user',
          content: '帮我查看 D:\\myProject\\xAI 目录下有哪些文件，然后读取 package.json 文件的内容',
          timestamp: 2,
        },
      ];

      const result1 = await callRealApi(adapter, messages1, config, 'Round 1', true);

      console.log(`\n--- 第 1 轮结果 ---`);
      console.log(`  thinking: ${result1.thinking ? `${result1.thinking.length} chars` : '(无)'}`);
      if (result1.thinking) console.log(`  thinking 预览: ${result1.thinking.substring(0, 150)}`);
      console.log(`  text: ${result1.text ? `"${result1.text.substring(0, 150)}"` : '(无)'}`);
      console.log(`  tool_calls: ${result1.toolCalls.length}`);
      for (const tc of result1.toolCalls) {
        console.log(`    → ${tc.name}(${JSON.stringify(tc.parameters)})`);
      }

      rounds.push({
        round: 1,
        hasThinking: result1.thinking.length > 0,
        thinkingLen: result1.thinking.length,
        thinkingPreview: result1.thinking.substring(0, 80),
        textPreview: result1.text.substring(0, 80),
        toolCallCount: result1.toolCalls.length,
        toolCallNames: result1.toolCalls.map(tc => tc.name),
      });

      if (result1.toolCalls.length === 0) {
        console.log('\n⚠️ 第 1 轮无 tool_calls，无法继续多轮测试');
        return;
      }

      // ── 第 2 轮：工具结果反馈 ──
      console.log('\n\n██████ 第 2 轮：工具结果反馈 ██████');
      const toolResults1: Message[] = result1.toolCalls.map((tc) => {
        let output = '';
        if (tc.name === 'list_files') output = 'package.json\ntsconfig.json\nsrc/\npackages/\nREADME.md';
        else if (tc.name === 'read_file') output = '{\n  "name": "xai-ide",\n  "version": "1.0.0",\n  "private": true\n}';
        else output = 'OK';
        return makeToolResult(tc.name, output);
      });

      const result2 = await callRealApi(adapter, toolResults1, config, 'Round 2');

      console.log(`\n--- 第 2 轮结果 ---`);
      console.log(`  thinking: ${result2.thinking ? `${result2.thinking.length} chars` : '(无)'}`);
      if (result2.thinking) console.log(`  thinking 预览: ${result2.thinking.substring(0, 150)}`);
      console.log(`  text: ${result2.text ? `"${result2.text.substring(0, 150)}"` : '(无)'}`);
      console.log(`  tool_calls: ${result2.toolCalls.length}`);
      for (const tc of result2.toolCalls) {
        console.log(`    → ${tc.name}(${JSON.stringify(tc.parameters)})`);
      }

      rounds.push({
        round: 2,
        hasThinking: result2.thinking.length > 0,
        thinkingLen: result2.thinking.length,
        thinkingPreview: result2.thinking.substring(0, 80),
        textPreview: result2.text.substring(0, 80),
        toolCallCount: result2.toolCalls.length,
        toolCallNames: result2.toolCalls.map(tc => tc.name),
      });

      // ── 第 3 轮 ──
      if (result2.toolCalls.length > 0) {
        console.log('\n\n██████ 第 3 轮：工具结果反馈 ██████');
        const toolResults2: Message[] = result2.toolCalls.map((tc) => {
          let output = '';
          if (tc.name === 'read_file') output = '{\n  "name": "xai-ide",\n  "version": "1.0.0",\n  "type": "module"\n}';
          else if (tc.name === 'list_files') output = 'packages/\nsrc/\ntsconfig.json';
          else output = 'OK';
          return makeToolResult(tc.name, output);
        });

        const result3 = await callRealApi(adapter, toolResults2, config, 'Round 3');

        console.log(`\n--- 第 3 轮结果 ---`);
        console.log(`  thinking: ${result3.thinking ? `${result3.thinking.length} chars` : '(无)'}`);
        if (result3.thinking) console.log(`  thinking 预览: ${result3.thinking.substring(0, 150)}`);
        console.log(`  text: ${result3.text ? `"${result3.text.substring(0, 150)}"` : '(无)'}`);
        console.log(`  tool_calls: ${result3.toolCalls.length}`);

        rounds.push({
          round: 3,
          hasThinking: result3.thinking.length > 0,
          thinkingLen: result3.thinking.length,
          thinkingPreview: result3.thinking.substring(0, 80),
          textPreview: result3.text.substring(0, 80),
          toolCallCount: result3.toolCalls.length,
          toolCallNames: result3.toolCalls.map(tc => tc.name),
        });

        // ── 第 4 轮 ──
        if (result3.toolCalls.length > 0) {
          console.log('\n\n██████ 第 4 轮：工具结果反馈 ██████');
          const toolResults3: Message[] = result3.toolCalls.map((tc) =>
            makeToolResult(tc.name, 'File content: {"name":"xai-ide","version":"1.0.0"}'),
          );

          const result4 = await callRealApi(adapter, toolResults3, config, 'Round 4');

          console.log(`\n--- 第 4 轮结果 ---`);
          console.log(`  thinking: ${result4.thinking ? `${result4.thinking.length} chars` : '(无)'}`);
          if (result4.thinking) console.log(`  thinking 预览: ${result4.thinking.substring(0, 150)}`);
          console.log(`  text: ${result4.text ? `"${result4.text.substring(0, 150)}"` : '(无)'}`);
          console.log(`  tool_calls: ${result4.toolCalls.length}`);

          rounds.push({
            round: 4,
            hasThinking: result4.thinking.length > 0,
            thinkingLen: result4.thinking.length,
            thinkingPreview: result4.thinking.substring(0, 80),
            textPreview: result4.text.substring(0, 80),
            toolCallCount: result4.toolCalls.length,
            toolCallNames: result4.toolCalls.map(tc => tc.name),
          });
        }
      }

      // ── 汇总报告 ──
      console.log('\n\n');
      console.log('╔══════════════════════════════════════════════════════════════╗');
      console.log('║              多轮 reasoning 诊断报告                        ║');
      console.log('╠══════╦══════════╦═════════════╦══════════╦═════════════════╣');
      console.log('║ 轮次 ║ thinking ║ thinking长度 ║ tool调用 ║ 状态            ║');
      console.log('╠══════╬══════════╬═════════════╬══════════╬═════════════════╣');
      for (const r of rounds) {
        const status = r.hasThinking ? '✅ 有reasoning' : '❌ 无reasoning';
        const thinkStr = r.hasThinking ? '✅ 有' : '❌ 无';
        console.log(`║  ${r.round}   ║  ${thinkStr}   ║  ${String(r.thinkingLen).padStart(9)}   ║   ${r.toolCallCount}      ║ ${status.padEnd(15)} ║`);
      }
      console.log('╚══════╩══════════╩═════════════╩══════════╩═════════════════╝');

      const firstLoss = rounds.find(r => !r.hasThinking);
      if (firstLoss) {
        console.log(`\n⚠️  第 ${firstLoss.round} 轮首次丢失 reasoning！`);
      } else {
        console.log('\n✅ 所有轮次都产出了 reasoning！');
      }

      // 检查 history 中 assistant 消息的 think_tag
      const history = (adapter as unknown as { conversationHistory: Array<Record<string, unknown>> }).conversationHistory;
      console.log('\n--- conversationHistory 概要 ---');
      for (let i = 0; i < history.length; i++) {
        const m = history[i];
        const content = typeof m.content === 'string' ? m.content : '';
        const hasThink = content.includes('<think>');
        console.log(`  [${i}] role=${m.role} content=${m.content === null ? 'null' : `str(${content.length})`} think_tag=${hasThink ? 'yes' : 'no'} tool_calls=${m.tool_calls ? 'yes' : 'no'}`);
      }

      console.log('\n========== 诊断测试完成 ==========');
    },
    180_000,
  );
});
