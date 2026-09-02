import { useState, useMemo, useCallback } from 'react';
import { X, Check, RefreshCw, RotateCcw } from 'lucide-react';
import type { ThemePromptData } from '@xai/shared';
import {
  normalizeThemePromptData,
  DEFAULT_BOOTSTRAP_COLORS,
  DEFAULT_BORDER_RADIUS,
  DEFAULT_SPACING,
  DEFAULT_FONT_FAMILY,
  DEFAULT_BOX_SHADOW,
  STYLE_PRESETS,
} from '@xai/shared';
import { AlphaColorPicker } from './AlphaColorPicker';

interface SystemDesignDialogProps {
  projectName: string;
  themePrompt?: string;
  onSave: (themePrompt: string) => Promise<boolean>;
  onClose: () => void;
}

/** Color token groups for organized display. */
const COLOR_GROUPS: { title: string; tokens: [string, string][] }[] = [
  {
    title: '主色 Primary',
    tokens: [
      ['primary', '主色'],
      ['on-primary', '主色上的文字'],
      ['primary-container', '主色容器'],
      ['on-primary-container', '主色容器上的文字'],
    ],
  },
  {
    title: '次色 Secondary',
    tokens: [
      ['secondary', '次色'],
      ['on-secondary', '次色上的文字'],
      ['secondary-container', '次色容器'],
      ['on-secondary-container', '次色容器上的文字'],
    ],
  },
  {
    title: '强调色 Tertiary',
    tokens: [
      ['tertiary', '强调色'],
      ['on-tertiary', '强调色上的文字'],
      ['tertiary-container', '强调色容器'],
      ['on-tertiary-container', '强调色容器上的文字'],
    ],
  },
  {
    title: '背景与表面 Background / Surface',
    tokens: [
      ['background', '页面背景'],
      ['on-background', '背景上的文字'],
      ['surface', '表面'],
      ['on-surface', '表面上的文字'],
      ['surface-variant', '表面(变体)'],
      ['on-surface-variant', '表面(变体)上的文字'],
      ['surface-container', '表面容器'],
      ['surface-container-high', '表面容器(高)'],
      ['surface-container-low', '表面容器(低)'],
      ['surface-container-lowest', '表面容器(最低)'],
      ['surface-container-highest', '表面容器(最高)'],
    ],
  },
  {
    title: '状态色 Status',
    tokens: [
      ['error', '错误'],
      ['on-error', '错误上的文字'],
      ['error-container', '错误容器'],
      ['on-error-container', '错误容器上的文字'],
      ['success', '成功'],
      ['on-success', '成功上的文字'],
      ['warning', '警告'],
      ['on-warning', '警告上的文字'],
    ],
  },
  {
    title: '描边 Outline',
    tokens: [
      ['outline', '描边'],
      ['outline-variant', '描边(变体)'],
    ],
  },
];

const BORDER_RADIUS_LABELS: [string, string][] = [
  ['sm', '小'],
  ['md', '中'],
  ['lg', '大'],
  ['xl', '加大'],
  ['2xl', '超大'],
  ['full', '圆形'],
];

const SPACING_LABELS: [string, string][] = [
  ['xs', '极小 4px'],
  ['sm', '小 8px'],
  ['md', '中 16px'],
  ['lg', '大 24px'],
  ['xl', '超大 32px'],
  ['element-gap', '元素间距 12px'],
  ['page-margin', '页面边距 24px'],
  ['section-gap', '区块间距 48px'],
];

const SHADOW_LABELS: [string, string][] = [
  ['sm', '轻微'],
  ['DEFAULT', '默认'],
  ['md', '中等'],
  ['lg', '较大'],
  ['xl', '最大'],
];

interface ShadowParts {
  inset: boolean;
  offsetX: number;
  offsetY: number;
  blur: number;
  spread: number;
  color: string;
  alpha: number;
}

/** Parse a CSS box-shadow value into structured parts. */
function parseShadow(value: string): ShadowParts {
  const result: ShadowParts = { inset: false, offsetX: 0, offsetY: 2, blur: 4, spread: 0, color: '#000000', alpha: 0.15 };
  if (!value || value === 'none') return result;

  // Extract color FIRST (rgba/hsla/hex), because rgba()/hsla() contain commas
  // which would break the multi-shadow split below.
  let working = value.trim();
  let colorStr = '';
  const colorMatch = working.match(/(rgba?\([^)]+\)|hsla?\([^)]+\)|#[0-9a-fA-F]{3,8})/);
  if (colorMatch) {
    colorStr = colorMatch[0];
    // Use a placeholder that won't contain commas, so split(',') is safe.
    working = working.replace(colorStr, '\uE000'); // Private Use Area char
  }

  // Now split on commas to get the first shadow only, then restore the color.
  const first = working.split(',')[0].trim().replace('\uE000', colorStr);

  let rest = first;
  if (rest.startsWith('inset')) {
    result.inset = true;
    rest = rest.slice(5).trim();
  }

  // Isolate numeric parts by removing the color token.
  const numericPart = colorStr ? rest.replace(colorStr, '').trim() : rest;
  const nums = numericPart.match(/-?[\d.]+/g)?.map(Number).filter(n => !isNaN(n)) || [];
  if (nums.length >= 1) result.offsetX = nums[0];
  if (nums.length >= 2) result.offsetY = nums[1];
  if (nums.length >= 3) result.blur = nums[2];
  if (nums.length >= 4) result.spread = nums[3];

  // Parse color into hex + alpha
  if (colorStr.startsWith('#')) {
    result.color = colorStr.slice(0, 7);
    if (colorStr.length === 9) {
      const a = parseInt(colorStr.slice(7, 9), 16);
      result.alpha = Math.round((a / 255) * 100) / 100;
    }
  } else if (colorStr.startsWith('rgb')) {
    const parts = colorStr.match(/[\d.]+/g)?.map(Number) || [0, 0, 0, 1];
    result.color = `#${parts[0].toString(16).padStart(2, '0')}${parts[1].toString(16).padStart(2, '0')}${parts[2].toString(16).padStart(2, '0')}`;
    if (parts.length >= 4) result.alpha = parts[3];
  } else if (colorStr.startsWith('hsl')) {
    const parts = colorStr.match(/[\d.]+/g)?.map(Number) || [0, 0, 0, 1];
    const [h, s, l] = parts;
    const a = parts.length >= 4 ? parts[3] : 1;
    // hsl → rgb
    const hue = h / 360, sat = s / 100, light = l / 100;
    let r: number, g: number, b: number;
    if (sat === 0) {
      r = g = b = light;
    } else {
      const hue2rgb = (p: number, q: number, t: number) => {
        if (t < 0) t += 1;
        if (t > 1) t -= 1;
        if (t < 1 / 6) return p + (q - p) * 6 * t;
        if (t < 1 / 2) return q;
        if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
        return p;
      };
      const q = light < 0.5 ? light * (1 + sat) : light + sat - light * sat;
      const p = 2 * light - q;
      r = hue2rgb(p, q, hue + 1 / 3);
      g = hue2rgb(p, q, hue);
      b = hue2rgb(p, q, hue - 1 / 3);
    }
    result.color = `#${Math.round(r * 255).toString(16).padStart(2, '0')}${Math.round(g * 255).toString(16).padStart(2, '0')}${Math.round(b * 255).toString(16).padStart(2, '0')}`;
    result.alpha = a;
  }

  return result;
}

/** Build a CSS box-shadow string from structured parts. */
function buildShadow(p: ShadowParts): string {
  const hex = p.color;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const colorStr = `rgba(${r},${g},${b},${p.alpha})`;
  const inset = p.inset ? 'inset ' : '';
  return `${inset}${p.offsetX}px ${p.offsetY}px ${p.blur}px ${p.spread}px ${colorStr}`;
}

/** Shadow editor for a single shadow level with sliders and color picker. */
function ShadowLevelEditor({ label, tokenKey, value, onChange }: {
  label: string;
  tokenKey: string;
  value: string;
  onChange: (val: string) => void;
}) {
  const parts = useMemo(() => parseShadow(value), [value]);

  const update = useCallback((patch: Partial<ShadowParts>) => {
    const next = { ...parts, ...patch };
    onChange(buildShadow(next));
  }, [parts, onChange]);

  return (
    <div className="designer-sysdesign-shadow-editor">
      <div className="designer-sysdesign-shadow-editor-head">
        <span className="designer-sysdesign-shadow-editor-title">{label}</span>
        <label className="designer-sysdesign-shadow-inset-toggle">
          <input type="checkbox" checked={parts.inset}
            onChange={e => update({ inset: e.target.checked })} />
          内阴影 (inset)
        </label>
        <span className="designer-sysdesign-shadow-editor-token">{tokenKey === 'DEFAULT' ? '默认' : tokenKey}</span>
      </div>
      <div className="designer-sysdesign-shadow-editor-body">
        <div className="designer-sysdesign-shadow-row">
          <div className="designer-sysdesign-shadow-field">
            <label>X 偏移</label>
            <div className="designer-prop-slider-row">
              <input type="range" className="designer-prop-slider" min={-50} max={50} step={1}
                value={parts.offsetX} onChange={e => update({ offsetX: Number(e.target.value) })} />
              <span className="designer-sysdesign-shadow-val">{parts.offsetX}px</span>
            </div>
          </div>
          <div className="designer-sysdesign-shadow-field">
            <label>Y 偏移</label>
            <div className="designer-prop-slider-row">
              <input type="range" className="designer-prop-slider" min={-50} max={50} step={1}
                value={parts.offsetY} onChange={e => update({ offsetY: Number(e.target.value) })} />
              <span className="designer-sysdesign-shadow-val">{parts.offsetY}px</span>
            </div>
          </div>
        </div>
        <div className="designer-sysdesign-shadow-row">
          <div className="designer-sysdesign-shadow-field">
            <label>模糊</label>
            <div className="designer-prop-slider-row">
              <input type="range" className="designer-prop-slider" min={0} max={100} step={1}
                value={parts.blur} onChange={e => update({ blur: Number(e.target.value) })} />
              <span className="designer-sysdesign-shadow-val">{parts.blur}px</span>
            </div>
          </div>
          <div className="designer-sysdesign-shadow-field">
            <label>扩展</label>
            <div className="designer-prop-slider-row">
              <input type="range" className="designer-prop-slider" min={-50} max={50} step={1}
                value={parts.spread} onChange={e => update({ spread: Number(e.target.value) })} />
              <span className="designer-sysdesign-shadow-val">{parts.spread}px</span>
            </div>
          </div>
        </div>
        <div className="designer-sysdesign-shadow-row">
          <div className="designer-sysdesign-shadow-field">
            <label>颜色</label>
            <AlphaColorPicker
              value={parts.color}
              onChange={c => update({ color: c })}
              showAlpha={false}
            />
          </div>
          <div className="designer-sysdesign-shadow-field">
            <label>不透明度</label>
            <div className="designer-prop-slider-row">
              <input type="range" className="designer-prop-slider" min={0} max={1} step={0.01}
                value={parts.alpha} onChange={e => update({ alpha: Number(e.target.value) })} />
              <span className="designer-sysdesign-shadow-val">{Math.round(parts.alpha * 100)}%</span>
            </div>
          </div>
        </div>
      </div>
      <div className="designer-sysdesign-shadow-preview-bar">
        <div
          className="designer-sysdesign-shadow-preview-box"
          style={{ boxShadow: buildShadow(parts) || 'none' }}
        />
        <code className="designer-sysdesign-shadow-code">{buildShadow(parts)}</code>
      </div>
    </div>
  );
}

export default function SystemDesignDialog({ projectName, themePrompt, onSave, onClose }: SystemDesignDialogProps) {
  const initial = useMemo<ThemePromptData>(() => normalizeThemePromptData(themePrompt), [themePrompt]);
  const [data, setData] = useState<ThemePromptData>(() => JSON.parse(JSON.stringify(initial)));
  const [saving, setSaving] = useState(false);
  const [activeTab, setActiveTab] = useState<'colors' | 'style' | 'spacing' | 'radius' | 'font' | 'shadow'>('colors');

  // Detect which style preset is currently active (by matching prompt text)
  const activeStyleId = useMemo(() => {
    const sp = data.stylePrompt;
    if (!sp) return 'default';
    const match = STYLE_PRESETS.find(s => s.id !== 'default' && s.prompt === sp);
    return match?.id ?? 'custom';
  }, [data.stylePrompt]);

  const updateColor = useCallback((key: string, value: string) => {
    setData(prev => ({ ...prev, colors: { ...(prev.colors || {}), [key]: value } }));
  }, []);

  const updateToken = useCallback((group: 'borderRadius' | 'spacing' | 'boxShadow', key: string, value: string) => {
    setData(prev => ({ ...prev, [group]: { ...(prev[group] || {}), [key]: value } }));
  }, []);

  const updateFontFamily = useCallback((value: string) => {
    setData(prev => ({
      ...prev,
      fontFamily: { sans: value.split(',').map(s => s.trim()).filter(Boolean) },
    }));
  }, []);

  const resetGroup = useCallback((group: 'colors' | 'borderRadius' | 'spacing' | 'fontFamily' | 'boxShadow') => {
    setData(prev => {
      const defaults: Record<string, unknown> = {
        colors: { ...DEFAULT_BOOTSTRAP_COLORS },
        borderRadius: { ...DEFAULT_BORDER_RADIUS },
        spacing: { ...DEFAULT_SPACING },
        fontFamily: JSON.parse(JSON.stringify(DEFAULT_FONT_FAMILY)),
        boxShadow: { ...DEFAULT_BOX_SHADOW },
      };
      return { ...prev, [group]: defaults[group] };
    });
  }, []);

  const selectStylePreset = useCallback((styleId: string) => {
    setData(prev => {
      if (styleId === 'default') {
        // Remove stylePrompt
        const next = { ...prev };
        delete next.stylePrompt;
        return next;
      }
      const preset = STYLE_PRESETS.find(s => s.id === styleId);
      if (preset) {
        return { ...prev, stylePrompt: preset.prompt };
      }
      return prev;
    });
  }, []);

  const updateStylePrompt = useCallback((value: string) => {
    setData(prev => {
      if (!value.trim()) {
        const next = { ...prev };
        delete next.stylePrompt;
        return next;
      }
      return { ...prev, stylePrompt: value };
    });
  }, []);

  const handleSave = useCallback(async () => {
    setSaving(true);
    // Drop undefined stylePrompt to keep JSON clean
    const clean: ThemePromptData = { ...data };
    if (!clean.stylePrompt) delete clean.stylePrompt;
    const json = JSON.stringify(clean);
    await onSave(json);
    setSaving(false);
  }, [data, onSave]);

  const fontFamilyStr = useMemo(() => (data.fontFamily?.sans || []).join(', '), [data.fontFamily]);

  const tabs: { id: typeof activeTab; label: string }[] = [
    { id: 'colors', label: '颜色' },
    { id: 'style', label: '风格' },
    { id: 'spacing', label: '间距' },
    { id: 'radius', label: '圆角' },
    { id: 'font', label: '字体' },
    { id: 'shadow', label: '阴影' },
  ];

  return (
    <div className="designer-dialog-overlay">
      <div className="designer-dialog designer-sysdesign-dialog" onClick={e => e.stopPropagation()}>
        <div className="designer-dialog-header">
          <span className="designer-dialog-title">系统设计 · {projectName}</span>
          <button className="designer-dialog-close" onClick={onClose}>
            <X size={14} />
          </button>
        </div>

        <div className="designer-sysdesign-tabs">
          {tabs.map(t => (
            <button
              key={t.id}
              className={`designer-sysdesign-tab ${activeTab === t.id ? 'active' : ''}`}
              onClick={() => setActiveTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="designer-dialog-body designer-sysdesign-body">
          {activeTab === 'colors' && (
            <div className="designer-sysdesign-section">
              <div className="designer-sysdesign-section-head">
                <span className="designer-sysdesign-section-title">颜色配置</span>
                <button className="designer-sysdesign-reset" onClick={() => resetGroup('colors')}>
                  <RotateCcw size={11} /> 重置颜色
                </button>
              </div>
              {COLOR_GROUPS.map(group => (
                <div key={group.title} className="designer-sysdesign-group">
                  <div className="designer-sysdesign-group-title">{group.title}</div>
                  <div className="designer-sysdesign-grid">
                    {group.tokens.map(([key, label]) => {
                      const value = data.colors?.[key] || DEFAULT_BOOTSTRAP_COLORS[key] || '#000000';
                      return (
                        <div key={key} className="designer-sysdesign-field">
                          <label className="designer-prop-label">{label}</label>
                          <AlphaColorPicker
                            value={value}
                            onChange={c => updateColor(key, c)}
                          />
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}

          {activeTab === 'style' && (
            <div className="designer-sysdesign-section">
              <div className="designer-sysdesign-section-head">
                <span className="designer-sysdesign-section-title">系统风格</span>
              </div>
              <div className="designer-sysdesign-style-grid">
                {STYLE_PRESETS.map(preset => (
                  <button
                    key={preset.id}
                    className={`designer-sysdesign-style-card ${activeStyleId === preset.id ? 'active' : ''}`}
                    onClick={() => selectStylePreset(preset.id)}
                  >
                    <div className="designer-sysdesign-style-name">{preset.name}</div>
                    <div className="designer-sysdesign-style-desc">{preset.description}</div>
                  </button>
                ))}
              </div>
              <div className="designer-sysdesign-field" style={{ marginTop: 14 }}>
                <label className="designer-prop-label">自定义提示词 {activeStyleId === 'custom' && '(当前)'}</label>
                <textarea
                  className="designer-prop-input designer-prop-textarea"
                  value={data.stylePrompt ?? ''}
                  onChange={e => updateStylePrompt(e.target.value)}
                  rows={6}
                  placeholder="输入自定义风格提示词，AI 将根据此提示词生成对应的视觉风格。选择预设风格后也可在此微调。"
                />
                <div className="designer-sysdesign-hint">
                  提示词会随项目数据存入数据库，AI 生成页面时自动读取。可直接输入中文或英文风格描述。
                </div>
              </div>
            </div>
          )}

          {activeTab === 'spacing' && (
            <div className="designer-sysdesign-section">
              <div className="designer-sysdesign-section-head">
                <span className="designer-sysdesign-section-title">间距 / 尺寸</span>
                <button className="designer-sysdesign-reset" onClick={() => resetGroup('spacing')}>
                  <RotateCcw size={11} /> 重置间距
                </button>
              </div>
              <div className="designer-sysdesign-grid">
                {SPACING_LABELS.map(([key, label]) => (
                  <div key={key} className="designer-sysdesign-field">
                    <label className="designer-prop-label">{label}</label>
                    <input
                      type="text"
                      className="designer-prop-input"
                      value={data.spacing?.[key] ?? DEFAULT_SPACING[key] ?? ''}
                      onChange={e => updateToken('spacing', key, e.target.value)}
                      placeholder="如 16px 或 1rem"
                    />
                  </div>
                ))}
              </div>
            </div>
          )}

          {activeTab === 'radius' && (
            <div className="designer-sysdesign-section">
              <div className="designer-sysdesign-section-head">
                <span className="designer-sysdesign-section-title">圆角</span>
                <button className="designer-sysdesign-reset" onClick={() => resetGroup('borderRadius')}>
                  <RotateCcw size={11} /> 重置圆角
                </button>
              </div>
              <div className="designer-sysdesign-grid">
                {BORDER_RADIUS_LABELS.map(([key, label]) => (
                  <div key={key} className="designer-sysdesign-field">
                    <label className="designer-prop-label">{label} ({key})</label>
                    <input
                      type="text"
                      className="designer-prop-input"
                      value={data.borderRadius?.[key] ?? DEFAULT_BORDER_RADIUS[key] ?? ''}
                      onChange={e => updateToken('borderRadius', key, e.target.value)}
                      placeholder="如 0.5rem"
                    />
                  </div>
                ))}
              </div>
            </div>
          )}

          {activeTab === 'font' && (
            <div className="designer-sysdesign-section">
              <div className="designer-sysdesign-section-head">
                <span className="designer-sysdesign-section-title">字体</span>
                <button className="designer-sysdesign-reset" onClick={() => resetGroup('fontFamily')}>
                  <RotateCcw size={11} /> 重置字体
                </button>
              </div>
              <div className="designer-sysdesign-field">
                <label className="designer-prop-label">无衬线字体 (font-sans) — 多个字体用英文逗号分隔</label>
                <textarea
                  className="designer-prop-input designer-prop-textarea"
                  value={fontFamilyStr}
                  onChange={e => updateFontFamily(e.target.value)}
                  rows={3}
                  placeholder="system-ui, -apple-system, sans-serif"
                />
                <div className="designer-sysdesign-hint">
                  示例: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif
                </div>
              </div>
            </div>
          )}

          {activeTab === 'shadow' && (
            <div className="designer-sysdesign-section">
              <div className="designer-sysdesign-section-head">
                <span className="designer-sysdesign-section-title">阴影</span>
                <button className="designer-sysdesign-reset" onClick={() => resetGroup('boxShadow')}>
                  <RotateCcw size={11} /> 重置阴影
                </button>
              </div>
              <div className="designer-sysdesign-shadow-list">
                {SHADOW_LABELS.map(([key, label]) => (
                  <ShadowLevelEditor
                    key={key}
                    label={label}
                    tokenKey={key}
                    value={data.boxShadow?.[key] ?? DEFAULT_BOX_SHADOW[key] ?? ''}
                    onChange={val => updateToken('boxShadow', key, val)}
                  />
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="designer-dialog-footer">
          <button className="designer-dialog-btn cancel" onClick={onClose}>取消</button>
          <button
            className="designer-dialog-btn primary"
            onClick={handleSave}
            disabled={saving}
          >
            {saving ? <RefreshCw size={12} className="spin" /> : <Check size={12} />}
            {saving ? '保存中...' : '保存'}
          </button>
        </div>
      </div>
    </div>
  );
}
