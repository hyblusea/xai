import { useState, useEffect, useCallback } from 'react';
import { IPCChannel } from '@xai/shared';

interface UpdateState {
  status: 'idle' | 'available' | 'downloading' | 'downloaded' | 'error';
  version: string;
  percent: number;
  error: string;
}

export default function UpdateNotification() {
  const [update, setUpdate] = useState<UpdateState>({
    status: 'idle',
    version: '',
    percent: 0,
    error: '',
  });
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    const api = (window as unknown as { electronAPI: { on: (ch: string, cb: (...args: unknown[]) => void) => void; invoke: (ch: string, ...args: unknown[]) => Promise<unknown>; removeListener: (ch: string, cb: (...args: unknown[]) => void) => void } }).electronAPI;
    if (!api) return;

    const onCheckResult = (...args: unknown[]) => {
      const data = args[0] as { available: boolean; version: string };
      if (data.available) {
        setUpdate(prev => ({ ...prev, status: 'available', version: data.version }));
        setDismissed(false);
      }
    };

    const onProgress = (...args: unknown[]) => {
      const data = args[0] as { percent: number };
      setUpdate(prev => ({ ...prev, status: 'downloading', percent: data.percent }));
    };

    const onDownloaded = (...args: unknown[]) => {
      const data = args[0] as { version: string };
      setUpdate(prev => ({ ...prev, status: 'downloaded', version: data.version }));
    };

    const onError = (...args: unknown[]) => {
      const data = args[0] as { message: string };
      setUpdate(prev => ({ ...prev, status: 'error', error: data.message }));
    };

    api.on(IPCChannel.UpdateCheckResult, onCheckResult);
    api.on(IPCChannel.UpdateDownloadProgress, onProgress);
    api.on(IPCChannel.UpdateDownloaded, onDownloaded);
    api.on(IPCChannel.UpdateError, onError);

    return () => {
      api.removeListener(IPCChannel.UpdateCheckResult, onCheckResult);
      api.removeListener(IPCChannel.UpdateDownloadProgress, onProgress);
      api.removeListener(IPCChannel.UpdateDownloaded, onDownloaded);
      api.removeListener(IPCChannel.UpdateError, onError);
    };
  }, []);

  const handleInstall = useCallback(() => {
    const api = (window as unknown as { electronAPI: { invoke: (ch: string) => Promise<unknown> } }).electronAPI;
    if (!api) return;
    api.invoke(IPCChannel.UpdateInstall);
  }, []);

  const handleDismiss = useCallback(() => {
    setDismissed(true);
  }, []);

  if (dismissed || update.status === 'idle') return null;

  return (
    <div className="update-notification">
      {update.status === 'available' && (
        <div className="update-notification-inner">
          <span className="update-icon">🔄</span>
          <span className="update-text">发现新版本 <b>v{update.version}</b>，正在准备下载...</span>
          <button className="update-dismiss" onClick={handleDismiss} title="忽略">✕</button>
        </div>
      )}

      {update.status === 'downloading' && (
        <div className="update-notification-inner">
          <span className="update-icon">⬇️</span>
          <span className="update-text">正在下载更新 v{update.version}</span>
          <div className="update-progress-bar">
            <div className="update-progress-fill" style={{ width: `${update.percent}%` }} />
          </div>
          <span className="update-percent">{update.percent}%</span>
          <button className="update-dismiss" onClick={handleDismiss} title="最小化">✕</button>
        </div>
      )}

      {update.status === 'downloaded' && (
        <div className="update-notification-inner update-ready">
          <span className="update-icon">✅</span>
          <span className="update-text">新版本 <b>v{update.version}</b> 已就绪</span>
          <button className="update-install-btn" onClick={handleInstall}>重启更新</button>
          <button className="update-dismiss" onClick={handleDismiss} title="稍后安装">✕</button>
        </div>
      )}

      {update.status === 'error' && (
        <div className="update-notification-inner update-error">
          <span className="update-icon">⚠️</span>
          <span className="update-text update-error-text">更新失败: {update.error}</span>
          <button className="update-dismiss" onClick={handleDismiss} title="关闭">✕</button>
        </div>
      )}
    </div>
  );
}
