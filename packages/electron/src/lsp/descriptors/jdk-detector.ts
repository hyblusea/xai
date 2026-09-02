/**
 * JDK detection — locates a suitable Java runtime for JDT.LS.
 *
 * JDT.LS 1.44+ requires JDK 21 or newer. We search in this order:
 *   1. JAVA_HOME environment variable
 *   2. PATH (looks for java/java.exe and resolves the symlink)
 *   3. Common install locations (Windows: Program Files\Java)
 *
 * We verify the JDK by running `java -version` and parsing the version string.
 */
import { execSync } from 'child_process';
import { existsSync, readdirSync, realpathSync } from 'fs';
import path from 'path';

export interface JdkInfo {
  /** Absolute path to the java executable. */
  javaPath: string;
  /** Java home directory (parent of bin/). */
  javaHome: string;
  /** Major version (e.g. 21, 17). */
  majorVersion: number;
  /** Full version string from `java -version`. */
  versionString: string;
}

/** Minimum required JDK version for JDT.LS 1.44+. */
export const MIN_JDK_VERSION = 17;

/**
 * Parse the major version from a `java -version` output line.
 * Examples:
 *   'openjdk version "17.0.1" 2021-10-19' → 17
 *   'openjdk version "1.8.0_292"' → 8
 *   'java version "21" 2023-09-19' → 21
 */
function parseMajorVersion(versionOutput: string): number | null {
  const match = versionOutput.match(/version "(\d+)(?:\.(\d+))?/);
  if (!match) return null;
  const major = parseInt(match[1], 10);
  const minor = parseInt(match[2] || '0', 10);
  // Old naming: 1.8.0 means Java 8
  if (major === 1) return minor;
  return major;
}

/** Run `java -version` and return parsed info, or null if it fails. */
function probeJava(javaPath: string): JdkInfo | null {
  try {
    // `java -version` historically writes to stderr — redirect to stdout
    // and capture both streams.
    const combined = execSync(`"${javaPath}" -version 2>&1`, {
      encoding: 'utf-8',
      timeout: 10000,
      stdio: 'pipe',
    });
    const major = parseMajorVersion(combined);
    if (!major) return null;

    // Resolve javaHome: should be parent of bin/
    const binDir = path.dirname(javaPath);
    const javaHome = path.dirname(binDir);

    return {
      javaPath,
      javaHome,
      majorVersion: major,
      versionString: combined.split('\n')[0].trim(),
    };
  } catch {
    return null;
  }
}

/** Check if a java executable exists at a path (with .exe on Windows). */
function findJavaExe(dir: string): string | null {
  const exeName = process.platform === 'win32' ? 'java.exe' : 'java';
  const candidates = [
    path.join(dir, exeName),
    path.join(dir, 'bin', exeName),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

/** Common install locations to check on Windows. */
function getCommonWindowsLocations(): string[] {
  const locations: string[] = [];
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
  const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';

  // Oracle JDK
  locations.push(path.join(programFiles, 'Java'));
  // OpenJDK
  locations.push(path.join(programFiles, 'Eclipse Adoptium'));
  locations.push(path.join(programFiles, 'Microsoft'));
  locations.push(path.join(programFiles, 'Zulu'));
  locations.push(path.join(programFilesX86, 'Java'));

  return locations;
}

/**
 * Detect a suitable JDK installation.
 * Returns null if no JDK is found or the version is too old.
 */
export function detectJdk(): JdkInfo | null {
  // 1. JAVA_HOME
  const javaHomeEnv = process.env.JAVA_HOME;
  if (javaHomeEnv && existsSync(javaHomeEnv)) {
    const exe = findJavaExe(javaHomeEnv);
    if (exe) {
      const info = probeJava(exe);
      if (info && info.majorVersion >= MIN_JDK_VERSION) return info;
    }
  }

  // 2. PATH — try `java` directly
  try {
    const pathJava = process.platform === 'win32' ? 'java.exe' : 'java';
    const which = execSync(`${process.platform === 'win32' ? 'where' : 'which'} ${pathJava}`, {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: 'pipe',
    }).trim().split('\n')[0].trim();
    if (which && existsSync(which)) {
      // Resolve symlinks (common on macOS/Linux)
      let resolved = which;
      try { resolved = realpathSync(which); } catch { /* use as-is */ }
      const info = probeJava(resolved);
      if (info && info.majorVersion >= MIN_JDK_VERSION) return info;
    }
  } catch { /* java not in PATH */ }

  // 3. Common install locations (Windows-only for now)
  if (process.platform === 'win32') {
    for (const base of getCommonWindowsLocations()) {
      if (!existsSync(base)) continue;
      try {
        const entries = readdirSync(base, { withFileTypes: true }) as Array<{ name: string; isDirectory: () => boolean }>;
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          const jdkDir = path.join(base, entry.name);
          const exe = findJavaExe(jdkDir);
          if (exe) {
            const info = probeJava(exe);
            if (info && info.majorVersion >= MIN_JDK_VERSION) return info;
          }
        }
      } catch { /* skip unreadable dir */ }
    }
  }

  return null;
}
