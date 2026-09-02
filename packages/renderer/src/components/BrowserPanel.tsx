import { useRef, useEffect, useState, useCallback } from 'react';
import {
  ArrowLeft, ArrowRight, RotateCw, X, Shield, Globe, Code2,
} from 'lucide-react';

interface BrowserPanelProps {
  sessionId: string;
  initialUrl?: string;
  onTitleChange?: (title: string) => void;
}

export default function BrowserPanel({ sessionId, initialUrl, onTitleChange }: BrowserPanelProps) {
  const webviewRef = useRef<any>(null);
  const [url, setUrl] = useState(initialUrl || 'about:blank');
  const [inputUrl, setInputUrl] = useState(initialUrl || '');
  const [title, setTitle] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [securityState, setSecurityState] = useState<'secure' | 'insecure' | 'neutral'>('neutral');
  const registeredRef = useRef(false);

  // ── Navigation ──
  const handleNavigate = useCallback((targetUrl: string) => {
    let finalUrl = targetUrl.trim();
    if (!finalUrl) return;
    // Auto-complete protocol
    if (!finalUrl.startsWith('http://') && !finalUrl.startsWith('https://') && !finalUrl.startsWith('file://')) {
      if (finalUrl.includes('.') && !finalUrl.includes(' ')) {
        finalUrl = 'https://' + finalUrl;
      } else {
        finalUrl = `https://www.google.com/search?q=${encodeURIComponent(finalUrl)}`;
      }
    }
    webviewRef.current?.loadURL(finalUrl);
  }, []);

  const handleUrlKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleNavigate(inputUrl);
    }
  };

  // ── Webview event binding ──
  useEffect(() => {
    const wv = webviewRef.current;
    if (!wv) return;

    const onDidStartLoading = () => setIsLoading(true);
    const onDidStopLoading = () => {
      setIsLoading(false);
      setCanGoBack(wv.canGoBack());
      setCanGoForward(wv.canGoForward());
    };
    const onDidNavigate = (e: any) => {
      const navigateUrl = e.url || url;
      setUrl(navigateUrl);
      setInputUrl(navigateUrl);
      setSecurityState(navigateUrl.startsWith('https://') ? 'secure' : 'neutral');
      setCanGoBack(wv.canGoBack());
      setCanGoForward(wv.canGoForward());
    };
    const onDidNavigateInPage = (e: any) => {
      if (e.isMainFrame) {
        const navigateUrl = e.url || url;
        setUrl(navigateUrl);
        setInputUrl(navigateUrl);
      }
    };
    const onPageTitleUpdated = (e: any) => {
      const newTitle = e.title || '';
      setTitle(newTitle);
      onTitleChange?.(newTitle);
    };
    const onDomReady = () => {
      // 强制浅色背景，避免深色模式下 webview 默认深色底导致黑色文字不可见
      wv.insertCSS('html, body { background-color: #ffffff !important; color: #1a1a1a !important; }');
      if (registeredRef.current) return;
      registeredRef.current = true;
      const wcId = wv.getWebContentsId();
      window.electronAPI.invoke('browser:register-webview', { sessionId, webContentsId: wcId });
    };

    wv.addEventListener('did-start-loading', onDidStartLoading);
    wv.addEventListener('did-stop-loading', onDidStopLoading);
    wv.addEventListener('did-navigate', onDidNavigate);
    wv.addEventListener('did-navigate-in-page', onDidNavigateInPage);
    wv.addEventListener('page-title-updated', onPageTitleUpdated);
    wv.addEventListener('dom-ready', onDomReady);

    // 拦截 target="_blank" / window.open()，在当前 webview 内打开
    const onNewWindow = (e: any) => {
      e.preventDefault();
      const newUrl = e.url;
      if (newUrl && newUrl !== 'about:blank') {
        wv.loadURL(newUrl);
      }
    };
    wv.addEventListener('new-window', onNewWindow);

    // 页面加载完成后，移除 target="_blank"，防止新窗口跳转
    const onDidFinishLoad = () => {
      try {
        wv.executeJavaScript(`
          document.querySelectorAll('a[target="_blank"]').forEach(a => {
            a.setAttribute('target', '_self');
          });
          new MutationObserver(() => {
            document.querySelectorAll('a[target="_blank"]').forEach(a => {
              a.setAttribute('target', '_self');
            });
          }).observe(document.body, { childList: true, subtree: true });
        `).catch(() => {});
      } catch {}
    };
    wv.addEventListener('did-finish-load', onDidFinishLoad);

    return () => {
      wv.removeEventListener('did-start-loading', onDidStartLoading);
      wv.removeEventListener('did-stop-loading', onDidStopLoading);
      wv.removeEventListener('did-navigate', onDidNavigate);
      wv.removeEventListener('did-navigate-in-page', onDidNavigateInPage);
      wv.removeEventListener('page-title-updated', onPageTitleUpdated);
      wv.removeEventListener('dom-ready', onDomReady);
      wv.removeEventListener('new-window', onNewWindow);
      wv.removeEventListener('did-finish-load', onDidFinishLoad);
    };
  }, [sessionId, onTitleChange]);

  return (
    <div className="browser-panel">
      {/* ── Toolbar ── */}
      <div className="browser-toolbar">
        <button
          className="browser-nav-btn"
          disabled={!canGoBack}
          onClick={() => webviewRef.current?.goBack()}
          title="后退"
        >
          <ArrowLeft size={14} />
        </button>
        <button
          className="browser-nav-btn"
          disabled={!canGoForward}
          onClick={() => webviewRef.current?.goForward()}
          title="前进"
        >
          <ArrowRight size={14} />
        </button>
        <button
          className={`browser-nav-btn${isLoading ? ' browser-nav-btn-loading' : ''}`}
          onClick={() => isLoading ? webviewRef.current?.stop() : webviewRef.current?.reload()}
          title={isLoading ? '停止' : '刷新'}
        >
          {isLoading ? <X size={14} /> : <RotateCw size={14} />}
        </button>

        <div className="browser-url-bar">
          {securityState === 'secure' && <Shield size={12} className="browser-secure-icon" />}
          <input
            type="text"
            value={inputUrl}
            onChange={(e) => setInputUrl(e.target.value)}
            onKeyDown={handleUrlKeyDown}
            onFocus={(e) => e.currentTarget.select()}
            placeholder="输入网址或搜索..."
            className="browser-url-input"
          />
        </div>

        <button
          className="browser-nav-btn"
          onClick={() => webviewRef.current?.openDevTools()}
          title="打开浏览器 DevTools"
        >
          <Code2 size={14} />
        </button>
      </div>

      {/* ── Webview ── */}
      <webview
        ref={webviewRef as any}
        src={initialUrl || 'about:blank'}
        className="browser-webview"
        {...{ bgcolor: '#ffffff' }}
      />

      <style>{`
        .browser-panel {
          display: flex;
          flex-direction: column;
          height: 100%;
        }
        .browser-toolbar {
          display: flex;
          align-items: center;
          gap: 4px;
          padding: 6px 8px;
          border-bottom: 1px solid var(--border);
          background: var(--bg-secondary);
          flex-shrink: 0;
        }
        .browser-nav-btn {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 28px;
          height: 28px;
          border: none;
          background: transparent;
          color: var(--text-secondary);
          border-radius: var(--radius-sm);
          cursor: pointer;
          transition: background 0.15s, color 0.15s;
          flex-shrink: 0;
        }
        .browser-nav-btn:hover:not(:disabled) {
          background: var(--bg-hover);
          color: var(--text-primary);
        }
        .browser-nav-btn:disabled {
          opacity: 0.3;
          cursor: default;
        }
        .browser-nav-btn-loading {
          color: var(--accent);
          animation: browser-spin-pulse 0.8s ease-in-out infinite;
        }
        @keyframes browser-spin-pulse {
          0% { opacity: 0.6; }
          50% { opacity: 1; }
          100% { opacity: 0.6; }
        }
        .browser-url-bar {
          flex: 1;
          display: flex;
          align-items: center;
          gap: 6px;
          background: var(--bg-primary);
          border: 1px solid var(--border);
          border-radius: 20px;
          padding: 0 12px;
          height: 30px;
          margin: 0 4px;
          transition: border-color 0.15s;
        }
        .browser-url-bar:focus-within {
          border-color: var(--accent);
        }
        .browser-secure-icon {
          color: #5ac8a0;
          flex-shrink: 0;
        }
        .browser-url-input {
          flex: 1;
          border: none;
          background: transparent;
          color: var(--text-primary);
          font-size: 12px;
          font-family: var(--font-mono);
          outline: none;
        }
        .browser-url-input::placeholder {
          color: var(--text-muted);
        }
        .browser-webview {
          flex: 1;
          border: none;
        }
        /* 美化滚动条 */
        .browser-panel ::-webkit-scrollbar {
          width: 6px;
          height: 6px;
        }
        .browser-panel ::-webkit-scrollbar-track {
          background: transparent;
        }
        .browser-panel ::-webkit-scrollbar-thumb {
          background: rgba(128, 128, 128, 0.3);
          border-radius: 3px;
        }
        .browser-panel ::-webkit-scrollbar-thumb:hover {
          background: rgba(128, 128, 128, 0.5);
        }
      `}</style>
    </div>
  );
}