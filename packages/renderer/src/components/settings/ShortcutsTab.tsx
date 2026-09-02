interface ShortcutsTabProps {
  shortcutText: string;
  setShortcutText: (text: string) => void;
}

export default function ShortcutsTab({ shortcutText, setShortcutText }: ShortcutsTabProps) {
  return (
    <div className="settings-tab-content settings-tab-content-fill">
      <h3 className="settings-section-title">Shortcut Commands</h3>

      <span className="settings-hint">
        Configure shortcut commands that appear when you type <code>/</code> in the chat input.
        Each line is one shortcut. Select with arrow keys and press Enter to insert.
        Click the <code>/</code> button at the bottom-left of the chat input to trigger the menu.
      </span>

      <div className="settings-field settings-field-fill">
        <label className="settings-label">Shortcut Commands</label>
        <textarea
          className="settings-textarea settings-textarea-fill"
          value={shortcutText}
          onChange={e => setShortcutText(e.target.value)}
          placeholder="One shortcut per line, e.g.\ntool_call格式错误\n帮我编译并运行程序\n解释这段代码的功能\n帮我写单元测试"
        />
      </div>
    </div>
  );
}
