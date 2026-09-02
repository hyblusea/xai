import React, { useState, useRef, useEffect, useCallback } from 'react';
import type { LayerNode, InsertComponentType, InsertPosition } from '../../hooks/useLayerTree';
import { ChevronRight, ChevronDown, Eye, EyeOff, Lock, Unlock, ArrowUp, ArrowDown, Plus, Copy, X, Layers, RefreshCw } from 'lucide-react';

interface LayerTreePanelProps {
  layers: LayerNode[];
  selectedSelector: string | null;
  onLayerClick: (selector: string) => void;
  onToggleVisibility: (selector: string) => void;
  onToggleLock: (selector: string) => void;
  onMoveElement: (selector: string, direction: 'up' | 'down') => void;
  onInsertElement: (selector: string, componentType: InsertComponentType, position: InsertPosition) => void;
  onDuplicateElement: (selector: string, position: InsertPosition) => void;
  onAddTableRow: (selector: string) => void;
  onAddTableColumn: (selector: string) => void;
  onRefresh: () => void;
  onLayerHover?: (selector: string | null) => void;
  onClose?: () => void;
  lockedSetRef?: React.MutableRefObject<Set<string>>;
}

interface InsertMenuState {
  visible: boolean;
  selector: string;
  tagName: string;
  x: number;
  y: number;
}

interface ActionBarState {
  selector: string;
  tagName: string;
  visible: boolean;
  locked: boolean;
  isTable: boolean;
  x: number;
  y: number;
}

const COMPONENT_OPTIONS: { type: InsertComponentType; label: string; icon: string }[] = [
  { type: 'input', label: '输入框', icon: '📝' },
  { type: 'select', label: '下拉选择', icon: '📋' },
  { type: 'textarea', label: '多行文本', icon: '📄' },
  { type: 'button', label: '按钮', icon: '🔘' },
  { type: 'checkbox', label: '复选框', icon: '☑️' },
  { type: 'radio', label: '单选组', icon: '🔘' },
  { type: 'divider', label: '分割线', icon: '➖' },
];

function getTagIcon(tag: string): string {
  const t = tag.toLowerCase();
  if (t === 'div') return '▢';
  if (t === 'form') return '📋';
  if (t === 'table') return '▦';
  if (t === 'tr' || t === 'th' || t === 'td') return '▤';
  if (t === 'thead' || t === 'tbody') return '▥';
  if (t === 'button' || t === 'a') return '🔘';
  if (t === 'input') return '📝';
  if (t === 'select') return '▼';
  if (t === 'img') return '🖼';
  if (t === 'p' || t === 'span' || t === 'label') return '📄';
  if (t === 'h1' || t === 'h2' || t === 'h3' || t === 'h4') return 'H';
  if (t === 'nav' || t === 'header' || t === 'footer' || t === 'section' || t === 'main' || t === 'aside') return '◱';
  if (t === 'ul' || t === 'ol') return '☰';
  if (t === 'li') return '•';
  if (t === 'hr') return '─';
  return '◇';
}

function getLayerLabel(node: LayerNode): string {
  if (node.text) {
    return node.text.length > 20 ? node.text.slice(0, 20) + '…' : node.text;
  }
  if (node.elementId) return `#${node.elementId}`;
  if (node.className) {
    const firstClass = node.className.split(' ')[0];
    if (firstClass) return `.${firstClass}`;
  }
  return node.tagName.toLowerCase();
}

function isTableElement(tagName: string): boolean {
  return ['table', 'thead', 'tbody', 'tr', 'th', 'td'].includes(tagName.toLowerCase());
}

function isContainerElement(tagName: string): boolean {
  return ['div', 'form', 'section', 'main', 'nav', 'aside', 'header', 'footer'].includes(tagName.toLowerCase());
}

/**
 * Find the list of ancestor node IDs that must be expanded to reveal the node
 * whose selector matches `targetSelector`. Returns null if not found.
 */
function findAncestorPath(nodes: LayerNode[], targetSelector: string): string[] | null {
  function search(nodeList: LayerNode[], path: string[]): string[] | null {
    for (const node of nodeList) {
      if (node.selector === targetSelector) {
        return path;
      }
      if (node.children.length > 0) {
        const found = search(node.children, [...path, node.id]);
        if (found) return found;
      }
    }
    return null;
  }
  return search(nodes, []);
}

interface LayerItemProps {
  node: LayerNode;
  depth: number;
  expandedIds: Set<string>;
  toggleExpand: (id: string) => void;
  selectedSelector: string | null;
  onSelect: (selector: string) => void;
  isLocked: (selector: string) => boolean;
  onHover?: (selector: string | null) => void;
  onShowActionBar?: (item: ActionBarState) => void;
  onHideActionBar?: () => void;
  selectedItemRef?: (el: HTMLDivElement | null) => void;
}

const LayerItem: React.FC<LayerItemProps> = ({
  node, depth, expandedIds, toggleExpand, selectedSelector, onSelect,
  isLocked, onHover, onShowActionBar, onHideActionBar, selectedItemRef,
}) => {
  const hasChildren = node.children.length > 0;
  const isExpanded = expandedIds.has(node.id);
  const isSelected = selectedSelector === node.selector;
  const isTableEl = isTableElement(node.tagName);
  const locked = isLocked(node.selector);

  return (
    <div className="designer-layer-item-wrapper">
      <div
        className={`designer-layer-item${isSelected ? ' selected' : ''}`}
        style={{ paddingLeft: `${8 + depth * 14}px` }}
        ref={isSelected ? selectedItemRef : undefined}
        onClick={() => onSelect(node.selector)}
        onMouseEnter={(e) => {
          onHover?.(node.selector);
          const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
          onShowActionBar?.({
            selector: node.selector,
            tagName: node.tagName,
            visible: node.visible,
            locked,
            isTable: isTableEl,
            x: rect.right,
            y: rect.top,
          });
        }}
        onMouseLeave={() => {
          onHover?.(null);
          onHideActionBar?.();
        }}
      >
        <span
          className="designer-layer-chevron"
          onClick={(e) => { e.stopPropagation(); toggleExpand(node.id); }}
          style={{ visibility: hasChildren ? 'visible' : 'hidden' }}
        >
          {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </span>
        <span className="designer-layer-tag">{getTagIcon(node.tagName)}</span>
        <span className="designer-layer-label" title={getLayerLabel(node)}>
          {getLayerLabel(node)}
        </span>
      </div>
      {hasChildren && isExpanded && (
        <div className="designer-layer-children">
          {node.children.map(child => (
            <LayerItem
              key={child.id}
              node={child}
              depth={depth + 1}
              expandedIds={expandedIds}
              toggleExpand={toggleExpand}
              selectedSelector={selectedSelector}
              onSelect={onSelect}
              isLocked={isLocked}
              onHover={onHover}
              onShowActionBar={onShowActionBar}
              onHideActionBar={onHideActionBar}
              selectedItemRef={selectedItemRef}
            />
          ))}
        </div>
      )}
    </div>
  );
};

export default function LayerTreePanel({
  layers, selectedSelector, onLayerClick, onToggleVisibility, onToggleLock,
  onMoveElement, onInsertElement, onDuplicateElement, onAddTableRow, onAddTableColumn, onRefresh,
  onLayerHover, onClose, lockedSetRef,
}: LayerTreePanelProps) {
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [insertMenu, setInsertMenu] = useState<InsertMenuState | null>(null);
  const [actionBar, setActionBar] = useState<ActionBarState | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const actionBarTimeoutRef = useRef<number | null>(null);

  const isLocked = useCallback((selector: string) => {
    return lockedSetRef?.current.has(selector) ?? false;
  }, [lockedSetRef]);

  const showActionBar = useCallback((item: ActionBarState) => {
    if (actionBarTimeoutRef.current) {
      clearTimeout(actionBarTimeoutRef.current);
      actionBarTimeoutRef.current = null;
    }
    setActionBar(item);
  }, []);

  const hideActionBar = useCallback(() => {
    actionBarTimeoutRef.current = window.setTimeout(() => {
      setActionBar(null);
    }, 150);
  }, []);

  const cancelHideActionBar = useCallback(() => {
    if (actionBarTimeoutRef.current) {
      clearTimeout(actionBarTimeoutRef.current);
      actionBarTimeoutRef.current = null;
    }
  }, []);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setInsertMenu(null);
      }
    }
    if (insertMenu?.visible) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [insertMenu?.visible]);

  useEffect(() => {
    if (layers.length > 0 && expandedIds.size === 0) {
      const ids = new Set<string>();
      function collectIds(nodes: LayerNode[], depth: number) {
        if (depth <= 2) {
          nodes.forEach(n => {
            ids.add(n.id);
            if (n.children.length > 0) collectIds(n.children, depth + 1);
          });
        }
      }
      collectIds(layers, 0);
      setExpandedIds(ids);
    }
  }, [layers, expandedIds.size]);

  // Auto-expand ancestors of the canvas-selected element so the highlight is
  // visible even when the element lives inside a collapsed subtree.
  useEffect(() => {
    if (!selectedSelector || layers.length === 0) return;
    const path = findAncestorPath(layers, selectedSelector);
    if (!path || path.length === 0) return;
    setExpandedIds(prev => {
      let changed = false;
      const next = new Set(prev);
      for (const id of path) {
        if (!next.has(id)) {
          next.add(id);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [selectedSelector, layers]);

  // Ref callback attached to the currently-selected layer row. When the row
  // mounts (after ancestor expansion) it scrolls into view inside the panel.
  const selectedItemRef = useCallback((el: HTMLDivElement | null) => {
    if (el) {
      el.scrollIntoView({ block: 'nearest' });
    }
  }, []);

  const toggleExpand = useCallback((id: string) => {
    setExpandedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleOpenInsert = useCallback((selector: string, tagName: string, e: React.MouseEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setInsertMenu({
      visible: true,
      selector,
      tagName,
      x: Math.min(rect.right + 4, window.innerWidth - 240),
      y: Math.min(rect.top, window.innerHeight - 480),
    });
  }, []);

  const handleInsertComponent = useCallback((componentType: InsertComponentType, position: InsertPosition) => {
    if (!insertMenu) return;
    onInsertElement(insertMenu.selector, componentType, position);
    setInsertMenu(null);
  }, [insertMenu, onInsertElement]);

  const handleQuickDuplicate = useCallback((selector: string) => {
    onDuplicateElement(selector, 'after');
  }, [onDuplicateElement]);

  const handleDuplicateMenu = useCallback((position: InsertPosition) => {
    if (!insertMenu) return;
    onDuplicateElement(insertMenu.selector, position);
    setInsertMenu(null);
  }, [insertMenu, onDuplicateElement]);

  const handleAddRow = useCallback(() => {
    if (!insertMenu) return;
    onAddTableRow(insertMenu.selector);
    setInsertMenu(null);
  }, [insertMenu, onAddTableRow]);

  const handleAddCol = useCallback(() => {
    if (!insertMenu) return;
    onAddTableColumn(insertMenu.selector);
    setInsertMenu(null);
  }, [insertMenu, onAddTableColumn]);

  const isTable = insertMenu ? isTableElement(insertMenu.tagName) : false;
  const isContainer = insertMenu ? isContainerElement(insertMenu.tagName) : false;

  return (
    <>
    <div className="designer-layer-panel">
      <div className="designer-layer-header">
        <Layers size={14} />
        <span className="designer-layer-title">图层</span>
        <button className="designer-layer-btn" title="刷新" onClick={onRefresh}>
          <RefreshCw size={12} />
        </button>
        {onClose && (
          <button className="designer-layer-btn" title="关闭" onClick={onClose}>
            <X size={12} />
          </button>
        )}
      </div>
      <div className="designer-layer-list">
        {layers.length === 0 ? (
          <div className="designer-layer-empty">点击画布中的元素以查看图层结构</div>
        ) : (
          layers.map(node => (
            <LayerItem
              key={node.id}
              node={node}
              depth={0}
              expandedIds={expandedIds}
              toggleExpand={toggleExpand}
              selectedSelector={selectedSelector}
              onSelect={onLayerClick}
              isLocked={isLocked}
              onHover={onLayerHover}
              onShowActionBar={showActionBar}
              onHideActionBar={hideActionBar}
              selectedItemRef={selectedItemRef}
            />
          ))
        )}
      </div>

    </div>

      {actionBar && (
        <div
          className="designer-layer-action-bar"
          style={{ left: actionBar.x, top: actionBar.y, transform: 'translateX(-50%)' }}
          onMouseEnter={cancelHideActionBar}
          onMouseLeave={hideActionBar}
        >
          {!actionBar.locked && (
            <>
              <button
                className="designer-layer-btn designer-layer-add-btn"
                title="插入组件"
                style={{ opacity: 1 }}
                onClick={(e) => { e.stopPropagation(); handleOpenInsert(actionBar.selector, actionBar.tagName, e); }}
              >
                <Plus size={13} />
              </button>
              <button
                className="designer-layer-btn designer-layer-dup-btn"
                title="复制到下方"
                style={{ opacity: 1 }}
                onClick={(e) => { e.stopPropagation(); handleQuickDuplicate(actionBar.selector); }}
              >
                <Copy size={13} />
              </button>
              {actionBar.isTable && (
                <button
                  className="designer-layer-btn"
                  title="添加行"
                  onClick={(e) => { e.stopPropagation(); onAddTableRow(actionBar.selector); }}
                >
                  <Plus size={13} />
                </button>
              )}
              <span className="designer-layer-action-sep" />
            </>
          )}
          <button
            className="designer-layer-btn"
            title="上移"
            onClick={(e) => { e.stopPropagation(); onMoveElement(actionBar.selector, 'down'); }}
          >
            <ArrowUp size={13} />
          </button>
          <button
            className="designer-layer-btn"
            title="下移"
            onClick={(e) => { e.stopPropagation(); onMoveElement(actionBar.selector, 'up'); }}
          >
            <ArrowDown size={13} />
          </button>
          <span className="designer-layer-action-sep" />
          <button
            className="designer-layer-btn"
            title={actionBar.visible ? '隐藏' : '显示'}
            onClick={(e) => { e.stopPropagation(); onToggleVisibility(actionBar.selector); }}
          >
            {actionBar.visible ? <Eye size={13} /> : <EyeOff size={13} />}
          </button>
          <button
            className="designer-layer-btn"
            title={actionBar.locked ? '解锁' : '锁定'}
            onClick={(e) => { e.stopPropagation(); onToggleLock(actionBar.selector); }}
          >
            {actionBar.locked ? <Lock size={13} /> : <Unlock size={13} />}
          </button>
        </div>
      )}

      {insertMenu?.visible && (
        <div
          ref={menuRef}
          className="designer-insert-menu"
          style={{ left: insertMenu.x, top: insertMenu.y }}
        >
          <div className="designer-insert-menu-section designer-insert-menu-section-dup">
            <div className="designer-insert-menu-title">📋 复制当前元素</div>
            <div className="designer-insert-menu-grid">
              <button className="designer-insert-menu-item designer-insert-menu-item-dup" onClick={() => handleDuplicateMenu('before')}>
                <span className="designer-insert-menu-icon">⬆️</span>
                <span className="designer-insert-menu-label">复制到上方</span>
              </button>
              <button className="designer-insert-menu-item designer-insert-menu-item-dup" onClick={() => handleDuplicateMenu('after')}>
                <span className="designer-insert-menu-icon">⬇️</span>
                <span className="designer-insert-menu-label">复制到下方</span>
              </button>
              {isContainer && (
                <button className="designer-insert-menu-item designer-insert-menu-item-dup" onClick={() => handleDuplicateMenu('inside')}>
                  <span className="designer-insert-menu-icon">📥</span>
                  <span className="designer-insert-menu-label">复制到内部</span>
                </button>
              )}
            </div>
          </div>
          <div className="designer-insert-menu-divider" />
          <div className="designer-insert-menu-section">
            <div className="designer-insert-menu-title">在上方插入新组件</div>
            <div className="designer-insert-menu-grid">
              {COMPONENT_OPTIONS.map(opt => (
                <button
                  key={`before-${opt.type}`}
                  className="designer-insert-menu-item"
                  onClick={() => handleInsertComponent(opt.type, 'before')}
                  title={`在上方插入${opt.label}`}
                >
                  <span className="designer-insert-menu-icon">{opt.icon}</span>
                  <span className="designer-insert-menu-label">{opt.label}</span>
                </button>
              ))}
            </div>
          </div>
          <div className="designer-insert-menu-section">
            <div className="designer-insert-menu-title">在下方插入新组件</div>
            <div className="designer-insert-menu-grid">
              {COMPONENT_OPTIONS.map(opt => (
                <button
                  key={`after-${opt.type}`}
                  className="designer-insert-menu-item"
                  onClick={() => handleInsertComponent(opt.type, 'after')}
                  title={`在下方插入${opt.label}`}
                >
                  <span className="designer-insert-menu-icon">{opt.icon}</span>
                  <span className="designer-insert-menu-label">{opt.label}</span>
                </button>
              ))}
            </div>
          </div>
          {isContainer && (
            <div className="designer-insert-menu-section">
              <div className="designer-insert-menu-title">插入到内部</div>
              <div className="designer-insert-menu-grid">
                {COMPONENT_OPTIONS.map(opt => (
                  <button
                    key={`inside-${opt.type}`}
                    className="designer-insert-menu-item"
                    onClick={() => handleInsertComponent(opt.type, 'inside')}
                    title={`插入到内部末尾`}
                  >
                    <span className="designer-insert-menu-icon">{opt.icon}</span>
                    <span className="designer-insert-menu-label">{opt.label}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
          {isTable && (
            <div className="designer-insert-menu-section">
              <div className="designer-insert-menu-title">表格操作</div>
              <div className="designer-insert-menu-grid">
                <button className="designer-insert-menu-item" onClick={handleAddRow}>
                  <span className="designer-insert-menu-icon">➕</span>
                  <span className="designer-insert-menu-label">添加行</span>
                </button>
                <button className="designer-insert-menu-item" onClick={handleAddCol}>
                  <span className="designer-insert-menu-icon">➕</span>
                  <span className="designer-insert-menu-label">添加列</span>
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </>
  );
}
