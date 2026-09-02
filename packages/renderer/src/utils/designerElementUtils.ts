import type { SelectedElement, ElementStyle } from '@xai/shared';
import { resolveTableContext } from './designerStructuredEditors';

/**
 * Generate a unique CSS selector for an element inside the iframe document.
 * Prefers data-design-id for stable, semantic targeting.
 */
export function generateSelector(el: HTMLElement): string {
  const doc = el.ownerDocument;
  // Verifies a candidate selector matches exactly one element in the document.
  // Without this guard, duplicate id / data-design-id values — common in
  // AI-generated repeated components like stats cards — yield a non-unique
  // selector. The deferred re-query in updateSelectionFromIframe /
  // updateRectOnly (2s interval, scroll, resize) then resolves
  // `querySelector(selector)` to the FIRST match, i.e. a different element,
  // and overwrites the selection's rect/style — making the selection box
  // "jump" to another element after the user clicks.
  const isUnique = (sel: string): boolean => !!doc && doc.querySelectorAll(sel).length === 1;

  // Short-circuit on a unique id.
  if (el.id) {
    const idSel = `#${CSS.escape(el.id)}`;
    if (isUnique(idSel)) return idSel;
  }

  // Prefer a unique data-design-id — it's stable across re-generations.
  const designId = el.getAttribute('data-design-id');
  if (designId) {
    const dIdSel = `[data-design-id="${CSS.escape(designId)}"]`;
    if (isUnique(dIdSel)) return dIdSel;
  }

  // Full hierarchical path. Unique by construction: at each level we either
  // anchor on a unique id/data-design-id, or pin the element with
  // tag:nth-of-type(n) among same-tag siblings.
  const parts: string[] = [];
  let current: HTMLElement | null = el;
  while (current && current.tagName !== 'HTML') {
    if (current.id) {
      const idSel = `#${CSS.escape(current.id)}`;
      if (isUnique(idSel)) {
        parts.unshift(idSel);
        break;
      }
    }
    const curDesignId = current.getAttribute('data-design-id');
    if (curDesignId) {
      const dIdSel = `[data-design-id="${CSS.escape(curDesignId)}"]`;
      if (isUnique(dIdSel)) {
        parts.unshift(dIdSel);
        break;
      }
    }
    let selector = current.tagName.toLowerCase();
    if (current.className && typeof current.className === 'string') {
      const classes = current.className.split(/\s+/).filter((c: string) => c && !c.startsWith('designer-')).slice(0, 2);
      if (classes.length > 0) selector += `.${classes.map(c => CSS.escape(c)).join('.')}`;
    }
    const parent: HTMLElement | null = current.parentElement;
    if (parent) {
      const siblings = Array.from(parent.children).filter((c: Element) => c.tagName === current!.tagName);
      if (siblings.length > 1) {
        const index = siblings.indexOf(current);
        selector += `:nth-of-type(${index + 1})`;
      }
    }
    parts.unshift(selector);
    current = parent;
  }
  return parts.join(' > ');
}

/**
 * Read the "editable" text of an element without the noise that
 * `el.textContent` introduces.
 *
 * `textContent` concatenates every descendant text node, including the
 * whitespace/newlines between tags — so for an element like
 *   <a class="sidebar-item"><svg>…</svg><span class="sidebar-label">运营规划管理</span></a>
 * it returns "\n          \n          运营规划管理\n        ", which is what
 * filled the properties panel with "lots of spaces / invisible characters".
 *
 * This helper instead walks down to the actual text-bearing container:
 *   1. No element children → trimmed direct text.
 *   2. Direct non-whitespace text nodes (e.g. <button><svg/>新建付款单</button>)
 *      → those text nodes joined.
 *   3. Exactly one text-bearing element child (e.g. the <span> next to an
 *      <svg>) → recurse into it.
 *   4. Multiple text-bearing element children → return ''. Combined descendant
 *      text would be misleading (can't be safely written back to a single
 *      child without destroying siblings). User should select a more specific
 *      element to edit precisely.
 */
export function getEditableText(el: HTMLElement): string {
  const hasElementChildren = Array.from(el.childNodes).some(n => n.nodeType === Node.ELEMENT_NODE);
  if (!hasElementChildren) {
    return (el.textContent || '').trim();
  }

  // Direct non-whitespace text nodes (icon + inline text pattern).
  const directTextNodes = Array.from(el.childNodes).filter(
    n => n.nodeType === Node.TEXT_NODE && (n.textContent || '').trim() !== '',
  );
  if (directTextNodes.length > 0) {
    return directTextNodes.map(n => (n.textContent || '').trim()).join(' ');
  }

  // Single text-bearing element child (icon + label span pattern).
  const textBearingChildren = Array.from(el.children).filter(
    c => (c.textContent || '').trim() !== '',
  );
  if (textBearingChildren.length === 1) {
    return getEditableText(textBearingChildren[0] as HTMLElement);
  }

  // Multiple text-bearing children (or zero): return '' so the textarea
  // never shows misleading combined descendant text that can't be safely
  // written back. See setEditableText for the matching write behavior.
  return '';
}

/**
 * Whether the element's text is "ambiguous" — i.e. it has multiple
 * text-bearing element children and no direct text nodes. In this case
 * `getEditableText` returns '' and `setEditableText` won't recurse into
 * any child (would destroy layout). Used by the properties panel to show
 * a "select a more specific element" hint.
 */
export function isTextAmbiguous(el: HTMLElement): boolean {
  const hasElementChildren = Array.from(el.childNodes).some(n => n.nodeType === Node.ELEMENT_NODE);
  if (!hasElementChildren) return false;
  const directTextNodes = Array.from(el.childNodes).filter(
    n => n.nodeType === Node.TEXT_NODE && (n.textContent || '').trim() !== '',
  );
  if (directTextNodes.length > 0) return false;
  const textBearingChildren = Array.from(el.children).filter(
    c => (c.textContent || '').trim() !== '',
  );
  return textBearingChildren.length >= 2;
}

/**
 * Write text to an element WITHOUT destroying its element children.
 *
 * Naively doing `el.textContent = val` replaces every child node (including
 * <svg> icons and class-bearing <span> labels) with a single text node —
 * which is exactly why editing text in the properties panel wiped out icons
 * and styling. This helper mirrors `getEditableText` to find the real text
 * container and update only that, leaving sibling elements intact.
 */
export function setEditableText(el: HTMLElement, val: string): void {
  const hasElementChildren = Array.from(el.childNodes).some(n => n.nodeType === Node.ELEMENT_NODE);
  // No element children → textContent is safe (nothing to destroy).
  if (!hasElementChildren) {
    el.textContent = val;
    return;
  }

  // icon + inline text: update only the direct text nodes, keep the icon.
  const directTextNodes = Array.from(el.childNodes).filter(
    n => n.nodeType === Node.TEXT_NODE && (n.textContent || '').trim() !== '',
  );
  if (directTextNodes.length > 0) {
    directTextNodes.forEach((node, i) => {
      node.textContent = i === 0 ? val : '';
    });
    return;
  }

  // icon + label span: recurse into the single text-bearing child.
  const textBearingChildren = Array.from(el.children).filter(
    c => (c.textContent || '').trim() !== '',
  );
  if (textBearingChildren.length === 1) {
    setEditableText(textBearingChildren[0] as HTMLElement, val);
    return;
  }

  // Multiple text-bearing children (or none): ambiguous. Don't recurse —
  // writing the full edited text into the first child would duplicate text
  // and destroy layout (the previous read returned '' for this case, so the
  // user can't have produced a meaningful combined edit here). Instead,
  // append the new text as a direct text node at the end so the user's
  // input is preserved without clobbering existing structure. If val is
  // empty, do nothing.
  if (val) {
    el.appendChild(el.ownerDocument.createTextNode(val));
  }
}

/** Extract editable style info from an element. */
export function extractElementStyle(el: HTMLElement, doc: Document): ElementStyle {
  const cs = doc.defaultView?.getComputedStyle(el);
  const transform = el.style.transform || cs?.transform || '';
  const rotationMatch = transform.match(/rotate\(([-\d.]+)deg\)/);
  const inputEl = el as HTMLInputElement;
  const textAreaEl = el as HTMLTextAreaElement;
  const imageEl = el as HTMLImageElement;

  // Resolve backgroundColor: inline gradient via `background` shorthand takes priority.
  // When a gradient is applied, applyStyleChange writes it to `el.style.background`
  // and clears `el.style.backgroundColor`. We must check `el.style.background` first
  // (and also `backgroundImage` as fallback for browsers that don't serialize the
  // shorthand), before falling back to computed style — Bootstrap classes (e.g.
  // .btn-primary) set a non-transparent backgroundColor that would mask the gradient.
  let backgroundColor = '';
  const inlineBg = el.style.background || '';
  const inlineBgImage = el.style.backgroundImage || '';
  if (/gradient\s*\(/i.test(inlineBg)) {
    backgroundColor = inlineBg;
  } else if (/gradient\s*\(/i.test(inlineBgImage)) {
    backgroundColor = inlineBgImage;
  } else {
    backgroundColor = el.style.backgroundColor || cs?.backgroundColor || '';
    const isTransparent = backgroundColor === 'rgba(0, 0, 0, 0)' || backgroundColor === 'transparent' || backgroundColor === '';
    if (isTransparent) {
      const bgImage = cs?.backgroundImage || '';
      if (bgImage.includes('gradient')) {
        backgroundColor = cs?.background || bgImage;
      }
    }
  }

  // backgroundImage: prefer inline style; strip url() wrapper for easier editing
  let bgImageVal = el.style.backgroundImage || '';
  if (!bgImageVal && cs?.backgroundImage && cs.backgroundImage !== 'none') {
    bgImageVal = cs.backgroundImage;
  }
  // Normalize: extract url('...') content so user edits just the URL
  const urlMatch = bgImageVal.match(/url\((['"]?)([^'")]+)\1\)/);
  const backgroundImage = urlMatch ? urlMatch[2] : (bgImageVal === 'none' ? '' : bgImageVal);

  return {
    width: el.style.width || cs?.width || '',
    height: el.style.height || cs?.height || '',
    backgroundColor,
    backgroundImage,
    color: el.style.color || cs?.color || '',
    fontSize: el.style.fontSize || cs?.fontSize || '',
    padding: el.style.padding || cs?.padding || '',
    margin: el.style.margin || cs?.margin || '',
    borderRadius: el.style.borderRadius || cs?.borderRadius || '',
    border: el.style.border || cs?.border || '',
    text: getEditableText(el).slice(0, 500),
    hasMultipleTextChildren: isTextAmbiguous(el),
    placeholder: el.getAttribute('placeholder') || '',
    value: String(inputEl.value ?? textAreaEl.value ?? el.getAttribute('value') ?? '').slice(0, 500),
    href: el.getAttribute('href') || '',
    src: imageEl.getAttribute('src') || '',
    textAlign: el.style.textAlign || cs?.textAlign || '',
    left: el.style.left || cs?.left || '',
    top: el.style.top || cs?.top || '',
    rotation: rotationMatch ? rotationMatch[1] : '',
    zIndex: el.style.zIndex || cs?.zIndex || '',
    opacity: el.style.opacity || cs?.opacity || '',
    boxShadow: el.style.boxShadow || cs?.boxShadow || '',
    filter: el.style.filter || cs?.filter || '',
    backdropFilter: el.style.backdropFilter || (el.style as any).webkitBackdropFilter || cs?.backdropFilter || (cs as any)?.webkitBackdropFilter || '',
    linkType: el.getAttribute('data-nav-type') || '',
    linkTarget: el.getAttribute('data-nav-target') || '',
    // Table scroll: read from the table's wrapper, not the cell itself.
    // Only read inline styles (not computed) to avoid picking up CSS-class-based
    // overflow (e.g. Bootstrap's .table-responsive) which cannot be toggled off
    // by clearing inline styles alone.
    ...(() => {
      const tableCtx = resolveTableContext(el);
      if (tableCtx?.wrapper) {
        return {
          overflowX: tableCtx.wrapper.style.overflowX || '',
          overflowY: tableCtx.wrapper.style.overflowY || '',
          tableMaxHeight: tableCtx.wrapper.style.maxHeight || '',
        };
      }
      return { overflowX: '', overflowY: '', tableMaxHeight: '' };
    })(),
    // 排版四件套：优先内联样式，回退计算样式
    fontFamily: el.style.fontFamily || cs?.fontFamily || '',
    fontWeight: el.style.fontWeight || cs?.fontWeight || '',
    lineHeight: el.style.lineHeight || cs?.lineHeight || '',
    letterSpacing: el.style.letterSpacing || cs?.letterSpacing || '',
    textDecoration: el.style.textDecoration || cs?.textDecoration || '',
    textTransform: el.style.textTransform || cs?.textTransform || '',
    // 四向间距：优先内联，回退计算样式（拆分 shorthand）
    paddingTop: el.style.paddingTop || cs?.paddingTop || '',
    paddingRight: el.style.paddingRight || cs?.paddingRight || '',
    paddingBottom: el.style.paddingBottom || cs?.paddingBottom || '',
    paddingLeft: el.style.paddingLeft || cs?.paddingLeft || '',
    marginTop: el.style.marginTop || cs?.marginTop || '',
    marginRight: el.style.marginRight || cs?.marginRight || '',
    marginBottom: el.style.marginBottom || cs?.marginBottom || '',
    marginLeft: el.style.marginLeft || cs?.marginLeft || '',
    // Flex 布局
    display: el.style.display || cs?.display || '',
    flexDirection: el.style.flexDirection || cs?.flexDirection || '',
    justifyContent: el.style.justifyContent || cs?.justifyContent || '',
    alignItems: el.style.alignItems || cs?.alignItems || '',
    flexWrap: el.style.flexWrap || cs?.flexWrap || '',
    gap: el.style.gap || cs?.gap || '',
    // Navbar 排列方向 (data-navbar-orientation)
    navbarOrientation: el.getAttribute('data-navbar-orientation') || '',
    // nav-link 菜单项图标：查找子元素 <i class="bi bi-*"> 的图标名
    // 排除 xai-dropdown-chevron（下拉菜单右侧的小三角指示器，不是内容图标）
    navLinkIcon: (() => {
      const iconEl = el.querySelector('i.bi:not(.xai-dropdown-chevron), i[class*="bi-"]:not(.xai-dropdown-chevron)') as HTMLElement | null;
      if (!iconEl) return '';
      const m = iconEl.className.match(/\bbi\s+bi-([\w-]+)/);
      return m ? m[1] : '';
    })(),
    // <i> 元素完整 className（供 IconEditor 回写）
    iconClass: el.tagName === 'I' ? el.className : '',
    // dropdown 展开状态 (data-dropdown-open)
    dropdownOpen: el.getAttribute('data-dropdown-open') || '',
    // dropdown 子菜单项标记 (data-dropdown-item)
    dropdownItem: el.getAttribute('data-dropdown-item') || '',
    // 侧边导航栏折叠状态 (data-navbar-collapsed)
    navbarCollapsed: el.getAttribute('data-navbar-collapsed') || '',
    // Raw inline style
    cssText: el.style.cssText || '',
    backdropRootWarning: findBackdropRootAncestor(el),
  };
}

/** Build a SelectedElement from a DOM element inside the iframe. */
export function buildSelectedElement(el: HTMLElement, doc: Document, screenId: string): SelectedElement {
  const rect = el.getBoundingClientRect();
  return {
    selector: generateSelector(el),
    tagName: el.tagName.toLowerCase(),
    id: el.id,
    className: typeof el.className === 'string' ? el.className : '',
    text: getEditableText(el).slice(0, 100),
    style: extractElementStyle(el, doc),
    rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
    // screenId is stored externally via the callback
  } as SelectedElement & { screenId: string };
}

/**
 * Describe an element for warning messages: `<tag.class>` (first class only).
 * Uses getAttribute('class') to be safe for SVG elements.
 */
function describeElement(el: Element): string {
  const tag = el.tagName.toLowerCase();
  const cls = el.getAttribute('class');
  if (cls) {
    const firstClass = cls.split(/\s+/)[0];
    if (firstClass) return `<${tag}.${firstClass}>`;
  }
  return `<${tag}>`;
}

/**
 * Detect whether an element has a backdrop-root ancestor that would block
 * `backdrop-filter` from sampling the page background.
 *
 * Per the CSS Filter Effects spec, `backdrop-filter` only samples pixels up
 * to the nearest "backdrop root" ancestor. Elements with transform, filter,
 * opacity<1, clip-path, will-change, etc. become backdrop roots, which can
 * make `backdrop-filter` on descendants appear to "not work" — the blur has
 * nothing behind the element to sample (only the ancestor's own background,
 * which is often transparent).
 *
 * Additionally, Chromium treats elements with `animation-fill-mode: forwards`
 * as remaining in "animation state" even after the animation ends, which can
 * also establish a backdrop root even if the final transform computes to
 * `none`. This is a heuristic check that covers the common `fade-up`-style
 * entrance animations AI-generated pages tend to use.
 *
 * Returns a human-readable reason string (empty if no blocking ancestor).
 */
export function findBackdropRootAncestor(el: Element): string {
  const win = el.ownerDocument.defaultView;
  if (!win) return '';

  let node = el.parentElement;
  while (node && node.tagName !== 'HTML') {
    const cs = win.getComputedStyle(node);
    const desc = describeElement(node);

    // Standard backdrop-root triggers (CSS Filter Effects spec)
    if (cs.transform && cs.transform !== 'none') {
      return `祖先 ${desc} 有 transform`;
    }
    if (cs.filter && cs.filter !== 'none') {
      return `祖先 ${desc} 有 filter`;
    }
    if (cs.backdropFilter && cs.backdropFilter !== 'none') {
      return `祖先 ${desc} 有 backdrop-filter`;
    }
    const opacity = parseFloat(cs.opacity);
    if (!isNaN(opacity) && opacity < 1) {
      return `祖先 ${desc} opacity=${cs.opacity}`;
    }
    if (cs.clipPath && cs.clipPath !== 'none') {
      return `祖先 ${desc} 有 clip-path`;
    }

    // will-change with backdrop-root-triggering properties
    if (cs.willChange && cs.willChange !== 'auto') {
      const willChangeProps = cs.willChange.split(',').map(s => s.trim());
      const backdropProps = ['transform', 'filter', 'opacity', 'backdrop-filter', 'clip-path', 'mask'];
      if (willChangeProps.some(p => backdropProps.includes(p))) {
        return `祖先 ${desc} will-change: ${cs.willChange}`;
      }
    }

    // Heuristic: animation with forwards/both fill mode.
    // Chromium keeps elements in "animation state" after forwards fill,
    // which may establish a backdrop root even if the final transform is 'none'.
    if (cs.animationName && cs.animationName !== 'none') {
      const fillMode = cs.animationFillMode;
      if (fillMode === 'forwards' || fillMode === 'both') {
        return `祖先 ${desc} 有动画(animation-fill-mode: ${fillMode})`;
      }
    }

    node = node.parentElement;
  }
  return '';
}
