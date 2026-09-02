/**
 * AdvancedCssEditor — 高级 CSS 可视化编辑器
 *
 * 替换原 ADVANCED_SECTION 中的两个裸输入框（CSS 类名 + 内联样式 cssText），
 * 提供可视化的类名管理（chip + Bootstrap 类补全）和样式属性行编辑
 * （颜色/数值/枚举自动切换控件），并保留原始文本输入作为折叠的 fallback。
 *
 * 设计约束：
 * - 不改 ElementStyle 类型、不改 applyStyleChange 逻辑、不改 extractElementStyle 读取
 * - 最终仍通过 onStyleChange({ cssText }) 和 onClassNameChange 提交，与现有直接 DOM 路径完全兼容
 * - 复用现有 AlphaColorPicker / NumberInput / PropertyField 等控件
 */
import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { Plus, Trash2, ChevronDown, ChevronUp, X } from 'lucide-react';
import { AlphaColorPicker } from '../../AlphaColorPicker';

/* ============================================================
 * Bootstrap 5 常用类补全数据（硬编码）
 * ============================================================ */

const BOOTSTRAP_CLASS_SUGGESTIONS: string[] = [
  // 间距
  'p-0', 'p-1', 'p-2', 'p-3', 'p-4', 'p-5',
  'pt-0', 'pt-1', 'pt-2', 'pt-3', 'pt-4', 'pt-5',
  'pb-0', 'pb-1', 'pb-2', 'pb-3', 'pb-4', 'pb-5',
  'ps-0', 'ps-1', 'ps-2', 'ps-3', 'ps-4', 'ps-5',
  'pe-0', 'pe-1', 'pe-2', 'pe-3', 'pe-4', 'pe-5',
  'px-0', 'px-1', 'px-2', 'px-3', 'px-4', 'px-5',
  'py-0', 'py-1', 'py-2', 'py-3', 'py-4', 'py-5',
  'm-0', 'm-1', 'm-2', 'm-3', 'm-4', 'm-5',
  'mt-0', 'mt-1', 'mt-2', 'mt-3', 'mt-4', 'mt-5',
  'mb-0', 'mb-1', 'mb-2', 'mb-3', 'mb-4', 'mb-5',
  'ms-0', 'ms-1', 'ms-2', 'ms-3', 'ms-4', 'ms-5',
  'me-0', 'me-1', 'me-2', 'me-3', 'me-4', 'me-5',
  'mx-auto', 'mx-0', 'mx-1', 'mx-2', 'mx-3', 'mx-4', 'mx-5',
  'my-0', 'my-1', 'my-2', 'my-3', 'my-4', 'my-5',
  // 显示
  'd-none', 'd-inline', 'd-inline-block', 'd-block', 'd-flex', 'd-inline-flex', 'd-grid',
  // Flex
  'flex-row', 'flex-column', 'flex-row-reverse', 'flex-column-reverse',
  'flex-wrap', 'flex-nowrap', 'flex-wrap-reverse',
  'justify-content-start', 'justify-content-center', 'justify-content-end', 'justify-content-between', 'justify-content-around',
  'align-items-start', 'align-items-center', 'align-items-end', 'align-items-stretch',
  'flex-grow-1', 'flex-shrink-0', 'flex-fill',
  // 文本
  'text-start', 'text-center', 'text-end',
  'text-primary', 'text-secondary', 'text-success', 'text-danger', 'text-warning', 'text-info', 'text-light', 'text-dark', 'text-muted', 'text-white',
  'text-decoration-none', 'text-decoration-underline', 'text-decoration-line-through',
  'text-uppercase', 'text-lowercase', 'text-capitalize',
  'fw-bold', 'fw-bolder', 'fw-normal', 'fw-light', 'fw-lighter',
  'fst-italic', 'fst-normal',
  'fs-1', 'fs-2', 'fs-3', 'fs-4', 'fs-5', 'fs-6',
  'lh-1', 'lh-sm', 'lh-base', 'lh-lg',
  // 背景
  'bg-primary', 'bg-secondary', 'bg-success', 'bg-danger', 'bg-warning', 'bg-info', 'bg-light', 'bg-dark', 'bg-white', 'bg-transparent', 'bg-body',
  // 按钮
  'btn', 'btn-primary', 'btn-secondary', 'btn-success', 'btn-danger', 'btn-warning', 'btn-info', 'btn-light', 'btn-dark', 'btn-outline-primary', 'btn-outline-secondary', 'btn-outline-success', 'btn-outline-danger', 'btn-link',
  'btn-sm', 'btn-lg', 'btn-block',
  // 圆角
  'rounded', 'rounded-0', 'rounded-1', 'rounded-2', 'rounded-3', 'rounded-circle', 'rounded-pill', 'rounded-top', 'rounded-end', 'rounded-bottom', 'rounded-start',
  // 边框
  'border', 'border-0', 'border-top', 'border-end', 'border-bottom', 'border-start',
  'border-primary', 'border-secondary', 'border-success', 'border-danger', 'border-warning', 'border-info', 'border-light', 'border-dark',
  // 阴影
  'shadow-none', 'shadow-sm', 'shadow', 'shadow-lg',
  // 宽高
  'w-25', 'w-50', 'w-75', 'w-100', 'w-auto',
  'h-25', 'h-50', 'h-75', 'h-100', 'h-auto',
  // 定位
  'position-static', 'position-relative', 'position-absolute', 'position-fixed', 'position-sticky',
  'top-0', 'top-50', 'top-100', 'bottom-0', 'bottom-50', 'bottom-100',
  'start-0', 'start-50', 'start-100', 'end-0', 'end-50', 'end-100',
  // 溢出
  'overflow-auto', 'overflow-hidden', 'overflow-visible', 'overflow-scroll',
  // 透明度
  'opacity-0', 'opacity-25', 'opacity-50', 'opacity-75', 'opacity-100',
];

/* ============================================================
 * CSS 属性元数据 — 用于 cssText 可视化编辑
 * ============================================================ */

type CssPropType = 'color' | 'number' | 'enum' | 'text';

interface CssPropMeta {
  type: CssPropType;
  /** number 类型的单位提示 */
  unit?: string;
  /** enum 类型的可选值 */
  options?: string[];
}

const CSS_PROP_METADATA: Record<string, CssPropMeta> = {
  // 颜色类
  color: { type: 'color' },
  'background-color': { type: 'color' },
  'background': { type: 'text' },
  'border-color': { type: 'color' },
  'border-top-color': { type: 'color' },
  'border-right-color': { type: 'color' },
  'border-bottom-color': { type: 'color' },
  'border-left-color': { type: 'color' },
  'box-shadow': { type: 'text' },
  'text-shadow': { type: 'text' },
  'outline-color': { type: 'color' },
  // 数值类
  'width': { type: 'number', unit: 'px' },
  'height': { type: 'number', unit: 'px' },
  'min-width': { type: 'number', unit: 'px' },
  'min-height': { type: 'number', unit: 'px' },
  'max-width': { type: 'number', unit: 'px' },
  'max-height': { type: 'number', unit: 'px' },
  'padding': { type: 'number', unit: 'px' },
  'padding-top': { type: 'number', unit: 'px' },
  'padding-right': { type: 'number', unit: 'px' },
  'padding-bottom': { type: 'number', unit: 'px' },
  'padding-left': { type: 'number', unit: 'px' },
  'margin': { type: 'number', unit: 'px' },
  'margin-top': { type: 'number', unit: 'px' },
  'margin-right': { type: 'number', unit: 'px' },
  'margin-bottom': { type: 'number', unit: 'px' },
  'margin-left': { type: 'number', unit: 'px' },
  'font-size': { type: 'number', unit: 'px' },
  'line-height': { type: 'text' },
  'letter-spacing': { type: 'number', unit: 'px' },
  'word-spacing': { type: 'number', unit: 'px' },
  'border-width': { type: 'number', unit: 'px' },
  'border-top-width': { type: 'number', unit: 'px' },
  'border-radius': { type: 'number', unit: 'px' },
  'border-top-left-radius': { type: 'number', unit: 'px' },
  'border-top-right-radius': { type: 'number', unit: 'px' },
  'border-bottom-left-radius': { type: 'number', unit: 'px' },
  'border-bottom-right-radius': { type: 'number', unit: 'px' },
  'gap': { type: 'number', unit: 'px' },
  'row-gap': { type: 'number', unit: 'px' },
  'column-gap': { type: 'number', unit: 'px' },
  'top': { type: 'number', unit: 'px' },
  'right': { type: 'number', unit: 'px' },
  'bottom': { type: 'number', unit: 'px' },
  'left': { type: 'number', unit: 'px' },
  'z-index': { type: 'number' },
  'opacity': { type: 'number' },
  'flex-grow': { type: 'number' },
  'flex-shrink': { type: 'number' },
  'order': { type: 'number' },
  // 枚举类
  'display': { type: 'enum', options: ['', 'block', 'inline', 'inline-block', 'flex', 'inline-flex', 'grid', 'inline-grid', 'none', 'table', 'table-cell', 'table-row'] },
  'position': { type: 'enum', options: ['', 'static', 'relative', 'absolute', 'fixed', 'sticky'] },
  'overflow': { type: 'enum', options: ['', 'visible', 'hidden', 'scroll', 'auto'] },
  'overflow-x': { type: 'enum', options: ['', 'visible', 'hidden', 'scroll', 'auto'] },
  'overflow-y': { type: 'enum', options: ['', 'visible', 'hidden', 'scroll', 'auto'] },
  'text-align': { type: 'enum', options: ['', 'left', 'right', 'center', 'justify', 'start', 'end'] },
  'vertical-align': { type: 'enum', options: ['', 'baseline', 'top', 'middle', 'bottom', 'text-top', 'text-bottom'] },
  'white-space': { type: 'enum', options: ['', 'normal', 'nowrap', 'pre', 'pre-wrap', 'pre-line'] },
  'text-decoration': { type: 'enum', options: ['', 'none', 'underline', 'overline', 'line-through'] },
  'text-transform': { type: 'enum', options: ['', 'none', 'capitalize', 'uppercase', 'lowercase'] },
  'font-weight': { type: 'enum', options: ['', 'normal', 'bold', 'lighter', 'bolder', '100', '200', '300', '400', '500', '600', '700', '800', '900'] },
  'font-style': { type: 'enum', options: ['', 'normal', 'italic', 'oblique'] },
  'flex-direction': { type: 'enum', options: ['', 'row', 'row-reverse', 'column', 'column-reverse'] },
  'flex-wrap': { type: 'enum', options: ['', 'nowrap', 'wrap', 'wrap-reverse'] },
  'justify-content': { type: 'enum', options: ['', 'flex-start', 'flex-end', 'center', 'space-between', 'space-around', 'space-evenly'] },
  'align-items': { type: 'enum', options: ['', 'flex-start', 'flex-end', 'center', 'baseline', 'stretch'] },
  'align-content': { type: 'enum', options: ['', 'flex-start', 'flex-end', 'center', 'space-between', 'space-around', 'stretch'] },
  'align-self': { type: 'enum', options: ['', 'auto', 'flex-start', 'flex-end', 'center', 'baseline', 'stretch'] },
  'border-style': { type: 'enum', options: ['', 'none', 'solid', 'dashed', 'dotted', 'double', 'groove', 'ridge', 'inset', 'outset'] },
  'cursor': { type: 'enum', options: ['', 'auto', 'default', 'pointer', 'text', 'wait', 'move', 'not-allowed', 'grab', 'grabbing'] },
  'pointer-events': { type: 'enum', options: ['', 'auto', 'none'] },
  'visibility': { type: 'enum', options: ['', 'visible', 'hidden', 'collapse'] },
  'background-repeat': { type: 'enum', options: ['', 'repeat', 'repeat-x', 'repeat-y', 'no-repeat', 'space', 'round'] },
  'background-size': { type: 'enum', options: ['', 'auto', 'cover', 'contain'] },
  'background-attachment': { type: 'enum', options: ['', 'scroll', 'fixed', 'local'] },
  'background-position': { type: 'enum', options: ['', 'left top', 'left center', 'left bottom', 'center top', 'center center', 'center bottom', 'right top', 'right center', 'right bottom'] },
  'float': { type: 'enum', options: ['', 'left', 'right', 'none'] },
  'clear': { type: 'enum', options: ['', 'none', 'left', 'right', 'both'] },
  'list-style-type': { type: 'enum', options: ['', 'none', 'disc', 'circle', 'square', 'decimal', 'lower-alpha', 'upper-alpha', 'lower-roman', 'upper-roman'] },
  'box-sizing': { type: 'enum', options: ['', 'content-box', 'border-box'] },
  'writing-mode': { type: 'enum', options: ['', 'horizontal-tb', 'vertical-rl', 'vertical-lr'] },
  'direction': { type: 'enum', options: ['', 'ltr', 'rtl'] },
  'resize': { type: 'enum', options: ['', 'none', 'both', 'horizontal', 'vertical'] },
  'object-fit': { type: 'enum', options: ['', 'fill', 'contain', 'cover', 'none', 'scale-down'] },
};

/** 常用 CSS 属性名列表（用于属性行添加时的下拉选择） */
const COMMON_CSS_PROPS = Object.keys(CSS_PROP_METADATA).sort();

/** 判断一个 CSS 值是否"看起来像数字"（可带单位） */
function isNumericValue(val: string): boolean {
  if (!val) return false;
  return /^-?[\d.]+(px|em|rem|%|vw|vh|pt|cm|mm|in|s|ms|deg|fr)?$/i.test(val.trim());
}

/** 从数值值中提取单位部分 */
function extractUnit(val: string): string {
  if (!val) return '';
  const m = val.trim().match(/^(?:-?[\d.]+)(px|em|rem|%|vw|vh|pt|cm|mm|in|s|ms|deg|fr)?$/i);
  return m && m[1] ? m[1] : '';
}

/* ============================================================
 * cssText 解析与序列化
 * ============================================================ */

interface CssDecl {
  property: string;
  value: string;
  /** 是否带 !important 标记（从 cssText 解析得到，序列化时重新拼接） */
  important: boolean;
}

/**
 * 解析 cssText 字符串为声明列表。
 * 支持带引号值（如 content: "..."）和函数值（如 url(...)、rgb(...)）。
 * 不处理 @规则和嵌套规则——这些不属于内联样式范畴。
 *
 * !important 处理：从 value 末尾分离 `!important` 标记，存为 important 字段。
 * 这样控件接收纯 value（如 `red`、`10px`），不会被 `!important` 污染导致无法识别。
 * 序列化时由 buildCssText 根据 important 标志重新拼接。
 */
function parseCssText(cssText: string): CssDecl[] {
  if (!cssText || !cssText.trim()) return [];
  const decls: CssDecl[] = [];
  // 按分号拆分，但尊重引号和括号
  let current = '';
  let depth = 0;
  let inQuote: string | null = null;
  for (let i = 0; i < cssText.length; i++) {
    const ch = cssText[i];
    if (inQuote) {
      current += ch;
      if (ch === inQuote && cssText[i - 1] !== '\\') inQuote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inQuote = ch;
      current += ch;
      continue;
    }
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ';' && depth === 0) {
      pushDecl(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) pushDecl(current);
  return decls;

  function pushDecl(str: string) {
    const trimmed = str.trim();
    if (!trimmed) return;
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx < 0) return;
    const property = trimmed.slice(0, colonIdx).trim().toLowerCase();
    let value = trimmed.slice(colonIdx + 1).trim();
    if (!property || !value) return;
    // 分离 !important 标记（容错：前后可能有空格）
    let important = false;
    const importantMatch = value.match(/\s*!\s*important\s*$/i);
    if (importantMatch) {
      important = true;
      value = value.slice(0, value.length - importantMatch[0].length).trim();
      if (!value) return; // 只有 !important 没有值，无效
    }
    decls.push({ property, value, important });
  }
}

/** 序列化声明列表回 cssText 字符串（根据 important 标志重新拼接 !important） */
function buildCssText(decls: CssDecl[]): string {
  return decls
    .filter(d => d.property && d.value)
    .map(d => `${d.property}: ${d.value}${d.important ? ' !important' : ''}`)
    .join('; ');
}

/* ============================================================
 * ClassNameChipList — 类名 chip 管理
 * ============================================================ */

function ClassNameChipList({
  className,
  onChange,
}: {
  className: string;
  onChange: (next: string) => void;
}) {
  const [inputValue, setInputValue] = useState('');
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [activeSuggestionIdx, setActiveSuggestionIdx] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);

  const classes = useMemo(() => {
    const arr = className.trim().split(/\s+/).filter(Boolean);
    // 去重，保留顺序
    return Array.from(new Set(arr));
  }, [className]);

  const filteredSuggestions = useMemo(() => {
    if (!inputValue.trim()) return [];
    const lower = inputValue.toLowerCase();
    // 已使用的类不再建议
    const usedSet = new Set(classes);
    return BOOTSTRAP_CLASS_SUGGESTIONS
      .filter(c => c.toLowerCase().includes(lower) && !usedSet.has(c))
      .slice(0, 8);
  }, [inputValue, classes]);

  const commitChange = useCallback((next: string[]) => {
    onChange(next.join(' '));
  }, [onChange]);

  const removeClass = (cls: string) => {
    commitChange(classes.filter(c => c !== cls));
  };

  const addClass = (cls: string) => {
    const trimmed = cls.trim();
    if (!trimmed) return;
    if (classes.includes(trimmed)) {
      setInputValue('');
      setShowSuggestions(false);
      return;
    }
    commitChange([...classes, trimmed]);
    setInputValue('');
    setShowSuggestions(false);
    setActiveSuggestionIdx(-1);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (activeSuggestionIdx >= 0 && filteredSuggestions[activeSuggestionIdx]) {
        addClass(filteredSuggestions[activeSuggestionIdx]);
      } else if (inputValue.trim()) {
        addClass(inputValue);
      }
      return;
    }
    if (e.key === 'Backspace' && !inputValue && classes.length > 0) {
      // 退格删除最后一个类
      commitChange(classes.slice(0, -1));
      return;
    }
    if (showSuggestions) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveSuggestionIdx(i => Math.min(i + 1, filteredSuggestions.length - 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveSuggestionIdx(i => Math.max(i - 1, 0));
        return;
      }
      if (e.key === 'Escape') {
        setShowSuggestions(false);
        setActiveSuggestionIdx(-1);
        return;
      }
    }
  };

  return (
    <div className="designer-adv-class-editor">
      <div className="designer-adv-class-chips">
        {classes.map(cls => (
          <span key={cls} className="designer-adv-class-chip" title={cls}>
            <span className="designer-adv-class-chip-name">{cls}</span>
            <button
              type="button"
              className="designer-adv-class-chip-remove"
              onClick={() => removeClass(cls)}
              title="移除"
            >
              <X size={10} />
            </button>
          </span>
        ))}
        <div className="designer-adv-class-input-wrap">
          <input
            ref={inputRef}
            type="text"
            className="designer-prop-input designer-adv-class-input"
            value={inputValue}
            onChange={e => {
              setInputValue(e.target.value);
              setShowSuggestions(true);
              setActiveSuggestionIdx(-1);
            }}
            onFocus={() => setShowSuggestions(true)}
            onBlur={() => {
              // 延迟关闭以允许点击建议
              setTimeout(() => {
                setShowSuggestions(false);
                setActiveSuggestionIdx(-1);
              }, 150);
            }}
            onKeyDown={handleKeyDown}
            placeholder={classes.length === 0 ? '输入类名，回车添加' : '继续添加...'}
          />
          {showSuggestions && filteredSuggestions.length > 0 && (
            <div className="designer-adv-class-suggestions">
              {filteredSuggestions.map((s, idx) => (
                <button
                  key={s}
                  type="button"
                  className={`designer-adv-class-suggestion ${idx === activeSuggestionIdx ? 'active' : ''}`}
                  onMouseDown={e => {
                    e.preventDefault();
                    addClass(s);
                  }}
                  onMouseEnter={() => setActiveSuggestionIdx(idx)}
                  title={`添加 ${s}`}
                >
                  {s}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
      {classes.length === 0 && !inputValue && (
        <div className="designer-prop-hint">元素当前没有 CSS 类名</div>
      )}
    </div>
  );
}

/* ============================================================
 * CssValueInput — 根据属性类型切换控件
 * ============================================================ */

function CssValueInput({
  property,
  value,
  onChange,
}: {
  property: string;
  value: string;
  onChange: (val: string) => void;
}) {
  const meta = CSS_PROP_METADATA[property];

  // 颜色类属性：使用 AlphaColorPicker（除非值看起来不像颜色，如 gradient 或 var()）
  if (meta?.type === 'color' && !value.includes('gradient') && !value.includes('var(') && !value.includes('url(')) {
    return (
      <AlphaColorPicker
        value={value}
        onChange={onChange}
        compact
      />
    );
  }

  // 枚举类属性：下拉选择
  if (meta?.type === 'enum' && meta.options) {
    return (
      <select
        className="designer-prop-input designer-prop-select"
        value={value}
        onChange={e => onChange(e.target.value)}
      >
        {meta.options.map(opt => (
          <option key={opt} value={opt}>{opt || '（继承）'}</option>
        ))}
      </select>
    );
  }

  // 数值类属性：数字输入 + 单位
  if (meta?.type === 'number' && (isNumericValue(value) || !value)) {
    const unit = extractUnit(value) || meta.unit || '';
    return (
      <div className="designer-adv-css-number-input">
        <input
          type="text"
          className="designer-prop-input designer-adv-css-number-field"
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder={meta.unit ? `0${meta.unit}` : '0'}
        />
        {meta.unit && <span className="designer-style-unit">{unit || meta.unit}</span>}
      </div>
    );
  }

  // 默认：文本输入
  return (
    <input
      type="text"
      className="designer-prop-input"
      value={value}
      onChange={e => onChange(e.target.value)}
      placeholder="值"
    />
  );
}

/* ============================================================
 * CssDeclsEditor — cssText 可视化声明编辑
 * ============================================================ */

function CssDeclsEditor({
  cssText,
  onChange,
}: {
  cssText: string;
  onChange: (next: string) => void;
}) {
  const [decls, setDecls] = useState<CssDecl[]>(() => parseCssText(cssText));
  const [addingProp, setAddingProp] = useState('');
  const [showAddRow, setShowAddRow] = useState(false);
  const [showPropSelect, setShowPropSelect] = useState(false);

  // 外部 cssText 变化时同步（用户从原始 textarea 编辑后回写到可视化）
  useEffect(() => {
    setDecls(parseCssText(cssText));
  }, [cssText]);

  const emit = useCallback((next: CssDecl[]) => {
    setDecls(next);
    onChange(buildCssText(next));
  }, [onChange]);

  const updateDecl = (idx: number, patch: Partial<CssDecl>) => {
    emit(decls.map((d, i) => i === idx ? { ...d, ...patch } : d));
  };

  const removeDecl = (idx: number) => {
    emit(decls.filter((_, i) => i !== idx));
  };

  const addDecl = (property: string) => {
    const trimmed = property.trim().toLowerCase();
    if (!trimmed) return;
    // 同名属性已存在则不添加
    if (decls.some(d => d.property === trimmed)) {
      setShowPropSelect(false);
      setAddingProp('');
      return;
    }
    emit([...decls, { property: trimmed, value: '', important: false }]);
    setShowPropSelect(false);
    setAddingProp('');
  };

  const toggleImportant = (idx: number) => {
    emit(decls.map((d, i) => i === idx ? { ...d, important: !d.important } : d));
  };

  const filteredProps = useMemo(() => {
    if (!addingProp.trim()) return COMMON_CSS_PROPS.slice(0, 12);
    const lower = addingProp.toLowerCase();
    return COMMON_CSS_PROPS.filter(p => p.includes(lower)).slice(0, 12);
  }, [addingProp]);

  return (
    <div className="designer-adv-css-decls">
      {decls.length === 0 && !showAddRow && (
        <div className="designer-prop-hint">元素当前没有内联样式</div>
      )}
      {decls.map((decl, idx) => (
        <div key={idx} className="designer-adv-css-row">
          <input
            type="text"
            className="designer-prop-input designer-adv-css-prop"
            value={decl.property}
            onChange={e => updateDecl(idx, { property: e.target.value.toLowerCase() })}
            list="designer-adv-css-prop-list"
            placeholder="属性名"
          />
          <div className="designer-adv-css-value-cell">
            <CssValueInput
              property={decl.property}
              value={decl.value}
              onChange={val => updateDecl(idx, { value: val })}
            />
          </div>
          <button
            type="button"
            className={`designer-adv-css-important ${decl.important ? 'active' : ''}`}
            onClick={() => toggleImportant(idx)}
            title={decl.important ? '已设 !important（覆盖 Bootstrap 工具类）— 点击移除' : '设为 !important（覆盖 Bootstrap 工具类）'}
          >
            !
          </button>
          <button
            type="button"
            className="designer-adv-css-remove"
            onClick={() => removeDecl(idx)}
            title="删除属性"
          >
            <Trash2 size={11} />
          </button>
        </div>
      ))}

      {/* 添加属性行 */}
      {showAddRow ? (
        <div className="designer-adv-css-row designer-adv-css-add-row">
          <div className="designer-adv-css-prop-add-wrap">
            <input
              type="text"
              className="designer-prop-input designer-adv-css-prop"
              value={addingProp}
              onChange={e => {
                setAddingProp(e.target.value);
                setShowPropSelect(true);
              }}
              onFocus={() => setShowPropSelect(true)}
              onBlur={() => setTimeout(() => setShowPropSelect(false), 150)}
              onKeyDown={e => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  addDecl(addingProp);
                }
                if (e.key === 'Escape') {
                  setShowAddRow(false);
                  setAddingProp('');
                  setShowPropSelect(false);
                }
              }}
              placeholder="属性名（如 color）"
              autoFocus
            />
            {showPropSelect && filteredProps.length > 0 && (
              <div className="designer-adv-css-prop-suggestions">
                {filteredProps.map(p => (
                  <button
                    key={p}
                    type="button"
                    className="designer-adv-css-prop-suggestion"
                    onMouseDown={e => {
                      e.preventDefault();
                      addDecl(p);
                    }}
                    title={`添加 ${p}`}
                  >
                    {p}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button
            type="button"
            className="designer-adv-css-cancel"
            onClick={() => { setShowAddRow(false); setAddingProp(''); }}
            title="取消"
          >
            <X size={11} />
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="designer-adv-css-add-btn"
          onClick={() => setShowAddRow(true)}
          title="添加 CSS 属性"
        >
          <Plus size={12} />
          <span>添加属性</span>
        </button>
      )}

      {/* datalist 作为属性名输入的兜底补全（不依赖弹出层） */}
      <datalist id="designer-adv-css-prop-list">
        {COMMON_CSS_PROPS.map(p => (
          <option key={p} value={p} />
        ))}
      </datalist>
    </div>
  );
}

/* ============================================================
 * AdvancedCssEditor — 主组件
 * ============================================================ */

export function AdvancedCssEditor({
  className,
  cssText,
  onClassNameChange,
  onCssTextChange,
}: {
  className: string;
  cssText: string;
  onClassNameChange: (next: string) => void;
  onCssTextChange: (next: string) => void;
}) {
  const [rawClassOpen, setRawClassOpen] = useState(false);
  const [rawCssOpen, setRawCssOpen] = useState(false);
  const [rawClassValue, setRawClassValue] = useState(className);
  const [rawCssValue, setRawCssValue] = useState(cssText);

  // 外部值变化时同步 raw 输入（仅当未在编辑时）
  const rawClassEditing = useRef(false);
  const rawCssEditing = useRef(false);
  useEffect(() => {
    if (!rawClassEditing.current) setRawClassValue(className);
  }, [className]);
  useEffect(() => {
    if (!rawCssEditing.current) setRawCssValue(cssText);
  }, [cssText]);

  return (
    <div className="designer-adv-css-editor">
      {/* CSS 类名 */}
      <div className="designer-prop-section">
        <div className="designer-adv-section-header">
          <span className="designer-prop-section-title">CSS 类名</span>
          <button
            type="button"
            className="designer-adv-raw-toggle"
            onClick={() => setRawClassOpen(o => !o)}
            title={rawClassOpen ? '收起原始编辑' : '展开原始编辑'}
          >
            {rawClassOpen ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
            <span>原始</span>
          </button>
        </div>
        <ClassNameChipList
          className={className}
          onChange={onClassNameChange}
        />
        {rawClassOpen && (
          <div className="designer-adv-raw-wrap">
            <input
              type="text"
              className="designer-prop-input"
              value={rawClassValue}
              onChange={e => setRawClassValue(e.target.value)}
              onFocus={() => { rawClassEditing.current = true; }}
              onBlur={() => {
                rawClassEditing.current = false;
                if (rawClassValue !== className) onClassNameChange(rawClassValue);
              }}
              onKeyDown={e => {
                if (e.key === 'Enter') (e.target as HTMLElement).blur();
                if (e.key === 'Escape') {
                  setRawClassValue(className);
                  (e.target as HTMLElement).blur();
                }
              }}
              placeholder="用空格分隔多个类名"
            />
          </div>
        )}
      </div>

      {/* 内联样式 cssText */}
      <div className="designer-prop-section">
        <div className="designer-adv-section-header">
          <span className="designer-prop-section-title">内联样式</span>
          <button
            type="button"
            className="designer-adv-raw-toggle"
            onClick={() => setRawCssOpen(o => !o)}
            title={rawCssOpen ? '收起原始编辑' : '展开原始编辑'}
          >
            {rawCssOpen ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
            <span>原始</span>
          </button>
        </div>
        <CssDeclsEditor
          cssText={cssText}
          onChange={onCssTextChange}
        />
        {rawCssOpen && (
          <div className="designer-adv-raw-wrap">
            <textarea
              className="designer-prop-input designer-prop-textarea designer-adv-raw-css"
              value={rawCssValue}
              onChange={e => setRawCssValue(e.target.value)}
              onFocus={() => { rawCssEditing.current = true; }}
              onBlur={() => {
                rawCssEditing.current = false;
                if (rawCssValue !== cssText) onCssTextChange(rawCssValue);
              }}
              placeholder="例如: color:red; font-size:14px;"
              rows={3}
            />
          </div>
        )}
      </div>
    </div>
  );
}
