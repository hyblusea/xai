import { useState, useCallback } from 'react';
import { PropertyField } from '../controls';
import {
  extractBiIconName,
  replaceBiIcon,
  removeBiIcon,
} from '../../../../utils/bootstrapIcons';
import IconPickerDialog from '../../IconPickerDialog';

/**
 * IconEditor — 编辑 <i class="bi bi-xxx"> 元素的图标
 * 复用 IconPickerDialog 弹窗（加载全部 Bootstrap Icons ~2050 个）
 */
export function IconEditor({
  className,
  onChange,
}: {
  className: string;
  onChange: (val: string) => void;
}) {
  const [showPicker, setShowPicker] = useState(false);

  const currentIconName = extractBiIconName(className) || '';

  const handlePick = useCallback((iconName: string) => {
    if (iconName) {
      onChange(replaceBiIcon(className, iconName));
    } else {
      onChange(removeBiIcon(className));
    }
  }, [className, onChange]);

  return (
    <div className="designer-icon-editor">
      <PropertyField
        label="图标类名"
        value={currentIconName}
        onChange={val => {
          if (val) {
            onChange(replaceBiIcon(className, val));
          } else {
            onChange(removeBiIcon(className));
          }
        }}
        placeholder="例如: house, search, play-fill"
      />
      <div className="designer-icon-current">
        {currentIconName && (
          <span className="designer-icon-preview">
            <i className={`bi bi-${currentIconName}`} />
          </span>
        )}
        <button
          className="designer-icon-picker-toggle"
          onClick={() => setShowPicker(true)}
          title="选择图标"
        >
          选择图标
        </button>
      </div>

      {showPicker && (
        <IconPickerDialog
          value={currentIconName}
          onPick={handlePick}
          onClose={() => setShowPicker(false)}
        />
      )}
    </div>
  );
}
