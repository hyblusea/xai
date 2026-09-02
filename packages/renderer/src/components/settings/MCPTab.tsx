import { Plus, Trash2, Power, PowerOff } from 'lucide-react';
import type { SessionConfig, MCPServerConfig } from '@xai/shared';

interface MCPTabProps {
  config: SessionConfig;
  newMCPName: string;
  setNewMCPName: (name: string) => void;
  newMCPCommand: string;
  setNewMCPCommand: (cmd: string) => void;
  newMCPArgs: string;
  setNewMCPArgs: (args: string) => void;
  mcpStatuses: Array<{ name: string; connected: boolean; toolCount: number; error?: string }>;
  handleAddMCPServer: () => void;
  handleToggleMCP: (name: string, currentEnabled: boolean) => void;
  handleRemoveMCP: (name: string) => void;
}

export default function MCPTab({
  config,
  newMCPName,
  setNewMCPName,
  newMCPCommand,
  setNewMCPCommand,
  newMCPArgs,
  setNewMCPArgs,
  mcpStatuses,
  handleAddMCPServer,
  handleToggleMCP,
  handleRemoveMCP,
}: MCPTabProps) {
  return (
    <div className="settings-tab-content">
      <h3 className="settings-section-title">MCP Servers</h3>
      <span className="settings-hint">
        Configure Model Context Protocol servers to extend AI capabilities with external tools.
        When MCP tools are available, a <code>tool_search</code> meta-tool is exposed to the AI for discovering MCP tools on demand.
      </span>

      <div className="settings-mcp-add">
        <div className="settings-field">
          <label className="settings-label">Name</label>
          <input
            className="settings-input"
            type="text"
            value={newMCPName}
            onChange={e => setNewMCPName(e.target.value)}
            placeholder="e.g. codegraph"
          />
        </div>
        <div className="settings-field">
          <label className="settings-label">Command</label>
          <input
            className="settings-input"
            type="text"
            value={newMCPCommand}
            onChange={e => setNewMCPCommand(e.target.value)}
            placeholder="e.g. codegraph"
          />
        </div>
        <div className="settings-field">
          <label className="settings-label">Args <span className="settings-label-hint">(space-separated)</span></label>
          <input
            className="settings-input"
            type="text"
            value={newMCPArgs}
            onChange={e => setNewMCPArgs(e.target.value)}
            placeholder="e.g. serve --mcp"
          />
        </div>
        <button
          className="settings-btn settings-btn-add-mcp"
          onClick={handleAddMCPServer}
          disabled={!newMCPName.trim() || !newMCPCommand.trim()}
        >
          <Plus size={14} />
          Add Server
        </button>
      </div>

      {(config.mcpServers || []).length === 0 ? (
        <div className="settings-mcp-empty">No MCP servers configured</div>
      ) : (
        <div className="settings-mcp-list">
          {(config.mcpServers || []).map((server) => {
            const status = mcpStatuses.find(s => s.name === server.name);
            return (
              <div key={server.name} className={`settings-mcp-item ${server.enabled ? 'mcp-enabled' : 'mcp-disabled'}`}>
                <div className="settings-mcp-info">
                  <div className="settings-mcp-header">
                    <span className="settings-mcp-name">{server.name}</span>
                    <span className={`settings-mcp-status ${status?.connected ? 'status-connected' : 'status-disconnected'}`}>
                      {status?.connected ? `Connected (${status.toolCount} tools)` : 'Disconnected'}
                    </span>
                  </div>
                  <div className="settings-mcp-command">
                    {server.command} {server.args.join(' ')}
                  </div>
                </div>
                <div className="settings-mcp-actions">
                  <button
                    className="settings-mcp-action-btn"
                    onClick={() => handleToggleMCP(server.name, server.enabled)}
                    title={server.enabled ? 'Disable' : 'Enable'}
                  >
                    {server.enabled ? <Power size={14} /> : <PowerOff size={14} />}
                  </button>
                  <button
                    className="settings-mcp-action-btn settings-mcp-action-delete"
                    onClick={() => handleRemoveMCP(server.name)}
                    title="Remove"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
