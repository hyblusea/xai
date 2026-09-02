import { useState, useCallback } from 'react';
import { Palette, X, Check, RefreshCw } from 'lucide-react';
import { THEME_PRESETS, STYLE_PRESETS, buildThemePromptData } from '@xai/shared';

interface ThemeDialogProps {
  onClose: () => void;
  onApply: (prompt: string, scope: 'project' | 'screen') => void;
  isGenerating: boolean;
  /** When true, show diagram-specific style presets instead of UI themes. */
  isDiagramProject?: boolean;
}

/**
 * Theme switching dialog with preset themes, style presets and custom input.
 * Supports project-level and screen-level theme application.
 */
export default function ThemeDialog({ onClose, onApply, isGenerating, isDiagramProject }: ThemeDialogProps) {
  const [selectedTheme, setSelectedTheme] = useState<string | null>(null);
  const [selectedStyle, setSelectedStyle] = useState<string | null>(null);
  const [scope, setScope] = useState<'project' | 'screen'>('project');
  const [customPrompt, setCustomPrompt] = useState('');

  const handleApply = useCallback(() => {
    const prompt = buildThemePromptData(selectedTheme, selectedStyle, customPrompt);
    if (prompt) {
      onApply(prompt, scope);
    }
  }, [selectedTheme, selectedStyle, customPrompt, scope, onApply]);

  return (
    <div className="designer-dialog-overlay" onClick={onClose}>
      <div className="designer-dialog designer-theme-dialog" onClick={e => e.stopPropagation()}>
        <div className="designer-dialog-header">
          <span className="designer-dialog-title">
            <Palette size={14} style={{ verticalAlign: 'middle', marginRight: 6 }} />
            换主题
          </span>
          <button className="designer-dialog-close" onClick={onClose}>
            <X size={14} />
          </button>
        </div>
        <div className="designer-dialog-body">
          {/* Scope selector */}
          <div className="designer-theme-scope">
            <button
              className={`designer-theme-scope-btn ${scope === 'project' ? 'active' : ''}`}
              onClick={() => setScope('project')}
            >
              整个项目
            </button>
            <button
              className={`designer-theme-scope-btn ${scope === 'screen' ? 'active' : ''}`}
              onClick={() => setScope('screen')}
            >
              当前页面
            </button>
          </div>

          {/* Color theme presets */}
          <div className="designer-dialog-label">配色主题</div>
          <div className="designer-theme-grid">
            {THEME_PRESETS.map(theme => (
              <div
                key={theme.id}
                className={`designer-theme-card ${selectedTheme === theme.id ? 'selected' : ''}`}
                onClick={() => { setSelectedTheme(theme.id); setCustomPrompt(''); }}
              >
                <div className="designer-theme-card-header">
                  <span className="designer-theme-card-name">{theme.name}</span>
                  {selectedTheme === theme.id && <Check size={12} />}
                </div>
                <span className="designer-theme-card-desc">{theme.description}</span>
              </div>
            ))}
          </div>

          {/* Style presets */}
          <div className="designer-dialog-label">视觉风格</div>
          <div className="designer-style-grid">
            {STYLE_PRESETS.map(style => (
              <div
                key={style.id}
                className={`designer-style-card ${selectedStyle === style.id ? 'selected' : ''}`}
                onClick={() => { setSelectedStyle(style.id); if (style.id !== 'default') setCustomPrompt(''); }}
              >
                <div className="designer-style-card-content">
                  <div className="designer-style-card-text">
                    <div className="designer-style-card-header">
                      <span className="designer-style-card-name">{style.name}</span>
                      {selectedStyle === style.id && <Check size={10} />}
                    </div>
                    <span className="designer-style-card-desc">{style.description}</span>
                  </div>
                  <div className={`designer-style-card-preview style-preview-${style.id}`}>
                    <div className="sp-topbar" />
                    <div className="sp-content">
                      <div className="sp-card" />
                      <div className="sp-btn" />
                      <div className="sp-accent" />
                    </div>
                    {selectedStyle === style.id && (
                      <div className="designer-style-card-check-overlay">
                        <Check size={12} />
                      </div>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* Custom prompt */}
          <div className="designer-theme-custom">
            <label className="designer-prop-label">自定义描述（可选）</label>
            <textarea
              className="designer-prop-input designer-prop-textarea"
              value={customPrompt}
              onChange={e => { setCustomPrompt(e.target.value); setSelectedTheme(null); setSelectedStyle(null); }}
              placeholder={isDiagramProject
                ? "描述你想要的图表风格，如：深色科技风、手绘风格、使用绿色系配色..."
                : "描述你想要的主题或风格，如：毛玻璃效果、渐变深色背景、低饱和柔和光影..."
              }
              rows={2}
            />
          </div>
        </div>
        <div className="designer-dialog-footer">
          <button className="designer-dialog-btn cancel" onClick={onClose}>取消</button>
          <button
            className="designer-dialog-btn primary"
            onClick={handleApply}
            disabled={isGenerating || (!selectedTheme && !selectedStyle && !customPrompt.trim())}
          >
            {isGenerating ? <RefreshCw size={12} className="spin" /> : <Check size={12} />}
            {isGenerating ? '应用中...' : '应用主题'}
          </button>
        </div>
      </div>
    </div>
  );
}
