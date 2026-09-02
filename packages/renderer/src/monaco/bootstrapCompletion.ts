/**
 * Bootstrap 5 completion provider for Monaco Editor.
 *
 * Registers an HTML-language completion provider that suggests Bootstrap class
 * names when the cursor is inside a `class="..."` attribute value. Outside of
 * class attributes Monaco's built-in HTML completions handle tags/attributes.
 *
 * Usage:
 *   const disposable = registerBootstrapCompletionProvider(monaco);
 *   // ... later on unmount:
 *   disposable.dispose();
 */

// ── Bootstrap 5 class data ──────────────────────────────────────────────────

interface BootstrapClassEntry {
  /** The class name (e.g. "btn-primary"). May contain a `-` prefix placeholder
   *  for responsive variants — see the "responsive" category below. */
  name: string;
  /** Short description shown in the completion popup. */
  desc: string;
}

const BOOTSTRAP_CLASSES: BootstrapClassEntry[] = [
  // ── Spacing ──
  { name: 'p-0', desc: 'Padding 0' }, { name: 'p-1', desc: 'Padding .25rem' },
  { name: 'p-2', desc: 'Padding .5rem' }, { name: 'p-3', desc: 'Padding 1rem' },
  { name: 'p-4', desc: 'Padding 1.5rem' }, { name: 'p-5', desc: 'Padding 3rem' },
  { name: 'pt-0', desc: 'Padding top 0' }, { name: 'pt-1', desc: 'Padding top .25rem' },
  { name: 'pt-2', desc: 'Padding top .5rem' }, { name: 'pt-3', desc: 'Padding top 1rem' },
  { name: 'pt-4', desc: 'Padding top 1.5rem' }, { name: 'pt-5', desc: 'Padding top 3rem' },
  { name: 'pb-0', desc: 'Padding bottom 0' }, { name: 'pb-1', desc: 'Padding bottom .25rem' },
  { name: 'pb-2', desc: 'Padding bottom .5rem' }, { name: 'pb-3', desc: 'Padding bottom 1rem' },
  { name: 'pb-4', desc: 'Padding bottom 1.5rem' }, { name: 'pb-5', desc: 'Padding bottom 3rem' },
  { name: 'ps-0', desc: 'Padding start 0' }, { name: 'ps-1', desc: 'Padding start .25rem' },
  { name: 'ps-2', desc: 'Padding start .5rem' }, { name: 'ps-3', desc: 'Padding start 1rem' },
  { name: 'ps-4', desc: 'Padding start 1.5rem' }, { name: 'ps-5', desc: 'Padding start 3rem' },
  { name: 'pe-0', desc: 'Padding end 0' }, { name: 'pe-1', desc: 'Padding end .25rem' },
  { name: 'pe-2', desc: 'Padding end .5rem' }, { name: 'pe-3', desc: 'Padding end 1rem' },
  { name: 'pe-4', desc: 'Padding end 1.5rem' }, { name: 'pe-5', desc: 'Padding end 3rem' },
  { name: 'px-0', desc: 'Padding x 0' }, { name: 'px-1', desc: 'Padding x .25rem' },
  { name: 'px-2', desc: 'Padding x .5rem' }, { name: 'px-3', desc: 'Padding x 1rem' },
  { name: 'px-4', desc: 'Padding x 1.5rem' }, { name: 'px-5', desc: 'Padding x 3rem' },
  { name: 'py-0', desc: 'Padding y 0' }, { name: 'py-1', desc: 'Padding y .25rem' },
  { name: 'py-2', desc: 'Padding y .5rem' }, { name: 'py-3', desc: 'Padding y 1rem' },
  { name: 'py-4', desc: 'Padding y 1.5rem' }, { name: 'py-5', desc: 'Padding y 3rem' },
  { name: 'm-0', desc: 'Margin 0' }, { name: 'm-1', desc: 'Margin .25rem' },
  { name: 'm-2', desc: 'Margin .5rem' }, { name: 'm-3', desc: 'Margin 1rem' },
  { name: 'm-4', desc: 'Margin 1.5rem' }, { name: 'm-5', desc: 'Margin 3rem' },
  { name: 'mt-0', desc: 'Margin top 0' }, { name: 'mt-1', desc: 'Margin top .25rem' },
  { name: 'mt-2', desc: 'Margin top .5rem' }, { name: 'mt-3', desc: 'Margin top 1rem' },
  { name: 'mt-4', desc: 'Margin top 1.5rem' }, { name: 'mt-5', desc: 'Margin top 3rem' },
  { name: 'mb-0', desc: 'Margin bottom 0' }, { name: 'mb-1', desc: 'Margin bottom .25rem' },
  { name: 'mb-2', desc: 'Margin bottom .5rem' }, { name: 'mb-3', desc: 'Margin bottom 1rem' },
  { name: 'mb-4', desc: 'Margin bottom 1.5rem' }, { name: 'mb-5', desc: 'Margin bottom 3rem' },
  { name: 'ms-0', desc: 'Margin start 0' }, { name: 'ms-1', desc: 'Margin start .25rem' },
  { name: 'ms-2', desc: 'Margin start .5rem' }, { name: 'ms-3', desc: 'Margin start 1rem' },
  { name: 'ms-4', desc: 'Margin start 1.5rem' }, { name: 'ms-5', desc: 'Margin start 3rem' },
  { name: 'me-0', desc: 'Margin end 0' }, { name: 'me-1', desc: 'Margin end .25rem' },
  { name: 'me-2', desc: 'Margin end .5rem' }, { name: 'me-3', desc: 'Margin end 1rem' },
  { name: 'me-4', desc: 'Margin end 1.5rem' }, { name: 'me-5', desc: 'Margin end 3rem' },
  { name: 'mx-auto', desc: 'Margin x auto (center)' }, { name: 'mx-0', desc: 'Margin x 0' },
  { name: 'mx-1', desc: 'Margin x .25rem' }, { name: 'mx-2', desc: 'Margin x .5rem' },
  { name: 'mx-3', desc: 'Margin x 1rem' }, { name: 'mx-4', desc: 'Margin x 1.5rem' },
  { name: 'mx-5', desc: 'Margin x 3rem' },
  { name: 'my-0', desc: 'Margin y 0' }, { name: 'my-1', desc: 'Margin y .25rem' },
  { name: 'my-2', desc: 'Margin y .5rem' }, { name: 'my-3', desc: 'Margin y 1rem' },
  { name: 'my-4', desc: 'Margin y 1.5rem' }, { name: 'my-5', desc: 'Margin y 3rem' },

  // ── Display ──
  { name: 'd-none', desc: 'Display none' }, { name: 'd-inline', desc: 'Display inline' },
  { name: 'd-inline-block', desc: 'Display inline-block' }, { name: 'd-block', desc: 'Display block' },
  { name: 'd-flex', desc: 'Display flex' }, { name: 'd-inline-flex', desc: 'Display inline-flex' },
  { name: 'd-grid', desc: 'Display grid' },

  // ── Flex ──
  { name: 'flex-row', desc: 'Flex direction row' }, { name: 'flex-column', desc: 'Flex direction column' },
  { name: 'flex-row-reverse', desc: 'Flex direction row-reverse' }, { name: 'flex-column-reverse', desc: 'Flex direction column-reverse' },
  { name: 'flex-wrap', desc: 'Flex wrap' }, { name: 'flex-nowrap', desc: 'Flex nowrap' },
  { name: 'flex-wrap-reverse', desc: 'Flex wrap-reverse' },
  { name: 'justify-content-start', desc: 'Justify content start' }, { name: 'justify-content-center', desc: 'Justify content center' },
  { name: 'justify-content-end', desc: 'Justify content end' }, { name: 'justify-content-between', desc: 'Justify content between' },
  { name: 'justify-content-around', desc: 'Justify content around' },
  { name: 'align-items-start', desc: 'Align items start' }, { name: 'align-items-center', desc: 'Align items center' },
  { name: 'align-items-end', desc: 'Align items end' }, { name: 'align-items-stretch', desc: 'Align items stretch' },
  { name: 'align-self-start', desc: 'Align self start' }, { name: 'align-self-center', desc: 'Align self center' },
  { name: 'align-self-end', desc: 'Align self end' },
  { name: 'flex-grow-1', desc: 'Flex grow 1' }, { name: 'flex-shrink-0', desc: 'Flex shrink 0' },
  { name: 'flex-fill', desc: 'Flex fill' },
  { name: 'order-0', desc: 'Flex order 0' }, { name: 'order-1', desc: 'Flex order 1' },
  { name: 'order-2', desc: 'Flex order 2' }, { name: 'order-3', desc: 'Flex order 3' },
  { name: 'order-4', desc: 'Flex order 4' }, { name: 'order-5', desc: 'Flex order 5' },

  // ── Text ──
  { name: 'text-start', desc: 'Text align start' }, { name: 'text-center', desc: 'Text align center' },
  { name: 'text-end', desc: 'Text align end' },
  { name: 'text-primary', desc: 'Text color primary' }, { name: 'text-secondary', desc: 'Text color secondary' },
  { name: 'text-success', desc: 'Text color success' }, { name: 'text-danger', desc: 'Text color danger' },
  { name: 'text-warning', desc: 'Text color warning' }, { name: 'text-info', desc: 'Text color info' },
  { name: 'text-light', desc: 'Text color light' }, { name: 'text-dark', desc: 'Text color dark' },
  { name: 'text-muted', desc: 'Text color muted' }, { name: 'text-white', desc: 'Text color white' },
  { name: 'text-decoration-none', desc: 'Text decoration none' }, { name: 'text-decoration-underline', desc: 'Text decoration underline' },
  { name: 'text-decoration-line-through', desc: 'Text decoration line-through' },
  { name: 'text-uppercase', desc: 'Text transform uppercase' }, { name: 'text-lowercase', desc: 'Text transform lowercase' },
  { name: 'text-capitalize', desc: 'Text transform capitalize' },
  { name: 'text-truncate', desc: 'Text truncate with ellipsis' },
  { name: 'text-wrap', desc: 'Text wrap' }, { name: 'text-nowrap', desc: 'Text nowrap' },
  { name: 'fw-bold', desc: 'Font weight bold' }, { name: 'fw-bolder', desc: 'Font weight bolder' },
  { name: 'fw-normal', desc: 'Font weight normal' }, { name: 'fw-light', desc: 'Font weight light' },
  { name: 'fw-lighter', desc: 'Font weight lighter' }, { name: 'fw-semibold', desc: 'Font weight semibold' },
  { name: 'fst-italic', desc: 'Font style italic' }, { name: 'fst-normal', desc: 'Font style normal' },
  { name: 'fs-1', desc: 'Font size 1 (2.5rem)' }, { name: 'fs-2', desc: 'Font size 2 (2rem)' },
  { name: 'fs-3', desc: 'Font size 3 (1.75rem)' }, { name: 'fs-4', desc: 'Font size 4 (1.5rem)' },
  { name: 'fs-5', desc: 'Font size 5 (1.25rem)' }, { name: 'fs-6', desc: 'Font size 6 (1rem)' },
  { name: 'lh-1', desc: 'Line height 1' }, { name: 'lh-sm', desc: 'Line height sm' },
  { name: 'lh-base', desc: 'Line height base' }, { name: 'lh-lg', desc: 'Line height lg' },

  // ── Background ──
  { name: 'bg-primary', desc: 'Background primary' }, { name: 'bg-secondary', desc: 'Background secondary' },
  { name: 'bg-success', desc: 'Background success' }, { name: 'bg-danger', desc: 'Background danger' },
  { name: 'bg-warning', desc: 'Background warning' }, { name: 'bg-info', desc: 'Background info' },
  { name: 'bg-light', desc: 'Background light' }, { name: 'bg-dark', desc: 'Background dark' },
  { name: 'bg-white', desc: 'Background white' }, { name: 'bg-transparent', desc: 'Background transparent' },
  { name: 'bg-body', desc: 'Background body' },

  // ── Buttons ──
  { name: 'btn', desc: 'Button base' },
  { name: 'btn-primary', desc: 'Button primary' }, { name: 'btn-secondary', desc: 'Button secondary' },
  { name: 'btn-success', desc: 'Button success' }, { name: 'btn-danger', desc: 'Button danger' },
  { name: 'btn-warning', desc: 'Button warning' }, { name: 'btn-info', desc: 'Button info' },
  { name: 'btn-light', desc: 'Button light' }, { name: 'btn-dark', desc: 'Button dark' },
  { name: 'btn-outline-primary', desc: 'Button outline primary' }, { name: 'btn-outline-secondary', desc: 'Button outline secondary' },
  { name: 'btn-outline-success', desc: 'Button outline success' }, { name: 'btn-outline-danger', desc: 'Button outline danger' },
  { name: 'btn-outline-warning', desc: 'Button outline warning' }, { name: 'btn-outline-info', desc: 'Button outline info' },
  { name: 'btn-outline-light', desc: 'Button outline light' }, { name: 'btn-outline-dark', desc: 'Button outline dark' },
  { name: 'btn-link', desc: 'Button link style' },
  { name: 'btn-sm', desc: 'Button small' }, { name: 'btn-lg', desc: 'Button large' },
  { name: 'btn-close', desc: 'Close button' },

  // ── Border ──
  { name: 'border', desc: 'Border all sides' }, { name: 'border-0', desc: 'Border none' },
  { name: 'border-top', desc: 'Border top' }, { name: 'border-end', desc: 'Border end' },
  { name: 'border-bottom', desc: 'Border bottom' }, { name: 'border-start', desc: 'Border start' },
  { name: 'border-top-0', desc: 'Remove border top' }, { name: 'border-end-0', desc: 'Remove border end' },
  { name: 'border-bottom-0', desc: 'Remove border bottom' }, { name: 'border-start-0', desc: 'Remove border start' },
  { name: 'border-primary', desc: 'Border color primary' }, { name: 'border-secondary', desc: 'Border color secondary' },
  { name: 'border-success', desc: 'Border color success' }, { name: 'border-danger', desc: 'Border color danger' },
  { name: 'border-warning', desc: 'Border color warning' }, { name: 'border-info', desc: 'Border color info' },
  { name: 'border-light', desc: 'Border color light' }, { name: 'border-dark', desc: 'Border color dark' },

  // ── Rounded ──
  { name: 'rounded', desc: 'Border radius default' }, { name: 'rounded-0', desc: 'Border radius 0' },
  { name: 'rounded-1', desc: 'Border radius .2rem' }, { name: 'rounded-2', desc: 'Border radius .25rem' },
  { name: 'rounded-3', desc: 'Border radius .3rem' }, { name: 'rounded-circle', desc: 'Border radius 50%' },
  { name: 'rounded-pill', desc: 'Border radius pill' },
  { name: 'rounded-top', desc: 'Border radius top' }, { name: 'rounded-end', desc: 'Border radius end' },
  { name: 'rounded-bottom', desc: 'Border radius bottom' }, { name: 'rounded-start', desc: 'Border radius start' },

  // ── Shadow ──
  { name: 'shadow-none', desc: 'Box shadow none' }, { name: 'shadow-sm', desc: 'Box shadow small' },
  { name: 'shadow', desc: 'Box shadow default' }, { name: 'shadow-lg', desc: 'Box shadow large' },

  // ── Sizing ──
  { name: 'w-25', desc: 'Width 25%' }, { name: 'w-50', desc: 'Width 50%' },
  { name: 'w-75', desc: 'Width 75%' }, { name: 'w-100', desc: 'Width 100%' },
  { name: 'w-auto', desc: 'Width auto' },
  { name: 'h-25', desc: 'Height 25%' }, { name: 'h-50', desc: 'Height 50%' },
  { name: 'h-75', desc: 'Height 75%' }, { name: 'h-100', desc: 'Height 100%' },
  { name: 'h-auto', desc: 'Height auto' },
  { name: 'mw-100', desc: 'Max width 100%' }, { name: 'mh-100', desc: 'Max height 100%' },
  { name: 'vw-100', desc: 'Viewport width 100%' }, { name: 'vh-100', desc: 'Viewport height 100%' },
  { name: 'min-vw-100', desc: 'Min viewport width 100%' }, { name: 'min-vh-100', desc: 'Min viewport height 100%' },

  // ── Position ──
  { name: 'position-static', desc: 'Position static' }, { name: 'position-relative', desc: 'Position relative' },
  { name: 'position-absolute', desc: 'Position absolute' }, { name: 'position-fixed', desc: 'Position fixed' },
  { name: 'position-sticky', desc: 'Position sticky' },
  { name: 'top-0', desc: 'Top 0' }, { name: 'top-50', desc: 'Top 50%' }, { name: 'top-100', desc: 'Top 100%' },
  { name: 'bottom-0', desc: 'Bottom 0' }, { name: 'bottom-50', desc: 'Bottom 50%' }, { name: 'bottom-100', desc: 'Bottom 100%' },
  { name: 'start-0', desc: 'Start 0' }, { name: 'start-50', desc: 'Start 50%' }, { name: 'start-100', desc: 'Start 100%' },
  { name: 'end-0', desc: 'End 0' }, { name: 'end-50', desc: 'End 50%' }, { name: 'end-100', desc: 'End 100%' },
  { name: 'translate-middle', desc: 'Translate middle' },
  { name: 'translate-middle-x', desc: 'Translate middle x' }, { name: 'translate-middle-y', desc: 'Translate middle y' },

  // ── Overflow ──
  { name: 'overflow-auto', desc: 'Overflow auto' }, { name: 'overflow-hidden', desc: 'Overflow hidden' },
  { name: 'overflow-visible', desc: 'Overflow visible' }, { name: 'overflow-scroll', desc: 'Overflow scroll' },

  // ── Opacity ──
  { name: 'opacity-0', desc: 'Opacity 0%' }, { name: 'opacity-25', desc: 'Opacity 25%' },
  { name: 'opacity-50', desc: 'Opacity 50%' }, { name: 'opacity-75', desc: 'Opacity 75%' },
  { name: 'opacity-100', desc: 'Opacity 100%' },

  // ── Layout / Grid ──
  { name: 'container', desc: 'Responsive container' }, { name: 'container-fluid', desc: 'Full-width container' },
  { name: 'container-sm', desc: 'Container sm breakpoint' }, { name: 'container-md', desc: 'Container md breakpoint' },
  { name: 'container-lg', desc: 'Container lg breakpoint' }, { name: 'container-xl', desc: 'Container xl breakpoint' },
  { name: 'container-xxl', desc: 'Container xxl breakpoint' },
  { name: 'row', desc: 'Grid row' },
  { name: 'col', desc: 'Grid column auto' },
  { name: 'col-1', desc: 'Grid column 1/12' }, { name: 'col-2', desc: 'Grid column 2/12' },
  { name: 'col-3', desc: 'Grid column 3/12' }, { name: 'col-4', desc: 'Grid column 4/12' },
  { name: 'col-5', desc: 'Grid column 5/12' }, { name: 'col-6', desc: 'Grid column 6/12' },
  { name: 'col-7', desc: 'Grid column 7/12' }, { name: 'col-8', desc: 'Grid column 8/12' },
  { name: 'col-9', desc: 'Grid column 9/12' }, { name: 'col-10', desc: 'Grid column 10/12' },
  { name: 'col-11', desc: 'Grid column 11/12' }, { name: 'col-12', desc: 'Grid column 12/12' },
  { name: 'col-auto', desc: 'Grid column auto width' },
  { name: 'col-sm', desc: 'Grid column sm auto' }, { name: 'col-md', desc: 'Grid column md auto' },
  { name: 'col-lg', desc: 'Grid column lg auto' }, { name: 'col-xl', desc: 'Grid column xl auto' },
  { name: 'col-xxl', desc: 'Grid column xxl auto' },
  { name: 'row-cols-1', desc: 'Row cols 1' }, { name: 'row-cols-2', desc: 'Row cols 2' },
  { name: 'row-cols-3', desc: 'Row cols 3' }, { name: 'row-cols-4', desc: 'Row cols 4' },
  { name: 'row-cols-5', desc: 'Row cols 5' }, { name: 'row-cols-6', desc: 'Row cols 6' },
  { name: 'g-0', desc: 'Gutter 0' }, { name: 'g-1', desc: 'Gutter .25rem' },
  { name: 'g-2', desc: 'Gutter .5rem' }, { name: 'g-3', desc: 'Gutter 1rem' },
  { name: 'g-4', desc: 'Gutter 1.5rem' }, { name: 'g-5', desc: 'Gutter 3rem' },
  { name: 'gx-0', desc: 'Gutter x 0' }, { name: 'gy-0', desc: 'Gutter y 0' },
  { name: 'offset-1', desc: 'Grid offset 1' }, { name: 'offset-2', desc: 'Grid offset 2' },
  { name: 'offset-3', desc: 'Grid offset 3' }, { name: 'offset-4', desc: 'Grid offset 4' },
  { name: 'offset-5', desc: 'Grid offset 5' }, { name: 'offset-6', desc: 'Grid offset 6' },

  // ── Nav / Navbar ──
  { name: 'nav', desc: 'Nav base' }, { name: 'nav-item', desc: 'Nav item' },
  { name: 'nav-link', desc: 'Nav link' }, { name: 'nav-link active', desc: 'Nav link active' },
  { name: 'nav-link disabled', desc: 'Nav link disabled' },
  { name: 'nav-tabs', desc: 'Nav tabs style' }, { name: 'nav-pills', desc: 'Nav pills style' },
  { name: 'nav-fill', desc: 'Nav fill' }, { name: 'nav-justified', desc: 'Nav justified' },
  { name: 'navbar', desc: 'Navbar base' }, { name: 'navbar-brand', desc: 'Navbar brand' },
  { name: 'navbar-nav', desc: 'Navbar nav' }, { name: 'navbar-toggler', desc: 'Navbar toggler' },
  { name: 'navbar-toggler-icon', desc: 'Navbar toggler icon' },
  { name: 'navbar-expand-sm', desc: 'Navbar expand sm' }, { name: 'navbar-expand-md', desc: 'Navbar expand md' },
  { name: 'navbar-expand-lg', desc: 'Navbar expand lg' }, { name: 'navbar-expand-xl', desc: 'Navbar expand xl' },
  { name: 'navbar-expand-xxl', desc: 'Navbar expand xxl' },
  { name: 'navbar-light', desc: 'Navbar light theme' }, { name: 'navbar-dark', desc: 'Navbar dark theme' },
  { name: 'navbar-text', desc: 'Navbar text' },

  // ── Dropdown ──
  { name: 'dropdown', desc: 'Dropdown wrapper' }, { name: 'dropdown-toggle', desc: 'Dropdown toggle' },
  { name: 'dropdown-menu', desc: 'Dropdown menu' }, { name: 'dropdown-item', desc: 'Dropdown item' },
  { name: 'dropdown-item active', desc: 'Dropdown item active' },
  { name: 'dropdown-item disabled', desc: 'Dropdown item disabled' },
  { name: 'dropdown-divider', desc: 'Dropdown divider' }, { name: 'dropdown-header', desc: 'Dropdown header' },
  { name: 'dropdown-menu-end', desc: 'Dropdown menu end-aligned' },
  { name: 'dropdown-menu-start', desc: 'Dropdown menu start-aligned' },

  // ── Collapse ──
  { name: 'collapse', desc: 'Collapse' }, { name: 'navbar-collapse', desc: 'Navbar collapse' },
  { name: 'accordion', desc: 'Accordion' }, { name: 'accordion-item', desc: 'Accordion item' },
  { name: 'accordion-header', desc: 'Accordion header' }, { name: 'accordion-body', desc: 'Accordion body' },
  { name: 'accordion-button', desc: 'Accordion button' }, { name: 'accordion-collapse', desc: 'Accordion collapse' },

  // ── Card ──
  { name: 'card', desc: 'Card container' }, { name: 'card-body', desc: 'Card body' },
  { name: 'card-header', desc: 'Card header' }, { name: 'card-footer', desc: 'Card footer' },
  { name: 'card-title', desc: 'Card title' }, { name: 'card-text', desc: 'Card text' },
  { name: 'card-img-top', desc: 'Card image top' }, { name: 'card-img-bottom', desc: 'Card image bottom' },
  { name: 'card-img-overlay', desc: 'Card image overlay' },
  { name: 'card-group', desc: 'Card group' }, { name: 'card-columns', desc: 'Card columns' },

  // ── List Group ──
  { name: 'list-group', desc: 'List group' }, { name: 'list-group-item', desc: 'List group item' },
  { name: 'list-group-item active', desc: 'List group item active' },
  { name: 'list-group-item disabled', desc: 'List group item disabled' },
  { name: 'list-group-numbered', desc: 'List group numbered' },
  { name: 'list-group-flush', desc: 'List group flush' },
  { name: 'list-group-item-action', desc: 'List group item action' },

  // ── Alert ──
  { name: 'alert', desc: 'Alert base' },
  { name: 'alert-primary', desc: 'Alert primary' }, { name: 'alert-secondary', desc: 'Alert secondary' },
  { name: 'alert-success', desc: 'Alert success' }, { name: 'alert-danger', desc: 'Alert danger' },
  { name: 'alert-warning', desc: 'Alert warning' }, { name: 'alert-info', desc: 'Alert info' },
  { name: 'alert-light', desc: 'Alert light' }, { name: 'alert-dark', desc: 'Alert dark' },
  { name: 'alert-dismissible', desc: 'Alert dismissible' }, { name: 'alert-heading', desc: 'Alert heading' },
  { name: 'alert-link', desc: 'Alert link' },

  // ── Badge ──
  { name: 'badge', desc: 'Badge' },
  { name: 'bg-primary rounded-pill', desc: 'Badge primary pill' },
  { name: 'text-bg-primary', desc: 'Text + background primary' },
  { name: 'text-bg-secondary', desc: 'Text + background secondary' },
  { name: 'text-bg-success', desc: 'Text + background success' },
  { name: 'text-bg-danger', desc: 'Text + background danger' },
  { name: 'text-bg-warning', desc: 'Text + background warning' },
  { name: 'text-bg-info', desc: 'Text + background info' },
  { name: 'text-bg-light', desc: 'Text + background light' },
  { name: 'text-bg-dark', desc: 'Text + background dark' },

  // ── Table ──
  { name: 'table', desc: 'Table base' }, { name: 'table-hover', desc: 'Table hover rows' },
  { name: 'table-striped', desc: 'Table striped rows' }, { name: 'table-bordered', desc: 'Table bordered' },
  { name: 'table-borderless', desc: 'Table borderless' }, { name: 'table-sm', desc: 'Table small' },
  { name: 'table-responsive', desc: 'Table responsive' }, { name: 'table-dark', desc: 'Table dark' },
  { name: 'table-active', desc: 'Table active row' }, { name: 'table-primary', desc: 'Table primary row' },

  // ── Modal ──
  { name: 'modal', desc: 'Modal' }, { name: 'modal-dialog', desc: 'Modal dialog' },
  { name: 'modal-content', desc: 'Modal content' }, { name: 'modal-header', desc: 'Modal header' },
  { name: 'modal-body', desc: 'Modal body' }, { name: 'modal-footer', desc: 'Modal footer' },
  { name: 'modal-title', desc: 'Modal title' }, { name: 'modal-backdrop', desc: 'Modal backdrop' },
  { name: 'modal-dialog-centered', desc: 'Modal dialog centered' },
  { name: 'modal-dialog-scrollable', desc: 'Modal dialog scrollable' },
  { name: 'modal-lg', desc: 'Modal large' }, { name: 'modal-sm', desc: 'Modal small' },
  { name: 'modal-fullscreen', desc: 'Modal fullscreen' },

  // ── Form ──
  { name: 'form-control', desc: 'Form control' }, { name: 'form-control-sm', desc: 'Form control small' },
  { name: 'form-control-lg', desc: 'Form control large' },
  { name: 'form-select', desc: 'Form select' }, { name: 'form-select-sm', desc: 'Form select small' },
  { name: 'form-select-lg', desc: 'Form select large' },
  { name: 'form-check', desc: 'Form check' }, { name: 'form-check-input', desc: 'Form check input' },
  { name: 'form-check-label', desc: 'Form check label' }, { name: 'form-check-inline', desc: 'Form check inline' },
  { name: 'form-switch', desc: 'Form switch' },
  { name: 'form-label', desc: 'Form label' }, { name: 'form-text', desc: 'Form text / help' },
  { name: 'form-range', desc: 'Form range' }, { name: 'form-floating', desc: 'Form floating label' },
  { name: 'input-group', desc: 'Input group' }, { name: 'input-group-text', desc: 'Input group text' },
  { name: 'input-group-sm', desc: 'Input group small' }, { name: 'input-group-lg', desc: 'Input group large' },
  { name: 'was-validated', desc: 'Was validated' }, { name: 'is-valid', desc: 'Is valid' },
  { name: 'is-invalid', desc: 'Is invalid' }, { name: 'invalid-feedback', desc: 'Invalid feedback' },
  { name: 'valid-feedback', desc: 'Valid feedback' },

  // ── Button Group ──
  { name: 'btn-group', desc: 'Button group' }, { name: 'btn-group-sm', desc: 'Button group small' },
  { name: 'btn-group-lg', desc: 'Button group large' },
  { name: 'btn-toolbar', desc: 'Button toolbar' }, { name: 'btn-group-vertical', desc: 'Button group vertical' },

  // ── Pagination ──
  { name: 'pagination', desc: 'Pagination' }, { name: 'page-item', desc: 'Page item' },
  { name: 'page-link', desc: 'Page link' }, { name: 'page-item active', desc: 'Page item active' },
  { name: 'page-item disabled', desc: 'Page item disabled' },
  { name: 'pagination-sm', desc: 'Pagination small' }, { name: 'pagination-lg', desc: 'Pagination large' },

  // ── Progress ──
  { name: 'progress', desc: 'Progress bar' }, { name: 'progress-bar', desc: 'Progress bar fill' },
  { name: 'progress-bar-striped', desc: 'Progress bar striped' },
  { name: 'progress-bar-animated', desc: 'Progress bar animated' },

  // ── Image / Figure ──
  { name: 'img-fluid', desc: 'Responsive image' }, { name: 'img-thumbnail', desc: 'Image thumbnail' },
  { name: 'figure', desc: 'Figure' }, { name: 'figure-caption', desc: 'Figure caption' },
  { name: 'figure-img', desc: 'Figure image' },

  // ── Ratio ──
  { name: 'ratio', desc: 'Aspect ratio' }, { name: 'ratio-1x1', desc: 'Ratio 1:1' },
  { name: 'ratio-4x3', desc: 'Ratio 4:3' }, { name: 'ratio-16x9', desc: 'Ratio 16:9' },
  { name: 'ratio-21x9', desc: 'Ratio 21:9' },

  // ── Visually / Screenreader ──
  { name: 'visually-hidden', desc: 'Visually hidden (screen reader only)' },
  { name: 'visually-hidden-focusable', desc: 'Visually hidden focusable' },
  { name: 'stretched-link', desc: 'Stretched link' },

  // ── z-index ──
  { name: 'z-1', desc: 'z-index 1' }, { name: 'z-2', desc: 'z-index 2' },
  { name: 'z-3', desc: 'z-index 3' },

  // ── xAI custom tokens (project-specific) ──
  { name: 'shadow-xai-sm', desc: 'xAI shadow small' }, { name: 'shadow-xai-md', desc: 'xAI shadow medium' },
  { name: 'shadow-xai-lg', desc: 'xAI shadow large' },
  { name: 'bg-surface', desc: 'xAI background surface' }, { name: 'bg-surface-container', desc: 'xAI background surface container' },
  { name: 'bg-primary-container', desc: 'xAI background primary container' },
  { name: 'text-on-surface', desc: 'xAI text on surface' }, { name: 'text-on-surface-variant', desc: 'xAI text on surface variant' },
  { name: 'text-on-primary-container', desc: 'xAI text on primary container' },
  { name: 'border-outline-variant', desc: 'xAI border outline variant' },
  { name: 'sidebar', desc: 'Sidebar wrapper' }, { name: 'sidebar-nav', desc: 'Sidebar nav' },
  { name: 'sidebar-brand', desc: 'Sidebar brand' }, { name: 'sidebar-menu', desc: 'Sidebar menu' },
  { name: 'sidebar-submenu', desc: 'Sidebar submenu' }, { name: 'sidebar-footer', desc: 'Sidebar footer' },
  { name: 'sidebar-toggle', desc: 'Sidebar toggle' },
];

// ── Provider registration ────────────────────────────────────────────────────

/**
 * Register a Monaco completion provider for Bootstrap 5 class names inside
 * HTML `class="..."` attribute values.
 *
 * @returns An `IDisposable` — call `.dispose()` on unmount to clean up.
 */
export function registerBootstrapCompletionProvider(monaco: any): { dispose: () => void } {
  return monaco.languages.registerCompletionItemProvider('html', {
    triggerCharacters: [' ', '"', '-'],
    provideCompletionItems(model: any, position: any) {
      const lineContent = model.getLineContent(position.lineNumber);
      const textBeforeCursor = lineContent.substring(0, position.column - 1);

      // Detect if cursor is inside a class="..." attribute value.
      // Match `class="...` where the quote is still open.
      const classAttrMatch = textBeforeCursor.match(/\bclass\s*=\s*"([^"]*)$/);
      if (!classAttrMatch) {
        // Also handle single quotes
        const classAttrMatchSingle = textBeforeCursor.match(/\bclass\s*=\s*'([^']*)$/);
        if (!classAttrMatchSingle) return { suggestions: [] };
      }

      const classValue = classAttrMatch ? classAttrMatch[1] :
        (textBeforeCursor.match(/\bclass\s*=\s*'([^']*)$/)?.[1] ?? '');

      // Get the partial token being typed (after last space)
      const lastSpaceIdx = classValue.lastIndexOf(' ');
      const partial = lastSpaceIdx >= 0 ? classValue.substring(lastSpaceIdx + 1) : classValue;
      const partialLower = partial.toLowerCase();

      // Already-typed tokens in this class attribute (for deduplication)
      const existingTokens = new Set(classValue.trim().split(/\s+/));
      existingTokens.delete(''); // remove empty string from split

      // Filter and rank matching classes
      const matching = partialLower
        ? BOOTSTRAP_CLASSES.filter(c =>
            c.name.toLowerCase().startsWith(partialLower) && !existingTokens.has(c.name))
        : BOOTSTRAP_CLASSES.filter(c => !existingTokens.has(c.name));

      // Limit results to avoid overwhelming the UI
      const suggestions = matching.slice(0, 50).map(entry => ({
        label: entry.name,
        kind: monaco.languages.CompletionItemKind.Property,
        insertText: entry.name,
        detail: 'Bootstrap 5',
        documentation: entry.desc,
        // Replace the partial token with the full class name
        range: {
          startLineNumber: position.lineNumber,
          startColumn: position.column - partial.length,
          endLineNumber: position.lineNumber,
          endColumn: position.column,
        },
      }));

      return { suggestions };
    },
  });
}
