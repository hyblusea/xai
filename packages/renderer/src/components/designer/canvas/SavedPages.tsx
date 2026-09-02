import { useRef, useLayoutEffect, useEffect, useState } from 'react';
import type { MutableRefObject } from 'react';
import type { SelectedElement } from '@xai/shared';
import type { AlignmentGuide } from '../../../hooks/useAlignmentGuides';
import type { FolderRow } from '../../../utils/designerFolderRows';
import ScreenOverlays from './ScreenOverlays';

interface Rect { x: number; y: number; width: number; height: number }

interface SavedPagesProps {
  folderRows: FolderRow[];
  currentScreenId: string | null;
  onSelectScreen?: (screenId: string) => void;
  deviceClass: string;
  iframeKey: number;
  /** 修改模式下正在生成的页面 id；该页会复用新增生成时的流光边框效果。 */
  generatingScreenId?: string | null;
  /** Ref callback to register each screen's iframe. */
  registerIframe: (screenId: string, el: HTMLIFrameElement | null) => void;
  /** Ref tracking HTML applied via direct DOM manipulation (style edits, drag,
   *  resize, etc.). When screen.html matches this value, the iframe DOM
   *  already reflects it and we skip the srcDoc reload. */
  directDomHtmlRef: MutableRefObject<Map<string, string>>;
  /** 手动重试加载某个 screen 的 HTML（用于加载失败的页面）。 */
  onReloadScreen?: (screenId: string) => Promise<boolean>;
  /** 加载失败的 screen id 集合（html='' 且加载失败，显示重试按钮而非 loading）。 */
  failedScreenIds?: Set<string>;
  showSelectionOverlay: boolean;
  selectedElement: SelectedElement | null;
  /** Canvas zoom — forwarded to ScreenOverlays. pan 已改为 ref + 直接 DOM 写入，
   *  不再作为 prop 传递（pan 变化不触发 React 重渲染，ScreenOverlays 通过
   *  'designer-canvas-transform' 自定义事件重算 toolbar 位置）。 */
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
  /** Live AI output text (thinking + content) for process display. */
  streamingText?: string;
  /** Screen ids with unsaved manual edits (shown as "*" next to file names). */
  dirtyScreenIds?: Set<string>;
}

/** Renders saved screens grouped into folder rows with iframes and overlays. */
export default function SavedPages({
  folderRows,
  currentScreenId,
  onSelectScreen,
  deviceClass,
  iframeKey,
  generatingScreenId,
  registerIframe,
  directDomHtmlRef,
  onReloadScreen,
  failedScreenIds,
  showSelectionOverlay,
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
  streamingText,
  dirtyScreenIds,
}: SavedPagesProps) {
  // 保存每个屏幕的滚动位置，在 iframe 因 srcDoc 变化重载后恢复。
  // applyStyleChange 直接改 DOM 后会 onHtmlChange → patchScreenHtml →
  // screen.html 变化 → iframe srcDoc 重载，浏览器默认重置滚动到顶部。
  // useLayoutEffect 在 React commit 后、浏览器 paint 前同步执行，
  // 此时新 srcDoc 已写入 DOM 属性但浏览器尚未开始重载 iframe，
  // contentWindow.scrollY 仍是重载前的位置 → 快照保存 → onLoad 恢复。
  const scrollMemoryRef = useRef<Map<string, { x: number; y: number }>>(new Map());

  // ── srcDoc reload-skip optimization ──────────────────────────────────
  // Problem: applyStyleChange (and drag/resize/layer ops) mutate the iframe
  // DOM directly for instant visual feedback, then call onHtmlChange to
  // persist. onHtmlChange → patchScreenHtml → screen.html changes →
  // srcDoc={screen.html} changes → iframe does a FULL reload (flash, lost
  // scroll/focus/interactive state). Since the DOM was already updated, the
  // reload is redundant.
  //
  // Solution: when directDomHtmlRef indicates the HTML came from direct DOM
  // manipulation, keep the old srcDoc (skip reload). Track DOM state to
  // handle undo/redo edge cases where screen.html reverts to the loaded
  // srcDoc value but the DOM was mutated.
  const loadedSrcDocRef = useRef<Map<string, string>>(new Map());
  const domHtmlRef = useRef<Map<string, string>>(new Map());
  const srcDocChangedRef = useRef<Map<string, boolean>>(new Map());
  const pendingReloadRef = useRef<Map<string, boolean>>(new Map());
  const [reloadCounters, setReloadCounters] = useState<Map<string, number>>(new Map());

  // 懒加载：只渲染已渲染过的 / active / generating 的 screen，其余用占位替代，
  // 避免 46 个 iframe 同时挂载导致卡顿。renderedScreenIds 记录已挂载过的 screen，
  // 一旦挂载就保持（防止来回滚动时 iframe 反复重建丢失状态）。
  const [renderedScreenIds, setRenderedScreenIds] = useState<Set<string>>(new Set());
  // 初始懒加载：项目首次加载时，只渲染当前选中页±3 范围内的 screen，
  // 其余滚动到可视区时由 IntersectionObserver 按需挂载。
  useEffect(() => {
    const allScreens = folderRows.flatMap(r => r.screens.map(s => s.screen.id));
    if (allScreens.length === 0) return;
    const activeIdx = currentScreenId ? allScreens.indexOf(currentScreenId) : 0;
    const baseIdx = activeIdx >= 0 ? activeIdx : 0;
    const window = 3;
    const initial = new Set<string>();
    for (let i = Math.max(0, baseIdx - window); i <= Math.min(allScreens.length - 1, baseIdx + window); i++) {
      initial.add(allScreens[i]);
    }
    setRenderedScreenIds(initial);
    // 仅在 currentScreenId 变化时重新计算初始集合（项目切换）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentScreenId]);

  // IntersectionObserver：滚动到可视区的 screen 按需加入 renderedScreenIds。
  // 已挂载的保持挂载（不卸载），避免反复重建 iframe 丢失状态。
  const cardRefs = useRef<Map<string, HTMLElement>>(new Map());
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        let changed = false;
        setRenderedScreenIds(prev => {
          let next = prev;
          for (const entry of entries) {
            if (entry.isIntersecting) {
              const id = (entry.target as HTMLElement).dataset.screenId;
              if (id && !next.has(id)) {
                if (next === prev) next = new Set(prev);
                next.add(id);
                changed = true;
              }
            }
          }
          return changed ? next : prev;
        });
      },
      { root: document.querySelector('.designer-canvas-wrapper'), rootMargin: '200px' }
    );
    for (const [, el] of cardRefs.current) {
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, [folderRows]);

  // screen 删除/项目切换时清理已不存在的 screenId 的 ref，防止内存泄漏。
  useEffect(() => {
    const allScreens = new Set(folderRows.flatMap(r => r.screens.map(s => s.screen.id)));
    for (const id of [...cardRefs.current.keys()]) {
      if (!allScreens.has(id)) cardRefs.current.delete(id);
    }
    for (const id of [...loadedSrcDocRef.current.keys()]) {
      if (!allScreens.has(id)) loadedSrcDocRef.current.delete(id);
    }
    for (const id of [...domHtmlRef.current.keys()]) {
      if (!allScreens.has(id)) domHtmlRef.current.delete(id);
    }
    for (const id of [...srcDocChangedRef.current.keys()]) {
      if (!allScreens.has(id)) srcDocChangedRef.current.delete(id);
    }
    for (const id of [...pendingReloadRef.current.keys()]) {
      if (!allScreens.has(id)) pendingReloadRef.current.delete(id);
    }
    setRenderedScreenIds(prev => {
      const next = new Set([...prev].filter(id => allScreens.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [folderRows]);

  // 每次 render 后同步快照所有 iframe 的滚动位置。
  // 只在非生成态执行（生成态 iframe 会频繁重载，无需保存）。
  // 性能优化：只遍历 srcDocChanged=true 的 screen（即将重载的），
  // 而非全部 46 个，避免每次 render 都查 46 个 contentWindow。
  useLayoutEffect(() => {
    const allScreens = folderRows.flatMap(r => r.screens.map(s => s.screen.id));
    const candidates = allScreens.filter(id => srcDocChangedRef.current.get(id));
    for (const screenId of candidates) {
      // 通过 data 属性查找 iframe（避免依赖外部 ref）
      const iframe = document.querySelector<HTMLIFrameElement>(
        `iframe[title][srcdoc][data-screen-id="${screenId}"]`
      );
      if (!iframe?.contentWindow) continue;
      try {
        const x = iframe.contentWindow.scrollX;
        const y = iframe.contentWindow.scrollY;
        if (x > 0 || y > 0) {
          scrollMemoryRef.current.set(screenId, { x, y });
        }
      } catch { /* cross-origin 时忽略 */ }
    }
  });

  // Consume direct-DOM flags after render (strict-mode safe: runs once after
  // the double render, so both renders see the flag consistently).
  useLayoutEffect(() => {
    directDomHtmlRef.current.clear();
  });

  // Edge-case detection: after a direct-DOM skip, if an external change
  // (undo/redo) reverts screen.html to the loaded srcDoc value, React won't
  // reload (srcDoc prop unchanged) but the DOM is stale. Force a remount via
  // per-screen key counter.
  useEffect(() => {
    const allScreens = folderRows.flatMap(r => r.screens.map(s => s.screen));
    for (const screen of allScreens) {
      if (pendingReloadRef.current.get(screen.id)) continue;
      if (srcDocChangedRef.current.get(screen.id)) continue;
      const domHtml = domHtmlRef.current.get(screen.id);
      if (domHtml !== undefined && screen.html !== domHtml) {
        pendingReloadRef.current.set(screen.id, true);
        setReloadCounters(prev => {
          const next = new Map(prev);
          next.set(screen.id, (next.get(screen.id) || 0) + 1);
          return next;
        });
      }
    }
  });

  return (
    <>
      {folderRows.map((row, rowIdx) => (
        <div key={row.folderName || `__root_${rowIdx}`} className="designer-folder-row">
          {row.folderName && (
            <div className="designer-folder-row-label">{row.folderName}</div>
          )}
          <div className="designer-folder-row-pages">
            {row.screens.map(({ screen, subFolderLabel }, idx) => {
              const isActive = currentScreenId === screen.id;
              const isGeneratingThis = generatingScreenId === screen.id;

              // ── Compute effective srcDoc ──────────────────────────────
              // Skip the srcDoc update (avoiding iframe reload) when the HTML
              // was applied via direct DOM manipulation — the iframe DOM
              // already reflects the new content. External changes (AI
              // generation, undo/redo, refresh) go through the normal srcDoc
              // update path and reload as expected.
              const directHtml = directDomHtmlRef.current.get(screen.id);
              const loadedSrc = loadedSrcDocRef.current.get(screen.id);
              const domHtml = domHtmlRef.current.get(screen.id);
              let effectiveSrcDoc: string;
              let srcDocChanged = false;
              if (loadedSrc === undefined) {
                // First mount — load screen HTML.
                effectiveSrcDoc = screen.html;
                loadedSrcDocRef.current.set(screen.id, screen.html);
                srcDocChanged = true;
              } else if (directHtml !== undefined && directHtml === screen.html) {
                // Direct DOM manipulation — iframe already shows this HTML.
                // Keep the old srcDoc to avoid a redundant reload.
                effectiveSrcDoc = loadedSrc;
                domHtmlRef.current.set(screen.id, screen.html);
              } else if (screen.html === domHtml) {
                // screen.html matches what's already in the DOM — no reload.
                effectiveSrcDoc = loadedSrc;
              } else if (screen.html !== loadedSrc) {
                // External change with different srcDoc — React will reload.
                effectiveSrcDoc = screen.html;
                loadedSrcDocRef.current.set(screen.id, screen.html);
                srcDocChanged = true;
              } else {
                // Edge case: screen.html === loadedSrc but DOM was mutated
                // by a prior direct-DOM edit (e.g. undo reverted to the
                // pre-edit state). srcDoc won't change → no React reload.
                // The useEffect above detects this and forces a remount via
                // reloadCounters.
                effectiveSrcDoc = loadedSrc;
              }
              srcDocChangedRef.current.set(screen.id, srcDocChanged);
              const reloadCounter = reloadCounters.get(screen.id) || 0;
              // 懒加载：只渲染已渲染过的 / active / generating 的 screen，
              // 其余用占位替代，避免 46 个 iframe 同时挂载导致卡顿。
              const shouldRender = isActive || isGeneratingThis || renderedScreenIds.has(screen.id);
              // 加载状态判断：串行加载时 html='' 表示尚未加载或加载失败。
              // failedScreenIds 区分两者：在集合中=加载失败（显示重试按钮），
              // 不在集合中=加载中（显示 loading spinner）。
              const isLoadFailed = !screen.html && !!failedScreenIds?.has(screen.id);
              const isLoading = !screen.html && !isLoadFailed;

              return (
                <div
                  key={screen.id}
                  className={`designer-page-card ${deviceClass} ${isActive ? 'active' : ''}`}
                  data-screen-id={screen.id}
                  ref={el => { if (el) cardRefs.current.set(screen.id, el); }}
                  onClick={() => onSelectScreen?.(screen.id)}
                >
                  <div className="designer-page-label">
                    {subFolderLabel && (
                      <span className="designer-subfolder-label">{subFolderLabel}</span>
                    )}
                    <span className="designer-page-label-text">
                      {screen.name}
                      {dirtyScreenIds?.has(screen.id) && <span className="designer-dirty-mark">*</span>}
                    </span>
                    <span className="designer-page-index">{idx + 1}</span>
                    {isGeneratingThis && streamingText && (
                      <span className="designer-streaming-text" title={streamingText}>
                        {streamingText}
                      </span>
                    )}
                  </div>
                  <div className={`designer-iframe-container ${deviceClass} ${isActive ? 'active-screen' : ''} ${isGeneratingThis ? 'generating' : ''}`}>
                    {isLoading ? (
                      <div className="designer-iframe-loading">
                        <div className="designer-iframe-loading-spinner" />
                      </div>
                    ) : isLoadFailed ? (
                      <div className="designer-iframe-retry">
                        <div className="designer-iframe-retry-icon">⚠</div>
                        <div className="designer-iframe-retry-text">页面加载失败</div>
                        <button
                          type="button"
                          className="designer-iframe-retry-btn"
                          onClick={async (e) => {
                            e.stopPropagation();
                            if (onReloadScreen) {
                              await onReloadScreen(screen.id);
                            }
                          }}
                        >重新加载</button>
                      </div>
                    ) : shouldRender ? (
                    <iframe
                      key={`screen-${screen.id}-${iframeKey}-${reloadCounter}`}
                      ref={el => registerIframe(screen.id, el)}
                      data-screen-id={screen.id}
                      className="designer-iframe"
                      sandbox="allow-same-origin allow-scripts"
                      title={screen.name}
                      srcDoc={effectiveSrcDoc}
                      onLoad={e => {
                        // Sync DOM tracking refs after iframe (re)load.
                        domHtmlRef.current.set(screen.id, screen.html);
                        pendingReloadRef.current.delete(screen.id);
                        const iframeEl = e.currentTarget as HTMLIFrameElement;
                        const doc = iframeEl.contentDocument;
                        if (!doc) return;
                        // 恢复重载前的滚动位置。
                        const saved = scrollMemoryRef.current.get(screen.id);
                        if (saved && (saved.x > 0 || saved.y > 0)) {
                          // 用 rAF 延迟一帧，确保文档已布局完成。
                          const w = iframeEl.contentWindow;
                          if (w) {
                            requestAnimationFrame(() => {
                              try { w.scrollTo(saved.x, saved.y); } catch { /* ignore */ }
                            });
                          }
                        }
                        // 阻止 <a href="#"> 触发顶层导航。
                        doc.addEventListener('click', (ev: MouseEvent) => {
                          const t = ev.target as HTMLElement;
                          const a = t.closest('a') as HTMLAnchorElement | null;
                          if (a) ev.preventDefault();
                        }, true);
                        // 转发 Ctrl/Cmd + 滚轮到父级画布容器以支持缩放。
                        doc.addEventListener('wheel', (ev: WheelEvent) => {
                          if (!(ev.ctrlKey || ev.metaKey)) return;
                          ev.preventDefault();
                          const parentWrapper = window.parent.document.querySelector('.designer-canvas-wrapper');
                          if (!parentWrapper) return;
                          const rect = iframeEl.getBoundingClientRect();
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
                      }}
                    />
                    ) : (
                      <div className="designer-iframe-placeholder" />
                    )}
                    {isActive && (
                      <ScreenOverlays
                        showSelection={showSelectionOverlay}
                        selectedElement={selectedElement}
                        zoom={zoom}
                        onAddElementToChat={onAddElementToChat}
                        onDeleteElement={onDeleteElement}
                        onSelectParent={onSelectParent}
                        onDuplicate={onDuplicate}
                        onSwapPrevious={onSwapPrevious}
                        onSwapNext={onSwapNext}
                        onZIndexUp={onZIndexUp}
                        onZIndexDown={onZIndexDown}
                        onDeselect={onDeselect}
                        hoveredSelector={hoveredSelector}
                        hoveredRect={hoveredRect}
                        alignmentGuides={alignmentGuides}
                      />
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </>
  );
}
