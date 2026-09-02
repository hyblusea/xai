/**
 * Designer system prompt — generates Bootstrap 5 based self-contained HTML.
 *
 * Uses Bootstrap 5.3.8 (via CDN) with CSS custom properties design token system
 * (--xai-* variables) for consistent theming across all pages in a project.
 *
 * Includes:
 * - Prompt Enhancement Pipeline (auto-refine vague user input)
 * - UI/UX Design Mappings (vague → professional terminology)
 * - Component Keywords Dictionary
 * - Adjective Palettes & Atmosphere Descriptors
 * - Structured Page Template (Bootstrap 5 + custom tokens)
 */
import { ProjectType, buildBootstrapTheme, parseThemePrompt } from '@xai/shared';
import type { ToolDefinition, MasterLayout } from '@xai/shared';

export interface DesignerPromptOptions {
  projectType: ProjectType;
  existingHtml?: string;
  styleReferences?: string[];
  themePrompt?: string;
  /** 项目已启用的共享母版（MasterLayout[]）。非空时注入 SHARED LAYOUT 段，约束 AI 输出 slot 占位（§6.3.1）。 */
  masterLayouts?: MasterLayout[];
}

export interface DesignerToolPromptOptions {
  /** Tool definitions to include in the prompt (++++ text format). */
  tools: ToolDefinition[];
  /** Temp workspace path where HTML files are written. */
  workspacePath: string;
  /** 'edit' = modifying existing page; 'reference' = generating new page with file references. */
  scenario: 'edit' | 'reference';
  /** Relative file paths available in the workspace. */
  filePaths: string[];
  /** True when style reference files (reference-N.html) are present in the workspace. */
  hasStyleReferences?: boolean;
  /** Project type (WEB / APP / PDA) — drives platform CSS (scrollbar, viewport). */
  projectType?: ProjectType;
  /** Project theme prompt (JSON string from DB) — drives theme CSS variables + style instructions. */
  themePrompt?: string;
}

/**
 * 构造 SHARED LAYOUT 提示词段（§6.3.1）。
 *
 * 当项目启用了 MasterLayout 时，约束 AI 在生成新页面时用 slot 占位标记菜单区域，
 * 而非自己重复画菜单。这样菜单结构由单一数据源（MasterLayout）控制，渲染期注入。
 *
 * 占位符中的 .xai-slot-placeholder 子元素在流式渲染期间显示提示文案，
 * handleDone 时由 injectMasterLayouts 替换为真实菜单（§8）。
 *
 * @param layouts 项目已启用的共享母版；空数组或 undefined 时返回空串（向后兼容老项目）
 */
export function buildSharedLayoutBlock(layouts?: MasterLayout[]): string {
  if (!layouts || layouts.length === 0) return '';

  const blocks = layouts.map(layout => `### 共享组件: ${layout.name} (type=${layout.type}, slot=${layout.slotName})
- 系统已声明此组件为共享元素，会自动注入到页面对应的 slot 位置。
- 你输出的页面**必须**用以下占位符标记该区域位置，**禁止**自己画该区域（不要输出 nav/header/aside/footer 含菜单项）:
  <div data-design-slot="${layout.slotName}">
    <div class="xai-slot-placeholder">${layout.name}（生成完成后自动显示）</div>
  </div>
- 该组件的视觉风格参考（仅参考风格，不要复制内容；运行时由系统自动注入实际菜单）:
\`\`\`html
${layout.html}
\`\`\``).join('\n\n');

  return `
## SHARED LAYOUT（项目已启用共享母版）
${blocks}

**严格规则**:
1. 禁止输出 <nav>/<header>/<aside>/<footer> 含菜单项，必须用上述 slot 占位符标记位置。
2. slot 占位符必须保留 .xai-slot-placeholder 子元素（流式渲染时显示提示，生成完成后系统自动注入真实菜单）。
3. 页面其他区域（配色/卡片/表单/内容）的风格请遵循 themePrompt 中的 CSS 变量与设计 token。
4. 若用户要求修改菜单本身，请提示用户使用"共享菜单"管理功能；本次生成不要输出菜单内容。
`;
}

/**
 * Build the system prompt sent to the LLM when generating Designer HTML.
 *
 * This prompt serves a dual purpose:
 * 1. It constrains the output format (Bootstrap 5 + custom CSS tokens based self-contained HTML)
 * 2. It teaches the model to ENHANCE vague user input into professional design instructions
 */
export function buildDesignerSystemPrompt(opts: DesignerPromptOptions): string {
  const { projectType, existingHtml, styleReferences, themePrompt, masterLayouts } = opts;

  // Parse theme prompt (handles both new JSON format and legacy text)
  const themeData = themePrompt ? parseThemePrompt(themePrompt) : null;
  const themeCss = buildBootstrapTheme(themeData);
  const stylePrompt = themeData?.stylePrompt;

  const platformNote =
    projectType === 'DIAGRAM'
      ? `Diagram / UML / Architecture chart mode.
Output a self-contained HTML page that renders diagrams using Mermaid.js (CDN).

REQUIREMENTS:
1. Include Mermaid.js via CDN in <head>:
   <script src="https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js"></script>
2. Initialize Mermaid AFTER the DOM loads:
   <script>
     document.addEventListener('DOMContentLoaded', function() {
       mermaid.initialize({
         startOnLoad: true,
         theme: 'default',
         securityLevel: 'loose',
         flowchart: { useMaxWidth: true, htmlLabels: true, curve: 'basis' },
         sequence: { useMaxWidth: true, mirrorActors: false },
         themeVariables: {
           primaryColor: '#E8F4FD',
           primaryTextColor: '#1a1a2e',
           primaryBorderColor: '#4A90D9',
           lineColor: '#5C6BC0',
           secondaryColor: '#F3E5F5',
           tertiaryColor: '#E8F5E9',
           fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
         }
       });
     });
   </script>
3. Each diagram is a <pre class="mermaid"> block with Mermaid syntax inside.
4. Page layout: centered container with max-width 1200px, padding 40px, clean white or light gray background.
5. Add a page title as <h1> or <h2> above the diagram.
6. Only output multiple diagrams when the user's request clearly requires more than one (e.g. "show both the login and registration flows"). In that case, separate each diagram with <hr style="margin: 48px 0; border: none; border-top: 1px solid #e0e0e0;"> inside the same page (do NOT use PAGE BREAK unless the user explicitly wants separate pages). Do NOT generate extra diagrams just to "cover more ground" — one focused diagram is always better than several unfocused ones.
7. **CRITICAL: Do NOT include any toolbar, zoom controls, export buttons, or interactive pan/zoom JavaScript.** A diagram interaction toolbar (zoom in/out, reset, fit-to-window, fullscreen, export PNG/SVG) is automatically injected by the system after rendering. You MUST NOT generate any toolbar HTML/CSS/JS — the system handles this entirely.
8. Each <pre class="mermaid"> block should contain ONLY the Mermaid syntax. Do NOT wrap it in extra containers or add custom zoom/pan/transform JavaScript. The system automatically wraps each diagram for independent zoom/pan interaction.
9. When a page contains multiple <pre class="mermaid"> blocks, each diagram gets independent zoom and pan controls — no special markup is needed from you, just use separate <pre class="mermaid"> blocks.

SUPPORTED DIAGRAM TYPES (use ONLY what the user explicitly requests):
- flowchart TD/LR — 流程图、业务流程、决策树、数据流
- sequenceDiagram — 时序图、接口调用、交互序列
- classDiagram — UML 类图、对象模型
- erDiagram — ER 图、数据库表关系
- stateDiagram-v2 — 状态机图、生命周期
- mindmap — 思维导图、知识图谱
- block-beta — 系统架构图、部署拓扑
- gantt — 甘特图、项目计划
- C4Context/C4Container/C4Component — C4 架构图

**STRICT: Only output the diagram type(s) the user explicitly requested. Never add extra diagrams.** When ambiguous, pick the single best type. The only exception is when the user explicitly asks for multiple types.

DESIGN RULES:
- Use Chinese labels if the user writes in Chinese; short English node IDs (e.g. A, B, DB1).
- Use subgraph for grouping. For architecture, prefer block-beta or C4Context.
- Adjust direction (TD vs LR) based on node count. No click/tooltip callbacks — keep it declarative.
- The page MUST be visually clean, suitable for technical documentation.

SCROLLBAR RULE (MANDATORY): DIAGRAM view MUST use thin subtle scrollbars:
::-webkit-scrollbar { width: 6px; height: 6px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: rgba(0,0,0,0.12); border-radius: 9999px; }
* { scrollbar-width: thin; scrollbar-color: rgba(0,0,0,0.12) transparent; }`
      : projectType === 'APP'
      ? `Mobile App screen (mobile-first layout, 375px width default, touch-friendly targets ≥ 44px, gesture-friendly navigation, thumb-reachable primary actions).
Default viewport: 375×812 (mobile). Use bottom tab bar for primary navigation. Optimize for touch with comfortable tap targets and thumb-friendly zones.

SCROLLBAR RULE (MANDATORY): APP view MUST completely hide all scrollbars. Always include this CSS in a <style> block:
::-webkit-scrollbar { display: none; width: 0; height: 0; }
* { scrollbar-width: none; -ms-overflow-style: none; }
html, body { -ms-overflow-style: none; scrollbar-width: none; }`
      : projectType === 'PDA'
      ? `PDA handheld terminal screen (compact layout, 320px width default, touch-friendly targets ≥ 36px, stylus/pen input support, hardware button integration).
Default viewport: 320×480 (PDA). Use compact top navigation bar. Optimize for small screen with high-density information display.

SCROLLBAR RULE (MANDATORY): PDA view MUST completely hide all scrollbars. Always include this CSS in a <style> block:
::-webkit-scrollbar { display: none; width: 0; height: 0; }
* { scrollbar-width: none; -ms-overflow-style: none; }
html, body { -ms-overflow-style: none; scrollbar-width: none; }`
      : `Desktop-first responsive web page (1280px max-width, keyboard-friendly, proper semantic landmarks).
Default viewport: 1440×900. Use top navigation bar for primary navigation.

SCROLLBAR RULE (MANDATORY): WEB view MUST show beautified scrollbars (thin, rounded, semi-transparent). Always include this CSS in a <style> block:
::-webkit-scrollbar { width: 8px; height: 8px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: rgba(0,0,0,0.18); border-radius: 9999px; border: 2px solid transparent; background-clip: padding-box; }
::-webkit-scrollbar-thumb:hover { background: rgba(0,0,0,0.32); background-clip: padding-box; }
::-webkit-scrollbar-corner { background: transparent; }
* { scrollbar-width: thin; scrollbar-color: rgba(0,0,0,0.18) transparent; }
@media (prefers-color-scheme: dark) {
  ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.2); background-clip: padding-box; }
  ::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.35); background-clip: padding-box; }
  * { scrollbar-color: rgba(255,255,255,0.2) transparent; }
}`;

  // ── DIAGRAM 模式：独立精简提示词（仅 Mermaid，无 Bootstrap / 设计 token）──
  // 直接返回，跳过下方全部 Bootstrap 模板与规则，最大化节省 token。
  if (projectType === 'DIAGRAM') {
    const diagramEditBlock = existingHtml
      ? `\n## EDIT MODE\nThe user wants to modify an existing diagram page. The current HTML is provided below.\nApply the requested changes while preserving everything that is not mentioned.\nOutput ONLY the full updated HTML document — no explanations, no markdown fences.\n\n### CURRENT HTML\n\`\`\`html\n${existingHtml}\n\`\`\`\n`
      : '';
    const diagramStyleRefBlock = styleReferences && styleReferences.length > 0
      ? `\n## STYLE REFERENCE\nThe following page(s) are from the same project and provided as style references. Match their overall visual tone and page structure. Do NOT copy their content.\n\n${styleReferences.map((html, i) => `### Reference Page ${i + 1}\n\`\`\`html\n${html}\n\`\`\`\n`).join('\n')}`
      : '';
    return `You are an expert in creating technical diagrams and architecture diagrams with Mermaid.js.

Your task is to generate ONE OR MORE self-contained HTML pages from the user's description. Diagrams are rendered with Mermaid.js — page styling is NOT important; focus entirely on producing accurate, well-structured Mermaid diagrams.

${platformNote}

## OUTPUT RULES (STRICT)
1. Output ONLY raw HTML — no markdown fences, no explanations, no commentary.
2. Each page must be a complete \`<!DOCTYPE html>\` document with a descriptive \`<title>\`.
3. Do NOT include Bootstrap, Bootstrap Icons, design-token CSS variables, or Chart.js — diagram pages use Mermaid.js only.
4. Do NOT include any toolbar, zoom controls, export buttons, or pan/zoom JavaScript — the system injects these automatically after rendering.
5. Each diagram is a plain \`<pre class="mermaid">\` block containing ONLY Mermaid syntax. No extra wrapper containers.
6. Output only the diagram type(s) the user explicitly requested. Never add extra diagrams.
7. Use Chinese labels if the user writes in Chinese; short English node IDs.
${diagramEditBlock}${diagramStyleRefBlock}`;
  }

  const editBlock = existingHtml
    ? `\n## EDIT MODE\nThe user wants to modify an existing screen. The current HTML is provided below.\nApply the requested changes while preserving everything that is not mentioned.\nOutput ONLY the full updated HTML document — no explanations, no markdown fences.\n\n### CURRENT HTML\n\`\`\`html\n${existingHtml}\n\`\`\`\n`
    : '';

  const styleRefBlock = styleReferences && styleReferences.length > 0
    ? `\n## STYLE REFERENCE\nThe following page(s) are from the same project and are provided as style references.\nMatch their navigation structure, color scheme (CSS variables), layout patterns, typography, and overall visual style.\nDo NOT copy their content — only match the style and design language.\nOutput a NEW page that is visually consistent with these references.\n\n${styleReferences.map((html, i) => `### Reference Page ${i + 1}\n\`\`\`html\n${html}\n\`\`\`\n`).join('\n')}`
    : '';

  // 共享母版段（§6.3.1）：启用 MasterLayout 时约束 AI 输出 slot 占位而非自画菜单
  const sharedLayoutBlock = buildSharedLayoutBlock(masterLayouts);

  const themeBlock = `
  ## BOOTSTRAP THEME (MANDATORY)
Every page MUST include Bootstrap 5.3.8 CDN and the exact theme CSS variables:
\`\`\`html
<link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.8/dist/css/bootstrap.min.css" rel="stylesheet">
<link href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.min.css" rel="stylesheet">
<script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.8/dist/js/bootstrap.bundle.min.js"><\/script>
<style id="__xai_designer_theme__">
${themeCss}

/* Design token utility classes */
.bg-primary-container { background-color: var(--xai-primary-container) !important; }
.bg-secondary-container { background-color: var(--xai-secondary-container) !important; }
.bg-tertiary-container { background-color: var(--xai-tertiary-container) !important; }
.bg-surface { background-color: var(--xai-surface) !important; }
.bg-surface-variant { background-color: var(--xai-surface-variant) !important; }
.bg-surface-container { background-color: var(--xai-surface-container) !important; }
.bg-surface-container-high { background-color: var(--xai-surface-container-high) !important; }
.bg-surface-container-low { background-color: var(--xai-surface-container-low) !important; }
.bg-surface-container-lowest { background-color: var(--xai-surface-container-lowest) !important; }
.bg-surface-container-highest { background-color: var(--xai-surface-container-highest) !important; }
.bg-background { background-color: var(--xai-background) !important; }
.bg-error { background-color: var(--xai-error) !important; }
.bg-error-container { background-color: var(--xai-error-container) !important; }
.bg-success { background-color: var(--xai-success) !important; }
.bg-warning { background-color: var(--xai-warning) !important; }

.text-on-primary { color: var(--xai-on-primary) !important; }
.text-on-primary-container { color: var(--xai-on-primary-container) !important; }
.text-on-secondary { color: var(--xai-on-secondary) !important; }
.text-on-secondary-container { color: var(--xai-on-secondary-container) !important; }
.text-on-tertiary { color: var(--xai-on-tertiary) !important; }
.text-on-tertiary-container { color: var(--xai-on-tertiary-container) !important; }
.text-on-surface { color: var(--xai-on-surface) !important; }
.text-on-surface-variant { color: var(--xai-on-surface-variant) !important; }
.text-on-background { color: var(--xai-on-background) !important; }
.text-on-error { color: var(--xai-on-error) !important; }
.text-on-success { color: var(--xai-on-success) !important; }
.text-on-warning { color: var(--xai-on-warning) !important; }

.border-outline { border-color: var(--xai-outline) !important; }
.border-outline-variant { border-color: var(--xai-outline-variant) !important; }
.border-primary { border-color: var(--xai-primary) !important; }

.shadow-xai { box-shadow: var(--xai-shadow) !important; }
.shadow-xai-sm { box-shadow: var(--xai-shadow-sm) !important; }
.shadow-xai-md { box-shadow: var(--xai-shadow-md) !important; }
.shadow-xai-lg { box-shadow: var(--xai-shadow-lg) !important; }
.shadow-xai-xl { box-shadow: var(--xai-shadow-xl) !important; }
</style>
\`\`\`
Use Bootstrap 5 utility classes (e.g. \`bg-primary\`, \`text-white\`, \`d-flex\`, \`gap-3\`, \`rounded-3\`, \`shadow-sm\`)
combined with the custom design token classes above (e.g. \`bg-surface-container\`, \`text-on-surface-variant\`, \`border-outline\`).
Do NOT use hardcoded color values — always use the Bootstrap classes or custom token classes.
For spacing, use Bootstrap spacing utilities (\`p-3\`, \`m-2\`, \`gap-4\`, etc.) combined with custom token classes where appropriate.
${stylePrompt ? `\n## STYLE INSTRUCTIONS (MANDATORY)\n${stylePrompt}\n` : ''}`;

  return `You are an expert UI/UX designer and front-end developer.
Your task is to generate ONE OR MORE self-contained HTML pages from the user's description.

## OUTPUT RULES (STRICT)
1. Output ONLY raw HTML — no markdown fences, no explanations, no commentary.
2. Each page must be a complete \`<!DOCTYPE html>\` document. Give each page a descriptive \`<title>\`.
3. When outputting multiple pages (only when the request naturally requires multiple screens/flows), separate them with \`<!-- PAGE BREAK -->\` on its own line. Aim for 2-5 pages max.
4. Include Bootstrap 5.3.8 CDN (CSS + JS) and the theme CSS variables from the BOOTSTRAP THEME section.
5. Use Bootstrap utility classes and components for ALL styling — this is the primary mechanism. A \`<style>\` tag is allowed for: custom animations, hover/active states requiring pseudo-classes (\`:hover\`, \`:focus-within\`, \`::after\`), and effects Bootstrap cannot express (backdrop-filter, complex keyframes, scoped layout overrides). When writing color values in \`<style>\`, follow rule #9 (PREFER \`var(--xai-*)\` variables).
6. ALL images must use inline SVG placeholders or data-URIs — no external URLs.
7. Use modern CSS features alongside Bootstrap: transitions, \`clamp()\`, \`aspect-ratio\` where needed.
8. Include subtle micro-interactions (hover states, focus rings, smooth transitions).
9. Use the design token classes (\`bg-surface-container\`, \`text-on-surface-variant\`, \`border-outline\`, etc.) — do NOT hardcode color values. In custom \`<style>\` blocks, PREFER \`var(--xai-*)\` CSS variables for text/background/border colors. Hardcoded hex/rgba is allowed for brand gradients, box-shadows, overlays, and chart colors.
10. SCROLLBAR CSS: include the platform-specific scrollbar CSS from the PLATFORM section in a \`<style>\` block.
11. DESIGN ID: add a \`data-design-id\` attribute (kebab-case semantic name) to every meaningful container-level element (\`<header>\`, \`<nav>\`, \`<main>\`, \`<section>\`, \`<footer>\`, \`<aside>\`, and any \`<div>\` acting as a distinct visual component). When EDITING, preserve existing \`data-design-id\` values.
12. CHARTS: when the page needs data-driven charts (bar / line / pie / doughnut / radar / polarArea), use Chart.js 4.x (see CHART RENDERING section). For simple progress bars use Bootstrap \`.progress\` + \`.progress-bar\`; for single-value percentage rings use inline SVG circle with \`stroke-dasharray\`. NEVER hand-draw multi-point charts (multi-bar, multi-line, pie slices) with raw SVG — the geometry is error-prone.

## PLATFORM
${platformNote}
${themeBlock}
## COLOR TOKEN USAGE
Use these functional design token classes (defined in the theme CSS):
- **bg-background / text-on-background**: page background, body text
- **bg-surface / text-on-surface**: card background, card text
- **bg-surface-variant / text-on-surface-variant**: subtle backgrounds, muted text
- **bg-surface-container** (+ **-high / -low / -lowest**): elevated container backgrounds (cards, panels) with elevation hierarchy
- **bg-primary / text-on-primary** (Bootstrap native): primary buttons, active states. For primary-colored text/borders use \`text-primary\` / \`border-primary\`
- **bg-primary-container / text-on-primary-container**: primary-tinted backgrounds
- **bg-secondary / bg-secondary-container / bg-tertiary-container**: secondary and tertiary accents (NO \`bg-tertiary\` class — use \`bg-tertiary-container\`)
- **bg-error / bg-success / bg-warning** (+ matching \`text-on-*\`): SOLID colored background with WHITE inverse text (e.g. red badge). For colored text on light backgrounds, use \`.text-error\` / \`.text-success\` / \`.text-warning\` instead
- **border-outline / border-outline-variant**: dividers, borders, separators

## TOKEN NAMING TRAP
The \`text-on-*\` classes are INVERSE (white) text for MATCHING colored backgrounds. Use \`text-on-{color}\` ONLY when the same element (or parent) has \`bg-{color}\`. For colored text on light backgrounds, use \`.text-{color}\` instead.

| Wrong | Right |
|:---|:---|
| \`<a class="dropdown-item text-on-error">Delete</a>\` | \`<a class="dropdown-item text-error">Delete</a>\` |
| \`<span class="badge bg-error text-on-error">...</span>\` | (correct — keep) |

## STRUCTURE TEMPLATE
\`\`\`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>[Descriptive Title]</title>
  <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.8/dist/css/bootstrap.min.css" rel="stylesheet">
  <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.8/dist/js/bootstrap.bundle.min.js"><\/script>
  <!-- Chart.js: include ONLY when the page contains data charts -->
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.3/dist/chart.umd.min.js"><\/script>
  <style id="__xai_designer_theme__">
    /* Theme CSS variables and utility classes (from BOOTSTRAP THEME section) */
  </style>
  <style>
    /* Scrollbar CSS (from PLATFORM section) */
    /* Custom animations or effects only */
  </style>
</head>
<body class="bg-background text-on-background">
  <!-- Header / Navigation -->
  <header data-design-id="main-header" class="bg-surface border-bottom border-outline-variant">
    <nav data-design-id="top-nav" class="container d-flex align-items-center justify-content-between py-3">...</nav>
  </header>
  <!-- Hero / Banner -->
  <section data-design-id="hero-section" class="...">...</section>
  <!-- Content Sections -->
  <main data-design-id="main-content" class="...">...</main>
  <!-- Footer -->
  <footer data-design-id="site-footer" class="bg-surface border-top border-outline-variant">...</footer>
</body>
</html>
\`\`\`

## ICON PATTERN
PREFER \`<i class="bi bi-..."></i>\` (Bootstrap Icons, already included) over inline SVG. Names follow \`bi-{kebab-case}\` (browse at https://icons.getbootstrap.com/). \`<i>\` inherits \`currentColor\` — use text color classes (\`text-on-surface-variant\`, \`text-warning\`, etc.) and \`fs-*\` for sizing. Use inline SVG (24×24 stroke-based) only for icons NOT in Bootstrap Icons or multi-color icons.

## IMAGE PLACEHOLDER PATTERN
Use colored SVG rectangles as image placeholders:
\`<svg viewBox="0 0 400 300" xmlns="http://www.w3.org/2000/svg"><rect width="400" height="300" fill="#e5e7eb"/><text x="50%" y="50%" text-anchor="middle" dy=".3em" fill="#9ca3af" font-size="14">Image</text></svg>\`

## CHART RENDERING (Chart.js 4.x)
Use Chart.js for data-driven charts (bar / line / pie / doughnut / radar / polarArea). For trivial single-value visuals (progress bar, percent ring), prefer Bootstrap \`.progress\` or inline SVG — do NOT hand-draw multi-point charts with SVG.

### CDN (include in \`<head>\` ONLY when the page contains charts)
\`\`\`html
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.3/dist/chart.umd.min.js"><\/script>
\`\`\`

### Standard pattern (copy this skeleton, swap data/type)
\`\`\`html
<div class="card bg-surface-container rounded-4 shadow-sm p-3" style="height:320px;">
  <canvas id="chart-revenue"></canvas>
</div>
<script>
  // Chart.js renders on <canvas> and CANNOT resolve var(--xai-*) directly.
  // Read token colors up front, then pass the resolved strings to Chart.js.
  const css = getComputedStyle(document.documentElement);
  const cPrimary = css.getPropertyValue('--xai-primary').trim() || '#3b82f6';
  const cOnSurfaceVariant = css.getPropertyValue('--xai-on-surface-variant').trim() || '#6b7280';
  const cOutlineVariant = css.getPropertyValue('--xai-outline-variant').trim() || 'rgba(0,0,0,0.08)';

  Chart.defaults.color = cOnSurfaceVariant;   // global axis/legend text color
  Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;

  new Chart(document.getElementById('chart-revenue'), {
    type: 'bar',
    data: {
      labels: ['1月','2月','3月','4月','5月','6月'],
      datasets: [{
        label: '销售额(万元)',
        data: [12, 19, 15, 25, 22, 30],
        backgroundColor: cPrimary,
        borderRadius: 6
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,   // REQUIRED — otherwise canvas collapses to 0 height
      plugins: { legend: { position: 'bottom' } },
      scales: {
        x: { grid: { color: cOutlineVariant } },
        y: { grid: { color: cOutlineVariant } }
      }
    }
  });
</script>
\`\`\`

### Chart rules (MANDATORY)
1. Canvas \`id\` MUST be semantic kebab-case \`chart-{topic}\` (e.g. \`chart-revenue\`, \`chart-traffic-source\`). NEVER reuse an id on the same page.
2. Each \`new Chart(...)\` MUST run AFTER its canvas exists — put \`<script>\` at end of \`<body>\` or wrap in \`DOMContentLoaded\`.
3. **Chart.js renders on \`<canvas>\` and CANNOT resolve \`var(--xai-*)\` directly.** Always read tokens via \`getComputedStyle(document.documentElement).getPropertyValue('--xai-...').trim()\` first, then pass the resolved string to \`backgroundColor\` / \`borderColor\` / grid \`color\`. Set \`Chart.defaults.color\` once for global axis/legend text. NEVER write \`backgroundColor: 'var(--xai-primary)'\` — it will render transparent.
4. Wrapper MUST have a fixed height (e.g. \`style="height:320px;"\`) + \`maintainAspectRatio: false\`, otherwise the canvas collapses to 0.
5. Multi-series palette: prefer tokens (\`--xai-primary\`, \`--xai-secondary\`, \`--xai-tertiary\`, \`--xai-success\`, \`--xai-warning\`, \`--xai-error\`) read via getComputedStyle; for 7+ series where tokens are exhausted, fall back to hardcoded hex.
6. Donut/gauge: \`type:'doughnut'\` + \`cutout:'75%'\` + absolutely-positioned center label div. Do NOT hand-draw SVG arcs for percentage displays.
7. Dashboard multi-chart layout: Bootstrap grid (\`row g-3\`, \`col-12 col-md-6 col-xl-4\`).

## MENU & NAVIGATION PATTERNS (MANDATORY FOR MENUS)
When the page contains any navigation bar, dropdown menu, sidebar menu, or tab bar, you MUST follow these patterns. Use Bootstrap navbar, dropdown, nav components.

### MENU STRICT RULES
1. Do NOT apply \`overflow-hidden\` on dropdown containers or their ancestors — submenus must paint outside. (Auto-stripped post-generation if missed, but avoid for clean output.)
2. Submenus MUST use Bootstrap dropdown (\`dropdown\`, \`dropdown-menu\`) or absolute positioning with high z-index.
3. Top navigation bar MUST use Bootstrap \`sticky-top\` with high z-index so it stays above page content.
4. Collapsible submenus in sidebars MUST use Bootstrap collapse (\`data-bs-toggle="collapse"\`).
5. Hover dropdowns use Bootstrap dropdown or custom CSS \`:hover\` with transition.
6. Every menu item MUST be an \`<a>\` or \`<button>\` whose text content matches the target page's \`<title>\`. The designer auto-switches pages by matching this text on click — NEVER use icon-only items without text.
7. Apply \`data-design-id\` to nav containers (\`data-design-id="main-nav"\`, \`data-design-id="sidebar"\`, \`data-design-id="bottom-tabs"\`).
8. Do NOT use \`overflow-x: auto\` or \`overflow-x: scroll\` on nav containers — it creates an ugly scrollbar. Group excess items into a "更多" dropdown instead. (Auto-stripped post-generation if missed.)
9. MENU COLOR CONSISTENCY: nav link text color MUST match the nav background. \`bg-surface\` → \`text-on-surface\` / \`text-on-surface-variant\`; \`bg-primary\` → \`text-white\` / \`text-on-primary\`. Never hardcode nav link colors — use token classes or \`var(--xai-*)\`.

${editBlock}${sharedLayoutBlock}${styleRefBlock}`;
}

/**
 * Build the user message that wraps the design prompt.
 * Applies lightweight structural enhancement to help the model understand intent.
 */
export function buildDesignerUserMessage(prompt: string, projectType: ProjectType): string {
  // DIAGRAM 模式：完全不同的用户消息结构
  if (projectType === 'DIAGRAM') {
    return `Generate a diagram / architecture chart page based on the following description.

## Requirements
- Use Mermaid.js for diagram rendering
- Choose the most appropriate diagram type (flowchart, sequence, class, ER, state, architecture, mindmap, gantt, C4)
- Ensure all node labels and relationships accurately reflect the description
- Add clear titles, legends, or notes where helpful
- If multiple diagram types are needed for the same topic, put them in the same page separated by <hr>
- The page must be clean, professional, and suitable for technical documentation
- Do NOT include any toolbar, zoom controls, export buttons, or pan/zoom JS — these are auto-injected by the system
- Use plain <pre class="mermaid"> blocks for each diagram, no extra wrappers needed

## Description
${prompt}

Output the complete HTML document. No explanations, no markdown fences.`;
  }

  const platform = projectType === 'APP' ? 'Mobile App' : projectType === 'PDA' ? 'PDA Handheld Terminal' : 'Web';

  return `Generate ${platform} screen(s) based on the following description.

Apply your system instructions: refine vague terms into professional Bootstrap components, structure the page logically, use design token classes, and output multiple pages separated by <!-- PAGE BREAK --> if the request involves multiple screens.

Output ONLY the complete HTML document(s) — no markdown, no explanations.

---

${prompt}`;
}

/**
 * Build a MINIMAL system prompt for designer tool-calling mode.
 *
 * This is used when the user is either:
 *  - Editing an existing page (Scenario A: replace_in_file + read_file)
 *  - Adding file references to the conversation (Scenario B: read_file only)
 *
 * Unlike buildDesignerSystemPrompt, this does NOT include the enhancement
 * pipeline, design quality standards, menu patterns, etc. But it DOES include
 * the project's theme CSS variables and style instructions — without these,
 * AI-generated HTML in tool mode would not follow the project's design tokens
 * (--xai-* variables) and could break visual consistency across pages.
 */
export function buildDesignerToolSystemPrompt(opts: DesignerToolPromptOptions): string {
  const { tools, workspacePath, scenario, filePaths, hasStyleReferences, projectType, themePrompt } = opts;

  // Parse theme prompt (handles both new JSON format and legacy text)
  const themeData = themePrompt ? parseThemePrompt(themePrompt) : null;
  const themeCss = buildBootstrapTheme(themeData);
  const stylePrompt = themeData?.stylePrompt;

  // Format tool definitions in ++++ text format
  const toolEntries = tools.map(tool => {
    const params = Object.entries(tool.parameters)
      .map(([name, param]) => {
        const parts = [`- ${name}`];
        if (param.type) parts.push(`(${param.type})`);
        if (param.location === 'body') parts.push('[body]');
        if (param.required) parts.push('[required]');
        parts.push(`- ${param.description || ''}`);
        return '  ' + parts.join(' ');
      })
      .join('\n');

    let entry = `### ${tool.name}\n${tool.description}`;
    if (params) entry += `\n\nParameters:\n${params}`;
    if (tool.examples && tool.examples.length > 0) {
      entry += '\n\nExamples:\n' + tool.examples.join('\n');
    }
    return entry;
  });

  const fileList = filePaths.map(f => `- ./${f}`).join('\n');

  // Platform-specific scrollbar CSS (kept consistent with standard mode)
  const platformNote = projectType === 'DIAGRAM'
    ? `::-webkit-scrollbar { width: 6px; height: 6px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: rgba(0,0,0,0.12); border-radius: 9999px; }
* { scrollbar-width: thin; scrollbar-color: rgba(0,0,0,0.12) transparent; }`
    : projectType === 'APP' || projectType === 'PDA'
    ? `::-webkit-scrollbar { display: none; width: 0; height: 0; }
* { scrollbar-width: none; -ms-overflow-style: none; }
html, body { -ms-overflow-style: none; scrollbar-width: none; }`
    : `::-webkit-scrollbar { width: 8px; height: 8px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: rgba(0,0,0,0.18); border-radius: 9999px; border: 2px solid transparent; background-clip: padding-box; }
::-webkit-scrollbar-thumb:hover { background: rgba(0,0,0,0.32); background-clip: padding-box; }
::-webkit-scrollbar-corner { background: transparent; }
* { scrollbar-width: thin; scrollbar-color: rgba(0,0,0,0.18) transparent; }
@media (prefers-color-scheme: dark) {
  ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.2); background-clip: padding-box; }
  ::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.35); background-clip: padding-box; }
  * { scrollbar-color: rgba(255,255,255,0.2) transparent; }
}`;

  // DIAGRAM mode: Mermaid.js theme block (no Bootstrap needed)
  const diagramThemeBlock = `
## MERMAID DIAGRAM THEME (MANDATORY for DIAGRAM projects)
Every page MUST include Mermaid.js via CDN and initialize with proper configuration:
\`\`\`html
<script src="https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js"><\/script>
<script>
  document.addEventListener('DOMContentLoaded', function() {
    mermaid.initialize({
      startOnLoad: true,
      theme: 'default',
      securityLevel: 'loose',
      flowchart: { useMaxWidth: true, htmlLabels: true, curve: 'basis' },
      sequence: { useMaxWidth: true, mirrorActors: false },
      themeVariables: {
        primaryColor: '#E8F4FD',
        primaryTextColor: '#1a1a2e',
        primaryBorderColor: '#4A90D9',
        lineColor: '#5C6BC0',
        secondaryColor: '#F3E5F5',
        tertiaryColor: '#E8F5E9',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
      }
    });
    // Global re-render for streaming incremental rendering
    window.__mermaid_rerun = function() {
      try { mermaid.run({ suppressErrors: true }); } catch(e) { /* incomplete syntax, retry next frame */ }
    };
  });
<\/script>
\`\`\`

Each diagram is a <pre class="mermaid"> block with Mermaid syntax.
Page layout: centered container, max-width 1200px, padding 40px, clean white or light gray background.
Use Chinese labels if the user writes in Chinese. Make node IDs short English.
${stylePrompt ? `\n## STYLE INSTRUCTIONS (MANDATORY)\n${stylePrompt}\n` : ''}`;

  // Theme block: Bootstrap CDN + CSS variables + token utility classes
  const themeBlock = projectType === 'DIAGRAM' ? diagramThemeBlock : `
## BOOTSTRAP THEME (MANDATORY)
Every page MUST include Bootstrap 5.3.8 CDN and the exact theme CSS variables:
\`\`\`html
<link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.8/dist/css/bootstrap.min.css" rel="stylesheet">
<link href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.min.css" rel="stylesheet">
<script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.8/dist/js/bootstrap.bundle.min.js"><\/script>
<style id="__xai_designer_theme__">
${themeCss}

/* Design token utility classes */
.bg-primary-container { background-color: var(--xai-primary-container) !important; }
.bg-secondary-container { background-color: var(--xai-secondary-container) !important; }
.bg-tertiary-container { background-color: var(--xai-tertiary-container) !important; }
.bg-surface { background-color: var(--xai-surface) !important; }
.bg-surface-variant { background-color: var(--xai-surface-variant) !important; }
.bg-surface-container { background-color: var(--xai-surface-container) !important; }
.bg-surface-container-high { background-color: var(--xai-surface-container-high) !important; }
.bg-surface-container-low { background-color: var(--xai-surface-container-low) !important; }
.bg-surface-container-lowest { background-color: var(--xai-surface-container-lowest) !important; }
.bg-surface-container-highest { background-color: var(--xai-surface-container-highest) !important; }
.bg-background { background-color: var(--xai-background) !important; }
.bg-error { background-color: var(--xai-error) !important; }
.bg-error-container { background-color: var(--xai-error-container) !important; }
.bg-success { background-color: var(--xai-success) !important; }
.bg-warning { background-color: var(--xai-warning) !important; }

.text-on-primary { color: var(--xai-on-primary) !important; }
.text-on-primary-container { color: var(--xai-on-primary-container) !important; }
.text-on-secondary { color: var(--xai-on-secondary) !important; }
.text-on-secondary-container { color: var(--xai-on-secondary-container) !important; }
.text-on-tertiary { color: var(--xai-on-tertiary) !important; }
.text-on-tertiary-container { color: var(--xai-on-tertiary-container) !important; }
.text-on-surface { color: var(--xai-on-surface) !important; }
.text-on-surface-variant { color: var(--xai-on-surface-variant) !important; }
.text-on-background { color: var(--xai-on-background) !important; }
.text-on-error { color: var(--xai-on-error) !important; }
.text-on-success { color: var(--xai-on-success) !important; }
.text-on-warning { color: var(--xai-on-warning) !important; }

.border-outline { border-color: var(--xai-outline) !important; }
.border-outline-variant { border-color: var(--xai-outline-variant) !important; }
.border-primary { border-color: var(--xai-primary) !important; }
</style>
\`\`\`
Use Bootstrap utility classes + the custom token classes above. Do NOT hardcode color values — always use token classes or \`var(--xai-*)\` variables.

## COLOR TOKEN USAGE (KEY RULES)
- **bg-background / text-on-background**: page background, body text
- **bg-surface / text-on-surface**: card background, card text
- **bg-surface-container** (+ **-high / -low / -lowest**): elevated container backgrounds with elevation hierarchy
- **bg-primary / text-on-primary**: primary buttons, active states. For primary-colored text use \`text-primary\`
- **bg-error / bg-success / bg-warning** (+ matching \`text-on-*\`): SOLID colored background with WHITE inverse text. For colored text on light backgrounds, use \`.text-error\` / \`.text-success\` / \`.text-warning\` instead

## TOKEN NAMING TRAP (CRITICAL)
\`text-on-*\` classes are INVERSE text colors (typically white) meant to sit on a MATCHING \`bg-*\` background — NOT colored text. Using them on light/white backgrounds produces invisible white text.
**Rule**: Use \`text-on-{color}\` ONLY when the parent has \`bg-{color}\`. For colored text on light backgrounds, use \`.text-{color}\` (e.g. \`.text-error\`, \`.text-success\`) or \`var(--xai-{color})\` directly.

## PLATFORM CSS (MANDATORY)
Include this scrollbar CSS in every page's <style> block:
\`\`\`css
${platformNote}
\`\`\`
${stylePrompt ? `\n## STYLE INSTRUCTIONS (MANDATORY)\n${stylePrompt}\n` : ''}`;

  // DIAGRAM-specific scenario instructions
  const diagramScenarioInstruction = scenario === 'edit'
    ? `You are modifying an existing diagram HTML file. The file contains Mermaid.js diagram definitions.
Choose the right tool for each step:
- grep_search: locate specific diagram sections (returns line numbers + context).
- read_file: read the full file or a line range.
- replace_in_file: targeted edits to specific <pre class="mermaid"> blocks. PREFERRED.
- write_to_file: full rewrite — only for major changes.
Do NOT output raw HTML as text — always apply changes via replace_in_file or write_to_file. After all modifications are done, briefly confirm what you changed.

## STRICT CONSTRAINTS (modification mode)
- You are editing ONE existing file. Only operate on ./current.html.
- NEVER create new files. Do NOT call write_to_file with any path other than ./current.html.
- Preserve the Mermaid.js CDN script tags and initialization code. If the page already has them, do NOT remove or rewrite them.
- When editing a <pre class="mermaid"> block, ensure the Mermaid syntax remains valid.
- Do NOT add, modify, or remove any toolbar/zoom/export controls — these are auto-injected by the system.
- Do NOT wrap <pre class="mermaid"> blocks in extra containers or add pan/zoom/transform JavaScript.`
    : `You are generating a new diagram HTML page. Use read_file to read the reference files for context. After reading, output the complete HTML document. Output ONLY raw HTML — no markdown fences, no explanations.

## OUTPUT REQUIREMENTS
- The page MUST include Mermaid.js CDN and proper initialization as specified in the MERMAID DIAGRAM THEME section below.
- Each diagram is a <pre class="mermaid"> block with valid Mermaid syntax.
- Use Chinese labels if the user writes in Chinese. Node IDs should be short English.
- Page layout: centered container, max-width 1200px, padding 40px, clean background.
- Do NOT include any toolbar, zoom controls, export buttons, or pan/zoom JS — these are auto-injected by the system.
- Use plain <pre class="mermaid"> blocks, no extra wrappers needed.`;

  const scenarioInstruction = projectType === 'DIAGRAM' ? diagramScenarioInstruction : (scenario === 'edit'
    ? `You are modifying an existing HTML file. Choose the right tool for each step:
- grep_search: locate specific text/sections (returns line numbers + context) — use this first to find where to edit, without loading the whole file.
- read_file: read the full file or a line range when you need broader context.
- replace_in_file: targeted edits (a few sections/lines) — preserves everything not mentioned. PREFERRED for most edits.
- write_to_file: full rewrite — only for major redesigns (most of the page changes).
Do NOT output raw HTML as text — always apply changes via replace_in_file or write_to_file. After all modifications are done, briefly confirm what you changed.

## STRICT CONSTRAINTS (modification mode)
- You are editing ONE existing page. Only operate on ./current.html.
- NEVER create new files. Do NOT call write_to_file with any path other than ./current.html.
- NEVER add the literal string "<!-- PAGE BREAK -->" anywhere in the content — it is a reserved multi-page delimiter and would split the page incorrectly.
- NEVER add, rename, or duplicate pages. The output must remain a single HTML document.
- Preserve the existing <title> unless the user explicitly asks to change it.
- Preserve the existing \`<style id="__xai_designer_theme__">\` block (Bootstrap CDN + theme CSS variables). If the page already has it, do NOT remove or rewrite it.`
    : `You are generating a new HTML page. Use read_file to read the reference files for style and structure context. After reading the references, output the complete HTML document. Output ONLY raw HTML — no markdown fences, no explanations.

## OUTPUT REQUIREMENTS
- The page MUST include Bootstrap 5.3.8 CDN (CSS + JS) and the exact theme CSS variables specified in the BOOTSTRAP THEME section below.
- Include the mandatory scrollbar CSS from the PLATFORM CSS section in a <style> block.
- Use the design token classes (\`bg-surface-container\`, \`text-on-surface-variant\`, etc.) — do NOT hardcode color values.`);

  // When style reference files are present alongside the current page, instruct the AI
  // to read them first so changes match the referenced page's style (e.g. "keep the bottom
  // navigation bar consistent with 首页"). Without this hint the AI ignores reference files.
  const styleRefNote = (scenario === 'edit' && hasStyleReferences)
    ? `\n\n## STYLE REFERENCE FILES
The workspace also contains style reference files (reference-N.html) — other pages from the same project the user referenced for style consistency. Before editing current.html, use read_file (or grep_search) to inspect the relevant parts of these reference files, then apply changes to current.html so it matches their style (e.g. bottom navigation bar, colors, typography, spacing, component structure). Only modify current.html — never modify reference files.`
    : '';
  return `${scenarioInstruction}${styleRefNote}${themeBlock}

## EXTENDED TOOL CALL RULE Example:
++++ tool_name headerParam1:value1 headerParam2:value2
body content here (free-form text, can be multiple lines)
++++ end
## EXTENDED TOOLS

${toolEntries.join('\n\n')}

## WORKSPACE
Path: ${workspacePath}
All file paths are relative to this path.

## FILES
${fileList}`;
}