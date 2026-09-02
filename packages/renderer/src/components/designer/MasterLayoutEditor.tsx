import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Copy, Trash2, X, Parentheses, MoveUpLeft, MoveDownRight, ArrowBigUpDash, ArrowBigDownDash,
  Layers as LayersIcon, SlidersHorizontal, Component as ComponentIcon,
} from 'lucide-react';
import type { MasterLayout, DesignerScreen, SelectedElement, ElementStyle, ProjectType } from '@xai/shared';
import { useDesignerElementOps } from '../../hooks/useDesignerElementOps';
import { useSelectedDomState } from '../../hooks/useSelectedDomState';
import { useLayerTree } from '../../hooks/useLayerTree';
import { useComponentDrag } from '../../hooks/useComponentDrag';
import { buildSelectedElement } from '../../utils/designerElementUtils';
import { postProcessDesignerHtml } from '../../utils/designerScrollbar';
import { buildPreviewDocument, extractBodyContent, injectResponsiveOverride } from '../../utils/masterLayoutPreview';
import type { ComponentId } from '../../utils/designerComponents';
import ElementPropertiesPanel from './ElementPropertiesPanel';
import LayerTreePanel from './LayerTreePanel';
import ComponentLibraryPanel from './ComponentLibraryPanel';
import DesignerDock from './DesignerDock';

interface MasterLayoutEditorProps {
  /** 当前编辑的 MasterLayout（受控）。 */
  layout: MasterLayout;
  /** 项目所有页面列表，用于属性面板的跳转目标下拉。 */
  screens: DesignerScreen[];
  /** 项目类型，用于预览 iframe 的 postProcess。 */
  projectType: ProjectType;
  /** 项目主题 JSON 串，用于预览 iframe。 */
  themePrompt?: string;
  /** HTML 变更时回调（受控）。 */
  onChange: (updates: { html?: string }) => void;
  /** 选择模式开关（受控）：true=选择元素，false=交互预览（可点击控件）。 */
  selectMode: boolean;
}

/**
 * MasterLayout 可视化编辑器（选择模式 + 属性面板）。
 *
 * 取代旧的 MasterLayoutCanvas（结构化 MenuItem 树编辑器）。复用主设计器的
 * 选择/属性/图层基础设施，类型无关——对 menu/header/footer/sidebar 任意 DOM
 * 都可直接点选编辑。
 *
 * 无闪烁核心：layout.html 是 body 片段，iframe 显示完整处理后文档，二者不同。
 * 解耦「期望 srcDoc」(iframeSrc, 完整文档) 与「已存片段」(layout.html)。直接
 * DOM 编辑走 reportDomHtmlChange → 设 directDomHtmlRef → effectiveSrcDoc 跳过
 * srcDoc 重载（镜像 SavedPages.tsx:251-282 的单 iframe 简化版）。
 */
export default function MasterLayoutEditor({
  layout, screens, projectType, themePrompt, onChange, selectMode,
}: MasterLayoutEditorProps) {
  const layoutId = layout.id;

  // ── refs ──────────────────────────────────────────────────────────────
  // layoutId 作为合成的 "screenId" 喂给 useDesignerElementOps（单 iframe 场景）。
  const iframeRefs = useRef<Map<string, HTMLIFrameElement>>(new Map());
  const selectedScreenIdRef = useRef<string | null>(layoutId);
  const iframeContainerRef = useRef<HTMLDivElement | null>(null);

  // 无闪烁直接 DOM 写入跟踪（镜像 SavedPages 的 directDomHtmlRef/loadedSrcDocRef/domHtmlRef）
  const directDomHtmlRef = useRef<Map<string, string>>(new Map());
  const loadedSrcDocRef = useRef<string | undefined>(undefined);
  const domHtmlRef = useRef<string | undefined>(undefined);
  // 抑制可视化编辑后 layout.html useEffect 的重算（变更来自 reportDomHtmlChange）
  const skipNextRecomputeRef = useRef(false);

  // ── state ─────────────────────────────────────────────────────────────
  const [selectedElement, setSelectedElement] = useState<SelectedElement | null>(null);
  const [iframeSrc, setIframeSrc] = useState<string>(() =>
    injectResponsiveOverride(postProcessDesignerHtml(buildPreviewDocument(layout.html, layout.css, layout.scripts), projectType, themePrompt)));
  const [iframeKey, setIframeKey] = useState(0);

  // 右侧 Dock 面板开/关状态：组件库/图层默认收起（false），属性面板默认展开
  const [dockComponentsOpen, setDockComponentsOpen] = useState(false);
  const [dockLayerOpen, setDockLayerOpen] = useState(false);
  const [dockPropertiesOpen, setDockPropertiesOpen] = useState(true);

  // 稳定的单元素 screens 数组（避免每渲染新建导致 useDesignerElementOps 监听器 effect 重跑）
  const screensMemo = useMemo(() => [{ id: layoutId }], [layoutId]);

  // ── reportDomHtmlChange 适配器 ────────────────────────────────────────
  // 直接 DOM 编辑（applyStyleChange / 拖拽 / 缩放 / 图层操作）变更 iframe DOM 后
  // 调用本函数：标记跳过 srcDoc 重载 + 同步跟踪 ref + 推 iframeSrc + 提取 body
  // 片段回调 onChange。layout.html(body 片段) 与 iframeSrc(完整文档) 解耦。
  const reportDomHtmlChange = useCallback((fullDocHtml: string) => {
    skipNextRecomputeRef.current = true;
    directDomHtmlRef.current.set(layoutId, fullDocHtml);
    domHtmlRef.current = fullDocHtml;
    setIframeSrc(fullDocHtml);
    onChange({ html: extractBodyContent(fullDocHtml) });
  }, [layoutId, onChange]);

  // 外部 layout.html 变化（源码 tab / 项目切换）：重算 iframeSrc。
  // 若 skipNextRecomputeRef 为 true 说明变更来自 reportDomHtmlChange，消费并跳过。
  useEffect(() => {
    if (skipNextRecomputeRef.current) {
      skipNextRecomputeRef.current = false;
      return;
    }
    const processed = injectResponsiveOverride(postProcessDesignerHtml(buildPreviewDocument(layout.html, layout.css, layout.scripts), projectType, themePrompt));
    setIframeSrc(prev => (prev === processed ? prev : processed));
  }, [layout.html, layout.css, layout.scripts, projectType, themePrompt]);

  // 每次 render 后消费 directDomHtmlRef 标志（镜像 SavedPages.tsx:208-210）
  useLayoutEffect(() => {
    directDomHtmlRef.current.clear();
  });

  // ── 稳定的 no-op 回调（避免 hook 依赖抖动）────────────────────────────
  const noop = useCallback(() => {}, []);
  const onSelectScreen = useCallback(() => {}, []);
  const onElementStyleChange = useCallback(((_selector: string, _style: Partial<ElementStyle>) => {}) as (selector: string, style: Partial<ElementStyle>) => void, []);
  const calculateSnap = useCallback(() => ({ snapDx: 0, snapDy: 0 }), []);
  const clearAlignmentGuides = useCallback(() => {}, []);

  // ── useDesignerElementOps：iframe 监听 + applyStyleChange + 结构编辑 ──
  const {
    applyStyleChange,
    handleDuplicateElement,
    selectParentElement,
    duplicateSelectedElement,
    swapWithSibling,
    adjustZIndex,
    resetDragState,
    addTableRowAtSelection,
    addTableColumnAtSelection,
    removeTableRowAtSelection,
    removeTableColumnAtSelection,
    copyTableRowAtSelection,
    copyTableColumnAtSelection,
    setTableColumnWidth,
    updateSelectOptions,
    renameTab,
    addTab,
    removeTab,
    setActiveTab,
    setAsCurrentMenuItem,
    toggleTableStriped,
    toggleTableStickyColumn,
    mergeTableCell,
    addAccordionItem,
    removeAccordionItem,
    renameAccordionItem,
    toggleAccordionItem,
    addCarouselSlide,
    removeCarouselSlide,
    setActiveCarouselSlide,
    renameCarouselSlide,
    updateProgress,
    updateBadge,
    updateDialog,
    updateButton,
  } = useDesignerElementOps({
    iframeRefs,
    selectedScreenIdRef,
    selectedElement,
    selectMode,
    isGenerating: false,
    currentScreenId: layoutId,
    screens: screensMemo,
    onSelectElement: setSelectedElement,
    onSelectScreen,
    onHtmlChange: reportDomHtmlChange,
    onElementStyleChange,
    calculateSnap,
    clearAlignmentGuides,
  });

  // ── useSelectedDomState：属性面板的结构化 DOM 上下文 ──────────────────
  const selectedDomState = useSelectedDomState({
    selectedElement,
    iframeRefs,
    currentScreenId: layoutId,
    iframeKey,
    selectMode,
    selectedScreenIdRef,
  });

  // ── useLayerTree：图层树（复杂嵌套菜单的关键）────────────────────────
  const getIframe = useCallback(() => iframeRefs.current.get(layoutId) || null, [layoutId]);

  // 桥接：图层树传 selector 字符串，需构造完整 SelectedElement 供属性面板。
  const handleLayerSelect = useCallback((selector: string) => {
    const iframe = iframeRefs.current.get(layoutId);
    if (!iframe?.contentDocument) return;
    const el = iframe.contentDocument.querySelector(selector) as HTMLElement | null;
    if (!el) return;
    selectedScreenIdRef.current = layoutId;
    setSelectedElement(buildSelectedElement(el, iframe.contentDocument, layoutId));
  }, [layoutId]);

  const {
    layers, refresh: refreshLayers, toggleVisibility, toggleLock,
    handleLayerClick, moveElement, insertElement, duplicateElement, addTableRow, addTableColumn,
    lockedSetRef,
  } = useLayerTree({
    getIframe,
    onSelectElement: handleLayerSelect,
    selectedSelector: selectedElement?.selector || null,
    enabled: selectMode,
    onHtmlChange: reportDomHtmlChange,
  });

  // ── 组件库拖拽插入（镜像 DesignerCanvas 的 useComponentDrag 用法）─────
  // 点击组件卡片：模板类替换 body，其余插入选中元素之后（未选中则 body 末尾）
  const handleComponentClickInsert = useCallback((componentType: ComponentId) => {
    const isTemplate = componentType.startsWith('tpl-');
    if (isTemplate) {
      insertElement('body', componentType, 'inside');
    } else {
      const baseSelector = selectedElement?.selector || 'body';
      insertElement(baseSelector, componentType, 'after');
    }
  }, [insertElement, selectedElement]);

  const handleCloseComponentLibrary = useCallback(() => {
    setDockComponentsOpen(false);
  }, []);

  const {
    isDragging: isCompDragging,
    dropTargetInfo: compDropTargetInfo,
    handleDragStart: handleCompDragStart,
  } = useComponentDrag({
    iframeRefs,
    currentScreenId: layoutId,
    onInsert: insertElement,
    enabled: selectMode,
    zoom: 1,
  });

  // ── 删除选中元素（useDesignerElementOps 未返回 delete，本组件实现）─────
  const deleteSelectedElement = useCallback(() => {
    if (!selectedElement) return;
    const iframe = iframeRefs.current.get(layoutId);
    if (!iframe?.contentDocument) return;
    const el = iframe.contentDocument.querySelector(selectedElement.selector) as HTMLElement | null;
    if (!el) return;
    el.remove();
    const newHtml = '<!DOCTYPE html>\n' + iframe.contentDocument.documentElement.outerHTML;
    reportDomHtmlChange(newHtml);
    setSelectedElement(null);
    refreshLayers();
  }, [selectedElement, layoutId, iframeRefs, reportDomHtmlChange, refreshLayers]);

  // ── 工具条操作包装：结构变更后刷新图层树 ─────────────────────────────
  const handleDuplicateAndRefresh = useCallback(() => {
    duplicateSelectedElement();
    refreshLayers();
  }, [duplicateSelectedElement, refreshLayers]);
  const handleSwapAndRefresh = useCallback((dir: 'previous' | 'next') => {
    swapWithSibling(dir);
    refreshLayers();
  }, [swapWithSibling, refreshLayers]);
  const handleZIndexAndRefresh = useCallback((delta: number) => {
    adjustZIndex(delta);
    refreshLayers();
  }, [adjustZIndex, refreshLayers]);

  // ── 选择模式受控：退出时清空选区与拖拽状态，进入时展开属性面板 ──
  useEffect(() => {
    if (!selectMode) {
      setSelectedElement(null);
      resetDragState();
      setDockLayerOpen(false);
      setDockPropertiesOpen(false);
    } else {
      setDockPropertiesOpen(true);
    }
  }, [selectMode, resetDragState]);

  // ── effectiveSrcDoc 计算（镜像 SavedPages.tsx:251-282 单 iframe 简化版）──
  const directHtml = directDomHtmlRef.current.get(layoutId);
  const loadedSrc = loadedSrcDocRef.current;
  const domHtml = domHtmlRef.current;
  let effectiveSrcDoc: string;
  if (loadedSrc === undefined) {
    // 首次挂载
    effectiveSrcDoc = iframeSrc;
    loadedSrcDocRef.current = iframeSrc;
    domHtmlRef.current = iframeSrc;
  } else if (directHtml !== undefined && directHtml === iframeSrc) {
    // 直接 DOM 编辑——iframe 已显示此 HTML，保持旧 srcDoc 避免冗余重载
    effectiveSrcDoc = loadedSrc;
    domHtmlRef.current = iframeSrc;
  } else if (iframeSrc === domHtml) {
    // 期望 srcDoc 与 DOM 已一致——不重载
    effectiveSrcDoc = loadedSrc;
  } else if (iframeSrc !== loadedSrc) {
    // 外部变更产生不同 srcDoc——React 将重载
    effectiveSrcDoc = iframeSrc;
    loadedSrcDocRef.current = iframeSrc;
  } else {
    // 边界：iframeSrc===loadedSrc 但 DOM 被先前直接编辑改过。弹窗无 undo/redo，
    // 此场景罕见，保持 loadedSrc（与 SavedPages 一致，由 reloadCounter 兜底——此处省略）
    effectiveSrcDoc = loadedSrc;
  }

  // ── iframe onLoad：同步 DOM 跟踪 + 刷新图层树 + 屏蔽 <a> 导航 ─────────
  const handleIframeLoad = useCallback(() => {
    domHtmlRef.current = iframeSrc;
    // bump iframeKey 让 useSelectedDomState 重新提取结构化状态
    setIframeKey(k => k + 1);
    refreshLayers();
    // 阻止 <a href="#"> 触发顶层导航 / iframe 滚顶（镜像 SavedPages.tsx:363-368）。
    // 选择模式由 clickHandler 统一 preventDefault；交互模式下此 guard 保证
    // 点击菜单链接不会污染顶层 hash 或导致 iframe 滚顶。捕获阶段 + 不
    // stopPropagation，与 dropdown/navbar handler 共存不冲突。
    const doc = iframeRefs.current.get(layoutId)?.contentDocument;
    if (doc) {
      doc.addEventListener('click', (ev: MouseEvent) => {
        const t = ev.target as HTMLElement;
        if (t.closest('a')) ev.preventDefault();
      }, true);
    }
  }, [iframeSrc, refreshLayers, layoutId]);

  // 退出时清理选区与拖拽状态
  useEffect(() => () => { resetDragState(); }, [resetDragState]);

  // ── 渲染 ─────────────────────────────────────────────────────────────
  return (
    <div className="master-layout-editor">
      {/* 右侧 Dock：组件库 + 图层 + 属性（与主设计器一致，tab 条在最右） */}
      <DesignerDock
        side="right"
        panels={[
          {
            id: 'components',
            title: '组件库',
            icon: <ComponentIcon size={16} />,
            available: true,
            open: dockComponentsOpen,
            onToggle: () => setDockComponentsOpen(prev => !prev),
            children: (
              <ComponentLibraryPanel
                embedded
                onClose={handleCloseComponentLibrary}
                onDragStart={handleCompDragStart}
                onClickComponent={handleComponentClickInsert}
                isDragging={isCompDragging}
                dropTargetInfo={compDropTargetInfo}
              />
            ),
          },
          {
            id: 'master-layers',
            title: '图层',
            icon: <LayersIcon size={16} />,
            available: true,
            open: dockLayerOpen,
            onToggle: () => setDockLayerOpen(prev => !prev),
            children: (
              <LayerTreePanel
                layers={layers}
                selectedSelector={selectedElement?.selector || null}
                onLayerClick={handleLayerClick}
                onToggleVisibility={toggleVisibility}
                onToggleLock={toggleLock}
                onMoveElement={moveElement}
                onInsertElement={insertElement}
                onDuplicateElement={duplicateElement}
                onAddTableRow={addTableRow}
                onAddTableColumn={addTableColumn}
                onRefresh={refreshLayers}
                onClose={() => setDockLayerOpen(false)}
                lockedSetRef={lockedSetRef}
              />
            ),
          },
          {
            id: 'master-properties',
            title: '属性',
            icon: <SlidersHorizontal size={16} />,
            available: true,
            open: dockPropertiesOpen,
            onToggle: () => setDockPropertiesOpen(prev => !prev),
            children: (
              <ElementPropertiesPanel
                element={selectedElement}
                screens={screens}
                selectOptions={selectedDomState.selectOptions}
                tableColumnWidth={selectedDomState.tableColumnWidth}
                hasTableContext={selectedDomState.hasTableContext}
                tableStickyLeft={selectedDomState.tableStickyLeft}
                tableStickyRight={selectedDomState.tableStickyRight}
                tableStriped={selectedDomState.tableStriped}
                onToggleTableStickyColumn={toggleTableStickyColumn}
                tabItems={selectedDomState.tabItems}
                onStyleChange={applyStyleChange}
                onAddToChat={noop}
                hideAddToChat
                onClose={() => setDockPropertiesOpen(false)}
                onAddTableRow={addTableRowAtSelection}
                onAddTableColumn={addTableColumnAtSelection}
                onRemoveTableRow={removeTableRowAtSelection}
                onRemoveTableColumn={removeTableColumnAtSelection}
                onCopyTableRow={copyTableRowAtSelection}
                onCopyTableColumn={copyTableColumnAtSelection}
                onTableColumnWidthChange={setTableColumnWidth}
                onSelectOptionsChange={updateSelectOptions}
                onAddTab={addTab}
                onRemoveTab={removeTab}
                onRenameTab={renameTab}
                onSetActiveTab={setActiveTab}
                onToggleTableStriped={toggleTableStriped}
                onMergeTableCell={mergeTableCell}
                accordionItems={selectedDomState.accordionItems}
                onAddAccordion={addAccordionItem}
                onRemoveAccordion={removeAccordionItem}
                onRenameAccordion={renameAccordionItem}
                onToggleAccordion={toggleAccordionItem}
                carouselSlides={selectedDomState.carouselSlides}
                carouselHasIndicators={selectedDomState.carouselHasIndicators}
                carouselHasControls={selectedDomState.carouselHasControls}
                onAddCarouselSlide={addCarouselSlide}
                onRemoveCarouselSlide={removeCarouselSlide}
                onSetActiveCarouselSlide={setActiveCarouselSlide}
                onRenameCarouselSlide={renameCarouselSlide}
                progressData={selectedDomState.progressData}
                onUpdateProgress={updateProgress}
                badgeData={selectedDomState.badgeData}
                onUpdateBadge={updateBadge}
                dialogData={selectedDomState.dialogData}
                onUpdateDialog={updateDialog}
                buttonData={selectedDomState.buttonData}
                onUpdateButton={updateButton}
                isMenuItem={selectedDomState.isMenuItem}
                menuItemIsActive={selectedDomState.menuItemIsActive}
                onSetAsCurrentMenuItem={setAsCurrentMenuItem}
              />
            ),
          },
        ]}
      />

      {/* 中：iframe 预览 + 选择高亮 */}
      <div className="master-layout-editor-canvas">
        <div className={`master-layout-editor-iframe-wrap ${selectMode ? 'select-mode' : ''}`} ref={iframeContainerRef}>
          <iframe
            title="master-layout-editor"
            className="master-layout-editor-iframe"
            srcDoc={effectiveSrcDoc}
            sandbox="allow-same-origin allow-scripts"
            ref={el => {
              if (el) iframeRefs.current.set(layoutId, el);
              else iframeRefs.current.delete(layoutId);
            }}
            onLoad={handleIframeLoad}
          />
          {selectMode && (
            <MasterLayoutOverlay
              selectedElement={selectedElement}
              containerRef={iframeContainerRef}
              onSelectParent={selectParentElement}
              onDuplicate={handleDuplicateAndRefresh}
              onSwapPrevious={() => handleSwapAndRefresh('previous')}
              onSwapNext={() => handleSwapAndRefresh('next')}
              onZIndexUp={() => handleZIndexAndRefresh(1)}
              onZIndexDown={() => handleZIndexAndRefresh(-1)}
              onDelete={deleteSelectedElement}
              onDeselect={() => setSelectedElement(null)}
            />
          )}
        </div>
      </div>
    </div>
  );
}

// ── 浮动选择工具条（轻量，不复用 ScreenOverlays 以避免 CSS 类耦合）──────────
interface MasterLayoutOverlayProps {
  selectedElement: SelectedElement | null;
  containerRef: React.RefObject<HTMLDivElement | null>;
  onSelectParent: () => void;
  onDuplicate: () => void;
  onSwapPrevious: () => void;
  onSwapNext: () => void;
  onZIndexUp: () => void;
  onZIndexDown: () => void;
  onDelete: () => void;
  onDeselect: () => void;
}

function MasterLayoutOverlay({
  selectedElement, containerRef, onSelectParent, onDuplicate,
  onSwapPrevious, onSwapNext, onZIndexUp, onZIndexDown, onDelete, onDeselect,
}: MasterLayoutOverlayProps) {
  const [fixedPos, setFixedPos] = useState<{ left: number; top: number } | null>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);

  // 选中元素变化时重算工具条固定位置（含 iframe 内滚动——hook 会更新 rect 触发重渲染）
  useLayoutEffect(() => {
    if (!selectedElement) { setFixedPos(null); return; }
    const container = containerRef.current;
    if (!container) { setFixedPos(null); return; }
    const containerRect = container.getBoundingClientRect();
    const elemLeft = containerRect.left + selectedElement.rect.x;
    const elemTop = containerRect.top + selectedElement.rect.y;
    const elemWidth = selectedElement.rect.width;
    const elemHeight = selectedElement.rect.height;
    const tWidth = toolbarRef.current?.offsetWidth ?? 280;
    const tHeight = toolbarRef.current?.offsetHeight ?? 28;
    const gap = 6;
    let top = elemTop - tHeight - gap;
    if (top < 4) top = elemTop + elemHeight + gap;
    let left = elemLeft;
    if (left + tWidth > window.innerWidth - 4) left = window.innerWidth - tWidth - 4;
    left = Math.max(4, left);
    setFixedPos({ left, top });
  }, [selectedElement, containerRef]);

  // 窗口缩放时重算
  useEffect(() => {
    if (!selectedElement) return;
    const handler = () => setFixedPos(prev => {
      if (!prev || !selectedElement) return null;
      const container = containerRef.current;
      if (!container) return null;
      const containerRect = container.getBoundingClientRect();
      const elemTop = containerRect.top + selectedElement.rect.y;
      const elemHeight = selectedElement.rect.height;
      const tHeight = toolbarRef.current?.offsetHeight ?? 28;
      const gap = 6;
      let top = elemTop - tHeight - gap;
      if (top < 4) top = elemTop + elemHeight + gap;
      return { left: prev.left, top };
    });
    window.addEventListener('resize', handler);
    return () => window.removeEventListener('resize', handler);
  }, [selectedElement, containerRef]);

  if (!selectedElement) return null;

  return (
    <>
      {/* 选择框（绝对定位于 iframe 容器内，复用现有 CSS）*/}
      <div
        className="designer-selection-overlay"
        style={{
          left: selectedElement.rect.x,
          top: selectedElement.rect.y,
          width: selectedElement.rect.width,
          height: selectedElement.rect.height,
        }}
      />
      {/* 浮动工具条（portal 到 body，固定定位，避免被容器 overflow 裁剪）*/}
      {typeof document !== 'undefined' && document.body && createPortal(
        <div
          ref={toolbarRef}
          className="designer-selection-toolbar designer-selection-toolbar--fixed"
          style={{
            left: fixedPos?.left ?? -9999,
            top: fixedPos?.top ?? -9999,
            visibility: fixedPos ? 'visible' : 'hidden',
          }}
          onMouseDown={e => e.stopPropagation()}
          onClick={e => e.stopPropagation()}
        >
          <span className="designer-selection-tag">
            {selectedElement.tagName}
            {selectedElement.id && ` #${selectedElement.id}`}
          </span>
          <button className="designer-selection-btn" onClick={e => { e.stopPropagation(); onSelectParent(); }} title="选择父容器">
            <Parentheses size={11} />
          </button>
          <button className="designer-selection-btn" onClick={e => { e.stopPropagation(); onDuplicate(); }} title="复制元素">
            <Copy size={11} />
          </button>
          <button className="designer-selection-btn" onClick={e => { e.stopPropagation(); onSwapPrevious(); }} title="与左侧或上方元素交换">
            <MoveUpLeft size={11} />
          </button>
          <button className="designer-selection-btn" onClick={e => { e.stopPropagation(); onSwapNext(); }} title="与右侧或下方元素交换">
            <MoveDownRight size={11} />
          </button>
          <button className="designer-selection-btn" onClick={e => { e.stopPropagation(); onZIndexUp(); }} title="Z 轴上移">
            <ArrowBigUpDash size={11} />
          </button>
          <button className="designer-selection-btn" onClick={e => { e.stopPropagation(); onZIndexDown(); }} title="Z 轴下移">
            <ArrowBigDownDash size={11} />
          </button>
          <button className="designer-selection-btn danger" onClick={e => { e.stopPropagation(); onDelete(); }} title="删除元素">
            <Trash2 size={11} />
          </button>
          <button className="designer-selection-btn" onClick={e => { e.stopPropagation(); onDeselect(); }} title="取消选择">
            <X size={11} />
          </button>
        </div>,
        document.body,
      )}
    </>
  );
}

// buildPreviewDocument / extractBodyContent / injectResponsiveOverride 已收敛到
// ../../utils/masterLayoutPreview.ts（与 MasterLayoutDialog 共用，Bug E 修复）。
