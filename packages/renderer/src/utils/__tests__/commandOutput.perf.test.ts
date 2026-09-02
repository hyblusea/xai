/**
 * 性能验证：execute_command 实时输出 → 渲染进程 IPC → setCommandOutput 累积
 * 是否会导致主线程长时间阻塞（renderer unresponsive / render-process-gone）。
 *
 * 复刻 App.tsx 中 `processCarriageReturns` + `handleCommandOutput` 的确切逻辑，
 * 用几种真实命令输出场景测量：
 *   1) 每 chunk 处理耗时是否随累积输出线性增长（O(N²) 总开销）
 *   2) 总同步阻塞时间是否达到秒级（触发 Electron unresponsive 的量级）
 *   3) 对比「每 chunk 全量处理」vs「按 100ms 合并处理」的差异
 */
import { describe, it, expect } from 'vitest';

/* ── 精确复刻 App.tsx:79 的 processCarriageReturns ─────────────────────── */
function processCarriageReturns(text: string): string {
  const lines: string[] = [];
  for (const segment of text.split('\n')) {
    let currentLine = '';
    for (const part of segment.split('\r')) {
      if (part.length >= currentLine.length) {
        currentLine = part;
      } else {
        currentLine = part + currentLine.slice(part.length);
      }
    }
    lines.push(currentLine);
  }
  return lines.join('\n');
}

/* ── 复刻 App.tsx:724 handleCommandOutput 的单条命令累积逻辑 ───────────── */
interface CmdEntry {
  commandId: string;
  command: string;
  output: string;
  status: string;
}

/** 单条命令条目，模拟 setCommandOutput updater 对累积输出的处理。 */
function accumulateCurrent(entry: CmdEntry, chunk: string): CmdEntry {
  const combined = entry.output + chunk;
  return {
    ...entry,
    output: combined.includes('\r') ? processCarriageReturns(combined) : combined,
  };
}

/** 固定方案 A：按 100ms 合并，把多个 chunk 拼接后只处理一次。 */
function accumulateThrottled(
  entry: CmdEntry,
  pendingChunks: string[],
  chunk: string,
  flush: boolean,
): { entry: CmdEntry; pendingChunks: string[] } {
  pendingChunks.push(chunk);
  if (!flush) return { entry, pendingChunks };
  const combined = entry.output + pendingChunks.join('');
  pendingChunks.length = 0;
  return {
    entry: {
      ...entry,
      output: combined.includes('\r') ? processCarriageReturns(combined) : combined,
    },
    pendingChunks,
  };
}

/* ── 计时辅助 ─────────────────────────────────────────────────────────── */
interface PerfResult {
  scenario: string;
  totalBytes: number;
  chunkCount: number;
  totalMs: number;
  maxChunkMs: number;
  avgChunkMs: number;
}

function measure(
  scenario: string,
  chunks: string[],
  accumulate: (entry: CmdEntry, chunk: string) => CmdEntry,
): PerfResult {
  let entry: CmdEntry = { commandId: 'cmd_1', command: 'test', output: '', status: 'running' };
  let maxChunkMs = 0;
  const start = performance.now();
  for (const chunk of chunks) {
    const t0 = performance.now();
    entry = accumulate(entry, chunk);
    maxChunkMs = Math.max(maxChunkMs, performance.now() - t0);
  }
  const totalMs = performance.now() - start;
  return {
    scenario,
    totalBytes: entry.output.length,
    chunkCount: chunks.length,
    totalMs,
    maxChunkMs,
    avgChunkMs: totalMs / chunks.length,
  };
}

function measureThrottled(scenario: string, chunks: string[]): PerfResult {
  let entry: CmdEntry = { commandId: 'cmd_1', command: 'test', output: '', status: 'running' };
  const pending: string[] = [];
  let maxChunkMs = 0;
  const start = performance.now();
  // 模拟每 100ms 合并一次的累积（每 100 个 chunk flush 一次，等价于 100ms 窗口）
  const flushEvery = 100;
  for (let i = 0; i < chunks.length; i++) {
    const t0 = performance.now();
    const flush = (i + 1) % flushEvery === 0 || i === chunks.length - 1;
    const r = accumulateThrottled(entry, pending, chunks[i], flush);
    entry = r.entry;
    maxChunkMs = Math.max(maxChunkMs, performance.now() - t0);
  }
  const totalMs = performance.now() - start;
  return {
    scenario,
    totalBytes: entry.output.length,
    chunkCount: chunks.length,
    totalMs,
    maxChunkMs,
    avgChunkMs: totalMs / chunks.length,
  };
}

/* ── 模拟命令输出 chunk 生成器 ────────────────────────────────────────── */
function makeChunks(totalBytes: number, chunkSize: number, withCarriageReturn: boolean): string[] {
  const chunks: string[] = [];
  let remaining = totalBytes;
  let line = 0;
  while (remaining > 0) {
    const size = Math.min(chunkSize, remaining);
    let content = `line ${line} - ${'x'.repeat(Math.max(0, size - 20))}`.slice(0, size);
    if (withCarriageReturn && line % 5 === 0) {
      // 模拟进度条：整行用 \r 覆盖刷新
      content = `\rProgress: ${line}/${Math.ceil(totalBytes / chunkSize)} ${'='.repeat(line % 20)}`;
      content = content.slice(0, size);
    }
    chunks.push(content);
    remaining -= size;
    line++;
  }
  return chunks;
}

function printTable(results: (PerfResult & { kind: string })[]): void {
  console.log('\n' + '='.repeat(110));
  console.log('命令输出 → 渲染进程主线程阻塞 性能验证');
  console.log('='.repeat(110));
  for (const r of results) {
    const risk = r.maxChunkMs > 500
      ? '⚠️  单 chunk 阻塞 >500ms，极易触发 unresponsive'
      : r.totalMs > 1000
        ? '⚠️  总阻塞 >1s，可能触发 unresponsive'
        : '✅ 可接受';
    console.log('');
    console.log(`【${r.scenario}】(${r.kind})`);
    console.log(`  输出总量: ${(r.totalBytes / 1024).toFixed(1)} KB | chunk 数: ${r.chunkCount}`);
    console.log(`  总处理时间: ${r.totalMs.toFixed(1)} ms | 平均/chunk: ${r.avgChunkMs.toFixed(3)} ms | 最大单 chunk: ${r.maxChunkMs.toFixed(1)} ms`);
    console.log(`  风险评估: ${risk}`);
  }
  console.log('='.repeat(110));
}

describe('execute_command 输出累积性能（验证 renderer unresponsive 根因）', () => {
  it('测量当前逐 chunk 全量处理逻辑的阻塞时间', () => {
    // 场景 1：普通构建日志，1MB，1000 个 chunk，无 \r
    const chunksPlain = makeChunks(1_000_000, 1024, false);
    // 场景 2：进度条式输出，500KB，500 个 chunk，含大量 \r（最坏情况）
    const chunksProgress = makeChunks(500_000, 1024, true);
    // 场景 3：高频小 chunk，200KB，4000 个 chunk（npm 类输出）
    const chunksSmall = makeChunks(200_000, 50, false);

    const r1 = measure('场景1-普通构建日志(1MB/1000块/无\\r)', chunksPlain, accumulateCurrent);
    const r2 = measure('场景2-进度条输出(500KB/500块/含\\r)', chunksProgress, accumulateCurrent);
    const r3 = measure('场景3-高频小chunk(200KB/4000块)', chunksSmall, accumulateCurrent);

    printTable([
      { ...r1, kind: '当前逻辑' },
      { ...r2, kind: '当前逻辑' },
      { ...r3, kind: '当前逻辑' },
    ]);

    // 关键断言：验证 O(N²) 量级 —— 输出越大，单 chunk 处理时间越长
    // （每 chunk 都对全量累积输出做 includes('\r') 全量扫描）
    // 注意：CI 机器可能更快，这里用相对保守的阈值
    expect(r1.totalMs).toBeGreaterThan(100);
    // 单 chunk 处理时间应随累积输出增长：场景3(输出总量小)的平均
    // 应显著低于场景1(输出总量大)
    expect(r3.avgChunkMs).toBeLessThan(r1.avgChunkMs);
    });

  it('对比：100ms 合并处理后阻塞时间大幅下降', () => {
    const chunksPlain = makeChunks(1_000_000, 1024, false);
    const chunksProgress = makeChunks(500_000, 1024, true);

    const cur1 = measure('场景1-普通构建日志(1MB/1000块)', chunksPlain, accumulateCurrent);
    const fix1 = measureThrottled('场景1-普通构建日志(1MB/1000块)', chunksPlain);
    const cur2 = measure('场景2-进度条输出(500KB/含\\r)', chunksProgress, accumulateCurrent);
    const fix2 = measureThrottled('场景2-进度条输出(500KB/含\\r)', chunksProgress);

    printTable([
      { ...cur1, kind: '当前逻辑' },
      { ...fix1, kind: '100ms合并' },
      { ...cur2, kind: '当前逻辑' },
      { ...fix2, kind: '100ms合并' },
    ]);

    // 优化后应显著低于优化前
    expect(fix1.totalMs).toBeLessThan(cur1.totalMs);
    expect(fix2.totalMs).toBeLessThan(cur2.totalMs);
    // 优化后单 chunk 不应有长阻塞
    expect(fix1.maxChunkMs).toBeLessThan(50);
    expect(fix2.maxChunkMs).toBeLessThan(50);
  });
});