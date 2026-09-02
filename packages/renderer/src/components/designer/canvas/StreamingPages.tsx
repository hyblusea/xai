import { useRef, useCallback } from 'react';
import type { ProjectType, MasterLayout } from '@xai/shared';
import { extractTitle } from '../../../utils/designerFolderRows';
import { postProcessDesignerHtml } from '../../../utils/designerScrollbar';
import { sanitizeLayoutHtml } from '../../../utils/masterLayoutDom';
import { disposeStreamingIframe } from '../../../hooks/useDesignerStreaming';

interface StreamingPagesProps {
  /** Raw streaming HTML buffer (may contain page-break delimiters). */
  html: string;
  /** Parsed streaming pages (split by page-break delimiter). */
  streamingPages: string[];
  /** Device class string ('tablet' | 'mobile' | ''). */
  deviceClass: string;
  /** Live AI output text (thinking + content) for process display. */
  streamingText: string;
  /** Ref callback to capture the active streaming iframe. */
  streamingIframeRef: (el: HTMLIFrameElement | null) => void;
  /** Project type for postProcessDesignerHtml (scrollbar styles etc.). */
  projectType?: ProjectType;
  /** Theme prompt for theme-aware post-processing. */
  themePrompt?: string;
  /** 共享母版：已完成页用 postProcessDesignerHtml 注入菜单到 slot 并高亮。
   *  无母版时传 undefined / 空数组，完全跳过注入（向后兼容）。 */
  masterLayouts?: MasterLayout[];
}

/**
 * 转发 Ctrl/Cmd + 滚轮到父级画布容器以支持缩放。
 * srcDoc iframe 无 doc.open() 时机，在 onLoad 后挂载。
 */
function attachIframeWheelForward(iframe: HTMLIFrameElement): void {
  try {
    const doc = iframe.contentDocument;
    if (!doc) return;
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
  } catch { /* cross-origin or detached — ignore */ }
}

/**
 * 已完成页的惰性 srcDoc 计算（每页只算一次，结果按页索引缓存）。
 *
 * 内存控制核心（OOM 修复）：
 *  1. 已完成页内容在流式 buffer 中只增不改（PAGE BREAK 分隔符一旦输出，其前
 *     内容即固定），因此按索引缓存处理结果在一次生成会话内永远有效；
 *  2. 处理结果会剥离全部 <script>（sanitizeLayoutHtml），且 iframe sandbox
 *     不带 allow-scripts —— 已完成页以纯静态文档渲染：无 V8 脚本上下文、
 *     无 CDN JS 下载执行、无定时器/动画循环。脚本在该页作为"当前页"流式
 *     生成时已经运行过，视觉结果已定型；
 *  3. 由此不管一次生成多少页，实时渲染只消耗"当前流式页(带脚本) + 已完成页
 *     的静态 DOM"，内存随页数增长极缓且完全可控，无需占位卡片。
 */
function buildInertSrcDoc(
  cleaned: string,
  hasLayouts: boolean,
  projectType: ProjectType | undefined,
  themePrompt: string | undefined,
  masterLayouts: MasterLayout[] | undefined,
): string {
  let out = cleaned;
  if (hasLayouts) {
    out = postProcessDesignerHtml(
      out,
      projectType ?? 'WEB',
      themePrompt,
      { screenId: '', screenName: extractTitle(out), layouts: masterLayouts! },
    );
  }
  // 剥离所有 <script>（含 postProcess 注入的 Bootstrap JS）→ 惰性静态页。
  // sandbox 无 allow-scripts 是第二重保险：即使残留脚本也不会执行。
  return sanitizeLayoutHtml(out);
}

/** Renders the streaming page cards while the LLM is generating. */
export default function StreamingPages({
  html,
  streamingPages,
  deviceClass,
  streamingText,
  streamingIframeRef,
  projectType,
  themePrompt,
  masterLayouts,
}: StreamingPagesProps) {
  const hasLayouts = !!masterLayouts && masterLayouts.length > 0;

  // ── 已完成页惰性 srcDoc 缓存 ─────────────────────────────────────────
  // 旧实现用 useMemo 依赖 streamingPages（每次 html 更新都是新数组，约 10Hz），
  // 导致每次更新都对【全部】已完成页重跑 postProcessDesignerHtml（含 DOMParser
  // 全量解析 + 序列化）——页数越多开销越大，临时 DOM 文档大量堆积，是 OOM 的
  // 放大器。现改为按页索引缓存：已完成页不可变，处理一次永久有效；缓存随组件
  // 卸载（生成结束/停止）整体释放。sig 覆盖处理参数变化（理论上生成期间不变，
  // 防御项目切换等边界）。
  const inertCacheRef = useRef<{ sig: string; map: Map<number, string> }>({ sig: '', map: new Map() });
  const sig = `${projectType ?? 'WEB'}|${themePrompt ?? ''}|${
    hasLayouts ? masterLayouts!.map(l => `${l.id}:${(l.html || '').length}`).join(',') : ''
  }`;
  if (inertCacheRef.current.sig !== sig) {
    inertCacheRef.current = { sig, map: new Map() };
  }
  const getInertSrcDoc = (idx: number, cleaned: string): string => {
    const map = inertCacheRef.current.map;
    const hit = map.get(idx);
    if (hit !== undefined) return hit;
    const out = buildInertSrcDoc(cleaned, hasLayouts, projectType, themePrompt, masterLayouts);
    map.set(idx, out);
    return out;
  };

  // ── 流式 iframe ref 包装：旧元素被替换/卸载时确定性销毁其文档 ──────────
  // 两种销毁时机：
  //  1. PAGE BREAK 翻页：React 重挂载流式 iframe（新元素），旧元素被替换 →
  //     立即销毁旧文档（含脚本/定时器），避免滞留；
  //  2. 组件卸载（生成结束/停止/视图切换）：ref 收到 null → 延迟一个微任务
  //     确认不是"ref 回调 identity 变化导致的 null→el 同元素重注册"后再销毁。
  // 双保险：useDesignerStreaming 在 isGenerating=false 时也会 dispose 一次（幂等）。
  const streamingElRef = useRef<HTMLIFrameElement | null>(null);
  const handleStreamingIframeRef = useCallback((el: HTMLIFrameElement | null) => {
    const prev = streamingElRef.current;
    streamingElRef.current = el;
    streamingIframeRef(el);
    if (el && prev && el !== prev) {
      // 翻页 remount：旧流式文档立即销毁
      disposeStreamingIframe(prev);
    } else if (!el && prev) {
      queueMicrotask(() => {
        // 若同一元素已重新注册（identity 变化引起的重注册），跳过销毁
        if (streamingElRef.current !== prev) disposeStreamingIframe(prev);
      });
    }
  }, [streamingIframeRef]);

  if (!html.trim()) {
    // html still empty — show placeholder frame immediately
    return (
      <div className={`designer-page-card ${deviceClass}`}>
        <div className="designer-page-label">
          <span className="designer-page-label-text">页面 1</span>
          {streamingText && (
            <span className="designer-streaming-text" title={streamingText}>
              {streamingText}
            </span>
          )}
        </div>
        <div className={`designer-iframe-container ${deviceClass} generating`}>
          <iframe
            ref={handleStreamingIframeRef}
            className="designer-iframe"
            sandbox="allow-same-origin allow-scripts"
            title="Streaming Page 1"
          />
        </div>
      </div>
    );
  }

  return (
    <>
      {streamingPages.map((pageHtml, idx) => {
        const isLast = idx === streamingPages.length - 1;
        const cleaned = pageHtml.trim();
        if (!cleaned && !isLast) return null;
        return (
          <div key={`stream-${idx}`} className={`designer-page-card ${deviceClass}`}>
            <div className="designer-page-label">
              <span className="designer-page-label-text">
                {extractTitle(cleaned) || `页面 ${idx + 1}`}
              </span>
              {isLast && streamingText && (
                <span className="designer-streaming-text" title={streamingText}>
                  {streamingText}
                </span>
              )}
            </div>
            <div className={`designer-iframe-container ${deviceClass} ${isLast ? 'generating' : 'inert'}`}>
              {isLast ? (
                // key 区分流式/已完成两种 iframe：PAGE BREAK 翻页时 React 必须
                // 卸载旧的流式元素并挂载新元素，而不是复用同一元素只换 props。
                // 若复用，ref(null) 后的 dispose 会把被 React 复用承载已完成页
                // 内容的元素 srcdoc 清空 → 已完成页变空白（OOM 修复的回归点）。
                <iframe
                  key="streaming-live"
                  ref={handleStreamingIframeRef}
                  className="designer-iframe"
                  sandbox="allow-same-origin allow-scripts"
                  title={`Streaming Page ${idx + 1}`}
                />
              ) : (
                // 已完成页：惰性静态渲染（真实内容，非占位卡片）。
                // srcDoc 已剥离脚本 + sandbox 禁用脚本执行（见 buildInertSrcDoc），
                // 每页只在首次完成时处理一次（inertCacheRef 缓存），离屏时由
                // CSS content-visibility 跳过渲染 —— 无论生成多少页，实时渲染
                // 只聚焦当前流式页，内存始终可控。
                <iframe
                  key={`completed-${idx}`}
                  className="designer-iframe"
                  sandbox="allow-same-origin"
                  title={`Page ${idx + 1}`}
                  srcDoc={getInertSrcDoc(idx, cleaned)}
                  onLoad={(e) => attachIframeWheelForward(e.target as HTMLIFrameElement)}
                />
              )}
            </div>
          </div>
        );
      })}
    </>
  );
}
