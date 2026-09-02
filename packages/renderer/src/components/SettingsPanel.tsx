import { useState, useEffect, useCallback } from 'react';
import { X, Save, Brain, Terminal, Plug, Zap, Smartphone, Globe, Download, Search, Scan, FolderOpen } from 'lucide-react';
import { IPCChannel } from '@xai/shared';
import type { SessionConfig, MCPServerConfig } from '@xai/shared';
import { useSettingsState } from './settings/useSettingsState';
import { useDraggable } from './settings/useDraggable';
import LLMTab from './settings/LLMTab';
import WorkspaceTab from './settings/WorkspaceTab';
import CommandsTab from './settings/CommandsTab';
import ShortcutsTab from './settings/ShortcutsTab';
import MCPTab from './settings/MCPTab';
import MQTTTab from './settings/MQTTTab';
import SearchTab from './settings/SearchTab';
import ProxyTab from './settings/ProxyTab';
import UpdateTab from './settings/UpdateTab';
import OCRTab from './settings/OCRTab';
import './settings/settings.css';

interface SettingsPanelProps {
  onClose: () => void;
  onWorkspaceChanged?: (path: string) => void;
}

type TabKey = 'llm' | 'workspace' | 'commands' | 'shortcuts' | 'mcp' | 'mqtt' | 'proxy' | 'update' | 'search' | 'ocr';

interface TabItem {
  key: TabKey;
  label: string;
  icon: React.ReactNode;
}

const tabs: TabItem[] = [
  { key: 'llm', label: 'LLM', icon: <Brain size={16} /> },
  { key: 'workspace', label: 'Workspace', icon: <FolderOpen size={16} /> },
  { key: 'commands', label: 'Commands', icon: <Terminal size={16} /> },
  { key: 'shortcuts', label: 'Shortcuts', icon: <Zap size={16} /> },
  { key: 'mcp', label: 'MCP', icon: <Plug size={16} /> },
  { key: 'search', label: 'Search', icon: <Search size={16} /> },
  { key: 'mqtt', label: 'MQTT', icon: <Smartphone size={16} /> },
  { key: 'proxy', label: 'Proxy', icon: <Globe size={16} /> },
  { key: 'update', label: 'Update', icon: <Download size={16} /> },
  { key: 'ocr', label: 'OCR', icon: <Scan size={16} /> },
];

export default function SettingsPanel({ onClose, onWorkspaceChanged }: SettingsPanelProps) {
  const [activeTab, setActiveTab] = useState<TabKey>('llm');

  const state = useSettingsState(onWorkspaceChanged);
  const { config, setConfig, toast, saving, testing, testResult, autoApproveText, setAutoApproveText, shortcutText, setShortcutText, showToast, loadConfig, handleSave, persistConfig, handleChangeWorkspace, handleTestConnection, updateLLM, updateLLMOption, updateProxy, updateUpdate, updateWebSearch, updateWebFetch, updateOCR } = state;

  const { panelRef, dragOffset, isDragging, handleHeaderMouseDown } = useDraggable();

  // MCP state
  const [newMCPName, setNewMCPName] = useState('');
  const [newMCPCommand, setNewMCPCommand] = useState('');
  const [newMCPArgs, setNewMCPArgs] = useState('');
  const [mcpStatuses, setMcpStatuses] = useState<Array<{ name: string; connected: boolean; toolCount: number; error?: string }>>([]);

  const loadMCPStatuses = useCallback(async () => {
    try {
      const statuses = await window.electronAPI.invoke(IPCChannel.MCPServerStatus) as Array<{ name: string; connected: boolean; toolCount: number; error?: string }>;
      setMcpStatuses(statuses);
    } catch {}
  }, []);

  useEffect(() => {
    loadConfig();
  }, [loadConfig]);

  useEffect(() => {
    if (activeTab === 'mcp') loadMCPStatuses();
  }, [activeTab, loadMCPStatuses]);

  const handleAddMCPServer = async () => {
    if (!newMCPName.trim() || !newMCPCommand.trim()) return;
    const serverConfig: MCPServerConfig = {
      name: newMCPName.trim(),
      command: newMCPCommand.trim(),
      args: newMCPArgs.trim() ? newMCPArgs.trim().split(/\s+/) : [],
      enabled: true,
    };
    const result = await window.electronAPI.invoke(IPCChannel.MCPAdd, serverConfig) as { success: boolean; error?: string };
    if (result.success) {
      setConfig(prev => prev ? { ...prev, mcpServers: [...(prev.mcpServers || []), serverConfig] } : prev);
      setNewMCPName('');
      setNewMCPCommand('');
      setNewMCPArgs('');
      await loadMCPStatuses();
    } else {
      showToast(result.error || 'Failed to add MCP server', 'error');
    }
  };

  const handleToggleMCP = async (name: string, currentEnabled: boolean) => {
    const result = await window.electronAPI.invoke(IPCChannel.MCPUpdate, name, { enabled: !currentEnabled }) as { success: boolean };
    if (result.success) {
      setConfig(prev => prev ? { ...prev, mcpServers: (prev.mcpServers || []).map(s => s.name === name ? { ...s, enabled: !currentEnabled } : s) } : prev);
      await loadMCPStatuses();
    }
  };

  const handleRemoveMCP = async (name: string) => {
    const result = await window.electronAPI.invoke(IPCChannel.MCPRemove, name) as { success: boolean };
    if (result.success) {
      setConfig(prev => prev ? { ...prev, mcpServers: (prev.mcpServers || []).filter(s => s.name !== name) } : prev);
      await loadMCPStatuses();
    }
  };

  if (!config) {
    return (
      <div className="overlay">
        <div className="settings-panel" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)' }}>
          Loading...
        </div>
      </div>
    );
  }

  const renderTabContent = () => {
    switch (activeTab) {
      case 'llm':
        return <LLMTab config={config} setConfig={setConfig} persistConfig={persistConfig} updateLLM={updateLLM} updateLLMOption={updateLLMOption} testing={testing} testResult={testResult} handleTestConnection={handleTestConnection} />;
      case 'workspace':
        return <WorkspaceTab config={config} handleChangeWorkspace={handleChangeWorkspace} />;
      case 'commands':
        return <CommandsTab autoApproveText={autoApproveText} setAutoApproveText={setAutoApproveText} />;
      case 'shortcuts':
        return <ShortcutsTab shortcutText={shortcutText} setShortcutText={setShortcutText} />;
      case 'mcp':
        return <MCPTab config={config} newMCPName={newMCPName} setNewMCPName={setNewMCPName} newMCPCommand={newMCPCommand} setNewMCPCommand={setNewMCPCommand} newMCPArgs={newMCPArgs} setNewMCPArgs={setNewMCPArgs} mcpStatuses={mcpStatuses} handleAddMCPServer={handleAddMCPServer} handleToggleMCP={handleToggleMCP} handleRemoveMCP={handleRemoveMCP} />;
      case 'mqtt':
        return <MQTTTab config={config} setConfig={setConfig} />;
      case 'search':
        return <SearchTab config={config} updateWebSearch={updateWebSearch} updateWebFetch={updateWebFetch} />;
      case 'proxy':
        return <ProxyTab config={config} updateProxy={updateProxy} />;
      case 'update':
        return <UpdateTab config={config} updateUpdate={updateUpdate} showToast={showToast} />;
      case 'ocr':
        return <OCRTab config={config} updateOCR={updateOCR} handleSave={handleSave} />;
    }
  };

  return (
    <div className="overlay">
      <div
        ref={panelRef}
        className="settings-panel"
        onClick={e => e.stopPropagation()}
        style={dragOffset ? { position: 'fixed', left: dragOffset.x, top: dragOffset.y, margin: 0 } : undefined}
      >
        <div
          className={`settings-header${isDragging ? ' settings-header-dragging' : ''}`}
          onMouseDown={handleHeaderMouseDown}
        >
          <span className="settings-title">Settings</span>
          <button className="icon-button" onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        <div className="settings-body">
          <nav className="settings-tabs">
            {tabs.map(tab => (
              <button
                key={tab.key}
                className={`settings-tab ${activeTab === tab.key ? 'settings-tab-active' : ''}`}
                onClick={() => setActiveTab(tab.key)}
              >
                {tab.icon}
                <span>{tab.label}</span>
              </button>
            ))}
          </nav>

          <div className="settings-content">
            {renderTabContent()}
          </div>
        </div>

        <div className="settings-footer">
          <div className="settings-footer-right">
            <button className="settings-btn settings-btn-cancel" onClick={onClose}>
              Close
            </button>
            <button
              className="settings-btn settings-btn-save"
              onClick={handleSave}
              disabled={saving}
            >
              <Save size={14} />
              {saving ? 'Saving...' : 'Save'}
            </button>
          </div>
        </div>

        {toast.visible && (
          <div className={`settings-toast settings-toast-${toast.type}`}>
            {toast.message}
          </div>
        )}
      </div>
    </div>
  );
}
