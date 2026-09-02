import { ToolDefinition } from '@xai/shared';
import { BrowserBaseTool } from './browser-base-tool.js';

export class BrowserFileTool extends BrowserBaseTool {
  get definition(): ToolDefinition {
    return {
      name: 'browser_file',
      description: 'File upload/download. Actions: upload (set files on <input type="file">), download (download URL), set-path (change download dir).',
      parameters: {
        sessionId: { type: 'string', description: 'Browser session ID', required: true, location: 'header' },
        action: { type: 'string', description: 'Action: upload, download, set-path', required: true, location: 'header' },
        selector: { type: 'string', description: '<input type="file"> selector (for upload)', required: false, location: 'header' },
        url: { type: 'string', description: 'URL to download (for download)', required: false, location: 'body' },
        filePaths: { type: 'string', description: 'Comma-separated paths (upload: files; set-path: download dir)', required: false, location: 'body' },
      },
      confirmationRequired: false,
      examples: [
        `++++ browser_file sessionId:br-abc123 action:upload selector:#file-input filePaths:/data/report.csv
++++ end`,
      ],
    };
  }

  async _execute(params: Record<string, unknown>, _signal?: AbortSignal) {
    const start = Date.now();
    try {
      const sessionId = params.sessionId as string;
      const action = params.action as string;

      if (!sessionId || !action) {
        return this.fail('sessionId and action parameters are required', Date.now() - start);
      }
      if (!['upload', 'download', 'set-path'].includes(action)) {
        return this.fail('action must be upload, download, or set-path', Date.now() - start);
      }

      const selector = params.selector as string | undefined;
      const url = params.url as string | undefined;
      const filePathsStr = params.filePaths as string | undefined;
      const filePaths = filePathsStr
        ? filePathsStr.split(',').map(p => p.trim()).filter(p => p.length > 0)
        : undefined;

      // Validate required params per action
      if (action === 'upload') {
        if (!selector) return this.fail('selector is required for upload action', Date.now() - start);
        if (!filePaths?.length) return this.fail('filePaths is required for upload action', Date.now() - start);
      }
      if (action === 'download') {
        if (!url) return this.fail('url is required for download action', Date.now() - start);
      }
      if (action === 'set-path') {
        if (!filePaths?.length) return this.fail('filePaths is required for set-path action', Date.now() - start);
      }

      const result = await this.invokeIPC<{ data?: unknown }>('browser:file', {
        sessionId, action, selector, url, filePaths,
      });

      if (action === 'upload') {
        const data = result.data as { uploaded: number };
        return this.success(`Successfully uploaded ${data.uploaded} file(s) to ${selector}`, Date.now() - start);
      }

      if (action === 'download') {
        const data = result.data as { downloadPath: string; downloads: Array<{ filename: string; state: string; path: string }> };
        let output = `Download initiated. Save directory: ${data.downloadPath}`;
        if (data.downloads?.length) {
          output += '\nRecent downloads:\n' + data.downloads.map(d =>
            `  ${d.filename} [${d.state}] → ${d.path}`
          ).join('\n');
        }
        return this.success(output, Date.now() - start);
      }

      if (action === 'set-path') {
        const data = result.data as { downloadPath: string };
        return this.success(`Download path set to: ${data.downloadPath}`, Date.now() - start);
      }

      return this.success('File operation completed.', Date.now() - start);
    } catch (error) {
      return this.fail(`browser_file failed: ${error instanceof Error ? error.message : String(error)}`, Date.now() - start);
    }
  }
}
