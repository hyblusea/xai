import { useState, useEffect, useRef } from 'react';
import { PropertySelect } from '../controls';

export function BadgeEditor({
  data,
  onUpdate,
}: {
  data: { text: string; variant: string; pill: boolean };
  onUpdate: (updates: { text?: string; variant?: string; pill?: boolean }) => void;
}) {
  const [text, setText] = useState(data.text);
  const isEditingRef = useRef(false);

  useEffect(() => {
    if (!isEditingRef.current) setText(data.text);
  }, [data.text]);

  const variantOptions = [
    { value: '', label: '默认' },
    { value: 'bg-primary', label: '主要' },
    { value: 'bg-secondary', label: '次要' },
    { value: 'bg-success', label: '成功' },
    { value: 'bg-danger', label: '危险' },
    { value: 'bg-warning', label: '警告' },
    { value: 'bg-info', label: '信息' },
    { value: 'bg-light', label: '浅色' },
    { value: 'bg-dark', label: '深色' },
  ];

  return (
    <div className="designer-prop-collection">
      <div className="designer-prop-field">
        <label className="designer-prop-label">文本</label>
        <input
          type="text"
          className="designer-prop-input"
          value={text}
          onChange={e => setText(e.target.value)}
          onFocus={() => { isEditingRef.current = true; }}
          onBlur={() => { isEditingRef.current = false; onUpdate({ text }); }}
          placeholder="徽标文本"
        />
      </div>
      <PropertySelect
        label="变体"
        value={data.variant}
        options={variantOptions}
        onChange={v => onUpdate({ variant: v })}
      />
      <label className="designer-prop-check">
        <input
          type="checkbox"
          checked={data.pill}
          onChange={e => onUpdate({ pill: e.target.checked })}
        />
        胶囊样式 (pill)
      </label>
    </div>
  );
}
