/**
 * MasterLayout 提取逻辑（renderer 端，DOMParser，D13）。
 *
 * 从页面元素（nav/header/footer/aside）提取出 MasterLayout（html + css）。
 * menuItems 已废弃（高亮由 scoreMenuMatch 文本匹配驱动，无需结构化绑定数据），
 * 提取时统一设 menuItems: []。
 *
 * css 字段：从源 iframe document 抽取与该元素相关的 CSS 规则（通用化，不依赖
 * 特定 class 名），用于预览 iframe 和注入到其他页面时保持视觉一致性。
 */
import { defaultSlotName, sanitizeLayoutHtml } from './masterLayoutDom';
import type { MasterLayout, MasterLayoutType } from '@xai/shared';

/** 转义正则元字符，用于把动态 token 拼进 RegExp。 */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 从元素 outerHTML 与自身 class 收集 class token，用于判定 script 是否与该元素相关。
 * outerHTML 是 HTML 文本（class="foo bar"），不是 CSS 选择器（.foo.bar），所以必须
 * 解析 class 属性值；同时兼容 CSS 选择器形式 `.foo` 以防传入混合文本。
 */
export function collectElementClassTokens(outerHtml: string, element?: HTMLElement): Set<string> {
  const tokens = new Set<string>();
  // 从 HTML class="..." / class='...' 属性中收集 token
  const classRe = /class\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = classRe.exec(outerHtml)) !== null) {
    const val = m[1] ?? m[2] ?? '';
    val.split(/\s+/).forEach(t => t && tokens.add(t));
  }
  // 兼容 CSS 选择器形式 .foo（outerHTML 一般不含，但脚本文本可能混入）
  const selRe = /\.([A-Za-z_][\w-]*)/g;
  while ((m = selRe.exec(outerHtml)) !== null) tokens.add(m[1]);
  if (element) {
    const cls = element.getAttribute && element.getAttribute('class');
    if (cls) cls.split(/\s+/).forEach(t => t && tokens.add(t));
  }
  return tokens;
}

/** 已知全局/宿主对象，不应被当作待捕获的函数名。 */
const KNOWN_GLOBALS = new Set([
  'event', 'window', 'document', 'console', 'alert', 'confirm', 'prompt',
  'preventDefault', 'stopPropagation', 'stopImmediatePropagation',
  'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
  'requestAnimationFrame', 'fetch', 'JSON', 'Math', 'Date', 'Array',
  'Object', 'String', 'Number', 'Boolean', 'Promise',
  // 常见宿主方法（window.X / el.X 调用形式，由 method-call 跳过逻辑覆盖，
  // 这里兜底防止 `scrollTo(0,0)` 这种省略 window. 前缀的直接调用）
  'scrollTo', 'scrollIntoView', 'scroll', 'open', 'close', 'postMessage',
]);

/**
 * 从 inline on* 属性值里提取被调用的函数名。
 * 如 `onclick="event.preventDefault();toggleSidebarDropdown(this)"` → ['toggleSidebarDropdown']。
 * 跳过：全局对象方法（window.scrollTo / el.preventDefault，即 `.` 前缀的调用）与已知全局名。
 * 容错：只增不删——多识别的候选名只会触发冗余的块扫描，不影响正确性。
 */
export function extractHandlerFunctionNames(onAttrValue: string): string[] {
  const names = new Set<string>();
  const re = /([A-Za-z_$][\w$]*)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(onAttrValue)) !== null) {
    const name = m[1];
    // 跳过方法调用（前面紧挨 `.`，如 window.scrollTo / this.preventDefault）
    const before = onAttrValue.slice(Math.max(0, m.index - 1), m.index);
    if (before === '.') continue;
    if (!KNOWN_GLOBALS.has(name)) names.add(name);
  }
  return [...names];
}

/**
 * 判断一段 inline script 文本是否与该元素相关（应被捕获）。
 * 相关条件（任一）：
 *  - 引用了元素外层 class token（如 `.sidebar-link`，覆盖 DOMContentLoaded/init 块）；
 *  - 定义了元素 on* 属性引用的函数名（`function NAME` 或 `NAME = function/(`）。
 */
export function blockRelevantToElement(
  scriptText: string,
  tokens: Set<string>,
  handlerNames: Set<string>,
): boolean {
  for (const token of tokens) {
    if (!token) continue;
    const re = new RegExp('\\.' + escapeRegex(token) + '\\b');
    if (re.test(scriptText)) return true;
  }
  for (const name of handlerNames) {
    if (!name) continue;
    const declFn = new RegExp('\\bfunction\\s+' + escapeRegex(name) + '\\b');
    const assignFn = new RegExp('\\b' + escapeRegex(name) + '\\s*=\\s*(?:function|\\([^)]*\\)\\s*=>|function\\s*\\()');
    if (declFn.test(scriptText) || assignFn.test(scriptText)) return true;
  }
  return false;
}

/** 生成稳定 id（非加密用途，够用即可）。 */
function genId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 从源页面 document 抽取与指定元素相关的 CSS 规则（通用化）。
 *
 * 策略：遍历 document.styleSheets，跳过：
 *   - designer 注入的样式块（id 以 `__xai_designer_` 开头）
 *   - 外部样式表（带 href，如 Bootstrap CDN）
 *   - 跨域样式表（cssRules 访问会抛异常，try-catch 兜底）
 * 对每条 CSSStyleRule，拆分 selectorText 后用 element.matches / element.querySelector
 * 测试是否匹配元素本身或其后代；任一匹配则保留整条规则。
 *
 * 处理动态伪类（:hover/:focus 等）：matches/querySelector 无法匹配这些伪类，
 * 测试前剥离再判定，输出时保留原始 selector 不动。
 *
 * @param doc     源 iframe 的 contentDocument
 * @param element 被提取的元素（nav/header/footer/aside 及其包装）
 * @returns       CSS 规则字符串（多行，无 <style> 包裹）；无相关规则返回空串
 */
export function extractRelevantCss(doc: Document, element: HTMLElement): string {
  const rules: string[] = [];
  const seen = new Set<string>();

  // 直接从 <style> 元素收集（rawText + CSSOM sheet），不依赖 sheet.ownerNode
  // （happy-dom 中 ownerNode 可能为 null，导致 rawText 丢失）。
  const styleBlocks: { rawText: string; sheet: CSSStyleSheet | null }[] = [];
  try {
    const styles = doc.querySelectorAll('style');
    styles.forEach(style => {
      if (style.id && /^__xai_/.test(style.id)) return;
      const rawText = style.textContent || '';
      if (!rawText.trim()) return;
      let sheet: CSSStyleSheet | null = null;
      try {
        sheet = (style as unknown as HTMLStyleElement & { sheet?: CSSStyleSheet }).sheet ?? null;
      } catch {
        sheet = null;
      }
      if (sheet?.href) return; // 外链（罕见，<style> 一般无 href）
      styleBlocks.push({ rawText, sheet });
    });
  } catch {
    return '';
  }

  for (const { rawText, sheet } of styleBlocks) {
    if (!sheet) {
      // CSSOM 不可用——直接从原始文本解析规则并匹配
      collectFromRawText(rawText, element, rules, seen);
      continue;
    }
    let cssRules: CSSRuleList;
    try {
      cssRules = sheet.cssRules;
    } catch {
      // 跨域 / 其他限制——回退原始文本解析
      collectFromRawText(rawText, element, rules, seen);
      continue;
    }
    for (const rule of Array.from(cssRules)) {
      if (!(rule instanceof CSSStyleRule)) continue;
      if (selectorMatchesElement(rule.selectorText, element)) {
        // Bug D: CSSOM cssText / style.cssText 在某些环境（happy-dom）会部分丢失属性值
        // （如 linear-gradient(135deg, var(--x) 0%) → 整个 background 声明消失，但其他
        // 属性保留）。仅检查空声明体 `{ }` 不够——必须始终优先从 <style> 原始文本提取
        // 完整规则，CSSOM 仅作 rawText 不可用时的兜底。
        let text = extractRuleFromRawText(rawText, rule.selectorText);
        if (!text) {
          // rawText 不可用或选择器未命中——回退到 CSSOM
          text = rule.cssText;
          if (!text || /\{\s*\}/.test(text)) {
            const styleText = rule.style.cssText;
            if (styleText && styleText.trim()) {
              text = `${rule.selectorText} { ${styleText} }`;
            }
          }
        }
        if (text && !seen.has(text)) {
          seen.add(text);
          rules.push(text);
        }
      }
    }
  }

  const result = rules.join('\n');
  if (result.trim()) return result;

  // 安全网：启发式未命中任何规则时，回退整块收集非 designer、非 CDN 的内联 <style>
  // 内容（兜底 AI 随机结构——选择器可能用匹配器无法判定的复杂形式）。
  return collectInlineStyleBlocks(doc);
}

/**
 * 从原始 CSS 文本解析简单规则（selector { body }）并匹配元素，命中则收录。
 * 用于 CSSOM 不可用或 cssText 序列化异常时的回退路径。
 */
function collectFromRawText(
  rawText: string,
  element: HTMLElement,
  rules: string[],
  seen: Set<string>,
): void {
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(rawText)) !== null) {
    const selector = m[1].trim();
    const body = m[2].trim();
    if (!selector || !body) continue;
    if (selector.startsWith('@')) continue; // 跳过 at-rules（@media 等）
    const text = `${selector} { ${body} }`;
    if (selectorMatchesElement(selector, element) && !seen.has(text)) {
      seen.add(text);
      rules.push(text);
    }
  }
}

/**
 * 从 <style> 原始文本中按选择器提取完整规则文本（Bug D 兜底）。
 * selectorText 可能是逗号分隔的复合选择器，逐段尝试；命中即返回 `selector { body }`。
 * 仅处理简单规则（不含 @media 嵌套），复杂场景由 CSSOM 主路径覆盖。
 */
function extractRuleFromRawText(rawText: string, selectorText: string): string | null {
  const selectors = selectorText.split(',').map(s => s.trim()).filter(Boolean);
  for (const sel of selectors) {
    const escaped = escapeRegex(sel);
    const re = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, '');
    const m = re.exec(rawText);
    if (m) {
      const body = m[1].trim();
      if (body) return `${sel} { ${body} }`;
    }
  }
  return null;
}

/**
 * 收集文档中非 designer 注入、非外链 CDN 的内联 <style> 块文本（兜底用）。
 * 跳过 id 匹配 /^__xai_/ 的 designer 注入块与带 href 的外链样式表。
 */
function collectInlineStyleBlocks(doc: Document): string {
  const blocks: string[] = [];
  const styles = doc.querySelectorAll('style');
  styles.forEach(style => {
    if (style.id && /^__xai_/.test(style.id)) return;
    const ownerSheet = (style as unknown as HTMLStyleElement & { sheet?: CSSStyleSheet }).sheet;
    if (ownerSheet && ownerSheet.href) return; // 外链（罕见，style 一般无 href）
    const text = style.textContent || '';
    if (text.trim()) blocks.push(text);
  });
  return blocks.join('\n');
}

/**
 * 剥离运行时切换的状态属性选择器（仅用于匹配测试，输出仍用原始 selectorText）。
 *
 * Bug B 盲区：`.sidebar-dropdown[data-dropdown-open="true"] .sidebar-chevron`
 * 在提取快照时所有 dropdown 都是 data-dropdown-open="false"，querySelector 落空 →
 * 规则被误丢。剥离后用 `.sidebar-dropdown  .sidebar-chevron` 测试即可命中，
 * 而注入/预览输出的仍是原始带状态的选择器，运行时状态切换才能正确驱动样式。
 *
 * 白名单只含运行时切换的状态属性；不剥 [data-design-id]/[id]/[href]/[type]/
 * [data-nav-target]/[role] 等结构/身份属性——它们对匹配有意义。
 */
export function stripStateAttributeSelectors(selector: string): string {
  return selector.replace(
    /\[(?:data-dropdown-open|data-bs-toggle|data-bs-target|data-bs-show|data-show|aria-expanded|aria-selected|aria-current|open|hidden|checked|disabled|selected)(?:[~^$*|]?=(?:"[^"]*"|'[^']*'))?\]/g,
    '',
  );
}

/**
 * 测试一个 selector（可能为复合选择器，逗号分隔）是否匹配元素或其后代。
 * 动态伪类（:hover/:focus 等）与运行时状态属性（[data-dropdown-open="true"] 等）
 * 在 matches/querySelector 中无法按目标状态匹配，测试前剥离（输出保留原始选择器）。
 */
function selectorMatchesElement(selectorText: string, element: HTMLElement): boolean {
  const selectors = selectorText.split(',').map(s => s.trim()).filter(Boolean);
  for (const sel of selectors) {
    // 剥离动态伪类 + 运行时状态属性，便于 matches/querySelector 测试
    const testable = stripStateAttributeSelectors(
      sel.replace(/:(?:hover|focus|active|visited|focus-within|focus-visible|target|checked|disabled|enabled|read-only|read-write|placeholder-shown|default|valid|invalid|in-range|out-of-range|required|optional)\b/g, ''),
    );
    if (!testable || /^\s*$/.test(testable)) continue;
    try {
      if (element.matches(testable)) return true;
    } catch {
      // 无效选择器，跳过
    }
    try {
      if (element.querySelector(testable)) return true;
    } catch {
      // 无效选择器，跳过
    }
  }
  return false;
}

/**
 * 从源页面 document 抽取与指定元素相关的 inline <script> 块（通用化，Bug A）。
 *
 * 策略：整块捕获（避免脆弱的花括号匹配）。遍历 doc.querySelectorAll('script')，
 * 跳过：外链(src)、designer 注入(id 匹配 /^__xai_/)、ESM(type=module)。
 * 当某块 textContent 满足下列任一条件即整块收录：
 *  - 引用了元素外层 class token（覆盖 DOMContentLoaded/init 块，如 .sidebar-link）；
 *  - 定义了元素 on* 属性引用的函数名（function NAME 或 NAME = function/=>）。
 * 按块文本去重，`\n;\n` 拼接。无相关块返回空串。
 *
 * @param doc     源 iframe 的 contentDocument
 * @param element 被提取的元素（nav/header/footer/aside 及其包装）
 * @returns       JS 块字符串；无相关块返回空串
 */
export function extractRelevantScripts(doc: Document, element: HTMLElement): string {
  const outerHtml = element.outerHTML;
  const tokens = collectElementClassTokens(outerHtml, element);

  // 收集元素及其后代 on* 属性引用的函数名
  const handlerNames = new Set<string>();
  const collectFrom = (el: Element) => {
    for (const attr of Array.from(el.attributes)) {
      if (attr.name.startsWith('on') && attr.name.length > 2) {
        for (const n of extractHandlerFunctionNames(attr.value)) handlerNames.add(n);
      }
    }
  };
  collectFrom(element);
  element.querySelectorAll('*').forEach(collectFrom);

  const blocks: string[] = [];
  const seen = new Set<string>();
  let scripts: HTMLScriptElement[];
  try {
    scripts = Array.from(doc.querySelectorAll('script'));
  } catch {
    return '';
  }
  for (const script of scripts) {
    if (script.src) continue;                 // 外链 CDN（bootstrap.bundle 等）
    if (script.id && /^__xai_/.test(script.id)) continue; // designer 注入
    if (script.type === 'module') continue;   // ESM 作用域独立，MVP 不处理
    const text = script.textContent || '';
    if (!text.trim()) continue;
    if (!blockRelevantToElement(text, tokens, handlerNames)) continue;
    if (!seen.has(text)) {
      seen.add(text);
      blocks.push(text);
    }
  }
  return blocks.join('\n;\n');
}

/**
 * 从选中元素提取 MasterLayout（类型无关：nav/header/footer/aside）。
 *
 * @param element   iframe 内被选中的元素（nav/header/footer/aside）
 * @param name      用户输入的 layout 名称
 * @param type      layout 类型（决定 slotName）
 * @param sourceDoc 源 iframe 的 contentDocument（用于抽取相关 CSS 规则与 JS，可选）
 * @returns { layout, selector } layout 为提取结果，selector 用于后续替换为 slot
 */
export function extractMasterLayoutFromElement(
  element: HTMLElement,
  name: string,
  type: MasterLayoutType = 'menu',
  sourceDoc?: Document,
): { layout: MasterLayout; selector: string } {
  // 1. 深拷贝元素 HTML（outerHTML 含标签本身），并清洗 script 标签（Bug C）：
  //    外链 script 会与目标页面 Bootstrap JS 重复加载；内联定义迁入 scripts 字段。
  const html = sanitizeLayoutHtml(element.outerHTML);

  // 2. 生成稳定 selector（优先 data-design-id，回退 id，最后用 tagName）
  const designId = element.getAttribute('data-design-id');
  const selector = designId
    ? `[data-design-id="${designId}"]`
    : element.id
      ? `#${element.id}`
      : element.tagName.toLowerCase();

  // 3. 从源页面抽取相关 CSS 规则 + JS（通用化，保证预览/注入后视觉与交互一致）
  const css = sourceDoc ? extractRelevantCss(sourceDoc, element) : '';
  const scripts = sourceDoc ? extractRelevantScripts(sourceDoc, element) : '';

  // 4. 构造 MasterLayout（menuItems 废弃，高亮由 scoreMenuMatch 驱动）
  const now = new Date().toISOString();
  const layout: MasterLayout = {
    id: genId('ml'),
    name,
    type,
    html,
    css: css || undefined,
    scripts: scripts || undefined,
    menuItems: [],
    applyTo: { mode: 'all' },
    slotName: defaultSlotName(type),
    createdAt: now,
    updatedAt: now,
  };

  return { layout, selector };
}
