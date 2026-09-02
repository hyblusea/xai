import type { Message, LLMConfig, StreamChunk, ProxyConfig } from '@xai/shared';
import type { LLMAdapter } from './types.js';

/** Raw HTTP 交互信息：由 LLMRouter 在每次 HTTP LLM 调用后回调上报。 */
export interface RawHttpInfo {
  url: string;
  status: number;
  requestBody: string;
  responseBody: string;
  /** 本次 HTTP 调用耗时（毫秒），从 fetch 发起到流式完成。 */
  durationMs: number;
}

export class LLMRouter {
  private adapters = new Map<string, LLMAdapter>();
  private proxyConfig: ProxyConfig | null = null;

  /**
   * 可选的 raw HTTP 日志回调。每次 HTTP LLM 调用（translateInput → fetch → translateStream）
   * 完成后会调用此回调，传入完整的 request body 与 response body。
   * 由上层（ReActLoop / Designer handlers）在会话开始时设置，结束时清除。
   */
  onRawHttp?: (info: RawHttpInfo) => void;

  setProxyConfig(config: ProxyConfig | null): void {
    this.proxyConfig = config;
  }

  getProxyConfig(): ProxyConfig | null {
    return this.proxyConfig;
  }

  registerAdapter(name: string, adapter: LLMAdapter): void {
    this.adapters.set(name, adapter);
  }

  getAdapter(name: string): LLMAdapter {
    const adapter = this.adapters.get(name);
    if (!adapter) {
      throw new Error(`LLM adapter not found: ${name}. Available: ${[...this.adapters.keys()].join(', ')}`);
    }
    return adapter;
  }

  resetSession(provider: string): void {
    const adapter = this.adapters.get(provider);
    if (adapter && 'resetSession' in adapter && typeof (adapter as any).resetSession === 'function') {
      (adapter as any).resetSession();
    }
  }

  private lastRequestTime: number = 0;
  private readonly MIN_REQUEST_INTERVAL = 1000;
  /** 限流锁：防止并发调用时多个协程同时通过限流检查。 */
  private rateLimitLock: Promise<void> = Promise.resolve();

  private async waitForRateLimit(): Promise<void> {
    // 串行化：确保同一时刻只有一个协程在执行限流逻辑，
    // 避免并发调用时多个协程读到相同的 lastRequestTime 从而同时通过检查。
    const prevLock = this.rateLimitLock;
    let release!: () => void;
    this.rateLimitLock = new Promise<void>(r => { release = r; });
    await prevLock;

    try {
      const now = Date.now();
      const elapsed = now - this.lastRequestTime;
      // 先标记"占位时间"，确保后续并发的调用能正确计算 elapsed，
      // 而不是在 await sleep 期间读到旧的 lastRequestTime。
      this.lastRequestTime = now;

      if (elapsed < this.MIN_REQUEST_INTERVAL) {
        const waitMs = this.MIN_REQUEST_INTERVAL - elapsed;
        await new Promise(r => setTimeout(r, waitMs));
        // sleep 结束后更新为实际发出请求的时刻，
        // 这样下次限流计算的基准 = 本次请求的实际发出时间。
        this.lastRequestTime = Date.now();
      }
    } finally {
      release();
    }
  }

  async *send(messages: Message[], config: LLMConfig, signal?: AbortSignal): AsyncIterable<StreamChunk> {
    const adapter = this.getAdapter(config.provider);

    let request;
    try {
      request = await adapter.translateInput(messages, config);
    } catch (err) {
      yield {
        type: 'error',
        content: `Failed to translate input: ${String(err)}`,
      };
      return;
    }

    await this.waitForRateLimit();

    const httpStartTime = Date.now();
    let response!: Response;
    const maxRetries = 2;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        response = await fetch(request.url, {
          method: request.method,
          headers: request.headers as Record<string, string>,
          body: request.body,
          signal,
        });
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          yield { type: 'done', content: '' };
          return;
        }
        const errDetail = err instanceof Error ? `${err.name}: ${err.message}${err.cause ? ` (cause: ${String(err.cause)})` : ''}` : String(err);
        if (attempt < maxRetries && !(err instanceof DOMException)) {
          const retryDelay = (attempt + 1) * 3000;
          await new Promise(r => setTimeout(r, retryDelay));
          continue;
        }
        this.onRawHttp?.({
          url: request.url,
          status: 0,
          requestBody: request.body ?? '',
          responseBody: `Network error: ${errDetail}`,
          durationMs: Date.now() - httpStartTime,
        });
        yield {
          type: 'error',
          content: `Network error: ${errDetail}. Please check your network connection and LLM configuration.`,
        };
        return;
      }
      break;
    }

    if (!response.ok) {
      let errorBody = '';
      try {
        errorBody = await response.text();
      } catch {
        errorBody = '(unable to read response body)';
      }

      // Freebuff session expired (HTTP 428 waiting_room_required) — re-admit
      // and retry. The session's 1-hour TTL has elapsed; the adapter's
      // handleSessionExpired callback ends the stale session and starts a fresh
      // one, returning the new instance ID. We patch the request body and retry.
      if (response.status === 428 && config.provider === 'freebuff') {
        const handleExpired = (adapter as unknown as Record<string, unknown>).handleSessionExpired;
        if (typeof handleExpired === 'function') {
          try {
            yield { type: 'text', content: '[Freebuff] Session expired, re-admitting...' };
            const newInstanceId = await (handleExpired as (model?: string) => Promise<string | undefined>).call(adapter, config.model);
            if (newInstanceId) {
              // Patch the request body with the new instance ID
              let patchedBody = request.body;
              try {
                const bodyObj = JSON.parse(request.body ?? '{}');
                if (bodyObj.codebuff_metadata) {
                  bodyObj.codebuff_metadata.freebuff_instance_id = newInstanceId;
                }
                patchedBody = JSON.stringify(bodyObj);
              } catch { /* parse failed — retry with original body */ }

              const retryResponse = await fetch(request.url, {
                method: request.method,
                headers: request.headers as Record<string, string>,
                body: patchedBody,
                signal,
              });
              if (retryResponse.ok && retryResponse.body) {
                const [s1, s2] = retryResponse.body.tee();
                let raw2 = '';
                const rp = new Response(s2).text().then(t => { raw2 = t; }).catch(() => {});
                const ai = readableStreamToAsyncIterable(s1);
                try {
                  for await (const chunk of adapter.translateStream(ai)) {
                    yield chunk;
                  }
                } finally {
                  await rp;
                  this.onRawHttp?.({ url: request.url, status: retryResponse.status, requestBody: patchedBody ?? '', responseBody: raw2, durationMs: Date.now() - httpStartTime });
                }
                return;
              }
            }
          } catch { /* re-admission failed, fall through to error */ }
        }
      }

      // Freebuff free-mode capacity deferred (HTTP 429) — honor Retry-After
      if (response.status === 429 && config.provider === 'freebuff') {
        const retryAfter = response.headers.get('retry-after');
        const retryMs = retryAfter ? Math.ceil(parseFloat(retryAfter) * 1000) : 30_000;
        if (retryMs <= 120_000) {
          yield { type: 'text', content: `[Freebuff] 容量暂时不足，${Math.ceil(retryMs / 1000)}秒后重试...` };
          await new Promise(r => setTimeout(r, retryMs));
          // Retry the entire send once
          try {
            const retryResponse = await fetch(request.url, {
              method: request.method,
              headers: request.headers as Record<string, string>,
              body: request.body,
              signal,
            });
            if (retryResponse.ok && retryResponse.body) {
              const [s1, s2] = retryResponse.body.tee();
              let raw2 = '';
              const rp = new Response(s2).text().then(t => { raw2 = t; }).catch(() => {});
              const ai = readableStreamToAsyncIterable(s1);
              try {
                for await (const chunk of adapter.translateStream(ai)) {
                  yield chunk;
                }
              } finally {
                await rp;
                this.onRawHttp?.({ url: request.url, status: retryResponse.status, requestBody: request.body ?? '', responseBody: raw2, durationMs: Date.now() - httpStartTime });
              }
              return;
            }
          } catch { /* retry failed, fall through to error */ }
        }
      }

      // 失败响应也记录 raw HTTP（含完整错误 body，便于排查）
      this.onRawHttp?.({
        url: request.url,
        status: response.status,
        requestBody: request.body ?? '',
        responseBody: errorBody,
        durationMs: Date.now() - httpStartTime,
      });

      yield {
        type: 'error',
        content: `LLM request failed (${response.status} ${response.statusText}): ${errorBody}. Please check your cookies/API key in Settings.`,
      };
      return;
    }

    if (!response.body) {
      // 无流式 body：仍触发 raw 回调（response body 为空字符串）
      this.onRawHttp?.({
        url: request.url,
        status: response.status,
        requestBody: request.body ?? '',
        responseBody: '',
        durationMs: Date.now() - httpStartTime,
      });
      yield {
        type: 'error',
        content: 'LLM response body is null. The server may not support streaming.',
      };
      return;
    }

    // tee 流式响应：一路交给 adapter 解析流式 chunk，一路累计完整 raw body 供日志记录。
    // 在 abort/error 场景下 raw 读取可能失败或不完整，catch 掉即可。
    const [streamForAdapter, streamForRaw] = response.body.tee();
    let rawResponseText = '';
    const rawPromise = new Response(streamForRaw).text().then(t => { rawResponseText = t; }).catch(() => { /* abort/error 时 raw 不完整，忽略 */ });

    const asyncIterable = readableStreamToAsyncIterable(streamForAdapter);

    try {
      for await (const chunk of adapter.translateStream(asyncIterable)) {
        yield chunk;
      }
    } finally {
      // 必须在 finally 中触发：消费者（ReActLoop）可能在 'done' chunk 后 break，
      // 导致 for await 循环提前终止，try 块尾的代码不会执行。
      await rawPromise;
      this.onRawHttp?.({
        url: request.url,
        status: response.status,
        requestBody: request.body ?? '',
        responseBody: rawResponseText,
        durationMs: Date.now() - httpStartTime,
      });
    }
  }
}

async function* readableStreamToAsyncIterable(stream: ReadableStream<Uint8Array>): AsyncIterable<Buffer> {
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      yield Buffer.from(value);
    }
  } catch (err) {
    if (!(err instanceof DOMException && err.name === 'AbortError')) {
      throw err;
    }
  } finally {
    reader.releaseLock();
  }
}
