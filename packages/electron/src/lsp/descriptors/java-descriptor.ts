/**
 * Java language server descriptor.
 *
 * Launches Eclipse JDT.LS (Java Development Tools Language Server) via the
 * Eclipse Equinox launcher. JDT.LS requires a JDK 17+ to run.
 *
 * Each workspace gets its own data directory to avoid JDT.LS workspace
 * collisions (JDT.LS locks its workspace data dir and refuses concurrent use).
 */
import { app } from 'electron';
import { existsSync, mkdirSync } from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import type { LanguageServerDescriptor, PrepareContext, PreparedServer } from '../descriptor.js';
import { detectJdk, type JdkInfo } from './jdk-detector.js';
import { ensureJdtlsInstalled, type JdtlsInstall } from './jdtls-downloader.js';
import { detectLombok, findProjectRoot, pomDeclaresLombok } from './lombok-detector.js';

/** Cache the detected JDK so we don't re-run `java -version` on every launch. */
let cachedJdk: JdkInfo | null | undefined = undefined;

/** Get the JDT.LS workspace data directory for a given project. */
function getWorkspaceDataDir(workspaceRoot: string): string {
  // Hash the workspace path to get a stable, short directory name.
  // JDT.LS requires a unique data dir per project — otherwise it complains
  // about locked workspaces and fails to start.
  const hash = createHash('sha256').update(workspaceRoot).digest('hex').substring(0, 12);
  const dir = path.join(app.getPath('userData'), 'jdtls-workspace', hash);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

/** Detect JDK once, cache the result. */
function getCachedJdk(): JdkInfo | null {
  if (cachedJdk === undefined) {
    cachedJdk = detectJdk();
  }
  return cachedJdk;
}

export const javaDescriptor: LanguageServerDescriptor = {
  language: 'java',

  async prepare(ctx: PrepareContext): Promise<PreparedServer> {
    // 1. Detect JDK
    const jdk = getCachedJdk();
    if (!jdk) {
      throw new Error(
        '[LSP:java] 未检测到 JDK 17+。请安装 JDK 17 或更高版本，并设置 JAVA_HOME 环境变量或将其加入 PATH。'
      );
    }

    // 2. Ensure JDT.LS is installed (downloads on first use)
    ctx.onProgress('正在准备 JDT.LS...', 0);
    const install: JdtlsInstall = await ensureJdtlsInstalled((p) => {
      ctx.onProgress(p.message, p.percent);
    });

    // 3. Prepare workspace data dir
    const dataDir = getWorkspaceDataDir(ctx.workspaceRoot);

    // 4. Build the JDT.LS launch command.
    // The standard launch sequence (see vscode-java / jdtls documentation):
    //   java \
    //     -Declipse.application=org.eclipse.jdt.ls.core.id1 \
    //     -Dosgi.bundles.defaultStartLevel=4 \
    //     -Declipse.product=org.eclipse.jdt.ls.core.product \
    //     -Dlog.level=ALL \
    //     -Xmx1G \
    //     --add-modules=ALL-SYSTEM \
    //     -jar <launcher.jar> \
    //     -configuration <config_dir> \
    //     -data <workspace_data_dir>
    // 检测 Lombok（必须在构建 args 之前 — -javaagent 是 JVM 参数，需要放在 -jar 前）
    // Lombok 需要两种加载方式配合才能正常工作：
    //   1. -javaagent:<lombok.jar>  — JVM 启动参数（核心），Lombok 通过 Java agent 机制
    //      hook 到 JDT 编译器，在类加载时注入 getter/setter 等方法。仅通过 bundles
    //      传递不够，会导致 "The method getLimit() is undefined" 误报。
    //   2. initializationOptions.bundles — 将 lombok.jar 作为 OSGi bundle 注册（补充）。
    const lombok = detectLombok(ctx.workspaceRoot);
    const initOptions: Record<string, unknown> = {};
    if (lombok) {
      initOptions.bundles = [lombok.fileUri];
      console.log(`[LSP:java] 已添加 Lombok javaagent: ${lombok.jarPath}`);
    } else {
      // 检查项目是否使用了 Lombok（即使没找到 jar）
      const projectRoot = findProjectRoot(ctx.workspaceRoot);
      if (projectRoot && pomDeclaresLombok(projectRoot)) {
        console.warn(`[LSP:java] 项目使用 Lombok，但未找到 lombok.jar。请在 ${projectRoot} 执行 mvn dependency:resolve 下载依赖。`);
      }
    }

    const args = [
      '-Declipse.application=org.eclipse.jdt.ls.core.id1',
      '-Dosgi.bundles.defaultStartLevel=4',
      '-Declipse.product=org.eclipse.jdt.ls.core.product',
      '-Dlog.level=ALL',
      '-Xmx1G',
      // Allow access to all system modules (JDT.LS uses internal JDK APIs)
      '--add-modules=ALL-SYSTEM',
      // Disable the Java SecurityManager — JDT.LS doesn't work with it
      '-Djava.security.manager=allow',
      // Lombok javaagent — 必须在 -jar 之前（JVM 参数位置）。
      // 通过 Java agent 机制 hook JDT 编译器，识别 @Data/@Getter 等注解生成的方法。
      ...(lombok ? [`-javaagent:${lombok.jarPath}`] : []),
      `-jar`, install.launcherJar,
      `-configuration`, install.configDir,
      `-data`, dataDir,
    ];

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      // JDT.LS reads JAVA_HOME for some operations (e.g. compiler compliance)
      JAVA_HOME: jdk.javaHome,
      // Remove ELECTRON_RUN_AS_NODE — JDT.LS spawns java, not node
      ELECTRON_RUN_AS_NODE: undefined as unknown as string,
    };

    return {
      command: jdk.javaPath,
      args,
      env,
      cwd: ctx.workspaceRoot,
      initOptions,
      cleanup: () => {
        // Note: we deliberately do NOT delete the workspace data dir on stop.
        // JDT.LS caches project indexes there; deleting would force a full
        // re-index on next launch (slow). The dir persists across sessions.
      },
    };
  },
};
