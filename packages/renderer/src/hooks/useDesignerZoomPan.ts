import { useRef, useEffect, useCallback, useState } from 'react';
import { ZOOM_MIN, ZOOM_MAX, ZOOM_STEP, type DeviceMode } from '../components/designer/canvas/types';

interface UseDesignerZoomPanOptions {
  deviceMode: DeviceMode;
  screensLength: number;
  isGenerating: boolean;
  /** True when generating against an existing screen (modification mode).
   *  In this mode we keep the user's canvas position stable — no auto-center. */
  isModification?: boolean;
  /** Currently selected screen id. On a pure selection change (same project,
   *  not during generation), the canvas pans to center the selected page. */
  currentScreenId?: string | null;
  /** Current project id — used to reset auto-center state on project switch. */
  projectId?: string | null;
}

/**
 * Manages canvas zoom & pan state, fit-to-window logic, auto-centering on
 * project open / device change / streaming, and Ctrl+scroll zoom.
 * Extracted from DesignerCanvas to keep file size manageable.
 *
 * 性能关键设计：pan 用 ref + 直接 DOM transform 写入，完全绕过 React 渲染。
 * 60-120Hz 的 mousemove 不触发任何 setState，canvas transform 直接写到 DOM。
 * 这避免了 pan 时整个 designer 树（含 46 个 iframe 卡片）重渲染。
 * zoom 仍是 state（低频，按钮/wheel 触发），变化时通过 applyTransform 同步 DOM。
 */
export function useDesignerZoomPan({
  deviceMode,
  screensLength,
  isGenerating,
  isModification = false,
  currentScreenId = null,
  projectId = null,
}: UseDesignerZoomPanOptions) {
  const [zoom, setZoom] = useState(0.7);
  // pan 用 ref 而非 state：拖拽时不触发 React 重渲染
  const panRef = useRef({ x: 0, y: 0 });
  // canvas transform 元素 ref：直接写 DOM style，绕过 React
  const canvasTransformRef = useRef<HTMLDivElement>(null);

  const isPanningRef = useRef(false);
  const panStartRef = useRef({ x: 0, y: 0 });
  const panOriginRef = useRef({ x: 0, y: 0 });
  const canvasWrapperRef = useRef<HTMLDivElement>(null);
  const hasAutoCenteredRef = useRef(false);
  const prevScreenIdRef = useRef<string | null>(null);
  const prevScreensLengthRef = useRef(0);
  const prevProjectIdRef = useRef<string | null | undefined>(undefined);
  // zoom state 镜像 ref，供非 React 路径（wheel）读取最新值
  const zoomRef = useRef(zoom);
  useEffect(() => { zoomRef.current = zoom; }, [zoom]);

  // 直接把 transform 写到 DOM，不经过 React。pan/zoom 任意一个变化都调此函数。
  // 写完后 dispatch 自定义事件，通知 ScreenOverlays 等需要跟随 transform 的
  // 组件重算位置（比 setPan 触发整棵树重渲染便宜得多）。
  const applyTransform = useCallback(() => {
    const el = canvasTransformRef.current;
    if (!el) return;
    const p = panRef.current;
    const z = zoomRef.current;
    el.style.transform = `translate(${p.x}px, ${p.y}px) scale(${z})`;
    el.style.setProperty('--canvas-zoom', String(z));
    window.dispatchEvent(new CustomEvent('designer-canvas-transform'));
  }, []);

  /* ── Fit to window: calculate zoom & pan to center content ────────── */
  const fitToWindow = useCallback(() => {
    const wrapper = canvasWrapperRef.current;
    if (!wrapper) {
      zoomRef.current = 0.7;
      setZoom(0.7);
      panRef.current = { x: 0, y: 0 };
      applyTransform();
      return;
    }

    const wrapperRect = wrapper.getBoundingClientRect();
    const wrapperW = wrapperRect.width;
    const wrapperH = wrapperRect.height;

    const stripEl = wrapper.querySelector('.designer-pages-strip') as HTMLElement | null;

    let contentW: number;
    let contentH: number;

    if (stripEl) {
      contentW = stripEl.scrollWidth;
      contentH = stripEl.scrollHeight;
    } else {
      if (deviceMode === 'mobile') {
        contentW = 430;
      } else if (deviceMode === 'tablet') {
        contentW = 768;
      } else {
        contentW = 1280;
      }
      contentH = 900;
    }

    const margin = 60;
    const scaleX = (wrapperW - margin) / contentW;
    const scaleY = (wrapperH - margin) / contentH;
    // 强制最小缩放 ZOOM_MIN (25%)：页面过多时 scaleX/scaleY 可能小于 25%，
    // 但工具栏缩放控件不允许低于 25%，fit-to-window 也应遵守同一限制。
    const newZoom = Math.max(ZOOM_MIN, Math.min(scaleX, scaleY, 1));

    const scaledW = contentW * newZoom;
    const scaledH = contentH * newZoom;
    const panX = Math.max(0, (wrapperW - scaledW) / 2);
    const panY = Math.max(0, (wrapperH - scaledH) / 2);

    zoomRef.current = newZoom;
    setZoom(newZoom);
    panRef.current = { x: panX, y: panY };
    applyTransform();
  }, [deviceMode, applyTransform]);

  /* ── Center the selected page card in the viewport ────────────────── */
  const centerOnScreen = useCallback(() => {
    const wrapper = canvasWrapperRef.current;
    if (!wrapper) return;
    const card = wrapper.querySelector('.designer-page-card.active') as HTMLElement | null;
    if (!card) return;

    const wrapperRect = wrapper.getBoundingClientRect();
    const cardRect = card.getBoundingClientRect();
    const dx = (wrapperRect.left + wrapperRect.width / 2) - (cardRect.left + cardRect.width / 2);
    const dy = (wrapperRect.top + wrapperRect.height / 2) - (cardRect.top + cardRect.height / 2);

    panRef.current = { x: panRef.current.x + dx, y: panRef.current.y + dy };
    applyTransform();
  }, [applyTransform]);

  /* ── Zoom handlers ─────────────────────────────────────────────────── */
  const zoomAtCenter = useCallback((nextZoom: number) => {
    const wrapper = canvasWrapperRef.current;
    if (!wrapper) {
      zoomRef.current = nextZoom;
      setZoom(nextZoom);
      applyTransform();
      return;
    }
    const r = wrapper.getBoundingClientRect();
    const cx = (r.width / 2 - panRef.current.x) / zoomRef.current;
    const cy = (r.height / 2 - panRef.current.y) / zoomRef.current;
    zoomRef.current = nextZoom;
    setZoom(nextZoom);
    panRef.current = { x: r.width / 2 - cx * nextZoom, y: r.height / 2 - cy * nextZoom };
    applyTransform();
  }, [applyTransform]);

  const handleZoomIn = useCallback(() => {
    zoomAtCenter(Math.min(zoomRef.current + ZOOM_STEP, ZOOM_MAX));
  }, [zoomAtCenter]);

  const handleZoomOut = useCallback(() => {
    zoomAtCenter(Math.max(zoomRef.current - ZOOM_STEP, ZOOM_MIN));
  }, [zoomAtCenter]);

  const handleZoomReset = useCallback(() => {
    fitToWindow();
  }, [fitToWindow]);

  const handleZoomFit = useCallback(() => {
    fitToWindow();
  }, [fitToWindow]);

  /* ── Sync DOM transform when zoom state changes from any source ──── */
  // zoom 是 React state，外部 setZoom 会触发重渲染；此 effect 确保 DOM transform
  // 与 zoom state 同步（pan 始终从 ref 读最新值）。
  useEffect(() => {
    applyTransform();
  }, [zoom, applyTransform]);

  /* ── Auto-center when project opens or device mode changes ─────────── */
  useEffect(() => {
    if (screensLength > 0 && !hasAutoCenteredRef.current) {
      hasAutoCenteredRef.current = true;
      requestAnimationFrame(() => {
        fitToWindow();
      });
      const timer = setTimeout(() => {
        fitToWindow();
      }, 150);
      return () => clearTimeout(timer);
    }
    if (screensLength === 0) {
      hasAutoCenteredRef.current = false;
    }
  }, [screensLength, fitToWindow]);

  /* ── Reset auto-center state when switching projects ──────────────── */
  useEffect(() => {
    if (prevProjectIdRef.current !== undefined && prevProjectIdRef.current !== projectId) {
      hasAutoCenteredRef.current = false;
    }
    prevProjectIdRef.current = projectId;
  }, [projectId]);

  /* ── Re-fit on explicit device mode change ─────────────────────────── */
  useEffect(() => {
    if (screensLength > 0) {
      requestAnimationFrame(() => {
        fitToWindow();
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceMode]);

  /* ── Auto-center during streaming generation ─────────────────────────── */
  useEffect(() => {
    if (isGenerating && !isModification) {
      const raf = requestAnimationFrame(() => {
        fitToWindow();
      });
      const timer = setTimeout(() => {
        fitToWindow();
      }, 300);
      return () => {
        cancelAnimationFrame(raf);
        clearTimeout(timer);
      };
    }
  }, [isGenerating, isModification, fitToWindow]);

  /* ── Re-center when device mode changes during streaming ─────────────── */
  useEffect(() => {
    if (isGenerating && !isModification) {
      requestAnimationFrame(() => {
        fitToWindow();
      });
    }
  }, [deviceMode, isGenerating, isModification, fitToWindow]);

  /* ── Center the selected page when a file is clicked in the list ────── */
  useEffect(() => {
    const screenChanged = currentScreenId !== prevScreenIdRef.current;
    const wasEmpty = prevScreensLengthRef.current === 0;
    prevScreenIdRef.current = currentScreenId;
    prevScreensLengthRef.current = screensLength;

    if (!screenChanged) return;
    if (currentScreenId == null) return;
    if (isGenerating || isModification) return;
    if (wasEmpty || screensLength === 0) return;

    const raf = requestAnimationFrame(() => centerOnScreen());
    return () => cancelAnimationFrame(raf);
  }, [currentScreenId, screensLength, isGenerating, isModification, centerOnScreen]);

  /* ── Ctrl+scroll zoom (anchored to cursor) ─────────────────────────── */
  /* panRef/zoomRef 读取最新值，applyTransform 直接写 DOM。 */
  useEffect(() => {
    const wrapper = canvasWrapperRef.current;
    if (!wrapper) return;

    const handleWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      const r = wrapper.getBoundingClientRect();
      const px = e.clientX - r.left;
      const py = e.clientY - r.top;
      const cx = (px - panRef.current.x) / zoomRef.current;
      const cy = (py - panRef.current.y) / zoomRef.current;
      const delta = e.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP;
      const next = Math.max(ZOOM_MIN, Math.min(zoomRef.current + delta, ZOOM_MAX));
      zoomRef.current = next;
      setZoom(next);
      panRef.current = { x: px - cx * next, y: py - cy * next };
      applyTransform();
    };

    wrapper.addEventListener('wheel', handleWheel, { passive: false });
    return () => wrapper.removeEventListener('wheel', handleWheel);
  }, [applyTransform]);

  /* ── Pan: mouse drag on blank area ─────────────────────────────────── */
  /* 性能关键路径：mousemove 直接写 DOM transform，不触发任何 React setState。
     这避免了 60-120Hz mousemove 导致整个 designer 树（含 46 个 iframe 卡片）
     重渲染。panRef 实时更新供其他逻辑读取。

     iframe 事件穿透（BUG 修复）：
     拖拽平移期间，鼠标若快速滑入 iframe（HTML 设计稿），iframe 会捕获鼠标事件，
     导致父窗口的 mousemove/mouseup 停止触发。若用户在 iframe 内松开鼠标，
     mouseup 永远不会到达父窗口 → isPanningRef 卡在 true → 画布持续跟随鼠标。
     修复：拖拽期间给所有 iframe 设置 pointer-events:none，使鼠标事件穿透回父文档；
     拖拽结束时恢复。与 useComponentDrag 的 disableAllIframePointerEvents 同理。 */
  const [isPanning, setIsPanning] = useState(false);

  const handleCanvasMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (target.closest('.designer-page-card') || target.closest('.designer-canvas-empty')) return;
    e.preventDefault();
    isPanningRef.current = true;
    panStartRef.current = { x: e.clientX, y: e.clientY };
    panOriginRef.current = { ...panRef.current };
    e.currentTarget.style.cursor = 'grabbing';
    // 拖拽期间禁用所有 iframe 的 pointer-events，防止 iframe 捕获鼠标事件
    document.querySelectorAll('iframe').forEach(ifr => {
      ifr.style.pointerEvents = 'none';
    });
    setIsPanning(true);
  }, []);

  useEffect(() => {
    if (!isPanning) return;
    document.body.style.userSelect = 'none';
    const handleMouseMove = (e: MouseEvent) => {
      if (!isPanningRef.current) return;
      const dx = e.clientX - panStartRef.current.x;
      const dy = e.clientY - panStartRef.current.y;
      // 直接更新 panRef + 写 DOM，不调 setPan → 零 React 渲染
      panRef.current = {
        x: panOriginRef.current.x + dx,
        y: panOriginRef.current.y + dy,
      };
      applyTransform();
    };
    const handleMouseUp = () => {
      isPanningRef.current = false;
      setIsPanning(false);
      const wrapper = canvasWrapperRef.current;
      if (wrapper) wrapper.style.cursor = '';
      // 拖拽结束：恢复所有 iframe 的 pointer-events
      document.querySelectorAll('iframe').forEach(ifr => {
        ifr.style.pointerEvents = '';
      });
    };
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.body.style.userSelect = '';
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      // cleanup 时也恢复 iframe pointer-events（防止组件卸载时状态残留）
      document.querySelectorAll('iframe').forEach(ifr => {
        ifr.style.pointerEvents = '';
      });
    };
  }, [isPanning, applyTransform]);

  /* ── Navigate Palette APIs ─────────────────────────────────────────── */

  // 实际大小 100%（以视口中心为锚点）
  const handleZoom100 = useCallback(() => zoomAtCenter(1), [zoomAtCenter]);

  // 程序化平移（鸟瞰图点击/拖拽）
  const panTo = useCallback((x: number, y: number) => {
    panRef.current = { x, y };
    applyTransform();
  }, [applyTransform]);

  const getPan = useCallback(() => ({ ...panRef.current }), []);
  const getZoom = useCallback(() => zoomRef.current, []);

  // 视口尺寸（canvasWrapper 的可见区域）
  const getViewport = useCallback(() => {
    const wrapper = canvasWrapperRef.current;
    if (!wrapper) return null;
    const r = wrapper.getBoundingClientRect();
    return { width: r.width, height: r.height };
  }, []);

  // 内容边界（.designer-pages-strip 逻辑尺寸）
  const getContentBounds = useCallback(() => {
    const strip = canvasWrapperRef.current?.querySelector('.designer-pages-strip') as HTMLElement | null;
    return strip ? { width: strip.scrollWidth, height: strip.scrollHeight } : null;
  }, []);

  // 页面卡片位置（相对 strip 的逻辑坐标，供鸟瞰图绘制）
  // 注意：必须使用 offsetWidth/offsetHeight（CSS 布局尺寸，不受 transform 缩放影响），
  // 而非 getBoundingClientRect()（返回缩放后的屏幕像素，zoom≠1 时坐标不一致）。
  const getPageCards = useCallback(() => {
    const wrapper = canvasWrapperRef.current;
    const strip = wrapper?.querySelector('.designer-pages-strip') as HTMLElement | null;
    if (!strip) return [];
    return Array.from(strip.querySelectorAll<HTMLElement>('.designer-page-card')).map(card => {
      // 累积 offset 链，将卡片坐标换算到 strip 坐标系
      let x = 0, y = 0;
      let el: HTMLElement | null = card;
      while (el && el !== strip) {
        x += el.offsetLeft;
        y += el.offsetTop;
        el = el.offsetParent as HTMLElement | null;
      }
      return {
        id: card.dataset.screenId || '',
        name: card.querySelector('.designer-page-label-text')?.textContent || '',
        x, y,
        width: card.offsetWidth,
        height: card.offsetHeight,
        active: card.classList.contains('active'),
      };
    });
  }, []);

  return {
    zoom,
    canvasTransformRef,
    canvasWrapperRef,
    handleZoomIn,
    handleZoomOut,
    handleZoomReset,
    handleZoomFit,
    handleCanvasMouseDown,
    // Navigate Palette APIs
    handleZoom100,
    panTo,
    getPan,
    getZoom,
    getViewport,
    getContentBounds,
    getPageCards,
  };
}
