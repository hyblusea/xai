/**
 * OCR IPC handlers — PaddleOCR server connection test and image recognition test.
 * Config changes are read from sessionConfig at call time (no restart needed).
 */
import { ipcMain, dialog, BrowserWindow } from 'electron';
import { IPCChannel } from '@xai/shared';
import type { OCRConfig } from '@xai/shared';
import type { IpcDeps } from './types.js';
import fs from 'fs/promises';
import path from 'path';

export function registerOCRHandlers(deps: IpcDeps): void {
  /**
   * Test connection to PaddleOCR server (health check).
   */
  ipcMain.handle(IPCChannel.OCRTestConnection, async () => {
    const ocr = deps.sessionConfig.ocr;
    if (!ocr || !ocr.serverUrl) {
      return { success: false, message: 'OCR server URL is not configured.' };
    }
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), ocr.timeout || 10000);
      const healthUrl = ocr.serverUrl.replace(/\/+$/, '') + '/health';
      const resp = await fetch(healthUrl, {
        signal: controller.signal,
        headers: buildAuthHeaders(ocr),
      });
      clearTimeout(timeout);
      if (resp.ok) {
        const data = await resp.json() as Record<string, unknown>;
        return {
          success: true,
          message: `Connected — ${data.model || 'PaddleOCR'}, engine: ${data.engine || '?'}, memory: ${data.memory_mb || '?'}MB`,
        };
      }
      return { success: false, message: `Server responded with HTTP ${resp.status}` };
    } catch (err: unknown) {
      const msg = extractFetchError(err);
      return { success: false, message: `Connection failed: ${msg}` };
    }
  });

  /**
   * Test OCR recognition: user picks an image file, we send it to the server,
   * and return recognized text.
   */
  ipcMain.handle(IPCChannel.OCRTestImage, async () => {
    const ocr = deps.sessionConfig.ocr;
    if (!ocr || !ocr.serverUrl) {
      return { success: false, message: 'OCR server URL is not configured.', text: '' };
    }

    // Open file dialog for image selection
    const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
    const result = await dialog.showOpenDialog(win, {
      title: 'Select Image for OCR Test',
      filters: [
        { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'bmp', 'gif', 'tiff', 'webp'] },
      ],
      properties: ['openFile'],
    });

    if (result.canceled || result.filePaths.length === 0) {
      return { success: false, message: 'No file selected.', text: '' };
    }

    const filePath = result.filePaths[0];
    const fileName = path.basename(filePath);
    try {
      const imageBuffer = await fs.readFile(filePath);
      return await recognizeImageBuffer(ocr, imageBuffer, fileName);
    } catch (err: unknown) {
      const msg = extractFetchError(err);
      return { success: false, message: `OCR request failed: ${msg}`, text: '' };
    }
  });

  /**
   * Recognize an in-memory image buffer (no file dialog).
   * Used by the chat input to OCR pasted image files / clipboard images.
   * Renderer sends: { filename: string, buffer: ArrayBuffer | Uint8Array }
   * Returns:        { success: boolean, message?: string, text?: string, rawJson?: unknown }
   */
  ipcMain.handle(
    IPCChannel.OCRRecognizeImage,
    async (_event, payload: { filename: string; buffer: ArrayBuffer | Uint8Array }) => {
      const ocr = deps.sessionConfig.ocr;
      if (!ocr || !ocr.serverUrl) {
        return { success: false, message: 'OCR server URL is not configured.', text: '' };
      }
      if (!payload || !payload.filename || !payload.buffer) {
        return { success: false, message: 'Missing filename or buffer.', text: '' };
      }
      const buf = payload.buffer instanceof Uint8Array
        ? payload.buffer
        : new Uint8Array(payload.buffer);
      return await recognizeImageBuffer(ocr, buf, payload.filename);
    },
  );
}

/**
 * Core OCR routine: POST an image buffer to the PaddleOCR server and parse the response.
 * Shared by OCRTestImage (file dialog) and OCRRecognizeImage (in-memory buffer).
 * Always returns a result object — never throws.
 */
async function recognizeImageBuffer(
  ocr: OCRConfig,
  imageBuffer: Uint8Array,
  fileName: string,
): Promise<{ success: boolean; message: string; text: string; rawJson?: unknown }> {
  try {
    const ext = path.extname(fileName).slice(1).toLowerCase() || 'png';
    const mimeType = `image/${ext === 'jpg' ? 'jpeg' : ext}`;

    // Normalize to a Node Buffer so the Blob constructor accepts it (Uint8Array
    // alone is not always assignable to BlobPart in the Node type defs).
    const nodeBuffer = Buffer.from(imageBuffer);

    // Build multipart/form-data with file field (matching FastAPI UploadFile)
    const formData = new FormData();
    formData.append('file', new Blob([nodeBuffer], { type: mimeType }), fileName);

    // Use longer timeout — PaddleOCR inference on CPU can be slow (30s+)
    const ocrTimeout = Math.max(ocr.timeout || 120000, 120000);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), ocrTimeout);
    const ocrUrl = ocr.serverUrl.replace(/\/+$/, '') + '/ocr';

    const resp = await fetch(ocrUrl, {
      method: 'POST',
      signal: controller.signal,
      headers: buildAuthHeaders(ocr),
      body: formData,
    });
    clearTimeout(timeout);

    if (!resp.ok) {
      const body = await resp.text();
      return { success: false, message: `Server returned HTTP ${resp.status}: ${body}`, text: '' };
    }

    const data = await resp.json() as {
      code: number;
      message: string;
      data: {
        total_raw: number;
        total_filtered: number;
        score_threshold: number;
        inference_time_s: number;
        items: Array<{ text: string; score: number; box?: number[][] }>;
      };
    };

    if (data.code !== 0) {
      return { success: false, message: `OCR error: ${data.message}`, text: '', rawJson: data };
    }

    const items = data.data?.items || [];
    const fullText = items.map(i => i.text).join('\n');
    const { total_filtered, total_raw, inference_time_s } = data.data;
    const summary = `识别 ${total_filtered}/${total_raw} 条文本，耗时 ${inference_time_s}s`;
    return { success: true, message: summary, text: fullText, rawJson: data };
  } catch (err: unknown) {
    const msg = extractFetchError(err);
    if (msg.includes('abort') || msg.includes('AbortError')) {
      return {
        success: false,
        message: `OCR request timed out. The server may be processing a large image — try reducing image size or increasing the timeout in OCR settings.`,
        text: '',
      };
    }
    return { success: false, message: `OCR request failed: ${msg}`, text: '' };
  }
}

/** Extract meaningful error message from fetch errors (Node/undici hides details in .cause). */
function extractFetchError(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as Error & { cause?: unknown }).cause;
    if (cause instanceof Error) return `${err.message} → ${cause.message}`;
    if (cause && typeof cause === 'object' && 'code' in cause) {
      const code = (cause as Record<string, unknown>).code;
      return `${err.message} (${code})`;
    }
    if (typeof cause === 'string' && cause) return `${err.message} → ${cause}`;
    return err.message;
  }
  return String(err);
}

/** Build HTTP Basic Auth header from OCR config.
 *  Password may be base64-encoded (matching the renderer's save logic),
 *  so we attempt to decode it before building the header. */
function buildAuthHeaders(ocr: OCRConfig): Record<string, string> {
  if (ocr.username && ocr.password) {
    let password = ocr.password;
    try {
      password = decodeURIComponent(escape(atob(ocr.password)));
    } catch { /* not base64-encoded — use as-is */ }
    const token = Buffer.from(`${ocr.username}:${password}`).toString('base64');
    return { Authorization: `Basic ${token}` };
  }
  return {};
}