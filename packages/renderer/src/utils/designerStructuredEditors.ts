export interface DesignerSelectOption {
  label: string;
  value: string;
  selected: boolean;
}

export interface DesignerTableContext {
  table: HTMLTableElement;
  columnIndex: number;
  columnWidth: string;
  /** The closest wrapper div that can hold overflow styles. */
  wrapper: HTMLElement | null;
  /** Whether the leftmost column is currently frozen (sticky). */
  stickyLeft: boolean;
  /** Whether the rightmost column is currently frozen (sticky). */
  stickyRight: boolean;
  /** Whether the table currently has the `table-striped` class. */
  striped: boolean;
}

/* ── Sticky column support ────────────────────────────────────────
 * Sticky column state lives on the <table> itself (via dedicated
 * marker classes) so it survives DOM re-serialization and is
 * independent of the React tree. Cell-level classes are reapplied
 * by reapplyStickyColumnClasses() whenever rows/cells change.
 * ───────────────────────────────────────────────────────────────── */
export const STICKY_LEFT_CELL_CLASS = 'xai-sticky-col-left';
export const STICKY_RIGHT_CELL_CLASS = 'xai-sticky-col-right';
export const STICKY_LEFT_TABLE_CLASS = '__xai_sticky_left__';
export const STICKY_RIGHT_TABLE_CLASS = '__xai_sticky_right__';

/**
 * Return all <tr> rows that belong DIRECTLY to `table` (i.e. its
 * thead/tbody/tfoot children), excluding rows of any nested tables.
 *
 * `HTMLTableElement.rows` and `table.querySelectorAll('tr')` both
 * descend into nested tables, which would cause add/remove/copy
 * column operations to corrupt inner tables — see BUG #14.
 */
export function getTableRows(table: HTMLTableElement): HTMLTableRowElement[] {
  return Array.from(table.rows).filter(row => row.closest('table') === table);
}

/**
 * Reapply sticky-cell classes to the first/last cell of every row
 * based on the table-level marker classes. Should be called after
 * any structural change (add/remove/copy column) so the sticky
 * column stays aligned with the new first/last cell.
 *
 * Header cells (th) and body cells (td) are both tagged so the
 * sticky background covers the entire column.
 */
export function reapplyStickyColumnClasses(table: HTMLTableElement): void {
  const wantLeft = table.classList.contains(STICKY_LEFT_TABLE_CLASS);
  const wantRight = table.classList.contains(STICKY_RIGHT_TABLE_CLASS);
  const rows = getTableRows(table);
  rows.forEach(row => {
    const cells = Array.from(row.cells) as HTMLTableCellElement[];
    if (cells.length === 0) return;
    // Left sticky: first cell
    cells.forEach((cell, i) => {
      if (i === 0 && wantLeft) cell.classList.add(STICKY_LEFT_CELL_CLASS);
      else cell.classList.remove(STICKY_LEFT_CELL_CLASS);
    });
    // Right sticky: last cell
    cells.forEach((cell, i) => {
      if (i === cells.length - 1 && wantRight) cell.classList.add(STICKY_RIGHT_CELL_CLASS);
      else cell.classList.remove(STICKY_RIGHT_CELL_CLASS);
    });
  });
}

export interface DesignerTabItem {
  id: string;
  label: string;
  active: boolean;
}

export interface DesignerTabsContext {
  tabList: HTMLElement;
  triggers: HTMLElement[];
  contentContainer: HTMLElement | null;
  selectedIndex: number;
  items: DesignerTabItem[];
}

function getTabTriggerTargetId(trigger: HTMLElement): string {
  const dataTarget = trigger.getAttribute('data-bs-target') || trigger.getAttribute('data-target') || '';
  if (dataTarget.startsWith('#')) return dataTarget.slice(1);
  const href = trigger.getAttribute('href') || '';
  if (href.startsWith('#')) return href.slice(1);
  const controls = trigger.getAttribute('aria-controls') || '';
  return controls;
}

function getTabTriggerLabel(trigger: HTMLElement): string {
  return (trigger.textContent || '').trim() || `标签 ${trigger.getAttribute('id') || ''}`.trim();
}

function isTabTrigger(el: Element): el is HTMLElement {
  return el instanceof HTMLElement && (
    el.matches('[data-bs-toggle="tab"]') ||
    el.getAttribute('role') === 'tab' ||
    el.matches('.nav-link')
  );
}

export function getSelectElement(el: HTMLElement | null): HTMLSelectElement | null {
  if (!el) return null;
  if (el.tagName === 'SELECT') return el as HTMLSelectElement;
  return el.closest('select');
}

export function readSelectOptions(el: HTMLElement | null): DesignerSelectOption[] {
  const select = getSelectElement(el);
  if (!select) return [];
  return Array.from(select.options).map(option => ({
    label: option.text,
    value: option.value,
    selected: option.selected,
  }));
}

export function resolveTableContext(el: HTMLElement | null): DesignerTableContext | null {
  if (!el) return null;
  const table = el.closest('table') as HTMLTableElement | null;
  if (!table) return null;

  const currentCell = (el.closest('th, td') as HTMLTableCellElement | null);
  // BUG #13 fix: only count th/td cells, not arbitrary children (e.g. whitespace
  // text nodes, <colgroup>, etc.) — indexOf over `children` includes non-cell
  // elements which would yield wrong column indices.
  const columnIndex = currentCell
    ? Array.from(currentCell.parentElement?.querySelectorAll(':scope > th, :scope > td') || []).indexOf(currentCell)
    : 0;

  const probeCell = currentCell
    || table.querySelector(`thead tr > *:nth-child(${columnIndex + 1}), tbody tr > *:nth-child(${columnIndex + 1})`) as HTMLTableCellElement | null
    || table.querySelector('th, td');

  const columnWidth = probeCell
    ? (probeCell.style.width || probeCell.getAttribute('width') || '')
    : '';

  // BUG #7 fix: only recognize a dedicated table-scroll wrapper as the scroll
  // container. Previously any <div>/<section> parent was treated as a wrapper,
  // which could hijack layout containers (e.g. card bodies) and accidentally
  // apply overflow styles to them. A wrapper is identified by:
  //   1. explicit `data-design-id` starting with `table-scroll-wrapper`, OR
  //   2. the dedicated class `table-scroll-wrapper` / `__xai_table_scroll_wrapper__`.
  //   3. Bootstrap's `.table-responsive` (recognized so sticky columns can
  //      reuse the existing scroll container instead of creating a new one).
  // Any other parent → return null so applyStyleChange creates a fresh wrapper.
  let wrapper: HTMLElement | null = null;
  const parent = table.parentElement;
  if (parent && parent.tagName !== 'BODY' && parent.tagName !== 'HTML') {
    const designId = parent.getAttribute('data-design-id') || '';
    if (
      designId.startsWith('table-scroll-wrapper') ||
      parent.classList.contains('table-scroll-wrapper') ||
      parent.classList.contains('__xai_table_scroll_wrapper__') ||
      parent.classList.contains('table-responsive')
    ) {
      wrapper = parent;
    }
  }

  return {
    table,
    columnIndex: Math.max(columnIndex, 0),
    columnWidth,
    wrapper,
    stickyLeft: table.classList.contains(STICKY_LEFT_TABLE_CLASS),
    stickyRight: table.classList.contains(STICKY_RIGHT_TABLE_CLASS),
    striped: table.classList.contains('table-striped'),
  };
}

export function resolveTabsContext(el: HTMLElement | null): DesignerTabsContext | null {
  if (!el) return null;

  const selectedTrigger = (el.closest('[data-bs-toggle="tab"], [role="tab"], .nav-link') as HTMLElement | null);
  let tabList = selectedTrigger?.closest('[role="tablist"], .nav-tabs, .nav-pills') as HTMLElement | null;

  if (!tabList) {
    const pane = el.closest('.tab-pane') as HTMLElement | null;
    const contentContainer = pane?.closest('.tab-content') as HTMLElement | null;
    if (contentContainer) {
      const paneId = pane?.id || '';
      if (paneId) {
        const doc = el.ownerDocument;
        const trigger = doc.querySelector(
          `[data-bs-target="#${CSS.escape(paneId)}"], [href="#${CSS.escape(paneId)}"], [aria-controls="${CSS.escape(paneId)}"]`
        ) as HTMLElement | null;
        tabList = trigger?.closest('[role="tablist"], .nav-tabs, .nav-pills') as HTMLElement | null;
      }
    }
  }

  if (!tabList) return null;

  const triggers = Array.from(tabList.querySelectorAll('*')).filter(isTabTrigger);
  if (triggers.length === 0) return null;

  const contentContainer = (() => {
    const fromSelected = triggers
      .map(trigger => {
        const targetId = getTabTriggerTargetId(trigger);
        return targetId ? el.ownerDocument.getElementById(targetId)?.closest('.tab-content') as HTMLElement | null : null;
      })
      .find(Boolean);
    return fromSelected || null;
  })();

  const selectedIndexFromTrigger = selectedTrigger ? triggers.indexOf(selectedTrigger) : -1;
  const activeIndex = selectedIndexFromTrigger >= 0
    ? selectedIndexFromTrigger
    : triggers.findIndex(trigger => trigger.classList.contains('active') || trigger.getAttribute('aria-selected') === 'true');

  return {
    tabList,
    triggers,
    contentContainer,
    selectedIndex: activeIndex >= 0 ? activeIndex : 0,
    items: triggers.map((trigger, index) => ({
      id: getTabTriggerTargetId(trigger) || trigger.id || `tab-${index + 1}`,
      label: getTabTriggerLabel(trigger),
      active: index === (activeIndex >= 0 ? activeIndex : 0),
    })),
  };
}

/* ============================================================
 * Accordion (折叠面板) context
 * ------------------------------------------------------------
 * Supports Bootstrap-style `.accordion` structure:
 *   .accordion
 *     .accordion-item
 *       .accordion-header > .accordion-button (trigger)
 *       .accordion-collapse > .accordion-body (content)
 * Also accepts generic `[data-accordion]` containers with
 * `[data-accordion-item]` children whose first child is the
 * trigger and the rest is the collapsible body.
 * ============================================================ */

export interface DesignerAccordionItem {
  id: string;
  header: string;
  active: boolean;
}

export interface DesignerAccordionContext {
  accordion: HTMLElement;
  items: HTMLElement[]; // each .accordion-item / [data-accordion-item]
  selectedIndex: number;
  itemData: DesignerAccordionItem[];
}

function isAccordionContainer(el: Element): el is HTMLElement {
  if (!(el instanceof HTMLElement)) return false;
  return el.classList.contains('accordion')
    || el.hasAttribute('data-accordion')
    || el.classList.contains('accordion-flush');
}

export function resolveAccordionContext(el: HTMLElement | null): DesignerAccordionContext | null {
  if (!el) return null;
  const accordion = (el.closest('.accordion, [data-accordion]') as HTMLElement | null);
  if (!accordion || !isAccordionContainer(accordion)) return null;

  const items = Array.from(accordion.querySelectorAll(':scope > .accordion-item, :scope > [data-accordion-item]')) as HTMLElement[];
  if (items.length === 0) return null;

  // Selected item: walk up from the click target to its containing item.
  const selectedItem = (el.closest('.accordion-item, [data-accordion-item]') as HTMLElement | null);
  const selectedIndex = selectedItem ? items.indexOf(selectedItem) : -1;

  const itemData: DesignerAccordionItem[] = items.map((item, index) => {
    const trigger = item.querySelector('.accordion-button, [data-accordion-trigger]') as HTMLElement | null;
    const header = trigger
      ? (trigger.textContent || '').trim()
      : (item.querySelector('.accordion-header, [data-accordion-header]') as HTMLElement | null)?.textContent?.trim()
      || `面板 ${index + 1}`;
    const active = !item.querySelector('.collapsed')
      && (!!item.querySelector('.accordion-collapse.show')
        || item.getAttribute('data-accordion-active') === 'true');
    const id = item.id || `accordion-item-${index + 1}`;
    return { id, header, active };
  });

  return {
    accordion,
    items,
    selectedIndex: selectedIndex >= 0 ? selectedIndex : 0,
    itemData,
  };
}

/* ============================================================
 * Carousel (轮播) context
 * ------------------------------------------------------------
 * Supports Bootstrap-style `.carousel` with `.carousel-item` slides
 * and `.carousel-indicators` / `.carousel-control-prev|next`.
 * ============================================================ */

export interface DesignerCarouselSlide {
  id: string;
  caption: string;
  active: boolean;
}

export interface DesignerCarouselContext {
  carousel: HTMLElement;
  slides: HTMLElement[];
  indicators: HTMLElement[];
  selectedIndex: number;
  slideData: DesignerCarouselSlide[];
  hasIndicators: boolean;
  hasControls: boolean;
}

export function resolveCarouselContext(el: HTMLElement | null): DesignerCarouselContext | null {
  if (!el) return null;
  const carousel = (el.closest('.carousel, [data-carousel]') as HTMLElement | null);
  if (!carousel) return null;

  const slides = Array.from(carousel.querySelectorAll('.carousel-item, [data-carousel-slide]')) as HTMLElement[];
  if (slides.length === 0) return null;

  const indicators = Array.from(carousel.querySelectorAll('.carousel-indicators li, .carousel-indicators button, [data-carousel-indicator]')) as HTMLElement[];

  // Determine active index from the active slide; fall back to the active
  // indicator; otherwise default to 0.
  let activeIndex = slides.findIndex(s => s.classList.contains('active'));
  if (activeIndex < 0) {
    activeIndex = indicators.findIndex(i => i.classList.contains('active') || i.getAttribute('aria-current') === 'true');
  }
  if (activeIndex < 0) activeIndex = 0;

  // Selected slide: walk up from the click target.
  const selectedSlide = (el.closest('.carousel-item, [data-carousel-slide]') as HTMLElement | null);
  const selectedIndex = selectedSlide ? slides.indexOf(selectedSlide) : activeIndex;

  const slideData: DesignerCarouselSlide[] = slides.map((slide, index) => {
    const captionEl = slide.querySelector('.carousel-caption, [data-carousel-caption]') as HTMLElement | null;
    const caption = captionEl ? (captionEl.textContent || '').trim() : `轮播 ${index + 1}`;
    return {
      id: slide.id || `carousel-slide-${index + 1}`,
      caption,
      active: index === activeIndex,
    };
  });

  const hasIndicators = indicators.length > 0;
  const hasControls = !!carousel.querySelector('.carousel-control-prev, .carousel-control-next, [data-carousel-control]');

  return {
    carousel,
    slides,
    indicators,
    selectedIndex,
    slideData,
    hasIndicators,
    hasControls,
  };
}

/* ============================================================
 * Progress (进度条) context
 * ------------------------------------------------------------
 * Supports Bootstrap `.progress > .progress-bar` and generic
 * `[data-progress] > [data-progress-bar]` structures. Also
 * supports `progress` element and `meter` element natively.
 * ============================================================ */

export interface DesignerProgressContext {
  container: HTMLElement;
  bar: HTMLElement;
  value: number;       // 0-100
  label: string;
  striped: boolean;
  animated: boolean;
  variant: string;     // e.g. "bg-success" — empty string if none
}

export function resolveProgressContext(el: HTMLElement | null): DesignerProgressContext | null {
  if (!el) return null;

  // Native <progress> element.
  if (el.tagName === 'PROGRESS' || el.closest('progress')) {
    const progress = (el.tagName === 'PROGRESS' ? el : el.closest('progress')) as HTMLProgressElement;
    const max = progress.max || 100;
    const value = Math.round(((progress.value || 0) / max) * 100);
    return {
      container: progress as HTMLElement,
      bar: progress as HTMLElement,
      value,
      label: progress.getAttribute('aria-label') || '',
      striped: false,
      animated: false,
      variant: '',
    };
  }

  // Native <meter> element.
  if (el.tagName === 'METER' || el.closest('meter')) {
    const meter = (el.tagName === 'METER' ? el : el.closest('meter')) as HTMLMeterElement;
    const min = meter.min || 0;
    const max = meter.max || 100;
    const value = Math.round(((meter.value || 0) - min) / (max - min) * 100);
    return {
      container: meter as HTMLElement,
      bar: meter as HTMLElement,
      value,
      label: '',
      striped: false,
      animated: false,
      variant: '',
    };
  }

  const container = (el.closest('.progress, [data-progress]') as HTMLElement | null);
  if (!container) return null;
  const bar = (container.querySelector('.progress-bar, [data-progress-bar]') as HTMLElement | null);
  if (!bar) return null;

  // Value: prefer inline `width: X%`, then `aria-valuenow`, then 0.
  let value = 0;
  const widthMatch = (bar.style.width || '').match(/^([\d.]+)%?$/);
  if (widthMatch) {
    value = Math.round(parseFloat(widthMatch[1]));
  } else {
    const ariaNow = bar.getAttribute('aria-valuenow');
    if (ariaNow) value = Math.round(parseFloat(ariaNow));
  }
  value = Math.max(0, Math.min(100, value));

  const label = (bar.textContent || '').trim();
  const striped = bar.classList.contains('progress-bar-striped');
  const animated = bar.classList.contains('progress-bar-animated');
  // Detect Bootstrap variant classes like bg-success / bg-info / bg-warning / bg-danger.
  const variantMatch = bar.className.match(/\bbg-(success|info|warning|danger|primary|secondary|light|dark)\b/);
  const variant = variantMatch ? variantMatch[0] : '';

  return { container, bar, value, label, striped, animated, variant };
}

/* ============================================================
 * Badge context
 * ------------------------------------------------------------
 * Supports Bootstrap `.badge` and generic `[data-badge]`.
 * ============================================================ */

export interface DesignerBadgeContext {
  badge: HTMLElement;
  text: string;
  variant: string;      // e.g. "bg-primary"
  pill: boolean;        // rounded-full style
}

export function resolveBadgeContext(el: HTMLElement | null): DesignerBadgeContext | null {
  if (!el) return null;
  const badge = (el.closest('.badge, [data-badge]') as HTMLElement | null);
  if (!badge) return null;

  const text = (badge.textContent || '').trim();
  const variantMatch = badge.className.match(/\b(bg|text)-(primary|secondary|success|danger|warning|info|light|dark)\b/);
  const variant = variantMatch ? variantMatch[0] : '';
  const pill = badge.classList.contains('rounded-pill');

  return { badge, text, variant, pill };
}

/* ============================================================
 * Button context
 * ------------------------------------------------------------
 * Supports Bootstrap `.btn` elements — detects variant (primary/secondary/
 * success/danger/warning/info/light/dark + outline-*), size (sm/lg),
 * and pill/full-width modifiers.
 * ============================================================ */

export interface DesignerButtonContext {
  button: HTMLElement;
  variant: string;     // e.g. "btn-primary", "btn-outline-danger", "" (no variant)
  size: string;        // "btn-sm" | "btn-lg" | ""
  pill: boolean;       // rounded-pill
  block: boolean;      // w-100 full-width
  disabled: boolean;
}

const BTN_SIZES = ['btn-sm', 'btn-lg'];

export function resolveButtonContext(el: HTMLElement | null): DesignerButtonContext | null {
  if (!el) return null;
  // 查找自身或祖先中的 button/.btn 元素
  let btn: HTMLElement | null = null;
  if (el.tagName === 'BUTTON' || el.classList.contains('btn')) {
    btn = el;
  } else {
    btn = el.closest('button, .btn') as HTMLElement | null;
  }
  if (!btn) return null;

  let variant = '';
  for (const cls of Array.from(btn.classList)) {
    if (/^btn-(outline-)?(primary|secondary|success|danger|warning|info|light|dark|link)$/.test(cls)) {
      variant = cls;
      break;
    }
  }

  let size = '';
  for (const s of BTN_SIZES) {
    if (btn.classList.contains(s)) { size = s; break; }
  }

  return {
    button: btn,
    variant,
    size,
    pill: btn.classList.contains('rounded-pill'),
    block: btn.classList.contains('w-100'),
    disabled: btn.hasAttribute('disabled') || btn.classList.contains('disabled'),
  };
}

/* ============================================================
 * Dialog (模态框) context
 * ------------------------------------------------------------
 * Supports Bootstrap `.modal` and generic `[data-dialog]`.
 * ============================================================ */

export interface DesignerDialogContext {
  modal: HTMLElement;
  dialog: HTMLElement;       // .modal-dialog
  title: string;
  body: HTMLElement | null;  // .modal-body
  footer: HTMLElement | null;// .modal-footer
}

export function resolveDialogContext(el: HTMLElement | null): DesignerDialogContext | null {
  if (!el) return null;
  const modal = (el.closest('.modal, [data-dialog]') as HTMLElement | null);
  if (!modal) return null;
  const dialog = (modal.querySelector('.modal-dialog, [data-dialog-dialog]') as HTMLElement | null) || modal;
  const titleEl = modal.querySelector('.modal-title, [data-dialog-title]') as HTMLElement | null;
  const body = (modal.querySelector('.modal-body, [data-dialog-body]') as HTMLElement | null);
  const footer = (modal.querySelector('.modal-footer, [data-dialog-footer]') as HTMLElement | null);

  return {
    modal,
    dialog,
    title: titleEl ? (titleEl.textContent || '').trim() : '',
    body,
    footer,
  };
}
