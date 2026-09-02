import { spawn, ChildProcess } from 'child_process';
import { createInterface, Interface } from 'readline';
import { randomUUID } from 'crypto';
import type { MCPServerConfig, MCPToolInfo, ToolParameter } from '@xai/shared';

interface MCPRequest {
  jsonrpc: '2.0';
  id: string;
  method: string;
  params?: Record<string, unknown>;
}

interface MCPResponse {
  jsonrpc: '2.0';
  id: string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class MCPClient {
  private config: MCPServerConfig;
  private process: ChildProcess | null = null;
  private rl: Interface | null = null;
  private pending: Map<string, PendingRequest> = new Map();
  private _connected = false;
  private _tools: MCPToolInfo[] = [];
  private buffer = '';
  private requestId = 0;

  constructor(config: MCPServerConfig) {
    this.config = config;
  }

  get connected(): boolean {
    return this._connected;
  }

  get tools(): MCPToolInfo[] {
    return this._tools;
  }

  get serverName(): string {
    return this.config.name;
  }

  async connect(): Promise<void> {
    if (this._connected) return;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`MCP Server "${this.config.name}" connection timeout`));
        this.kill();
      }, 15000);

      try {
        const env: Record<string, string> = { ...process.env as Record<string, string> };
        if (this.config.env) {
          Object.assign(env, this.config.env);
        }

        this.process = spawn(this.config.command, this.config.args, {
          env,
          stdio: ['pipe', 'pipe', 'pipe'],
          shell: true,
        });

        if (!this.process.stdin || !this.process.stdout) {
          clearTimeout(timeout);
          reject(new Error(`Failed to create stdio pipes for "${this.config.name}"`));
          this.kill();
          return;
        }

        this.rl = createInterface({ input: this.process.stdout });

        this.rl.on('line', (line: string) => {
          this.handleMessage(line);
        });

        this.process.stderr?.on('data', (data: Buffer) => {
          const msg = data.toString().trim();
          if (msg) {
            console.log(`[MCP:${this.config.name}:stderr] ${msg.substring(0, 200)}`);
          }
        });

        this.process.on('error', (err) => {
          console.error(`[MCP:${this.config.name}] Process error:`, err.message);
          clearTimeout(timeout);
          this._connected = false;
          reject(err);
        });

        this.process.on('exit', (code) => {
          console.log(`[MCP:${this.config.name}] Process exited with code ${code}`);
          this._connected = false;
          clearTimeout(timeout);
        });

        this.initialize()
          .then(() => {
            clearTimeout(timeout);
            resolve();
          })
          .catch((err) => {
            clearTimeout(timeout);
            reject(err);
          });
      } catch (err) {
        clearTimeout(timeout);
        reject(err);
      }
    });
  }

  private async initialize(): Promise<void> {
    const result = await this.sendRequest('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'xai-ide', version: '0.1.0' },
    }) as { capabilities?: Record<string, unknown>; serverInfo?: { name?: string; version?: string } };

    console.log(`[MCP:${this.config.name}] Initialized: ${result.serverInfo?.name || 'unknown'} v${result.serverInfo?.version || '?'}`);

    this.sendNotification('notifications/initialized');

    await this.refreshTools();
    this._connected = true;
  }

  async refreshTools(): Promise<MCPToolInfo[]> {
    const result = await this.sendRequest('tools/list', {}) as {
      tools?: Array<{
        name: string;
        description?: string;
        inputSchema?: {
          type?: string;
          properties?: Record<string, unknown>;
          required?: string[];
        };
      }>;
    };

    this._tools = (result.tools || []).map((tool) => {
      const parameters: Record<string, ToolParameter> = {};
      if (tool.inputSchema?.properties) {
        const required = new Set(tool.inputSchema.required || []);
        for (const [key, val] of Object.entries(tool.inputSchema.properties)) {
          const schema = val as Record<string, unknown>;
          parameters[key] = {
            type: (schema.type as string) || 'string',
            description: (schema.description as string) || '',
            required: required.has(key),
            enum: schema.enum as string[] | undefined,
            default: schema.default,
          };
        }
      }

      return {
        serverName: this.config.name,
        name: tool.name,
        description: tool.description || '',
        parameters,
      };
    });

    console.log(`[MCP:${this.config.name}] Found ${this._tools.length} tools`);
    return this._tools;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const result = await this.sendRequest('tools/call', {
      name,
      arguments: args,
    }) as { content?: Array<{ type: string; text?: string }>; isError?: boolean };

    if (result.isError) {
      const errorText = result.content?.map(c => c.text || '').join('\n') || 'Unknown MCP tool error';
      throw new Error(errorText);
    }

    if (result.content && Array.isArray(result.content)) {
      return result.content.map(c => c.text || '').join('\n');
    }

    return JSON.stringify(result);
  }

  private sendRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = String(++this.requestId);
      const request: MCPRequest = { jsonrpc: '2.0', id, method, params };

      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request timeout: ${method} (id=${id})`));
      }, 30000);

      this.pending.set(id, { resolve, reject, timer });

      const message = JSON.stringify(request) + '\n';
      this.process?.stdin?.write(message, (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(new Error(`Failed to write to MCP server: ${err.message}`));
        }
      });
    });
  }

  private sendNotification(method: string, params?: Record<string, unknown>): void {
    const notification = { jsonrpc: '2.0', method, params: params || {} };
    const message = JSON.stringify(notification) + '\n';
    this.process?.stdin?.write(message);
  }

  private handleMessage(line: string): void {
    let data: MCPResponse;
    try {
      data = JSON.parse(line);
    } catch {
      return;
    }

    if (data.id && this.pending.has(data.id)) {
      const pending = this.pending.get(data.id)!;
      clearTimeout(pending.timer);
      this.pending.delete(data.id);

      if (data.error) {
        pending.reject(new Error(data.error.message));
      } else {
        pending.resolve(data.result);
      }
    }
  }

  kill(): void {
    this._connected = false;
    this._tools = [];

    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error('MCP server disconnected'));
    }
    this.pending.clear();

    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }

    if (this.process) {
      try {
        this.process.kill();
      } catch {}
      this.process = null;
    }
  }
}
