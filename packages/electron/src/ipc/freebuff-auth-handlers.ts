/**
 * Freebuff OAuth authentication & model IPC handlers.
 * Handles login, logout, auth status, model list, reasoning, context info,
 * and session management queries.
 */
import { ipcMain } from 'electron';
import { IPCChannel } from '@xai/shared';
import { freebuffAuthService } from '../freebuff-auth.js';
import { FREEBUFF_MODEL_CATALOG, FREEBUFF_DEFAULT_CONTEXT_WINDOW, resolveFreebuffContextWindow } from '@xai/core';
import type { IpcDeps } from './types.js';

export function registerFreebuffAuthHandlers(deps: IpcDeps): void {
  ipcMain.handle(IPCChannel.FreebuffLogin, async () => {
    try {
      const result = await freebuffAuthService.login((message) => {
        deps.sendToRenderer(IPCChannel.FreebuffLoginProgress, message);
      });
      return result;
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle(IPCChannel.FreebuffLogout, async () => {
    freebuffAuthService.logout();
    return { success: true };
  });

  ipcMain.handle(IPCChannel.FreebuffAuthStatus, async () => {
    return freebuffAuthService.getAuthStatus();
  });

  // ── Model catalog (local, no API call needed) ────────────────────────────
  ipcMain.handle(IPCChannel.FreebuffModels, async () => {
    try {
      const models = Object.entries(FREEBUFF_MODEL_CATALOG).map(([id, info]) => ({
        id,
        name: id.split('/').pop() ?? id,
        contextWindow: info.contextWindow,
        reasoning: info.reasoning,
        reasoningEffort: info.reasoning ? 'high' : undefined,
        efforts: info.reasoning ? ['low', 'medium', 'high', 'xhigh', 'max'] : undefined,
        defaultEffort: info.reasoning ? 'high' : undefined,
        premium: ['deepseek/deepseek-v4-pro', 'minimax/minimax-m3', 'openai/gpt-5.6-luna'].includes(id),
        tagline: getModelTagline(id),
      }));
      return { success: true, models };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  // ── Reasoning support (local lookup from catalog) ────────────────────────
  ipcMain.handle(IPCChannel.FreebuffModelReasoning, async (_event, modelId: string) => {
    try {
      const info = FREEBUFF_MODEL_CATALOG[modelId];
      if (!info) {
        return { success: true, supportsReasoning: false, supportedEfforts: [], defaultEffort: '' };
      }
      const efforts = info.reasoning ? ['low', 'medium', 'high', 'xhigh', 'max'] : [];
      const defaultEffort = info.reasoning ? 'high' : '';
      return { success: true, supportsReasoning: info.reasoning, supportedEfforts: efforts, defaultEffort };
    } catch (err) {
      return { success: false, supportsReasoning: false, supportedEfforts: [], defaultEffort: '', error: String(err) };
    }
  });

  // ── Context info (local lookup from catalog) ─────────────────────────────
  ipcMain.handle(IPCChannel.FreebuffModelContextInfo, async (_event, modelId: string) => {
    try {
      const contextWindow = resolveFreebuffContextWindow(modelId);
      const maxInputTokens = Math.floor(contextWindow * 0.85);
      const maxOutputTokens = Math.min(Math.floor(contextWindow * 0.15), 16_384);
      return { success: true, contextWindow, maxInputTokens, maxOutputTokens };
    } catch (err) {
      return { success: false, contextWindow: FREEBUFF_DEFAULT_CONTEXT_WINDOW, maxInputTokens: Math.floor(FREEBUFF_DEFAULT_CONTEXT_WINDOW * 0.85), maxOutputTokens: 4_096, error: String(err) };
    }
  });

  // ── Session management ───────────────────────────────────────────────────
  ipcMain.handle(IPCChannel.FreebuffSessionStart, async (_event, model?: string) => {
    try {
      const result = await freebuffAuthService.startSession(model);
      return { success: true, ...result };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle(IPCChannel.FreebuffSessionStatus, async () => {
    try {
      return await freebuffAuthService.getSessionStatus();
    } catch (err) {
      return { active: false, error: String(err) };
    }
  });

  ipcMain.handle(IPCChannel.FreebuffSessionEnd, async () => {
    try {
      await freebuffAuthService.endSession();
      return { success: true };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });
}

/** Human-readable taglines for the model selector UI. */
function getModelTagline(modelId: string): string {
  if (modelId.includes('deepseek-v4-flash')) return 'DeepSeek V4 Flash — 快速推理，1M 上下文';
  if (modelId.includes('deepseek-v4-pro')) return 'DeepSeek V4 Pro — 深度推理，1M 上下文';
  if (modelId.includes('minimax-m3')) return 'MiniMax M3 — 512K 上下文';
  if (modelId.includes('gpt-5.6-luna')) return 'GPT-5.6 Luna — OpenAI 推理模型，400K 上下文';
  if (modelId.includes('mimo-v2.5')) return 'MiMo V2.5 — 262K 上下文';
  if (modelId.includes('glm-5.2')) return 'GLM 5.2 — 推理模型，128K 上下文';
  return 'Freebuff 免费模型';
}