#!/usr/bin/env node
/**
 * electron-builder wrapper —— 仅供 macOS 构建使用（dist:mac-x64 / dist:mac-arm64）。
 *
 * ⚠️ Windows 构建继续直接使用 electron-builder（`dist` / `pack` 脚本），不要改。
 *
 * 【为什么要包一层】
 * electron-builder 26.8.1 的 NodeModulesCollector 依赖 `pnpm list --prod --json` 的输出，
 * 但 pnpm 11 在 monorepo 中返回的是"全部 workspace 项目"的合并数组，而 collector 的
 * parseDependenciesTree() 固定取 dependencyTree[0] —— 也就是**根项目**（xai-ide）的
 * 依赖树，而不是当前 app（@xai/electron）的依赖树；且该输出跨项目去重后不含
 * @lydell/node-pty 的 darwin 平台二进制包。
 *
 * 后果：mac 打包时 node_modules 只收集到根 package.json 的 3 个依赖
 * （node-sql-parser/@types/pegjs/big-integer），@lydell/node-pty、undici、mqtt 等
 * 全部缺失，应用启动即报：
 *   Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@lydell/node-pty'
 *
 * 已知官方 issue（未修复）：
 *   https://github.com/electron-userland/electron-builder/issues/10000
 *   "pnpm 11 workspace: collector drops dependencies due to cross-project
 *    deduped pnpm list output"
 *
 * 【本包装器做什么】
 * 1. 在启动 electron-builder 前，把 PnpmNodeModulesCollector.getNodeModules 短路为
 *    "返回空结果"。electron-builder 收集依赖时的官方回退链是
 *    [pnpm] → [traversal]（对每个候选目录依次尝试，空结果自动换下一个），
 *    因此会自动落到 TraversalNodeModulesCollector —— 它直接遍历磁盘上的
 *    node_modules（含符号链接目标），能拿到完整依赖（含 @lydell/node-pty 的
 *    darwin-x64 / darwin-arm64 平台二进制包）。
 * 2. 构建完成后自动校验产物 app.asar：
 *    - node_modules 数量达到合理规模；
 *    - @lydell/node-pty 存在（asar 内或 app.asar.unpacked 内）；
 *    - 对应架构的 @lydell/node-pty-darwin-<arch> 存在；
 *    - darwin 平台二进制 pty.node 已被 asarUnpack 落到 app.asar.unpacked。
 *    校验失败则构建失败（非零退出），绝不静默产出坏包。
 *
 * 上游修复后可直接删除本包装器，并把 package.json 中两个 mac 脚本改回直接调用
 * electron-builder。
 */

'use strict';

const path = require('path');
const fs = require('fs');
const { createRequire } = require('module');
const { spawnSync } = require('child_process');

const TAG = '[electron-builder-mac] ';

function fail(message) {
  console.error(TAG + message);
  process.exit(1);
}

/** 是否被直接执行（node scripts/electron-builder-mac.cjs ...） */
function isMainModule() {
  try {
    return require.main === module;
  } catch {
    return true;
  }
}

/** 解析 electron-builder 的 package.json 路径（与 packages/electron 安装的同一份） */
function resolveElectronBuilderPkgPath() {
  try {
    // 本脚本位于 packages/electron/scripts/，从包目录开始解析
    return require.resolve('electron-builder/package.json', { paths: [path.resolve(__dirname, '..')] });
  } catch (err) {
    return fail('未找到 electron-builder，请先执行 pnpm install。' + err.message);
  }
}

/**
 * 禁用基于 `pnpm list` 的依赖收集器（electron-builder#10000）。
 * 返回空结果后，electron-builder 会按官方回退链自动改用
 * TraversalNodeModulesCollector（物理遍历 node_modules，结果最完整）。
 */
function disablePnpmNodeModulesCollector() {
  const ebPkgPath = resolveElectronBuilderPkgPath();
  const ebRequire = createRequire(ebPkgPath);

  let PnpmNodeModulesCollector;
  try {
    ({ PnpmNodeModulesCollector } = ebRequire('app-builder-lib/out/node-module-collector/pnpmNodeModulesCollector.js'));
  } catch (err) {
    fail('无法加载 app-builder-lib 的 PnpmNodeModulesCollector：' + err.message);
  }

  if (
    !PnpmNodeModulesCollector ||
    typeof PnpmNodeModulesCollector.prototype.getNodeModules !== 'function'
  ) {
    fail(
      'app-builder-lib 内部结构已变化（PnpmNodeModulesCollector.getNodeModules 不存在）。' +
        '请检查 electron-builder 新版本是否已修复 issue #10000：若已修复，可移除本包装器；' +
        '否则需要更新补丁逻辑。'
    );
  }

  PnpmNodeModulesCollector.prototype.getNodeModules = async function disabledGetNodeModules() {
    console.warn(
      TAG + '已跳过 `pnpm list` 依赖收集（规避 electron-builder#10000 的 pnpm11 workspace bug），' +
        '将回退到磁盘遍历（traversal）方式收集依赖'
    );
    return { nodeModules: [], logSummary: this.cache.logSummary };
  };

  console.log(TAG + '已禁用 pnpm list 收集器（electron-builder#10000 workaround），依赖改由 traversal 收集');
  return ebPkgPath;
}

/* ============================================================================
 * 产物校验
 * ==========================================================================*/

/** 读取 asar 归档的文件树（header） */
function readAsarHeader(asarPath) {
  const fd = fs.openSync(asarPath, 'r');
  try {
    const sizeBuf = Buffer.alloc(8);
    fs.readSync(fd, sizeBuf, 0, 8, 0);
    const headerSize = sizeBuf.readUInt32LE(4);
    const headerBuf = Buffer.alloc(headerSize);
    fs.readSync(fd, headerBuf, 0, headerSize, 8);
    const jsonLen = headerBuf.readUInt32LE(4);
    return JSON.parse(headerBuf.slice(8, 8 + jsonLen).toString('utf8'));
  } finally {
    fs.closeSync(fd);
  }
}

/** 在 asar header 树中按路径查找（路径段数组），返回条目或 undefined */
function findInHeader(header, segments) {
  let node = { files: header.files };
  for (const seg of segments) {
    if (!node || !node.files || !node.files[seg]) return undefined;
    node = node.files[seg];
  }
  return node;
}

/** 统计 asar 内 node_modules 顶层包数量 */
function countNodeModulesPackages(header) {
  const nm = header.files && header.files.node_modules;
  if (!nm || !nm.files) return 0;
  let count = 0;
  for (const entry of Object.values(nm.files)) {
    if (entry.files) {
      if (entry.name && entry.name.startsWith('@')) count += Object.keys(entry.files).length;
      else count += 1;
    }
  }
  return count;
}

/** 递归列出目录（相对路径），用于检查 app.asar.unpacked 内容 */
function listDirRecursive(base, rel = '', out = []) {
  const abs = path.join(base, rel);
  let entries;
  try {
    entries = fs.readdirSync(abs, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const relPath = rel ? rel + '/' + e.name : e.name;
    if (e.isDirectory()) listDirRecursive(base, relPath, out);
    else out.push(relPath);
  }
  return out;
}

/**
 * 校验 mac 打包产物。
 * @returns {{ ok: boolean, problems: string[], asarPath: string }}
 */
function verifyMacAsar({ releaseDir, productName, arch }) {
  const problems = [];
  const appDirNames = arch === 'arm64' ? ['mac-arm64', 'mac'] : ['mac', 'mac-arm64'];

  let asarPath = null;
  for (const dirName of appDirNames) {
    const candidate = path.join(releaseDir, dirName, productName + '.app', 'Contents', 'Resources', 'app.asar');
    if (fs.existsSync(candidate)) {
      asarPath = candidate;
      break;
    }
  }
  if (!asarPath) {
    return {
      ok: false,
      asarPath: '',
      problems: [
        `未找到打包产物 app.asar（已尝试 ${appDirNames.map(d => path.join(releaseDir, d)).join(' 和 ')}）。` +
          '请确认构建输出目录未被自定义。',
      ],
    };
  }

  const resourcesDir = path.dirname(asarPath);
  const unpackedDir = path.join(resourcesDir, 'app.asar.unpacked');
  const header = readAsarHeader(asarPath);

  // 1) node_modules 规模合理（防止又只收集了根包的 3 个依赖）
  const pkgCount = countNodeModulesPackages(header);
  if (pkgCount < 50) {
    problems.push(
      `app.asar 内 node_modules 仅有 ${pkgCount} 个包（应 >50）。依赖收集失败，` +
        'node_modules/@lydell/node-pty 等将缺失，应用会报 ERR_MODULE_NOT_FOUND。'
    );
  }

  // 2) @lydell/node-pty 主包存在（asar 内或 unpacked 内）
  const ptySegments = ['node_modules', '@lydell', 'node-pty', 'package.json'];
  const ptyInAsar = !!findInHeader(header, ptySegments);
  const ptyUnpacked = fs.existsSync(path.join(unpackedDir, ...ptySegments));
  if (!ptyInAsar && !ptyUnpacked) {
    problems.push("@lydell/node-pty 未打进包（asar 与 app.asar.unpacked 中都不存在），启动必现 ERR_MODULE_NOT_FOUND。");
  }

  // 3) 对应架构的平台二进制包存在
  const platformPkgs = arch ? ['node-pty-' + (arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64')] : ['node-pty-darwin-x64', 'node-pty-darwin-arm64'];
  const unpackedFiles = fs.existsSync(unpackedDir) ? listDirRecursive(unpackedDir) : [];
  for (const platformPkg of platformPkgs) {
    const pkgSegs = ['node_modules', '@lydell', platformPkg, 'package.json'];
    const inAsar = !!findInHeader(header, pkgSegs);
    const onDisk = unpackedFiles.includes(pkgSegs.join('/'));
    if (!inAsar && !onDisk) {
      problems.push(
        `@lydell/node-pty/${platformPkg} 缺失（asar 与 app.asar.unpacked 中都不存在）。` +
          '请确认 pnpm 安装时包含 darwin 平台二进制（pnpm-workspace.yaml 的 supportedArchitectures）。'
      );
    }
  }

  // 4) undici 必须存在（Node.js 内置 fetch 依赖 undici 的 global dispatcher；
  //    proxy-manager.ts 动态 import('undici') 设置代理；缺失则代理失效且可能影响 fetch）
  const undiciSegments = ['node_modules', 'undici', 'package.json'];
  const undiciInAsar = !!findInHeader(header, undiciSegments);
  const undiciUnpacked = fs.existsSync(path.join(unpackedDir, ...undiciSegments));
  if (!undiciInAsar && !undiciUnpacked) {
    problems.push(
      'undici 未打进包（asar 与 app.asar.unpacked 中都不存在）。' +
        'proxy-manager.ts 的 import("undici") 会失败，fetch 代理设置不生效。' +
        '请确认 undici 在 dependencies 中且未被 pnpm 收集器遗漏。'
    );
  }

  // 5) darwin 原生二进制 pty.node 必须已解包到磁盘（asar 内无法 dlopen）
  for (const platformPkg of platformPkgs) {
    const nodeArch = platformPkg.replace('node-pty-darwin-', 'darwin-');
    const ptyNodeRel = `node_modules/@lydell/${platformPkg}/prebuilds/${nodeArch}/pty.node`;
    if (!fs.existsSync(path.join(unpackedDir, ...ptyNodeRel.split('/')))) {
      // 如果 asar 里根本没有这个包（例如 arm64 构建不含 x64 包），跳过该提示
      const inAsar = !!findInHeader(header, ptyNodeRel.split('/').slice(0, -1));
      if (inAsar || platformPkgs.length === 1) {
        problems.push(
          `原生二进制 ${ptyNodeRel} 未被 asarUnpack 解包到 app.asar.unpacked，` +
            'mac 上无法 dlopen，启动时 pty 加载会失败。'
        );
      }
    }
  }

  return { ok: problems.length === 0, problems, asarPath };
}

/* ============================================================================
 * 主流程
 * ==========================================================================*/

function main() {
  const argv = process.argv.slice(2);
  if (!argv.includes('--mac')) {
    fail('本包装器仅用于 macOS 构建（参数需包含 --mac）。Windows 构建请直接使用 electron-builder。');
  }
  const arch = argv.includes('--arm64') ? 'arm64' : argv.includes('--x64') ? 'x64' : undefined;

  // 子进程运行真正的 electron-builder CLI，并通过 --require 把补丁注入子进程
  // （electron-builder CLI 会 process.exit，同进程 require 会导致后续产物校验无法执行）
  const ebPkgPath = resolveElectronBuilderPkgPath();
  const cliPath = path.join(path.dirname(ebPkgPath), 'cli.js');
  const childEnv = { ...process.env, EB_MAC_WRAPPER_PRELOAD: '1' };
  const result = spawnSync(process.execPath, ['--require', __filename, cliPath, ...argv], {
    stdio: 'inherit',
    env: childEnv,
  });
  if (result.error) fail('启动 electron-builder 失败：' + result.error.message);
  if (result.status !== 0) {
    console.error(TAG + 'electron-builder 退出码 ' + result.status + '，构建失败');
    process.exit(result.status == null ? 1 : result.status);
  }

  // ---- 产物校验 ----
  const releaseDir = path.resolve(process.cwd(), '..', '..', 'release');
  let productName = 'XAI IDE';
  try {
    const appPkg = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf8'));
    productName = (appPkg.build && appPkg.build.productName) || appPkg.productName || productName;
  } catch {
    /* 使用默认值 */
  }

  console.log(TAG + '开始校验 mac 打包产物…');
  const verdict = verifyMacAsar({ releaseDir, productName, arch });
  if (!verdict.ok) {
    console.error(TAG + '产物校验失败（' + verdict.asarPath + '）：');
    for (const p of verdict.problems) console.error('  ✗ ' + p);
    process.exit(1);
  }
  console.log(TAG + '产物校验通过：' + verdict.asarPath);
}

if (process.env.EB_MAC_WRAPPER_PRELOAD === '1') {
  // 被 --require 预加载进 electron-builder 子进程：立即应用补丁
  disablePnpmNodeModulesCollector();
} else if (isMainModule()) {
  main();
}

module.exports = {
  disablePnpmNodeModulesCollector,
  verifyMacAsar,
  readAsarHeader,
  findInHeader,
  countNodeModulesPackages,
};
