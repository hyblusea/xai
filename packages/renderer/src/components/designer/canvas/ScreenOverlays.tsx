import {
  ArrowBigDownDash, ArrowBigUpDash, Copy, MessageSquarePlus,
  MoveDownRight, MoveUpLeft, Parentheses, Trash2, X,
} from 'lucide-react';
import { useRef, useLayoutEffect, useEffect, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import type { SelectedElement } from '@xai/shared';
import type { AlignmentGuide } from '../../../hooks/useAlignmentGuides';

interface Rect { x: number; y: number; width: number; height: number }

interface ScreenOverlaysProps {
  /** Whether the selection box should be shown (select mode + not generating). */
  showSelection: boolean;
  selectedElement: SelectedElement | null;
  /**
   * Canvas zoom — drives the CSS scale on `.designer-canvas-transform`.
   * zoom 变化时（低频）触发 React 重渲染 + recalcPos。
   * pan 已改为 ref + 直接 DOM 写入（绕过 React），pan 变化通过
   * 'designer-canvas-transform' 自定义事件通知本组件重算 toolbar 位置。
   */
  zoom: number;
  onAddElementToChat: () => void;
  onDeleteElement: (selector: string) => void;
  onSelectParent: () => void;
  onDuplicate: () => void;
  onSwapPrevious: () => void;
  onSwapNext: () => void;
  onZIndexUp: () => void;
  onZIndexDown: () => void;
  onDeselect: () => void;
  hoveredSelector: string | null;
  hoveredRect: Rect | null;
  alignmentGuides: AlignmentGuide[];
}

/**
 * Overlays rendered on top of the active screen's iframe container:
 *  - Selection box with resize handles & action toolbar (toolbar portaled for viewport-fixed positioning)
 *  - Layer-hover highlight box
 *  - Alignment guide lines
 */
export default function ScreenOverlays({
  showSelection,
  selectedElement,
  zoom,
  onAddElementToChat,
  onDeleteElement,
  onSelectParent,
  onDuplicate,
  onSwapPrevious,
  onSwapNext,
  onZIndexUp,
  onZIndexDown,
  onDeselect,
  hoveredSelector,
  hoveredRect,
  alignmentGuides,
}: ScreenOverlaysProps) {
  const toolbarRef = useRef<HTMLDivElement>(null);
  const [fixedPos, setFixedPos] = useState<{ left: number; top: number } | null>(null);

  // recalcPos 用 useCallback 稳定引用，供多个 effect 复用
  const recalcPos = useCallback(() => {
    if (!selectedElement) {
      setFixedPos(null);
      return;
    }

    const container = document.querySelector(
      '.designer-iframe-container.active-screen',
    ) as HTMLElement | null;
    if (!container) {
      setFixedPos(null);
      return;
    }

    const containerRect = container.getBoundingClientRect();
    const zoomVal =
      parseFloat(getComputedStyle(container).getPropertyValue('--canvas-zoom')) || 1;

    const elemLeft = containerRect.left + selectedElement.rect.x * zoomVal;
    const elemTop = containerRect.top + selectedElement.rect.y * zoomVal;
    const elemWidth = selectedElement.rect.width * zoomVal;
    const elemHeight = selectedElement.rect.height * zoomVal;

    const toolbar = toolbarRef.current;
    const tWidth = toolbar?.offsetWidth ?? 360;
    const tHeight = toolbar?.offsetHeight ?? 30;
    const gap = 8;

    let top = elemTop - tHeight - gap;
    if (top < 4) {
      top = elemTop + elemHeight + gap;
    }
    if (top + tHeight > window.innerHeight - 4) {
      top = 4;
    }

    const cLeft = containerRect.left;
    const cRight = containerRect.right;

    let left: number;

    if (tWidth <= cRight - cLeft) {
      left = elemLeft;
      if (left + tWidth > cRight - 4) {
        left = cRight - tWidth - 4;
      }
      left = Math.max(cLeft + 4, left);
    } else {
      left = cLeft + 4;
    }

    left = Math.max(4, Math.min(left, window.innerWidth - tWidth - 8));

    setFixedPos({ left, top });
  }, [selectedElement]);

  // zoom/selectedElement 变化时同步重算（React 渲染路径，低频）
  useLayoutEffect(() => {
    if (!selectedElement) {
      setFixedPos(null);
      return;
    }
    recalcPos();
  }, [selectedElement, zoom, recalcPos]);

  // scroll/resize 监听：仅 selectedElement 变化时重绑（pan 不影响监听器）
  useEffect(() => {
    if (!selectedElement) return;
    const wrapper = document.querySelector('.designer-canvas-wrapper');
    wrapper?.addEventListener('scroll', recalcPos, { passive: true });
    window.addEventListener('resize', recalcPos);
    return () => {
      wrapper?.removeEventListener('scroll', recalcPos);
      window.removeEventListener('resize', recalcPos);
    };
  }, [selectedElement, recalcPos]);

  // pan 变化时重算 toolbar 位置：pan 绕过 React（ref + 直接 DOM），
  // 通过 'designer-canvas-transform' 自定义事件通知。比 setPan 触发
  // 整棵树重渲染便宜得多——只有本组件的 recalcPos 跑（轻量 getBoundingClientRect）。
  useEffect(() => {
    if (!selectedElement) return;
    const handler = () => recalcPos();
    window.addEventListener('designer-canvas-transform', handler);
    return () => window.removeEventListener('designer-canvas-transform', handler);
  }, [selectedElement, recalcPos]);

  return (
    <>
      {/* Selection box outline for the active screen */}
      {showSelection && selectedElement && (
        <div
          className="designer-selection-overlay"
          style={{
            left: selectedElement.rect.x,
            top: selectedElement.rect.y,
            width: selectedElement.rect.width,
            height: selectedElement.rect.height,
          }}
        />
      )}

      {/* ── Floating toolbar: portaled into document.body for viewport-fixed positioning ── */}
      {showSelection &&
        selectedElement &&
        typeof document !== 'undefined' &&
        document.body &&
        createPortal(
          <div
            ref={toolbarRef}
            className="designer-selection-toolbar designer-selection-toolbar--fixed"
            style={{
              left: fixedPos?.left ?? -9999,
              top: fixedPos?.top ?? -9999,
              visibility: fixedPos ? 'visible' : 'hidden',
            }}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
          >
            <span className="designer-selection-tag">
              {selectedElement.tagName}
              {selectedElement.id && ` #${selectedElement.id}`}
            </span>
            <button
              className="designer-selection-btn"
              onClick={(e) => { e.stopPropagation(); onAddElementToChat(); }}
              title="添加到对话"
            >
              <MessageSquarePlus size={11} />
            </button>
            <button
              className="designer-selection-btn"
              onClick={(e) => { e.stopPropagation(); onSelectParent(); }}
              title="选择父容器"
            >
              <Parentheses size={11} />
            </button>
            <button
              className="designer-selection-btn"
              onClick={(e) => { e.stopPropagation(); onDuplicate(); }}
              title="复制元素"
            >
              <Copy size={11} />
            </button>
            <button
              className="designer-selection-btn"
              onClick={(e) => { e.stopPropagation(); onSwapPrevious(); }}
              title="与左侧或上方元素交换"
            >
              <MoveUpLeft size={11} />
            </button>
            <button
              className="designer-selection-btn"
              onClick={(e) => { e.stopPropagation(); onSwapNext(); }}
              title="与右侧或下方元素交换"
            >
              <MoveDownRight size={11} />
            </button>
            <button
              className="designer-selection-btn"
              onClick={(e) => { e.stopPropagation(); onZIndexUp(); }}
              title="Z 轴上移"
            >
              <ArrowBigUpDash size={11} />
            </button>
            <button
              className="designer-selection-btn"
              onClick={(e) => { e.stopPropagation(); onZIndexDown(); }}
              title="Z 轴下移"
            >
              <ArrowBigDownDash size={11} />
            </button>
            <button
              className="designer-selection-btn danger"
              onClick={(e) => {
                e.stopPropagation();
                onDeleteElement(selectedElement.selector);
              }}
              title="删除元素"
            >
              <Trash2 size={11} />
            </button>
            <button
              className="designer-selection-btn"
              onClick={(e) => { e.stopPropagation(); onDeselect(); }}
              title="取消选择"
            >
              <X size={11} />
            </button>
          </div>,
          document.body,
        )}

      {/* Layer hover overlay for the active screen */}
      {hoveredSelector && hoveredRect && (
        <div
          className="designer-hover-overlay"
          style={{
            left: hoveredRect.x,
            top: hoveredRect.y,
            width: hoveredRect.width,
            height: hoveredRect.height,
          }}
        >
          <span className="designer-hover-label">
            {hoveredSelector.startsWith('#') || hoveredSelector.startsWith('[')
              ? hoveredSelector.split(/[\s>]+/).pop()
              : hoveredSelector.split(' > ').pop()}
          </span>
        </div>
      )}

      {/* Alignment guides for the active screen */}
      {alignmentGuides.length > 0 && (
        <div className="designer-alignment-guides">
          {alignmentGuides.map(g => (
            <div
              key={g.id}
              className={`designer-guide-line designer-guide-${g.type}`}
              style={
                g.type === 'vertical'
                  ? { left: g.position }
                  : { top: g.position }
              }
            />
          ))}
        </div>
      )}
    </>
  );
}