import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TerminalOpenTool } from './terminal-open.js';
import { TerminalSendTool } from './terminal-send.js';
import { TerminalCloseTool } from './terminal-close.js';
import { TerminalPollTool } from './terminal-poll.js';
import type { TerminalSessionManager, SessionInfo, ShellType, SendResult } from './session-manager.js';

// ── Mock Factory ──────────────────────────────────────────────────────────────

function createMockManager() {
  const mockSessions: SessionInfo[] = [];
  let sessionCounter = 0;

  return {
    spawn: vi.fn().mockImplementation(async (opts?: { shell?: ShellType; cwd?: string }) => {
      sessionCounter++;
      const sessionId = `term_mock_${sessionCounter}`;
      const shell = opts?.shell || 'bash';
      const cwd = opts?.cwd || '/workspace';
      const info: SessionInfo = {
        id: sessionId,
        shell,
        cwd,
        startTime: Date.now(),
        lastActivity: Date.now(),
        status: 'active',
        pid: 12345 + sessionCounter,
      };
      mockSessions.push(info);
      return {
        sessionId,
        initialOutput: `mock shell started: ${shell}`,
        shell,
      };
    }),
    send: vi.fn().mockImplementation(async (_sessionId: string, _command: string): Promise<SendResult> => {
      return { output: `mock output for: ${_command}`, status: 'completed' };
    }),
    poll: vi.fn().mockImplementation(async (_sessionId: string): Promise<SendResult> => {
      return { output: '(no running command)', status: 'completed' };
    }),
    waitUntilComplete: vi.fn().mockImplementation(async (_sessionId: string, _opts?: { timeout?: number; signal?: AbortSignal }): Promise<SendResult> => {
      return { output: '(no running command)', status: 'completed' };
    }),
    close: vi.fn().mockImplementation(async (sessionId: string) => {
      const s = mockSessions.find((s) => s.id === sessionId);
      if (s) s.status = 'closed';
    }),
    listSessions: vi.fn().mockImplementation(() => mockSessions.map((s) => ({ ...s }))),
    isSessionActive: vi.fn().mockImplementation((sessionId: string) => {
      const s = mockSessions.find((s) => s.id === sessionId);
      return !!s && s.status === 'active';
    }),
    _mockSessions: mockSessions,
  } as unknown as TerminalSessionManager & { _mockSessions: SessionInfo[] };
}

// ═══════════════════════════════════════════════════════════════════════════════
// TerminalOpenTool
// ═══════════════════════════════════════════════════════════════════════════════

describe('TerminalOpenTool', () => {
  let manager: ReturnType<typeof createMockManager>;
  let tool: TerminalOpenTool;

  beforeEach(() => {
    manager = createMockManager();
    tool = new TerminalOpenTool(manager);
  });

  // ── Definition ────────────────────────────────────────────────────────────

  describe('definition', () => {
    it('should have tool name terminal_open', () => {
      expect(tool.definition.name).toBe('terminal_open');
    });

    it('should require confirmation', () => {
      expect(tool.definition.confirmationRequired).toBe(true);
    });

    it('should have shell parameter with enum values', () => {
      const shellParam = tool.definition.parameters.shell;
      expect(shellParam).toBeDefined();
      expect(shellParam.type).toBe('string');
      expect(shellParam.enum).toEqual(['cmd', 'powershell']);
      expect(shellParam.location).toBe('header');
    });

    it('should have cwd parameter as optional header param', () => {
      const cwdParam = tool.definition.parameters.cwd;
      expect(cwdParam).toBeDefined();
      expect(cwdParam.type).toBe('string');
      expect(cwdParam.location).toBe('header');
      expect(cwdParam.required).toBeUndefined();
    });

  });

  // ── Successful Execution ──────────────────────────────────────────────────

  describe('successful execution', () => {
    it('should open a session with default shell', async () => {
      const result = await tool.execute({});

      expect(result.success).toBe(true);
      expect(result.output).toContain('Session opened:');
      expect(result.output).toContain('term_mock_1');
      expect(result.output).toContain('Shell:');
      expect(result.output).toContain('mock shell started');
      expect(result.output).toContain('Active sessions: 1');
      expect(result.output).toContain('Use terminal_send');
      expect(result.output).toContain('Use terminal_close');
      expect(manager.spawn).toHaveBeenCalledOnce();
    });

    it('should open a session with specified shell', async () => {
      const result = await tool.execute({ shell: 'powershell' });

      expect(result.success).toBe(true);
      expect(manager.spawn).toHaveBeenCalledWith({ shell: 'powershell', cwd: undefined });
    });

    it('should open a session with custom cwd', async () => {
      const result = await tool.execute({ cwd: './myproject' });

      expect(result.success).toBe(true);
      expect(manager.spawn).toHaveBeenCalledWith({ shell: undefined, cwd: './myproject' });
    });

    it('should open a session with both shell and cwd', async () => {
      const result = await tool.execute({ shell: 'cmd', cwd: 'D:\\projects' });

      expect(result.success).toBe(true);
      expect(manager.spawn).toHaveBeenCalledWith({ shell: 'cmd', cwd: 'D:\\projects' });
    });

    it('should list all active sessions in output', async () => {
      // Open first session
      await tool.execute({ shell: 'bash' });
      // Open second session
      await tool.execute({ shell: 'cmd' });

      const result = await tool.execute({});
      expect(result.success).toBe(true);
      expect(result.output).toContain('Active sessions: 3');
      expect(result.output).toContain('term_mock_1');
      expect(result.output).toContain('term_mock_2');
      expect(result.output).toContain('term_mock_3');
    });

    it('should include execution time', async () => {
      const result = await tool.execute({});
      expect(result.success).toBe(true);
      expect(result.executionTime).toBeGreaterThanOrEqual(0);
    });
  });

  // ── Error Handling ────────────────────────────────────────────────────────

  describe('error handling', () => {
    it('should handle spawn failure', async () => {
      (manager.spawn as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('ENOENT: shell not found')
      );

      const result = await tool.execute({ shell: 'bash' });

      expect(result.success).toBe(false);
      expect(result.output).toContain('Failed to open terminal session');
      expect(result.output).toContain('ENOENT: shell not found');
    });

    it('should handle unknown error types', async () => {
      (manager.spawn as ReturnType<typeof vi.fn>).mockRejectedValueOnce('string error');

      const result = await tool.execute({});

      expect(result.success).toBe(false);
      expect(result.output).toContain('Failed to open terminal session');
      expect(result.output).toContain('string error');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// TerminalSendTool
// ═══════════════════════════════════════════════════════════════════════════════

describe('TerminalSendTool', () => {
  let manager: ReturnType<typeof createMockManager>;
  let tool: TerminalSendTool;

  beforeEach(() => {
    manager = createMockManager();
    tool = new TerminalSendTool(manager);

    // Pre-open a session for send tests
    manager.spawn();
  });

  // ── Definition ────────────────────────────────────────────────────────────

  describe('definition', () => {
    it('should have tool name terminal_send', () => {
      expect(tool.definition.name).toBe('terminal_send');
    });

    it('should require confirmation', () => {
      expect(tool.definition.confirmationRequired).toBe(true);
    });

    it('should require sessionId parameter', () => {
      const sessionIdParam = tool.definition.parameters.sessionId;
      expect(sessionIdParam).toBeDefined();
      expect(sessionIdParam.required).toBe(true);
      expect(sessionIdParam.location).toBe('header');
    });

    it('should require command parameter in body', () => {
      const commandParam = tool.definition.parameters.command;
      expect(commandParam).toBeDefined();
      expect(commandParam.required).toBe(true);
      expect(commandParam.location).toBe('body');
    });

    it('should have optional timeout parameter', () => {
      const timeoutParam = tool.definition.parameters.timeout;
      expect(timeoutParam).toBeDefined();
      expect(timeoutParam.type).toBe('number');
      expect(timeoutParam.required).toBeUndefined();
      expect(timeoutParam.location).toBe('header');
    });

  });

  // ── Successful Execution ──────────────────────────────────────────────────

  describe('successful execution', () => {
    it('should send a command to an active session', async () => {
      const result = await tool.execute({
        sessionId: 'term_mock_1',
        command: 'echo hello',
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain('Session: term_mock_1');
      expect(result.output).toContain('Command: echo hello');
      expect(result.output).toContain('mock output for: echo hello');
      expect(manager.send).toHaveBeenCalledWith('term_mock_1', 'echo hello', { timeout: undefined, background: false, interactive: false, signal: undefined });
    });

    it('should send a command with custom timeout', async () => {
      const result = await tool.execute({
        sessionId: 'term_mock_1',
        command: 'npm test',
        timeout: 60000,
      });

      expect(result.success).toBe(true);
      expect(manager.send).toHaveBeenCalledWith('term_mock_1', 'npm test', { timeout: 60000, background: false, interactive: false, signal: undefined });
    });

    it('should handle empty output gracefully', async () => {
      (manager.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ output: '', status: 'completed' });

      const result = await tool.execute({
        sessionId: 'term_mock_1',
        command: 'silent-command',
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain('no output');
    });

    it('should include execution time', async () => {
      const result = await tool.execute({
        sessionId: 'term_mock_1',
        command: 'ls',
      });

      expect(result.executionTime).toBeGreaterThanOrEqual(0);
    });
  });

  // ── Validation ────────────────────────────────────────────────────────────

  describe('validation', () => {
    it('should fail when sessionId is empty', async () => {
      const result = await tool.execute({ sessionId: '', command: 'ls' });

      expect(result.success).toBe(false);
      expect(result.output).toContain('sessionId is required');
    });

    it('should fail when sessionId is whitespace-only', async () => {
      const result = await tool.execute({ sessionId: '   ', command: 'ls' });

      expect(result.success).toBe(false);
      expect(result.output).toContain('sessionId is required');
    });

    it('should fail when command is empty', async () => {
      const result = await tool.execute({ sessionId: 'term_mock_1', command: '' });

      expect(result.success).toBe(false);
      expect(result.output).toContain('command is required');
    });

    it('should fail when command is whitespace-only', async () => {
      const result = await tool.execute({ sessionId: 'term_mock_1', command: '   ' });

      expect(result.success).toBe(false);
      expect(result.output).toContain('command is required');
    });

    it('should fail when sessionId is not found', async () => {
      const result = await tool.execute({
        sessionId: 'nonexistent_session',
        command: 'ls',
      });

      expect(result.success).toBe(false);
      expect(result.output).toContain('not found or closed');
      expect(result.output).toContain('nonexistent_session');
      expect(manager.send).not.toHaveBeenCalled();
    });

    it('should list active sessions when session not found', async () => {
      const result = await tool.execute({
        sessionId: 'nonexistent_session',
        command: 'ls',
      });

      expect(result.success).toBe(false);
      expect(result.output).toContain('Active sessions:');
      expect(result.output).toContain('term_mock_1');
    });

    it('should show "(none)" when no active sessions exist', async () => {
      // Close the only session
      await manager.close('term_mock_1');

      const result = await tool.execute({
        sessionId: 'term_mock_1',
        command: 'ls',
      });

      expect(result.success).toBe(false);
      expect(result.output).toContain('(none)');
    });
  });

  // ── Error Handling ────────────────────────────────────────────────────────

  describe('error handling', () => {
    it('should handle send failure (command timed out)', async () => {
      (manager.send as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('Command timed out after 30000ms')
      );

      const result = await tool.execute({
        sessionId: 'term_mock_1',
        command: 'long-running-command',
      });

      expect(result.success).toBe(false);
      expect(result.output).toContain('Command failed');
      expect(result.output).toContain('Command timed out after 30000ms');
    });

    it('should handle process exited error', async () => {
      (manager.send as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('Process exited with code 1 before command completed')
      );

      const result = await tool.execute({
        sessionId: 'term_mock_1',
        command: 'exit 1',
      });

      expect(result.success).toBe(false);
      expect(result.output).toContain('Command failed');
      expect(result.output).toContain('Process exited with code 1');
    });

    it('should handle unknown error types', async () => {
      (manager.send as ReturnType<typeof vi.fn>).mockRejectedValueOnce(42);

      const result = await tool.execute({
        sessionId: 'term_mock_1',
        command: 'test',
      });

      expect(result.success).toBe(false);
      expect(result.output).toContain('Command failed');
    });
  });

  // ── Interactive Mode ────────────────────────────────────────────────────

  describe('interactive mode', () => {
    it('should pass interactive:true to manager.send', async () => {
      await tool.execute({
        sessionId: 'term_mock_1',
        command: 'ssh user@host',
        interactive: true,
      });

      expect(manager.send).toHaveBeenCalledWith(
        'term_mock_1',
        'ssh user@host',
        expect.objectContaining({ interactive: true }),
      );
    });

    it('should show interactive hint when command is still_running', async () => {
      (manager.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        output: 'user@host\'s password: ',
        status: 'still_running',
      });

      const result = await tool.execute({
        sessionId: 'term_mock_1',
        command: 'ssh user@host',
        interactive: true,
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain('Interactive command is still running');
      expect(result.output).toContain('interactive:true');
      expect(result.output).toContain('user@host\'s password:');
    });

    it('should default interactive to false when not specified', async () => {
      await tool.execute({
        sessionId: 'term_mock_1',
        command: 'ls',
      });

      expect(manager.send).toHaveBeenCalledWith(
        'term_mock_1',
        'ls',
        expect.objectContaining({ interactive: false }),
      );
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// TerminalCloseTool
// ═══════════════════════════════════════════════════════════════════════════════

describe('TerminalCloseTool', () => {
  let manager: ReturnType<typeof createMockManager>;
  let tool: TerminalCloseTool;

  beforeEach(() => {
    manager = createMockManager();
    tool = new TerminalCloseTool(manager);

    // Pre-open a session
    manager.spawn();
  });

  // ── Definition ────────────────────────────────────────────────────────────

  describe('definition', () => {
    it('should have tool name terminal_close', () => {
      expect(tool.definition.name).toBe('terminal_close');
    });

    it('should NOT require confirmation', () => {
      expect(tool.definition.confirmationRequired).toBe(false);
    });

    it('should require sessionId parameter', () => {
      const sessionIdParam = tool.definition.parameters.sessionId;
      expect(sessionIdParam).toBeDefined();
      expect(sessionIdParam.required).toBe(true);
      expect(sessionIdParam.location).toBe('header');
    });

  });

  // ── Successful Execution ──────────────────────────────────────────────────

  describe('successful execution', () => {
    it('should close an active session', async () => {
      const result = await tool.execute({ sessionId: 'term_mock_1' });

      expect(result.success).toBe(true);
      expect(result.output).toContain('Session term_mock_1 closed.');
      expect(manager.close).toHaveBeenCalledWith('term_mock_1');
    });

    it('should report already closed session', async () => {
      // Close first, then try again
      await manager.close('term_mock_1');
      // Make isSessionActive return false
      (manager.isSessionActive as ReturnType<typeof vi.fn>).mockReturnValue(false);

      const result = await tool.execute({ sessionId: 'term_mock_1' });

      expect(result.success).toBe(true);
      expect(result.output).toContain('was already closed');
    });

    it('should list remaining active sessions', async () => {
      // Open a second session
      await manager.spawn();

      const result = await tool.execute({ sessionId: 'term_mock_1' });

      expect(result.success).toBe(true);
      expect(result.output).toContain('Active sessions: 1');
      expect(result.output).toContain('term_mock_2');
      // "Session term_mock_1 closed." appears earlier, so check only the active sessions list
      const activeSection = result.output.split('Active sessions')[1];
      expect(activeSection).toContain('term_mock_2');
      expect(activeSection).not.toContain('term_mock_1');
    });

    it('should show 0 active sessions when all closed', async () => {
      const result = await tool.execute({ sessionId: 'term_mock_1' });

      expect(result.success).toBe(true);
      expect(result.output).toContain('Active sessions: 0');
    });

    it('should include execution time', async () => {
      const result = await tool.execute({ sessionId: 'term_mock_1' });

      expect(result.executionTime).toBeGreaterThanOrEqual(0);
    });
  });

  // ── Validation ────────────────────────────────────────────────────────────

  describe('validation', () => {
    it('should fail when sessionId is empty', async () => {
      const result = await tool.execute({ sessionId: '' });

      expect(result.success).toBe(false);
      expect(result.output).toContain('sessionId is required');
    });

    it('should fail when sessionId is whitespace-only', async () => {
      const result = await tool.execute({ sessionId: '   ' });

      expect(result.success).toBe(false);
      expect(result.output).toContain('sessionId is required');
    });

    it('should still call close even for nonexistent session (graceful)', async () => {
      // close() on manager is a no-op for unknown ids
      const result = await tool.execute({ sessionId: 'nonexistent_id' });

      expect(result.success).toBe(true);
      expect(manager.close).toHaveBeenCalledWith('nonexistent_id');
    });
  });

  // ── Error Handling ────────────────────────────────────────────────────────

  describe('error handling', () => {
    it('should handle close failure', async () => {
      (manager.close as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('EPERM: cannot kill process')
      );

      const result = await tool.execute({ sessionId: 'term_mock_1' });

      expect(result.success).toBe(false);
      expect(result.output).toContain('Failed to close session');
      expect(result.output).toContain('EPERM: cannot kill process');
    });

    it('should handle unknown error types', async () => {
      (manager.close as ReturnType<typeof vi.fn>).mockRejectedValueOnce('string error');

      const result = await tool.execute({ sessionId: 'term_mock_1' });

      expect(result.success).toBe(false);
      expect(result.output).toContain('Failed to close session');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Cross-tool Integration (using mock manager)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Cross-tool integration (mock)', () => {
  let manager: ReturnType<typeof createMockManager>;
  let openTool: TerminalOpenTool;
  let sendTool: TerminalSendTool;
  let closeTool: TerminalCloseTool;

  beforeEach(() => {
    manager = createMockManager();
    openTool = new TerminalOpenTool(manager);
    sendTool = new TerminalSendTool(manager);
    closeTool = new TerminalCloseTool(manager);
  });

  it('should open → send → close workflow', async () => {
    // Step 1: Open
    const openResult = await openTool.execute({ shell: 'bash' });
    expect(openResult.success).toBe(true);
    const sessionIdMatch = openResult.output.match(/Session opened: (term_mock_\d+)/);
    expect(sessionIdMatch).not.toBeNull();
    const sessionId = sessionIdMatch![1];

    // Step 2: Send
    const sendResult = await sendTool.execute({
      sessionId,
      command: 'echo hello',
    });
    expect(sendResult.success).toBe(true);
    expect(sendResult.output).toContain('mock output for: echo hello');
    expect(sendResult.output).toContain('Status: completed');

    // Step 3: Close
    const closeResult = await closeTool.execute({ sessionId });
    expect(closeResult.success).toBe(true);
    expect(closeResult.output).toContain('closed');
  });

  it('should fail send after session is closed', async () => {
    const openResult = await openTool.execute({});
    const sessionId = openResult.output.match(/Session opened: (term_mock_\d+)/)![1];

    await closeTool.execute({ sessionId });

    // Now the mock isSessionActive should return false for closed sessions
    const sendResult = await sendTool.execute({
      sessionId,
      command: 'echo too late',
    });

    expect(sendResult.success).toBe(false);
    expect(sendResult.output).toContain('not found or closed');
  });

  it('should handle multiple concurrent sessions independently', async () => {
    const session1 = await openTool.execute({ shell: 'bash' });
    const session2 = await openTool.execute({ shell: 'cmd' });

    const id1 = session1.output.match(/Session opened: (term_mock_\d+)/)![1];
    const id2 = session2.output.match(/Session opened: (term_mock_\d+)/)![1];

    expect(id1).not.toBe(id2);

    // Send to both
    const send1 = await sendTool.execute({ sessionId: id1, command: 'echo s1' });
    const send2 = await sendTool.execute({ sessionId: id2, command: 'echo s2' });

    expect(send1.success).toBe(true);
    expect(send2.success).toBe(true);

    // Close session1, session2 should still work
    await closeTool.execute({ sessionId: id1 });
    const send2Again = await sendTool.execute({ sessionId: id2, command: 'echo still alive' });
    expect(send2Again.success).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// TerminalPollTool
// ═══════════════════════════════════════════════════════════════════════════════

describe('TerminalPollTool', () => {
  let manager: ReturnType<typeof createMockManager>;
  let tool: TerminalPollTool;

  beforeEach(() => {
    manager = createMockManager();
    tool = new TerminalPollTool(manager);
    manager.spawn();
  });

  it('should have tool name terminal_poll', () => {
    expect(tool.definition.name).toBe('terminal_poll');
  });

  it('should NOT require confirmation', () => {
    expect(tool.definition.confirmationRequired).toBe(false);
  });

  it('should poll a session successfully', async () => {
    const result = await tool.execute({ sessionId: 'term_mock_1' });
    expect(result.success).toBe(true);
    expect(result.output).toContain('Session: term_mock_1');
    expect(manager.poll).toHaveBeenCalledWith('term_mock_1');
  });

  it('should show COMPLETED status', async () => {
    (manager.poll as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      output: 'build successful',
      status: 'completed',
    });

    const result = await tool.execute({ sessionId: 'term_mock_1' });
    expect(result.success).toBe(true);
    expect(result.output).toContain('COMPLETED');
    expect(result.output).toContain('build successful');
  });

  it('should show STILL RUNNING status', async () => {
    (manager.poll as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      output: 'downloading gradle...',
      status: 'still_running',
    });

    const result = await tool.execute({ sessionId: 'term_mock_1' });
    expect(result.success).toBe(true);
    expect(result.output).toContain('STILL RUNNING');
    expect(result.output).toContain('downloading gradle...');
    expect(result.output).toContain('wait:true');
  });

  it('should use waitUntilComplete when wait:true', async () => {
    (manager.waitUntilComplete as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      output: 'build successful',
      status: 'completed',
    });

    const result = await tool.execute({ sessionId: 'term_mock_1', wait: true });
    expect(result.success).toBe(true);
    expect(result.output).toContain('COMPLETED');
    expect(result.output).toContain('build successful');
    expect(manager.waitUntilComplete).toHaveBeenCalledWith('term_mock_1', { timeout: undefined, signal: undefined });
  });

  it('should pass timeout to waitUntilComplete when wait:true', async () => {
    (manager.waitUntilComplete as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      output: 'done',
      status: 'completed',
    });

    const result = await tool.execute({ sessionId: 'term_mock_1', wait: true, timeout: 60000 });
    expect(result.success).toBe(true);
    expect(manager.waitUntilComplete).toHaveBeenCalledWith('term_mock_1', { timeout: 60000, signal: undefined });
  });

  it('should show STILL RUNNING with wait-specific hint when wait:true times out', async () => {
    (manager.waitUntilComplete as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      output: 'still building...',
      status: 'still_running',
    });

    const result = await tool.execute({ sessionId: 'term_mock_1', wait: true });
    expect(result.success).toBe(true);
    expect(result.output).toContain('STILL RUNNING');
    expect(result.output).toContain('longer timeout');
  });

  it('should fail when sessionId is empty', async () => {
    const result = await tool.execute({ sessionId: '' });
    expect(result.success).toBe(false);
    expect(result.output).toContain('sessionId is required');
  });

  it('should fail when session not found', async () => {
    const result = await tool.execute({ sessionId: 'nonexistent' });
    expect(result.success).toBe(false);
    expect(result.output).toContain('not found or closed');
  });

  it('should handle poll failure', async () => {
    (manager.poll as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('Session crashed'),
    );

    const result = await tool.execute({ sessionId: 'term_mock_1' });
    expect(result.success).toBe(false);
    expect(result.output).toContain('Poll failed');
    expect(result.output).toContain('Session crashed');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Background & Still-running behaviors
// ═══════════════════════════════════════════════════════════════════════════════

describe('Terminal send background & still_running', () => {
  let manager: ReturnType<typeof createMockManager>;
  let tool: TerminalSendTool;

  beforeEach(() => {
    manager = createMockManager();
    tool = new TerminalSendTool(manager);
    manager.spawn();
  });

  it('should handle background mode', async () => {
    (manager.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      output: 'Command started in background.',
      status: 'background',
    });

    const result = await tool.execute({
      sessionId: 'term_mock_1',
      command: 'gradlew assembleRelease',
      background: true,
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain('Status: background');
    expect(manager.send).toHaveBeenCalledWith(
      'term_mock_1',
      'gradlew assembleRelease',
      { timeout: undefined, background: true, interactive: false, signal: undefined },
    );
  });

  it('should handle still_running status', async () => {
    (manager.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      output: 'downloading gradle...',
      status: 'still_running',
    });

    const result = await tool.execute({
      sessionId: 'term_mock_1',
      command: 'gradlew assembleRelease',
      timeout: 30000,
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain('STILL RUNNING');
    expect(result.output).toContain('terminal_poll');
    expect(result.output).toContain('downloading gradle...');
  });

  it('should detect immediate failure in background mode', async () => {
    // Simulate earlyFailureCheck detecting that the command failed immediately
    // (e.g. PSReadLine garbled the command, syntax error)
    (manager.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      output: 'OCRv6_medium_detcmd : 无法将"OCRv6_medium_detcmd"项识别为 cmdlet、函数、脚本文件或可运行程序的名称。',
      status: 'completed',
    });

    const result = await tool.execute({
      sessionId: 'term_mock_1',
      command: 'cmd /c "cd /d D:\\PaddleOCR && python test_final_verify.py"',
      background: true,
    });

    expect(result.success).toBe(true);
    // Status label should indicate immediate completion (possible error)
    expect(result.output).toContain('COMPLETED IMMEDIATELY');
    // Should include the NOTE about background command completing immediately
    expect(result.output).toContain('Background command completed immediately');
    // Should include the actual error output
    expect(result.output).toContain('无法将');
  });

  it('should show normal background status when command is genuinely running', async () => {
    // Simulate earlyFailureCheck returning null (command still starting)
    (manager.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      output: 'Command started in background. Use terminal_poll sessionId:term_mock_1 to check progress and results.',
      status: 'background',
    });

    const result = await tool.execute({
      sessionId: 'term_mock_1',
      command: 'pnpm dev',
      background: true,
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain('Status: background');
    // Should NOT show immediate completion note
    expect(result.output).not.toContain('COMPLETED IMMEDIATELY');
    expect(result.output).not.toContain('Background command completed immediately');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Integration: pnpm dev (webapp-test/app) — open → send(background) → poll
// ═══════════════════════════════════════════════════════════════════════════════

describe('Integration: pnpm dev in webapp-test/app', () => {
  let manager: ReturnType<typeof createMockManager>;
  let openTool: TerminalOpenTool;
  let sendTool: TerminalSendTool;
  let pollTool: TerminalPollTool;
  let closeTool: TerminalCloseTool;

  const webappCwd = 'D:\\myProject\\xAI\\webapp-test\\app';

  beforeEach(() => {
    manager = createMockManager();
    openTool = new TerminalOpenTool(manager);
    sendTool = new TerminalSendTool(manager);
    pollTool = new TerminalPollTool(manager);
    closeTool = new TerminalCloseTool(manager);
  });

  // ── PowerShell ────────────────────────────────────────────────────────────

  describe('PowerShell', () => {
    it('should open powershell, send "pnpm dev" in background, then poll for Vite ready', async () => {
      // Step 1: Open a PowerShell terminal in webapp-test/app
      const openResult = await openTool.execute({ shell: 'powershell', cwd: webappCwd });
      expect(openResult.success).toBe(true);
      expect(openResult.output).toContain('Session opened:');
      const sessionId = openResult.output.match(/Session opened: (term_\S+)/)?.[1];
      expect(sessionId).toBeDefined();

      // Step 2: Send "pnpm dev" in background mode
      (manager.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        output: `Command started in background. Use terminal_poll sessionId:${sessionId} to check progress and results.`,
        status: 'background',
      });

      const sendResult = await sendTool.execute({
        sessionId: sessionId!,
        command: 'pnpm dev',
        background: true,
      });
      expect(sendResult.success).toBe(true);
      expect(sendResult.output).toContain('background');

      // Step 3: Poll — first poll shows still running (Vite starting)
      (manager.poll as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        output: '$ pnpm dev\n$ vite --host\n\nVITE v5.4.0  ready in 1302 ms\n\n➜  Local:   http://localhost:5173/',
        status: 'still_running',
      });

      const pollResult1 = await pollTool.execute({ sessionId: sessionId! });
      expect(pollResult1.success).toBe(true);
      expect(pollResult1.output).toContain('STILL RUNNING');
      expect(pollResult1.output).toContain('VITE v5.4.0');
      expect(pollResult1.output).toContain('localhost:5173');

      // Step 4: Poll with wait:true — Vite is serving, command stays running
      (manager.waitUntilComplete as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        output: 'VITE v5.4.0  ready in 1302 ms\n\n➜  Local:   http://localhost:5173/\n➜  Network: http://10.128.252.145:5173/',
        status: 'still_running',
      });

      const pollResult2 = await pollTool.execute({ sessionId: sessionId!, wait: true, timeout: 120000 });
      expect(pollResult2.success).toBe(true);
      // Vite dev server stays running, so status is still_running — but we can confirm it started
      expect(pollResult2.output).toContain('localhost:5173');

      // Step 5: Close the session
      const closeResult = await closeTool.execute({ sessionId: sessionId! });
      expect(closeResult.success).toBe(true);
      expect(closeResult.output).toContain('closed');
    });
  });

  // ── CMD ───────────────────────────────────────────────────────────────────

  describe('CMD', () => {
    it('should open cmd, send "pnpm dev" in background, then poll for Vite ready', async () => {
      // Step 1: Open a CMD terminal in webapp-test/app
      const openResult = await openTool.execute({ shell: 'cmd', cwd: webappCwd });
      expect(openResult.success).toBe(true);
      expect(openResult.output).toContain('Session opened:');
      const sessionId = openResult.output.match(/Session opened: (term_\S+)/)?.[1];
      expect(sessionId).toBeDefined();

      // Step 2: Send "pnpm dev" in background mode
      (manager.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        output: `Command started in background. Use terminal_poll sessionId:${sessionId} to check progress and results.`,
        status: 'background',
      });

      const sendResult = await sendTool.execute({
        sessionId: sessionId!,
        command: 'pnpm dev',
        background: true,
      });
      expect(sendResult.success).toBe(true);
      expect(sendResult.output).toContain('background');

      // Step 3: Poll — Vite starting up
      (manager.poll as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        output: 'D:\\myProject\\xAI\\webapp-test\\app>pnpm dev\n> vite --host\n\n  VITE v5.4.0  ready in 898 ms\n\n  ➜  Local:   http://localhost:5173/',
        status: 'still_running',
      });

      const pollResult1 = await pollTool.execute({ sessionId: sessionId! });
      expect(pollResult1.success).toBe(true);
      expect(pollResult1.output).toContain('VITE v5.4.0');
      expect(pollResult1.output).toContain('localhost:5173');

      // Step 4: Close
      const closeResult = await closeTool.execute({ sessionId: sessionId! });
      expect(closeResult.success).toBe(true);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Integration: java -jar (db-gateway/target) — open → send(background) → poll
// ═══════════════════════════════════════════════════════════════════════════════

describe('Integration: java -jar db-gateway in db-gateway/target', () => {
  let manager: ReturnType<typeof createMockManager>;
  let openTool: TerminalOpenTool;
  let sendTool: TerminalSendTool;
  let pollTool: TerminalPollTool;
  let closeTool: TerminalCloseTool;

  const dbGatewayCwd = 'D:\\myProject\\xAI\\db-gateway\\target';

  beforeEach(() => {
    manager = createMockManager();
    openTool = new TerminalOpenTool(manager);
    sendTool = new TerminalSendTool(manager);
    pollTool = new TerminalPollTool(manager);
    closeTool = new TerminalCloseTool(manager);
  });

  // ── PowerShell ────────────────────────────────────────────────────────────

  describe('PowerShell', () => {
    it('should open powershell, send "java -jar" in background, then poll for Spring Boot started', async () => {
      // Step 1: Open a PowerShell terminal in db-gateway/target
      const openResult = await openTool.execute({ shell: 'powershell', cwd: dbGatewayCwd });
      expect(openResult.success).toBe(true);
      expect(openResult.output).toContain('Session opened:');
      const sessionId = openResult.output.match(/Session opened: (term_\S+)/)?.[1];
      expect(sessionId).toBeDefined();

      // Step 2: Send "java -jar db-gateway-1.0.0.jar" in background mode
      (manager.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        output: `Command started in background. Use terminal_poll sessionId:${sessionId} to check progress and results.`,
        status: 'background',
      });

      const sendResult = await sendTool.execute({
        sessionId: sessionId!,
        command: 'java -jar db-gateway-1.0.0.jar',
        background: true,
      });
      expect(sendResult.success).toBe(true);
      expect(sendResult.output).toContain('background');

      // Step 3: Poll — Spring Boot is starting
      (manager.poll as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        output: 'Starting DbGatewayApplication v1.0.0 using Java 21.0.1\nTomcat initialized with port 8088 (http)',
        status: 'still_running',
      });

      const pollResult1 = await pollTool.execute({ sessionId: sessionId! });
      expect(pollResult1.success).toBe(true);
      expect(pollResult1.output).toContain('STILL RUNNING');
      expect(pollResult1.output).toContain('DbGatewayApplication');
      expect(pollResult1.output).toContain('port 8088');

      // Step 4: Poll with wait:true — Spring Boot fully started
      (manager.waitUntilComplete as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        output: 'Tomcat started on port 8088 (http) with context path \'/\'\nStarted DbGatewayApplication in 3.554 seconds (process running for 4.545)',
        status: 'still_running',
      });

      const pollResult2 = await pollTool.execute({ sessionId: sessionId!, wait: true, timeout: 120000 });
      expect(pollResult2.success).toBe(true);
      // Spring Boot stays running, but we can confirm it started successfully
      expect(pollResult2.output).toContain('Started DbGatewayApplication');
      expect(pollResult2.output).toContain('port 8088');

      // Step 5: Close
      const closeResult = await closeTool.execute({ sessionId: sessionId! });
      expect(closeResult.success).toBe(true);
    });
  });

  // ── CMD ───────────────────────────────────────────────────────────────────

  describe('CMD', () => {
    it('should open cmd, send "java -jar" in background, then poll for Spring Boot started', async () => {
      // Step 1: Open a CMD terminal in db-gateway/target
      const openResult = await openTool.execute({ shell: 'cmd', cwd: dbGatewayCwd });
      expect(openResult.success).toBe(true);
      expect(openResult.output).toContain('Session opened:');
      const sessionId = openResult.output.match(/Session opened: (term_\S+)/)?.[1];
      expect(sessionId).toBeDefined();

      // Step 2: Send "java -jar db-gateway-1.0.0.jar" in background mode
      (manager.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        output: `Command started in background. Use terminal_poll sessionId:${sessionId} to check progress and results.`,
        status: 'background',
      });

      const sendResult = await sendTool.execute({
        sessionId: sessionId!,
        command: 'java -jar db-gateway-1.0.0.jar',
        background: true,
      });
      expect(sendResult.success).toBe(true);
      expect(sendResult.output).toContain('background');

      // Step 3: Poll — Spring Boot starting
      (manager.poll as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        output: 'Starting DbGatewayApplication v1.0.0\nTomcat initialized with port 8088 (http)',
        status: 'still_running',
      });

      const pollResult1 = await pollTool.execute({ sessionId: sessionId! });
      expect(pollResult1.success).toBe(true);
      expect(pollResult1.output).toContain('DbGatewayApplication');
      expect(pollResult1.output).toContain('port 8088');

      // Step 4: Poll with wait:true — Spring Boot fully started
      (manager.waitUntilComplete as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        output: 'Tomcat started on port 8088 (http) with context path \'/\'\nStarted DbGatewayApplication in 3.486 seconds',
        status: 'still_running',
      });

      const pollResult2 = await pollTool.execute({ sessionId: sessionId!, wait: true, timeout: 120000 });
      expect(pollResult2.success).toBe(true);
      expect(pollResult2.output).toContain('Started DbGatewayApplication');

      // Step 5: Close
      const closeResult = await closeTool.execute({ sessionId: sessionId! });
      expect(closeResult.success).toBe(true);
    });

    // ── Error scenario: port already in use ─────────────────────────────────

    it('should detect port conflict when running java -jar on an occupied port', async () => {
      const openResult = await openTool.execute({ shell: 'cmd', cwd: dbGatewayCwd });
      const sessionId = openResult.output.match(/Session opened: (term_\S+)/)?.[1]!;

      (manager.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        output: `Command started in background. Use terminal_poll sessionId:${sessionId} to check progress and results.`,
        status: 'background',
      });

      await sendTool.execute({
        sessionId,
        command: 'java -jar db-gateway-1.0.0.jar',
        background: true,
      });

      // Poll reveals port conflict error
      (manager.poll as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        output: 'Web server failed to start. Port 8088 was already in use.\nAPPLICATION FAILED TO START',
        status: 'completed',
      });

      const pollResult = await pollTool.execute({ sessionId });
      expect(pollResult.success).toBe(true);
      expect(pollResult.output).toContain('Port 8088 was already in use');
      expect(pollResult.output).toContain('APPLICATION FAILED TO START');

      await closeTool.execute({ sessionId });
    });
  });
});