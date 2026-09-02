/**
 * Designer theme configuration — Bootstrap 5 CSS custom properties based design token system.
 *
 * Each project stores a themePrompt (JSON string) containing:
 * - colors: CSS custom property color overrides
 * - stylePrompt: optional style instructions (glassmorphism, etc.)
 *
 * The system prompt always includes a base Bootstrap theme; theme presets
 * override the colors section. This ensures all pages in a project share
 * the same design tokens for visual consistency.
 */

// ── Helpers ──

/** Convert a hex color (#rrggbb or #rgb) to "r, g, b" triplet for Bootstrap --bs-*-rgb vars. */
function hexToRgbTriplet(hex: string): string {
  let h = hex.replace('#', '').trim();
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `${r}, ${g}, ${b}`;
}

// ── Types ──

export interface ThemeColors {
  [token: string]: string;
}

export interface ThemePreset {
  id: string;
  name: string;
  description: string;
  /** Display swatches for UI */
  colors: string[];
  /** CSS custom property color overrides */
  config: { colors: ThemeColors };
}

export interface StylePreset {
  id: string;
  name: string;
  description: string;
  /** Text instructions for CSS techniques (glassmorphism, etc.) */
  prompt: string;
  /** Preview image URL for hover display */
  previewImage?: string;
  /**
   * Token overrides applied at project creation for this style.
   * Empty string ('') marks a token as unused — the editor shows it blank
   * and buildBootstrapTheme skips emitting the CSS variable.
   */
  tokenOverrides?: {
    borderRadius?: TokenMap;
    spacing?: TokenMap;
    boxShadow?: TokenMap;
  };
}

/** Token maps stored alongside colors in ThemePromptData */
export type TokenMap = Record<string, string>;
export type FontFamilyMap = Record<string, string[]>;

/** Shape of the JSON stored in DesignerProject.themePrompt */
export interface ThemePromptData {
  colors?: ThemeColors;
  borderRadius?: TokenMap;
  spacing?: TokenMap;
  fontFamily?: FontFamilyMap;
  boxShadow?: TokenMap;
  stylePrompt?: string;
}

// ── Default Bootstrap Theme (base, always included) ──

export const DEFAULT_BOOTSTRAP_COLORS: ThemeColors = {
  // Primary
  primary: '#3b82f6',
  'on-primary': '#ffffff',
  'primary-container': '#dbeafe',
  'on-primary-container': '#1e3a5f',
  // Secondary
  secondary: '#6366f1',
  'on-secondary': '#ffffff',
  'secondary-container': '#e0e7ff',
  'on-secondary-container': '#312e81',
  // Tertiary
  tertiary: '#8b5cf6',
  'on-tertiary': '#ffffff',
  'tertiary-container': '#f3e8ff',
  'on-tertiary-container': '#4c1d95',
  // Background & Surface
  background: '#ffffff',
  'on-background': '#1f2937',
  surface: '#ffffff',
  'on-surface': '#1f2937',
  'surface-variant': '#f3f4f6',
  'on-surface-variant': '#6b7280',
  'surface-container': '#f9fafb',
  'surface-container-high': '#f3f4f6',
  'surface-container-low': '#ffffff',
  'surface-container-lowest': '#ffffff',
  'surface-container-highest': '#e5e7eb',
  // Error
  error: '#ef4444',
  'on-error': '#ffffff',
  'error-container': '#fee2e2',
  'on-error-container': '#991b1b',
  // Success & Warning
  success: '#22c55e',
  'on-success': '#ffffff',
  warning: '#f59e0b',
  'on-warning': '#ffffff',
  // Outline
  outline: '#d1d5db',
  'outline-variant': '#e5e7eb',
};

// ── Default design tokens (borderRadius / spacing / fontFamily / boxShadow) ──

export const DEFAULT_BORDER_RADIUS: TokenMap = {
  DEFAULT: '0.25rem',
  sm: '0.25rem',
  md: '0.5rem',
  lg: '0.75rem',
  xl: '1rem',
  '2xl': '1.5rem',
  full: '9999px',
};

export const DEFAULT_SPACING: TokenMap = {
  xs: '4px',
  sm: '8px',
  md: '16px',
  lg: '24px',
  xl: '32px',
  'element-gap': '12px',
  'page-margin': '24px',
  'section-gap': '48px',
};

export const DEFAULT_FONT_FAMILY: FontFamilyMap = {
  sans: ['system-ui', '-apple-system', 'sans-serif'],
};

export const DEFAULT_BOX_SHADOW: TokenMap = {
  sm: '0 1px 2px 0 rgba(0,0,0,0.05)',
  DEFAULT: '0 1px 3px 0 rgba(0,0,0,0.1), 0 1px 2px -1px rgba(0,0,0,0.1)',
  md: '0 4px 6px -1px rgba(0,0,0,0.1), 0 2px 4px -2px rgba(0,0,0,0.1)',
  lg: '0 10px 15px -3px rgba(0,0,0,0.1), 0 4px 6px -4px rgba(0,0,0,0.1)',
  xl: '0 20px 25px -5px rgba(0,0,0,0.1), 0 8px 10px -6px rgba(0,0,0,0.1)',
};

// ── Theme Presets (color overrides) ──

export const THEME_PRESETS: ThemePreset[] = [
  {
    id: 'default',
    name: '默认',
    description: '使用系统默认配色',
    colors: ['#3b82f6', '#6366f1', '#8b5cf6'],
    config: { colors: {} },
  },
  {
    id: 'ocean',
    name: '海洋蓝',
    description: '清新、专业的蓝色系',
    colors: ['#0077b6', '#90e0ef', '#caf0f8'],
    config: {
      colors: {
        primary: '#0077b6',
        'on-primary': '#ffffff',
        'primary-container': '#caf0f8',
        'on-primary-container': '#003d5c',
        secondary: '#90e0ef',
        'on-secondary': '#003d5c',
        'secondary-container': '#caf0f8',
        'on-secondary-container': '#003d5c',
        tertiary: '#48cae4',
        'on-tertiary': '#003d5c',
        'tertiary-container': '#caf0f8',
        'on-tertiary-container': '#003d5c',
        background: '#ffffff',
        'on-background': '#003d5c',
        surface: '#ffffff',
        'on-surface': '#003d5c',
        'surface-variant': '#f0f9ff',
        'on-surface-variant': '#5a7a8a',
        'surface-container': '#f0f9ff',
        'surface-container-high': '#e0f2fe',
        'surface-container-low': '#ffffff',
        'surface-container-lowest': '#ffffff',
        'surface-container-highest': '#bae6fd',
        error: '#dc2626',
        'on-error': '#ffffff',
        'error-container': '#fee2e2',
        'on-error-container': '#7f1d1d',
        success: '#16a34a',
        'on-success': '#ffffff',
        warning: '#f59e0b',
        'on-warning': '#ffffff',
        outline: '#90e0ef',
        'outline-variant': '#caf0f8',
      },
    },
  },
  {
    id: 'sunset',
    name: '日落橙',
    description: '温暖、活力的橙红色系',
    colors: ['#f97316', '#fbbf24', '#fffbeb'],
    config: {
      colors: {
        primary: '#f97316',
        'on-primary': '#ffffff',
        'primary-container': '#ffedd5',
        'on-primary-container': '#7c2d12',
        secondary: '#fbbf24',
        'on-secondary': '#7c2d12',
        'secondary-container': '#fef3c7',
        'on-secondary-container': '#7c2d12',
        tertiary: '#f59e0b',
        'on-tertiary': '#ffffff',
        'tertiary-container': '#fef3c7',
        'on-tertiary-container': '#78350f',
        background: '#fffbeb',
        'on-background': '#7c2d12',
        surface: '#fffbeb',
        'on-surface': '#7c2d12',
        'surface-variant': '#fef3c7',
        'on-surface-variant': '#92400e',
        'surface-container': '#fef3c7',
        'surface-container-high': '#fde68a',
        'surface-container-low': '#fffbeb',
        'surface-container-lowest': '#ffffff',
        'surface-container-highest': '#fcd34d',
        error: '#dc2626',
        'on-error': '#ffffff',
        'error-container': '#fee2e2',
        'on-error-container': '#7f1d1d',
        success: '#16a34a',
        'on-success': '#ffffff',
        warning: '#d97706',
        'on-warning': '#ffffff',
        outline: '#fbbf24',
        'outline-variant': '#fef3c7',
      },
    },
  },
  {
    id: 'forest',
    name: '森林绿',
    description: '自然、沉稳的绿色系',
    colors: ['#16a34a', '#86efac', '#f0fdf4'],
    config: {
      colors: {
        primary: '#16a34a',
        'on-primary': '#ffffff',
        'primary-container': '#dcfce7',
        'on-primary-container': '#14532d',
        secondary: '#86efac',
        'on-secondary': '#14532d',
        'secondary-container': '#dcfce7',
        'on-secondary-container': '#14532d',
        tertiary: '#22c55e',
        'on-tertiary': '#ffffff',
        'tertiary-container': '#dcfce7',
        'on-tertiary-container': '#14532d',
        background: '#f0fdf4',
        'on-background': '#14532d',
        surface: '#f0fdf4',
        'on-surface': '#14532d',
        'surface-variant': '#dcfce7',
        'on-surface-variant': '#166534',
        'surface-container': '#dcfce7',
        'surface-container-high': '#bbf7d0',
        'surface-container-low': '#f0fdf4',
        'surface-container-lowest': '#ffffff',
        'surface-container-highest': '#86efac',
        error: '#dc2626',
        'on-error': '#ffffff',
        'error-container': '#fee2e2',
        'on-error-container': '#7f1d1d',
        success: '#16a34a',
        'on-success': '#ffffff',
        warning: '#f59e0b',
        'on-warning': '#ffffff',
        outline: '#86efac',
        'outline-variant': '#dcfce7',
      },
    },
  },
  {
    id: 'cherry',
    name: '樱花粉',
    description: '温柔、浪漫的粉色系',
    colors: ['#ec4899', '#f9a8d4', '#fdf2f8'],
    config: {
      colors: {
        primary: '#ec4899',
        'on-primary': '#ffffff',
        'primary-container': '#fce7f3',
        'on-primary-container': '#831843',
        secondary: '#f9a8d4',
        'on-secondary': '#831843',
        'secondary-container': '#fce7f3',
        'on-secondary-container': '#831843',
        tertiary: '#f472b6',
        'on-tertiary': '#ffffff',
        'tertiary-container': '#fce7f3',
        'on-tertiary-container': '#831843',
        background: '#fdf2f8',
        'on-background': '#831843',
        surface: '#fdf2f8',
        'on-surface': '#831843',
        'surface-variant': '#fce7f3',
        'on-surface-variant': '#9d174d',
        'surface-container': '#fce7f3',
        'surface-container-high': '#fbcfe8',
        'surface-container-low': '#fdf2f8',
        'surface-container-lowest': '#ffffff',
        'surface-container-highest': '#fbcfe8',
        error: '#dc2626',
        'on-error': '#ffffff',
        'error-container': '#fee2e2',
        'on-error-container': '#7f1d1d',
        success: '#16a34a',
        'on-success': '#ffffff',
        warning: '#f59e0b',
        'on-warning': '#ffffff',
        outline: '#f9a8d4',
        'outline-variant': '#fce7f3',
      },
    },
  },
  {
    id: 'dark-dashboard',
    name: '深蓝大屏',
    description: '数据可视化大屏深蓝配色',
    colors: ['#00d4ff', '#0a1929', '#102a43'],
    config: {
      colors: {
        // Primary — 霓虹青
        primary: '#00d4ff',
        'on-primary': '#0a1929',
        'primary-container': '#0d3a5c',
        'on-primary-container': '#00d4ff',
        // Secondary — 深空蓝
        secondary: '#1e90ff',
        'on-secondary': '#ffffff',
        'secondary-container': '#0d2540',
        'on-secondary-container': '#1e90ff',
        // Tertiary — 科技紫
        tertiary: '#7c3aed',
        'on-tertiary': '#ffffff',
        'tertiary-container': '#1e1b4b',
        'on-tertiary-container': '#a78bfa',
        // Background & Surface — 深海蓝
        background: '#0a1929',
        'on-background': '#e6f1ff',
        surface: '#102a43',
        'on-surface': '#e6f1ff',
        'surface-variant': '#0d2540',
        'on-surface-variant': '#8bafd4',
        'surface-container': '#0d2540',
        'surface-container-high': '#163d5c',
        'surface-container-low': '#0a1929',
        'surface-container-lowest': '#06101c',
        'surface-container-highest': '#1e4d7b',
        // Error — 霓虹红
        error: '#ff4d6d',
        'on-error': '#ffffff',
        'error-container': '#5c0a1f',
        'on-error-container': '#ff8fa3',
        // Success & Warning — 霓虹绿/琥珀
        success: '#00e676',
        'on-success': '#0a1929',
        warning: '#ffb300',
        'on-warning': '#0a1929',
        // Outline — 暗蓝边框
        outline: '#1e3a5f',
        'outline-variant': '#0d2540',
      },
    },
  },
];

// ── Style Presets (CSS technique instructions) ──

export const STYLE_PRESETS: StylePreset[] = [
  {
    id: 'default',
    name: '默认',
    description: '标准平面风格',
    prompt: '',
  },
  {
    id: 'glassmorphism',
    name: '玻璃拟态',
    description: '半透明磨砂卡片、渐变深色背景、分层悬浮感',
    prompt: 'Apply Glassmorphism style: use semi-transparent frosted glass cards with backdrop-filter: blur(16px) saturate(180%), gradient dark background, layered floating effect with subtle shadows, low saturation soft lighting. Add custom CSS for glass panels with background: rgba(255,255,255,0.1), backdrop-filter: blur(16px), border: 1px solid rgba(255,255,255,0.2). Use shadow utilities for floating depth.',
  },
  {
    id: 'neumorphism',
    name: '新拟态',
    description: '柔和凸起/凹陷效果、浅色中性背景',
    prompt: 'Apply Neumorphism style: soft extruded/inset UI elements with dual shadows. Use custom CSS with box-shadow: 6px 6px 12px rgba(0,0,0,0.15), -6px -6px 12px rgba(255,255,255,0.8). Light neutral background (#e0e5ec). Use rounded-pill or rounded-4 for all elements. For pressed/active states, use inset shadows.',
  },
  {
    id: 'cyberpunk',
    name: '赛博朋克',
    description: '霓虹色彩、暗黑背景、故障效果',
    prompt: 'Apply Cyberpunk style: neon accent colors on dark background. Use custom CSS for neon text glow with text-shadow: 0 0 8px rgba(0,240,255,0.6). Sharp geometric shapes, high contrast, scanline overlays via CSS. Use border-2 border-info for neon outlines. Add subtle scanline patterns with CSS background.',
  },
  {
    id: 'brutalism',
    name: '粗野主义',
    description: '大胆色块、粗边框、原始感',
    prompt: 'Apply Brutalism style: bold solid color blocks, thick black borders (border border-dark border-3), raw/unpolished aesthetic, monospace fonts (font-monospace), high contrast, no rounded corners (rounded-0), visible grid structure, large typography, stark color contrasts.',
  },
  {
    id: 'minimalist',
    name: '简约',
    description: '小圆角、细线分隔、扁平标签、紧凑布局，类似 Ant Design 风格',
    prompt: 'Apply Minimalist/Ant-Design style: override Bootstrap defaults aggressively. Add a <style> block with these MANDATORY rules:\n1. BORDER RADIUS: cap all .rounded-1, .rounded-2, .rounded-3, .rounded-4 at border-radius: 4px (4px max, may be 0 for tabs/sidebar); .rounded-circle stays 50%. Do NOT use .rounded-pill (see BADGES).\n2. BUTTONS: .btn { border-radius: 4px; padding: 4px 12px; font-weight: 500; } .btn-primary { box-shadow: none; } .btn:hover { opacity: 0.85; }\n3. CARDS: .card { border-radius: 4px; border: 1px solid var(--xai-outline-variant); box-shadow: none; } .card-header { border-bottom: 1px solid var(--xai-outline-variant); background: transparent; }\n4. TABS (nav-tabs): .nav-tabs { border-bottom: 1px solid var(--xai-outline-variant); } .nav-tabs .nav-link { border: none; border-bottom: 2px solid transparent; border-radius: 0; padding: 8px 16px; color: var(--xai-on-surface-variant); } .nav-tabs .nav-link.active { border-bottom-color: var(--xai-primary); color: var(--xai-primary); background: transparent; font-weight: 500; } .nav-tabs .nav-link:hover { border-bottom-color: var(--xai-primary); color: var(--xai-primary); }\n5. FORM INPUTS: .form-control, .form-select { border-radius: 4px; border: 1px solid var(--xai-outline); padding: 4px 8px; } .form-control:focus { border-color: var(--xai-primary); box-shadow: 0 0 0 2px rgba(var(--bs-primary-rgb), 0.12); }\n6. BADGES: .badge { border-radius: 4px; font-weight: 500; } Avoid .rounded-pill for badges.\n7. TABLES: .table { font-size: 0.875rem; } .table thead th { border-bottom: 2px solid var(--xai-outline-variant); font-weight: 600; color: var(--xai-on-surface-variant); background: var(--xai-surface-container); padding: 10px 12px; } .table td { padding: 10px 12px; border-bottom: 1px solid var(--xai-outline-variant); }\n8. NAVBAR: .navbar { border-bottom: 1px solid var(--xai-outline-variant); box-shadow: none; } Avoid .shadow-* on navbar.\n9. GENERAL: Prefer 1px solid borders for separation over shadows. Use flat colors, no gradients. Keep spacing tight (p-2, p-3 instead of p-4, p-5). Use font-weight 500 for emphasis. Avoid .shadow-sm/.shadow on cards/containers—only use shadows for modals and dropdowns.\n10. SIDEBAR: sidebar links use left border indicator instead of background color for active state. .nav-link.active { border-left: 3px solid var(--xai-primary); background: transparent; color: var(--xai-primary); border-radius: 0; padding-left: 13px; }\nUse small, precise rounded corners (4px max) everywhere. Match the clean, professional look of enterprise management systems.',
    tokenOverrides: {
      borderRadius: { DEFAULT: '4px', sm: '4px', md: '', lg: '', xl: '', '2xl': '', full: '50%' },
      boxShadow: { sm: '', DEFAULT: '', md: '', lg: '0 6px 16px rgba(0,0,0,0.08)', xl: '' },
    },
  },
  {
    id: 'skeuomorphism',
    name: '拟物化',
    description: '逼真材质纹理、立体感',
    prompt: 'Apply Skeuomorphism style: realistic material textures, depth through gradients and inner shadows. Use custom CSS gradients (background: linear-gradient(...)) and shadow-inner effects for depth. Realistic button press effects with active states using inset shadows. Use rounded-3 and subtle texture patterns via CSS background-image.',
  },
  {
    id: 'dashboard',
    name: '大屏科技',
    description: '数据可视化大屏风格：发光边框、渐变背景、霓虹色、科技感装饰',
    prompt: 'Apply Dashboard/Tech style for data visualization large screens. Add a <style> block with these MANDATORY rules:\n1. BODY BACKGROUND: body { background: radial-gradient(ellipse at top, var(--xai-surface-container) 0%, var(--xai-background) 60%); min-height: 100vh; } Add a subtle grid overlay via body::before { content: ""; position: fixed; inset: 0; background-image: linear-gradient(var(--xai-outline) 1px, transparent 1px), linear-gradient(90deg, var(--xai-outline) 1px, transparent 1px); background-size: 40px 40px; opacity: 0.08; pointer-events: none; z-index: 0; }\n2. CARDS (data panels): .card { background: linear-gradient(135deg, var(--xai-surface) 0%, var(--xai-surface-container) 100%); border: 1px solid var(--xai-outline); border-radius: 4px; box-shadow: 0 0 20px rgba(var(--bs-primary-rgb), 0.15), inset 0 0 30px rgba(var(--bs-primary-rgb), 0.05); position: relative; overflow: hidden; } .card::before { content: ""; position: absolute; top: 0; left: 0; right: 0; height: 2px; background: linear-gradient(90deg, transparent, var(--xai-primary), transparent); }\n3. CARD CORNER DECORATIONS (sci-fi corners): .card::after { content: ""; position: absolute; top: 0; right: 0; width: 12px; height: 12px; border-top: 2px solid var(--xai-primary); border-right: 2px solid var(--xai-primary); }\n4. KPI VALUES: .kpi-value, .stat-value, [class*="kpi"] > div > div:first-child { font-family: "SF Mono", "Cascadia Code", Consolas, monospace; font-size: 32px; font-weight: 700; color: var(--xai-primary); text-shadow: 0 0 12px rgba(var(--bs-primary-rgb), 0.6); letter-spacing: 1px; }\n5. SECTION TITLES: .card-header, .panel-title, h5, h6 { color: var(--xai-primary); letter-spacing: 2px; font-weight: 600; text-transform: uppercase; font-size: 14px; border-bottom: 1px solid var(--xai-outline) !important; padding-bottom: 8px; } Add a left accent bar: .card-header::before { content: ""; display: inline-block; width: 3px; height: 14px; background: var(--xai-primary); margin-right: 8px; vertical-align: middle; box-shadow: 0 0 8px var(--xai-primary); }\n6. BUTTONS: .btn-primary { background: linear-gradient(135deg, var(--xai-primary), var(--xai-secondary)); border: none; box-shadow: 0 0 12px rgba(var(--bs-primary-rgb), 0.4); } .btn-primary:hover { box-shadow: 0 0 20px rgba(var(--bs-primary-rgb), 0.6); } .btn-outline-primary { border: 1px solid var(--xai-primary); color: var(--xai-primary); } .btn-outline-primary:hover { background: rgba(var(--bs-primary-rgb), 0.15); box-shadow: 0 0 12px rgba(var(--bs-primary-rgb), 0.3); }\n7. TABLES: .table { color: var(--xai-on-surface); } .table thead th { color: var(--xai-primary); border-bottom: 1px solid var(--xai-outline); background: rgba(var(--bs-primary-rgb), 0.08); letter-spacing: 1px; } .table tbody tr:hover { background: rgba(var(--bs-primary-rgb), 0.08); } .table td { border-bottom: 1px solid var(--xai-outline-variant); }\n8. BADGES: .badge { border: 1px solid currentColor; background: transparent; box-shadow: 0 0 8px currentColor; } .bg-success { box-shadow: 0 0 8px rgba(var(--bs-success-rgb), 0.5); } .bg-danger { box-shadow: 0 0 8px rgba(var(--bs-danger-rgb), 0.5); }\n9. FORM CONTROLS: .form-control, .form-select { background: var(--xai-surface-container); border: 1px solid var(--xai-outline); color: var(--xai-on-surface); } .form-control:focus, .form-select:focus { border-color: var(--xai-primary); box-shadow: 0 0 12px rgba(var(--bs-primary-rgb), 0.3); background: var(--xai-surface); }\n10. CHARTS (Chart.js): set Chart.defaults.color to var(--xai-on-surface-variant); grid lines color: rgba(var(--bs-primary-rgb), 0.1); tooltip background: var(--xai-surface-container) with border: 1px solid var(--xai-primary).\n11. GENERAL: All text uses var(--xai-on-surface) for primary text, var(--xai-on-surface-variant) for secondary. Use neon glow sparingly—only on KPI values, active states, and primary buttons. Avoid .shadow-sm/.shadow (use box-shadow with rgba(var(--bs-primary-rgb)) for glow instead). Keep content within a max-width: 1920px container centered for large screens.\nUse dark navy backgrounds with neon cyan accents, glowing borders, and sci-fi corner decorations. Match the look of professional data visualization dashboards (DataV, AliDataV).',
    tokenOverrides: {
      borderRadius: { DEFAULT: '4px', sm: '4px', md: '4px', lg: '', xl: '', '2xl': '', full: '50%' },
      boxShadow: {
        sm: '0 0 8px rgba(var(--bs-primary-rgb), 0.2)',
        DEFAULT: '0 0 20px rgba(var(--bs-primary-rgb), 0.15)',
        md: '0 0 24px rgba(var(--bs-primary-rgb), 0.25)',
        lg: '0 0 32px rgba(var(--bs-primary-rgb), 0.3)',
        xl: '0 0 48px rgba(var(--bs-primary-rgb), 0.4)',
      },
    },
  },
];

// ── Helper Functions ──

/**
 * Build a CSS :root block defining all Bootstrap + custom design tokens.
 *
 * This CSS is injected into every generated HTML page to ensure consistent theming.
 * Bootstrap's native --bs-* variables are overridden alongside custom --xai-* variables
 * for design tokens that Bootstrap doesn't natively support (surface, outline, etc.).
 *
 * Accepts either a full ThemePromptData object or a bare ThemeColors map
 * for backwards compatibility.
 */
export function buildBootstrapTheme(themeData?: ThemePromptData | ThemeColors | null): string {
  const colors = { ...DEFAULT_BOOTSTRAP_COLORS };
  let borderRadius: TokenMap = { ...DEFAULT_BORDER_RADIUS };
  let spacing: TokenMap = { ...DEFAULT_SPACING };
  let fontFamily: FontFamilyMap = JSON.parse(JSON.stringify(DEFAULT_FONT_FAMILY));
  let boxShadow: TokenMap = { ...DEFAULT_BOX_SHADOW };

  if (themeData) {
    // Detect legacy call shape: a plain ThemeColors object has string values and
    // no nested token groups. ThemePromptData has colors/borderRadius/etc keys.
    const isThemeData =
      'colors' in (themeData as ThemePromptData) ||
      'borderRadius' in (themeData as ThemePromptData) ||
      'spacing' in (themeData as ThemePromptData) ||
      'fontFamily' in (themeData as ThemePromptData) ||
      'boxShadow' in (themeData as ThemePromptData) ||
      'stylePrompt' in (themeData as ThemePromptData);

    const data: ThemePromptData = isThemeData
      ? (themeData as ThemePromptData)
      : { colors: themeData as ThemeColors };

    if (data.colors && Object.keys(data.colors).length > 0) {
      Object.assign(colors, data.colors);
    }
    if (data.borderRadius && Object.keys(data.borderRadius).length > 0) {
      borderRadius = { ...borderRadius, ...data.borderRadius };
    }
    if (data.spacing && Object.keys(data.spacing).length > 0) {
      spacing = { ...spacing, ...data.spacing };
    }
    if (data.fontFamily && Object.keys(data.fontFamily).length > 0) {
      fontFamily = { ...fontFamily, ...data.fontFamily };
    }
    if (data.boxShadow && Object.keys(data.boxShadow).length > 0) {
      boxShadow = { ...boxShadow, ...data.boxShadow };
    }
  }

  // Build the CSS :root block
  const lines: string[] = [':root {'];

  // Bootstrap overrides: map our primary/secondary/error/success/warning
  // to Bootstrap's --bs-* variables.
  // CRITICAL: Bootstrap 5.3 utility classes (bg-primary, text-primary,
  // border-primary, btn-primary, etc.) use --bs-*-rgb (RGB triplets),
  // NOT --bs-* (hex). Without the -rgb vars, bg-primary falls back to the
  // Bootstrap default blue regardless of our --bs-primary hex value.
  lines.push(`  /* Bootstrap 5 color overrides (hex + RGB triplet) */`);
  lines.push(`  --bs-primary: ${colors.primary};`);
  lines.push(`  --bs-primary-rgb: ${hexToRgbTriplet(colors.primary)};`);
  lines.push(`  --bs-secondary: ${colors.secondary};`);
  lines.push(`  --bs-secondary-rgb: ${hexToRgbTriplet(colors.secondary)};`);
  lines.push(`  --bs-success: ${colors.success};`);
  lines.push(`  --bs-success-rgb: ${hexToRgbTriplet(colors.success)};`);
  lines.push(`  --bs-warning: ${colors.warning};`);
  lines.push(`  --bs-warning-rgb: ${hexToRgbTriplet(colors.warning)};`);
  lines.push(`  --bs-danger: ${colors.error};`);
  lines.push(`  --bs-danger-rgb: ${hexToRgbTriplet(colors.error)};`);
  lines.push(`  --bs-info: ${colors.tertiary};`);
  lines.push(`  --bs-info-rgb: ${hexToRgbTriplet(colors.tertiary)};`);
  lines.push(`  --bs-body-bg: ${colors.background};`);
  lines.push(`  --bs-body-color: ${colors['on-background']};`);
  // Bootstrap 5.3 changed --bs-table-color to use --bs-emphasis-color (default #000)
  // instead of --bs-body-color. Without this override, dark themes get black table text.
  lines.push(`  --bs-emphasis-color: ${colors['on-background']};`);
  lines.push('');

  // Custom design tokens (Material Design style)
  lines.push(`  /* Primary */`);
  lines.push(`  --xai-primary: ${colors.primary};`);
  lines.push(`  --xai-on-primary: ${colors['on-primary']};`);
  lines.push(`  --xai-primary-container: ${colors['primary-container']};`);
  lines.push(`  --xai-on-primary-container: ${colors['on-primary-container']};`);
  lines.push(`  /* Secondary */`);
  lines.push(`  --xai-secondary: ${colors.secondary};`);
  lines.push(`  --xai-on-secondary: ${colors['on-secondary']};`);
  lines.push(`  --xai-secondary-container: ${colors['secondary-container']};`);
  lines.push(`  --xai-on-secondary-container: ${colors['on-secondary-container']};`);
  lines.push(`  /* Tertiary */`);
  lines.push(`  --xai-tertiary: ${colors.tertiary};`);
  lines.push(`  --xai-on-tertiary: ${colors['on-tertiary']};`);
  lines.push(`  --xai-tertiary-container: ${colors['tertiary-container']};`);
  lines.push(`  --xai-on-tertiary-container: ${colors['on-tertiary-container']};`);
  lines.push(`  /* Background & Surface */`);
  lines.push(`  --xai-background: ${colors.background};`);
  lines.push(`  --xai-on-background: ${colors['on-background']};`);
  lines.push(`  --xai-surface: ${colors.surface};`);
  lines.push(`  --xai-on-surface: ${colors['on-surface']};`);
  lines.push(`  --xai-surface-variant: ${colors['surface-variant']};`);
  lines.push(`  --xai-on-surface-variant: ${colors['on-surface-variant']};`);
  lines.push(`  --xai-surface-container: ${colors['surface-container']};`);
  lines.push(`  --xai-surface-container-high: ${colors['surface-container-high']};`);
  lines.push(`  --xai-surface-container-low: ${colors['surface-container-low']};`);
  lines.push(`  --xai-surface-container-lowest: ${colors['surface-container-lowest']};`);
  lines.push(`  --xai-surface-container-highest: ${colors['surface-container-highest']};`);
  lines.push(`  /* Error */`);
  lines.push(`  --xai-error: ${colors.error};`);
  lines.push(`  --xai-on-error: ${colors['on-error']};`);
  lines.push(`  --xai-error-container: ${colors['error-container']};`);
  lines.push(`  --xai-on-error-container: ${colors['on-error-container']};`);
  lines.push(`  /* Success */`);
  lines.push(`  --xai-success: ${colors.success};`);
  lines.push(`  --xai-on-success: ${colors['on-success']};`);
  lines.push(`  /* Warning */`);
  lines.push(`  --xai-warning: ${colors.warning};`);
  lines.push(`  --xai-on-warning: ${colors['on-warning']};`);
  lines.push(`  /* Outline */`);
  lines.push(`  --xai-outline: ${colors.outline};`);
  lines.push(`  --xai-outline-variant: ${colors['outline-variant']};`);
  lines.push('');

  // Border radius tokens (empty values = unused token, skip emitting)
  lines.push(`  /* Border Radius */`);
  for (const [key, value] of Object.entries(borderRadius)) {
    if (!value) continue;
    const suffix = key === 'DEFAULT' ? '' : `-${key}`;
    lines.push(`  --xai-radius${suffix}: ${value};`);
  }
  lines.push('');

  // Spacing tokens
  lines.push(`  /* Spacing */`);
  for (const [key, value] of Object.entries(spacing)) {
    if (!value) continue;
    lines.push(`  --xai-space-${key}: ${value};`);
  }
  lines.push('');

  // Font family tokens
  lines.push(`  /* Font Family */`);
  for (const [key, values] of Object.entries(fontFamily)) {
    lines.push(`  --xai-font-${key}: ${values.join(', ')};`);
  }
  lines.push('');

  // Box shadow tokens
  lines.push(`  /* Box Shadow */`);
  for (const [key, value] of Object.entries(boxShadow)) {
    if (!value) continue;
    const suffix = key === 'DEFAULT' ? '' : `-${key}`;
    lines.push(`  --xai-shadow${suffix}: ${value};`);
  }

  lines.push('}');
  return lines.join('\n');
}

/**
 * Parse a stored themePrompt string into structured data.
 * Handles both new JSON format and legacy text format.
 */
export function parseThemePrompt(themePrompt: string): ThemePromptData {
  try {
    const parsed = JSON.parse(themePrompt);
    if (parsed && typeof parsed === 'object') {
      return {
        colors: parsed.colors,
        borderRadius: parsed.borderRadius,
        spacing: parsed.spacing,
        fontFamily: parsed.fontFamily,
        boxShadow: parsed.boxShadow,
        stylePrompt: parsed.stylePrompt,
      };
    }
  } catch {
    // Legacy format — treat as style prompt text
  }
  return { stylePrompt: themePrompt };
}

/**
 * Build a ThemePromptData JSON string from theme/style selections.
 * Returns undefined if nothing is selected.
 *
 * Used by the ThemeDialog (换主题) which only records the *changed* tokens;
 * unchanged defaults are intentionally omitted so the dialog can apply a
 * partial override to the current screen via AI.
 */
export function buildThemePromptData(
  themeId: string | null,
  styleId: string | null,
  customStyle: string,
): string | undefined {
  const theme = THEME_PRESETS.find(t => t.id === themeId);
  const style = STYLE_PRESETS.find(s => s.id === styleId);
  const data: ThemePromptData = {};
  if (theme && theme.id !== 'default') {
    data.colors = theme.config.colors;
  }
  const stylePrompt = style?.prompt || customStyle.trim() || undefined;
  if (stylePrompt) {
    data.stylePrompt = stylePrompt;
  }
  if (!data.colors && !data.stylePrompt) return undefined;
  return JSON.stringify(data);
}

/**
 * Build a COMPLETE ThemePromptData JSON string containing every design token
 * (colors, borderRadius, spacing, fontFamily, boxShadow) — using default
 * values wherever the user did not override.
 *
 * Used at project creation so the database always stores the full design
 * system, even when the user keeps all defaults. The System Design dialog
 * subsequently edits this complete record in place.
 */
export function buildFullThemePromptData(
  themeId: string | null,
  styleId: string | null,
  customStyle: string,
): string {
  const theme = THEME_PRESETS.find(t => t.id === themeId);
  const style = STYLE_PRESETS.find(s => s.id === styleId);

  // Always persist the full color palette. Theme presets override the
  // defaults; the "default" theme keeps DEFAULT_BOOTSTRAP_COLORS.
  const colors: ThemeColors = theme && theme.id !== 'default'
    ? { ...DEFAULT_BOOTSTRAP_COLORS, ...theme.config.colors }
    : { ...DEFAULT_BOOTSTRAP_COLORS };

  const data: ThemePromptData = {
    colors,
    borderRadius: { ...DEFAULT_BORDER_RADIUS, ...(style?.tokenOverrides?.borderRadius || {}) },
    spacing: { ...DEFAULT_SPACING, ...(style?.tokenOverrides?.spacing || {}) },
    fontFamily: JSON.parse(JSON.stringify(DEFAULT_FONT_FAMILY)),
    boxShadow: { ...DEFAULT_BOX_SHADOW, ...(style?.tokenOverrides?.boxShadow || {}) },
  };

  const stylePrompt = style?.prompt || customStyle.trim() || undefined;
  if (stylePrompt) {
    data.stylePrompt = stylePrompt;
  }
  return JSON.stringify(data);
}

/**
 * Normalize any stored themePrompt into a complete ThemePromptData object,
 * filling missing token groups with defaults. Used by the System Design
 * dialog so it always shows every editable field, even for projects created
 * before the extended tokens existed.
 */
export function normalizeThemePromptData(themePrompt: string | undefined | null): ThemePromptData {
  const parsed = themePrompt ? parseThemePrompt(themePrompt) : {};
  return {
    colors: { ...DEFAULT_BOOTSTRAP_COLORS, ...(parsed.colors || {}) },
    borderRadius: { ...DEFAULT_BORDER_RADIUS, ...(parsed.borderRadius || {}) },
    spacing: { ...DEFAULT_SPACING, ...(parsed.spacing || {}) },
    fontFamily: JSON.parse(JSON.stringify(DEFAULT_FONT_FAMILY)) as FontFamilyMap,
    boxShadow: { ...DEFAULT_BOX_SHADOW, ...(parsed.boxShadow || {}) },
    stylePrompt: parsed.stylePrompt,
  };
}