import { useState, useCallback } from 'react';
import IconPickerDialog from '../../IconPickerDialog';

/**
 * NavLinkIconEditor — 为 nav-link 等非 <i> 元素增删图标
 * 通过 onStyleChange({ navLinkIcon }) 走 applyStyleChange 统一路径
 */
export function NavLinkIconEditor({
  currentIconName,
  onPick,
}: {
  currentIconName: string;
  onPick: (iconName: string) => void;
}) {
  const [showPicker, setShowPicker] = useState(false);

  const handlePick = useCallback((iconName: string) => {
    onPick(iconName);
    setShowPicker(false);
  }, [onPick]);

  return (
    <div className="designer-icon-editor">
      <div className="designer-icon-current">
        {currentIconName && (
          <span className="designer-icon-preview">
            <i className={`bi bi-${currentIconName}`} />
          </span>
        )}
        <button
          className="designer-icon-picker-toggle"
          onClick={() => setShowPicker(true)}
          title={currentIconName ? '更换图标' : '添加图标'}
        >
          {currentIconName ? '更换图标' : '添加图标'}
        </button>
        {currentIconName && (
          <button
            className="designer-icon-picker-toggle"
            onClick={() => handlePick('')}
            title="移除图标"
          >
            移除
          </button>
        )}
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
