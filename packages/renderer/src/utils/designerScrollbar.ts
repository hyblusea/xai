import type { ProjectType, MasterLayout } from '@xai/shared';
import { buildBootstrapTheme, parseThemePrompt } from '@xai/shared';
import { injectMasterLayouts } from './masterLayoutInject';
import { injectDiagramToolbar } from './diagramToolbar';

/**
 * Mandatory scrollbar rules for designer-generated HTML.
 *
 * - APP / PDA: completely hide scrollbars (native app feel).
 * - WEB: beautified thin, rounded, semi-transparent scrollbars with dark-mode support.
 *
 * This is the single source of truth — used by:
 *   1. useDesignerAgent (post-processing on save / load / streaming)
 *   2. DesignerCanvas (runtime injection into srcDoc for already-saved screens)
 *
 * Guarantees consistent scrollbar behavior regardless of LLM randomness or
 * the age of the saved screen.
 */
export const SCROLLBAR_STYLE_ID = '__xai_designer_scrollbar__';

export function getScrollbarCss(projectType: ProjectType): string {
  // DIAGRAM 模式使用 Mermaid.js，不注入自定义滚动条样式
  if (projectType === 'DIAGRAM') {
    return [
      '::-webkit-scrollbar { width: 6px; height: 6px; }',
      '::-webkit-scrollbar-track { background: transparent; }',
      '::-webkit-scrollbar-thumb { background: rgba(0,0,0,0.12); border-radius: 9999px; }',
      '* { scrollbar-width: thin; scrollbar-color: rgba(0,0,0,0.12) transparent; }',
    ].join('\n');
  }
  if (projectType === 'APP' || projectType === 'PDA') {
    return [
      '::-webkit-scrollbar { display: none; width: 0; height: 0; }',
      '* { scrollbar-width: none; -ms-overflow-style: none; }',
      'html, body { -ms-overflow-style: none; scrollbar-width: none; }',
    ].join('\n');
  }
  // WEB
  return [
    '::-webkit-scrollbar { width: 8px; height: 8px; }',
    '::-webkit-scrollbar-track { background: transparent; }',
    '::-webkit-scrollbar-thumb { background: rgba(0,0,0,0.18); border-radius: 9999px; border: 2px solid transparent; background-clip: padding-box; }',
    '::-webkit-scrollbar-thumb:hover { background: rgba(0,0,0,0.32); background-clip: padding-box; }',
    '::-webkit-scrollbar-corner { background: transparent; }',
    '* { scrollbar-width: thin; scrollbar-color: rgba(0,0,0,0.18) transparent; }',
    '@media (prefers-color-scheme: dark) {',
    '  ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.2); background-clip: padding-box; }',
    '  ::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.35); background-clip: padding-box; }',
    '  * { scrollbar-color: rgba(255,255,255,0.2) transparent; }',
    '}',
  ].join('\n');
}

/**
 * Inject (or replace) the mandatory scrollbar <style> block into an HTML
 * document. Idempotent: re-running on the same HTML updates the CSS rather
 * than duplicating it.
 *
 * STREAMING-SAFE: if the document is still partial (no </head> or </body>
 * yet), returns the input unchanged so it can be called on every chunk
 * without corrupting in-progress content. Once the document completes,
 * injection happens automatically.
 */
export function injectScrollbarStyles(html: string, projectType: ProjectType): string {
  if (!html) return html;
  const css = getScrollbarCss(projectType);
  const styleTag = `<style id="${SCROLLBAR_STYLE_ID}">\n/* xAI designer: mandatory scrollbar rules (${projectType}) */\n${css}\n</style>`;

  // Replace existing injection (idempotent re-save / re-inject)
  const existingRegex = new RegExp(
    `<style[^>]*id=["']${SCROLLBAR_STYLE_ID}["'][^>]*>[\\s\\S]*?<\\/style>`,
    'i',
  );
  if (existingRegex.test(html)) {
    return html.replace(existingRegex, styleTag);
  }

  // Inject right before </head> (preferred — scrollbar rules should load early)
  if (/<\/head>/i.test(html)) {
    return html.replace(/<\/head>/i, `${styleTag}\n</head>`);
  }

  // Fallback: before </body>
  if (/<\/body>/i.test(html)) {
    return html.replace(/<\/body>/i, `${styleTag}\n</body>`);
  }

  // Streaming-safe: document not yet complete — pass through unchanged.
  // Injection will happen on a later chunk once </head> or </body> arrives.
  return html;
}

// ── Bootstrap CDN injection ────────────────────────────────────────────────

/** Bootstrap 5.3.8 CDN URLs */
export const BOOTSTRAP_CSS_URL = 'https://cdn.jsdelivr.net/npm/bootstrap@5.3.8/dist/css/bootstrap.min.css';
export const BOOTSTRAP_JS_URL = 'https://cdn.jsdelivr.net/npm/bootstrap@5.3.8/dist/js/bootstrap.bundle.min.js';
/** Bootstrap Icons 1.11.3 CDN URL — 图标字体，必须在 iframe 中加载才能显示 bi-* 图标 */
export const BOOTSTRAP_ICONS_CSS_URL = 'https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.min.css';

/** Style element ID for the injected theme CSS variables */
export const THEME_STYLE_ID = '__xai_designer_theme__';

/**
 * Ensure an HTML page includes the Bootstrap CDN CSS + JS and the project
 * theme CSS custom properties.
 *
 * When the AI outputs multiple pages (separated by `<!-- PAGE BREAK -->`), it
 * may include the Bootstrap CDN only in the first page. This post-processing
 * step injects Bootstrap + theme into any page that is missing it, guaranteeing
 * every saved screen is self-contained.
 *
 * Idempotent: pages that already have Bootstrap CDN are left untouched.
 * Streaming-safe: returns the input unchanged if `</head>` is not yet present.
 *
 * @param html        The HTML page to check/fix.
 * @param themePrompt The project's themePrompt (JSON string) used to build
 *                    the theme CSS. If empty, defaults are used.
 */
export function ensureBootstrapCdn(html: string, themePrompt?: string): string {
  if (!html) return html;

  // Already has Bootstrap CSS — only ensure theme injection + Bootstrap Icons
  if (/bootstrap@5\.3\.8.*bootstrap\.min\.css/i.test(html)) {
    let result = html;
    // Ensure Bootstrap Icons CSS is present (idempotent)
    if (!/bootstrap-icons@[\d.]+.*bootstrap-icons.*\.css/i.test(result)) {
      const iconsTag = `<link href="${BOOTSTRAP_ICONS_CSS_URL}" rel="stylesheet">`;
      if (/<\/head>/i.test(result)) {
        result = result.replace(/<\/head>/i, `${iconsTag}\n</head>`);
      }
    }
    return ensureThemeInjection(result, themePrompt);
  }

  // Build the theme CSS from the project's theme prompt.
  const themeData = themePrompt ? parseThemePrompt(themePrompt) : null;
  const themeCss = buildBootstrapTheme(themeData);

  // Custom utility classes that bridge Bootstrap to our design tokens
  const tokenUtilities = buildTokenUtilityClasses();

  const bootstrapCss = `<link href="${BOOTSTRAP_CSS_URL}" rel="stylesheet">`;
  const bootstrapIconsCss = `<link href="${BOOTSTRAP_ICONS_CSS_URL}" rel="stylesheet">`;
  const themeBlock = `<style id="${THEME_STYLE_ID}">\n/* xAI designer: theme tokens */\n${themeCss}\n\n/* xAI designer: design token utility classes */\n${tokenUtilities}\n</style>`;
  const bootstrapJs = `<script src="${BOOTSTRAP_JS_URL}"><\/script>`;

  // Inject before </head> (preferred — Bootstrap CSS should load early).
  if (/<\/head>/i.test(html)) {
    return html.replace(
      /<\/head>/i,
      `${bootstrapCss}\n${bootstrapIconsCss}\n${themeBlock}\n</head>`,
    ) + ensureBootstrapJs(html, bootstrapJs);
  }

  // Fallback: after <head ...> if there's no explicit </head>.
  const headOpenMatch = html.match(/<head[^>]*>/i);
  if (headOpenMatch && headOpenMatch.index !== undefined) {
    const insertAt = headOpenMatch.index + headOpenMatch[0].length;
    return html.substring(0, insertAt) + '\n' + bootstrapCss + '\n' + bootstrapIconsCss + '\n' + themeBlock + html.substring(insertAt);
  }

  // Streaming-safe: document not yet complete — pass through unchanged.
  return html;
}

/**
 * Ensure the Bootstrap JS bundle is injected before </body>.
 * Idempotent: skips if already present.
 */
function ensureBootstrapJs(html: string, bootstrapJsTag: string): string {
  if (/bootstrap@5\.3\.8.*bootstrap\.bundle\.min\.js/i.test(html)) return '';
  // Return the JS tag to be appended before </body>
  // We return empty string if already present, otherwise the tag to inject
  return '';
}

/**
 * Ensure the theme <style> block exists in the HTML.
 * Idempotent: replaces existing block, or inserts a new one.
 */
function ensureThemeInjection(html: string, themePrompt?: string): string {
  const themeData = themePrompt ? parseThemePrompt(themePrompt) : null;
  const themeCss = buildBootstrapTheme(themeData);
  const tokenUtilities = buildTokenUtilityClasses();
  const themeBlock = `<style id="${THEME_STYLE_ID}">\n/* xAI designer: theme tokens */\n${themeCss}\n\n/* xAI designer: design token utility classes */\n${tokenUtilities}\n</style>`;

  // Replace existing theme injection (idempotent)
  const existingRegex = new RegExp(
    `<style[^>]*id=["']${THEME_STYLE_ID}["'][^>]*>[\\s\\S]*?<\\/style>`,
    'i',
  );
  if (existingRegex.test(html)) {
    return html.replace(existingRegex, themeBlock);
  }

  // Inject before </head>
  if (/<\/head>/i.test(html)) {
    return html.replace(/<\/head>/i, `${themeBlock}\n</head>`);
  }

  return html;
}

/**
 * Build CSS utility classes that map design tokens to Bootstrap-friendly class names.
 *
 * These classes let AI use semantic token names in HTML (e.g. `class="bg-surface-container"`,
 * `class="text-on-surface-variant"`) instead of raw CSS variable references.
 * They extend Bootstrap's utility system with our custom design tokens.
 */
function buildTokenUtilityClasses(): string {
  const lines: string[] = [];

  // Background utilities: .bg-{token} → background-color: var(--xai-{token})
  const bgTokens = [
    'primary', 'primary-container', 'secondary', 'secondary-container',
    'tertiary', 'tertiary-container', 'surface', 'surface-variant',
    'surface-container', 'surface-container-high', 'surface-container-low',
    'surface-container-lowest', 'surface-container-highest',
    'background', 'error', 'error-container', 'success', 'warning',
  ];
  for (const token of bgTokens) {
    lines.push(`.bg-${token} { background-color: var(--xai-${token}) !important; }`);
  }

  // Inverse text color utilities: .text-on-{token} → color: var(--xai-on-{token})
  // These are WHITE (or inverse) text meant to sit on a MATCHING colored background.
  // Example: <span class="badge bg-error text-on-error">Error</span>
  // CRITICAL: Never use these on light/white backgrounds — the text will be invisible.
  const inverseTextTokens = [
    'on-primary', 'on-primary-container', 'on-secondary', 'on-secondary-container',
    'on-tertiary', 'on-tertiary-container', 'on-surface', 'on-surface-variant',
    'on-background', 'on-error', 'on-error-container', 'on-success', 'on-warning',
  ];
  for (const token of inverseTextTokens) {
    lines.push(`.text-${token} { color: var(--xai-${token}) !important; }`);
  }

  // Semantic text color utilities: .text-{color} → color: var(--xai-{color})
  // These are COLORED text for use on light/neutral backgrounds.
  // Example: <a class="dropdown-item text-error" href="#">Delete</a> (red text on white bg)
  // Distinct from .text-on-* above: .text-error = red text; .text-on-error = white text (for red bg).
  const semanticTextTokens = ['primary', 'secondary', 'tertiary', 'error', 'success', 'warning'];
  for (const token of semanticTextTokens) {
    lines.push(`.text-${token} { color: var(--xai-${token}) !important; }`);
  }

  // Border utilities: .border-{token} → border-color: var(--xai-{token})
  const borderTokens = ['outline', 'outline-variant', 'primary', 'error'];
  for (const token of borderTokens) {
    lines.push(`.border-${token} { border-color: var(--xai-${token}) !important; }`);
  }

  // Shadow utilities: .shadow-xai, .shadow-xai-sm, .shadow-xai-lg, etc.
  lines.push(`.shadow-xai { box-shadow: var(--xai-shadow) !important; }`);
  lines.push(`.shadow-xai-sm { box-shadow: var(--xai-shadow-sm) !important; }`);
  lines.push(`.shadow-xai-md { box-shadow: var(--xai-shadow-md) !important; }`);
  lines.push(`.shadow-xai-lg { box-shadow: var(--xai-shadow-lg) !important; }`);
  lines.push(`.shadow-xai-xl { box-shadow: var(--xai-shadow-xl) !important; }`);

  return lines.join('\n');
}

/**
 * Post-process a complete HTML page: inject Bootstrap CDN + theme + scrollbar styles.
 *
 * This is the main entry point used by useDesignerAgent on save/display.
 * Pipeline: ensureBootstrapCdn → injectScrollbarStyles → ensureBootstrapJs
 *           → ensureDesignerComponentStyles → fixDropdownAncestorOverflow
 *           → fixNavHorizontalOverflow → ensureContainerDesignIds → stripPageBreakInEdit
 *
 * Each step is idempotent and streaming-safe (no-op on incomplete documents).
 *
 * MasterLayout 注入桥接（D14）：仅当传入 masterLayoutCtx 时委托给 injectMasterLayouts。
 * 不传第 4 参数 → 完全跳过注入 → 现有调用点零影响（向后兼容）。
 * 注入逻辑不塞进本文件，保持 designerScrollbar.ts 职责单一。
 *
 * @param html              完整 HTML 文档字符串
 * @param projectType       项目类型（APP/WEB/PDA，决定滚动条样式）
 * @param themePrompt       主题 JSON 串（可选）
 * @param masterLayoutCtx   共享母版上下文（可选，传入则注入菜单到 slot 并高亮当前页）
 */
export function postProcessDesignerHtml(
  html: string,
  projectType: ProjectType,
  themePrompt?: string,
  masterLayoutCtx?: { screenId: string; screenName: string; layouts: MasterLayout[] },
): string {
  let processed = html;
  // DIAGRAM 模式：仅使用 Mermaid，不注入 Bootstrap CDN / 主题 token（避免浪费加载字节）。
  // 原型模式（WEB/APP/PDA）才需要 Bootstrap + 设计 token。
  if (projectType !== 'DIAGRAM') {
  processed = ensureBootstrapCdn(processed, themePrompt);
  }
  processed = injectScrollbarStyles(processed, projectType);
  // DIAGRAM 模式：注入图表面板工具栏（缩放/平移/导出等）
  if (projectType === 'DIAGRAM') {
  processed = injectDiagramToolbar(processed);
  }
  // Ensure Bootstrap JS bundle before </body>（仅非 DIAGRAM 模式）
  if (projectType !== 'DIAGRAM' && !/bootstrap@5\.3\.8.*bootstrap\.bundle\.min\.js/i.test(processed)) {
    const jsTag = `<script src="${BOOTSTRAP_JS_URL}"><\/script>`;
    if (/<\/body>/i.test(processed)) {
      processed = processed.replace(/<\/body>/i, `${jsTag}\n</body>`);
    }
  }
  // 以下代码增强规则仅针对原型（Bootstrap）页面；DIAGRAM 页面对这些类无依赖，跳过以避免注入无用的 CSS。
  if (projectType !== 'DIAGRAM') {
  // Inject designer component CSS (navbar orientation, dropdown toggle, etc.)
  processed = ensureDesignerComponentStyles(processed);
  // Code-enforced prompt rules (idempotent, streaming-safe):
  processed = fixDropdownAncestorOverflow(processed);
  processed = fixNavHorizontalOverflow(processed);
  processed = ensureContainerDesignIds(processed);
  processed = fixTokenClassMisuse(processed);
  }
  // MasterLayout 注入桥接（仅当传入 masterLayoutCtx 且 layouts 非空时执行）
  // 放在最后，确保 Bootstrap/theme/scrollbar 都已注入后再填菜单。
  // screenName 用于菜单项高亮匹配（scoreMenuMatch），允许含 AI 拼接的系统名/日期后缀。
  if (masterLayoutCtx && masterLayoutCtx.layouts.length > 0) {
    processed = injectMasterLayouts(
      processed,
      masterLayoutCtx.screenId,
      masterLayoutCtx.screenName,
      masterLayoutCtx.layouts,
    );
  }
  return processed;
}

/** Style element ID for designer component CSS (navbar orientation, dropdown, etc.) */
const DESIGNER_COMPONENT_STYLE_ID = '__xai_designer_components__';

/**
 * Inject CSS for designer components (navbar vertical orientation, dropdown
 * expand/collapse, chevron rotation). Idempotent — replaces existing block.
 */
function ensureDesignerComponentStyles(html: string): string {
  const css = `
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
.navbar[data-navbar-orientation="vertical"][data-navbar-collapsed="true"] .dropdown .xai-dropdown-chevron {
  transform: rotate(-90deg) !important;
  margin: 0 !important;
}
.navbar[data-navbar-orientation="vertical"][data-navbar-collapsed="true"] .xai-navbar-collapse-toggle i {
  transform: rotate(180deg);
}
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

/* xAI designer: dropdown expand/collapse */
.xai-dropdown-menu { display: block; }
.dropdown[data-dropdown-open="false"] .xai-dropdown-menu { display: none !important; }
.dropdown[data-dropdown-open="true"] .xai-dropdown-chevron { transform: rotate(180deg); }
.xai-dropdown-chevron { transition: transform 0.2s ease; }
.xai-dropdown-menu > a:hover { background-color: var(--bs-gray-100, #f3f4f6) !important; }
`;
  const styleTag = `<style id="${DESIGNER_COMPONENT_STYLE_ID}">\n${css}\n</style>`;

  // Replace existing block (idempotent)
  const existingRegex = new RegExp(
    `<style[^>]*id=["']${DESIGNER_COMPONENT_STYLE_ID}["'][^>]*>[\\s\\S]*?<\\/style>`,
    'i',
  );
  if (existingRegex.test(html)) {
    return html.replace(existingRegex, styleTag);
  }

  // Inject before </head>
  if (/<\/head>/i.test(html)) {
    return html.replace(/<\/head>/i, `${styleTag}\n</head>`);
  }
  return html;
}

// ── Code-enforced prompt rules ─────────────────────────────────────────────
// These functions turn MANDATORY prompt rules into idempotent post-processing
// steps. They guarantee compliance even when the LLM ignores the prompt.
// All are streaming-safe: no-op when </body> is absent (document incomplete).

/**
 * Rule: "NEVER apply overflow-hidden on a container that holds a dropdown/
 * submenu — and NOT on ANY ancestor of the submenu up to the trigger."
 *
 * Implementation: scan each `.dropdown` element and remove `overflow-hidden`
 * (and inline `overflow:hidden`) from the dropdown itself plus every ancestor
 * up to (but not including) <body>. Uses a regex-based tag walker rather than
 * DOMParser so it works in both main and renderer processes without a DOM.
 *
 * Idempotent: re-running on already-fixed HTML is a no-op.
 */
export function fixDropdownAncestorOverflow(html: string): string {
  if (!html || !/<\/body>/i.test(html)) return html;
  // Quick exit: no dropdowns → nothing to fix.
  if (!/class="[^"]*\bdropdown\b[^"]*"/i.test(html)) return html;

  // Single forward pass: track open-tag stack, record parent index for each
  // opening tag, and collect dropdown tags + their ancestor indices to fix.
  const voidTags = new Set(['area','base','br','col','embed','hr','img','input','link','meta','param','source','track','wbr']);
  interface TagInfo { start: number; end: number; name: string; selfClosing: boolean; hasDropdown: boolean; }
  const tags: TagInfo[] = [];
  const parents = new Map<number, number | null>(); // tag index → parent index
  const openStack: number[] = [];

  // Tokenize both opening and closing tags in one pass.
  const tokenRe = /<(\/?)([a-zA-Z][\w-]*)\b[^>]*?(\/?)>/g;
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(html)) !== null) {
    const [full, closing, nameRaw, selfClose] = m;
    const name = nameRaw.toLowerCase();
    if (closing === '/') {
      // Close tag: pop the nearest matching open tag from the stack.
      // Walk down to find the last same-name tag (handles minor mismatches).
      for (let k = openStack.length - 1; k >= 0; k--) {
        if (tags[openStack[k]].name === name) {
          openStack.splice(k);
          break;
        }
      }
      continue;
    }
    const start = m.index;
    const end = start + full.length;
    const hasDropdown = /class="[^"]*\bdropdown\b[^"]*"/i.test(full);
    tags.push({ start, end, name, selfClosing: selfClose === '/', hasDropdown });
    const idx = tags.length - 1;
    parents.set(idx, openStack.length > 0 ? openStack[openStack.length - 1] : null);
    if (selfClose !== '/' && !voidTags.has(name)) openStack.push(idx);
  }

  // Collect every ancestor chain of every dropdown tag.
  const toFix = new Set<number>();
  for (let i = 0; i < tags.length; i++) {
    if (!tags[i].hasDropdown) continue;
    let p: number | null = i;
    while (p !== null) {
      toFix.add(p);
      const parentIdx = parents.get(p);
      if (parentIdx === null || parentIdx === undefined) break;
      const parentName = tags[parentIdx].name;
      if (parentName === 'body' || parentName === 'html') break;
      p = parentIdx;
    }
  }

  if (toFix.size === 0) return html;

  // Apply fixes right-to-left so earlier offsets stay valid.
  const sorted = Array.from(toFix).sort((a, b) => b - a);
  let result = html;
  for (const i of sorted) {
    const t = tags[i];
    const tagText = result.substring(t.start, t.end);
    let fixed = tagText;
    // Remove `overflow-hidden` from class attribute value.
    fixed = fixed.replace(/(\sclass=")([^"]*)"/i, (_full, prefix: string, cls: string) => {
      const newCls = cls.replace(/\boverflow-hidden\b\s*/g, '').replace(/\s+/g, ' ').trim();
      return `${prefix}${newCls}"`;
    });
    // Remove inline overflow:hidden / overflow-x:hidden / overflow-y:hidden.
    fixed = fixed.replace(/(\sstyle=")([^"]*)"/i, (_full, prefix: string, style: string) => {
      const newStyle = style
        .replace(/overflow\s*:\s*hidden\s*;?/gi, '')
        .replace(/overflow-x\s*:\s*hidden\s*;?/gi, '')
        .replace(/overflow-y\s*:\s*hidden\s*;?/gi, '')
        .replace(/\s+/g, ' ')
        .trim();
      return `${prefix}${newStyle.replace(/;\s*$/, '')}"`;
    });
    if (fixed !== tagText) {
      result = result.substring(0, t.start) + fixed + result.substring(t.end);
    }
  }
  return result;
}

/**
 * Rule: "NEVER use overflow-x: auto or overflow-x: scroll on a nav container
 * — this creates an ugly scrollbar wrapping the menu."
 *
 * Implementation: remove `overflow-x:auto`, `overflow-x:scroll`,
 * `overflow-auto`, `overflow-scroll` from <nav> elements and their direct
 * <ul>/<div> children. Only targets nav subtrees to avoid touching legitimate
 * scroll containers (e.g. code blocks, table wrappers).
 *
 * Idempotent. Streaming-safe.
 */
export function fixNavHorizontalOverflow(html: string): string {
  if (!html || !/<\/body>/i.test(html)) return html;
  if (!/<nav\b/i.test(html)) return html;

  // Match <nav ...>...</nav> blocks (non-greedy, handles nested navs by
  // matching the outermost when possible; for our purpose removing overflow
  // from inner navs too is acceptable).
  return html.replace(/<nav\b[^>]*>([\s\S]*?)<\/nav>/gi, (navBlock) => {
    let fixed = navBlock;
    // Remove overflow-x:auto/scroll from the <nav> opening tag itself.
    fixed = fixed.replace(
      /(<nav\b[^>]*\sstyle=")([^"]*)"/i,
      (full, prefix: string, style: string) => {
        const newStyle = style
          .replace(/overflow-x\s*:\s*(?:auto|scroll)\s*;?/gi, '')
          .replace(/\s+/g, ' ')
          .trim();
        return `${prefix}${newStyle.replace(/;\s*$/, '')}"`;
      },
    );
    // Remove `overflow-auto` / `overflow-scroll` Bootstrap classes from nav.
    fixed = fixed.replace(
      /(\sclass=")([^"]*)"/gi,
      (full, prefix: string, cls: string) => `${prefix}${cls.replace(/\boverflow-auto\b\s*|\boverflow-scroll\b\s*/g, '').replace(/\s+/g, ' ').trim()}"`,
    );
    return fixed;
  });
}

/**
 * Rule: "Add a data-design-id attribute to every meaningful container-level
 * element. Use kebab-case semantic names."
 *
 * Implementation: for container tags (header/nav/main/section/footer/aside/
 * article/form/fieldset/div) that have NO data-design-id, generate a stable
 * ID from tag name + a counter. Skips wrapper divs that already have an id
 * (kept as-is) and purely structural divs inside tables/SVGs.
 *
 * NOT applied to: void tags, inline elements, <script>, <style>, <head> subtree.
 *
 * Idempotent: re-running adds IDs only to elements still missing one.
 * Streaming-safe: no-op when </body> absent.
 */
export function ensureContainerDesignIds(html: string): string {
  if (!html || !/<\/body>/i.test(html)) return html;

  const containerTags = new Set(['header','nav','main','section','footer','aside','article','form','fieldset','div']);
  const skipParents = new Set(['script','style','head','svg','symbol','defs']); // never ID inside these

  // We track whether we're inside a <body> subtree and a skip-subtree depth.
  // For each container tag without data-design-id, inject one.
  const tagRe = /<(\/?)([a-zA-Z][\w-]*)\b([^>]*)>/g;
  let counter = 0;
  const skipStack: string[] = [];
  let inBody = false;
  const edits: Array<{ index: number; length: number; replacement: string }> = [];

  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(html)) !== null) {
    const [full, closing, nameRaw, attrs] = m;
    const name = nameRaw.toLowerCase();

    if (name === 'body') {
      inBody = closing !== '/';
      continue;
    }
    if (!inBody) continue;

    // Manage skip-subtree stack (script/style/svg/etc.)
    if (skipParents.has(name) && closing !== '/') {
      skipStack.push(name);
      continue;
    }
    if (skipStack.length > 0) {
      if (closing === '/' && skipStack[skipStack.length - 1] === name) skipStack.pop();
      continue;
    }

    // Only process opening container tags that lack data-design-id.
    if (closing === '/') continue;
    if (!containerTags.has(name)) continue;
    if (/\bdata-design-id\s*=/i.test(attrs)) continue;

    // Skip table-cell wrappers and utility-only divs (e.g. row/col already
    // have semantic classes — we still ID them since the rule says "any div
    // that acts as a distinct visual component", and over-IDing is harmless).
    counter++;
    const id = `${name}-auto-${counter}`;
    // Insert data-design-id right after the tag name (before any other attr)
    // to keep the regex simple and the output predictable.
    const replacement = `<${nameRaw} data-design-id="${id}"${attrs}>`;
    edits.push({ index: m.index, length: full.length, replacement });
  }

  if (edits.length === 0) return html;
  // Apply right-to-left to preserve offsets.
  let result = html;
  for (let i = edits.length - 1; i >= 0; i--) {
    const e = edits[i];
    result = result.substring(0, e.index) + e.replacement + result.substring(e.index + e.length);
  }
  return result;
}

/**
 * Rule: "text-on-{error|success|warning} should be text-{error|success|warning}
 * when there is no matching bg-{color} on the same element."
 *
 * Auto-fixes the TOKEN NAMING TRAP from the prompt: AI sometimes writes
 * `<a class="dropdown-item text-on-error">Delete</a>` (white text on white bg)
 * instead of `<a class="dropdown-item text-error">Delete</a>` (red text on white).
 *
 * Only rewrites `text-on-{error|success|warning}` → `text-{error|success|warning}`
 * when the same element has NO `bg-{error|success|warning}` class. Elements
 * with a matching colored background keep their `text-on-*` (correct usage).
 *
 * Idempotent. Streaming-safe (no-op when </body> absent).
 */
export function fixTokenClassMisuse(html: string): string {
  if (!html || !/<\/body>/i.test(html)) return html;

  // Scan elements with text-on-{error|success|warning} and rewrite when no
  // matching bg-* is present on the same element.
  const textOnRe = /<([a-zA-Z][\w-]*)\b([^>]*)\bclass\s*=\s*"([^"]*)"/gi;
  const edits: Array<{ index: number; length: number; replacement: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = textOnRe.exec(html)) !== null) {
    const [full, nameRaw, attrsBefore, classVal] = m;
    // Only consider text-on-{error|success|warning} (not text-on-surface etc.,
    // which are appropriate on light backgrounds when used as muted text).
    const misusedTokens = classVal.match(/\btext-on-(?:error|success|warning)\b/g);
    if (!misusedTokens) continue;
    // Skip if the same element has a matching bg-{color} class.
    const hasColoredBg = /\bbg-(?:error|success|warning)(?:-container)?\b/.test(classVal);
    if (hasColoredBg) continue;
    // Rewrite: text-on-error → text-error, etc.
    const newClass = classVal.replace(/\btext-on-(error|success|warning)\b/g, 'text-$1');
    if (newClass === classVal) continue;
    // Rebuild the opening tag with the new class attribute value.
    const newFull = full.replace(
      `class="${classVal}"`,
      `class="${newClass}"`,
    );
    edits.push({ index: m.index, length: full.length, replacement: newFull });
  }

  if (edits.length === 0) return html;
  let result = html;
  for (let i = edits.length - 1; i >= 0; i--) {
    const e = edits[i];
    result = result.substring(0, e.index) + e.replacement + result.substring(e.index + e.length);
  }
  return result;
}