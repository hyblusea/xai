import { useState, useEffect } from 'react';
import {
  Plus, Trash2, Copy, Rows3, Columns3,
  ArrowRight, ArrowDown,
  AlignHorizontalJustifyStart, AlignHorizontalJustifyEnd,
} from 'lucide-react';
import { PropertyField } from '../controls';

export function TableEditor({
  columnWidth,
  overflowX,
  overflowY,
  tableMaxHeight,
  stickyLeft,
  stickyRight,
  striped,
  onAddRow,
  onAddColumn,
  onRemoveRow,
  onRemoveColumn,
  onCopyRow,
  onCopyColumn,
  onColumnWidthChange,
  onScrollChange,
  onToggleTableStriped,
  onMergeTableCell,
  onToggleStickyColumn,
}: {
  columnWidth: string;
  overflowX: string;
  overflowY: string;
  tableMaxHeight: string;
  stickyLeft: boolean;
  stickyRight: boolean;
  striped: boolean;
  onAddRow?: () => void;
  onAddColumn?: () => void;
  onRemoveRow?: () => void;
  onRemoveColumn?: () => void;
  onCopyRow?: () => void;
  onCopyColumn?: () => void;
  onColumnWidthChange?: (width: string) => void;
  onScrollChange?: (style: { overflowX?: string; overflowY?: string; tableMaxHeight?: string }) => void;
  onToggleTableStriped?: (enabled: boolean) => void;
  onMergeTableCell?: (direction: 'right' | 'down') => void;
  onToggleStickyColumn?: (side: 'left' | 'right', enabled: boolean) => void;
}) {
  const [localWidth, setLocalWidth] = useState(columnWidth);
  // 斑马纹状态从 DOM 读取（props.striped），用 useEffect 同步以避免
  // 切换选中元素时本地 state 残留旧值导致显示与 DOM 不一致。
  const [stripedState, setStripedState] = useState(striped);

  useEffect(() => {
    setLocalWidth(columnWidth);
  }, [columnWidth]);

  useEffect(() => {
    setStripedState(striped);
  }, [striped]);

  const hasHorizontalScroll = overflowX === 'auto' || overflowX === 'scroll';
  const hasVerticalScroll = overflowY === 'auto' || overflowY === 'scroll';

  const toggleStriped = () => {
    const next = !stripedState;
    setStripedState(next);
    onToggleTableStriped?.(next);
  };

  return (
    <div className="designer-prop-collection">
      <PropertyField
        label="当前列宽"
        value={localWidth}
        onChange={val => {
          setLocalWidth(val);
          onColumnWidthChange?.(val);
        }}
        placeholder="120px / 20%"
      />
      <div className="designer-prop-row">
        <button type="button" className="designer-prop-btn" onClick={onAddRow}>
          <Plus size={12} />
          增加行
        </button>
        <button type="button" className="designer-prop-btn" onClick={onAddColumn}>
          <Plus size={12} />
          增加列
        </button>
      </div>
      <div className="designer-prop-row">
        <button type="button" className="designer-prop-btn" onClick={onRemoveRow}>
          <Trash2 size={12} />
          删除行
        </button>
        <button type="button" className="designer-prop-btn" onClick={onRemoveColumn}>
          <Trash2 size={12} />
          删除列
        </button>
      </div>
      <div className="designer-prop-row">
        <button type="button" className="designer-prop-btn" onClick={onCopyRow}>
          <Copy size={12} />
          复制行
        </button>
        <button type="button" className="designer-prop-btn" onClick={onCopyColumn}>
          <Copy size={12} />
          复制列
        </button>
      </div>

      {/* 合并单元格 */}
      {onMergeTableCell && (
        <>
          <div className="designer-prop-divider" />
          <div className="designer-prop-row">
            <button
              type="button"
              className="designer-prop-btn"
              onClick={() => onMergeTableCell('right')}
              title="向右合并"
            >
              <ArrowRight size={12} />
              向右合并
            </button>
            <button
              type="button"
              className="designer-prop-btn"
              onClick={() => onMergeTableCell('down')}
              title="向下合并"
            >
              <ArrowDown size={12} />
              向下合并
            </button>
          </div>
        </>
      )}

      {/* 斑马纹 */}
      {onToggleTableStriped && (
        <>
          <div className="designer-prop-divider" />
          <div className="designer-prop-field">
            <label className="designer-prop-label">斑马纹</label>
            <button
              type="button"
              className={`designer-prop-btn-icon full-width ${stripedState ? 'active' : ''}`}
              onClick={toggleStriped}
              title={stripedState ? '关闭斑马纹' : '开启斑马纹'}
            >
              {stripedState ? '已启用' : '未启用'}
            </button>
          </div>
        </>
      )}

      {/* ── Table Scroll Controls ── */}
      <div className="designer-prop-divider" />
      <div className="designer-prop-field">
        <label className="designer-prop-label">水平滚动 (需禁用自动列宽)</label>
        <button
          type="button"
          className={`designer-prop-btn-icon full-width ${hasHorizontalScroll ? 'active' : ''}`}
          onClick={() => {
            if (hasHorizontalScroll) {
              onScrollChange?.({ overflowX: 'visible' });
            } else {
              onScrollChange?.({ overflowX: 'auto' });
            }
          }}
          title={hasHorizontalScroll ? '关闭水平滚动' : '开启水平滚动'}
        >
          <Columns3 size={13} />
          {hasHorizontalScroll ? '已启用' : '未启用'}
        </button>
      </div>

      {/* 冻结列（sticky）：开启后会自动启用水平滚动并锁定 table-layout */}
      {onToggleStickyColumn && (
        <div className="designer-prop-row">
          <div className="designer-prop-field">
            <label className="designer-prop-label">冻结首列</label>
            <button
              type="button"
              className={`designer-prop-btn-icon full-width ${stickyLeft ? 'active' : ''}`}
              onClick={() => onToggleStickyColumn('left', !stickyLeft)}
              title={stickyLeft ? '取消冻结首列' : '冻结首列（不随水平滚动移动）'}
            >
              <AlignHorizontalJustifyStart size={13} />
              {stickyLeft ? '已冻结' : '未冻结'}
            </button>
          </div>
          <div className="designer-prop-field">
            <label className="designer-prop-label">冻结末尾列</label>
            <button
              type="button"
              className={`designer-prop-btn-icon full-width ${stickyRight ? 'active' : ''}`}
              onClick={() => onToggleStickyColumn('right', !stickyRight)}
              title={stickyRight ? '取消冻结末尾列' : '冻结末尾列（不随水平滚动移动）'}
            >
              <AlignHorizontalJustifyEnd size={13} />
              {stickyRight ? '已冻结' : '未冻结'}
            </button>
          </div>
        </div>
      )}

      <div className="designer-prop-field">
        <label className="designer-prop-label">垂直滚动</label>
        <button
          type="button"
          className={`designer-prop-btn-icon full-width ${hasVerticalScroll ? 'active' : ''}`}
          onClick={() => {
            if (hasVerticalScroll) {
              onScrollChange?.({ overflowY: 'visible', tableMaxHeight: '' });
            } else {
              onScrollChange?.({ overflowY: 'auto', tableMaxHeight: tableMaxHeight || '400px' });
            }
          }}
          title={hasVerticalScroll ? '关闭垂直滚动' : '开启垂直滚动'}
        >
          <Rows3 size={13} />
          {hasVerticalScroll ? '已启用' : '未启用'}
        </button>
      </div>
      {hasVerticalScroll && (
        <PropertyField
          label="最大高度"
          value={tableMaxHeight}
          onChange={val => onScrollChange?.({ tableMaxHeight: val })}
          placeholder="400px"
        />
      )}
    </div>
  );
}
