import { PropertySelect } from '../controls';

const BTN_VARIANT_OPTIONS = [
  { value: '', label: '默认' },
  { value: 'btn-primary', label: '主要' },
  { value: 'btn-secondary', label: '次要' },
  { value: 'btn-success', label: '成功' },
  { value: 'btn-danger', label: '危险' },
  { value: 'btn-warning', label: '警告' },
  { value: 'btn-info', label: '信息' },
  { value: 'btn-light', label: '浅色' },
  { value: 'btn-dark', label: '深色' },
  { value: 'btn-outline-primary', label: '描边 主要' },
  { value: 'btn-outline-secondary', label: '描边 次要' },
  { value: 'btn-outline-success', label: '描边 成功' },
  { value: 'btn-outline-danger', label: '描边 危险' },
  { value: 'btn-outline-warning', label: '描边 警告' },
  { value: 'btn-outline-info', label: '描边 信息' },
  { value: 'btn-outline-light', label: '描边 浅色' },
  { value: 'btn-outline-dark', label: '描边 深色' },
  { value: 'btn-link', label: '链接' },
];

const BTN_SIZE_OPTIONS = [
  { value: '', label: '默认' },
  { value: 'btn-sm', label: '小' },
  { value: 'btn-lg', label: '大' },
];

export function ButtonEditor({
  data,
  onUpdate,
}: {
  data: { variant: string; size: string; pill: boolean; block: boolean; disabled: boolean };
  onUpdate: (updates: { variant?: string; size?: string; pill?: boolean; block?: boolean; disabled?: boolean }) => void;
}) {
  return (
    <div className="designer-prop-collection">
      <PropertySelect
        label="变体"
        value={data.variant}
        options={BTN_VARIANT_OPTIONS}
        onChange={v => onUpdate({ variant: v })}
      />
      <PropertySelect
        label="尺寸"
        value={data.size}
        options={BTN_SIZE_OPTIONS}
        onChange={v => onUpdate({ size: v })}
      />
      <div className="designer-prop-row">
        <label className="designer-prop-check">
          <input
            type="checkbox"
            checked={data.pill}
            onChange={e => onUpdate({ pill: e.target.checked })}
          />
          胶囊
        </label>
        <label className="designer-prop-check">
          <input
            type="checkbox"
            checked={data.block}
            onChange={e => onUpdate({ block: e.target.checked })}
          />
          块级
        </label>
      </div>
      <label className="designer-prop-check">
        <input
          type="checkbox"
          checked={data.disabled}
          onChange={e => onUpdate({ disabled: e.target.checked })}
        />
        禁用
      </label>
    </div>
  );
}
