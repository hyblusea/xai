import { BrowserWindow } from 'electron';
import type { ProxyConfig } from '@xai/shared';

export interface FetchWebContentOptions {
  maxLength?: number;
  timeout?: number;
  proxy?: ProxyConfig;
}

export interface FetchWebContentResult {
  content: string;
  title: string;
  url: string;
}

export async function fetchWebContent(
  url: string,
  options: FetchWebContentOptions = {}
): Promise<FetchWebContentResult> {
  return new Promise((resolve, reject) => {
    const win = new BrowserWindow({
      show: false,
      width: 1280,
      height: 800,
      webPreferences: {
        offscreen: true,
        nodeIntegration: false,
        contextIsolation: true,
      },
    });

    // 代理配置
    if (options.proxy?.enabled && !options.proxy.useSystemProxy && options.proxy.server) {
      win.webContents.session.setProxy({
        proxyURL: options.proxy.server,
      });
    }

    const timeout = setTimeout(() => {
      win.destroy();
      reject(new Error('Fetch timeout'));
    }, options.timeout || 30000);

    win.webContents.on('did-finish-load', async () => {
      clearTimeout(timeout);

      try {
        // 在页面中执行 JS：智能提取 + 紧凑格式化
        const result = await win.webContents.executeJavaScript(`
          (function() {
            const target = document.body;

            if (!target) return { content: '', title: document.title };

            // 1. 克隆目标节点
            const clone = target.cloneNode(true);

            // 2. 移除噪音元素
            const noiseSelectors = [
              'script', 'style', 'noscript', 'iframe', 'svg',
              'nav', 'footer', 'header', '.ad', '.ads', '.sidebar',
              '.cookie-banner', '.popup', '.modal', '#comments',
              '.social-share', '.related-posts', '.breadcrumb',
              '[role="navigation"]', '[role="banner"]', '[role="contentinfo"]'
            ];
            clone.querySelectorAll(noiseSelectors.join(',')).forEach(el => el.remove());

            // 3. 提取文本（innerText 自动处理空白和换行）
            const rawText = clone.innerText;

            // 4. 压缩空白
            const content = rawText
              .split('\\n')
              .map(line => line.trim())
              .filter((line, i, arr) => !(line === '' && arr[i-1] === ''))
              .join('\\n');

            return { content, title: document.title };
          })()
        `);

        win.destroy();

        const maxLen = options.maxLength || 50000;
        const truncated = result.content.length > maxLen
          ? result.content.substring(0, maxLen) + '\n\n[... 内容已截断 ...]'
          : result.content;

        resolve({
          content: truncated,
          title: result.title,
          url: win.webContents.getURL(),
        });
      } catch (err) {
        win.destroy();
        reject(err);
      }
    });

    win.webContents.on('did-fail-load', (_event, _errorCode, errorDesc) => {
      clearTimeout(timeout);
      win.destroy();
      reject(new Error(`Load failed: ${errorDesc}`));
    });

    win.loadURL(url);
  });
}
