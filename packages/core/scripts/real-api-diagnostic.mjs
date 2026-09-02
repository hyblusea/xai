/**
 * 真实 API 诊断脚本：直接调用 DevEco GLM-5.1 真实接口，
 * 诊断多轮工具调用中 reasoning_content 的产出行为。
 *
 * 完全复刻 deveco-adapter.ts 的行为：
 *   - translateInput: 构建请求体（messages + tools + temperature）
 *   - translateStream: 解析 SSE 流，提取 reasoning_content / content / tool_calls
 *   - commitAssistantMessage: 用「智能」标签把 reasoning 拼入 content 持久化
 *
 * 运行方式：
 *   node packages/core/scripts/real-api-diagnostic.mjs
 *
 * 前提：用户已通过 OAuth 登录 DevEco，deveco-auth.json 存在。
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

const AUTH_FILE = path.join(os.homedir(), 'AppData', 'Roaming', 'Electron', 'deveco-auth.json');
const BASE_URL = 'https://cn.devecostudio.huawei.com';
const JWT_CHECK_URL = `${BASE_URL}/authrouter/auth/api/jwToken/check`;
const CHAT_COMPLETIONS_PATH = '/sse/codeGenie/maas/v2/chat/completions';

// ── 认证 ──────────────────────────────────────────────────────────────────────

function loadAuth() {
  try {
    if (!fs.existsSync(AUTH_FILE)) {
      console.log('[RealAPI] Auth file not found:', AUTH_FILE);
      return null;
    }
    const data = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf-8'));
    if (data.type === 'oauth' && data.access && data.jwtToken) return data;
    console.log('[RealAPI] Auth file exists but missing required fields');
  } catch (err) {
    console.log('[RealAPI] Failed to load auth:', err.message);
  }
  return null;
}

async function refreshAccessToken(jwtToken) {
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
  const data = await response.json();
  if (!data.status || !data.userInfo?.accessToken) throw new Error('Token refresh failed: invalid response');
  return data.userInfo.accessToken;
}

async function getValidToken() {
  const auth = loadAuth();
  if (!auth) return null;
  if (auth.expires > Date.now()) {
    console.log('[RealAPI] Using cached access token (not expired)');
    return auth.access;
  }
  try {
    console.log('[RealAPI] Token expired, refreshing...');
    return await refreshAccessToken(auth.jwtToken);
  } catch (err) {
    console.error('[RealAPI] Token refresh failed:', err.message);
    return null;
  }
}

function uuidNoHyphen() {
  return 'xxxxxxxxxxxx4xxxyxxxxxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// ── 会话历史（复刻 DevecoAdapter 的 conversationHistory） ────────────────────

let conversationHistory = [];
let pendingToolCallIdQueue = [];
const chatId = uuidNoHyphen();

function resetSession() {
  conversationHistory = [];
  pendingToolCallIdQueue = [];
}

// ── translateInput（复刻 deveco-adapter.ts） ──────────────────────────────────

function appendNewMessages(messages) {
  for (const msg of messages) {
    if (msg.role === 'tool' && msg.toolName) {
      let toolCallId = pendingToolCallIdQueue.shift();
      if (toolCallId) {
        conversationHistory.push({
          role: 'tool',
          content: msg.content,
          tool_call_id: toolCallId,
        });
      }
    } else if (msg.role === 'system') {
      const hasSystem = conversationHistory.some(m => m.role === 'system');
      if (!hasSystem && msg.content) {
        conversationHistory.unshift({ role: 'system', content: msg.content });
      }
    } else if (msg.role === 'user') {
      const lastUser = [...conversationHistory].reverse().find(m => m.role === 'user');
      if (!lastUser || lastUser.content !== msg.content) {
        conversationHistory.push({ role: 'user', content: msg.content });
      }
    }
  }
}

function buildRequestBody(config) {
  const openaiMessages = conversationHistory.map(m => {
    const out = { role: m.role, content: m.content };
    // 不回传 reasoning_content（对齐 deveco 源码）
    if (m.tool_calls) out.tool_calls = m.tool_calls;
    if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
    return out;
  });

  const body = {
    model: config.model || 'GLM-5.1',
    messages: openaiMessages,
    stream: true,
    temperature: config.temperature,
  };

  if (config.options?.tools && Array.isArray(config.options.tools) && config.options.tools.length > 0) {
    body.tools = config.options.tools;
    body.tool_choice = 'auto';
  }

  // 不设置 thinking 参数（对齐 deveco 源码：deveco providerID 不匹配 thinking 分支）

  return body;
}

function buildHeaders(token) {
  return {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
    'lang': 'en',
    'Chat-Id': chatId,
    'Accept': 'text/event-stream',
  };
}

// ── translateStream（复刻 deveco-adapter.ts） ─────────────────────────────────

async function* translateStream(stream) {
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let assistantContent = '';
  let assistantReasoning = '';
  const toolCallAccumulators = new Map();
  const completedToolCalls = [];
  const completedIndices = new Set();

  const emitPendingToolCalls = function* () {
    for (const [idx, acc] of toolCallAccumulators) {
      if (completedIndices.has(idx)) continue;
      completedIndices.add(idx);
      try {
        const parameters = acc.arguments ? JSON.parse(acc.arguments) : {};
        completedToolCalls.push({ id: acc.id, name: acc.name, parameters });
        yield { type: 'tool_call', content: '', toolCall: { name: acc.name, parameters } };
      } catch {
        console.warn('[DevEco] Failed to parse tool_call arguments:', acc.arguments);
      }
    }
  };

  const handleDataEvent = function* (dataStr) {
    if (dataStr === '[DONE]' || dataStr === '') return;

    let parsed;
    try {
      parsed = JSON.parse(dataStr);
    } catch {
      return;
    }
    const choice = parsed.choices?.[0];
    if (!choice) return;

    // reasoning / thinking
    const reasoningContent = choice.delta?.reasoning_content;
    if (reasoningContent) {
      if (!assistantReasoning) {
        console.log('[DevEco] reasoning_content detected in stream, thinking mode active');
      }
      assistantReasoning += reasoningContent;
      yield { type: 'thinking', content: reasoningContent };
    }

    // 调试日志
    const delta = choice.delta;
    if (delta && (delta.content || delta.reasoning_content || delta.tool_calls)) {
      const hasR = !!delta.reasoning_content;
      const hasC = !!delta.content;
      const hasT = !!delta.tool_calls;
      console.log(`[DevEco] delta: reasoning=${hasR} content=${hasC} tool_calls=${hasT} finish=${choice.finish_reason ?? ''}`);
    }

    // text content
    const content = choice.delta?.content;
    if (content) {
      assistantContent += content;
      yield { type: 'text', content };
    }

    // tool_calls deltas
    const toolCallDeltas = choice.delta?.tool_calls;
    if (toolCallDeltas) {
      for (const tcDelta of toolCallDeltas) {
        const idx = tcDelta.index;
        let acc = toolCallAccumulators.get(idx);
        if (!acc) {
          acc = { id: tcDelta.id ?? '', name: '', arguments: '' };
          toolCallAccumulators.set(idx, acc);
        }
        if (tcDelta.id) acc.id = tcDelta.id;
        if (tcDelta.function?.name) acc.name += tcDelta.function.name;
        if (tcDelta.function?.arguments) acc.arguments += tcDelta.function.arguments;
      }
    }

    // finish_reason
    if (choice.finish_reason === 'tool_calls' || choice.finish_reason === 'stop') {
      for (const c of emitPendingToolCalls()) yield c;
    }
  };

  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });

    const parts = buffer.split(/\r?\n\r?\n/);
    buffer = parts.pop() ?? '';

    for (const part of parts) {
      const lines = part.split(/\r?\n/);
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const dataStr = line.slice(6).trim();
        if (dataStr === '[DONE]') continue;
        for (const c of handleDataEvent(dataStr)) yield c;
      }
    }
  }

  buffer += decoder.decode();

  if (buffer.trim()) {
    const remainingParts = buffer.split(/\r?\n\r?\n/);
    for (const part of remainingParts) {
      const lines = part.split(/\r?\n/);
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const dataStr = line.slice(6).trim();
        if (dataStr === '[DONE]' || dataStr === '') continue;
        for (const c of handleDataEvent(dataStr)) yield c;
      }
    }
  }

  for (const c of emitPendingToolCalls()) yield c;

  // commitAssistantMessage（复刻：用「智能」标签把 reasoning 拼入 content）
  const finalContent = assistantReasoning && assistantReasoning.trim()
    ? `智能\n${assistantReasoning}\n智能\n${assistantContent}`
    : assistantContent;
  const msg = {
    role: 'assistant',
    content: finalContent || null,
  };
  if (completedToolCalls.length > 0) {
    msg.tool_calls = completedToolCalls.map(tc => ({
      id: tc.id,
      type: 'function',
      function: { name: tc.name, arguments: JSON.stringify(tc.parameters) },
    }));
    for (const tc of completedToolCalls) {
      pendingToolCallIdQueue.push(tc.id);
    }
  }
  conversationHistory.push(msg);

  yield { type: 'done', content: '' };

  return { assistantContent, assistantReasoning, completedToolCalls };
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

function makeToolResult(toolName, output) {
  return {
    role: 'tool',
    content: `[Tool Result] ${toolName} - 成功\nOutput:\n${output}`,
    timestamp: Date.now(),
    toolName,
    toolResult: { toolName, success: true, output },
  };
}

// ── 系统提示词（接近生产 778 字符） ───────────────────────────────────────────

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

// ── 调用 API ──────────────────────────────────────────────────────────────────

async function callRealApi(token, messages, config, roundLabel, printBody = false) {
  // 复刻 translateInput
  appendNewMessages(messages);

  const body = buildRequestBody(config);

  // 调试日志：打印每轮请求的 messages 结构概要
  const msgSummary = body.messages.map((m, i) => {
    const role = m.role;
    const cStr = typeof m.content === 'string' ? m.content : '';
    const hasThink = cStr.includes('智能');
    const hasTC = !!m.tool_calls;
    const cType = m.content === null ? 'null' : `str(${cStr.length})`;
    return `  [${i}] role=${role} content=${cType} think_tag=${hasThink ? 'yes' : 'no'} tool_calls=${hasTC ? 'yes' : 'no'}`;
  }).join('\n');
  console.log(`[DevEco] translateInput: ${body.messages.length} messages, model=${body.model}, thinking=${JSON.stringify(body.thinking)}\n${msgSummary}`);

  if (printBody) {
    console.log(`\n[${roundLabel}] 请求体 (前 2000 字符):`);
    console.log(JSON.stringify(body, null, 2).substring(0, 2000));
  }

  const url = `${BASE_URL}${CHAT_COMPLETIONS_PATH}`;
  const headers = buildHeaders(token);

  console.log(`\n[${roundLabel}] 发送请求...`);

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`API ${response.status}: ${errorBody.substring(0, 500)}`);
  }

  if (!response.body) throw new Error('Response body is null');

  let thinking = '';
  let text = '';
  const toolCalls = [];
  let reasoningDeltaCount = 0;
  let contentDeltaCount = 0;

  async function* streamToAsyncIterable() {
    const reader = response.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        yield value;
      }
    } finally {
      reader.releaseLock();
    }
  }

  for await (const chunk of translateStream(streamToAsyncIterable())) {
    if (chunk.type === 'thinking') {
      thinking += chunk.content;
      reasoningDeltaCount++;
    } else if (chunk.type === 'text') {
      text += chunk.content;
      contentDeltaCount++;
    } else if (chunk.type === 'tool_call' && chunk.toolCall) {
      toolCalls.push({ name: chunk.toolCall.name, parameters: chunk.toolCall.parameters });
    }
  }

  console.log(`[${roundLabel}] 完成: reasoning_deltas=${reasoningDeltaCount} content_deltas=${contentDeltaCount} tool_calls=${toolCalls.length}`);

  return { thinking, text, toolCalls, reasoningDeltaCount, contentDeltaCount };
}

// ── 主流程 ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('╔══════════════════════════════════════════════════════════════════╗');
  console.log('║   DevEco GLM-5.1 真实 API 多轮 reasoning 诊断                    ║');
  console.log('╚══════════════════════════════════════════════════════════════════╝');

  const token = await getValidToken();
  if (!token) {
    console.error('\n❌ 无法获取有效 token，请先在 DevEco 中登录。');
    process.exit(1);
  }
  console.log('[RealAPI] Token 获取成功\n');

  const config = {
    provider: 'deveco',
    model: 'GLM-5.1',
    temperature: 0.3,
    stream: true,
    options: { tools: TEST_TOOLS },
  };

  const rounds = [];

  // ── 第 1 轮 ──
  console.log('\n██████ 第 1 轮：用户提问 ██████');
  const messages1 = [
    { role: 'system', content: SYSTEM_PROMPT, timestamp: 1 },
    {
      role: 'user',
      content: '帮我查看 D:\\myProject\\xAI 目录下有哪些文件，然后读取 package.json 文件的内容',
      timestamp: 2,
    },
  ];

  const result1 = await callRealApi(token, messages1, config, 'Round 1', true);

  console.log(`\n--- 第 1 轮结果 ---`);
  console.log(`  thinking: ${result1.thinking ? `${result1.thinking.length} chars` : '(无)'}`);
  if (result1.thinking) console.log(`  thinking 预览: ${result1.thinking.substring(0, 200)}`);
  console.log(`  text: ${result1.text ? `"${result1.text.substring(0, 200)}"` : '(无)'}`);
  console.log(`  tool_calls: ${result1.toolCalls.length}`);
  for (const tc of result1.toolCalls) {
    console.log(`    → ${tc.name}(${JSON.stringify(tc.parameters)})`);
  }

  rounds.push({
    round: 1,
    hasThinking: result1.thinking.length > 0,
    thinkingLen: result1.thinking.length,
    reasoningDeltas: result1.reasoningDeltaCount,
    textPreview: result1.text.substring(0, 80),
    toolCallCount: result1.toolCalls.length,
    toolCallNames: result1.toolCalls.map(tc => tc.name),
  });

  if (result1.toolCalls.length === 0) {
    console.log('\n⚠️ 第 1 轮无 tool_calls，无法继续多轮测试');
    printReport(rounds);
    return;
  }

  // ── 第 2 轮：工具结果反馈 ──
  console.log('\n\n██████ 第 2 轮：工具结果反馈 ██████');
  const toolResults1 = result1.toolCalls.map((tc) => {
    let output = '';
    if (tc.name === 'list_files') output = 'package.json\ntsconfig.json\nsrc/\npackages/\nREADME.md';
    else if (tc.name === 'read_file') output = '{\n  "name": "xai-ide",\n  "version": "1.0.0",\n  "private": true\n}';
    else output = 'OK';
    return makeToolResult(tc.name, output);
  });

  const result2 = await callRealApi(token, toolResults1, config, 'Round 2');

  console.log(`\n--- 第 2 轮结果 ---`);
  console.log(`  thinking: ${result2.thinking ? `${result2.thinking.length} chars` : '(无)'}`);
  if (result2.thinking) console.log(`  thinking 预览: ${result2.thinking.substring(0, 200)}`);
  console.log(`  text: ${result2.text ? `"${result2.text.substring(0, 200)}"` : '(无)'}`);
  console.log(`  tool_calls: ${result2.toolCalls.length}`);
  for (const tc of result2.toolCalls) {
    console.log(`    → ${tc.name}(${JSON.stringify(tc.parameters)})`);
  }

  rounds.push({
    round: 2,
    hasThinking: result2.thinking.length > 0,
    thinkingLen: result2.thinking.length,
    reasoningDeltas: result2.reasoningDeltaCount,
    textPreview: result2.text.substring(0, 80),
    toolCallCount: result2.toolCalls.length,
    toolCallNames: result2.toolCalls.map(tc => tc.name),
  });

  // ── 第 3 轮 ──
  if (result2.toolCalls.length > 0) {
    console.log('\n\n██████ 第 3 轮：工具结果反馈 ██████');
    const toolResults2 = result2.toolCalls.map((tc) => {
      let output = '';
      if (tc.name === 'read_file') output = '{\n  "name": "xai-ide",\n  "version": "1.0.0",\n  "type": "module"\n}';
      else if (tc.name === 'list_files') output = 'packages/\nsrc/\ntsconfig.json';
      else output = 'OK';
      return makeToolResult(tc.name, output);
    });

    const result3 = await callRealApi(token, toolResults2, config, 'Round 3');

    console.log(`\n--- 第 3 轮结果 ---`);
    console.log(`  thinking: ${result3.thinking ? `${result3.thinking.length} chars` : '(无)'}`);
    if (result3.thinking) console.log(`  thinking 预览: ${result3.thinking.substring(0, 200)}`);
    console.log(`  text: ${result3.text ? `"${result3.text.substring(0, 200)}"` : '(无)'}`);
    console.log(`  tool_calls: ${result3.toolCalls.length}`);
    for (const tc of result3.toolCalls) {
      console.log(`    → ${tc.name}(${JSON.stringify(tc.parameters)})`);
    }

    rounds.push({
      round: 3,
      hasThinking: result3.thinking.length > 0,
      thinkingLen: result3.thinking.length,
      reasoningDeltas: result3.reasoningDeltaCount,
      textPreview: result3.text.substring(0, 80),
      toolCallCount: result3.toolCalls.length,
      toolCallNames: result3.toolCalls.map(tc => tc.name),
    });

    // ── 第 4 轮 ──
    if (result3.toolCalls.length > 0) {
      console.log('\n\n██████ 第 4 轮：工具结果反馈 ██████');
      const toolResults3 = result3.toolCalls.map((tc) =>
        makeToolResult(tc.name, 'File content: {"name":"xai-ide","version":"1.0.0"}'),
      );

      const result4 = await callRealApi(token, toolResults3, config, 'Round 4');

      console.log(`\n--- 第 4 轮结果 ---`);
      console.log(`  thinking: ${result4.thinking ? `${result4.thinking.length} chars` : '(无)'}`);
      if (result4.thinking) console.log(`  thinking 预览: ${result4.thinking.substring(0, 200)}`);
      console.log(`  text: ${result4.text ? `"${result4.text.substring(0, 200)}"` : '(无)'}`);
      console.log(`  tool_calls: ${result4.toolCalls.length}`);

      rounds.push({
        round: 4,
        hasThinking: result4.thinking.length > 0,
        thinkingLen: result4.thinking.length,
        reasoningDeltas: result4.reasoningDeltaCount,
        textPreview: result4.text.substring(0, 80),
        toolCallCount: result4.toolCalls.length,
        toolCallNames: result4.toolCalls.map(tc => tc.name),
      });
    }
  }

  printReport(rounds);
}

function printReport(rounds) {
  console.log('\n\n');
  console.log('╔══════════════════════════════════════════════════════════════════════════╗');
  console.log('║                    多轮 reasoning 诊断报告                              ║');
  console.log('╠══════╦════════════╦═══════════════╦══════════════╦══════════╦═══════════╣');
  console.log('║ 轮次 ║ thinking   ║ thinking长度  ║ reasoning delta║ tool调用 ║ 状态      ║');
  console.log('╠══════╬════════════╬═══════════════╬══════════════╬══════════╬═══════════╣');
  for (const r of rounds) {
    const status = r.hasThinking ? '✅ 有' : '❌ 无';
    const thinkStr = r.hasThinking ? '✅ 有' : '❌ 无';
    console.log(`║  ${r.round}   ║  ${thinkStr.padEnd(9)} ║  ${String(r.thinkingLen).padStart(11)}   ║  ${String(r.reasoningDeltas).padStart(12)}   ║   ${r.toolCallCount}      ║ ${status.padEnd(10)}║`);
  }
  console.log('╚══════╩════════════╩═══════════════╩══════════════╩══════════╩═══════════╝');

  const firstLoss = rounds.find(r => !r.hasThinking);
  if (firstLoss) {
    console.log(`\n⚠️  第 ${firstLoss.round} 轮首次丢失 reasoning！`);
  } else {
    console.log('\n✅ 所有轮次都产出了 reasoning！');
  }

  // 检查 history 中 assistant 消息的 think_tag
  console.log('\n--- conversationHistory 概要 ---');
  for (let i = 0; i < conversationHistory.length; i++) {
    const m = conversationHistory[i];
    const content = typeof m.content === 'string' ? m.content : '';
    const hasThink = content.includes('智能');
    console.log(`  [${i}] role=${m.role} content=${m.content === null ? 'null' : `str(${content.length})`} think_tag=${hasThink ? 'yes' : 'no'} tool_calls=${m.tool_calls ? 'yes' : 'no'}`);
  }

  console.log('\n========== 诊断完成 ==========');
}

main().catch(err => {
  console.error('\n❌ 诊断脚本失败:', err);
  process.exit(1);
});
