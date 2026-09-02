/**
 * useSelectedDomState — extracts structured DOM context for the currently
 * selected element (table/tabs/accordion/carousel/progress/badge/dialog/
 * button/select options). Centralizes the BUG #8 fix: when iframe srcDoc
 * reloads and querySelector transiently returns null, fall back to the last
 * valid state to prevent the structured editors from flashing empty.
 *
 * Extracted from DesignerCanvas to decouple DOM parsing from rendering and
 * to make the fallback logic testable in isolation.
 */
import { useMemo, useRef } from 'react';
import type { SelectedElement } from '@xai/shared';
import {
  readSelectOptions,
  resolveTableContext,
  resolveTabsContext,
  resolveAccordionContext,
  resolveCarouselContext,
  resolveProgressContext,
  resolveBadgeContext,
  resolveDialogContext,
  resolveButtonContext,
  type DesignerSelectOption,
  type DesignerTabItem,
} from '../utils/designerStructuredEditors';

export interface SelectedDomState {
  selectOptions: DesignerSelectOption[];
  tableColumnWidth: string;
  hasTableContext: boolean;
  /**
   * 选中元素是否为"菜单项"（侧栏/顶栏的 <a class="nav-link">、<li class="nav-item">、
   * submenu-link）。用于在属性面板显示"设为当前项"一键高亮按钮。
   * 排除 .nav-tabs 内的 tab link（由 Tabs 编辑器管理）、面包屑、分页、dropdown-item。
   */
  isMenuItem: boolean;
  /**
   * 该菜单项目标 <a> 当前是否已处于 active 高亮态。用于"设为当前项"按钮的 toggle
   * 文案（已高亮 → 显示"取消当前项"）。非菜单项时为 false。
   */
  menuItemIsActive: boolean;
  tableStickyLeft: boolean;
  tableStickyRight: boolean;
  tableStriped: boolean;
  tabItems: DesignerTabItem[];
  accordionItems: Array<{ id: string; header: string; active: boolean }>;
  carouselSlides: Array<{ id: string; caption: string; active: boolean }>;
  carouselHasIndicators: boolean;
  carouselHasControls: boolean;
  progressData: { value: number; label: string; striped: boolean; animated: boolean; variant: string } | null;
  badgeData: { text: string; variant: string; pill: boolean } | null;
  dialogData: { title: string; sizeClass: string } | null;
  buttonData: { variant: string; size: string; pill: boolean; block: boolean; disabled: boolean } | null;
}

export interface UseSelectedDomStateOptions {
  /** Currently selected element (or null). */
  selectedElement: SelectedElement | null;
  /** iframe refs keyed by screenId, used to access the live DOM. */
  iframeRefs: React.MutableRefObject<Map<string, HTMLIFrameElement>>;
  /** Currently active screen id (drives which iframe to query). */
  currentScreenId: string | null;
  /** iframeKey bump — invalidates cache when iframe reloads. */
  iframeKey: number;
  /** Whether the canvas is in select mode (only parse when true). */
  selectMode: boolean;
  /** Ref holding the last selected screen id (for async safety). */
  selectedScreenIdRef?: React.MutableRefObject<string | null>;
}

const EMPTY_STATE: SelectedDomState = {
  selectOptions: [],
  tableColumnWidth: '',
  hasTableContext: false,
  isMenuItem: false,
  menuItemIsActive: false,
  tableStickyLeft: false,
  tableStickyRight: false,
  tableStriped: false,
  tabItems: [],
  accordionItems: [],
  carouselSlides: [],
  carouselHasIndicators: false,
  carouselHasControls: false,
  progressData: null,
  badgeData: null,
  dialogData: null,
  buttonData: null,
};

/**
 * 判断选中元素是否为"菜单项"，并解析其当前 active 态。
 * 用于在属性面板显示"设为当前项"一键高亮按钮（toggle 文案依赖 active 态）。
 *
 * 命中：<a class="nav-link">（含 submenu-link，侧栏/顶栏菜单项）或 <li class="nav-item">。
 * 排除：
 *  - .nav-tabs 内的 tab link（由 Tabs 编辑器的 onSetActiveTab 管理，避免功能重叠）；
 *  - 面包屑 .breadcrumb / 分页 .pagination（功能性导航，非菜单）；
 *  - .dropdown-item（下拉菜单项，显隐由 dropdown JS 管理，不属于侧栏菜单语义）。
 *
 * active 解析：选中 <li class="nav-item"> 时下钻到其内部 <a>（与 setAsCurrentMenuItem
 * 的目标解析逻辑一致），再读 .active。
 */
interface MenuItemState {
  isMenuItem: boolean;
  isActive: boolean;
}
function resolveMenuItemState(el: HTMLElement): MenuItemState {
  const no: MenuItemState = { isMenuItem: false, isActive: false };
  if (el.closest('.nav-tabs, .breadcrumb, .pagination')) return no;
  if (el.classList.contains('dropdown-item')) return no;
  const isItem =
    (el.tagName === 'A' && el.classList.contains('nav-link')) ||
    (el.tagName === 'LI' && el.classList.contains('nav-item'));
  if (!isItem) return no;
  const target: HTMLElement =
    el.tagName === 'LI'
      ? (el.querySelector('a.nav-link, a.submenu-link, a') as HTMLElement | null) || el
      : el;
  return { isMenuItem: true, isActive: target.classList.contains('active') };
}

/**
 * Build a SelectedDomState for the selected element, with BUG #8 fallback:
 * returns the last valid state when the iframe DOM is transiently unavailable
 * (e.g. during srcDoc reload) so structured editors don't flash empty.
 */
export function useSelectedDomState({
  selectedElement,
  iframeRefs,
  currentScreenId,
  iframeKey,
  selectMode,
  selectedScreenIdRef,
}: UseSelectedDomStateOptions): SelectedDomState {
  // 缓存上一次成功解析的 DOM 状态。iframe 因 srcDoc 重载时 querySelector
  // 可能瞬时返回 null，用 ref 保留上次有效状态，在解析失败时回退，避免 UI 抖动。
  const lastDomStateRef = useRef<SelectedDomState>(EMPTY_STATE);

  return useMemo(() => {
    if (!selectedElement) {
      lastDomStateRef.current = EMPTY_STATE;
      return EMPTY_STATE;
    }
    const screenId = selectedScreenIdRef?.current || currentScreenId || '';
    const iframe = iframeRefs.current.get(screenId);
    const doc = iframe?.contentDocument;
    const el = doc?.querySelector(selectedElement.selector) as HTMLElement | null;
    if (!el) {
      // BUG #8: 解析失败时回退到上次有效状态，避免编辑器闪空
      return lastDomStateRef.current;
    }
    const tableContext = resolveTableContext(el);
    const tabsContext = resolveTabsContext(el);
    const accContext = resolveAccordionContext(el);
    const carContext = resolveCarouselContext(el);
    const progContext = resolveProgressContext(el);
    const badgeContext = resolveBadgeContext(el);
    const dlgContext = resolveDialogContext(el);
    const btnContext = resolveButtonContext(el);
    const menuItemState = resolveMenuItemState(el);
    // 推断 dialog 当前 sizeClass
    let dialogSizeClass = '';
    if (dlgContext) {
      const match = dlgContext.dialog.className.match(/\b(modal-sm|modal-lg|modal-xl|modal-fullscreen)\b/);
      dialogSizeClass = match ? match[0] : '';
    }
    const nextState: SelectedDomState = {
      selectOptions: readSelectOptions(el),
      tableColumnWidth: tableContext?.columnWidth || '',
      hasTableContext: !!tableContext,
      isMenuItem: menuItemState.isMenuItem,
      menuItemIsActive: menuItemState.isActive,
      tableStickyLeft: !!tableContext?.stickyLeft,
      tableStickyRight: !!tableContext?.stickyRight,
      tableStriped: !!tableContext?.striped,
      tabItems: tabsContext?.items || [],
      accordionItems: accContext?.itemData || [],
      carouselSlides: carContext?.slideData || [],
      carouselHasIndicators: carContext?.hasIndicators || false,
      carouselHasControls: carContext?.hasControls || false,
      progressData: progContext ? {
        value: progContext.value,
        label: progContext.label,
        striped: progContext.striped,
        animated: progContext.animated,
        variant: progContext.variant,
      } : null,
      badgeData: badgeContext ? {
        text: badgeContext.text,
        variant: badgeContext.variant,
        pill: badgeContext.pill,
      } : null,
      dialogData: dlgContext ? {
        title: dlgContext.title,
        sizeClass: dialogSizeClass,
      } : null,
      buttonData: btnContext ? {
        variant: btnContext.variant,
        size: btnContext.size,
        pill: btnContext.pill,
        block: btnContext.block,
        disabled: btnContext.disabled,
      } : null,
    };
    lastDomStateRef.current = nextState;
    return nextState;
  }, [currentScreenId, iframeKey, selectedElement, selectMode, iframeRefs, selectedScreenIdRef]);
}
