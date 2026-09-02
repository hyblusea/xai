import { useState, useEffect, useCallback, useRef } from 'react';
import { Eye, EyeOff, X } from 'lucide-react';
import { IPCChannel } from '@xai/shared';
import type { SessionConfig, LLMConfig } from '@xai/shared';

/**
 * Default field values applied when switching to a provider that has no
 * saved snapshot yet. Only the fields that differ per-provider are listed;
 * everything else is inherited from the current llm config.
 */
const PROVIDER_DEFAULTS: Record<string, Partial<LLMConfig>> = {
  mimo: { model: 'mimo-v2.5-pro', baseUrl: 'https://aistudio.xiaomimimo.com/open-apis/bot/chat' },
  openai: { model: 'gpt-4o', baseUrl: 'https://api.openai.com/v1/chat/completions' },
  deveco: { model: 'GLM-5.1', baseUrl: 'https://cn.devecostudio.huawei.com', temperature: 0.7 },
  cline: { model: 'cline-free/glm-5.2', baseUrl: 'https://api.cline.bot/api/v1/chat/completions', temperature: 0.7 },
  freebuff: { model: 'deepseek/deepseek-v4-flash', temperature: 0.7 },
};

interface LLMTabProps {
  config: SessionConfig;
  setConfig: React.Dispatch<React.SetStateAction<SessionConfig | null>>;
  persistConfig: (config: SessionConfig) => Promise<void>;
  updateLLM: <K extends keyof LLMConfig>(key: K, value: LLMConfig[K]) => void;
  updateLLMOption: (key: string, value: unknown) => void;
  testing: boolean;
  testResult: { success: boolean; message: string } | null;
  handleTestConnection: () => void;
}

export default function LLMTab({
  config,
  setConfig,
  persistConfig,
  updateLLM,
  updateLLMOption,
  testing,
  testResult,
  handleTestConnection,
}: LLMTabProps) {
  const [showApiKey, setShowApiKey] = useState(false);
  const [showCookies, setShowCookies] = useState(false);
  const [devecoModels, setDevecoModels] = useState<Array<{ id: string; name: string; contextWindow: number; maxOutput: number; thinkingMode: string; toolCallMode: string; inputModalities: string[] }>>([]);
  const [devecoModelsLoading, setDevecoModelsLoading] = useState(false);
  const [devecoAuthStatus, setDevecoAuthStatus] = useState<{ loggedIn: boolean; userName: string; expired: boolean } | null>(null);
  const [devecoLoginLoading, setDevecoLoginLoading] = useState(false);
  const [devecoLoginProgress, setDevecoLoginProgress] = useState('');

  const isMiMo = config.llm.provider === 'mimo';
  const isDevEco = config.llm.provider === 'deveco';
  const isCline = config.llm.provider === 'cline';
  const isFreebuff = config.llm.provider === 'freebuff';

  // ── Cline state ──
  const [clineModels, setClineModels] = useState<Array<{ id: string; name: string; description: string; tags: string[]; category: string }>>([]);
  const [clineModelsLoading, setClineModelsLoading] = useState(false);
  const [clineAuthStatus, setClineAuthStatus] = useState<{ loggedIn: boolean; email: string; expired: boolean } | null>(null);
  const [clineLoginLoading, setClineLoginLoading] = useState(false);
  const [clineLoginProgress, setClineLoginProgress] = useState('');
  // Reasoning support state — dynamically resolved per model
  const [clineReasoningInfo, setClineReasoningInfo] = useState<{ supportsReasoning: boolean; supportedEfforts: string[]; defaultEffort: string } | null>(null);
  const [clineReasoningLoading, setClineReasoningLoading] = useState(false);
  // Context info state — dynamically resolved per model
  const [clineContextInfo, setClineContextInfo] = useState<{ contextWindow: number; maxInputTokens: number; maxOutputTokens: number } | null>(null);
  const [clineContextLoading, setClineContextLoading] = useState(false);

  // ── Freebuff state ──
  const [freebuffAuthStatus, setFreebuffAuthStatus] = useState<{ loggedIn: boolean; email: string; expired: boolean } | null>(null);
  const [freebuffLoginLoading, setFreebuffLoginLoading] = useState(false);
  const [freebuffLoginProgress, setFreebuffLoginProgress] = useState('');
  const [freebuffModels, setFreebuffModels] = useState<Array<{ id: string; name: string; contextWindow: number; reasoning: boolean; reasoningEffort?: string; efforts?: string[]; defaultEffort?: string; premium: boolean; tagline?: string }>>([]);
  const [freebuffModelsLoading, setFreebuffModelsLoading] = useState(false);
  const [freebuffReasoningInfo, setFreebuffReasoningInfo] = useState<{ supportsReasoning: boolean; supportedEfforts: string[]; defaultEffort: string } | null>(null);
  const [freebuffReasoningLoading, setFreebuffReasoningLoading] = useState(false);
  const [freebuffContextInfo, setFreebuffContextInfo] = useState<{ contextWindow: number; maxInputTokens: number; maxOutputTokens: number } | null>(null);
  const [freebuffContextLoading, setFreebuffContextLoading] = useState(false);
  const [freebuffSessionStatus, setFreebuffSessionStatus] = useState<{ active: boolean; model?: string; expiresAt?: string; instanceId?: string } | null>(null);

  useEffect(() => {
    if (config.llm.provider !== 'deveco') return;
    const loadStatus = async () => {
      try {
        const status = await window.electronAPI.invoke('deveco:auth-status') as { loggedIn: boolean; userName: string; expired: boolean };
        setDevecoAuthStatus(status);
      } catch {}
    };
    loadStatus();
  }, [config.llm.provider]);

  const loadClineModels = useCallback(async () => {
    setClineModelsLoading(true);
    try {
      const result = await window.electronAPI.invoke(IPCChannel.ClineModels) as { success: boolean; models?: Array<{ id: string; name: string; description: string; tags: string[]; category: string }>; error?: string };
      if (result.success && result.models) {
        // Only free models are returned from the backend
        setClineModels(result.models);
      } else {
        setClineModels([]);
      }
    } catch {
      setClineModels([]);
    } finally {
      setClineModelsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (config.llm.provider !== 'cline') return;
    const loadStatus = async () => {
      try {
        const status = await window.electronAPI.invoke(IPCChannel.ClineAuthStatus) as { loggedIn: boolean; email: string; expired: boolean };
        setClineAuthStatus(status);
      } catch {}
    };
    loadStatus();
    // Do NOT auto-fetch models — user must click "Fetch Models" to load free models.
  }, [config.llm.provider]);

  // Dynamically check reasoning support when the Cline model changes
  useEffect(() => {
    if (config.llm.provider !== 'cline' || !config.llm.model) {
      setClineReasoningInfo(null);
      return;
    }
    let cancelled = false;
    const checkReasoning = async () => {
      setClineReasoningLoading(true);
      try {
        const result = await window.electronAPI.invoke(IPCChannel.ClineModelReasoning, config.llm.model) as {
          success: boolean;
          supportsReasoning: boolean;
          supportedEfforts: string[];
          defaultEffort: string;
        };
        if (!cancelled) {
          setClineReasoningInfo({
            supportsReasoning: result.supportsReasoning,
            supportedEfforts: result.supportedEfforts ?? [],
            defaultEffort: result.defaultEffort ?? '',
          });
        }
      } catch {
        if (!cancelled) setClineReasoningInfo(null);
      } finally {
        if (!cancelled) setClineReasoningLoading(false);
      }
    };
    checkReasoning();
    return () => { cancelled = true; };
  }, [config.llm.provider, config.llm.model]);

  // Dynamically check context window / max tokens when the Cline model changes
  useEffect(() => {
    if (config.llm.provider !== 'cline' || !config.llm.model) {
      setClineContextInfo(null);
      return;
    }
    let cancelled = false;
    const checkContext = async () => {
      setClineContextLoading(true);
      try {
        const result = await window.electronAPI.invoke(IPCChannel.ClineModelContextInfo, config.llm.model) as {
          success: boolean;
          contextWindow: number;
          maxInputTokens: number;
          maxOutputTokens: number;
        };
        if (!cancelled && result.success) {
          setClineContextInfo({
            contextWindow: result.contextWindow,
            maxInputTokens: result.maxInputTokens,
            maxOutputTokens: result.maxOutputTokens,
          });
        }
      } catch {
        if (!cancelled) setClineContextInfo(null);
      } finally {
        if (!cancelled) setClineContextLoading(false);
      }
    };
    checkContext();
    return () => { cancelled = true; };
  }, [config.llm.provider, config.llm.model]);

  // ── Freebuff effects ──

  useEffect(() => {
    if (config.llm.provider !== 'freebuff') return;
    const loadStatus = async () => {
      try {
        const status = await window.electronAPI.invoke(IPCChannel.FreebuffAuthStatus) as { loggedIn: boolean; email: string; expired: boolean };
        setFreebuffAuthStatus(status);
      } catch {}
    };
    loadStatus();
  }, [config.llm.provider]);

  const loadFreebuffModels = useCallback(async () => {
    setFreebuffModelsLoading(true);
    try {
      const result = await window.electronAPI.invoke(IPCChannel.FreebuffModels) as { success: boolean; models?: Array<{ id: string; name: string; contextWindow: number; reasoning: boolean; reasoningEffort?: string; efforts?: string[]; defaultEffort?: string; premium: boolean; tagline?: string }>; error?: string };
      if (result.success && result.models) {
        setFreebuffModels(result.models);
      } else {
        setFreebuffModels([]);
      }
    } catch {
      setFreebuffModels([]);
    } finally {
      setFreebuffModelsLoading(false);
    }
  }, []);

  // Dynamically check reasoning support when the Freebuff model changes
  useEffect(() => {
    if (config.llm.provider !== 'freebuff' || !config.llm.model) {
      setFreebuffReasoningInfo(null);
      return;
    }
    let cancelled = false;
    const checkReasoning = async () => {
      setFreebuffReasoningLoading(true);
      try {
        const result = await window.electronAPI.invoke(IPCChannel.FreebuffModelReasoning, config.llm.model) as {
          success: boolean;
          supportsReasoning: boolean;
          supportedEfforts: string[];
          defaultEffort: string;
        };
        if (!cancelled) {
          setFreebuffReasoningInfo({
            supportsReasoning: result.supportsReasoning,
            supportedEfforts: result.supportedEfforts ?? [],
            defaultEffort: result.defaultEffort ?? '',
          });
        }
      } catch {
        if (!cancelled) setFreebuffReasoningInfo(null);
      } finally {
        if (!cancelled) setFreebuffReasoningLoading(false);
      }
    };
    checkReasoning();
    return () => { cancelled = true; };
  }, [config.llm.provider, config.llm.model]);

  // Dynamically check context window when the Freebuff model changes
  useEffect(() => {
    if (config.llm.provider !== 'freebuff' || !config.llm.model) {
      setFreebuffContextInfo(null);
      return;
    }
    let cancelled = false;
    const checkContext = async () => {
      setFreebuffContextLoading(true);
      try {
        const result = await window.electronAPI.invoke(IPCChannel.FreebuffModelContextInfo, config.llm.model) as {
          success: boolean;
          contextWindow: number;
          maxInputTokens: number;
          maxOutputTokens: number;
        };
        if (!cancelled && result.success) {
          setFreebuffContextInfo({
            contextWindow: result.contextWindow,
            maxInputTokens: result.maxInputTokens,
            maxOutputTokens: result.maxOutputTokens,
          });
        }
      } catch {
        if (!cancelled) setFreebuffContextInfo(null);
      } finally {
        if (!cancelled) setFreebuffContextLoading(false);
      }
    };
    checkContext();
    return () => { cancelled = true; };
  }, [config.llm.provider, config.llm.model]);

  const handleFreebuffLogin = async () => {
    setFreebuffLoginLoading(true);
    setFreebuffLoginProgress('正在获取登录链接...');
    const onProgress = (_msg: unknown) => {
      if (typeof _msg === 'string') setFreebuffLoginProgress(_msg);
    };
    window.electronAPI.on(IPCChannel.FreebuffLoginProgress, onProgress);
    try {
      const result = await window.electronAPI.invoke(IPCChannel.FreebuffLogin) as { success: boolean; email?: string; error?: string };
      if (result.success) {
        setFreebuffAuthStatus({ loggedIn: true, email: result.email || 'User', expired: false });
      } else {
        alert(`Login failed: ${result.error || 'Unknown error'}`);
      }
    } catch (err) {
      alert(`Login error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      window.electronAPI.removeListener(IPCChannel.FreebuffLoginProgress, onProgress);
      setFreebuffLoginLoading(false);
      setFreebuffLoginProgress('');
    }
  };

  const handleFreebuffLogout = async () => {
    try {
      await window.electronAPI.invoke(IPCChannel.FreebuffLogout);
      setFreebuffAuthStatus({ loggedIn: false, email: '', expired: false });
    } catch {}
  };

  const handleDevecoLogin = async () => {
    setDevecoLoginLoading(true);
    setDevecoLoginProgress('打开浏览器...');
    const onProgress = (_msg: unknown) => {
      if (typeof _msg === 'string') setDevecoLoginProgress(_msg);
    };
    window.electronAPI.on(IPCChannel.DevEcoLoginProgress, onProgress);
    try {
      const result = await window.electronAPI.invoke('deveco:login') as { success: boolean; userName?: string; error?: string };
      if (result.success) {
        setDevecoAuthStatus({ loggedIn: true, userName: result.userName || 'User', expired: false });
      } else {
        alert(`Login failed: ${result.error || 'Unknown error'}`);
      }
    } catch (err) {
      alert(`Login error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      window.electronAPI.removeListener(IPCChannel.DevEcoLoginProgress, onProgress);
      setDevecoLoginLoading(false);
      setDevecoLoginProgress('');
    }
  };

  const handleDevecoLogout = async () => {
    await window.electronAPI.invoke('deveco:logout');
    setDevecoAuthStatus({ loggedIn: false, userName: '', expired: false });
  };

  const handleClineLogin = async () => {
    setClineLoginLoading(true);
    setClineLoginProgress('正在打开浏览器...');
    const onProgress = (_msg: unknown) => {
      if (typeof _msg === 'string') setClineLoginProgress(_msg);
    };
    window.electronAPI.on(IPCChannel.ClineLoginProgress, onProgress);
    try {
      const result = await window.electronAPI.invoke(IPCChannel.ClineLogin) as { success: boolean; email?: string; error?: string };
      if (result.success) {
        setClineAuthStatus({ loggedIn: true, email: result.email || 'User', expired: false });
      } else {
        alert(`Login failed: ${result.error || 'Unknown error'}`);
      }
    } catch (err) {
      alert(`Login error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      window.electronAPI.removeListener(IPCChannel.ClineLoginProgress, onProgress);
      setClineLoginLoading(false);
      setClineLoginProgress('');
    }
  };

  const handleClineLogout = async () => {
    await window.electronAPI.invoke(IPCChannel.ClineLogout);
    setClineAuthStatus({ loggedIn: false, email: '', expired: false });
  };


  const loadDevecoModels = useCallback(async () => {
    setDevecoModelsLoading(true);
    try {
      const result = await window.electronAPI.invoke(IPCChannel.DevEcoModels) as { success: boolean; models?: Array<{ id: string; name: string; contextWindow: number; maxOutput: number; thinkingMode: string; toolCallMode: string; inputModalities: string[] }>; error?: string };
      if (result.success && result.models) {
        setDevecoModels(result.models);
      } else {
        setDevecoModels([]);
      }
    } catch {
      setDevecoModels([]);
    } finally {
      setDevecoModelsLoading(false);
    }
  }, []);

  return (
    <div className="settings-tab-content">
      <h3 className="settings-section-title">LLM Configuration</h3>

      <div className="settings-field">
        <label className="settings-label">Provider</label>
        <select
          className="settings-select"
          value={config.llm.provider}
          onChange={e => {
            const newProvider = e.target.value;
            setConfig(prev => {
              if (!prev) return prev;
              if (newProvider === prev.llm.provider) return prev;

              // Read the target provider's saved config if present; otherwise
              // fall back to the provider defaults. Saving of the current
              // provider's config happens on Save (see useSettingsState).
              const saved = prev.llm.providerConfigs?.[newProvider];
              let newLlm: LLMConfig = saved
                ? { ...saved, provider: newProvider, providerConfigs: prev.llm.providerConfigs }
                : { ...prev.llm, ...PROVIDER_DEFAULTS[newProvider], provider: newProvider, providerConfigs: prev.llm.providerConfigs };

              // Freebuff uses a built-in base URL — clear any stale value
              // that may have leaked from the previous provider or an old save.
              if (newProvider === 'freebuff') {
                newLlm = { ...newLlm, baseUrl: undefined };
              }

              return { ...prev, llm: newLlm };
            });
          }}
        >
          <option value="mimo">MiMo</option>
          <option value="openai">OpenAI</option>
          <option value="deveco">DevEco</option>
          <option value="cline">Cline (Free Models)</option>
          <option value="freebuff">Freebuff (Free Models)</option>
        </select>
      </div>

      {isMiMo ? (
        <MiMoSection config={config} updateLLM={updateLLM} showApiKey={showApiKey} setShowApiKey={setShowApiKey} showCookies={showCookies} setShowCookies={setShowCookies} />
      ) : isDevEco ? (
        <DevEcoSection
          config={config} updateLLM={updateLLM}
          devecoModels={devecoModels} devecoModelsLoading={devecoModelsLoading} loadDevecoModels={loadDevecoModels}
          devecoAuthStatus={devecoAuthStatus} handleDevecoLogin={handleDevecoLogin} handleDevecoLogout={handleDevecoLogout}
          devecoLoginLoading={devecoLoginLoading} devecoLoginProgress={devecoLoginProgress}
        />
      ) : isCline ? (
        <ClineSection
          config={config} updateLLM={updateLLM}
          clineModels={clineModels} clineModelsLoading={clineModelsLoading} loadClineModels={loadClineModels}
          clineAuthStatus={clineAuthStatus} handleClineLogin={handleClineLogin} handleClineLogout={handleClineLogout}
          clineLoginLoading={clineLoginLoading} clineLoginProgress={clineLoginProgress}
          clineReasoningInfo={clineReasoningInfo} clineReasoningLoading={clineReasoningLoading}
          clineContextInfo={clineContextInfo} clineContextLoading={clineContextLoading}
        />
      ) : isFreebuff ? (
        <FreebuffSection
          config={config} updateLLM={updateLLM}
          freebuffModels={freebuffModels} freebuffModelsLoading={freebuffModelsLoading} loadFreebuffModels={loadFreebuffModels}
          freebuffAuthStatus={freebuffAuthStatus} handleFreebuffLogin={handleFreebuffLogin} handleFreebuffLogout={handleFreebuffLogout}
          freebuffLoginLoading={freebuffLoginLoading} freebuffLoginProgress={freebuffLoginProgress}
          freebuffReasoningInfo={freebuffReasoningInfo} freebuffReasoningLoading={freebuffReasoningLoading}
          freebuffContextInfo={freebuffContextInfo} freebuffContextLoading={freebuffContextLoading}
          freebuffSessionStatus={freebuffSessionStatus}
        />
      ) : (
        <OpenAISection config={config} setConfig={setConfig} persistConfig={persistConfig} showApiKey={showApiKey} setShowApiKey={setShowApiKey} />
      )}

      <div className="settings-field">
        <button
          className="settings-btn settings-btn-test"
          onClick={handleTestConnection}
          disabled={testing}
        >
          {testing ? 'Testing...' : 'Test Connection'}
        </button>
        {testResult && (
          <div className={`settings-test-result ${testResult.success ? 'test-success' : 'test-fail'}`}>
            {testResult.message}
          </div>
        )}
      </div>
    </div>
  );
}

/* ---- Provider sub-components ---- */

interface ProviderSectionBase {
  config: SessionConfig;
  updateLLM: <K extends keyof LLMConfig>(key: K, value: LLMConfig[K]) => void;
}
interface ShowApiKeyProps { showApiKey: boolean; setShowApiKey: (v: boolean) => void; }
interface ShowCookiesProps { showCookies: boolean; setShowCookies: (v: boolean) => void; }

function MiMoSection({ config, updateLLM, showApiKey, setShowApiKey, showCookies, setShowCookies }: ProviderSectionBase & ShowApiKeyProps & ShowCookiesProps) {
  return (
    <>
      <div className="settings-field">
        <label className="settings-label">Model</label>
        <input className="settings-input" type="text" value={config.llm.model} onChange={e => updateLLM('model', e.target.value)} placeholder="mimo-v2.5-pro" />
      </div>
      <div className="settings-field">
        <label className="settings-label">Base URL</label>
        <input className="settings-input" type="text" value={config.llm.baseUrl || ''} onChange={e => updateLLM('baseUrl', e.target.value)} placeholder="https://aistudio.xiaomimimo.com/open-apis/bot/chat" />
      </div>
      <div className="settings-field">
        <label className="settings-label">API Key <span className="settings-label-hint">(Official API, recommended)</span></label>
        <div className="settings-secret-field">
          <input className="settings-input settings-secret-input" type={showApiKey ? 'text' : 'password'} value={config.llm.apiKey || ''} onChange={e => updateLLM('apiKey', e.target.value)} placeholder="Get from platform.xiaomimimo.com" />
          <button className="settings-secret-toggle" onClick={() => setShowApiKey(!showApiKey)} type="button">{showApiKey ? <EyeOff size={14} /> : <Eye size={14} />}</button>
        </div>
        <span className="settings-hint">Apply at <a href="https://platform.xiaomimimo.com/console/api-keys" target="_blank" rel="noreferrer">platform.xiaomimimo.com</a> — free tier available</span>
      </div>
      <div className="settings-divider"><span className="settings-divider-text">OR use Cookie (MiMo Studio)</span></div>
      <div className="settings-field">
        <label className="settings-label">Cookies <span className="settings-label-hint">(Studio mode, may expire)</span></label>
        <div className="settings-secret-field settings-secret-field-textarea">
          <textarea className="settings-textarea settings-secret-input" value={showCookies ? (config.llm.cookies || '') : (config.llm.cookies ? '••••••••' : '')} onChange={e => updateLLM('cookies', e.target.value)} onFocus={() => { if (!showCookies) setShowCookies(true); }} rows={3} placeholder="Paste MiMo Studio cookies here..." />
          <button className="settings-secret-toggle" onClick={() => setShowCookies(!showCookies)} type="button">{showCookies ? <EyeOff size={14} /> : <Eye size={14} />}</button>
        </div>
        <span className="settings-hint">1. Open <a href="https://aistudio.xiaomimimo.com" target="_blank" rel="noreferrer">MiMo Studio</a> and login<br/>2. Press F12 → Application → Cookies<br/>3. Copy all cookie values (serviceToken, userId, etc.)</span>
      </div>
      <div className="settings-field">
        <label className="settings-label">Bot ID</label>
        <input className="settings-input" type="text" value={config.llm.botId || ''} onChange={e => updateLLM('botId', e.target.value)} placeholder="MiMo bot ID (optional)" />
      </div>
      <div className="settings-field">
        <label className="settings-label">Max Tokens <span className="settings-label-hint">(留空使用模型默认值)</span></label>
        <input className="settings-input" type="text" inputMode="numeric" value={config.llm.maxTokens ?? ''} onChange={e => updateLLM('maxTokens', e.target.value === '' ? undefined : (parseInt(e.target.value, 10) || undefined))} placeholder="留空使用模型默认值" />
      </div>
      <div className="settings-field">
        <label className="settings-label">Temperature <span className="settings-label-value">{config.llm.temperature.toFixed(2)}</span></label>
        <input className="settings-slider" type="range" min="0" max="2" step="0.01" value={config.llm.temperature} onChange={e => updateLLM('temperature', parseFloat(e.target.value))} />
      </div>
    </>
  );
}

/* ---- Cline Provider Section ---- */

interface ClineSectionProps extends ProviderSectionBase {
  clineModels: Array<{ id: string; name: string; description: string; tags: string[]; category: string }>;
  clineModelsLoading: boolean;
  loadClineModels: () => Promise<void>;
  clineAuthStatus: { loggedIn: boolean; email: string; expired: boolean } | null;
  handleClineLogin: () => Promise<void>;
  handleClineLogout: () => Promise<void>;
  clineLoginLoading: boolean;
  clineLoginProgress: string;
  clineReasoningInfo: { supportsReasoning: boolean; supportedEfforts: string[]; defaultEffort: string } | null;
  clineReasoningLoading: boolean;
  clineContextInfo: { contextWindow: number; maxInputTokens: number; maxOutputTokens: number } | null;
  clineContextLoading: boolean;
}

function ClineSection({
  config, updateLLM,
  clineModels, clineModelsLoading, loadClineModels,
  clineAuthStatus, handleClineLogin, handleClineLogout,
  clineLoginLoading, clineLoginProgress,
  clineReasoningInfo, clineReasoningLoading,
  clineContextInfo, clineContextLoading,
}: ClineSectionProps) {
  const [showModelDropdown, setShowModelDropdown] = useState(false);
  const [modelFilter, setModelFilter] = useState('');
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setShowModelDropdown(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Auto-open dropdown when models are loaded
  useEffect(() => {
    if (clineModels.length > 0 && !clineModelsLoading) {
      setShowModelDropdown(true);
    }
  }, [clineModels, clineModelsLoading]);

  const filteredModels = modelFilter
    ? clineModels.filter(m => m.id.toLowerCase().includes(modelFilter.toLowerCase()) || m.name.toLowerCase().includes(modelFilter.toLowerCase()))
    : clineModels;

  const selectModel = (modelId: string) => {
    updateLLM('model', modelId);
    setShowModelDropdown(false);
    setModelFilter('');
  };

  // Whether the current model supports reasoning (dynamically resolved)
  const supportsReasoning = clineReasoningInfo?.supportsReasoning === true;
  const supportedEfforts = clineReasoningInfo?.supportedEfforts ?? [];
  const defaultEffort = clineReasoningInfo?.defaultEffort ?? 'medium';

  // When reasoning support is detected and no effort is set yet, auto-apply the default.
  // NOTE: strict === undefined check — an explicit 'off' chosen by the user must
  // never be overridden (storing 'off' explicitly is what makes the first option selectable).
  useEffect(() => {
    if (supportsReasoning && defaultEffort && config.llm.options?.reasoningEffort === undefined) {
      updateLLM('options', { ...config.llm.options, reasoningEffort: defaultEffort });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supportsReasoning, defaultEffort]);

  // When context info is resolved, auto-apply contextWindow and maxTokens if not manually set
  useEffect(() => {
    if (!clineContextInfo) return;
    // Only auto-set if the user hasn't manually overridden these values
    // We detect "manual override" by checking if the current value differs from what we'd set
    const needsContextWindow = config.llm.contextWindow === undefined || config.llm.contextWindow === 128_000;
    const needsMaxTokens = config.llm.maxTokens === undefined;
    if (needsContextWindow) updateLLM('contextWindow', clineContextInfo.contextWindow);
    if (needsMaxTokens) updateLLM('maxTokens', clineContextInfo.maxOutputTokens);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clineContextInfo]);

  return (
    <>
      <div className="settings-field">
        <label className="settings-label">Cline 账号</label>
        {clineAuthStatus?.loggedIn ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <span style={{ color: 'var(--success)' }}>✓ 已登录: {clineAuthStatus.email}</span>
            {clineAuthStatus.expired && <span style={{ color: 'orange', fontSize: '12px' }}>(token 已过期，使用时自动刷新)</span>}
            <button type="button" className="settings-hint-button" style={{ padding: '4px 12px', fontSize: '12px', cursor: 'pointer', background: 'transparent', border: '1px solid var(--border)', borderRadius: '4px', color: 'var(--text-secondary)' }} onClick={handleClineLogout}>Logout</button>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <button type="button" style={{ padding: '8px 16px', fontSize: '13px', cursor: clineLoginLoading ? 'wait' : 'pointer', background: 'var(--accent)', border: 'none', borderRadius: '4px', color: '#fff', fontWeight: 500, alignSelf: 'flex-start' }} onClick={handleClineLogin} disabled={clineLoginLoading}>
              {clineLoginLoading ? (clineLoginProgress || '登录中...') : 'Login with Cline'}
            </button>
            <span className="settings-hint">点击按钮在浏览器中完成 Cline 账号登录（WorkOS Device Auth），登录后可使用免费模型</span>
          </div>
        )}
      </div>

      <div className="settings-field" style={{ position: 'relative' }} ref={dropdownRef}>
        <label className="settings-label">
          Model (Free)
          <button
            type="button"
            className="settings-hint-button"
            style={{ marginLeft: '8px', padding: '2px 8px', fontSize: '11px', cursor: clineModelsLoading ? 'wait' : 'pointer', background: 'transparent', border: '1px solid var(--border)', borderRadius: '3px', color: 'var(--text-secondary)', display: 'inline-flex', alignItems: 'center', gap: '4px' }}
            onClick={loadClineModels}
            disabled={clineModelsLoading}
            title="从 Cline API 获取免费模型列表"
          >
            {clineModelsLoading ? 'Fetching...' : 'Fetch Free Models'}
          </button>
        </label>
        <input
          className="settings-input"
          type="text"
          value={config.llm.model}
          onChange={e => {
            updateLLM('model', e.target.value);
            setModelFilter(e.target.value);
            if (clineModels.length > 0) setShowModelDropdown(true);
          }}
          onFocus={() => { if (clineModels.length > 0) { setModelFilter(''); setShowModelDropdown(true); } }}
          placeholder="cline-free/glm-5.2"
        />
        {showModelDropdown && filteredModels.length > 0 && (
          <div
            style={{
              position: 'absolute',
              top: '100%',
              left: 0,
              right: 0,
              maxHeight: '260px',
              overflowY: 'auto',
              background: 'var(--bg-secondary)',
              border: '1px solid var(--border)',
              borderRadius: '6px',
              marginTop: '2px',
              zIndex: 1000,
              boxShadow: '0 4px 16px rgba(0,0,0,0.35)',
            }}
          >
            {filteredModels.map(m => (
              <div
                key={m.id}
                onClick={() => selectModel(m.id)}
                style={{
                  padding: '8px 12px',
                  cursor: 'pointer',
                  fontSize: '13px',
                  color: m.id === config.llm.model ? 'var(--accent)' : 'var(--text-primary)',
                  background: m.id === config.llm.model ? 'rgba(212,167,106,0.12)' : 'transparent',
                  borderBottom: '1px solid var(--border)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '2px',
                  transition: 'background 0.15s',
                }}
                onMouseEnter={e => { if (m.id !== config.llm.model) (e.currentTarget as HTMLDivElement).style.background = 'var(--bg-hover)'; }}
                onMouseLeave={e => { if (m.id !== config.llm.model) (e.currentTarget as HTMLDivElement).style.background = 'transparent'; }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: '12px' }}>{m.id}</span>
                  <span style={{ fontSize: '11px', color: 'var(--text-muted)', flexShrink: 0, marginLeft: '8px' }}>
                    🆓 {m.tags?.filter(t => t !== 'FREE' && t !== 'BEST' && t !== 'NEW').join(', ')}
                  </span>
                </div>
                {m.description && (
                  <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{m.description}</span>
                )}
              </div>
            ))}
          </div>
        )}
        {clineModels.length > 0 && !showModelDropdown && (
          <span className="settings-hint" style={{ marginTop: '4px' }}>共 {clineModels.length} 个免费模型，点击输入框查看列表</span>
        )}
        {clineModels.length === 0 && !clineModelsLoading && (
          <span className="settings-hint" style={{ marginTop: '4px' }}>点击 "Fetch Free Models" 获取可用免费模型列表</span>
        )}
      </div>

      {/* Reasoning / Thinking Effort — dynamically shown based on model capability */}
      {clineReasoningLoading ? (
        <div className="settings-field">
          <label className="settings-label">Thinking Effort</label>
          <span className="settings-hint" style={{ color: 'var(--text-muted)' }}>正在检测模型推理能力...</span>
        </div>
      ) : supportsReasoning ? (
        <div className="settings-field">
          <label className="settings-label">
            Thinking Effort
            <span style={{ marginLeft: '6px', fontSize: '11px', color: 'var(--success)', fontWeight: 400 }}>
              ✓ 当前模型支持推理
            </span>
          </label>
          <select
            className="settings-select"
            value={(config.llm.options?.reasoningEffort as string) ?? defaultEffort}
            onChange={e => updateLLM('options', { ...config.llm.options, reasoningEffort: e.target.value })}
          >
            <option value="off">关闭 (off)</option>
            {supportedEfforts.length > 0 ? (
              supportedEfforts.map(effort => (
                <option key={effort} value={effort}>{effort}</option>
              ))
            ) : (
              <>
                <option value="low">低 (low)</option>
                <option value="medium">中 (medium)</option>
                <option value="high">高 (high)</option>
                <option value="xhigh">超高 (xhigh)</option>
                <option value="max">最高 (max)</option>
              </>
            )}
          </select>
          <span className="settings-hint">
            当前模型支持推理/思考模式，开启后模型会先推理再回答。支持的级别: {supportedEfforts.length > 0 ? supportedEfforts.join(', ') : 'low, medium, high, xhigh, max'}
          </span>
        </div>
      ) : config.llm.model ? (
        <div className="settings-field">
          <label className="settings-label">Thinking Effort</label>
          <span className="settings-hint" style={{ color: 'var(--text-muted)' }}>
            当前模型不支持推理/思考模式，Thinking Effort 不可用
          </span>
        </div>
      ) : null}

      <div className="settings-field">
        <label className="settings-label">Base URL</label>
        <input className="settings-input" type="text" value={config.llm.baseUrl || ''} onChange={e => updateLLM('baseUrl', e.target.value)} placeholder="https://api.cline.bot/api/v1/chat/completions" />
      </div>
      <div className="settings-field">
        <label className="settings-label">
          Context Window
          {clineContextLoading ? (
            <span style={{ marginLeft: '6px', fontSize: '11px', color: 'var(--text-muted)' }}>正在检测...</span>
          ) : clineContextInfo ? (
            <span style={{ marginLeft: '6px', fontSize: '11px', color: 'var(--success)', fontWeight: 400 }}>
              ✓ 自动检测: {clineContextInfo.contextWindow.toLocaleString()} tokens (最大输入: {clineContextInfo.maxInputTokens.toLocaleString()})
            </span>
          ) : null}
        </label>
        <input className="settings-input" type="text" inputMode="numeric" value={config.llm.contextWindow ?? ''} onChange={e => updateLLM('contextWindow', e.target.value === '' ? undefined : (parseInt(e.target.value, 10) || undefined))} placeholder={clineContextInfo ? String(clineContextInfo.contextWindow) : '留空使用模型默认值'} />
        <span className="settings-hint">模型的上下文窗口大小（tokens），留空则使用自动检测值</span>
      </div>
      <div className="settings-field">
        <label className="settings-label">
          Max Tokens
          {clineContextInfo ? (
            <span style={{ marginLeft: '6px', fontSize: '11px', color: 'var(--success)', fontWeight: 400 }}>
              ✓ 自动检测: {clineContextInfo.maxOutputTokens.toLocaleString()} tokens
            </span>
          ) : null}
        </label>
        <input className="settings-input" type="text" inputMode="numeric" value={config.llm.maxTokens ?? ''} onChange={e => updateLLM('maxTokens', e.target.value === '' ? undefined : (parseInt(e.target.value, 10) || undefined))} placeholder={clineContextInfo ? String(clineContextInfo.maxOutputTokens) : '留空使用模型默认值'} />
        <span className="settings-hint">模型最大输出 tokens，留空则使用自动检测值</span>
      </div>
      <div className="settings-field">
        <label className="settings-label">Temperature <span className="settings-label-value">{config.llm.temperature.toFixed(2)}</span></label>
        <input className="settings-slider" type="range" min="0" max="2" step="0.01" value={config.llm.temperature} onChange={e => updateLLM('temperature', parseFloat(e.target.value))} />
      </div>
    </>
  );
}

interface FreebuffSectionProps extends ProviderSectionBase {
  freebuffModels: Array<{ id: string; name: string; contextWindow: number; reasoning: boolean; reasoningEffort?: string; efforts?: string[]; defaultEffort?: string; premium: boolean; tagline?: string }>;
  freebuffModelsLoading: boolean;
  loadFreebuffModels: () => Promise<void>;
  freebuffAuthStatus: { loggedIn: boolean; email: string; expired: boolean } | null;
  handleFreebuffLogin: () => Promise<void>;
  handleFreebuffLogout: () => Promise<void>;
  freebuffLoginLoading: boolean;
  freebuffLoginProgress: string;
  freebuffReasoningInfo: { supportsReasoning: boolean; supportedEfforts: string[]; defaultEffort: string } | null;
  freebuffReasoningLoading: boolean;
  freebuffContextInfo: { contextWindow: number; maxInputTokens: number; maxOutputTokens: number } | null;
  freebuffContextLoading: boolean;
  freebuffSessionStatus: { active: boolean; model?: string; expiresAt?: string; instanceId?: string } | null;
}

function FreebuffSection({
  config, updateLLM,
  freebuffModels, freebuffModelsLoading, loadFreebuffModels,
  freebuffAuthStatus, handleFreebuffLogin, handleFreebuffLogout,
  freebuffLoginLoading, freebuffLoginProgress,
  freebuffReasoningInfo, freebuffReasoningLoading,
  freebuffContextInfo, freebuffContextLoading,
  freebuffSessionStatus,
}: FreebuffSectionProps) {
  const [showModelDropdown, setShowModelDropdown] = useState(false);
  const [modelFilter, setModelFilter] = useState('');
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setShowModelDropdown(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Auto-open dropdown when models are loaded
  useEffect(() => {
    if (freebuffModels.length > 0 && !freebuffModelsLoading) {
      setShowModelDropdown(true);
    }
  }, [freebuffModels, freebuffModelsLoading]);

  const filteredModels = modelFilter
    ? freebuffModels.filter(m => m.id.toLowerCase().includes(modelFilter.toLowerCase()) || m.name.toLowerCase().includes(modelFilter.toLowerCase()))
    : freebuffModels;

  const selectModel = (modelId: string) => {
    updateLLM('model', modelId);
    setShowModelDropdown(false);
    setModelFilter('');
  };

  // Whether the current model supports reasoning (dynamically resolved)
  const supportsReasoning = freebuffReasoningInfo?.supportsReasoning === true;
  const supportedEfforts = freebuffReasoningInfo?.supportedEfforts ?? [];
  const defaultEffort = freebuffReasoningInfo?.defaultEffort ?? 'high';

  // When reasoning support is detected and no effort is set yet, auto-apply the default.
  useEffect(() => {
    if (supportsReasoning && defaultEffort && config.llm.options?.reasoningEffort === undefined) {
      updateLLM('options', { ...config.llm.options, reasoningEffort: defaultEffort });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supportsReasoning, defaultEffort]);

  // When context info is resolved, auto-apply contextWindow and maxTokens if not manually set
  useEffect(() => {
    if (!freebuffContextInfo) return;
    const needsContextWindow = config.llm.contextWindow === undefined || config.llm.contextWindow === 131_072;
    const needsMaxTokens = config.llm.maxTokens === undefined;
    if (needsContextWindow) updateLLM('contextWindow', freebuffContextInfo.contextWindow);
    if (needsMaxTokens) updateLLM('maxTokens', freebuffContextInfo.maxOutputTokens);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [freebuffContextInfo]);

  return (
    <>
      {/* Auth section */}
      <div className="settings-field">
        <label className="settings-label">Freebuff 账号</label>
        {freebuffAuthStatus?.loggedIn ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <span style={{ color: 'var(--success)' }}>✓ 已登录: {freebuffAuthStatus.email}</span>
            {freebuffAuthStatus.expired && <span style={{ color: 'orange', fontSize: '12px' }}>(token 已过期)</span>}
            <button type="button" className="settings-hint-button" style={{ padding: '4px 12px', fontSize: '12px', cursor: 'pointer', background: 'transparent', border: '1px solid var(--border)', borderRadius: '4px', color: 'var(--text-secondary)' }} onClick={handleFreebuffLogout}>Logout</button>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <button type="button" style={{ padding: '8px 16px', fontSize: '13px', cursor: freebuffLoginLoading ? 'wait' : 'pointer', background: 'var(--accent)', border: 'none', borderRadius: '4px', color: '#fff', fontWeight: 500, alignSelf: 'flex-start' }} onClick={handleFreebuffLogin} disabled={freebuffLoginLoading}>
              {freebuffLoginLoading ? (freebuffLoginProgress || '登录中...') : 'Login with Freebuff'}
            </button>
            <span className="settings-hint">点击按钮在浏览器中完成 Freebuff 账号登录（Device Code Auth），登录后可使用免费模型</span>
          </div>
        )}
      </div>

      {/* Session status */}
      {freebuffSessionStatus?.active && (
        <div className="settings-field">
          <label className="settings-label">会话状态</label>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ color: 'var(--success)', fontSize: '13px' }}>🟢 活跃会话</span>
            <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
              模型: {freebuffSessionStatus.model}
              {freebuffSessionStatus.expiresAt && ` · 过期: ${new Date(freebuffSessionStatus.expiresAt).toLocaleTimeString()}`}
            </span>
          </div>
        </div>
      )}

      {/* Model selector */}
      <div className="settings-field" style={{ position: 'relative' }} ref={dropdownRef}>
        <label className="settings-label">
          Model (Free)
          <button
            type="button"
            className="settings-hint-button"
            style={{ marginLeft: '8px', padding: '2px 8px', fontSize: '11px', cursor: freebuffModelsLoading ? 'wait' : 'pointer', background: 'transparent', border: '1px solid var(--border)', borderRadius: '3px', color: 'var(--text-secondary)', display: 'inline-flex', alignItems: 'center', gap: '4px' }}
            onClick={loadFreebuffModels}
            disabled={freebuffModelsLoading}
            title="从 Freebuff 获取免费模型列表"
          >
            {freebuffModelsLoading ? 'Fetching...' : 'Fetch Free Models'}
          </button>
        </label>
        <input
          className="settings-input"
          type="text"
          value={config.llm.model}
          onChange={e => {
            updateLLM('model', e.target.value);
            setModelFilter(e.target.value);
            if (freebuffModels.length > 0) setShowModelDropdown(true);
          }}
          onFocus={() => { if (freebuffModels.length > 0) { setModelFilter(''); setShowModelDropdown(true); } }}
          placeholder="deepseek/deepseek-v4-flash"
        />
        {showModelDropdown && filteredModels.length > 0 && (
          <div
            style={{
              position: 'absolute',
              top: '100%',
              left: 0,
              right: 0,
              maxHeight: '260px',
              overflowY: 'auto',
              background: 'var(--bg-secondary)',
              border: '1px solid var(--border)',
              borderRadius: '6px',
              marginTop: '2px',
              zIndex: 1000,
              boxShadow: '0 4px 16px rgba(0,0,0,0.35)',
            }}
          >
            {filteredModels.map(m => (
              <div
                key={m.id}
                onClick={() => selectModel(m.id)}
                style={{
                  padding: '8px 12px',
                  cursor: 'pointer',
                  fontSize: '13px',
                  color: m.id === config.llm.model ? 'var(--accent)' : 'var(--text-primary)',
                  background: m.id === config.llm.model ? 'rgba(212,167,106,0.12)' : 'transparent',
                  borderBottom: '1px solid var(--border)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '2px',
                  transition: 'background 0.15s',
                }}
                onMouseEnter={e => { if (m.id !== config.llm.model) (e.currentTarget as HTMLDivElement).style.background = 'var(--bg-hover)'; }}
                onMouseLeave={e => { if (m.id !== config.llm.model) (e.currentTarget as HTMLDivElement).style.background = 'transparent'; }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: '12px' }}>{m.id}</span>
                  <span style={{ fontSize: '11px', color: 'var(--text-muted)', flexShrink: 0, marginLeft: '8px' }}>
                    🆓 {m.premium ? '⭐ Premium' : 'Free'} {m.reasoning ? '🧠' : ''}
                  </span>
                </div>
                {m.tagline && (
                  <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{m.tagline}</span>
                )}
                <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>
                  上下文: {m.contextWindow.toLocaleString()} tokens
                </span>
              </div>
            ))}
          </div>
        )}
        {freebuffModels.length > 0 && !showModelDropdown && (
          <span className="settings-hint" style={{ marginTop: '4px' }}>共 {freebuffModels.length} 个免费模型，点击输入框查看列表</span>
        )}
        {freebuffModels.length === 0 && !freebuffModelsLoading && (
          <span className="settings-hint" style={{ marginTop: '4px' }}>点击 "Fetch Free Models" 获取可用免费模型列表</span>
        )}
      </div>

      {/* Reasoning / Thinking Effort */}
      {freebuffReasoningLoading ? (
        <div className="settings-field">
          <label className="settings-label">Thinking Effort</label>
          <span className="settings-hint" style={{ color: 'var(--text-muted)' }}>正在检测模型推理能力...</span>
        </div>
      ) : supportsReasoning ? (
        <div className="settings-field">
          <label className="settings-label">
            Thinking Effort
            <span style={{ marginLeft: '6px', fontSize: '11px', color: 'var(--success)', fontWeight: 400 }}>
              ✓ 当前模型支持推理
            </span>
          </label>
          <select
            className="settings-select"
            value={(config.llm.options?.reasoningEffort as string) ?? defaultEffort}
            onChange={e => updateLLM('options', { ...config.llm.options, reasoningEffort: e.target.value })}
          >
            <option value="off">关闭 (off)</option>
            {supportedEfforts.length > 0 ? (
              supportedEfforts.map(effort => (
                <option key={effort} value={effort}>{effort}</option>
              ))
            ) : (
              <>
                <option value="low">低 (low)</option>
                <option value="medium">中 (medium)</option>
                <option value="high">高 (high)</option>
                <option value="xhigh">超高 (xhigh)</option>
                <option value="max">最高 (max)</option>
              </>
            )}
          </select>
          <span className="settings-hint">
            Freebuff 原生推理模式：模型先思考再回答，思考内容通过 reasoning_content 字段回传。支持的级别: {supportedEfforts.length > 0 ? supportedEfforts.join(', ') : 'low, medium, high, xhigh, max'}
          </span>
        </div>
      ) : config.llm.model ? (
        <div className="settings-field">
          <label className="settings-label">Thinking Effort</label>
          <span className="settings-hint" style={{ color: 'var(--text-muted)' }}>
            当前模型不支持推理/思考模式，Thinking Effort 不可用
          </span>
        </div>
      ) : null}

      <div className="settings-field">
        <label className="settings-label">
          Context Window
          {freebuffContextLoading ? (
            <span style={{ marginLeft: '6px', fontSize: '11px', color: 'var(--text-muted)' }}>正在检测...</span>
          ) : freebuffContextInfo ? (
            <span style={{ marginLeft: '6px', fontSize: '11px', color: 'var(--success)', fontWeight: 400 }}>
              ✓ 自动检测: {freebuffContextInfo.contextWindow.toLocaleString()} tokens (最大输入: {freebuffContextInfo.maxInputTokens.toLocaleString()})
            </span>
          ) : null}
        </label>
        <input className="settings-input" type="text" inputMode="numeric" value={config.llm.contextWindow ?? ''} onChange={e => updateLLM('contextWindow', e.target.value === '' ? undefined : (parseInt(e.target.value, 10) || undefined))} placeholder={freebuffContextInfo ? String(freebuffContextInfo.contextWindow) : '留空使用模型默认值'} />
        <span className="settings-hint">模型的上下文窗口大小（tokens），留空则使用自动检测值</span>
      </div>
      <div className="settings-field">
        <label className="settings-label">
          Max Tokens
          {freebuffContextInfo ? (
            <span style={{ marginLeft: '6px', fontSize: '11px', color: 'var(--success)', fontWeight: 400 }}>
              ✓ 自动检测: {freebuffContextInfo.maxOutputTokens.toLocaleString()} tokens
            </span>
          ) : null}
        </label>
        <input className="settings-input" type="text" inputMode="numeric" value={config.llm.maxTokens ?? ''} onChange={e => updateLLM('maxTokens', e.target.value === '' ? undefined : (parseInt(e.target.value, 10) || undefined))} placeholder={freebuffContextInfo ? String(freebuffContextInfo.maxOutputTokens) : '留空使用模型默认值'} />
        <span className="settings-hint">模型最大输出 tokens，留空则使用自动检测值</span>
      </div>
      <div className="settings-field">
        <label className="settings-label">Temperature <span className="settings-label-value">{config.llm.temperature.toFixed(2)}</span></label>
        <input className="settings-slider" type="range" min="0" max="2" step="0.01" value={config.llm.temperature} onChange={e => updateLLM('temperature', parseFloat(e.target.value))} />
      </div>
    </>
  );
}

interface DevEcoSectionProps extends ProviderSectionBase {
  devecoModels: Array<{ id: string; name: string; contextWindow: number; maxOutput: number; thinkingMode: string; toolCallMode: string; inputModalities: string[] }>;
  devecoModelsLoading: boolean;
  loadDevecoModels: () => void;
  devecoAuthStatus: { loggedIn: boolean; userName: string; expired: boolean } | null;
  handleDevecoLogin: () => void;
  handleDevecoLogout: () => void;
  devecoLoginLoading: boolean;
  devecoLoginProgress: string;
}

function DevEcoSection({ config, updateLLM, devecoModels, devecoModelsLoading, loadDevecoModels, devecoAuthStatus, handleDevecoLogin, handleDevecoLogout, devecoLoginLoading, devecoLoginProgress }: DevEcoSectionProps) {
  return (
    <>
      <div className="settings-field">
        <label className="settings-label">
          Model
          <button type="button" className="settings-hint-button" style={{ marginLeft: '8px', padding: '0 6px', fontSize: '11px', cursor: 'pointer', background: 'transparent', border: '1px solid var(--border)', borderRadius: '3px', color: 'var(--text-secondary)' }} onClick={loadDevecoModels} disabled={devecoModelsLoading}>
            {devecoModelsLoading ? 'Loading...' : 'Refresh'}
          </button>
        </label>
        <select className="settings-select" value={config.llm.model} onChange={e => updateLLM('model', e.target.value)}>
          {devecoModels.length > 0 ? (
            devecoModels.map(m => (<option key={m.id} value={m.id}>{m.name}{m.thinkingMode === 'on' ? ' (thinking)' : ''}{m.toolCallMode === 'tool_calls' ? ' (tool_call)' : ''}</option>))
          ) : (
            <option value={config.llm.model || 'GLM-5.1'}>{config.llm.model || 'GLM-5.1'} (点击 Refresh 加载)</option>
          )}
        </select>
        {devecoModels.length > 0 && <span className="settings-hint">共 {devecoModels.length} 个可用模型，点击 Refresh 刷新列表</span>}
      </div>
      <div className="settings-field">
        <label className="settings-label">华为 DevEco 账号</label>
        {devecoAuthStatus?.loggedIn ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <span style={{ color: 'var(--success)' }}>✓ 已登录: {devecoAuthStatus.userName}</span>
            {devecoAuthStatus.expired && <span style={{ color: 'orange', fontSize: '12px' }}>(token 已过期，使用时自动刷新)</span>}
            <button type="button" className="settings-hint-button" style={{ padding: '4px 12px', fontSize: '12px', cursor: 'pointer', background: 'transparent', border: '1px solid var(--border)', borderRadius: '4px', color: 'var(--text-secondary)' }} onClick={handleDevecoLogout}>Logout</button>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <button type="button" style={{ padding: '8px 16px', fontSize: '13px', cursor: devecoLoginLoading ? 'wait' : 'pointer', background: 'var(--accent)', border: 'none', borderRadius: '4px', color: '#fff', fontWeight: 500, alignSelf: 'flex-start' }} onClick={handleDevecoLogin} disabled={devecoLoginLoading}>
              {devecoLoginLoading ? (devecoLoginProgress || '登录中...') : 'Login with Huawei'}
            </button>
            <span className="settings-hint">点击按钮在浏览器中完成华为账号登录</span>
          </div>
        )}
      </div>
      <div className="settings-field"><label className="settings-label">Context Window <span className="settings-label-hint">(tokens, 留空使用模型默认值)</span></label><input className="settings-input" type="text" inputMode="numeric" value={config.llm.contextWindow ?? ''} onChange={e => updateLLM('contextWindow', e.target.value === '' ? undefined : (parseInt(e.target.value, 10) || undefined))} placeholder="留空使用模型默认值" /></div>
      <div className="settings-field"><label className="settings-label">Max Tokens <span className="settings-label-hint">(留空使用模型默认值)</span></label><input className="settings-input" type="text" inputMode="numeric" value={config.llm.maxTokens ?? ''} onChange={e => updateLLM('maxTokens', e.target.value === '' ? undefined : (parseInt(e.target.value, 10) || undefined))} placeholder="留空使用模型默认值" /></div>
      <div className="settings-field">
        <label className="settings-label">Temperature <span className="settings-label-value">{config.llm.temperature.toFixed(2)}</span></label>
        <input className="settings-slider" type="range" min="0" max="2" step="0.01" value={config.llm.temperature} onChange={e => updateLLM('temperature', parseFloat(e.target.value))} />
      </div>
    </>
  );
}


function OpenAISection({ config, setConfig, persistConfig, showApiKey, setShowApiKey }: { config: SessionConfig; setConfig: React.Dispatch<React.SetStateAction<SessionConfig | null>>; persistConfig: (config: SessionConfig) => Promise<void> } & ShowApiKeyProps) {
  // ── OpenAI profile (multi-endpoint) management ──
  const profiles = config.llm.openaiProfiles || {};
  const profileNames = Object.keys(profiles);
  const activeProfile = config.llm.activeOpenaiProfile;
  const activeProfileData = activeProfile ? profiles[activeProfile] : undefined;

  // Load a profile into the active llm config (keeps providerConfigs intact).
  const applyProfile = (name: string) => {
    const profile = profiles[name];
    if (!profile) return;
    setConfig(prev => {
      if (!prev) return prev;
      return {
        ...prev,
        llm: {
          ...prev.llm,
          ...profile,
          provider: 'openai',
          providerConfigs: prev.llm.providerConfigs,
          openaiProfiles: prev.llm.openaiProfiles,
          activeOpenaiProfile: name,
        },
      };
    });
  };

  const deleteProfile = (name: string) => {
    const nextProfiles = { ...(config.llm.openaiProfiles || {}) };
    delete nextProfiles[name];
    const wasActive = config.llm.activeOpenaiProfile === name;
    const next: SessionConfig = {
      ...config,
      llm: {
        ...config.llm,
        openaiProfiles: nextProfiles,
        activeOpenaiProfile: wasActive ? undefined : config.llm.activeOpenaiProfile,
      },
    };
    setConfig(next);
    void persistConfig(next);
  };

  // ── Add/Edit-model modal state ──
  const [showAddModal, setShowAddModal] = useState(false);
  // Name of the profile being edited (null = adding a new profile)
  const [editingProfileName, setEditingProfileName] = useState<string | null>(null);
  const [draftName, setDraftName] = useState('');
  const [draftBaseUrl, setDraftBaseUrl] = useState('');
  const [draftApiKey, setDraftApiKey] = useState('');
  const [draftModel, setDraftModel] = useState('');
  const [draftReasoning, setDraftReasoning] = useState('');
  const [draftContextWindow, setDraftContextWindow] = useState('');
  const [draftMaxTokens, setDraftMaxTokens] = useState('');
  const [draftTemperature, setDraftTemperature] = useState(0.7);
  const [draftExtraBody, setDraftExtraBody] = useState('');
  const [draftExtraBodyError, setDraftExtraBodyError] = useState<string | null>(null);
  const [draftShowApiKey, setDraftShowApiKey] = useState(false);

  // Model fetching inside the modal
  const [openaiModels, setOpenaiModels] = useState<Array<{ id: string; name: string; ownedBy: string }>>([]);
  const [openaiModelsLoading, setOpenaiModelsLoading] = useState(false);
  const [openaiModelsError, setOpenaiModelsError] = useState<string | null>(null);
  const [showModelDropdown, setShowModelDropdown] = useState(false);
  const [modelFilter, setModelFilter] = useState('');
  const [openaiReasoningInfo, setOpenaiReasoningInfo] = useState<{ supportsReasoning: boolean; supportedEfforts: string[]; defaultEffort: string } | null>(null);
  const [openaiReasoningLoading, setOpenaiReasoningLoading] = useState(false);
  const [openaiContextInfo, setOpenaiContextInfo] = useState<{ contextWindow: number; maxInputTokens: number; maxOutputTokens: number } | null>(null);
  const [openaiContextLoading, setOpenaiContextLoading] = useState(false);
  const [openaiMetadataAutoSyncEnabled, setOpenaiMetadataAutoSyncEnabled] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const lastOpenAIAutoFillRef = useRef<{ reasoning: string; contextWindow: string; maxTokens: string }>({
    reasoning: '',
    contextWindow: '',
    maxTokens: '',
  });
  // Tracks whether the user manually changed the reasoning select during this
  // modal session. Prevents metadata auto-sync from overriding an explicit
  // choice — especially "off" (the first option).
  const reasoningUserTouchedRef = useRef(false);

  const fetchOpenaiModels = useCallback(async () => {
    setOpenaiModelsLoading(true);
    setOpenaiModelsError(null);
    try {
      const res = await window.electronAPI.invoke(IPCChannel.FetchOpenaiModels, {
        baseUrl: draftBaseUrl,
        apiKey: draftApiKey,
      }) as { success: boolean; models?: Array<{ id: string; name: string; ownedBy: string }>; error?: string };
      if (res.success && res.models) {
        setOpenaiModels(res.models);
        setModelFilter('');
        setShowModelDropdown(true);
      } else {
        setOpenaiModels([]);
        setOpenaiModelsError(res.error || 'Failed to fetch models');
      }
    } catch (err) {
      setOpenaiModels([]);
      setOpenaiModelsError(err instanceof Error ? err.message : String(err));
    } finally {
      setOpenaiModelsLoading(false);
    }
  }, [draftBaseUrl, draftApiKey]);

  const filteredModels = modelFilter
    ? openaiModels.filter(m => m.id.toLowerCase().includes(modelFilter.toLowerCase()))
    : openaiModels;

  const handleModelInputFocus = () => {
    if (openaiModels.length > 0) {
      setModelFilter('');
      setShowModelDropdown(true);
    }
  };

  const selectModel = (modelId: string) => {
    setOpenaiMetadataAutoSyncEnabled(true);
    setDraftModel(modelId);
    setShowModelDropdown(false);
    setModelFilter('');
  };

  const supportsOpenAIReasoning = openaiReasoningInfo?.supportsReasoning === true;
  const openaiSupportedEfforts = openaiReasoningInfo?.supportedEfforts ?? [];
  const openaiDefaultEffort = openaiReasoningInfo?.defaultEffort ?? 'medium';
  const openaiSupportedEffortsKey = openaiSupportedEfforts.join('|');

  useEffect(() => {
    if (!showAddModal || !draftModel.trim()) {
      setOpenaiReasoningInfo(null);
      setOpenaiContextInfo(null);
      setOpenaiReasoningLoading(false);
      setOpenaiContextLoading(false);
      return;
    }

    let cancelled = false;
    const loadOpenAIMetadata = async () => {
      setOpenaiReasoningLoading(true);
      setOpenaiContextLoading(true);
      try {
        const [reasoningResult, contextResult] = await Promise.all([
          window.electronAPI.invoke(IPCChannel.OpenAIModelReasoning, draftModel.trim()) as Promise<{
            success: boolean;
            supportsReasoning: boolean;
            supportedEfforts: string[];
            defaultEffort: string;
          }>,
          window.electronAPI.invoke(IPCChannel.OpenAIModelContextInfo, draftModel.trim()) as Promise<{
            success: boolean;
            contextWindow: number;
            maxInputTokens: number;
            maxOutputTokens: number;
          }>,
        ]);

        if (cancelled) return;

        setOpenaiReasoningInfo(reasoningResult.success ? {
          supportsReasoning: reasoningResult.supportsReasoning,
          supportedEfforts: reasoningResult.supportedEfforts ?? [],
          defaultEffort: reasoningResult.defaultEffort ?? '',
        } : null);

        setOpenaiContextInfo(contextResult.success ? {
          contextWindow: contextResult.contextWindow,
          maxInputTokens: contextResult.maxInputTokens,
          maxOutputTokens: contextResult.maxOutputTokens,
        } : null);
      } catch {
        if (cancelled) return;
        setOpenaiReasoningInfo(null);
        setOpenaiContextInfo(null);
      } finally {
        if (!cancelled) {
          setOpenaiReasoningLoading(false);
          setOpenaiContextLoading(false);
        }
      }
    };

    const timer = window.setTimeout(() => {
      void loadOpenAIMetadata();
    }, 250);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [showAddModal, draftModel]);

  useEffect(() => {
    if (!showAddModal || !openaiMetadataAutoSyncEnabled || !openaiReasoningInfo) return;

    const currentReasoning = draftReasoning || 'off';
    const nextReasoning = supportsOpenAIReasoning ? openaiDefaultEffort : 'off';
    const isCurrentSupported = currentReasoning === 'off' || openaiSupportedEfforts.includes(currentReasoning);
    // Never override a value the user explicitly chose in this modal session —
    // including "off" (the first option). Auto-fill only applies while the field
    // is untouched; an unsupported value is still corrected ('off' is always supported).
    const shouldAutoReplace = (!reasoningUserTouchedRef.current && (
      currentReasoning === ''
      || currentReasoning === 'off'
      || currentReasoning === lastOpenAIAutoFillRef.current.reasoning
    )) || !isCurrentSupported;

    if (!shouldAutoReplace || currentReasoning === nextReasoning) return;

    lastOpenAIAutoFillRef.current.reasoning = nextReasoning;
    setDraftReasoning(nextReasoning);
  }, [showAddModal, openaiMetadataAutoSyncEnabled, openaiReasoningInfo, draftReasoning, supportsOpenAIReasoning, openaiDefaultEffort, openaiSupportedEffortsKey]);

  useEffect(() => {
    if (!showAddModal || !openaiMetadataAutoSyncEnabled || !openaiContextInfo) return;

    const nextContextWindow = String(openaiContextInfo.contextWindow);
    const nextMaxTokens = String(openaiContextInfo.maxOutputTokens);

    if ((draftContextWindow.trim() === '' || draftContextWindow === lastOpenAIAutoFillRef.current.contextWindow) && draftContextWindow !== nextContextWindow) {
      lastOpenAIAutoFillRef.current.contextWindow = nextContextWindow;
      setDraftContextWindow(nextContextWindow);
    }

    if ((draftMaxTokens.trim() === '' || draftMaxTokens === lastOpenAIAutoFillRef.current.maxTokens) && draftMaxTokens !== nextMaxTokens) {
      lastOpenAIAutoFillRef.current.maxTokens = nextMaxTokens;
      setDraftMaxTokens(nextMaxTokens);
    }
  }, [showAddModal, openaiMetadataAutoSyncEnabled, openaiContextInfo, draftContextWindow, draftMaxTokens]);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setShowModelDropdown(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
}, []);

  const openAddModal = () => {
    setEditingProfileName(null);
    setDraftName('');
    setDraftBaseUrl('https://api.openai.com/v1/chat/completions');
    setDraftApiKey('');
    setDraftModel('gpt-4o');
    setDraftReasoning('off');
    setDraftContextWindow('');
    setDraftMaxTokens('');
    setDraftTemperature(0.7);
    setDraftExtraBody('');
    setDraftExtraBodyError(null);
    setOpenaiModels([]);
    setOpenaiModelsError(null);
    setOpenaiReasoningInfo(null);
    setOpenaiReasoningLoading(false);
    setOpenaiContextInfo(null);
    setOpenaiContextLoading(false);
    setOpenaiMetadataAutoSyncEnabled(false);
    lastOpenAIAutoFillRef.current = { reasoning: '', contextWindow: '', maxTokens: '' };
    reasoningUserTouchedRef.current = false;
    setShowModelDropdown(false);
    setShowAddModal(true);
  };

  // Open the modal pre-filled with an existing profile's values for editing.
  const openEditModal = (name: string) => {
    const profile = profiles[name];
    if (!profile) return;
    setEditingProfileName(name);
    setDraftName(name);
    setDraftBaseUrl(profile.baseUrl || '');
    setDraftApiKey(profile.apiKey || '');
    setDraftModel(profile.model || '');
    setDraftReasoning((profile.options?.reasoningEffort as string) || 'off');
    setDraftContextWindow(profile.contextWindow === undefined ? '' : String(profile.contextWindow));
    setDraftMaxTokens(profile.maxTokens === undefined ? '' : String(profile.maxTokens));
    setDraftTemperature(profile.temperature ?? 0.7);
    setDraftExtraBody(profile.options?.extraBody && typeof profile.options.extraBody === 'object' ? JSON.stringify(profile.options.extraBody, null, 2) : '');
    setDraftExtraBodyError(null);
    setOpenaiModels([]);
    setOpenaiModelsError(null);
    setOpenaiReasoningInfo(null);
    setOpenaiReasoningLoading(false);
    setOpenaiContextInfo(null);
    setOpenaiContextLoading(false);
    setOpenaiMetadataAutoSyncEnabled(false);
    lastOpenAIAutoFillRef.current = { reasoning: '', contextWindow: '', maxTokens: '' };
    reasoningUserTouchedRef.current = false;
    setShowModelDropdown(false);
    setShowAddModal(true);
  };

  const handleDraftExtraBodyChange = (text: string) => {
    setDraftExtraBody(text);
    const trimmed = text.trim();
    if (trimmed === '') {
      setDraftExtraBodyError(null);
      return;
    }
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        setDraftExtraBodyError(null);
      } else {
        setDraftExtraBodyError('必须是一个 JSON 对象（如 {"chat_template_kwargs": {"enable_thinking": true}}）');
      }
    } catch {
      setDraftExtraBodyError('JSON 格式错误，请检查');
    }
  };

  const saveNewProfile = () => {
    const name = draftName.trim();
    if (!name) return;
    if (draftExtraBodyError) return;
    const extraBody = draftExtraBody.trim() ? JSON.parse(draftExtraBody.trim()) : undefined;
    const profile: LLMConfig = {
      provider: 'openai',
      baseUrl: draftBaseUrl.trim() || undefined,
      apiKey: draftApiKey.trim() || undefined,
      model: draftModel.trim() || 'gpt-4o',
      temperature: draftTemperature,
      contextWindow: draftContextWindow === '' ? undefined : (parseInt(draftContextWindow, 10) || undefined),
      maxTokens: draftMaxTokens === '' ? undefined : (parseInt(draftMaxTokens, 10) || undefined),
      options: {
        ...(draftReasoning && draftReasoning !== 'off' ? { reasoningEffort: draftReasoning } : {}),
        ...(extraBody ? { extraBody } : {}),
      },
    };
    const oldName = editingProfileName;
    const nextProfiles = { ...(config.llm.openaiProfiles || {}) };
    // When renaming an existing profile, drop the old key.
    if (oldName && oldName !== name) {
      delete nextProfiles[oldName];
    }
    nextProfiles[name] = profile;
    // If the edited profile was the active one (or it's a new profile),
    // keep it active and sync the live llm config.
    const wasActive = oldName ? config.llm.activeOpenaiProfile === oldName : true;
    const next: SessionConfig = {
      ...config,
      llm: {
        ...config.llm,
        ...(wasActive ? profile : {}),
        provider: 'openai',
        providerConfigs: config.llm.providerConfigs,
        openaiProfiles: nextProfiles,
        activeOpenaiProfile: wasActive ? name : config.llm.activeOpenaiProfile,
      },
    };
    setConfig(next);
    // The settings panel's state is discarded when it closes, so the profile
    // must be written to disk here — waiting for the main Save button loses it.
    void persistConfig(next);
    setShowAddModal(false);
    setEditingProfileName(null);
    };

    return (
    <>
    <div className="settings-field">
    <label className="settings-label">OpenAI 配置档案 (Profiles)</label>
        <div className="settings-workspace-row">
          <select
            className="settings-select"
            value={activeProfile || ''}
            onChange={e => { if (e.target.value) applyProfile(e.target.value); }}
          >
            <option value="">— 请选择配置档案 —</option>
            {profileNames.map(n => (
              <option key={n} value={n}>{n}{activeProfile === n ? ' (当前)' : ''}</option>
            ))}
          </select>
          <button
            type="button"
            className="settings-hint-button"
            style={{ padding: '6px 12px', fontSize: '12px', cursor: 'pointer', background: 'var(--accent)', border: 'none', borderRadius: '4px', color: '#fff', whiteSpace: 'nowrap', fontWeight: 500 }}
            onClick={openAddModal}
          >+ 添加模型</button>
        </div>
        {activeProfile && (
        <div className="settings-workspace-row" style={{ marginTop: '6px' }}>
        <button
        type="button"
        className="settings-hint-button"
        style={{ padding: '4px 12px', fontSize: '12px', cursor: 'pointer', background: 'transparent', border: '1px solid var(--border)', borderRadius: '4px', color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}
        onClick={() => openEditModal(activeProfile)}
        >编辑当前配置</button>
        <button
        type="button"
        className="settings-hint-button"
        style={{ padding: '4px 12px', fontSize: '12px', cursor: 'pointer', background: 'transparent', border: '1px solid #f85149', borderRadius: '4px', color: '#f85149', whiteSpace: 'nowrap' }}
        onClick={() => deleteProfile(activeProfile)}
        >删除当前配置</button>
        </div>
        )}
        <span className="settings-hint">可保存多套 OpenAI 兼容端点（OpenAI 官方 / DeepSeek / 智谱 GLM / 本地 vLLM 等），点击 "添加模型" 新建，从下拉框快速切换。切换后点击下方 "Test Connection" 验证。</span>
      </div>

      {/* ── Read-only display of the active profile ── */}
      <div className="settings-field">
        <label className="settings-label">Base URL</label>
        <input className="settings-input" type="text" value={activeProfileData?.baseUrl || config.llm.baseUrl || ''} readOnly placeholder="https://api.openai.com/v1/chat/completions" />
      </div>
      <div className="settings-field">
        <label className="settings-label">Model</label>
        <input className="settings-input" type="text" value={activeProfileData?.model || config.llm.model || ''} readOnly placeholder="gpt-4o" />
      </div>
      <div className="settings-field">
        <label className="settings-label">API Key</label>
        <div className="settings-secret-field">
          <input className="settings-input settings-secret-input" type={showApiKey ? 'text' : 'password'} value={activeProfileData?.apiKey || config.llm.apiKey || ''} readOnly placeholder="sk-..." />
          <button className="settings-secret-toggle" onClick={() => setShowApiKey(!showApiKey)} type="button">{showApiKey ? <EyeOff size={14} /> : <Eye size={14} />}</button>
        </div>
      </div>
      <div className="settings-field">
        <label className="settings-label">Thinking Effort</label>
        <input className="settings-input" type="text" value={(activeProfileData?.options?.reasoningEffort as string) || 'off'} readOnly />
      </div>
      <div className="settings-field"><label className="settings-label">Context Window <span className="settings-label-hint">(tokens)</span></label><input className="settings-input" type="text" value={activeProfileData?.contextWindow ?? config.llm.contextWindow ?? ''} readOnly placeholder="留空使用模型默认值" /></div>
      <div className="settings-field"><label className="settings-label">Max Tokens <span className="settings-label-hint">(留空使用模型默认值)</span></label><input className="settings-input" type="text" value={activeProfileData?.maxTokens ?? config.llm.maxTokens ?? ''} readOnly placeholder="留空使用模型默认值" /></div>
      <div className="settings-field">
        <label className="settings-label">Temperature <span className="settings-label-value">{(activeProfileData?.temperature ?? config.llm.temperature).toFixed(2)}</span></label>
        <input className="settings-slider" type="range" min="0" max="2" step="0.01" value={activeProfileData?.temperature ?? config.llm.temperature} readOnly />
      </div>
      <div className="settings-field">
        <label className="settings-label">自定义请求参数 <span className="settings-label-hint">(非标准 OpenAI 参数透传)</span></label>
        <textarea
          className="settings-textarea"
          style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: '12px', minHeight: '80px' }}
          value={activeProfileData?.options?.extraBody && typeof activeProfileData.options.extraBody === 'object' ? JSON.stringify(activeProfileData.options.extraBody, null, 2) : ''}
          readOnly
          rows={5}
          spellCheck={false}
        />
      </div>

      {/* ── Add-model modal ── */}
      {showAddModal && (
        <div className="overlay">
          <div
            className="settings-panel"
            style={{ width: '680px', height: 'auto', maxHeight: '90vh' }}
            onClick={e => e.stopPropagation()}
          >
            <div className="settings-header" style={{ cursor: 'default' }}>
              <span className="settings-title">{editingProfileName ? '编辑 OpenAI 模型' : '添加 OpenAI 模型'}</span>
              <button type="button" className="settings-hint-button" style={{ padding: '4px', cursor: 'pointer', background: 'transparent', border: 'none', color: 'var(--text-secondary)' }} onClick={() => setShowAddModal(false)}>
                <X size={16} />
              </button>
            </div>
            <div className="settings-content" style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <div className="settings-field">
                <label className="settings-label">配置名称 <span className="settings-label-hint">(必填，用于下拉框标识)</span></label>
                <input className="settings-input" type="text" value={draftName} onChange={e => setDraftName(e.target.value)} placeholder="例如: DeepSeek / GLM / 本地vLLM" />
              </div>
              <div className="settings-field">
                <label className="settings-label">Base URL</label>
                <input className="settings-input" type="text" value={draftBaseUrl} onChange={e => setDraftBaseUrl(e.target.value)} placeholder="https://api.openai.com/v1/chat/completions" />
                <span className="settings-hint">支持 OpenAI 兼容的 API 端点，例如：<br/>• <code>https://api.openai.com/v1/chat/completions</code> — OpenAI 官方<br/>• <code>https://api.deepseek.com/v1/chat/completions</code> — DeepSeek<br/>• <code>https://open.bigmodel.cn/api/paas/v4/chat/completions</code> — 智谱 GLM</span>
              </div>
              <div className="settings-field">
                <label className="settings-label">
                  Thinking Effort
                  {openaiReasoningLoading ? (
                    <span style={{ marginLeft: '6px', fontSize: '11px', color: 'var(--text-muted)' }}>正在检测...</span>
                  ) : openaiReasoningInfo ? (
                    supportsOpenAIReasoning ? (
                      <span style={{ marginLeft: '6px', fontSize: '11px', color: 'var(--success)', fontWeight: 400 }}>
                        ✓ 自动推荐: {openaiDefaultEffort}
                      </span>
                    ) : (
                      <span style={{ marginLeft: '6px', fontSize: '11px', color: 'var(--text-muted)' }}>
                        当前模型不支持
                      </span>
                    )
                  ) : null}
                </label>
                <select className="settings-select" value={draftReasoning} onChange={e => { reasoningUserTouchedRef.current = true; setDraftReasoning(e.target.value); }}>
                  <option value="off">关闭 (off)</option>
                  {supportsOpenAIReasoning && openaiSupportedEfforts.length > 0 ? (
                    openaiSupportedEfforts.map(effort => (
                      <option key={effort} value={effort}>{effort}</option>
                    ))
                  ) : (
                    <>
                      <option value="low">低 (low)</option>
                      <option value="medium">中 (medium)</option>
                      <option value="high">高 (high)</option>
                      <option value="xhigh">超高 (xhigh)</option>
                      <option value="max">最高 (max)</option>
                    </>
                  )}
                </select>
                <span className="settings-hint">
                  {openaiReasoningLoading ? '正在通过 OpenRouter 检测当前模型支持的推理级别...' : supportsOpenAIReasoning
                    ? `当前模型支持推理/思考模式。推荐级别: ${openaiDefaultEffort}${openaiSupportedEfforts.length > 0 ? `，支持级别: ${openaiSupportedEfforts.join(', ')}` : ''}`
                    : '开启后模型会先推理再回答，适用于复杂任务。未检测到支持时建议保持关闭。'}
                </span>
              </div>
              <div className="settings-field" style={{ position: 'relative' }} ref={dropdownRef}>
                <label className="settings-label">
                  Model
                  <button
                    type="button"
                    className="settings-hint-button"
                    style={{ marginLeft: '8px', padding: '2px 8px', fontSize: '11px', cursor: openaiModelsLoading ? 'wait' : 'pointer', background: 'transparent', border: '1px solid var(--border)', borderRadius: '3px', color: 'var(--text-secondary)', display: 'inline-flex', alignItems: 'center', gap: '4px' }}
                    onClick={fetchOpenaiModels}
                    disabled={openaiModelsLoading}
                    title="从 URL 自动获取可用模型列表"
                  >
                    {openaiModelsLoading ? 'Fetching...' : 'Fetch Models'}
                  </button>
                </label>
                <input
                  className="settings-input"
                  type="text"
                  value={draftModel}
                  onChange={e => {
                    setOpenaiMetadataAutoSyncEnabled(true);
                    setDraftModel(e.target.value);
                    setModelFilter(e.target.value);
                    if (openaiModels.length > 0) setShowModelDropdown(true);
                  }}
                  onFocus={handleModelInputFocus}
                  placeholder="gpt-4o"
                />
                {openaiModelsError && (
                  <span className="settings-hint" style={{ color: '#ef4444', marginTop: '4px' }}>Error: {openaiModelsError}</span>
                )}
                {showModelDropdown && filteredModels.length > 0 && (
                  <div
                    style={{
                      position: 'absolute',
                      top: '100%',
                      left: 0,
                      right: 0,
                      maxHeight: '220px',
                      overflowY: 'auto',
                      background: 'var(--bg-secondary)',
                      border: '1px solid var(--border)',
                      borderRadius: '6px',
                      marginTop: '2px',
                      zIndex: 1000,
                      boxShadow: '0 4px 16px rgba(0,0,0,0.35)',
                    }}
                  >
                    {filteredModels.map(m => (
                      <div
                        key={m.id}
                        onClick={() => selectModel(m.id)}
                        style={{
                          padding: '7px 12px',
                          cursor: 'pointer',
                          fontSize: '13px',
                          color: m.id === draftModel ? 'var(--accent)' : 'var(--text-primary)',
                          background: m.id === draftModel ? 'rgba(212,167,106,0.12)' : 'transparent',
                          borderBottom: '1px solid var(--border)',
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          transition: 'background 0.15s',
                        }}
                        onMouseEnter={e => { if (m.id !== draftModel) (e.currentTarget as HTMLDivElement).style.background = 'var(--bg-hover)'; }}
                        onMouseLeave={e => { if (m.id !== draftModel) (e.currentTarget as HTMLDivElement).style.background = 'transparent'; }}
                      >
                        <span style={{ fontFamily: 'var(--font-mono)', fontSize: '12px' }}>{m.id}</span>
                        {m.ownedBy && <span style={{ fontSize: '11px', color: 'var(--text-muted)', marginLeft: '8px', flexShrink: 0 }}>{m.ownedBy}</span>}
                      </div>
                    ))}
                  </div>
                )}
                {openaiModels.length > 0 && !showModelDropdown && (
                  <span className="settings-hint" style={{ marginTop: '4px' }}>共 {openaiModels.length} 个可用模型，点击输入框查看列表</span>
                )}
              </div>
              <div className="settings-field">
                <label className="settings-label">API Key</label>
                <div className="settings-secret-field">
                  <input className="settings-input settings-secret-input" type={draftShowApiKey ? 'text' : 'password'} value={draftApiKey} onChange={e => setDraftApiKey(e.target.value)} placeholder="sk-..." />
                  <button className="settings-secret-toggle" onClick={() => setDraftShowApiKey(!draftShowApiKey)} type="button">{draftShowApiKey ? <EyeOff size={14} /> : <Eye size={14} />}</button>
                </div>
              </div>
              <div className="settings-field">
                <label className="settings-label">
                  Context Window <span className="settings-label-hint">(tokens, 留空使用模型默认值)</span>
                  {openaiContextLoading ? (
                    <span style={{ marginLeft: '6px', fontSize: '11px', color: 'var(--text-muted)' }}>正在检测...</span>
                  ) : openaiContextInfo ? (
                    <span style={{ marginLeft: '6px', fontSize: '11px', color: 'var(--success)', fontWeight: 400 }}>
                      ✓ 自动检测: {openaiContextInfo.contextWindow.toLocaleString()} tokens (最大输入: {openaiContextInfo.maxInputTokens.toLocaleString()})
                    </span>
                  ) : null}
                </label>
                <input className="settings-input" type="text" inputMode="numeric" value={draftContextWindow} onChange={e => setDraftContextWindow(e.target.value)} placeholder={openaiContextInfo ? String(openaiContextInfo.contextWindow) : '留空使用模型默认值'} />
                <span className="settings-hint">模型上下文窗口大小，切换模型时会自动从 OpenRouter 查询推荐值。</span>
              </div>
              <div className="settings-field">
                <label className="settings-label">
                  Max Tokens <span className="settings-label-hint">(留空使用模型默认值)</span>
                  {openaiContextInfo ? (
                    <span style={{ marginLeft: '6px', fontSize: '11px', color: 'var(--success)', fontWeight: 400 }}>
                      ✓ 自动检测: {openaiContextInfo.maxOutputTokens.toLocaleString()} tokens
                    </span>
                  ) : null}
                </label>
                <input className="settings-input" type="text" inputMode="numeric" value={draftMaxTokens} onChange={e => setDraftMaxTokens(e.target.value)} placeholder={openaiContextInfo ? String(openaiContextInfo.maxOutputTokens) : '留空使用模型默认值'} />
                <span className="settings-hint">模型最大输出 tokens，切换模型时会自动从 OpenRouter 查询推荐值。</span>
              </div>
              <div className="settings-field">
                <label className="settings-label">Temperature <span className="settings-label-value">{draftTemperature.toFixed(2)}</span></label>
                <input className="settings-slider" type="range" min="0" max="2" step="0.01" value={draftTemperature} onChange={e => setDraftTemperature(parseFloat(e.target.value))} />
              </div>
              <div className="settings-field">
                <label className="settings-label">自定义请求参数 <span className="settings-label-hint">(非标准 OpenAI 参数透传，留空则不发送)</span></label>
                <textarea
                  className="settings-textarea"
                  style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: '12px', minHeight: '80px' }}
                  value={draftExtraBody}
                  onChange={e => handleDraftExtraBodyChange(e.target.value)}
                  placeholder={'非标准参数将原样合并到请求 body。例如：\n{\n  "chat_template_kwargs": {\n    "enable_thinking": true\n  }\n}'}
                  rows={5}
                  spellCheck={false}
                />
                {draftExtraBodyError ? (
                  <span className="settings-hint" style={{ color: '#ef4444' }}>{draftExtraBodyError}</span>
                ) : draftExtraBody.trim() ? (
                  <span className="settings-hint" style={{ color: 'var(--success)' }}>✓ 已启用，参数将合并到请求 body（不覆盖标准字段）</span>
                ) : (
                  <span className="settings-hint">用于支持厂商私有参数，例如 vLLM 服务的 <code>chat_template_kwargs.enable_thinking</code>。仅接受 JSON 对象。</span>
                )}
              </div>
            </div>
            <div className="settings-footer">
              <span className="settings-hint" style={{ color: 'var(--text-muted)' }}>{editingProfileName ? '保存后更新当前配置档案' : '保存后可在上方下拉框中选择该配置'}</span>
              <div className="settings-footer-right">
                <button className="settings-btn settings-btn-cancel" onClick={() => setShowAddModal(false)}>取消</button>
                <button className="settings-btn settings-btn-save" onClick={saveNewProfile} disabled={!draftName.trim() || !!draftExtraBodyError}>保存</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
