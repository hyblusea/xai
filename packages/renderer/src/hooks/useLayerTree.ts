import { useState, useCallback, useEffect, useRef } from 'react';
import { getTableRows, reapplyStickyColumnClasses } from '../utils/designerStructuredEditors';
import { generateSelector } from '../utils/designerElementUtils';
import {
  buildComponentHtml,
  type InsertComponentType,
  type InsertPosition,
} from '../utils/designerComponents';

export interface LayerNode {
  id: string;
  tagName: string;
  className: string;
  elementId: string;
  designId: string;
  text: string;
  selector: string;
  visible: boolean;
  locked: boolean;
  children: LayerNode[];
}

/** 历史兼容：从 designerComponents re-export，LayerTreePanel 等调用方无需改动 */
export type { InsertComponentType, InsertPosition };

interface UseLayerTreeOptions {
  getIframe: () => HTMLIFrameElement | null;
  onSelectElement: (selector: string) => void;
  selectedSelector: string | null;
  enabled: boolean;
  onHtmlChange?: (html: string) => void;
}

const IGNORED_TAGS = new Set(['SCRIPT', 'STYLE', 'HEAD', 'META', 'LINK', 'TITLE', 'NOSCRIPT']);

function generateLayerId(el: HTMLElement, depth: number, index: number): string {
  return `${depth}-${index}-${el.tagName.toLowerCase()}`;
}

function buildLayerNode(
  el: HTMLElement,
  doc: Document,
  depth: number,
  index: number,
  lockedSet: Set<string>,
): LayerNode | null {
  if (IGNORED_TAGS.has(el.tagName)) return null;

  const selector = generateSelector(el);
  const text = el.textContent?.slice(0, 40)?.trim() || '';

  const children: LayerNode[] = [];
  let childIndex = 0;
  for (const child of Array.from(el.children)) {
    const node = buildLayerNode(child as HTMLElement, doc, depth + 1, childIndex, lockedSet);
    if (node) {
      children.push(node);
      childIndex++;
    }
  }

  return {
    id: generateLayerId(el, depth, index),
    tagName: el.tagName.toLowerCase(),
    className: typeof el.className === 'string' ? el.className.split(/\s+/).filter(Boolean).slice(0, 2).join(' ') : '',
    elementId: el.id || '',
    designId: el.getAttribute('data-design-id') || '',
    text: children.length === 0 ? text : '',
    selector,
    visible: el.style.display !== 'none',
    locked: lockedSet.has(selector),
    children,
  };
}

/**
 * Hook to build and manage a layer tree from the designer iframe DOM.
 * Provides visibility toggle, lock toggle, and element selection.
 */
export function useLayerTree({ getIframe, onSelectElement, selectedSelector, enabled, onHtmlChange }: UseLayerTreeOptions) {
  const [layers, setLayers] = useState<LayerNode[]>([]);
  const [refreshKey, setRefreshKey] = useState(0);
  const lockedSetRef = useRef<Set<string>>(new Set());

  const refresh = useCallback(() => {
    setRefreshKey(k => k + 1);
  }, []);

  // Build the layer tree from the iframe DOM
  useEffect(() => {
    if (!enabled) {
      setLayers([]);
      return;
    }
    const iframe = getIframe();
    if (!iframe?.contentDocument) return;

    const doc = iframe.contentDocument;
    const body = doc.body;
    if (!body) return;

    const nodes: LayerNode[] = [];
    let index = 0;
    for (const child of Array.from(body.children)) {
      const node = buildLayerNode(child as HTMLElement, doc, 0, index, lockedSetRef.current);
      if (node) {
        nodes.push(node);
        index++;
      }
    }
    setLayers(nodes);
  }, [enabled, getIframe, refreshKey]);

  // Toggle visibility of an element
  const toggleVisibility = useCallback((selector: string) => {
    const iframe = getIframe();
    if (!iframe?.contentDocument) return;
    const el = iframe.contentDocument.querySelector(selector) as HTMLElement | null;
    if (!el) return;
    el.style.display = el.style.display === 'none' ? '' : 'none';
    refresh();
  }, [getIframe, refresh]);

  // Toggle lock state of an element
  const toggleLock = useCallback((selector: string) => {
    const set = lockedSetRef.current;
    if (set.has(selector)) {
      set.delete(selector);
    } else {
      set.add(selector);
    }
    refresh();
  }, [refresh]);

  // Handle layer click
  const handleLayerClick = useCallback((selector: string) => {
    onSelectElement(selector);
  }, [onSelectElement]);

  // Move element forward/backward in DOM
  const moveElement = useCallback((selector: string, direction: 'up' | 'down') => {
    const iframe = getIframe();
    if (!iframe?.contentDocument) return;
    const el = iframe.contentDocument.querySelector(selector) as HTMLElement | null;
    if (!el || !el.parentElement) return;
    if (direction === 'up') {
      const next = el.nextElementSibling;
      if (next) el.parentElement.insertBefore(next, el);
    } else {
      const prev = el.previousElementSibling;
      if (prev) el.parentElement.insertBefore(el, prev);
    }
    const newHtml = '<!DOCTYPE html>\n' + iframe.contentDocument.documentElement.outerHTML;
    onHtmlChange?.(newHtml);
    refresh();
  }, [getIframe, refresh, onHtmlChange]);

  const commitAndRefresh = useCallback(() => {
    const iframe = getIframe();
    if (!iframe?.contentDocument) return;
    const newHtml = '<!DOCTYPE html>\n' + iframe.contentDocument.documentElement.outerHTML;
    onHtmlChange?.(newHtml);
    refresh();
  }, [getIframe, refresh, onHtmlChange]);

  function reassignDesignIds(root: HTMLElement, doc: Document) {
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
    return root;
  }

  const duplicateElement = useCallback((selector: string, position: InsertPosition = 'after') => {
    const iframe = getIframe();
    if (!iframe?.contentDocument) return;
    const el = iframe.contentDocument.querySelector(selector) as HTMLElement | null;
    if (!el || !el.parentElement) return;

    const clone = el.cloneNode(true) as HTMLElement;
    reassignDesignIds(clone, iframe.contentDocument);

    if (position === 'before') {
      el.parentElement.insertBefore(clone, el);
    } else if (position === 'after') {
      el.parentElement.insertBefore(clone, el.nextSibling);
    } else if (position === 'inside') {
      el.appendChild(clone);
    }

    commitAndRefresh();
  }, [getIframe, commitAndRefresh]);

  const insertElement = useCallback((selector: string, componentType: InsertComponentType, position: InsertPosition) => {
    const iframe = getIframe();
    if (!iframe?.contentDocument) return;
    const el = iframe.contentDocument.querySelector(selector) as HTMLElement | null;
    if (!el) return;

    // 传入父容器，以便 buildComponentHtml 判断 flex 布局方向决定是否添加 mb-3
    const parentEl = position === 'inside' ? el : el.parentElement;
    const html = buildComponentHtml(componentType, position === 'inside' ? null : el, parentEl);
    const template = iframe.contentDocument.createElement('template');
    template.innerHTML = html.trim();
    const newEl = template.content.firstElementChild as HTMLElement;
    if (!newEl) return;

    if (position === 'before') {
      el.parentElement?.insertBefore(newEl, el);
    } else if (position === 'after') {
      el.parentElement?.insertBefore(newEl, el.nextSibling);
    } else if (position === 'inside') {
      // 模板组件（tpl-*）插入 body 时，清空旧内容再插入（替换整个页面）
      if (el.tagName === 'BODY' && componentType.startsWith('tpl-')) {
        el.innerHTML = '';
      }
      el.appendChild(newEl);
    }

    commitAndRefresh();
  }, [getIframe, commitAndRefresh]);

  const addTableRow = useCallback((selector: string) => {
    const iframe = getIframe();
    if (!iframe?.contentDocument) return;
    const el = iframe.contentDocument.querySelector(selector) as HTMLElement | null;
    if (!el) return;

    const table = el.closest('table') as HTMLTableElement | null;
    if (!table) return;

    const referenceRow = (el.closest('tr') as HTMLTableRowElement | null)
      || getTableRows(table)[0];
    const colCount = referenceRow?.cells.length || 3;
    const newRow = iframe.contentDocument.createElement('tr');
    newRow.setAttribute('data-design-id', `designer-added-row-${Date.now()}`);
    for (let i = 0; i < colCount; i++) {
      const td = iframe.contentDocument.createElement('td');
      td.className = (referenceRow?.cells[0] as HTMLElement | undefined)?.className || 'px-4 py-3 text-sm';
      td.textContent = i === 0 ? '新数据' : '-';
      newRow.appendChild(td);
    }

    // Append to tbody if exists, otherwise to table directly
    const tbody = table.querySelector('tbody');
    if (tbody) {
      tbody.appendChild(newRow);
    } else {
      table.appendChild(newRow);
    }

    commitAndRefresh();
  }, [getIframe, commitAndRefresh]);

  const addTableColumn = useCallback((selector: string) => {
    const iframe = getIframe();
    if (!iframe?.contentDocument) return;
    const el = iframe.contentDocument.querySelector(selector) as HTMLElement | null;
    if (!el) return;

    const table = el.closest('table') as HTMLTableElement | null;
    if (!table) return;

    let insertIndex = 0;
    if (el.tagName === 'TH' || el.tagName === 'TD') {
      const parentTr = el.parentElement;
      if (parentTr) {
        insertIndex = Array.from(parentTr.children).indexOf(el);
      }
    }

    // Use getTableRows to handle all table structures regardless of thead/tbody
    // while excluding rows from nested tables (BUG #14).
    const allRows = getTableRows(table);
    allRows.forEach((row, rowIndex) => {
      const refCell = row.cells[Math.min(insertIndex, row.cells.length - 1)] as HTMLElement | undefined;
      if (row.querySelector('th')) {
        const newTh = iframe.contentDocument!.createElement('th');
        newTh.setAttribute('data-design-id', `designer-added-th-${Date.now()}-${rowIndex}`);
        newTh.className = refCell?.className || 'px-4 py-3 text-left text-xs font-medium text-on-surface-variant uppercase tracking-wider';
        newTh.textContent = '新列';
        if (insertIndex < row.cells.length) {
          row.insertBefore(newTh, row.cells[insertIndex]);
        } else {
          row.appendChild(newTh);
        }
      } else {
        const newTd = iframe.contentDocument!.createElement('td');
        newTd.setAttribute('data-design-id', `designer-added-td-${Date.now()}-${rowIndex}`);
        newTd.className = refCell?.className || 'px-4 py-3 text-sm';
        newTd.textContent = '-';
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

    commitAndRefresh();
  }, [getIframe, commitAndRefresh]);

  return {
    layers,
    refresh,
    toggleVisibility,
    toggleLock,
    handleLayerClick,
    moveElement,
    insertElement,
    duplicateElement,
    addTableRow,
    addTableColumn,
    selectedSelector,
    lockedSetRef,
  };
}
