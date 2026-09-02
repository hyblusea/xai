interface CommandsTabProps {
  autoApproveText: string;
  setAutoApproveText: (text: string) => void;
}

export default function CommandsTab({ autoApproveText, setAutoApproveText }: CommandsTabProps) {
  return (
    <div className="settings-tab-content settings-tab-content-fill">
      <h3 className="settings-section-title">Command Approval</h3>

      <span className="settings-hint">
        Commands in the whitelist are auto-approved without confirmation prompts. Supports prefix matching — e.g. <code>git</code> matches all git commands, <code>git status</code> matches exact command.
        Unlisted commands will trigger a confirmation dialog.
      </span>

      <div className="settings-field settings-field-fill">
        <label className="settings-label">Auto-approve Commands (Whitelist)</label>
        <textarea
          className="settings-textarea settings-textarea-fill"
          value={autoApproveText}
          onChange={e => setAutoApproveText(e.target.value)}
          placeholder="One command per line, e.g.\ngit\ngit status\nnpm test\nnode --version"
        />
      </div>
    </div>
  );
}
