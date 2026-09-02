import { spawn, execSync } from 'child_process';
import path from 'path';
import { createRequire } from 'module';
import { ToolDefinition, CommandStatus as CommandStatusType, ProxyConfig } from '@xai/shared';
import { BaseTool } from './base-tool.js';

// ESM-safe require for resolving optional npm packages (e.g. iconv-lite).
const esmRequire = createRequire(import.meta.url);

interface InternalCommandStatus {
  id: string;
  command: string;
  cwd: string;
  status: CommandStatusType;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  startTime: number;
  endTime?: number;
  pid?: number;
}

const DEFAULT_TIMEOUT = 120_000;
const MAX_OUTPUT_LENGTH = 50_000;
const HEAD_TAIL_THRESHOLD = 30_000;
const HEAD_SIZE = 15_000;
const TAIL_SIZE = 15_000;

const ANSI_REGEX = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;
const GBK_REGEX = /[\x80-\xff]/;

const EXIT_CODE_MESSAGES: Record<number, string> = {
  0: 'Command executed successfully',
  1: 'Command failed (general error)',
  2: 'Command failed (misuse of shell builtins or invalid arguments)',
  127: 'Command not found - check spelling or install the required tool',
  130: 'Command was interrupted by user (Ctrl+C / SIGINT)',
  137: 'Command was killed (SIGKILL - possibly out of memory or timed out)',
};

export class ExecuteCommandTool extends BaseTool {
  private workspacePath: string;
  private activeProcesses: Map<string, InternalCommandStatus> = new Map();
  private onOutput?: (commandId: string, outputType: 'stdout' | 'stderr', data: string) => void;
  private proxyConfig: ProxyConfig | null = null;

  setProxyConfig(config: ProxyConfig | null): void {
    this.proxyConfig = config;
  }

  constructor(workspacePath: string, onOutput?: (commandId: string, outputType: 'stdout' | 'stderr', data: string) => void) {
    super();
    this.workspacePath = workspacePath;
    this.onOutput = onOutput;
  }

  get definition(): ToolDefinition {
    return {
      name: 'execute_command',
      description: `Execute a command via ${process.platform === 'win32' ? 'cmd.exe' : 'bash'}. Returns output.`,
      parameters: {
        command: { type: 'string', description: 'Command to execute', required: true, location: 'body' },
        cwd: { type: 'string', description: 'Working directory (default: workspace root)', location: 'header' },
        timeout: { type: 'number', description: `Timeout in ms (default: ${DEFAULT_TIMEOUT})`, location: 'header' },
        env: { type: 'object', description: 'Extra environment variables', location: 'header' },
      },
      confirmationRequired: true,
      examples: [
        `++++ execute_command cwd:./packages/core timeout:30000
npm run build
++++ end`,
      ],
    };
  }

  async _execute(params: Record<string, unknown>, signal?: AbortSignal) {
    const start = Date.now();
    try {
      const command = params.command as string;
      const cwd = params.cwd ? this.resolvePath(params.cwd as string) : this.workspacePath;
      const timeout = typeof params.timeout === 'number' ? params.timeout : (typeof params.timeout === 'string' ? parseInt(params.timeout, 10) : DEFAULT_TIMEOUT);
      const extraEnv = params.env as Record<string, string> | undefined;

      if (!command || !command.trim()) {
        return this.fail('Command cannot be empty', Date.now() - start);
      }

      const result = await this.runCommand(command, cwd, timeout, extraEnv, signal);
      const output = this.formatOutput(result);

      return this.success(output, Date.now() - start);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return this.fail(`Failed to execute command: ${message}`, Date.now() - start);
    }
  }

  private resolvePath(inputPath: string): string {
    if (path.isAbsolute(inputPath)) {
      return path.normalize(inputPath);
    }
    return path.resolve(this.workspacePath, inputPath);
  }

  private runCommand(
    command: string,
    cwd: string,
    timeout: number,
    extraEnv?: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<InternalCommandStatus> {
    return new Promise((resolve) => {
      const id = `cmd_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const isWindows = process.platform === 'win32';

      const shell = isWindows ? 'cmd.exe' : '/bin/bash';
      const shellArgs = isWindows ? ['/c', command] : ['-c', command];

      const env: Record<string, string> = {
        ...process.env as Record<string, string>,
        PYTHONIOENCODING: 'utf-8',
        PYTHONUTF8: '1',
        ...extraEnv,
      };

      if (isWindows) {
        env.CHCP = '65001';
      }

      if (command.includes('java') || command.includes('javac') || command.includes('mvn') || command.includes('gradle')) {
        const existingOpts = env.JAVA_TOOL_OPTIONS || '';
        env.JAVA_TOOL_OPTIONS = `${existingOpts} -Dfile.encoding=UTF-8`.trim();
      }

      if (this.proxyConfig?.enabled && this.proxyConfig.cmdUseProxy) {
        const proxyServer = this.proxyConfig.server?.trim();
        if (proxyServer) {
          try {
            const proxyUrl = new URL(proxyServer);
            env.http_proxy = proxyServer;
            env.https_proxy = proxyServer;
            env.HTTP_PROXY = proxyServer;
            env.HTTPS_PROXY = proxyServer;
            if (proxyUrl.username || proxyUrl.password) {
              // some tools need this
            }
            env.no_proxy = 'localhost,127.0.0.1';
            env.NO_PROXY = 'localhost,127.0.0.1';
          } catch {}
        }
      }

      const child = spawn(shell, shellArgs, {
        cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });

      const status: InternalCommandStatus = {
        id,
        command,
        cwd,
        status: 'running',
        exitCode: null,
        stdout: '',
        stderr: '',
        startTime: Date.now(),
        pid: child.pid ?? undefined,
      };

      this.activeProcesses.set(id, status);

      let stdoutChunks: Buffer[] = [];
      let stderrChunks: Buffer[] = [];

      child.stdout?.on('data', (chunk: Buffer) => {
        stdoutChunks.push(chunk);
        if (this.onOutput) {
          const text = this.stripAnsi(this.decodeOutput(chunk));
          this.onOutput(id, 'stdout', text);
        }
      });

      child.stderr?.on('data', (chunk: Buffer) => {
        stderrChunks.push(chunk);
        if (this.onOutput) {
          const text = this.stripAnsi(this.decodeOutput(chunk));
          this.onOutput(id, 'stderr', text);
        }
      });

      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

      const cleanup = () => {
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }
        this.activeProcesses.delete(id);
      };

      timeoutHandle = setTimeout(() => {
        status.status = 'timeout';
        this.killProcessTree(child);
        cleanup();
        resolve({ ...status });
      }, timeout);

      // Wire up abort signal to kill the process tree
      const onAbort = () => {
        status.status = 'killed';
        status.endTime = Date.now();
        this.killProcessTree(child);
        cleanup();
        resolve({ ...status });
      };
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });

      child.on('close', (code) => {
        signal?.removeEventListener('abort', onAbort);
        cleanup();

        const rawStdout = Buffer.concat(stdoutChunks);
        const rawStderr = Buffer.concat(stderrChunks);

        const stdout = this.decodeOutput(rawStdout);
        const stderr = this.decodeOutput(rawStderr);

        status.stdout = this.processCarriageReturns(this.stripAnsi(stdout));
        status.stderr = this.processCarriageReturns(this.stripAnsi(stderr));
        status.exitCode = code;
        status.endTime = Date.now();

        if (status.status !== 'timeout') {
          status.status = code === 0 ? 'completed' : 'failed';
        }

        resolve({ ...status });
      });

      child.on('error', (err) => {
        cleanup();
        status.status = 'failed';
        status.stderr = err.message;
        status.exitCode = 1;
        status.endTime = Date.now();
        resolve({ ...status });
      });
    });
  }

  private decodeOutput(buffer: Buffer): string {
    const utf8Text = buffer.toString('utf-8');
    if (!GBK_REGEX.test(utf8Text) || this.containsValidUtf8(utf8Text)) {
      return utf8Text;
    }

    try {
      const iconv = esmRequire('iconv-lite');
      if (iconv.encodingExists('gbk')) {
        const gbkText = iconv.decode(buffer, 'gbk');
        if (!this.containsGarbledText(gbkText)) {
          return gbkText;
        }
      }
    } catch {
      // iconv-lite not available
    }

    return utf8Text;
  }

  private containsValidUtf8(text: string): boolean {
    return !this.containsGarbledText(text);
  }

  private containsGarbledText(text: string): boolean {
    return text.includes('\uFFFD');
  }

  private stripAnsi(text: string): string {
    return text.replace(ANSI_REGEX, '');
  }

  /**
   * Process \r (carriage return) as "move to start of current line and overwrite",
   * matching real terminal behavior. Without this, curl-style progress bars that
   * use \r to refresh in-place produce one line per update instead of one final line.
   */
  private processCarriageReturns(text: string): string {
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

  private truncateOutput(text: string): string {
    if (text.length <= MAX_OUTPUT_LENGTH) return text;

    if (text.length > HEAD_TAIL_THRESHOLD) {
      const head = text.slice(0, HEAD_SIZE);
      const tail = text.slice(-TAIL_SIZE);
      const omitted = text.length - HEAD_SIZE - TAIL_SIZE;
      return `${head}\n\n... (${omitted} characters omitted) ...\n\n${tail}`;
    }

    return text.slice(0, MAX_OUTPUT_LENGTH) + '\n... (output truncated)';
  }

  private formatOutput(status: InternalCommandStatus): string {
    const lines: string[] = [];

    lines.push(`Command: ${status.command}`);
    lines.push(`Working Directory: ${status.cwd}`);
    lines.push(`Status: ${status.status}`);
    lines.push(`Exit Code: ${status.exitCode ?? 'N/A'}`);

    if (status.pid) {
      lines.push(`PID: ${status.pid}`);
    }

    const duration = status.endTime ? status.endTime - status.startTime : Date.now() - status.startTime;
    lines.push(`Duration: ${duration}ms`);

    if (status.exitCode !== null && status.exitCode !== 0) {
      const semanticMsg = EXIT_CODE_MESSAGES[status.exitCode] || `Exit code ${status.exitCode}`;
      lines.push(`Meaning: ${semanticMsg}`);
    }

    lines.push('');

    if (status.stdout) {
      const truncatedStdout = this.truncateOutput(status.stdout);
      lines.push('--- STDOUT ---');
      lines.push(truncatedStdout);
    }

    if (status.stderr) {
      const truncatedStderr = this.truncateOutput(status.stderr);
      lines.push('--- STDERR ---');
      lines.push(truncatedStderr);
    }

    if (!status.stdout && !status.stderr) {
      lines.push('(no output)');
    }

    return lines.join('\n');
  }

  getActiveProcess(id: string): InternalCommandStatus | undefined {
    return this.activeProcesses.get(id);
  }

  killProcess(id: string): boolean {
    const status = this.activeProcesses.get(id);
    if (!status || status.status !== 'running') return false;
    if (status.pid) {
      try {
        this.killByPid(status.pid);
        status.status = 'killed';
        status.endTime = Date.now();
        this.activeProcesses.delete(id);
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }

  private killProcessTree(child: import('child_process').ChildProcess): void {
    // Close stdin first to unblock any processes waiting for input
    try { child.stdin?.end(); } catch {}
    if (child.pid) {
      this.killByPid(child.pid);
    } else {
      child.kill('SIGKILL');
    }
  }

  private killByPid(pid: number): void {
    if (process.platform === 'win32') {
      // Windows: use taskkill /T to kill the entire process tree
      try {
        execSync(`taskkill /pid ${pid} /T /F`, { stdio: 'ignore', timeout: 5000 });
      } catch {
        // fallback: direct kill
        try { process.kill(pid); } catch {}
      }
    } else {
      // Unix: SIGTERM first, then SIGKILL
      try {
        process.kill(-pid, 'SIGTERM');
      } catch {
        try { process.kill(pid, 'SIGKILL'); } catch {}
      }
    }
  }
}
