import { Plus, Trash2, ChevronDown } from 'lucide-react';
import { InlineTextEdit } from '../controls';

export function AccordionEditor({
  items,
  onAddAccordion,
  onRemoveAccordion,
  onRenameAccordion,
  onToggleAccordion,
}: {
  items: Array<{ id: string; header: string; active: boolean }>;
  onAddAccordion?: () => void;
  onRemoveAccordion?: (index: number) => void;
  onRenameAccordion?: (index: number, header: string) => void;
  onToggleAccordion?: (index: number) => void;
}) {
  return (
    <div className="designer-prop-collection">
      {items.map((item, index) => (
        <div key={item.id} className="designer-prop-collection-item">
          <div className="designer-prop-collection-head">
            <span className={`designer-prop-pill ${item.active ? 'active' : ''}`}>
              {item.active ? '已展开' : `面板 ${index + 1}`}
            </span>
            <div className="designer-prop-btn-group">
              {onToggleAccordion && (
                <button
                  type="button"
                  className={`designer-prop-inline-btn ${item.active ? 'active' : ''}`}
                  onClick={() => onToggleAccordion(index)}
                  title={item.active ? '收起' : '展开'}
                >
                  <ChevronDown
                    size={12}
                    style={{ transform: item.active ? 'none' : 'rotate(-90deg)', transition: 'transform 0.12s' }}
                  />
                </button>
              )}
              <button
                type="button"
                className="designer-prop-inline-btn danger"
                onClick={() => onRemoveAccordion?.(index)}
                title="删除面板"
              >
                <Trash2 size={12} />
              </button>
            </div>
          </div>
          <InlineTextEdit
            value={item.header}
            onCommit={v => onRenameAccordion?.(index, v)}
            placeholder="面板标题"
          />
        </div>
      ))}
      <button type="button" className="designer-prop-btn" onClick={onAddAccordion}>
        <Plus size={12} />
        新增面板
      </button>
    </div>
  );
}
