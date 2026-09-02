/**
 * AI 交互日志记录器：按"一次 HTTP request 一条日志"的粒度上报。
 *
 * 在 LLMRouter.onRawHttp 回调中调用 submitRawHttpLog，每次 HTTP LLM 调用
 * 完成后上报一条原始 request/response 日志（含流式 SSE 全文）。
 *
 * 设计要点：
 * - 底层：在 HTTP 层捕获原始 requestBody / responseBody，不依赖解析后的 chunk。
 * - 简洁：唯一入口 submitRawHttpLog，Code / Designer 视图共用。
 * - 一次 request 一次 response：每次 HTTP 调用恰好一条日志。
 * - 上报失败不影响主流程，仅 console.warn。
 * - 未登录时静默跳过。
 */
import type { RawHttpInfo } from '@xai/core';
import type { AdminClient } from './admin-client.js';
import type { AppState } from './app-state.js';

/** 会话级日志上下文：保存会话元数据，供 onRawHttp 回调时携带。 */
export interface AiLogContext {
  mode: 'code' | 'designer';
  /** 会话 ID：同一次会话内多次 HTTP 调用共享。 */
  sessionId: string;
  projectId?: string;
  projectName?: string;
  screenId?: string;
  screenName?: string;
  provider?: string;
  model?: string;
}

export function createAiLogContext(init: Pick<AiLogContext, 'mode' | 'sessionId'> &
  Partial<Omit<AiLogContext, 'mode' | 'sessionId'>>): AiLogContext {
  return { ...init };
}

/**
 * 上报一条原始 HTTP 日志（一次 request 一条日志）。
 * Code / Designer 视图共用，在 LLMRouter.onRawHttp 回调中调用。
 */
export async function submitRawHttpLog(
  state: AppState,
  ctx: AiLogContext,
  info: RawHttpInfo,
): Promise<void> {
  const client: AdminClient | undefined = state.adminClient;
  const userId = state.currentUser?.id;
  if (!client || !userId) return;
  const ok = info.status >= 200 && info.status < 300;
  try {
    await client.submitAiLog({
      mode: ctx.mode,
      sessionId: ctx.sessionId,
      projectId: ctx.projectId,
      projectName: ctx.projectName,
      screenId: ctx.screenId,
      screenName: ctx.screenName,
      provider: ctx.provider,
      model: ctx.model,
      requestText: info.requestBody,
      responseText: info.responseBody,
      status: ok ? 'success' : 'error',
      errorMessage: ok ? undefined : `HTTP ${info.status}`,
      durationMs: info.durationMs,
    });
  } catch (err) {
    console.warn(
      `[ai-logger] submitRawHttpLog failed: ${(err as Error).message} ` +
      `(provider=${ctx.provider}, mode=${ctx.mode}, sessionId=${ctx.sessionId})`,
    );
  }
}
