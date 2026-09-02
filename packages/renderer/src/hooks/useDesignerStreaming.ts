import { useRef, useEffect, useMemo } from 'react';
import type { MasterLayout } from '@xai/shared';
import { PAGE_BREAK_DELIMITER } from '../components/designer/canvas/types';
import { stripCodeFences, wrapStreamingPages } from './useDesignerAgent';
import { injectMasterLayoutsIntoDoc } from '../utils/masterLayoutInject';

/** Tags that should NOT trigger cursor reveal (non-visual elements). */
const SKIP_TAGS = new Set(['script', 'style', 'link', 'meta', 'title', 'head', 'base', 'noscript']);

/**
 * 确定性销毁流式 iframe 的文档。
 *
 * 背景（OOM 根因之一）：流式 iframe 带 sandbox="allow-same-origin allow-scripts"，
 * AI 页面里的 <script>（Bootstrap bundle、图表库、setInterval/rAF 动画）在 iframe
 * 文档内执行。生成结束或用户点「停止」后 StreamingPages 卸载，React 在 commit
 * 阶段先把 ref 置 null，之后才跑 useEffect cleanup —— 导致旧实现里的
 * `streamingIframeRef.current?.contentDocument?.close()` 永远读到 null（死代码），
 * 流式文档从未被主动关闭。带定时器/脚本闭包的文档会整体滞留（V8 context +
 * CDN 库可达数十~上百 MB），每点一次停止就泄漏一份，累积后触发
 * render-process-gone: reason=oom。
 *
 * 这里通过给 iframe 设置空 srcdoc 触发一次导航：旧文档被卸载，其定时器、
 * 脚本与 V8 context 随之释放。幂等，可安全重复调用。
 */
export function disposeStreamingIframe(iframe: HTMLIFrameElement | null): void {
  if (!iframe) return;
  try { iframe.contentWindow?.stop(); } catch { /* ignore */ }
  try {
    // 空 srcdoc 导航 → 卸载旧文档（含脚本/定时器），释放渲染资源
    iframe.srcdoc = '';
  } catch { /* ignore */ }
}

interface UseDesignerStreamingOptions {
  html: string;
  isGenerating: boolean;
  /** doc.write 后 diff 出新增元素时调用(用于虚拟光标画框) */
  onNewElement?: (el: HTMLElement) => void;
  /** 外部传入的 iframe ref(与 cursor 共用) */
  streamingIframeRef?: React.RefObject<HTMLIFrameElement | null>;
  /**
   * Shared ref from useDesignerCursor. When true, the cursor is actively
   * processing elements (queue non-empty or moving/drawing), so auto-scroll
   * should be skipped to avoid conflicting with the cursor's own
   * scroll-into-view logic in elementToTarget.
   */
  cursorHasWorkRef?: React.MutableRefObject<boolean>;
  /**
   * Shared ref from useDesignerCursor: the last element the cursor drew a box
   * around. During the resting phase (cursorHasWorkRef=false) auto-scroll keeps
   * this element in view instead of jumping to the bottom. Without this, in a
   * two-column layout, generating the right column's top region makes the
   * scrollbar oscillate between the element position (elementToTarget scrolls
   * up to it) and the document bottom (auto-scroll pulls back down) every
   * token that doesn't produce a new element — and the dashed cursor box jitters
   * along with it. Null when the cursor has never committed a target (start of
   * generation), in which case the original scroll-to-bottom behavior applies.
   */
  lastCursorTargetElRef?: React.MutableRefObject<HTMLElement | null>;
  /** 共享母版：传入则流式期间实时注入到 slot 占位（菜单高亮跟随当前生成页）。 */
  masterLayouts?: MasterLayout[];
  /** 用于菜单高亮：编辑模式传 screenId，新建模式传 ''。 */
  streamingScreenId?: string;
}

/**
 * Manages streaming multi-page HTML rendering into the active iframe via
 * incremental document.write. Handles page-break splitting, per-page write
 * cursors, fallback to srcdoc on write failure, auto-scroll, and cleanup.
 * Extracted from DesignerCanvas.
 */
export function useDesignerStreaming({ html, isGenerating, onNewElement, streamingIframeRef: externalRef, cursorHasWorkRef, lastCursorTargetElRef, masterLayouts, streamingScreenId }: UseDesignerStreamingOptions) {
  const internalRef = useRef<HTMLIFrameElement | null>(null);
  const streamingIframeRef = externalRef ?? internalRef;
  // 最近一次成功写入时捕获的 iframe 元素。StreamingPages 卸载时 React 会先把
  // 外部 ref 置 null（早于 useEffect cleanup），因此清理逻辑不能依赖外部 ref，
  // 必须用这个在写入时捕获的引用才能拿到元素并确定性销毁其文档（见
  // disposeStreamingIframe 注释 —— 这是停止按钮后内存不释放的根因修复）。
  const lastIframeRef = useRef<HTMLIFrameElement | null>(null);
  const streamingWrittenRef = useRef(0);
  const streamingStartedRef = useRef(false);
  const streamingPageIndexRef = useRef(0);
  const lastInProgressHtmlRef = useRef('');
  // 上一次 doc.write 前的 body 子元素快照(WeakSet),用于 diff 新增元素
  const prevElementsRef = useRef<WeakSet<Element> | null>(null);
  // ── 新元素 diff 的索引游标（性能优化）────────────────────────────────
  // 旧实现每次写入都 querySelectorAll('*:not([data-stream-seen])')，对全量
  // 元素做 O(E) 选择器匹配（3000 元素约 1-3ms/帧）。body 元素在流式期间只增
  // 不减，改用 getElementsByTagName('*') live 集合 + 索引游标，只遍历新增部分
  // （O(新增)）。streamSweepCounterRef 每 200 次写入强制一次全量兜底扫描，
  // 覆盖解析器移动/删除节点导致游标漏掉的元素（漏掉的元素会停在 opacity:0）。
  const streamSeenCountRef = useRef(0);
  const streamSweepCounterRef = useRef(0);
  const onNewElementRef = useRef(onNewElement);
  useEffect(() => { onNewElementRef.current = onNewElement; }, [onNewElement]);

  // ── 共享母版实时注入 refs ──────────────────────────────────────────────
  // masterLayouts / streamingScreenId 可能在每次 render 变化（如项目切换），
  // 用 ref 保存最新值供 performStreamingWriteRef（rAF 回调）读取，避免闭包过期。
  const masterLayoutsRef = useRef(masterLayouts);
  masterLayoutsRef.current = masterLayouts;
  const streamingScreenIdRef = useRef(streamingScreenId);
  streamingScreenIdRef.current = streamingScreenId;

  /* ── Parse the streaming buffer into pages ─────────────────────────── */
  // Each page is run through stripCodeFences so that per-page fences (the
  // closing ``` of page N and the opening ```html of page N+1 that sit between
  // two PAGE_BREAK delimiters) are stripped before rendering. The full-buffer
  // strip in useDesignerAgent only removes the outermost opening/closing
  // fences; intermediate per-page fences are handled here.
  //
  // After fence-stripping, wrapStreamingPages is applied: any bare fragment
  // (not starting with <!DOCTYPE html> or <html>) is wrapped into a complete
  // document reusing the <head> block from the first complete page. This
  // rescues the SPA-tab pattern where the LLM emits non-active pages as
  // <div style="display:none;"> — the wrapper strips that display:none and
  // provides Bootstrap CDN + theme CSS so the page renders correctly during
  // streaming (matching the final parsePages behavior in useDesignerAgent).
  const streamingPages: string[] = useMemo(
    () => (isGenerating && html
      ? wrapStreamingPages(html.split(PAGE_BREAK_DELIMITER).map(stripCodeFences))
      : []),
    [html, isGenerating],
  );

  /* ── rAF 节流 refs ─────────────────────────────────────────────────── */
  // 流式期间 html 高频更新(每 token 一次),逐次触发 document.write + iframe 全量
  // reflow 会导致渲染进程 OOM(见 window.ts render-process-gone 注释)。用 rAF
  // 把同帧多次 html 更新合并为一次 write:rAF 回调读取 latestStreamingPagesRef
  // (即最新 buffer),基于 streamingWrittenRef 增量游标 write,不丢内容。
  // 所有原有语义(page-break 切页、prefix mutation 重置、WeakSet diff、srcdoc
  // fallback、auto-scroll)在 performStreamingWriteRef 中完整保留,仅调度方式
  // 从「每 token 同步」改为「每帧合并」。
  const rafPendingRef = useRef(false);
  const latestStreamingPagesRef = useRef<string[]>(streamingPages);
  const latestHtmlRef = useRef(html);
  latestStreamingPagesRef.current = streamingPages;
  latestHtmlRef.current = html;

  /* ── 核心 write 逻辑(每次 render 更新闭包,供 rAF / flush 调用) ─────── */
  // 从原 streaming render effect 抽出,逻辑与原版完全等价。接收 pages 参数
  // (调用方传 latestStreamingPagesRef.current),不依赖 render 期变量,只读 refs,
  // 因此 rAF 在下一帧执行时拿到的永远是最新状态。
  const performStreamingWriteRef = useRef<(pages: string[]) => void>(() => {});
  performStreamingWriteRef.current = (pages: string[]) => {
    if (pages.length === 0) return;

    const currentPageIndex = pages.length - 1;
    const inProgressHtml = pages[currentPageIndex] || '';

    const iframe = streamingIframeRef.current;
    if (!iframe) return;
    // 捕获当前元素供 isGenerating=false 清理时确定性销毁（外部 ref 届时已被置 null）
    lastIframeRef.current = iframe;

    const doc = iframe.contentDocument;
    if (!doc) return;

    const isPageIndexChange = streamingPageIndexRef.current !== currentPageIndex;
    if (isPageIndexChange) {
      streamingPageIndexRef.current = currentPageIndex;
      streamingWrittenRef.current = 0;
      streamingStartedRef.current = false;
      lastInProgressHtmlRef.current = '';
      // 新页面 = 新文档：元素游标与兜底计数归零
      streamSeenCountRef.current = 0;
      streamSweepCounterRef.current = 0;
      // 重置 Mermaid 初始化标志：doc.open() 清除文档但保留 window 属性，
      // 而新页面的 CDN <script> 会加载全新 mermaid 实例，需要重新 initialize。
      try {
        const w = streamingIframeRef.current?.contentWindow as any;
        if (w) w.__xai_mermaid_initialized = false;
      } catch { /* ignore */ }
    }

    if (!streamingStartedRef.current) {
      streamingStartedRef.current = true;
      streamingWrittenRef.current = 0;
      try {
        doc.open();
        // 转发 Ctrl/Cmd + 滚轮到父级画布容器以支持缩放（同 SavedPages）。
        // 此 iframe 通过 document.write 写入内容,无 onLoad 事件,故在 doc.open()
        // 之后(此时 document 已重置为空白)直接挂载监听器,整个流式期间有效。
        doc.addEventListener('wheel', (ev: WheelEvent) => {
          if (!(ev.ctrlKey || ev.metaKey)) return;
          ev.preventDefault();
          const parentWrapper = window.parent.document.querySelector('.designer-canvas-wrapper');
          if (!parentWrapper) return;
          const rect = iframe.getBoundingClientRect();
          parentWrapper.dispatchEvent(new WheelEvent('wheel', {
            bubbles: true,
            cancelable: true,
            ctrlKey: ev.ctrlKey,
            metaKey: ev.metaKey,
            deltaX: ev.deltaX,
            deltaY: ev.deltaY,
            clientX: ev.clientX + rect.left,
            clientY: ev.clientY + rect.top,
          }));
        }, { passive: false });
      } catch { /* ignore */ }
    }

    // Detect buffer prefix mutation on the same page. stripCodeFences may
    // remove the opening fence (```html\n) only after a partial fence (```)
    // has already been written to the iframe. When that happens, the buffer
    // no longer starts with what we previously wrote — reset the document
    // and rewrite from scratch so no orphaned backticks remain visible.
    if (!isPageIndexChange && lastInProgressHtmlRef.current) {
      const prev = lastInProgressHtmlRef.current;
      const shorter = inProgressHtml.length < prev.length ? inProgressHtml : prev;
      const longer = inProgressHtml.length < prev.length ? prev : inProgressHtml;
      if (!longer.startsWith(shorter)) {
        streamingWrittenRef.current = 0;
        // doc.open() 重置文档 → 元素游标归零
        streamSeenCountRef.current = 0;
        streamSweepCounterRef.current = 0;
        try { doc.open(); } catch { /* ignore */ }
        // prefix mutation 重置也需要重置 Mermaid 标志（同 page index change）
        try {
          const w = iframe.contentWindow as any;
          if (w) w.__xai_mermaid_initialized = false;
        } catch { /* ignore */ }
      }
    }
    lastInProgressHtmlRef.current = inProgressHtml;

    const newPart = inProgressHtml.substring(streamingWrittenRef.current);
    if (newPart) {
      const callback = onNewElementRef.current;

      try {
        doc.write(newPart);
      } catch (err) {
        console.warn('[DesignerCanvas] document.write failed, falling back to srcdoc:', err);
        iframe.srcdoc = inProgressHtml;
        const scrollOnLoad = () => {
          try {
            const d = iframe.contentDocument;
            if (d?.documentElement) {
              d.documentElement.scrollTop = d.documentElement.scrollHeight;
            }
          } catch { /* ignore */ }
          iframe.removeEventListener('load', scrollOnLoad);
        };
        iframe.addEventListener('load', scrollOnLoad);
      }
      streamingWrittenRef.current = inProgressHtml.length;

      // ── Mermaid 流式实时渲染（引擎自主初始化）───────────────────────
      // 流式 doc.write 期间 DOMContentLoaded 永远不会触发，AI 生成的
      // mermaid.initialize() 脚本（通常放在 HTML 末尾）不会在流式阶段执行。
      // 因此流式引擎需要自行初始化 Mermaid 并在每次 write 后调用
      // mermaid.run() 渲染新增的 <pre class="mermaid"> 块。
      // mermaid.run() 自动跳过已渲染的块（data-processed 属性），
      // suppressErrors 静默处理尚未完成的语法（下一次增量写入后重试）。
      try {
        const win = iframe.contentWindow as any;
        if (win?.mermaid && !win.__xai_mermaid_initialized) {
          win.mermaid.initialize({
            startOnLoad: false,
            theme: 'default',
            securityLevel: 'loose',
            flowchart: { useMaxWidth: true, htmlLabels: true, curve: 'basis' },
            sequence: { useMaxWidth: true, mirrorActors: false },
            themeVariables: {
              primaryColor: '#E8F4FD',
              primaryTextColor: '#1a1a2e',
              primaryBorderColor: '#4A90D9',
              lineColor: '#5C6BC0',
              secondaryColor: '#F3E5F5',
              tertiaryColor: '#E8F5E9',
              fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
            }
          });
          win.__xai_mermaid_initialized = true;
        }
        if (win?.mermaid?.run) {
          win.mermaid.run({ suppressErrors: true });
        }
      } catch { /* ignore — iframe may be disposed mid-call */ }

      // 同步 diff 新增元素：用 data-stream-seen 属性标记已处理元素，
      // querySelectorAll(':not([data-stream-seen])') 只返回新元素。
      //
      // 必须同步执行（doc.write 返回后、浏览器 paint 前），否则元素会短暂
      // 可见后被 opacity:0 隐藏（MutationObserver 是 microtask，会延迟到
      // paint 之后才隐藏 → 用户看到元素闪现后消失的 bug）。
      //
      // 效率：无需每帧 new WeakSet(querySelectorAll('*')) 快照，无需 Array.from
      // 转换。doc.open() 清除整个文档（含 data 属性），所有元素自动变为"新"。
      //
      // 高速 token 优化：纯文本增量不可能产生新元素 —— 跳过元素扫描。
      // 注意跨帧不完整标签（上一增量以 "<di" 结尾、本增量 "v>" 补全）：
      // 本增量含 '>' 时仍会扫描，故条件同时检查 '<' 与 '>'。
      const mayCreateNodes = newPart.includes('<') || newPart.includes('>');
      if (callback && doc.body && mayCreateNodes) {
        // 索引游标遍历（O(新增)）替代全量选择器匹配（O(E)）：
        // live 集合 + 游标只处理新增元素；hasAttribute 校验防止重复处理。
        const all = doc.body.getElementsByTagName('*');
        streamSweepCounterRef.current++;
        let start = streamSeenCountRef.current;
        // 集合收缩（罕见：解析器移动/删除节点）或每 200 次写入 → 从头兜底扫描
        if (all.length < start || streamSweepCounterRef.current >= 200) {
          start = 0;
          streamSweepCounterRef.current = 0;
        }
        for (let i = start; i < all.length; i++) {
          const el = all[i] as HTMLElement;
          if (el.hasAttribute('data-stream-seen')) continue;
          el.setAttribute('data-stream-seen', '');
          if (SKIP_TAGS.has(el.tagName.toLowerCase())) continue;
          el.style.opacity = '0';
          callback(el);
        }
        streamSeenCountRef.current = all.length;
      }

      // ── 实时注入共享母版到 slot 占位 ──────────────────────────────────
      // document.write 后检测 iframe DOM 中的 [data-design-slot]，若仍含
      // .xai-slot-placeholder 则立即替换为真实菜单 + 高亮当前页菜单项。
      // 幂等：已注入的 slot 跳过；CSS/Scripts 用固定 ID 替换。
      // 性能：已有 rAF 节流（每帧最多 1 次 write），注入检查在 write 后同步
      // 执行，只查 [data-design-slot] 选择器，无 slot 时立即返回。
      // 多页生成时 doc.open() 会清空 DOM，已注入的 MasterLayout 会丢失，
      // 下一页需要重新注入——这是自然的，每页的菜单高亮可能不同。
      if (masterLayoutsRef.current?.length && doc.body) {
        // 从 iframe <title> 提取 screenName 用于菜单文本匹配
        // （新建模式下 <title> 可能还没生成完，此时 screenName 为空，
        //  菜单不高亮；等 <title> 到达后的下一帧会自动补上高亮——渐进式体验）
        const title = doc.querySelector('title')?.textContent?.trim() || '';
        injectMasterLayoutsIntoDoc(
          doc,
          streamingScreenIdRef.current || '',
          title,
          masterLayoutsRef.current,
        );
      }

      // Auto-scroll so the latest generated content stays visible.
      // Skip when the cursor is actively processing elements (queue non-empty or
      // moving/drawing), because elementToTarget scrolls the iframe to bring each
      // target element into view. If we auto-scroll to bottom here, we'd undo that
      // positioning and cause coordinate misalignment for the cursor draw box.
      //
      // During the resting phase (cursorHasWorkRef=false): if the cursor has
      // committed a target before (lastCursorTargetElRef set & still in the DOM),
      // keep THAT element in view (vertical + horizontal) rather than jumping to
      // the bottom. Otherwise — e.g. two-column layout, right column's top region
      // — every token that produces no new element would yank the scrollbar back
      // to the bottom, fighting elementToTarget's scroll-up and making both the
      // scrollbar and the dashed cursor box jitter. Only when the cursor has
      // never committed a target (start of generation) do we fall back to the
      // original scroll-to-bottom.
      requestAnimationFrame(() => {
        if (cursorHasWorkRef?.current) return;
        try {
          const d = iframe.contentDocument;
          if (!d?.documentElement) return;
          const docEl = d.documentElement;
          const lastEl = lastCursorTargetElRef?.current;
          // 元素已随 doc.open()/页面切换被移除时,回退到底部
          if (lastEl && d.body && d.body.contains(lastEl)) {
            const rect = lastEl.getBoundingClientRect();
            const viewH = iframe.clientHeight;
            const viewW = iframe.clientWidth;
            // 垂直:元素不在视口内则滚到视口上方 1/3 处(与 elementToTarget 一致)
            if (rect.bottom < 0 || rect.top > viewH || rect.top < 0) {
              const elAbsTop = docEl.scrollTop + rect.top;
              docEl.scrollTop = Math.max(0, elAbsTop - viewH / 3);
            }
            // 水平:元素不在视口内则滚到视口左侧 1/4 处(与 elementToTarget 一致)
            if (rect.right < 0 || rect.left > viewW || rect.left < 0) {
              const elAbsLeft = docEl.scrollLeft + rect.left;
              docEl.scrollLeft = Math.max(0, elAbsLeft - viewW / 4);
            }
          } else {
            // 光标从未工作过(生成初期):保持原行为,滚到底部
            docEl.scrollTop = docEl.scrollHeight;
          }
        } catch { /* ignore */ }
      });
    }
  };

  /* ── 节流后的 streaming render effect ──────────────────────────────── */
  // 与原版唯一区别:html 高频变化时不再每 token 同步 write,而是每帧最多一次。
  // 若同帧已有 pending rAF 则跳过(回调会读 latestStreamingPagesRef,即最新 buffer);
  // 因 write 基于 streamingWrittenRef 增量游标,跳过的 token 不会丢失——下次 rAF
  // 执行时 substring(streamingWrittenRef) 会把累积的增量一次性写入。
  useEffect(() => {
    if (!isGenerating || !html || streamingPages.length === 0) return;

    if (rafPendingRef.current) return;
    rafPendingRef.current = true;
    requestAnimationFrame(() => {
      rafPendingRef.current = false;
      const pages = latestStreamingPagesRef.current;
      if (!latestHtmlRef.current || pages.length === 0) return;
      performStreamingWriteRef.current(pages);
    });
  }, [html, isGenerating, streamingPages]);

  /* ── Reset streaming state when generation starts/stops ────────────── */
  useEffect(() => {
    if (isGenerating) {
      streamingPageIndexRef.current = 0;
      streamingWrittenRef.current = 0;
      streamingStartedRef.current = false;
      lastInProgressHtmlRef.current = '';
      prevElementsRef.current = null;
      streamSeenCountRef.current = 0;
      streamSweepCounterRef.current = 0;
    } else {
      // Generation finished (or aborted) — 取消挂起的 rAF 并确定性销毁流式文档。
      // 注意：此处不再 flush 最后一次增量——该 iframe 随 StreamingPages 卸载即将
      // 移除，最终内容由 SavedPages 基于 htmlBuffer 渲染；flush 只会延长旧文档
      // 存活时间。旧实现试图在此 close() 文档，但 React 已先把外部 ref 置 null
      // （commit 早于 effect cleanup），close 从未执行 → 带脚本/定时器的文档滞留
      // 内存（每次「停止」泄漏一份）。现改用写入时捕获的 lastIframeRef 主动销毁。
      rafPendingRef.current = false;
      disposeStreamingIframe(lastIframeRef.current);
      lastIframeRef.current = null;
      streamingStartedRef.current = false;
      streamingWrittenRef.current = 0;
      lastInProgressHtmlRef.current = '';
      prevElementsRef.current = null;
    }
  }, [isGenerating]);

  return { streamingPages };
}
