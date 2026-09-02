/**
 * Designer 组件库定义 — Bootstrap 5 + xai design token 风格
 *
 * 用于：
 *  - LayerTreePanel 的 insertElement（点击插入到选中元素 before/after/inside）
 *  - ComponentLibraryPanel 的拖拽插入（HTML5 drag-drop 到画布）
 *
 * 设计原则（Figma 级设计感）：
 *  - 所有颜色用 Bootstrap utility 类或 xai token 类（bg-surface-container / text-on-surface-variant / border-outline-variant）
 *  - 立体感用 shadow-xai-sm/md/lg + rounded-3/4
 *  - 微动效：transition + hover 状态
 *  - 图标用 Bootstrap Icons（CDN 已在 system-prompt 中引入）
 *  - 每个 container 级元素带 data-design-id（kebab-case 语义名）
 *  - 内联 style 仅用于 transition / hover 伪类等 Bootstrap 无法表达的效果
 */

/** 组件分类（顶部分类 Tab） */
export type ComponentCategory = 'layout' | 'basic' | 'form' | 'template' | 'chart';

/** 组件 ID（与历史 InsertComponentType 兼容 + 新增） */
export type ComponentId =
  // ── 历史遗留（保留兼容 LayerTreePanel 的 COMPONENT_OPTIONS）──
  | 'input'
  | 'select'
  | 'textarea'
  | 'button'
  | 'checkbox'
  | 'radio'
  | 'divider'
  | 'table-row'
  | 'table-col'
  // ── 新增：布局容器 ──
  | 'container'
  | 'row-col'
  | 'flex'
  | 'card'
  | 'section'
  | 'tabs'
  | 'navbar'
  // ── 新增：基础元素 ──
  | 'heading'
  | 'paragraph'
  | 'icon'
  | 'image'
  | 'link'
  | 'badge'
  | 'table'
  | 'alert'
  | 'pagination'
  | 'list'
  | 'dropdown'
  // ── 新增：表单 ──
  | 'switch'
  | 'range'
  | 'file'
  | 'form-group'
  | 'search'
  // ── 新增：页面布局模板 ──
  | 'tpl-header-content'
  | 'tpl-sidebar-content'
  | 'tpl-header-sidebar'
  | 'tpl-dashboard'
  // ── 新增：图表（纯 SVG 静态占位，无需图表库依赖） ──
  | 'bar-chart'
  | 'line-chart'
  | 'pie-chart'
  | 'donut-chart'
  | 'stat-card'
  | 'progress-bar';

/** 历史兼容：InsertComponentType 即 ComponentId */
export type InsertComponentType = ComponentId;

/** 组件插入位置（与历史保持一致） */
export type InsertPosition = 'before' | 'after' | 'inside';

/** 组件元数据 — 驱动组件库面板 UI */
export interface ComponentDef {
  id: ComponentId;
  /** 显示名称 */
  name: string;
  category: ComponentCategory;
  /** Bootstrap Icons 类名（如 'bi-square'），用于网格缩略图 */
  icon: string;
  /** 搜索关键词（含英文别名） */
  keywords: string;
  /** 简化 SVG 缩略图（24×16 viewBox），不含外层 svg 标签 */
  thumbnail: string;
}

/** 分类标签 */
export const CATEGORY_LABELS: Record<ComponentCategory, string> = {
  layout: '布局容器',
  basic: '基础元素',
  form: '表单',
  template: '页面模板',
  chart: '图表',
};

/**
 * 生成唯一 data-design-id（语义化 kebab-case + 时间戳防重）
 */
function designId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * 构建 component HTML 片段（设计版：Bootstrap 5 + xai token + 阴影/圆角/微动效）
 *
 * @param type       组件 ID
 * @param referenceEl 参考元素（用于继承父级 margin 等），可空
 */
export function buildComponentHtml(
  type: ComponentId,
  referenceEl?: HTMLElement | null,
  parentEl?: HTMLElement | null,
): string {
  // 判断父容器是否为 flex row 布局 —— 在 row 方向中 mb-* 会破坏交叉轴对齐
  let skipMarginBottom = false;
  if (parentEl) {
    const display = parentEl.style.display || getComputedStyle(parentEl).display || '';
    if (display === 'flex' || display === 'inline-flex') {
      const dir = parentEl.style.flexDirection || getComputedStyle(parentEl).flexDirection || 'row';
      if (dir.startsWith('row')) {
        skipMarginBottom = true;
      }
    }
  }
  // 注意：不能使用 referenceEl.className —— SVGElement 的 className 是
  // SVGAnimatedString（含 baseVal/animVal），没有 .match() 方法，会导致拖拽到
  // <svg>/<rect>/<text> 等元素时报 "_a3.match is not a function"。
  // getAttribute('class') 对 HTML / SVG 元素均返回 string，行为一致。
  const refMargin = referenceEl?.getAttribute('class')?.match(/mb-\d+/)?.[0] || '';
  const wrapperClass = skipMarginBottom ? '' : (refMargin || 'mb-3');

  switch (type) {
    // ════════════════════════════════════════════════════════════
    // 历史遗留 9 个 — 重写为 Bootstrap 5 + xai token
    // ════════════════════════════════════════════════════════════
    case 'input':
      return `<div data-design-id="${designId('input-group')}" class="${wrapperClass}"><label class="form-label small text-on-surface-variant mb-1">字段名</label><input type="text" class="form-control bg-surface-container border-outline-variant" placeholder="请输入" style="transition: border-color .15s ease, box-shadow .15s ease;" /></div>`;

    case 'select':
      return `<div data-design-id="${designId('select-group')}" class="${wrapperClass}"><label class="form-label small text-on-surface-variant mb-1">请选择</label><select class="form-select bg-surface-container border-outline-variant"><option value="">请选择</option><option value="1">选项一</option><option value="2">选项二</option></select></div>`;

    case 'textarea':
      return `<div data-design-id="${designId('textarea-group')}" class="${wrapperClass}"><label class="form-label small text-on-surface-variant mb-1">备注</label><textarea class="form-control bg-surface-container border-outline-variant" rows="3" placeholder="请输入备注" style="resize: vertical;"></textarea></div>`;

    case 'button':
      return `<button data-design-id="${designId('button')}" type="button" class="btn btn-primary px-4 py-2 rounded-3 shadow-xai-sm d-inline-flex align-items-center gap-2" style="transition: all .18s ease;"><i class="bi bi-check2-circle"></i><span>按钮</span></button>`;

    case 'checkbox':
      return `<div data-design-id="${designId('checkbox')}" class="form-check ${wrapperClass}"><input class="form-check-input bg-surface-container border-outline-variant" type="checkbox" id="${designId('cb')}" /><label class="form-check-label small text-on-surface" for="">复选项</label></div>`;

    case 'radio':
      return `<div data-design-id="${designId('radio-group')}" class="${wrapperClass}"><div class="form-check"><input class="form-check-input bg-surface-container border-outline-variant" type="radio" name="${designId('rg')}" id="${designId('r1')}" checked /><label class="form-check-label small text-on-surface" for="">选项 A</label></div><div class="form-check"><input class="form-check-input bg-surface-container border-outline-variant" type="radio" name="${designId('rg')}" id="${designId('r2')}" /><label class="form-check-label small text-on-surface" for="">选项 B</label></div></div>`;

    case 'divider':
      return `<hr data-design-id="${designId('divider')}" class="my-3 border-outline-variant" />`;

    case 'table-row':
      return `<tr data-design-id="${designId('row')}"><td class="px-3 py-2 small text-on-surface">新数据</td><td class="px-3 py-2 small text-on-surface-variant">—</td><td class="px-3 py-2 small text-on-surface-variant">—</td></tr>`;

    case 'table-col':
      return `<th data-design-id="${designId('col')}" class="px-3 py-2 small fw-medium text-on-surface-variant text-uppercase">新列</th>`;

    // ════════════════════════════════════════════════════════════
    // 新增：布局容器
    // ════════════════════════════════════════════════════════════
    case 'container':
      return `<div data-design-id="${designId('container')}" class="container ${wrapperClass} p-4 bg-surface-container rounded-3 border border-outline-variant" style="min-height: 120px;"><p class="text-on-surface-variant small text-center mb-0">容器 — 拖入其他组件</p></div>`;

    case 'row-col':
      return `<div data-design-id="${designId('row')}" class="row g-3 ${wrapperClass}"><div data-design-id="${designId('col')}" class="col-12 col-md-6"><div class="p-3 bg-surface-container rounded-3 border border-outline-variant text-center small text-on-surface-variant">列 1</div></div><div data-design-id="${designId('col')}" class="col-12 col-md-6"><div class="p-3 bg-surface-container rounded-3 border border-outline-variant text-center small text-on-surface-variant">列 2</div></div></div>`;

    case 'flex':
      return `<div data-design-id="${designId('flex')}" class="d-flex align-items-center justify-content-between gap-3 p-3 bg-surface-container rounded-3 border border-outline-variant ${wrapperClass}"><div class="small text-on-surface">弹性项 A</div><div class="small text-on-surface">弹性项 B</div></div>`;

    case 'card':
      return `<div data-design-id="${designId('card')}" class="card ${wrapperClass} shadow-xai-sm border-0 rounded-4 overflow-hidden" style="transition: box-shadow .2s ease;"><div data-design-id="${designId('card-header')}" class="card-header bg-primary-container border-0 py-3"><h6 class="mb-0 text-on-primary-container fw-semibold">卡片标题</h6></div><div data-design-id="${designId('card-body')}" class="card-body bg-surface"><p class="card-text small text-on-surface-variant mb-0">卡片描述文字，可在此放置内容。</p></div></div>`;

    case 'section':
      return `<section data-design-id="${designId('section')}" class="${wrapperClass} py-4 px-3 bg-surface-container-low rounded-4"><div data-design-id="${designId('section-title')}" class="mb-3"><h5 class="text-on-surface fw-semibold mb-1">区块标题</h5><p class="small text-on-surface-variant mb-0">区块副标题或说明</p></div><div data-design-id="${designId('section-content')}" class="p-3 bg-surface rounded-3 border border-outline-variant text-center small text-on-surface-variant">区块内容</div></section>`;

    case 'tabs':
      return `<div data-design-id="${designId('tabs')}" class="${wrapperClass}"><ul data-design-id="${designId('tab-nav')}" class="nav nav-tabs border-bottom border-outline-variant" role="tablist"><li class="nav-item"><button class="nav-link active border-0 text-on-surface fw-medium" type="button" style="border-bottom:2px solid var(--xai-primary)!important;">标签一</button></li><li class="nav-item"><button class="nav-link border-0 text-on-surface-variant" type="button">标签二</button></li><li class="nav-item"><button class="nav-link border-0 text-on-surface-variant" type="button">标签三</button></li></ul><div data-design-id="${designId('tab-content')}" class="p-3 bg-surface rounded-bottom-3 border border-top-0 border-outline-variant"><p class="small text-on-surface-variant mb-0">标签一内容区域</p></div></div>`;

    case 'navbar':
      // data-navbar-orientation: horizontal | vertical — 属性面板可切换排列方向
      return `<nav data-design-id="${designId('navbar')}" data-navbar-orientation="horizontal" class="navbar navbar-expand-lg bg-surface border-bottom border-outline-variant shadow-xai-sm ${wrapperClass} px-3 py-2"><div class="container-fluid"><a class="navbar-brand d-flex align-items-center gap-2 fw-semibold text-on-surface" href="#"><i class="bi bi-grid-3x3-gap-fill text-primary"></i><span>品牌名称</span></a><button class="navbar-toggler border-outline-variant" type="button"><span class="navbar-toggler-icon"></span></button><div class="collapse navbar-collapse"><ul class="navbar-nav ms-auto mb-0 d-flex gap-3"><li class="nav-item"><a class="nav-link small text-primary active" href="#"><i class="bi bi-house-fill me-1"></i>首页</a></li><li class="nav-item"><a class="nav-link small text-on-surface-variant" href="#"><i class="bi bi-grid me-1"></i>功能</a></li><li class="nav-item"><a class="nav-link small text-on-surface-variant" href="#"><i class="bi bi-info-circle me-1"></i>关于</a></li></ul></div></div></nav>`;

    // ════════════════════════════════════════════════════════════
    // 新增：基础元素
    // ════════════════════════════════════════════════════════════
    case 'heading':
      return `<h3 data-design-id="${designId('heading')}" class="${wrapperClass} text-on-surface fw-bold">标题文本</h3>`;

    case 'paragraph':
      return `<p data-design-id="${designId('paragraph')}" class="${wrapperClass} text-on-surface-variant" style="line-height: 1.6;">这是一段占位文字，可在此描述详细内容。点击编辑替换为你的实际文本。</p>`;

    case 'icon':
      return `<span data-design-id="${designId('icon')}" class="d-inline-flex align-items-center justify-content-center ${wrapperClass}" style="width:40px;height:40px;color: var(--xai-primary);"><i class="bi bi-star fs-4"></i></span>`;

    case 'image':
      return `<div data-design-id="${designId('image')}" class="${wrapperClass} rounded-3 overflow-hidden bg-surface-container border border-outline-variant" style="aspect-ratio: 4/3;"><svg viewBox="0 0 400 300" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:100%;display:block;"><rect width="400" height="300" fill="var(--xai-surface-container-high)"/><text x="50%" y="50%" text-anchor="middle" dy=".3em" fill="var(--xai-on-surface-variant)" font-size="14">图片占位</text></svg></div>`;

    case 'link':
      return `<a data-design-id="${designId('link')}" href="#" class="${wrapperClass} text-primary text-decoration-none d-inline-flex align-items-center gap-1" style="transition: opacity .15s ease;"><span>链接文字</span><i class="bi bi-arrow-right-short"></i></a>`;

    case 'badge':
      return `<span data-design-id="${designId('badge')}" class="badge bg-primary-container text-on-primary-container rounded-pill px-3 py-2 ${wrapperClass}">徽章</span>`;

    case 'table':
      return `<div data-design-id="${designId('table-wrap')}" class="table-responsive ${wrapperClass}"><table class="table table-hover align-middle mb-0 bg-surface"><thead><tr class="bg-primary-container"><th class="px-3 py-2 small fw-semibold text-on-primary-container">列一</th><th class="px-3 py-2 small fw-semibold text-on-primary-container">列二</th><th class="px-3 py-2 small fw-semibold text-on-primary-container">列三</th></tr></thead><tbody><tr><td class="px-3 py-2 small text-on-surface">数据 A1</td><td class="px-3 py-2 small text-on-surface-variant">数据 B1</td><td class="px-3 py-2 small text-on-surface-variant">数据 C1</td></tr><tr><td class="px-3 py-2 small text-on-surface">数据 A2</td><td class="px-3 py-2 small text-on-surface-variant">数据 B2</td><td class="px-3 py-2 small text-on-surface-variant">数据 C2</td></tr></tbody></table></div>`;

    case 'alert':
      return `<div data-design-id="${designId('alert')}" class="alert d-flex align-items-center gap-2 rounded-3 border-0 mb-3" role="alert" style="background-color: var(--xai-primary-container); color: var(--xai-on-primary-container);"><i class="bi bi-info-circle-fill"></i><span class="small">这是一条提示信息</span></div>`;

    case 'pagination':
      return `<nav data-design-id="${designId('pagination')}" aria-label="分页" class="${wrapperClass}"><ul class="pagination mb-0"><li class="page-item disabled"><a class="page-link bg-surface border-outline-variant text-on-surface-variant" href="#"><i class="bi bi-chevron-left"></i></a></li><li class="page-item"><a class="page-link bg-surface border-outline-variant text-on-surface" href="#">1</a></li><li class="page-item active"><a class="page-link bg-primary border-primary text-on-primary-container" href="#">2</a></li><li class="page-item"><a class="page-link bg-surface border-outline-variant text-on-surface" href="#">3</a></li><li class="page-item"><a class="page-link bg-surface border-outline-variant text-on-surface" href="#"><i class="bi bi-chevron-right"></i></a></li></ul></nav>`;

    case 'list':
      return `<ul data-design-id="${designId('list')}" class="list-group ${wrapperClass} shadow-xai-sm rounded-3 overflow-hidden"><li class="list-group-item d-flex align-items-center justify-content-between bg-surface border-bottom border-outline-variant px-3 py-2"><div class="d-flex align-items-center gap-2"><i class="bi bi-folder-fill text-primary small"></i><span class="small text-on-surface">列表项一</span></div><span class="badge bg-primary-container text-on-primary-container rounded-pill small">12</span></li><li class="list-group-item d-flex align-items-center justify-content-between bg-surface border-bottom border-outline-variant px-3 py-2"><div class="d-flex align-items-center gap-2"><i class="bi bi-folder-fill text-primary small"></i><span class="small text-on-surface">列表项二</span></div><span class="badge bg-primary-container text-on-primary-container rounded-pill small">8</span></li><li class="list-group-item d-flex align-items-center justify-content-between bg-outline-variant px-3 py-2"><div class="d-flex align-items-center gap-2"><i class="bi bi-folder-fill text-primary small"></i><span class="small text-on-surface">列表项三</span></div><span class="badge bg-primary-container text-on-primary-container rounded-pill small">5</span></li></ul>`;

    case 'dropdown':
      // 下拉菜单 — nav-link 风格触发器 + 右侧小三角 + 可折叠子菜单
      // 适合用作导航二级菜单、操作菜单、用户菜单等
      // data-dropdown-open="true" 控制展开/折叠状态（canvas 中默认展开便于编辑）
      // data-dropdown-toggle="true" 标记触发器（design-mode 点击切换展开/折叠）
      // data-dropdown-item="true" 标记子菜单项（属性面板显示图标编辑器）
      return `<div data-design-id="${designId('dropdown')}" class="${wrapperClass} nav-item dropdown position-relative" data-dropdown-open="true"><a href="#" data-design-id="${designId('dropdown-toggle')}" data-dropdown-toggle="true" class="nav-link small d-inline-flex align-items-center gap-1 text-on-surface-variant text-decoration-none" style="cursor: pointer;"><span>下拉菜单</span><i class="bi bi-chevron-down ms-1 small xai-dropdown-chevron"></i></a><div data-design-id="${designId('dropdown-menu')}" class="xai-dropdown-menu shadow-xai-sm rounded-3 border border-outline-variant bg-surface overflow-hidden mt-1" style="min-width: 200px;"><a href="#" data-design-id="${designId('dropdown-item')}" data-dropdown-item="true" class="d-flex align-items-center gap-2 px-3 py-2 small text-on-surface text-decoration-none" style="transition: background-color .15s ease;"><i class="bi bi-house-fill text-primary"></i><span class="flex-grow-1">菜单项一</span></a><a href="#" data-design-id="${designId('dropdown-item')}" data-dropdown-item="true" class="d-flex align-items-center gap-2 px-3 py-2 small text-decoration-none bg-primary-container" style="transition: background-color .15s ease;"><i class="bi bi-grid-fill text-on-primary-container"></i><span class="flex-grow-1 text-on-primary-container">菜单项二</span><span class="badge bg-on-primary-container text-primary-container rounded-pill small">2</span></a><a href="#" data-design-id="${designId('dropdown-item')}" data-dropdown-item="true" class="d-flex align-items-center gap-2 px-3 py-2 small text-on-surface text-decoration-none" style="transition: background-color .15s ease;"><i class="bi bi-gear-fill text-primary"></i><span class="flex-grow-1">菜单项三</span></a><div class="dropdown-divider border-outline-variant my-1"></div><a href="#" data-design-id="${designId('dropdown-item')}" data-dropdown-item="true" class="d-flex align-items-center gap-2 px-3 py-2 small text-on-surface text-decoration-none" style="transition: background-color .15s ease;"><i class="bi bi-box-arrow-right text-primary"></i><span class="flex-grow-1">退出登录</span></a></div></div>`;

    // ════════════════════════════════════════════════════════════
    // 新增：表单
    // ════════════════════════════════════════════════════════════
    case 'switch':
      return `<div data-design-id="${designId('switch')}" class="form-check form-switch ${wrapperClass}"><input class="form-check-input" type="checkbox" role="switch" id="${designId('sw')}" checked /><label class="form-check-label small text-on-surface" for="">开关项</label></div>`;

    case 'range':
      return `<div data-design-id="${designId('range-group')}" class="${wrapperClass}"><label class="form-label small text-on-surface-variant mb-1 d-flex justify-content-between"><span>范围</span><span class="text-on-surface">50</span></label><input type="range" class="form-range" min="0" max="100" value="50" /></div>`;

    case 'file':
      return `<div data-design-id="${designId('file-group')}" class="${wrapperClass}"><label class="form-label small text-on-surface-variant mb-1">上传文件</label><input type="file" class="form-control bg-surface-container border-outline-variant" /></div>`;

    case 'form-group':
      return `<div data-design-id="${designId('form-group')}" class="${wrapperClass} p-3 bg-surface-container rounded-3 border border-outline-variant"><div class="mb-2"><label class="form-label small text-on-surface-variant mb-1">用户名</label><input type="text" class="form-control bg-surface border-outline-variant" placeholder="请输入用户名" /></div><div><label class="form-label small text-on-surface-variant mb-1">密码</label><input type="password" class="form-control bg-surface border-outline-variant" placeholder="请输入密码" /></div></div>`;

    case 'search':
      // 搜索框 — input-group + 搜索图标 + 搜索按钮
      return `<div data-design-id="${designId('search')}" class="${wrapperClass}"><div class="input-group"><span class="input-group-text bg-surface-container border-outline-variant text-on-surface-variant"><i class="bi bi-search"></i></span><input type="search" class="form-control bg-surface-container border-outline-variant" placeholder="输入关键词搜索" aria-label="搜索" style="transition: border-color .15s ease, box-shadow .15s ease;" /><button class="btn btn-primary px-3 rounded-end-3" type="button" style="transition: all .18s ease;"><i class="bi bi-search me-1"></i><span>搜索</span></button></div></div>`;

    // ════════════════════════════════════════════════════════════
    // 新增：页面布局模板（填满视口，提供完整页面结构）
    // ════════════════════════════════════════════════════════════
    case 'tpl-header-content':
      // 顶部导航栏：使用 navbar 组件（horizontal 排列方向）
      return `<div data-design-id="tpl-header-content" class="d-flex flex-column" style="min-height:100vh;">
  <nav data-design-id="navbar" data-navbar-orientation="horizontal" class="navbar navbar-expand-lg bg-surface border-bottom border-outline-variant shadow-xai-sm flex-shrink-0 px-3 py-2"><div class="container-fluid"><a class="navbar-brand d-flex align-items-center gap-2 fw-semibold text-on-surface" href="#"><i class="bi bi-grid-3x3-gap-fill text-primary"></i><span>应用名称</span></a><button class="navbar-toggler border-outline-variant" type="button"><span class="navbar-toggler-icon"></span></button><div class="collapse navbar-collapse"><ul class="navbar-nav ms-auto mb-0 d-flex gap-3"><li class="nav-item"><a class="nav-link small text-primary active" href="#"><i class="bi bi-house-fill me-1"></i>首页</a></li><li class="nav-item"><a class="nav-link small text-on-surface-variant" href="#"><i class="bi bi-grid me-1"></i>功能</a></li><li class="nav-item"><a class="nav-link small text-on-surface-variant" href="#"><i class="bi bi-info-circle me-1"></i>关于</a></li></ul></div></div></nav>
  <main data-design-id="main" class="flex-grow-1 p-4 bg-surface-container-low">
    <div class="text-center text-on-surface-variant small" style="padding:60px 0;">主内容区域</div>
  </main>
</div>`;

    case 'tpl-sidebar-content':
      // 左侧导航栏：使用 navbar 组件（vertical 排列方向，border-end 适配侧边布局）
      return `<div data-design-id="tpl-sidebar-content" class="d-flex" style="min-height:100vh;">
  <nav data-design-id="navbar" data-navbar-orientation="vertical" class="navbar navbar-expand-lg bg-surface border-end border-outline-variant shadow-xai-sm flex-shrink-0 px-3 py-2" style="width:220px;"><div class="container-fluid"><a class="navbar-brand d-flex align-items-center gap-2 fw-semibold text-on-surface" href="#"><i class="bi bi-menu-button-wide-fill text-primary"></i><span>应用名称</span></a><button class="navbar-toggler border-outline-variant" type="button"><span class="navbar-toggler-icon"></span></button><div class="collapse navbar-collapse"><ul class="navbar-nav ms-auto mb-0 d-flex gap-3"><li class="nav-item"><a class="nav-link small text-primary active" href="#"><i class="bi bi-house-fill me-1"></i>首页</a></li><li class="nav-item"><a class="nav-link small text-on-surface-variant" href="#"><i class="bi bi-search me-1"></i>搜索</a></li><li class="nav-item"><a class="nav-link small text-on-surface-variant" href="#"><i class="bi bi-gear me-1"></i>设置</a></li></ul></div></div><div data-navbar-collapse-toggle="true" class="xai-navbar-collapse-toggle"><i class="bi bi-chevron-left"></i></div><div data-navbar-resizer="true" class="xai-navbar-resizer" style="pointer-events:none;"></div></nav>
  <main data-design-id="main" class="flex-grow-1 p-4 bg-surface-container-low">
    <div class="text-center text-on-surface-variant small" style="padding:60px 0;">主内容区域</div>
  </main>
</div>`;

    case 'tpl-header-sidebar':
      // 顶部 header 保留品牌+用户区；左侧导航栏使用 navbar 组件（vertical 排列方向）
      return `<div data-design-id="tpl-header-sidebar" class="d-flex flex-column" style="min-height:100vh;">
  <header data-design-id="header" class="d-flex align-items-center justify-content-between px-4 py-3 bg-surface border-bottom border-outline-variant shadow-xai-sm">
    <div class="d-flex align-items-center gap-2"><i class="bi bi-grid-3x3-gap-fill text-primary"></i><span class="fw-semibold text-on-surface">应用名称</span></div>
    <div class="d-flex align-items-center gap-3"><a href="#" class="text-on-surface-variant text-decoration-none small">帮助</a><div class="rounded-circle bg-primary-container d-flex align-items-center justify-content-center" style="width:28px;height:28px;"><i class="bi bi-person-fill small text-on-primary-container"></i></div></div>
  </header>
  <div class="d-flex flex-grow-1">
    <nav data-design-id="navbar" data-navbar-orientation="vertical" class="navbar navbar-expand-lg bg-surface border-end border-outline-variant shadow-xai-sm flex-shrink-0 px-3 py-2" style="width:200px;"><div class="container-fluid"><a class="navbar-brand d-flex align-items-center gap-2 fw-semibold text-on-surface" href="#"><i class="bi bi-list-ul text-primary"></i><span>导航</span></a><button class="navbar-toggler border-outline-variant" type="button"><span class="navbar-toggler-icon"></span></button><div class="collapse navbar-collapse"><ul class="navbar-nav ms-auto mb-0 d-flex gap-3"><li class="nav-item"><a class="nav-link small text-primary active" href="#"><i class="bi bi-house-fill me-1"></i>首页</a></li><li class="nav-item"><a class="nav-link small text-on-surface-variant" href="#"><i class="bi bi-search me-1"></i>搜索</a></li><li class="nav-item"><a class="nav-link small text-on-surface-variant" href="#"><i class="bi bi-heart me-1"></i>收藏</a></li><li class="nav-item"><a class="nav-link small text-on-surface-variant" href="#"><i class="bi bi-gear me-1"></i>设置</a></li></ul></div></div><div data-navbar-collapse-toggle="true" class="xai-navbar-collapse-toggle"><i class="bi bi-chevron-left"></i></div><div data-navbar-resizer="true" class="xai-navbar-resizer" style="pointer-events:none;"></div></nav>
    <main data-design-id="main" class="flex-grow-1 p-4 bg-surface-container-low">
      <div class="text-center text-on-surface-variant small" style="padding:60px 0;">主内容区域</div>
    </main>
  </div>
</div>`;

    case 'tpl-dashboard':
      // 左侧导航栏：使用 navbar 组件（vertical 排列方向，border-end 适配侧边布局）
      return `<div data-design-id="tpl-dashboard" class="d-flex" style="min-height:100vh;">
  <nav data-design-id="navbar" data-navbar-orientation="vertical" class="navbar navbar-expand-lg bg-surface border-end border-outline-variant shadow-xai-sm flex-shrink-0 px-3 py-2" style="width:220px;"><div class="container-fluid"><a class="navbar-brand d-flex align-items-center gap-2 fw-semibold text-on-surface" href="#"><i class="bi bi-bar-chart-fill text-primary"></i><span>Dashboard</span></a><button class="navbar-toggler border-outline-variant" type="button"><span class="navbar-toggler-icon"></span></button><div class="collapse navbar-collapse"><ul class="navbar-nav ms-auto mb-0 d-flex gap-3"><li class="nav-item"><a class="nav-link small text-primary active" href="#"><i class="bi bi-speedometer2 me-1"></i>概览</a></li><li class="nav-item"><a class="nav-link small text-on-surface-variant" href="#"><i class="bi bi-graph-up me-1"></i>分析</a></li><li class="nav-item"><a class="nav-link small text-on-surface-variant" href="#"><i class="bi bi-people me-1"></i>用户</a></li><li class="nav-item"><a class="nav-link small text-on-surface-variant" href="#"><i class="bi bi-gear me-1"></i>设置</a></li></ul></div></div><div data-navbar-collapse-toggle="true" class="xai-navbar-collapse-toggle"><i class="bi bi-chevron-left"></i></div><div data-navbar-resizer="true" class="xai-navbar-resizer" style="pointer-events:none;"></div></nav>
  <div class="d-flex flex-column flex-grow-1">
    <header data-design-id="header" class="d-flex align-items-center justify-content-between px-4 py-3 bg-surface border-bottom border-outline-variant shadow-xai-sm">
      <h6 class="mb-0 text-on-surface fw-semibold">概览</h6>
      <div class="d-flex align-items-center gap-2"><span class="badge bg-primary-container text-on-primary-container rounded-pill small">管理员</span><div class="rounded-circle bg-surface-container-high d-flex align-items-center justify-content-center" style="width:28px;height:28px;"><i class="bi bi-person small text-on-surface-variant"></i></div></div>
    </header>
    <main data-design-id="main" class="flex-grow-1 p-4 bg-surface-container-low">
      <div class="row g-3 mb-4">
        <div class="col-12 col-md-4"><div class="p-3 bg-surface rounded-3 border border-outline-variant shadow-xai-sm"><div class="small text-on-surface-variant">总用户</div><div class="fs-4 fw-bold text-on-surface">1,280</div></div></div>
        <div class="col-12 col-md-4"><div class="p-3 bg-surface rounded-3 border border-outline-variant shadow-xai-sm"><div class="small text-on-surface-variant">活跃用户</div><div class="fs-4 fw-bold text-primary">856</div></div></div>
        <div class="col-12 col-md-4"><div class="p-3 bg-surface rounded-3 border border-outline-variant shadow-xai-sm"><div class="small text-on-surface-variant">收入</div><div class="fs-4 fw-bold text-on-surface">¥12.5k</div></div></div>
      </div>
      <div class="p-4 bg-surface rounded-3 border border-outline-variant text-center text-on-surface-variant small">详细内容区域</div>
    </main>
  </div>
</div>`;

    // ════════════════════════════════════════════════════════════
    // 新增：图表组件（纯 SVG 静态占位，与 xai token 配色一致）
    // ════════════════════════════════════════════════════════════
    case 'bar-chart':
      return `<div data-design-id="${designId('bar-chart')}" class="${wrapperClass} p-3 bg-surface rounded-3 border border-outline-variant shadow-xai-sm"><div class="d-flex align-items-center justify-content-between mb-2"><span class="small fw-semibold text-on-surface">柱状图</span><span class="badge bg-primary-container text-on-primary-container rounded-pill small">月度</span></div><svg viewBox="0 0 240 120" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;display:block;"><g><rect x="10" y="60" width="24" height="50" rx="2" fill="var(--xai-primary)" opacity="0.6"/><rect x="42" y="40" width="24" height="70" rx="2" fill="var(--xai-primary)" opacity="0.75"/><rect x="74" y="20" width="24" height="90" rx="2" fill="var(--xai-primary)"/><rect x="106" y="50" width="24" height="60" rx="2" fill="var(--xai-primary)" opacity="0.7"/><rect x="138" y="30" width="24" height="80" rx="2" fill="var(--xai-primary)" opacity="0.85"/><rect x="170" y="55" width="24" height="55" rx="2" fill="var(--xai-primary)" opacity="0.65"/><rect x="202" y="35" width="24" height="75" rx="2" fill="var(--xai-primary)" opacity="0.8"/></g><line x1="6" y1="110" x2="232" y2="110" stroke="var(--xai-outline-variant)" stroke-width="1"/></svg></div>`;

    case 'line-chart': {
      const lineGradId = `lcg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      return `<div data-design-id="${designId('line-chart')}" class="${wrapperClass} p-3 bg-surface rounded-3 border border-outline-variant shadow-xai-sm"><div class="d-flex align-items-center justify-content-between mb-2"><span class="small fw-semibold text-on-surface">折线图</span><span class="badge bg-success-subtle text-success rounded-pill small">+12.5%</span></div><svg viewBox="0 0 240 120" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;display:block;"><defs><linearGradient id="${lineGradId}" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="var(--xai-primary)" stop-opacity="0.35"/><stop offset="100%" stop-color="var(--xai-primary)" stop-opacity="0"/></linearGradient></defs><path d="M10,90 L40,75 L70,80 L100,55 L130,60 L160,35 L190,40 L220,20 L220,110 L10,110 Z" fill="url(#${lineGradId})"/><polyline points="10,90 40,75 70,80 100,55 130,60 160,35 190,40 220,20" fill="none" stroke="var(--xai-primary)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><g fill="var(--xai-primary)"><circle cx="10" cy="90" r="2.5"/><circle cx="70" cy="80" r="2.5"/><circle cx="130" cy="60" r="2.5"/><circle cx="190" cy="40" r="2.5"/><circle cx="220" cy="20" r="2.5"/></g><line x1="6" y1="110" x2="232" y2="110" stroke="var(--xai-outline-variant)" stroke-width="1"/></svg></div>`;
    }

    case 'pie-chart':
      return `<div data-design-id="${designId('pie-chart')}" class="${wrapperClass} p-3 bg-surface rounded-3 border border-outline-variant shadow-xai-sm"><div class="d-flex align-items-center justify-content-between mb-2"><span class="small fw-semibold text-on-surface">饼图</span></div><div class="d-flex align-items-center gap-3"><svg viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg" style="width:100px;height:100px;display:block;flex-shrink:0;"><circle cx="60" cy="60" r="50" fill="var(--xai-surface-container-high)"/><path d="M60,60 L60,10 A50,50 0 0,1 108.66,75 Z" fill="var(--xai-primary)"/><path d="M60,60 L108.66,75 A50,50 0 0,1 28.66,98.30 Z" fill="var(--xai-primary)" opacity="0.7"/><path d="M60,60 L28.66,98.30 A50,50 0 0,1 60,10 Z" fill="var(--xai-primary)" opacity="0.4"/></svg><ul class="list-unstyled mb-0 small d-flex flex-column gap-1"><li class="d-flex align-items-center gap-2"><span style="width:10px;height:10px;background:var(--xai-primary);border-radius:2px;display:inline-block;"></span><span class="text-on-surface">类别 A 45%</span></li><li class="d-flex align-items-center gap-2"><span style="width:10px;height:10px;background:var(--xai-primary);opacity:0.7;border-radius:2px;display:inline-block;"></span><span class="text-on-surface-variant">类别 B 30%</span></li><li class="d-flex align-items-center gap-2"><span style="width:10px;height:10px;background:var(--xai-primary);opacity:0.4;border-radius:2px;display:inline-block;"></span><span class="text-on-surface-variant">类别 C 25%</span></li></ul></div></div>`;

    case 'donut-chart':
      return `<div data-design-id="${designId('donut-chart')}" class="${wrapperClass} p-3 bg-surface rounded-3 border border-outline-variant shadow-xai-sm"><div class="d-flex align-items-center justify-content-between mb-2"><span class="small fw-semibold text-on-surface">环形图</span></div><div class="d-flex align-items-center gap-3"><svg viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg" style="width:100px;height:100px;display:block;flex-shrink:0;"><circle cx="60" cy="60" r="42" fill="none" stroke="var(--xai-surface-container-high)" stroke-width="16"/><circle cx="60" cy="60" r="42" fill="none" stroke="var(--xai-primary)" stroke-width="16" stroke-dasharray="198 264" stroke-dashoffset="0" transform="rotate(-90 60 60)"/><circle cx="60" cy="60" r="42" fill="none" stroke="var(--xai-primary)" stroke-width="16" stroke-dasharray="66 264" stroke-dashoffset="-198" transform="rotate(-90 60 60)" opacity="0.6"/><text x="60" y="56" text-anchor="middle" fill="var(--xai-on-surface)" font-size="16" font-weight="600">75%</text><text x="60" y="72" text-anchor="middle" fill="var(--xai-on-surface-variant)" font-size="9">完成率</text></svg><ul class="list-unstyled mb-0 small d-flex flex-column gap-1"><li class="d-flex align-items-center gap-2"><span style="width:10px;height:10px;background:var(--xai-primary);border-radius:2px;display:inline-block;"></span><span class="text-on-surface">已完成 75%</span></li><li class="d-flex align-items-center gap-2"><span style="width:10px;height:10px;background:var(--xai-primary);opacity:0.6;border-radius:2px;display:inline-block;"></span><span class="text-on-surface-variant">进行中 25%</span></li></ul></div></div>`;

    case 'stat-card':
      return `<div data-design-id="${designId('stat-card')}" class="${wrapperClass} p-3 bg-surface rounded-3 border border-outline-variant shadow-xai-sm" style="transition: box-shadow .2s ease;"><div class="d-flex align-items-start justify-content-between"><div><div class="small text-on-surface-variant mb-1">总用户数</div><div class="d-flex align-items-baseline gap-2"><span class="fs-3 fw-bold text-on-surface">12,847</span><span class="small text-success d-inline-flex align-items-center gap-1"><i class="bi bi-arrow-up-short"></i>12.5%</span></div></div><div class="rounded-3 d-flex align-items-center justify-content-center bg-primary-container" style="width:40px;height:40px;"><i class="bi bi-people-fill text-on-primary-container"></i></div></div></div>`;

    case 'progress-bar':
      return `<div data-design-id="${designId('progress-bar')}" class="${wrapperClass} p-3 bg-surface rounded-3 border border-outline-variant shadow-xai-sm"><div class="d-flex align-items-center justify-content-between mb-2"><span class="small fw-medium text-on-surface">项目进度</span><span class="small text-on-surface-variant">68%</span></div><div class="progress bg-surface-container-high" style="height:8px;border-radius:4px;"><div class="progress-bar bg-primary" role="progressbar" style="width:68%;border-radius:4px;transition:width .3s ease;"></div></div><div class="d-flex justify-content-between mt-2"><span class="small text-on-surface-variant">已完成 34 项</span><span class="small text-on-surface-variant">共 50 项</span></div></div>`;

    default:
      return `<div data-design-id="${designId('element')}" class="${wrapperClass} p-3 bg-surface-container rounded-3">新元素</div>`;
  }
}

/**
 * 组件清单 — 驱动 ComponentLibraryPanel 网格 UI
 * 缩略图 SVG 内容（不含 svg 标签），坐标空间 24×16
 */
export const COMPONENTS: ComponentDef[] = [
  // ── 布局容器 ──
  {
    id: 'container', name: '容器', category: 'layout', icon: 'bi-bounding-box',
    keywords: 'container 容器 wrapper 包裹 box',
    thumbnail: '<rect x="2" y="3" width="20" height="10" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.2"/><rect x="5" y="6" width="14" height="4" rx="0.5" fill="currentColor" opacity="0.15"/>',
  },
  {
    id: 'row-col', name: '栅格行', category: 'layout', icon: 'bi-layout-three-columns',
    keywords: 'row col grid 栅格 列 栏目',
    thumbnail: '<rect x="2" y="3" width="9" height="10" rx="0.8" fill="currentColor" opacity="0.25"/><rect x="13" y="3" width="9" height="10" rx="0.8" fill="currentColor" opacity="0.15"/>',
  },
  {
    id: 'flex', name: '弹性布局', category: 'layout', icon: 'bi-distribute-horizontal',
    keywords: 'flex 弹性 横排 align',
    thumbnail: '<rect x="2" y="3" width="20" height="10" rx="1" fill="none" stroke="currentColor" stroke-width="1" stroke-dasharray="1.5 1"/><rect x="4" y="6" width="6" height="4" fill="currentColor" opacity="0.4"/><rect x="11" y="6" width="6" height="4" fill="currentColor" opacity="0.25"/><rect x="18" y="6" width="2" height="4" fill="currentColor" opacity="0.15"/>',
  },
  {
    id: 'card', name: '卡片', category: 'layout', icon: 'bi-card-text',
    keywords: 'card 卡片 panel 面板',
    thumbnail: '<rect x="3" y="2" width="18" height="12" rx="1.5" fill="none" stroke="currentColor" stroke-width="1"/><rect x="3" y="2" width="18" height="3" fill="currentColor" opacity="0.25"/><line x1="6" y1="8" x2="18" y2="8" stroke="currentColor" stroke-width="1" opacity="0.4"/><line x1="6" y1="11" x2="14" y2="11" stroke="currentColor" stroke-width="1" opacity="0.3"/>',
  },
  {
    id: 'section', name: '内容区块', category: 'layout', icon: 'bi-layout-text-window-reverse',
    keywords: 'section 区块 block 区域',
    thumbnail: '<rect x="2" y="3" width="20" height="10" rx="1" fill="currentColor" opacity="0.1"/><rect x="4" y="5" width="6" height="1.5" fill="currentColor" opacity="0.6"/><rect x="4" y="8" width="16" height="4" rx="0.5" fill="none" stroke="currentColor" stroke-width="0.8"/>',
  },
  {
    id: 'divider', name: '分隔线', category: 'layout', icon: 'bi-dash',
    keywords: 'divider hr 分隔线 分割',
    thumbnail: '<line x1="2" y1="8" x2="22" y2="8" stroke="currentColor" stroke-width="1.5"/>',
  },
  {
    id: 'tabs', name: '选项卡', category: 'layout', icon: 'bi-folder2-open',
    keywords: 'tabs 选项卡 tab 切换 标签页',
    thumbnail: '<rect x="2" y="3" width="6" height="3" rx="0.8" fill="currentColor"/><rect x="9" y="3" width="6" height="3" rx="0.8" fill="currentColor" opacity="0.3"/><rect x="16" y="3" width="6" height="3" rx="0.8" fill="currentColor" opacity="0.3"/><rect x="2" y="6" width="20" height="7" rx="0.8" fill="none" stroke="currentColor" stroke-width="0.8"/>',
  },
  {
    id: 'navbar', name: '导航栏', category: 'layout', icon: 'bi-menu-app',
    keywords: 'navbar 导航栏 menu 菜单 顶部栏 header',
    thumbnail: '<rect x="2" y="3" width="20" height="3" rx="0.8" fill="currentColor" opacity="0.4"/><rect x="4" y="4" width="3" height="1" fill="currentColor"/><rect x="14" y="4" width="2" height="1" fill="currentColor" opacity="0.6"/><rect x="17" y="4" width="2" height="1" fill="currentColor" opacity="0.6"/><rect x="20" y="4" width="1.5" height="1" fill="currentColor" opacity="0.6"/>',
  },
  // ── 基础元素 ──
  {
    id: 'heading', name: '标题', category: 'basic', icon: 'bi-type-h1',
    keywords: 'heading title 标题 h1 h2 h3',
    thumbnail: '<rect x="3" y="5" width="14" height="2.4" rx="0.4" fill="currentColor"/><rect x="3" y="9" width="8" height="1.4" rx="0.3" fill="currentColor" opacity="0.4"/>',
  },
  {
    id: 'paragraph', name: '段落', category: 'basic', icon: 'bi-paragraph',
    keywords: 'paragraph text 段落 文本 p',
    thumbnail: '<line x1="3" y1="5" x2="21" y2="5" stroke="currentColor" stroke-width="1" opacity="0.6"/><line x1="3" y1="8" x2="21" y2="8" stroke="currentColor" stroke-width="1" opacity="0.5"/><line x1="3" y1="11" x2="16" y2="11" stroke="currentColor" stroke-width="1" opacity="0.4"/>',
  },
  {
    id: 'button', name: '按钮', category: 'basic', icon: 'bi-square',
    keywords: 'button btn 按钮 action',
    thumbnail: '<rect x="6" y="5" width="12" height="6" rx="3" fill="currentColor"/><circle cx="9" cy="8" r="0.8" fill="#fff"/>',
  },
  {
    id: 'icon', name: '图标', category: 'basic', icon: 'bi-star',
    keywords: 'icon 图标 star',
    thumbnail: '<path d="M12 4 L13.6 8 L17.8 8 L14.4 10.5 L15.6 14.5 L12 12 L8.4 14.5 L9.6 10.5 L6.2 8 L10.4 8 Z" fill="currentColor"/>',
  },
  {
    id: 'image', name: '图片', category: 'basic', icon: 'bi-image',
    keywords: 'image picture 图片 图像',
    thumbnail: '<rect x="2" y="3" width="20" height="10" rx="1" fill="none" stroke="currentColor" stroke-width="1"/><circle cx="7" cy="7" r="1.5" fill="currentColor"/><path d="M3 12 L8 8 L12 11 L17 6 L21 10 L21 13 L3 13 Z" fill="currentColor" opacity="0.35"/>',
  },
  {
    id: 'link', name: '链接', category: 'basic', icon: 'bi-link-45deg',
    keywords: 'link a 链接 url',
    thumbnail: '<line x1="3" y1="8" x2="17" y2="8" stroke="currentColor" stroke-width="1.2"/><polyline points="15,5 19,8 15,11" fill="none" stroke="currentColor" stroke-width="1.2"/>',
  },
  {
    id: 'badge', name: '徽章', category: 'basic', icon: 'bi-bookmark-fill',
    keywords: 'badge tag chip 标签 徽章',
    thumbnail: '<rect x="5" y="6" width="14" height="4" rx="2" fill="currentColor" opacity="0.7"/>',
  },
  {
    id: 'table', name: '表格', category: 'basic', icon: 'bi-table',
    keywords: 'table 表格 grid 数据 表',
    thumbnail: '<rect x="2" y="3" width="20" height="10" rx="0.8" fill="none" stroke="currentColor" stroke-width="0.8"/><line x1="2" y1="6" x2="22" y2="6" stroke="currentColor" stroke-width="0.8"/><line x1="9" y1="6" x2="9" y2="13" stroke="currentColor" stroke-width="0.8" opacity="0.6"/><line x1="15" y1="6" x2="15" y2="13" stroke="currentColor" stroke-width="0.8" opacity="0.6"/><rect x="2" y="3" width="20" height="3" fill="currentColor" opacity="0.25"/>',
  },
  {
    id: 'alert', name: '提示框', category: 'basic', icon: 'bi-info-circle-fill',
    keywords: 'alert 提示 警告 通知 message',
    thumbnail: '<rect x="2" y="4" width="20" height="8" rx="1.5" fill="currentColor" opacity="0.18"/><circle cx="5" cy="8" r="1.4" fill="currentColor"/><line x1="8" y1="8" x2="19" y2="8" stroke="currentColor" stroke-width="1" opacity="0.5"/>',
  },
  {
    id: 'pagination', name: '分页', category: 'basic', icon: 'bi-chevron-bar-right',
    keywords: 'pagination 分页 页码 page',
    thumbnail: '<rect x="2" y="6" width="3" height="4" rx="0.5" fill="currentColor" opacity="0.4"/><rect x="6" y="6" width="3" height="4" rx="0.5" fill="currentColor" opacity="0.6"/><rect x="10" y="6" width="3" height="4" rx="0.5" fill="currentColor"/><rect x="14" y="6" width="3" height="4" rx="0.5" fill="currentColor" opacity="0.6"/><rect x="18" y="6" width="3" height="4" rx="0.5" fill="currentColor" opacity="0.4"/>',
  },
  {
    id: 'list', name: '列表', category: 'basic', icon: 'bi-list-ul',
    keywords: 'list 列表 list-group ul',
    thumbnail: '<rect x="2" y="3" width="20" height="3" rx="0.6" fill="currentColor" opacity="0.25"/><circle cx="4.5" cy="4.5" r="0.6" fill="currentColor"/><rect x="2" y="7" width="20" height="3" rx="0.6" fill="currentColor" opacity="0.18"/><circle cx="4.5" cy="8.5" r="0.6" fill="currentColor"/><rect x="2" y="11" width="20" height="3" rx="0.6" fill="currentColor" opacity="0.12"/><circle cx="4.5" cy="12.5" r="0.6" fill="currentColor"/>',
  },
  {
    id: 'dropdown', name: '下拉菜单', category: 'basic', icon: 'bi-menu-button-wide-fill',
    keywords: 'dropdown 下拉 菜单 menu 子菜单 二级菜单 弹出',
    thumbnail: '<rect x="2" y="3" width="14" height="3.5" rx="1" fill="currentColor"/><polyline points="12.5,4.3 13.5,5.3 14.5,4.3" fill="none" stroke="#fff" stroke-width="0.5" stroke-linecap="round" stroke-linejoin="round"/><rect x="2" y="8" width="20" height="2.5" rx="0.4" fill="currentColor" opacity="0.45"/><rect x="2" y="11.5" width="20" height="2.5" rx="0.4" fill="currentColor" opacity="0.3"/>',
  },
  // ── 表单 ──
  {
    id: 'input', name: '输入框', category: 'form', icon: 'bi-input-cursor-text',
    keywords: 'input text 输入框 文本',
    thumbnail: '<rect x="2" y="3" width="20" height="3" rx="0.5" fill="currentColor" opacity="0.3"/><rect x="2" y="7" width="20" height="6" rx="1" fill="none" stroke="currentColor" stroke-width="1"/><line x1="5" y1="10" x2="10" y2="10" stroke="currentColor" stroke-width="1"/>',
  },
  {
    id: 'textarea', name: '多行文本', category: 'form', icon: 'bi-textarea-t',
    keywords: 'textarea 多行 文本域',
    thumbnail: '<rect x="2" y="3" width="20" height="3" rx="0.5" fill="currentColor" opacity="0.3"/><rect x="2" y="7" width="20" height="7" rx="1" fill="none" stroke="currentColor" stroke-width="1"/><line x1="5" y1="9.5" x2="19" y2="9.5" stroke="currentColor" stroke-width="0.8" opacity="0.5"/><line x1="5" y1="12" x2="14" y2="12" stroke="currentColor" stroke-width="0.8" opacity="0.4"/>',
  },
  {
    id: 'select', name: '下拉选择', category: 'form', icon: 'bi-menu-button-wide',
    keywords: 'select dropdown 下拉 选择',
    thumbnail: '<rect x="2" y="3" width="20" height="3" rx="0.5" fill="currentColor" opacity="0.3"/><rect x="2" y="7" width="20" height="6" rx="1" fill="none" stroke="currentColor" stroke-width="1"/><polyline points="17,9.5 18.5,11 20,9.5" fill="none" stroke="currentColor" stroke-width="1"/>',
  },
  {
    id: 'checkbox', name: '复选框', category: 'form', icon: 'bi-check2-square',
    keywords: 'checkbox 复选 多选',
    thumbnail: '<rect x="3" y="6" width="5" height="5" rx="0.8" fill="none" stroke="currentColor" stroke-width="1.2"/><polyline points="4,8.3 5,9.5 7,7" fill="none" stroke="currentColor" stroke-width="1.2"/><line x1="10" y1="8.5" x2="20" y2="8.5" stroke="currentColor" stroke-width="1" opacity="0.5"/>',
  },
  {
    id: 'radio', name: '单选', category: 'form', icon: 'bi-record-circle',
    keywords: 'radio 单选',
    thumbnail: '<circle cx="5.5" cy="6.5" r="2.5" fill="none" stroke="currentColor" stroke-width="1.2"/><circle cx="5.5" cy="6.5" r="1" fill="currentColor"/><line x1="10" y1="6.5" x2="20" y2="6.5" stroke="currentColor" stroke-width="1" opacity="0.5"/><circle cx="5.5" cy="11.5" r="2.5" fill="none" stroke="currentColor" stroke-width="1.2"/><line x1="10" y1="11.5" x2="20" y2="11.5" stroke="currentColor" stroke-width="1" opacity="0.4"/>',
  },
  {
    id: 'switch', name: '开关', category: 'form', icon: 'bi-toggle-on',
    keywords: 'switch toggle 开关',
    thumbnail: '<rect x="3" y="6" width="11" height="5" rx="2.5" fill="currentColor"/><circle cx="11.5" cy="8.5" r="2" fill="#fff"/>',
  },
  {
    id: 'range', name: '滑块', category: 'form', icon: 'bi-sliders',
    keywords: 'range slider 滑块 范围',
    thumbnail: '<line x1="3" y1="8.5" x2="21" y2="8.5" stroke="currentColor" stroke-width="1.2" opacity="0.4"/><circle cx="14" cy="8.5" r="2" fill="currentColor"/>',
  },
  {
    id: 'file', name: '文件上传', category: 'form', icon: 'bi-upload',
    keywords: 'file upload 文件 上传',
    thumbnail: '<rect x="2" y="3" width="20" height="3" rx="0.5" fill="currentColor" opacity="0.3"/><rect x="2" y="7" width="20" height="6" rx="1" fill="none" stroke="currentColor" stroke-width="1" stroke-dasharray="1.5 1"/><polyline points="10,9 12,7 14,9" fill="none" stroke="currentColor" stroke-width="1"/><line x1="12" y1="7" x2="12" y2="11" stroke="currentColor" stroke-width="1"/>',
  },
  {
    id: 'form-group', name: '表单分组', category: 'form', icon: 'bi-ui-radios',
    keywords: 'form group 表单 分组 登录',
    thumbnail: '<rect x="2" y="3" width="20" height="10" rx="1" fill="none" stroke="currentColor" stroke-width="1"/><line x1="5" y1="6" x2="9" y2="6" stroke="currentColor" stroke-width="1" opacity="0.5"/><rect x="5" y="7" width="14" height="1.8" fill="currentColor" opacity="0.2"/><line x1="5" y1="10" x2="9" y2="10" stroke="currentColor" stroke-width="1" opacity="0.5"/><rect x="5" y="11" width="14" height="1.8" fill="currentColor" opacity="0.2"/>',
  },
  {
    id: 'search', name: '搜索框', category: 'form', icon: 'bi-search',
    keywords: 'search 搜索 查找 检索 search-box search-input',
    thumbnail: '<rect x="2" y="5" width="13" height="6" rx="1" fill="none" stroke="currentColor" stroke-width="1"/><circle cx="5" cy="8" r="1" fill="none" stroke="currentColor" stroke-width="0.7"/><line x1="5.7" y1="8.7" x2="6.5" y2="9.5" stroke="currentColor" stroke-width="0.7" stroke-linecap="round"/><rect x="16" y="5" width="6" height="6" rx="1" fill="currentColor" opacity="0.55"/>',
  },
  // ── 页面布局模板 ──
  {
    id: 'tpl-header-content', name: '顶部导航+内容', category: 'template', icon: 'bi-window-stack',
    keywords: 'header navbar 顶部 导航 导航栏 页面模板 header content',
    thumbnail: '<rect x="2" y="2" width="20" height="3" rx="0.8" fill="currentColor" opacity="0.5"/><rect x="2" y="6" width="20" height="8" rx="0.8" fill="currentColor" opacity="0.12"/>',
  },
  {
    id: 'tpl-sidebar-content', name: '侧边栏+内容', category: 'template', icon: 'bi-layout-sidebar',
    keywords: 'sidebar 侧边栏 侧栏 菜单 sidebar content',
    thumbnail: '<rect x="2" y="2" width="6" height="12" rx="0.8" fill="currentColor" opacity="0.35"/><rect x="10" y="2" width="12" height="12" rx="0.8" fill="currentColor" opacity="0.12"/>',
  },
  {
    id: 'tpl-header-sidebar', name: '导航+侧边栏+内容', category: 'template', icon: 'bi-layout-split',
    keywords: 'header sidebar 导航 侧边栏 组合 三栏',
    thumbnail: '<rect x="2" y="2" width="20" height="2.5" rx="0.6" fill="currentColor" opacity="0.45"/><rect x="2" y="5.5" width="5" height="8.5" rx="0.6" fill="currentColor" opacity="0.25"/><rect x="9" y="5.5" width="13" height="8.5" rx="0.6" fill="currentColor" opacity="0.1"/>',
  },
  {
    id: 'tpl-dashboard', name: '数据面板', category: 'template', icon: 'bi-speedometer2',
    keywords: 'dashboard 面板 数据 统计 后台 admin',
    thumbnail: '<rect x="2" y="2" width="5" height="12" rx="0.6" fill="currentColor" opacity="0.3"/><rect x="9" y="2" width="13" height="2" rx="0.5" fill="currentColor" opacity="0.35"/><rect x="9" y="5.5" width="4" height="4" rx="0.5" fill="currentColor" opacity="0.2"/><rect x="14.5" y="5.5" width="4" height="4" rx="0.5" fill="currentColor" opacity="0.15"/><rect x="9" y="10.5" width="13" height="3.5" rx="0.5" fill="currentColor" opacity="0.1"/>',
  },
  // ── 图表 ──
  {
    id: 'bar-chart', name: '柱状图', category: 'chart', icon: 'bi-bar-chart-fill',
    keywords: 'bar chart 柱状图 柱形 条形 图表',
    thumbnail: '<rect x="2" y="3" width="20" height="10" rx="0.8" fill="none" stroke="currentColor" stroke-width="0.6" opacity="0.4"/><rect x="4" y="8" width="2.5" height="5" fill="currentColor" opacity="0.6"/><rect x="8" y="6" width="2.5" height="7" fill="currentColor" opacity="0.75"/><rect x="12" y="4" width="2.5" height="9" fill="currentColor"/><rect x="16" y="7" width="2.5" height="6" fill="currentColor" opacity="0.7"/>',
  },
  {
    id: 'line-chart', name: '折线图', category: 'chart', icon: 'bi-graph-up',
    keywords: 'line chart 折线图 趋势 图表',
    thumbnail: '<rect x="2" y="3" width="20" height="10" rx="0.8" fill="none" stroke="currentColor" stroke-width="0.6" opacity="0.4"/><polyline points="3,11 6,9 9,10 12,6 15,7 18,4 21,3" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>',
  },
  {
    id: 'pie-chart', name: '饼图', category: 'chart', icon: 'bi-pie-chart-fill',
    keywords: 'pie chart 饼图 占比 图表',
    thumbnail: '<circle cx="8" cy="8" r="5" fill="currentColor" opacity="0.25"/><path d="M8,8 L8,3 A5,5 0 0,1 12.83,10.5 Z" fill="currentColor"/><path d="M8,8 L12.83,10.5 A5,5 0 0,1 4.5,11.33 Z" fill="currentColor" opacity="0.6"/>',
  },
  {
    id: 'donut-chart', name: '环形图', category: 'chart', icon: 'bi-pie-chart',
    keywords: 'donut chart 环形图 圆环 进度 图表',
    thumbnail: '<circle cx="8" cy="8" r="5" fill="none" stroke="currentColor" stroke-width="2" opacity="0.2"/><circle cx="8" cy="8" r="5" fill="none" stroke="currentColor" stroke-width="2" stroke-dasharray="20 31.4" transform="rotate(-90 8 8)"/>',
  },
  {
    id: 'stat-card', name: '统计卡片', category: 'chart', icon: 'bi-clipboard-data-fill',
    keywords: 'stat card 统计 卡片 数据 指标 kpi',
    thumbnail: '<rect x="2" y="3" width="20" height="10" rx="1" fill="none" stroke="currentColor" stroke-width="0.8"/><rect x="4" y="5" width="6" height="1.5" fill="currentColor" opacity="0.5"/><rect x="4" y="8" width="8" height="2.5" fill="currentColor"/><rect x="17" y="5" width="3" height="3" rx="0.5" fill="currentColor" opacity="0.4"/>',
  },
  {
    id: 'progress-bar', name: '进度条', category: 'chart', icon: 'bi-speedometer',
    keywords: 'progress bar 进度条 百分比',
    thumbnail: '<rect x="2" y="6" width="20" height="4" rx="2" fill="currentColor" opacity="0.2"/><rect x="2" y="6" width="13" height="4" rx="2" fill="currentColor"/>',
  },
];

/**
 * 按分类分组组件
 */
export function groupByCategory(): Record<ComponentCategory, ComponentDef[]> {
  const groups: Record<ComponentCategory, ComponentDef[]> = {
    layout: [],
    basic: [],
    form: [],
    template: [],
    chart: [],
  };
  for (const c of COMPONENTS) groups[c.category].push(c);
  return groups;
}

/**
 * 搜索过滤（按名称 + keywords 模糊匹配）
 */
export function filterComponents(query: string): ComponentDef[] {
  const q = query.trim().toLowerCase();
  if (!q) return COMPONENTS;
  return COMPONENTS.filter(c =>
    c.name.toLowerCase().includes(q) ||
    c.keywords.toLowerCase().includes(q) ||
    c.id.toLowerCase().includes(q),
  );
}
