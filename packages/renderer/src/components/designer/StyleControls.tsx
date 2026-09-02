import { useState, useEffect, useCallback, useRef } from 'react';
import { Plus, Trash2, ChevronDown, ChevronUp, AlertTriangle } from 'lucide-react';
import { isGradientValue } from '../../utils/designerColorUtils';
import { AlphaColorPicker } from './AlphaColorPicker';

/* ============================================================
 * Shared utilities
 * ============================================================ */

/** Small labeled number input with unit suffix. */
function NumberInput({
  value,
  onChange,
  placeholder = '0',
  unit = 'px',
  min,
  max,
  step = 1,
}: {
  value: string;
  onChange: (val: string) => void;
  placeholder?: string;
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
}) {
  const [local, setLocal] = useState(value);
  useEffect(() => { setLocal(value); }, [value]);

  const commit = useCallback(() => {
    if (local !== value) onChange(local);
  }, [local, value, onChange]);

  return (
    <div className="designer-style-number-input">
      <input
        type="number"
        className="designer-prop-input designer-style-number-field"
        value={local}
        onChange={e => setLocal(e.target.value)}
        onBlur={commit}
        onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLElement).blur(); }}
        placeholder={placeholder}
        min={min}
        max={max}
        step={step}
      />
      {unit && <span className="designer-style-unit">{unit}</span>}
    </div>
  );
}

/** Collapsible section wrapper. */
function CollapsibleSection({
  label,
  children,
  defaultOpen = true,
}: {
  label: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="designer-style-section">
      <button
        type="button"
        className="designer-style-section-header"
        onClick={() => setOpen(o => !o)}
      >
        <span className="designer-style-section-label">{label}</span>
        {open ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
      </button>
      {open && <div className="designer-style-section-body">{children}</div>}
    </div>
  );
}

/* ============================================================
 * GradientPicker — visual gradient editor
 * ============================================================ */

interface GradientStop {
  color: string;
  position: number; // 0-100
}

interface GradientData {
  type: 'linear' | 'radial';
  angle: number; // 0-360
  stops: GradientStop[];
}

/** Parse a CSS gradient string into structured data. */
function parseGradient(value: string): GradientData | null {
  // Use manual parenthesis matching to support nested functions like rgb() / rgba()
  // inside gradient stops. The old regex [^)]* broke on the first ')' inside rgb().
  const startMatch = value.match(/(linear|radial)-gradient\s*\(/i);
  if (!startMatch || startMatch.index === undefined) return null;

  const type = startMatch[1].toLowerCase() as 'linear' | 'radial';
  const startIdx = startMatch.index + startMatch[0].length;
  let depth = 1;
  let endIdx = -1;
  for (let i = startIdx; i < value.length; i++) {
    if (value[i] === '(') depth++;
    if (value[i] === ')') {
      depth--;
      if (depth === 0) { endIdx = i; break; }
    }
  }
  if (endIdx === -1) return null;
  const inner = value.slice(startIdx, endIdx).trim();

  // Split by commas, but respect parentheses (for rgba)
  const parts: string[] = [];
  let commaDepth = 0;
  let current = '';
  for (const ch of inner) {
    if (ch === '(') commaDepth++;
    if (ch === ')') commaDepth--;
    if (ch === ',' && commaDepth === 0) {
      parts.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current.trim());

  let angle = 90;
  const stopParts: string[] = [];

  for (const part of parts) {
    const angleMatch = part.match(/^([\d.]+)deg$/);
    if (angleMatch) {
      angle = parseFloat(angleMatch[1]);
    } else if (part.startsWith('to ')) {
      // Convert "to right" etc. to angle
      const dirMap: Record<string, number> = {
        'to top': 0, 'to right': 90, 'to bottom': 180, 'to left': 270,
        'to top right': 45, 'to top left': 315, 'to bottom right': 135, 'to bottom left': 225,
      };
      angle = dirMap[part.toLowerCase()] ?? 90;
    } else if (part.startsWith('circle') || part.startsWith('ellipse') || part.includes('at ')) {
      // radial direction — ignore for now
    } else {
      stopParts.push(part);
    }
  }

  const stops: GradientStop[] = stopParts.map((part, idx) => {
    const tokens = part.trim().split(/\s+/);
    const lastToken = tokens[tokens.length - 1];
    const posMatch = lastToken.match(/^([\d.]+)%$/);
    if (posMatch) {
      return {
        color: tokens.slice(0, -1).join(' '),
        position: parseFloat(posMatch[1]),
      };
    }
    // No explicit position — distribute evenly
    return {
      color: part.trim(),
      position: stopParts.length === 1 ? 50 : (idx / (stopParts.length - 1)) * 100,
    };
  });

  if (stops.length === 0) {
    stops.push({ color: '#3b82f6', position: 0 }, { color: '#8b5cf6', position: 100 });
  }

  return { type, angle, stops };
}

/** Serialize GradientData back to a CSS gradient string. */
function buildGradient(data: GradientData): string {
  const stopsStr = data.stops
    .slice()
    .sort((a, b) => a.position - b.position)
    .map(s => `${s.color} ${Math.round(s.position)}%`)
    .join(', ');
  if (data.type === 'linear') {
    return `linear-gradient(${data.angle}deg, ${stopsStr})`;
  }
  return `radial-gradient(circle, ${stopsStr})`;
}

export function GradientPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (val: string) => void;
}) {
  const [data, setData] = useState<GradientData | null>(() => parseGradient(value));
  const [editingStop, setEditingStop] = useState<number | null>(null);

  useEffect(() => {
    if (isGradientValue(value)) {
      const parsed = parseGradient(value);
      if (parsed) setData(parsed);
    } else {
      setData(null);
    }
  }, [value]);

  const emitChange = useCallback((next: GradientData) => {
    setData(next);
    onChange(buildGradient(next));
  }, [onChange]);

  const handleTypeChange = (type: 'linear' | 'radial') => {
    if (!data) return;
    emitChange({ ...data, type });
  };

  const handleAngleChange = (angle: number) => {
    if (!data) return;
    emitChange({ ...data, angle });
  };

  const handleStopColor = (idx: number, color: string) => {
    if (!data) return;
    const stops = data.stops.map((s, i) => i === idx ? { ...s, color } : s);
    emitChange({ ...data, stops });
  };

  const handleStopPosition = (idx: number, position: number) => {
    if (!data) return;
    const stops = data.stops.map((s, i) => i === idx ? { ...s, position: Math.max(0, Math.min(100, position)) } : s);
    emitChange({ ...data, stops });
  };

  const addStop = () => {
    if (!data) return;
    const lastPos = data.stops[data.stops.length - 1]?.position ?? 100;
    const newPos = Math.min(100, lastPos + 25);
    emitChange({ ...data, stops: [...data.stops, { color: '#ffffff', position: newPos }] });
  };

  const removeStop = (idx: number) => {
    if (!data || data.stops.length <= 2) return;
    const stops = data.stops.filter((_, i) => i !== idx);
    emitChange({ ...data, stops });
  };

  // Initialize from a plain color
  const initFromColor = () => {
    const baseColor = value && !isGradientValue(value) ? value : '#3b82f6';
    emitChange({
      type: 'linear',
      angle: 135,
      stops: [
        { color: baseColor, position: 0 },
        { color: '#8b5cf6', position: 100 },
      ],
    });
  };

  if (!data) {
    return (
      <button type="button" className="designer-style-gradient-init-btn" onClick={initFromColor}>
        切换为渐变背景
      </button>
    );
  }

  const previewGradient = buildGradient(data);

  return (
    <div className="designer-style-gradient-picker">
      {/* Preview */}
      <div
        className="designer-style-gradient-preview"
        style={{ background: previewGradient }}
      />

      {/* Type & Angle */}
      <div className="designer-prop-row">
        <div className="designer-prop-field">
          <label className="designer-prop-label">类型</label>
          <div className="designer-prop-btn-group">
            <button
              type="button"
              className={`designer-prop-btn-icon ${data.type === 'linear' ? 'active' : ''}`}
              onClick={() => handleTypeChange('linear')}
            >线性</button>
            <button
              type="button"
              className={`designer-prop-btn-icon ${data.type === 'radial' ? 'active' : ''}`}
              onClick={() => handleTypeChange('radial')}
            >径向</button>
          </div>
        </div>
        {data.type === 'linear' && (
          <div className="designer-prop-field">
            <label className="designer-prop-label">角度</label>
            <div className="designer-prop-slider-row">
              <input
                type="range"
                className="designer-prop-slider"
                min={0}
                max={360}
                step={1}
                value={data.angle}
                onChange={e => handleAngleChange(parseInt(e.target.value))}
              />
              <span className="designer-style-angle-label">{data.angle}°</span>
            </div>
          </div>
        )}
      </div>

      {/* Color stops */}
      <div className="designer-style-stops">
        <div className="designer-style-stops-header">
          <label className="designer-prop-label">色标</label>
          <button type="button" className="designer-style-stop-add" onClick={addStop} title="添加色标">
            <Plus size={12} />
          </button>
        </div>
        {data.stops.map((stop, idx) => (
          <div key={idx} className="designer-style-stop-row">
            <AlphaColorPicker
              value={stop.color}
              onChange={c => handleStopColor(idx, c)}
              compact
            />
            <div className="designer-style-stop-row-bottom">
              <input
                type="range"
                className="designer-prop-slider designer-style-stop-slider"
                min={0}
                max={100}
                step={1}
                value={stop.position}
                onChange={e => handleStopPosition(idx, parseInt(e.target.value))}
              />
              <span className="designer-style-stop-pos">{Math.round(stop.position)}%</span>
              {data.stops.length > 2 && (
                <button
                  type="button"
                  className="designer-style-stop-remove"
                  onClick={() => removeStop(idx)}
                  title="删除色标"
                >
                  <Trash2 size={11} />
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Raw value */}
      <input
        type="text"
        className="designer-prop-input designer-style-gradient-raw"
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder="linear-gradient(...)"
      />
    </div>
  );
}

/* ============================================================
 * BorderEditor — width / style / color
 * ============================================================ */

interface BorderData {
  width: string;
  style: string;
  color: string;
}

function parseBorder(value: string): BorderData {
  const trimmed = value.trim();
  if (!trimmed || trimmed === 'none' || trimmed === 'initial') {
    return { width: '', style: 'none', color: '#000000' };
  }
  // Match: <width> <style> <color>
  // Color can be hex, rgb(), rgba(), named
  const widthMatch = trimmed.match(/^(\d+(?:\.\d+)?(?:px|em|rem|pt|vw|vh)?)/i);
  const styleMatch = trimmed.match(/\b(none|solid|dashed|dotted|double|groove|ridge|inset|outset)\b/i);
  // Color is everything that's not width or style
  let color = '#000000';
  if (widthMatch && styleMatch) {
    const colorPart = trimmed
      .replace(widthMatch[0], '')
      .replace(styleMatch[0], '')
      .trim();
    if (colorPart) color = colorPart;
  }
  return {
    width: widthMatch ? widthMatch[1] : '',
    style: styleMatch ? styleMatch[1].toLowerCase() : 'solid',
    color,
  };
}

function buildBorder(data: BorderData): string {
  if (!data.width || data.style === 'none') return 'none';
  return `${data.width} ${data.style} ${data.color}`;
}

const BORDER_STYLES = ['none', 'solid', 'dashed', 'dotted', 'double'];

export function BorderEditor({
  value,
  onChange,
}: {
  value: string;
  onChange: (val: string) => void;
}) {
  const [data, setData] = useState<BorderData>(() => parseBorder(value));
  const [open, setOpen] = useState(false);

  useEffect(() => { setData(parseBorder(value)); }, [value]);

  const emit = (next: BorderData) => {
    setData(next);
    onChange(buildBorder(next));
  };

  return (
    <div className="designer-style-border-editor">
      <button
        type="button"
        className="designer-style-summary-btn"
        onClick={() => setOpen(o => !o)}
      >
        <span className="designer-style-summary-preview" style={{
          borderTop: data.style !== 'none' && data.width ? `${data.width} ${data.style} ${data.color}` : '2px solid transparent',
        }} />
        <span className="designer-style-summary-text">{value || 'none'}</span>
        {open ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
      </button>
      {open && (
        <div className="designer-style-border-body">
          <div className="designer-prop-row">
            <div className="designer-prop-field">
              <label className="designer-prop-label">宽度</label>
              <NumberInput
                value={data.width.replace(/px$/, '')}
                onChange={v => emit({ ...data, width: v ? `${v}px` : '' })}
                placeholder="0"
              />
            </div>
            <div className="designer-prop-field">
              <label className="designer-prop-label">样式</label>
              <select
                className="designer-prop-input designer-prop-select"
                value={data.style}
                onChange={e => emit({ ...data, style: e.target.value })}
              >
                {BORDER_STYLES.map(s => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </div>
          </div>
          <div className="designer-prop-field">
            <label className="designer-prop-label">颜色</label>
            <AlphaColorPicker
              value={data.color}
              onChange={c => emit({ ...data, color: c })}
            />
          </div>
        </div>
      )}
    </div>
  );
}

/* ============================================================
 * ShadowEditor — inset / x / y / blur / spread / color
 * ============================================================ */

interface ShadowData {
  inset: boolean;
  x: string;
  y: string;
  blur: string;
  spread: string;
  color: string;
}

function parseShadow(value: string): ShadowData {
  const trimmed = value.trim();
  if (!trimmed || trimmed === 'none') {
    return { inset: false, x: '', y: '', blur: '', spread: '', color: '#000000' };
  }

  const inset = /\binset\b/i.test(trimmed);
  const withoutInset = trimmed.replace(/\binset\b/i, '').trim();

  // Extract color — could be rgba(...), rgb(...), #hex, or named
  let color = '#000000';
  let remaining = withoutInset;

  const rgbaMatch = remaining.match(/rgba?\([^)]+\)/i);
  if (rgbaMatch) {
    color = rgbaMatch[0];
    remaining = remaining.replace(rgbaMatch[0], '').trim();
  } else {
    const hexMatch = remaining.match(/#[0-9a-f]{3,8}\b/i);
    if (hexMatch) {
      color = hexMatch[0];
      remaining = remaining.replace(hexMatch[0], '').trim();
    } else {
      // Try to find a named color at the end
      const tokens = remaining.split(/\s+/);
      const lastToken = tokens[tokens.length - 1];
      if (lastToken && !/^-?[\d.]/.test(lastToken) && !lastToken.endsWith('px')) {
        color = lastToken;
        tokens.pop();
        remaining = tokens.join(' ');
      }
    }
  }

  const nums = remaining.split(/\s+/).filter(Boolean);
  return {
    inset,
    x: nums[0] || '',
    y: nums[1] || '',
    blur: nums[2] || '',
    spread: nums[3] || '',
    color,
  };
}

function buildShadow(data: ShadowData): string {
  if (!data.x && !data.y && !data.blur && !data.spread) return 'none';
  const parts = [
    data.inset ? 'inset' : '',
    data.x || '0px',
    data.y || '0px',
    data.blur || '0px',
    data.spread,
    data.color,
  ].filter(Boolean);
  return parts.join(' ');
}

/* ============================================================
 * ShadowPresets — xai design token 阴影预设快速选择
 * ============================================================ */

const SHADOW_PRESETS: { label: string; value: string; preview: string }[] = [
  { label: '无', value: 'none', preview: 'none' },
  { label: 'SM', value: 'var(--xai-shadow-sm)', preview: '0 1px 2px 0 rgba(0,0,0,0.05)' },
  { label: 'MD', value: 'var(--xai-shadow-md)', preview: '0 4px 6px -1px rgba(0,0,0,0.1), 0 2px 4px -2px rgba(0,0,0,0.1)' },
  { label: 'LG', value: 'var(--xai-shadow-lg)', preview: '0 10px 15px -3px rgba(0,0,0,0.1), 0 4px 6px -4px rgba(0,0,0,0.1)' },
  { label: 'XL', value: 'var(--xai-shadow-xl)', preview: '0 20px 25px -5px rgba(0,0,0,0.1), 0 8px 10px -6px rgba(0,0,0,0.1)' },
];

export function ShadowEditor({
  value,
  onChange,
}: {
  value: string;
  onChange: (val: string) => void;
}) {
  const [data, setData] = useState<ShadowData>(() => parseShadow(value));
  const [open, setOpen] = useState(false);

  useEffect(() => { setData(parseShadow(value)); }, [value]);

  const emit = (next: ShadowData) => {
    setData(next);
    onChange(buildShadow(next));
  };

  const numVal = (s: string) => s.replace(/px$/, '');

  const isPresetActive = (presetVal: string) => {
    if (presetVal === 'none') return !value || value === 'none';
    return value === presetVal;
  };

  return (
    <div className="designer-style-shadow-editor">
      {/* 阴影预设快速选择 */}
      <div className="designer-shadow-presets">
        {SHADOW_PRESETS.map(p => (
          <button
            key={p.value}
            type="button"
            className={`designer-shadow-preset-btn ${isPresetActive(p.value) ? 'active' : ''}`}
            onClick={() => onChange(p.value)}
            title={p.label}
          >
            <span
              className="designer-shadow-preset-preview"
              style={{ boxShadow: p.preview }}
            />
            <span className="designer-shadow-preset-label">{p.label}</span>
          </button>
        ))}
      </div>

      <button
        type="button"
        className="designer-style-summary-btn"
        onClick={() => setOpen(o => !o)}
      >
        <span className="designer-style-summary-preview" style={{
          boxShadow: value && value !== 'none' ? value : 'none',
        }} />
        <span className="designer-style-summary-text">{value || 'none'}</span>
        {open ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
      </button>
      {open && (
        <div className="designer-style-shadow-body">
          <div className="designer-prop-row">
            <div className="designer-prop-field">
              <label className="designer-prop-label">X 偏移</label>
              <NumberInput
                value={numVal(data.x)}
                onChange={v => emit({ ...data, x: v ? `${v}px` : '' })}
                placeholder="0"
              />
            </div>
            <div className="designer-prop-field">
              <label className="designer-prop-label">Y 偏移</label>
              <NumberInput
                value={numVal(data.y)}
                onChange={v => emit({ ...data, y: v ? `${v}px` : '' })}
                placeholder="0"
              />
            </div>
          </div>
          <div className="designer-prop-row">
            <div className="designer-prop-field">
              <label className="designer-prop-label">模糊</label>
              <NumberInput
                value={numVal(data.blur)}
                onChange={v => emit({ ...data, blur: v ? `${v}px` : '' })}
                placeholder="0"
                min={0}
              />
            </div>
            <div className="designer-prop-field">
              <label className="designer-prop-label">扩散</label>
              <NumberInput
                value={numVal(data.spread)}
                onChange={v => emit({ ...data, spread: v ? `${v}px` : '' })}
                placeholder="0"
              />
            </div>
          </div>
          <div className="designer-prop-field">
            <label className="designer-prop-label">颜色</label>
            <AlphaColorPicker
              value={data.color}
              onChange={c => emit({ ...data, color: c })}
            />
          </div>
          <button
            type="button"
            className={`designer-prop-btn-icon ${data.inset ? 'active' : ''}`}
            onClick={() => emit({ ...data, inset: !data.inset })}
            style={{ marginTop: 4 }}
          >
            {data.inset ? '✓ 内阴影' : '内阴影'}
          </button>
        </div>
      )}
    </div>
  );
}

/* ============================================================
 * BlurEditor — backdrop-filter blur radius (background blur)
 * ============================================================ */

export function BlurEditor({
  value,
  onChange,
  warning,
}: {
  value: string;
  onChange: (val: string) => void;
  warning?: string;
}) {
  // Extract blur radius from backdrop-filter string
  const blurMatch = value.match(/blur\(([\d.]+)(px|em|rem)?\)/i);
  const blurRadius = blurMatch ? blurMatch[1] : '';
  const blurUnit = blurMatch ? (blurMatch[2] || 'px') : 'px';

  // Other backdrop-filters (preserve them).
  // Drop 'none' — it's the initial computed value for elements without
  // backdrop-filter, and "none blur(10px)" is invalid CSS that browsers
  // silently ignore, making the blur slider appear to do nothing.
  const otherFilters = value.replace(/blur\([^)]*\)/gi, '').replace(/\bnone\b/gi, '').trim();

  const handleChange = (radius: string) => {
    if (!radius) {
      onChange(otherFilters || '');
      return;
    }
    const blurPart = `blur(${radius}${blurUnit})`;
    onChange(otherFilters ? `${otherFilters} ${blurPart}` : blurPart);
  };

  return (
    <div className="designer-style-blur-editor">
      <div className="designer-prop-slider-row">
        <input
          type="range"
          className="designer-prop-slider"
          min={0}
          max={30}
          step={0.5}
          value={parseFloat(blurRadius) || 0}
          onChange={e => handleChange(e.target.value)}
        />
        <NumberInput
          value={blurRadius}
          onChange={handleChange}
          placeholder="0"
          min={0}
          step={0.5}
        />
      </div>
      {warning && (
        <div className="designer-prop-warning" title={warning}>
          <AlertTriangle size={11} />
          <span>{warning}，可能阻止模糊生效</span>
        </div>
      )}
    </div>
  );
}

/* ============================================================
 * ColorField — unified color/gradient field
 * ============================================================ */

/** Color field that switches between plain color picker and gradient picker. */
export function ColorField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (val: string) => void;
}) {
  const [showGradient, setShowGradient] = useState(isGradientValue(value));

  useEffect(() => {
    setShowGradient(isGradientValue(value));
  }, [value]);

  return (
    <div className="designer-prop-field">
      <div className="designer-style-color-header">
        <label className="designer-prop-label">{label}</label>
        <button
          type="button"
          className={`designer-style-toggle-btn ${showGradient ? 'active' : ''}`}
          onClick={() => {
            if (showGradient) {
              // Switch to plain color
              setShowGradient(false);
              if (isGradientValue(value)) onChange('#3b82f6');
            } else {
              // Switch to gradient
              setShowGradient(true);
            }
          }}
          title={showGradient ? '切换为纯色' : '切换为渐变'}
        >
          渐变
        </button>
      </div>
      {showGradient || isGradientValue(value) ? (
        <GradientPicker value={value} onChange={onChange} />
      ) : (
        <AlphaColorPicker
          value={value}
          onChange={onChange}
        />
      )}
    </div>
  );
}
