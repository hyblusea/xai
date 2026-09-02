import { useRef, useEffect, useState, useCallback } from 'react';
import { IPCChannel } from '@xai/shared';
import { useIpc } from './useIpc';

export type CursorState = 'idle' | 'moving' | 'drawing' | 'resting';

export interface CursorPosition { x: number; y: number; }
export interface CursorBox { x: number; y: number; w: number; h: number; }

/** 追加:绘制进度 0→1,用于渐进式画框 */
export type DrawState = CursorBox & { progress: number };

/* ── 光标/画框尺寸常量（hook 与组件共用，避免循环依赖放在 hook 侧） ── */
export const CURSOR_W = 100;
export const CURSOR_H = 72;
/**
 * 纸飞机 SVG 经过 translate(0,90) rotate(145°,327,426) 后,
 * 4 个顶点变换后的包围盒左上角在 viewBox 中的坐标:
 *   minX = 184.18, minY = 222.03
 * 换算到 100×72 像素空间:
 *   ANCHOR_X = 184.18 / 1322 * 100 ≈ 13.93
 *   ANCHOR_Y = 222.03 / 960  * 72  ≈ 16.65
 *
 * 使用此锚点 + 无额外偏移,即可让纸飞机左上角精确对齐 position。
 */
export const CURSOR_ANCHOR_X = 184.18 / 1322 * CURSOR_W; // ≈ 13.93
export const CURSOR_ANCHOR_Y = 222.03 / 960 * CURSOR_H;  // ≈ 16.65

/**
 * 光标 DOM 句柄：DesignerCursor 组件挂载时填充，useDesignerCursor 在 rAF
 * 动画帧里【命令式】直写这些节点（transform / SVG 属性），完全绕过 React
 * state。
 *
 * 背景（性能优化）：旧实现每帧 setPosition + setDrawBox（2 次 setState）→
 * 整棵 DesignerCanvas 树以 60fps 重渲染（工具栏、StreamingPages、Dock、
 * 属性面板全部参与 reconciliation），是流式生成期间 CPU/GC 负载的最大来源。
 * 现改为：高频数据（位置、画框坐标/进度）直写 DOM；React 只保留低频的
 * cursorState 切换（每秒几次）。
 */
export interface CursorDomHandles {
  /** 光标元素（纸飞机容器，transform: translate+scale） */
  cursor: HTMLDivElement;
  /** 画框容器（absolute，translate 定位 + width/height） */
  box: HTMLDivElement;
  /** 画框 SVG（width/height/viewBox 随画框尺寸更新） */
  svg: SVGSVGElement;
  /** 半透明填充 rect（width/height 随画框尺寸更新） */
  fillRect: SVGRectElement;
  /** 渐进描边 rect（+ stroke-dashoffset 随进度更新） */
  strokeRect: SVGRectElement;
  /** 发光层 rect（+ stroke-dashoffset 随进度更新） */
  glowRect: SVGRectElement;
}

interface UseDesignerCursorOptions {
  isGenerating: boolean;
  isModification: boolean;
  streamingIframeRef: React.RefObject<HTMLIFrameElement | null>;
  stripRef: React.RefObject<HTMLDivElement | null>;
  zoom: number;
  idlePosition?: CursorPosition;
  /** 光标 DOM 句柄 ref：组件挂载时填充，动画帧直写（见 CursorDomHandles）。 */
  cursorDomRef?: React.MutableRefObject<CursorDomHandles | null>;
  /**
   * Ref for sharing cursor work state with useDesignerStreaming.
   * When cursorHasWorkRef.current === true, streaming should skip
   * auto-scrolling the iframe to bottom to avoid conflicting with
   * the cursor's own scroll-into-view logic.
   */
  cursorHasWorkRef?: React.MutableRefObject<boolean>;
  /**
   * Ref for sharing the cursor's last target element with useDesignerStreaming.
   * Updated whenever startNextTarget commits to a valid target. During the
   * resting phase (cursorHasWorkRef=false), streaming's auto-scroll keeps this
   * element in view instead of jumping to the bottom — otherwise, in a
   * two-column layout, generating the right column's top region makes the
   * scrollbar oscillate between the element position (elementToTarget scrolls
   * up) and the document bottom (auto-scroll pulls back), and the dashed
   * cursor box jitters along with it.
   */
  lastCursorTargetElRef?: React.MutableRefObject<HTMLElement | null>;
}

interface QueuedTarget {
  element: HTMLElement;
  box: CursorBox;
}

/**
 * Google-Stitch 风格虚拟光标 hook。
 *
 * 工作流程:
 *  1. streaming 推入新元素时(diff 检测),元素立即 opacity:0 隐藏
 *  2. 元素加入光标队列
 *  3. 光标移动到元素位置 → 沿矩形 4 边顺时针画框(按 demo 的 rectPath)
 *  4. 画框完成 → 元素 opacity:1 淡入显示
 *  5. 处理队列下一个
 *
 * 视觉效果:光标画框 → 元素出现,感觉是光标"画出"了元素。
 */
export function useDesignerCursor({
  isGenerating,
  isModification,
  streamingIframeRef,
  stripRef,
  zoom,
  idlePosition = { x: 16, y: 16 },
  cursorDomRef,
  cursorHasWorkRef,
  lastCursorTargetElRef,
}: UseDesignerCursorOptions) {
  const active = isGenerating && !isModification;

  // 低频状态：光标阶段（每秒切换几次，走 React 渲染）。
  // 高频数据（位置/画框坐标/进度）不再走 state —— 见 writePosition/writeDrawBox。
  const [cursorState, setCursorState] = useState<CursorState>('idle');

  const { on, removeListener } = useIpc();

  const positionRef = useRef<CursorPosition>(idlePosition);
  const stateRef = useRef<CursorState>('idle');
  const queueRef = useRef<QueuedTarget[]>([]);
  const currentTargetRef = useRef<QueuedTarget | null>(null);
  const animRafRef = useRef<number | null>(null);
  const idleRafRef = useRef<number | null>(null);
  const speedFactorRef = useRef(1);
  const skipBoostRef = useRef(1);
  const lastChunkTimeRef = useRef(Date.now());
  const lastElementRef = useRef<HTMLElement | null>(null);
  const idleTargetOffsetRef = useRef<CursorPosition>({ x: 0, y: 0 });
  const idleNextJitterRef = useRef(Date.now() + 2000);
  const basePositionRef = useRef<CursorPosition>(idlePosition);
  const idlePositionRef = useRef<CursorPosition>(idlePosition);
  // 当前画框状态（供 scroll 监听补偿重算用；不驱动渲染）
  const currentDrawRef = useRef<DrawState | null>(null);
  // zoom 经 ref 供命令式写入读取（writePosition 在 rAF 回调中执行）
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;

  useEffect(() => { stateRef.current = cursorState; }, [cursorState]);

  /* ── 命令式 DOM 写入：高频动画数据绕过 React ─────────────────────── */
  /** 光标位置直写（transform: translate + scale(1/zoom)）。 */
  const writePosition = useCallback((x: number, y: number) => {
    positionRef.current = { x, y };
    const dom = cursorDomRef?.current;
    if (!dom) return;
    const invZoom = 1 / zoomRef.current;
    const tx = x - CURSOR_ANCHOR_X * invZoom;
    const ty = y - CURSOR_ANCHOR_Y * invZoom;
    dom.cursor.style.transform = `translate(${tx}px, ${ty}px) scale(${invZoom})`;
  }, [cursorDomRef]);

  /** 画框直写（容器定位/尺寸 + SVG viewBox + rect 尺寸 + dashoffset 进度）。 */
  const writeDrawBox = useCallback((box: CursorBox | null, progress: number) => {
    currentDrawRef.current = box ? { ...box, progress } : null;
    const dom = cursorDomRef?.current;
    if (!dom) return;
    if (!box) {
      dom.box.style.display = 'none';
      return;
    }
    const strokeW = 1;
    const iw = box.w - strokeW;
    const ih = box.h - strokeW;
    dom.box.style.display = '';
    dom.box.style.transform = `translate(${box.x}px, ${box.y}px)`;
    dom.box.style.width = `${box.w}px`;
    dom.box.style.height = `${box.h}px`;
    dom.svg.setAttribute('width', String(box.w));
    dom.svg.setAttribute('height', String(box.h));
    dom.svg.setAttribute('viewBox', `0 0 ${box.w} ${box.h}`);
    const sizeAttrs = [['width', iw], ['height', ih]] as const;
    for (const rect of [dom.fillRect, dom.strokeRect, dom.glowRect]) {
      for (const [name, val] of sizeAttrs) rect.setAttribute(name, String(val));
    }
    const offset = String(1 - Math.min(1, progress));
    dom.strokeRect.setAttribute('stroke-dashoffset', offset);
    dom.glowRect.setAttribute('stroke-dashoffset', offset);
  }, [cursorDomRef]);

  /* ── 同步 cursorHasWorkRef: 队列有元素或正在绘制/移动时为 true ── */
  const syncCursorWork = useCallback(() => {
    if (!cursorHasWorkRef) return;
    const st = stateRef.current;
    cursorHasWorkRef.current =
      queueRef.current.length > 0 ||
      st === 'moving' ||
      st === 'drawing';
  }, [cursorHasWorkRef]);

  /* ── 坐标换算:iframe 内元素 → overlay 屏幕 px ────────────────────── */
  // overlay 在 .designer-pages-strip 内(position:absolute;top:0;left:0),
  // 和 .designer-page-card 是兄弟节点。坐标系原点 = strip 左上角。
  //
  // elRect 来自 getBoundingClientRect(),是相对于 iframe 视口的坐标。
  // 当 iframe 内部滚动时 elRect.top 会变化,因此 box 必须在绘制时实时重算
  // (见 startDrawing tick 和 scroll 监听 effect),否则画框会与元素错位。
  //
  // computeBox:纯坐标计算,不滚动 iframe。供 tick / scroll 监听复用。
  const computeBox = useCallback((el: HTMLElement): CursorBox | null => {
    const iframe = streamingIframeRef.current;
    const strip = stripRef.current;
    if (!iframe || !strip) return null;
    const iframeContainer = iframe.closest('.designer-iframe-container');
    const pageCard = iframeContainer?.closest('.designer-page-card');
    if (!iframeContainer || !pageCard) return null;

    const elRect = el.getBoundingClientRect();
    if (elRect.width === 0 && elRect.height === 0) return null;

    const stripRect = strip.getBoundingClientRect();
    const pageCardRect = pageCard.getBoundingClientRect();
    const pageCardLeft = (pageCardRect.left - stripRect.left) / zoom;
    const pageCardTop = (pageCardRect.top - stripRect.top) / zoom;

    const iframeContainerRect = iframeContainer.getBoundingClientRect();
    const iframeInPageCardLeft = (iframeContainerRect.left - pageCardRect.left) / zoom;
    const iframeInPageCardTop = (iframeContainerRect.top - pageCardRect.top) / zoom;

    const pad = 1;
    return {
      x: pageCardLeft + iframeInPageCardLeft + elRect.left - pad,
      y: pageCardTop + iframeInPageCardTop + elRect.top - pad,
      w: elRect.width + pad * 2,
      h: elRect.height + pad * 2,
    };
  }, [streamingIframeRef, stripRef, zoom]);

  /* ── 元素 → 光标目标(含 scroll-into-view)─────────────────────── */
  // 检查元素是否在 iframe 可视区域外,如果是则手动滚动 iframe 的 scrollTop/scrollLeft
  // (scrollIntoView 跨 iframe 边界调用不可靠,改用手动计算),
  // 然后调用 computeBox 得到最终坐标。
  // 垂直与水平均处理:左右两栏布局下右栏元素可能同时在垂直(顶部)与水平(右侧)方向
  // 超出视口,只滚垂直会让元素停留在水平滚动条之外,光标画框仍不可见。
  const elementToTarget = useCallback((el: HTMLElement): QueuedTarget | null => {
    const iframe = streamingIframeRef.current;
    if (!iframe) return null;

    let elRect = el.getBoundingClientRect();
    if (elRect.width === 0 && elRect.height === 0) return null;

    const iframeHeight = iframe.clientHeight;
    const iframeWidth = iframe.clientWidth;

    try {
      const iframeDoc = iframe.contentDocument;
      if (iframeDoc?.documentElement) {
        const docEl = iframeDoc.documentElement;
        // 垂直:元素完全在视口外 或 顶部超出视口上方时滚动到视口上方 1/3 处
        if (elRect.bottom < 0 || elRect.top > iframeHeight || elRect.top < 0) {
          // elRect.top 是元素相对于 iframe 视口的偏移
          // 加上当前 scrollTop 就是元素在文档中的绝对位置
          const elAbsTop = docEl.scrollTop + elRect.top;
          docEl.scrollTop = Math.max(0, elAbsTop - iframeHeight / 3);
          // 滚动后刷新 rect(水平判断要用滚动后的新值)
          elRect = el.getBoundingClientRect();
        }
        // 水平:元素完全在视口外 或 左侧超出视口左方时滚动到视口左侧 1/4 处
        if (elRect.right < 0 || elRect.left > iframeWidth || elRect.left < 0) {
          const elAbsLeft = docEl.scrollLeft + elRect.left;
          docEl.scrollLeft = Math.max(0, elAbsLeft - iframeWidth / 4);
        }
      }
    } catch { /* ignore */ }

    // 滚动后实时计算坐标(scrollTop/scrollLeft 变化后 elRect 会变)
    const box = computeBox(el);
    if (!box) return null;
    return { element: el, box };
  }, [streamingIframeRef, computeBox]);

  /* ── 显示元素(画框完成后调用)────────────────────────────────── */
  const showElement = useCallback((el: HTMLElement) => {
    try {
      el.style.opacity = '1';
      el.style.transition = 'opacity 0.3s ease';
    } catch { /* ignore */ }
  }, []);

  // 自引用 refs：startDrawing / startNextTarget 在 rAF/setTimeout 回调里互相
  // 引用,通过 ref 拿最新闭包（同原实现）。
  const startDrawingRef = useRef<(target: QueuedTarget) => void>(() => {});
  const startNextTargetRef = useRef<() => void>(() => {});
  const elementToTargetRef = useRef<(el: HTMLElement) => QueuedTarget | null>(() => null);
  const showElementRef = useRef<(el: HTMLElement) => void>(() => {});
  const computeBoxRef = useRef<(el: HTMLElement) => CursorBox | null>(() => null);

  /* ── 画框动画:光标沿矩形 4 边顺时针移动(按 demo)────────────────── */
  // 按用户 demo 的 rectPath:光标从左上角出发,顺时针绕矩形 4 边:
  //   上边(左上→右上)→ 右边(右上→右下)→ 下边(右下→左下)→ 左边(左下→左上)
  // 匀速移动,时长按周长比例分配。画框(矩形边框)一开始就完整显示,
  // 光标沿边框移动一圈,完成后元素淡入。
  const startDrawing = useCallback((target: QueuedTarget) => {
    const speed = speedFactorRef.current * skipBoostRef.current;
    const { box } = target;
    const perimeter = 2 * (box.w + box.h);
    // 周长越长,时长越长(匀速 ~600px/s)
    const duration = Math.max(200, Math.min(800, perimeter / 1200 * 1000 / speed));

    setCursorState('drawing');
    stateRef.current = 'drawing';
    // 初始化画框,progress 从 0 开始随光标推进（命令式直写 DOM）
    writeDrawBox(box, 0);

    const startTs = performance.now();
    // 4 段时间分配(匀速):上、右、下、左
    const t1 = box.w / perimeter; // 上边占比
    const t2 = box.h / perimeter; // 右边占比
    const t3 = box.w / perimeter; // 下边占比
    const t4 = box.h / perimeter; // 左边占比

    const tick = () => {
      const elapsed = performance.now() - startTs;
      const t = Math.min(1, elapsed / duration);

      // 实时重算 box,跟踪 iframe 滚动 / 内容 reflow 导致的元素位移。
      // 绘制期 cursorHasWorkRef=true 会阻止 streaming 自动滚到底部,
      // 但 reflow 仍可能移动元素;fallback 到原始 box 防止元素被移除时崩溃。
      const liveBox = computeBoxRef.current(target.element) ?? box;

      // 根据 t 计算光标在矩形边框上的位置(顺时针,从左上角出发)
      let cx: number, cy: number;
      if (t < t1) {
        // 上边:左上 → 右上
        const p = t / t1;
        cx = liveBox.x + liveBox.w * p;
        cy = liveBox.y;
      } else if (t < t1 + t2) {
        // 右边:右上 → 右下
        const p = (t - t1) / t2;
        cx = liveBox.x + liveBox.w;
        cy = liveBox.y + liveBox.h * p;
      } else if (t < t1 + t2 + t3) {
        // 下边:右下 → 左下
        const p = (t - t1 - t2) / t3;
        cx = liveBox.x + liveBox.w * (1 - p);
        cy = liveBox.y + liveBox.h;
      } else {
        // 左边:左下 → 左上
        const p = (t - t1 - t2 - t3) / t4;
        cx = liveBox.x;
        cy = liveBox.y + liveBox.h * (1 - p);
      }
      // 高频位置/进度更新:直写 DOM,不触发 React 渲染
      writePosition(cx, cy);
      writeDrawBox(liveBox, t);

      if (t < 1) {
        animRafRef.current = requestAnimationFrame(tick);
      } else {
        // 画框完成:光标停在左上角(起点),元素淡入显示
        writePosition(liveBox.x, liveBox.y);
        showElement(target.element);

        setCursorState('resting');
        stateRef.current = 'resting';
        // 进度 1 + resting,触发画框淡出（fading 过渡由组件按 cursorState 设置）
        writeDrawBox(liveBox, 1);
        basePositionRef.current = { x: liveBox.x, y: liveBox.y };
        idleNextJitterRef.current = Date.now() + 1500 + Math.random() * 1500;

        // ── 跳过加速衰减:本轮无跳过,boost 衰减 ──
        skipBoostRef.current = Math.max(1, skipBoostRef.current * 0.85);

        // 同步 cursorHasWorkRef
        syncCursorWork();

        // 队列中还有元素 → 停顿后处理下一个
        if (queueRef.current.length > 0) {
          const effectiveSpeed = speedFactorRef.current * skipBoostRef.current;
          const pause = Math.max(50, Math.min(200, 100 / effectiveSpeed));
          setTimeout(() => {
            if (stateRef.current === 'resting' && queueRef.current.length > 0) {
              startNextTargetRef.current();
            }
          }, pause);
        }
      }
    };
    animRafRef.current = requestAnimationFrame(tick);
  }, [showElement, syncCursorWork, writePosition, writeDrawBox]);

  /* ── 移动动画:贝塞尔曲线带弧度 ─────────────────────────────────── */
  const startNextTarget = useCallback(() => {
    let next = queueRef.current.shift();
    if (!next) {
      // 队列空:保持 resting(不回左上角),停在当前位置
      setCursorState('resting');
      stateRef.current = 'resting';
      currentTargetRef.current = null;
      basePositionRef.current = positionRef.current;
      idleNextJitterRef.current = Date.now() + 1500 + Math.random() * 1500;
      syncCursorWork();
      return;
    }

    // ── 积压检测:队列仍有元素 → 跳过中间元素,只画最后一个 ────────
    if (queueRef.current.length > 0) {
      // 立即显示已 shift 出来的元素 + 所有中间元素(无动画)
      showElementRef.current(next.element);
      for (const skipped of queueRef.current) {
        showElementRef.current(skipped.element);
      }
      // 取最后一个作为光标目标
      const last = queueRef.current[queueRef.current.length - 1];
      queueRef.current = [];
      next = last;
      // 速度翻倍
      skipBoostRef.current = 2.0;
    }

    // 同步 cursorHasWorkRef:队列还有元素
    syncCursorWork();

    // 绘制前实时重新计算坐标(处理 iframe 滚动导致的坐标变化)
    const freshTarget = elementToTargetRef.current(next.element);
    if (!freshTarget) {
      // 元素已不可见,直接显示并跳到下一个
      showElementRef.current(next.element);
      if (queueRef.current.length > 0) {
        startNextTargetRef.current();
      } else {
        setCursorState('resting');
        stateRef.current = 'resting';
        syncCursorWork();
      }
      return;
    }
    next = freshTarget;
    currentTargetRef.current = next;
    lastElementRef.current = next.element;
    // 同步给 useDesignerStreaming:resting 阶段自动滚动据此保持元素在视口内,
    // 而不是无脑拉到底部(见 options.lastCursorTargetElRef 注释)。
    if (lastCursorTargetElRef) lastCursorTargetElRef.current = next.element;

    const from = positionRef.current;
    // 目标:元素左上角(光标从左上角开始绕框)
    const to = { x: next.box.x, y: next.box.y };
    const speed = speedFactorRef.current * skipBoostRef.current;
    const duration = Math.max(200, Math.min(500, 400 / speed));

    setCursorState('moving');
    stateRef.current = 'moving';
    writeDrawBox(null, 0);

    const startTs = performance.now();
    const midX = (from.x + to.x) / 2 + (to.y - from.y) * 0.12;
    const midY = (from.y + to.y) / 2 - (to.x - from.x) * 0.12;

    const tick = () => {
      const elapsed = performance.now() - startTs;
      const t = Math.min(1, elapsed / duration);
      const eased = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      const x = (1 - eased) * (1 - eased) * from.x + 2 * (1 - eased) * eased * midX + eased * eased * to.x;
      const y = (1 - eased) * (1 - eased) * from.y + 2 * (1 - eased) * eased * midY + eased * eased * to.y;
      writePosition(x, y);

      if (t < 1) {
        animRafRef.current = requestAnimationFrame(tick);
      } else {
        startDrawingRef.current(next);
      }
    };
    animRafRef.current = requestAnimationFrame(tick);
  }, [syncCursorWork, writePosition, writeDrawBox]);

  startDrawingRef.current = startDrawing;
  startNextTargetRef.current = startNextTarget;
  elementToTargetRef.current = elementToTarget;
  showElementRef.current = showElement;
  computeBoxRef.current = computeBox;

  /* ── idle 微动:仅在 idle / resting 状态 ─────────────────────────── */
  // 使用 CSS transition 驱动平滑移动,不再每帧 rAF 手动插值
  // 每隔几秒随机设一个新目标,DesignerCursor 的 CSS transition 自动缓动
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    let timerId: ReturnType<typeof setTimeout>;

    const scheduleNext = () => {
      if (cancelled) return;
      const st = stateRef.current;

      if (st === 'idle' || st === 'resting') {
        idleTargetOffsetRef.current = {
          x: (Math.random() - 0.5) * 120,
          y: (Math.random() - 0.5) * 90,
        };
        const targetX = basePositionRef.current.x + idleTargetOffsetRef.current.x;
        const targetY = basePositionRef.current.y + idleTargetOffsetRef.current.y;
        // 直接设目标,CSS transition: transform 4s 自动平滑（命令式写入）
        writePosition(targetX, targetY);
      }

      const delay = 7000 + Math.random() * 5000;
      timerId = setTimeout(scheduleNext, delay);
    };

    const initialDelay = 1500 + Math.random() * 1500;
    timerId = setTimeout(scheduleNext, initialDelay);

    return () => {
      cancelled = true;
      clearTimeout(timerId);
    };
  }, [active, writePosition]);

  /* ── 接收 streaming 推入的新元素(回调方式)────────────────────── */
  // useDesignerStreaming 在 doc.write 后 diff 出新增元素,调用此回调。
  // 元素已经在 streaming 端被设置 opacity:0,这里加入队列等光标画框。
  //
  // 注意:只检查元素是否有效,不计算最终坐标。坐标在 startNextTarget
  // 即将绘制时才实时计算(避免 iframe 滚动导致坐标过时)。
  const handleNewElement = useCallback((el: HTMLElement) => {
    // 快速检查:元素必须有可见尺寸
    const rect = el.getBoundingClientRect();
    if (rect.width < 10 || rect.height < 10) {
      showElement(el);
      return;
    }
    // 只存元素引用,不存坐标(box 在绘制时实时计算)
    queueRef.current.push({ element: el, box: { x: 0, y: 0, w: 0, h: 0 } });
    // 同步 cursorHasWorkRef
    syncCursorWork();
    if (stateRef.current === 'idle' || stateRef.current === 'resting') {
      if (animRafRef.current) cancelAnimationFrame(animRafRef.current);
      startNextTargetRef.current();
    }
  }, [showElement, syncCursorWork]);

  /* ── AI 输出测速 ────────────────────────────────────────────────── */
  useEffect(() => {
    if (!active) return;
    const handleChunk = (chunk: unknown) => {
      const text = String(chunk);
      const now = Date.now();
      const dt = now - lastChunkTimeRef.current;
      if (dt > 0 && text.length > 0) {
        const charsPerSec = text.length / (dt / 1000);
        const factor = Math.max(0.5, Math.min(2.5, 0.5 + charsPerSec / 100));
        speedFactorRef.current = speedFactorRef.current * 0.6 + factor * 0.4;
      }
      lastChunkTimeRef.current = now;
    };
    on(IPCChannel.DesignerStreamChunk, handleChunk);
    return () => removeListener(IPCChannel.DesignerStreamChunk, handleChunk);
  }, [active, on, removeListener]);

  /* ── 生成开始/结束:重置状态 ────────────────────────────────────── */
  useEffect(() => {
    if (active) {
      const idle = idlePositionRef.current;
      writePosition(idle.x, idle.y);
      basePositionRef.current = idle;
      setCursorState('idle');
      stateRef.current = 'idle';
      writeDrawBox(null, 0);
      queueRef.current = [];
      currentTargetRef.current = null;
      lastElementRef.current = null;
      speedFactorRef.current = 1;
      skipBoostRef.current = 1;
      lastChunkTimeRef.current = Date.now();
      idleTargetOffsetRef.current = { x: 0, y: 0 };
      idleNextJitterRef.current = Date.now() + 1500;
      // 重置 cursorHasWorkRef
      if (cursorHasWorkRef) cursorHasWorkRef.current = false;
      if (lastCursorTargetElRef) lastCursorTargetElRef.current = null;
    } else {
      if (animRafRef.current) cancelAnimationFrame(animRafRef.current);
      writeDrawBox(null, 0);
      queueRef.current = [];
      currentTargetRef.current = null;
      skipBoostRef.current = 1;
      if (cursorHasWorkRef) cursorHasWorkRef.current = false;
      if (lastCursorTargetElRef) lastCursorTargetElRef.current = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  /* ── zoom 变化:用新缩放重写光标 transform（画框在 strip 坐标系不受影响）── */
  useEffect(() => {
    const p = positionRef.current;
    writePosition(p.x, p.y);
  }, [zoom, writePosition]);

  /* ── 动态 idle 位置:跟随 iframe 左上角 ─────────────────────────── */
  useEffect(() => {
    if (!active) return;
    let cancelled = false;

    const updateIdle = () => {
      if (cancelled) return;
      const iframe = streamingIframeRef.current;
      const strip = stripRef.current;
      if (!iframe || !strip) return;
      const iframeRect = iframe.getBoundingClientRect();
      const stripRect = strip.getBoundingClientRect();
      if (iframeRect.width === 0) return;

      // idle 位置:与 elementToTarget 同一坐标系
      // 找到 pageCard 偏移
      const iframeContainer = iframe.closest('.designer-iframe-container');
      const pageCard = iframeContainer?.closest('.designer-page-card');
      let pageCardLeft = 0, pageCardTop = 0;
      let iframeInPageCardLeft = 0, iframeInPageCardTop = 0;
      if (pageCard) {
        const pageCardRect = pageCard.getBoundingClientRect();
        pageCardLeft = (pageCardRect.left - stripRect.left) / zoom;
        pageCardTop = (pageCardRect.top - stripRect.top) / zoom;
        const iframeContainerRect = iframeContainer!.getBoundingClientRect();
        iframeInPageCardLeft = (iframeContainerRect.left - pageCardRect.left) / zoom;
        iframeInPageCardTop = (iframeContainerRect.top - pageCardRect.top) / zoom;
      }
      const newPos = {
        x: pageCardLeft + iframeInPageCardLeft + 44,
        y: pageCardTop + iframeInPageCardTop + 44,
      };
      idlePositionRef.current = newPos;
      const st = stateRef.current;
      // 仅 idle 状态更新基准位置(不打断 moving/drawing/resting)
      if (st === 'idle') {
        // 只更新 basePositionRef,让 idle jitter 效果控制 position
        // 避免 updateIdle(400ms) 与 jitter(CSS transition 8s) 互相覆盖
        basePositionRef.current = newPos;
        // 首次(offset 为 0)时直接设 position,后续由 jitter 驱动
        if (idleTargetOffsetRef.current.x === 0 && idleTargetOffsetRef.current.y === 0) {
          writePosition(newPos.x, newPos.y);
        }
      }
    };

    const timer = setTimeout(updateIdle, 100);
    const interval = setInterval(updateIdle, 400);

    return () => {
      cancelled = true;
      clearTimeout(timer);
      clearInterval(interval);
    };
  }, [active, zoom, streamingIframeRef, stripRef, writePosition]);

  /* ── iframe 滚动时实时更新画框(防止自动滚动时画框与元素错位)────── */
  // 画框坐标用 getBoundingClientRect() 一次性算好,但 iframe 内部滚动
  // (如 streaming 自动滚到底部)会改变元素的视口相对坐标,导致画框
  // 停留在旧位置。绘制期 cursorHasWorkRef=true 阻止了自动滚动,但
  // resting 阶段(画框 ~0.35s 淡出)cursorHasWorkRef 恢复 false,
  // 自动滚动恢复 → 画框与元素错位。此监听器在滚动时实时重算画框坐标。
  //
  // 绘制中(drawing):tick 每帧已重算,此处作为补充;
  // 淡出中(resting):tick 已停止,此处是唯一的补偿来源。
  useEffect(() => {
    if (!active) return;
    let currentWindow: Window | null = null;
    let scrollRafId: number | null = null;

    const onScroll = () => {
      if (scrollRafId !== null) return; // rAF 节流:每帧最多一次
      scrollRafId = requestAnimationFrame(() => {
        scrollRafId = null;
        const target = currentTargetRef.current;
        const draw = currentDrawRef.current;
        if (!target || !draw) return;
        const freshBox = computeBoxRef.current(target.element);
        if (!freshBox) return;
        writeDrawBox(freshBox, draw.progress);
      });
    };

    const bind = () => {
      const iframe = streamingIframeRef.current;
      const w = iframe?.contentWindow;
      if (!w || w === currentWindow) return;
      if (currentWindow) currentWindow.removeEventListener('scroll', onScroll);
      currentWindow = w;
      w.addEventListener('scroll', onScroll, { passive: true });
    };

    bind();
    // StreamingPages 条件渲染 iframe,可能稍晚才挂载;轮询确保绑定时序
    const pollInterval = setInterval(bind, 500);

    return () => {
      clearInterval(pollInterval);
      if (scrollRafId !== null) cancelAnimationFrame(scrollRafId);
      if (currentWindow) currentWindow.removeEventListener('scroll', onScroll);
    };
  }, [active, streamingIframeRef, writeDrawBox]);

  /* ── 卸载清理 ───────────────────────────────────────────────────── */
  useEffect(() => {
    return () => {
      if (animRafRef.current) cancelAnimationFrame(animRafRef.current);
      if (idleRafRef.current) cancelAnimationFrame(idleRafRef.current);
    };
  }, []);

  return {
    cursorState,
    active,
    handleNewElement,
  };
}
