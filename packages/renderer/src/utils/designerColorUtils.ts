/**
 * Shared color/gradient utilities used by the designer properties panel.
 * Extracted from ElementPropertiesPanel.tsx and StyleControls.tsx to avoid
 * the previous duplicate implementations.
 */

/** Check if a CSS value is a gradient (e.g. linear-gradient(...), radial-gradient(...)). */
export function isGradientValue(value: string): boolean {
  return /gradient\s*\(/i.test(value);
}

/**
 * Convert any CSS color string to a hex string suitable for the native
 * `<input type="color">` control. Returns `#000000` for non-parseable
 * values (including `transparent` / `currentColor` / `inherit`) because the
 * native picker cannot represent them.
 */
export function colorToHex(color: string): string {
  if (!color) return '#000000';
  const trimmed = color.trim().toLowerCase();
  // `transparent` / `currentColor` / `inherit` / `initial` are not representable
  // by a single RGB hex — fall back to black so the picker doesn't break.
  if (['transparent', 'currentcolor', 'inherit', 'initial', 'unset'].includes(trimmed)) {
    return '#000000';
  }
  if (/^#[0-9a-f]{6}$/i.test(trimmed)) return trimmed;
  if (/^#[0-9a-f]{3}$/i.test(trimmed)) {
    return '#' + trimmed[1] + trimmed[1] + trimmed[2] + trimmed[2] + trimmed[3] + trimmed[3];
  }
  // Use the canvas trick to resolve named/rgb() colors to hex.
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const ctx = canvas.getContext('2d');
    if (!ctx) return '#000000';
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = trimmed;
    const drawn = ctx.fillStyle;
    // If fillStyle stayed black but the input wasn't black, parsing failed.
    if (drawn === '#000000' && trimmed !== '#000000' && trimmed !== 'black') {
      return '#000000';
    }
    return drawn;
  } catch {
    return '#000000';
  }
}

/** Parsed RGBA components from any CSS color string. */
export interface ColorAlpha {
  hex: string;   // #rrggbb
  alpha: number; // 0–1
}

/**
 * Parse any CSS color string into { hex, alpha }.
 * Handles: #rrggbb, #rrggbbaa, #rgb, rgba(), rgb(), named colors.
 */
export function parseColorAlpha(color: string): ColorAlpha {
  if (!color) return { hex: '#000000', alpha: 1 };
  const trimmed = color.trim();

  // #rrggbbaa (8-digit hex)
  const hex8 = trimmed.match(/^#([0-9a-f]{6})([0-9a-f]{2})$/i);
  if (hex8) {
    return { hex: '#' + hex8[1].toLowerCase(), alpha: Math.round((parseInt(hex8[2], 16) / 255) * 100) / 100 };
  }

  // #rrggbb
  if (/^#[0-9a-f]{6}$/i.test(trimmed)) {
    return { hex: trimmed.toLowerCase(), alpha: 1 };
  }

  // #rgb
  const hex3 = trimmed.match(/^#([0-9a-f]{3})$/i);
  if (hex3) {
    const h = '#' + hex3[1][0] + hex3[1][0] + hex3[1][1] + hex3[1][1] + hex3[1][2] + hex3[1][2];
    return { hex: h.toLowerCase(), alpha: 1 };
  }

  // rgba(r, g, b, a) or rgba(r g b a)
  const rgbaMatch = trimmed.match(/^rgba\s*\(\s*([\d.]+)\s*[,\s]\s*([\d.]+)\s*[,\s]\s*([\d.]+)\s*[,\s]\s*([\d.]+)\s*\)$/i);
  if (rgbaMatch) {
    const r = Math.round(Number(rgbaMatch[1])).toString(16).padStart(2, '0');
    const g = Math.round(Number(rgbaMatch[2])).toString(16).padStart(2, '0');
    const b = Math.round(Number(rgbaMatch[3])).toString(16).padStart(2, '0');
    return { hex: ('#' + r + g + b).toLowerCase(), alpha: Math.round(Number(rgbaMatch[4]) * 100) / 100 };
  }

  // rgb(r, g, b)
  const rgbMatch = trimmed.match(/^rgb\s*\(\s*([\d.]+)\s*[,\s]\s*([\d.]+)\s*[,\s]\s*([\d.]+)\s*\)$/i);
  if (rgbMatch) {
    const r = Math.round(Number(rgbMatch[1])).toString(16).padStart(2, '0');
    const g = Math.round(Number(rgbMatch[2])).toString(16).padStart(2, '0');
    const b = Math.round(Number(rgbMatch[3])).toString(16).padStart(2, '0');
    return { hex: ('#' + r + g + b).toLowerCase(), alpha: 1 };
  }

  // transparent
  if (trimmed.toLowerCase() === 'transparent') {
    return { hex: '#000000', alpha: 0 };
  }

  // Fallback: use canvas trick for named colors, default alpha 1
  return { hex: colorToHex(trimmed), alpha: 1 };
}

/**
 * Build a CSS color string from hex + alpha.
 * Uses #rrggbb when alpha is 1, rgba() otherwise.
 */
export function buildColorAlpha(hex: string, alpha: number): string {
  const clamped = Math.max(0, Math.min(1, Math.round(alpha * 100) / 100));
  if (clamped === 1) return hex;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${clamped})`;
}
