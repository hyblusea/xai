/**
 * Diagram toolbar injection for DIAGRAM project type.
 *
 * Injects per-diagram toolbars + zoom/pan wrappers into
 * Mermaid-rendered HTML pages. Each diagram gets its own toolbar
 * positioned at the top-right corner of the diagram container.
 *
 * Architecture:
 * - MutationObserver wraps each <pre class="mermaid"> after Mermaid renders SVGs
 * - Each diagram gets independent zoom/pan state and its own toolbar
 * - Toolbar appears on hover over the diagram container
 * - Each toolbar provides: zoom in/out/reset, fullscreen, copy SVG to clipboard
 * - CSS transforms for zoom (vector quality preserved)
 * - Mouse drag + wheel zoom per diagram
 * - Idempotent: safe to call multiple times on the same HTML
 *
 * Used by: postProcessDesignerHtml (designerScrollbar.ts)
 */

// ── Style ID for idempotent injection ──────────────────────────────────
const TOOLBAR_STYLE_ID = '__xai_diagram_toolbar__';
const TOOLBAR_SCRIPT_ID = '__xai_diagram_toolbar_script__';

// ── CSS ────────────────────────────────────────────────────────────────

function getToolbarCss(): string {
  return `
/* === Diagram Toolbar (per-diagram) === */

/* Separator between button groups */
.dt-sep {
  width: 1px;
  height: 24px;
  background: rgba(0,0,0,0.1);
  margin: 0 4px;
  flex-shrink: 0;
}

/* Zoom level display */
.dt-zoom-display {
  font-size: 11px;
  font-weight: 600;
  color: #555;
  min-width: 40px;
  text-align: center;
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.02em;
}

/* Button base */
.dt-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: #444;
  cursor: pointer;
  padding: 0;
  transition: background 0.15s ease, color 0.15s ease, transform 0.1s ease;
  flex-shrink: 0;
}
.dt-btn:hover {
  background: rgba(0,0,0,0.07);
  color: #111;
}
.dt-btn:active {
  background: rgba(0,0,0,0.12);
  transform: scale(0.94);
}
.dt-btn svg {
  width: 16px;
  height: 16px;
  stroke-width: 2;
}

/* Copy button feedback */
.dt-copy-feedback {
  color: #22c55e !important;
}
.dt-btn.dt-copied {
  color: #22c55e !important;
}

/* Per-diagram toolbar — sits inside wrapper, top-right corner */
.dt-toolbar {
  position: absolute;
  top: 12px;
  right: 12px;
  z-index: 9999;
  display: flex;
  align-items: center;
  gap: 2px;
  background: rgba(255,255,255,0.92);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  border: 1px solid rgba(0,0,0,0.1);
  border-radius: 10px;
  padding: 4px;
  box-shadow: 0 2px 12px rgba(0,0,0,0.08), 0 0 0 1px rgba(0,0,0,0.04);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  user-select: none;
  -webkit-user-select: none;
  opacity: 0;
  transform: translateY(-4px);
  transition: opacity 0.2s ease, transform 0.2s ease;
  pointer-events: none;
}
.dt-diagram-wrap:hover > .dt-toolbar,
.dt-toolbar:focus-within {
  opacity: 1;
  transform: translateY(0);
  pointer-events: auto;
}

/* Diagram wrapper */
.dt-diagram-wrap {
  position: relative;
  overflow: hidden;
  cursor: grab;
  border-radius: 8px;
  transition: box-shadow 0.2s ease;
  width: 100%;
  box-sizing: border-box;
}
.dt-diagram-wrap:active { cursor: grabbing; }
.dt-diagram-wrap.dt-focused {
  box-shadow: 0 0 0 2px rgba(74,144,217,0.25);
}

/* SVG inside wrapper */
.dt-diagram-wrap > svg,
.dt-diagram-wrap > .mermaid > svg {
  transform-origin: center center;
  will-change: transform;
  transition: none;
  display: block;
  max-width: none;
  width: 100%;
  height: auto;
}

/* Tooltip */
.dt-btn[data-tip] { position: relative; }
.dt-btn[data-tip]::after {
  content: attr(data-tip);
  position: absolute;
  top: calc(100% + 6px);
  left: 50%;
  transform: translateX(-50%);
  padding: 4px 10px;
  background: #222;
  color: #fff;
  font-size: 11px;
  font-weight: 500;
  white-space: nowrap;
  border-radius: 6px;
  pointer-events: none;
  opacity: 0;
  transition: opacity 0.15s ease;
}
.dt-btn[data-tip]:hover::after { opacity: 1; }

@media print {
  .dt-toolbar { display: none !important; }
  .dt-diagram-wrap { overflow: visible !important; cursor: default !important; }
  .dt-diagram-wrap > svg { transform: none !important; }
}`;
}

// ── JavaScript ─────────────────────────────────────────────────────────

function getToolbarScript(): string {
  return `(function() {
  'use strict';

  /* ── Constants ────────────────────────────────────── */
  var ZOOM_STEP = 0.15;
  var ZOOM_MIN  = 0.2;
  var ZOOM_MAX  = 5;

  /* ── SVG icon helpers ─────────────────────────────── */
  var ICO_ZOOM_IN  = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.35-4.35M11 8v6M8 11h6"/></svg>';
  var ICO_ZOOM_OUT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.35-4.35M8 11h6"/></svg>';
  var ICO_RESET    = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M3 12a9 9 0 1 1 3 6.75"/><path d="M3 22V12h10"/></svg>';
  var ICO_FIT      = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>';
  var ICO_FS       = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>';
  var ICO_COPY     = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
  var ICO_CHECK    = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><polyline points="20 6 9 17 4 12"/></svg>';

  /* ── Build toolbar HTML for a single diagram ─────── */
  function buildToolbarHtml() {
    return '<button class="dt-btn dt-zoom-in" data-tip="放大">' + ICO_ZOOM_IN + '</button>' +
      '<span class="dt-zoom-display dt-zoom-pct">100%</span>' +
      '<button class="dt-btn dt-zoom-out" data-tip="缩小">' + ICO_ZOOM_OUT + '</button>' +
      '<button class="dt-btn dt-reset" data-tip="重置视图">' + ICO_RESET + '</button>' +
      '<div class="dt-sep"></div>' +
      '<button class="dt-btn dt-fit" data-tip="适应窗口">' + ICO_FIT + '</button>' +
      '<button class="dt-btn dt-fs" data-tip="全屏">' + ICO_FS + '</button>' +
      '<div class="dt-sep"></div>' +
      '<button class="dt-btn dt-copy-svg" data-tip="复制 SVG">' + ICO_COPY + '</button>';
  }

  /* ── Wrap all diagrams ───────────────────────────── */
  function wrapDiagrams() {
    var pres = document.querySelectorAll('pre.mermaid');
    for (var i = 0; i < pres.length; i++) {
      var pre = pres[i];
      // Already wrapped? skip
      if (pre.querySelector('.dt-diagram-wrap')) continue;
      // Find rendered SVG (Mermaid replaces content or creates sibling)
      var svg = pre.querySelector('svg');
      if (!svg) continue; // Not yet rendered

      // Create wrapper
      var wrap = document.createElement('div');
      wrap.className = 'dt-diagram-wrap';
      wrap.setAttribute('data-dt-zoom', '1');
      wrap.setAttribute('data-dt-pan-x', '0');
      wrap.setAttribute('data-dt-pan-y', '0');

      // Move SVG into wrapper
      pre.style.position = 'relative';
      pre.style.overflow = 'visible';
      svg.parentNode.insertBefore(wrap, svg);
      wrap.appendChild(svg);

      // Create per-diagram toolbar
      var toolbar = document.createElement('div');
      toolbar.className = 'dt-toolbar';
      toolbar.innerHTML = buildToolbarHtml();
      wrap.appendChild(toolbar);

      // Bind events for this diagram + toolbar
      bindDiagramEvents(wrap, svg, toolbar);
    }
  }

  /* ── Diagram interaction events ──────────────────── */
  function bindDiagramEvents(wrap, svg, toolbar) {
    var isPanning = false;
    var startX, startY, startPanX, startPanY;

    // Mouse drag pan
    wrap.addEventListener('mousedown', function(e) {
      // Don't start panning if clicking on toolbar buttons
      if (e.target.closest('.dt-toolbar')) return;
      if (e.button !== 0) return;
      isPanning = true;
      startX = e.clientX;
      startY = e.clientY;
      startPanX = parseFloat(wrap.getAttribute('data-dt-pan-x')) || 0;
      startPanY = parseFloat(wrap.getAttribute('data-dt-pan-y')) || 0;
      wrap.style.cursor = 'grabbing';
      wrap.classList.add('dt-focused');
      e.preventDefault();
    });

    document.addEventListener('mousemove', function(e) {
      if (!isPanning) return;
      var dx = e.clientX - startX;
      var dy = e.clientY - startY;
      var newPanX = startPanX + dx;
      var newPanY = startPanY + dy;
      wrap.setAttribute('data-dt-pan-x', newPanX);
      wrap.setAttribute('data-dt-pan-y', newPanY);
      applyTransform(wrap, svg);
    });

    document.addEventListener('mouseup', function() {
      if (isPanning) {
        isPanning = false;
        wrap.style.cursor = 'grab';
        setTimeout(function() { wrap.classList.remove('dt-focused'); }, 600);
      }
    });

    // Wheel zoom
    wrap.addEventListener('wheel', function(e) {
      e.preventDefault();
      var zoom = parseFloat(wrap.getAttribute('data-dt-zoom')) || 1;
      var rect = wrap.getBoundingClientRect();
      var mx = e.clientX - rect.left;
      var my = e.clientY - rect.top;
      var oldZoom = zoom;

      if (e.deltaY < 0) {
        zoom = Math.min(zoom + ZOOM_STEP, ZOOM_MAX);
      } else {
        zoom = Math.max(zoom - ZOOM_STEP, ZOOM_MIN);
      }

      // Zoom toward cursor position
      var panX = parseFloat(wrap.getAttribute('data-dt-pan-x')) || 0;
      var panY = parseFloat(wrap.getAttribute('data-dt-pan-y')) || 0;
      var scale = zoom / oldZoom;
      var newPanX = mx - scale * (mx - panX);
      var newPanY = my - scale * (my - panY);

      wrap.setAttribute('data-dt-zoom', zoom);
      wrap.setAttribute('data-dt-pan-x', newPanX);
      wrap.setAttribute('data-dt-pan-y', newPanY);
      applyTransform(wrap, svg);
      updateZoomDisplay(wrap, toolbar);
    }, { passive: false });

    // ── Per-diagram toolbar button events ─────────────
    var zoomPct = toolbar.querySelector('.dt-zoom-pct');

    toolbar.querySelector('.dt-zoom-in').addEventListener('click', function(e) {
      e.stopPropagation();
      var z = Math.min((parseFloat(wrap.getAttribute('data-dt-zoom')) || 1) + ZOOM_STEP, ZOOM_MAX);
      wrap.setAttribute('data-dt-zoom', z);
      applyTransform(wrap, svg);
      updateZoomDisplay(wrap, toolbar);
    });

    toolbar.querySelector('.dt-zoom-out').addEventListener('click', function(e) {
      e.stopPropagation();
      var z = Math.max((parseFloat(wrap.getAttribute('data-dt-zoom')) || 1) - ZOOM_STEP, ZOOM_MIN);
      wrap.setAttribute('data-dt-zoom', z);
      applyTransform(wrap, svg);
      updateZoomDisplay(wrap, toolbar);
    });

    toolbar.querySelector('.dt-reset').addEventListener('click', function(e) {
      e.stopPropagation();
      wrap.setAttribute('data-dt-zoom', '1');
      wrap.setAttribute('data-dt-pan-x', '0');
      wrap.setAttribute('data-dt-pan-y', '0');
      applyTransform(wrap, svg);
      updateZoomDisplay(wrap, toolbar);
    });

    toolbar.querySelector('.dt-fit').addEventListener('click', function(e) {
      e.stopPropagation();
      var wrapRect = wrap.getBoundingClientRect();
      var svgW = svg.getBBox().width  || svg.getBoundingClientRect().width;
      var svgH = svg.getBBox().height || svg.getBoundingClientRect().height;
      if (svgW === 0 || svgH === 0) return;
      var scaleX = wrapRect.width  / svgW;
      var scaleY = wrapRect.height / svgH;
      var fitZoom = Math.min(scaleX, scaleY, 1) * 0.92;
      wrap.setAttribute('data-dt-zoom', fitZoom);
      wrap.setAttribute('data-dt-pan-x', '0');
      wrap.setAttribute('data-dt-pan-y', '0');
      applyTransform(wrap, svg);
      updateZoomDisplay(wrap, toolbar);
    });

    toolbar.querySelector('.dt-fs').addEventListener('click', function(e) {
      e.stopPropagation();
      if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen().catch(function(){});
      } else {
        document.exitFullscreen().catch(function(){});
      }
    });

    // Copy SVG to clipboard
    toolbar.querySelector('.dt-copy-svg').addEventListener('click', function(e) {
      e.stopPropagation();
      var btn = this;
      var str = getSvgString(svg);
      if (!str || !/<svg/i.test(str)) {
        console.error('[DiagramToolbar] SVG copy failed: invalid SVG content');
        return;
      }
      navigator.clipboard.writeText(str).then(function() {
        btn.innerHTML = ICO_CHECK;
        btn.classList.add('dt-copied');
        btn.setAttribute('data-tip', '已复制');
        setTimeout(function() {
          btn.innerHTML = ICO_COPY;
          btn.classList.remove('dt-copied');
          btn.setAttribute('data-tip', '复制 SVG');
        }, 2000);
      }).catch(function() {
        console.error('[DiagramToolbar] Failed to copy SVG to clipboard');
      });
    });
  }

  /* ── Apply CSS transform ─────────────────────────── */
  function applyTransform(wrap, svg) {
    var zoom = parseFloat(wrap.getAttribute('data-dt-zoom')) || 1;
    var panX = parseFloat(wrap.getAttribute('data-dt-pan-x')) || 0;
    var panY = parseFloat(wrap.getAttribute('data-dt-pan-y')) || 0;
    svg.style.transform = 'translate(' + panX + 'px,' + panY + 'px) scale(' + zoom + ')';
  }

  /* ── Update zoom % display for a specific diagram ── */
  function updateZoomDisplay(wrap, toolbar) {
    var el = toolbar.querySelector('.dt-zoom-pct');
    if (!el) return;
    var zoom = parseFloat(wrap.getAttribute('data-dt-zoom')) || 1;
    el.textContent = Math.round(zoom * 100) + '%';
  }


  /* ── SVG serialization for clipboard copy ─────────── */
  function inlineComputedStyles(origEl, cloneEl) {
    var svgStyleProps = [
      'fill', 'stroke', 'stroke-width', 'stroke-dasharray', 'stroke-linecap',
      'stroke-linejoin', 'stroke-opacity', 'fill-opacity', 'opacity',
      'font-family', 'font-size', 'font-weight', 'font-style',
      'text-anchor', 'text-decoration', 'dominant-baseline',
      'letter-spacing', 'word-spacing', 'line-height',
      'visibility', 'display', 'color',
      'marker-start', 'marker-mid', 'marker-end',
      'filter', 'clip-path'
    ];
    var origChildren = origEl.children;
    var cloneChildren = cloneEl.children;
    for (var i = 0; i < origChildren.length && i < cloneChildren.length; i++) {
      try {
        var cs = getComputedStyle(origChildren[i]);
        for (var j = 0; j < svgStyleProps.length; j++) {
          var prop = svgStyleProps[j];
          var val = cs.getPropertyValue(prop);
          if (val && val !== 'none' && val !== 'normal' && val !== '0px') {
            cloneChildren[i].style.setProperty(prop, val);
          }
        }
      } catch(_) { /* skip elements that fail style lookup */ }
      if (origChildren[i].children.length > 0) {
        inlineComputedStyles(origChildren[i], cloneChildren[i]);
      }
    }
  }

  function cloneSvgForExport(svg) {
    var clone = svg.cloneNode(true);
    clone.style.transform = '';
    clone.removeAttribute('style');
    var rect = svg.getBoundingClientRect();
    clone.setAttribute('width',  rect.width);
    clone.setAttribute('height', rect.height);
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    if (!clone.getAttribute('xmlns:xlink')) {
      clone.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
    }
    var cs = getComputedStyle(svg);
    if (!clone.getAttribute('font-family')) {
      clone.setAttribute('font-family', cs.fontFamily || 'sans-serif');
    }
    try { inlineComputedStyles(svg, clone); } catch(_) {}
    return clone;
  }

  function getSvgString(svgEl) {
    var clone = cloneSvgForExport(svgEl);
    var serializer = new XMLSerializer();
    var str = serializer.serializeToString(clone);
    if (str.indexOf('xmlns="http://www.w3.org/2000/svg"') === -1) {
      str = str.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"');
    }
    return '<?xml version="1.0" encoding="UTF-8"?>\\n' + str;
  }

  /* ── MutationObserver: auto-wrap on Mermaid render ── */
  function observeMermaidRender() {
    var observer = new MutationObserver(function(mutations) {
      var shouldWrap = false;
      for (var i = 0; i < mutations.length; i++) {
        var m = mutations[i];
        for (var j = 0; j < m.addedNodes.length; j++) {
          var node = m.addedNodes[j];
          if (node.nodeType !== 1) continue;
          if (node.tagName === 'SVG' || (node.querySelector && node.querySelector('svg'))) {
            shouldWrap = true;
            break;
          }
        }
        if (shouldWrap) break;
      }
      if (shouldWrap) {
        requestAnimationFrame(wrapDiagrams);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return observer;
  }

  /* ── Initialization ──────────────────────────────── */
  function init() {
    // Initial wrap attempt (for pre-rendered pages)
    wrapDiagrams();
    // Observer for streaming / late-rendered pages
    observeMermaidRender();
    // Backup: retry after a short delay for slow Mermaid renders
    setTimeout(wrapDiagrams, 500);
    setTimeout(wrapDiagrams, 1500);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();`;
}

// ── Public API ─────────────────────────────────────────────────────────

/**
 * Inject diagram toolbar + zoom/pan wrappers into a DIAGRAM HTML page.
 *
 * Idempotent: existing toolbar/styles are replaced rather than duplicated.
 * Streaming-safe: returns unchanged if </body> is not yet present.
 *
 * @param html The HTML page to inject toolbar into
 * @returns Modified HTML with toolbar injected
 */
export function injectDiagramToolbar(html: string): string {
  if (!html) return html;

  // Streaming-safe: only inject when document is complete
  if (!/<\/body>/i.test(html) && !/<\/head>/i.test(html)) return html;

  let result = html;

  // ── 1. Inject CSS (idempotent, before </head>) ──
  const existingStyleRegex = new RegExp(
    `<style[^>]*id=["']${TOOLBAR_STYLE_ID}["'][^>]*>[\\s\\S]*?<\\/style>`,
    'i',
  );
  const styleTag = `<style id="${TOOLBAR_STYLE_ID}">\n/* xAI diagram toolbar */\n${getToolbarCss()}\n</style>`;

  if (existingStyleRegex.test(result)) {
    result = result.replace(existingStyleRegex, styleTag);
  } else if (/<\/head>/i.test(result)) {
    result = result.replace(/<\/head>/i, `${styleTag}\n</head>`);
  }

  // ── 2. Inject toolbar script (idempotent, before </body>) ──
  const existingScriptRegex = new RegExp(
    `<script[^>]*id=["']${TOOLBAR_SCRIPT_ID}["'][^>]*>[\\s\\S]*?<\\/script>`,
    'i',
  );
  const scriptTag = `<script id="${TOOLBAR_SCRIPT_ID}">\n${getToolbarScript()}\n<\/script>`;

  if (existingScriptRegex.test(result)) {
    result = result.replace(existingScriptRegex, scriptTag);
  } else if (/<\/body>/i.test(result)) {
    result = result.replace(/<\/body>/i, `${scriptTag}\n</body>`);
  }

  return result;
}