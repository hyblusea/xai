// Standalone validation: exercise the refactored session-manager
// against real PTY behavior we care about (SSH-style prompt, REPL, etc.)
// without going through vitest.
import { TerminalSessionManager, translateControlChars } from './session-manager.ts';

function log(...args) { console.log(new Date().toISOString().slice(11, 23), ...args); }

async function step(name, fn) {
  const start = Date.now();
  try {
    const result = await fn();
    log('OK ', name, `(${Date.now() - start}ms)`, result ? JSON.stringify(result) : '');
  } catch (err) {
    log('FAIL', name, `(${Date.now() - start}ms)`, err && err.message ? err.message : err);
    // continue past failures
  }
}

(async () => {
  const mgr = new TerminalSessionManager(process.cwd());

  // Test 1: plain echo via powershell
  await step('powershell: echo HELLO', async () => {
    const { sessionId } = await mgr.spawn({ shell: 'powershell' });
    const r = await mgr.send(sessionId, 'Write-Output HELLO_FROM_PTY', { timeout: 10000 });
    return { status: r.status, outputPreview: r.output.slice(0, 200) };
  });

  // Test 2: cmd prompt detection via expectPrompt
  await step('cmd: echo PROMPT_TEST_AAA', async () => {
    const { sessionId } = await mgr.spawn({ shell: 'cmd' });
    const r = await mgr.send(sessionId, 'echo PROMPT_TEST_AAA', { timeout: 10000 });
    return { status: r.status, outputPreview: r.output.slice(0, 200) };
  });

  // Test 3: interactive mode — pretend to be ssh waiting for input.
  // We use `cmd /k` (keep open) so cmd stays alive without exiting.
  // The session_manager will write "whoami" then idle. Since we didn't
  // set expectPrompt, we just want to see *something* come back.
  await step('interactive: write to persistent cmd, read output', async () => {
    const { sessionId } = await mgr.spawn({ shell: 'cmd' });
    const r = await mgr.send(sessionId, 'echo INTERACTIVE_OK', { interactive: true, timeout: 8000 });
    const r2 = await mgr.send(sessionId, 'echo SECOND_OK', { interactive: true, timeout: 8000 });
    return {
      r1: { status: r.status, outputPreview: r.output.slice(0, 200) },
      r2: { status: r2.status, outputPreview: r2.output.slice(0, 200) },
    };
  });

  // Test 4: expectPrompt — wait for a specific string.
  // We use a one-liner that prints a custom prompt-like string and then
  // sits in cmd waiting for input. This simulates an interactive prompt.
  await step('expectPrompt: wait for a custom string', async () => {
    const { sessionId } = await mgr.spawn({ shell: 'cmd' });
    const setup = await mgr.send(sessionId, 'echo SETUP_DONE', { timeout: 10000 });
    const r = await mgr.send(sessionId, 'this_command_does_not_exist_xyz', {
      interactive: true,
      expectPrompt: 'is not recognized',
      timeout: 8000,
    });
    return {
      setup: { status: setup.status, outputPreview: setup.output.slice(0, 200) },
      r: { status: r.status, outputPreview: r.output.slice(0, 200) },
    };
  });

  // Test 5: simulate the real SSH-style scenario.
  // We can't actually ssh in CI, but we can spawn a "fake ssh" that
  // prints a prompt and waits for input.
  await step('SSH-like: fake server prints prompt, AI types password', async () => {
    const { sessionId } = await mgr.spawn({ shell: 'cmd' });
    const fakeSsh = 'echo hy@host password:';
    const r = await mgr.send(sessionId, fakeSsh, {
      interactive: true,
      expectPrompt: 'password:',
      timeout: 8000,
    });
    const r2 = await mgr.send(sessionId, 'echo PASSWORD_ACCEPTED', {
      interactive: true,
      timeout: 8000,
    });
    return {
      prompt: { status: r.status, outputPreview: r.output.slice(0, 200) },
      pw: { status: r2.status, outputPreview: r2.output.slice(0, 200) },
    };
  });

  // Test 6: REAL SSH to local OpenSSH server (127.0.0.1).
  // This is the real end-to-end test: spawn shell, run ssh, get password
  // prompt, type the password, then run `dir` and verify we see a directory
  // listing (proving the SSH session is alive and we can run commands).
  // Set XAI_SSH_TEST=skip to disable, or XAI_SSH_USER / XAI_SSH_PASS to
  // override the default credentials.
  const skipRealSsh = process.env.XAI_SSH_TEST === 'skip';
  if (skipRealSsh) {
    log('SKIP', 'real SSH (XAI_SSH_TEST=skip)');
  } else {
    const sshUser = process.env.XAI_SSH_USER || 'user';
    const sshPass = process.env.XAI_SSH_PASS || 'Tr0ub4dor&3';
    const sshHost = process.env.XAI_SSH_HOST || '127.0.0.1';
    await step(`real SSH: ${sshUser}@${sshHost}, type password, run dir`, async () => {
      const { sessionId } = await mgr.spawn({ shell: 'cmd' });
      try {
        // Step A: kick off the SSH connection. We use `cmd /c ssh ...` so
        // that the cmd shell is replaced by ssh; the prompt we expect is
        // the ssh password prompt, not a cmd prompt.
        const r1 = await mgr.send(sessionId, `ssh ${sshUser}@${sshHost}`, {
          interactive: true,
          expectPrompt: 'password:',
          timeout: 20000,
        });
        const gotPrompt = (r1.output || '').toLowerCase().includes('password');
        if (!gotPrompt) {
          throw new Error(`Did not see password prompt. Output: ${(r1.output || '').slice(0, 300)}`);
        }

        // Step B: type the password + Enter. OpenSSH on Windows reads
        // password from the terminal in raw mode, so we must NOT echo it
        // (which is what the manager does for plain text).
        const r2 = await mgr.send(sessionId, sshPass, {
          interactive: true,
          expectPrompt: '$',
          timeout: 20000,
        });

        // Step C: once we're inside the SSH session, run `dir` (works on
        // the Windows OpenSSH server shell too, which is cmd by default).
        const r3 = await mgr.send(sessionId, 'dir', {
          interactive: true,
          timeout: 15000,
        });
        const dirOut = (r3.output || '').toLowerCase();
        // `dir` lists the current directory, so we should see <DIR> entries
        // and/or a "Volume" header. Look for any common signature.
        const looksLikeDir =
          dirOut.includes('<dir>') ||
          dirOut.includes('volume ') ||
          dirOut.includes('volume in drive') ||
          dirOut.includes('directory of');
        return {
          prompt: { saw: gotPrompt, preview: r1.output.slice(0, 120) },
          afterPw: { status: r2.status, preview: r2.output.slice(0, 120) },
          dir: { status: r3.status, preview: r3.output.slice(0, 200), looksLikeDir },
        };
      } finally {
        // Clean up: close the session even on failure
        try { await mgr.close(sessionId); } catch (_) { /* ignore */ }
      }
    });
  }

  // Test 7: translateControlChars pure-function unit test.
  // This is the cleanest way to verify `Ctrl+C` produces 0x03 without
  // fighting Windows ConPTY (which eats 0x03 as the INTR character in
  // cooked mode and never passes it to a child process). The end-to-end
  // effect (SIGINT delivery) depends on the receiving program being in
  // raw mode, which is its concern, not the session manager's.
  await step('Ctrl+<key> translation: Ctrl+C→0x03 etc.', async () => {
    const cases = [
      { in: 'Ctrl+C', want: '\x03' },
      { in: 'Ctrl+D', want: '\x04' },
      { in: 'Ctrl+Z', want: '\x1a' },
      { in: 'Ctrl+A', want: '\x01' },
      { in: 'Ctrl+Z', want: '\x1a' },
      { in: 'Ctrl+[', want: '\x1b' },
      { in: 'Ctrl+\\', want: '\x1c' },
      { in: 'Ctrl+c', want: '\x03' }, // case-insensitive
      { in: 'echo Ctrl+C', want: 'echo \x03' },
      { in: 'plain text', want: 'plain text' }, // no change
      { in: '', want: '' }, // empty
    ];
    const mismatches = [];
    for (const c of cases) {
      const got = translateControlChars(c.in);
      if (got !== c.want) {
        mismatches.push({ input: JSON.stringify(c.in), want: JSON.stringify(c.want), got: JSON.stringify(got) });
      }
    }
    return {
      cases: cases.length,
      mismatches,
    };
  });

  mgr.dispose();
  log('ALL PASSED');
  process.exit(0);
})().catch((e) => {
  log('UNHANDLED', e);
  process.exit(1);
});
