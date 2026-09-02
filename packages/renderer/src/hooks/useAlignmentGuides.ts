import { useState, useCallback, useRef } from 'react';

export interface AlignmentGuide {
  id: string;
  type: 'vertical' | 'horizontal';
  position: number;
}

export interface SnapInfo {
  snapDx: number;
  snapDy: number;
  guides: AlignmentGuide[];
}

/** Selectors of elements worth aligning to. */
const ALIGNABLE_SELECTOR =
  'div, section, header, footer, nav, main, article, aside, img, p, h1, h2, h3, h4, h5, h6, ul, ol, li, button, input, textarea, select, form, figure, blockquote';

const DEFAULT_THRESHOLD = 5;

/**
 * Alignment guides & snap-to logic for the designer canvas.
 *
 * Call `calculateSnap` during element drag to get snap offsets and the
 * guides to display. Call `clearGuides` when the drag ends.
 */
export function useAlignmentGuides() {
  const [guides, setGuides] = useState<AlignmentGuide[]>([]);
  const guidesRef = useRef<AlignmentGuide[]>([]);

  const clearGuides = useCallback(() => {
    if (guidesRef.current.length > 0) {
      guidesRef.current = [];
      setGuides([]);
    }
  }, []);

  /**
   * Calculate snap alignment for a dragged element against its siblings
   * and the iframe viewport edges.
   *
   * @param iframe The iframe containing the element
   * @param currentEl The element being dragged (already at its new position)
   * @param threshold Snap distance in pixels (default 5)
   * @returns Snap offsets to apply and guides to render
   */
  const calculateSnap = useCallback((
    iframe: HTMLIFrameElement | null,
    currentEl: HTMLElement,
    threshold: number = DEFAULT_THRESHOLD,
  ): SnapInfo => {
    if (!iframe?.contentDocument) {
      return { snapDx: 0, snapDy: 0, guides: [] };
    }

    const doc = iframe.contentDocument;
    const elRect = currentEl.getBoundingClientRect();

    // Element key positions
    const elLeft = elRect.left;
    const elRight = elRect.right;
    const elCenterX = elRect.left + elRect.width / 2;
    const elTop = elRect.top;
    const elBottom = elRect.bottom;
    const elCenterY = elRect.top + elRect.height / 2;

    // Viewport dimensions
    const viewportW = doc.documentElement?.clientWidth || 0;
    const viewportH = doc.documentElement?.clientHeight || 0;

    // Collect alignment targets: sibling elements + viewport edges
    interface AlignTarget { left: number; right: number; centerX: number; top: number; bottom: number; centerY: number; }
    const targets: AlignTarget[] = [];

    // Viewport edges as a pseudo-target
    if (viewportW > 0 && viewportH > 0) {
      targets.push({
        left: 0,
        right: viewportW,
        centerX: viewportW / 2,
        top: 0,
        bottom: viewportH,
        centerY: viewportH / 2,
      });
    }

    // Collect sibling elements
    const allEls = doc.querySelectorAll<HTMLElement>(ALIGNABLE_SELECTOR);
    allEls.forEach(el => {
      if (el === currentEl || el.contains(currentEl) || currentEl.contains(el)) return;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      // Skip elements that are not in the visible viewport at all
      if (rect.bottom < 0 || rect.top > viewportH || rect.right < 0 || rect.left > viewportW) return;
      targets.push({
        left: rect.left,
        right: rect.right,
        centerX: rect.left + rect.width / 2,
        top: rect.top,
        bottom: rect.bottom,
        centerY: rect.top + rect.height / 2,
      });
    });

    // Find best vertical snap (X axis)
    let bestVSnap: { offset: number; position: number } | null = null;
    let bestVDiff = threshold;

    // Find best horizontal snap (Y axis)
    let bestHSnap: { offset: number; position: number } | null = null;
    let bestHDiff = threshold;

    for (const t of targets) {
      // Vertical alignment checks (snap X position)
      const vChecks = [
        { elPos: elLeft, targetPos: t.left },
        { elPos: elRight, targetPos: t.right },
        { elPos: elCenterX, targetPos: t.centerX },
        { elPos: elRight, targetPos: t.left },   // right edge to target left
        { elPos: elLeft, targetPos: t.right },   // left edge to target right
      ];
      for (const check of vChecks) {
        const diff = Math.abs(check.elPos - check.targetPos);
        if (diff <= bestVDiff) {
          bestVDiff = diff;
          bestVSnap = { offset: check.targetPos - check.elPos, position: check.targetPos };
        }
      }

      // Horizontal alignment checks (snap Y position)
      const hChecks = [
        { elPos: elTop, targetPos: t.top },
        { elPos: elBottom, targetPos: t.bottom },
        { elPos: elCenterY, targetPos: t.centerY },
        { elPos: elBottom, targetPos: t.top },   // bottom edge to target top
        { elPos: elTop, targetPos: t.bottom },   // top edge to target bottom
      ];
      for (const check of hChecks) {
        const diff = Math.abs(check.elPos - check.targetPos);
        if (diff <= bestHDiff) {
          bestHDiff = diff;
          bestHSnap = { offset: check.targetPos - check.elPos, position: check.targetPos };
        }
      }
    }

    const newGuides: AlignmentGuide[] = [];
    let snapDx = 0;
    let snapDy = 0;

    if (bestVSnap) {
      snapDx = bestVSnap.offset;
      newGuides.push({
        id: `v-${Math.round(bestVSnap.position)}`,
        type: 'vertical',
        position: bestVSnap.position,
      });
    }

    if (bestHSnap) {
      snapDy = bestHSnap.offset;
      newGuides.push({
        id: `h-${Math.round(bestHSnap.position)}`,
        type: 'horizontal',
        position: bestHSnap.position,
      });
    }

    // Update guides state (only if changed to avoid unnecessary re-renders)
    const prev = guidesRef.current;
    if (prev.length !== newGuides.length ||
        prev.some((g, i) => g.id !== newGuides[i]?.id || g.position !== newGuides[i]?.position)) {
      guidesRef.current = newGuides;
      setGuides(newGuides);
    }

    return { snapDx, snapDy, guides: newGuides };
  }, []);

  return { guides, clearGuides, calculateSnap };
}
