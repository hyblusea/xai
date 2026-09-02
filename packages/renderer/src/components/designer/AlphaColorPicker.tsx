import { useState, useEffect, useCallback, useRef } from 'react';
import { parseColorAlpha, buildColorAlpha } from '../../utils/designerColorUtils';

/**
 * AlphaColorPicker — a color picker that supports opacity/alpha channel.
 * Uses the native <input type="color"> for hue/saturation/lightness and
 * a custom slider for alpha. Displays a checkerboard pattern behind the
 * color swatch to visualize transparency.
 *
 * compact mode: hides the text input, suitable for inline use (e.g. gradient stops).
 */
export function AlphaColorPicker({
  value,
  onChange,
  className,
  compact,
  showAlpha = true,
}: {
  value: string;
  onChange: (val: string) => void;
  className?: string;
  compact?: boolean;
  showAlpha?: boolean;
}) {
  const parsed = parseColorAlpha(value);
  const [hex, setHex] = useState(parsed.hex);
  const [alpha, setAlpha] = useState(parsed.alpha);
  const isEditingRef = useRef(false);
  const rafIdRef = useRef<number | null>(null);
  const pendingRef = useRef<{ hex: string; alpha: number } | null>(null);

  // Sync from external value changes (but not while user is editing)
  useEffect(() => {
    if (!isEditingRef.current) {
      const p = parseColorAlpha(value);
      setHex(p.hex);
      setAlpha(p.alpha);
    }
  }, [value]);

  // Cleanup rAF on unmount
  useEffect(() => () => {
    if (rafIdRef.current !== null) cancelAnimationFrame(rafIdRef.current);
  }, []);

  const scheduleChange = useCallback((nextHex: string, nextAlpha: number) => {
    setHex(nextHex);
    setAlpha(nextAlpha);
    pendingRef.current = { hex: nextHex, alpha: nextAlpha };
    if (rafIdRef.current === null) {
      rafIdRef.current = requestAnimationFrame(() => {
        rafIdRef.current = null;
        if (pendingRef.current) {
          onChange(buildColorAlpha(pendingRef.current.hex, pendingRef.current.alpha));
          pendingRef.current = null;
        }
      });
    }
  }, [onChange]);

  const flushPending = useCallback(() => {
    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }
    if (pendingRef.current) {
      onChange(buildColorAlpha(pendingRef.current.hex, pendingRef.current.alpha));
      pendingRef.current = null;
    }
  }, [onChange]);

  const handleColorChange = useCallback((newHex: string) => {
    scheduleChange(newHex, alpha);
  }, [alpha, scheduleChange]);

  const handleAlphaChange = useCallback((newAlpha: number) => {
    scheduleChange(hex, newAlpha);
  }, [hex, scheduleChange]);

  const handleTextChange = useCallback((text: string) => {
    const p = parseColorAlpha(text);
    setHex(p.hex);
    setAlpha(p.alpha);
  }, []);

  const handleTextBlur = useCallback(() => {
    isEditingRef.current = false;
    flushPending();
    const rebuilt = buildColorAlpha(hex, alpha);
    if (rebuilt !== value) {
      onChange(rebuilt);
    }
  }, [hex, alpha, value, onChange, flushPending]);

  // Dynamic alpha slider background: transparent → current color
  const alphaSliderBg = `linear-gradient(to right, transparent, ${hex})`;

  return (
    <div className={`designer-alpha-color-picker ${compact ? 'designer-alpha-color-picker--compact' : ''} ${className || ''}`}>
      <div className="designer-alpha-color-row">
        {/* Color swatch with checkerboard to show transparency */}
        <div className="designer-alpha-color-swatch-wrap">
          <input
            type="color"
            className="designer-alpha-color-input"
            value={hex}
            onChange={e => handleColorChange(e.target.value)}
            onBlur={flushPending}
          />
        </div>
        {/* Alpha slider with checkerboard track */}
        {showAlpha && (
          <div className="designer-alpha-slider-track">
            <div className="designer-alpha-slider-checker" />
            <div className="designer-alpha-slider-gradient" style={{ background: alphaSliderBg }} />
            <input
              type="range"
              className="designer-alpha-slider"
              min={0}
              max={1}
              step={0.01}
              value={alpha}
              onChange={e => handleAlphaChange(Number(e.target.value))}
              onMouseDown={() => { isEditingRef.current = true; }}
              onMouseUp={() => { isEditingRef.current = false; flushPending(); }}
              onTouchStart={() => { isEditingRef.current = true; }}
              onTouchEnd={() => { isEditingRef.current = false; flushPending(); }}
            />
          </div>
        )}
        {showAlpha && <span className="designer-alpha-slider-label">{Math.round(alpha * 100)}%</span>}
        {/* Text input for raw value (hidden in compact mode) */}
        {!compact && (
          <input
            type="text"
            className="designer-prop-input designer-alpha-color-text"
            value={value}
            onChange={e => handleTextChange(e.target.value)}
            onFocus={() => { isEditingRef.current = true; }}
            onBlur={handleTextBlur}
            placeholder="#000000"
          />
        )}
      </div>
    </div>
  );
}
