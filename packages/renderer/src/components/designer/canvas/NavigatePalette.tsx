import { useContext, useRef, useState, useCallback, useEffect } from 'react';
import { ZoomIn, ZoomOut, Maximize2, ChevronDown } from 'lucide-react';
import { DesignerNavContext, type PageCardInfo } from './navContext';
import { ZOOM_MIN, ZOOM_MAX } from './types';

interface NavigatePaletteProps {
  isGenerating: boolean;
  hasContent: boolean;
  /** 当前项目的页面数量，变化时触发鸟瞰图重绘 */
  screensCount: number;
  /** 当前项目 ID，切换项目时触发鸟瞰图重绘 */
  currentProjectId: string | null;
}

/** Percent icon: a simple "100%" text icon since lucide doesn't have one */
function PercentIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="19" y1="5" x2="5" y2="19" />
      <circle cx="6.5" cy="6.5" r="2.5" />
      <circle cx="17.5" cy="17.5" r="2.5" />
    </svg>
  );
}

/**
 * Navigate Palette — 缩放控制 + 鸟瞰图
 * 挂载在 DesignerProjectList 底部，通过 DesignerNavContext 获取画布 API。
 */
export default function NavigatePalette({ isGenerating, hasContent, screensCount, currentProjectId }: NavigatePaletteProps) {
  const nav = useContext(DesignerNavContext);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [collapsed, setCollapsed] = useState(false);
  const draggingRef = useRef(false);

  /* ── 计算鸟瞰图映射参数 ─────────────────────────────────────────────── */
  // 内容占满 minimap 控件，保持宽高比，居中放置
  const getMinimapMapping = useCallback(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper || !nav) return null;
    const contentBounds = nav.getContentBounds();
    if (!contentBounds) return null;

    const minimapWidth = wrapper.clientWidth;
    const minimapHeight = wrapper.clientHeight;

    // 双轴独立缩放，取较小值保持宽高比，让内容完整占满 minimap
    const scaleX = minimapWidth / contentBounds.width;
    const scaleY = minimapHeight / contentBounds.height;
    const scale = Math.min(scaleX, scaleY);

    // 内容在 minimap 中居中的偏移量
    const offsetX = (minimapWidth - contentBounds.width * scale) / 2;
    const offsetY = (minimapHeight - contentBounds.height * scale) / 2;

    return { minimapWidth, minimapHeight, scale, offsetX, offsetY };
  }, [nav]);

  /* ── 鸟瞰图绘制 ─────────────────────────────────────────────────────── */
  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    const mapping = getMinimapMapping();
    if (!canvas || !mapping || !nav) return;

    const viewport = nav.getViewport();
    if (!viewport) return;

    const { minimapWidth, minimapHeight, scale, offsetX, offsetY } = mapping;
    const dpr = window.devicePixelRatio || 1;

    // 设置 canvas 实际像素尺寸（高清屏适配）
    canvas.width = minimapWidth * dpr;
    canvas.height = minimapHeight * dpr;
    canvas.style.width = minimapWidth + 'px';
    canvas.style.height = minimapHeight + 'px';

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);

    // 清空
    ctx.clearRect(0, 0, minimapWidth, minimapHeight);

    // 背景
    ctx.fillStyle = '#f8f8fc';
    ctx.fillRect(0, 0, minimapWidth, minimapHeight);

    // 绘制页面卡片（逻辑坐标 * scale + offset → minimap 坐标）
    const pageCards: PageCardInfo[] = nav.getPageCards();
    for (const card of pageCards) {
      const rx = card.x * scale + offsetX;
      const ry = card.y * scale + offsetY;
      const rw = card.width * scale;
      const rh = card.height * scale;

      // 圆角矩形
      const radius = Math.max(1, Math.min(3, rw * 0.05, rh * 0.05));
      ctx.beginPath();
      ctx.moveTo(rx + radius, ry);
      ctx.lineTo(rx + rw - radius, ry);
      ctx.quadraticCurveTo(rx + rw, ry, rx + rw, ry + radius);
      ctx.lineTo(rx + rw, ry + rh - radius);
      ctx.quadraticCurveTo(rx + rw, ry + rh, rx + rw - radius, ry + rh);
      ctx.lineTo(rx + radius, ry + rh);
      ctx.quadraticCurveTo(rx, ry + rh, rx, ry + rh - radius);
      ctx.lineTo(rx, ry + radius);
      ctx.quadraticCurveTo(rx, ry, rx + radius, ry);
      ctx.closePath();

      if (card.active) {
        ctx.fillStyle = 'rgba(184, 148, 74, 0.12)';
        ctx.fill();
        ctx.strokeStyle = '#b8944a';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      } else {
        ctx.fillStyle = 'rgba(200, 200, 215, 0.35)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(180, 180, 195, 0.5)';
        ctx.lineWidth = 0.5;
        ctx.stroke();
      }

      // 页面名（卡片足够大时显示）
      if (rw > 30 && rh > 14) {
        ctx.fillStyle = card.active ? '#b8944a' : '#8888a0';
        ctx.font = '8px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        const label = card.name.length > 8 ? card.name.slice(0, 7) + '…' : card.name;
        ctx.fillText(label, rx + 3, ry + 2);
      }
    }

    // 视口矩形（内容坐标系 → minimap 坐标）
    const pan = nav.getPan();
    const zoom = nav.getZoom();
    const vx = -pan.x / zoom;
    const vy = -pan.y / zoom;
    const vw = viewport.width / zoom;
    const vh = viewport.height / zoom;

    const mvx = vx * scale + offsetX;
    const mvy = vy * scale + offsetY;
    const mvw = vw * scale;
    const mvh = vh * scale;

    ctx.fillStyle = 'rgba(184, 148, 74, 0.08)';
    ctx.fillRect(mvx, mvy, mvw, mvh);
    ctx.strokeStyle = 'rgba(184, 148, 74, 0.5)';
    ctx.lineWidth = 1;
    ctx.strokeRect(mvx, mvy, mvw, mvh);
  }, [nav, getMinimapMapping]);

  // zoom 变化（React 渲染）+ pan 变化（监听 designer-canvas-transform 事件）
  useEffect(() => {
    redraw();
    const handler = () => redraw();
    window.addEventListener('designer-canvas-transform', handler);
    return () => window.removeEventListener('designer-canvas-transform', handler);
  }, [redraw]);

  // ResizeObserver 监听 wrapper 尺寸变化
  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    const ro = new ResizeObserver(() => redraw());
    ro.observe(wrapper);
    return () => ro.disconnect();
  }, [redraw]);

  // 页面数量或项目变化时重绘鸟瞰图（删除/新增设计稿、切换项目等）
  // 这些操作改变了画布上的页面卡片，但可能不触发 zoom/pan 变化，
  // 导致鸟瞰图不会自动重绘。监听 screensCount 和 currentProjectId 弥补这一盲区。
  useEffect(() => {
    // 延迟一帧，等 DOM 更新完毕后再读取最新的页面卡片位置
    const raf = requestAnimationFrame(() => redraw());
    return () => cancelAnimationFrame(raf);
  }, [screensCount, currentProjectId, redraw]);

  /* ── 鸟瞰图交互：点击/拖拽 → panTo ─────────────────────────────────── */
  const contentToPointer = useCallback((e: React.PointerEvent | PointerEvent) => {
    const canvas = canvasRef.current;
    const mapping = getMinimapMapping();
    if (!canvas || !mapping) return null;

    const { scale, offsetX, offsetY } = mapping;
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    // minimap 像素 → 内容逻辑坐标（减去居中偏移后除以 scale）
    const cx = (px - offsetX) / scale;
    const cy = (py - offsetY) / scale;
    return { cx, cy };
  }, [getMinimapMapping]);

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    if (!nav) return;
    const coords = contentToPointer(e);
    if (!coords) return;
    e.preventDefault();
    draggingRef.current = true;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);

    const viewport = nav.getViewport();
    if (!viewport) return;
    const zoom = nav.getZoom();
    // 以点击点为中心平移
    const panX = viewport.width / 2 - coords.cx * zoom;
    const panY = viewport.height / 2 - coords.cy * zoom;
    nav.panTo(panX, panY);
  }, [nav, contentToPointer]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!draggingRef.current || !nav) return;
    const coords = contentToPointer(e);
    if (!coords) return;

    const viewport = nav.getViewport();
    if (!viewport) return;
    const zoom = nav.getZoom();
    const panX = viewport.width / 2 - coords.cx * zoom;
    const panY = viewport.height / 2 - coords.cy * zoom;
    nav.panTo(panX, panY);
  }, [nav, contentToPointer]);

  const handlePointerUp = useCallback(() => {
    draggingRef.current = false;
  }, []);

  /* ── 渲染 ───────────────────────────────────────────────────────────── */
  return (
    <div className="designer-navigate-palette">
      <div className="navigate-header" onClick={() => setCollapsed(c => !c)}>
        <span>导航</span>
        <ChevronDown size={12} className={collapsed ? 'collapsed' : ''} />
      </div>
      {!collapsed && (
        <>
          <div className="navigate-zoom-row">
            <button
              onClick={() => nav?.zoomOut()}
              disabled={!nav || nav.zoom <= ZOOM_MIN}
              title="缩小"
            >
              <ZoomOut size={13} />
            </button>
            <span className="navigate-zoom-value" onClick={() => nav?.fit()} title="点击适应屏幕">
              {nav?.zoomPercent ?? 100}%
            </span>
            <button
              onClick={() => nav?.zoomIn()}
              disabled={!nav || nav.zoom >= ZOOM_MAX}
              title="放大"
            >
              <ZoomIn size={13} />
            </button>
            <span className="navigate-sep" />
            <button onClick={() => nav?.fit()} title="适应屏幕">
              <Maximize2 size={13} />
            </button>
            <button onClick={() => nav?.reset100()} title="实际大小 100%">
              <PercentIcon size={13} />
            </button>
          </div>
          {hasContent && !isGenerating && (
            <div className="navigate-birdseye-wrap" ref={wrapperRef}>
              <canvas
                ref={canvasRef}
                className="navigate-birdseye"
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
              />
            </div>
          )}
        </>
      )}
    </div>
  );
}
