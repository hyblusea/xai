import { useState, useEffect, useRef } from 'react';
import { PropertySelect } from '../controls';

export function ProgressEditor({
  data,
  onUpdate,
}: {
  data: { value: number; label: string; striped: boolean; animated: boolean; variant: string };
  onUpdate: (updates: { value?: number; label?: string; striped?: boolean; animated?: boolean; variant?: string }) => void;
}) {
  const [label, setLabel] = useState(data.label);
  const isEditingRef = useRef(false);

  useEffect(() => {
    if (!isEditingRef.current) setLabel(data.label);
  }, [data.label]);

  const variantOptions = [
    { value: '', label: '默认' },
    { value: 'bg-primary', label: '主要' },
    { value: 'bg-success', label: '成功' },
    { value: 'bg-info', label: '信息' },
    { value: 'bg-warning', label: '警告' },
    { value: 'bg-danger', label: '危险' },
  ];

  return (
    <div className="designer-prop-collection">
      <div className="designer-prop-field">
        <label className="designer-prop-label">进度 ({data.value}%)</label>
        <div className="designer-prop-slider-row">
          <input
            type="range"
            className="designer-prop-slider"
            min={0}
            max={100}
            step={1}
            value={data.value}
            onChange={e => onUpdate({ value: parseInt(e.target.value, 10) })}
          />
          <input
            type="number"
            className="designer-prop-input designer-prop-slider-text"
            min={0}
            max={100}
            value={data.value}
            onChange={e => {
              const v = parseInt(e.target.value, 10);
              onUpdate({ value: isNaN(v) ? 0 : Math.max(0, Math.min(100, v)) });
            }}
          />
        </div>
      </div>
      <div className="designer-prop-field">
        <label className="designer-prop-label">标签</label>
        <input
          type="text"
          className="designer-prop-input"
          value={label}
          onChange={e => setLabel(e.target.value)}
          onFocus={() => { isEditingRef.current = true; }}
          onBlur={() => { isEditingRef.current = false; onUpdate({ label }); }}
          placeholder="进度标签"
        />
      </div>
      <div className="designer-prop-row">
        <label className="designer-prop-check">
          <input
            type="checkbox"
            checked={data.striped}
            onChange={e => onUpdate({ striped: e.target.checked })}
          />
          条纹
        </label>
        <label className="designer-prop-check">
          <input
            type="checkbox"
            checked={data.animated}
            onChange={e => onUpdate({ animated: e.target.checked })}
          />
          动画
        </label>
      </div>
      <PropertySelect
        label="变体"
        value={data.variant}
        options={variantOptions}
        onChange={v => onUpdate({ variant: v })}
      />
    </div>
  );
}
