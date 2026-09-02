import { useState, useCallback, useEffect, useRef } from 'react';
import { IPCChannel } from '@xai/shared';
import type { DesignerProject, DesignerScreen, ProjectType, SelectedElement, ElementStyle, ChatTag, Publication, CreatePublicationRequest, ScreenHistorySummary, ScreenHistoryContent, MasterLayout } from '@xai/shared';
import { parseThemePrompt, buildBootstrapTheme } from '@xai/shared';
import { useIpc } from './useIpc';
import { injectScrollbarStyles, ensureBootstrapCdn, postProcessDesignerHtml } from '../utils/designerScrollbar';
import { enforceSlotCompliance, replaceElementWithSlot, injectMasterLayouts } from '../utils/masterLayoutInject';
import { masterLayoutTypeLabel } from '../utils/masterLayoutDom';
import { validateDesignerHtml, summarizeIssues } from '../utils/designerValidator';

/* ── Toast types ────────────────────────────────────────────────────────── */
export interface Toast {
  id: string;
  type: 'success' | 'error' | 'info' | 'warning';
  message: string;
}

/* ── Public API ─────────────────────────────────────────────────────────── */
export interface UseDesignerAgentReturn {
  projects: DesignerProject[];
  currentProject: DesignerProject | null;
  currentScreenId: string | null;
  htmlBuffer: string;
  isGenerating: boolean;
  streamingText: string;
  toasts: Toast[];
  selectedElement: SelectedElement | null;
  chatTags: ChatTag[];

  generateHtml: (prompt: string) => void;
  abortGeneration: () => void;
  saveCurrentHtml: () => Promise<void>;
  /** Set of screen ids with unsaved manual edits (drag/resize/style/delete/undo). */
  dirtyScreenIds: Set<string>;
  /** Manually save the current screen's HTML to the backend and clear its dirty flag. */
  saveCurrentScreen: () => Promise<void>;
  /** Save ALL dirty screens to the backend and clear their dirty flags. */
  saveAllDirtyScreens: () => Promise<void>;
  createProject: (name: string, type: ProjectType, basePath?: string, themePrompt?: string) => Promise<void>;
  deleteProject: (projectId: string) => Promise<void>;
  renameProject: (projectId: string, newName: string) => Promise<void>;
  updateProjectTheme: (projectId: string, themePrompt: string) => Promise<boolean>;
  loadProject: (projectId: string) => void;
  loadScreen: (projectId: string, screenId: string) => void;
  reloadCurrentProject: () => Promise<void>;
  /** 手动重试加载某个失败 screen 的 HTML。成功后从 failedScreenIds 移除并 patch 到 state。 */
  reloadScreen: (screenId: string) => Promise<boolean>;
  /** 加载失败的 screen id 集合（html='' 且加载失败，显示重试按钮而非 loading）。 */
  failedScreenIds: Set<string>;
  deselectScreen: () => void;
  /** 创建一个空白页面并加载到画布上（默认命名 Untitled-N）。 */
  createBlankScreen: () => Promise<void>;
  /** 导入 HTML 文件作为新页面保存到数据库（逻辑与新建相同）。 */
  importHtmlScreen: (html: string, screenName: string, folderPath?: string) => Promise<void>;
  /** 在「新建」和「修改」模式间切换。新建=清空画布(空白页)；修改=恢复之前选中的页面。 */
  switchDesignerMode: (mode: 'new' | 'edit') => void;
  /** 是否可切回「修改」模式（即之前有选中页面）。 */
  canSwitchToEdit: boolean;
  deleteScreen: (projectId: string, screenId: string) => Promise<void>;
  renameScreen: (projectId: string, screenId: string, newName: string) => Promise<void>;
  duplicateScreen: (projectId: string, screenId: string) => Promise<void>;
  refreshProjects: () => Promise<void>;
  dismissToast: (id: string) => void;
  // Element selection
  selectElement: (el: SelectedElement | null) => void;
  updateElementStyle: (selector: string, style: Partial<ElementStyle>) => void;
  addElementToChat: () => void;
  addScreenToChat: (projectId: string, screenId: string) => void;
  deleteElement: (selector: string) => void;
  updateHtml: (html: string) => void;
  removeChatTag: (tagId: string) => void;
  restoreChatTags: (tags: ChatTag[]) => void;
  // Folder management
  moveScreen: (projectId: string, screenId: string, folderPath: string) => Promise<void>;
  createFolder: (projectId: string, folderPath: string) => Promise<void>;
  deleteFolder: (projectId: string, folderPath: string) => Promise<void>;
  renameFolder: (projectId: string, folderPath: string, newName: string) => Promise<void>;
  // Home screen
  setHomeScreen: (projectId: string, screenId: string | null) => Promise<void>;
  // Reorder screen
  reorderScreen: (screenId: string, targetScreenId: string, insertBefore: boolean) => Promise<void>;
  // AI theme
  applyTheme: (prompt: string, scope: 'project' | 'screen') => void;
  // Export to Vue 3 project
  exportVue: (projectId: string, outputDir: string) => Promise<void>;
  // Undo / Redo
  // The optional `onApplied` callback is invoked synchronously with the
  // target (screenId, html) right after the new HTML is computed and
  // patchScreenHtml is queued. Callers (e.g. DesignerCanvas) use it to
  // write the HTML directly to the iframe DOM and set the skip-reload
  // flag, so SavedPages avoids a full srcDoc reload (no flicker).
  undo: (onApplied?: (screenId: string, html: string) => void) => void;
  redo: (onApplied?: (screenId: string, html: string) => void) => void;
  canUndo: boolean;
  canRedo: boolean;
  // AI 操作前置权限弹窗
  permissionWarning: { folderPath: string; message: string } | null;
  dismissPermissionWarning: () => void;
  // 新建页面目录选择弹窗
  folderSelectDialog: { projectId: string } | null;
  onFolderSelect: (folderPath: string) => void;
  onFolderSelectCancel: () => void;
  // Publication (设计图发布)
  createPublication: (projectId: string, req: CreatePublicationRequest) => Promise<Publication | null>;
  listPublications: (projectId: string) => Promise<Publication[]>;
  deletePublication: (projectId: string, publicationId: number) => Promise<boolean>;
  refreshPublication: (projectId: string, publicationId: number) => Promise<Publication | null>;
  // Screen History (设计稿历史版本)
  listScreenHistory: (screenId: string) => Promise<ScreenHistorySummary[]>;
  getScreenHistoryContent: (screenId: string, historyId: number) => Promise<ScreenHistoryContent | null>;
  restoreScreenHistory: (screenId: string, historyId: number) => Promise<DesignerScreen | null>;

  /* ── 共享母版（MasterLayout） ───────────────────────────────────────── */
  /** 提取页面元素为共享母版（由提取对话框确认时调用）。 */
  extractMasterLayout: (layout: MasterLayout, sourceScreenId: string, selector: string) => Promise<void>;
  /** 保存母版编辑并同步到所有页面（由管理对话框保存时调用）。 */
  applyMasterLayoutEdit: (layout: MasterLayout) => Promise<void>;
  /** 删除共享母版（已注入页面保留现有菜单快照）。 */
  deleteMasterLayout: (layoutId: string) => Promise<void>;
}

/* ── Helper ─────────────────────────────────────────────────────────────── */
function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function formatDate(ts: number): string {
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * Extract clean HTML from LLM output by stripping:
 *   1. Leading prose/explanatory text before the HTML
 *   2. Markdown code fences (```html ... ``` or ``` ... ```)
 *   3. Trailing closing fence AND any prose after it
 *
 * Streaming-safe: a partial opening fence (e.g. "```" or "```ht" WITHOUT a
 * trailing newline) is NOT treated as a fence — we wait for the newline so
 * we don't prematurely strip prose or leak the language tag ("html") into
 * the iframe as visible text.
 *
 * Idempotent: safe to call multiple times on already-stripped text. This is
 * important because the buffer is stripped once in the chunk handler, then
 * stripCodeFences is re-applied per-page in parsePages / useDesignerStreaming.
 * A guard ensures a lone closing fence (leftover from a prior partial strip)
 * is not misinterpreted as an opening fence — which would discard the HTML
 * and return only trailing prose (the "all elements disappear" bug).
 *
 * When no complete opening fence is found, we look for the start of an HTML
 * document (<!DOCTYPE or <html>) and strip any prose before it. If neither
 * is found (pure prose, HTML hasn't arrived yet), we return '' so the canvas
 * shows a placeholder instead of raw prose.
 */
export function stripCodeFences(text: string): string {
  if (!text) return '';

  // 1. Find a COMPLETE opening code fence (``` + optional language + newline)
  //    ANYWHERE in the text — not just at the start — to handle leading prose
  //    before the fence. The \r?\n is REQUIRED so partial fences during
  //    streaming (just "```" or "```ht" without a newline) are not prematurely
  //    stripped, which would leak the language tag as visible text.
  const openFenceMatch = text.match(/```[ \t]*(?:[a-zA-Z]+)?[ \t]*\r?\n/);
  if (openFenceMatch && openFenceMatch.index !== undefined) {
    const afterOpen = text.substring(openFenceMatch.index + openFenceMatch[0].length);
    // Guard against misinterpreting a lone CLOSING fence as an opening fence.
    // This happens when stripCodeFences is re-applied to already-stripped text
    // that still contains a leftover closing ``` (because the first strip
    // couldn't remove it — trailing prose prevented the end-anchored regex from
    // matching). In that case afterOpen is the trailing prose (starts with
    // non-'<'), and treating ``` as an opening fence would discard the real
    // HTML that precedes it. Fall through to the no-opening-fence branch,
    // which strips the trailing ``` correctly.
    const afterOpenTrimmed = afterOpen.trimStart();
    if (afterOpenTrimmed && afterOpenTrimmed.startsWith('<')) {
      // Find the LAST standalone closing fence (a line that is just ```),
      // anywhere after the opening fence — not only at the very end. This
      // handles trailing prose/explanation that the LLM emits after the
      // closing fence (e.g. "## 页面功能说明 ..."). The LAST match is used so
      // that intermediate per-page fences (multi-page output split by
      // PAGE_BREAK) are preserved for parsePages to handle.
      const closeFenceRegex = /^[ \t]*```[ \t]*$/gm;
      let lastCloseIndex = -1;
      let m: RegExpExecArray | null;
      while ((m = closeFenceRegex.exec(afterOpen)) !== null) {
        lastCloseIndex = m.index;
      }
      if (lastCloseIndex >= 0) {
        // Return content between opening and last closing fence, discarding
        // the closing fence and any trailing prose after it.
        return afterOpen.substring(0, lastCloseIndex);
      }
      // No closing fence yet (still streaming) — return everything after the
      // opening fence so partial HTML renders incrementally.
      return afterOpen;
    }
    // afterOpen doesn't look like HTML content — the matched ``` is likely a
    // closing fence. Fall through to the no-opening-fence branch.
  }

  // 2. No (valid) opening fence found. Any ``` in the text is a closing
  //    fence. Strip it and any trailing prose after it: find the FIRST
  //    standalone ``` (a line that is just ```) and truncate there. This
  //    handles both a trailing ``` at the very end and a ``` in the middle
  //    followed by explanatory prose. Falls back to the end-anchored strip
  //    for a non-standalone trailing ``` (e.g. inline at end of a line).
  let result = text;
  const closingFenceMatch = result.match(/^[ \t]*```[ \t]*$/m);
  if (closingFenceMatch && closingFenceMatch.index !== undefined) {
    result = result.substring(0, closingFenceMatch.index);
  } else {
    result = result.replace(/\r?\n?[ \t]*```\s*$/, '');
  }

  // 3. If the result doesn't start with HTML, find the first HTML document
  //    start (<!DOCTYPE or <html>) and strip any leading prose before it.
  const htmlStartMatch = result.match(/<!DOCTYPE\s+html[\s>]/i) || result.match(/<html[\s>]/i);
  if (htmlStartMatch && htmlStartMatch.index !== undefined && htmlStartMatch.index > 0) {
    result = result.substring(htmlStartMatch.index);
  }

  // 4. If no HTML detected (pure prose, fence not yet complete), return ''
  //    so the canvas shows a placeholder instead of raw prose text.
  const trimmed = result.trimStart();
  if (!trimmed || !trimmed.startsWith('<')) {
    return '';
  }

  return result;
}

/** Delimiter used to separate multiple HTML pages in LLM output. */
const PAGE_BREAK_DELIMITER = '<!-- PAGE BREAK -->';

/**
 * Extract the <head>...</head> block from a complete HTML document.
 * Returns '' if no <head> block is found.
 */
function extractHead(html: string): string {
  const match = html.match(/<head[^>]*>[\s\S]*?<\/head>/i);
  return match ? match[0] : '';
}

/**
 * Check whether a string looks like a complete HTML document (starts with
 * <!DOCTYPE html> or <html> after trimming leading whitespace/prose).
 */
function isCompleteHtmlDocument(text: string): boolean {
  if (!text) return false;
  const trimmed = text.trimStart();
  return /^<!DOCTYPE\s+html[\s>]/i.test(trimmed) || /^<html[\s>]/i.test(trimmed);
}

/**
 * Strip the leading `style="display:none;"` (and similar display:none inline
 * styles) from the FIRST top-level element of a fragment. This handles the
 * SPA-tab pattern where AI wraps non-active pages in a hidden div.
 *
 * Only the root element's inline style is touched; nested elements keep their
 * styles. If the fragment's root isn't a tag with a style attribute containing
 * display:none, the fragment is returned unchanged.
 *
 * Leading HTML comments (e.g. `<!-- PAGE 2: 空调 -->`) and whitespace before
 * the root element are preserved — only the root tag's style attribute is
 * modified.
 */
function stripRootDisplayNone(fragment: string): string {
  // Skip leading whitespace and HTML comments to locate the first real element
  // tag. Comments like <!-- PAGE 2: ... --> must not be mistaken for the root.
  let offset = 0;
  while (offset < fragment.length) {
    const rest = fragment.substring(offset);
    // Skip leading whitespace
    const wsMatch = rest.match(/^\s+/);
    if (wsMatch) { offset += wsMatch[0].length; continue; }
    // Skip HTML comments <!-- ... -->
    const commentMatch = rest.match(/^<!--[\s\S]*?-->/);
    if (commentMatch) { offset += commentMatch[0].length; continue; }
    break;
  }
  const rest = fragment.substring(offset);
  // Match the first opening tag and capture its style attribute (if any).
  const tagMatch = rest.match(/^<([a-zA-Z][\w-]*)\b([^>]*)>/);
  if (!tagMatch) return fragment;
  const attrs = tagMatch[2];
  const styleMatch = attrs.match(/\bstyle\s*=\s*"([^"]*)"/i);
  if (!styleMatch) return fragment;
  const styleValue = styleMatch[1];
  // Only strip if display:none is present in the inline style.
  if (!/display\s*:\s*none\s*;?/i.test(styleValue)) return fragment;
  // Remove the display:none; declaration (and a trailing space if left over).
  let newStyle = styleValue.replace(/display\s*:\s*none\s*;?\s*/i, '');
  newStyle = newStyle.trim();
  // Rebuild the attribute string: replace the old style="..." with the new one,
  // or remove the style attribute entirely if nothing remains.
  let newAttrs: string;
  if (newStyle) {
    newAttrs = attrs.replace(styleMatch[0], `style="${newStyle}"`);
  } else {
    newAttrs = attrs.replace(/\s*style\s*=\s*"[^"]*"\s*/i, ' ');
  }
  // Rebuild: prefix (whitespace + comments) + new tag + rest of fragment.
  const newTag = `<${tagMatch[1]}${newAttrs}>`;
  return fragment.substring(0, offset) + newTag + rest.substring(tagMatch[0].length);
}

/**
 * Wrap a bare HTML fragment (not a complete document) into a full document
 * using the provided <head> block. The fragment's root display:none style
 * (if any) is stripped first.
 *
 * Used to rescue "pages" that the LLM emitted as bare divs (SPA-tab pattern)
 * instead of complete <!DOCTYPE html> documents. Without this, those pages
 * would render blank because their root has style="display:none" and they
 * lack Bootstrap CDN + theme CSS.
 *
 * @param fragment  The bare HTML fragment (e.g. `<div id="page-x" style="display:none;">...</div>`)
 * @param headBlock The <head>...</head> block to reuse (from the first page).
 * @returns A complete HTML document string.
 */
function wrapFragmentWithHead(fragment: string, headBlock: string): string {
  const cleaned = stripRootDisplayNone(fragment.trim());
  const safeHead = headBlock || '<head><meta charset="UTF-8"></head>';
  return `<!DOCTYPE html>\n<html lang="zh-CN">\n${safeHead}\n<body>\n${cleaned}\n</body>\n</html>`;
}

/**
 * Parse a (possibly multi-page) HTML buffer into individual page HTML strings.
 * Splits by the PAGE BREAK delimiter and trims whitespace. Empty pages are
 * discarded. Code fences are stripped from each page.
 *
 * For pages that are NOT complete HTML documents (the LLM emitted a bare div
 * fragment, typical of SPA-tab output), they are wrapped into complete
 * documents reusing the <head> block from the first complete page. This
 * ensures every saved page has Bootstrap CDN + theme CSS, so theme editing
 * (ensureThemeInjection) and proper rendering both work.
 */
function parsePages(buffer: string): string[] {
  if (!buffer || !buffer.trim()) return [];
  const rawPages = buffer.split(PAGE_BREAK_DELIMITER);
  const cleanedPages: string[] = [];
  for (const raw of rawPages) {
    const cleaned = stripCodeFences(raw).trim();
    if (cleaned) cleanedPages.push(cleaned);
  }
  if (cleanedPages.length === 0) return [];

  // Find the <head> block from the first complete HTML document.
  // Subsequent non-complete fragments will reuse it.
  let sharedHead = '';
  for (const page of cleanedPages) {
    if (isCompleteHtmlDocument(page)) {
      sharedHead = extractHead(page);
      break;
    }
  }

  const pages: string[] = [];
  for (const page of cleanedPages) {
    if (isCompleteHtmlDocument(page)) {
      pages.push(page);
    } else if (sharedHead) {
      // Bare fragment — wrap with the shared head so it gets Bootstrap CDN +
      // theme CSS, and strip any root display:none so content is visible.
      pages.push(wrapFragmentWithHead(page, sharedHead));
    } else {
      // No complete page found yet (shouldn't normally happen) — keep as-is.
      pages.push(page);
    }
  }
  return pages;
}

/**
 * Streaming-safe variant of parsePages for use during streaming. Same
 * wrapping logic but exposed so useDesignerStreaming can apply it per-chunk
 * without re-implementing the head extraction / fragment wrapping.
 *
 * Given the array of page strings (already split + fence-stripped), returns
 * the array with bare fragments wrapped using the shared <head>.
 */
export function wrapStreamingPages(pages: string[]): string[] {
  if (pages.length === 0) return pages;
  let sharedHead = '';
  for (const page of pages) {
    if (isCompleteHtmlDocument(page)) {
      sharedHead = extractHead(page);
      break;
    }
  }
  if (!sharedHead) return pages;
  return pages.map(page =>
    isCompleteHtmlDocument(page) ? page : wrapFragmentWithHead(page, sharedHead)
  );
}

/**
 * Extract the <title> text from an HTML document. Falls back to a generic
 * name based on the page index if no title is found.
 */
function extractPageTitle(html: string, fallbackIndex: number): string {
  const match = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  const title = match?.[1]?.trim();
  if (title) return title;
  return `Page ${fallbackIndex + 1}`;
}

/* ── Hook ───────────────────────────────────────────────────────────────── */
export function useDesignerAgent(): UseDesignerAgentReturn {
  const { invoke, on, removeListener } = useIpc();
  const [projects, setProjects] = useState<DesignerProject[]>([]);
  const [currentProject, setCurrentProject] = useState<DesignerProject | null>(null);
  const [currentScreenId, setCurrentScreenId] = useState<string | null>(null);
  const [htmlBuffer, setHtmlBuffer] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [streamingText, setStreamingText] = useState('');
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [selectedElement, setSelectedElement] = useState<SelectedElement | null>(null);
  const [chatTags, setChatTags] = useState<ChatTag[]>([]);
  const [permissionWarning, setPermissionWarning] = useState<{ folderPath: string; message: string } | null>(null);
  const [folderSelectDialog, setFolderSelectDialog] = useState<{ projectId: string } | null>(null);
  // 用户从「修改」切到「新建」时记住当前 screenId，以便切回「修改」时恢复。
  // 只有此值非空时，switch 的「修改」一侧才可点击。
  const [savedScreenId, setSavedScreenId] = useState<string | null>(null);
  // 挂起的新建页面数据（等待用户选择目录后保存）
  const pendingSaveRef = useRef<{ pages: string[]; screenNames: string[]; baseIndex: number } | null>(null);

  // Screens with unsaved manual edits (drag/resize/style/delete/undo/redo).
  // Driving a Set<string> through React state so the toolbar save button and
  // the "*" dirty marker on file names re-render automatically.
  const [dirtyScreenIds, setDirtyScreenIds] = useState<Set<string>>(new Set());

  // 加载失败的 screen id 集合。loadProject 串行加载时，html='' 但不在该集合中
  // 的页面表示"加载中"，在该集合中的表示"加载失败"。区分两者让 SavedPages
  // 分别显示 loading spinner 或重试按钮。
  const [failedScreenIds, setFailedScreenIds] = useState<Set<string>>(new Set());

  // Undo / Redo history
  const historyRef = useRef<string[]>([]);
  const historyIndexRef = useRef<number>(-1);
  const isUndoRedoRef = useRef<boolean>(false);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const HISTORY_LIMIT = 50;

  const htmlBufferRef = useRef('');
  // rAF 防重入标志：把每 token 的所有昂贵工作（stripCodeFences + maybeIncrementalSave
  // + setHtmlBuffer + setStreamingText）合并为每帧最多一次。
  //
  // 历史问题：之前 stripCodeFences(L593) + maybeIncrementalSave(L596, 内部跑 parsePages)
  // 每 token 同步执行，对 10 页 790KB 累积 19.5s 同步主线程占用（实测 _perf-repro.js）
  // → 96% 主线程占用 → renderer unresponsive → window.ts:140 forcefullyCrashRenderer
  // → exitCode=-36861 崩溃。改动 3（增量保存）让情况更糟。
  //
  // 现在：handleChunk 只做 rawChunksRef.current.push(text)（O(1)，array push），
  // 不再用 string += （JS 字符串不可变，+= 每次 O(N) 复制整个旧串 → 高速 token
  // 下 100MB/s 垃圾 → OOM exitCode=-536870904）。
  // stripCodeFences/parsePages/setHtmlBuffer 全部在 rAF 回调里跑（每帧最多 1 次），
  // 回调内 syncRawBuffer() 把 chunks join 成完整字符串。
  // 实测 4.7× 加速（_perf-fixed.js：19950ms → 4211ms），per-frame 1.25ms（16ms 预算内），
  // 主线程占用 96% → 79.5%。
  //
  // 注意：htmlBufferRef.current 现在只在 rAF 回调里更新，故 handleDone 等需要立即读
  // htmlBufferRef.current 的入口前必须调用 flushHtmlBufferSync() 防止最后一个 token
  // 的 rAF 尚未执行时读到 stale 值。
  const htmlBufferRafRef = useRef(false);
  // ── 增量保存（Change 3）：流式期间每完成一页立即落盘，避免程序崩溃丢失已生成页面 ──
  // generationStartedAtRef：本次生成的起始时间戳，用作所有页面 screenName 的时间后缀，
  //   保证增量保存与最终保存用同一时间戳 → postProcessDesignerHtml 的母版注入（依赖
  //   screenName 做菜单高亮）输出一致 → 最终保存可按内容匹配复用增量 screenId，避免重复保存。
  const generationStartedAtRef = useRef(0);
  // incrementalSaveRef：增量保存状态。enabled=已确定目录可增量；bailed=多目录需弹窗，
  //   降级到 handleDone 一次性保存；saved=已落盘页面（含 screenId/postProcess 后 html/name）；
  //   seenHtml=按 postProcess 后内容去重（与最终保存的 dedup 口径一致）。
  const incrementalSaveRef = useRef<{
    enabled: boolean;
    bailed: boolean;
    folderPath: string | undefined;
    processed: number;
    saved: Array<{ screenId: string; html: string; name: string }>;
    seenHtml: Set<string>;
  }>({ enabled: false, bailed: false, folderPath: undefined, processed: 0, saved: [], seenHtml: new Set() });
  // 串行化：增量保存是 async，用标志防止相邻 chunk 重入导致同一页重复保存。
  const incrementalSavingRef = useRef(false);
  // 进行中的增量保存 promise：saveCurrentHtmlInternal 在复用增量 screenId 前需 await 它，
  // 否则若 done 事件在增量保存 await 期间到达，最终保存会因 st.saved 尚未含该页而重复保存。
  const incrementalSavePromiseRef = useRef<Promise<void> | null>(null);
  // 稳定 ref：handleChunk 在 [] 依赖的 effect 里，通过 ref 调用最新的增量保存实现。
  const maybeIncrementalSaveRef = useRef<() => void>(() => {});
  // setHtmlBuffer 节流：避免每帧触发 React re-render → streamingPages useMemo
  // （O(N) split + stripCodeFences + wrapStreamingPages），对 500KB buffer 产生
  // ~2.5MB/帧临时字符串 → 60fps 下 150MB/s 垃圾 → GC 跟不上 → OOM。
  // 100ms 节流（10fps）降至 25MB/s，远在 GC 能力内。流式 iframe 的 doc.write
  // 仍由 useDesignerStreaming 的 rAF 驱动（读 latestHtmlRef，从 html state 同步），
  // 只是每次写入的增量更大，对视觉无影响。
  const lastStateUpdateRef = useRef(0);
  // setStreamingText 节流：与 setHtmlBuffer 相同的问题 —— 旧实现在 rAF 回调里
  // 每帧（60fps）都 setState，高速 token 下整棵 DesignerView 树以 60fps 重渲染，
  // React 协调产生的临时对象是 GC 压力的主要来源之一。统一节流到 100ms。
  const lastTextUpdateRef = useRef(0);
  // Raw, unmodified accumulation of all streamed chunks. stripCodeFences is
  // re-applied to this on every chunk to produce the cleaned htmlBuffer.
  // A separate raw buffer is required because stripping leading prose / fences
  // from the buffer itself would discard the prose, making it impossible to
  // reconstruct the full "prose + fence + html" needed to pair opening and
  // closing fences on subsequent chunks.
  //
  // 性能关键：用 string[] 累积 token，不用 string += 拼接。
  // JS 字符串不可变，str += chunk 每次 O(N) 复制整个旧串。当 buffer 500KB +
  // token 200/s 时，产生 100MB/s 垃圾字符串 → GC 跟不上 → OOM (exitCode=-536870904)。
  // 改用 array.push (O(1) per token) + join (O(N) once per rAF frame) 后，
  // per-token 分配降为 O(text.length)，GC 压力降低 ~200×。
  const rawChunksRef = useRef<string[]>([]);
  const rawBufferRef = useRef('');
  /** 把 rawChunksRef 中的新 chunk 追加到 rawBufferRef（压实）。读取 rawBufferRef 前调用。
   *  压实优化：join 后立即清空 chunks。旧实现每帧对【全部历史 chunks】做 O(N)
   *  全量 join（数组随会话无限增长），高速 token 下每帧产生整份 buffer 大小的
   *  临时字符串；现改为增量拼接，chunks 数组始终只含未压实部分。 */
  const syncRawBuffer = () => {
    if (rawChunksRef.current.length > 0) {
      rawBufferRef.current += rawChunksRef.current.join('');
      rawChunksRef.current = [];
    }
  };
  // 生成状态 ref：handleChunk 在 [] 依赖的稳定 effect 中，用 ref 判断生成是否仍在
  // 进行。用户点「停止」后 setIsGenerating(false) 立即生效，主进程残留 chunk
  // （abort 到 done 事件之间的窗口）直接丢弃，不再驱动 rAF/setState。
  const isGeneratingRef = useRef(false);
  const thinkingBufferRef = useRef('');
  const messageBufferRef = useRef('');
  const currentProjectRef = useRef<DesignerProject | null>(null);
  const currentScreenIdRef = useRef<string | null>(null);
  const selectedElementRef = useRef<SelectedElement | null>(null);
  const dirtyScreenIdsRef = useRef<Set<string>>(new Set());
  const savedScreenIdRef = useRef<string | null>(null);

  // Keep refs in sync
  useEffect(() => { htmlBufferRef.current = htmlBuffer; }, [htmlBuffer]);
  useEffect(() => { isGeneratingRef.current = isGenerating; }, [isGenerating]);
  useEffect(() => { currentProjectRef.current = currentProject; }, [currentProject]);
  useEffect(() => { currentScreenIdRef.current = currentScreenId; }, [currentScreenId]);
  useEffect(() => { selectedElementRef.current = selectedElement; }, [selectedElement]);
  useEffect(() => { dirtyScreenIdsRef.current = dirtyScreenIds; }, [dirtyScreenIds]);
  useEffect(() => { savedScreenIdRef.current = savedScreenId; }, [savedScreenId]);

  /* ── Toast helper ──────────────────────────────────────────────────── */
  const pushToast = useCallback((type: Toast['type'], message: string) => {
    const id = generateId();
    setToasts(prev => [...prev, { id, type, message }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 4000);
  }, []);

  const dismissToast = useCallback((id: string) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  const dismissPermissionWarning = useCallback(() => {
    setPermissionWarning(null);
  }, []);

  /* ── Undo / Redo helpers ───────────────────────────────────────────── */
  const updateUndoRedoState = useCallback(() => {
    setCanUndo(historyIndexRef.current > 0);
    setCanRedo(historyIndexRef.current < historyRef.current.length - 1);
  }, []);

  /** Push current HTML onto the history stack (skipped during undo/redo). */
  const pushHistory = useCallback((html: string) => {
    if (isUndoRedoRef.current) return;
    const stack = historyRef.current;
    // Truncate any redo entries
    stack.splice(historyIndexRef.current + 1);
    // Skip duplicate (no actual change)
    if (stack.length > 0 && stack[stack.length - 1] === html) return;
    stack.push(html);
    // Enforce size limit
    if (stack.length > HISTORY_LIMIT) {
      stack.shift();
    }
    historyIndexRef.current = stack.length - 1;
    updateUndoRedoState();
  }, [updateUndoRedoState]);

  /** Reset the history stack to a single entry (used on load / new generation). */
  const resetHistory = useCallback((html: string) => {
    historyRef.current = html ? [html] : [];
    historyIndexRef.current = html ? 0 : -1;
    updateUndoRedoState();
  }, [updateUndoRedoState]);

  /** Patch a screen's html into currentProject and the projects list.
   *  The tree endpoint returns screen summaries with html=''; this keeps the
   *  fetched HTML in sync with the screen objects so the canvas (SavedPages,
   *  which reads screen.html) and downstream consumers (addScreenToChat,
   *  deleteElement, …) see actual content instead of an empty string. */
  const patchScreenHtml = useCallback((screenId: string, html: string) => {
    setCurrentProject(prev => {
      if (!prev || !prev.screens.some(s => s.id === screenId)) return prev;
      return { ...prev, screens: prev.screens.map(s => s.id === screenId ? { ...s, html } : s) };
    });
    setProjects(prev => prev.map(p => p.screens.some(s => s.id === screenId)
      ? { ...p, screens: p.screens.map(s => s.id === screenId ? { ...s, html } : s) }
      : p));
  }, []);

  /** Mark a screen as having unsaved manual edits. */
  const markDirty = useCallback((screenId: string) => {
    setDirtyScreenIds(prev => prev.has(screenId) ? prev : new Set(prev).add(screenId));
  }, []);

  /** Clear the dirty flag for a screen (called after a successful save). */
  const clearDirty = useCallback((screenId: string) => {
    setDirtyScreenIds(prev => {
      if (!prev.has(screenId)) return prev;
      const next = new Set(prev);
      next.delete(screenId);
      return next;
    });
  }, []);

  /* ── Load projects on mount ────────────────────────────────────────── */
  useEffect(() => {
    refreshProjects();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /* ── Streaming listeners (stable — use refs for state access) ──────── */
  useEffect(() => {
    // 同步 flush：在 handleDone 等需要立即读 htmlBufferRef.current 的入口前调用，
    // 把尚未执行的 rAF 回调里的工作同步执行一次，避免最后一个 token 的内容丢失。
    // 同时把 React state 同步更新，防止 L491 的 back-sync useEffect 用 stale state
    // 覆盖刚 flush 出来的 fresh ref。
    const flushHtmlBufferSync = () => {
      if (htmlBufferRafRef.current) {
        htmlBufferRafRef.current = false;
        // Join chunks before stripping (rAF callback may not have run yet)
        syncRawBuffer();
        htmlBufferRef.current = stripCodeFences(rawBufferRef.current);
        setHtmlBuffer(htmlBufferRef.current); // Always update on final flush (no throttle)
        lastStateUpdateRef.current = performance.now(); // Reset throttle timer
        // 注意：不在此调用 maybeIncrementalSaveRef —— handleDone 随后会调用
        // saveCurrentHtmlInternal 跑完整 parsePages+保存，增量保存无意义重复。
      }
    };

    const handleChunk = (chunk: unknown) => {
      // 「停止」/结束后的残留 chunk 直接丢弃：主进程从 abort 到真正停发之间有
      // 窗口期，期间 chunk 仍会到达。不丢弃则 rAF/stripCodeFences/setState 会
      // 一直空转（此前每次点停止后都有一段无谓的内存/CPU 开销）。
      if (!isGeneratingRef.current) return;
      const text = String(chunk);
      // Accumulate into the RAW chunks array (O(1) push, not O(N) string +=).
      // The full buffer is joined once per rAF frame via syncRawBuffer().
      rawChunksRef.current.push(text);
      // NOTE: do NOT call injectScrollbarStyles here — it mutates the buffer
      // (inserts a <style> block before </head>) which shifts character
      // positions. DesignerCanvas tracks write positions via streamingWrittenRef
      // and the shift causes document.write to start mid-tag, rendering the
      // scrollbar CSS as visible text during streaming. Scrollbar injection is
      // applied later in saveCurrentHtmlInternal (on save) and in
      // DesignerCanvas (on display of saved screens).
      //
      // 所有昂贵的 per-token 工作合并到每帧最多一次（rAF）。之前 stripCodeFences +
      // maybeIncrementalSave 每 token 同步执行（共 19.5s 同步阻塞 for 10 页 790KB），
      // 现在只在 rAF 回调里跑，4.7× 加速（详见 htmlBufferRafRef 注释）。
      if (!htmlBufferRafRef.current) {
        htmlBufferRafRef.current = true;
        requestAnimationFrame(() => {
          htmlBufferRafRef.current = false;
          // 如果 handleDone/handleError 已清空 buffer（生成结束），跳过 —
          // flushHtmlBufferSync 已设置最终 htmlBufferRef，此回调若继续执行
          // 会用 stripCodeFences('')='' 覆盖清空 htmlBufferRef，导致画布空白。
          // 注意：syncRawBuffer 压实后会清空 rawChunksRef（数据进入 rawBufferRef），
          // 所以必须同时判断两者都为空才是真正的"已结束"，否则压实后会误跳过。
          if (rawChunksRef.current.length === 0 && !rawBufferRef.current) return;
          // Join chunks into rawBufferRef (O(N) once per frame, not per token)
          syncRawBuffer();
          htmlBufferRef.current = stripCodeFences(rawBufferRef.current);
          // 增量保存（Change 3）：检测已完成页并立即落盘（fire-and-forget，
          // incrementalSavingRef 内部串行化）。仅在新建多页模式生效。
          // 移到 rAF 后 per-frame 最多跑 1 次 parsePages，不再 per-token 跑。
          maybeIncrementalSaveRef.current();
          // 节流 setHtmlBuffer：避免每帧触发 React re-render → streamingPages
          // useMemo（O(N) split + stripCodeFences）产生大量临时字符串 → OOM。
          // 100ms（10fps）足够流畅，doc.write 仍由 useDesignerStreaming rAF 驱动。
          const now = performance.now();
          if (now - lastStateUpdateRef.current >= 100) {
            setHtmlBuffer(htmlBufferRef.current);
            lastStateUpdateRef.current = now;
          }
          // Show prose tail during the prose phase (cleaned is '' because the
          // opening fence hasn't completed yet), and HTML tail once rendering
          // begins — keeps the status indicator informative in both phases.
          // 节流到 100ms：旧实现每帧（60fps）setState 触发整棵 DesignerView
          // 树重渲染，高速 token 下是 GC 压力的主要来源之一。
          if (now - lastTextUpdateRef.current >= 100) {
            lastTextUpdateRef.current = now;
            setStreamingText((htmlBufferRef.current || rawBufferRef.current).slice(-200));
          }
        });
      }
    };

    const handleThinking = (chunk: unknown) => {
      const text = String(chunk);
      thinkingBufferRef.current += text;
      const thinking = thinkingBufferRef.current.slice(-100);
      const message = messageBufferRef.current.slice(-500);
      setStreamingText(message ? `思考: ${thinking} | ${message}` : `思考: ${thinking}`);
    };

    // 修改模式：AI 正文输出仅更新顶部状态显示（streamingText），
    // 不写入 htmlBuffer，避免污染画布。画布只反映工具修改后的文件内容。
    const handleMessage = (chunk: unknown) => {
      const text = String(chunk);
      messageBufferRef.current += text;
      const thinking = thinkingBufferRef.current.slice(-100);
      const message = messageBufferRef.current.slice(-500);
      setStreamingText(thinking ? `思考: ${thinking} | ${message}` : message);
    };

    const handleDone = (data: unknown) => {
      // 关键：先把尚未执行的 rAF 回调同步 flush 一次，确保最后一个 token 的内容已
      // 写入 htmlBufferRef.current。否则 handleDone 读到的可能是 stale 值（少最后
      // ~16ms 的内容），导致丢失最后一页/最后一节 HTML。详见 htmlBufferRafRef 注释。
      flushHtmlBufferSync();
      // 立即置位 ref：handleChunk 的守卫据此丢弃 done 之后到达的残留 chunk。
      isGeneratingRef.current = false;
      setIsGenerating(false);
      const payload = data as { aborted?: boolean; noToolCalls?: boolean; scenario?: string } | undefined;
      // 修改模式下 AI 未调用任何工具就结束了 —— 以警告方式在右下角提示用户
      if (!payload?.aborted && payload?.noToolCalls && payload?.scenario === 'edit') {
        const aiMsg = messageBufferRef.current.trim();
        const warnText = aiMsg
          ? `AI 未执行任何修改操作。输出内容：${aiMsg.slice(0, 200)}${aiMsg.length > 200 ? '...' : ''}`
          : 'AI 未执行任何修改操作，可能未理解指令或生成失败。请尝试重新描述需求。';
        pushToast('warning', warnText);
      }
      setStreamingText('');
      thinkingBufferRef.current = '';
      messageBufferRef.current = '';
      rawChunksRef.current = [];
      rawBufferRef.current = '';
      if (payload?.aborted) {
        // 中止后释放流式 buffer：画布已切回 SavedPages，htmlBuffer 到下次生成前
        // 不再被消费，持续持有大份部分 HTML 字符串只会占用内存（多次「停止」
        // 叠加会累积可观的滞留内存）。
        htmlBufferRef.current = '';
        setHtmlBuffer('');
        // 中止时若已有页面增量落盘（Change 3），重载树让它们显示在画布上，避免
        // 「生成了几页后中止却看不到」的困惑；同时重置增量状态。未增量保存则原样返回。
        const inc = incrementalSaveRef.current.saved.filter(s => s.screenId);
        if (inc.length > 0) {
          const savedHtmlById = new Map<string, string>();
          for (const s of inc) savedHtmlById.set(s.screenId, s.html);
          // 不 await：handleDone 是同步 listener，重载在后台进行
          reloadProjectTreeAndPatch(savedHtmlById);
        }
        incrementalSaveRef.current = {
          enabled: false, bailed: false, folderPath: undefined,
          processed: 0, saved: [], seenHtml: new Set(),
        };
        return;
      }
      const proj = currentProjectRef.current;
      if (!proj || !htmlBufferRef.current.trim()) return;
      const screenId = currentScreenIdRef.current;
      if (screenId) {
        // 编辑模式：AI 修改了已有页面，不自动保存到后端。
        // 仅更新本地状态（画布 + screen.html）并标记为 dirty，
        // 用户通过工具栏保存按钮或 Ctrl+S 手动保存（见 saveCurrentScreen）。
        const projectType = proj.type;
        const themePrompt = proj.themePrompt;
        // 应用与 saveCurrentHtmlInternal 一致的后处理（滚动条样式 + Bootstrap CDN + 主题），
        // 保证画布显示与保存路径一致。
        const pages = parsePages(htmlBufferRef.current);
        if (pages.length === 0) return;
        // 共享母版兜底（§6.3.3）：AI 可能不听提示词仍画了 nav，剥离替换为 slot 占位。
        // 仅在项目启用 MasterLayout 时生效；无 layout 时原样返回（向后兼容）。
        const layouts = proj.masterLayouts;
        const compliantPages = layouts && layouts.length > 0
          ? pages.map(p => enforceSlotCompliance(p, proj))
          : pages;
        // 注入共享菜单（§6.4.2）：按 screenId + screenName 算高亮。无 slot 时自动跳过。
        // 编辑模式 screenId 已知，screenName 取已存在屏幕名（含系统名/日期后缀，利于 scoreMenuMatch 消歧）。
        const editScreenName = proj.screens.find(s => s.id === screenId)?.name ?? '';
        const styledPages = compliantPages.map(p => postProcessDesignerHtml(p, projectType, themePrompt,
          layouts && layouts.length > 0 ? { screenId, screenName: editScreenName, layouts } : undefined));
        const mergedHtml = styledPages.length > 1 ? styledPages.join('\n') : styledPages[0];
        // 校验：仅 error 级别问题告警，不阻塞保存（postProcess 已修复大部分问题）。
        const issues = validateDesignerHtml(mergedHtml);
        const errors = issues.filter(i => i.severity === 'error');
        if (errors.length > 0) {
          pushToast('error', `生成内容校验失败：${summarizeIssues(issues)}`);
        }
        setHtmlBuffer(mergedHtml);
        htmlBufferRef.current = mergedHtml;
        patchScreenHtml(screenId, mergedHtml);
        markDirty(screenId);
        pushHistory(mergedHtml);
      } else {
        // 新建模式：自动保存以创建新页面（保持原有行为）
        saveCurrentHtmlInternal().then(() => {
          pushHistory(htmlBufferRef.current);
        });
      }
    };

    const handleError = (err: unknown) => {
      console.error('[Designer] Generation error:', err);
      isGeneratingRef.current = false;
      setIsGenerating(false);
      setStreamingText('');
      // 出错后释放流式 buffer（同 abort 分支的理由）
      htmlBufferRef.current = '';
      setHtmlBuffer('');
      thinkingBufferRef.current = '';
      messageBufferRef.current = '';
      rawChunksRef.current = [];
      rawBufferRef.current = '';
      pushToast('error', `生成失败: ${String(err)}`);
    };

    on(IPCChannel.DesignerStreamChunk, handleChunk);
    on(IPCChannel.DesignerStreamThinking, handleThinking);
    on(IPCChannel.DesignerStreamMessage, handleMessage);
    on(IPCChannel.DesignerStreamDone, handleDone);
    on(IPCChannel.DesignerStreamError, handleError);

    return () => {
      removeListener(IPCChannel.DesignerStreamChunk, handleChunk);
      removeListener(IPCChannel.DesignerStreamThinking, handleThinking);
      removeListener(IPCChannel.DesignerStreamMessage, handleMessage);
      removeListener(IPCChannel.DesignerStreamDone, handleDone);
      removeListener(IPCChannel.DesignerStreamError, handleError);
    };
  }, []); // Stable — all state access via refs

  /* ── 增量保存（Change 3）：流式期间每完成一页立即落盘 ──────────────── */
  // 触发：handleChunk 每个 token 调用 maybeIncrementalSaveRef.current()。仅新建模式
  // （无 currentScreenId）生效。检测到 buffer 中出现新已完成页（PAGE_BREAK 后移）时，
  // 按与最终保存完全一致的管线（parsePages → enforceSlotCompliance → postProcessDesignerHtml，
  // 且 screenName 用 generationStartedAtRef 同一时间戳）处理后保存到后端，记录 screenId+html。
  // 目录解析：OWNER/ADMIN → 根目录；单可写目录 → 该目录；多可写目录 → bailed，降级到
  // handleDone 一次性保存（避免流式期间弹窗）。最终保存按 postProcess 后内容匹配复用增量
  // screenId，避免重复保存。目的：程序崩溃时不丢失已生成好的页面（含母版注入的侧边栏/页头）。
  const maybeIncrementalSave = useCallback(async () => {
    const proj = currentProjectRef.current;
    if (!proj) return;
    if (currentScreenIdRef.current) return; // 编辑模式不增量
    const st = incrementalSaveRef.current;
    if (st.bailed) return;
    if (incrementalSavingRef.current) return; // 串行化：未完成则跳过，下个 token 重试
    const buffer = htmlBufferRef.current;
    if (!buffer.trim()) return;
    // 快速跳过：buffer 中无 PAGE_BREAK → 单页模式，无已完成页可保存。
    // parsePages 是 O(N)，此检查避免每帧对大 buffer 调用 parsePages。
    // includes 用原生字符串搜索（Boyer-Moore），500KB 约 0.3ms，远快于 parsePages 的 ~5ms。
    if (!buffer.includes(PAGE_BREAK_DELIMITER)) return;

    const allPages = parsePages(buffer);
    const completedCount = Math.max(0, allPages.length - 1); // 最后一页在生成中
    if (completedCount <= st.processed) return; // 无新完成页

    // 有新完成页 → 执行并把 promise 存入 ref，供 saveCurrentHtmlInternal 等待
    const run = async () => {
      incrementalSavingRef.current = true;
      try {
        // 首次：解析保存目录（异步）
        if (!st.enabled) {
          const role = proj.role;
          if (role === 'OWNER' || role === 'ADMIN') {
            st.folderPath = undefined;
            st.enabled = true;
          } else {
            try {
              const wf = await invoke(IPCChannel.DesignerListWritableFolders, {
                projectId: proj.id,
              }) as { success: boolean; folders?: { folderId: number; path: string }[]; error?: string };
              if (!wf.success || !wf.folders || wf.folders.length === 0) {
                st.bailed = true; // 无可写目录，交由 handleDone 报错
                return;
              }
              if (wf.folders.length === 1) {
                st.folderPath = wf.folders[0].path;
                st.enabled = true;
              } else {
                st.bailed = true; // 多目录需弹窗，降级到 handleDone
                return;
              }
            } catch {
              st.bailed = true;
              return;
            }
          }
        }
        if (!st.enabled) return;

        // 目录解析期间 buffer 可能增长，重新读取最新值
        const latestPages = parsePages(htmlBufferRef.current);
        const latestCompleted = Math.max(0, latestPages.length - 1);
        const projectType = proj.type;
        const themePrompt = proj.themePrompt;
        const layouts = proj.masterLayouts;
        const baseIndex = proj.screens.length;
        const now = generationStartedAtRef.current || Date.now();
        for (let i = st.processed; i < latestCompleted; i++) {
          st.processed = i + 1;
          let pageHtml = latestPages[i];
          if (layouts && layouts.length > 0) {
            pageHtml = enforceSlotCompliance(pageHtml, proj);
          }
          // 与最终保存一致：母版注入用的 screenName = extractPageTitle(compliantPage, idx)
          const injectScreenName = extractPageTitle(pageHtml, baseIndex + i);
          pageHtml = postProcessDesignerHtml(pageHtml, projectType, themePrompt,
            layouts && layouts.length > 0
              ? { screenId: '', screenName: injectScreenName, layouts }
              : undefined);
          // 去重（与最终保存 dedup 口径一致：按 postProcess 后内容）
          if (st.seenHtml.has(pageHtml)) continue;
          st.seenHtml.add(pageHtml);
          const saveScreenName = `${extractPageTitle(pageHtml, baseIndex + i)} — ${formatDate(now)}`;
          const screenId = generateId();
          try {
            const res = await invoke(IPCChannel.DesignerSaveHtml, {
              projectId: proj.id,
              screenId,
              screenName: saveScreenName,
              html: pageHtml,
              folderPath: st.folderPath,
            }) as { success: boolean; screenId?: string };
            st.saved.push({ screenId: res.success ? (res.screenId ?? screenId) : '', html: pageHtml, name: saveScreenName });
          } catch {
            st.saved.push({ screenId: '', html: pageHtml, name: saveScreenName });
          }
        }
      } finally {
        incrementalSavingRef.current = false;
      }
    };
    const p = run();
    incrementalSavePromiseRef.current = p;
    await p;
  }, [invoke]);
  maybeIncrementalSaveRef.current = maybeIncrementalSave;

  /* ── 重新加载项目树并把已保存 HTML patch 进摘要（Change 3 抽取的公共尾） ── */
  // 树端点返回 screen 摘要（html='');savedHtmlById 把刚保存的 HTML 回填，避免画布空 iframe；
  // prevHtmlById 保留本次生成前已加载的其它页面 HTML，防止树重载把它们清空。
  const reloadProjectTreeAndPatch = useCallback(async (savedHtmlById: Map<string, string>) => {
    const proj = currentProjectRef.current;
    if (!proj) return;
    try {
      const listResult = await invoke(IPCChannel.DesignerListProjects) as { success: boolean; projects?: DesignerProject[] };
      if (listResult.success && listResult.projects) {
        setProjects(listResult.projects);
      }
      const loadResult = await invoke(IPCChannel.DesignerLoadProject, { projectId: proj.id }) as {
        success: boolean;
        project?: DesignerProject;
        error?: string;
      };
      if (loadResult.success && loadResult.project) {
        const updated = loadResult.project;
        const prevHtmlById = new Map<string, string>();
        for (const s of proj.screens) {
          if (s.html) prevHtmlById.set(s.id, s.html);
        }
        const patched: DesignerProject = {
          ...updated,
          screens: updated.screens.map(s => {
            const newHtml = savedHtmlById.get(s.id);
            if (newHtml) return { ...s, html: newHtml };
            const prevHtml = prevHtmlById.get(s.id);
            if (prevHtml) return { ...s, html: prevHtml };
            return s;
          }),
        };
        setProjects(prev => prev.map(p => p.id === patched.id ? patched : p));
        setCurrentProject(patched);
      }
    } catch (err) {
      console.error('[Designer] reloadProjectTreeAndPatch failed:', err);
    }
  }, [invoke]);

  /* ── Internal save (used by auto-save in listener) ─────────────────── */
  const saveCurrentHtmlInternal = useCallback(async () => {
    const proj = currentProjectRef.current;
    if (!proj || !htmlBufferRef.current.trim()) return;

    // Parse the buffer into individual pages (supports multi-page output)
    const pages = parsePages(htmlBufferRef.current);
    if (pages.length === 0) return;

    // Post-processing safety net: guarantee consistent scrollbar behavior.
    // Even if the LLM omitted the mandatory scrollbar CSS, inject it here.
    const projectType = proj.type;
    const themePrompt = proj.themePrompt;
    // Also ensure every page has the Bootstrap CDN + theme tokens. When the AI
    // outputs multiple pages (<!-- PAGE BREAK -->), it may include CDN only in
    // the first page — pages 2-N render unstyled without this fix.
    // 共享母版（§6.4.2）：启用 MasterLayout 时注入菜单。编辑模式 screenId 已知可高亮；
    // 新建模式 screenId 此时未生成，传 '' 注入菜单但不高亮（autoBind 后重载时补高亮）。
    // screenName 用于文本匹配高亮：编辑模式取已存在屏幕名；新建模式用 extractPageTitle
    // （AI 通常把页面名写在 <title>，scoreMenuMatch 的 includes 可命中菜单标签）。
    const layouts = proj.masterLayouts;
    const knownScreenId = currentScreenIdRef.current || '';
    // 编辑模式（knownScreenId 非空）取已存在屏幕名；新建模式 find 返回 undefined → 用 extractPageTitle
    const existingScreenForName = proj.screens.find(s => s.id === knownScreenId);
    // baseIndex 必须在 styledPages 之前计算：postProcessDesignerHtml 的母版注入用
    // screenName=extractPageTitle(p, baseIndex+idx) 高亮菜单项。增量保存
    // （maybeIncrementalSave）也用 baseIndex+i。若两者 idx 不一致 → screenName 不同 →
    // 注入的菜单 HTML 不同 → 最终保存的 dedup（s.html===pagesToSave[i]）失败 → 重复保存！
    const baseIndex = proj.screens.length;
    // 兜底（§6.3.3）：AI 误画 nav 时剥离为 slot 占位（无 layout 时原样返回）。
    const compliantPages = layouts && layouts.length > 0
      ? pages.map(p => enforceSlotCompliance(p, proj))
      : pages;
    const styledPages = compliantPages.map((p, idx) => postProcessDesignerHtml(p, projectType, themePrompt,
      layouts && layouts.length > 0
        ? {
            screenId: knownScreenId,
            screenName: existingScreenForName?.name ?? extractPageTitle(p, baseIndex + idx),
            layouts,
          }
        : undefined));

    const isEditingExisting = !!currentScreenIdRef.current;
    // 用本次生成的起始时间戳（而非保存时刻）作为 screenName 时间后缀，保证与流式期间
    // 增量保存（maybeIncrementalSave）使用同一时间戳 → postProcessDesignerHtml 的母版注入
    // 输出一致 → 下方可按内容匹配复用增量 screenId，避免重复保存同一页面。
    const now = generationStartedAtRef.current || Date.now();
    // Real screenIds returned by the backend for the pages we save. Used to
    // patch the generated HTML into the tree summaries (which come back with
    // html='') and to select the first new screen by id rather than by an
    // unreliable array index (the tree sorts screens by updatedAt DESC).
    const savedScreenIds: string[] = [];
    // 去重后实际要保存的页面列表。edit 分支不用它（提前 return）；
    // new 分支会重新赋值为去重后的数组，公共重载逻辑（树 patch / 选中首页）据此索引。
    let pagesToSave: string[] = styledPages;

    try {
      if (isEditingExisting) {
        // Edit mode: always update the existing screen in place. NEVER create
        // new screens here — even if the AI output unexpectedly contained the
        // PAGE_BREAK delimiter (which would split styledPages into >1 page),
        // we re-merge into a single document and update only the original
        // screen. This is a hard guard against the "刷新后出现重复页面" bug.
        const screenId = currentScreenIdRef.current!;
        const existingScreen = proj.screens.find(s => s.id === screenId);
        const screenName = existingScreen?.name || extractPageTitle(styledPages[0], 0);
        // Re-join in case AI mistakenly emitted PAGE_BREAK inside one page.
        // Use a safe separator that won't render visibly in HTML.
        const mergedHtml = styledPages.length > 1 ? styledPages.join('\n') : styledPages[0];
        const res = await invoke(IPCChannel.DesignerSaveHtml, {
          projectId: proj.id,
          screenId,
          screenName,
          html: mergedHtml,
          // Pass the existing screen's folderPath so any (rare) legitimate
          // re-create lands in the same folder instead of the project root.
          folderPath: existingScreen?.folderPath,
          // AI 编辑后保存，标记来源用于历史记录溯源
          source: 'ai_edit',
        }) as { success: boolean; screenId?: string; error?: string };
        if (!res.success) {
          // IPC refused to create a duplicate (e.g. version unknown + getScreen
          // failed). Surface the error instead of silently patching local state
          // — otherwise the canvas would show the new HTML but the backend still
          // has the old one, and refreshing would reveal the mismatch.
          console.error('[Designer] Edit-mode save refused by backend:', res.error);
          return;
        }
        savedScreenIds.push(res.screenId ?? screenId);

        // 修改模式：只刷新被修改的页面。不重载整棵项目树、不刷新项目列表、
        // 不清空画布、不移动画布位置。直接在当前项目状态里就地 patch 该
        // screen 的 HTML，SavedPages 的 iframe (srcDoc) 会随之重新渲染；
        // 其余 screen 不受影响，用户的 pan/zoom 也保持不变。
        const updatedScreen = {
          ...(existingScreen ?? { id: screenId, name: screenName, html: '', createdAt: now }),
          html: mergedHtml,
          name: screenName,
          updatedAt: now,
        };
        const updatedProject = {
          ...proj,
          updatedAt: now,
          screens: proj.screens.some(s => s.id === screenId)
            ? proj.screens.map(s => (s.id === screenId ? updatedScreen : s))
            : [...proj.screens, updatedScreen],
        };
        setProjects(prev => prev.map(p => (p.id === updatedProject.id ? updatedProject : p)));
        setCurrentProject(updatedProject);
        setHtmlBuffer(mergedHtml);
        htmlBufferRef.current = mergedHtml;
        // AI 编辑保存成功，清除该 screen 的 dirty 标记
        clearDirty(screenId);
        return; // 跳过项目列表刷新 + 全树重载
      } else {
        // New generation (possibly multi-page): create a new screen for each page.
        // 去重：mimo 等模型偶发会把同一页面重复输出并用 <!-- PAGE BREAK --> 分隔，
        // 导致一次生成出现两个一模一样的页面。这里按 trim 后的字节内容去重，
        // 相同页面只创建一个 screen；合法的多页输出（各页内容不同）不受影响。
        const seenHtml = new Set<string>();
        pagesToSave = styledPages.filter(p => {
          const key = p.trim();
          if (!key) return false;
          if (seenHtml.has(key)) return false;
          seenHtml.add(key);
          return true;
        });
        if (pagesToSave.length < styledPages.length) {
          console.warn(
            `[Designer] 去重：检测到重复页面（${styledPages.length} → ${pagesToSave.length}），已合并相同内容的页面。` +
            `若非预期，请检查模型是否误输出 <!-- PAGE BREAK -->。`,
          );
        }
        // baseIndex 已在上方 styledPages 计算前声明，此处复用（确保增量保存与最终保存的 idx 一致）
        const screenNames = pagesToSave.map((p, i) =>
          `${extractPageTitle(p, baseIndex + i)} — ${formatDate(now)}`);

        // 确定保存目录
        const role = proj.role;
        let targetFolderPath: string | undefined;

        if (role === 'OWNER' || role === 'ADMIN') {
          // OWNER/ADMIN：保存到根目录（保持原有行为）
          targetFolderPath = undefined;
        } else {
          // 普通成员：查询可写目录
          const wfResult = await invoke(IPCChannel.DesignerListWritableFolders, {
            projectId: proj.id,
          }) as { success: boolean; folders?: { folderId: number; path: string }[]; error?: string };
          if (!wfResult.success || !wfResult.folders || wfResult.folders.length === 0) {
            pushToast('error', '您在该项目中没有可写目录,无法创建新页面。请联系项目管理员分配目录权限。');
            return;
          }
          if (wfResult.folders.length === 1) {
            // 仅一个可写目录：自动保存到该目录
            targetFolderPath = wfResult.folders[0].path;
          } else {
            // 多个可写目录：挂起保存,弹出选择对话框
            pendingSaveRef.current = { pages: pagesToSave, screenNames, baseIndex };
            setFolderSelectDialog({ projectId: proj.id });
            return; // 保存暂停,由 folderSelectCallback 继续
          }
        }

        // 执行保存（Change 3：流式期间已增量落盘的页面按内容匹配复用 screenId，跳过重复保存）
        // 先等待可能仍在进行的增量保存完成，否则 done 事件抢先到达会导致 st.saved 缺页 → 重复保存。
        if (incrementalSavePromiseRef.current) {
          await incrementalSavePromiseRef.current;
        }
        const incSaved = incrementalSaveRef.current.saved;
        for (let i = 0; i < pagesToSave.length; i++) {
          // 增量保存已落盘该页？按 postProcess 后内容匹配（增量与最终管线/时间戳一致，输出相同）
          const inc = incSaved.find(s => s.screenId && s.html === pagesToSave[i]);
          if (inc) {
            savedScreenIds.push(inc.screenId);
            continue;
          }
          const screenId = generateId();
          const res = await invoke(IPCChannel.DesignerSaveHtml, {
            projectId: proj.id,
            screenId,
            screenName: screenNames[i],
            html: pagesToSave[i],
            folderPath: targetFolderPath,
          }) as { success: boolean; screenId?: string };
          if (res.success) savedScreenIds.push(res.screenId ?? screenId);
        }
      }

      // 重新加载项目树并把刚保存的 HTML 回填到摘要（Change 3：抽取为公共 helper）。
      // savedHtmlById 覆盖本次保存的全部页面（含增量复用 + 本次新存），让 SavedPages
      // 渲染真实内容而非空 iframe；prevHtmlById（在 helper 内）保留其它已有页面 HTML。
      const savedHtmlById = new Map<string, string>();
      pagesToSave.forEach((html, i) => {
        if (savedScreenIds[i]) savedHtmlById.set(savedScreenIds[i], html);
      });
      await reloadProjectTreeAndPatch(savedHtmlById);
      // 选中首个新建页面（按真实 server id；树按 updatedAt DESC 排序，不能用下标）
      if (savedScreenIds.length > 0) {
        setCurrentScreenId(savedScreenIds[0]);
        setHtmlBuffer(pagesToSave[0]);
        htmlBufferRef.current = pagesToSave[0];
      }
      // 重置增量保存状态（本次生成结束，下次生成会在 generateHtml 里再次重置）
      incrementalSaveRef.current = {
        enabled: false, bailed: false, folderPath: undefined,
        processed: 0, saved: [], seenHtml: new Set(),
      };
    } catch (err) {
      console.error('[Designer] Save failed:', err);
    }
  }, [invoke, clearDirty, pushToast, reloadProjectTreeAndPatch]);

  /* ── 目录选择回调（用户从弹窗选择保存目录后继续保存） ─────────────── */
  const onFolderSelect = useCallback(async (folderPath: string) => {
    setFolderSelectDialog(null);
    const pending = pendingSaveRef.current;
    pendingSaveRef.current = null;
    if (!pending) return;
    const proj = currentProjectRef.current;
    if (!proj) return;

    const savedScreenIds: string[] = [];
    try {
      for (let i = 0; i < pending.pages.length; i++) {
        const screenId = generateId();
        const res = await invoke(IPCChannel.DesignerSaveHtml, {
          projectId: proj.id,
          screenId,
          screenName: pending.screenNames[i],
          html: pending.pages[i],
          folderPath,
        }) as { success: boolean; screenId?: string };
        if (res.success) savedScreenIds.push(res.screenId ?? screenId);
      }

      // 刷新项目列表 + 加载完整树
      const listResult = await invoke(IPCChannel.DesignerListProjects) as { success: boolean; projects?: DesignerProject[] };
      if (listResult.success && listResult.projects) {
        setProjects(listResult.projects);
      }
      const loadResult = await invoke(IPCChannel.DesignerLoadProject, { projectId: proj.id }) as {
        success: boolean;
        project?: DesignerProject;
        error?: string;
      };
      if (loadResult.success && loadResult.project) {
        const updated = loadResult.project;
        const savedHtmlById = new Map<string, string>();
        pending.pages.forEach((html, i) => {
          if (savedScreenIds[i]) savedHtmlById.set(savedScreenIds[i], html);
        });
        const prevHtmlById = new Map<string, string>();
        for (const s of proj.screens) {
          if (s.html) prevHtmlById.set(s.id, s.html);
        }
        const patched: DesignerProject = {
          ...updated,
          screens: updated.screens.map(s => {
            const newHtml = savedHtmlById.get(s.id);
            if (newHtml) return { ...s, html: newHtml };
            const prevHtml = prevHtmlById.get(s.id);
            if (prevHtml) return { ...s, html: prevHtml };
            return s;
          }),
        };
        setProjects(prev => prev.map(p => p.id === patched.id ? patched : p));
        setCurrentProject(patched);
        if (savedScreenIds.length > 0) {
          setCurrentScreenId(savedScreenIds[0]);
          setHtmlBuffer(pending.pages[0]);
          htmlBufferRef.current = pending.pages[0];
        }
      }
    } catch (err) {
      console.error('[Designer] Folder-select save failed:', err);
      pushToast('error', '保存失败');
    }
  }, [invoke, pushToast]);

  const onFolderSelectCancel = useCallback(() => {
    setFolderSelectDialog(null);
    pendingSaveRef.current = null;
  }, []);

  /* ── Refresh projects ──────────────────────────────────────────────── */
  const refreshProjects = useCallback(async () => {
    try {
      const result = await invoke(IPCChannel.DesignerListProjects) as { success: boolean; projects?: DesignerProject[] };
      if (result.success && result.projects) {
        // The list endpoint returns project metadata without screens/folders.
        // Preserve the current project's screens/folders (loaded via loadProject)
        // by merging metadata into the existing currentProject instead of replacing it.
        const current = currentProjectRef.current;
        if (current) {
          const updated = result.projects.find(p => p.id === current.id);
          if (updated) {
            // Merge: keep existing screens/folders, update metadata from list
            const merged: DesignerProject = {
              ...current,
              name: updated.name,
              type: updated.type,
              themePrompt: updated.themePrompt,
              role: updated.role,
              ownerId: updated.ownerId ?? current.ownerId,
              updatedAt: updated.updatedAt,
              createdAt: updated.createdAt,
            };
            // Replace the list entry with the merged version (keeps screens visible)
            setProjects(result.projects.map(p => p.id === current.id ? merged : p));
            setCurrentProject(merged);
            return;
          }
        }
        setProjects(result.projects);
      }
    } catch (err) {
      console.error('[Designer] Failed to load projects:', err);
    }
  }, [invoke]);

  /* ── Undo: revert to the previous history entry ───────────────────── */
  const undo = useCallback((onApplied?: (screenId: string, html: string) => void) => {
    if (historyIndexRef.current <= 0) return;
    historyIndexRef.current--;
    isUndoRedoRef.current = true;
    const html = historyRef.current[historyIndexRef.current];
    setHtmlBuffer(html);
    htmlBufferRef.current = html;
    setSelectedElement(null);
    isUndoRedoRef.current = false;
    // Update screen.html + dirty flag (clear dirty if back to saved version)
    const proj = currentProjectRef.current;
    const screenId = currentScreenIdRef.current;
    if (proj && screenId) {
      patchScreenHtml(screenId, html);
      const saved = proj.screens.find(s => s.id === screenId)?.html;
      if (saved && saved === html) clearDirty(screenId);
      else markDirty(screenId);
      // Notify the caller with the target HTML so it can apply it directly
      // to the iframe DOM (flicker-free) before React re-renders.
      onApplied?.(screenId, html);
    }
    updateUndoRedoState();
  }, [patchScreenHtml, clearDirty, markDirty, updateUndoRedoState]);

  /* ── Redo: re-apply a previously undone history entry ──────────────── */
  const redo = useCallback((onApplied?: (screenId: string, html: string) => void) => {
    if (historyIndexRef.current >= historyRef.current.length - 1) return;
    historyIndexRef.current++;
    isUndoRedoRef.current = true;
    const html = historyRef.current[historyIndexRef.current];
    setHtmlBuffer(html);
    htmlBufferRef.current = html;
    setSelectedElement(null);
    isUndoRedoRef.current = false;
    // Update screen.html + dirty flag (clear dirty if back to saved version)
    const proj = currentProjectRef.current;
    const screenId = currentScreenIdRef.current;
    if (proj && screenId) {
      patchScreenHtml(screenId, html);
      const saved = proj.screens.find(s => s.id === screenId)?.html;
      if (saved && saved === html) clearDirty(screenId);
      else markDirty(screenId);
      // Notify the caller with the target HTML so it can apply it directly
      // to the iframe DOM (flicker-free) before React re-renders.
      onApplied?.(screenId, html);
    }
    updateUndoRedoState();
  }, [patchScreenHtml, clearDirty, markDirty, updateUndoRedoState]);

  /* ── AI 操作前置权限检查 ───────────────────────────────────────────── */
  /**
   * 检查当前用户在目标目录是否有写权限。
   * - 编辑已有页面时,目标目录 = 该页面所属目录,直接检查该目录写权限
   * - 新建页面时,检查用户是否有任意可写目录(OWNER/ADMIN 全部可写)
   * 无权限时设置 permissionWarning 并返回 false,调用方应中止后续操作。
   */
  const checkWritePermission = useCallback(async (): Promise<boolean> => {
    const proj = currentProjectRef.current;
    if (!proj) return true; // 无项目上下文,交由后续逻辑处理
    const screenId = currentScreenIdRef.current;
    // 编辑模式：检查当前页面所在目录的写权限
    if (screenId) {
      const screen = proj.screens.find(s => s.id === screenId);
      const folderPath = screen?.folderPath || '';
      try {
        const result = await invoke(IPCChannel.DesignerCheckWritePermission, {
          projectId: proj.id,
          folderPath,
        }) as { success: boolean; canWrite?: boolean; role?: string; error?: string };
        if (!result.success || !result.canWrite) {
          const target = folderPath ? `目录 "${folderPath}"` : '项目根目录';
          const roleHint = result.role === 'MEMBER' ? '(当前身份为项目成员)' : '';
          setPermissionWarning({
            folderPath,
            message: `你在${target}没有写权限,无法让 AI 修改文件${roleHint}。请联系项目管理员授权。`,
          });
          return false;
        }
        return true;
      } catch (err) {
        console.error('[Designer] permission check failed:', err);
        return true;
      }
    }
    // 新建模式：OWNER/ADMIN 可直接创建，普通成员需有至少一个可写目录
    const role = proj.role;
    if (role === 'OWNER' || role === 'ADMIN') return true;
    try {
      const result = await invoke(IPCChannel.DesignerListWritableFolders, {
        projectId: proj.id,
      }) as { success: boolean; folders?: { folderId: number; path: string }[]; error?: string };
      if (result.success && result.folders && result.folders.length > 0) {
        return true; // 有可写目录,允许新建(保存时再选择具体目录)
      }
      setPermissionWarning({
        folderPath: '',
        message: '您在该项目中没有可写目录,无法创建新页面。请联系项目管理员分配目录权限。',
      });
      return false;
    } catch (err) {
      console.error('[Designer] writable folders check failed:', err);
      return true; // 检查失败时不阻断,交由保存时报错
    }
  }, [invoke]);

  /* ── Generate HTML ─────────────────────────────────────────────────── */
  const generateHtml = useCallback(async (prompt: string) => {
    if (isGenerating) return;

    // AI 操作前置权限检查:无写权限则弹窗提醒并中止
    const allowed = await checkWritePermission();
    if (!allowed) return;

    // Bug fix: capture existing HTML BEFORE clearing the buffer
    // Scenario C: if UI element tags are present, treat it as a file-modification
    // task. The element's source screen HTML becomes the file to edit.
    const elementTags = chatTags.filter(t => t.type === 'element');
    let existingHtml = currentScreenIdRef.current ? htmlBufferRef.current : undefined;
    if (!existingHtml && elementTags.length > 0) {
      // No current screen selected, but element tags carry their source screenId.
      // Adopt that screen as the current one so:
      //   1. existingHtml is populated (triggers tool-loop in main process)
      //   2. saveCurrentHtmlInternal updates the correct screen in place
      const proj = currentProjectRef.current;
      const srcScreenId = elementTags[0].screenId;
      if (proj && srcScreenId) {
        const screen = proj.screens.find(s => s.id === srcScreenId);
        if (screen?.html) {
          existingHtml = screen.html;
          setCurrentScreenId(srcScreenId);
        }
      }
    }

    // Collect screen style references from chat tags
    const screenTags = chatTags.filter(t => t.type === 'screen');
    const styleReferences = screenTags.length > 0
      ? screenTags.map(t => t.content || '').filter(Boolean)
      : undefined;

    // Element info is already included in the prompt text via inline-tag
    // rendering in ChatInput.getEditorText(), so no need to append it again.
    const enhancedPrompt = prompt;

    htmlBufferRef.current = '';
    rawChunksRef.current = [];
    rawBufferRef.current = '';
    thinkingBufferRef.current = '';
    messageBufferRef.current = '';
    lastStateUpdateRef.current = 0; // Reset throttle timer for new generation
    lastTextUpdateRef.current = 0;
    setHtmlBuffer('');
    setStreamingText('');
    isGeneratingRef.current = true; // 同步置位，handleChunk 守卫立即放行新 chunk
    setIsGenerating(true);

    // 增量保存（Change 3）：记录生成起始时间戳并重置增量保存状态。
    // 仅新建模式（无 currentScreenId）会真正触发增量落盘（见 maybeIncrementalSave）。
    generationStartedAtRef.current = Date.now();
    incrementalSaveRef.current = {
      enabled: false,
      bailed: false,
      folderPath: undefined,
      processed: 0,
      saved: [],
      seenHtml: new Set(),
    };
    incrementalSavingRef.current = false;

    // Clear element and screen tags after sending
    setChatTags(prev => prev.filter(t => t.type !== 'element' && t.type !== 'screen'));

    invoke(IPCChannel.DesignerGenerate, {
      prompt: enhancedPrompt,
      projectType: currentProjectRef.current?.type || 'WEB',
      projectId: currentProjectRef.current?.id,
      screenId: currentScreenIdRef.current,
      existingHtml,
      styleReferences,
      // 传递 renderer 端最新的 masterLayouts（提取/编辑后立即生效），
      // 避免主进程从后端二次拉取时拿到陈旧数据或静默失败（designer-handlers
      // 的 getProject catch 了异常但不会重试），导致 SHARED LAYOUT 提示词段缺失。
      masterLayouts: currentProjectRef.current?.masterLayouts,
    }).catch((err: unknown) => {
      console.error('[Designer] Generate error:', err);
      isGeneratingRef.current = false;
      setIsGenerating(false);
      pushToast('error', `生成请求失败: ${String(err)}`);
    });
  }, [isGenerating, invoke, pushToast, chatTags, checkWritePermission]);

  /* ── Abort generation ──────────────────────────────────────────────── */
  const abortGeneration = useCallback(() => {
    invoke(IPCChannel.DesignerAbort);
    // 同步置位 ref：残留 chunk 守卫立即生效（done 事件到达前可能有窗口期）。
    // 同时释放流式 buffer —— 即使 done{aborted} 事件因异常未到达，也不滞留内存。
    isGeneratingRef.current = false;
    setIsGenerating(false);
    htmlBufferRef.current = '';
    setHtmlBuffer('');
    rawChunksRef.current = [];
    rawBufferRef.current = '';
  }, [invoke]);

  /* ── Save current HTML (public, for manual save) ───────────────────── */
  const saveCurrentHtml = useCallback(async () => {
    await saveCurrentHtmlInternal();
    pushToast('success', '已导出到本地');
  }, [saveCurrentHtmlInternal, pushToast]);

  /* ── Save current screen (manual save via toolbar / Ctrl+S) ────────── */
  // Persists the current screen's htmlBuffer to the backend and clears its
  // dirty flag. Unlike saveCurrentHtmlInternal (which handles multi-page AI
  // output), this is a single-screen save for manual canvas edits.
  const saveCurrentScreen = useCallback(async () => {
    const proj = currentProjectRef.current;
    const screenId = currentScreenIdRef.current;
    if (!proj || !screenId) return;
    const html = htmlBufferRef.current;
    if (!html.trim()) return;
    const screen = proj.screens.find(s => s.id === screenId);
    if (!screen) return;
    try {
      const res = await invoke(IPCChannel.DesignerSaveHtml, {
        projectId: proj.id,
        screenId,
        screenName: screen.name,
        html,
        folderPath: screen.folderPath,
      }) as { success: boolean; error?: string };
      if (res.success) {
        // screen.html is already patched by updateHtml/deleteElement on every
        // edit; just clear the dirty flag and refresh project metadata.
        clearDirty(screenId);
        await refreshProjects();
        pushToast('success', '已保存');
      } else {
        pushToast('error', `保存失败: ${res.error || '未知错误'}`);
      }
    } catch (err) {
      console.error('[Designer] Manual save failed:', err);
      pushToast('error', `保存失败: ${String(err)}`);
    }
  }, [invoke, refreshProjects, clearDirty, pushToast]);

  /* ── Save ALL dirty screens (manual save via toolbar "保存全部") ─────── */
  const saveAllDirtyScreens = useCallback(async () => {
    const proj = currentProjectRef.current;
    if (!proj) return;
    const dirty = Array.from(dirtyScreenIdsRef.current);
    if (dirty.length === 0) return;

    let savedCount = 0;
    let failedCount = 0;

    // Save each dirty screen in parallel
    await Promise.all(dirty.map(async (screenId) => {
      const screen = proj.screens.find(s => s.id === screenId);
      if (!screen || !screen.html?.trim()) {
        failedCount++;
        return;
      }
      try {
        const res = await invoke(IPCChannel.DesignerSaveHtml, {
          projectId: proj.id,
          screenId,
          screenName: screen.name,
          html: screen.html,
          folderPath: screen.folderPath,
        }) as { success: boolean; error?: string };
        if (res.success) {
          clearDirty(screenId);
          savedCount++;
        } else {
          failedCount++;
          console.error(`[Designer] Save all: failed for screen "${screen.name}": ${res.error}`);
        }
      } catch (err) {
        failedCount++;
        console.error(`[Designer] Save all: error saving screen "${screen.name}":`, err);
      }
    }));

    if (savedCount > 0) {
      await refreshProjects();
    }
    if (failedCount === 0) {
      pushToast('success', `已保存全部 ${savedCount} 个页面`);
    } else if (savedCount > 0) {
      pushToast('info', `已保存 ${savedCount} 个页面，${failedCount} 个保存失败`);
    } else {
      pushToast('error', '保存失败');
    }
  }, [invoke, clearDirty, refreshProjects, pushToast]);

  /* ── Create project ────────────────────────────────────────────────── */
  const createProject = useCallback(async (name: string, type: ProjectType, basePath?: string, themePrompt?: string) => {
    try {
      const result = await invoke(IPCChannel.DesignerCreateProject, { name, type, basePath, themePrompt }) as { success: boolean; project?: DesignerProject; error?: string };
      if (result.success && result.project) {
        setProjects(prev => [...prev, result.project!]);
        setCurrentProject(result.project);
        setCurrentScreenId(null);
        setHtmlBuffer('');
        htmlBufferRef.current = '';
        resetHistory('');
        pushToast('success', `项目 "${name}" 已创建`);
        return true;
      } else {
        pushToast('error', result.error || '创建项目失败');
        return false;
      }
    } catch (err) {
      console.error('[Designer] Create project failed:', err);
      pushToast('error', '创建项目失败');
      return false;
    }
  }, [invoke, pushToast, resetHistory]);

  /* ── Delete project ────────────────────────────────────────────────── */
  const deleteProject = useCallback(async (projectId: string) => {
    try {
      const result = await invoke(IPCChannel.DesignerDeleteProject, { projectId }) as { success: boolean };
      if (result.success) {
        const proj = projects.find(p => p.id === projectId);
        setProjects(prev => prev.filter(p => p.id !== projectId));
        if (currentProjectRef.current?.id === projectId) {
          setCurrentProject(null);
          setCurrentScreenId(null);
          setHtmlBuffer('');
          htmlBufferRef.current = '';
        }
        pushToast('info', `项目 "${proj?.name || ''}" 已删除`);
      }
    } catch (err) {
      console.error('[Designer] Delete project failed:', err);
      pushToast('error', '删除项目失败');
    }
  }, [invoke, projects, pushToast]);

  /* ── Rename project ────────────────────────────────────────────────── */
  const renameProject = useCallback(async (projectId: string, newName: string) => {
    try {
      const result = await invoke(IPCChannel.DesignerRenameProject, { projectId, name: newName }) as { success: boolean };
      if (result.success) {
        await refreshProjects();
        pushToast('success', '项目已重命名');
      }
    } catch (err) {
      console.error('[Designer] Rename project failed:', err);
      pushToast('error', '重命名失败');
    }
  }, [invoke, refreshProjects, pushToast]);

  /* ── Update project theme (系统设计：写回数据库 + 刷新内存) ─────────── */
  const updateProjectTheme = useCallback(async (projectId: string, themePrompt: string): Promise<boolean> => {
    try {
      const result = await invoke(IPCChannel.DesignerUpdateProjectTheme, { projectId, themePrompt }) as {
        success: boolean;
        project?: DesignerProject;
        error?: string;
      };
      if (result.success) {
        // 同步刷新 projects 列表与 currentProject 的 themePrompt
        setProjects(prev => prev.map(p => p.id === projectId ? { ...p, themePrompt } : p));
        setCurrentProject(prev => prev && prev.id === projectId ? { ...prev, themePrompt } : prev);
        pushToast('success', '系统设计已保存');
        return true;
      }
      pushToast('error', result.error || '保存系统设计失败');
      return false;
    } catch (err) {
      console.error('[Designer] Update project theme failed:', err);
      pushToast('error', '保存系统设计失败');
      return false;
    }
  }, [invoke, pushToast]);

  /* ── Load project (Bug fix: call DesignerLoadProject IPC) ──────────── */
  const loadProject = useCallback(async (projectId: string) => {
    try {
      const result = await invoke(IPCChannel.DesignerLoadProject, { projectId }) as {
        success: boolean;
        project?: DesignerProject;
        error?: string;
      };
      if (result.success && result.project) {
        const project = result.project;
        // 串行逐个加载 screen HTML：服务器/VPN 带宽有限，并发会互相抢占
        // 导致整体更慢。串行加载让每个请求独占带宽，加载完一个立即 patch
        // 到 state，用户能看到渐进式加载进度。未加载的页面 html='' 显示
        // loading 占位，失败的页面记录到 failedScreenIds 显示重试按钮。
        setFailedScreenIds(new Set());
        // 先用空 html 设置 currentProject，让画布立即显示 loading 占位
        const initialScreens = project.screens.map(s => ({ ...s, html: '' }));
        const initialProject = { ...project, screens: initialScreens };
        setCurrentProject(initialProject);
        setProjects(prev => prev.map(p => p.id === initialProject.id ? initialProject : p));
        // 默认选中第一个 screen（而非最后一个），让用户从开头看到加载进度
        if (initialScreens.length > 0) {
          const firstScreen = initialScreens[0];
          setCurrentScreenId(firstScreen.id);
          setHtmlBuffer('');
          htmlBufferRef.current = '';
          resetHistory('');
        } else {
          setCurrentScreenId(null);
          setHtmlBuffer('');
          htmlBufferRef.current = '';
          resetHistory('');
        }
        // 串行加载每个 screen
        const failedNames: string[] = [];
        for (let i = 0; i < project.screens.length; i++) {
          const s = project.screens[i];
          try {
            const screenResult = await invoke(IPCChannel.DesignerLoadScreen, { screenId: s.id }) as {
              success: boolean;
              screen?: DesignerScreen;
            };
            if (screenResult.success && screenResult.screen) {
              const html = postProcessDesignerHtml(screenResult.screen.html, project.type, project.themePrompt,
                project.masterLayouts && project.masterLayouts.length > 0
                  ? { screenId: s.id, screenName: s.name ?? '', layouts: project.masterLayouts }
                  : undefined);
              // patch 单个 screen 的 html 到 currentProject
              setCurrentProject(prev => {
                if (!prev || prev.id !== project.id) return prev;
                return {
                  ...prev,
                  screens: prev.screens.map(sc => sc.id === s.id ? { ...sc, html } : sc),
                };
              });
              setProjects(prev => prev.map(p => p.id === project.id
                ? { ...p, screens: p.screens.map(sc => sc.id === s.id ? { ...sc, html } : sc) }
                : p));
              // 若当前选中页正是刚加载完的，同步 htmlBuffer + history
              if (currentScreenIdRef.current === s.id) {
                setHtmlBuffer(html);
                htmlBufferRef.current = html;
                resetHistory(html);
              }
              continue;
            }
          } catch (err) {
            console.warn(`[Designer] Failed to load screen ${s.id} (${s.name}):`, err);
          }
          failedNames.push(s.name || s.id);
          setFailedScreenIds(prev => new Set(prev).add(s.id));
        }
        if (failedNames.length > 0) {
          pushToast('error', `${failedNames.length} 个页面加载失败（网络超时或服务器错误）：${failedNames.slice(0, 3).join('、')}${failedNames.length > 3 ? ' 等' : ''}`);
        }
      }
    } catch (err) {
      console.error('[Designer] Load project failed:', err);
      pushToast('error', `加载项目失败: ${(err as Error).message || '网络错误'}`);
    }
  }, [invoke, resetHistory, pushToast]);

  /** Reload the current project's full tree without changing the selected screen.
   *  Used after structural operations (delete/rename/move screen, folder ops)
   *  to refresh the sidebar while keeping the user's current view stable. */
  const reloadCurrentProject = useCallback(async () => {
    const proj = currentProjectRef.current;
    if (!proj) return;
    try {
      const result = await invoke(IPCChannel.DesignerLoadProject, { projectId: proj.id }) as {
        success: boolean;
        project?: DesignerProject;
        error?: string;
      };
      if (result.success && result.project) {
        const updated = result.project;
        // 树只返回摘要（html='');保留之前已加载到前端的 html，避免重命名/
        // 移动/删除等结构操作后画布被空摘要覆盖而变白。
        const prevHtmlById = new Map<string, string>();
        for (const s of proj.screens) {
          if (s.html) prevHtmlById.set(s.id, s.html);
        }
        const merged: DesignerProject = {
          ...updated,
          screens: updated.screens.map(s => {
            const h = prevHtmlById.get(s.id);
            return h ? { ...s, html: h } : s;
          }),
        };
        setProjects(prev => prev.map(p => p.id === merged.id ? merged : p));
        setCurrentProject(merged);
        // Preserve currentScreenId — do not change the selected screen
      }
    } catch (err) {
      console.error('[Designer] Reload project failed:', err);
    }
  }, [invoke]);

  /* ── 共享母版：提取（§6.2 onExtractConfirm） ───────────────────────────
   *  由 MasterLayoutExtractDialog 确认时调用。
   *  1. 保存 MasterLayout 到项目
   *  2. 把源页面元素替换为 slot 占位
   *  3. 注入母版（含高亮）并保存源页面（快照版）
   *  4. 更新本地 state */
  const extractMasterLayout = useCallback(async (
    layout: MasterLayout,
    sourceScreenId: string,
    selector: string,
  ) => {
    const proj = currentProjectRef.current;
    if (!proj) return;
    try {
      // 1. 保存 MasterLayout
      const saveRes = await invoke(IPCChannel.DesignerSaveMasterLayout, {
        projectId: proj.id,
        layout,
      }) as { success: boolean; layouts?: MasterLayout[]; error?: string };
      if (!saveRes.success || !saveRes.layouts) {
        pushToast('error', `保存共享${masterLayoutTypeLabel(layout.type)}失败：${saveRes.error || '未知错误'}`);
        return;
      }
      const newLayouts = saveRes.layouts;
      const updatedProj: DesignerProject = { ...proj, masterLayouts: newLayouts };
      setProjects(prev => prev.map(p => p.id === proj.id ? updatedProj : p));
      setCurrentProject(updatedProj);

      // 2. 把源页面元素替换为 slot 占位
      const screen = proj.screens.find(s => s.id === sourceScreenId);
      if (!screen) {
        pushToast('error', `未找到源页面，无法提取共享${masterLayoutTypeLabel(layout.type)}`);
        return;
      }
      // Use the latest iframe content (htmlBuffer) when the source screen is
      // currently selected — screen.html may lag behind if patchScreenHtml
      // hasn't flushed yet, and the user's unsaved edits would be lost.
      const sourceHtml = (currentScreenIdRef.current === sourceScreenId && htmlBufferRef.current)
        ? htmlBufferRef.current
        : (screen?.html || '');
      if (!sourceHtml) {
        pushToast('success', `已提取共享${masterLayoutTypeLabel(layout.type)}"${layout.name}"`);
        return;
      }
      const slottedHtml = replaceElementWithSlot(sourceHtml, selector, layout.slotName, layout.name);
      // 3. 注入菜单（含高亮）+ 后处理
      const injected = postProcessDesignerHtml(slottedHtml, proj.type, proj.themePrompt,
        { screenId: sourceScreenId, screenName: screen.name ?? '', layouts: newLayouts });

      // 4. 保存源页面（快照版）
      const updateRes = await invoke(IPCChannel.DesignerSaveHtml, {
        projectId: proj.id,
        screenId: sourceScreenId,
        screenName: screen.name,
        html: injected,
        folderPath: screen.folderPath,
      }) as { success: boolean; error?: string };
      if (!updateRes.success) {
        pushToast('error', `源页面保存失败：${updateRes.error || '未知错误'}`);
        return;
      }
      // patch 本地 state
      patchScreenHtml(sourceScreenId, injected);
      // 自动保存：源页面已通过 DesignerSaveHtml 持久化，清除 dirty 标记
      clearDirty(sourceScreenId);
      const finalProj: DesignerProject = {
        ...updatedProj,
        screens: updatedProj.screens.map(s => s.id === sourceScreenId ? { ...s, html: injected } : s),
      };
      setProjects(prev => prev.map(p => p.id === proj.id ? finalProj : p));
      setCurrentProject(finalProj);
      if (currentScreenIdRef.current === sourceScreenId) {
        setHtmlBuffer(injected);
        htmlBufferRef.current = injected;
      }
      pushToast('success', `已提取共享${masterLayoutTypeLabel(layout.type)}"${layout.name}"，并应用到当前页面`);
    } catch (err) {
      console.error('[Designer] extractMasterLayout failed:', err);
      pushToast('error', `提取失败：${String(err)}`);
    }
  }, [invoke, pushToast, patchScreenHtml, clearDirty]);

  /* ── 共享母版：应用编辑（管理对话框保存时调用，§6.5） ────────────────
   *  1. 保存 MasterLayout
   *  2. InjectAll 到后端所有页面（主进程 cheerio + 串行 UPDATE + 进度事件）
   *  3. 本地用 renderer 端 injectMasterLayouts 重新注入各 screen（避免全量重拉）
   *  注入兼容：快照版 screen.html 仍保留 [data-design-slot] 外壳，innerHTML 被替换，
   *  重新注入会再次找到 slot 外壳并替换 innerHTML（§6.4.2）。*/
  const applyMasterLayoutEdit = useCallback(async (layout: MasterLayout) => {
    const proj = currentProjectRef.current;
    if (!proj) return;
    try {
      // 1. 保存 MasterLayout
      const saveRes = await invoke(IPCChannel.DesignerSaveMasterLayout, {
        projectId: proj.id,
        layout,
      }) as { success: boolean; layouts?: MasterLayout[]; error?: string };
      if (!saveRes.success || !saveRes.layouts) {
        pushToast('error', `保存共享${masterLayoutTypeLabel(layout.type)}失败：${saveRes.error || '未知错误'}`);
        return;
      }
      const newLayouts = saveRes.layouts;
      // Use the persisted layout (id may have been generated by the save handler
      // if the original layout.id was empty). Passing it directly to inject-all
      // avoids a re-fetch round-trip that could fail with "MasterLayout not found"
      // if the server hasn't propagated the write yet.
      const savedLayout = newLayouts.find(l => l.id === layout.id) ?? newLayouts[0] ?? layout;

      // 2. InjectAll 到后端所有页面
      const injectRes = await invoke(IPCChannel.DesignerInjectMasterLayoutAll, {
        projectId: proj.id,
        layoutId: savedLayout.id,
        layout: savedLayout,
      }) as { success: boolean; updated?: number; failed?: Array<{ screenId: string; reason: string }>; error?: string };
      if (!injectRes.success) {
        pushToast('error', `同步失败：${injectRes.error || '未知错误'}`);
        return;
      }
      const typeLabel = masterLayoutTypeLabel(layout.type);
      const updatedCount = injectRes.updated ?? 0;
      const failedList = injectRes.failed ?? [];

      // 3. 本地重新注入各 screen（避免全量重拉）
      //    传 screenName 以正确高亮当前页菜单项（scoreMenuMatch 文本匹配 + 父级展开）。
      //    编辑母版同步到各页面时，每页仍按自身 screenName 重新选优高亮，互不影响。
      const updatedProj: DesignerProject = { ...proj, masterLayouts: newLayouts };
      updatedProj.screens = proj.screens.map(s => {
        if (!s.html) return s;
        const reInjected = injectMasterLayouts(s.html, s.id, s.name ?? '', newLayouts);
        return { ...s, html: reInjected };
      });
      setProjects(prev => prev.map(p => p.id === proj.id ? updatedProj : p));
      setCurrentProject(updatedProj);
      // 若当前选中页受影响，同步 htmlBuffer
      const curId = currentScreenIdRef.current;
      if (curId) {
        const cur = updatedProj.screens.find(s => s.id === curId);
        if (cur?.html) {
          setHtmlBuffer(cur.html);
          htmlBufferRef.current = cur.html;
        }
      }

      // 4. 反馈
      if (failedList.length === 0) {
        pushToast('success', `共享${typeLabel}已同步到 ${updatedCount} 个页面`);
      } else {
        const names = failedList.map(f => {
          const sc = proj.screens.find(s => s.id === f.screenId);
          return sc?.name || f.screenId;
        });
        pushToast('info', `同步 ${updatedCount} 页，${failedList.length} 页失败：${names.slice(0, 3).join('、')}${names.length > 3 ? ' 等' : ''}（保留旧${typeLabel}）`);
      }
    } catch (err) {
      console.error('[Designer] applyMasterLayoutEdit failed:', err);
      pushToast('error', `应用失败：${String(err)}`);
    }
  }, [invoke, pushToast]);

  /* ── 共享母版：删除 ──────────────────────────────────────────────────
   *  删除 MasterLayout（不自动清理已注入页面的菜单——保留快照，页面继续可用）。*/
  const deleteMasterLayout = useCallback(async (layoutId: string) => {
    const proj = currentProjectRef.current;
    if (!proj) return;
    // 查找 layout 以获取类型用于 type-aware toast
    const layout = (proj.masterLayouts ?? []).find(l => l.id === layoutId);
    const typeLabel = layout ? masterLayoutTypeLabel(layout.type) : '母版';
    try {
      const res = await invoke(IPCChannel.DesignerDeleteMasterLayout, {
        projectId: proj.id,
        layoutId,
      }) as { success: boolean; layouts?: MasterLayout[]; error?: string };
      if (!res.success) {
        pushToast('error', `删除失败：${res.error || '未知错误'}`);
        return;
      }
      const updatedProj: DesignerProject = { ...proj, masterLayouts: res.layouts };
      setProjects(prev => prev.map(p => p.id === proj.id ? updatedProj : p));
      setCurrentProject(updatedProj);
      pushToast('success', `已删除共享${typeLabel}（已注入页面保留现有${typeLabel}）`);
    } catch (err) {
      console.error('[Designer] deleteMasterLayout failed:', err);
      pushToast('error', `删除失败：${String(err)}`);
    }
  }, [invoke, pushToast]);

  /* ── Load screen ───────────────────────────────────────────────────── */
  const loadScreen = useCallback(async (projectId: string, screenId: string) => {
    const project = projects.find(p => p.id === projectId);
    if (project) {
      setCurrentProject(project);
      const screen = project.screens.find(s => s.id === screenId);
      if (screen) {
        setCurrentScreenId(screenId);
        // NOTE: Do NOT clear the dirty flag here. When switching between
        // screens, the projects state already holds locally-patched HTML
        // (including unsaved manual edits made via updateHtml → patchScreenHtml).
        // Clearing dirty here would make the Save button disabled after
        // switching away and back to a screen with pending edits.
        // The dirty flag is cleared only by saveCurrentScreen / saveCurrentHtmlInternal
        // after a successful backend save.
        // The tree only returns screen summaries (html=''). If the screen's
        // html is empty, fetch the full content from the backend.
        if (screen.html) {
          const html = postProcessDesignerHtml(screen.html, project.type, project.themePrompt,
            project.masterLayouts && project.masterLayouts.length > 0
              ? { screenId, screenName: screen.name ?? '', layouts: project.masterLayouts }
              : undefined);
          setHtmlBuffer(html);
          htmlBufferRef.current = html;
          resetHistory(html);
        } else {
          try {
            const result = await invoke(IPCChannel.DesignerLoadScreen, { screenId }) as {
              success: boolean;
              screen?: DesignerScreen;
            };
            if (result.success && result.screen) {
              const html = postProcessDesignerHtml(result.screen.html, project.type, project.themePrompt,
                project.masterLayouts && project.masterLayouts.length > 0
                  ? { screenId, screenName: result.screen.name ?? '', layouts: project.masterLayouts }
                  : undefined);
              setHtmlBuffer(html);
              htmlBufferRef.current = html;
              resetHistory(html);
              // Sync fetched HTML into the screen summary so SavedPages renders
              // content instead of an empty srcDoc.
              patchScreenHtml(screenId, html);
            }
          } catch (err) {
            console.error('[Designer] Load screen failed:', err);
          }
        }
      }
    }
  }, [projects, invoke, resetHistory, patchScreenHtml]);

  /* ── Reload a single failed screen (manual retry from canvas).
   *  调 DesignerLoadScreen 拉取 HTML，成功后 patchScreenHtml 到 state 并从
   *  failedScreenIds 中移除（让 SavedPages 显示内容而非重试按钮）。
   *  若该 screen 正是当前选中页，同步 htmlBuffer + history。
   *  返回 true 表示成功，false 表示失败（让 UI 保持重试按钮）。*/
  const reloadScreen = useCallback(async (screenId: string): Promise<boolean> => {
    const proj = currentProjectRef.current;
    if (!proj) return false;
    try {
      const result = await invoke(IPCChannel.DesignerLoadScreen, { screenId }) as {
        success: boolean;
        screen?: DesignerScreen;
      };
      if (!result.success || !result.screen) return false;
      const html = postProcessDesignerHtml(result.screen.html, proj.type, proj.themePrompt,
        proj.masterLayouts && proj.masterLayouts.length > 0
          ? { screenId, screenName: result.screen.name ?? '', layouts: proj.masterLayouts }
          : undefined);
      patchScreenHtml(screenId, html);
      setProjects(prev => prev.map(p => p.id === proj.id
        ? { ...p, screens: p.screens.map(sc => sc.id === screenId ? { ...sc, html } : sc) }
        : p));
      // 若是当前选中页，同步 htmlBuffer + history
      if (currentScreenIdRef.current === screenId) {
        setHtmlBuffer(html);
        htmlBufferRef.current = html;
        resetHistory(html);
      }
      // 从 failedScreenIds 移除（成功加载，不再显示重试按钮）
      setFailedScreenIds(prev => {
        if (!prev.has(screenId)) return prev;
        const next = new Set(prev);
        next.delete(screenId);
        return next;
      });
      return true;
    } catch (err) {
      console.warn(`[Designer] Reload screen ${screenId} failed:`, err);
      return false;
    }
  }, [invoke, patchScreenHtml, resetHistory]);

  /* ── Deselect screen (clear currentScreenId so new generation creates a new page) ── */
  const deselectScreen = useCallback(() => {
    setCurrentScreenId(null);
    setHtmlBuffer('');
    htmlBufferRef.current = '';
    setSelectedElement(null);
    resetHistory('');
  }, [resetHistory]);

  /* ── Create a blank screen for manual design ──────────────────────
   *  生成一个空白 HTML 页面并创建 screen 记录，加载到画布。
   *  与 AI 生成互斥：isGenerating 时拒绝。
   *  空白 HTML 仅含最小骨架，postProcess 会自动注入 Bootstrap CDN + 主题变量 + 滚动条。
   *  复用 saveCurrentHtmlInternal 走"新建"分支创建 screen 记录（含权限/目录处理）。
   */
  const createBlankScreen = useCallback(async () => {
    const proj = currentProjectRef.current;
    if (!proj) {
      pushToast('error', '请先选择一个项目');
      return;
    }
    if (isGenerating) {
      pushToast('error', 'AI 正在生成，请等待完成或中止后再创建空白页');
      return;
    }
    // 清空 currentScreenId → saveCurrentHtmlInternal 走"新建"分支
    setCurrentScreenId(null);
    currentScreenIdRef.current = null;
    setSelectedElement(null);

    const blankName = `Untitled-${proj.screens.length + 1}`;
    const blankHtml = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${blankName}</title>
</head>
<body class="bg-background text-on-background" style="margin:0;min-height:100vh;">
  <div data-design-id="page-root" class="d-flex flex-column" style="min-height:100vh;">
    <div data-design-id="page-hint" class="d-flex align-items-center justify-content-center flex-grow-1">
      <div class="text-center" style="opacity:0.4;">
        <i class="bi bi-plus-circle" style="font-size:40px;"></i>
        <p class="mt-2 mb-0 text-on-surface-variant small">拖入组件或布局模板开始设计</p>
      </div>
    </div>
  </div>
</body>
</html>`;

    setHtmlBuffer(blankHtml);
    htmlBufferRef.current = blankHtml;
    resetHistory(blankHtml);

    // 复用现有保存逻辑创建 screen 记录（会自动 postProcess 注入 Bootstrap + 主题）
    await saveCurrentHtmlInternal();
  }, [isGenerating, pushToast, resetHistory, saveCurrentHtmlInternal]);

  /* ── Import an HTML file as a new screen ─────────────────────────────
   *  直接调用 IPC DesignerSaveHtml 保存（支持 folderPath），不走
   *  saveCurrentHtmlInternal（它不接收外部 folderPath）。
   *  保存后刷新项目列表和当前项目树，并选中新页面。
   */
  const importHtmlScreen = useCallback(async (html: string, screenName: string, folderPath?: string) => {
    const proj = currentProjectRef.current;
    if (!proj) {
      pushToast('error', '请先选择一个项目');
      return;
    }
    if (isGenerating) {
      pushToast('error', 'AI 正在生成，请等待完成或中止后再导入');
      return;
    }

    // 用传入的 HTML 构造带名称的文档（替换或追加 title）
    let finalHtml = html.trim();
    if (!/<title[^>]*>/i.test(finalHtml)) {
      finalHtml = finalHtml.replace(/<head[^>]*>/i, `$&\n  <title>${screenName}</title>`);
    } else {
      finalHtml = finalHtml.replace(/<title[^>]*>[\s\S]*?<\/title>/i, `<title>${screenName}</title>`);
    }

    // 后处理：注入 Bootstrap CDN + 主题 + 滚动条 + 共享菜单（若有 slot）
    const screenId = generateId();
    const styledHtml = postProcessDesignerHtml(finalHtml, proj.type, proj.themePrompt,
      proj.masterLayouts && proj.masterLayouts.length > 0
        ? { screenId, screenName, layouts: proj.masterLayouts }
        : undefined);

    const now = Date.now();
    const fullScreenName = `${screenName} — ${formatDate(now)}`;

    try {
      const res = await invoke(IPCChannel.DesignerSaveHtml, {
        projectId: proj.id,
        screenId,
        screenName: fullScreenName,
        html: styledHtml,
        folderPath,
      }) as { success: boolean; screenId?: string; error?: string };

      if (!res.success) {
        pushToast('error', `导入失败：${res.error || '未知错误'}`);
        return;
      }

      const savedId = res.screenId ?? screenId;

      // 刷新项目列表
      const listResult = await invoke(IPCChannel.DesignerListProjects) as { success: boolean; projects?: DesignerProject[] };
      if (listResult.success && listResult.projects) {
        setProjects(listResult.projects);
      }

      // 重新加载当前项目树
      const loadResult = await invoke(IPCChannel.DesignerLoadProject, { projectId: proj.id }) as {
        success: boolean;
        project?: DesignerProject;
        error?: string;
      };
      if (loadResult.success && loadResult.project) {
        const updated = loadResult.project;
        // 将刚保存的 HTML 补丁到树中（树返回的 screen 摘要 html=''）
        const patched: DesignerProject = {
          ...updated,
          screens: updated.screens.map(s =>
            s.id === savedId ? { ...s, html: styledHtml } : s
          ),
        };
        // 保留其他 screen 已加载的 html
        const prevHtmlById = new Map<string, string>();
        for (const s of proj.screens) {
          if (s.html) prevHtmlById.set(s.id, s.html);
        }
        patched.screens = patched.screens.map(s => {
          if (s.html) return s;
          const prevHtml = prevHtmlById.get(s.id);
          if (prevHtml) return { ...s, html: prevHtml };
          return s;
        });
        setProjects(prev => prev.map(p => p.id === patched.id ? patched : p));
        setCurrentProject(patched);

        // 选中新导入的页面
        setCurrentScreenId(savedId);
        currentScreenIdRef.current = savedId;
        setHtmlBuffer(styledHtml);
        htmlBufferRef.current = styledHtml;
        resetHistory(styledHtml);
        setSelectedElement(null);
      }

      pushToast('success', `页面 "${screenName}" 导入成功`);
    } catch (err) {
      console.error('[Designer] Import HTML failed:', err);
      pushToast('error', '导入失败');
    }
  }, [isGenerating, invoke, pushToast, resetHistory]);

  /* ── Switch designer mode between 'new' and 'edit' ──────────────────
   *  'new'  : 记住当前 screenId（或元素标签所属 screenId），然后清空画布，
   *           进入「新建空白页」状态；同时清除元素/页面标签（它们仅用于修改）。
   *  'edit' : 恢复之前记住的 screenId，重新加载到画布上（删除空白页状态）。
   *           若记住的 screen 已被删除，则清空 savedScreenId 并提示。
   *  约束：如果没有选中文件（savedScreenId 为空），不能切回「修改」。
   *  canSwitchToEdit 由 savedScreenId 派生，供 UI 禁用「修改」按钮。
   */
  const switchDesignerMode = useCallback((mode: 'new' | 'edit') => {
    if (mode === 'new') {
      // 记住当前 screenId（若有），否则尝试从元素标签取所属 screenId
      const cur = currentScreenIdRef.current;
      if (cur) {
        setSavedScreenId(cur);
        savedScreenIdRef.current = cur;
      } else {
        const elementTag = chatTags.find(t => t.type === 'element' && t.screenId);
        if (elementTag?.screenId) {
          setSavedScreenId(elementTag.screenId);
          savedScreenIdRef.current = elementTag.screenId;
        }
      }
      // 清空画布 → 视觉上「新建一个空白页」
      deselectScreen();
      // 元素/页面标签仅用于修改模式，切到新建时清除
      setChatTags(prev => prev.filter(t => t.type !== 'element' && t.type !== 'screen'));
    } else {
      // 恢复之前记住的 screen → 视觉上「删除空白页」并回到修改模式
      const savedId = savedScreenIdRef.current;
      const proj = currentProjectRef.current;
      if (savedId && proj) {
        const screen = proj.screens.find(s => s.id === savedId);
        if (screen) {
          loadScreen(proj.id, savedId);
        } else {
          // 记住的页面已被删除，清空 savedScreenId，无法切回修改
          setSavedScreenId(null);
          savedScreenIdRef.current = null;
          pushToast('info', '原页面已不存在，无法切回修改模式');
        }
      }
    }
  }, [deselectScreen, loadScreen, chatTags, pushToast]);

  /* ── Delete screen ─────────────────────────────────────────────────── */
  const deleteScreen = useCallback(async (projectId: string, screenId: string) => {
    try {
      const result = await invoke(IPCChannel.DesignerDeleteScreen, { projectId, screenId }) as { success: boolean };
      if (result.success) {
        // If the deleted screen was selected, clear canvas
        if (currentScreenIdRef.current === screenId) {
          setCurrentScreenId(null);
          setHtmlBuffer('');
          htmlBufferRef.current = '';
        }
        // 若删除的正是切到「新建」时记住的页面，清除 savedScreenId，
        // 防止用户切回「修改」时尝试加载已不存在的页面。
        if (savedScreenIdRef.current === screenId) {
          setSavedScreenId(null);
          savedScreenIdRef.current = null;
        }
        await reloadCurrentProject();
        pushToast('info', '页面已删除');
      }
    } catch (err) {
      console.error('[Designer] Delete screen failed:', err);
      pushToast('error', '删除页面失败');
    }
  }, [invoke, reloadCurrentProject, pushToast]);

  /* ── Rename screen ─────────────────────────────────────────────────── */
  const renameScreen = useCallback(async (projectId: string, screenId: string, newName: string) => {
    try {
      const result = await invoke(IPCChannel.DesignerRenameScreen, { projectId, screenId, name: newName }) as { success: boolean };
      if (result.success) {
        await reloadCurrentProject();
      }
    } catch (err) {
      console.error('[Designer] Rename screen failed:', err);
    }
  }, [invoke, reloadCurrentProject]);

  /* ── Duplicate screen ──────────────────────────────────────────────── */
  const duplicateScreen = useCallback(async (projectId: string, screenId: string) => {
    try {
      const result = await invoke(IPCChannel.DesignerDuplicateScreen, { projectId, screenId }) as { success: boolean };
      if (result.success) {
        await reloadCurrentProject();
        pushToast('success', '页面已复制');
      }
    } catch (err) {
      console.error('[Designer] Duplicate screen failed:', err);
      pushToast('error', '复制页面失败');
    }
  }, [invoke, reloadCurrentProject, pushToast]);

  /* ── Move screen to a folder ───────────────────────────────────────── */
  const moveScreen = useCallback(async (projectId: string, screenId: string, folderPath: string) => {
    try {
      const result = await invoke(IPCChannel.DesignerMoveScreen, { projectId, screenId, folderPath }) as { success: boolean };
      if (result.success) {
        await reloadCurrentProject();
      }
    } catch (err) {
      console.error('[Designer] Move screen failed:', err);
      pushToast('error', '移动页面失败');
    }
  }, [invoke, reloadCurrentProject, pushToast]);

  /* ── Create folder ──────────────────────────────────────────────────── */
  const createFolder = useCallback(async (projectId: string, folderPath: string) => {
    try {
      const result = await invoke(IPCChannel.DesignerCreateFolder, { projectId, folderPath }) as { success: boolean; error?: string };
      if (result.success) {
        await reloadCurrentProject();
      } else if (result.error) {
        pushToast('error', result.error);
      }
    } catch (err) {
      console.error('[Designer] Create folder failed:', err);
      pushToast('error', '创建文件夹失败');
    }
  }, [invoke, reloadCurrentProject, pushToast]);

  /* ── Delete folder ──────────────────────────────────────────────────── */
  const deleteFolder = useCallback(async (projectId: string, folderPath: string) => {
    try {
      const result = await invoke(IPCChannel.DesignerDeleteFolder, { projectId, folderPath }) as { success: boolean; error?: string };
      if (result.success) {
        await reloadCurrentProject();
      } else if (result.error) {
        pushToast('error', result.error);
      }
    } catch (err) {
      console.error('[Designer] Delete folder failed:', err);
      pushToast('error', '删除文件夹失败');
    }
  }, [invoke, reloadCurrentProject, pushToast]);

  /* ── Rename folder ──────────────────────────────────────────────────── */
  const renameFolder = useCallback(async (projectId: string, folderPath: string, newName: string) => {
    try {
      const result = await invoke(IPCChannel.DesignerRenameFolder, { projectId, folderPath, newName }) as { success: boolean; error?: string };
      if (result.success) {
        await reloadCurrentProject();
      } else if (result.error) {
        pushToast('error', result.error);
      }
    } catch (err) {
      console.error('[Designer] Rename folder failed:', err);
      pushToast('error', '重命名文件夹失败');
    }
  }, [invoke, reloadCurrentProject, pushToast]);

  /* ── Set home screen ─────────────────────────────────────────────────── */
  const setHomeScreen = useCallback(async (projectId: string, screenId: string | null) => {
    try {
      const result = await invoke(IPCChannel.DesignerSetHomeScreen, { projectId, screenId }) as { success: boolean; error?: string };
      if (result.success) {
        await reloadCurrentProject();
        pushToast('success', screenId ? '已设置为首页' : '已取消首页设置');
      } else if (result.error) {
        pushToast('error', result.error);
      }
    } catch (err) {
      console.error('[Designer] Set home screen failed:', err);
      pushToast('error', '设置首页失败');
    }
  }, [invoke, reloadCurrentProject, pushToast]);

  /* ── Reorder screen (drag within same folder) ────────────────────────── */
  const reorderScreen = useCallback(async (screenId: string, targetScreenId: string, insertBefore: boolean) => {
    try {
      const result = await invoke(IPCChannel.DesignerReorderScreen, { screenId, targetScreenId, insertBefore }) as { success: boolean; error?: string };
      if (result.success) {
        await reloadCurrentProject();
      } else if (result.error) {
        pushToast('error', result.error);
      }
    } catch (err) {
      console.error('[Designer] Reorder screen failed:', err);
      pushToast('error', '调整排序失败');
    }
  }, [invoke, reloadCurrentProject, pushToast]);

  /* ── Apply theme via AI (project-level or screen-level) ────────────── */
  const applyTheme = useCallback(async (themePrompt: string, scope: 'project' | 'screen') => {
    if (isGenerating) return;
    const proj = currentProjectRef.current;
    if (!proj) {
      pushToast('error', '请先选择项目');
      return;
    }

    const currentHtml = htmlBufferRef.current;
    if (!currentHtml.trim()) {
      pushToast('error', '当前没有页面内容');
      return;
    }

    // AI 操作前置权限检查:主题修改会触发保存,需对当前目录有写权限
    const allowed = await checkWritePermission();
    if (!allowed) return;

    // Parse theme prompt JSON to extract colors and style instructions
    const themeData = parseThemePrompt(themePrompt);
    const parts: string[] = [];

    if (themeData.colors && Object.keys(themeData.colors).length > 0) {
      const themeCss = buildBootstrapTheme(themeData);
      parts.push(`请更新页面的 CSS 主题变量为以下值（替换现有的 :root CSS 变量块，保留其他内容不变）：\n\n${themeCss}\n\n更新所有使用设计 token 的 CSS 类名以匹配新配置。`);
    }

    if (themeData.stylePrompt) {
      parts.push(`请应用以下视觉风格：\n\n${themeData.stylePrompt}`);
    }

    if (parts.length === 0) {
      // Legacy text format — use as-is
      parts.push(themePrompt);
    }

    setIsGenerating(true);
    const fullPrompt = `请修改以下HTML页面的主题风格。\n\n${parts.join('\n\n')}\n\n保持页面结构和内容不变，只修改样式相关属性（CSS 变量、Bootstrap 类名、自定义 CSS）。返回完整的HTML文件。\n\n当前HTML:\n${currentHtml}`;
    invoke(IPCChannel.DesignerGenerate, {
      prompt: fullPrompt,
      projectType: proj.type,
      projectId: proj.id,
      screenId: currentScreenIdRef.current,
      existingHtml: currentHtml,
    }).catch((err: unknown) => {
      console.error('[Designer] Theme generation error:', err);
      setIsGenerating(false);
      pushToast('error', `主题应用失败: ${String(err)}`);
    });
  }, [isGenerating, invoke, pushToast, checkWritePermission]);

  /* ── Export project as Vue 3 ───────────────────────────────────────── */
  const exportVue = useCallback(async (projectId: string, outputDir: string) => {
    try {
      const result = await invoke(IPCChannel.DesignerExportVue, { projectId, outputDir }) as { success: boolean; path?: string; error?: string };
      if (result.success) {
        pushToast('success', `Vue 项目已导出到: ${result.path}`);
      } else {
        pushToast('error', `导出失败: ${result.error || '未知错误'}`);
        throw new Error(result.error);
      }
    } catch (err) {
      console.error('[Designer] Export Vue failed:', err);
      pushToast('error', `导出 Vue 项目失败: ${String(err)}`);
      throw err;
    }
  }, [invoke, pushToast]);

  /* ── Element selection: set/clear selected element ─────────────────── */
  const selectElement = useCallback((el: SelectedElement | null) => {
    setSelectedElement(el);
  }, []);

  /* ── Update element style in the current screen's HTML ─────────────── */
  const updateElementStyle = useCallback((selector: string, style: Partial<ElementStyle>) => {
    // The actual DOM manipulation is done in DesignerCanvas.
    // Here we just update the selectedElement state and trigger a save.
    setSelectedElement(prev => {
      if (!prev || prev.selector !== selector) return prev;
      return { ...prev, style: { ...prev.style, ...style } };
    });
  }, []);

  /* ── Add selected element to chat as a tag ─────────────────────────── */
  const addElementToChat = useCallback(() => {
    const el = selectedElementRef.current;
    const proj = currentProjectRef.current;
    const screenId = currentScreenIdRef.current;
    if (!el || !proj || !screenId) return;

    const screen = proj.screens.find(s => s.id === screenId);
    const tag: ChatTag = {
      id: generateId(),
      type: 'element',
      filePath: screen?.name || 'screen',
      elementSelector: el.selector,
      elementHtml: `<${el.tagName}${el.id ? ` id="${el.id}"` : ''}${el.className ? ` class="${el.className}"` : ''}>${el.style.text}</${el.tagName}>`,
      elementTag: el.tagName,
      screenId,
      screenName: screen?.name,
    };
    // Only one element tag allowed at a time — replace any existing element tag.
    setChatTags(prev => {
      const others = prev.filter(t => t.type !== 'element');
      return [...others, tag];
    });
    pushToast('success', '已添加到对话');
  }, [pushToast]);

  /* ── Add a screen to chat as a style reference tag ─────────────────── */
  const addScreenToChat = useCallback((projectId: string, screenId: string) => {
    const proj = currentProjectRef.current;
    if (!proj || proj.id !== projectId) return;
    const screen = proj.screens.find(s => s.id === screenId);
    if (!screen) return;

    const tag: ChatTag = {
      id: generateId(),
      type: 'screen',
      filePath: screen.name || 'screen',
      content: screen.html,
      screenId,
      screenName: screen.name,
    };
    setChatTags(prev => [...prev, tag]);
    pushToast('success', '已添加到对话');
  }, [pushToast]);

  /* ── Delete element from the screen ────────────────────────────────── */
  const deleteElement = useCallback((selector: string) => {
    const proj = currentProjectRef.current;
    const screenId = currentScreenIdRef.current;
    if (!proj || !screenId) return;

    const screen = proj.screens.find(s => s.id === screenId);
    if (!screen) return;

    // Use the latest HTML buffer (mirrors the live iframe DOM including unsaved
    // edits) rather than screen.html, which may be stale after recent canvas
    // edits (drag/resize/duplicate) because refreshProjects() only merges
    // project metadata and never updates screens[i].html.
    const sourceHtml = htmlBufferRef.current || screen.html;

    // Parse the HTML and remove the element
    try {
      const parser = new DOMParser();
      const doc = parser.parseFromString(sourceHtml, 'text/html');
      const el = doc.querySelector(selector);
      if (el) {
        el.remove();
        const newHtml = '<!DOCTYPE html>\n' + doc.documentElement.outerHTML;
        setHtmlBuffer(newHtml);
        htmlBufferRef.current = newHtml;
        // Patch the screen's HTML in currentProject so the iframe's srcDoc
        // updates and re-renders without the deleted element. Without this,
        // the iframe keeps showing the old content (screen.html is never
        // refreshed by refreshProjects, and deleteElement does not touch the
        // live iframe DOM unlike handleDuplicateElement).
        patchScreenHtml(screenId, newHtml);
        pushHistory(newHtml);
        // Mark dirty — user saves explicitly via toolbar/Ctrl+S.
        markDirty(screenId);
      }
      setSelectedElement(null);
    } catch (err) {
      console.error('[Designer] Delete element failed:', err);
    }
  }, [pushHistory, patchScreenHtml, markDirty]);

  /* ── Update HTML (from manual editing in canvas) ───────────────────── */
  // Manual canvas edits (drag/resize/style/duplicate/reorder/inline-edit)
  // only update the in-memory buffer + screen.html and mark the screen dirty.
  // The user persists changes explicitly via the toolbar Save button or
  // Ctrl+S (see saveCurrentScreen). This avoids the previous 1000ms
  // debounce auto-save whose race with the Refresh button caused edits to
  // be reverted (screen.html was never patched, so reloadCurrentProject's
  // prevHtmlById fallback restored stale content).
  const updateHtml = useCallback((newHtml: string) => {
    const proj = currentProjectRef.current;
    const screenId = currentScreenIdRef.current;
    if (!proj || !screenId) return;

    setHtmlBuffer(newHtml);
    htmlBufferRef.current = newHtml;
    // Patch screen.html so the iframe srcDoc and reloadCurrentProject's
    // prevHtmlById both reflect the latest edit — refresh no longer reverts.
    patchScreenHtml(screenId, newHtml);
    markDirty(screenId);
    pushHistory(newHtml);
  }, [patchScreenHtml, markDirty, pushHistory]);

  /* ── Remove a chat tag ─────────────────────────────────────────────── */
  const removeChatTag = useCallback((tagId: string) => {
    setChatTags(prev => prev.filter(t => t.id !== tagId));
  }, []);

  /* ── Restore chat tags from a history snapshot ─────────────────────── */
  // Replaces the entire chatTags state with the provided snapshot. Used by
  // the designer input history feature to restore a previously-sent message's
  // inline references (file/table/element/screen/code chips).
  const restoreChatTags = useCallback((tags: ChatTag[]) => {
    setChatTags(tags);
  }, []);

  /* ── Publication (设计图发布) ──────────────────────────────────────── */
  const createPublication = useCallback(async (projectId: string, req: CreatePublicationRequest): Promise<Publication | null> => {
    try {
      const result = await invoke(IPCChannel.DesignerCreatePublication, { projectId, req }) as { success: boolean; publication?: Publication; error?: string };
      if (result.success && result.publication) {
        pushToast('success', '发布成功');
        return result.publication;
      }
      pushToast('error', result.error || '发布失败');
      return null;
    } catch (err) {
      pushToast('error', String(err));
      return null;
    }
  }, [invoke, pushToast]);

  const listPublications = useCallback(async (projectId: string): Promise<Publication[]> => {
    try {
      const result = await invoke(IPCChannel.DesignerListPublications, { projectId }) as { success: boolean; publications?: Publication[] };
      return result.success ? (result.publications ?? []) : [];
    } catch {
      return [];
    }
  }, [invoke]);

  const deletePublication = useCallback(async (projectId: string, publicationId: number): Promise<boolean> => {
    try {
      const result = await invoke(IPCChannel.DesignerDeletePublication, { projectId, publicationId }) as { success: boolean };
      if (result.success) pushToast('success', '已取消发布');
      return result.success;
    } catch {
      return false;
    }
  }, [invoke, pushToast]);

  const refreshPublication = useCallback(async (projectId: string, publicationId: number): Promise<Publication | null> => {
    try {
      const result = await invoke(IPCChannel.DesignerRefreshPublication, { projectId, publicationId }) as { success: boolean; publication?: Publication; error?: string };
      if (result.success && result.publication) {
        pushToast('success', '已更新发布');
        return result.publication;
      }
      pushToast('error', result.error || '更新失败');
      return null;
    } catch (err) {
      pushToast('error', String(err));
      return null;
    }
  }, [invoke, pushToast]);

  /* ── Screen History (设计稿历史版本) ──────────────────────────────── */
  const listScreenHistory = useCallback(async (screenId: string): Promise<ScreenHistorySummary[]> => {
    try {
      const result = await invoke(IPCChannel.DesignerListScreenHistory, { screenId }) as { success: boolean; history?: ScreenHistorySummary[] };
      return result.success ? (result.history ?? []) : [];
    } catch {
      return [];
    }
  }, [invoke]);

  const getScreenHistoryContent = useCallback(async (screenId: string, historyId: number): Promise<ScreenHistoryContent | null> => {
    try {
      const result = await invoke(IPCChannel.DesignerGetScreenHistoryContent, { screenId, historyId }) as { success: boolean; content?: ScreenHistoryContent; error?: string };
      if (result.success && result.content) return result.content;
      pushToast('error', result.error || '获取历史内容失败');
      return null;
    } catch (err) {
      pushToast('error', String(err));
      return null;
    }
  }, [invoke, pushToast]);

  const restoreScreenHistory = useCallback(async (screenId: string, historyId: number): Promise<DesignerScreen | null> => {
    try {
      const result = await invoke(IPCChannel.DesignerRestoreScreenHistory, { screenId, historyId }) as { success: boolean; screen?: DesignerScreen; error?: string };
      if (result.success && result.screen) {
        pushToast('success', '已恢复到历史版本');
        return result.screen;
      }
      pushToast('error', result.error || '恢复失败');
      return null;
    } catch (err) {
      pushToast('error', String(err));
      return null;
    }
  }, [invoke, pushToast]);

  return {
    projects,
    currentProject,
    currentScreenId,
    htmlBuffer,
    isGenerating,
    streamingText,
    toasts,
    selectedElement,
    chatTags,
    generateHtml,
    abortGeneration,
    saveCurrentHtml,
    dirtyScreenIds,
    saveCurrentScreen,
    saveAllDirtyScreens,
    createProject,
    deleteProject,
    renameProject,
    updateProjectTheme,
    loadProject,
    loadScreen,
    reloadCurrentProject,
    reloadScreen,
    failedScreenIds,
    deselectScreen,
    createBlankScreen,
    importHtmlScreen,
    switchDesignerMode,
    canSwitchToEdit: !!savedScreenId,
    deleteScreen,
    renameScreen,
    duplicateScreen,
    refreshProjects,
    dismissToast,
    selectElement,
    updateElementStyle,
    addElementToChat,
    addScreenToChat,
    deleteElement,
    updateHtml,
    removeChatTag,
    restoreChatTags,
    moveScreen,
    createFolder,
    deleteFolder,
    renameFolder,
    setHomeScreen,
    reorderScreen,
    applyTheme,
    exportVue,
    undo,
    redo,
    canUndo,
    canRedo,
    permissionWarning,
    dismissPermissionWarning,
    folderSelectDialog,
    onFolderSelect,
    onFolderSelectCancel,
    createPublication,
    listPublications,
    deletePublication,
    refreshPublication,
    listScreenHistory,
    getScreenHistoryContent,
    restoreScreenHistory,
    extractMasterLayout,
    applyMasterLayoutEdit,
    deleteMasterLayout,
  };
}
