import { describe, it, expect } from 'vitest';
import path from 'path';
import fs from 'fs';
import { TerminalSessionManager, type ShellType } from './session-manager.js';

const isWindows = process.platform === 'win32';

// Resolve webapp-test dir relative to project root (not __dirname which varies
// depending on whether vitest runs from source or compiled output).
function findWebappTestDir(): string {
  const candidates = [
    path.resolve(process.cwd(), 'webapp-test/app'),
    path.resolve(process.cwd(), '../../webapp-test/app'),
    path.resolve(process.cwd(), '../../../webapp-test/app'),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
  }
  return candidates[0]; // fallback
}

const WEBAPP_TEST_DIR = findWebappTestDir();

/**
 * Real-world integration tests that exercise terminal_send with actual
 * development tools (pnpm, vite, etc.) — not just simple echo commands.
 *
 * These tests validate the full pipeline:
 *   PTY spawn → command echo → marker detection → cleanOutput → result
 *
 * They catch issues that unit tests (with mocked managers) cannot:
 *   - Command echo wrapping on narrow terminals
 *   - ANSI escape sequences in real tool output
 *   - Marker-in-echo false detection (the "dual marker" fix)
 *   - Long-running background commands
 */
describe('Terminal Real-World Scenarios', () => {
  const defaultShell: ShellType = isWindows ? 'cmd' : 'bash';

  async function withManager(
    fn: (manager: TerminalSessionManager) => Promise<void>,
    cwd: string = process.cwd(),
  ) {
    const manager = new TerminalSessionManager(cwd, 60_000);
    try {
      await fn(manager);
    } finally {
      manager.dispose();
    }
  }

  // ── Long command echo wrapping ─────────────────────────────────────────

  describe('long command echo handling', () => {
    it('should capture output from dir with long path (cmd echo wrapping)', async () => {
      await withManager(async (manager) => {
        const { sessionId } = await manager.spawn({ shell: defaultShell, cwd: WEBAPP_TEST_DIR });

        // This command is long enough that prompt + command + marker suffix
        // may exceed 120 columns, triggering cmd.exe backtick wrapping.
        const output = await manager.send(
          sessionId,
          'dir node_modules\\.bin\\vite.cmd',
          { timeout: 15_000 },
        );

        // The output should NOT be empty — the dir command always produces output
        expect(output.output).toBeTruthy();
        expect(output.output).not.toContain('no output');
        expect(output.status).toBe('completed');

        // Should contain file listing content
        if (isWindows) {
          // dir output contains the filename
          expect(output.output.toLowerCase()).toContain('vite');
        }
      });
    }, 30_000);

    it('should handle cd then command in same session', async () => {
      await withManager(async (manager) => {
        const { sessionId } = await manager.spawn({ shell: defaultShell });

        // First: change directory
        const cdOutput = await manager.send(sessionId, `cd ${WEBAPP_TEST_DIR}`, { timeout: 10_000 });
        console.log('[cd] status:', cdOutput.status, 'output:', JSON.stringify(cdOutput.output).slice(0, 200));
        expect(cdOutput.status).toBe('completed');

        // Second: run a command that produces output
        const dirOutput = await manager.send(sessionId, 'dir package.json', { timeout: 10_000 });
        console.log('[dir] status:', dirOutput.status, 'output:', JSON.stringify(dirOutput.output).slice(0, 500));
        expect(dirOutput.status).toBe('completed');
        expect(dirOutput.output).toBeTruthy();
        expect(dirOutput.output.toLowerCase()).toContain('package.json');
      });
    }, 30_000);
  });

  // ── Dev server startup detection ───────────────────────────────────────

  describe('dev server startup (pnpm dev)', () => {
    it('should detect vite dev server startup output', async () => {
      await withManager(async (manager) => {
        const { sessionId } = await manager.spawn({
          shell: defaultShell,
          cwd: WEBAPP_TEST_DIR,
        });

        // Start pnpm dev in background mode — it's a long-running process
        const bgResult = await manager.send(sessionId, 'pnpm dev', {
          background: true,
          timeout: 15_000,
        });
        expect(bgResult.status).toBe('background');

        // Poll for the vite startup output (up to 30s)
        let viteStarted = false;
        let lastOutput = '';
        const maxAttempts = 15;
        for (let i = 0; i < maxAttempts; i++) {
          await new Promise((r) => setTimeout(r, 2_000));
          const poll = await manager.poll(sessionId);
          lastOutput = poll.output;

          // Vite prints "ready in" or "Local:" when the server starts
          if (lastOutput.includes('ready in') || lastOutput.includes('Local:') || lastOutput.includes('VITE')) {
            viteStarted = true;
            break;
          }
        }

        expect(viteStarted).toBe(true);
        expect(lastOutput).toContain('ready in');
        expect(lastOutput).toContain('Local:');
        expect(lastOutput).toContain('http://localhost:');

        // Clean up: kill the dev server
        if (isWindows) {
          await manager.send(sessionId, 'Ctrl+C', { interactive: true, timeout: 5_000 });
        } else {
          await manager.send(sessionId, 'Ctrl+C', { interactive: true, timeout: 5_000 });
        }
      });
    }, 60_000);

    it('should return still_running with captured output for long-running command (non-background)', async () => {
      await withManager(async (manager) => {
        const { sessionId } = await manager.spawn({
          shell: defaultShell,
          cwd: WEBAPP_TEST_DIR,
        });

        // Send pnpm dev WITHOUT background — should timeout and return still_running
        // With the dual-marker fix, the output should contain what the server printed
        // during the timeout period, NOT "no output".
        const result = await manager.send(sessionId, 'pnpm dev', {
          timeout: 10_000,
        });

        // Should be still_running since pnpm dev never exits
        expect(result.status).toBe('still_running');

        // Key assertion: output should NOT be empty or "no output"
        // The vite dev server should have printed something by now
        expect(result.output).toBeTruthy();
        expect(result.output).not.toBe('(no output yet)');

        // Clean up
        await manager.send(sessionId, 'Ctrl+C', { interactive: true, timeout: 5_000 });
      });
    }, 30_000);
  });

  // ── Multi-line output with ANSI codes ──────────────────────────────────

  describe('ANSI and multi-line output', () => {
    it('should capture pnpm list output (contains ANSI + tree structure)', async () => {
      await withManager(async (manager) => {
        const { sessionId } = await manager.spawn({
          shell: defaultShell,
          cwd: WEBAPP_TEST_DIR,
        });

        const output = await manager.send(sessionId, 'pnpm list', { timeout: 15_000 });

        expect(output.status).toBe('completed');
        expect(output.output).toBeTruthy();
        // pnpm list shows dependency tree with package names
        expect(output.output).toContain('parent-app');
        // Should have stripped ANSI codes
        expect(output.output).not.toContain('\x1B');
      });
    }, 30_000);
  });

  // ── waitUntilComplete for long-running command ─────────────────────────

  describe('waitUntilComplete', () => {
    it('should return accumulated output when timeout reached', async () => {
      await withManager(async (manager) => {
        const { sessionId } = await manager.spawn({
          shell: defaultShell,
          cwd: WEBAPP_TEST_DIR,
        });

        // Start pnpm dev in background
        await manager.send(sessionId, 'pnpm dev', { background: true });

        // Wait for completion with a short timeout — will return still_running
        const result = await manager.waitUntilComplete(sessionId, {
          timeout: 8_000,
        });

        // Should have captured some output even though command didn't complete
        expect(result.output).toBeTruthy();
        expect(result.output).not.toBe('(no output yet, command still running)');

        // Clean up
        await manager.send(sessionId, 'Ctrl+C', { interactive: true, timeout: 5_000 });
      });
    }, 30_000);
  });
});
