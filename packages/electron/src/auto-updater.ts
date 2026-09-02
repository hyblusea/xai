/**
 * XAI IDE 自动更新器（全文件增量更新模式）
 *
 * 流程：
 * 1. 拉取服务端 update-manifest.json（包含所有文件的 sha512）
 * 2. 与本地 manifest 逐文件对比 hash
 * 3. 仅下载 hash 变更的文件（增量下载）
 * 4. 服务端已移除的文件，客户端同步删除
 * 5. 生成 bat 脚本：等进程退出 → 替换文件 → 删除旧文件 → 重启
 * 6. 保存新 manifest 为本地副本
 *
 * 优势：
 * - 支持 exe、dll、asar、原生插件等所有文件的自动更新
 * - 仅传输变更文件，带宽开销最小
 * - 服务端删除文件后客户端自动清理
 */

import { BrowserWindow, ipcMain, app } from 'electron';
import { IPCChannel } from '@xai/shared';
import type { UpdateConfig } from '@xai/shared';
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

const isDev = process.env.XAI_DEV === '1';

/** 检查间隔：4 小时 */
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

/** 单文件下载最大重试次数（含首次） */
const MAX_DOWNLOAD_RETRIES = 5;
/** 重试基础退避毫秒数（指数退避：1s, 2s, 4s, 8s, 16s，上限 30s） */
const RETRY_BASE_DELAY_MS = 1000;
/** 重试退避上限 */
const RETRY_MAX_DELAY_MS = 30_000;

let checkTimer: ReturnType<typeof setInterval> | null = null;
let mainWindowRef: BrowserWindow | null = null;
let currentUpdateConfig: UpdateConfig | null = null;

/** 下载中的 AbortController，用于取消下载 */
let activeDownloadAbort: AbortController | null = null;

// =============================================
// 类型定义
// =============================================

/** 单个文件的清单条目 */
interface FileEntry {
  url: string;
  sha512?: string;
  size: number;
}

/** 服务端返回的版本清单（全文件） */
interface UpdateManifest {
  version: string;
  electronVersion?: string;
  releaseDate?: string;
  releaseNotes?: string;
  totalSize?: number;
  files: Record<string, FileEntry>;
}

/** 文件级 diff 结果 */
interface FileDiff {
  /** hash 变更或新增的文件 */
  changed: string[];
  /** 服务端已移除的文件 */
  deleted: string[];
}

/** 已下载完成的更新信息 */
interface DownloadedUpdate {
  version: string;
  manifest: UpdateManifest;
  diff: FileDiff;
  cacheDir: string;
}

let downloadedUpdate: DownloadedUpdate | null = null;

// =============================================
// 工具函数
// =============================================

function sendToRenderer(win: BrowserWindow | null, channel: string, ...args: unknown[]) {
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, ...args);
  }
}

/** 获取更新缓存目录 */
function getUpdateCacheDir(): string {
  return path.join(app.getPath('userData'), 'update-cache');
}

/** 获取本地 manifest 存储路径 */
function getLocalManifestPath(): string {
  return path.join(app.getPath('userData'), 'update-manifest.json');
}

/** 获取应用安装根目录（exe 所在目录） */
function getAppRootDir(): string {
  return path.dirname(process.execPath);
}

/** 构建 Basic Auth 请求头 */
function buildAuthHeader(config: UpdateConfig): string {
  const password = Buffer.from(config.password, 'base64').toString('utf-8');
  const credentials = `${config.username}:${password}`;
  return `Basic ${Buffer.from(credentials, 'utf-8').toString('base64')}`;
}

/** 比较版本号（semver 格式 x.y.z） */
function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const va = pa[i] || 0;
    const vb = pb[i] || 0;
    if (va > vb) return 1;
    if (va < vb) return -1;
  }
  return 0;
}

/** 将正斜杠路径转为 Windows 反斜杠路径 */
function toWinPath(p: string): string {
  return p.replace(/\//g, '\\');
}

/**
 * 验证相对路径不包含路径遍历（..）或绝对路径前缀，
 * 防止 manifest 中恶意/错误的路径导致意外写入。
 */
function isValidRelPath(relPath: string): boolean {
  // 拒绝包含 .. 的路径
  if (relPath.includes('..')) return false;
  // 拒绝绝对路径（Unix / 或 Windows 盘符开头）
  if (relPath.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(relPath)) return false;
  // 拒绝以分隔符开头的路径
  if (relPath.startsWith('\\')) return false;
  return true;
}

// =============================================
// 重试与错误处理工具
// =============================================

/** 判断错误是否可重试（瞬时网络故障、5xx、超时等） */
function isRetryableError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (
    code &&
    [
      'ECONNRESET',
      'ETIMEDOUT',
      'ENOTFOUND',
      'EAI_AGAIN',
      'ECONNREFUSED',
      'EHOSTUNREACH',
      'EPIPE',
      'ECONNABORTED',
    ].includes(code)
  ) {
    return true;
  }
  const msg = err instanceof Error ? err.message : String(err);
  if (/^HTTP 5\d\d$/.test(msg)) return true;
  if (
    /ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|EHOSTUNREACH|EPIPE|socket hang up|下载超时|下载不完整/i.test(
      msg,
    )
  ) {
    return true;
  }
  return false;
}

/** 将原始 Node 错误转换为用户友好的中文提示 */
function formatDownloadError(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  const msg = err instanceof Error ? err.message : String(err);
  if (code === 'ECONNRESET' || /ECONNRESET/i.test(msg)) {
    return '网络连接被重置（ECONNRESET），请检查网络稳定性后重试';
  }
  if (code === 'ETIMEDOUT' || /ETIMEDOUT/i.test(msg)) {
    return '网络连接超时，请检查网络后重试';
  }
  if (code === 'ENOTFOUND' || /ENOTFOUND/i.test(msg)) {
    return '无法解析服务器地址，请检查网络或 DNS 配置';
  }
  if (code === 'ECONNREFUSED' || /ECONNREFUSED/i.test(msg)) {
    return '服务器拒绝连接，请稍后重试';
  }
  if (code === 'EHOSTUNREACH' || /EHOSTUNREACH/i.test(msg)) {
    return '无法连接到服务器主机，请检查网络';
  }
  if (code === 'EPIPE' || /EPIPE/i.test(msg)) {
    return '网络连接断开（EPIPE），请检查网络后重试';
  }
  if (/^HTTP 5\d\d/.test(msg)) {
    return `服务器错误（${msg}），请稍后重试`;
  }
  if (/下载超时/.test(msg)) {
    return '下载超时（5 分钟无数据），请检查网络后重试';
  }
  if (/SHA512 校验失败/.test(msg)) {
    return `${msg}，请重新检查更新`;
  }
  if (code === 'ENOENT' || /ENOENT/i.test(msg)) {
    return '更新文件写入失败，请检查磁盘空间或权限后重试';
  }
  return msg;
}

/** Promise 延时 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 计算文件 SHA512（base64），用于断点续传后整体校验 */
function computeFileSha512(filePath: string): string {
  const hash = crypto.createHash('sha512');
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(64 * 1024);
    let bytesRead: number;
    while ((bytesRead = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      hash.update(buf.slice(0, bytesRead));
    }
    return hash.digest('base64');
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * 通用重试包装器（指数退避）：用于小响应（如 manifest）的拉取
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  label: string,
  signal?: AbortSignal,
): Promise<T> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= MAX_DOWNLOAD_RETRIES; attempt++) {
    if (signal?.aborted) throw new Error('Download cancelled');
    try {
      return await fn();
    } catch (err: unknown) {
      lastError = err;
      const errMsg = err instanceof Error ? err.message : String(err);
      if (errMsg === 'Download cancelled') throw err;
      if (!isRetryableError(err) || attempt === MAX_DOWNLOAD_RETRIES) {
        throw err;
      }
      const delay = Math.min(
        RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1),
        RETRY_MAX_DELAY_MS,
      );
      console.warn(
        `[AsarUpdater] ${label} 第 ${attempt}/${MAX_DOWNLOAD_RETRIES} 次失败: ${errMsg}，${delay}ms 后重试...`,
      );
      await sleep(delay);
    }
  }
  throw lastError;
}

// =============================================
// HTTP 工具
// =============================================

/** 带认证的 HTTP(S) GET 请求（返回 Buffer，用于小响应如 manifest） */
function httpGetBuffer(
  url: string,
  authHeader: string,
  onProgress?: (transferred: number, total: number) => void,
  signal?: AbortSignal,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const options: http.RequestOptions = {
      headers: { Authorization: authHeader },
      timeout: 300_000,
    };

    const req = mod.get(url, options, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        httpGetBuffer(res.headers.location, authHeader, onProgress, signal).then(resolve, reject);
        return;
      }

      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        res.resume();
        return;
      }

      const total = parseInt(res.headers['content-length'] || '0', 10);
      const chunks: Buffer[] = [];
      let transferred = 0;

      res.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
        transferred += chunk.length;
        if (onProgress) onProgress(transferred, total);
      });

      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (total > 0 && buf.length !== total) {
          reject(new Error(`下载不完整: 期望 ${total} bytes，实际 ${buf.length} bytes`));
          return;
        }
        resolve(buf);
      });
      res.on('error', reject);
    });

    // 修复：signal 监听器必须在 req 创建之后注册
    if (signal) {
      signal.addEventListener('abort', () => {
        req.destroy();
        reject(new Error('Download cancelled'));
      });
    }

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('下载超时（5分钟）'));
    });

    req.on('error', reject);
  });
}

/** 带认证的 HTTP(S) GET 请求（返回 JSON），自动重试 */
async function httpGetJson<T>(url: string, authHeader: string): Promise<T> {
  const buf = await withRetry(() => httpGetBuffer(url, authHeader), 'Manifest fetch');
  return JSON.parse(buf.toString('utf-8')) as T;
}

// =============================================
// Manifest 管理
// =============================================

/** 加载本地保存的 manifest */
function loadLocalManifest(): UpdateManifest | null {
  const localPath = getLocalManifestPath();
  if (fs.existsSync(localPath)) {
    try {
      return JSON.parse(fs.readFileSync(localPath, 'utf-8'));
    } catch {
      return null;
    }
  }
  return null;
}

/** 保存 manifest 到本地 */
function saveLocalManifest(manifest: UpdateManifest): void {
  const localPath = getLocalManifestPath();
  const dir = path.dirname(localPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(localPath, JSON.stringify(manifest, null, 2), 'utf-8');
  console.log(`[AsarUpdater] Saved local manifest: ${localPath}`);
}

// =============================================
// 核心逻辑
// =============================================

/**
 * 对比服务端与本地 manifest，返回文件差异
 * isFirstRun: 首次运行（无本地 manifest）时，若版本一致则视为基线，不下载
 */
function diffManifests(server: UpdateManifest, local: UpdateManifest | null, isFirstRun: boolean): FileDiff {
  const changed: string[] = [];
  const deleted: string[] = [];

  if (!local) {
    if (isFirstRun) {
      // 首次运行：假设已安装文件与服务端一致，仅保存基线，不下载
      console.log(`[AsarUpdater] First run: saving server manifest as baseline`);
      return { changed: [], deleted: [] };
    }
    // 非首次但本地 manifest 损坏：全量同步
    return { changed: Object.keys(server.files), deleted: [] };
  }

  // 找出变更/新增的文件
  for (const [relPath, entry] of Object.entries(server.files)) {
    // 跳过服务端 manifest 中的非法路径
    if (!isValidRelPath(relPath)) {
      console.warn(`[AsarUpdater] 服务端 manifest 包含非法路径，已跳过: ${relPath}`);
      continue;
    }
    const localEntry = local.files?.[relPath];
    if (!localEntry || localEntry.sha512 !== entry.sha512) {
      changed.push(relPath);
    }
  }

  // 找出服务端已删除的文件
  for (const relPath of Object.keys(local.files || {})) {
    // 跳过本地 manifest 中的非法路径
    if (!isValidRelPath(relPath)) {
      console.warn(`[AsarUpdater] 本地 manifest 包含非法路径，已跳过: ${relPath}`);
      continue;
    }
    if (!server.files[relPath]) {
      deleted.push(relPath);
    }
  }

  return { changed, deleted };
}

/**
 * 检查服务器上的更新（基于文件级 hash 对比）
 */
async function checkForUpdate(config: UpdateConfig): Promise<{
  available: boolean;
  manifest: UpdateManifest | null;
  diff: FileDiff | null;
}> {
  const baseUrl = config.server.replace(/\/+$/, '') + '/';
  const authHeader = buildAuthHeader(config);

  const serverManifest = await httpGetJson<UpdateManifest>(baseUrl + 'update-manifest.json', authHeader);
  const localManifest = loadLocalManifest();
  const currentVersion = app.getVersion();

  console.log(`[AsarUpdater] Server: v${serverManifest.version} (${Object.keys(serverManifest.files).length} files), Local: v${currentVersion}`);

  // 版本不低于时才进行文件对比（防止降级）
  if (compareVersions(serverManifest.version, currentVersion) < 0) {
    console.log(`[AsarUpdater] Server version is older, skipping.`);
    return { available: false, manifest: null, diff: null };
  }

  const isFirstRun = !localManifest;
  const diff = diffManifests(serverManifest, localManifest, isFirstRun);
  const hasChanges = diff.changed.length > 0 || diff.deleted.length > 0;

  console.log(`[AsarUpdater] Diff: ${diff.changed.length} changed, ${diff.deleted.length} deleted`);

  if (hasChanges) {
    return { available: true, manifest: serverManifest, diff };
  }

  // 首次运行或无变更：保存服务端 manifest 作为本地基线
  if (isFirstRun || !localManifest) {
    saveLocalManifest(serverManifest);
  }

  return { available: false, manifest: serverManifest, diff: null };
}

/**
 * 单次下载尝试（支持 Range 断点续传，流式写入 .part 文件）
 * - startOffset > 0 时发送 Range: bytes=startOffset-
 * - 206 Partial Content → 追加写入；200 OK → 覆盖写入（服务器未支持 Range）
 * - 流式落盘，避免大文件占满内存
 */
function downloadFileChunk(
  url: string,
  tmpPath: string,
  authHeader: string,
  startOffset: number,
  onProgress?: (transferred: number, total: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const headers: Record<string, string> = { Authorization: authHeader };
    if (startOffset > 0) {
      headers.Range = `bytes=${startOffset}-`;
    }
    const options: http.RequestOptions = {
      headers,
      timeout: 300_000,
    };

    let writeStream: fs.WriteStream | null = null;
    let total = 0;
    let transferred = startOffset;
    let settled = false;

    const cleanup = () => {
      if (writeStream) {
        try {
          writeStream.destroy();
        } catch {
          /* ignore */
        }
      }
    };

    const req = mod.get(url, options, (res) => {
      // 处理重定向：丢弃 Range，从头开始（避免跨主机续传的复杂性）
      if (
        res.statusCode &&
        res.statusCode >= 300 &&
        res.statusCode < 400 &&
        res.headers.location
      ) {
        res.resume();
        if (startOffset > 0) {
          try {
            fs.unlinkSync(tmpPath);
          } catch {
            /* ignore */
          }
        }
        downloadFileChunk(res.headers.location, tmpPath, authHeader, 0, onProgress, signal).then(
          resolve,
          reject,
        );
        return;
      }

      let isResume = false;
      if (res.statusCode === 206) {
        // 服务器支持 Range：追加写入
        isResume = true;
        // 确保父目录存在，防止目录不存在导致 ENOENT
        const parentDir206 = path.dirname(tmpPath);
        if (!fs.existsSync(parentDir206)) {
          fs.mkdirSync(parentDir206, { recursive: true });
        }
        writeStream = fs.createWriteStream(tmpPath, { flags: 'a' });
        const contentRange = res.headers['content-range'] || '';
        const match = /bytes \d+-\d+\/(\d+)/.exec(contentRange);
        total = match ? parseInt(match[1], 10) : 0;
      } else if (res.statusCode === 200) {
        // 服务器未支持 Range 或无 Range 请求：覆盖写入
        // 确保父目录存在，防止目录不存在导致 ENOENT
        const parentDir200 = path.dirname(tmpPath);
        if (!fs.existsSync(parentDir200)) {
          fs.mkdirSync(parentDir200, { recursive: true });
        }
        writeStream = fs.createWriteStream(tmpPath, { flags: 'w' });
        transferred = 0;
        total = parseInt(res.headers['content-length'] || '0', 10);
      } else {
        reject(new Error(`HTTP ${res.statusCode}`));
        res.resume();
        return;
      }

      console.log(
        `[AsarUpdater] Downloading ${path.basename(tmpPath)}: ${isResume ? `resume from ${startOffset}` : 'full'}, total=${total}`,
      );

      res.on('data', (chunk: Buffer) => {
        if (settled) return;
        writeStream!.write(chunk);
        transferred += chunk.length;
        if (onProgress) onProgress(transferred, total);
      });

      res.on('end', () => {
        if (settled) return;
        writeStream!.end((err?: NodeJS.ErrnoException | null) => {
          if (err) {
            if (!settled) {
              settled = true;
              reject(err);
            }
            return;
          }
          if (settled) return;
          // 校验最终大小
          const actualSize = fs.statSync(tmpPath).size;
          if (total > 0 && actualSize !== total) {
            settled = true;
            reject(
              new Error(`下载不完整: 期望 ${total} bytes，实际 ${actualSize} bytes`),
            );
            return;
          }
          settled = true;
          resolve();
        });
      });

      res.on('error', (err) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      });
    });

    // 修复：signal 监听器必须在 req 创建之后注册
    if (signal) {
      signal.addEventListener('abort', () => {
        if (settled) return;
        settled = true;
        req.destroy();
        cleanup();
        reject(new Error('Download cancelled'));
      });
    }

    req.on('timeout', () => {
      if (settled) return;
      settled = true;
      req.destroy();
      cleanup();
      reject(new Error('下载超时（5分钟）'));
    });

    req.on('error', (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    });
  });
}

/**
 * 下载单个文件并校验（流式写入 + 断点续传 + 自动重试）
 *
 * 策略：
 * - 先检查目标文件是否已存在且 SHA 匹配，匹配则跳过（支持批次中断后断点续下）
 * - 否则下载到 .part 临时文件：失败时保留 .part，下次重试从已下载字节数续传
 * - SHA512 校验失败时删除 .part 并从 0 重新下载
 * - 网络瞬时错误（ECONNRESET/ETIMEDOUT/5xx 等）按指数退避重试，最多 MAX_DOWNLOAD_RETRIES 次
 */
async function downloadFile(
  url: string,
  localPath: string,
  authHeader: string,
  sha512?: string,
  onProgress?: (transferred: number, total: number) => void,
): Promise<void> {
  // 整个下载流程禁用 asar 拦截：localPath 可能是 app.asar，tmpPath 是 app.asar.part，
  // Electron 的 asar 处理器会对路径中含 ".asar" 的所有 fs 操作做拦截（用 indexOf('.asar') 切分），
  // 把 app.asar.part 误判为 app.asar 归档内的 .part 文件，导致 ENOENT。
  const origNoAsar = process.noAsar;
  process.noAsar = true;
  try {
    // 跳过已下载且校验通过的文件（断点续下整批更新）
    if (sha512 && fs.existsSync(localPath)) {
      try {
        const existingHash = computeFileSha512(localPath);
        if (existingHash === sha512) {
          console.log(`[AsarUpdater] Already up-to-date: ${path.basename(localPath)}`);
          return;
        }
      } catch {
        // 校验失败（文件损坏等），继续重新下载
      }
    }

    console.log(`[AsarUpdater] Downloading: ${url}`);
    const tmpPath = localPath + '.part';
    const signal = activeDownloadAbort?.signal;

    let lastError: unknown = null;
    for (let attempt = 1; attempt <= MAX_DOWNLOAD_RETRIES; attempt++) {
      if (signal?.aborted) throw new Error('Download cancelled');

      // 从 .part 文件确定续传起点
      let startOffset = 0;
      if (fs.existsSync(tmpPath)) {
        try {
          startOffset = fs.statSync(tmpPath).size;
        } catch {
          startOffset = 0;
        }
      }

      try {
        await downloadFileChunk(url, tmpPath, authHeader, startOffset, onProgress, signal);

        const finalSize = fs.statSync(tmpPath).size;
        console.log(
          `[AsarUpdater] Downloaded (${attempt}/${MAX_DOWNLOAD_RETRIES}): ${path.basename(localPath)}, ${finalSize} bytes${startOffset > 0 ? ` (resumed from ${startOffset})` : ''}`,
        );

        // SHA512 校验
        if (sha512) {
          const hash = computeFileSha512(tmpPath);
          if (hash !== sha512) {
            // 校验失败：删除 .part，从头重新下载
            try {
              fs.unlinkSync(tmpPath);
            } catch {
              /* ignore */
            }
            throw new Error(`SHA512 校验失败: ${path.basename(localPath)}`);
          }
        }

        // 重命名 .part → 最终文件（noAsar 已在函数入口设置）
        const dir = path.dirname(localPath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        fs.renameSync(tmpPath, localPath);
        console.log(
          `[AsarUpdater] Saved: ${localPath} (${(fs.statSync(localPath).size / 1024 / 1024).toFixed(2)} MB)`,
        );
        return;
      } catch (err: unknown) {
        lastError = err;
        const errMsg = err instanceof Error ? err.message : String(err);
        if (errMsg === 'Download cancelled') throw err;

        const isShaMismatch = /SHA512/.test(errMsg);
        const retryable = isShaMismatch || isRetryableError(err);

        if (!retryable || attempt === MAX_DOWNLOAD_RETRIES) {
          // 不可重试的错误：清理 .part 后抛出
          if (!retryable) {
            try {
              fs.unlinkSync(tmpPath);
            } catch {
              /* ignore */
            }
          }
          throw err;
        }

        // 指数退避：1s, 2s, 4s, 8s, 16s（上限 30s）
        const delay = Math.min(
          RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1),
          RETRY_MAX_DELAY_MS,
        );
        console.warn(
          `[AsarUpdater] Download attempt ${attempt}/${MAX_DOWNLOAD_RETRIES} failed: ${errMsg}. Retrying in ${delay}ms...`,
        );
        await sleep(delay);
      }
    }

    throw lastError;
  } finally {
    process.noAsar = origNoAsar;
  }
}

/**
 * 下载变更文件到缓存目录
 */
async function downloadChangedFiles(
  config: UpdateConfig,
  manifest: UpdateManifest,
  diff: FileDiff,
): Promise<string> {
  const baseUrl = config.server.replace(/\/+$/, '') + '/';
  const authHeader = buildAuthHeader(config);
  const cacheDir = path.join(getUpdateCacheDir(), manifest.version);

  if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true });
  }

  // 取消之前的下载
  if (activeDownloadAbort) {
    activeDownloadAbort.abort();
    activeDownloadAbort = null;
  }
  activeDownloadAbort = new AbortController();

  // 计算总下载大小
  let totalSize = 0;
  for (const relPath of diff.changed) {
    totalSize += manifest.files[relPath].size;
  }
  let totalTransferred = 0;

  const version = manifest.version;
  let lastFileTransferred = 0;
  const onProgress = (transferred: number, _total: number) => {
    const delta = transferred - lastFileTransferred;
    totalTransferred += delta;
    lastFileTransferred = transferred;
    const percent = totalSize > 0 ? Math.round((totalTransferred / totalSize) * 100) : 0;
    sendToRenderer(mainWindowRef, IPCChannel.UpdateDownloadProgress, {
      percent,
      transferred: totalTransferred,
      total: totalSize,
      version,
    });
  };

  // 逐个下载变更文件
  // 注意：relPath 可能是 resources/app.asar 或 resources/app.asar.unpacked/...，
  // 对这些路径做 fs 操作时必须禁用 asar 拦截（同 downloadFile 中的处理）。
  const origNoAsar = process.noAsar;
  process.noAsar = true;
  try {
    for (const relPath of diff.changed) {
      // 路径安全性校验
      if (!isValidRelPath(relPath)) {
        console.error(`[AsarUpdater] 跳过非法路径: ${relPath}`);
        continue;
      }

      lastFileTransferred = 0;
      const entry = manifest.files[relPath];
      if (!entry) {
        console.error(`[AsarUpdater] 清单中找不到条目: ${relPath}`);
        continue;
      }

      const localPath = path.join(cacheDir, relPath);

      // 确保 .part 文件的父目录存在（防止 ENOENT）
      const partDir = path.dirname(localPath);
      if (!fs.existsSync(partDir)) {
        fs.mkdirSync(partDir, { recursive: true });
      }

      await downloadFile(
        baseUrl + entry.url,
        localPath,
        authHeader,
        entry.sha512,
        onProgress,
      );
    }
  } finally {
    process.noAsar = origNoAsar;
  }

  activeDownloadAbort = null;
  return cacheDir;
}

/**
 * 生成 bat 脚本并执行更新
 * 脚本流程：等进程退出 → 复制变更文件 → 删除已移除文件 → 重启
 */
function applyUpdate(update: DownloadedUpdate): void {
  const appRoot = getAppRootDir();
  const exeName = path.basename(process.execPath);

  console.log(`[AsarUpdater] Apply update: ${update.version}`);
  console.log(`  App root: ${appRoot}`);
  console.log(`  Changed: ${update.diff.changed.length} files`);
  console.log(`  Deleted: ${update.diff.deleted.length} files`);

  const batPath = path.join(getUpdateCacheDir(), `update-${update.version}.bat`);

  const batLines: string[] = [
    '@echo off',
    `echo [XAI Update] Applying v${update.version}`,
    // 等 app.exit(0) 生效 + 子进程释放文件锁
    'timeout /t 5 /nobreak >NUL',
    // 兜底：强杀残留进程
    `taskkill /F /IM "${exeName}" >NUL 2>&1`,
    'timeout /t 2 /nobreak >NUL',
    '',
    'echo [XAI Update] Copying updated files...',
  ];

  // 判断缓存目录与安装目录是否在同一驱动器
  const cacheDrive = path.parse(update.cacheDir).root.toLowerCase();
  const appDrive = path.parse(appRoot).root.toLowerCase();
  const sameDrive = cacheDrive === appDrive;

  // 1. 复制/移动变更的文件到安装目录（同盘用 move，跨盘用 copy）
  for (const relPath of update.diff.changed) {
    if (!isValidRelPath(relPath)) {
      console.warn(`[AsarUpdater] 跳过非法路径（apply）: ${relPath}`);
      continue;
    }
    const srcPath = path.join(update.cacheDir, relPath);
    const destPath = path.join(appRoot, toWinPath(relPath));
    // 确保目标目录存在
    batLines.push(`if not exist "${path.dirname(destPath)}" mkdir "${path.dirname(destPath)}" >NUL 2>&1`);
    if (sameDrive) {
      // 同盘：move 是重命名操作，瞬间完成
      batLines.push(`move /Y "${srcPath}" "${destPath}" >NUL`);
    } else {
      batLines.push(`copy /Y "${srcPath}" "${destPath}" >NUL`);
    }
  }

  // 2. 删除服务端已移除的文件
  if (update.diff.deleted.length > 0) {
    batLines.push('');
    batLines.push('echo [XAI Update] Removing deleted files...');
    for (const relPath of update.diff.deleted) {
      if (!isValidRelPath(relPath)) {
        console.warn(`[AsarUpdater] 跳过非法路径（delete）: ${relPath}`);
        continue;
      }
      const targetPath = path.join(appRoot, toWinPath(relPath));
      batLines.push(`if exist "${targetPath}" del /F /Q "${targetPath}" >NUL 2>&1`);
    }

    // 尝试清理可能留下的空目录（从深到浅）
    batLines.push('');
    batLines.push('echo [XAI Update] Cleaning empty directories...');
    const deletedDirs = new Set<string>();
    for (const relPath of update.diff.deleted) {
      let dir = path.dirname(toWinPath(relPath));
      while (dir && dir !== '.') {
        deletedDirs.add(dir);
        dir = path.dirname(dir);
      }
    }
    // 按路径长度降序排列（先删深层目录）
    const sortedDirs = [...deletedDirs].sort((a, b) => b.length - a.length);
    for (const dir of sortedDirs) {
      const fullPath = path.join(appRoot, dir);
      batLines.push(`if exist "${fullPath}" rmdir "${fullPath}" >NUL 2>&1`);
    }
  }

  batLines.push('');
  batLines.push('echo [XAI Update] Cleaning cache...');
  // 清理缓存目录
  batLines.push(`rmdir /S /Q "${update.cacheDir}" >NUL 2>&1`);

  batLines.push('');
  batLines.push('echo [XAI Update] Restarting...');
  // 重启
  batLines.push(`start "" "${process.execPath}"`);
  // 清理 bat 自身并关闭窗口
  batLines.push('del /F "%~f0" >NUL 2>&1');
  batLines.push('exit');

  const batContent = batLines.join('\r\n');

  fs.writeFileSync(batPath, batContent, 'utf-8');
  console.log(`[AsarUpdater] Bat script: ${batPath}`);

  spawn('cmd.exe', ['/c', batPath], {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  });

  app.exit(0);
}

// =============================================
// 对外接口
// =============================================

export function initAutoUpdater(mainWindow: BrowserWindow | null, updateConfig: UpdateConfig): void {
  mainWindowRef = mainWindow;
  currentUpdateConfig = updateConfig;

  ipcMain.handle(IPCChannel.UpdateCheck, async () => {
    try {
      if (isDev) {
        return { success: false, error: '开发环境不支持更新检查' };
      }
      if (process.platform !== 'win32') {
        // asar 差量更新依赖 .bat + cmd.exe + taskkill，仅支持 Windows
        return { success: false, error: '当前平台暂不支持自动更新（仅 Windows）' };
      }
      if (!currentUpdateConfig?.enabled || !currentUpdateConfig?.server) {
        return { success: false, error: '更新服务未配置或已禁用' };
      }

      const result = await checkForUpdate(currentUpdateConfig);
      if (!result.available) {
        sendToRenderer(mainWindowRef, IPCChannel.UpdateCheckResult, {
          available: false,
          version: result.manifest?.version ?? app.getVersion(),
        });
        return { success: true, version: null };
      }

      sendToRenderer(mainWindowRef, IPCChannel.UpdateCheckResult, {
        available: true,
        version: result.manifest!.version,
        releaseNotes: result.manifest!.releaseNotes ?? '',
      });

      // 异步下载
      downloadUpdate(currentUpdateConfig, result.manifest!, result.diff!);

      return { success: true, version: result.manifest!.version };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[AsarUpdater] UpdateCheck error:', msg);
      return { success: false, error: msg };
    }
  });

  ipcMain.handle(IPCChannel.UpdateInstall, async () => {
    if (downloadedUpdate) {
      console.log('[AsarUpdater] Applying update:', downloadedUpdate.version);
      // 先保存本地 manifest，再应用更新
      saveLocalManifest(downloadedUpdate.manifest);
      applyUpdate(downloadedUpdate);
      return { success: true };
    }
    return { success: false, error: '没有可用的更新' };
  });

  if (isDev) {
    console.log('[AsarUpdater] Dev mode, skipping auto-update.');
    return;
  }

  if (process.platform !== 'win32') {
    // asar 差量更新（.bat + cmd.exe + taskkill）仅支持 Windows；
    // mac/linux 禁用后台定时检查，手动检查也会返回不支持
    console.log('[AsarUpdater] Auto-update is only supported on Windows, skipping.');
    return;
  }

  if (!updateConfig?.enabled || !updateConfig?.server) {
    console.log('[AsarUpdater] Update not configured or disabled.');
    return;
  }

  // 启动后延迟 30 秒检查
  const doCheck = () => {
    checkAndDownload(currentUpdateConfig!).catch((err: Error) => {
      console.error('[AsarUpdater] Scheduled check failed:', err.message);
    });
  };
  setTimeout(doCheck, 30_000);
  checkTimer = setInterval(doCheck, CHECK_INTERVAL_MS);

  console.log('[AsarUpdater] Initialized, server:', updateConfig.server);
}

export function applyUpdateConfig(config: UpdateConfig): void {
  currentUpdateConfig = config;
  if (!isDev && config?.enabled && config?.server) {
    checkAndDownload(config).catch((err: Error) => {
      console.error('[AsarUpdater] applyUpdateConfig check failed:', err.message);
    });
  }
}

async function checkAndDownload(config: UpdateConfig): Promise<void> {
  try {
    const result = await checkForUpdate(config);
    if (!result.available || !result.manifest || !result.diff) {
      sendToRenderer(mainWindowRef, IPCChannel.UpdateCheckResult, {
        available: false,
        version: result.manifest?.version ?? app.getVersion(),
      });
      return;
    }

    sendToRenderer(mainWindowRef, IPCChannel.UpdateCheckResult, {
      available: true,
      version: result.manifest.version,
      releaseNotes: result.manifest.releaseNotes ?? '',
    });

    await downloadUpdate(config, result.manifest, result.diff);
  } catch (err: unknown) {
    const rawMsg = err instanceof Error ? err.message : String(err);
    if (rawMsg === 'Download cancelled') return;
    console.error('[AsarUpdater] checkAndDownload error:', rawMsg);
    sendToRenderer(mainWindowRef, IPCChannel.UpdateError, {
      message: formatDownloadError(err),
    });
  }
}

async function downloadUpdate(config: UpdateConfig, manifest: UpdateManifest, diff: FileDiff): Promise<void> {
  try {
    const cacheDir = await downloadChangedFiles(config, manifest, diff);

    const update: DownloadedUpdate = {
      version: manifest.version,
      manifest,
      diff,
      cacheDir,
    };
    downloadedUpdate = update;

    sendToRenderer(mainWindowRef, IPCChannel.UpdateDownloaded, {
      version: manifest.version,
      releaseNotes: manifest.releaseNotes ?? '',
    });
    console.log(`[AsarUpdater] Update ready: v${manifest.version} (${diff.changed.length} files changed, ${diff.deleted.length} deleted)`);
  } catch (err: unknown) {
    const rawMsg = err instanceof Error ? err.message : String(err);
    if (rawMsg === 'Download cancelled') return;
    console.error('[AsarUpdater] Download error:', rawMsg);
    sendToRenderer(mainWindowRef, IPCChannel.UpdateError, {
      message: formatDownloadError(err),
    });
  }
}

export function disposeAutoUpdater(): void {
  if (activeDownloadAbort) {
    activeDownloadAbort.abort();
    activeDownloadAbort = null;
  }
  if (checkTimer) {
    clearInterval(checkTimer);
    checkTimer = null;
  }
}

