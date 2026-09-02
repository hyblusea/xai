/**
 * MasterLayout 预览文档构造（共享，Bug E 收敛点）。
 *
 * 之前 MasterLayoutEditor.tsx 与 MasterLayoutDialog.tsx 各持一份 buildPreviewDocument/
 * extractBodyContent 副本，且 injectResponsiveOverride 只在 Editor 有 → 预览与实际页面
 * 分叉。本模块统一三函数，并注入 layout.scripts（Bug A 预览侧）。
 */
/** 注入到预览文档 <head> 的 <style> id（携带 layout.css，与注入管线一致）。 */
const MASTER_LAYOUT_CSS_STYLE_ID = '__xai_master_layout_css__';
/** 注入到预览文档 </body> 前的 <script> id（携带 layout.scripts，与注入管线一致）。 */
const MASTER_LAYOUT_SCRIPTS_ID = '__xai_master_layout_scripts__';

/**
 * 把 MasterLayout.html 片段包裹为完整 HTML 文档（用于预览 iframe）。
 *  - 若 html 本身已是完整文档（含 <body>），只取 body 内部内容，避免嵌套 <html>/<head>/<body>
 *    导致 postProcessDesignerHtml 的 </head>/</body> 正则替换命中内层标签、CSS/JS 注入位置错乱。
 *  - layout.css 注入 <head>（与注入管线的 injectMasterLayoutCssBlock 同 id）。
 *  - layout.scripts 注入 </body> 前（与注入管线的 injectMasterLayoutScriptsBlock 同 id）。
 *  保证预览与实际注入页面视觉/交互一致。
 */
export function buildPreviewDocument(htmlFragment: string, css?: string, scripts?: string): string {
  const bodyContent = extractBodyContent(htmlFragment);
  const cssBlock = css
    ? `\n<style id="${MASTER_LAYOUT_CSS_STYLE_ID}">\n/* extracted from source page */\n${css}\n</style>`
    : '';
  // 用字符串拼接构造 script 标签，避免 </script> 在 JS 字符串里提前闭合模板字面量；
  // 内联 scripts 经 sanitizeLayoutHtml 已从 html 片段剥离，这里按字段单独注入。
  const scriptBlock = scripts
    ? `\n<script id="${MASTER_LAYOUT_SCRIPTS_ID}">//\n${scripts}\n</` + `script>\n`
    : '';
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>MasterLayout Preview</title>${cssBlock}
</head>
<body>
${bodyContent}${scriptBlock}
</body>
</html>`;
}

/**
 * 从完整 HTML 文档中提取 <body> 内部内容；若不是完整文档则原样返回。
 *
 * 额外剥离预览专用 <script id="__xai_master_layout_scripts__">：MasterLayoutEditor 的
 * 直接 DOM 编辑保存（reportDomHtmlChange）会把整个 iframe 文档序列化成 fullDocHtml 再
 * 取 body。若不剥离，预览注入的 script 会被回写进 layout.html，随每次注入重复声明。
 * 注意：剥离 id 必须与 buildPreviewDocument / injectMasterLayoutScriptsBlock 写入的一致。
 */
export function extractBodyContent(html: string): string {
  let cleaned = html;
  // 剥离预览专用 scripts 块（含其内部任意内容，非贪婪可能误伤嵌套 script——此处该块
  // 由我们生成、内部不会再嵌 <script>，安全）。用 [^<] 兜底防止跨多个 script 误删。
  cleaned = cleaned.replace(
    new RegExp(`<script id="${MASTER_LAYOUT_SCRIPTS_ID}">[\\s\\S]*?<\\/script>`, 'i'),
    '',
  );
  const m = cleaned.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  return m ? m[1].trim() : cleaned.trim();
}

/**
 * 在已处理（含 Bootstrap CSS）的完整文档中注入响应式显示类覆盖。
 * postProcessDesignerHtml 把 Bootstrap CSS 注入到 </head> 前，此函数在 Bootstrap 之后
 * （</head> 紧前）再注入覆盖 style，确保 !important 生效。
 * 预览 iframe 宽度可能远小于真实页面，Bootstrap 响应式类 (d-lg-block 等) 会因 iframe
 * 宽度未达断点而隐藏内容——覆盖后强制所有 display 类按最大断点生效，避免窄弹窗隐藏侧边栏。
 */
export function injectResponsiveOverride(html: string): string {
  if (html.includes('__xai_master_layout_responsive_override__')) return html; // 幂等
  const overrideStyle = `\n<style id="__xai_master_layout_responsive_override__">\n` +
    `/* 预览覆盖：强制响应式显示类在任意 iframe 宽度下生效，避免窄弹窗隐藏内容 */\n` +
    `.d-none { display: revert !important; }\n` +
    `.d-sm-none, .d-md-none, .d-lg-none, .d-xl-none, .d-xxl-none { display: revert !important; }\n` +
    `.d-block, .d-sm-block, .d-md-block, .d-lg-block, .d-xl-block, .d-xxl-block { display: block !important; }\n` +
    `.d-flex, .d-sm-flex, .d-md-flex, .d-lg-flex, .d-xl-flex, .d-xxl-flex { display: flex !important; }\n` +
    `.d-inline, .d-sm-inline, .d-md-inline, .d-lg-inline, .d-xl-inline, .d-xxl-inline { display: inline !important; }\n` +
    `.d-inline-block, .d-sm-inline-block, .d-md-inline-block, .d-lg-inline-block, .d-xl-inline-block, .d-xxl-inline-block { display: inline-block !important; }\n` +
    `.d-table, .d-sm-table, .d-md-table, .d-lg-table, .d-xl-table, .d-xxl-table { display: table !important; }\n` +
    `.d-grid, .d-sm-grid, .d-md-grid, .d-lg-grid, .d-xl-grid, .d-xxl-grid { display: grid !important; }\n` +
    `</style>\n</head>`;
  return html.replace(/<\/head>/i, overrideStyle);
}
