/**
 * IconPickerDialog — Bootstrap Icons 图标选择弹窗
 *
 * 加载全部 Bootstrap Icons v1.11.3（约 2050 个），支持：
 *  - 名称模糊搜索（子串匹配）
 *  - 常用分类快捷栏
 *  - 虚拟滚动（仅渲染可视行，避免 2050 项 DOM 卡顿）
 *  - 清除图标
 *
 * 共享组件：IconEditor（<i> 元素）、NavLinkIconEditor（nav-link 图标）等均可调用。
 */
import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { X, Search } from 'lucide-react';
import {
  BOOTSTRAP_ICON_NAMES,
  BOOTSTRAP_ICON_CATEGORIES,
} from '../../utils/bootstrapIcons';

export interface IconPickerDialogProps {
  /** 当前选中的图标名（去 bi- 前缀，如 'house'）；空字符串表示未选中 */
  value: string;
  /** 选中图标时回调，参数为图标名（去 bi- 前缀）；传空字符串表示清除 */
  onPick: (iconName: string) => void;
  /** 关闭弹窗 */
  onClose: () => void;
}

/** 每行图标数 */
const COLS = 10;
/** 单元格高度（px，含 gap） */
const ROW_HEIGHT = 36;
/** 弹窗网格区最大高度（px） */
const GRID_MAX_HEIGHT = 420;

export default function IconPickerDialog({ value, onPick, onClose }: IconPickerDialogProps) {
  const [query, setQuery] = useState('');
  // 当前选中的分类；null = 全部
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  // 滚动偏移（虚拟滚动）
  const [scrollTop, setScrollTop] = useState(0);
  const gridRef = useRef<HTMLDivElement>(null);

  // 动态注入 Bootstrap Icons CSS（弹窗运行在主应用上下文，非 canvas iframe）
  // 确保所有 <i class="bi bi-*"> 能正确渲染图标字形
  useEffect(() => {
    const LINK_ID = '__xai_bootstrap_icons_for_dialog__';
    if (document.getElementById(LINK_ID)) return;
    const link = document.createElement('link');
    link.id = LINK_ID;
    link.rel = 'stylesheet';
    link.href = 'https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.min.css';
    document.head.appendChild(link);
  }, []);

  // 关闭快捷键 Esc
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // 根据搜索 + 分类计算图标列表
  const icons = useMemo(() => {
    if (activeCategory && !query.trim()) {
      // 分类模式：只显示该分类的图标
      return BOOTSTRAP_ICON_CATEGORIES[activeCategory] || [];
    }
    if (query.trim()) {
      // 搜索模式：从全量中过滤（忽略分类）
      const q = query.trim().toLowerCase();
      const result: string[] = [];
      for (const name of BOOTSTRAP_ICON_NAMES) {
        if (name.toLowerCase().includes(q)) {
          result.push(name);
          if (result.length >= 1000) break;
        }
      }
      return result;
    }
    // 全部模式
    return BOOTSTRAP_ICON_NAMES;
  }, [query, activeCategory]);

  // 虚拟滚动计算
  const totalRows = Math.ceil(icons.length / COLS);
  const totalHeight = totalRows * ROW_HEIGHT;
  const startIndex = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - 2);
  const visibleRowCount = Math.ceil(GRID_MAX_HEIGHT / ROW_HEIGHT) + 4;
  const endIndex = Math.min(totalRows, startIndex + visibleRowCount);
  const visibleIcons = icons.slice(startIndex * COLS, endIndex * COLS);

  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    setScrollTop(e.currentTarget.scrollTop);
  }, []);

  const handleSelect = useCallback((name: string) => {
    onPick(name);
    onClose();
  }, [onPick, onClose]);

  const handleClear = useCallback(() => {
    onPick('');
    onClose();
  }, [onPick, onClose]);

  return (
    <div className="designer-dialog-overlay" onClick={onClose}>
      <div
        className="designer-dialog designer-icon-picker-dialog"
        onClick={e => e.stopPropagation()}
      >
        {/* ── Header ── */}
        <div className="designer-dialog-header">
          <span className="designer-dialog-title">
            选择 Bootstrap 图标
            <span className="designer-icon-picker-count">{BOOTSTRAP_ICON_NAMES.length} 个</span>
          </span>
          <button className="designer-dialog-close" onClick={onClose} title="关闭 (Esc)">
            <X size={16} />
          </button>
        </div>

        {/* ── 搜索栏 ── */}
        <div className="designer-icon-picker-searchbar">
          <Search size={14} className="designer-icon-picker-search-icon" />
          <input
            type="text"
            className="designer-icon-picker-search-input"
            value={query}
            onChange={e => { setQuery(e.target.value); setActiveCategory(null); setScrollTop(0); if (gridRef.current) gridRef.current.scrollTop = 0; }}
            placeholder="搜索图标名称，如 house、arrow、play..."
            autoFocus
          />
        </div>

        {/* ── 分类快捷栏 ── */}
        <div className="designer-icon-picker-categories">
          <button
            className={`designer-icon-picker-cat${activeCategory === null ? ' active' : ''}`}
            onClick={() => { setActiveCategory(null); setQuery(''); setScrollTop(0); if (gridRef.current) gridRef.current.scrollTop = 0; }}
          >
            全部
          </button>
          {Object.keys(BOOTSTRAP_ICON_CATEGORIES).map(cat => (
            <button
              key={cat}
              className={`designer-icon-picker-cat${activeCategory === cat ? ' active' : ''}`}
              onClick={() => { setActiveCategory(cat); setQuery(''); setScrollTop(0); if (gridRef.current) gridRef.current.scrollTop = 0; }}
            >
              {cat}
            </button>
          ))}
        </div>

        {/* ── 图标网格（虚拟滚动） ── */}
        <div
          ref={gridRef}
          className="designer-icon-picker-grid"
          onScroll={handleScroll}
          style={{ maxHeight: GRID_MAX_HEIGHT }}
        >
          {icons.length === 0 ? (
            <div className="designer-icon-empty">无匹配图标</div>
          ) : (
            <div style={{ height: totalHeight, position: 'relative' }}>
              <div
                style={{
                  position: 'absolute',
                  top: startIndex * ROW_HEIGHT,
                  left: 0,
                  right: 0,
                }}
                className="designer-icon-picker-grid-inner"
              >
                {visibleIcons.map(name => (
                  <button
                    key={name}
                    className={`designer-icon-item${name === value ? ' active' : ''}`}
                    onClick={() => handleSelect(name)}
                    title={`bi bi-${name}`}
                  >
                    <i className={`bi bi-${name}`} />
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* ── Footer ── */}
        <div className="designer-dialog-footer">
          {value && (
            <span className="designer-icon-picker-current">
              当前：<i className={`bi bi-${value}`} /><code>{value}</code>
            </span>
          )}
          <div className="designer-dialog-footer-btns">
            {value && (
              <button className="designer-dialog-btn cancel" onClick={handleClear}>
                清除图标
              </button>
            )}
            <button className="designer-dialog-btn cancel" onClick={onClose}>
              取消
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
