import React, { useState, useEffect, useRef } from 'react';

interface PageStyleEditorProps {
  /** 当前页面的 <style> 内容（不含标签本身） */
  initialCss: string;
  /** 当用户确认修改后回调，传回新的 CSS 内容 */
  onApply: (css: string) => void;
  /** 关闭面板 */
  onClose: () => void;
}

/**
 * PageStyleEditor — 页面级 <style> 编辑器
 *
 * 浮层面板，提供 textarea 让用户编辑当前页面的自定义 CSS。
 * 点击「应用」后更新 iframe 中的 <style> 标签。
 */
export default function PageStyleEditor({ initialCss, onApply, onClose }: PageStyleEditorProps) {
  const [css, setCss] = useState(initialCss);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => { setCss(initialCss); }, [initialCss]);

  // 聚焦到 textarea
  useEffect(() => {
    const timer = setTimeout(() => textareaRef.current?.focus(), 100);
    return () => clearTimeout(timer);
  }, []);

  // ESC 关闭
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose]);

  // 点击面板外部关闭
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside);
    }, 0);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [onClose]);

  const handleApply = () => {
    onApply(css);
  };

  const handleApplyAndClose = () => {
    onApply(css);
    onClose();
  };

  return (
    <div className="designer-comp-library-overlay">
      <div className="designer-page-style-editor" ref={panelRef}>
        <div className="designer-comp-library-header">
          <span className="designer-comp-library-title">页面样式</span>
          <button className="designer-comp-library-close" onClick={onClose} title="关闭 (ESC)">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M1 1l12 12M13 1L1 13" />
            </svg>
          </button>
        </div>

        <div className="designer-page-style-body">
          <div className="designer-page-style-hint">
            编辑当前页面的 <code>&lt;style&gt;</code> 标签中的 CSS。修改后点击「应用」即时生效。
          </div>
          <textarea
            ref={textareaRef}
            className="designer-page-style-textarea"
            value={css}
            onChange={e => setCss(e.target.value)}
            spellCheck={false}
            placeholder={`/* 在此编写自定义 CSS */\n.my-class {\n  color: red;\n}`}
          />
        </div>

        <div className="designer-page-style-footer">
          <button className="designer-prop-btn" onClick={onClose}>取消</button>
          <button className="designer-prop-btn primary" onClick={handleApply}>应用</button>
          <button className="designer-prop-btn primary" onClick={handleApplyAndClose}>应用并关闭</button>
        </div>
      </div>
    </div>
  );
}
