/**
 * useComponentDrag — 组件库拖拽插入到画布
 *
 * 使用自定义 mouse 事件实现拖拽（不依赖 HTML5 Drag and Drop API），
 * 提供完全可控的拖拽预览和落点指示。
 *
 * 工作原理：
 *  1. 组件库卡片 mousedown → 记录起始位置和组件信息，注册全局 mousemove/mouseup
 *  2. mousemove 超过 5px 阈值 → 进入拖拽模式：创建浮动预览 + 开始跟踪落点
 *  3. mousemove（拖拽中）→ 移动预览 + 检测鼠标是否在 iframe 上 → 更新蓝色指示器
 *  4. mouseup → 若在 iframe 上释放则执行插入，否则取消
 *
 * 落点判定（方案 A：鼠标位置自动判定）：
 *  - 检测目标元素父级的 flex-direction
 *  - row：左 1/3 = before，右 1/3 = after，中 1/3 = inside
 *  - column / 非 flex：上 1/3 = before，下 1/3 = after，中 1/3 = inside
 *  - Alt 强制 inside，Shift 切换 before/after
 *
 * 高亮指示器样式（统一为虚线）：
 *  - before/after：2px 蓝色虚线线条（横线 border-top / 竖线 border-left）
 *  - inside：2px 蓝色虚线框包围目标元素
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ComponentId, InsertPosition, ComponentDef } from '../utils/designerComponents';
import { generateSelector } from '../utils/designerElementUtils';

interface UseComponentDragOptions {
  /** 与 DesignerCanvas 共享的 iframe 引用映射 */
  iframeRefs: React.MutableRefObject<Map<string, HTMLIFrameElement>>;
  /** 当前 screenId — 决定给哪个 iframe 绑定事件 */
  currentScreenId: string | null;
  /** 执行实际插入：调用方通常包装 useLayerTree.insertElement */
  onInsert: (selector: string, componentType: ComponentId, position: InsertPosition) => void;
  /** 拖拽是否启用（如 selectMode 或生成中应禁用） */
  enabled: boolean;
  /** 当前画布缩放级别 — 用于将视口坐标转换为 iframe 内坐标 */
  zoom: number;
}

export interface DropTarget {
  selector: string;
  position: InsertPosition;
}

/**
 * 落点父容器描述 — 供组件库面板 footer 实时显示"插入到: xxx"。
 * parentLabel 例如 "div.container"、"body"、"section[data-design-id=...]"。
 */
export interface DropTargetInfo {
  /** 父容器可读描述（tag + 首个语义 class / id / data-design-id） */
  parentLabel: string;
  /** 插入位置 */
  position: InsertPosition;
}

/**
 * 将 DOM 元素描述为可读字符串：tag + 首个语义标识。
 * 优先级：#id > [data-design-id=...] > .首个非 utility class > 仅 tag。
 * 不使用 el.className —— SVGElement.className 是 SVGAnimatedString，无 .split()。
 */
function describeElement(el: Element): string {
  const tag = el.tagName.toLowerCase();
  if (el.id) return `${tag}#${el.id}`;
  const designId = el.getAttribute('data-design-id');
  if (designId) return `${tag}[${designId}]`;
  const cls = el.getAttribute('class');
  if (cls) {
    // 取首个非 Bootstrap utility / 状态类的语义 class
    const SEMANTIC_HINT = /^(container|row|col|card|nav|navbar|section|header|footer|main|aside|table|form|alert|badge|dropdown|modal|tab|accordion|carousel|progress|list-group|input-group|d-|flex|grid)/;
    const semantic = cls.split(/\s+/).find(c => c && !c.startsWith('designer-') && SEMANTIC_HINT.test(c));
    if (semantic) return `${tag}.${semantic}`;
    const first = cls.split(/\s+/).find(c => c && !c.startsWith('designer-'));
    if (first) return `${tag}.${first}`;
  }
  return tag;
}

/**
 * 根据落点元素和插入位置，计算"实际父容器"并返回可读描述。
 * - inside：父容器就是 el 本身
 * - before/after：父容器是 el.parentElement
 */
function describeDropParent(el: Element, position: InsertPosition): string {
  if (position === 'inside') return describeElement(el);
  const parent = el.parentElement;
  if (!parent) return describeElement(el);
  if (parent.tagName === 'HTML' || parent.tagName === 'BODY') return 'body';
  return describeElement(parent);
}

const INDICATOR_ID = '__designer_drop_indicator__';
const DRAG_PREVIEW_ID = '__designer_drag_preview__';
const DRAG_THRESHOLD = 5; // px — 超过此距离才进入拖拽模式

/* ── 辅助函数（模块级，不依赖 hook 状态）───────────────────────────── */

/**
 * 计算落点位置：根据鼠标相对目标元素的位置 + 父级 flex-direction
 */
function computePosition(
  el: HTMLElement,
  iframeX: number,
  iframeY: number,
  altKey: boolean,
  shiftKey: boolean,
): InsertPosition {
  if (altKey) return 'inside';

  const parent = el.parentElement;
  const isFlexRow = parent &&
    getComputedStyle(parent).display === 'flex' &&
    getComputedStyle(parent).flexDirection === 'row';

  const rect = el.getBoundingClientRect();
  let ratio: number;
  if (isFlexRow) {
    ratio = (iframeX - rect.left) / rect.width;
  } else {
    ratio = (iframeY - rect.top) / rect.height;
  }

  // Shift 强制切换 before/after（根据鼠标在下半/右半）
  if (shiftKey) {
    return ratio < 0.5 ? 'before' : 'after';
  }

  if (ratio < 0.33) return 'before';
  if (ratio > 0.67) return 'after';
  return 'inside';
}

/**
 * 在 iframe 内更新/创建落点指示器
 *
 * 关键：每次都用 cssText 重置整体样式，而不是仅在创建时设置。
 * 否则在 inside 与 before/after 之间切换时会复用旧元素，残留旧的
 * border/background，导致一会儿虚线、一会儿实线的不一致表现。
 *
 * 样式统一为虚线：
 *  - inside：2px 虚线框包围目标元素
 *  - before/after：2px 虚线线条（横线用 border-top，竖线用 border-left）
 */
function updateIndicator(iframe: HTMLIFrameElement, el: HTMLElement, position: InsertPosition) {
  const doc = iframe.contentDocument;
  if (!doc) return;

  let indicator = doc.getElementById(INDICATOR_ID) as HTMLDivElement | null;
  const rect = el.getBoundingClientRect();
  // iframe 内 position:fixed 相对 iframe viewport
  const isFlexRow = el.parentElement &&
    getComputedStyle(el.parentElement).display === 'flex' &&
    getComputedStyle(el.parentElement).flexDirection === 'row';

  // 公共基础样式。box-sizing:content-box 确保边框不被 iframe 内可能的全局
  // * { box-sizing:border-box } 压缩，保证虚线线条始终可见。
  const BASE = 'position:fixed;pointer-events:none;z-index:99999;box-sizing:content-box;transition:all 0.08s ease;';

  if (!indicator) {
    indicator = doc.createElement('div');
    indicator.id = INDICATOR_ID;
    doc.body.appendChild(indicator);
  }

  if (position === 'inside') {
    // 虚线框包围目标元素
    indicator.style.cssText = `${BASE}border:2px dashed #2563eb;background:rgba(37,99,235,0.08);border-radius:4px;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;`;
  } else if (isFlexRow) {
    // 竖虚线：before = 元素左方；after = 右方
    const left = position === 'before' ? rect.left - 1 : rect.right - 2;
    indicator.style.cssText = `${BASE}border-left:2px dashed #2563eb;background:transparent;left:${left}px;top:${rect.top}px;width:0;height:${rect.height}px;`;
  } else {
    // 横虚线：before = 元素上方；after = 下方
    const top = position === 'before' ? rect.top - 1 : rect.bottom - 2;
    indicator.style.cssText = `${BASE}border-top:2px dashed #2563eb;background:transparent;left:${rect.left}px;top:${top}px;width:${rect.width}px;height:0;`;
  }
}

function removeIndicator(iframe: HTMLIFrameElement | null | undefined) {
  if (!iframe?.contentDocument) return;
  const indicator = iframe.contentDocument.getElementById(INDICATOR_ID);
  if (indicator) indicator.remove();
}

/** 创建拖拽浮动预览 */
function createDragPreview(comp: ComponentDef, x: number, y: number) {
  removeDragPreview();
  const preview = document.createElement('div');
  preview.id = DRAG_PREVIEW_ID;
  preview.className = 'designer-drag-preview';
  preview.innerHTML = `
    <div class="designer-drag-preview-thumb">
      <svg width="48" height="32" viewBox="0 0 24 16" xmlns="http://www.w3.org/2000/svg">
        <g>${comp.thumbnail}</g>
      </svg>
    </div>
    <span class="designer-drag-preview-name">${comp.name}</span>
  `;
  preview.style.left = `${x + 8}px`;
  preview.style.top = `${y + 8}px`;
  document.body.appendChild(preview);
  return preview;
}

function removeDragPreview() {
  const el = document.getElementById(DRAG_PREVIEW_ID);
  if (el) el.remove();
}

/**
 * 禁用文档内所有 iframe 的 pointer-events。
 *
 * 拖拽期间必须对【所有】iframe（而非仅当前设计器 iframe）设置 pointer-events:none，
 * 否则鼠标经过其他 iframe 时，事件会被该 iframe 吞掉，父 document 的 mousemove
 * 不再触发，导致拖拽预览停滞不前、落点检测中断。
 */
function disableAllIframePointerEvents() {
  document.querySelectorAll('iframe').forEach(ifr => {
    ifr.style.pointerEvents = 'none';
  });
}

/** 恢复文档内所有 iframe 的 pointer-events（拖拽结束时调用） */
function restoreAllIframePointerEvents() {
  document.querySelectorAll('iframe').forEach(ifr => {
    ifr.style.pointerEvents = '';
  });
}

/* ── Hook ────────────────────────────────────────────────────────────── */

export function useComponentDrag({
  iframeRefs,
  currentScreenId,
  onInsert,
  enabled,
  zoom,
}: UseComponentDragOptions) {
  const [isDragging, setIsDragging] = useState(false);
  /** 落点父容器描述 — 仅在选择器变化时更新，避免 mousemove 频繁 setState */
  const [dropTargetInfo, setDropTargetInfo] = useState<DropTargetInfo | null>(null);
  const dragComponentRef = useRef<ComponentId | null>(null);
  const onInsertRef = useRef(onInsert);
  const dropTargetRef = useRef<DropTarget | null>(null);
  /** 上次 setState 用的 selector，用于去重 —— 避免 mousemove 每次都触发 re-render */
  const lastInfoSelectorRef = useRef<string>('');
  const previewElRef = useRef<HTMLElement | null>(null);
  // 缓存 ref 供 document-level 事件回调使用
  const currentScreenIdRef = useRef(currentScreenId);
  const zoomRef = useRef(zoom);
  const cleanupDragRef = useRef<(() => void) | null>(null);

  useEffect(() => { onInsertRef.current = onInsert; }, [onInsert]);
  useEffect(() => { currentScreenIdRef.current = currentScreenId; }, [currentScreenId]);
  useEffect(() => { zoomRef.current = zoom; }, [zoom]);

  /**
   * 组件库卡片 mousedown 调用 — 开始跟踪拖拽。
   *
   * 实际拖拽模式在鼠标移动超过 DRAG_THRESHOLD 后才激活，
   * 因此快速点击不会触发拖拽，onClick 事件照常工作。
   */
  const handleDragStart = useCallback((e: React.MouseEvent, comp: ComponentDef) => {
    if (!enabled || e.button !== 0 || dragComponentRef.current) return;

    const startPos = { x: e.clientX, y: e.clientY };
    let didDrag = false;
    let preview: HTMLElement | null = null;

    dragComponentRef.current = comp.id;

    const handleMouseMove = (moveEv: MouseEvent) => {
      // 未超过阈值 → 不激活拖拽模式
      if (!didDrag) {
        const dx = moveEv.clientX - startPos.x;
        const dy = moveEv.clientY - startPos.y;
        if (Math.abs(dx) + Math.abs(dy) < DRAG_THRESHOLD) return;

        // 超过阈值，正式进入拖拽模式
        didDrag = true;
        setIsDragging(true);
        preview = createDragPreview(comp, moveEv.clientX, moveEv.clientY);
        previewElRef.current = preview;
        document.body.style.cursor = 'grabbing';

        // 关键：给【所有】iframe 设 pointer-events:none，使鼠标事件穿透任何 iframe。
        // 若仅禁用当前设计器 iframe，鼠标经过其他 iframe 时事件会被吞掉，
        // 导致 mousemove 停止触发、预览不再跟随鼠标。
        disableAllIframePointerEvents();
      }

      // 移动浮动预览
      if (preview) {
        preview.style.left = `${moveEv.clientX + 8}px`;
        preview.style.top = `${moveEv.clientY + 8}px`;
      }

      // 更新落点指示器
      const screenId = currentScreenIdRef.current;
      if (!screenId) return;
      const iframe = iframeRefs.current.get(screenId);
      if (!iframe || !iframe.contentDocument) return;

      const rect = iframe.getBoundingClientRect();
      const { clientX, clientY } = moveEv;

      // 鼠标不在 iframe 区域 → 清除指示器，光标变为禁止状态
      if (clientX < rect.left || clientX > rect.right ||
          clientY < rect.top || clientY > rect.bottom) {
        removeIndicator(iframe);
        dropTargetRef.current = null;
        document.body.style.cursor = 'not-allowed';
        if (preview) preview.style.cursor = 'not-allowed';
        return;
      }

      // 鼠标回到 iframe 区域 → 恢复 grabbing 光标
      document.body.style.cursor = 'grabbing';
      if (preview) preview.style.cursor = 'grabbing';

      // 将视口坐标转换为 iframe 内坐标（考虑画布缩放）
      const currentZoom = zoomRef.current || 1;
      const iframeX = (clientX - rect.left) / currentZoom;
      const iframeY = (clientY - rect.top) / currentZoom;

      const doc = iframe.contentDocument;
      const el = doc.elementFromPoint(iframeX, iframeY) as HTMLElement | null;

      if (!el || el === doc.body || el === doc.documentElement) {
        dropTargetRef.current = { selector: 'body', position: 'inside' };
        if (lastInfoSelectorRef.current !== 'body') {
          lastInfoSelectorRef.current = 'body';
          setDropTargetInfo({ parentLabel: 'body', position: 'inside' });
        }
        removeIndicator(iframe);
        return;
      }
      // 跳过指示器自身
      if (el.id === INDICATOR_ID) return;

      const position = computePosition(el, iframeX, iframeY, moveEv.altKey, moveEv.shiftKey);
      const selector = generateSelector(el);
      dropTargetRef.current = { selector, position };
      // 仅在 selector 变化时更新父容器描述 state，避免 mousemove 频繁 re-render
      if (lastInfoSelectorRef.current !== selector) {
        lastInfoSelectorRef.current = selector;
        setDropTargetInfo({
          parentLabel: describeDropParent(el, position),
          position,
        });
      }
      updateIndicator(iframe, el, position);
    };

    const handleMouseUp = (upEv: MouseEvent) => {
      cleanup();

      if (!didDrag) {
        // 未进入拖拽模式 → 纯点击，让 onClick 自行处理
        dragComponentRef.current = null;
        return;
      }

      // ① 先清除指示器（在 onInsert 触发 React 重渲染之前）
      const screenId = currentScreenIdRef.current;
      const iframe = screenId ? iframeRefs.current.get(screenId) : undefined;
      removeIndicator(iframe);

      // ② 拖拽结束：若在 iframe 上方释放则执行插入
      const componentType = dragComponentRef.current;
      const target = dropTargetRef.current;
      if (componentType && target) {
        onInsertRef.current(target.selector, componentType, target.position);
      }

      // ③ 清理拖拽状态
      removeDragPreview();
      previewElRef.current = null;
      dragComponentRef.current = null;
      dropTargetRef.current = null;
      lastInfoSelectorRef.current = '';
      setDropTargetInfo(null);
      setIsDragging(false);
      document.body.style.cursor = '';
      restoreAllIframePointerEvents();
    };

    const handleKeyDown = (keyEv: KeyboardEvent) => {
      if (keyEv.key === 'Escape') {
        cleanup();
        removeDragPreview();
        previewElRef.current = null;
        dragComponentRef.current = null;
        dropTargetRef.current = null;
        lastInfoSelectorRef.current = '';
        setDropTargetInfo(null);
        setIsDragging(false);
        document.body.style.cursor = '';
        restoreAllIframePointerEvents();
        const screenId = currentScreenIdRef.current;
        const iframe = screenId ? iframeRefs.current.get(screenId) : undefined;
        removeIndicator(iframe);
      }
    };

    const cleanup = () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.removeEventListener('keydown', handleKeyDown);
      cleanupDragRef.current = null;
    };

    cleanupDragRef.current = cleanup;
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    document.addEventListener('keydown', handleKeyDown);
  }, [enabled, iframeRefs]);

  /** 手动取消拖拽（外部调用，如关闭面板时） */
  const handleDragEnd = useCallback(() => {
    cleanupDragRef.current?.();
    removeDragPreview();
    previewElRef.current = null;
    dragComponentRef.current = null;
    dropTargetRef.current = null;
    lastInfoSelectorRef.current = '';
    setDropTargetInfo(null);
    setIsDragging(false);
    document.body.style.cursor = '';
    restoreAllIframePointerEvents();
    const iframe = iframeRefs.current.get(currentScreenIdRef.current || '');
    removeIndicator(iframe);
  }, [iframeRefs]);

  // 卸载时清理所有残留状态
  useEffect(() => {
    return () => {
      cleanupDragRef.current?.();
      removeDragPreview();
      document.body.style.cursor = '';
      restoreAllIframePointerEvents();
      iframeRefs.current.forEach(removeIndicator);
    };
  }, [iframeRefs]);

  return {
    isDragging,
    dropTarget: dropTargetRef.current,
    dropTargetInfo,
    handleDragStart,
    handleDragEnd,
  };
}