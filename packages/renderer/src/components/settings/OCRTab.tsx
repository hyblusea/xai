import { useState } from 'react';
import { Power, PowerOff, Eye, EyeOff, Loader2, Scan } from 'lucide-react';
import { IPCChannel } from '@xai/shared';
import type { SessionConfig, OCRConfig } from '@xai/shared';

interface OCRTabProps {
  config: SessionConfig;
  updateOCR: <K extends keyof OCRConfig>(key: K, value: OCRConfig[K]) => void;
  handleSave: () => Promise<void>;
}

export default function OCRTab({ config, updateOCR, handleSave }: OCRTabProps) {
  const [showOcrPassword, setShowOcrPassword] = useState(false);
  const [ocrTesting, setOcrTesting] = useState(false);
  const [ocrTestResult, setOcrTestResult] = useState<{ success: boolean; message: string } | null>(null);
  const [ocrImageTesting, setOcrImageTesting] = useState(false);
  const [ocrImageResult, setOcrImageResult] = useState<{ success: boolean; message: string; text?: string; rawJson?: Record<string, unknown> } | null>(null);

  const handleOCRTestConnection = async () => {
    setOcrTesting(true);
    setOcrTestResult(null);
    try {
      await handleSave();
      const result = await window.electronAPI.invoke(IPCChannel.OCRTestConnection) as { success: boolean; message: string };
      setOcrTestResult(result);
    } catch (err) {
      setOcrTestResult({ success: false, message: String(err) });
    } finally {
      setOcrTesting(false);
    }
  };

  const handleOCRTestImage = async () => {
    setOcrImageTesting(true);
    setOcrImageResult(null);
    try {
      await handleSave();
      const result = await window.electronAPI.invoke(IPCChannel.OCRTestImage) as { success: boolean; message: string; text?: string; rawJson?: Record<string, unknown> };
      setOcrImageResult(result);
    } catch (err) {
      setOcrImageResult({ success: false, message: String(err) });
    } finally {
      setOcrImageTesting(false);
    }
  };

  return (
    <div className="settings-tab-content">
      <h3 className="settings-section-title">OCR 识别服务</h3>
      <span className="settings-hint">
        配置 PaddleOCR 识别服务器，供 LLM 模型调用 OCR 能力时使用。修改保存后立即生效，无需重启程序。
      </span>

      <div className="settings-field">
        <label className="settings-label">启用 OCR 服务</label>
        <div className="settings-mqtt-toggle-row">
          <button
            className={`settings-mqtt-toggle ${config.ocr?.enabled ? 'toggle-on' : 'toggle-off'}`}
            onClick={() => updateOCR('enabled', !config.ocr?.enabled)}
          >
            {config.ocr?.enabled ? <Power size={14} /> : <PowerOff size={14} />}
            {config.ocr?.enabled ? '已启用' : '已禁用'}
          </button>
        </div>
      </div>

      {config.ocr?.enabled && (
        <>
          <div className="settings-field">
            <label className="settings-label">服务器地址</label>
            <input
              className="settings-input"
              type="text"
              value={config.ocr?.serverUrl || ''}
              onChange={e => updateOCR('serverUrl', e.target.value)}
              placeholder="http://127.0.0.1:8089"
            />
            <span className="settings-hint">
              PaddleOCR HTTP 服务地址，例如 <code>http://127.0.0.1:8089</code>
            </span>
          </div>

          <div className="settings-divider">
            <span className="settings-divider-text">认证信息</span>
          </div>

          <div className="settings-field">
            <label className="settings-label">用户名</label>
            <input
              className="settings-input"
              type="text"
              value={config.ocr?.username || ''}
              onChange={e => updateOCR('username', e.target.value)}
              placeholder="admin"
            />
          </div>

          <div className="settings-field">
            <label className="settings-label">密码</label>
            <div className="settings-secret-field">
              <input
                className="settings-input settings-secret-input"
                type={showOcrPassword ? 'text' : 'password'}
                value={config.ocr?.password || ''}
                onChange={e => updateOCR('password', e.target.value)}
                placeholder="OCR server password"
              />
              <button
                className="settings-secret-toggle"
                onClick={() => setShowOcrPassword(!showOcrPassword)}
                type="button"
              >
                {showOcrPassword ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
          </div>

          <div className="settings-divider">
            <span className="settings-divider-text">OCR 参数</span>
          </div>

          <div className="settings-field">
            <label className="settings-label">识别语言</label>
            <select
              className="settings-select"
              value={config.ocr?.lang || 'ch'}
              onChange={e => updateOCR('lang', e.target.value)}
            >
              <option value="ch">中文</option>
              <option value="en">英文</option>
              <option value="japan">日文</option>
              <option value="korean">韩文</option>
              <option value="chinese_cht">繁体中文</option>
              <option value="ta">泰文</option>
              <option value="te">泰卢固文</option>
              <option value="ka">卡纳达文</option>
              <option value="ta">泰米尔文</option>
            </select>
          </div>

          <div className="settings-field">
            <label className="settings-label">请求超时 (ms)</label>
            <input
              className="settings-input"
              type="number"
              value={config.ocr?.timeout || 120000}
              onChange={e => updateOCR('timeout', parseInt(e.target.value, 10) || 120000)}
              min={10000}
              step={10000}
            />
            <span className="settings-hint">
              OCR 推理在 CPU 上可能较慢，建议至少 120000ms (2分钟)。大图会被服务端自动缩放以加速识别。
            </span>
          </div>

          <div className="settings-divider">
            <span className="settings-divider-text">连接测试</span>
          </div>

          <div className="settings-field">
            <button
              className="settings-btn settings-btn-test"
              style={{ width: 'auto' }}
              onClick={handleOCRTestConnection}
              disabled={ocrTesting}
            >
              {ocrTesting ? <Loader2 size={14} className="spin" /> : <Scan size={14} />}
              {ocrTesting ? '测试中...' : '测试连接'}
            </button>
            {ocrTestResult && (
              <div className={`settings-test-result ${ocrTestResult.success ? 'test-success' : 'test-fail'}`}>
                {ocrTestResult.message}
              </div>
            )}
          </div>

          <div className="settings-divider">
            <span className="settings-divider-text">图片识别测试</span>
          </div>

          <div className="settings-field">
            <span className="settings-hint" style={{ marginBottom: 4 }}>
              选择一张本地图片，发送到 OCR 服务器进行识别，查看识别结果。
            </span>
            <button
              className="settings-btn settings-btn-secondary"
              onClick={handleOCRTestImage}
              disabled={ocrImageTesting || !config.ocr?.serverUrl}
            >
              {ocrImageTesting ? <Loader2 size={14} className="spin" /> : <Scan size={14} />}
              {ocrImageTesting ? '识别中...' : '选择图片并测试识别'}
            </button>
            {ocrImageResult && (
              <div style={{ marginTop: 8 }}>
                <div className={`settings-test-result ${ocrImageResult.success ? 'test-success' : 'test-fail'}`}>
                  {ocrImageResult.message}
                </div>
                {ocrImageResult.success && ocrImageResult.text && (
                  <pre className="settings-search-test-result" style={{ marginTop: 8, maxHeight: 200, overflow: 'auto' }}>
                    {ocrImageResult.text}
                  </pre>
                )}
                {ocrImageResult.rawJson && (
                  <details style={{ marginTop: 8 }}>
                    <summary style={{ cursor: 'pointer', fontSize: 12, opacity: 0.7 }}>原始 JSON 响应</summary>
                    <pre className="settings-search-test-result" style={{ marginTop: 4, maxHeight: 400, overflow: 'auto', fontSize: 11 }}>
                      {JSON.stringify(ocrImageResult.rawJson, null, 2)}
                    </pre>
                  </details>
                )}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
