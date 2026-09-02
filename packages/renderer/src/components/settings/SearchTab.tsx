import { useState } from 'react';
import { Power, PowerOff, Loader2, Search } from 'lucide-react';
import { IPCChannel } from '@xai/shared';
import type { SessionConfig, WebSearchConfig, WebFetchConfig } from '@xai/shared';

interface SearchTabProps {
  config: SessionConfig;
  updateWebSearch: <K extends keyof WebSearchConfig>(key: K, value: WebSearchConfig[K]) => void;
  updateWebFetch: <K extends keyof WebFetchConfig>(key: K, value: WebFetchConfig[K]) => void;
}

export default function SearchTab({ config, updateWebSearch, updateWebFetch }: SearchTabProps) {
  const [searchTestQuery, setSearchTestQuery] = useState('');
  const [searchTestEngine, setSearchTestEngine] = useState<string>('bing');
  const [searchTesting, setSearchTesting] = useState(false);
  const [searchTestResult, setSearchTestResult] = useState<{ success: boolean; data?: string; error?: string } | null>(null);

  const handleSearchTest = async () => {
    if (!searchTestQuery.trim()) return;
    setSearchTesting(true);
    setSearchTestResult(null);
    try {
      const result = await window.electronAPI.invoke(IPCChannel.WebSearchTest, {
        query: searchTestQuery.trim(),
        engine: searchTestEngine,
        num: 5,
      }) as { success: boolean; data?: string; error?: string };
      setSearchTestResult(result);
    } catch (err) {
      setSearchTestResult({ success: false, error: String(err) });
    } finally {
      setSearchTesting(false);
    }
  };

  return (
    <div className="settings-tab-content">
      <h3 className="settings-section-title">搜索设置</h3>
      <span className="settings-hint">
        配置网页搜索和网页查看工具。搜索工具模拟浏览器请求搜索引擎，解析 HTML 提取搜索结果。修改保存后立即生效，无需重启。
      </span>

      <div className="settings-field">
        <label className="settings-label">启用网页搜索</label>
        <div className="settings-mqtt-toggle-row">
          <button
            className={`settings-mqtt-toggle ${config.webSearch?.enabled !== false ? 'toggle-on' : 'toggle-off'}`}
            onClick={() => updateWebSearch('enabled', config.webSearch?.enabled === false ? true : false)}
          >
            {config.webSearch?.enabled !== false ? <Power size={14} /> : <PowerOff size={14} />}
            {config.webSearch?.enabled !== false ? '已启用' : '已禁用'}
          </button>
        </div>
      </div>

      {config.webSearch?.enabled !== false && (
        <>
          <div className="settings-field">
            <label className="settings-label">默认搜索引擎</label>
            <select
              className="settings-select"
              value={config.webSearch?.defaultEngine || 'google'}
              onChange={e => updateWebSearch('defaultEngine', e.target.value as 'google' | 'bing' | 'duckduckgo' | 'baidu')}
            >
              <option value="google">Google</option>
              <option value="bing">Bing</option>
              <option value="duckduckgo">DuckDuckGo</option>
              <option value="baidu">百度</option>
            </select>
          </div>

          <div className="settings-field">
            <label className="settings-label">最大结果数</label>
            <input
              className="settings-input"
              type="number"
              value={config.webSearch?.maxResults || 10}
              onChange={e => updateWebSearch('maxResults', parseInt(e.target.value, 10) || 10)}
              min={1}
              max={20}
            />
          </div>

          <div className="settings-field">
            <label className="settings-label">请求最小间隔 (ms)</label>
            <input
              className="settings-input"
              type="number"
              value={config.webSearch?.minRequestInterval || 2000}
              onChange={e => updateWebSearch('minRequestInterval', parseInt(e.target.value, 10) || 2000)}
              min={500}
              step={500}
            />
          </div>

          <div className="settings-field">
            <label className="settings-label">CAPTCHA 自动降级</label>
            <div className="settings-mqtt-toggle-row">
              <button
                className={`settings-mqtt-toggle ${config.webSearch?.autoFallback !== false ? 'toggle-on' : 'toggle-off'}`}
                onClick={() => updateWebSearch('autoFallback', config.webSearch?.autoFallback === false ? true : false)}
              >
                {config.webSearch?.autoFallback !== false ? <Power size={14} /> : <PowerOff size={14} />}
                {config.webSearch?.autoFallback !== false ? '已启用' : '已禁用'}
              </button>
            </div>
            <span className="settings-hint">
              启用后，当搜索引擎返回 CAPTCHA 时，自动降级到下一个搜索引擎。
            </span>
          </div>

          <div className="settings-field">
            <label className="settings-label">界面语言 (hl)</label>
            <input
              className="settings-input"
              type="text"
              value={config.webSearch?.hl || 'zh-CN'}
              onChange={e => updateWebSearch('hl', e.target.value)}
              placeholder="zh-CN"
            />
          </div>

          <div className="settings-field">
            <label className="settings-label">国家/地区 (gl)</label>
            <input
              className="settings-input"
              type="text"
              value={config.webSearch?.gl || 'CN'}
              onChange={e => updateWebSearch('gl', e.target.value)}
              placeholder="CN"
            />
          </div>

          <div className="settings-divider">
            <span className="settings-divider-text">搜索测试</span>
          </div>

          <div className="settings-field">
            <label className="settings-label">测试引擎</label>
            <select
              className="settings-select"
              value={searchTestEngine}
              onChange={e => setSearchTestEngine(e.target.value)}
            >
              <option value="google">Google</option>
              <option value="bing">Bing</option>
              <option value="duckduckgo">DuckDuckGo</option>
              <option value="baidu">百度</option>
            </select>
          </div>

          <div className="settings-field">
            <label className="settings-label">搜索关键字</label>
            <div className="settings-search-test-row">
              <input
                className="settings-input"
                type="text"
                value={searchTestQuery}
                onChange={e => setSearchTestQuery(e.target.value)}
                placeholder="React 19 新特性"
                onKeyDown={e => { if (e.key === 'Enter' && searchTestQuery.trim()) handleSearchTest(); }}
              />
              <button
                className="settings-btn settings-btn-test"
                style={{ width: 'auto', flexShrink: 0 }}
                onClick={handleSearchTest}
                disabled={searchTesting || !searchTestQuery.trim()}
              >
                {searchTesting ? <Loader2 size={14} className="spin" /> : <Search size={14} />}
                {searchTesting ? '搜索中...' : '测试'}
              </button>
            </div>
          </div>

          {searchTestResult && (
            <div className="settings-field">
              <span className="tool-call-detail-label">搜索结果</span>
              {searchTestResult.success ? (
                <pre className="settings-search-test-result">{searchTestResult.data}</pre>
              ) : (
                <div className="settings-test-result test-fail">{searchTestResult.error}</div>
              )}
            </div>
          )}
        </>
      )}

      <div className="settings-divider">
        <span className="settings-divider-text">网页查看</span>
      </div>

      <div className="settings-field">
        <label className="settings-label">启用网页查看</label>
        <div className="settings-mqtt-toggle-row">
          <button
            className={`settings-mqtt-toggle ${config.webFetch?.enabled !== false ? 'toggle-on' : 'toggle-off'}`}
            onClick={() => updateWebFetch('enabled', config.webFetch?.enabled === false ? true : false)}
          >
            {config.webFetch?.enabled !== false ? <Power size={14} /> : <PowerOff size={14} />}
            {config.webFetch?.enabled !== false ? '已启用' : '已禁用'}
          </button>
        </div>
      </div>

      {config.webFetch?.enabled !== false && (
        <>
          <div className="settings-field">
            <label className="settings-label">最大内容长度 (字符)</label>
            <input
              className="settings-input"
              type="number"
              value={config.webFetch?.maxLength || 50000}
              onChange={e => updateWebFetch('maxLength', parseInt(e.target.value, 10) || 50000)}
              min={1000}
              step={5000}
            />
          </div>

          <div className="settings-field">
            <label className="settings-label">请求超时 (ms)</label>
            <input
              className="settings-input"
              type="number"
              value={config.webFetch?.timeout || 30000}
              onChange={e => updateWebFetch('timeout', parseInt(e.target.value, 10) || 30000)}
              min={5000}
              step={5000}
            />
          </div>
        </>
      )}
    </div>
  );
}
