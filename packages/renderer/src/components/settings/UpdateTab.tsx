import { useState, useEffect } from 'react';
import { Power, PowerOff, Eye, EyeOff, Loader2 } from 'lucide-react';
import { IPCChannel } from '@xai/shared';
import type { SessionConfig, UpdateConfig } from '@xai/shared';

interface UpdateTabProps {
  config: SessionConfig;
  updateUpdate: <K extends keyof UpdateConfig>(key: K, value: UpdateConfig[K]) => void;
  showToast: (message: string, type: 'success' | 'error') => void;
}

export default function UpdateTab({ config, updateUpdate, showToast }: UpdateTabProps) {
  const [showUpdatePassword, setShowUpdatePassword] = useState(false);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [updateCheckResult, setUpdateCheckResult] = useState<{ success: boolean; message: string } | null>(null);
  const [updateDownloadProgress, setUpdateDownloadProgress] = useState<{
    percent: number; status: 'downloading' | 'downloaded' | 'error'; version: string; error?: string;
  } | null>(null);

  useEffect(() => {
    const onProgress = (data: unknown) => {
      const d = data as { percent: number };
      setUpdateDownloadProgress(prev => ({ ...prev!, percent: d.percent, status: 'downloading' }));
    };
    const onDownloaded = (data: unknown) => {
      const d = data as { version: string };
      setUpdateDownloadProgress({ percent: 100, status: 'downloaded', version: d.version });
    };
    const onError = (data: unknown) => {
      const d = data as { message: string };
      setUpdateDownloadProgress(prev => ({ ...prev!, status: 'error', error: d.message }));
    };
    const onCheckResult = (data: unknown) => {
      const d = data as { available: boolean; version: string };
      if (d.available) {
        setUpdateDownloadProgress({ percent: 0, status: 'downloading', version: d.version });
      }
    };

    window.electronAPI?.on(IPCChannel.UpdateCheckResult, onCheckResult);
    window.electronAPI?.on(IPCChannel.UpdateDownloadProgress, onProgress);
    window.electronAPI?.on(IPCChannel.UpdateDownloaded, onDownloaded);
    window.electronAPI?.on(IPCChannel.UpdateError, onError);

    return () => {
      window.electronAPI?.removeListener?.(IPCChannel.UpdateCheckResult, onCheckResult);
      window.electronAPI?.removeListener?.(IPCChannel.UpdateDownloadProgress, onProgress);
      window.electronAPI?.removeListener?.(IPCChannel.UpdateDownloaded, onDownloaded);
      window.electronAPI?.removeListener?.(IPCChannel.UpdateError, onError);
    };
  }, []);

  return (
    <div className="settings-tab-content">
      <h3 className="settings-section-title">自动更新</h3>
      <span className="settings-hint">
        配置更新服务器以实现应用自动更新。更新文件通过 HTTP 服务器发布，客户端使用 Basic Auth 认证下载。
      </span>

      <div className="settings-field">
        <label className="settings-label">启用自动更新</label>
        <div className="settings-mqtt-toggle-row">
          <button
            className={`settings-mqtt-toggle ${config.update?.enabled ? 'toggle-on' : 'toggle-off'}`}
            onClick={() => updateUpdate('enabled', !config.update?.enabled)}
          >
            {config.update?.enabled ? <Power size={14} /> : <PowerOff size={14} />}
            {config.update?.enabled ? '已启用' : '已禁用'}
          </button>
        </div>
      </div>

      {config.update?.enabled && (
        <>
          <div className="settings-field">
            <label className="settings-label">服务器地址</label>
            <input
              className="settings-input"
              type="text"
              value={config.update?.server || ''}
              onChange={e => updateUpdate('server', e.target.value)}
              placeholder="http://10.128.252.145:3000"
            />
            <span className="settings-hint">
              更新服务器的 HTTP 地址，例如 <code>http://10.128.252.145:3000</code>
            </span>
          </div>

          <div className="settings-field">
            <label className="settings-label">用户名</label>
            <input
              className="settings-input"
              type="text"
              value={config.update?.username || ''}
              onChange={e => updateUpdate('username', e.target.value)}
              placeholder="admin"
              autoComplete="off"
            />
          </div>

          <div className="settings-field">
            <label className="settings-label">密码</label>
            <div className="settings-secret-field">
              <input
                className="settings-input settings-secret-input"
                type={showUpdatePassword ? 'text' : 'password'}
                value={config.update?.password || ''}
                onChange={e => updateUpdate('password', e.target.value)}
                placeholder="••••••••"
                autoComplete="off"
              />
              <button
                className="settings-secret-toggle"
                onClick={() => setShowUpdatePassword(!showUpdatePassword)}
                type="button"
              >
                {showUpdatePassword ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
            <span className="settings-hint">
              密码将以 base64 编码存储在配置文件中。
            </span>
          </div>

          <div className="settings-divider">
            <span className="settings-divider-text">手动检查</span>
          </div>

          <div className="settings-field">
            <button
              className="settings-btn settings-btn-secondary"
              disabled={checkingUpdate}
              onClick={async () => {
                setCheckingUpdate(true);
                setUpdateCheckResult(null);
                try {
                  const result = await window.electronAPI.invoke(IPCChannel.UpdateCheck) as { success: boolean; version?: string; error?: string };
                  if (result.success) {
                    const msg = result.version ? `发现新版本: v${result.version}` : '当前已是最新版本';
                    setUpdateCheckResult({ success: true, message: msg });
                    showToast(msg, 'success');
                  } else {
                    const msg = `检查失败: ${result.error}`;
                    setUpdateCheckResult({ success: false, message: msg });
                    showToast(msg, 'error');
                  }
                } catch (err) {
                  const msg = `检查失败: ${err}`;
                  setUpdateCheckResult({ success: false, message: msg });
                  showToast(msg, 'error');
                } finally {
                  setCheckingUpdate(false);
                }
              }}
            >
              {checkingUpdate ? (
                <>
                  <Loader2 size={14} className="spin" />
                  检查中...
                </>
              ) : '立即检查更新'}
            </button>
            {updateCheckResult && (
              <div className={`settings-test-result ${updateCheckResult.success ? 'test-success' : 'test-fail'}`}>
                {updateCheckResult.message}
              </div>
            )}
          </div>

          {updateDownloadProgress && (
            <div className="settings-field">
              {updateDownloadProgress.status === 'downloading' && (
                <div className="update-progress-container">
                  <div className="update-progress-label">
                    <span>正在下载更新 v{updateDownloadProgress.version}</span>
                    <span>{updateDownloadProgress.percent}%</span>
                  </div>
                  <div className="update-progress-bar">
                    <div className="update-progress-fill" style={{ width: `${updateDownloadProgress.percent}%` }} />
                  </div>
                </div>
              )}
              {updateDownloadProgress.status === 'downloaded' && (
                <div className="settings-test-result test-success">
                  新版本 v{updateDownloadProgress.version} 已下载完成，重启后生效
                </div>
              )}
              {updateDownloadProgress.status === 'error' && (
                <div className="settings-test-result test-fail">
                  下载失败: {updateDownloadProgress.error}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
