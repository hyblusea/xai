import { useRef, useEffect, useState, useCallback } from 'react';
import { ShieldCheck, X, RotateCcw, ExternalLink } from 'lucide-react';

interface CaptchaInfo {
  engine: string;
  url: string;
}

interface CaptchaViewProps {
  captcha: CaptchaInfo;
  onResolved: () => void;
  onDismiss: () => void;
}

/**
 * CaptchaView renders the search engine CAPTCHA page in an Electron <webview>
 * so the user can manually complete verification.
 */
export default function CaptchaView({ captcha, onResolved, onDismiss }: CaptchaViewProps) {
  const webviewRef = useRef<HTMLElement>(null);
  const [loading, setLoading] = useState(true);
  const [pageUrl, setPageUrl] = useState(captcha.url);

  useEffect(() => {
    const wv = webviewRef.current as any;
    if (!wv) return;

    const onDidFinishLoad = () => {
      setLoading(false);
      // Track URL changes (e.g. after CAPTCHA redirect)
      try {
        const currentUrl = wv.getURL?.();
        if (currentUrl) setPageUrl(currentUrl);
      } catch { /* ignore */ }
    };

    const onDidFailLoad = () => {
      setLoading(false);
    };

    const onDidNavigate = (_e: any) => {
      try {
        const currentUrl = wv.getURL?.();
        if (currentUrl) setPageUrl(currentUrl);
      } catch { /* ignore */ }
    };

    wv.addEventListener('did-finish-load', onDidFinishLoad);
    wv.addEventListener('did-fail-load', onDidFailLoad);
    wv.addEventListener('did-navigate', onDidNavigate);

    return () => {
      wv.removeEventListener?.('did-finish-load', onDidFinishLoad);
      wv.removeEventListener?.('did-fail-load', onDidFailLoad);
      wv.removeEventListener?.('did-navigate', onDidNavigate);
    };
  }, [captcha.url]);

  const handleReload = useCallback(() => {
    const wv = webviewRef.current as any;
    if (wv?.reload) {
      setLoading(true);
      wv.reload();
    }
  }, []);

  const handleOpenExternal = useCallback(() => {
    window.electronAPI?.invoke?.('shell:open-external', pageUrl);
  }, [pageUrl]);

  const engineLabel = captcha.engine.charAt(0).toUpperCase() + captcha.engine.slice(1);

  return (
    <div className="captcha-view" style={{ display: 'flex', flexDirection: 'column', height: '100%', background: '#0e0f14' }}>
      {/* Header */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '8px 12px',
        background: '#1a1b26',
        borderBottom: '1px solid #2a2b3a',
        flexShrink: 0,
      }}>
        <ShieldCheck size={16} color="#f59e0b" />
        <span style={{ fontSize: 13, color: '#f59e0b', fontWeight: 500 }}>
          CAPTCHA 验证 — {engineLabel}
        </span>
        <span style={{ fontSize: 12, color: '#888', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {pageUrl}
        </span>
        {loading && (
          <span style={{ fontSize: 12, color: '#666', marginRight: 8 }}>加载中...</span>
        )}
        <button
          onClick={handleReload}
          title="刷新页面"
          style={{
            background: 'none', border: 'none', cursor: 'pointer', padding: 4,
            color: '#888', display: 'flex', alignItems: 'center',
          }}
        >
          <RotateCcw size={14} />
        </button>
        <button
          onClick={handleOpenExternal}
          title="在浏览器中打开"
          style={{
            background: 'none', border: 'none', cursor: 'pointer', padding: 4,
            color: '#888', display: 'flex', alignItems: 'center',
          }}
        >
          <ExternalLink size={14} />
        </button>
      </div>

      {/* Webview */}
      <div style={{ flex: 1, position: 'relative' }}>
        {/* @ts-ignore Electron webview tag */}
        <webview
          ref={webviewRef}
          src={captcha.url}
          style={{
            position: 'absolute',
            top: 0, left: 0, right: 0, bottom: 0,
            width: '100%', height: '100%',
            border: 'none',
          }}
          allowpopups
        />
      </div>

      {/* Footer actions */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'flex-end',
        gap: 8,
        padding: '8px 12px',
        background: '#1a1b26',
        borderTop: '1px solid #2a2b3a',
        flexShrink: 0,
      }}>
        <button
          onClick={onDismiss}
          style={{
            display: 'flex', alignItems: 'center', gap: 4,
            padding: '6px 14px', fontSize: 13, borderRadius: 4,
            background: '#2a2b3a', color: '#ccc', border: 'none', cursor: 'pointer',
          }}
        >
          <X size={14} />
          取消
        </button>
        <button
          onClick={onResolved}
          style={{
            display: 'flex', alignItems: 'center', gap: 4,
            padding: '6px 14px', fontSize: 13, borderRadius: 4,
            background: '#f59e0b', color: '#000', border: 'none', cursor: 'pointer',
            fontWeight: 500,
          }}
        >
          <ShieldCheck size={14} />
          已完成验证，重试搜索
        </button>
      </div>
    </div>
  );
}
