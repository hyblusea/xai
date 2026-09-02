/**
 * Standalone test for ZaiCaptchaMinter + ZaiAdapter.
 *
 * Run with:
 *   pnpm --filter @xai/electron build
 *   pnpm --filter @xai/electron test:captcha
 *
 * Token resolution order:
 *   1. ZAI_TOKEN env var
 *   2. llm.zaiToken field in xai-config.json (userData dir)
 *
 * What it does:
 * 1. Initializes ZaiCaptchaMinter (hidden BrowserWindow + Aliyun SDK)
 * 2. Mints a fresh captcha_verify_param
 * 3. Decodes and prints the param structure
 * 4. Uses ZaiAdapter to send a real request to chat.z.ai (with proper signing)
 * 5. Streams the response and prints it
 */
import { app, BrowserWindow } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ZaiCaptchaMinter } from './zai-captcha-minter.js';
import { ZaiAdapter } from '@xai/core';
import type { Message, LLMConfig } from '@xai/shared';

const TEST_MESSAGE = process.env.ZAI_TEST_MESSAGE || '你好，请用一句话介绍自己';

function resolveToken(): string {
  // 1. Env var
  if (process.env.ZAI_TOKEN) {
    console.log('[Test] Using token from ZAI_TOKEN env var.');
    return process.env.ZAI_TOKEN;
  }
  // 2. xai-config.json
  try {
    const cfgPath = path.join(app.getPath('userData'), 'xai-config.json');
    if (fs.existsSync(cfgPath)) {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
      const t = cfg?.llm?.zaiToken;
      if (typeof t === 'string' && t.trim()) {
        console.log('[Test] Using token from', cfgPath);
        return t.trim();
      }
    }
  } catch (e) {
    console.warn('[Test] Failed to read config file:', e);
  }
  return '';
}

function decodeBase64Json(s: string): any {
  try {
    const json = Buffer.from(s, 'base64').toString('utf-8');
    return JSON.parse(json);
  } catch {
    return null;
  }
}

async function runTest() {
  console.log('\n========== ZaiCaptchaMinter + ZaiAdapter Test ==========\n');

  const TEST_TOKEN = resolveToken();
  if (!TEST_TOKEN) {
    console.error('[Test] No token found. Either:');
    console.error('  - Set ZAI_TOKEN env var, or');
    console.error('  - Add "zaiToken" to llm section in xai-config.json');
    app.quit();
    return;
  }
  console.log('[Test] Token:', TEST_TOKEN.substring(0, 40) + '...');

  const minter = new ZaiCaptchaMinter(30000);

  try {
    // ---------------------------------------------------------------
    // Phase 1: Test the minter alone
    // ---------------------------------------------------------------
    console.log('\n--- Phase 1: Minter test ---');

    console.log('[Test] Starting minter...');
    const startBegin = Date.now();
    await minter.start();
    console.log(`[Test] Minter started in ${Date.now() - startBegin}ms`);

    console.log('[Test] Minting captcha param...');
    const mintBegin = Date.now();
    const param = await minter.mint();
    console.log(`[Test] Minted in ${Date.now() - mintBegin}ms`);

    const decoded = decodeBase64Json(param);
    if (decoded) {
      console.log('[Test] Param structure:');
      console.log('  certifyId:', decoded.certifyId);
      console.log('  sceneId:', decoded.sceneId);
      console.log('  isSign:', decoded.isSign);
      console.log('  hasSecurityToken:', !!decoded.securityToken);
      if (decoded.securityToken) {
        console.log('  securityToken length:', decoded.securityToken.length);
      }
    }

    // ---------------------------------------------------------------
    // Phase 2: Test through the adapter (real API request)
    // ---------------------------------------------------------------
    console.log('\n--- Phase 2: Adapter + real API test ---');

    const adapter = new ZaiAdapter({
      token: TEST_TOKEN,
      captchaMinter: async () => {
        await minter.start();
        return minter.mint();
      },
    });

    const messages: Message[] = [
      { role: 'user', content: TEST_MESSAGE, id: 'msg-1' },
    ];

    const config: LLMConfig = {
      provider: 'zai',
      model: 'glm-5.2',
      apiKey: TEST_TOKEN,
      options: {
        enableThinking: false,
        reasoningEffort: 'high',
      },
    };

    console.log('[Test] Building request via adapter...');
    const httpRequest = await adapter.translateInput(messages, config);
    console.log('[Test] Request URL:', httpRequest.url.substring(0, 120) + '...');
    console.log('[Test] Request headers:', Object.keys(httpRequest.headers).join(', '));
    console.log('[Test] Body length:', httpRequest.body?.length || 0);

    console.log('\n[Test] Sending request to chat.z.ai...');
    const sendBegin = Date.now();
    const res = await fetch(httpRequest.url, {
      method: 'POST',
      headers: httpRequest.headers,
      body: httpRequest.body,
    });

    console.log(`[Test] Response status: ${res.status} ${res.statusText}`);
    console.log(`[Test] Response headers:`);
    res.headers.forEach((v, k) => console.log(`  ${k}: ${v}`));

    if (!res.ok) {
      const text = await res.text();
      console.error('[Test] Request failed:', text.substring(0, 500));
      throw new Error(`HTTP ${res.status}`);
    }

    // Stream the response
    console.log('\n[Test] Streaming response:');
    const reader = res.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    let fullText = '';
    let chunkCount = 0;
    let sawCaptchaError = false;
    let sawThinking = false;
    let sawAnswer = false;
    let yieldedContent = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      fullText += chunk;

      // Parse SSE lines
      for (const line of chunk.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (!data || data === '[DONE]') continue;
        try {
          const evt = JSON.parse(data);
          chunkCount++;

          // Print every chunk's type/phase for diagnosis
          const type = evt.type || '?';
          const phase = evt.data?.phase || evt.phase || '-';
          const hasErr = !!(evt.error || evt.data?.error);
          const delta = evt.data?.delta_content || evt.delta_content || evt.data?.delta || '';
          console.log(`[chunk ${chunkCount}] type=${type} phase=${phase} err=${hasErr} deltaLen=${delta.length}`);
          if (delta) console.log(`  delta: ${JSON.stringify(delta.substring(0, 80))}${delta.length > 80 ? '...' : ''}`);

          // Check for errors
          if (evt.error || evt.data?.error) {
            const err = evt.error || evt.data?.error;
            console.error('[Test] SSE error:', JSON.stringify(err).substring(0, 300));
            if (err.error_code === 'FRONTEND_CAPTCHA_REQUIRED' || err.code === 'FRONTEND_CAPTCHA_REQUIRED') {
              sawCaptchaError = true;
            }
            // INTERNAL_ERROR after content is spurious — don't treat as fatal
            const code = err.code || err.error_code;
            if (code === 'INTERNAL_ERROR' && yieldedContent) {
              console.log('[Test] [INTERNAL_ERROR ignored as spurious post-content]');
              continue;
            }
          }

          // Check for thinking
          if (evt.phase === 'thinking' || evt.data?.phase === 'thinking') {
            if (!sawThinking) {
              console.log('[Test] [thinking phase started]');
              sawThinking = true;
            }
            if (delta) yieldedContent = true;
          }

          // Check for answer
          if (evt.phase === 'answer' || evt.data?.phase === 'answer' || evt.type === 'chat:completion') {
            if (!sawAnswer) {
              console.log('[Test] [answer phase started]');
              sawAnswer = true;
            }
            const text = evt.content || evt.data?.content || evt.delta || evt.data?.delta || '';
            if (text) {
              process.stdout.write(text);
              yieldedContent = true;
            }
          }
        } catch {
          // Not JSON, skip
        }
      }
    }

    console.log(`\n\n[Test] Stream ended. Total chunks: ${chunkCount}, duration: ${Date.now() - sendBegin}ms`);

    // ---------------------------------------------------------------
    // Summary
    // ---------------------------------------------------------------
    console.log('\n========== Test Summary ==========');
    console.log('Minter start:      OK');
    console.log('Captcha mint:      OK');
    console.log('Param decoded:     ', !!decoded);
    console.log('hasSecurityToken:  ', decoded?.securityToken ? 'YES' : 'NO');
    console.log('API request:       ', sawCaptchaError ? 'CAPTCHA REJECTED' : 'OK');
    console.log('Saw thinking:      ', sawThinking);
    console.log('Saw answer:        ', sawAnswer);
    console.log('Total SSE chunks:  ', chunkCount);
    console.log('==================================\n');

    if (sawCaptchaError) {
      console.error('FAILED: Captcha was rejected by the server.');
      process.exitCode = 1;
    } else if (!sawAnswer && !sawThinking) {
      console.error('FAILED: No answer or thinking received.');
      process.exitCode = 1;
    } else {
      console.log('SUCCESS: Captcha accepted, got response from Z.ai.');
    }
  } catch (err) {
    console.error('\n[Test] FAILED:', err);
    console.error((err as Error)?.stack || err);
    process.exitCode = 1;
  } finally {
    await minter.stop();
    app.quit();
  }
}

app.whenReady().then(() => {
  BrowserWindow.getAllWindows().forEach(w => w.destroy());
  runTest().catch(err => {
    console.error('Unhandled error:', err);
    process.exit(1);
  });
});

setTimeout(() => {
  console.error('[Test] Global timeout — forcing quit');
  app.quit();
  process.exit(2);
}, 90000);
