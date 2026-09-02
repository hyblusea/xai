import { readFile } from 'fs/promises';
import { existsSync, statSync } from 'fs';
import path from 'path';
import { ToolDefinition, TOOL_OUTPUT_MAX_CHARS } from '@xai/shared';
import { BaseTool } from './base-tool.js';

export class ReadFileTool extends BaseTool {
  private workspacePath: string;

  constructor(workspacePath: string) {
    super();
    this.workspacePath = workspacePath;
  }

  get definition(): ToolDefinition {
    return {
      name: 'read_file',
      description: 'Read file contents. Supports line range selection. Returns content with line numbers.',
      parameters: {
        path: { type: 'string', description: 'File path (relative or absolute)', required: true, location: 'header' },
        startLine: { type: 'number', description: 'Start line (1-based)', location: 'header' },
        limit: { type: 'number', description: 'Max lines to read', location: 'header' },
      },
      confirmationRequired: false,
      examples: [
        `++++ read_file path:./src/app.ts startLine:10 limit:30
++++ end`,
      ],
    };
  }

  async _execute(params: Record<string, unknown>, _signal?: AbortSignal) {
    const start = Date.now();
    try {
      const filePath = this.resolvePath(params.path as string);
      const startLine = typeof params.startLine === 'number' ? params.startLine : (typeof params.startLine === 'string' ? parseInt(params.startLine, 10) : undefined);
      const limit = typeof params.limit === 'number' ? params.limit : (typeof params.limit === 'string' ? parseInt(params.limit, 10) : undefined);

      if (!existsSync(filePath)) {
        return this.fail(`File not found: ${filePath}`, Date.now() - start);
      }

      const stat = statSync(filePath);
      if (!stat.isFile()) {
        return this.fail(`Path is not a file: ${filePath}`, Date.now() - start);
      }

      const content = await this.readFileWithEncoding(filePath);
      const lines = content.split('\n');
      const readStart = startLine ? Math.max(1, startLine) : 1;
      const endLine = limit ? Math.min(lines.length, readStart + limit - 1) : lines.length;
      const selectedLines = lines.slice(readStart - 1, endLine);

      const maxLineNumWidth = String(endLine).length;
      const numberedContent = selectedLines
        .map((line, i) => {
          const lineNum = String(readStart + i).padStart(maxLineNumWidth, ' ');
          return `${lineNum}│${line}`;
        })
        .join('\n');

      const header = `File: ${path.relative(this.workspacePath, filePath)} (${lines.length} lines total)`;
      const rangeInfo = startLine || limit
        ? `\nShowing lines ${readStart}-${endLine}:`
        : '';
      let output = `${header}${rangeInfo}\n${numberedContent}`;

      // 统一 90KB 阈值：对最终输出截断，且截断标记计入预算，
      // 保证总长不超过 TOOL_OUTPUT_MAX_CHARS，BaseTool 不会二次截断。
      if (output.length > TOOL_OUTPUT_MAX_CHARS) {
        const marker = `\n... [truncated, ${output.length} chars total, use startLine/limit to read specific sections]`;
        output = output.substring(0, TOOL_OUTPUT_MAX_CHARS - marker.length) + marker;
      }

      return this.success(output, Date.now() - start);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('EACCES') || message.includes('EPERM')) {
        return this.fail(`Permission denied: ${params.path}`, Date.now() - start);
      }
      return this.fail(`Failed to read file: ${message}`, Date.now() - start);
    }
  }

  private resolvePath(inputPath: string): string {
    if (path.isAbsolute(inputPath)) {
      return path.normalize(inputPath);
    }
    return path.resolve(this.workspacePath, inputPath);
  }

  private async readFileWithEncoding(filePath: string): Promise<string> {
    const buffer = await readFile(filePath);
    try {
      const content = buffer.toString('utf-8');
      if (this.containsGarbledText(content)) {
        return this.tryAlternativeEncoding(buffer);
      }
      return content;
    } catch {
      return this.tryAlternativeEncoding(buffer);
    }
  }

  private containsGarbledText(text: string): boolean {
    return text.includes('\uFFFD');
  }

  private async tryAlternativeEncoding(buffer: Buffer): Promise<string> {
    try {
      const iconv: typeof import('iconv-lite') = await import('iconv-lite');
      for (const encoding of ['gbk', 'gb2312', 'gb18030', 'big5', 'shift_jis', 'euc-kr', 'iso-8859-1']) {
        if (iconv.encodingExists(encoding)) {
          const content = iconv.decode(buffer, encoding);
          if (!this.containsGarbledText(content)) {
            return content;
          }
        }
      }
    } catch {}
    return buffer.toString('utf-8');
  }
}


