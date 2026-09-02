import { useState, useEffect, useRef } from 'react';
import { X, Globe, Smartphone, Tablet, Check, GitBranch } from 'lucide-react';
import type { ProjectType } from '@xai/shared';
import { THEME_PRESETS, STYLE_PRESETS, buildFullThemePromptData } from '@xai/shared';

interface CreateProjectDialogProps {
  onConfirm: (name: string, type: ProjectType, themePrompt?: string) => void | Promise<void>;
  onCancel: () => void;
}

type DialogTab = 'prototype' | 'diagram';


export default function CreateProjectDialog({ onConfirm, onCancel }: CreateProjectDialogProps) {
  const [tab, setTab] = useState<DialogTab>('prototype');
  const [name, setName] = useState('');
  const [projectType, setProjectType] = useState<ProjectType>('WEB');
  const [selectedTheme, setSelectedTheme] = useState<string>('default');
  const [selectedStyle, setSelectedStyle] = useState<string>('default');
  const [customStyle, setCustomStyle] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Tab 切换时同步 projectType
  useEffect(() => {
    if (tab === 'diagram') {
      setProjectType('DIAGRAM');
    } else {
      if (projectType === 'DIAGRAM') setProjectType('WEB');
    }
  }, [tab]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && name.trim()) {
      handleConfirm();
    } else if (e.key === 'Escape') {
      onCancel();
    }
  };

  const handleConfirm = () => {
    if (tab === 'diagram') {
      onConfirm(name.trim(), 'DIAGRAM');
    } else {
      onConfirm(name.trim(), projectType, buildFullThemePromptData(selectedTheme, selectedStyle, customStyle));
    }
  };

  return (
    <div className="designer-dialog-overlay" onClick={onCancel}>
      <div className="designer-dialog designer-create-dialog" onClick={e => e.stopPropagation()}>
        <div className="designer-dialog-header">
          <span className="designer-dialog-title">新建项目</span>
          <button className="designer-dialog-close" onClick={onCancel}>
            <X size={14} />
          </button>
        </div>

        {/* Tab 切换 */}
        <div className="designer-create-tabs">
          <button
            className={`designer-create-tab ${tab === 'prototype' ? 'active' : ''}`}
            onClick={() => setTab('prototype')}
          >
            <Globe size={12} />
            原型设计
          </button>
          <button
            className={`designer-create-tab ${tab === 'diagram' ? 'active' : ''}`}
            onClick={() => setTab('diagram')}
          >
            <GitBranch size={12} />
            图表 / 架构图
          </button>
        </div>

        <div className="designer-dialog-body">
          {/* ─── 原型设计 Tab ─── */}
          {tab === 'prototype' && (
            <>
              <div>
                <div className="designer-dialog-label">项目类型</div>
                <div className="designer-type-cards">
                  <div
                    className={`designer-type-card ${projectType === 'WEB' ? 'selected' : ''}`}
                    onClick={() => setProjectType('WEB')}
                  >
                    <Globe size={14} />
                    <span>WEB</span>
                  </div>
                  <div
                    className={`designer-type-card ${projectType === 'APP' ? 'selected' : ''}`}
                    onClick={() => setProjectType('APP')}
                  >
                    <Smartphone size={14} />
                    <span>APP</span>
                  </div>
                  <div
                    className={`designer-type-card ${projectType === 'PDA' ? 'selected' : ''}`}
                    onClick={() => setProjectType('PDA')}
                  >
                    <Tablet size={14} />
                    <span>PDA</span>
                  </div>
                </div>
              </div>

              <div>
                <div className="designer-dialog-label">配色主题</div>
                <div className="designer-create-theme-grid">
                  {THEME_PRESETS.map(theme => (
                    <div
                      key={theme.id}
                      className={`designer-create-theme-card ${selectedTheme === theme.id ? 'selected' : ''}`}
                      onClick={() => setSelectedTheme(theme.id)}
                    >
                      <div className="designer-create-theme-colors">
                        {theme.colors.map((color, i) => (
                          <span
                            key={i}
                            className="designer-create-theme-dot"
                            style={{ background: color }}
                          />
                        ))}
                      </div>
                      <span className="designer-create-theme-name">{theme.name}</span>
                      {selectedTheme === theme.id && <Check size={10} className="designer-create-theme-check" />}
                    </div>
                  ))}
                </div>
              </div>

              <div>
                <div className="designer-dialog-label">视觉风格</div>
                <div className="designer-style-grid">
                  {STYLE_PRESETS.map(style => (
                    <div
                      key={style.id}
                      className={`designer-style-card ${selectedStyle === style.id ? 'selected' : ''}`}
                      onClick={() => { setSelectedStyle(style.id); if (style.id !== 'default') setCustomStyle(''); }}
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
              </div>

              <div>
                <div className="designer-dialog-label">自定义风格描述（可选）</div>
                <textarea
                  className="designer-dialog-input designer-style-textarea"
                  value={customStyle}
                  onChange={e => { setCustomStyle(e.target.value); if (e.target.value.trim()) setSelectedStyle('default'); }}
                  placeholder="描述你想要的视觉风格，如：毛玻璃效果、渐变深色背景、低饱和柔和光影..."
                  rows={2}
                />
              </div>
            </>
          )}

          {/* ─── 图表 / 架构图 Tab ─── */}
          {tab === 'diagram' && (
            <>
              <div className="designer-diagram-tip">
                图表 / 架构图项目使用 Mermaid 渲染，无需选择风格。创建后直接在聊天中描述你的图表需求即可。
              </div>
            </>
          )}

          {/* 项目名称（两个 Tab 共用） */}
          <div>
            <div className="designer-dialog-label">项目名称</div>
            <input
              ref={inputRef}
              className="designer-dialog-input"
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={tab === 'diagram' ? '输入图表项目名称，如：电商系统架构图...' : '输入项目名称...'}
            />
          </div>
        </div>

        <div className="designer-dialog-footer">
          <button className="designer-dialog-btn cancel" onClick={onCancel}>取消</button>
          <button
            className="designer-dialog-btn confirm"
            disabled={!name.trim()}
            onClick={handleConfirm}
          >
            创建
          </button>
        </div>
      </div>
    </div>
  );
}