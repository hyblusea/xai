import { Power, PowerOff } from 'lucide-react';
import type { SessionConfig, ProxyConfig } from '@xai/shared';

interface ProxyTabProps {
  config: SessionConfig;
  updateProxy: <K extends keyof ProxyConfig>(key: K, value: ProxyConfig[K]) => void;
}

export default function ProxyTab({ config, updateProxy }: ProxyTabProps) {
  return (
    <div className="settings-tab-content">
      <h3 className="settings-section-title">代理设置</h3>
      <span className="settings-hint">
        配置网络代理。启用后，LLM 请求将通过代理服务器发送。修改保存后立即生效，无需重启。
      </span>

      <div className="settings-field">
        <label className="settings-label">启用代理</label>
        <div className="settings-mqtt-toggle-row">
          <button
            className={`settings-mqtt-toggle ${config.proxy?.enabled ? 'toggle-on' : 'toggle-off'}`}
            onClick={() => updateProxy('enabled', !config.proxy?.enabled)}
          >
            {config.proxy?.enabled ? <Power size={14} /> : <PowerOff size={14} />}
            {config.proxy?.enabled ? '已启用' : '已禁用'}
          </button>
        </div>
      </div>

      {config.proxy?.enabled && (
        <>
          <div className="settings-field">
            <label className="settings-label">代理服务器</label>
            <input
              className="settings-input"
              type="text"
              value={config.proxy?.server || ''}
              onChange={e => updateProxy('server', e.target.value)}
              placeholder="http://127.0.0.1:10808"
            />
            <span className="settings-hint">
              支持 HTTP/HTTPS/SOCKS5 代理，例如：<br />
              • <code>http://127.0.0.1:10808</code> — HTTP 代理<br />
              • <code>socks5://127.0.0.1:1080</code> — SOCKS5 代理
            </span>
          </div>

          <div className="settings-field">
            <label className="settings-label">使用系统代理</label>
            <div className="settings-mqtt-toggle-row">
              <button
                className={`settings-mqtt-toggle ${config.proxy?.useSystemProxy ? 'toggle-on' : 'toggle-off'}`}
                onClick={() => updateProxy('useSystemProxy', !config.proxy?.useSystemProxy)}
              >
                {config.proxy?.useSystemProxy ? <Power size={14} /> : <PowerOff size={14} />}
                {config.proxy?.useSystemProxy ? '使用系统代理' : '使用自定义代理'}
              </button>
            </div>
            <span className="settings-hint">
              启用后将使用系统代理设置，忽略上方配置的代理服务器地址。
            </span>
          </div>

          <div className="settings-divider">
            <span className="settings-divider-text">CMD 命令代理</span>
          </div>

          <div className="settings-field">
            <label className="settings-label">CMD 命令使用代理</label>
            <div className="settings-mqtt-toggle-row">
              <button
                className={`settings-mqtt-toggle ${config.proxy?.cmdUseProxy ? 'toggle-on' : 'toggle-off'}`}
                onClick={() => updateProxy('cmdUseProxy', !config.proxy?.cmdUseProxy)}
              >
                {config.proxy?.cmdUseProxy ? <Power size={14} /> : <PowerOff size={14} />}
                {config.proxy?.cmdUseProxy ? '已启用' : '已禁用'}
              </button>
            </div>
            <span className="settings-hint">
              启用后，AI 执行的 CMD 命令将自动设置 <code>http_proxy</code> / <code>https_proxy</code> 环境变量。
              适用于 npm、pip、curl、git 等需要代理的命令行工具。
            </span>
          </div>
        </>
      )}
    </div>
  );
}
