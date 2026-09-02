import { writeFile, mkdir, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { ToolDefinition } from '@xai/shared';
import { BaseTool } from './base-tool.js';

export class WriteFileTool extends BaseTool {
  private workspacePath: string;
  /**
   * Optional write-path whitelist (relative to workspacePath). When set,
   * any target that does not match one of these entries is rejected before
   * touching the filesystem. Used by designer edit mode to hard-block the AI
   * from creating new files — the prompt is a soft hint, this is the hard
   * guard. `undefined` means no restriction (legacy behaviour).
   */
  private restrictToFiles: string[] | undefined;

  constructor(workspacePath: string, restrictToFiles?: string[]) {
    super();
    this.workspacePath = workspacePath;
    if (restrictToFiles && restrictToFiles.length > 0) {
      // Normalize each entry to a workspace-relative POSIX-style path so
      // comparisons survive "./" prefixes, Windows backslashes, etc.
      this.restrictToFiles = restrictToFiles.map(f =>
        path.normalize(f).replace(/^[\/\\]+/, '').replace(/\\/g, '/')
      );
    }
  }

  get definition(): ToolDefinition {
    return {
      name: 'write_to_file',
      description: 'Write content to file. Creates if missing, overwrites if exists. start_line to insert at specific line.',
      parameters: {
        path: { type: 'string', description: 'File path (relative or absolute)', required: true, location: 'header' },
        content: { type: 'string', description: 'Content to write', required: true, location: 'body' },
        createDirs: { type: 'boolean', description: 'Create parent dirs if needed', default: true, location: 'header' },
        start_line: { type: 'number', description: 'Insert at line (1-based, existing files only, default: end)', required: false, location: 'header' },
      },
      confirmationRequired: true,
      contentMode: 'native',
      examples: [
        `++++ write_to_file path:./src/new-module.ts
  console.log('Hello, world!');
++++ end`,
      ],
    };
  }

  async _execute(params: Record<string, unknown>, _signal?: AbortSignal) {
    const start = Date.now();
    try {
      const filePath = this.resolvePath(params.path as string);
      const content = params.content as string;
      const createDirs = params.createDirs === undefined
        ? true
        : params.createDirs === true || params.createDirs === 'true';

      if (!filePath || content === undefined || content === null) {
        return this.fail('Missing required parameters: path and content', Date.now() - start);
      }

      // Hard whitelist guard. We check this BEFORE any filesystem mutation
      // (mkdir/writeFile), so a rejected call leaves zero side effects. This
      // is what actually prevents the AI from creating new files in designer
      // edit mode even when it ignores the system-prompt instructions.
      if (this.restrictToFiles) {
        const rel = path.relative(this.workspacePath, filePath);
        const normalizedRel = path.normalize(rel).replace(/^[\/\\]+/, '').replace(/\\/g, '/');
        if (!this.restrictToFiles.includes(normalizedRel)) {
          const allowed = this.restrictToFiles.join(', ');
          return this.fail(
            `Write denied: in this mode you may only modify ${allowed}. ` +
            `Attempted target "${normalizedRel}" is not allowed. ` +
            `Do NOT create new files — apply changes to the existing file via write_to_file or replace_in_file.`,
            Date.now() - start
          );
        }
      }

      const dirPath = path.dirname(filePath);
      if (!existsSync(dirPath)) {
        if (createDirs) {
          await mkdir(dirPath, { recursive: true });
        } else {
          return this.fail(`Parent directory does not exist: ${dirPath}. Set createDirs to true to auto-create.`, Date.now() - start);
        }
      }

      const isNewFile = !existsSync(filePath);
      let originalContent = '';
      if (!isNewFile) {
        try {
          originalContent = await readFile(filePath, 'utf-8');
        } catch {}
      }

      // start_line mode: insert content at a specific line in an existing file
      const startLine = params.start_line != null ? (params.start_line as number) : undefined;
      let finalContent: string;
      let insertMode = false;

      if (startLine != null && !isNewFile) {
        const lines = originalContent.split('\n');
        if (startLine < 1 || startLine > lines.length + 1) {
          return this.fail(`Invalid start_line: ${startLine}. File has ${lines.length} lines. Valid range: 1-${lines.length + 1}`, Date.now() - start);
        }
        const contentLines = content.split('\n');
        lines.splice(startLine - 1, 0, ...contentLines);
        finalContent = lines.join('\n');
        insertMode = true;
      } else if (startLine != null && isNewFile) {
        return this.fail(`Cannot use start_line on a new file: ${filePath}`, Date.now() - start);
      } else {
        finalContent = content;
      }

      await writeFile(filePath, finalContent, 'utf-8');

      const relativePath = path.relative(this.workspacePath, filePath);

      if (insertMode) {
        const lines = finalContent.split('\n');
        const originalLineCount = lines.length - content.split('\n').length;
        const newLineCount = lines.length;
        const addedLines = newLineCount - originalLineCount;
        const contentLines = content.split('\n');

        let output = `Inserted into: ${relativePath}\n`;
        output += `Lines: ${originalLineCount} → ${newLineCount} (+${addedLines})\n`;
        output += `Inserted at line: ${startLine}\n`;
        output += `Size: +${Buffer.byteLength(content, 'utf-8')} bytes`;

        output += '\n\n--- Inserted Content ---\n';
        const displayStart = Math.max(1, startLine! - 2);
        const displayEnd = Math.min(newLineCount, startLine! + contentLines.length + 1);
        const maxLineNumWidth = String(newLineCount).length;

        for (let i = displayStart; i <= displayEnd; i++) {
          const lineNum = String(i).padStart(maxLineNumWidth, ' ');
          const marker = i >= startLine! && i < startLine! + contentLines.length ? '+' : ' ';
          output += `${lineNum}${marker}${lines[i - 1]}\n`;
        }

        return this.success(output.trimEnd(), Date.now() - start);
      }

      const lineCount = finalContent.split('\n').length;
      const status = isNewFile ? 'Created' : 'Overwritten';
      let output = `${status} file: ${relativePath}\nLines: ${lineCount}\nSize: ${Buffer.byteLength(finalContent, 'utf-8')} bytes`;

      if (!isNewFile && originalContent !== finalContent) {
        output += '\n\n--- Changes ---\n';
        const diff = this.generateDiff(originalContent, finalContent, relativePath);
        output += diff;
      }

      return this.success(output, Date.now() - start);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('EACCES') || message.includes('EPERM')) {
        return this.fail(`Permission denied: ${params.path}`, Date.now() - start);
      }
      return this.fail(`Failed to write file: ${message}`, Date.now() - start);
    }
  }

  private resolvePath(inputPath: string): string {
    if (path.isAbsolute(inputPath)) {
      return path.normalize(inputPath);
    }
    return path.resolve(this.workspacePath, inputPath);
  }

  private generateDiff(original: string, modified: string, filePath: string): string {
    const originalLines = original.split('\n');
    const modifiedLines = modified.split('\n');
    const lines: string[] = [];

    lines.push(`--- a/${filePath}`);
    lines.push(`+++ b/${filePath}`);

    let oIdx = 0;
    let mIdx = 0;

    while (oIdx < originalLines.length || mIdx < modifiedLines.length) {
      if (oIdx < originalLines.length && mIdx < modifiedLines.length) {
        if (originalLines[oIdx] === modifiedLines[mIdx]) {
          oIdx++;
          mIdx++;
          continue;
        }

        const changeStart = Math.min(oIdx, mIdx);
        let oEnd = oIdx;
        let mEnd = mIdx;

        while (oEnd < originalLines.length && mEnd < modifiedLines.length) {
          if (originalLines[oEnd] === modifiedLines[mEnd]) break;
          oEnd++;
          mEnd++;
        }

        const contextBefore = 2;
        const contextAfter = 2;
        const displayStart = Math.max(0, changeStart - contextBefore);
        const displayEndO = Math.min(originalLines.length, oEnd + contextAfter);
        const displayEndM = Math.min(modifiedLines.length, mEnd + contextAfter);

        lines.push(`@@ -${displayStart + 1},${displayEndO - displayStart} +${displayStart + 1},${displayEndM - displayStart} @@`);

        for (let i = displayStart; i < changeStart; i++) {
          lines.push(` ${originalLines[i]}`);
        }

        for (let i = changeStart; i < oEnd; i++) {
          if (i < originalLines.length) {
            lines.push(`-${originalLines[i]}`);
          }
        }

        for (let i = changeStart; i < mEnd; i++) {
          if (i < modifiedLines.length) {
            lines.push(`+${modifiedLines[i]}`);
          }
        }

        for (let i = oEnd; i < displayEndO && i < originalLines.length; i++) {
          lines.push(` ${originalLines[i]}`);
        }

        oIdx = oEnd;
        mIdx = mEnd;
      } else if (oIdx < originalLines.length) {
        lines.push(`-${originalLines[oIdx]}`);
        oIdx++;
      } else {
        lines.push(`+${modifiedLines[mIdx]}`);
        mIdx++;
      }
    }

    return lines.join('\n');
  }
}
