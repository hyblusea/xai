import { describe, it, expect } from 'vitest';
import { TerminalSessionManager } from './session-manager.js';

const isWindows = process.platform === 'win32';

const ANSI_REGEX =
  /\x1B(?:\][\s\S]*?(?:\x07|\x1B\\)|\[[0-?]*[ -/]*[@-~]|[@-Z\\-_])/g;

/**
 * Regression tests for the per-shell line terminator fix.
 *
 * doSend() used to append '\r\n' to every command. ConPTY delivers CR and LF
 * as separate key events: the CR submits the command, and the leftover LF is
 * read at the NEXT prompt where PSReadLine maps a lone LF to "insert line
 * feed" (Shift+Enter) — leaving the session stuck on the '>>' continuation
 * prompt and leaking stray '>>' rows into the echo area. See lineTerminator()
 * in session-manager.ts.
 */
describe.skipIf(!isWindows)('line terminator (stray continuation prompt)', () => {
  it(
    'powershell: no ">>" continuation prompt leaks between commands',
    async () => {
      const raw: string[] = [];
      const mgr = new TerminalSessionManager(process.cwd(), 10 * 60 * 1000, {
        onSessionData: (_id, data) => raw.push(data),
      });
      try {
        const { sessionId } = await mgr.spawn({ shell: 'powershell' });

        const r1 = await mgr.send(sessionId, 'echo first_ok');
        expect(r1.status).toBe('completed');
        expect(r1.output).toContain('first_ok');

        // The stray-LF artifact (if it existed) would surface after the fresh
        // prompt following r1, before/around r2's echo.
        const r2 = await mgr.send(
          sessionId,
          'echo second_ok; echo "quoted value"',
        );
        expect(r2.status).toBe('completed');
        expect(r2.output).toContain('second_ok');

        // Wait past the point where a leftover LF would have been consumed
        // and rendered, then scan the whole raw stream.
        await new Promise((r) => setTimeout(r, 1500));
        const text = raw.join('').replace(ANSI_REGEX, '');
        expect(text).not.toContain('>>');
      } finally {
        await mgr.dispose();
      }
    },
    60_000,
  );

  it(
    'cmd: commands complete with clean output',
    async () => {
      const mgr = new TerminalSessionManager(process.cwd(), 10 * 60 * 1000);
      try {
        const { sessionId } = await mgr.spawn({ shell: 'cmd' });
        const r1 = await mgr.send(sessionId, 'echo first_ok');
        expect(r1.status).toBe('completed');
        expect(r1.output).toContain('first_ok');
        const r2 = await mgr.send(sessionId, 'echo second_ok');
        expect(r2.status).toBe('completed');
        expect(r2.output).toContain('second_ok');
      } finally {
        await mgr.dispose();
      }
    },
    60_000,
  );
});
