/**
 * Editor registry for the ElementPropertiesPanel.
 *
 * The panel is split into three render groups, mirroring the original
 * single-file layout exactly:
 *
 *   1. BASIC_SECTIONS   — universal property sections rendered before the
 *                         structural editors (尺寸 / 位置 / 颜色 / 字体 /
 *                         元素属性 / 间距 / 外观 / Flex 布局 / 阴影与模糊 /
 *                         跳转 / 文本内容). Most always render; a few are
 *                         gated by element tag (元素属性 / 文本内容).
 *   2. STRUCTURAL_EDITORS — element-specific editors chosen via `match`
 *                         (Icon / Navbar / NavLink / Dropdown / SelectOptions
 *                         / Table / Tabs / Accordion / Carousel / Progress
 *                         / Badge / Dialog / Button).
 *   3. ADVANCED_SECTION  — the trailing 高级 section, rendered last to keep
 *                         the original ordering (it originally appeared after
 *                         all structural editors).
 *
 * `matchEditors(ctx)` returns the subset of STRUCTURAL_EDITORS whose `match`
 * returns true, in registration order. The main panel iterates the result.
 */
import type { EditorDef, EditorContext } from './types';
import type { ElementStyle } from '@xai/shared';
import {
  AlignLeft, AlignCenter, AlignRight, AlignJustify,
  Link as LinkIcon, FileText, X,
  Underline, Strikethrough,
  AlignHorizontalJustifyStart, AlignHorizontalJustifyCenter, AlignHorizontalJustifyEnd,
  AlignHorizontalSpaceBetween, AlignHorizontalSpaceAround,
  AlignVerticalJustifyStart, AlignVerticalJustifyCenter, AlignVerticalJustifyEnd,
  StretchVertical,
  ArrowRight, ArrowDown,
  ChevronDown, ChevronRight,
  Percent, Tag, Frame,
  PanelLeftClose, PanelLeftOpen,
} from 'lucide-react';
import {
  PropertyField,
  PropertyButtonGroup,
  PropertySlider,
  PropertySelect,
} from './controls';
import { ColorField, BorderEditor, ShadowEditor, BlurEditor } from '../StyleControls';
import { TableEditor } from './editors/TableEditor';
import { TabsEditor } from './editors/TabsEditor';
import { AccordionEditor } from './editors/AccordionEditor';
import { CarouselEditor } from './editors/CarouselEditor';
import { ProgressEditor } from './editors/ProgressEditor';
import { BadgeEditor } from './editors/BadgeEditor';
import { DialogEditor } from './editors/DialogEditor';
import { IconEditor } from './editors/IconEditor';
import { NavLinkIconEditor } from './editors/NavLinkIconEditor';
import { ButtonEditor } from './editors/ButtonEditor';
import { SelectOptionsEditor } from './editors/SelectOptionsEditor';
import { AdvancedCssEditor } from './editors/AdvancedCssEditor';

/* ------------------------------------------------------------------ *
 * Option arrays (kept here so the basic sections below stay declarative)
 * ------------------------------------------------------------------ */

const alignmentOptions = [
  { value: 'left', icon: <AlignLeft size={13} />, title: '左对齐' },
  { value: 'center', icon: <AlignCenter size={13} />, title: '居中' },
  { value: 'right', icon: <AlignRight size={13} />, title: '右对齐' },
  { value: 'justify', icon: <AlignJustify size={13} />, title: '两端对齐' },
];

const fontFamilyOptions = [
  { value: '', label: '继承' },
  { value: 'system-ui', label: 'system-ui' },
  { value: 'Arial', label: 'Arial' },
  { value: 'Helvetica', label: 'Helvetica' },
  { value: 'Georgia', label: 'Georgia' },
  { value: 'Times New Roman', label: 'Times New Roman' },
  { value: 'Courier New', label: 'Courier New' },
  { value: 'Microsoft YaHei', label: 'Microsoft YaHei' },
  { value: 'PingFang SC', label: 'PingFang SC' },
  { value: 'sans-serif', label: 'sans-serif' },
  { value: 'serif', label: 'serif' },
  { value: 'monospace', label: 'monospace' },
];

const fontWeightOptions = [
  { value: '', label: '继承' },
  { value: 'normal', label: 'normal' },
  { value: 'bold', label: 'bold' },
  { value: 'lighter', label: 'lighter' },
  { value: 'bolder', label: 'bolder' },
  { value: '100', label: '100' },
  { value: '200', label: '200' },
  { value: '300', label: '300' },
  { value: '400', label: '400' },
  { value: '500', label: '500' },
  { value: '600', label: '600' },
  { value: '700', label: '700' },
  { value: '800', label: '800' },
  { value: '900', label: '900' },
];

const textDecorationOptions = [
  { value: '', icon: <span style={{ fontSize: 11 }}>无</span>, title: '无' },
  { value: 'underline', icon: <Underline size={13} />, title: '下划线' },
  { value: 'line-through', icon: <Strikethrough size={13} />, title: '删除线' },
  { value: 'overline', icon: <span style={{ fontSize: 11, textDecoration: 'overline' }}>A</span>, title: '上划线' },
];

const textTransformOptions = [
  { value: '', icon: <span style={{ fontSize: 11 }}>Aa</span>, title: '默认' },
  { value: 'uppercase', icon: <span style={{ fontSize: 11 }}>AB</span>, title: '大写' },
  { value: 'lowercase', icon: <span style={{ fontSize: 11 }}>ab</span>, title: '小写' },
  { value: 'capitalize', icon: <span style={{ fontSize: 11 }}>Ab</span>, title: '首字母大写' },
];

const flexDirectionOptions = [
  { value: '', label: '继承' },
  { value: 'row', label: '行' },
  { value: 'row-reverse', label: '行（反向）' },
  { value: 'column', label: '列' },
  { value: 'column-reverse', label: '列（反向）' },
];

const flexWrapOptions = [
  { value: '', label: '继承' },
  { value: 'nowrap', label: '不换行' },
  { value: 'wrap', label: '换行' },
  { value: 'wrap-reverse', label: '反向换行' },
];

const justifyContentOptions = [
  { value: '', icon: <span style={{ fontSize: 11 }}>无</span>, title: '默认' },
  { value: 'flex-start', icon: <AlignHorizontalJustifyStart size={13} />, title: '起始' },
  { value: 'center', icon: <AlignHorizontalJustifyCenter size={13} />, title: '居中' },
  { value: 'flex-end', icon: <AlignHorizontalJustifyEnd size={13} />, title: '末尾' },
  { value: 'space-between', icon: <AlignHorizontalSpaceBetween size={13} />, title: '两端分布' },
  { value: 'space-around', icon: <AlignHorizontalSpaceAround size={13} />, title: '环绕分布' },
];

const alignItemsOptions = [
  { value: '', icon: <span style={{ fontSize: 11 }}>无</span>, title: '默认' },
  { value: 'flex-start', icon: <AlignVerticalJustifyStart size={13} />, title: '起始' },
  { value: 'center', icon: <AlignVerticalJustifyCenter size={13} />, title: '居中' },
  { value: 'flex-end', icon: <AlignVerticalJustifyEnd size={13} />, title: '末尾' },
  { value: 'stretch', icon: <StretchVertical size={13} />, title: '拉伸' },
];

/* ------------------------------------------------------------------ *
 * Tag-based predicates used by match functions
 * ------------------------------------------------------------------ */

const isInputOrTextarea = (ctx: EditorContext) =>
  ctx.element.tagName === 'input' || ctx.element.tagName === 'textarea';

const isMediaTag = (ctx: EditorContext) =>
  ['img', 'iframe', 'video', 'audio', 'source'].includes(ctx.element.tagName);

/** "元素属性" section shows when any of placeholder/value/href/src applies. */
const showElementAttrs = (ctx: EditorContext) =>
  isInputOrTextarea(ctx) || ctx.element.tagName === 'a' || isMediaTag(ctx);

/** "文本内容" section hides for elements whose text isn't editable inline. */
const showTextEditor = (ctx: EditorContext) =>
  !['img', 'input', 'textarea', 'select'].includes(ctx.element.tagName);

/* ------------------------------------------------------------------ *
 * BASIC_SECTIONS — universal property sections (pre-structural order)
 * ------------------------------------------------------------------ */

export const BASIC_SECTIONS: EditorDef[] = [
  {
    id: 'dimensions',
    match: () => true,
    render: (ctx) => {
      const { element, ops } = ctx;
      const onStyleChange = ops.style.onStyleChange;
      return (
        <div className="designer-prop-section">
          <div className="designer-prop-section-title">尺寸</div>
          <div className="designer-prop-row">
            <PropertyField
              label="宽度"
              value={element.style.width}
              onChange={val => onStyleChange({ width: val })}
              placeholder="auto"
            />
            <PropertyField
              label="高度"
              value={element.style.height}
              onChange={val => onStyleChange({ height: val })}
              placeholder="auto"
            />
          </div>
        </div>
      );
    },
  },
  {
    id: 'position',
    match: () => true,
    render: (ctx) => {
      const { element, ops } = ctx;
      const onStyleChange = ops.style.onStyleChange;
      return (
        <div className="designer-prop-section">
          <div className="designer-prop-section-title">位置</div>
          <PropertyButtonGroup
            label="对齐"
            value={element.style.textAlign}
            options={alignmentOptions}
            onChange={val => onStyleChange({ textAlign: val })}
          />
          <div className="designer-prop-row">
            <PropertyField
              label="X 坐标"
              value={element.style.left}
              onChange={val => onStyleChange({ left: val })}
              placeholder="auto"
            />
            <PropertyField
              label="Y 坐标"
              value={element.style.top}
              onChange={val => onStyleChange({ top: val })}
              placeholder="auto"
            />
          </div>
          <PropertyField
            label="旋转 (°)"
            value={element.style.rotation}
            onChange={val => onStyleChange({ rotation: val })}
            placeholder="0"
          />
          <PropertyField
            label="Z 轴"
            value={element.style.zIndex}
            onChange={val => onStyleChange({ zIndex: val })}
            placeholder="0"
          />
        </div>
      );
    },
  },
  {
    id: 'colors',
    match: () => true,
    render: (ctx) => {
      const { element, ops } = ctx;
      const onStyleChange = ops.style.onStyleChange;
      return (
        <div className="designer-prop-section">
          <div className="designer-prop-section-title">颜色</div>
          <ColorField
            label="背景"
            value={element.style.backgroundColor}
            onChange={val => onStyleChange({ backgroundColor: val })}
          />
          <PropertyField
            label="背景图片"
            value={element.style.backgroundImage}
            onChange={val => onStyleChange({ backgroundImage: val })}
            placeholder="https://... 或 url(...)"
          />
          <ColorField
            label="文字"
            value={element.style.color}
            onChange={val => onStyleChange({ color: val })}
          />
        </div>
      );
    },
  },
  {
    id: 'typography',
    match: () => true,
    render: (ctx) => {
      const { element, ops } = ctx;
      const onStyleChange = ops.style.onStyleChange;
      return (
        <div className="designer-prop-section">
          <div className="designer-prop-section-title">字体</div>
          <PropertyField
            label="字号"
            value={element.style.fontSize}
            onChange={val => onStyleChange({ fontSize: val })}
            placeholder="16px"
          />
          <PropertySelect
            label="字体族"
            value={element.style.fontFamily}
            options={fontFamilyOptions}
            onChange={val => onStyleChange({ fontFamily: val })}
          />
          <PropertySelect
            label="字重"
            value={element.style.fontWeight}
            options={fontWeightOptions}
            onChange={val => onStyleChange({ fontWeight: val })}
          />
          <PropertyField
            label="行高"
            value={element.style.lineHeight}
            onChange={val => onStyleChange({ lineHeight: val })}
            placeholder="1.5"
          />
          <PropertyField
            label="字间距"
            value={element.style.letterSpacing}
            onChange={val => onStyleChange({ letterSpacing: val })}
            placeholder="0.05em"
          />
          <PropertyButtonGroup
            label="文本修饰"
            value={element.style.textDecoration}
            options={textDecorationOptions}
            onChange={val => onStyleChange({ textDecoration: val })}
          />
          <PropertyButtonGroup
            label="大小写转换"
            value={element.style.textTransform}
            options={textTransformOptions}
            onChange={val => onStyleChange({ textTransform: val })}
          />
        </div>
      );
    },
  },
  {
    id: 'element-attrs',
    match: (ctx) => showElementAttrs(ctx),
    render: (ctx) => {
      const { element, ops } = ctx;
      const onStyleChange = ops.style.onStyleChange;
      const showPlaceholder = isInputOrTextarea(ctx);
      const showValue = isInputOrTextarea(ctx);
      const showHref = element.tagName === 'a';
      const showSrc = isMediaTag(ctx);
      return (
        <div className="designer-prop-section">
          <div className="designer-prop-section-title">元素属性</div>
          {showPlaceholder && (
            <PropertyField
              label="Placeholder"
              value={element.style.placeholder}
              onChange={val => onStyleChange({ placeholder: val })}
              placeholder="请输入提示文字"
            />
          )}
          {showValue && (
            <PropertyField
              label="值"
              value={element.style.value}
              onChange={val => onStyleChange({ value: val })}
              placeholder="默认值"
            />
          )}
          {showHref && (
            <PropertyField
              label="链接地址"
              value={element.style.href}
              onChange={val => onStyleChange({ href: val })}
              placeholder="https://example.com"
            />
          )}
          {showSrc && (
            <PropertyField
              label="资源地址"
              value={element.style.src}
              onChange={val => onStyleChange({ src: val })}
              placeholder="https://..."
            />
          )}
        </div>
      );
    },
  },
  {
    id: 'spacing',
    match: () => true,
    render: (ctx) => {
      const { element, ops } = ctx;
      const onStyleChange = ops.style.onStyleChange;
      return (
        <div className="designer-prop-section">
          <div className="designer-prop-section-title">间距</div>
          <div className="designer-prop-row">
            <PropertyField
              label="内边距"
              value={element.style.padding}
              onChange={val => onStyleChange({ padding: val })}
              placeholder="0"
            />
            <PropertyField
              label="外边距"
              value={element.style.margin}
              onChange={val => onStyleChange({ margin: val })}
              placeholder="0"
            />
          </div>
          <div className="designer-prop-divider" />
          <label className="designer-prop-label">内边距（四向）</label>
          <div className="designer-prop-row">
            <PropertyField
              label="上"
              value={element.style.paddingTop}
              onChange={val => onStyleChange({ paddingTop: val })}
              placeholder="0"
            />
            <PropertyField
              label="下"
              value={element.style.paddingBottom}
              onChange={val => onStyleChange({ paddingBottom: val })}
              placeholder="0"
            />
          </div>
          <div className="designer-prop-row">
            <PropertyField
              label="左"
              value={element.style.paddingLeft}
              onChange={val => onStyleChange({ paddingLeft: val })}
              placeholder="0"
            />
            <PropertyField
              label="右"
              value={element.style.paddingRight}
              onChange={val => onStyleChange({ paddingRight: val })}
              placeholder="0"
            />
          </div>
          <label className="designer-prop-label">外边距（四向）</label>
          <div className="designer-prop-row">
            <PropertyField
              label="上"
              value={element.style.marginTop}
              onChange={val => onStyleChange({ marginTop: val })}
              placeholder="0"
            />
            <PropertyField
              label="下"
              value={element.style.marginBottom}
              onChange={val => onStyleChange({ marginBottom: val })}
              placeholder="0"
            />
          </div>
          <div className="designer-prop-row">
            <PropertyField
              label="左"
              value={element.style.marginLeft}
              onChange={val => onStyleChange({ marginLeft: val })}
              placeholder="0"
            />
            <PropertyField
              label="右"
              value={element.style.marginRight}
              onChange={val => onStyleChange({ marginRight: val })}
              placeholder="0"
            />
          </div>
        </div>
      );
    },
  },
  {
    id: 'appearance',
    match: () => true,
    render: (ctx) => {
      const { element, ops } = ctx;
      const onStyleChange = ops.style.onStyleChange;
      return (
        <div className="designer-prop-section">
          <div className="designer-prop-section-title">外观</div>
          <PropertySlider
            label="透明度"
            value={element.style.opacity}
            onChange={val => onStyleChange({ opacity: val })}
            min={0}
            max={1}
            step={0.1}
          />
          <div className="designer-prop-row">
            <PropertyField
              label="圆角"
              value={element.style.borderRadius}
              onChange={val => onStyleChange({ borderRadius: val })}
              placeholder="0"
            />
          </div>
          <div className="designer-prop-field">
            <label className="designer-prop-label">边框</label>
            <BorderEditor
              value={element.style.border}
              onChange={val => onStyleChange({ border: val })}
            />
          </div>
        </div>
      );
    },
  },
  {
    id: 'flex',
    match: () => true,
    render: (ctx) => {
      const { element, ops } = ctx;
      const onStyleChange = ops.style.onStyleChange;
      const isFlex = element.style.display === 'flex' || element.style.display === 'inline-flex';
      return (
        <div className="designer-prop-section">
          <div className="designer-prop-section-title">Flex 布局</div>
          {isFlex ? (
            <>
              <div className="designer-prop-field">
                <label className="designer-prop-label">display</label>
                <div className="designer-prop-btn-group">
                  <button
                    className={`designer-prop-btn-icon ${element.style.display === 'flex' ? 'active' : ''}`}
                    onClick={() => onStyleChange({ display: 'flex' })}
                    title="flex"
                    type="button"
                  >
                    <span style={{ fontSize: 10 }}>flex</span>
                  </button>
                  <button
                    className={`designer-prop-btn-icon ${element.style.display === 'inline-flex' ? 'active' : ''}`}
                    onClick={() => onStyleChange({ display: 'inline-flex' })}
                    title="inline-flex"
                    type="button"
                  >
                    <span style={{ fontSize: 9 }}>inline</span>
                  </button>
                  <button
                    className="designer-prop-btn-icon"
                    onClick={() => onStyleChange({ display: '' })}
                    title="关闭 Flex"
                    type="button"
                  >
                    <X size={13} />
                  </button>
                </div>
              </div>
              <PropertySelect
                label="主轴方向"
                value={element.style.flexDirection}
                options={flexDirectionOptions}
                onChange={val => onStyleChange({ flexDirection: val })}
              />
              <PropertyButtonGroup
                label="主轴对齐"
                value={element.style.justifyContent}
                options={justifyContentOptions}
                onChange={val => onStyleChange({ justifyContent: val })}
              />
              <PropertyButtonGroup
                label="交叉轴对齐"
                value={element.style.alignItems}
                options={alignItemsOptions}
                onChange={val => onStyleChange({ alignItems: val })}
              />
              <PropertySelect
                label="换行"
                value={element.style.flexWrap}
                options={flexWrapOptions}
                onChange={val => onStyleChange({ flexWrap: val })}
              />
              <PropertyField
                label="间距"
                value={element.style.gap}
                onChange={val => onStyleChange({ gap: val })}
                placeholder="8px"
              />
            </>
          ) : (
            <div className="designer-prop-field">
              <button
                type="button"
                className="designer-prop-btn-icon full-width"
                onClick={() => onStyleChange({ display: 'flex' })}
                title="启用 Flex 布局"
              >
                启用 Flex
              </button>
            </div>
          )}
        </div>
      );
    },
  },
  {
    id: 'shadow-blur',
    match: () => true,
    render: (ctx) => {
      const { element, ops } = ctx;
      const onStyleChange = ops.style.onStyleChange;
      return (
        <div className="designer-prop-section">
          <div className="designer-prop-section-title">阴影与模糊</div>
          <div className="designer-prop-field">
            <label className="designer-prop-label">阴影</label>
            <ShadowEditor
              value={element.style.boxShadow}
              onChange={val => onStyleChange({ boxShadow: val })}
            />
          </div>
          <div className="designer-prop-field">
            <label className="designer-prop-label">模糊</label>
            <BlurEditor
              value={element.style.backdropFilter}
              onChange={val => onStyleChange({ backdropFilter: val })}
              warning={element.style.backdropRootWarning}
            />
          </div>
        </div>
      );
    },
  },
  {
    id: 'navigation',
    match: () => true,
    render: (ctx) => {
      const { element, ops, screens } = ctx;
      const onStyleChange = ops.style.onStyleChange;
      return (
        <div className="designer-prop-section">
          <div className="designer-prop-section-title">跳转</div>
          <div className="designer-prop-field">
            <label className="designer-prop-label">类型</label>
            <div className="designer-prop-btn-group">
              <button
                className={`designer-prop-btn-icon ${element.style.linkType === 'page' ? 'active' : ''}`}
                onClick={() => onStyleChange(
                  element.style.linkType === 'page'
                    ? { linkType: '', linkTarget: '' }
                    : { linkType: 'page', linkTarget: '' }
                )}
                title="跳转到页面"
                type="button"
              >
                <FileText size={13} />
              </button>
              <button
                className={`designer-prop-btn-icon ${element.style.linkType === 'url' ? 'active' : ''}`}
                onClick={() => onStyleChange(
                  element.style.linkType === 'url'
                    ? { linkType: '', linkTarget: '' }
                    : { linkType: 'url', linkTarget: '' }
                )}
                title="跳转到链接"
                type="button"
              >
                <LinkIcon size={13} />
              </button>
            </div>
          </div>
          {element.style.linkType === 'page' && (
            <div className="designer-prop-field">
              <label className="designer-prop-label">目标页面</label>
              <div className="designer-prop-select-wrap">
                <select
                  className="designer-prop-input designer-prop-select"
                  value={element.style.linkTarget}
                  onChange={e => onStyleChange({ linkTarget: e.target.value })}
                >
                  <option value="" disabled>选择页面...</option>
                  {screens.map(s => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
                {element.style.linkTarget && (
                  <button
                    className="designer-prop-select-clear"
                    onClick={() => onStyleChange({ linkType: '', linkTarget: '' })}
                    title="清除跳转"
                    type="button"
                  >
                    <X size={12} />
                  </button>
                )}
              </div>
            </div>
          )}
          {element.style.linkType === 'url' && (
            <PropertyField
              label="URL 地址"
              value={element.style.linkTarget}
              onChange={val => onStyleChange({ linkTarget: val })}
              placeholder="https://example.com"
            />
          )}
        </div>
      );
    },
  },
  {
    id: 'content',
    match: (ctx) => showTextEditor(ctx),
    render: (ctx) => {
      const { element, ops } = ctx;
      const onStyleChange = ops.style.onStyleChange;
      // When the selected element is a container with multiple text-bearing
      // children (e.g. <div><h1>…</h1><p>…</p></div>), getEditableText
      // returns '' and setEditableText won't recurse into any child —
      // editing here would only append a text node at the end. Tell the user
      // to pick a more specific element instead of leaving them staring at a
      // confusingly empty textarea.
      const ambiguous = element.style.hasMultipleTextChildren === true;
      return (
        <div className="designer-prop-section">
          <div className="designer-prop-section-title">文本内容</div>
          <PropertyField
            label="内容"
            value={element.style.text}
            onChange={val => onStyleChange({ text: val })}
            type="textarea"
            placeholder={ambiguous ? '该容器包含多个子元素文本，请选择具体子元素编辑' : '元素文本...'}
          />
          {ambiguous && (
            <div
              className="designer-prop-hint"
              title="父容器的文本由多个子元素组成，无法整体编辑。点击画布中的具体子元素（标题、段落、按钮等）即可编辑其文本。"
            >
              该容器包含多个子元素文本，请选择具体子元素编辑
            </div>
          )}
        </div>
      );
    },
  },
];

/* ------------------------------------------------------------------ *
 * STRUCTURAL_EDITORS — element-specific editors chosen via `match`
 * Order matches the original main panel layout.
 * ------------------------------------------------------------------ */

export const STRUCTURAL_EDITORS: EditorDef[] = [
  {
    id: 'icon',
    match: (ctx) => ctx.element.tagName === 'i' && /\bbi\b/.test(ctx.element.className),
    render: (ctx) => {
      const { element, ops } = ctx;
      const onStyleChange = ops.style.onStyleChange;
      return (
        <div className="designer-prop-section">
          <div className="designer-prop-section-title">Bootstrap 图标</div>
          <IconEditor
            className={element.style.iconClass || element.className}
            onChange={val => onStyleChange({ iconClass: val })}
          />
        </div>
      );
    },
  },
  {
    id: 'navbar-orientation',
    match: (ctx) => ctx.element.tagName === 'nav' && /\bnavbar\b/.test(ctx.element.className),
    render: (ctx) => {
      const { element, ops } = ctx;
      const onStyleChange = ops.style.onStyleChange;
      return (
        <div className="designer-prop-section">
          <div className="designer-prop-section-title">导航栏排列方向</div>
          <div className="designer-prop-btn-group designer-navbar-orientation">
            <button
              type="button"
              className={`designer-prop-btn-icon ${(element.style.navbarOrientation || 'horizontal') === 'horizontal' ? 'active' : ''}`}
              onClick={() => onStyleChange({ navbarOrientation: 'horizontal' })}
              title="横向排列 — 适合顶部导航栏"
            >
              <ArrowRight size={13} />
              <span>横向</span>
            </button>
            <button
              type="button"
              className={`designer-prop-btn-icon ${element.style.navbarOrientation === 'vertical' ? 'active' : ''}`}
              onClick={() => onStyleChange({ navbarOrientation: 'vertical' })}
              title="纵向排列 — 适合左侧侧边导航"
            >
              <ArrowDown size={13} />
              <span>纵向</span>
            </button>
          </div>
        </div>
      );
    },
  },
  {
    id: 'navbar-collapse',
    match: (ctx) =>
      ctx.element.tagName === 'nav' &&
      /\bnavbar\b/.test(ctx.element.className) &&
      ctx.element.style.navbarOrientation === 'vertical',
    render: (ctx) => {
      const { element, ops } = ctx;
      const onStyleChange = ops.style.onStyleChange;
      return (
        <div className="designer-prop-section">
          <div className="designer-prop-section-title">侧边栏折叠</div>
          <div className="designer-prop-btn-group designer-navbar-orientation">
            <button
              type="button"
              className={`designer-prop-btn-icon ${element.style.navbarCollapsed === 'true' ? 'active' : ''}`}
              onClick={() => onStyleChange({ navbarCollapsed: 'true' })}
              title="折叠 — 仅显示图标，宽度变窄"
            >
              <PanelLeftClose size={13} />
              <span>折叠</span>
            </button>
            <button
              type="button"
              className={`designer-prop-btn-icon ${(element.style.navbarCollapsed || 'false') === 'false' ? 'active' : ''}`}
              onClick={() => onStyleChange({ navbarCollapsed: 'false' })}
              title="展开 — 显示完整菜单"
            >
              <PanelLeftOpen size={13} />
              <span>展开</span>
            </button>
          </div>
        </div>
      );
    },
  },
  {
    id: 'navlink-icon',
    match: (ctx) =>
      ctx.element.tagName === 'a' &&
      (/\bnav-link\b/.test(ctx.element.className) || ctx.element.style.dropdownItem === 'true'),
    render: (ctx) => {
      const { element, ops } = ctx;
      const onStyleChange = ops.style.onStyleChange;
      return (
        <div className="designer-prop-section">
          <div className="designer-prop-section-title">菜单项图标</div>
          <NavLinkIconEditor
            currentIconName={element.style.navLinkIcon || ''}
            onPick={iconName => onStyleChange({ navLinkIcon: iconName })}
          />
        </div>
      );
    },
  },
  {
    id: 'dropdown',
    match: (ctx) => ctx.element.tagName === 'div' && /\bdropdown\b/.test(ctx.element.className),
    render: (ctx) => {
      const { element, ops } = ctx;
      const onStyleChange = ops.style.onStyleChange;
      return (
        <div className="designer-prop-section">
          <div className="designer-prop-section-title">下拉菜单展开状态</div>
          <div className="designer-prop-btn-group designer-navbar-orientation">
            <button
              type="button"
              className={`designer-prop-btn-icon ${element.style.dropdownOpen === 'true' ? 'active' : ''}`}
              onClick={() => onStyleChange({ dropdownOpen: 'true' })}
              title="展开子菜单"
            >
              <ChevronDown size={13} />
              <span>展开</span>
            </button>
            <button
              type="button"
              className={`designer-prop-btn-icon ${element.style.dropdownOpen === 'false' ? 'active' : ''}`}
              onClick={() => onStyleChange({ dropdownOpen: 'false' })}
              title="折叠子菜单"
            >
              <ChevronRight size={13} />
              <span>折叠</span>
            </button>
          </div>
        </div>
      );
    },
  },
  {
    id: 'select-options',
    match: (ctx) => ctx.element.tagName === 'select' && ctx.ops.selectOptions != null,
    render: (ctx) => {
      const selectOps = ctx.ops.selectOptions;
      if (!selectOps) return null;
      return (
        <div className="designer-prop-section">
          <div className="designer-prop-section-title">下拉选项</div>
          <SelectOptionsEditor
            options={ctx.domState.selectOptions ?? []}
            onChange={selectOps.onChange}
          />
        </div>
      );
    },
  },
  {
    id: 'table',
    match: (ctx) => ctx.domState.hasTableContext === true,
    render: (ctx) => {
      const { element, ops, domState } = ctx;
      const onStyleChange = ops.style.onStyleChange;
      const table = ops.table;
      return (
        <div className="designer-prop-section">
          <div className="designer-prop-section-title">表格操作</div>
          <TableEditor
            columnWidth={domState.tableColumnWidth ?? ''}
            overflowX={element.style.overflowX}
            overflowY={element.style.overflowY}
            tableMaxHeight={element.style.tableMaxHeight}
            stickyLeft={!!domState.tableStickyLeft}
            stickyRight={!!domState.tableStickyRight}
            striped={!!domState.tableStriped}
            onAddRow={table?.onAddTableRow}
            onAddColumn={table?.onAddTableColumn}
            onRemoveRow={table?.onRemoveTableRow}
            onRemoveColumn={table?.onRemoveTableColumn}
            onCopyRow={table?.onCopyTableRow}
            onCopyColumn={table?.onCopyTableColumn}
            onColumnWidthChange={table?.onTableColumnWidthChange}
            onScrollChange={onStyleChange}
            onToggleTableStriped={table?.onToggleTableStriped}
            onMergeTableCell={table?.onMergeTableCell}
            onToggleStickyColumn={table?.onToggleTableStickyColumn}
          />
        </div>
      );
    },
  },
  {
    id: 'tabs',
    match: (ctx) => ctx.domState.tabItems != null && ctx.domState.tabItems.length > 0,
    render: (ctx) => {
      const items = ctx.domState.tabItems;
      if (!items || items.length === 0) return null;
      const tabs = ctx.ops.tabs;
      return (
        <div className="designer-prop-section">
          <div className="designer-prop-section-title">Tabs</div>
          <TabsEditor
            items={items}
            onAddTab={tabs?.onAddTab}
            onRemoveTab={tabs?.onRemoveTab}
            onRenameTab={tabs?.onRenameTab}
            onSetActiveTab={tabs?.onSetActiveTab}
          />
        </div>
      );
    },
  },
  {
    id: 'accordion',
    match: (ctx) => ctx.domState.accordionItems != null && ctx.domState.accordionItems.length > 0,
    render: (ctx) => {
      const items = ctx.domState.accordionItems;
      if (!items || items.length === 0) return null;
      const acc = ctx.ops.accordion;
      return (
        <div className="designer-prop-section">
          <div className="designer-prop-section-title">手风琴</div>
          <AccordionEditor
            items={items}
            onAddAccordion={acc?.onAddAccordion}
            onRemoveAccordion={acc?.onRemoveAccordion}
            onRenameAccordion={acc?.onRenameAccordion}
            onToggleAccordion={acc?.onToggleAccordion}
          />
        </div>
      );
    },
  },
  {
    id: 'carousel',
    match: (ctx) => ctx.domState.carouselSlides != null && ctx.domState.carouselSlides.length > 0,
    render: (ctx) => {
      const slides = ctx.domState.carouselSlides;
      if (!slides || slides.length === 0) return null;
      const car = ctx.ops.carousel;
      return (
        <div className="designer-prop-section">
          <div className="designer-prop-section-title">轮播</div>
          <CarouselEditor
            slides={slides}
            hasIndicators={ctx.domState.carouselHasIndicators}
            hasControls={ctx.domState.carouselHasControls}
            onAddCarouselSlide={car?.onAddCarouselSlide}
            onRemoveCarouselSlide={car?.onRemoveCarouselSlide}
            onSetActiveCarouselSlide={car?.onSetActiveCarouselSlide}
            onRenameCarouselSlide={car?.onRenameCarouselSlide}
          />
        </div>
      );
    },
  },
  {
    id: 'progress',
    match: (ctx) => ctx.domState.progressData != null && ctx.ops.progress != null,
    render: (ctx) => {
      const data = ctx.domState.progressData;
      const progress = ctx.ops.progress;
      if (!data || !progress) return null;
      return (
        <div className="designer-prop-section">
          <div className="designer-prop-section-title"><Percent size={11} style={{ verticalAlign: '-1px', marginRight: 4 }} />进度条</div>
          <ProgressEditor data={data} onUpdate={progress.onUpdate} />
        </div>
      );
    },
  },
  {
    id: 'badge',
    match: (ctx) => ctx.domState.badgeData != null && ctx.ops.badge != null,
    render: (ctx) => {
      const data = ctx.domState.badgeData;
      const badge = ctx.ops.badge;
      if (!data || !badge) return null;
      return (
        <div className="designer-prop-section">
          <div className="designer-prop-section-title"><Tag size={11} style={{ verticalAlign: '-1px', marginRight: 4 }} />徽标</div>
          <BadgeEditor data={data} onUpdate={badge.onUpdate} />
        </div>
      );
    },
  },
  {
    id: 'dialog',
    match: (ctx) => ctx.domState.dialogData != null && ctx.ops.dialog != null,
    render: (ctx) => {
      const data = ctx.domState.dialogData;
      const dialog = ctx.ops.dialog;
      if (!data || !dialog) return null;
      return (
        <div className="designer-prop-section">
          <div className="designer-prop-section-title"><Frame size={11} style={{ verticalAlign: '-1px', marginRight: 4 }} />对话框</div>
          <DialogEditor data={data} onUpdate={dialog.onUpdate} />
        </div>
      );
    },
  },
  {
    id: 'button',
    match: (ctx) => ctx.domState.buttonData != null && ctx.ops.button != null,
    render: (ctx) => {
      const data = ctx.domState.buttonData;
      const button = ctx.ops.button;
      if (!data || !button) return null;
      return (
        <div className="designer-prop-section">
          <div className="designer-prop-section-title">按钮</div>
          <ButtonEditor data={data} onUpdate={button.onUpdate} />
        </div>
      );
    },
  },
];

/* ------------------------------------------------------------------ *
 * ADVANCED_SECTION — trailing section (kept separate to preserve the
 * original ordering: it always followed the structural editors).
 * ------------------------------------------------------------------ */

export const ADVANCED_SECTION: EditorDef = {
  id: 'advanced',
  match: () => true,
  render: (ctx) => {
    const { element, ops } = ctx;
    const onStyleChange = ops.style.onStyleChange;
    return (
      <div className="designer-prop-section">
        <div className="designer-prop-section-title">高级</div>
        <AdvancedCssEditor
          className={element.className || ''}
          cssText={element.style.cssText || ''}
          onClassNameChange={val => {
            // 通过 applyStyleChange 的 className 分支写入 iframe DOM。
            // className 不在 ElementStyle 类型中（在 SelectedElement 上），
            // 用类型断言传递，applyStyleChange 内有对应分支处理。
            onStyleChange({ className: val } as unknown as Partial<ElementStyle>);
          }}
          onCssTextChange={val => onStyleChange({ cssText: val })}
        />
      </div>
    );
  },
};

/* ------------------------------------------------------------------ *
 * Public helper — returns the subset of structural editors that apply.
 * ------------------------------------------------------------------ */

export function matchEditors(ctx: EditorContext): EditorDef[] {
  return STRUCTURAL_EDITORS.filter(editor => editor.match(ctx));
}
