import { useState, useCallback } from 'react';
import { IPCChannel } from '@xai/shared';
import type { SessionConfig, LLMConfig, ProxyConfig, UpdateConfig, WebSearchConfig, WebFetchConfig, OCRConfig } from '@xai/shared';
import { refreshToolNames } from '../chat/toolNamesStore';

type ToastType = 'success' | 'error';

export interface ToastState {
  visible: boolean;
  message: string;
  type: ToastType;
}

export function useSettingsState(onWorkspaceChanged?: (path: string) => void) {
  const [config, setConfig] = useState<SessionConfig | null>(null);
  const [toast, setToast] = useState<ToastState>({ visible: false, message: '', type: 'success' });
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);
  const [autoApproveText, setAutoApproveText] = useState('');
  const [shortcutText, setShortcutText] = useState('');

  const showToast = useCallback((message: string, type: ToastType) => {
    setToast({ visible: true, message, type });
    setTimeout(() => setToast({ visible: false, message: '', type: 'success' }), 3000);
  }, []);

  const loadConfig = useCallback(async () => {
    try {
      const result = await window.electronAPI.invoke(IPCChannel.ConfigGet) as SessionConfig;
      if (result.update?.password) {
        try {
          result.update.password = decodeURIComponent(escape(atob(result.update.password)));
        } catch { /* 未编码的旧数据兼容 */ }
      }
      if (result.ocr?.password) {
        try {
          result.ocr.password = decodeURIComponent(escape(atob(result.ocr.password)));
        } catch { /* 未编码的旧数据兼容 */ }
      }
      setConfig(result);
      setAutoApproveText((result.autoApproveCommands || []).join('\n'));
      setShortcutText((result.shortcutCommands || []).join('\n'));
    } catch {
      showToast('Failed to load config', 'error');
    }
  }, [showToast]);

  // Shared persist path for the main Save button and immediate saves (e.g. the
  // OpenAI add-model modal). Takes the config to write so callers can persist
  // a freshly computed state without waiting for the next render.
  const persistConfig = useCallback(async (base: SessionConfig) => {
    setSaving(true);
    try {
      // Persist the current provider's config under its key so switching back
      // to it later restores these values instead of defaults.
      const { providerConfigs: _omit, ...currentSnapshot } = base.llm;
      const providerConfigs: Record<string, LLMConfig> = {
        ...(base.llm.providerConfigs || {}),
        [base.llm.provider]: currentSnapshot,
      };
      const configToSave = {
        ...base,
        llm: { ...base.llm, providerConfigs },
        autoApproveCommands: autoApproveText.split('\n').map(s => s.trim()).filter(Boolean),
        shortcutCommands: shortcutText.split('\n').map(s => s.trim()).filter(Boolean),
        update: base.update ? {
          ...base.update,
          password: base.update.password ? btoa(unescape(encodeURIComponent(base.update.password))) : '',
        } : base.update,
        ocr: base.ocr ? {
          ...base.ocr,
          password: base.ocr.password ? btoa(unescape(encodeURIComponent(base.ocr.password))) : '',
        } : base.ocr,
      };
      await window.electronAPI.invoke(IPCChannel.ConfigSet, configToSave);
      setConfig(prev => {
        if (!prev) return prev;
        return {
          ...prev,
          llm: { ...prev.llm, providerConfigs },
          autoApproveCommands: configToSave.autoApproveCommands,
          shortcutCommands: configToSave.shortcutCommands,
        };
      });
      showToast('Settings saved successfully', 'success');
    } catch {
      showToast('Failed to save settings', 'error');
    } finally {
      setSaving(false);
    }
  }, [autoApproveText, shortcutText, showToast]);

  const handleSave = useCallback(async () => {
    if (!config) return;
    await persistConfig(config);
  }, [config, persistConfig]);

  const handleReset = useCallback(async () => {
    try {
      const result = await window.electronAPI.invoke(IPCChannel.ConfigReset) as SessionConfig;
      if (result) {
        setConfig(result);
        setAutoApproveText((result.autoApproveCommands || []).join('\n'));
        setShortcutText((result.shortcutCommands || []).join('\n'));
      }
      showToast('Settings reset to defaults', 'success');
      await refreshToolNames(true);
    } catch {
      showToast('Failed to reset settings', 'error');
    }
  }, [showToast]);

  const handleChangeWorkspace = useCallback(async () => {
    try {
      const workspace = await window.electronAPI.invoke(IPCChannel.WorkspaceOpen) as string | null;
      if (workspace) {
        setConfig(prev => prev ? { ...prev, workspace } : prev);
        onWorkspaceChanged?.(workspace);
      }
    } catch {
      showToast('Failed to change workspace', 'error');
    }
  }, [onWorkspaceChanged, showToast]);

  const handleTestConnection = useCallback(async () => {
    if (!config) return;
    setSaving(true);
    setTesting(true);
    setTestResult(null);
    try {
      const configToSave = {
        ...config,
        update: config.update ? {
          ...config.update,
          password: config.update.password ? btoa(unescape(encodeURIComponent(config.update.password))) : '',
        } : config.update,
        ocr: config.ocr ? {
          ...config.ocr,
          password: config.ocr.password ? btoa(unescape(encodeURIComponent(config.ocr.password))) : '',
        } : config.ocr,
      };
      await window.electronAPI.invoke(IPCChannel.ConfigSet, configToSave);
      const result = await window.electronAPI.invoke('llm:test-connection') as { success: boolean; status: number; message: string };
      setTestResult(result);
    } catch (err) {
      setTestResult({ success: false, message: String(err) });
    } finally {
      setSaving(false);
      setTesting(false);
    }
  }, [config]);

  const updateLLM = useCallback(<K extends keyof LLMConfig>(key: K, value: LLMConfig[K]) => {
    setConfig(prev => {
      if (!prev) return prev;
      return { ...prev, llm: { ...prev.llm, [key]: value } };
    });
  }, []);

  const updateLLMOption = useCallback((key: string, value: unknown) => {
    setConfig(prev => {
      if (!prev) return prev;
      return { ...prev, llm: { ...prev.llm, options: { ...prev.llm.options, [key]: value } } };
    });
  }, []);

  const updateProxy = useCallback(<K extends keyof ProxyConfig>(key: K, value: ProxyConfig[K]) => {
    setConfig(prev => {
      if (!prev) return prev;
      return { ...prev, proxy: { ...prev.proxy, [key]: value } };
    });
  }, []);

  const updateUpdate = useCallback(<K extends keyof UpdateConfig>(key: K, value: UpdateConfig[K]) => {
    setConfig(prev => {
      if (!prev) return prev;
      return { ...prev, update: { ...prev.update, [key]: value } };
    });
  }, []);

  const updateWebSearch = useCallback(<K extends keyof WebSearchConfig>(key: K, value: WebSearchConfig[K]) => {
    setConfig(prev => {
      if (!prev) return prev;
      return { ...prev, webSearch: { ...prev.webSearch!, [key]: value } };
    });
  }, []);

  const updateWebFetch = useCallback(<K extends keyof WebFetchConfig>(key: K, value: WebFetchConfig[K]) => {
    setConfig(prev => {
      if (!prev) return prev;
      return { ...prev, webFetch: { ...prev.webFetch!, [key]: value } };
    });
  }, []);

  const updateOCR = useCallback(<K extends keyof OCRConfig>(key: K, value: OCRConfig[K]) => {
    setConfig(prev => {
      if (!prev) return prev;
      return { ...prev, ocr: { ...prev.ocr!, [key]: value } };
    });
  }, []);

  return {
    config,
    setConfig,
    toast,
    saving,
    testing,
    testResult,
    autoApproveText,
    setAutoApproveText,
    shortcutText,
    setShortcutText,
    showToast,
    loadConfig,
    handleSave,
    persistConfig,
    handleReset,
    handleChangeWorkspace,
    handleTestConnection,
    updateLLM,
    updateLLMOption,
    updateProxy,
    updateUpdate,
    updateWebSearch,
    updateWebFetch,
    updateOCR,
  };
}
