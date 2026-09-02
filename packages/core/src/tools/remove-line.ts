import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { ToolDefinition } from '@xai/shared';
import { BaseTool } from './base-tool.js';

export class RemoveLineTool extends BaseTool {
  private workspacePath: string;

  constructor(workspacePath: string) {
    super();
    this.workspacePath = workspacePath;
  }

  get definition(): ToolDefinition {
    return {
      name: 'remove_line',
      description: 'Remove lines from a file by line range (inclusive).',
      parameters: {
        path: { type: 'string', description: 'File path (relative or absolute)', required: true, location: 'header' },
        startLine: { type: 'number', description: 'First line to remove (1-based, inclusive)', required: true, location: 'header' },
        endLine: { type: 'number', description: 'Last line to remove (default: same as startLine)', location: 'header' },
      },
      confirmationRequired: false,
      examples: [
        `++++ remove_line path:./src/app.ts startLine:10 endLine:15
++++ end`,
      ],
    };
  }

  async _execute(params: Record<string, unknown>, _signal?: AbortSignal) {
    const start = Date.now();
    try {
      const filePath = this.resolvePath(params.path as string);

      if (!existsSync(filePath)) {
        return this.fail(`File not found: ${filePath}`, Date.now() - start);
      }

      const startLine = this.toInt(params.startLine);

      if (startLine === null || isNaN(startLine)) {
        return this.fail('startLine is required and must be a number', Date.now() - start);
      }

      const endLineRaw = this.toInt(params.endLine);
      const endLine = endLineRaw !== null ? endLineRaw : startLine;

      if (startLine < 1) {
        return this.fail('startLine must be >= 1', Date.now() - start);
      }

      if (endLine < startLine) {
        return this.fail('endLine must be >= startLine', Date.now() - start);
      }

      const originalContent = await readFile(filePath, 'utf-8');
      const lines = originalContent.split('\n');
      const totalLines = lines.length;

      if (startLine > totalLines) {
        return this.fail(`startLine ${startLine} exceeds file length (${totalLines} lines)`, Date.now() - start);
      }

      const clampedEndLine = Math.min(endLine, totalLines);
      const removedCount = clampedEndLine - startLine + 1;

      // Show what's being removed
      const removedLines = lines.slice(startLine - 1, clampedEndLine);

      // Remove the lines
      const newLines = [...lines.slice(0, startLine - 1), ...lines.slice(clampedEndLine)];
      const newContent = newLines.join('\n');

      if (newContent === originalContent) {
        return this.fail('No changes made - removal produces identical content', Date.now() - start);
      }

      await writeFile(filePath, newContent, 'utf-8');

      const relativePath = path.relative(this.workspacePath, filePath);
      let output = `Removed ${removedCount} line(s) from: ${relativePath}\n`;
      output += `Lines: ${totalLines} → ${newLines.length} (-${removedCount})`;

      // Show removed content
      output += '\n\n--- Removed Lines ---\n';
      const maxLineNumWidth = String(clampedEndLine).length;
      for (let i = 0; i < removedLines.length; i++) {
        const lineNum = String(startLine + i).padStart(maxLineNumWidth, ' ');
        output += `${lineNum} - ${removedLines[i]}\n`;
      }

      return this.success(output.trimEnd(), Date.now() - start);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('EACCES') || message.includes('EPERM')) {
        return this.fail(`Permission denied: ${params.path}`, Date.now() - start);
      }
      return this.fail(`Failed to remove lines: ${message}`, Date.now() - start);
    }
  }

  private toInt(value: unknown): number | null {
    if (value === undefined || value === null) return null;
    if (typeof value === 'number') return value;
    const parsed = parseInt(String(value), 10);
    return isNaN(parsed) ? null : parsed;
  }

  private resolvePath(inputPath: string): string {
    if (path.isAbsolute(inputPath)) {
      return path.normalize(inputPath);
    }
    return path.resolve(this.workspacePath, inputPath);
  }
}
