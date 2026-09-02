import { readFile } from 'fs/promises';
import { existsSync, statSync } from 'fs';
import path from 'path';
import { ToolDefinition } from '@xai/shared';
import { BaseTool } from '../base-tool.js';
import { convertToMarkdown, SUPPORTED_EXTENSIONS } from './converter.js';

/**
 * AI-callable tool that converts an Office document to minimal Markdown.
 *
 * Supports .docx, .xlsx, .xls, .xlsm, .csv, .pdf.
 * The same converter is shared with the chat-input paste feature, so AI
 * and users get identical output.
 */
export class Office2MdTool extends BaseTool {
  private workspacePath: string;

  constructor(workspacePath: string) {
    super();
    this.workspacePath = workspacePath;
  }

  get definition(): ToolDefinition {
    return {
      name: 'office2md',
      description:
        'Convert Office/PDF/CSV to Markdown. Supports: ' + SUPPORTED_EXTENSIONS.map((e) => '.' + e).join(', ') + '. ' +
        'Tables→GFM; images stripped.',
      parameters: {
        path: { type: 'string', description: 'File path (relative or absolute)', required: true, location: 'header' },
        maxRows: { type: 'number', description: 'Excel: max rows per sheet (default 200)', location: 'header' },
        maxCols: { type: 'number', description: 'Excel: max columns per sheet (default 30)', location: 'header' },
        maxPages: { type: 'number', description: 'PDF: max pages to convert, 0 = all (default 0)', location: 'header' },
      },
      confirmationRequired: false,
      examples: [
        `++++ office2md path:./docs/report.docx
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
      if (!statSync(filePath).isFile()) {
        return this.fail(`Not a file: ${filePath}`, Date.now() - start);
      }

      const data = await readFile(filePath);
      const filename = path.basename(filePath);

      const markdown = await convertToMarkdown(data, filename, {
        maxRows: typeof params.maxRows === 'number' ? params.maxRows : undefined,
        maxCols: typeof params.maxCols === 'number' ? params.maxCols : undefined,
        maxPages: typeof params.maxPages === 'number' ? params.maxPages : undefined,
      });

      const relativePath = path.relative(this.workspacePath, filePath) || filePath;
      const header = `Converted ${relativePath} (${data.length} bytes → ${markdown.length} chars)`;
      return this.success(`${header}\n\n${markdown}`, Date.now() - start);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return this.fail(`office2md failed: ${message}`, Date.now() - start);
    }
  }

  private resolvePath(inputPath: string): string {
    if (path.isAbsolute(inputPath)) {
      return path.normalize(inputPath);
    }
    return path.resolve(this.workspacePath, inputPath);
  }
}
