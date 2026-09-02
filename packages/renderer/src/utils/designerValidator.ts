/**
 * Designer HTML validator — detects issues that postProcessDesignerHtml
 * cannot auto-fix. Used to surface problems during development and to
 * decide whether to retry generation with feedback to the LLM.
 *
 * Each check returns a structured issue with severity and a human-readable
 * message. Checks are pure (no side effects) and streaming-safe (no-op on
 * incomplete documents).
 *
 * Categories:
 *  - error:   broken HTML that will not render correctly
 *  - warn:    suboptimal but functional (e.g. missing semantic structure)
 *  - info:    minor improvements (e.g. missing accessibility attributes)
 */

export type ValidationSeverity = 'error' | 'warn' | 'info';

export interface ValidationIssue {
  severity: ValidationSeverity;
  rule: string;
  message: string;
  /** Optional character offset in the source HTML for editor integration. */
  offset?: number;
}

/**
 * Validate a complete HTML page produced by the Designer LLM.
 *
 * @param html The HTML document to validate (should be complete, with </body>).
 * @returns Array of issues; empty array means the page passed all checks.
 */
export function validateDesignerHtml(html: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!html || !html.trim()) {
    issues.push({ severity: 'error', rule: 'empty', message: 'HTML 内容为空' });
    return issues;
  }
  // Skip checks on streaming-partial documents (no </body> yet).
  const isComplete = /<\/body>/i.test(html);
  if (!isComplete) {
    return issues; // streaming in progress — defer validation
  }

  // ── Structural checks ────────────────────────────────────────────────
  // 1. DOCTYPE present
  if (!/<!DOCTYPE\s+html>/i.test(html)) {
    issues.push({
      severity: 'warn',
      rule: 'missing-doctype',
      message: '缺少 <!DOCTYPE html> 声明，可能触发怪异模式渲染',
    });
  }

  // 2. Balanced <html>...</html> root
  const htmlOpenCount = (html.match(/<html\b[^>]*>/gi) || []).length;
  const htmlCloseCount = (html.match(/<\/html\s*>/gi) || []).length;
  if (htmlOpenCount !== htmlCloseCount) {
    issues.push({
      severity: 'error',
      rule: 'unbalanced-html-root',
      message: `<html> 标签不配对：${htmlOpenCount} 个开标签 vs ${htmlCloseCount} 个闭标签`,
    });
  }

  // 3. <head> and <body> present
  if (!/<head\b[^>]*>[\s\S]*?<\/head>/i.test(html)) {
    issues.push({ severity: 'error', rule: 'missing-head', message: '缺少 <head> 块' });
  }
  if (!/<body\b[^>]*>[\s\S]*?<\/body>/i.test(html)) {
    issues.push({ severity: 'error', rule: 'missing-body', message: '缺少 <body> 块' });
  }

  // 4. <title> present (used by designer for page matching)
  if (!/<title[^>]*>[^<]+<\/title>/i.test(html)) {
    issues.push({
      severity: 'warn',
      rule: 'missing-title',
      message: '缺少 <title>，设计器页面跳转匹配将退化为序号',
    });
  }

  // ── Bootstrap / theme checks (postProcess should have fixed these) ───
  // 5. Bootstrap CSS CDN present
  if (!/bootstrap@[\d.]+.*bootstrap\.min\.css/i.test(html)) {
    issues.push({
      severity: 'error',
      rule: 'missing-bootstrap-css',
      message: '缺少 Bootstrap CSS CDN，页面将无样式',
    });
  }

  // 6. Theme style block present
  if (!/id=["']__xai_designer_theme__["']/i.test(html)) {
    issues.push({
      severity: 'warn',
      rule: 'missing-theme-block',
      message: '缺少主题 CSS 变量块 (--xai-* tokens)，颜色 token 类将失效',
    });
  }

  // ── data-design-id checks ────────────────────────────────────────────
  // 7. At least one container-level element has data-design-id
  const designIdCount = (html.match(/\bdata-design-id\s*=/gi) || []).length;
  if (designIdCount === 0) {
    issues.push({
      severity: 'warn',
      rule: 'no-design-ids',
      message: '无任何 data-design-id，图层树与元素追踪将不可用',
    });
  }

  // ── Image checks ─────────────────────────────────────────────────────
  // 8. No external image URLs (rule: must use inline SVG / data-URI)
  const externalImgMatches = html.match(/<img\b[^>]*\bsrc\s*=\s*["'](?!data:|svg)[^"']+["']/gi) || [];
  if (externalImgMatches.length > 0) {
    issues.push({
      severity: 'warn',
      rule: 'external-image-url',
      message: `发现 ${externalImgMatches.length} 处外部图片 URL，离线时将无法显示`,
    });
  }

  // ── Token misuse checks ──────────────────────────────────────────────
  // 9. text-on-* used without matching bg-* on an ancestor (heuristic).
  //    This catches the "invisible white text on white bg" trap. We only
  //    flag the most common case: text-on-* on an element whose nearest
  //    ancestor with a bg-* class uses a surface/background token (light).
  const tokenMisuse = detectTextOnWithoutBg(html);
  issues.push(...tokenMisuse);

  // 10. Hardcoded nav link white color (rule 9 in MENU STRICT RULES)
  const hardcodedNavWhite = detectHardcodedNavWhite(html);
  issues.push(...hardcodedNavWhite);

  // ── Page break checks (edit mode) ────────────────────────────────────
  // 11. PAGE_BREAK delimiter should not appear in a single-page document.
  //     The caller is responsible for passing mode info; we just detect
  //     the presence of the delimiter so the caller can decide.
  if (/<!--\s*PAGE BREAK\s*-->/.test(html)) {
    issues.push({
      severity: 'info',
      rule: 'page-break-present',
      message: 'HTML 含 PAGE_BREAK 分隔符，编辑模式下应被去除',
    });
  }

  return issues;
}

/**
 * Detect `text-on-{color}` classes whose nearest ancestor background is a
 * light surface/background token. This is the "invisible white text" trap.
 *
 * Heuristic: for each element with `text-on-*`, scan up to 3 ancestors for
 * a `bg-*` class. If the nearest bg-* is one of the light tokens (surface,
 * background, surface-container*), flag it.
 */
function detectTextOnWithoutBg(html: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  // Light background tokens that would make white text invisible.
  const lightBgTokens = [
    'bg-surface', 'bg-surface-variant', 'bg-surface-container',
    'bg-surface-container-high', 'bg-surface-container-low',
    'bg-surface-container-lowest', 'bg-surface-container-highest',
    'bg-background', 'bg-white',
  ];
  // Colored bg tokens where text-on-* is appropriate (has matching inverse text).
  const coloredBgRe = /\bbg-(?:primary|secondary|tertiary|error|success|warning)(?:-container)?\b/;

  // Scan elements with text-on-* and check the same element's class for a
  // matching bg-*. Conservative: only flags the common misuse patterns.
  const textOnRe = /<([a-zA-Z][\w-]*)\b([^>]*)\bclass\s*=\s*"([^"]*text-on-(?:primary|secondary|tertiary|error|success|warning|surface)[^"]*)"/gi;
  let m: RegExpExecArray | null;
  while ((m = textOnRe.exec(html)) !== null) {
    const classVal = m[3];
    // Skip if the same element has a colored bg-* (text-on-* is appropriate).
    if (coloredBgRe.test(classVal)) continue;
    // Flag if the same element has a light bg-* (white text on light bg).
    const hasLightBg = lightBgTokens.some(t => new RegExp(`\\b${t}\\b`).test(classVal));
    if (hasLightBg) {
      issues.push({
        severity: 'warn',
        rule: 'text-on-without-matching-bg',
        message: `元素使用 text-on-* 但背景为浅色 token，文字将不可见: <${m[1]} class="${classVal}">`,
        offset: m.index,
      });
    }
    // Flag standalone text-on-{error|success|warning} with NO bg-* at all
    // (the misuse pattern from the prompt's TOKEN NAMING TRAP).
    const hasAnyBg = /\bbg-/.test(classVal);
    if (!hasAnyBg && /\btext-on-(?:error|success|warning)\b/.test(classVal)) {
      issues.push({
        severity: 'warn',
        rule: 'text-on-without-bg',
        message: `text-on-{error|success|warning} 应改为 text-{error|success|warning}（浅色背景上的彩色文字）: <${m[1]} class="${classVal}">`,
        offset: m.index,
      });
    }
  }
  return issues;
}

/**
 * Detect hardcoded nav link white colors via inline style (rule 9 in MENU
 * STRICT RULES). Catches `style="color: rgba(255,255,255,...)"` or
 * `style="color: #fff"` on .nav-link / .dropdown-item elements.
 */
function detectHardcodedNavWhite(html: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const navLinkRe = /<([a-zA-Z][\w-]*)\b([^>]*\bclass\s*=\s*"[^"]*(?:nav-link|dropdown-item)[^"]*"[^>]*)>/gi;
  let m: RegExpExecArray | null;
  while ((m = navLinkRe.exec(html)) !== null) {
    const attrs = m[2];
    const styleMatch = attrs.match(/\bstyle\s*=\s*"([^"]*)"/i);
    if (!styleMatch) continue;
    const style = styleMatch[1];
    // Match color: #fff / #ffffff / white / rgba(255,255,255,...) / rgb(255,255,255)
    if (/color\s*:\s*(?:#fff(?:fff)?|white|rgba?\(\s*255\s*,\s*255\s*,\s*255)/i.test(style)) {
      issues.push({
        severity: 'warn',
        rule: 'hardcoded-nav-white',
        message: `导航项硬编码白色文字，应使用 text-on-surface / text-on-primary 等 token 类: <${m[1]} style="${style}">`,
        offset: m.index,
      });
    }
  }
  return issues;
}

/**
 * Summarize validation issues for display.
 * Returns a single string suitable for toast notifications or logs.
 */
export function summarizeIssues(issues: ValidationIssue[]): string {
  if (issues.length === 0) return '校验通过';
  const errors = issues.filter(i => i.severity === 'error');
  const warns = issues.filter(i => i.severity === 'warn');
  const infos = issues.filter(i => i.severity === 'info');
  const parts: string[] = [];
  if (errors.length) parts.push(`${errors.length} 个错误`);
  if (warns.length) parts.push(`${warns.length} 个警告`);
  if (infos.length) parts.push(`${infos.length} 个提示`);
  return parts.join('，');
}
