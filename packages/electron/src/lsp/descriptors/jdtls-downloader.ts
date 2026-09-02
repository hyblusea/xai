/**
 * JDT.LS downloader — fetches and extracts the Eclipse JDT Language Server
 * on first use, then caches it in userData so subsequent launches are instant.
 *
 * Layout under userData:
 *   jdtls/
 *     current-version.txt          ← marker file with installed version
 *     jdt-language-server-1.44.0/  ← extracted JDT.LS directory
 *       plugins/
 *       config_win/
 *       ...
 */
import { app } from 'electron';
import { createHash } from 'crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { pipeline } from 'stream/promises';
import { spawn } from 'child_process';
import { Readable } from 'stream';

/** Pinned JDT.LS version. Update this + URL when upgrading. */
export const JDTLS_VERSION = '1.44.0';
const JDTLS_BUILD = '202501221502';
const JDTLS_TARBALL = `jdt-language-server-${JDTLS_VERSION}-${JDTLS_BUILD}.tar.gz`;
const JDTLS_DOWNLOAD_URL = `https://download.eclipse.org/jdtls/milestones/${JDTLS_VERSION}/${JDTLS_TARBALL}`;
const JDTLS_SHA256_URL = `https://download.eclipse.org/jdtls/milestones/${JDTLS_VERSION}/${JDTLS_TARBALL}.sha256`;

/** Expected extracted directory name. */
const EXTRACTED_DIR_NAME = `jdt-language-server-${JDTLS_VERSION}`;

export interface DownloadProgress {
  message: string;
  percent: number; // 0-100
}

export interface JdtlsInstall {
  /** Root directory of the extracted JDT.LS (contains plugins/, config_win, etc.). */
  rootDir: string;
  /** Path to the equinox launcher jar. */
  launcherJar: string;
  /** Config directory path (config_win / config_linux / config_mac). */
  configDir: string;
}

/** Get the userData/jdtls directory where JDT.LS is cached. */
function getJdtlsCacheDir(): string {
  const dir = path.join(app.getPath('userData'), 'jdtls');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

/** Read the installed version marker file. Returns null if not installed. */
function getInstalledVersion(): string | null {
  const marker = path.join(getJdtlsCacheDir(), 'current-version.txt');
  if (!existsSync(marker)) return null;
  try {
    return readFileSync(marker, 'utf-8').trim();
  } catch {
    return null;
  }
}

/** Find the equinox launcher jar in plugins/ (filename includes version number). */
function findLauncherJar(pluginsDir: string): string | null {
  try {
    const entries = readdirSync(pluginsDir);
    const launcher = entries.find(name =>
      name.startsWith('org.eclipse.equinox.launcher_') && name.endsWith('.jar')
    );
    return launcher ? path.join(pluginsDir, launcher) : null;
  } catch {
    return null;
  }
}

/** Get the platform-specific config directory name. */
function getConfigDirName(): string {
  switch (process.platform) {
    case 'win32': return 'config_win';
    case 'darwin': return 'config_mac';
    default: return 'config_linux';
  }
}

/** Validate that an extracted JDT.LS directory has all required pieces. */
function validateInstall(rootDir: string): JdtlsInstall | null {
  const pluginsDir = path.join(rootDir, 'plugins');
  if (!existsSync(pluginsDir)) return null;
  const launcherJar = findLauncherJar(pluginsDir);
  if (!launcherJar) return null;
  const configDir = path.join(rootDir, getConfigDirName());
  if (!existsSync(configDir)) return null;
  return { rootDir, launcherJar, configDir };
}

/** Fetch the expected SHA256 checksum for the tarball. */
async function fetchExpectedSha256(): Promise<string | null> {
  try {
    const resp = await fetch(JDTLS_SHA256_URL);
    if (!resp.ok) return null;
    const text = await resp.text();
    // SHA file may contain just the hash, or "hash  filename" format
    return text.trim().split(/\s+/)[0].toLowerCase();
  } catch {
    return null;
  }
}

/** Download the tarball to a temp file with progress reporting. */
async function downloadTarball(
  destPath: string,
  onProgress: (p: DownloadProgress) => void,
): Promise<void> {
  onProgress({ message: '正在下载 JDT.LS...', percent: 0 });

  const resp = await fetch(JDTLS_DOWNLOAD_URL);
  if (!resp.ok || !resp.body) {
    throw new Error(`下载失败: HTTP ${resp.status} ${resp.statusText}`);
  }

  const totalBytes = parseInt(resp.headers.get('content-length') || '0', 10);
  let receivedBytes = 0;
  let lastReportedPercent = -1;

  const hash = createHash('sha256');
  const fileStream = createWriteStream(destPath);

  // Node's Readable.fromWeb converts a ReadableStream to a Node stream.
  const nodeStream = Readable.fromWeb(resp.body as any);

  // Wrap with a passthrough that updates progress and hashes chunks.
  let lastError: Error | null = null;
  nodeStream.on('data', (chunk: Buffer) => {
    receivedBytes += chunk.length;
    hash.update(chunk);
    if (totalBytes > 0) {
      const percent = Math.floor((receivedBytes / totalBytes) * 100);
      // Only report when percent changes by at least 1%
      if (percent !== lastReportedPercent) {
        lastReportedPercent = percent;
        onProgress({ message: `正在下载 JDT.LS... ${percent}%`, percent });
      }
    }
  });

  try {
    await pipeline(nodeStream, fileStream);
  } catch (err) {
    lastError = err as Error;
  }

  if (lastError) throw lastError;

  // Verify SHA256
  const actualHash = hash.digest('hex');
  const expectedHash = await fetchExpectedSha256();
  if (expectedHash && actualHash !== expectedHash) {
    throw new Error(`SHA256 校验失败\n期望: ${expectedHash}\n实际: ${actualHash}`);
  }
  onProgress({ message: '下载完成', percent: 100 });
}

/** Extract tar.gz using the system tar (available on all platforms). */
function extractTarball(tarballPath: string, destDir: string, onProgress: (p: DownloadProgress) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    onProgress({ message: '正在解压 JDT.LS...', percent: 0 });
    // Use system tar. On Windows 10+, tar.exe is bundled.
    // -xzf: extract, gzip, file
    // -C:  change to destDir before extracting
    const tar = spawn('tar', ['-xzf', tarballPath, '-C', destDir], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';
    tar.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });

    tar.on('close', (code) => {
      if (code === 0) {
        onProgress({ message: '解压完成', percent: 100 });
        resolve();
      } else {
        reject(new Error(`tar 解压失败 (code=${code}): ${stderr}`));
      }
    });

    tar.on('error', (err) => {
      reject(new Error(`无法启动 tar: ${err.message}。Windows 10 1803+ 自带 tar.exe，请确认系统支持。`));
    });
  });
}

/**
 * Ensure JDT.LS is installed. Downloads + extracts on first use.
 * Returns the install info, or throws on failure.
 */
export async function ensureJdtlsInstalled(
  onProgress: (p: DownloadProgress) => void,
): Promise<JdtlsInstall> {
  // Fast path — already installed
  const installedVersion = getInstalledVersion();
  if (installedVersion === JDTLS_VERSION) {
    const rootDir = path.join(getJdtlsCacheDir(), EXTRACTED_DIR_NAME);
    const install = validateInstall(rootDir);
    if (install) return install;
    // Marker exists but directory is corrupt — fall through to reinstall
  }

  const cacheDir = getJdtlsCacheDir();
  const extractDir = path.join(cacheDir, EXTRACTED_DIR_NAME);

  // Clean up any previous extraction
  if (existsSync(extractDir)) {
    try { rmSync(extractDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  // Download to a temp file
  const tmpFile = path.join(tmpdir(), JDTLS_TARBALL);
  await downloadTarball(tmpFile, onProgress);

  // Extract to a staging directory first, then rename for atomicity
  const stagingDir = path.join(cacheDir, `${EXTRACTED_DIR_NAME}.staging`);
  if (existsSync(stagingDir)) {
    try { rmSync(stagingDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  mkdirSync(stagingDir, { recursive: true });

  await extractTarball(tmpFile, stagingDir, onProgress);

  // The tarball extracts to a top-level directory — find it and move contents
  const entries = readdirSync(stagingDir, { withFileTypes: true });
  // Some tarballs have a wrapper dir, some don't. Detect and flatten.
  const innerDir = entries.length === 1 && entries[0].isDirectory()
    ? path.join(stagingDir, entries[0].name)
    : stagingDir;

  const install = validateInstall(innerDir);
  if (!install) {
    throw new Error('JDT.LS 解压后校验失败: 缺少 plugins/ 或 launcher jar');
  }

  // Move to the final location
  renameSync(innerDir, extractDir);
  // Clean up staging if it's not the same as innerDir
  if (innerDir !== stagingDir) {
    try { rmSync(stagingDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  // Write version marker
  writeFileSync(path.join(cacheDir, 'current-version.txt'), JDTLS_VERSION, 'utf-8');

  // Clean up temp tarball
  try { rmSync(tmpFile, { force: true }); } catch { /* ignore */ }

  return validateInstall(extractDir)!;
}

/** Check if JDT.LS is already installed (without downloading). */
export function isJdtlsInstalled(): boolean {
  return getInstalledVersion() === JDTLS_VERSION;
}
