import { describe, it, expect } from 'vitest';
import {
  extractRelevantCss,
  extractRelevantScripts,
  extractMasterLayoutFromElement,
  stripStateAttributeSelectors,
  extractHandlerFunctionNames,
  collectElementClassTokens,
  blockRelevantToElement,
} from '../masterLayoutExtract';
import { sanitizeLayoutHtml } from '../masterLayoutDom';
import { injectMasterLayouts } from '../masterLayoutInject';
import { buildPreviewDocument, extractBodyContent } from '../masterLayoutPreview';
import type { MasterLayout } from '@xai/shared';

/* ── 纯逻辑小函数 ──────────────────────────────────────────────────── */

describe('stripStateAttributeSelectors', () => {
  it('strips runtime state attribute selectors but keeps structural ones', () => {
    // 状态属性选择器被剥离，保留前后选择器文本（空格来自原选择器中 ] 与后续 token 之间）
    expect(stripStateAttributeSelectors('.sidebar-dropdown[data-dropdown-open="true"] .sidebar-chevron'))
      .toBe('.sidebar-dropdown .sidebar-chevron');
    expect(stripStateAttributeSelectors('.dropdown[data-dropdown-open="false"] .xai-dropdown-menu'))
      .toBe('.dropdown .xai-dropdown-menu');
    expect(stripStateAttributeSelectors('.collapse.show')).toBe('.collapse.show');
    // 结构/身份属性必须保留
    expect(stripStateAttributeSelectors('[data-design-id="top-nav"] .item')).toBe('[data-design-id="top-nav"] .item');
    expect(stripStateAttributeSelectors('[data-nav-target="abc"]')).toBe('[data-nav-target="abc"]');
    expect(stripStateAttributeSelectors('a[href="#"]')).toBe('a[href="#"]');
  });
});

describe('extractHandlerFunctionNames', () => {
  it('extracts called function names from inline on* values, skipping globals', () => {
    expect(extractHandlerFunctionNames('event.preventDefault();toggleSidebarDropdown(this)'))
      .toEqual(['toggleSidebarDropdown']);
    expect(extractHandlerFunctionNames("doStuff(a);window.scrollTo(0,0)")).toEqual(['doStuff']);
  });
});

describe('collectElementClassTokens', () => {
  it('collects class tokens from outerHTML and element className', () => {
    const tokens = collectElementClassTokens(
      '<aside class="sidebar bg-surface"><a class="nav-link sidebar-link">x</a></aside>',
    );
    expect(tokens.has('sidebar')).toBe(true);
    expect(tokens.has('bg-surface')).toBe(true);
    expect(tokens.has('nav-link')).toBe(true);
    expect(tokens.has('sidebar-link')).toBe(true);
  });
});

describe('blockRelevantToElement', () => {
  it('matches by class token reference', () => {
    const tokens = new Set(['sidebar-link', 'sidebar-sub-link']);
    const handlers = new Set<string>();
    expect(blockRelevantToElement('document.querySelectorAll(".sidebar-link")', tokens, handlers)).toBe(true);
    expect(blockRelevantToElement('document.querySelectorAll(".other")', tokens, handlers)).toBe(false);
  });
  it('matches by handler function definition', () => {
    const tokens = new Set<string>();
    const handlers = new Set(['toggleSidebarDropdown']);
    expect(blockRelevantToElement('function toggleSidebarDropdown(el){}', tokens, handlers)).toBe(true);
    expect(blockRelevantToElement('const foo = function(){}', tokens, handlers)).toBe(false);
  });
});

/* ── CSS 提取 ──────────────────────────────────────────────────────── */

describe('extractRelevantCss', () => {
  const sidebarCss = `
    .sidebar { width: 220px; min-height: calc(100vh - 56px); }
    .sidebar .nav-link { color: var(--xai-on-surface-variant); font-size: 0.875rem; }
    .sidebar-link.active { border-left: 3px solid var(--xai-primary); color: var(--xai-primary); }
    .sidebar-parent { cursor: pointer; }
    .sidebar-dropdown[data-dropdown-open="true"] .sidebar-chevron { transform: rotate(180deg); }
    .sidebar-submenu { padding-left: 0 !important; overflow: hidden; }
    .sidebar-sub-link { padding: 6px 16px 6px 32px !important; }
    .greeting-accent { background: linear-gradient(135deg, var(--xai-primary) 0%, var(--xai-secondary) 100%); }
    .unrelated-thing { color: pink; }
  `;
  const sidebarHtml = `<aside data-design-id="sidebar" class="sidebar bg-surface">
    <nav class="p-2"><ul class="nav flex-column">
      <li class="nav-item sidebar-dropdown" data-dropdown-open="false">
        <a href="#" class="nav-link sidebar-link sidebar-parent" onclick="event.preventDefault();toggleSidebarDropdown(this)">
          <i class="bi bi-chevron-down sidebar-chevron"></i>
        </a>
        <ul class="nav flex-column sidebar-submenu" style="display:none;">
          <li class="nav-item"><a href="#" class="nav-link sidebar-sub-link">子项</a></li>
        </ul>
      </li>
    </ul></nav></aside>`;

  function buildDoc(): Document {
    return new DOMParser().parseFromString(
      `<!DOCTYPE html><html><head><style>${sidebarCss}</style></head><body>${sidebarHtml}</body></html>`,
      'text/html',
    );
  }

  it('Bug B: keeps state-attribute selector rule with original [data-dropdown-open="true"]', () => {
    const doc = buildDoc();
    const aside = doc.querySelector('aside') as HTMLElement;
    const css = extractRelevantCss(doc, aside);
    expect(css).toContain('[data-dropdown-open="true"]');
    expect(css).toContain('rotate(180deg)');
  });

  it('Bug D guard: captures .greeting-accent gradient background (element contains the span)', () => {
    const doc = new DOMParser().parseFromString(
      `<!DOCTYPE html><html><head><style>${sidebarCss}</style></head>
       <body><nav data-design-id="top-nav"><div class="greeting-accent"><i class="bi bi-fire text-white"></i></div></nav></body></html>`,
      'text/html',
    );
    const nav = doc.querySelector('nav') as HTMLElement;
    const css = extractRelevantCss(doc, nav);
    expect(css).toContain('.greeting-accent');
    expect(css).toContain('linear-gradient');
  });

  it('captures .sidebar width + .sidebar .nav-link color', () => {
    const doc = buildDoc();
    const aside = doc.querySelector('aside') as HTMLElement;
    const css = extractRelevantCss(doc, aside);
    expect(css).toContain('width: 220px');
    expect(css).toContain('var(--xai-on-surface-variant)');
  });

  it('does not capture unrelated rules', () => {
    const doc = buildDoc();
    const aside = doc.querySelector('aside') as HTMLElement;
    const css = extractRelevantCss(doc, aside);
    expect(css).not.toContain('unrelated-thing');
  });
});

/* ── JS 提取 ──────────────────────────────────────────────────────── */

const SIDEBAR_SCRIPT = `function toggleSidebarDropdown(el) {
  const parent = el.closest('.sidebar-dropdown');
  const isOpen = parent.getAttribute('data-dropdown-open') === 'true';
  const submenu = parent.querySelector('.sidebar-submenu');
  if (isOpen) { submenu.style.display = 'none'; parent.setAttribute('data-dropdown-open', 'false'); }
  else { submenu.style.display = 'block'; parent.setAttribute('data-dropdown-open', 'true'); }
}
document.addEventListener('DOMContentLoaded', function() {
  document.querySelectorAll('.sidebar-link, .sidebar-sub-link').forEach(function(link){
    link.addEventListener('click', function(e){ e.preventDefault(); this.classList.add('active'); });
  });
});`;

describe('extractRelevantScripts', () => {
  const sidebarHtml = `<aside class="sidebar">
    <li class="nav-item sidebar-dropdown" data-dropdown-open="false">
      <a href="#" class="nav-link sidebar-link sidebar-parent" onclick="event.preventDefault();toggleSidebarDropdown(this)">
        <i class="bi bi-chevron-down sidebar-chevron"></i>
      </a>
      <ul class="sidebar-submenu"><li><a class="sidebar-sub-link">子</a></li></ul>
    </li></aside>`;

  function buildDoc(): Document {
    return new DOMParser().parseFromString(
      `<!DOCTYPE html><html><head></head><body>${sidebarHtml}<script>${SIDEBAR_SCRIPT}</script>
       <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.8/dist/js/bootstrap.bundle.min.js"></script></body></html>`,
      'text/html',
    );
  }

  it('Bug A: captures toggleSidebarDropdown function definition', () => {
    const doc = buildDoc();
    const aside = doc.querySelector('aside') as HTMLElement;
    const scripts = extractRelevantScripts(doc, aside);
    expect(scripts).toContain('function toggleSidebarDropdown');
  });

  it('captures DOMContentLoaded block referencing .sidebar-link token', () => {
    const doc = buildDoc();
    const aside = doc.querySelector('aside') as HTMLElement;
    const scripts = extractRelevantScripts(doc, aside);
    expect(scripts).toContain('DOMContentLoaded');
    expect(scripts).toContain('.sidebar-sub-link');
  });

  it('skips external src scripts (bootstrap CDN)', () => {
    const doc = buildDoc();
    const aside = doc.querySelector('aside') as HTMLElement;
    const scripts = extractRelevantScripts(doc, aside);
    expect(scripts).not.toContain('bootstrap.bundle.min.js');
  });

  it('skips designer-injected scripts (id __xai_)', () => {
    const doc = new DOMParser().parseFromString(
      `<!DOCTYPE html><html><head></head><body>${sidebarHtml}
       <script id="__xai_designer_foo">document.querySelectorAll('.sidebar-link');</script></body></html>`,
      'text/html',
    );
    const aside = doc.querySelector('aside') as HTMLElement;
    const scripts = extractRelevantScripts(doc, aside);
    expect(scripts).not.toContain('__xai_designer_foo');
  });
});

/* ── sanitizeLayoutHtml + extractMasterLayoutFromElement ──────────── */

describe('extractMasterLayoutFromElement', () => {
  it('Bug C: strips <script> from layout.html and captures inline defs into scripts', () => {
    const sidebarHtml = `<aside class="sidebar">
      <a class="nav-link sidebar-link sidebar-parent" onclick="event.preventDefault();toggleSidebarDropdown(this)">x</a>
      <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.8/dist/js/bootstrap.bundle.min.js"></script>
    </aside>`;
    const doc = new DOMParser().parseFromString(
      `<!DOCTYPE html><html><head><style>.sidebar{width:220px}</style></head>
       <body>${sidebarHtml}<script>${SIDEBAR_SCRIPT}</script></body></html>`,
      'text/html',
    );
    const aside = doc.querySelector('aside') as HTMLElement;
    const { layout } = extractMasterLayoutFromElement(aside, '侧栏', 'sidebar', doc);
    expect(layout.html).not.toContain('<script');
    expect(layout.html).not.toContain('bootstrap.bundle.min.js');
    expect(layout.scripts).toContain('function toggleSidebarDropdown');
    expect(layout.css).toContain('.sidebar');
  });
});

describe('sanitizeLayoutHtml', () => {
  it('removes both external and inline script tags', () => {
    const html = `<aside><a onclick="x()">y</a><script src="a.js"></script><script>function x(){}</script></aside>`;
    const cleaned = sanitizeLayoutHtml(html);
    expect(cleaned).not.toContain('<script');
    expect(cleaned).toContain('<a onclick="x()">y</a>');
  });
  it('keeps inline onclick attributes (only strips <script> tags)', () => {
    expect(sanitizeLayoutHtml('<a onclick="foo(this)">z</a>')).toBe('<a onclick="foo(this)">z</a>');
  });
});

/* ── 注入 ──────────────────────────────────────────────────────────── */

function makeLayout(overrides: Partial<MasterLayout> = {}): MasterLayout {
  const now = new Date().toISOString();
  return {
    id: 'ml-test',
    name: '侧栏',
    type: 'sidebar',
    html: '<aside class="sidebar"><a href="#" class="nav-link sidebar-link">首页</a></aside>',
    css: '.sidebar { width: 220px; }',
    scripts: 'function toggleSidebarDropdown(el){ return el; }',
    menuItems: [],
    applyTo: { mode: 'all' },
    slotName: 'main-sidebar',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function pageWithSlot(slotName: string, inner = ''): string {
  return `<!DOCTYPE html><html><head><title>p</title></head>
    <body><div data-design-slot="${slotName}">${inner}</div>
    <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.8/dist/js/bootstrap.bundle.min.js"></script>
    </body></html>`;
}

describe('injectMasterLayouts', () => {
  it('injects css <style> and scripts <script> blocks with the expected ids', () => {
    const out = injectMasterLayouts(pageWithSlot('main-sidebar'), 's1', '首页', [makeLayout()]);
    expect(out).toContain('id="__xai_master_layout_css__"');
    expect(out).toContain('width: 220px');
    expect(out).toContain('id="__xai_master_layout_scripts__"');
    expect(out).toContain('function toggleSidebarDropdown');
  });

  it('Bug B/Step2b: expands .sidebar-dropdown ancestor data-dropdown-open to true for the winner', () => {
    const layout = makeLayout({
      html: `<aside class="sidebar"><ul>
        <li class="nav-item sidebar-dropdown" data-dropdown-open="false">
          <a href="#" class="nav-link sidebar-parent">父级</a>
          <ul class="sidebar-submenu"><li><a href="#" class="nav-link sidebar-sub-link">生产计划</a></li></ul>
        </li></ul></aside>`,
    });
    const out = injectMasterLayouts(pageWithSlot('main-sidebar'), 's1', '生产计划', [layout]);
    // winner 是“生产计划”子项，其 .sidebar-dropdown 祖先应被置 true
    const match = out.match(/<li class="nav-item sidebar-dropdown" data-dropdown-open="([^"]*)"/);
    expect(match).toBeTruthy();
    expect(match![1]).toBe('true');
  });

  it('idempotent: injecting twice yields exactly one css block and one scripts block, single .active winner', () => {
    const layout = makeLayout({
      html: `<aside class="sidebar">
        <a href="#" class="nav-link sidebar-link">首页</a>
        <a href="#" class="nav-link sidebar-link">设置</a></aside>`,
    });
    const once = injectMasterLayouts(pageWithSlot('main-sidebar'), 's1', '首页', [layout]);
    const twice = injectMasterLayouts(once, 's1', '首页', [layout]);
    expect((twice.match(/id="__xai_master_layout_css__"/g) || []).length).toBe(1);
    expect((twice.match(/id="__xai_master_layout_scripts__"/g) || []).length).toBe(1);
    // 注入 layout 快照里残留的 .active 也应被清掉，仅当前页 winner 保留
    const activeCount = (twice.match(/class="[^"]*\bactive\b[^"]*"/g) || []).length;
    expect(activeCount).toBe(1);
  });

  it('Bug C injection defense: does not double-inject Bootstrap JS from layout html', () => {
    // 旧 layout 仍带 <script src="bootstrap..."> —— 注入时应被 sanitizeLayoutHtml 清掉
    const layout = makeLayout({
      html: `<aside class="sidebar"><a class="nav-link sidebar-link">首页</a></aside>
        <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.8/dist/js/bootstrap.bundle.min.js"></script>`,
      scripts: undefined,
    });
    const out = injectMasterLayouts(pageWithSlot('main-sidebar'), 's1', '首页', [layout]);
    const bsCount = (out.match(/bootstrap\.bundle\.min\.js/g) || []).length;
    expect(bsCount).toBe(1); // 仅来自页面本身
  });

  it('returns original html when no layouts', () => {
    const page = pageWithSlot('main-sidebar');
    expect(injectMasterLayouts(page, 's1', '首页', [])).toBe(page);
  });

  it('returns original html when slot absent (old page)', () => {
    const page = '<!DOCTYPE html><html><head></head><body><p>no slot</p></body></html>';
    expect(injectMasterLayouts(page, 's1', '首页', [makeLayout()])).toBe(page);
  });
});

/* ── 预览文档 ──────────────────────────────────────────────────────── */

describe('buildPreviewDocument / extractBodyContent', () => {
  it('includes css <style> and scripts <script> blocks when provided', () => {
    const doc = buildPreviewDocument('<aside class="sidebar">x</aside>', '.sidebar{width:220px}', 'function f(){}');
    expect(doc).toContain('id="__xai_master_layout_css__"');
    expect(doc).toContain('id="__xai_master_layout_scripts__"');
    expect(doc).toContain('function f(){}');
  });

  it('omits both blocks when css/scripts absent', () => {
    const doc = buildPreviewDocument('<aside>x</aside>');
    expect(doc).not.toContain('__xai_master_layout_css__');
    expect(doc).not.toContain('__xai_master_layout_scripts__');
  });

  it('extractBodyContent strips the preview scripts block so direct-DOM saves do not leak it into layout.html', () => {
    const full = buildPreviewDocument('<aside class="sidebar">x</aside>', '.sidebar{width:220px}', 'function toggleSidebarDropdown(el){}');
    const body = extractBodyContent(full);
    expect(body).toContain('<aside');
    expect(body).not.toContain('__xai_master_layout_scripts__');
    expect(body).not.toContain('toggleSidebarDropdown');
  });

  it('extractBodyContent handles fragment without <body>', () => {
    expect(extractBodyContent('<aside>x</aside>')).toBe('<aside>x</aside>');
  });
});

/* ── 全面排查：潜在 BUG 与边界场景 ─────────────────────────────────── */

describe('Potential Bug: fire icon / gradient with var() extraction', () => {
  // 用户报告：页头组件中 fire 图标不显示，但侧栏中同样的图标正常。
  // 根因：.greeting-accent 的 linear-gradient(135deg, var(--xai-primary) 0%, ...)
  // 含 CSS 变量，happy-dom CSSOM cssText 序列化时丢失值 → 规则体为空 →
  // 渐变背景未注入预览 → 白色图标（text-white / color:transparent）在白色背景上不可见。
  it('captures gradient with var() and -webkit-background-clip:text (fire icon container)', () => {
    const css = `
      .greeting-accent {
        background: linear-gradient(135deg, var(--xai-primary) 0%, var(--xai-secondary) 100%);
        -webkit-background-clip: text;
        background-clip: text;
        color: transparent;
      }
      .fire-icon-wrap { display: inline-flex; align-items: center; }
    `;
    const html = `<header data-design-id="top-header" class="navbar">
      <span class="greeting-accent fire-icon-wrap">
        <i class="bi bi-fire text-white"></i>
      </span>
    </header>`;
    const doc = new DOMParser().parseFromString(
      `<!DOCTYPE html><html><head><style>${css}</style></head><body>${html}</body></html>`,
      'text/html',
    );
    const header = doc.querySelector('header') as HTMLElement;
    const extracted = extractRelevantCss(doc, header);
    // 渐变背景必须被捕获——否则 color:transparent 的图标会消失
    expect(extracted).toContain('linear-gradient');
    expect(extracted).toContain('var(--xai-primary)');
    expect(extracted).toContain('background-clip');
    // fire-icon-wrap 也应被捕获
    expect(extracted).toContain('fire-icon-wrap');
  });
});

describe('Potential Bug: multiple layouts with different slots', () => {
  it('injects sidebar + header layouts into their respective slots', () => {
    const sidebar = makeLayout({
      id: 'ml-sidebar',
      name: '侧栏',
      type: 'sidebar',
      slotName: 'main-sidebar',
      html: '<aside class="sidebar"><a href="#">侧栏链接</a></aside>',
      css: '.sidebar { width: 220px; }',
    });
    const header = makeLayout({
      id: 'ml-header',
      name: '页头',
      type: 'header',
      slotName: 'main-header',
      html: '<header class="navbar"><a href="#">页头链接</a></header>',
      css: '.navbar { height: 56px; }',
    });
    const page = `<!DOCTYPE html><html><head></head>
      <body>
        <div data-design-slot="main-header">旧页头</div>
        <main>内容</main>
        <div data-design-slot="main-sidebar">旧侧栏</div>
      </body></html>`;
    const out = injectMasterLayouts(page, 's1', '首页', [sidebar, header]);
    // 两个 slot 都应被替换
    expect(out).toContain('侧栏链接');
    expect(out).toContain('页头链接');
    expect(out).not.toContain('旧页头');
    expect(out).not.toContain('旧侧栏');
    // 两个 layout 的 CSS 都应注入到同一个 <style> 块
    expect(out).toContain('width: 220px');
    expect(out).toContain('height: 56px');
    const cssBlockCount = (out.match(/id="__xai_master_layout_css__"/g) || []).length;
    expect(cssBlockCount).toBe(1);
  });

  it('partial slot: one layout has slot, another does not — only injects for present slot', () => {
    const sidebar = makeLayout({
      slotName: 'main-sidebar',
      html: '<aside>侧栏</aside>',
      css: '.sidebar{width:220px}',
    });
    const header = makeLayout({
      id: 'ml-header-2',
      slotName: 'main-header',
      html: '<header>页头</header>',
      css: '.header{height:56px}',
    });
    // 页面只有 sidebar slot，没有 header slot
    const page = `<!DOCTYPE html><html><head></head>
      <body><div data-design-slot="main-sidebar">旧</div></body></html>`;
    const out = injectMasterLayouts(page, 's1', '首页', [sidebar, header]);
    // sidebar slot 被替换
    expect(out).toContain('侧栏');
    // header slot 不存在 → 不注入 header html，但 CSS 仍应注入（有任意 slot 即注入 CSS）
    expect(out).not.toContain('页头');
    expect(out).toContain('width:220px');
    expect(out).toContain('height:56px');
  });
});

describe('Potential Bug: script deduplication across layouts', () => {
  it('does not duplicate functions with the same name across layouts', () => {
    const layout1 = makeLayout({
      id: 'ml-1',
      slotName: 'main-sidebar',
      html: '<aside><a onclick="toggleDropdown(this)">x</a></aside>',
      scripts: 'function toggleDropdown(el){ console.log("v1"); }',
    });
    const layout2 = makeLayout({
      id: 'ml-2',
      slotName: 'main-header',
      html: '<header><a onclick="toggleDropdown(this)">y</a></header>',
      scripts: 'function toggleDropdown(el){ console.log("v2"); }',
    });
    const page = `<!DOCTYPE html><html><head></head>
      <body><div data-design-slot="main-sidebar"></div><div data-design-slot="main-header"></div></body></html>`;
    const out = injectMasterLayouts(page, 's1', '首页', [layout1, layout2]);
    // 只应有一个 function toggleDropdown 声明（避免 SyntaxError）
    const fnCount = (out.match(/function toggleDropdown/g) || []).length;
    expect(fnCount).toBe(1);
    // 只应有一个 scripts 块
    const blockCount = (out.match(/id="__xai_master_layout_scripts__"/g) || []).length;
    expect(blockCount).toBe(1);
  });

  it('keeps scripts with different function names from different layouts', () => {
    const layout1 = makeLayout({
      id: 'ml-1',
      slotName: 'main-sidebar',
      html: '<aside>x</aside>',
      scripts: 'function toggleSidebar(){}',
    });
    const layout2 = makeLayout({
      id: 'ml-2',
      slotName: 'main-header',
      html: '<header>y</header>',
      scripts: 'function toggleHeader(){}',
    });
    const page = `<!DOCTYPE html><html><head></head>
      <body><div data-design-slot="main-sidebar"></div><div data-design-slot="main-header"></div></body></html>`;
    const out = injectMasterLayouts(page, 's1', '首页', [layout1, layout2]);
    expect(out).toContain('function toggleSidebar');
    expect(out).toContain('function toggleHeader');
  });
});

describe('Potential Bug: collectElementClassTokens edge cases', () => {
  it('collects from deeply nested HTML with single quotes', () => {
    const html = `<div class="outer"><span class='inner mid'><i class="bi bi-fire"></i></span></div>`;
    const tokens = collectElementClassTokens(html);
    expect(tokens.has('outer')).toBe(true);
    expect(tokens.has('inner')).toBe(true);
    expect(tokens.has('mid')).toBe(true);
    expect(tokens.has('bi')).toBe(true);
    expect(tokens.has('bi-fire')).toBe(true);
  });

  it('handles empty class attributes gracefully', () => {
    const html = `<aside class=""><a class>link</a></aside>`;
    const tokens = collectElementClassTokens(html);
    expect(tokens.size).toBe(0);
  });

  it('deduplicates repeated class tokens', () => {
    const html = `<nav class="nav"><a class="nav-link">1</a><a class="nav-link">2</a></nav>`;
    const tokens = collectElementClassTokens(html);
    expect(tokens.has('nav')).toBe(true);
    expect(tokens.has('nav-link')).toBe(true);
    // Set 去重
    const navLinkCount = [...tokens].filter(t => t === 'nav-link').length;
    expect(navLinkCount).toBe(1);
  });
});

describe('Potential Bug: extractHandlerFunctionNames edge cases', () => {
  it('skips chained method calls (el.closest().querySelector())', () => {
    const handler = "this.closest('.item').querySelector('.sub').click()";
    const names = extractHandlerFunctionNames(handler);
    // closest / querySelector / click 前面都有 .，应全部跳过
    expect(names).toEqual([]);
  });

  it('captures multiple standalone function calls', () => {
    const handler = "initDropdown(this);registerEvent(this)";
    const names = extractHandlerFunctionNames(handler);
    expect(names).toContain('initDropdown');
    expect(names).toContain('registerEvent');
  });

  it('skips new keyword constructors and global names', () => {
    const handler = "new Promise(function(resolve){resolve()})";
    const names = extractHandlerFunctionNames(handler);
    // Promise 在 KNOWN_GLOBALS 中，被跳过
    expect(names).not.toContain('Promise');
    // resolve 是回调参数，前面是 { 不是 . —— 会被捕获为误报。
    // 这是可接受的容错：多识别的候选名只会触发冗余的块扫描，不会匹配到任何
    // function 定义，不影响正确性。
    expect(names).toContain('resolve');
  });
});

describe('Potential Bug: CSS extraction with @media queries', () => {
  it('falls back to raw text collection when CSSOM misses @media inner rules', () => {
    const css = `
      .sidebar { width: 220px; }
      @media (max-width: 768px) {
        .sidebar { width: 100%; }
      }
    `;
    const html = `<aside class="sidebar"><a href="#">link</a></aside>`;
    const doc = new DOMParser().parseFromString(
      `<!DOCTYPE html><html><head><style>${css}</style></head><body>${html}</body></html>`,
      'text/html',
    );
    const aside = doc.querySelector('aside') as HTMLElement;
    const extracted = extractRelevantCss(doc, aside);
    // 至少应捕获 .sidebar 的基础规则
    expect(extracted).toContain('width: 220px');
  });
});

describe('Potential Bug: sanitizeLayoutHtml edge cases', () => {
  it('removes script tags with attributes (async, defer, type)', () => {
    const html = `<aside>
      <script async>function f(){{}</script>
      <script defer src="x.js"></script>
      <script type="module">import 'y';</script>
    </aside>`;
    const cleaned = sanitizeLayoutHtml(html);
    expect(cleaned).not.toContain('<script');
    expect(cleaned).toContain('<aside>');
  });

  it('preserves SVG and other inline elements', () => {
    const html = `<header><svg class="icon" viewBox="0 0 16 16"><path d="M8 0L0 8"/></svg></header>`;
    const cleaned = sanitizeLayoutHtml(html);
    expect(cleaned).toContain('<svg');
    expect(cleaned).toContain('<path');
    expect(cleaned).toContain('viewBox');
  });
});

describe('Potential Bug: idempotent re-injection after external changes', () => {
  it('re-injecting after page edits replaces stale content without duplicates', () => {
    const layout = makeLayout({
      html: '<aside class="sidebar"><a href="#" class="nav-link sidebar-link">首页</a></aside>',
      css: '.sidebar { width: 220px; }',
      scripts: 'function toggleSidebarDropdown(el){}',
    });
    const page = pageWithSlot('main-sidebar');
    const once = injectMasterLayouts(page, 's1', '首页', [layout]);
    // 模拟用户编辑了页面其他部分（在 body 末尾加了内容）
    const edited = once.replace('</body>', '<div class="user-content">用户编辑</div></body>');
    const twice = injectMasterLayouts(edited, 's1', '首页', [layout]);
    // 用户编辑应保留
    expect(twice).toContain('用户编辑');
    // CSS/scripts 块仍只有一个
    expect((twice.match(/id="__xai_master_layout_css__"/g) || []).length).toBe(1);
    expect((twice.match(/id="__xai_master_layout_scripts__"/g) || []).length).toBe(1);
    // sidebar html 只注入一次
    const sidebarCount = (twice.match(/class="sidebar"/g) || []).length;
    expect(sidebarCount).toBe(1);
  });
});

describe('Potential Bug: empty / undefined layout fields', () => {
  it('handles layout with undefined css and scripts', () => {
    const layout = makeLayout({ css: undefined, scripts: undefined });
    const page = pageWithSlot('main-sidebar');
    const out = injectMasterLayouts(page, 's1', '首页', [layout]);
    expect(out).toContain('class="sidebar"');
    expect(out).not.toContain('__xai_master_layout_css__');
    expect(out).not.toContain('__xai_master_layout_scripts__');
  });

  it('handles layout with empty string css and scripts', () => {
    const layout = makeLayout({ css: '   ', scripts: '\n  ' });
    const page = pageWithSlot('main-sidebar');
    const out = injectMasterLayouts(page, 's1', '首页', [layout]);
    expect(out).toContain('class="sidebar"');
    expect(out).not.toContain('__xai_master_layout_css__');
    expect(out).not.toContain('__xai_master_layout_scripts__');
  });
});

describe('Potential Bug: buildPreviewDocument with full document input', () => {
  it('extracts body content when layout.html is a full HTML document', () => {
    const fullDoc = `<!DOCTYPE html><html><head><title>test</title></head><body><aside class="sidebar">content</aside></body></html>`;
    const preview = buildPreviewDocument(fullDoc, '.sidebar{width:220px}', 'function f(){}');
    // 不应嵌套 <html>/<head>/<body>
    const htmlTagCount = (preview.match(/<html/g) || []).length;
    const bodyTagCount = (preview.match(/<body/g) || []).length;
    expect(htmlTagCount).toBe(1);
    expect(bodyTagCount).toBe(1);
    expect(preview).toContain('content');
  });
});

describe('Potential Bug: highlightActiveMenuItem with AI-generated suffixes', () => {
  it('matches page with suffix "页面名 - 系统名 — 日期"', () => {
    const layout = makeLayout({
      html: `<aside class="sidebar">
        <a href="#" class="nav-link sidebar-link">首页</a>
        <a href="#" class="nav-link sidebar-link">用户管理</a>
        <a href="#" class="nav-link sidebar-link">系统设置</a>
      </aside>`,
    });
    const page = pageWithSlot('main-sidebar');
    // 页面名含 AI 拼接后缀
    const out = injectMasterLayouts(page, 's1', '用户管理 - 后台系统 — 2026-07-29', [layout]);
    // "用户管理" 应被高亮（fuzzy match: bidirectional includes）
    // 用 DOMParser 解析输出，查找带 active 类的 <a> 元素
    const outDoc = new DOMParser().parseFromString(out, 'text/html');
    const activeLink = outDoc.querySelector('a.active-side');
    expect(activeLink).toBeTruthy();
    expect(activeLink!.textContent?.trim()).toBe('用户管理');
  });
});

describe('Potential Bug: sidebar-submenu display:none not cleared on initial injection', () => {
  // 用户报告：生产计划页生成后，父菜单"生产管理"没有展开，子菜单项"生产计划"
  // 没有高亮。根因：layout 快照中 .sidebar-submenu 带 inline style="display:none"，
  // expandAncestors 只设了 data-dropdown-open="true" 但没清 display:none。
  // toggleSidebarDropdown JS 用 inline style 管理显隐，初始注入时 JS 未执行，
  // 子菜单被 display:none 遮住 → active 高亮不可见。
  it('clears inline display:none on .sidebar-submenu when expanding ancestor', () => {
    const layout = makeLayout({
      html: `<aside class="sidebar"><ul class="nav flex-column">
        <li class="nav-item sidebar-dropdown" data-dropdown-open="false">
          <a href="#" class="nav-link sidebar-link sidebar-parent" onclick="event.preventDefault();toggleSidebarDropdown(this)">
            <span>生产管理</span>
            <i class="bi bi-chevron-down sidebar-chevron"></i>
          </a>
          <ul class="nav flex-column sidebar-submenu" style="display:none;">
            <li class="nav-item"><a href="#" class="nav-link sidebar-sub-link">排产管理</a></li>
            <li class="nav-item"><a href="#" class="nav-link sidebar-sub-link">生产计划</a></li>
            <li class="nav-item"><a href="#" class="nav-link sidebar-sub-link">炉次管理</a></li>
          </ul>
        </li>
      </ul></aside>`,
    });
    const page = pageWithSlot('main-sidebar');
    const out = injectMasterLayouts(page, 's1', '生产计划 - 炼钢MES — 7/30 8:33', [layout]);

    // 解析输出，验证子菜单可见 + 高亮正确
    const outDoc = new DOMParser().parseFromString(out, 'text/html');

    // 1. 父菜单 data-dropdown-open 应为 "true"
    const dropdown = outDoc.querySelector('.sidebar-dropdown');
    expect(dropdown?.getAttribute('data-dropdown-open')).toBe('true');

    // 2. .sidebar-submenu 的 inline display:none 应被清除（改为 block）
    const submenu = outDoc.querySelector('.sidebar-submenu');
    expect(submenu).toBeTruthy();
    const submenuStyle = (submenu as HTMLElement).getAttribute('style') || '';
    expect(submenuStyle).not.toMatch(/display:\s*none/);
    expect((submenu as HTMLElement).style.display).toBe('block');

    // 3. "生产计划" 应被高亮（fuzzy match "生产计划 - 炼钢MES — 7/30 8:33"）
    const activeLink = outDoc.querySelector('a.active-side');
    expect(activeLink).toBeTruthy();
    expect(activeLink!.textContent?.trim()).toBe('生产计划');
  });

  it('does not affect collapsed dropdowns (non-winner branches stay display:none)', () => {
    const layout = makeLayout({
      html: `<aside class="sidebar"><ul class="nav flex-column">
        <li class="nav-item sidebar-dropdown" data-dropdown-open="false">
          <a href="#" class="nav-link sidebar-link sidebar-parent" onclick="event.preventDefault();toggleSidebarDropdown(this)">
            <span>生产管理</span>
          </a>
          <ul class="nav flex-column sidebar-submenu" style="display:none;">
            <li class="nav-item"><a href="#" class="nav-link sidebar-sub-link">生产计划</a></li>
          </ul>
        </li>
        <li class="nav-item sidebar-dropdown" data-dropdown-open="false">
          <a href="#" class="nav-link sidebar-link sidebar-parent" onclick="event.preventDefault();toggleSidebarDropdown(this)">
            <span>质量管理</span>
          </a>
          <ul class="nav flex-column sidebar-submenu" style="display:none;">
            <li class="nav-item"><a href="#" class="nav-link sidebar-sub-link">成分检测</a></li>
          </ul>
        </li>
      </ul></aside>`,
    });
    const page = pageWithSlot('main-sidebar');
    // 当前页是"生产计划"，"质量管理"分支不应展开
    const out = injectMasterLayouts(page, 's1', '生产计划', [layout]);
    const outDoc = new DOMParser().parseFromString(out, 'text/html');

    const dropdowns = outDoc.querySelectorAll('.sidebar-dropdown');
    expect(dropdowns.length).toBe(2);
    // 第一个（生产管理）应展开
    expect(dropdowns[0].getAttribute('data-dropdown-open')).toBe('true');
    const submenu1 = dropdowns[0].querySelector('.sidebar-submenu') as HTMLElement;
    expect(submenu1.style.display).toBe('block');
    // 第二个（质量管理）应保持折叠
    expect(dropdowns[1].getAttribute('data-dropdown-open')).toBe('false');
    const submenu2 = dropdowns[1].querySelector('.sidebar-submenu') as HTMLElement;
    expect(submenu2.style.display).toBe('none');
  });
});
