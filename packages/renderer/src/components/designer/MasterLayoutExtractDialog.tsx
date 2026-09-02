import { useMemo, useState, useCallback } from 'react';
import { Crown, X, Check, AlertTriangle, RefreshCw } from 'lucide-react';
import type { MasterLayout, MasterLayoutType } from '@xai/shared';
import { extractMasterLayoutFromElement } from '../../utils/masterLayoutExtract';
import { buildSlotPlaceholder, masterLayoutTypeLabel, defaultSlotName } from '../../utils/masterLayoutDom';

interface MasterLayoutExtractDialogProps {
  /** 选中元素（nav/header/footer/aside）的 outerHTML（由 DesignerCanvas 从 iframe DOM 中提取并传入）。 */
  outerHtml: string;
  /** 元素的 selector（用于 extractMasterLayout 反查源节点）。 */
  selector: string;
  /** layout 类型（由选中元素 tagName 判定，决定 slotName）。 */
  type: MasterLayoutType;
  /** 当前页面 id（提取来源）。 */
  sourceScreenId: string;
  /** 项目所有页面（保留接口兼容，内部不再用于菜单项绑定）。 */
  screens: { id: string; name?: string }[];
  /** 同类型已存在的 MasterLayout 数量（MVP 限制每类型 ≤1）。 */
  existingLayoutsCount: number;
  /** 源 iframe 的 contentDocument（用于抽取相关 CSS 规则，可选）。 */
  sourceDoc?: Document;
  /** 确认提取：传入用户调整后的 layout。 */
  onConfirm: (layout: MasterLayout, sourceScreenId: string, selector: string) => void | Promise<void>;
  onClose: () => void;
}

/**
 * 提取对话框（§6.2 / §7.2）。
 *
 * 输入：用户在画布选中 nav/header/footer/aside，DesignerCanvas 把元素的 outerHTML + selector +
 * type + 当前 screenId 传入。
 * 流程：
 *  1. 用 extractMasterLayoutFromElement 自动解析 + 生成 layout 雏形
 *  2. 显示双栏预览（左：将提取的元素 HTML；右：源页面元素→slot 后效果）
 *  3. 确认 → onConfirm(layout, sourceScreenId, selector) 由 useDesignerAgent.extractMasterLayout 落库
 *
 * 菜单项高亮由 scoreMenuMatch 文本匹配驱动（注入时自动计算），无需手动绑定。
 *
 * MVP 限制：一个项目每种类型最多 1 个 MasterLayout（§6.8.4）。已达上限时显示提示但仍允许查看。
 * 类型由选中元素 tagName 决定（nav→menu, header→header, footer→footer, aside→sidebar），
 * 用户不可在此对话框更改类型。
 */
export default function MasterLayoutExtractDialog({
  outerHtml,
  selector,
  type,
  sourceScreenId,
  existingLayoutsCount,
  sourceDoc,
  onConfirm,
  onClose,
}: MasterLayoutExtractDialogProps) {
  // 临时 div 解析元素 HTML 为 HTMLElement，复用 extractMasterLayoutFromElement
  const initialLayout = useMemo(() => {
    const container = document.createElement('div');
    container.innerHTML = outerHtml;
    const el = container.firstElementChild as HTMLElement | null;
    if (!el) {
      // 兜底：构造一个空 layout，避免后续 .map 崩溃
      const now = new Date().toISOString();
      const empty: MasterLayout = {
        id: `ml-${Date.now()}`,
        name: masterLayoutTypeLabel(type),
        type,
        html: outerHtml,
        menuItems: [],
        applyTo: { mode: 'all' },
        slotName: defaultSlotName(type),
        createdAt: now,
        updatedAt: now,
      };
      return empty;
    }
    const { layout } = extractMasterLayoutFromElement(el, masterLayoutTypeLabel(type), type, sourceDoc);
    return layout;
  }, [outerHtml, type, sourceDoc]);

  const [name, setName] = useState(initialLayout.name);
  const [applying, setApplying] = useState(false);

  // 源页面 元素→slot 后的预览 HTML
  const slottedPreview = useMemo(() => {
    const slotName = initialLayout.slotName;
    const placeholder = buildSlotPlaceholder(name || masterLayoutTypeLabel(type));
    return `<div data-design-slot="${slotName}">\n  ${placeholder}\n</div>`;
  }, [initialLayout.slotName, name, type]);

  const handleConfirm = useCallback(async () => {
    setApplying(true);
    try {
      const now = new Date().toISOString();
      const layout: MasterLayout = {
        ...initialLayout,
        name: name.trim() || masterLayoutTypeLabel(type),
        type,
        menuItems: [], // menuItems 不再使用，高亮由 scoreMenuMatch 驱动
        updatedAt: now,
      };
      await onConfirm(layout, sourceScreenId, selector);
    } finally {
      setApplying(false);
    }
  }, [initialLayout, name, type, onConfirm, sourceScreenId, selector]);

  const reachedLimit = existingLayoutsCount >= 1;
  const typeLabel = masterLayoutTypeLabel(type);

  return (
    <div className="designer-dialog-overlay" onClick={applying ? undefined : onClose}>
      <div className="designer-dialog designer-master-extract-dialog" onClick={e => e.stopPropagation()}>
        <div className="designer-dialog-header">
          <span className="designer-dialog-title">
            <Crown size={14} style={{ verticalAlign: 'middle', marginRight: 6, color: '#d97706' }} />
            提取为共享{typeLabel}
          </span>
          <button className="designer-dialog-close" onClick={onClose} disabled={applying}>
            <X size={14} />
          </button>
        </div>

        <div className="designer-dialog-body" style={{ display: 'flex', flexDirection: 'column', padding: 0, flex: 1, minHeight: 0, overflow: 'hidden' }}>
          {reachedLimit && (
            <div style={{ padding: '8px 12px', background: 'rgba(245, 158, 11, 0.1)', color: '#92400e', fontSize: 11, borderBottom: '1px solid var(--border)' }}>
              <AlertTriangle size={11} style={{ verticalAlign: 'middle', marginRight: 4 }} />
              当前项目已有一个共享{typeLabel}（MVP 限制每类型 1 个）。继续将覆盖现有{typeLabel}。
            </div>
          )}

          {/* 名称 + 类型（只读） */}
          <div style={{ display: 'flex', gap: 12, padding: '12px 12px 0' }}>
            <div style={{ flex: 1 }}>
              <label className="designer-prop-label">名称</label>
              <input
                type="text"
                className="designer-prop-input"
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder={typeLabel}
                style={{ width: '100%' }}
              />
            </div>
            <div style={{ width: 140 }}>
              <label className="designer-prop-label">类型</label>
              <input
                type="text"
                className="designer-prop-input"
                value={`${typeLabel} (${type})`}
                readOnly
                style={{ width: '100%', color: 'var(--text-secondary)' }}
                title="类型由选中元素的标签决定，不可更改"
              />
            </div>
          </div>

          {/* 作用域提示（MVP 仅"全部页面"） */}
          <div style={{ padding: '4px 12px 0', fontSize: 11, color: 'var(--text-secondary)' }}>
            作用域：<strong>全部页面</strong>（MVP 仅支持此模式，按文件夹指定将在 v2 提供）
          </div>

          {/* 双栏预览 */}
          <div className="master-extract-preview">
            <div className="master-extract-preview-col">
              <div className="master-extract-preview-label">将提取的{typeLabel} HTML（独立保存为共享组件）</div>
              <div className="master-extract-preview-box">{outerHtml}</div>
            </div>
            <div className="master-extract-preview-col">
              <div className="master-extract-preview-label">源页面将变为（元素替换为 slot 占位）</div>
              <div className="master-extract-preview-box">{slottedPreview}</div>
            </div>
          </div>
        </div>

        <div className="designer-dialog-footer">
          <button className="designer-dialog-btn cancel" onClick={onClose} disabled={applying}>取消</button>
          <button
            className="designer-dialog-btn primary"
            onClick={handleConfirm}
            disabled={applying || !name.trim()}
          >
            {applying ? <RefreshCw size={12} className="spin" /> : <Check size={12} />}
            {applying ? '提取中...' : '确认提取'}
          </button>
        </div>
      </div>
    </div>
  );
}
