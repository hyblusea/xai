import { useState, useEffect, useRef } from 'react';
import { PropertySelect } from '../controls';

export function DialogEditor({
  data,
  onUpdate,
}: {
  data: { title: string; sizeClass: string };
  onUpdate: (updates: { title?: string; sizeClass?: string }) => void;
}) {
  const [title, setTitle] = useState(data.title);
  const isEditingRef = useRef(false);

  useEffect(() => {
    if (!isEditingRef.current) setTitle(data.title);
  }, [data.title]);

  const sizeOptions = [
    { value: '', label: '默认' },
    { value: 'modal-sm', label: '小' },
    { value: 'modal-lg', label: '大' },
    { value: 'modal-xl', label: '超大' },
    { value: 'modal-fullscreen', label: '全屏' },
  ];

  return (
    <div className="designer-prop-collection">
      <div className="designer-prop-field">
        <label className="designer-prop-label">标题</label>
        <input
          type="text"
          className="designer-prop-input"
          value={title}
          onChange={e => setTitle(e.target.value)}
          onFocus={() => { isEditingRef.current = true; }}
          onBlur={() => { isEditingRef.current = false; onUpdate({ title }); }}
          placeholder="对话框标题"
        />
      </div>
      <PropertySelect
        label="尺寸"
        value={data.sizeClass}
        options={sizeOptions}
        onChange={v => onUpdate({ sizeClass: v })}
      />
    </div>
  );
}
