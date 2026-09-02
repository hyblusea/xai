import { describe, it, expect, beforeEach } from 'vitest';
import { generateSelector } from '../designerElementUtils';

/**
 * Regression tests for the "selection box jumps to another element" bug.
 *
 * Root cause: generateSelector used to short-circuit on `id` / `data-design-id`
 * without verifying uniqueness. AI-generated repeated components (e.g. stats
 * cards) frequently share the same data-design-id, so the produced selector
 * matched multiple elements. The deferred re-query in updateSelectionFromIframe
 * / updateRectOnly then resolved `querySelector(selector)` to the FIRST match —
 * a different element — and overwrote the selection's rect/style, making the
 * selection box jump.
 *
 * The fix: only short-circuit on id / data-design-id when they are unique;
 * otherwise fall back to a hierarchical `:nth-of-type` path that is unique by
 * construction.
 */

// Polyfill CSS.escape in case the test DOM (happy-dom) lacks it. The real
// runtime is a browser iframe, which always provides CSS.escape.
if (typeof (globalThis as any).CSS === 'undefined' || !(globalThis as any).CSS?.escape) {
  (globalThis as any).CSS = {
    ...(globalThis as any).CSS,
    escape: (s: string) => String(s).replace(/[^a-zA-Z0-9_-]/g, ch => '\\' + ch),
  };
}

describe('generateSelector — uniqueness', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('uniquely targets an element whose data-design-id is duplicated (stats-card regression)', () => {
    document.body.innerHTML = `
      <div class="card" data-design-id="stat-card"><div class="num">1234</div></div>
      <div class="card" data-design-id="stat-card"><div class="num">5678</div></div>
    `;
    const cardBNum = document.querySelectorAll('.num')[1] as HTMLElement;

    const sel = generateSelector(cardBNum);

    // Must NOT be the bare non-unique short selector.
    expect(sel).not.toBe('[data-design-id="stat-card"]');
    // Must resolve to exactly one element — the clicked one.
    expect(document.querySelectorAll(sel).length).toBe(1);
    expect(document.querySelector(sel)).toBe(cardBNum);
  });

  it('uniquely targets an element whose id is duplicated', () => {
    document.body.innerHTML = `
      <div id="dup"><span>a</span></div>
      <div id="dup"><span>b</span></div>
    `;
    const bSpan = document.querySelectorAll('#dup span')[1] as HTMLElement;

    const sel = generateSelector(bSpan);

    expect(sel).not.toBe('#dup');
    expect(document.querySelectorAll(sel).length).toBe(1);
    expect(document.querySelector(sel)).toBe(bSpan);
  });

  it('still short-circuits on a globally-unique id', () => {
    document.body.innerHTML = `<div id="unique"><span>hi</span></div>`;
    const span = document.querySelector('#unique span') as HTMLElement;

    const sel = generateSelector(span);

    // Anchors on the unique ancestor id (no full body→… path needed).
    expect(sel).toBe('#unique > span');
    expect(document.querySelectorAll(sel).length).toBe(1);
    expect(document.querySelector(sel)).toBe(span);
  });

  it('still short-circuits on a globally-unique data-design-id', () => {
    document.body.innerHTML = `<div data-design-id="only"><span>x</span></div>`;
    const span = document.querySelector('[data-design-id="only"] span') as HTMLElement;

    const sel = generateSelector(span);

    expect(sel).toBe('[data-design-id="only"] > span');
    expect(document.querySelectorAll(sel).length).toBe(1);
    expect(document.querySelector(sel)).toBe(span);
  });

  it('produces a unique selector for sibling cards without any id/data-design-id', () => {
    document.body.innerHTML = `
      <div class="card"><div class="num">1</div></div>
      <div class="card"><div class="num">2</div></div>
      <div class="card"><div class="num">3</div></div>
    `;
    const cards = document.querySelectorAll('.card');
    const selectors = Array.from(cards).map(c => generateSelector(c as HTMLElement));

    // Every selector is unique and resolves back to its source element.
    selectors.forEach((sel, i) => {
      expect(document.querySelectorAll(sel).length).toBe(1);
      expect(document.querySelector(sel)).toBe(cards[i]);
    });
    // No two siblings collapse to the same selector.
    expect(new Set(selectors).size).toBe(selectors.length);
  });
});
