/**
 * MasterLayout 注入逻辑（renderer 端，DOMParser，D13）。
 *
 * 被 postProcessDesignerHtml 桥接调用（见 designerScrollbar.ts）。
 * 主进程端等价逻辑在 designer-handlers.ts 的 injectMasterLayoutWithCheerio（cheerio）。
 *
 * 向后兼容：无 masterLayouts / 无 slot 时原样返回，不影响老项目。
 */
import { parseHtml, serializeHtml, buildSlotPlaceholder, sanitizeLayoutHtml } from './masterLayoutDom';
import type { DesignerProject, MasterLayout } from '@xai/shared';
import { scoreMenuMatch, MENU_MATCH_SCORE } from '@xai/shared';

/** 注入到目标页面 <head> 的 <style> id（携带各 layout.css 合并结果，去重）。 */
const MASTER_LAYOUT_CSS_STYLE_ID = '__xai_master_layout_css__';

/** 注入到目标页面 </body> 前的 <script> id（携带各 layout.scripts 合并结果，幂等替换）。 */
const MASTER_LAYOUT_SCRIPTS_ID = '__xai_master_layout_scripts__';

/**
 * 把 MasterLayout 注入到 HTML 的 slot 位置，并按当前页高亮对应菜单项。
 * 同时把各 layout.css 合并注入 <head>（去重，幂等）。
 *
 * 高亮策略（与 DesignerCanvas 按钮跳转共用 scoreMenuMatch 规则）：
 *  - 遍历 slot 内所有 <a>/<button>，按 data-nav-target 强绑定或文本匹配打分；
 *  - 取最高分者为当前页菜单项，加 .active；其余清除 .active；
 *  - winner 若位于子菜单（.collapse / .dropdown），展开父级并设 aria-expanded。
 *
 * @param html       完整 HTML 文档字符串
 * @param screenId   当前页面 screenId（用于 data-nav-target 强绑定）
 * @param screenName 当前页面名（含 AI 拼接的系统名/日期后缀，用于文本匹配）
 * @param layouts    项目所有 MasterLayout（按 slotName 注入各自 html）
 * @returns 注入后的 HTML；无 layout 时原样返回
 */
export function injectMasterLayouts(
  html: string,
  screenId: string,
  screenName: string,
  layouts: MasterLayout[],
): string {
  if (!layouts || layouts.length === 0) return html;

  const doc = parseHtml(html);
  let changed = false;

  // 先检查是否有任何 layout 的 slot 存在。老页面（无 slot）应原样返回——
  // 即使 layout 有 css/scripts，没有 slot 就不该注入（避免污染老页面）。
  let hasAnySlot = false;
  for (const layout of layouts) {
    if (doc.querySelector(`[data-design-slot="${layout.slotName}"]`)) {
      hasAnySlot = true;
      break;
    }
  }
  if (!hasAnySlot) return html;

  // 合并所有 layout.css 到一个 <style> 块（幂等替换）
  const cssParts: string[] = [];
  for (const layout of layouts) {
    if (layout.css && layout.css.trim()) {
      cssParts.push(`/* ${layout.name || layout.id} */\n${layout.css}`);
    }
  }
  if (cssParts.length > 0) {
    injectMasterLayoutCssBlock(doc, cssParts.join('\n'));
    changed = true;
  }

  for (const layout of layouts) {
    const slot = doc.querySelector(`[data-design-slot="${layout.slotName}"]`);
    if (!slot) continue; // 该 layout 无 slot（其他 layout 有），跳过

    // 1. 用 MasterLayout.html 替换 slot 内容（先清洗 script，Bug C 防御：旧 layout
    //    可能仍带 <script src="bootstrap...">，避免与目标页 Bootstrap JS 重复加载）
    slot.innerHTML = sanitizeLayoutHtml(layout.html);
    changed = true;

    // 2. 高亮计算：统一打分选最优（data-nav-target 强绑定 > 文本匹配）
    highlightActiveMenuItem(slot, screenId, screenName);
  }

  // 3. 合并所有 layout.scripts 到 </body> 前的 <script id="__xai_master_layout_scripts__">
  //    （幂等替换，Bug A：恢复 toggleSidebarDropdown 等交互函数）
  const scriptParts: string[] = [];
  const declaredFn = new Set<string>();
  for (const layout of layouts) {
    if (!layout.scripts || !layout.scripts.trim()) continue;
    // 跨 layout 按顶层 function 名去重，避免重复声明 SyntaxError
    const fnNames = [...layout.scripts.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)\b/g)].map(m => m[1]);
    if (fnNames.length > 0 && fnNames.every(n => declaredFn.has(n))) continue;
    fnNames.forEach(n => declaredFn.add(n));
    scriptParts.push(`/* ${layout.name || layout.id} */\n${layout.scripts}`);
  }
  if (scriptParts.length > 0) {
    injectMasterLayoutScriptsBlock(doc, scriptParts.join('\n;\n'));
    changed = true;
  }

  return changed ? serializeHtml(doc) : html;
}

/**
 * 直接在 Document 上注入 MasterLayout（不经过 parse/serialize）。
 * 供流式渲染期间使用：document.write 后直接操作 iframe DOM。
 *
 * 与 injectMasterLayouts 的区别：
 * - injectMasterLayouts: HTML string → DOMParser → 修改 → serialize → HTML string
 * - injectMasterLayoutsIntoDoc: 直接在已有 Document 上操作，无序列化开销
 *
 * 幂等：slot 已注入（不含 .xai-slot-placeholder）时跳过；
 *       CSS/Scripts 用固定 ID 幂等替换。
 *
 * @param doc         iframe.contentDocument（document.write 后已可查询）
 * @param screenId    当前页面 screenId（编辑模式已知，新建模式传 ''）
 * @param screenName  当前页面名（从 <title> 提取，用于 scoreMenuMatch 文本匹配）
 * @param layouts     项目所有 MasterLayout（按 slotName 注入各自 html）
 * @returns 是否有变更（用于调用方决定是否触发额外操作）
 */
export function injectMasterLayoutsIntoDoc(
  doc: Document,
  screenId: string,
  screenName: string,
  layouts: MasterLayout[],
): boolean {
  if (!layouts || layouts.length === 0) return false;

  // 检查是否有任何 slot 存在。无 slot 时完全跳过（避免污染无母版的页面）。
  let hasAnySlot = false;
  for (const layout of layouts) {
    if (doc.querySelector(`[data-design-slot="${layout.slotName}"]`)) {
      hasAnySlot = true;
      break;
    }
  }
  if (!hasAnySlot) return false;

  let changed = false;

  // 合并所有 layout.css 到一个 <style> 块（幂等替换）
  const cssParts: string[] = [];
  for (const layout of layouts) {
    if (layout.css && layout.css.trim()) {
      cssParts.push(`/* ${layout.name || layout.id} */\n${layout.css}`);
    }
  }
  if (cssParts.length > 0) {
    injectMasterLayoutCssBlock(doc, cssParts.join('\n'));
    changed = true;
  }

  // 逐 layout 注入 slot 内容
  for (const layout of layouts) {
    const slot = doc.querySelector(`[data-design-slot="${layout.slotName}"]`);
    if (!slot) continue; // 该 layout 无 slot（其他 layout 有），跳过

    // 幂等：仍含 placeholder 才注入（已注入的跳过）
    // 流式期间 AI 可能只输出了 <div data-design-slot="main-menu"> 但 </div> 还没到，
    // 此时 querySelector 能找到该 div，但 .xai-slot-placeholder 子元素可能不存在 → 跳过，下一帧再检测
    if (!slot.querySelector('.xai-slot-placeholder')) continue;

    slot.innerHTML = sanitizeLayoutHtml(layout.html);
    changed = true;

    // 高亮当前页菜单项
    highlightActiveMenuItem(slot, screenId, screenName);
  }

  // 合并所有 layout.scripts 到 </body> 前的 <script>（幂等替换）
  const scriptParts: string[] = [];
  const declaredFn = new Set<string>();
  for (const layout of layouts) {
    if (!layout.scripts || !layout.scripts.trim()) continue;
    // 跨 layout 按顶层 function 名去重，避免重复声明 SyntaxError
    const fnNames = [...layout.scripts.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)\b/g)].map(m => m[1]);
    if (fnNames.length > 0 && fnNames.every(n => declaredFn.has(n))) continue;
    fnNames.forEach(n => declaredFn.add(n));
    scriptParts.push(`/* ${layout.name || layout.id} */\n${layout.scripts}`);
  }
  if (scriptParts.length > 0) {
    injectMasterLayoutScriptsBlock(doc, scriptParts.join('\n;\n'));
    changed = true;
  }

  return changed;
}

/**
 * 在 slot 内选出当前页对应的菜单项并高亮，同时展开其父级折叠/下拉。
 *
 * 打分：data-nav-target===screenId → EXACT+1（强绑定最高，优先于一切文本匹配）；
 *      否则 scoreMenuMatch(textContent, screenName)（EXACT > FUZZY > NONE）。
 * 选优：最高分；同分取 label 最长（最具体）；仍同分优先非 toggle 叶子
 *      （无 data-bs-toggle，避免父级折叠标题与同名叶子项冲突）。
 * 幂等：先清掉所有候选的 .active（含其 <li>），再给 winner 加 .active。
 */
function highlightActiveMenuItem(slot: Element, screenId: string, screenName: string): void {
  const candidates = Array.from(slot.querySelectorAll('a, button'));

  type Cand = { el: Element; score: number; labelLen: number; isToggle: boolean };
  let best: Cand | null = null;
  for (const el of candidates) {
    const navTarget = el.getAttribute('data-nav-target') || '';
    const text = (el.textContent || '').trim();
    const score = navTarget && navTarget === screenId
      ? MENU_MATCH_SCORE.EXACT + 1 // 强绑定压过一切文本匹配
      : scoreMenuMatch(text, screenName);
    if (score === MENU_MATCH_SCORE.NONE) continue;
    const isToggle = el.getAttribute('data-bs-toggle') !== null;
    const c: Cand = { el, score, labelLen: text.length, isToggle };
    if (
      !best ||
      c.score > best.score ||
      (c.score === best.score && c.labelLen > best.labelLen) ||
      (c.score === best.score && c.labelLen === best.labelLen && !c.isToggle && best.isToggle)
    ) {
      best = c;
    }
  }

  // 清除所有候选的 .active / .active-side（注入是幂等重算，确保每页高亮反映当前页而非母版快照残留）
  candidates.forEach(el => {
    el.classList.remove('active', 'active-side');
    el.closest('li')?.classList.remove('active');
  });

  if (best) {
    best.el.classList.add('active', 'active-side');
    best.el.closest('li')?.classList.add('active');
    expandAncestors(best.el, slot);
  }
}

/**
 * 从 el 向上遍历到 slot 根，展开沿途的折叠/下拉父级：
 *  - Bootstrap collapse：.collapse 加 show；并用 href="#<id>" 找到同级 toggle
 *    设 aria-expanded="true"（toggle 与 .collapse 通常同为 <li> 子元素）。
 *  - data-dropdown-open 状态属性（类无关）：任何带该属性的祖先置 "true"
 *    （覆盖 designer 的 .dropdown 与 AI 的 .sidebar-dropdown，CSS 均靠此属性驱动）。
 *  - sidebar-submenu 内联 display:none 清除：AI 侧栏用
 *    <ul class="sidebar-submenu" style="display:none;"> 配合 toggleSidebarDropdown
 *    JS 函数管理显隐。初始注入时 JS 未执行，内联 display:none 会遮住已展开的
 *    子菜单（即使 data-dropdown-open="true"），需在此同步清除。
 */
function expandAncestors(el: Element, slot: Element): void {
  let cur: Element | null = el.parentElement;
  while (cur && cur !== slot) {
    if (cur.classList.contains('collapse')) {
      cur.classList.add('show');
      const id = cur.getAttribute('id');
      if (id) {
        const toggle = slot.querySelector(`[data-bs-toggle="collapse"][href="#${id}"]`);
        toggle?.setAttribute('aria-expanded', 'true');
      }
    }
    if (cur.getAttribute('data-dropdown-open') !== null) {
      cur.setAttribute('data-dropdown-open', 'true');
      // 清除 .sidebar-submenu 的内联 display:none + maxHeight
      // （toggleSidebarDropdown 用 inline style 管理显隐，初始注入时需同步）
      const submenu = cur.querySelector('.sidebar-submenu');
      if (submenu) {
        (submenu as HTMLElement).style.display = 'block';
        (submenu as HTMLElement).style.maxHeight = 'none';
      }
    }
    cur = cur.parentElement;
  }
}

/**
 * 把合并后的 layout.css 注入到 doc 的 <head>（幂等：替换已存在的同名 <style>）。
 * 放在 designer 注入样式（theme/scrollbar/components）之前，确保后者可覆盖前者。
 */
function injectMasterLayoutCssBlock(doc: Document, css: string): void {
  const existing = doc.querySelector(`style#${MASTER_LAYOUT_CSS_STYLE_ID}`);
  if (existing) {
    existing.textContent = css;
    return;
  }
  const styleEl = doc.createElement('style');
  styleEl.id = MASTER_LAYOUT_CSS_STYLE_ID;
  styleEl.textContent = css;
  const head = doc.querySelector('head');
  if (head) {
    // 插在第一个 designer 注入样式之前（如果存在），否则插到 head 末尾
    const firstDesignerStyle = head.querySelector('style[id^="__xai_designer_"], link[href*="bootstrap"]');
    if (firstDesignerStyle) {
      head.insertBefore(styleEl, firstDesignerStyle);
    } else {
      head.appendChild(styleEl);
    }
  } else {
    // 兜底：无 head，插到 body 顶部
    const body = doc.querySelector('body');
    if (body) body.insertBefore(styleEl, body.firstChild);
  }
}

/**
 * 把合并后的 layout.scripts 注入到 doc 的 </body> 前（幂等：替换已存在的同名 <script>）。
 *
 * 必须整块替换而非 append：重复声明 `function toggleSidebarDropdown(){}` 会触发
 * SyntaxError: Identifier 'toggleSidebarDropdown' has already been declared。
 * 放在 </body> 前：此时 slot DOM 已就绪，且函数声明会被提升，DOMContentLoaded
 * 监听器在文档解析完成后正常触发。
 */
function injectMasterLayoutScriptsBlock(doc: Document, scripts: string): void {
  const existing = doc.querySelector(`script#${MASTER_LAYOUT_SCRIPTS_ID}`);
  if (existing) {
    existing.textContent = scripts;
    return;
  }
  const scriptEl = doc.createElement('script');
  scriptEl.id = MASTER_LAYOUT_SCRIPTS_ID;
  scriptEl.textContent = scripts;
  const body = doc.querySelector('body');
  if (body) {
    body.appendChild(scriptEl);
  } else {
    // 兜底：无 body，插到 documentElement 末尾
    doc.documentElement.appendChild(scriptEl);
  }
}

/**
 * 判断一个 <nav> 是否为"功能性导航"（面包屑/分页），不应被视为菜单剥离。
 *
 * 这些 nav 通常带 aria-label="breadcrumb"/"分页"/"pagination"，
 * 或内部包含 .breadcrumb / .pagination 列表。
 */
function isUtilityNav(nav: Element): boolean {
  const ariaLabel = (nav.getAttribute('aria-label') || '').toLowerCase();
  if (/\b(breadcrumb|pagination|面包屑|分页)\b/.test(ariaLabel)) return true;
  const cls = nav.getAttribute('class') || '';
  if (/\b(breadcrumb|pagination)\b/.test(cls)) return true;
  if (nav.querySelector('.breadcrumb, .pagination')) return true;
  return false;
}

/**
 * AI 输出兜底：检测到 nav 含多个 <a> 但无 slot，自动剥离替换为 slot 占位（§6.3.3）。
 *
 * 场景：AI 不听提示词仍画了完整 nav。此函数把它替换为 slot 占位，
 * 后续 injectMasterLayouts 会把 MasterLayout.html 填入 slot。
 *
 * 仅在项目启用了 MasterLayout 时生效；无 layout 时原样返回。
 *
 * 处理两类情况：
 * 1. 某个 layout 的 slot 缺失：找第一个非 utility nav（≥2 个 <a>）替换为 slot 占位。
 * 2. 所有 slot 已就位后，仍存在多余 nav（AI 在 slot 之外又画了一份菜单）：
 *    连同其仅包裹该 nav 的 aside/header/footer 外壳一并移除，避免留下空容器。
 *    面包屑/分页等 utility nav 不受影响。
 */
export function enforceSlotCompliance(
  html: string,
  project: DesignerProject,
): string {
  const layouts = project.masterLayouts;
  if (!layouts || layouts.length === 0) return html;

  const doc = parseHtml(html);
  let changed = false;

  // 1. 为缺失 slot 的 layout 补占位（只处理第一个非 utility nav，不在已有 slot 内）
  for (const layout of layouts) {
    const existingSlot = doc.querySelector(`[data-design-slot="${layout.slotName}"]`);
    if (existingSlot) continue;

    const navCandidates = doc.querySelectorAll('nav');
    let replaced = false;
    navCandidates.forEach(nav => {
      if (replaced) return;
      // 跳过已在某个 slot 内的 nav（属于其他 layout 的占位内容）
      if (nav.closest('[data-design-slot]')) return;
      // 跳过面包屑/分页等功能性 nav
      if (isUtilityNav(nav)) return;
      const linkCount = nav.querySelectorAll('a').length;
      if (linkCount >= 2) {
        const placeholder = doc.createElement('div');
        placeholder.setAttribute('data-design-slot', layout.slotName);
        // 同 replaceElementWithSlot：用 display: contents 让 slot div 布局透明，
        // 避免插入的包装层断开 nav 与父容器的 flex 链（详见 replaceElementWithSlot 注释）
        placeholder.style.display = 'contents';
        placeholder.innerHTML = buildSlotPlaceholder(layout.name);
        nav.replaceWith(placeholder);
        changed = true;
        replaced = true;
      }
    });
  }

  // 2. 移除 slot 之外残留的多余 nav 菜单（AI 在 slot 之外又画了一份）
  //    若该 nav 是 aside/header/footer 的唯一子元素，连同外壳一起移除，避免空容器。
  const allNavs = doc.querySelectorAll('nav');
  allNavs.forEach(nav => {
    // slot 内的 nav 会被 injectMasterLayouts 覆盖，跳过
    if (nav.closest('[data-design-slot]')) return;
    if (isUtilityNav(nav)) return;
    const linkCount = nav.querySelectorAll('a').length;
    if (linkCount < 2) return;

    const parent = nav.parentElement;
    if (
      parent &&
      ['ASIDE', 'HEADER', 'FOOTER'].includes(parent.tagName) &&
      parent.children.length === 1
    ) {
      parent.remove();
    } else {
      nav.remove();
    }
    changed = true;
  });

  return changed ? serializeHtml(doc) : html;
}

/**
 * 把指定元素替换为 slot 占位（提取流程用，§6.2）。
 * 类型无关：selector 可匹配 nav/header/footer/aside 等任意元素。
 * 返回新的完整 HTML；找不到元素时原样返回。
 */
export function replaceElementWithSlot(
  html: string,
  selector: string,
  slotName: string,
  layoutName: string,
): string {
  const doc = parseHtml(html);
  const nav = doc.querySelector(selector);
  if (!nav) return html;

  const placeholder = doc.createElement('div');
  placeholder.setAttribute('data-design-slot', slotName);
  // display: contents 让 slot div 不生成盒子，其子元素（注入的 nav）直接参与
  // 祖父级 flex 布局，如同 slot div 不存在。这是最稳妥的方案：
  //  - 不复制 navbar class（会引入 align-items: center 导致 nav 垂直居中而非拉伸）
  //  - 不需要判断哪些 class 是布局相关的（h-100/flex-grow-1/flex-shrink-0 等）
  //  - 原 nav 的所有布局 class 和 inline style 全部正常生效
  // 局限：slot 内仅含 placeholder 时（流式渲染/未注入）placeholder 也按自然尺寸显示，
  // 但这只是临时态，注入后即为真实 nav。
  placeholder.style.display = 'contents';
  placeholder.innerHTML = buildSlotPlaceholder(layoutName);
  nav.replaceWith(placeholder);

  return serializeHtml(doc);
}
