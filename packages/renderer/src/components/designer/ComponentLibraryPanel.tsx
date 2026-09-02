/**
 * ComponentLibraryPanel — 组件库浮层面板
 *
 * 布局 A：顶部搜索框 → 分类 Tab（全部/布局/基础/表单）→ 组件网格
 *
 * 交互：
 *  - 按下鼠标并拖拽组件卡片到画布 → 触发 onDragStart（自定义 mouse 拖拽）
 *  - 点击组件卡片 → 触发 onClickComponent（由调用方决定插入位置）
 *  - 点击遮罩或关闭按钮 → 触发 onClose
 *
 * 定位：fixed 紧贴工具栏下方右侧，宽度 320px，高度自适应（最大 420px）
 */
import React, { useState, useMemo, useEffect, useRef } from 'react';
import { Search, X } from 'lucide-react';
import {
  filterComponents,
  type ComponentDef,
  type ComponentCategory,
  type ComponentId,
  type InsertPosition,
} from '../../utils/designerComponents';
import type { DropTargetInfo } from '../../hooks/useComponentDrag';

interface ComponentLibraryPanelProps {
  onClose: () => void;
  /** 按下鼠标时调用 — 由 useComponentDrag 管理拖拽生命周期 */
  onDragStart: (e: React.MouseEvent, comp: ComponentDef) => void;
  onClickComponent: (componentType: ComponentId) => void;
  /** 拖拽进行中时降低面板透明度并禁用交互 */
  isDragging?: boolean;
  /** 拖拽中的落点父容器描述 — 用于 footer 实时显示 */
  dropTargetInfo?: DropTargetInfo | null;
  /**
   * 嵌入模式：嵌入 Dock 等容器时使用。
   *  - 不渲染外层 overlay 遮罩
   *  - 禁用「点击面板外部关闭」行为（避免拖拽组件到画布时误关闭）
   *  - 面板以 100% 宽高填充容器，去除绝对定位
   */
  embedded?: boolean;
}

type TabKey = 'all' | ComponentCategory;

/**
 * Tab 按钮显示文本（缩短为 2 字，便于在窄面板内一行排开）。
 * 注意：CATEGORY_LABELS 是全局常量，可能在其他地方使用全称（如 "布局容器"），
 * 这里仅覆盖面板 Tab 的显示，不动 CATEGORY_LABELS 本身。
 */
const TABS: { key: TabKey; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'template', label: '模板' },
  { key: 'layout', label: '布局' },
  { key: 'basic', label: '基础' },
  { key: 'form', label: '表单' },
  { key: 'chart', label: '图表' },
];

export default function ComponentLibraryPanel({
  onClose,
  onDragStart,
  onClickComponent,
  isDragging = false,
  dropTargetInfo = null,
  embedded = false,
}: ComponentLibraryPanelProps) {
  const [query, setQuery] = useState('');
  const [activeTab, setActiveTab] = useState<TabKey>('all');
  const panelRef = useRef<HTMLDivElement>(null);

  // 过滤后的组件列表
  const filtered = useMemo(() => {
    const byQuery = filterComponents(query);
    if (activeTab === 'all') return byQuery;
    return byQuery.filter(c => c.category === activeTab);
  }, [query, activeTab]);

  // ESC 关闭
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose]);

  // 点击面板外部关闭 — 嵌入模式下禁用（拖拽组件到画布时不应触发关闭）
  useEffect(() => {
    if (embedded) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    // 延迟绑定避免打开时立即触发
    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside);
    }, 0);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [onClose, embedded]);

  // 嵌入模式：直接渲染面板本体，填充容器；否则渲染 overlay 遮罩
  if (embedded) {
    return (
      <div
        className={`designer-comp-library designer-comp-library--embedded${isDragging ? ' is-dragging' : ''}`}
        ref={panelRef}
      >
        <ComponentLibraryContent
          query={query}
          setQuery={setQuery}
          activeTab={activeTab}
          setActiveTab={setActiveTab}
          filtered={filtered}
          onClose={onClose}
          onDragStart={onDragStart}
          onClickComponent={onClickComponent}
          dropTargetInfo={dropTargetInfo}
        />
      </div>
    );
  }

  return (
    <div
      className={`designer-comp-library-overlay${isDragging ? ' designer-comp-library-overlay--dragging' : ''}`}
    >
      <div
        className="designer-comp-library"
        ref={panelRef}
      >
        <ComponentLibraryContent
          query={query}
          setQuery={setQuery}
          activeTab={activeTab}
          setActiveTab={setActiveTab}
          filtered={filtered}
          onClose={onClose}
          onDragStart={onDragStart}
          onClickComponent={onClickComponent}
          dropTargetInfo={dropTargetInfo}
        />
      </div>
    </div>
  );
}

/** 面板内容（header / search / tabs / grid / footer） — overlay 与 embedded 两种模式共用 */
interface ComponentLibraryContentProps {
  query: string;
  setQuery: (v: string) => void;
  activeTab: TabKey;
  setActiveTab: (v: TabKey) => void;
  filtered: ComponentDef[];
  onClose: () => void;
  onDragStart: (e: React.MouseEvent, comp: ComponentDef) => void;
  onClickComponent: (componentType: ComponentId) => void;
  dropTargetInfo: DropTargetInfo | null;
}

/** 插入位置 → 中文标签 */
const POSITION_LABELS: Record<InsertPosition, string> = {
  before: '前方',
  after: '后方',
  inside: '内部',
};

function ComponentLibraryContent({
  query,
  setQuery,
  activeTab,
  setActiveTab,
  filtered,
  onClose,
  onDragStart,
  onClickComponent,
  dropTargetInfo,
}: ComponentLibraryContentProps) {
  return (
    <>
      {/* Header */}
      <div className="designer-comp-library-header">
        <span className="designer-comp-library-title">组件库</span>
        <button className="designer-comp-library-close" onClick={onClose} title="关闭 (ESC)">
          <X size={14} />
        </button>
      </div>

      {/* Search */}
      <div className="designer-comp-library-search">
        <Search size={12} />
        <input
          type="text"
          placeholder="搜索组件…"
          value={query}
          onChange={e => setQuery(e.target.value)}
          autoFocus
        />
      </div>

      {/* Category Tabs */}
      <div className="designer-comp-library-tabs">
        {TABS.map(tab => (
          <button
            key={tab.key}
            className={`designer-comp-library-tab ${activeTab === tab.key ? 'active' : ''}`}
            onClick={() => setActiveTab(tab.key)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Component Grid */}
      <div className="designer-comp-library-grid">
        {filtered.length === 0 ? (
          <div className="designer-comp-library-empty">未找到匹配组件</div>
        ) : (
          filtered.map(comp => (
            <ComponentCard
              key={comp.id}
              comp={comp}
              onDragStart={onDragStart}
              onClick={() => onClickComponent(comp.id)}
            />
          ))
        )}
      </div>

      {/* Footer — 两行：快捷键提示 + 拖拽中的实时落点 */}
      <div className="designer-comp-library-footer">
        <div className="designer-comp-library-footer-hint">
          Alt=内部 · Shift=前/后 · 默认按位置自动判定
        </div>
        <div
          className={`designer-comp-library-footer-target${dropTargetInfo ? ' is-active' : ''}`}
          role="status"
          aria-live="polite"
        >
          {dropTargetInfo
            ? `插入到${POSITION_LABELS[dropTargetInfo.position]}：${dropTargetInfo.parentLabel}`
            : '准备就绪 — 拖拽组件到画布'}
        </div>
      </div>
    </>
  );
}

/** 单个组件卡片 */
const ComponentCard = React.memo(function ComponentCard({
  comp,
  onDragStart,
  onClick,
}: {
  comp: ComponentDef;
  onDragStart: (e: React.MouseEvent, comp: ComponentDef) => void;
  onClick: () => void;
}) {
  return (
    <div
      className="designer-comp-card"
      onMouseDown={e => onDragStart(e, comp)}
      onClick={onClick}
      title={`拖拽或点击插入：${comp.name}`}
    >
      <div className="designer-comp-card-thumb">
        <svg width="48" height="32" viewBox="0 0 24 16" xmlns="http://www.w3.org/2000/svg">
          <g dangerouslySetInnerHTML={{ __html: comp.thumbnail }} />
        </svg>
      </div>
      <span className="designer-comp-card-name">{comp.name}</span>
    </div>
  );
});