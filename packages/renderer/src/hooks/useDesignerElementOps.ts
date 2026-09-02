import { useRef, useEffect, useCallback } from 'react';
import type { SelectedElement, ElementStyle } from '@xai/shared';
import { buildSelectedElement, extractElementStyle, setEditableText, isTextAmbiguous } from '../utils/designerElementUtils';
import { getSelectElement, resolveTableContext, resolveTabsContext, resolveAccordionContext, resolveCarouselContext, resolveProgressContext, resolveBadgeContext, resolveDialogContext, resolveButtonContext, getTableRows, reapplyStickyColumnClasses, STICKY_LEFT_TABLE_CLASS, STICKY_RIGHT_TABLE_CLASS } from '../utils/designerStructuredEditors';

const TABLE_SCROLLBAR_STYLE_ID = '__xai_table_scrollbar__';

/**
 * Inject custom scrollbar CSS for table scroll wrappers into the iframe.
 * Reads theme variables from the page (--xai-outline, --xai-primary) to
 * keep the scrollbar style consistent with the overall design.
 */
function ensureTableScrollbarStyles(doc: Document) {
  if (doc.getElementById(TABLE_SCROLLBAR_STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = TABLE_SCROLLBAR_STYLE_ID;
  style.textContent = `
/* xAI designer: table scrollbar theming */
.__xai_table_scroll_wrapper__,
[data-design-id^="table-scroll-wrapper"],
.table-scroll-wrapper,
.table-responsive {
  scrollbar-width: thin;
  scrollbar-color: var(--xai-outline, #d1d5db) transparent;
}
.__xai_table_scroll_wrapper__::-webkit-scrollbar,
[data-design-id^="table-scroll-wrapper"]::-webkit-scrollbar,
.table-scroll-wrapper::-webkit-scrollbar,
.table-responsive::-webkit-scrollbar {
  height: 6px;
  width: 6px;
}
.__xai_table_scroll_wrapper__::-webkit-scrollbar-track,
[data-design-id^="table-scroll-wrapper"]::-webkit-scrollbar-track,
.table-scroll-wrapper::-webkit-scrollbar-track,
.table-responsive::-webkit-scrollbar-track {
  background: transparent;
}
.__xai_table_scroll_wrapper__::-webkit-scrollbar-thumb,
[data-design-id^="table-scroll-wrapper"]::-webkit-scrollbar-thumb,
.table-scroll-wrapper::-webkit-scrollbar-thumb,
.table-responsive::-webkit-scrollbar-thumb {
  background: var(--xai-outline, #d1d5db);
  border-radius: 3px;
}
.__xai_table_scroll_wrapper__::-webkit-scrollbar-thumb:hover,
[data-design-id^="table-scroll-wrapper"]::-webkit-scrollbar-thumb:hover,
.table-scroll-wrapper::-webkit-scrollbar-thumb:hover,
.table-responsive::-webkit-scrollbar-thumb:hover {
  background: var(--xai-primary, #3b82f6);
}
`;
  // srcdoc iframe 在解析早期阶段 `doc.head` 可能为 null（<head> 尚未创建），
  // 此时回退到 documentElement（<html>，总是最先创建），避免 null.appendChild 崩溃。
  (doc.head || doc.documentElement)?.appendChild(style);
}

const TABLE_STICKY_COL_STYLE_ID = '__xai_table_sticky_col__';

/**
 * Inject CSS for sticky (frozen) table columns. Reads the theme
 * surface color (--xai-surface) so the frozen cell has an opaque
 * background and doesn't bleed through to neighbouring columns
 * when the table is scrolled horizontally. Falls back to #ffffff.
 */
function ensureTableStickyColumnStyles(doc: Document) {
  if (doc.getElementById(TABLE_STICKY_COL_STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = TABLE_STICKY_COL_STYLE_ID;
  style.textContent = `
/* xAI designer: sticky (frozen) table columns
 *
 * CRITICAL: background-color must be !important to override Bootstrap's
 * .table thead th and .table-striped rules which have higher CSS specificity
 * than our single-class selector. Without this, the sticky cell's background
 * gets overridden — becoming transparent or semi-transparent — and other
 * columns' content bleeds through when scrolling horizontally.
 *
 * All backgrounds must be FULLY OPAQUE (no rgba with alpha < 1) so the
 * sticky cell truly occludes the content scrolling beneath it.
 */
.xai-sticky-col-left {
  position: sticky !important;
  left: 0;
  z-index: 5;
  /* opaque white — must !important to beat .table thead th / .table-striped */
  background-color: var(--xai-surface, #ffffff) !important;
  box-shadow: 2px 0 4px -2px rgba(0, 0, 0, 0.15);
}
.xai-sticky-col-right {
  position: sticky !important;
  right: 0;
  z-index: 5;
  background-color: var(--xai-surface, #ffffff) !important;
  box-shadow: -2px 0 4px -2px rgba(0, 0, 0, 0.15);
}
/* Single-column table where both left and right are frozen */
.xai-sticky-col-left.xai-sticky-col-right {
  box-shadow: 2px 0 4px -2px rgba(0, 0, 0, 0.15), -2px 0 4px -2px rgba(0, 0, 0, 0.15);
}
/* thead sticky cells: use header bg color (opaque) to match table header style.
 * --xai-surface-container defaults to #f9fafb. */
.table thead .xai-sticky-col-left,
.table thead .xai-sticky-col-right {
  background-color: var(--xai-surface-container, #f9fafb) !important;
}
/* striped odd rows: use opaque equivalent of rgba(0,0,0,0.05) on white.
 * NEVER use rgba(0,0,0,0.05) directly — its alpha lets content bleed through. */
.table-striped > tbody > tr:nth-of-type(odd) > .xai-sticky-col-left,
.table-striped > tbody > tr:nth-of-type(odd) > .xai-sticky-col-right {
  background-color: #f3f4f6 !important;
}
/* hover rows (.table-hover) — also use opaque color */
.table-hover > tbody > tr:hover > .xai-sticky-col-left,
.table-hover > tbody > tr:hover > .xai-sticky-col-right {
  background-color: var(--xai-surface-container, #f9fafb) !important;
}
`;
  // srcdoc iframe 在解析早期阶段 `doc.head` 可能为 null（<head> 尚未创建），
  // 此时回退到 documentElement（<html>，总是最先创建），避免 null.appendChild 崩溃。
  (doc.head || doc.documentElement)?.appendChild(style);
}

const NAVBAR_ORIENTATION_STYLE_ID = '__xai_navbar_orientation__';

/**
 * Inject CSS for navbar vertical orientation.
 * When data-navbar-orientation="vertical" is set on a .navbar,
 * the nav items stack vertically — suitable for left-side navigation.
 */
function ensureNavbarOrientationStyles(doc: Document) {
  if (doc.getElementById(NAVBAR_ORIENTATION_STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = NAVBAR_ORIENTATION_STYLE_ID;
  style.textContent = `
/* xAI designer: navbar vertical orientation */
.navbar[data-navbar-orientation="vertical"] {
  position: relative !important;
  flex-direction: column !important;
  align-items: stretch !important;
}
.navbar[data-navbar-orientation="vertical"] .container-fluid {
  flex-direction: column !important;
  align-items: stretch !important;
  gap: 0.5rem;
}
.navbar[data-navbar-orientation="vertical"] .navbar-collapse {
  display: flex !important;
  flex-basis: 100%;
}
.navbar[data-navbar-orientation="vertical"] .navbar-nav {
  flex-direction: column !important;
  gap: 0.25rem !important;
  margin: 0 !important;
  width: 100%;
}
.navbar[data-navbar-orientation="vertical"] .navbar-nav .nav-link {
  width: 100%;
  padding: 0.5rem 0.75rem;
}
.navbar[data-navbar-orientation="vertical"] .navbar-toggler {
  display: none !important;
}
.navbar[data-navbar-orientation="vertical"] .navbar-brand {
  margin-bottom: 0.25rem;
}
/* xAI designer: sidebar navbar resizer handle — drag to adjust width */
.xai-navbar-resizer {
  position: absolute;
  top: 0;
  right: -3px;
  width: 6px;
  height: 100%;
  cursor: col-resize;
  background-color: transparent;
  z-index: 10;
  transition: background-color .15s ease;
}
.xai-navbar-resizer:hover {
  background-color: var(--xai-primary, #3b82f6);
}
/* xAI designer: sidebar navbar collapse toggle button */
.xai-navbar-collapse-toggle {
  display: none;
}
.navbar[data-navbar-orientation="vertical"] .xai-navbar-collapse-toggle {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0.4rem;
  margin-top: auto;
  border: 1px solid var(--xai-outline-variant, #dee2e6);
  border-radius: 0.375rem;
  color: var(--xai-on-surface-variant, #6b7280);
  cursor: pointer;
  transition: background-color .15s ease, color .15s ease;
}
.navbar[data-navbar-orientation="vertical"] .xai-navbar-collapse-toggle:hover {
  background-color: var(--xai-primary-container, #e0e7ff);
  color: var(--xai-on-primary-container, #3730a3);
}
.navbar[data-navbar-orientation="vertical"] .xai-navbar-collapse-toggle i {
  transition: transform 0.2s ease;
  font-size: 0.9rem;
}
/* ── 折叠状态：窄宽度，仅图标 ── */
.navbar[data-navbar-orientation="vertical"][data-navbar-collapsed="true"] {
  width: 64px !important;
}
.navbar[data-navbar-orientation="vertical"][data-navbar-collapsed="true"] .xai-navbar-resizer {
  display: none !important;
}
.navbar[data-navbar-orientation="vertical"][data-navbar-collapsed="true"] .container-fluid {
  padding-left: 0.5rem !important;
  padding-right: 0.5rem !important;
}
.navbar[data-navbar-orientation="vertical"][data-navbar-collapsed="true"] .navbar-brand {
  justify-content: center;
  gap: 0 !important;
}
.navbar[data-navbar-orientation="vertical"][data-navbar-collapsed="true"] .navbar-brand span {
  display: none !important;
}
.navbar[data-navbar-orientation="vertical"][data-navbar-collapsed="true"] .navbar-brand i {
  margin: 0 !important;
}
.navbar[data-navbar-orientation="vertical"][data-navbar-collapsed="true"] .navbar-nav .nav-link {
  font-size: 0 !important;
  text-align: center;
  justify-content: center !important;
  padding: 0.5rem 0 !important;
  gap: 0 !important;
}
.navbar[data-navbar-orientation="vertical"][data-navbar-collapsed="true"] .navbar-nav .nav-link i {
  font-size: 1rem !important;
  margin: 0 !important;
}
/* dropdown chevron 指向右侧，提示子菜单向右弹出 */
.navbar[data-navbar-orientation="vertical"][data-navbar-collapsed="true"] .dropdown .xai-dropdown-chevron {
  transform: rotate(-90deg) !important;
  margin: 0 !important;
}
/* 折叠按钮图标旋转 180° */
.navbar[data-navbar-orientation="vertical"][data-navbar-collapsed="true"] .xai-navbar-collapse-toggle i {
  transform: rotate(180deg);
}
/* ── 折叠状态：子菜单弹出显示（hover 触发）── */
.navbar[data-navbar-orientation="vertical"][data-navbar-collapsed="true"] .dropdown .xai-dropdown-menu {
  display: none !important;
  position: absolute !important;
  left: calc(100% + 4px) !important;
  top: 0 !important;
  margin: 0 !important;
  min-width: 200px;
  z-index: 1000;
}
.navbar[data-navbar-orientation="vertical"][data-navbar-collapsed="true"] .dropdown:hover .xai-dropdown-menu {
  display: block !important;
}
`;
  // srcdoc iframe 在解析早期阶段 `doc.head` 可能为 null（<head> 尚未创建），
  // 此时回退到 documentElement（<html>，总是最先创建），避免 null.appendChild 崩溃。
  (doc.head || doc.documentElement)?.appendChild(style);
}

const DROPDOWN_STYLE_ID = '__xai_dropdown__';

/**
 * Inject CSS for dropdown component.
 * - data-dropdown-open="false" 折叠子菜单
 * - 展开时 chevron 旋转 180°
 */
function ensureDropdownStyles(doc: Document) {
  if (doc.getElementById(DROPDOWN_STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = DROPDOWN_STYLE_ID;
  style.textContent = `
/* xAI designer: dropdown 组件展开/折叠 */
.xai-dropdown-menu {
  display: block;
}
.dropdown[data-dropdown-open="false"] .xai-dropdown-menu {
  display: none !important;
}
.dropdown[data-dropdown-open="true"] .xai-dropdown-chevron {
  transform: rotate(180deg);
}
.xai-dropdown-chevron {
  transition: transform 0.2s ease;
}
.xai-dropdown-menu > a:hover {
  background-color: var(--bs-gray-100, #f3f4f6) !important;
}
`;
  // srcdoc iframe 在解析早期阶段 `doc.head` 可能为 null（<head> 尚未创建），
  // 此时回退到 documentElement（<html>，总是最先创建），避免 null.appendChild 崩溃。
  (doc.head || doc.documentElement)?.appendChild(style);
}

interface UseDesignerElementOpsOptions {
  iframeRefs: React.MutableRefObject<Map<string, HTMLIFrameElement>>;
  selectedScreenIdRef: React.MutableRefObject<string | null>;
  selectedElement: SelectedElement | null;
  selectMode: boolean;
  isGenerating: boolean;
  currentScreenId: string | null;
  screens: { id: string }[];
  onSelectElement: (el: SelectedElement | null) => void;
  onSelectScreen?: (screenId: string) => void;
  onHtmlChange: (html: string) => void;
  onElementStyleChange: (selector: string, style: Partial<ElementStyle>) => void;
  calculateSnap: (iframe: HTMLIFrameElement, el: HTMLElement) => { snapDx: number; snapDy: number };
  clearAlignmentGuides: () => void;
}

/**
 * 清理子元素上与交叉轴/主轴对齐冲突的 Bootstrap margin 工具类。
 *
 * 场景：父容器设置了 `align-items: center`（交叉轴居中），但某个子元素
 * 仍保留 `mb-3`（margin-bottom: 1rem !important），在 row 方向下 `mb-3`
 * 会将该子元素向下推，造成视觉上未居中的假象。
 *
 * 对称地，当 `flex-direction: column` + `justify-content: center` 时，
 * 子元素的 `mr-*` / `ml-*` 也会干扰主轴居中。
 *
 * 策略：根据 alignItems / justifyContent 的目标值，移除子元素上与
 * 交叉轴（行方向）或主轴（列方向）冲突的 margin 类和内联 margin。
 */
function _cleanChildMarginClasses(parent: HTMLElement, key: 'alignItems' | 'justifyContent') {
  const flexDirection = parent.style.flexDirection || getComputedStyle(parent).flexDirection || 'row';
  const val = key === 'alignItems' ? parent.style.alignItems : parent.style.justifyContent;

  // 只在居中或 end 对齐时才需要清理，start 不需要
  if (val !== 'center' && !val.includes('end')) return;

  // 判断需要清理哪个轴的 margin：
  //   row + alignItems       → 垂直轴 → mt/mb
  //   row + justifyContent   → 水平轴 → ml/mr/mx
  //   column + alignItems    → 水平轴 → ml/mr/mx
  //   column + justifyContent→ 垂直轴 → mt/mb
  const isRow = flexDirection.startsWith('row');
  let marginClasses: RegExp;
  let marginProps: string[];

  if (key === 'alignItems') {
    if (isRow) {
      // row 布局中交叉轴是垂直方向 → 清理 mt/mb
      marginClasses = /\bmt-\d+\b|\bmb-\d+\b|\bmy-\d+\b/;
      marginProps = ['marginTop', 'marginBottom'];
    } else {
      // column 布局中交叉轴是水平方向 → 清理 ml/mr/mx/ms/me（BS5兼容）
      marginClasses = /\bml-\d+\b|\bmr-\d+\b|\bmx-\d+\b|\bms-\d+\b|\bme-\d+\b/;
      marginProps = ['marginLeft', 'marginRight'];
    }
  } else {
    // justifyContent
    if (isRow) {
      // row 布局中主轴是水平方向 → 清理 ml/mr/mx/ms/me（BS5兼容）
      marginClasses = /\bml-\d+\b|\bmr-\d+\b|\bmx-\d+\b|\bms-\d+\b|\bme-\d+\b/;
      marginProps = ['marginLeft', 'marginRight'];
    } else {
      // column 布局中主轴是垂直方向 → 清理 mt/mb
      marginClasses = /\bmt-\d+\b|\bmb-\d+\b|\bmy-\d+\b/;
      marginProps = ['marginTop', 'marginBottom'];
    }
  }

  Array.from(parent.children).forEach(child => {
    const htmlChild = child as HTMLElement;
    if (!htmlChild.classList) return;

    // 移除冲突的 Bootstrap margin 工具类
    const classesToRemove: string[] = [];
    htmlChild.classList.forEach(cls => {
      if (marginClasses.test(cls)) classesToRemove.push(cls);
    });
    classesToRemove.forEach(cls => htmlChild.classList.remove(cls));

    // 同时清除对应方向的内联 margin（带 !important 的也要清除）
    marginProps.forEach(prop => {
      if (htmlChild.style.getPropertyValue(prop)) {
        htmlChild.style.removeProperty(prop);
      }
    });
  });
}

/**
 * 清理元素自身上与指定 padding/margin 属性冲突的 Bootstrap 间距工具类。
 *
 * 原因：Bootstrap 的 p- 与 m- 系列工具类默认带 !important，与用户在属性面板设置的
 * 内联间距冲突。即使内联也带 !important 能压住，保留无用的工具类仍会混淆用户
 * （class 写着 p-4 但实际 padding 已被内联覆盖为 0），且会让"删除 p-4"操作
 * 看起来"不生效/又补回来"。故在用户显式设置间距时清理对应冲突类。
 *
 * 清理范围（Bootstrap 5，兼容旧版 pl、pr、ml、mr）：
 *   padding 简写 → p- / pt / pb / ps / pe / px / py / pl / pr
 *   paddingTop   → pt / py
 *   paddingBottom → pb / py
 *   paddingLeft  → ps / pl / px
 *   paddingRight → pe / pr / px
 *   margin 同理
 */
function _cleanConflictSpacingClasses(el: HTMLElement, key: string) {
  const map: Record<string, RegExp> = {
    padding:       /\bp-\d+\b|\bpt-\d+\b|\bpb-\d+\b|\bps-\d+\b|\bpe-\d+\b|\bpx-\d+\b|\bpy-\d+\b|\bpl-\d+\b|\bpr-\d+\b/,
    paddingTop:    /\bpt-\d+\b|\bpy-\d+\b/,
    paddingBottom: /\bpb-\d+\b|\bpy-\d+\b/,
    paddingLeft:   /\bps-\d+\b|\bpl-\d+\b|\bpx-\d+\b/,
    paddingRight:  /\bpe-\d+\b|\bpr-\d+\b|\bpx-\d+\b/,
    margin:        /\bm-\d+\b|\bmt-\d+\b|\bmb-\d+\b|\bms-\d+\b|\bme-\d+\b|\bmx-\d+\b|\bmy-\d+\b|\bml-\d+\b|\bmr-\d+\b/,
    marginTop:     /\bmt-\d+\b|\bmy-\d+\b/,
    marginBottom:  /\bmb-\d+\b|\bmy-\d+\b/,
    marginLeft:    /\bms-\d+\b|\bml-\d+\b|\bmx-\d+\b/,
    marginRight:   /\bme-\d+\b|\bmr-\d+\b|\bmx-\d+\b/,
  };
  const re = map[key];
  if (!re) return;
  const classesToRemove: string[] = [];
  el.classList.forEach(cls => { if (re.test(cls)) classesToRemove.push(cls); });
  classesToRemove.forEach(cls => el.classList.remove(cls));
}

/**
 * Manages element selection, drag, resize, duplicate, and DOM reorder inside
 * the designer iframes. Attaches click/hover/dblclick/contextmenu listeners
 * to each iframe document when in select mode, keeps the selection overlay
 * in sync, and serializes changes back via onHtmlChange.
 * Extracted from DesignerCanvas.
 */
export function useDesignerElementOps({
  iframeRefs,
  selectedScreenIdRef,
  selectedElement,
  selectMode,
  isGenerating,
  currentScreenId,
  screens,
  onSelectElement,
  onSelectScreen,
  onHtmlChange,
  onElementStyleChange,
  calculateSnap,
  clearAlignmentGuides,
}: UseDesignerElementOpsOptions) {
  /* ── Bring element forward / send backward in DOM order ───────────── */
  const handleBringForward = useCallback((selector: string) => {
    const iframe = iframeRefs.current.get(selectedScreenIdRef.current || '');
    if (!iframe?.contentDocument) return;
    const el = iframe.contentDocument.querySelector(selector) as HTMLElement | null;
    if (!el || !el.parentElement) return;
    const next = el.nextElementSibling;
    if (next) {
      el.parentElement.insertBefore(next, el);
      const newHtml = '<!DOCTYPE html>\n' + iframe.contentDocument.documentElement.outerHTML;
      onHtmlChange(newHtml);
    }
  }, [iframeRefs, selectedScreenIdRef, onHtmlChange]);

  const handleSendBackward = useCallback((selector: string) => {
    const iframe = iframeRefs.current.get(selectedScreenIdRef.current || '');
    if (!iframe?.contentDocument) return;
    const el = iframe.contentDocument.querySelector(selector) as HTMLElement | null;
    if (!el || !el.parentElement) return;
    const prev = el.previousElementSibling;
    if (prev) {
      el.parentElement.insertBefore(el, prev);
      const newHtml = '<!DOCTYPE html>\n' + iframe.contentDocument.documentElement.outerHTML;
      onHtmlChange(newHtml);
    }
  }, [iframeRefs, selectedScreenIdRef, onHtmlChange]);

  /* ── Reassign data-design-id on cloned subtree (avoids duplicate selectors) ── */
  const reassignDesignIds = useCallback((root: HTMLElement, doc: Document) => {
    const timestamp = Date.now();
    let counter = 0;
    function walk(node: HTMLElement) {
      if (node.hasAttribute && node.hasAttribute('data-design-id')) {
        node.setAttribute('data-design-id', `designer-dup-${timestamp}-${counter++}`);
      }
      const children = node.children;
      for (let i = 0; i < children.length; i++) {
        walk(children[i] as HTMLElement);
      }
    }
    walk(root);
    if (root.tagName === 'INPUT' && (root as HTMLInputElement).type === 'radio' && root.getAttribute('name')) {
      (root as HTMLInputElement).name = `radio-group-dup-${timestamp}`;
    }
  }, []);

  /* ── Duplicate element (used by context menu & screen overlays) ────── */
  const handleDuplicateElement = useCallback((selector: string) => {
    const iframe = iframeRefs.current.get(selectedScreenIdRef.current || '');
    if (!iframe?.contentDocument) return;
    const el = iframe.contentDocument.querySelector(selector) as HTMLElement | null;
    if (!el || !el.parentElement) return;
    const clone = el.cloneNode(true) as HTMLElement;
    reassignDesignIds(clone, iframe.contentDocument);
    el.parentElement.insertBefore(clone, el.nextSibling);
    const newHtml = '<!DOCTYPE html>\n' + iframe.contentDocument.documentElement.outerHTML;
    onHtmlChange(newHtml);
  }, [iframeRefs, selectedScreenIdRef, onHtmlChange, reassignDesignIds]);

  const getSelectedDomContext = useCallback(() => {
    const screenId = selectedScreenIdRef.current || currentScreenId || '';
    const iframe = iframeRefs.current.get(screenId);
    if (!iframe?.contentDocument || !selectedElement) return null;
    const el = iframe.contentDocument.querySelector(selectedElement.selector) as HTMLElement | null;
    if (!el) return null;
    return { screenId, iframe, doc: iframe.contentDocument, el };
  }, [currentScreenId, iframeRefs, selectedElement, selectedScreenIdRef]);

  const commitDom = useCallback((doc: Document) => {
    const newHtml = '<!DOCTYPE html>\n' + doc.documentElement.outerHTML;
    onHtmlChange(newHtml);
  }, [onHtmlChange]);

  const syncSelectedElement = useCallback((el: HTMLElement, doc: Document, screenId: string) => {
    onSelectElement(buildSelectedElement(el, doc, screenId));
  }, [onSelectElement]);

  /* ── Element selection: attach click handlers to iframes ───────────── */
  const attachIframeListeners = useCallback((iframe: HTMLIFrameElement, screenId: string) => {
    const doc = iframe.contentDocument;
    if (!doc) return;

    // Remove existing listeners
    doc.removeEventListener('click', (doc as any).__designerClickHandler, true);
    doc.removeEventListener('click', (doc as any).__designerDropdownToggleHandler, true);
    doc.removeEventListener('pointerdown', (doc as any).__designerNavbarResizerHandler, true);
    doc.removeEventListener('mouseover', (doc as any).__designerHoverHandler, true);
    doc.removeEventListener('mouseout', (doc as any).__designerOutHandler, true);
    doc.removeEventListener('dblclick', (doc as any).__designerDblClickHandler, true);
    doc.removeEventListener('contextmenu', (doc as any).__designerContextMenuHandler, true);

    // 确保设计师组件 CSS（navbar 方向、dropdown 展开/折叠）已注入
    // 对老页面（postProcessDesignerHtml 未注入这些 CSS）做兜底
    ensureNavbarOrientationStyles(doc);
    ensureDropdownStyles(doc);

    // 启用侧边导航栏 resizer 交互（设计模式）— 初始 HTML 中 pointer-events:none
    // 运行模式 iframe 不执行此代码，resizer 保持禁用且不可见
    doc.querySelectorAll('[data-navbar-resizer="true"]').forEach(el => {
      (el as HTMLElement).style.pointerEvents = 'auto';
    });

    // ── 下拉菜单展开/折叠：所有模式（选择/非选择/设计/运行）都生效 ──
    // data-dropdown-toggle="true" 标记的元素（或其子元素）点击时切换父级 .dropdown 的 data-dropdown-open
    // 不调用 stopPropagation，让选择模式的 click handler 仍能正常选中元素
    //
    // 持久化策略：
    // - 非选择模式：立即 onHtmlChange 持久化（无选择状态需要保护）
    // - 选择模式：延迟持久化（setTimeout 0），确保 clickHandler 的选中状态先提交渲染，
    //   避免 onHtmlChange 触发 iframe srcDoc 重载与选中渲染同帧导致选区丢失
    const dropdownToggleHandler = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target) return;
      const dropdownToggle = target.closest('[data-dropdown-toggle="true"]') as HTMLElement | null;
      if (!dropdownToggle) return;
      // 阻止 <a href="#"> 默认跳转
      e.preventDefault();
      const dropdown = dropdownToggle.closest('.dropdown') as HTMLElement | null;
      if (dropdown) {
        const current = dropdown.getAttribute('data-dropdown-open');
        const next = current === 'true' ? 'false' : 'true';
        dropdown.setAttribute('data-dropdown-open', next);
        const persist = () => {
          const newHtml = '<!DOCTYPE html>\n' + doc.documentElement.outerHTML;
          onHtmlChange(newHtml);
        };
        if (selectMode) {
          // 选择模式：延迟到下一 tick，让选中先渲染
          setTimeout(persist, 0);
        } else {
          persist();
        }
      }
    };
    (doc as any).__designerDropdownToggleHandler = dropdownToggleHandler;
    doc.addEventListener('click', dropdownToggleHandler, true);

    // ── 侧边导航栏折叠/展开：点击折叠按钮切换 data-navbar-collapsed ──
    // 所有模式（选择/非选择/设计/运行）都生效
    // 不调用 stopPropagation，让选择模式的 click handler 仍能正常选中 navbar
    const navbarCollapseHandler = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target) return;
      const collapseToggle = target.closest('[data-navbar-collapse-toggle="true"]') as HTMLElement | null;
      if (!collapseToggle) return;
      // 阻止默认行为（防止按钮触发表单提交等）
      e.preventDefault();
      const navbar = collapseToggle.closest('.navbar') as HTMLElement | null;
      if (navbar) {
        const current = navbar.getAttribute('data-navbar-collapsed');
        const next = current === 'true' ? 'false' : 'true';
        navbar.setAttribute('data-navbar-collapsed', next);
        const persist = () => {
          const newHtml = '<!DOCTYPE html>\n' + doc.documentElement.outerHTML;
          onHtmlChange(newHtml);
        };
        if (selectMode) {
          // 选择模式：延迟到下一 tick，让选中先渲染
          setTimeout(persist, 0);
        } else {
          persist();
        }
      }
    };
    (doc as any).__designerNavbarCollapseHandler = navbarCollapseHandler;
    doc.addEventListener('click', navbarCollapseHandler, true);

    // ── 侧边导航栏宽度调整：拖动 resizer 左右调整 navbar 宽度 ──
    // data-navbar-resizer="true" 标记的元素（或其子元素）pointerdown 时开始拖拽
    // 所有设计模式（选择/非选择）都生效；运行模式不注册此 handler
    const navbarResizerHandler = (e: PointerEvent) => {
      const target = e.target as HTMLElement;
      if (!target) return;
      const resizer = target.closest('[data-navbar-resizer="true"]') as HTMLElement | null;
      if (!resizer) return;

      const navbar = resizer.closest('.navbar') as HTMLElement | null;
      if (!navbar) return;

      e.preventDefault();
      e.stopPropagation();

      // 选中 navbar（与 click handler 行为一致）
      selectedScreenIdRef.current = screenId;
      if (currentScreenId !== screenId) {
        onSelectScreen?.(screenId);
      }
      const sel = buildSelectedElement(navbar, doc, screenId);
      onSelectElement(sel);

      // 视觉反馈
      resizer.style.backgroundColor = 'var(--xai-primary, #3b82f6)';
      doc.body.style.userSelect = 'none';
      doc.body.style.cursor = 'col-resize';

      const startX = e.clientX;
      const startWidth = navbar.offsetWidth;
      let moved = false;

      const onPointerMove = (ev: PointerEvent) => {
        const dx = ev.clientX - startX;
        if (Math.abs(dx) > 2) moved = true;
        // 限制宽度范围：120px ~ 480px
        const newWidth = Math.max(120, Math.min(480, startWidth + dx));
        navbar.style.width = newWidth + 'px';
      };

      const onPointerUp = () => {
        resizer.style.backgroundColor = '';
        doc.body.style.userSelect = '';
        doc.body.style.cursor = '';
        doc.removeEventListener('pointermove', onPointerMove);
        doc.removeEventListener('pointerup', onPointerUp);

        if (moved) {
          const persist = () => {
            const newHtml = '<!DOCTYPE html>\n' + doc.documentElement.outerHTML;
            onHtmlChange(newHtml);
          };
          if (selectMode) {
            setTimeout(persist, 0);
          } else {
            persist();
          }
        }
      };

      doc.addEventListener('pointermove', onPointerMove);
      doc.addEventListener('pointerup', onPointerUp);
    };
    (doc as any).__designerNavbarResizerHandler = navbarResizerHandler;
    doc.addEventListener('pointerdown', navbarResizerHandler, true);

    if (!selectMode) return;

    const clickHandler = (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const target = e.target as HTMLElement;
      if (!target || target.tagName === 'HTML' || target.tagName === 'BODY' || target.tagName === 'HEAD') return;

      // resizer 点击：选中其所属 navbar（pointerdown handler 已处理拖拽逻辑）
      const resizerEl = target.closest('[data-navbar-resizer="true"]') as HTMLElement | null;
      if (resizerEl) {
        const navbar = resizerEl.closest('.navbar') as HTMLElement | null;
        if (navbar) {
          selectedScreenIdRef.current = screenId;
          if (currentScreenId !== screenId) {
            onSelectScreen?.(screenId);
          }
          const sel = buildSelectedElement(navbar, doc, screenId);
          onSelectElement(sel);
        }
        return;
      }

      // 折叠按钮点击：选中其所属 navbar（collapse handler 已在 capture 阶段处理折叠逻辑）
      const collapseToggleEl = target.closest('[data-navbar-collapse-toggle="true"]') as HTMLElement | null;
      if (collapseToggleEl) {
        const navbar = collapseToggleEl.closest('.navbar') as HTMLElement | null;
        if (navbar) {
          selectedScreenIdRef.current = screenId;
          if (currentScreenId !== screenId) {
            onSelectScreen?.(screenId);
          }
          const sel = buildSelectedElement(navbar, doc, screenId);
          onSelectElement(sel);
        }
        return;
      }

      selectedScreenIdRef.current = screenId;
      // Switch active screen so the selection overlay renders on the correct page
      if (currentScreenId !== screenId) {
        onSelectScreen?.(screenId);
      }

      // 清除 hover 虚线框残留（DOM 变化时 mouseout 可能未触发）
      const prevHover = (doc as any).__designerPrevHover;
      if (prevHover) {
        prevHover.style.outline = (prevHover as any).__designerOrigOutline || '';
        delete (prevHover as any).__designerOrigOutline;
        delete (doc as any).__designerPrevHover;
      }

      const sel = buildSelectedElement(target, doc, screenId);
      onSelectElement(sel);
    };

    // Double-click: enter inline text editing mode
    const dblClickHandler = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target || target.tagName === 'HTML' || target.tagName === 'BODY') return;
      e.preventDefault();
      e.stopPropagation();

      selectedScreenIdRef.current = screenId;
      if (currentScreenId !== screenId) {
        onSelectScreen?.(screenId);
      }

      // Select the element first
      const sel = buildSelectedElement(target, doc, screenId);
      onSelectElement(sel);

      // Enter edit mode
      target.contentEditable = 'true';
      target.style.outline = '2px solid #b8944a';
      target.focus();

      // Select all text in the element
      const range = doc.createRange();
      range.selectNodeContents(target);
      const selection = doc.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);

      const finishEdit = () => {
        target.contentEditable = 'false';
        target.style.outline = (target as any).__designerOrigOutline || '';
        const newHtml = '<!DOCTYPE html>\n' + doc.documentElement.outerHTML;
        onHtmlChange(newHtml);
        target.removeEventListener('blur', finishEdit);
      };
      target.addEventListener('blur', finishEdit);
    };

    // Right-click: show custom context menu
    const contextMenuHandler = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target || target.tagName === 'HTML' || target.tagName === 'BODY') return;
      e.preventDefault();
      e.stopPropagation();

      selectedScreenIdRef.current = screenId;
      if (currentScreenId !== screenId) {
        onSelectScreen?.(screenId);
      }
      const sel = buildSelectedElement(target, doc, screenId);
      onSelectElement(sel);
      // Request context menu via custom event
      window.dispatchEvent(new CustomEvent('designer-context-menu', {
        detail: { x: e.clientX, y: e.clientY, screenId },
      }));
    };

    const hoverHandler = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target || target.tagName === 'HTML' || target.tagName === 'BODY') return;
      // resizer / 折叠按钮不显示虚线选中框（hover 颜色由 CSS 处理）
      if (target.closest('[data-navbar-resizer="true"]') || target.closest('[data-navbar-collapse-toggle="true"]')) return;
      // Add outline on hover
      const prev = (doc as any).__designerPrevHover;
      if (prev && prev !== target) {
        prev.style.outline = (prev as any).__designerOrigOutline || '';
        delete (prev as any).__designerOrigOutline;
      }
      if (target) {
        // 只在首次 hover 时存储原始 outline，避免重复 hover 覆盖为虚线值
        if ((target as any).__designerOrigOutline === undefined) {
          (target as any).__designerOrigOutline = target.style.outline;
        }
        target.style.outline = '2px dashed #b8944a';
        (doc as any).__designerPrevHover = target;
      }
    };

    const outHandler = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target && (target as any).__designerOrigOutline !== undefined) {
        target.style.outline = (target as any).__designerOrigOutline;
        // 清除存储，下次 hover 重新读取原始值
        delete (target as any).__designerOrigOutline;
      }
    };

    (doc as any).__designerClickHandler = clickHandler;
    (doc as any).__designerHoverHandler = hoverHandler;
    (doc as any).__designerOutHandler = outHandler;
    (doc as any).__designerDblClickHandler = dblClickHandler;
    (doc as any).__designerContextMenuHandler = contextMenuHandler;

    doc.addEventListener('click', clickHandler, true);
    doc.addEventListener('mouseover', hoverHandler, true);
    doc.addEventListener('mouseout', outHandler, true);
    doc.addEventListener('dblclick', dblClickHandler, true);
    doc.addEventListener('contextmenu', contextMenuHandler, true);
  }, [selectMode, onSelectElement, currentScreenId, onSelectScreen, onHtmlChange, selectedScreenIdRef]);

  // Re-attach listeners when selectMode changes or screens change, and
  // set up iframe `load` handlers so that after a srcDoc reload (triggered
  // by patchScreenHtml from deleteElement/duplicateElement/etc.) the
  // designer click/hover listeners are re-attached to the fresh document.
  useEffect(() => {
    if (isGenerating) return;
    iframeRefs.current.forEach((iframe, screenId) => {
      attachIframeListeners(iframe, screenId);

      // Re-attach listeners after iframe finishes reloading (e.g. after
      // deleteElement/duplicateElement calls patchScreenHtml which changes
      // srcDoc, causing the browser to reload the iframe content).
      // Remove previous handler to avoid leaks.
      if ((iframe as any).__designerLoadHandler) {
        iframe.removeEventListener('load', (iframe as any).__designerLoadHandler);
      }
      const loadHandler = () => {
        attachIframeListeners(iframe, screenId);
      };
      (iframe as any).__designerLoadHandler = loadHandler;
      iframe.addEventListener('load', loadHandler);
    });

    // Cleanup load handlers on unmount / effect re-run
    return () => {
      iframeRefs.current.forEach((iframe) => {
        if ((iframe as any).__designerLoadHandler) {
          iframe.removeEventListener('load', (iframe as any).__designerLoadHandler);
          delete (iframe as any).__designerLoadHandler;
        }
      });
    };
  }, [selectMode, screens, isGenerating, attachIframeListeners, iframeRefs]);

  /* ── Update selection overlay position when element changes ────────── */
  const updateSelectionFromIframe = useCallback(() => {
    if (!selectedElement || !selectedScreenIdRef.current) return;
    const iframe = iframeRefs.current.get(selectedScreenIdRef.current);
    if (!iframe?.contentDocument) return;
    const doc = iframe.contentDocument;
    // querySelectorAll + length check: a non-unique selector (e.g. duplicate
    // data-design-id on AI-generated repeated components like stats cards)
    // must NOT be allowed to resolve to a different element and overwrite the
    // selection's rect/style — that is what made the selection box "jump".
    // When ambiguous, skip the update rather than risk targeting another element.
    const matches = doc.querySelectorAll(selectedElement.selector);
    if (matches.length !== 1) return;
    const el = matches[0] as HTMLElement;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    onSelectElement({
      ...selectedElement,
      style: extractElementStyle(el, doc),
      rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
    });
  }, [selectedElement, onSelectElement, iframeRefs, selectedScreenIdRef]);

  // Refs 持有最新值，让 scroll 监听器读取当前状态而不成为 effect 依赖项。
  // 否则每次 rect 更新都会触发 effect 重跑（拆卸+重建监听器），造成抖动。
  const selectedElementRef = useRef(selectedElement);
  const onSelectElementRef = useRef(onSelectElement);
  const updateSelectionFnRef = useRef(updateSelectionFromIframe);
  useEffect(() => {
    selectedElementRef.current = selectedElement;
    onSelectElementRef.current = onSelectElement;
    updateSelectionFnRef.current = updateSelectionFromIframe;
  });

  // 滚动/缩放时更新选择框位置。
  // 旧实现用 setInterval(handler, 500) 轮询，滚动时选择框落后 500ms，明显卡顿。
  // 现在直接监听 iframe contentWindow 的 scroll 事件（用户实际滚动的对象），
  // 并用 requestAnimationFrame 节流，保证每帧最多更新一次。
  //
  // 两条更新路径：
  //  - updateRectOnly（轻量）：只读 getBoundingClientRect，跳过昂贵的
  //    extractElementStyle（内部多次调用 getComputedStyle）。用于高频 scroll。
  //  - updateFull（重量）：调用 updateSelectionFromIframe，同时刷新 style。
  //    用于低频 resize 事件和 2s 慢速兜底（处理 iframe 重载导致监听器丢失等边界）。
  useEffect(() => {
    const selector = selectedElement?.selector;
    const screenId = selectedScreenIdRef.current;
    if (!selector || !screenId) return;

    let rafId: number | null = null;
    let fullRafId: number | null = null;

    // 轻量更新：仅刷新 rect，每帧合并多次事件为一次更新
    const updateRectOnly = () => {
      if (rafId !== null) return; // 已调度则跳过，合并到本帧
      rafId = requestAnimationFrame(() => {
        rafId = null;
        const cur = selectedElementRef.current;
        if (!cur) return;
        const iframe = iframeRefs.current.get(screenId);
        const doc = iframe?.contentDocument;
        if (!doc) return;
        // Ambiguous (non-unique) selector → skip rather than resolve to a
        // different element and make the selection box jump. See
        // updateSelectionFromIframe for the same guard.
        const matches = doc.querySelectorAll(selector);
        if (matches.length !== 1) return;
        const el = matches[0] as HTMLElement;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return;
        onSelectElementRef.current({
          ...cur,
          rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
        });
      });
    };

    // 重量更新：rect + style，同样用 rAF 节流
    const updateFull = () => {
      if (fullRafId !== null) cancelAnimationFrame(fullRafId);
      fullRafId = requestAnimationFrame(() => {
        fullRafId = null;
        updateSelectionFnRef.current();
      });
    };

    window.addEventListener('resize', updateFull);

    // iframe 内部滚动 —— 选择框卡顿的主要来源。
    // iframe 重载（srcDoc 变化）时 contentWindow 会被替换，旧监听器随之失效。
    // 通过 iframe 元素的 load 事件重新绑定到新的 contentWindow。
    const iframe = iframeRefs.current.get(screenId);
    let currentWindow: Window | null = null;

    const attachIframeListeners = () => {
      const w = iframeRefs.current.get(screenId)?.contentWindow;
      if (!w || w === currentWindow) return;
      // 清理旧 contentWindow 上的监听器
      if (currentWindow) {
        currentWindow.removeEventListener('scroll', updateRectOnly);
        currentWindow.removeEventListener('resize', updateFull);
      }
      currentWindow = w;
      w.addEventListener('scroll', updateRectOnly, { passive: true });
      w.addEventListener('resize', updateFull);
    };

    attachIframeListeners();
    iframe?.addEventListener('load', attachIframeListeners);

    // 慢速兜底（2s）：作为保险，处理监听器意外丢失等边界场景。
    const fallbackInterval = setInterval(updateFull, 2000);

    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      if (fullRafId !== null) cancelAnimationFrame(fullRafId);
      window.removeEventListener('resize', updateFull);
      iframe?.removeEventListener('load', attachIframeListeners);
      if (currentWindow) {
        currentWindow.removeEventListener('scroll', updateRectOnly);
        currentWindow.removeEventListener('resize', updateFull);
      }
      clearInterval(fallbackInterval);
    };
    // 依赖 selector（而非整个 selectedElement），使得滚动期间 rect 更新
    // 不会触发 effect 重跑（避免反复拆卸/重建监听器）。
  }, [selectedElement?.selector, selectedScreenIdRef, iframeRefs]);

  /* ── Resize handle drag ────────────────────────────────────────────── */
  /* iframe 事件穿透（BUG 修复）：
     resize 拖拽期间，鼠标若快速滑出 resize handle 进入 iframe 内部，
     iframe 会捕获鼠标事件，导致父窗口的 mousemove/mouseup 停止触发。
     若用户在 iframe 内松开鼠标，mouseup 永远不会到达父文档 → resizeStateRef
     卡在非 null → 元素持续跟随鼠标。修复：拖拽期间禁用所有 iframe 的
     pointer-events，使鼠标事件穿透回父文档；拖拽结束时恢复。 */
  const resizeStateRef = useRef<{ handle: string; startX: number; startY: number; startRect: DOMRect } | null>(null);

  const handleResizeStart = useCallback((e: React.MouseEvent, handle: string) => {
    e.preventDefault();
    e.stopPropagation();
    if (!selectedElement) return;
    const startRect = {
      x: selectedElement.rect.x,
      y: selectedElement.rect.y,
      width: selectedElement.rect.width,
      height: selectedElement.rect.height,
      left: selectedElement.rect.x,
      top: selectedElement.rect.y,
      right: selectedElement.rect.x + selectedElement.rect.width,
      bottom: selectedElement.rect.y + selectedElement.rect.height,
      toJSON: () => {},
    } as DOMRect;
    resizeStateRef.current = { handle, startX: e.clientX, startY: e.clientY, startRect };
    // 拖拽期间禁用所有 iframe 的 pointer-events，防止 iframe 捕获鼠标事件
    document.querySelectorAll('iframe').forEach(ifr => {
      ifr.style.pointerEvents = 'none';
    });
  }, [selectedElement]);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      const state = resizeStateRef.current;
      if (!state || !selectedElement) return;
      const dx = e.clientX - state.startX;
      const dy = e.clientY - state.startY;
      const r = state.startRect;
      let newWidth = r.width;
      let newHeight = r.height;

      if (state.handle.includes('e')) newWidth = Math.max(20, r.width + dx);
      if (state.handle.includes('s')) newHeight = Math.max(20, r.height + dy);
      if (state.handle.includes('w')) newWidth = Math.max(20, r.width - dx);
      if (state.handle.includes('n')) newHeight = Math.max(20, r.height - dy);

      // Apply to the element in the iframe
      const iframe = iframeRefs.current.get(selectedScreenIdRef.current || '');
      if (!iframe?.contentDocument) return;
      const el = iframe.contentDocument.querySelector(selectedElement.selector) as HTMLElement | null;
      if (!el) return;

      el.style.width = `${newWidth}px`;
      el.style.height = `${newHeight}px`;

      // Update overlay
      const rect = el.getBoundingClientRect();
      onSelectElement({
        ...selectedElement,
        style: { ...selectedElement.style, width: `${newWidth}px`, height: `${newHeight}px` },
        rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
      });
    };

    const handleMouseUp = () => {
      if (resizeStateRef.current && selectedElement) {
        // Serialize and save
        const iframe = iframeRefs.current.get(selectedScreenIdRef.current || '');
        if (iframe?.contentDocument) {
          const newHtml = '<!DOCTYPE html>\n' + iframe.contentDocument.documentElement.outerHTML;
          onHtmlChange(newHtml);
        }
        onElementStyleChange(selectedElement.selector, {
          width: selectedElement.style.width,
          height: selectedElement.style.height,
        });
      }
      resizeStateRef.current = null;
      // 拖拽结束：恢复所有 iframe 的 pointer-events
      document.querySelectorAll('iframe').forEach(ifr => {
        ifr.style.pointerEvents = '';
      });
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      // cleanup 时也恢复 iframe pointer-events（防止组件卸载时状态残留）
      document.querySelectorAll('iframe').forEach(ifr => {
        ifr.style.pointerEvents = '';
      });
    };
  }, [selectedElement, onSelectElement, onElementStyleChange, onHtmlChange, iframeRefs, selectedScreenIdRef]);

  /* ── Drag to move element ──────────────────────────────────────────── */
  /* iframe 事件穿透（BUG 修复）：
     元素拖拽期间，鼠标若快速滑出拖拽区域进入 iframe 内部，
     iframe 会捕获鼠标事件，导致父窗口的 mousemove/mouseup 停止触发。
     若用户在 iframe 内松开鼠标，mouseup 永远不会到达父文档 → dragStateRef
     卡在非 null → 元素持续跟随鼠标。修复：拖拽期间禁用所有 iframe 的
     pointer-events，使鼠标事件穿透回父文档；拖拽结束时恢复。 */
  const dragStateRef = useRef<{ startX: number; startY: number; startRect: DOMRect } | null>(null);

  const handleDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!selectedElement) return;
    const startRect = {
      x: selectedElement.rect.x,
      y: selectedElement.rect.y,
      width: selectedElement.rect.width,
      height: selectedElement.rect.height,
      left: selectedElement.rect.x,
      top: selectedElement.rect.y,
      right: selectedElement.rect.x + selectedElement.rect.width,
      bottom: selectedElement.rect.y + selectedElement.rect.height,
      toJSON: () => {},
    } as DOMRect;
    dragStateRef.current = { startX: e.clientX, startY: e.clientY, startRect };
    // 拖拽期间禁用所有 iframe 的 pointer-events，防止 iframe 捕获鼠标事件
    document.querySelectorAll('iframe').forEach(ifr => {
      ifr.style.pointerEvents = 'none';
    });
  }, [selectedElement]);

  // Note: do NOT early-return when dragStateRef.current is null. The ref is
  // mutated by handleDragStart without triggering a re-render, so an early
  // return here would prevent the mousemove/mouseup listeners from being
  // registered at all — handleMouseUp (the only place that clears the ref)
  // would never fire, leaving the drag state stuck forever and causing the
  // element to follow the cursor even with no button pressed. Match the
  // resize effect below: always register listeners, check ref inside handlers.
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      const state = dragStateRef.current;
      if (!state || !selectedElement) return;
      const dx = e.clientX - state.startX;
      const dy = e.clientY - state.startY;

      const iframe = iframeRefs.current.get(selectedScreenIdRef.current || '');
      if (!iframe?.contentDocument) return;
      const el = iframe.contentDocument.querySelector(selectedElement.selector) as HTMLElement | null;
      if (!el) return;

      // Apply position offset via margin
      const currentMarginLeft = parseFloat(getComputedStyle(el).marginLeft) || 0;
      const currentMarginTop = parseFloat(getComputedStyle(el).marginTop) || 0;
      let newMarginLeft = currentMarginLeft + dx;
      let newMarginTop = currentMarginTop + dy;
      el.style.marginLeft = `${newMarginLeft}px`;
      el.style.marginTop = `${newMarginTop}px`;

      // Snap alignment: adjust position if close to alignment targets
      const snap = calculateSnap(iframe, el);
      if (snap.snapDx !== 0) {
        newMarginLeft += snap.snapDx;
        el.style.marginLeft = `${newMarginLeft}px`;
      }
      if (snap.snapDy !== 0) {
        newMarginTop += snap.snapDy;
        el.style.marginTop = `${newMarginTop}px`;
      }

      const rect = el.getBoundingClientRect();
      onSelectElement({
        ...selectedElement,
        rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
      });

      // Reset start for continuous dragging
      dragStateRef.current = { startX: e.clientX, startY: e.clientY, startRect: rect };
    };

    const handleMouseUp = () => {
      if (dragStateRef.current && selectedElement) {
        const iframe = iframeRefs.current.get(selectedScreenIdRef.current || '');
        if (iframe?.contentDocument) {
          const newHtml = '<!DOCTYPE html>\n' + iframe.contentDocument.documentElement.outerHTML;
          onHtmlChange(newHtml);
        }
      }
      dragStateRef.current = null;
      clearAlignmentGuides();
      // 拖拽结束：恢复所有 iframe 的 pointer-events
      document.querySelectorAll('iframe').forEach(ifr => {
        ifr.style.pointerEvents = '';
      });
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      // cleanup 时也恢复 iframe pointer-events（防止组件卸载时状态残留）
      document.querySelectorAll('iframe').forEach(ifr => {
        ifr.style.pointerEvents = '';
      });
    };
  }, [selectedElement, onSelectElement, onHtmlChange, calculateSnap, clearAlignmentGuides, iframeRefs, selectedScreenIdRef]);

  /* ── Reset drag/resize state (used by ESC & mode switch) ──────────── */
  // Clears any stuck drag/resize refs so the element stops following the
  // cursor. Called when the user presses Escape or exits select mode.
  const resetDragState = useCallback(() => {
    dragStateRef.current = null;
    resizeStateRef.current = null;
    clearAlignmentGuides();
    // 恢复所有 iframe 的 pointer-events（拖拽可能被 ESC 中断，需确保恢复）
    document.querySelectorAll('iframe').forEach(ifr => {
      ifr.style.pointerEvents = '';
    });
  }, [clearAlignmentGuides]);

  /* ── Apply style changes from the properties panel ────────────────── */
  const applyStyleChange = useCallback((style: Partial<ElementStyle>) => {
    if (!selectedElement) return;
    onElementStyleChange(selectedElement.selector, style);
    // Apply to iframe element immediately
    const iframe = iframeRefs.current.get(selectedScreenIdRef.current || '');
    if (!iframe?.contentDocument) return;
    const el = iframe.contentDocument.querySelector(selectedElement.selector) as HTMLElement | null;
    if (!el) return;
    // Ensure navbar orientation & dropdown CSS is available (idempotent)
    ensureNavbarOrientationStyles(iframe.contentDocument);
    ensureDropdownStyles(iframe.contentDocument);
    Object.entries(style).forEach(([key, val]) => {
      // ElementStyle 含只读 DOM 提示字段（hasMultipleTextChildren: boolean），
      // 不应写回 DOM。跳过非 string 值，收窄类型并防止误写。
      if (typeof val !== 'string') return;
      if (key === 'className') {
        // AdvancedCssEditor 的类名管理：直接写入 DOM className。
        // 注意：className 不属于 ElementStyle 类型字段（在 SelectedElement 上），
        // 这里通过类型断言传递，避免污染 ElementStyle 类型。
        el.className = String(val || '');
      } else if (key === 'text') {
        // Preserve sibling element children (SVG icons, class-bearing <span>
        // labels, etc.) — `el.textContent = val` would wipe them out, which
        // is why editing text used to make icons/styles disappear.
        setEditableText(el, val);
      } else if (key === 'rotation') {
        // Build transform preserving non-rotate parts
        const existing = el.style.transform || '';
        const cleaned = existing.replace(/rotate\(([-\d.]+)deg\)/g, '').trim();
        const rotatePart = val ? `rotate(${val}deg)` : '';
        el.style.transform = [cleaned, rotatePart].filter(Boolean).join(' ') || '';
      } else if (key === 'left' || key === 'top') {
        // Ensure position is set so left/top take effect
        if (val && (el.style.position === '' || el.style.position === 'static')) {
          // !important to override Bootstrap .position-* utilities
          el.style.setProperty('position', 'relative', 'important');
        }
        const cssProp = key === 'left' ? 'left' : 'top';
        if (val) {
          // !important to override Bootstrap .start-* / .top-* (left/top: ... !important)
          el.style.setProperty(cssProp, String(val), 'important');
        } else {
          el.style.removeProperty(cssProp);
        }
      } else if (key === 'linkType') {
        if (val) el.setAttribute('data-nav-type', val);
        else el.removeAttribute('data-nav-type');
      } else if (key === 'linkTarget') {
        if (val) el.setAttribute('data-nav-target', val);
        else el.removeAttribute('data-nav-target');
      } else if (key === 'navbarOrientation') {
        // navbar 排列方向：horizontal | vertical
        if (val) el.setAttribute('data-navbar-orientation', val);
        else el.removeAttribute('data-navbar-orientation');
      } else if (key === 'navbarCollapsed') {
        // 侧边导航栏折叠/展开：data-navbar-collapsed = "true" | "false"
        if (val === 'true' || val === 'false') el.setAttribute('data-navbar-collapsed', val);
        else el.removeAttribute('data-navbar-collapsed');
      } else if (key === 'iconClass') {
        // <i> 元素完整 className 回写（IconEditor）
        el.className = val;
      } else if (key === 'dropdownOpen') {
        // dropdown 展开/折叠：data-dropdown-open = "true" | "false"
        if (val === 'true' || val === 'false') el.setAttribute('data-dropdown-open', val);
        else el.removeAttribute('data-dropdown-open');
      } else if (key === 'navLinkIcon') {
        // nav-link / dropdown-item 菜单项图标：创建/更新/移除 <i class="bi bi-*"> 子元素
        // 排除 xai-dropdown-chevron（下拉菜单右侧小三角指示器，不应被当作内容图标编辑）
        const iconEl = el.querySelector('i.bi:not(.xai-dropdown-chevron), i[class*="bi-"]:not(.xai-dropdown-chevron)') as HTMLElement | null;
        if (val) {
          if (iconEl) {
            // 更新现有图标：保留非 bi/bi-* 的辅助类（如 text-primary, me-1 等）
            const other = iconEl.className.replace(/\bbi\s+bi-[\w-]+/, '').trim();
            iconEl.className = other ? `${other} bi bi-${val}` : `bi bi-${val}`;
          } else {
            // 新建图标，插入到元素最前面
            const doc = iframe.contentDocument;
            if (!doc) return;
            const newIcon = doc.createElement('i');
            newIcon.className = `bi bi-${val} me-1`;
            newIcon.setAttribute('data-design-id', 'nav-icon-' + Date.now().toString(36));
            el.insertBefore(newIcon, el.firstChild);
          }
        } else {
          // 移除图标
          if (iconEl) iconEl.remove();
        }
      } else if (key === 'placeholder') {
        if (val) el.setAttribute('placeholder', val);
        else el.removeAttribute('placeholder');
      } else if (key === 'value') {
        if ('value' in el) {
          (el as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement).value = val;
        }
        if (val) el.setAttribute('value', val);
        else el.removeAttribute('value');
      } else if (key === 'href') {
        if (val) el.setAttribute('href', val);
        else el.removeAttribute('href');
      } else if (key === 'src') {
        if (val) el.setAttribute('src', val);
        else el.removeAttribute('src');
      } else if (key === 'backgroundImage') {
        if (val) {
          // Accept bare URL or url(...) wrapped; wrap if needed
          const v = /^(url|linear-gradient|radial-gradient|repeating-)/i.test(val) ? val : `url("${val}")`;
          // !important to override Bootstrap .bg-gradient (background-image: var(--bs-gradient) !important)
          el.style.setProperty('background-image', v, 'important');
        } else {
          el.style.removeProperty('background-image');
        }
      } else if (key === 'backgroundColor') {
        // Gradient values must go to `background`, not `backgroundColor`
        if (/gradient\s*\(/i.test(val)) {
          el.style.setProperty('background', val, 'important');
          // Clear inline backgroundColor so it doesn't override
          el.style.removeProperty('background-color');
        } else {
          // Switching back to plain color: clear any previous gradient
          // set via `background` so the solid color shows through.
          if (el.style.background && /gradient\s*\(/i.test(el.style.background)) {
            el.style.removeProperty('background');
          }
          // !important to override Bootstrap .bg-* / .btn-* (background-color: ... !important)
          el.style.setProperty('background-color', val, 'important');
        }
      } else if (key === 'color') {
        // Gradient text requires background-clip: text
        if (/gradient\s*\(/i.test(val)) {
          el.style.setProperty('background', val, 'important');
          el.style.setProperty('background-clip', 'text', 'important');
          el.style.setProperty('-webkit-background-clip', 'text', 'important');
          el.style.setProperty('-webkit-text-fill-color', 'transparent', 'important');
        } else {
          // Restore normal color behavior
          // !important to override Bootstrap .text-* (color: ... !important)
          el.style.setProperty('color', val, 'important');
          if (el.style.webkitTextFillColor === 'transparent') {
            el.style.removeProperty('-webkit-text-fill-color');
            el.style.removeProperty('background-clip');
            el.style.removeProperty('-webkit-background-clip');
            el.style.removeProperty('background');
          }
        }
      } else if (key === 'overflowX' || key === 'overflowY' || key === 'tableMaxHeight') {
        // Table scroll properties target the wrapper, not the selected element.
        const tableCtx = resolveTableContext(el);
        let wrapper = tableCtx?.wrapper;
        const doc = iframe.contentDocument;
        if (tableCtx && doc) {
          if (!wrapper) {
            // No wrapper exists — create one around the table
            wrapper = doc.createElement('div');
            wrapper.setAttribute('data-design-id', `table-scroll-wrapper-${Date.now()}`);
            tableCtx.table.parentElement?.insertBefore(wrapper, tableCtx.table);
            wrapper.appendChild(tableCtx.table);
          }
          // Mark the wrapper so our scrollbar CSS can target it
          wrapper.classList.add('__xai_table_scroll_wrapper__');
          if (key === 'overflowX') {
            // !important to override Bootstrap .overflow-* utilities
            if (val) wrapper.style.setProperty('overflow-x', val, 'important');
            else wrapper.style.removeProperty('overflow-x');
          } else if (key === 'overflowY') {
            if (val) wrapper.style.setProperty('overflow-y', val, 'important');
            else wrapper.style.removeProperty('overflow-y');
          } else if (key === 'tableMaxHeight') {
            if (val) wrapper.style.setProperty('max-height', val, 'important');
            else wrapper.style.removeProperty('max-height');
          }
          // Inject custom scrollbar styles that match the page theme
          ensureTableScrollbarStyles(doc);
        }
      } else if (key === 'display') {
        // 切换 display：清空旧值再设新值，空串表示恢复默认（移除内联）
        // 使用 !important 以覆盖 Bootstrap .d-{value} 工具类（默认带 !important）
        if (val) el.style.setProperty('display', val, 'important');
        else el.style.removeProperty('display');
      } else if (key === 'border') {
        // Bootstrap border 工具类（.border, .border-outline-variant 等）带 !important，
        // 内联 border 必须也用 !important 才能覆盖。清空时设 none !important 彻底去掉边框。
        if (val && val !== 'none') {
          el.style.setProperty('border', val, 'important');
        } else {
          el.style.setProperty('border', 'none', 'important');
        }
      } else if (key === 'cssText') {
        // Raw inline style: 直接设置整个 cssText
        el.style.cssText = val;
      } else if (
        key === 'padding' || key === 'paddingTop' || key === 'paddingRight' || key === 'paddingBottom' || key === 'paddingLeft' ||
        key === 'margin' || key === 'marginTop' || key === 'marginRight' || key === 'marginBottom' || key === 'marginLeft' ||
        key === 'fontFamily' || key === 'fontWeight' || key === 'lineHeight' || key === 'letterSpacing' ||
        key === 'textDecoration' || key === 'textTransform' ||
        key === 'flexDirection' || key === 'justifyContent' || key === 'alignItems' || key === 'flexWrap' || key === 'gap'
      ) {
        // 通用 CSS 属性；空串移除内联
        // 使用 !important 以覆盖 Bootstrap 工具类（默认 $enable-important-utilities: true）
        const cssProp = key.replace(/([A-Z])/g, '-$1').toLowerCase();
        if (val) {
          el.style.setProperty(cssProp, String(val), 'important');
        } else {
          el.style.removeProperty(cssProp);
        }
        // 间距类（padding/margin 简写或四向）变更时，清理元素自身冲突的 Bootstrap p-*/m-* 工具类。
        // 否则 p-4（!important）会与内联 padding:0（!important）并存，class 残留误导用户，
        // 也让"删除 p-4"看起来"又补回来"——实际是内联压不住或残留未清。
        if (
          key === 'padding' || key === 'paddingTop' || key === 'paddingRight' ||
          key === 'paddingBottom' || key === 'paddingLeft' ||
          key === 'margin' || key === 'marginTop' || key === 'marginRight' ||
          key === 'marginBottom' || key === 'marginLeft'
        ) {
          _cleanConflictSpacingClasses(el, key);
        }
        // alignItems/justifyContent 变更时，清理子元素上冲突的 Bootstrap margin 工具类。
        // 例如：父容器 align-items:center，但子元素带 mb-3 类（margin-bottom!important）
        // 会导致该子元素下移，视觉上未居中。
        if (key === 'alignItems' || key === 'justifyContent') {
          _cleanChildMarginClasses(el, key);
        }
      } else if (key === 'backdropFilter') {
        // backdrop-filter: use webkit prefix for broader compatibility.
        // !important to match other props and override AI-generated CSS
        // classes that may use !important (e.g. .glass-card { backdrop-filter: blur(20px) !important }).
        if (val) {
          el.style.setProperty('backdrop-filter', String(val), 'important');
          el.style.setProperty('-webkit-backdrop-filter', String(val), 'important');
        } else {
          el.style.removeProperty('backdrop-filter');
          el.style.removeProperty('-webkit-backdrop-filter');
        }
      } else {
        // 通用 CSS 属性写入：统一使用 !important 以覆盖 Bootstrap 工具类
        // （.w-*/.h-*/.fs-*/.text-*/.rounded*/.shadow*/.opacity-*/.z-*/.start-*/.top-* 等
        // 默认带 !important）。否则内联样式会被工具类压住导致"修改后不生效"。
        // 空 val 移除内联属性，恢复工具类默认值。
        // 注意：这里用 kebab-case 转换，覆盖 width/height/fontSize/textAlign/borderRadius/
        // boxShadow/opacity/zIndex/filter/left/top/color/backgroundColor/backgroundImage 等。
        const cssProp = key.replace(/([A-Z])/g, '-$1').toLowerCase();
        if (val !== '' && val !== undefined && val !== null) {
          el.style.setProperty(cssProp, String(val), 'important');
        } else {
          el.style.removeProperty(cssProp);
        }
      }
    });
    const newHtml = '<!DOCTYPE html>\n' + iframe.contentDocument.documentElement.outerHTML;
    onHtmlChange(newHtml);
    // Update overlay
    const rect = el.getBoundingClientRect();
    // If text was edited, recompute hasMultipleTextChildren from the live DOM:
    // appending a direct text node to a previously-ambiguous container makes
    // it non-ambiguous, so the "select a more specific element" hint should
    // disappear. Without this, the flag stays stale and contradicts the
    // textarea's now-populated value.
    const mergedStyle: Partial<ElementStyle> = { ...style };
    if ('text' in style) {
      mergedStyle.hasMultipleTextChildren = isTextAmbiguous(el);
    }
    // className 不在 ElementStyle 中，但在 SelectedElement 上。
    // AdvancedCssEditor 的类名管理通过 className key 传递，这里同步更新 React state，
    // 否则面板会显示旧 className（虽然 DOM 已更新）。
    const classNameUpdate = 'className' in style
      ? { className: String((style as Record<string, unknown>).className || '') }
      : {};
    onSelectElement({
      ...selectedElement,
      ...classNameUpdate,
      style: { ...selectedElement.style, ...mergedStyle },
      rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
    });
  }, [selectedElement, onElementStyleChange, onHtmlChange, onSelectElement, iframeRefs, selectedScreenIdRef]);

  const selectParentElement = useCallback(() => {
    const context = getSelectedDomContext();
    if (!context) return;
    let current: HTMLElement | null = context.el.parentElement;
    while (current && current.tagName !== 'BODY' && current.tagName !== 'HTML') {
      const rect = current.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) break;
      current = current.parentElement;
    }
    if (!current || current.tagName === 'BODY' || current.tagName === 'HTML') return;
    syncSelectedElement(current, context.doc, context.screenId);
  }, [getSelectedDomContext, syncSelectedElement]);

  const duplicateSelectedElement = useCallback(() => {
    if (!selectedElement) return;
    handleDuplicateElement(selectedElement.selector);
  }, [handleDuplicateElement, selectedElement]);

  const swapWithSibling = useCallback((direction: 'previous' | 'next') => {
    const context = getSelectedDomContext();
    if (!context || !context.el.parentElement) return;
    const sibling = direction === 'previous'
      ? context.el.previousElementSibling
      : context.el.nextElementSibling;
    if (!sibling) return;
    if (direction === 'previous') {
      context.el.parentElement.insertBefore(context.el, sibling);
    } else {
      context.el.parentElement.insertBefore(sibling, context.el);
    }
    commitDom(context.doc);
    syncSelectedElement(context.el, context.doc, context.screenId);
  }, [commitDom, getSelectedDomContext, syncSelectedElement]);

  const adjustZIndex = useCallback((delta: number) => {
    const context = getSelectedDomContext();
    if (!context) return;
    const current = parseInt(context.el.style.zIndex || context.doc.defaultView?.getComputedStyle(context.el).zIndex || '0', 10);
    const next = Number.isFinite(current) ? current + delta : delta;
    if (!context.el.style.position || context.el.style.position === 'static') {
      context.el.style.position = 'relative';
    }
    context.el.style.zIndex = String(Math.max(next, 0));
    commitDom(context.doc);
    syncSelectedElement(context.el, context.doc, context.screenId);
  }, [commitDom, getSelectedDomContext, syncSelectedElement]);

  const addTableRowAtSelection = useCallback(() => {
    const context = getSelectedDomContext();
    if (!context) return;
    const tableContext = resolveTableContext(context.el);
    if (!tableContext) return;

    const table = tableContext.table;
    const referenceRow = (context.el.closest('tr') as HTMLTableRowElement | null)
      || getTableRows(table)[0];
    const colCount = referenceRow?.cells.length || 3;
    const newRow = context.doc.createElement('tr');
    newRow.setAttribute('data-design-id', `designer-added-row-${Date.now()}`);
    for (let i = 0; i < colCount; i += 1) {
      const td = context.doc.createElement('td');
      td.textContent = i === 0 ? '新数据' : '-';
      td.className = (referenceRow?.cells[i] as HTMLElement | undefined)?.className || 'px-4 py-3 text-sm';
      if (tableContext.columnWidth) {
        td.style.width = tableContext.columnWidth;
        td.style.minWidth = tableContext.columnWidth;
      }
      newRow.appendChild(td);
    }

    // Append to tbody if exists, otherwise to table directly
    const tbody = table.querySelector('tbody');
    if (tbody) {
      tbody.appendChild(newRow);
    } else {
      table.appendChild(newRow);
    }

    commitDom(context.doc);
    syncSelectedElement(context.el, context.doc, context.screenId);
  }, [commitDom, getSelectedDomContext, syncSelectedElement]);

  const addTableColumnAtSelection = useCallback(() => {
    const context = getSelectedDomContext();
    if (!context) return;
    const tableContext = resolveTableContext(context.el);
    if (!tableContext) return;
    const insertIndex = tableContext.columnIndex;
    const table = tableContext.table;

    const allRows = getTableRows(table);
    allRows.forEach((row, rowIndex) => {
      const refCell = row.cells[Math.min(insertIndex, row.cells.length - 1)] as HTMLElement | undefined;
      if (row.querySelector('th')) {
        // Header row: create th
        const newTh = context.doc.createElement('th');
        newTh.setAttribute('data-design-id', `designer-added-th-${Date.now()}-${rowIndex}`);
        newTh.className = refCell?.className || 'px-4 py-3 text-left text-xs font-medium';
        newTh.textContent = '新列';
        if (insertIndex < row.cells.length) {
          row.insertBefore(newTh, row.cells[insertIndex]);
        } else {
          row.appendChild(newTh);
        }
      } else {
        // Body row: create td
        const newTd = context.doc.createElement('td');
        newTd.setAttribute('data-design-id', `designer-added-td-${Date.now()}-${rowIndex}`);
        newTd.className = refCell?.className || 'px-4 py-3 text-sm';
        newTd.textContent = '-';
        if (tableContext.columnWidth) {
          newTd.style.width = tableContext.columnWidth;
          newTd.style.minWidth = tableContext.columnWidth;
        }
        if (insertIndex < row.cells.length) {
          row.insertBefore(newTd, row.cells[insertIndex]);
        } else {
          row.appendChild(newTd);
        }
      }
    });
    // Adding a column shifts the last cell index; re-apply sticky tags so
    // the frozen column stays aligned with the new first/last cell.
    reapplyStickyColumnClasses(table);

    commitDom(context.doc);
    syncSelectedElement(context.el, context.doc, context.screenId);
  }, [commitDom, getSelectedDomContext, syncSelectedElement]);

  const removeTableRowAtSelection = useCallback(() => {
    const context = getSelectedDomContext();
    if (!context) return;
    const tableContext = resolveTableContext(context.el);
    if (!tableContext) return;

    const currentRow = context.el.closest('tr') as HTMLTableRowElement | null;
    if (!currentRow) return;

    /* If only one row left, don't delete */
    const allRows = getTableRows(tableContext.table);
    if (allRows.length <= 1) return;

    /* Select next sibling or previous before removing */
    const nextRow = currentRow.nextElementSibling as HTMLTableRowElement | null;
    const prevRow = currentRow.previousElementSibling as HTMLTableRowElement | null;
    currentRow.remove();

    /* Select the sibling row's first cell so user stays in table context */
    const targetRow = nextRow || prevRow;
    if (targetRow) {
      const firstCell = targetRow.querySelector('td, th') as HTMLElement | null;
      if (firstCell) {
        syncSelectedElement(firstCell, context.doc, context.screenId);
      }
    }

    commitDom(context.doc);
  }, [commitDom, getSelectedDomContext, syncSelectedElement]);

  const removeTableColumnAtSelection = useCallback(() => {
    const context = getSelectedDomContext();
    if (!context) return;
    const tableContext = resolveTableContext(context.el);
    if (!tableContext) return;

    const colIdx = tableContext.columnIndex;
    const allRows = getTableRows(tableContext.table);

    /* Check if only one column left */
    const hasMultipleCols = allRows.some(row => row.cells.length > 1);
    if (!hasMultipleCols) return;

    allRows.forEach(row => {
      const cell = row.cells[colIdx] as HTMLElement | undefined;
      if (cell) cell.remove();
    });
    // Removing a column shifts the last cell index; re-apply sticky tags so
    // the frozen column stays aligned with the new first/last cell.
    reapplyStickyColumnClasses(tableContext.table);

    commitDom(context.doc);
    syncSelectedElement(context.el, context.doc, context.screenId);
  }, [commitDom, getSelectedDomContext, syncSelectedElement]);

  const copyTableRowAtSelection = useCallback(() => {
    const context = getSelectedDomContext();
    if (!context) return;
    const tableContext = resolveTableContext(context.el);
    if (!tableContext) return;

    const currentRow = context.el.closest('tr') as HTMLTableRowElement | null;
    if (!currentRow) return;

    const timestamp = Date.now();
    const clone = currentRow.cloneNode(true) as HTMLTableRowElement;
    clone.setAttribute('data-design-id', `designer-copied-row-${timestamp}`);

    /* Generate new unique IDs instead of removing them */
    const cellId = clone.getAttribute('id');
    if (cellId) {
      clone.setAttribute('id', `${cellId}-copy-${timestamp}`);
    }
    clone.querySelectorAll('[id]').forEach(el => {
      const oldId = el.getAttribute('id');
      if (oldId) {
        el.setAttribute('id', `${oldId}-copy-${timestamp}`);
      }
    });

    currentRow.parentElement?.insertBefore(clone, currentRow.nextSibling);

    commitDom(context.doc);
    syncSelectedElement(context.el, context.doc, context.screenId);
  }, [commitDom, getSelectedDomContext, syncSelectedElement]);

  const copyTableColumnAtSelection = useCallback(() => {
    const context = getSelectedDomContext();
    if (!context) return;
    const tableContext = resolveTableContext(context.el);
    if (!tableContext) return;

    const colIdx = tableContext.columnIndex;
    const table = tableContext.table;
    const timestamp = Date.now();

    const allRows = getTableRows(table);

    allRows.forEach((row, rowIndex) => {
      const sourceCell = row.cells[colIdx] as HTMLElement | undefined;
      if (!sourceCell) return;

      const clone = sourceCell.cloneNode(true) as HTMLElement;
      clone.setAttribute('data-design-id', `designer-copied-${timestamp}-${rowIndex}`);

      // Remove rowspan/colspan from clone to avoid layout issues
      clone.removeAttribute('rowspan');
      clone.removeAttribute('colspan');

      const cellId = clone.getAttribute('id');
      if (cellId) {
        clone.setAttribute('id', `${cellId}-copy-${timestamp}-${rowIndex}`);
      }
      clone.querySelectorAll('[id]').forEach(el => {
        const oldId = el.getAttribute('id');
        if (oldId) {
          el.setAttribute('id', `${oldId}-copy-${timestamp}-${rowIndex}`);
        }
      });

      if (colIdx + 1 < row.cells.length) {
        row.insertBefore(clone, row.cells[colIdx + 1]);
      } else {
        row.appendChild(clone);
      }
    });
    // Copying a column shifts the last cell index; re-apply sticky tags so
    // the frozen column stays aligned with the new first/last cell.
    reapplyStickyColumnClasses(table);

    commitDom(context.doc);
    syncSelectedElement(context.el, context.doc, context.screenId);
  }, [commitDom, getSelectedDomContext, syncSelectedElement]);

  const setTableColumnWidth = useCallback((width: string) => {
    const context = getSelectedDomContext();
    if (!context) return;
    const tableContext = resolveTableContext(context.el);
    if (!tableContext) return;
    const normalized = width.trim();
    const rows = getTableRows(tableContext.table);
    rows.forEach(row => {
      const cell = row.children[tableContext.columnIndex] as HTMLElement | undefined;
      if (!cell) return;
      if (normalized) {
        cell.style.width = normalized;
        cell.style.minWidth = normalized;
      } else {
        cell.style.width = '';
        cell.style.minWidth = '';
      }
    });
    commitDom(context.doc);
    syncSelectedElement(context.el, context.doc, context.screenId);
  }, [commitDom, getSelectedDomContext, syncSelectedElement]);

  const updateSelectOptions = useCallback((options: Array<{ label: string; value: string; selected: boolean }>) => {
    const context = getSelectedDomContext();
    if (!context) return;
    const select = getSelectElement(context.el);
    if (!select) return;

    select.innerHTML = '';
    options.forEach((item, index) => {
      const option = context.doc.createElement('option');
      option.value = item.value;
      option.textContent = item.label;
      option.selected = item.selected || (!options.some(opt => opt.selected) && index === 0);
      select.appendChild(option);
    });
    commitDom(context.doc);
    syncSelectedElement(select, context.doc, context.screenId);
  }, [commitDom, getSelectedDomContext, syncSelectedElement]);

  const renameTab = useCallback((index: number, label: string) => {
    const context = getSelectedDomContext();
    if (!context) return;
    const tabsContext = resolveTabsContext(context.el);
    if (!tabsContext) return;
    const trigger = tabsContext.triggers[index];
    if (!trigger) return;
    trigger.textContent = label;
    commitDom(context.doc);
    syncSelectedElement(trigger, context.doc, context.screenId);
  }, [commitDom, getSelectedDomContext, syncSelectedElement]);

  const addTab = useCallback(() => {
    const context = getSelectedDomContext();
    if (!context) return;
    const tabsContext = resolveTabsContext(context.el);
    if (!tabsContext || !tabsContext.contentContainer) return;

    const nextIndex = tabsContext.triggers.length + 1;
    const tabId = `designer-tab-${Date.now()}`;
    const paneId = `${tabId}-pane`;
    const referenceTrigger = tabsContext.triggers[0];
    const triggerTag = referenceTrigger?.tagName || 'BUTTON';
    const newTrigger = context.doc.createElement(triggerTag);
    newTrigger.textContent = `标签 ${nextIndex}`;
    newTrigger.className = referenceTrigger?.className || 'nav-link';
    newTrigger.setAttribute('data-bs-toggle', 'tab');
    newTrigger.setAttribute('data-bs-target', `#${paneId}`);
    newTrigger.setAttribute('type', triggerTag === 'BUTTON' ? 'button' : (referenceTrigger?.getAttribute('type') || 'button'));
    newTrigger.setAttribute('role', 'tab');
    newTrigger.setAttribute('aria-controls', paneId);
    newTrigger.setAttribute('aria-selected', 'false');
    newTrigger.id = tabId;
    newTrigger.classList.remove('active');

    const wrapper = referenceTrigger?.parentElement?.tagName === 'LI'
      ? context.doc.createElement('li')
      : null;
    if (wrapper) {
      wrapper.className = referenceTrigger.parentElement?.className || 'nav-item';
      wrapper.appendChild(newTrigger);
      tabsContext.tabList.appendChild(wrapper);
    } else {
      tabsContext.tabList.appendChild(newTrigger);
    }

    const newPane = context.doc.createElement('div');
    newPane.id = paneId;
    newPane.className = 'tab-pane fade';
    newPane.setAttribute('role', 'tabpanel');
    newPane.setAttribute('aria-labelledby', tabId);
    newPane.setAttribute('data-design-id', `designer-tab-pane-${Date.now()}`);
    newPane.textContent = `标签 ${nextIndex} 内容`;
    tabsContext.contentContainer.appendChild(newPane);

    commitDom(context.doc);
    syncSelectedElement(newTrigger, context.doc, context.screenId);
  }, [commitDom, getSelectedDomContext, syncSelectedElement]);

  const removeTab = useCallback((index: number) => {
    const context = getSelectedDomContext();
    if (!context) return;
    const tabsContext = resolveTabsContext(context.el);
    if (!tabsContext || tabsContext.triggers.length <= 1) return;

    const trigger = tabsContext.triggers[index];
    if (!trigger) return;
    const targetId = trigger.getAttribute('data-bs-target')?.replace(/^#/, '')
      || trigger.getAttribute('href')?.replace(/^#/, '')
      || trigger.getAttribute('aria-controls')
      || '';
    const pane = targetId ? context.doc.getElementById(targetId) : null;
    const nextTrigger = tabsContext.triggers[index - 1] || tabsContext.triggers[index + 1] || null;

    const wrapper = trigger.parentElement?.tagName === 'LI' ? trigger.parentElement : trigger;
    wrapper?.remove();
    pane?.remove();

    if (nextTrigger) {
      nextTrigger.classList.add('active');
      nextTrigger.setAttribute('aria-selected', 'true');
      const nextTargetId = nextTrigger.getAttribute('data-bs-target')?.replace(/^#/, '')
        || nextTrigger.getAttribute('href')?.replace(/^#/, '')
        || nextTrigger.getAttribute('aria-controls')
        || '';
      const nextPane = nextTargetId ? context.doc.getElementById(nextTargetId) : null;
      nextPane?.classList.add('show', 'active');
    }

    commitDom(context.doc);
    if (nextTrigger) syncSelectedElement(nextTrigger, context.doc, context.screenId);
  }, [commitDom, getSelectedDomContext, syncSelectedElement]);

  /* ── Tabs: 切换 active 标签 ─────────────────────────────────────── */
  const setActiveTab = useCallback((index: number) => {
    const context = getSelectedDomContext();
    if (!context) return;
    const tabsContext = resolveTabsContext(context.el);
    if (!tabsContext) return;
    const trigger = tabsContext.triggers[index];
    if (!trigger) return;

    // 取消所有 active 状态
    tabsContext.triggers.forEach(t => {
      t.classList.remove('active');
      t.setAttribute('aria-selected', 'false');
    });
    // 激活目标
    trigger.classList.add('active');
    trigger.setAttribute('aria-selected', 'true');

    // 切换 pane
    tabsContext.triggers.forEach(t => {
      const targetId = t.getAttribute('data-bs-target')?.replace(/^#/, '')
        || t.getAttribute('href')?.replace(/^#/, '')
        || t.getAttribute('aria-controls')
        || '';
      const pane = targetId ? context.doc.getElementById(targetId) : null;
      pane?.classList.remove('show', 'active');
    });
    const targetId = trigger.getAttribute('data-bs-target')?.replace(/^#/, '')
      || trigger.getAttribute('href')?.replace(/^#/, '')
      || trigger.getAttribute('aria-controls')
      || '';
    const pane = targetId ? context.doc.getElementById(targetId) : null;
    pane?.classList.add('show', 'active');

    commitDom(context.doc);
    syncSelectedElement(trigger, context.doc, context.screenId);
  }, [commitDom, getSelectedDomContext, syncSelectedElement]);

  /* ── 菜单项：一键设为当前页高亮项（人工设置，toggle 语义） ─────────
   * 便于观察测试/正式使用时手动指定哪个菜单项为"当前页"。
   * 行为（toggle）：
   *  1. 解析目标 <a>（选中 <li class="nav-item"> 时下钻到其内部 <a>）；
   *  2. 记录目标当前是否已 active（wasActive）；
   *  3. 在同一菜单作用域（最近 nav/.sidebar/ul.nav）内清除所有菜单链接的
   *     .active/.active-side 及其 <li>.active；
   *  4. 若 wasActive 为 false（原本未高亮）→ 给目标加 .active/.active-side
   *     （及其 <li>.active）并展开祖先子菜单；若 wasActive 为 true（已高亮）
   *     → 保持清除态，即取消高亮（不折叠祖先，避免误伤用户已展开的子菜单）。
   *  5. 展开祖先子菜单：Bootstrap .collapse 加 .show + toggle aria-expanded、
   *     data-dropdown-open 置 true、清除 .sidebar-submenu 内联 display:none/maxHeight
   *     （与 masterLayoutInject.expandAncestors 同步，初始 JS 未执行也能可见）。
   *
   * 持久化：commitDom 走 direct-DOM 路径（reportDomHtmlChange），iframe 不重载；
   * 保存的 HTML 加载时不再跑 injectMasterLayouts（仅 AI 生成/编辑才跑），
   * 故人工高亮在 会话/重开/导出 均保留，不会被 screenName 自动匹配覆盖。
   */
  const setAsCurrentMenuItem = useCallback(() => {
    const context = getSelectedDomContext();
    if (!context) return;
    const { el, doc } = context;

    // 1. 解析目标 <a>
    let target: HTMLElement = el;
    if (el.tagName === 'LI' || el.classList.contains('nav-item')) {
      const inner = el.querySelector('a.nav-link, a.submenu-link, a.dropdown-item, a') as HTMLElement | null;
      if (inner) target = inner;
    }
    if (target.tagName !== 'A') return;

    // 菜单作用域：仅在同一 nav/.sidebar 内去激活兄弟，避免误伤面包屑/分页/其他 nav
    const menuRoot = target.closest('nav, .sidebar, .navbar-nav, ul.nav') as ParentNode | null;
    const scope: ParentNode = menuRoot || doc;

    // 2. toggle：记录目标当前是否已 active（在清除前判定）
    const wasActive = target.classList.contains('active');

    // 3. 去激活作用域内所有菜单链接
    scope.querySelectorAll('a.nav-link, a.submenu-link, a.dropdown-item').forEach(a => {
      a.classList.remove('active', 'active-side');
      a.closest('li')?.classList.remove('active');
    });

    // 4. 原本未高亮 → 激活目标并展开祖先；原本已高亮 → 维持清除态（toggle off）
    if (!wasActive) {
      target.classList.add('active', 'active-side');
      target.closest('li')?.classList.add('active');

      // 5. 展开祖先子菜单（Bootstrap collapse + sidebar-dropdown + sidebar-submenu）
      let cur: Element | null = target.parentElement;
      while (cur && cur !== scope) {
        if (cur.classList.contains('collapse')) {
          cur.classList.add('show');
          const id = cur.getAttribute('id');
          if (id) {
            const toggle = scope.querySelector(
              `[data-bs-toggle="collapse"][href="#${id}"], [data-bs-toggle="collapse"][data-bs-target="#${id}"]`,
            );
            toggle?.setAttribute('aria-expanded', 'true');
          }
        }
        if (cur.getAttribute('data-dropdown-open') !== null) {
          cur.setAttribute('data-dropdown-open', 'true');
          const submenu = cur.querySelector('.sidebar-submenu');
          if (submenu) {
            (submenu as HTMLElement).style.display = 'block';
            (submenu as HTMLElement).style.maxHeight = 'none';
          }
        }
        cur = cur.parentElement;
      }
    }

    commitDom(context.doc);
    // 同步选中元素状态（className 已变）；保持选区在原 el 上不跳动
    syncSelectedElement(el, context.doc, context.screenId);
  }, [commitDom, getSelectedDomContext, syncSelectedElement]);

  /* ── 表格：垂直滚动开关（含 max-height） ───────────────────────── */
  const toggleTableVerticalScroll = useCallback((enabled: boolean, maxHeight: string) => {
    const context = getSelectedDomContext();
    if (!context) return;
    const tableCtx = resolveTableContext(context.el);
    if (!tableCtx) return;
    let wrapper = tableCtx.wrapper;
    if (!wrapper) {
      // 复用 applyStyleChange 的 wrapper 创建逻辑
      wrapper = context.doc.createElement('div');
      wrapper.setAttribute('data-design-id', `table-scroll-wrapper-${Date.now()}`);
      tableCtx.table.parentElement?.insertBefore(wrapper, tableCtx.table);
      wrapper.appendChild(tableCtx.table);
    }
    wrapper.classList.add('__xai_table_scroll_wrapper__');
    if (enabled) {
      wrapper.style.overflowY = 'auto';
      wrapper.style.maxHeight = maxHeight || '400px';
    } else {
      wrapper.style.overflowY = '';
      wrapper.style.maxHeight = '';
    }
    ensureTableScrollbarStyles(context.doc);
    commitDom(context.doc);
    syncSelectedElement(context.el, context.doc, context.screenId);
  }, [commitDom, getSelectedDomContext, syncSelectedElement]);

  /* ── 表格：斑马纹开关 ─────────────────────────────────────────── */
  const toggleTableStriped = useCallback((enabled: boolean) => {
    const context = getSelectedDomContext();
    if (!context) return;
    const tableCtx = resolveTableContext(context.el);
    if (!tableCtx) return;
    const table = tableCtx.table;
    if (enabled) {
      table.classList.add('table-striped');
    } else {
      table.classList.remove('table-striped');
    }
    commitDom(context.doc);
    syncSelectedElement(context.el, context.doc, context.screenId);
  }, [commitDom, getSelectedDomContext, syncSelectedElement]);

  /* ── 表格：冻结列（sticky left/right） ─────────────────────────── */
  const toggleTableStickyColumn = useCallback((side: 'left' | 'right', enabled: boolean) => {
    const context = getSelectedDomContext();
    if (!context) return;
    const tableCtx = resolveTableContext(context.el);
    if (!tableCtx) return;
    const { table } = tableCtx;
    const doc = context.doc;
    const tableClass = side === 'left' ? STICKY_LEFT_TABLE_CLASS : STICKY_RIGHT_TABLE_CLASS;

    if (enabled) {
      table.classList.add(tableClass);
      // Sticky needs a scroll container. Reuse the existing wrapper
      // (incl. Bootstrap .table-responsive) or create one if missing.
      let wrapper = tableCtx.wrapper;
      if (!wrapper) {
        wrapper = doc.createElement('div');
        wrapper.setAttribute('data-design-id', `table-scroll-wrapper-${Date.now()}`);
        table.parentElement?.insertBefore(wrapper, table);
        wrapper.appendChild(table);
      }
      wrapper.classList.add('__xai_table_scroll_wrapper__');
      // Horizontal scroll is required for sticky columns to be visible
      if (!wrapper.style.overflowX) wrapper.style.overflowX = 'auto';
      // NOTE: We intentionally do NOT force `table-layout: fixed` here.
      // Forced fixed layout discards min-width on cells and redistributes
      // column widths by the first row's width ratios — this breaks
      // tables that rely on auto sizing (columns without explicit width
      // collapse). Sticky left works perfectly under auto layout; sticky
      // right may drift slightly when content width varies, but that is
      // far less disruptive than forcing a layout mode change. Users who
      // need pixel-perfect right-sticky can set table-layout: fixed
      // themselves and declare widths on all columns.
    } else {
      table.classList.remove(tableClass);
    }
    reapplyStickyColumnClasses(table);
    ensureTableStickyColumnStyles(doc);
    ensureTableScrollbarStyles(doc);
    commitDom(doc);
    syncSelectedElement(context.el, context.doc, context.screenId);
  }, [commitDom, getSelectedDomContext, syncSelectedElement]);

  /* ── 表格：合并单元格（基于当前选中单元格的右/下方向） ─────────── */
  const mergeTableCell = useCallback((direction: 'right' | 'down') => {
    const context = getSelectedDomContext();
    if (!context) return;
    const cell = context.el.closest('th, td') as HTMLTableCellElement | null;
    if (!cell) return;
    const row = cell.parentElement as HTMLTableRowElement | null;
    if (!row) return;

    if (direction === 'right') {
      const next = cell.nextElementSibling as HTMLTableCellElement | null;
      if (!next) return;
      // colSpan 是 number 类型，直接相加
      const span = (cell.colSpan || 1) + (next.colSpan || 1);
      // 合并内容
      cell.textContent = (cell.textContent || '') + ' ' + (next.textContent || '');
      cell.colSpan = span;
      next.remove();
    } else {
      const table = cell.closest('table') as HTMLTableElement | null;
      if (!table) return;
      const rows = getTableRows(table);
      const rowIndex = rows.indexOf(row);
      const cellIndex = Array.from(row.querySelectorAll(':scope > th, :scope > td')).indexOf(cell);
      const nextRow = rows[rowIndex + 1];
      if (!nextRow) return;
      const nextCell = Array.from(nextRow.querySelectorAll(':scope > th, :scope > td'))[cellIndex] as HTMLTableCellElement | undefined;
      if (!nextCell) return;
      const span = (cell.rowSpan || 1) + (nextCell.rowSpan || 1);
      cell.textContent = (cell.textContent || '') + ' ' + (nextCell.textContent || '');
      cell.rowSpan = span;
      nextCell.remove();
    }
    commitDom(context.doc);
    syncSelectedElement(cell, context.doc, context.screenId);
  }, [commitDom, getSelectedDomContext, syncSelectedElement]);

  /* ── Accordion：新增/删除/重命名/展开切换 ──────────────────────── */
  const addAccordionItem = useCallback(() => {
    const context = getSelectedDomContext();
    if (!context) return;
    const accCtx = resolveAccordionContext(context.el);
    if (!accCtx) return;
    const doc = context.doc;
    const timestamp = Date.now();
    const itemId = `accordion-item-${timestamp}`;
    const collapseId = `accordion-collapse-${timestamp}`;

    const item = doc.createElement('div');
    item.className = 'accordion-item';
    item.setAttribute('data-design-id', `designer-acc-item-${timestamp}`);

    const header = doc.createElement('h2');
    header.className = 'accordion-header';

    const button = doc.createElement('button');
    button.className = 'accordion-button collapsed';
    button.type = 'button';
    button.setAttribute('data-bs-toggle', 'collapse');
    button.setAttribute('data-bs-target', `#${collapseId}`);
    button.setAttribute('aria-expanded', 'false');
    button.setAttribute('aria-controls', collapseId);
    button.textContent = `面板 ${accCtx.items.length + 1}`;
    header.appendChild(button);

    const collapse = doc.createElement('div');
    collapse.id = collapseId;
    collapse.className = 'accordion-collapse collapse';
    const body = doc.createElement('div');
    body.className = 'accordion-body';
    body.textContent = '新面板内容';
    collapse.appendChild(body);

    item.appendChild(header);
    item.appendChild(collapse);
    accCtx.accordion.appendChild(item);

    commitDom(doc);
    syncSelectedElement(button, doc, context.screenId);
  }, [commitDom, getSelectedDomContext, syncSelectedElement]);

  const removeAccordionItem = useCallback((index: number) => {
    const context = getSelectedDomContext();
    if (!context) return;
    const accCtx = resolveAccordionContext(context.el);
    if (!accCtx || accCtx.items.length <= 1) return;
    const item = accCtx.items[index];
    if (!item) return;
    const next = accCtx.items[index - 1] || accCtx.items[index + 1];
    item.remove();
    commitDom(context.doc);
    if (next) {
      const trigger = next.querySelector('.accordion-button, [data-accordion-trigger]') as HTMLElement | null;
      syncSelectedElement(trigger || next, context.doc, context.screenId);
    }
  }, [commitDom, getSelectedDomContext, syncSelectedElement]);

  const renameAccordionItem = useCallback((index: number, header: string) => {
    const context = getSelectedDomContext();
    if (!context) return;
    const accCtx = resolveAccordionContext(context.el);
    if (!accCtx) return;
    const item = accCtx.items[index];
    if (!item) return;
    const trigger = item.querySelector('.accordion-button, [data-accordion-trigger]') as HTMLElement | null;
    if (trigger) {
      trigger.textContent = header;
    } else {
      const headerEl = item.querySelector('.accordion-header, [data-accordion-header]') as HTMLElement | null;
      if (headerEl) headerEl.textContent = header;
    }
    commitDom(context.doc);
    syncSelectedElement(trigger || item, context.doc, context.screenId);
  }, [commitDom, getSelectedDomContext, syncSelectedElement]);

  const toggleAccordionItem = useCallback((index: number) => {
    const context = getSelectedDomContext();
    if (!context) return;
    const accCtx = resolveAccordionContext(context.el);
    if (!accCtx) return;
    const item = accCtx.items[index];
    if (!item) return;
    const button = item.querySelector('.accordion-button') as HTMLElement | null;
    const collapse = item.querySelector('.accordion-collapse') as HTMLElement | null;
    if (button && collapse) {
      const isCollapsed = button.classList.contains('collapsed');
      if (isCollapsed) {
        button.classList.remove('collapsed');
        button.setAttribute('aria-expanded', 'true');
        collapse.classList.add('show');
      } else {
        button.classList.add('collapsed');
        button.setAttribute('aria-expanded', 'false');
        collapse.classList.remove('show');
      }
      commitDom(context.doc);
      syncSelectedElement(button, context.doc, context.screenId);
    }
  }, [commitDom, getSelectedDomContext, syncSelectedElement]);

  /* ── Carousel：新增/删除幻灯片/切换 active ────────────────────── */
  const addCarouselSlide = useCallback(() => {
    const context = getSelectedDomContext();
    if (!context) return;
    const carCtx = resolveCarouselContext(context.el);
    if (!carCtx) return;
    const doc = context.doc;
    const timestamp = Date.now();
    const slide = doc.createElement('div');
    slide.className = 'carousel-item';
    slide.setAttribute('data-design-id', `designer-carousel-slide-${timestamp}`);
    const caption = doc.createElement('div');
    caption.className = 'carousel-caption d-none d-md-block';
    caption.textContent = `轮播 ${carCtx.slides.length + 1}`;
    slide.appendChild(caption);
    carCtx.carousel.appendChild(slide);

    // 同步 indicators
    if (carCtx.hasIndicators) {
      const indicatorList = carCtx.carousel.querySelector('.carousel-indicators');
      if (indicatorList) {
        const indicator = doc.createElement('li');
        indicator.setAttribute('data-bs-target', '#');
        indicator.setAttribute('data-bs-slide-to', String(carCtx.slides.length));
        indicatorList.appendChild(indicator);
      }
    }
    commitDom(doc);
    syncSelectedElement(slide, doc, context.screenId);
  }, [commitDom, getSelectedDomContext, syncSelectedElement]);

  const removeCarouselSlide = useCallback((index: number) => {
    const context = getSelectedDomContext();
    if (!context) return;
    const carCtx = resolveCarouselContext(context.el);
    if (!carCtx || carCtx.slides.length <= 1) return;
    const slide = carCtx.slides[index];
    if (!slide) return;
    const wasActive = slide.classList.contains('active');
    slide.remove();
    if (carCtx.indicators[index]) carCtx.indicators[index].remove();
    if (wasActive && carCtx.slides.length > 0) {
      const next = carCtx.slides[index] || carCtx.slides[index - 1];
      if (next) {
        next.classList.add('active');
        syncSelectedElement(next, context.doc, context.screenId);
      }
    }
    commitDom(context.doc);
  }, [commitDom, getSelectedDomContext, syncSelectedElement]);

  const setActiveCarouselSlide = useCallback((index: number) => {
    const context = getSelectedDomContext();
    if (!context) return;
    const carCtx = resolveCarouselContext(context.el);
    if (!carCtx) return;
    carCtx.slides.forEach((s, i) => s.classList.toggle('active', i === index));
    carCtx.indicators.forEach((ind, i) => {
      ind.classList.toggle('active', i === index);
      if (i === index) ind.setAttribute('aria-current', 'true');
      else ind.removeAttribute('aria-current');
    });
    commitDom(context.doc);
    const target = carCtx.slides[index];
    if (target) syncSelectedElement(target, context.doc, context.screenId);
  }, [commitDom, getSelectedDomContext, syncSelectedElement]);

  const renameCarouselSlide = useCallback((index: number, caption: string) => {
    const context = getSelectedDomContext();
    if (!context) return;
    const carCtx = resolveCarouselContext(context.el);
    if (!carCtx) return;
    const slide = carCtx.slides[index];
    if (!slide) return;
    let captionEl = slide.querySelector('.carousel-caption, [data-carousel-caption]') as HTMLElement | null;
    if (!captionEl) {
      captionEl = context.doc.createElement('div');
      captionEl.className = 'carousel-caption d-none d-md-block';
      slide.appendChild(captionEl);
    }
    captionEl.textContent = caption;
    commitDom(context.doc);
    syncSelectedElement(slide, context.doc, context.screenId);
  }, [commitDom, getSelectedDomContext, syncSelectedElement]);

  /* ── Progress：值/标签/条纹/动画/变体 ─────────────────────────── */
  const updateProgress = useCallback((updates: { value?: number; label?: string; striped?: boolean; animated?: boolean; variant?: string }) => {
    const context = getSelectedDomContext();
    if (!context) return;
    const progCtx = resolveProgressContext(context.el);
    if (!progCtx) return;
    const { bar } = progCtx;

    if (updates.value !== undefined) {
      const v = Math.max(0, Math.min(100, Math.round(updates.value)));
      bar.style.width = `${v}%`;
      bar.setAttribute('aria-valuenow', String(v));
      // 同步 native progress
      if (bar.tagName === 'PROGRESS') (bar as HTMLProgressElement).value = v;
      else if (bar.tagName === 'METER') (bar as HTMLMeterElement).value = v;
    }
    if (updates.label !== undefined) {
      bar.textContent = updates.label;
    }
    if (updates.striped !== undefined) {
      bar.classList.toggle('progress-bar-striped', updates.striped);
    }
    if (updates.animated !== undefined) {
      bar.classList.toggle('progress-bar-animated', updates.animated);
    }
    if (updates.variant !== undefined) {
      // 移除旧 bg-* 变体
      ['bg-success', 'bg-info', 'bg-warning', 'bg-danger', 'bg-primary', 'bg-secondary', 'bg-light', 'bg-dark'].forEach(c => bar.classList.remove(c));
      if (updates.variant) bar.classList.add(updates.variant);
    }
    commitDom(context.doc);
    syncSelectedElement(context.el, context.doc, context.screenId);
  }, [commitDom, getSelectedDomContext, syncSelectedElement]);

  /* ── Badge：文本/变体/pill ─────────────────────────────────────── */
  const updateBadge = useCallback((updates: { text?: string; variant?: string; pill?: boolean }) => {
    const context = getSelectedDomContext();
    if (!context) return;
    const badgeCtx = resolveBadgeContext(context.el);
    if (!badgeCtx) return;
    const { badge } = badgeCtx;

    if (updates.text !== undefined) {
      badge.textContent = updates.text;
    }
    if (updates.variant !== undefined) {
      // 移除旧 bg-*/text-* 变体
      ['bg-primary', 'bg-secondary', 'bg-success', 'bg-danger', 'bg-warning', 'bg-info', 'bg-light', 'bg-dark',
       'text-primary', 'text-secondary', 'text-success', 'text-danger', 'text-warning', 'text-info', 'text-light', 'text-dark'].forEach(c => badge.classList.remove(c));
      if (updates.variant) badge.classList.add(updates.variant);
    }
    if (updates.pill !== undefined) {
      badge.classList.toggle('rounded-pill', updates.pill);
    }
    commitDom(context.doc);
    syncSelectedElement(badge, context.doc, context.screenId);
  }, [commitDom, getSelectedDomContext, syncSelectedElement]);

  /* ── Dialog：标题/尺寸变体 ────────────────────────────────────── */
  const updateDialog = useCallback((updates: { title?: string; sizeClass?: string }) => {
    const context = getSelectedDomContext();
    if (!context) return;
    const dlgCtx = resolveDialogContext(context.el);
    if (!dlgCtx) return;

    if (updates.title !== undefined) {
      let titleEl = dlgCtx.modal.querySelector('.modal-title') as HTMLElement | null;
      if (!titleEl) {
        // 在 dialog 头部创建
        const header = dlgCtx.modal.querySelector('.modal-header') as HTMLElement | null
          || (() => {
            const h = context.doc.createElement('div');
            h.className = 'modal-header';
            dlgCtx.dialog.insertBefore(h, dlgCtx.dialog.firstChild);
            return h;
          })();
        titleEl = context.doc.createElement('h5');
        titleEl.className = 'modal-title';
        header.insertBefore(titleEl, header.firstChild);
      }
      titleEl.textContent = updates.title;
    }
    if (updates.sizeClass !== undefined) {
      // 移除旧的 modal-sm/modal-lg/modal-xl
      ['modal-sm', 'modal-lg', 'modal-xl', 'modal-fullscreen'].forEach(c => dlgCtx.dialog.classList.remove(c));
      if (updates.sizeClass) dlgCtx.dialog.classList.add(updates.sizeClass);
    }
    commitDom(context.doc);
    syncSelectedElement(context.el, context.doc, context.screenId);
  }, [commitDom, getSelectedDomContext, syncSelectedElement]);

  /* ── Button：变体/尺寸/药丸/块级/禁用 ────────────────────────── */
  const BTN_VARIANT_RE = /^btn-(outline-)?(primary|secondary|success|danger|warning|info|light|dark|link)$/;
  const BTN_SIZE_RE = /^btn-(sm|lg)$/;

  const updateButton = useCallback((updates: { variant?: string; size?: string; pill?: boolean; block?: boolean; disabled?: boolean }) => {
    const context = getSelectedDomContext();
    if (!context) return;
    const btnCtx = resolveButtonContext(context.el);
    if (!btnCtx) return;
    const { button } = btnCtx;

    if (updates.variant !== undefined) {
      for (const cls of Array.from(button.classList)) {
        if (BTN_VARIANT_RE.test(cls)) button.classList.remove(cls);
      }
      if (updates.variant) button.classList.add(updates.variant);
    }
    if (updates.size !== undefined) {
      for (const cls of Array.from(button.classList)) {
        if (BTN_SIZE_RE.test(cls)) button.classList.remove(cls);
      }
      if (updates.size) button.classList.add(updates.size);
    }
    if (updates.pill !== undefined) {
      button.classList.toggle('rounded-pill', updates.pill);
    }
    if (updates.block !== undefined) {
      button.classList.toggle('w-100', updates.block);
    }
    if (updates.disabled !== undefined) {
      button.classList.toggle('disabled', updates.disabled);
      if (updates.disabled) button.setAttribute('disabled', '');
      else button.removeAttribute('disabled');
    }
    commitDom(context.doc);
    syncSelectedElement(button, context.doc, context.screenId);
  }, [commitDom, getSelectedDomContext, syncSelectedElement]);

  return {
    handleBringForward,
    handleSendBackward,
    handleDuplicateElement,
    handleDragStart,
    handleResizeStart,
    updateSelectionFromIframe,
    applyStyleChange,
    resetDragState,
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
  };
}
