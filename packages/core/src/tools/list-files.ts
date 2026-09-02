import { readdir, stat, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { ToolDefinition } from '@xai/shared';
import { BaseTool } from './base-tool.js';

interface FileEntry {
  name: string;
  relativePath: string;
  isDirectory: boolean;
  children?: FileEntry[];
}

export class ListFilesTool extends BaseTool {
  private workspacePath: string;

  constructor(workspacePath: string) {
    super();
    this.workspacePath = workspacePath;
  }

  get definition(): ToolDefinition {
    return {
      name: 'list_files',
      description: 'List files/dirs in path. Supports recursive listing, glob filtering, respects .gitignore.',
      parameters: {
        path: { type: 'string', description: 'Directory path (relative or absolute)', required: true, location: 'header' },
        recursive: { type: 'boolean', description: 'List recursively', default: false, location: 'header' },
        pattern: { type: 'string', description: 'Glob filter (*.xxx, *.{ts,tsx} etc)', default: '*.*', location: 'header' },
      },
      confirmationRequired: false,
      examples: [
        `++++ list_files path:src recursive:true pattern:*.{ts,tsx}
++++ end`,
      ],
    };
  }

  async _execute(params: Record<string, unknown>, _signal?: AbortSignal) {
    const start = Date.now();
    try {
      const dirPath = this.resolvePath(params.path as string);
      const recursive = params.recursive === true || params.recursive === 'true';
      const pattern = (params.pattern as string) ?? '*.*';

      if (!existsSync(dirPath)) {
        return this.fail(`Directory not found: ${dirPath}`, Date.now() - start);
      }

      const dirStat = await stat(dirPath);
      if (!dirStat.isDirectory()) {
        return this.fail(`Path is not a directory: ${dirPath}`, Date.now() - start);
      }

      const gitignorePatterns = await this.loadGitignore(dirPath);
      const entries = await this.listDirectory(dirPath, dirPath, recursive, gitignorePatterns);

      const filteredEntries = this.filterByPattern(entries, pattern);

      const output = this.formatFileTree(filteredEntries, dirPath);
      const fileCount = this.countFiles(filteredEntries);
      const dirCount = this.countDirs(filteredEntries);

      return this.success(`${output}\n\n${fileCount} file(s), ${dirCount} directory(es)`, Date.now() - start);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('EACCES') || message.includes('EPERM')) {
        return this.fail(`Permission denied: ${params.path}`, Date.now() - start);
      }
      return this.fail(`Failed to list directory: ${message}`, Date.now() - start);
    }
  }

  private resolvePath(inputPath: string): string {
    if (path.isAbsolute(inputPath)) {
      return path.normalize(inputPath);
    }
    return path.resolve(this.workspacePath, inputPath);
  }

  private async loadGitignore(dirPath: string): Promise<string[]> {
    const patterns: string[] = [
      'node_modules', '.git', '.svn', '.hg',
      '__pycache__', '.DS_Store', 'Thumbs.db',
      '.idea', '.vscode', 'dist', 'build', '.next', '.nuxt',
      'coverage', '.cache', '.tmp', '.temp',
    ];

    const gitignorePath = path.join(dirPath, '.gitignore');
    if (existsSync(gitignorePath)) {
      try {
        const content = await readFile(gitignorePath, 'utf-8');
        const customPatterns = content
          .split('\n')
          .map(line => line.trim())
          .filter(line => line && !line.startsWith('#'));
        patterns.push(...customPatterns);
      } catch {
        // ignore gitignore read errors
      }
    }

    return patterns;
  }

  private isIgnored(name: string, gitignorePatterns: string[]): boolean {
    for (const pattern of gitignorePatterns) {
      if (pattern.endsWith('/')) {
        if (name === pattern.slice(0, -1)) return true;
      } else if (pattern.startsWith('*.')) {
        const ext = pattern.slice(1);
        if (name.endsWith(ext)) return true;
      } else if (pattern.startsWith('!')) {
        if (name === pattern.slice(1)) return false;
      } else {
        if (name === pattern) return true;
      }
    }
    return false;
  }

  private async listDirectory(
    dirPath: string,
    rootPath: string,
    recursive: boolean,
    gitignorePatterns: string[],
  ): Promise<FileEntry[]> {
    const entries = await readdir(dirPath, { withFileTypes: true });
    const result: FileEntry[] = [];

    const sortedEntries = entries.sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name);
    });

    for (const entry of sortedEntries) {
      if (this.isIgnored(entry.name, gitignorePatterns)) continue;

      const fullPath = path.join(dirPath, entry.name);
      const relativePath = path.relative(rootPath, fullPath);

      if (entry.isDirectory()) {
        const fileEntry: FileEntry = {
          name: entry.name,
          relativePath,
          isDirectory: true,
        };

        if (recursive) {
          try {
            fileEntry.children = await this.listDirectory(fullPath, rootPath, recursive, gitignorePatterns);
          } catch {
            fileEntry.children = [];
          }
        }

        result.push(fileEntry);
      } else if (entry.isFile()) {
        result.push({
          name: entry.name,
          relativePath,
          isDirectory: false,
        });
      }
    }

    return result;
  }

  private filterByPattern(entries: FileEntry[], pattern: string): FileEntry[] {
    const regex = this.globToRegex(pattern);
    const result: FileEntry[] = [];

    for (const entry of entries) {
      if (entry.isDirectory) {
        if (!entry.children) {
          // 非递归模式：目录没有children，直接保留，不受pattern过滤
          result.push(entry);
        } else {
          // 递归模式：根据pattern过滤子内容
          const filteredChildren = this.filterByPattern(entry.children, pattern);
          const dirMatches = regex.test(entry.name);
          if (filteredChildren.length > 0 || dirMatches) {
            result.push({ ...entry, children: filteredChildren });
          }
        }
      } else {
        if (regex.test(entry.name)) {
          result.push(entry);
        }
      }
    }

    return result;
  }

  private globToRegex(pattern: string): RegExp {
    const parts: string[] = [];
    let i = 0;

    while (i < pattern.length) {
      if (pattern[i] === '{') {
        const end = pattern.indexOf('}', i);
        if (end !== -1) {
          const alternatives = pattern.substring(i + 1, end)
            .split(',')
            .map(s => s.trim())
            .filter(s => s.length > 0);
          if (alternatives.length > 0) {
            parts.push('(' + alternatives.map(a => this.escapeRegex(a)).join('|') + ')');
            i = end + 1;
            continue;
          }
        }
      }

      if (pattern[i] === '*' && pattern[i + 1] === '*') {
        parts.push('.*');
        i += 2;
        continue;
      }

      if (pattern[i] === '*') {
        parts.push('[^/]*');
        i++;
        continue;
      }

      if (pattern[i] === '?') {
        parts.push('[^/]');
        i++;
        continue;
      }

      if (/[.+^${}()|[\]\\]/.test(pattern[i])) {
        parts.push('\\' + pattern[i]);
      } else {
        parts.push(pattern[i]);
      }
      i++;
    }

    return new RegExp(`^${parts.join('')}$`);
  }

  private escapeRegex(str: string): string {
    return str.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }

  private formatFileTree(entries: FileEntry[], rootPath: string, prefix: string = ''): string {
    const lines: string[] = [];
    const rootName = path.basename(rootPath);

    if (prefix === '') {
      lines.push(`${rootName}/`);
    }

    for (let i = 0; i < entries.length; i++) {
      const isLast = i === entries.length - 1;
      const connector = isLast ? '└── ' : '├── ';
      const childPrefix = isLast ? '    ' : '│   ';

      if (entries[i].isDirectory) {
        lines.push(`${prefix}${connector}${entries[i].name}/`);
        if (entries[i].children && entries[i].children!.length > 0) {
          lines.push(this.formatFileTree(entries[i].children ?? [], rootPath, prefix + childPrefix));
        }
      } else {
        lines.push(`${prefix}${connector}${entries[i].name}`);
      }
    }

    return lines.join('\n');
  }

  private countFiles(entries: FileEntry[]): number {
    let count = 0;
    for (const entry of entries) {
      if (entry.isDirectory) {
        count += entry.children ? this.countFiles(entry.children) : 0;
      } else {
        count++;
      }
    }
    return count;
  }

  private countDirs(entries: FileEntry[]): number {
    let count = 0;
    for (const entry of entries) {
      if (entry.isDirectory) {
        count++;
        count += entry.children ? this.countDirs(entry.children) : 0;
      }
    }
    return count;
  }
}


