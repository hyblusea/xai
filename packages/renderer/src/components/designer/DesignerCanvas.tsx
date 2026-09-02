import { useRef, useEffect, useCallback, useState, useMemo } from 'react';
import { toPng } from 'html-to-image';
import { Palette, Component as ComponentIcon, Layers as LayersIcon, SlidersHorizontal } from 'lucide-react';
import type { ProjectType } from '@xai/shared';
import { scoreMenuMatch, MENU_MATCH_SCORE } from '@xai/shared';
import ElementContextMenu from './ElementContextMenu';
import ElementPropertiesPanel from './ElementPropertiesPanel';
import DesignerDock from './DesignerDock';

import { injectScrollbarStyles } from '../../utils/designerScrollbar';
import { useAlignmentGuides } from '../../hooks/useAlignmentGuides';
import { useDesignerZoomPan } from '../../hooks/useDesignerZoomPan';
import { useDesignerStreaming } from '../../hooks/useDesignerStreaming';
import { useDesignerKeyboard } from '../../hooks/useDesignerKeyboard';
import { useDesignerElementOps } from '../../hooks/useDesignerElementOps';
import { buildFolderRows } from '../../utils/designerFolderRows';
import { buildSelectedElement } from '../../utils/designerElementUtils';
import { detectMasterLayoutType } from '../../utils/masterLayoutDom';

import DesignerToolbar from './canvas/DesignerToolbar';
import StreamingPages from './canvas/StreamingPages';
import SavedPages from './canvas/SavedPages';
import RunModeOverlay from './canvas/RunModeOverlay';
import DesignerCursor from './canvas/DesignerCursor';
import { useDesignerCursor } from '../../hooks/useDesignerCursor';
import type { CursorDomHandles } from '../../hooks/useDesignerCursor';
import type { DeviceMode, CanvasMode, DesignerCanvasProps } from './canvas/types';
import type { DesignerNavApi } from './canvas/navContext';
import { useLayerTree } from '../../hooks/useLayerTree';
import { useComponentDrag } from '../../hooks/useComponentDrag';
import { useSelectedDomState } from '../../hooks/useSelectedDomState';
import type { ComponentId } from '../../utils/designerComponents';
import LayerTreePanel from './LayerTreePanel';
import ComponentLibraryPanel from './ComponentLibraryPanel';
import PageStyleEditor from './PageStyleEditor';

/**
 * 判断元素是否为 Tab 标签/页内锚点类控件。
 * 此类元素点击后应执行页面自身的 Tab 切换逻辑，
 * 不能触发按文本匹配屏幕名的自动跳转（与发布预览 Preview.tsx 同一规则）。
 */
function isTabLikeElement(el: HTMLElement, doc: Document): boolean {
  if (el.getAttribute('role') === 'tab') return true;
  if (el.closest('[role="tablist"]')) return true;
  const toggle = (
    el.getAttribute('data-bs-toggle') ||
    el.getAttribute('data-toggle') ||
    ''
  ).toLowerCase();
  if (toggle === 'tab' || toggle === 'pill' || toggle === 'collapse' || toggle === 'dropdown') {
    return true;
  }
  // href="#pane" 且目标元素真实存在 → 页内锚点 / Tab 面板切换，不跳转。
  // 注意：href="#"（空锚点）是未绑定菜单项的占位链接，必须放行给
  // 文本匹配，否则点击菜单无反应。
  const href = el.getAttribute('href') || '';
  if (href.startsWith('#')) {
    const id = href.slice(1);
    if (!id) return false;
    return !!doc.getElementById(id);
  }
  // class 形如 tab / tabs / tab-item / tab_link（排除 table 等误伤）
  for (const cls of el.classList) {
    if (/^tab(s|[-_].*)?$/i.test(cls)) return true;
  }
  return false;
}

/**
 * 判断元素是否为分页控件（页码/上一页/下一页）。
 * scoreMenuMatch 已跳过纯数字页码，但带文字的分页按钮（上一页/下一页/跳转）
 * 仍需按容器特征识别，避免与同名屏幕误匹配。
 */
function isPaginationElement(el: HTMLElement): boolean {
  if (el.classList.contains('page-link') || el.classList.contains('page-item')) return true;
  if (el.closest('.pagination, .pager, [class*="pagination"]')) return true;
  if (el.hasAttribute('data-page') || el.hasAttribute('data-page-no')) return true;
  const aria = el.getAttribute('aria-label') || '';
  if (/上一页|下一页|pagination/i.test(aria)) return true;
  return false;
}

/**
 * Streaming multi-page HTML renderer for the Designer canvas.
 *
 * Features:
 *  - Multi-page strip view with zoom & pan
 *  - Run mode: full-screen interactive preview with page navigation
 *  - Element selection: click to select, resize handles, custom properties panel
 *
 * Note: The heavy logic lives in dedicated hooks under src/hooks and the
 * presentational pieces under src/components/designer/canvas.
 */
export default function DesignerCanvas({
  html,
  isGenerating,
  streamingText,
  screens,
  currentScreenId,
  projectType,
  projectId,
  folders,
  onSelectScreen,
  onExport,
  onRefresh,
  selectedElement,
  onSelectElement,
  onElementStyleChange,
  onAddElementToChat,
  onDeleteElement,
  onHtmlChange,
  onReloadScreen,
  failedScreenIds,
  onUndo,
  onRedo,
  canUndo,
  canRedo,
  dirtyScreenIds,
  onSave,
  onSaveAll,
  onCreateBlankScreen,
  hasCurrentProject,
  onToggleComponentLibrary,
  componentLibraryVisible,
  onTogglePageStyle,
  pageStyleVisible,
  onApplyTheme,
  onExportVue,
  onPublish,
  onOpenMasterLayout,
  hasMasterLayout,
  onPromoteToMasterLayout,
  masterLayouts,
  themePrompt,
  onNavReady,
}: DesignerCanvasProps) {
  const [deviceMode, setDeviceMode] = useState<DeviceMode>('desktop');
  const [copied, setCopied] = useState(false);
  const [pngCopied, setPngCopied] = useState(false);
  const [iframeKey, setIframeKey] = useState(0);
  const [mode, setMode] = useState<CanvasMode>('design');
  const [selectMode, setSelectMode] = useState(false);
  const [runOpen, setRunOpen] = useState(false);
  // Layer panel visibility (toggled in select mode)
  const [layerPanelVisible, setLayerPanelVisible] = useState(false);
  // Properties panel visibility in the right Dock — 默认隐藏，进入选择模式时也不自动展开
  const [propertiesPanelVisible, setPropertiesPanelVisible] = useState(false);

  // Layer hover state — shows a highlight overlay on the canvas when hovering layers
  const [hoveredSelector, setHoveredSelector] = useState<string | null>(null);
  const [hoveredRect, setHoveredRect] = useState<{ x: number; y: number; width: number; height: number } | null>(null);

  const handleLayerHover = useCallback((selector: string | null) => {
    setHoveredSelector(selector);
    if (!selector) {
      setHoveredRect(null);
      return;
    }
    const iframe = iframeRefs.current.get(currentScreenId || '');
    if (!iframe?.contentDocument) { setHoveredRect(null); return; }
    const el = iframe.contentDocument.querySelector(selector) as HTMLElement | null;
    if (!el) { setHoveredRect(null); return; }
    const r = el.getBoundingClientRect();
    setHoveredRect({ x: r.x, y: r.y, width: r.width, height: r.height });
  }, [currentScreenId]);

  // Map of screenId -> iframe element (for element selection)
  const iframeRefs = useRef<Map<string, HTMLIFrameElement>>(new Map());
  // Track which screen the selected element belongs to
  const selectedScreenIdRef = useRef<string | null>(null);
  const runIframeRef = useRef<HTMLIFrameElement | null>(null);

  // Tracks HTML applied via direct DOM manipulation (applyStyleChange, drag,
  // resize, layer ops, page style edit, etc.). SavedPages uses this to skip
  // the srcDoc reload when the iframe DOM already reflects the new HTML —
  // eliminating the full-page flash/flicker on every property edit.
  const directDomHtmlRef = useRef<Map<string, string>>(new Map());

  const handleRefresh = useCallback(() => {
    setIframeKey(k => k + 1);
    onRefresh();
  }, [onRefresh]);

  // Wrap onHtmlChange: when direct DOM manipulation mutates the iframe DOM
  // and then calls onHtmlChange to persist, we record the HTML in
  // directDomHtmlRef so SavedPages can skip the redundant srcDoc reload (the
  // iframe already shows the correct content). External changes (AI
  // generation, undo/redo, refresh) don't go through this wrapper and reload
  // normally.
  const reportDomHtmlChange = useCallback((html: string) => {
    // Use selectedScreenIdRef (which screen's iframe was actually mutated)
    // falling back to currentScreenId. This must match the screen that
    // updateHtml will patch so the skip logic in SavedPages aligns.
    const sid = selectedScreenIdRef.current || currentScreenId;
    if (sid) directDomHtmlRef.current.set(sid, html);
    onHtmlChange(html);
  }, [currentScreenId, onHtmlChange]);

  // Direct-DOM write for undo/redo: replaces the iframe's document content
  // in place (head + body innerHTML, no srcDoc reload → no flicker) and sets
  // directDomHtmlRef so SavedPages skips the redundant reload. Mirrors the
  // reportDomHtmlChange skip pattern but for full-document replacement
  // instead of targeted style mutations. Inline <script> tags are re-cloned
  // so they execute (innerHTML-inserted scripts are inert by spec).
  // On any failure we bail out without setting the flag, letting SavedPages
  // fall back to a normal srcDoc reload.
  const applyDirectDomHtml = useCallback((screenId: string, html: string) => {
    const iframe = iframeRefs.current.get(screenId);
    const doc = iframe?.contentDocument;
    if (!iframe || !doc) return;
    try {
      const newDoc = new DOMParser().parseFromString(html, 'text/html');
      doc.head.innerHTML = newDoc.head.innerHTML;
      doc.body.innerHTML = newDoc.body.innerHTML;
      // Sync body attributes (class, data-*, onload, ...).
      doc.body.getAttributeNames().forEach(a => {
        if (!newDoc.body.hasAttribute(a)) doc.body.removeAttribute(a);
      });
      newDoc.body.getAttributeNames().forEach(a => {
        doc.body.setAttribute(a, newDoc.body.getAttribute(a) || '');
      });
      // Re-execute inline scripts: <script> nodes inserted via innerHTML are
      // not executed by the HTML spec, so clone-replace them to run.
      doc.querySelectorAll('script').forEach(oldScript => {
        const newScript = doc.createElement('script');
        const src = oldScript.getAttribute('src');
        if (src) newScript.setAttribute('src', src);
        else newScript.textContent = oldScript.textContent;
        oldScript.parentNode?.replaceChild(newScript, oldScript);
      });
    } catch {
      return; // fall back to normal srcDoc reload
    }
    directDomHtmlRef.current.set(screenId, html);
  }, []);

  // Wrap undo/redo so the target HTML is applied directly to the iframe DOM
  // (flicker-free) before React re-renders. Both the toolbar buttons and the
  // keyboard shortcuts (Ctrl+Z / Ctrl+Shift+Z) go through these wrappers.
  const handleUndo = useCallback(() => {
    onUndo(applyDirectDomHtml);
  }, [onUndo, applyDirectDomHtml]);
  const handleRedo = useCallback(() => {
    onRedo(applyDirectDomHtml);
  }, [onRedo, applyDirectDomHtml]);

  // Sync device mode with project type
  // DIAGRAM projects always use desktop mode and default to wider viewport
  useEffect(() => {
    if (projectType === 'DIAGRAM') {
      setDeviceMode('desktop');
    } else {
      setDeviceMode(projectType === 'APP' || projectType === 'PDA' ? 'mobile' : 'desktop');
    }
  }, [projectType]);

  // Backfill mandatory scrollbar styles into already-saved screens at render
  // time. This covers historical screens generated before the scrollbar rule
  // existed, without mutating the stored HTML. Idempotent — no-op for screens
  // that already contain the injected <style> block.
  const effectiveProjectType: ProjectType = projectType ?? 'WEB';
  const screensWithScrollbar = useMemo(
    () => screens.map(s => ({ ...s, html: injectScrollbarStyles(s.html, effectiveProjectType) })),
    [screens, effectiveProjectType],
  );

  // Build folder-grouped rows for the pages strip
  const folderRows = useMemo(
    () => buildFolderRows(screensWithScrollbar, folders),
    [screensWithScrollbar, folders],
  );

  // Alignment guides
  const { guides: alignmentGuides, clearGuides: clearAlignmentGuides, calculateSnap } = useAlignmentGuides();

  /* ── Streaming, zoom/pan, keyboard, element ops ───────────────────── */
  // 先创建 streamingIframeRef,供 cursor 和 streaming 共用
  const streamingIframeRef = useRef<HTMLIFrameElement | null>(null);
  // 稳定的 ref 回调：身份不变时 React 不会在每次 render 重复 detach/attach。
  // StreamingPages 内部据此做确定性销毁（dispose），身份不稳定会干扰其判断；
  // 旧的内联箭头函数每帧 identity 变化，60fps 重渲染下 ref 被反复重注册。
  const setStreamingIframeEl = useCallback((el: HTMLIFrameElement | null) => {
    streamingIframeRef.current = el;
  }, []);

  // Modification mode: generating against an existing screen. In this mode we
  // keep the current canvas (SavedPages) visible instead of switching to the
  // streaming view, and preserve the user's pan/zoom position.
  const isModification = isGenerating && currentScreenId != null;

  const {
    zoom,
    canvasTransformRef,
    canvasWrapperRef,
    handleZoomIn,
    handleZoomOut,
    handleZoomReset,
    handleZoomFit,
    handleCanvasMouseDown,
    handleZoom100,
    panTo,
    getPan,
    getZoom,
    getViewport,
    getContentBounds,
    getPageCards,
  } = useDesignerZoomPan({ deviceMode, screensLength: screens.length, isGenerating, isModification, currentScreenId, projectId });

  // 虚拟光标:仅新建页面模式激活。stripRef 指向 .designer-pages-strip,
  // 用于把 iframe 内元素坐标换算为 strip 逻辑坐标。
  const stripRef = useRef<HTMLDivElement>(null);
  // cursorHasWorkRef: 当光标队列有待处理元素或正在绘制/移动时为 true，
  // 通知 useDesignerStreaming 跳过自动滚到底部，避免与光标的 scrollIntoView 冲突。
  const cursorHasWorkRef = useRef(false);
  // lastCursorTargetElRef: 光标最后处理(画框)的目标元素。由 useDesignerCursor 写入,
  // useDesignerStreaming 读取。resting 阶段(cursorHasWorkRef=false)自动滚动不再无脑
  // 拉到底部,而是保持该元素在视口内——否则左右两栏布局下,生成右栏上方元素时滚动条
  // 会在「右栏元素位置」(elementToTarget 滚上来)与「文档底部」(自动滚动拉回去)之间
  // 反复跳动,连带虚线光标画框错位跳动。
  const lastCursorTargetElRef = useRef<HTMLElement | null>(null);
  // 光标 DOM 句柄：DesignerCursor 挂载时填充，useDesignerCursor 的 rAF 动画
  // 帧直写（位置/画框坐标/进度），高频更新不再触发 React 渲染整棵画布树。
  const cursorDomRef = useRef<CursorDomHandles | null>(null);
  const { cursorState, active: cursorActive, handleNewElement } = useDesignerCursor({
    isGenerating,
    isModification,
    streamingIframeRef,
    stripRef,
    zoom,
    cursorDomRef,
    cursorHasWorkRef,
    lastCursorTargetElRef,
  });

  const { streamingPages } = useDesignerStreaming({ html, isGenerating, onNewElement: handleNewElement, streamingIframeRef, cursorHasWorkRef, lastCursorTargetElRef, masterLayouts, streamingScreenId: currentScreenId || '' });

  const {
    handleBringForward,
    handleSendBackward,
    handleDuplicateElement,
    applyStyleChange,
    selectParentElement,
    duplicateSelectedElement,
    swapWithSibling,
    adjustZIndex,
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
    toggleTableVerticalScroll,
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
    resetDragState,
  } = useDesignerElementOps({
    iframeRefs,
    selectedScreenIdRef,
    selectedElement,
    selectMode,
    isGenerating,
    currentScreenId,
    screens,
    onSelectElement,
    onSelectScreen,
    onHtmlChange: reportDomHtmlChange,
    onElementStyleChange,
    calculateSnap,
    clearAlignmentGuides,
  });

  useDesignerKeyboard({
    iframeRefs,
    selectedScreenIdRef,
    selectedElement,
    isGenerating,
    runOpen,
    canUndo,
    canRedo,
    onUndo: handleUndo,
    onRedo: handleRedo,
    onDeleteElement,
    onHtmlChange: reportDomHtmlChange,
    onSelectElement,
    onResetDragState: resetDragState,
    onSave,
  });

  /* ── Copy current screen HTML ─────────────────────────────────────── */
  const handleCopy = useCallback(async () => {
    const htmlToCopy = currentScreenId
      ? screens.find(s => s.id === currentScreenId)?.html
      : html;
    if (!htmlToCopy) return;
    try {
      await navigator.clipboard.writeText(htmlToCopy);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      console.error('Failed to copy');
    }
  }, [html, screens, currentScreenId]);

  /* ── Copy current screen as full-page PNG ───────────────────────────── */
  const handleCopyPng = useCallback(async () => {
    const sid = currentScreenId;
    if (!sid) return;
    const iframe = iframeRefs.current.get(sid);
    if (!iframe?.contentDocument) return;

    const doc = iframe.contentDocument;
    const htmlEl = doc.documentElement;
    const body = doc.body;
    if (!htmlEl || !body) return;

    try {
      // Temporarily expand the iframe to full content size so html-to-image
      // captures everything (including below-the-fold scrollable content).
      const scrollW = Math.max(body.scrollWidth, htmlEl.scrollWidth, body.offsetWidth);
      const scrollH = Math.max(body.scrollHeight, htmlEl.scrollHeight, body.offsetHeight);

      // Save original styles
      const origIframeW = iframe.style.width;
      const origIframeH = iframe.style.height;
      const origIframeStyle = iframe.getAttribute('style') || '';
      const origBodyOverflow = body.style.overflow;
      const origHtmlOverflow = htmlEl.style.overflow;
      const origBodyH = body.style.height;
      const origHtmlH = htmlEl.style.height;

      // Expand iframe to full content size and remove scrollbars
      iframe.style.width = scrollW + 'px';
      iframe.style.height = scrollH + 'px';
      body.style.overflow = 'visible';
      htmlEl.style.overflow = 'visible';
      body.style.height = 'auto';
      htmlEl.style.height = 'auto';

      // Small delay for layout reflow
      await new Promise(r => setTimeout(r, 50));

      const dataUrl = await toPng(body, {
        width: scrollW,
        height: scrollH,
        pixelRatio: 2,
        skipAutoScale: true,
        cacheBust: true,
        style: {
          overflow: 'visible',
          height: 'auto',
        },
      });

      // Restore original styles
      iframe.setAttribute('style', origIframeStyle);
      body.style.overflow = origBodyOverflow;
      htmlEl.style.overflow = origHtmlOverflow;
      body.style.height = origBodyH;
      htmlEl.style.height = origHtmlH;

      // Convert data URL to blob and copy to clipboard
      const res = await fetch(dataUrl);
      const blob = await res.blob();
      await navigator.clipboard.write([
        new ClipboardItem({ 'image/png': blob }),
      ]);

      setPngCopied(true);
      setTimeout(() => setPngCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy PNG:', err);
    }
  }, [currentScreenId, iframeRefs]);

  /* ── Page navigation ───────────────────────────────────────────────── */
  const currentScreenIndex = screens.findIndex(s => s.id === currentScreenId);
  const hasMultipleScreens = screens.length > 1;

  const goToPrevPage = useCallback(() => {
    if (currentScreenIndex > 0) {
      onSelectScreen?.(screens[currentScreenIndex - 1].id);
    }
  }, [currentScreenIndex, screens, onSelectScreen]);

  const goToNextPage = useCallback(() => {
    if (currentScreenIndex >= 0 && currentScreenIndex < screens.length - 1) {
      onSelectScreen?.(screens[currentScreenIndex + 1].id);
    }
  }, [currentScreenIndex, screens, onSelectScreen]);

  /* ── Run mode toggle ───────────────────────────────────────────────── */
  const handleRunToggle = useCallback(() => {
    if (!currentScreenId && screens.length === 0) return;
    setRunOpen(true);
  }, [currentScreenId, screens.length]);

  /* ── Select mode toggle ────────────────────────────────────────────── */
  const handleSelectToggle = useCallback(() => {
    setSelectMode(prev => {
      const next = !prev;
      if (next) {
        // 进入选择模式：自动展开属性面板（主编辑面），图层面板默认不自动打开
        setPropertiesPanelVisible(true);
      } else {
        // Clear selection and any stuck drag/resize state when exiting
        onSelectElement(null);
        resetDragState();
        setLayerPanelVisible(false);
        setPropertiesPanelVisible(false);
        setHoveredSelector(null);
        setHoveredRect(null);
      }
      return next;
    });
  }, [onSelectElement, resetDragState]);

  /* ── Run mode: detect link clicks and navigate between screens ─────── */
  const handleRunIframeLoad = useCallback(() => {
    const iframe = runIframeRef.current;
    if (!iframe?.contentDocument) return;
    const doc = iframe.contentDocument;

    // 确保设计师组件 CSS 已注入（老页面兜底）
    const DESIGNER_CSS_ID = '__xai_designer_components__';
    if (!doc.getElementById(DESIGNER_CSS_ID)) {
      const style = doc.createElement('style');
      style.id = DESIGNER_CSS_ID;
      style.textContent = `
.navbar[data-navbar-orientation="vertical"] { flex-direction: column !important; align-items: stretch !important; }
.navbar[data-navbar-orientation="vertical"] .container-fluid { flex-direction: column !important; align-items: stretch !important; gap: 0.5rem; }
.navbar[data-navbar-orientation="vertical"] .navbar-collapse { display: flex !important; flex-basis: 100%; }
.navbar[data-navbar-orientation="vertical"] .navbar-nav { flex-direction: column !important; gap: 0.25rem !important; margin: 0 !important; width: 100%; }
.navbar[data-navbar-orientation="vertical"] .navbar-nav .nav-link { width: 100%; padding: 0.5rem 0.75rem; }
.navbar[data-navbar-orientation="vertical"] .navbar-toggler { display: none !important; }
.navbar[data-navbar-orientation="vertical"] .navbar-brand { margin-bottom: 0.25rem; }
.xai-dropdown-menu { display: block; }
.dropdown[data-dropdown-open="false"] .xai-dropdown-menu { display: none !important; }
.dropdown[data-dropdown-open="true"] .xai-dropdown-chevron { transform: rotate(180deg); }
.xai-dropdown-chevron { transition: transform 0.2s ease; }
.xai-dropdown-menu > a:hover { background-color: var(--bs-gray-100, #f3f4f6) !important; }
/* 运行模式隐藏侧边导航栏 resizer（仅设计模式可拖拽调整宽度） */
.xai-navbar-resizer { display: none !important; pointer-events: none !important; }
`;
      // srcdoc 解析早期 doc.head 可能为 null，回退到 documentElement
      (doc.head || doc.documentElement)?.appendChild(style);
    }

    const clickHandler = (e: MouseEvent) => {
      const target = e.target as HTMLElement;

      // 下拉菜单展开/折叠（运行模式）：点击触发器切换 data-dropdown-open
      const dropdownToggle = target.closest('[data-dropdown-toggle="true"]') as HTMLElement | null;
      if (dropdownToggle) {
        e.preventDefault();
        const dropdown = dropdownToggle.closest('.dropdown') as HTMLElement | null;
        if (dropdown) {
          const current = dropdown.getAttribute('data-dropdown-open');
          const next = current === 'true' ? 'false' : 'true';
          dropdown.setAttribute('data-dropdown-open', next);
        }
        return; // 下拉菜单点击不触发页面导航
      }

      // Check for data-nav attributes (designer-configured navigation)
      // 优先级 1：显式 data-nav-type + data-nav-target（属性面板配置的跳转）
      const navEl = target.closest('[data-nav-type]') as HTMLElement | null;
      if (navEl) {
        const navType = navEl.getAttribute('data-nav-type');
        const navTarget = navEl.getAttribute('data-nav-target') || '';
        if (navType === 'page' && navTarget) {
          const targetScreen = screens.find(s => s.id === navTarget);
          if (targetScreen && targetScreen.id !== currentScreenId) {
            e.preventDefault();
            onSelectScreen?.(targetScreen.id);
            return;
          }
        } else if (navType === 'url' && navTarget) {
          e.preventDefault();
          window.open(navTarget, '_blank', 'noopener,noreferrer');
          return;
        }
      }

      // 优先级 2：仅 data-nav-target（MasterLayout 注入的菜单项，无 data-nav-type）
      // 强绑定：直接按 screenId 跳转，不走文本匹配（避免误匹配，D9）
      const navTargetOnlyEl = target.closest('[data-nav-target]') as HTMLElement | null;
      if (navTargetOnlyEl) {
        const navTarget = navTargetOnlyEl.getAttribute('data-nav-target') || '';
        if (navTarget) {
          const targetScreen = screens.find(s => s.id === navTarget);
          if (targetScreen && targetScreen.id !== currentScreenId) {
            e.preventDefault();
            onSelectScreen?.(targetScreen.id);
            return;
          }
        }
      }

      // Try to match link text/href to a screen name
      const link = target.closest('a, button') as HTMLElement | null;
      if (!link) return;

      // 关键：对所有 <a>/<button> 点击都阻止默认导航行为。
      // srcdoc iframe 在 allow-same-origin 下，<a href="#"> 的 # 会被解析为顶层
      // 窗口 URL 的 hash，点击会导航顶层 → React 应用重载 → 显示登录页。
      // 这里即使未命中屏幕切换也必须 preventDefault。
      e.preventDefault();

      // Tab 标签 / 页内锚点 / 分页控件：保留页面自身的交互逻辑，不做屏幕跳转
      if (isTabLikeElement(link, doc) || isPaginationElement(link)) return;

      // Try to match link text/href to a screen name
      const linkText = link.textContent?.trim() || '';
      // 空文本不再提前 return：纯图标按钮虽无文本，但 href 可能携带目标页名。
      // 空标签防护已内置在 findByLabel / scoreMenuMatch 中（空串返回 undefined，
      // 不会因 `title.includes("")` 恒为 true 而误命中 screens 列表第一个屏幕）。

      // Same-folder screens first, then fall back to all screens
      const currentFolder = screens.find(s => s.id === currentScreenId)?.folderPath ?? '';
      const sameFolderScreens = screens.filter(s => (s.folderPath ?? '') === currentFolder);
      // 修复 D9：先精确匹配，再模糊匹配（避免"用户管理"误匹配"管理"页）。
      // 顺序必须是：精确（同目录）→ 精确（全局）→ 模糊（同目录）→ 模糊（全局）。
      // 若同目录模糊优先，当前目录里名字为目标子串的页面（如"管理"）会拦截
      // 跨目录的精确目标（如另一目录的"用户管理"），导致点击菜单无法跳转。
      // 匹配谓词提取为 @xai/shared 的 scoreMenuMatch，与共享母版菜单高亮、
      // autoBindPendingMenuItems 三处共用同一规则（单一事实源）。
      const findByLabel = (label: string): typeof screens[number] | undefined => {
        if (!label.trim()) return undefined;
        const exact = (list: typeof screens) => list.find(s =>
          scoreMenuMatch(label, s.name ?? '') === MENU_MATCH_SCORE.EXACT);
        const fuzzy = (list: typeof screens) => list.find(s =>
          scoreMenuMatch(label, s.name ?? '') === MENU_MATCH_SCORE.FUZZY);
        return (
          exact(sameFolderScreens) ||
          exact(screens) ||
          fuzzy(sameFolderScreens) ||
          fuzzy(screens)
        );
      };

      // href 匹配：跨目录链接形如 `../计划管理/计划排产.html`，取末段文件名
      // （去扩展名）作为标签参与匹配——菜单文案与页面名不一致时仍能命中目标。
      // 仅处理本地相对 .html 链接，跳过 http(s)/mailto/javascript/锚点。
      const hrefAttr = link.getAttribute('href') || '';
      let hrefLabel = '';
      if (hrefAttr && !/^(https?:|mailto:|tel:|javascript:|#)/i.test(hrefAttr)) {
        const clean = hrefAttr.split(/[?#]/)[0];
        if (/\.html?$/i.test(clean)) {
          hrefLabel = decodeURIComponent(clean.split('/').pop() || '').replace(/\.html?$/i, '');
        }
      }

      const matchScreen = findByLabel(hrefLabel) || findByLabel(linkText);

      if (matchScreen && matchScreen.id !== currentScreenId) {
        onSelectScreen?.(matchScreen.id);
      }
    };

    doc.addEventListener('click', clickHandler, true);
  }, [screens, currentScreenId, onSelectScreen]);

  // 共享母版：选中 nav/header/footer/aside 时"提升为共享母版"——从当前 iframe DOM
  // 中取出元素的 outerHTML + 构造稳定 selector + 判定类型，传给 DesignerView 弹出
  // 提取对话框。仅当 selectedElement.tagName 可被 detectMasterLayoutType 识别且
  // 外部传入了回调时可用。
  const handlePromoteToMasterLayout = useCallback(() => {
    if (!onPromoteToMasterLayout || !selectedElement) return;
    const promoteType = detectMasterLayoutType(selectedElement.tagName);
    if (!promoteType) return;
    const sid = selectedScreenIdRef.current || currentScreenId;
    if (!sid) return;
    const iframe = iframeRefs.current.get(sid);
    const doc = iframe?.contentDocument;
    if (!doc) return;
    const el = doc.querySelector(selectedElement.selector) as HTMLElement | null;
    if (!el) return;
    // 稳定 selector：优先 data-design-id，回退 id，最后用 selectedElement.selector
    const designId = el.getAttribute('data-design-id');
    const selector = designId
      ? `[data-design-id="${designId}"]`
      : el.id
        ? `#${el.id}`
        : selectedElement.selector;
    // 传 sourceDoc 以便提取对话框抽取相关 CSS 规则（通用化，不依赖特定 class 名）
    onPromoteToMasterLayout(el.outerHTML, selector, promoteType, doc);
  }, [onPromoteToMasterLayout, selectedElement, currentScreenId]);

  /* ── Register saved-page iframes into the refs map ────────────────── */
  const registerIframe = useCallback((screenId: string, el: HTMLIFrameElement | null) => {
    if (el) iframeRefs.current.set(screenId, el);
    else iframeRefs.current.delete(screenId);
  }, [iframeRefs]);

  /* ── Layer tree for select mode ───────────────────────────────────── */
  // Provides a DOM-based layer panel (independent of GrapesJS) that lists
  // all elements in the current screen's iframe, supports visibility toggle,
  // lock, reorder, insert, duplicate, and syncs selection with the canvas.
  const getIframe = useCallback((): HTMLIFrameElement | null => {
    return iframeRefs.current.get(currentScreenId || '') || null;
  }, [currentScreenId]);

  // Adapter: layer panel passes a selector string; we need to build a full
  // SelectedElement (with rect, style, etc.) for the properties panel.
  const handleLayerSelect = useCallback((selector: string) => {
    const iframe = iframeRefs.current.get(currentScreenId || '');
    if (!iframe?.contentDocument) return;
    const doc = iframe.contentDocument;
    // Guard against a non-unique selector (e.g. duplicate data-design-id on
    // repeated stats cards): querySelector would return the FIRST match — a
    // different card — and the layer panel would select the wrong element.
    // Bail when ambiguous rather than risk targeting another element. With the
    // uniqueness-checked generateSelector this branch normally never triggers;
    // it exists for stale selectors after DOM mutations.
    const matches = doc.querySelectorAll(selector);
    if (matches.length !== 1) return;
    const el = matches[0] as HTMLElement;
    selectedScreenIdRef.current = currentScreenId;
    onSelectElement(buildSelectedElement(el, doc, currentScreenId || ''));
  }, [currentScreenId, onSelectElement]);

  const {
    layers, refresh: refreshLayers, toggleVisibility, toggleLock,
    handleLayerClick, moveElement, insertElement, duplicateElement,
    addTableRow, addTableColumn, lockedSetRef,
  } = useLayerTree({
    getIframe,
    onSelectElement: handleLayerSelect,
    selectedSelector: selectedElement?.selector || null,
    enabled: selectMode,
    onHtmlChange: reportDomHtmlChange,
  });

  const handleToggleLayerPanel = useCallback(() => {
    setLayerPanelVisible(prev => !prev);
  }, []);

  const handleTogglePropertiesPanel = useCallback(() => {
    setPropertiesPanelVisible(prev => !prev);
  }, []);

  /* ── Component library drag-insert (HTML5 drag-drop across iframe) ──── */
  // 点击组件卡片时插入：默认追加到当前选中元素之后；未选中则插入 body 末尾
  const handleComponentClickInsert = useCallback((componentType: ComponentId) => {
    // 模板类组件（tpl-*）替换整个页面 body 内容
    const isTemplate = componentType.startsWith('tpl-');
    if (isTemplate) {
      insertElement('body', componentType, 'inside');
    } else {
      const baseSelector = selectedElement?.selector || 'body';
      insertElement(baseSelector, componentType, 'after');
    }
  }, [insertElement, selectedElement]);

  const {
    isDragging: isCompDragging,
    dropTargetInfo: compDropTargetInfo,
    handleDragStart: handleCompDragStart,
    handleDragEnd: handleCompDragEnd,
  } = useComponentDrag({
    iframeRefs,
    currentScreenId,
    onInsert: insertElement,
    // 仅在有当前页面且非生成中时启用拖拽落点
    enabled: !!currentScreenId && !isGenerating,
    zoom,
  });

  const handleCloseComponentLibrary = useCallback(() => {
    onToggleComponentLibrary();
  }, [onToggleComponentLibrary]);

  /* ── 页面样式（<style> 标签）读写 ───────────────────────────────── */
  /** 从当前 iframe 中读取 <style> 标签的 CSS 内容 */
  const getPageStyleContent = useCallback((): string => {
    const iframe = iframeRefs.current.get(currentScreenId ?? '');
    if (!iframe?.contentDocument) return '';
    const styleTags = iframe.contentDocument.querySelectorAll('style');
    // 拼合所有 <style> 标签内容（排除注入的 Bootstrap CDN 等，只保留用户自定义）
    const parts: string[] = [];
    styleTags.forEach(tag => {
      const text = tag.textContent || '';
      // 跳过由 postProcessDesignerHtml 注入的 Bootstrap/主题/滚动条样式
      if (text.includes('bootstrap.min.css') || text.includes('/* injected-theme') || text.includes('/* scrollbar')) return;
      parts.push(text.trim());
    });
    return parts.join('\n\n');
  }, [currentScreenId, iframeRefs]);

  /** 将修改后的 CSS 写回 iframe 的 <style> 标签，并触发保存 */
  const applyPageStyle = useCallback((css: string) => {
    const iframe = iframeRefs.current.get(currentScreenId ?? '');
    if (!iframe?.contentDocument) return;
    const doc = iframe.contentDocument;

    // 查找或创建用户自定义 <style> 标签
    let userStyle = doc.getElementById('xai-user-style') as HTMLStyleElement | null;
    if (!userStyle) {
      userStyle = doc.createElement('style');
      userStyle.id = 'xai-user-style';
      userStyle.setAttribute('data-xai-user', 'true');
      (doc.head || doc.documentElement)?.appendChild(userStyle);
    }
    userStyle.textContent = css;

    // 序列化并触发保存
    const newHtml = '<!DOCTYPE html>\n' + doc.documentElement.outerHTML;
    reportDomHtmlChange(newHtml);
  }, [currentScreenId, iframeRefs, reportDomHtmlChange]);

  /* ── Computed values ───────────────────────────────────────────────── */
  const deviceClass = deviceMode === 'tablet' ? 'tablet' : deviceMode === 'mobile' ? 'mobile' : '';
  const zoomPercent = Math.round(zoom * 100);

  const hasContent = isGenerating ? true : screens.length > 0;

  /* ── Navigate Palette: build navApi & register ──────────────────────── */
  const navApi = useMemo<DesignerNavApi>(() => ({
    zoom,
    zoomPercent,
    zoomIn: handleZoomIn,
    zoomOut: handleZoomOut,
    fit: handleZoomReset,
    reset100: handleZoom100,
    panTo,
    getPan,
    getZoom,
    getContentBounds,
    getViewport,
    getPageCards,
  }), [zoom, zoomPercent, handleZoomIn, handleZoomOut, handleZoomReset,
      handleZoom100, panTo, getPan, getZoom, getContentBounds, getViewport, getPageCards]);

  useEffect(() => { onNavReady?.(navApi); }, [navApi, onNavReady]);

  const exportHtml = currentScreenId
    ? screens.find(s => s.id === currentScreenId)?.html
    : screens[0]?.html || html;

  // Whether the current screen has unsaved manual edits (drives Save button)
  const isCurrentDirty = !!currentScreenId && dirtyScreenIds.has(currentScreenId);
  const hasDirtyScreens = dirtyScreenIds.size > 0;

  // The active screen's iframe for element selection overlay
  const activeScreen = screensWithScrollbar.find(s => s.id === currentScreenId);
  const showSelectionOverlay = selectMode && !!selectedElement && !isGenerating;

  // BUG #8 fix: 缓存上一次成功解析的 DOM 状态。iframe 因 srcDoc 重载时
  // querySelector 可能瞬时返回 null，导致表格/Tabs/结构化编辑器一闪而过消失。
  // 用 ref 保留上次有效状态，在解析失败时回退，避免 UI 抖动。
  // 逻辑抽取到 useSelectedDomState hook，便于独立测试与复用。
  const selectedDomState = useSelectedDomState({
    selectedElement,
    iframeRefs,
    currentScreenId,
    iframeKey,
    selectMode,
    selectedScreenIdRef,
  });

  return (
    <div className={`designer-main ${mode === 'run' ? 'mode-run' : 'mode-design'}`}>
      <DesignerToolbar
        deviceMode={deviceMode}
        onDeviceModeChange={setDeviceMode}
        zoom={zoom}
        zoomPercent={zoomPercent}
        onZoomIn={handleZoomIn}
        onZoomOut={handleZoomOut}
        onZoomReset={handleZoomReset}
        onZoomFit={handleZoomFit}
        hasMultipleScreens={hasMultipleScreens}
        currentScreenIndex={currentScreenIndex}
        screensLength={screens.length}
        hasCurrentScreen={!!currentScreenId}
        onPrevPage={goToPrevPage}
        onNextPage={goToNextPage}
        isGenerating={isGenerating}
        selectMode={selectMode}
        onSelectToggle={handleSelectToggle}
        layerPanelVisible={layerPanelVisible}
        onToggleLayerPanel={handleToggleLayerPanel}
        onApplyTheme={onApplyTheme}
        onRunToggle={handleRunToggle}
        onRefresh={handleRefresh}
        exportHtml={exportHtml}
        copied={copied}
        onCopy={handleCopy}
        onCopyPng={handleCopyPng}
        pngCopied={pngCopied}
        onExport={onExport}
        onExportVue={onExportVue}
        onPublish={onPublish}
        canUndo={canUndo}
        canRedo={canRedo}
        onUndo={handleUndo}
        onRedo={handleRedo}
        onSave={onSave}
        isCurrentDirty={isCurrentDirty}
        onSaveAll={onSaveAll}
        hasDirtyScreens={hasDirtyScreens}
        hasCurrentProject={hasCurrentProject}
        onCreateBlankScreen={onCreateBlankScreen}
        onToggleComponentLibrary={onToggleComponentLibrary}
        componentLibraryVisible={componentLibraryVisible}
        onTogglePageStyle={onTogglePageStyle}
        pageStyleVisible={pageStyleVisible}
        onOpenMasterLayout={onOpenMasterLayout}
        hasMasterLayout={hasMasterLayout}
        isDiagramProject={effectiveProjectType === 'DIAGRAM'}
      />

      {/* 页面样式编辑器（浮层） */}
      {pageStyleVisible && currentScreenId && !isGenerating && (
        <PageStyleEditor
          initialCss={getPageStyleContent()}
          onApply={applyPageStyle}
          onClose={onTogglePageStyle}
        />
      )}

      {/* 画布 + 右侧 Dock 横向布局 */}
      <div className="designer-canvas-dock-row">
        {/* Canvas */}
        <div
          ref={canvasWrapperRef}
          className={`designer-canvas-wrapper ${selectMode ? 'select-mode' : ''}`}
          onMouseDown={handleCanvasMouseDown}
        >
          {!hasContent ? (
            <div className="designer-canvas-empty">
              <div className="designer-canvas-empty-icon">
                <Palette size={22} />
              </div>
              <div className="designer-canvas-empty-title">描述你想要的设计</div>
              <div className="designer-canvas-empty-desc">
                在下方输入框中用自然语言描述你想要的页面，<br />
                AI 将实时生成 HTML 设计稿，支持一次生成多个页面
              </div>
            </div>
          ) : (
            <div
              className="designer-canvas-transform"
              ref={canvasTransformRef}
              style={{
                transformOrigin: '0 0',
              } as React.CSSProperties}
            >
              <div className="designer-pages-strip" ref={stripRef}>
                <DesignerCursor
                  cursorState={cursorState}
                  active={cursorActive}
                  domRef={cursorDomRef}
                />
                {isGenerating && !isModification ? (
                  <StreamingPages
                    html={html}
                    streamingPages={streamingPages}
                    deviceClass={deviceClass}
                    streamingText={streamingText}
                    streamingIframeRef={setStreamingIframeEl}
                    projectType={effectiveProjectType}
                    themePrompt={themePrompt}
                    masterLayouts={masterLayouts}
                  />
                ) : (
                  <SavedPages
                    folderRows={folderRows}
                    currentScreenId={currentScreenId}
                    onSelectScreen={onSelectScreen}
                    deviceClass={deviceClass}
                    iframeKey={iframeKey}
                    generatingScreenId={isModification ? currentScreenId : null}
                    registerIframe={registerIframe}
                    directDomHtmlRef={directDomHtmlRef}
                    onReloadScreen={onReloadScreen}
                    failedScreenIds={failedScreenIds}
                    showSelectionOverlay={showSelectionOverlay}
                    selectedElement={selectedElement}
                    zoom={zoom}
                    onAddElementToChat={onAddElementToChat}
                    onDeleteElement={onDeleteElement}
                    onSelectParent={selectParentElement}
                    onDuplicate={duplicateSelectedElement}
                    onSwapPrevious={() => swapWithSibling('previous')}
                    onSwapNext={() => swapWithSibling('next')}
                    onZIndexUp={() => adjustZIndex(1)}
                    onZIndexDown={() => adjustZIndex(-1)}
                    onDeselect={() => onSelectElement(null)}
                    hoveredSelector={hoveredSelector}
                    hoveredRect={hoveredRect}
                    alignmentGuides={alignmentGuides}
                    streamingText={streamingText}
                    dirtyScreenIds={dirtyScreenIds}
                  />
                )}
              </div>
            </div>
          )}
        </div>

        {/* 右侧 Dock：组件库 / 图层 / 属性，支持横向并列显示 */}
        <DesignerDock
          panels={[
            {
              id: 'components',
              title: '组件库',
              icon: <ComponentIcon size={16} />,
              available: !!currentScreenId && !isGenerating,
              open: componentLibraryVisible,
              onToggle: onToggleComponentLibrary,
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
              id: 'layers',
              title: '图层',
              icon: <LayersIcon size={16} />,
              available: selectMode && !isGenerating && !!currentScreenId,
              open: layerPanelVisible,
              onToggle: handleToggleLayerPanel,
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
                  onLayerHover={handleLayerHover}
                  onClose={() => { setLayerPanelVisible(false); setHoveredSelector(null); setHoveredRect(null); }}
                  lockedSetRef={lockedSetRef}
                />
              ),
            },
            {
              id: 'properties',
              title: '属性',
              icon: <SlidersHorizontal size={16} />,
              available: selectMode && !isGenerating && !!currentScreenId,
              open: propertiesPanelVisible,
              onToggle: handleTogglePropertiesPanel,
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
                  onAddToChat={onAddElementToChat}
                  onClose={() => setPropertiesPanelVisible(false)}
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
                  onPromoteToMasterLayout={onPromoteToMasterLayout ? handlePromoteToMasterLayout : undefined}
                  isMenuItem={selectedDomState.isMenuItem}
                  menuItemIsActive={selectedDomState.menuItemIsActive}
                  onSetAsCurrentMenuItem={setAsCurrentMenuItem}
                />
              ),
            },
          ]}
        />
      </div>

      {/* Element Context Menu */}
      {selectMode && !isGenerating && (
        <ElementContextMenu
          selector={selectedElement?.selector ?? null}
          onDuplicate={handleDuplicateElement}
          onDelete={onDeleteElement}
          onAddToChat={onAddElementToChat}
          onBringForward={handleBringForward}
          onSendBackward={handleSendBackward}
        />
      )}

      {/* Run Mode Overlay */}
      {runOpen && (
        <RunModeOverlay
          screen={activeScreen || screens[0]}
          hasMultipleScreens={hasMultipleScreens}
          currentScreenIndex={currentScreenIndex}
          screensLength={screens.length}
          deviceClass={deviceClass}
          iframeKey={iframeKey}
          onPrevPage={goToPrevPage}
          onNextPage={goToNextPage}
          runIframeRef={el => { runIframeRef.current = el; }}
          onLoad={handleRunIframeLoad}
          onClose={() => setRunOpen(false)}
        />
      )}
    </div>
  );
}
