/**
 * Shared property controls used by the ElementPropertiesPanel and its
 * sub-editors. Extracted from the original 2232-line ElementPropertiesPanel.tsx
 * to enable independent reuse and testing.
 *
 * All controls are presentational — they own local edit state but delegate
 * commit to the parent via onChange callbacks. This keeps the source of truth
 * in the panel's element style object.
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import { isGradientValue } from '../../../utils/designerColorUtils';
import { AlphaColorPicker } from '../AlphaColorPicker';

/** A single editable field in the properties panel. */
export function PropertyField({
  label,
  value,
  onChange,
  placeholder,
  type = 'text',
}: {
  label: string;
  value: string;
  onChange: (val: string) => void;
  placeholder?: string;
  type?: 'text' | 'color' | 'textarea';
}) {
  const [localValue, setLocalValue] = useState(value);
  const isEditingRef = useRef(false);
  // 颜色拾取拖动节流：rAF 合并连续帧
  const rafIdRef = useRef<number | null>(null);
  const pendingValueRef = useRef<string>('');

  useEffect(() => {
    if (!isEditingRef.current) setLocalValue(value);
  }, [value]);

  useEffect(() => () => {
    if (rafIdRef.current !== null) cancelAnimationFrame(rafIdRef.current);
  }, []);

  const flushPending = useCallback(() => {
    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }
    if (pendingValueRef.current) {
      const pv = pendingValueRef.current;
      pendingValueRef.current = '';
      onChange(pv);
    }
  }, [onChange]);

  const scheduleChange = useCallback((v: string) => {
    pendingValueRef.current = v;
    if (rafIdRef.current === null) {
      rafIdRef.current = requestAnimationFrame(() => {
        rafIdRef.current = null;
        if (pendingValueRef.current) {
          const pv = pendingValueRef.current;
          pendingValueRef.current = '';
          onChange(pv);
        }
      });
    }
  }, [onChange]);

  const handleBlur = useCallback(() => {
    isEditingRef.current = false;
    flushPending();
    if (localValue !== value) {
      onChange(localValue);
    }
  }, [localValue, value, onChange, flushPending]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && type !== 'textarea') {
      e.preventDefault();
      (e.target as HTMLElement).blur();
    }
    if (e.key === 'Escape') {
      setLocalValue(value);
      (e.target as HTMLElement).blur();
    }
  }, [type, value]);

  const markEditing = useCallback(() => { isEditingRef.current = true; }, []);

  return (
    <div className="designer-prop-field">
      <label className="designer-prop-label">{label}</label>
      {type === 'textarea' ? (
        <textarea
          className="designer-prop-input designer-prop-textarea"
          value={localValue}
          onChange={e => setLocalValue(e.target.value)}
          onFocus={markEditing}
          onBlur={handleBlur}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          rows={3}
        />
      ) : type === 'color' ? (
        isGradientValue(localValue) ? (
          <input
            type="text"
            className="designer-prop-input"
            value={localValue}
            onChange={e => setLocalValue(e.target.value)}
            onFocus={markEditing}
            onBlur={handleBlur}
            onKeyDown={handleKeyDown}
            placeholder="#000000"
          />
        ) : (
        <AlphaColorPicker
          value={localValue}
          onChange={scheduleChange}
        />
        )
      ) : (
        <input
          type="text"
          className="designer-prop-input"
          value={localValue}
          onChange={e => setLocalValue(e.target.value)}
          onFocus={markEditing}
          onBlur={handleBlur}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
        />
      )}
    </div>
  );
}

/** Button group for selecting from discrete options (e.g. alignment). */
export function PropertyButtonGroup({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: { value: string; icon: React.ReactNode; title: string }[];
  onChange: (val: string) => void;
}) {
  return (
    <div className="designer-prop-field">
      <label className="designer-prop-label">{label}</label>
      <div className="designer-prop-btn-group">
        {options.map(opt => (
          <button
            key={opt.value}
            className={`designer-prop-btn-icon ${value === opt.value ? 'active' : ''}`}
            onClick={() => onChange(opt.value)}
            title={opt.title}
            type="button"
          >
            {opt.icon}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Slider + number input combo for range values like opacity. */
export function PropertySlider({
  label,
  value,
  onChange,
  min = 0,
  max = 1,
  step = 0.1,
  unit = '',
}: {
  label: string;
  value: string;
  onChange: (val: string) => void;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
}) {
  const numValue = parseFloat(value) || 0;
  return (
    <div className="designer-prop-field">
      <label className="designer-prop-label">{label}</label>
      <div className="designer-prop-slider-row">
        <input
          type="range"
          className="designer-prop-slider"
          min={min}
          max={max}
          step={step}
          value={numValue}
          onChange={e => onChange(e.target.value)}
        />
        <input
          type="text"
          className="designer-prop-input designer-prop-slider-text"
          value={value}
          onChange={e => onChange(e.target.value)}
          onBlur={() => {
            const v = parseFloat(value);
            if (isNaN(v)) onChange('');
          }}
          placeholder="1"
        />
      </div>
    </div>
  );
}

/** Select dropdown for discrete string values. */
export function PropertySelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (val: string) => void;
}) {
  return (
    <div className="designer-prop-field">
      <label className="designer-prop-label">{label}</label>
      <div className="designer-prop-select-wrap">
        <select
          className="designer-prop-input designer-prop-select"
          value={value}
          onChange={e => onChange(e.target.value)}
        >
          {options.map(o => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </div>
    </div>
  );
}

/** Inline text input with local state synced from props, committed on blur. */
export function InlineTextEdit({
  value,
  onCommit,
  placeholder,
}: {
  value: string;
  onCommit: (v: string) => void;
  placeholder?: string;
}) {
  const [local, setLocal] = useState(value);
  const isEditingRef = useRef(false);

  useEffect(() => {
    if (!isEditingRef.current) setLocal(value);
  }, [value]);

  return (
    <input
      type="text"
      className="designer-prop-input"
      value={local}
      onChange={e => setLocal(e.target.value)}
      onFocus={() => { isEditingRef.current = true; }}
      onBlur={() => { isEditingRef.current = false; onCommit(local); }}
      onKeyDown={e => {
        if (e.key === 'Enter') {
          e.preventDefault();
          (e.target as HTMLElement).blur();
        }
        if (e.key === 'Escape') {
          setLocal(value);
          (e.target as HTMLElement).blur();
        }
      }}
      placeholder={placeholder}
    />
  );
}
