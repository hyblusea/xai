import { Plus, Trash2, CircleDot } from 'lucide-react';
import { InlineTextEdit } from '../controls';

export function TabsEditor({
  items,
  onAddTab,
  onRemoveTab,
  onRenameTab,
  onSetActiveTab,
}: {
  items: Array<{ id: string; label: string; active: boolean }>;
  onAddTab?: () => void;
  onRemoveTab?: (index: number) => void;
  onRenameTab?: (index: number, label: string) => void;
  onSetActiveTab?: (index: number) => void;
}) {
  return (
    <div className="designer-prop-collection">
      {items.map((item, index) => (
        <div key={item.id} className="designer-prop-collection-item">
          <div className="designer-prop-collection-head">
            <span className={`designer-prop-pill ${item.active ? 'active' : ''}`}>
              {item.active ? '当前标签' : `标签 ${index + 1}`}
            </span>
            <div className="designer-prop-btn-group">
              {onSetActiveTab && (
                <button
                  type="button"
                  className={`designer-prop-inline-btn ${item.active ? 'active' : ''}`}
                  onClick={() => onSetActiveTab(index)}
                  title="激活此标签"
                >
                  <CircleDot size={12} />
                </button>
              )}
              <button
                type="button"
                className="designer-prop-inline-btn danger"
                onClick={() => onRemoveTab?.(index)}
                title="删除标签"
              >
                <Trash2 size={12} />
              </button>
            </div>
          </div>
          <InlineTextEdit
            value={item.label}
            onCommit={v => onRenameTab?.(index, v)}
            placeholder="标签名称"
          />
        </div>
      ))}
      <button type="button" className="designer-prop-btn" onClick={onAddTab}>
        <Plus size={12} />
        新增标签页
      </button>
    </div>
  );
}
