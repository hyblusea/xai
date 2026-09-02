/**
 * Lombok 检测器 — 检测项目是否使用 Lombok，并找到 lombok.jar 路径。
 *
 * JDT.LS 默认不支持 Lombok：@Data/@Getter/@Slf4j 等注解生成的 getter/setter
 * 方法在 JDT.LS 看来不存在，导致 completion 缺失、误报 "method undefined"。
 *
 * 解决方案：将 lombok.jar 作为 OSGi bundle 加入 JDT.LS 的
 * initializationOptions.bundles。lombok.jar 本身就是一个 OSGi bundle，加入后
 * JDT.LS 的 JDT 编译器就能识别 Lombok 注解生成的方法。
 *
 * 检测流程：
 *   1. 在项目根目录及上级目录查找 pom.xml
 *   2. 检查 pom.xml 是否声明了 org.projectlombok:lombok 依赖
 *   3. 读取 Maven settings.xml 的 localRepository（默认 ~/.m2/repository）
 *   4. 在本地仓库中查找 lombok.jar，返回最新版本的绝对路径
 */
import { existsSync, readFileSync, readdirSync } from 'fs';
import path from 'path';
import { homedir } from 'os';
import { execSync } from 'child_process';

/** Maven 本地仓库中 lombok 的 groupId/artifactId 路径片段。 */
const LOMBOK_REPO_PATH = path.join('org', 'projectlombok', 'lombok');

/**
 * 从项目根目录向上查找 pom.xml，返回其所在目录。
 * 找不到返回 null。
 */
export function findProjectRoot(startDir: string): string | null {
  let dir = startDir;
  // 先向上检查当前目录及父目录
  for (let i = 0; i < 6; i++) {
    const pomPath = path.join(dir, 'pom.xml');
    if (existsSync(pomPath)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // 再检查当前目录的直接子目录（一层），覆盖多模块项目场景
  try {
    const entries = readdirSync(startDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
        const childDir = path.join(startDir, entry.name);
        if (existsSync(path.join(childDir, 'pom.xml'))) return childDir;
      }
    }
  } catch { /* ignore */ }
  return null;
}

/**
 * 查找工作区内所有使用 Lombok 的 Maven 项目根目录。
 * 在多 pom 工作区中（如 d:\myProject\xAI 下同时有 admin-server 和 db-gateway），
 * 只要有一个项目使用 Lombok，就需要加载 Lombok agent。
 *
 * 查找范围：
 *   1. startDir 本身
 *   2. startDir 的上级目录（最多 6 层）
 *   3. startDir 的所有直接子目录
 */
function findAllLombokProjectRoots(startDir: string): string[] {
  const roots: string[] = [];
  const seen = new Set<string>();

  const tryAdd = (dir: string) => {
    if (seen.has(dir)) return;
    if (existsSync(path.join(dir, 'pom.xml')) && pomDeclaresLombok(dir)) {
      seen.add(dir);
      roots.push(dir);
    }
  };

  // 1. 检查 startDir 本身
  tryAdd(startDir);

  // 2. 向上查找
  let dir = startDir;
  for (let i = 0; i < 6; i++) {
    tryAdd(dir);
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // 3. 扫描所有直接子目录（一层）— 覆盖多 pom 工作区场景
  try {
    const entries = readdirSync(startDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      tryAdd(path.join(startDir, entry.name));
    }
  } catch { /* ignore */ }

  return roots;
}

/**
 * 检查 pom.xml 是否声明了 lombok 依赖。
 * 只做简单文本匹配（避免完整 XML 解析的开销）。
 */
export function pomDeclaresLombok(projectRoot: string): boolean {
  const pomPath = path.join(projectRoot, 'pom.xml');
  if (!existsSync(pomPath)) return false;
  try {
    const content = readFileSync(pomPath, 'utf-8');
    // 简单匹配 — groupId + artifactId 同时出现
    return content.includes('org.projectlombok') && content.includes('lombok');
  } catch {
    return false;
  }
}

/**
 * 解析 Maven settings.xml 中的 localRepository。
 * 检查顺序：用户级 ~/.m2/settings.xml → 全局级（Maven home）/conf/settings.xml。
 * 找不到返回默认值 ~/.m2/repository。
 */
function resolveMavenLocalRepository(): string {
  const candidates = [
    path.join(homedir(), '.m2', 'settings.xml'),
  ];
  // 尝试从 M2_HOME / MAVEN_HOME 找全局 settings.xml
  const mavenHome = process.env.M2_HOME || process.env.MAVEN_HOME;
  if (mavenHome) {
    candidates.push(path.join(mavenHome, 'conf', 'settings.xml'));
  }

  for (const settingsPath of candidates) {
    if (!existsSync(settingsPath)) continue;
    try {
      const content = readFileSync(settingsPath, 'utf-8');
      const match = content.match(/<localRepository>([^<]+)<\/localRepository>/);
      if (match) {
        const repo = match[1].trim();
        if (repo && existsSync(repo)) return repo;
      }
    } catch { /* ignore */ }
  }

  return path.join(homedir(), '.m2', 'repository');
}

/**
 * 在 Maven 本地仓库中查找 lombok.jar。
 * 返回最新版本的 jar 绝对路径，找不到返回 null。
 */
function findLombokJar(localRepo: string): string | null {
  const lombokDir = path.join(localRepo, LOMBOK_REPO_PATH);
  if (!existsSync(lombokDir)) return null;

  let versionDirs: string[] = [];
  try {
    versionDirs = readdirSync(lombokDir, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name);
  } catch { return null; }

  if (versionDirs.length === 0) return null;

  // 简单按版本号字符串排序取最后一个（最新版本通常字符串最大）
  versionDirs.sort();
  // 从最新版本开始找，返回第一个存在的非 sources javadoc 的 jar
  for (let i = versionDirs.length - 1; i >= 0; i--) {
    const version = versionDirs[i];
    const versionDir = path.join(lombokDir, version);
    try {
      const jars = readdirSync(versionDir)
        .filter(name => name.endsWith('.jar'))
        // 排除 sources / javadoc jar
        .filter(name => !name.includes('-sources') && !name.includes('-javadoc'));
      if (jars.length > 0) {
        return path.join(versionDir, jars[0]);
      }
    } catch { /* skip */ }
  }
  return null;
}

/**
 * 尝试通过 mvn 命令下载 lombok 依赖。
 * @param projectRoot 包含 pom.xml 的目录
 * @returns true 如果执行成功
 */
function tryMvnDownload(projectRoot: string): boolean {
  try {
    console.log(`[LSP:java] 尝试在 ${projectRoot} 执行 mvn dependency:resolve 下载 lombok...`);
    execSync('mvn dependency:resolve -DincludeGroupIds=org.projectlombok -q', {
      cwd: projectRoot,
      stdio: 'ignore',
      timeout: 120000, // 2分钟超时
    });
    return true;
  } catch (err) {
    console.warn('[LSP:java] mvn dependency:resolve 执行失败:', err);
    return false;
  }
}

export interface LombokDetection {
  /** lombok.jar 的绝对路径，供 JDT.LS bundles 使用。 */
  jarPath: string;
  /** file:// URI 格式的路径，直接放入 initializationOptions.bundles。 */
  fileUri: string;
}

/**
 * 检测项目是否使用 Lombok，如果是，返回 lombok.jar 的路径信息。
 * 返回 null 表示项目未使用 Lombok 或找不到 jar。
 *
 * 在多 pom 工作区中（如 d:\myProject\xAI 下同时有 admin-server 和 db-gateway），
 * 会扫描所有子目录的 pom.xml，只要有一个项目使用 Lombok 就返回其 jar 路径。
 */
export function detectLombok(workspaceRoot: string): LombokDetection | null {
  // 1. 查找工作区内所有使用 Lombok 的项目根目录
  const projectRoots = findAllLombokProjectRoots(workspaceRoot);
  if (projectRoots.length === 0) return null;

  console.log(`[LSP:java] 发现 ${projectRoots.length} 个使用 Lombok 的项目: ${projectRoots.join(', ')}`);

  // 2. 解析 Maven 本地仓库位置
  const localRepo = resolveMavenLocalRepository();

  // 3. 在本地仓库中查找 lombok.jar
  let jarPath = findLombokJar(localRepo);

  // 4. 若未找到，尝试通过 mvn 自动下载（遍历所有项目根，任一成功即可）
  if (!jarPath) {
    for (const root of projectRoots) {
      const downloaded = tryMvnDownload(root);
      if (downloaded) {
        jarPath = findLombokJar(localRepo);
        if (jarPath) break;
      }
    }
  }

  if (!jarPath) {
    console.warn('[LSP:java] 项目使用 Lombok，但本地 Maven 仓库未找到 lombok.jar。' +
      `请在 ${projectRoots[0]} 运行 mvn dependency:resolve 下载依赖。本地仓库: ${localRepo}`);
    return null;
  }

  // 转为 file:// URI（Windows 路径需要正斜杠 + 额外前导斜杠）
  const normalized = jarPath.replace(/\\/g, '/');
  const fileUri = /^[A-Za-z]:/.test(normalized)
    ? `file:///${normalized}`
    : `file://${normalized}`;

  console.log(`[LSP:java] Lombok 检测成功: ${jarPath}`);
  return { jarPath, fileUri };
}
