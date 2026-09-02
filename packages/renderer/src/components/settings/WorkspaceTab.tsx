import { FolderOpen } from 'lucide-react';
import type { SessionConfig } from '@xai/shared';

interface WorkspaceTabProps {
  config: SessionConfig;
  handleChangeWorkspace: () => void;
}

export default function WorkspaceTab({ config, handleChangeWorkspace }: WorkspaceTabProps) {
  return (
    <div className="settings-tab-content">
      <h3 className="settings-section-title">Workspace</h3>

      <div className="settings-field">
        <label className="settings-label">Current Workspace</label>
        <div className="settings-workspace-row">
          <input
            className="settings-input settings-workspace-input"
            type="text"
            value={config.workspace}
            readOnly
          />
          <button className="settings-workspace-btn" onClick={handleChangeWorkspace}>
            <FolderOpen size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}
