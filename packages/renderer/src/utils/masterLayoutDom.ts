/**
 * renderer 端 HTML 操作工具（D13：用浏览器原生 DOMParser，不用 cheerio）。
 *
 * 所有 renderer 进程的 MasterLayout HTML 解析/序列化集中在此文件，
 * 与 designerScrollbar.ts 的 postProcessDesignerHtml 解耦。
 * 主进程端等价逻辑在 designer-handlers.ts 的 injectMasterLayoutWithCheerio（cheerio）。
 */
import type { MasterLayoutType } from '@xai/shared';

/** 把完整 HTML 字符串解析成 Document（浏览器原生 API）。 */
export function parseHtml(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

/** 把 Document 序列化回完整 HTML 字符串（保留 doctype）。 */
export function serializeHtml(doc: Document): string {
  const doctype = '<!DOCTYPE html>';
  return doctype + '\n' + doc.documentElement.outerHTML;
}

/** type → 默认 slotName 映射。 */
export function defaultSlotName(type: MasterLayoutType): string {
  switch (type) {
    case 'menu': return 'main-menu';
    case 'header': return 'main-header';
    case 'footer': return 'main-footer';
    case 'sidebar': return 'main-sidebar';
    default: return 'main-menu';
  }
}

/** 选中元素的 tagName → MasterLayoutType；无法识别的元素返回 null。 */
export function detectMasterLayoutType(tagName: string): MasterLayoutType | null {
  switch (tagName.toLowerCase()) {
    case 'nav': return 'menu';
    case 'header': return 'header';
    case 'footer': return 'footer';
    case 'aside': return 'sidebar';
    default: return null;
  }
}

/** type → 中文标签（用于按钮 / 弹窗标题 / toast）。 */
export function masterLayoutTypeLabel(type: MasterLayoutType): string {
  switch (type) {
    case 'menu': return '主菜单';
    case 'header': return '页头';
    case 'footer': return '页脚';
    case 'sidebar': return '侧栏';
    default: return '母版';
  }
}

/**
 * slot placeholder 样式（§8.2）。
 * 流式渲染期间 slot 显示此 placeholder，handleDone 注入后替换。
 * 注入到全局 <style> 由 ensureBootstrapCdn 路径的 themeBlock 携带，
 * 此常量供需要单独注入的场景（如母版预览 iframe）使用。
 */
export const SLOT_PLACEHOLDER_CSS = `
.xai-slot-placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 56px;
  padding: 16px;
  background: var(--xai-surface-container, #f8f9fa);
  border: 2px dashed var(--xai-outline-variant, #dee2e6);
  border-radius: 8px;
  color: var(--xai-on-surface-variant, #6c757d);
  font-size: 14px;
  text-align: center;
}
`;

/**
 * 构造 slot 占位 HTML 片段。
 * AI 输出 slot 时应包含此 placeholder（提示词约束），流式期间显示提示。
 */
export function buildSlotPlaceholder(label: string): string {
  return `<div class="xai-slot-placeholder">${label}（生成完成后自动显示）</div>`;
}

/**
 * 清除 HTML 片段内的所有 <script> 标签（含外链 src 与内联）。
 *
 * 用途：MasterLayout.html 是组件片段，不应携带 script——
 *  - 外链 script（如 bootstrap.bundle.min.js）会与目标页面 postProcessDesignerHtml
 *    已注入的 Bootstrap JS 重复加载（Bug C）；
 *  - 内联 script 的函数定义应迁入 layout.scripts 字段统一管理，而非留在 html 里
 *    随每次注入重复执行/重复声明。
 *
 * 放在本模块（masterLayoutDom）以便 extract 与 inject 共用，避免循环依赖。
 * 用正则而非 DOMParser：片段可能不完整，且需保留原始 HTML 字节级内容（仅去 script）。
 */
export function sanitizeLayoutHtml(html: string): string {
  if (!html) return html;
  return html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
}
