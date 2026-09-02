import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Crown, X, Check, RefreshCw, Trash2, Code2, Eye, MousePointer2 } from 'lucide-react';
import type { MasterLayout, DesignerProject, MasterLayoutType } from '@xai/shared';
import MasterLayoutEditor from './MasterLayoutEditor';
import SourceMonacoEditor from './SourceMonacoEditor';
import { masterLayoutTypeLabel } from '../../utils/masterLayoutDom';
import { postProcessDesignerHtml } from '../../utils/designerScrollbar';
import { buildPreviewDocument, injectResponsiveOverride } from '../../utils/masterLayoutPreview';

interface MasterLayoutDialogProps {
  project: DesignerProject;
  onClose: () => void;
  /** 保存母版编辑并同步到所有页面（useDesignerAgent.applyMasterLayoutEdit）。 */
  onSave: (layout: MasterLayout) => Promise<void>;
  /** 删除母版（useDesignerAgent.deleteMasterLayout）。 */
  onDelete: (layoutId: string) => Promise<void>;
}

type TabKey = 'visual' | 'source';
/** 源码 tab 内的子编辑器：HTML 片段 / CSS / 脚本。 */
type SourceSubTab = 'html' | 'css' | 'scripts';

/** 母版类型显示顺序（顶部 tab 顺序）。 */
const TYPE_ORDER: MasterLayoutType[] = ['menu', 'header', 'footer', 'sidebar'];

/** Per-type draft map。null 表示该类型当前无 layout。 */
type DraftMap = Record<MasterLayoutType, MasterLayout | null>;

/** Per-type source-text map（源码 tab 的 textarea 值）。 */
type SourceTextMap = Record<MasterLayoutType, string>;

function emptyDraftMap(): DraftMap {
  return { menu: null, header: null, footer: null, sidebar: null };
}
function emptySourceTextMap(): SourceTextMap {
  return { menu: '', header: '', footer: '', sidebar: '' };
}

/**
 * 共享母版管理对话框（§6.5.1 / §7.3）。
 *
 * 顶部类型 tab（menu/header/footer/sidebar）切换不同类型的母版管理；每类型 MVP 限制 ≤1。
 *
 * 双 tab 设计：
 *  - 可视化 tab：MasterLayoutEditor —— 复用主设计器的选择模式 + 属性面板 +
 *    图层树，对任意 DOM 元素直接点选编辑（类型无关）。
 *  - 源码 tab：textarea 直接编辑 MasterLayout.html + 实时 iframe 预览。
 *
 * menuItems 已废弃（高亮由 scoreMenuMatch 文本匹配驱动，无需结构化绑定数据），
 * 保存时统一设 menuItems: []。
 *
 * 保存流程：onSave → applyMasterLayoutEdit → 后端 InjectAll + 本地重新注入。
 * 独立状态：本对话框维护本地编辑副本，不影响 useDesignerAgent 的 screen 状态（D15）。
 */
export default function MasterLayoutDialog({
  project,
  onClose,
  onSave,
  onDelete,
}: MasterLayoutDialogProps) {
  const existingLayouts = project.masterLayouts ?? [];

  // 默认激活第一个已有 layout 的类型，否则 'menu'
  const [activeType, setActiveType] = useState<MasterLayoutType>(() =>
    existingLayouts[0]?.type ?? 'menu',
  );

  // Per-type 本地编辑副本（独立于 useDesignerAgent 的 currentProject 状态，D15）
  const [drafts, setDrafts] = useState<DraftMap>(() => {
    const init = emptyDraftMap();
    for (const l of existingLayouts) init[l.type] = { ...l };
    return init;
  });

  const [tab, setTab] = useState<TabKey>('visual');
  // 源码 tab 内当前激活的子编辑器（HTML / CSS / 脚本）
  const [sourceSubTab, setSourceSubTab] = useState<SourceSubTab>('html');
  // 选择模式开关（传给 MasterLayoutEditor）：true=选择元素，false=交互预览
  const [selectMode, setSelectMode] = useState(true);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [sourcePreviewHtml, setSourcePreviewHtml] = useState('');

  // Per-type 源码 textarea 值（与 draft.* 分离，避免每次按键都触发重渲染）
  const [sourceTexts, setSourceTexts] = useState<SourceTextMap>(() => {
    const init = emptySourceTextMap();
    for (const l of existingLayouts) init[l.type] = l.html || '';
    return init;
  });
  // CSS / 脚本 源码文本（此前源码 tab 只能编 HTML，CSS/scripts 无文本编辑入口）
  const [sourceCssTexts, setSourceCssTexts] = useState<SourceTextMap>(() => {
    const init = emptySourceTextMap();
    for (const l of existingLayouts) init[l.type] = l.css || '';
    return init;
  });
  const [sourceScriptsTexts, setSourceScriptsTexts] = useState<SourceTextMap>(() => {
    const init = emptySourceTextMap();
    for (const l of existingLayouts) init[l.type] = l.scripts || '';
    return init;
  });

  // ── 拖拽标题栏移动弹窗（初始 null = 居中显示，拖拽后切到 absolute 定位）──
  const [dialogPos, setDialogPos] = useState<{ x: number; y: number } | null>(null);
  const isDraggingRef = useRef(false);
  const dragStartRef = useRef({ x: 0, y: 0 });
  const dragOriginRef = useRef({ x: 0, y: 0 });

  const handleHeaderMouseDown = useCallback((e: React.MouseEvent) => {
    // 左键且非点击在按钮上时才开始拖拽（避免点关闭按钮时误触发）
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest('button')) return;
    e.preventDefault();
    const dialogEl = (e.currentTarget as HTMLElement).closest('.designer-master-dialog') as HTMLElement | null;
    const rect = dialogEl?.getBoundingClientRect();
    // 首次拖拽时以当前居中位置作为起点，后续从已记录位置继续
    const startX = rect ? rect.left : 0;
    const startY = rect ? rect.top : 0;
    if (dialogPos === null) setDialogPos({ x: startX, y: startY });
    dragStartRef.current = { x: e.clientX, y: e.clientY };
    dragOriginRef.current = { x: startX, y: startY };
    isDraggingRef.current = true;
  }, [dialogPos]);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDraggingRef.current) return;
      const dx = e.clientX - dragStartRef.current.x;
      const dy = e.clientY - dragStartRef.current.y;
      setDialogPos({
        x: dragOriginRef.current.x + dx,
        y: dragOriginRef.current.y + dy,
      });
    };
    const handleMouseUp = () => {
      isDraggingRef.current = false;
    };
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, []);

  const draft = drafts[activeType];
  const sourceText = sourceTexts[activeType];
  const sourceCssText = sourceCssTexts[activeType];
  const sourceScriptsText = sourceScriptsTexts[activeType];

  // 当 draft.html 变化时，同步到对应类型的 sourceText（仅可视化 tab → 源码 tab 单向同步）
  useEffect(() => {
    if (tab === 'source' && draft && sourceText !== draft.html) {
      setSourceTexts(prev => ({ ...prev, [activeType]: draft.html }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft?.html, tab, activeType]);

  // draft.css / draft.scripts 变化时同步到源码文本（可视化 tab 改了 CSS/脚本 → 源码 tab 跟随）
  useEffect(() => {
    if (tab === 'source' && draft && sourceCssText !== (draft.css || '')) {
      setSourceCssTexts(prev => ({ ...prev, [activeType]: draft.css || '' }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft?.css, tab, activeType]);

  useEffect(() => {
    if (tab === 'source' && draft && sourceScriptsText !== (draft.scripts || '')) {
      setSourceScriptsTexts(prev => ({ ...prev, [activeType]: draft.scripts || '' }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft?.scripts, tab, activeType]);

  // 源码 tab 实时预览
  useEffect(() => {
    if (tab !== 'source' || !sourceText) {
      setSourcePreviewHtml('');
      return;
    }
    const fullDoc = buildPreviewDocument(sourceText, draft?.css, draft?.scripts);
    const processed = injectResponsiveOverride(postProcessDesignerHtml(fullDoc, project.type, project.themePrompt));
    setSourcePreviewHtml(processed);
  }, [tab, sourceText, draft?.css, draft?.scripts, project.type, project.themePrompt]);

  const hasLayout = !!draft;
  const typeLabel = masterLayoutTypeLabel(activeType);

  // 可视化 tab 编辑回调：仅 html 变更（menuItems 已废弃，保存时统一设 []）
  const handleCanvasChange = useCallback((updates: { html?: string }) => {
    setDrafts(prev => {
      const existing = prev[activeType];
      if (!existing) return prev;
      return { ...prev, [activeType]: { ...existing, ...updates, updatedAt: new Date().toISOString() } };
    });
  }, [activeType]);

  // 源码 tab 编辑：html 变更（menuItems 已废弃，保存时统一设 []）
  const handleSourceChange = useCallback((value: string) => {
    setSourceTexts(prev => ({ ...prev, [activeType]: value }));
    setDrafts(prev => {
      const existing = prev[activeType];
      if (!existing) return prev;
      return { ...prev, [activeType]: { ...existing, html: value, menuItems: [], updatedAt: new Date().toISOString() } };
    });
  }, [activeType]);

  // 源码 tab 编辑：CSS 变更
  const handleSourceCssChange = useCallback((value: string) => {
    setSourceCssTexts(prev => ({ ...prev, [activeType]: value }));
    setDrafts(prev => {
      const existing = prev[activeType];
      if (!existing) return prev;
      return { ...prev, [activeType]: { ...existing, css: value, updatedAt: new Date().toISOString() } };
    });
  }, [activeType]);

  // 源码 tab 编辑：脚本变更
  const handleSourceScriptsChange = useCallback((value: string) => {
    setSourceScriptsTexts(prev => ({ ...prev, [activeType]: value }));
    setDrafts(prev => {
      const existing = prev[activeType];
      if (!existing) return prev;
      return { ...prev, [activeType]: { ...existing, scripts: value, updatedAt: new Date().toISOString() } };
    });
  }, [activeType]);

  // 名称变更
  const handleNameChange = useCallback((value: string) => {
    setDrafts(prev => {
      const existing = prev[activeType];
      if (!existing) return prev;
      return { ...prev, [activeType]: { ...existing, name: value, updatedAt: new Date().toISOString() } };
    });
  }, [activeType]);

  const handleSave = useCallback(async () => {
    if (!draft) return;
    setSaving(true);
    try {
      // menuItems 已废弃，保存时统一设 []（注入管线只用 html + slotName）
      await onSave({ ...draft, menuItems: [] });
      // onSave 成功后由父组件关闭对话框（避免提前关闭看不到错误 toast）
    } finally {
      setSaving(false);
    }
  }, [draft, onSave]);

  const handleDelete = useCallback(async () => {
    if (!draft) return;
    if (!window.confirm(`确认删除共享${typeLabel}"${draft.name}"？\n\n已注入的页面会保留现有${typeLabel}快照（不会立即消失），但后续修改不再同步。`)) {
      return;
    }
    setDeleting(true);
    try {
      await onDelete(draft.id);
      // 清空本地 draft（后端已删除）
      setDrafts(prev => ({ ...prev, [activeType]: null }));
      setSourceTexts(prev => ({ ...prev, [activeType]: '' }));
      setSourceCssTexts(prev => ({ ...prev, [activeType]: '' }));
      setSourceScriptsTexts(prev => ({ ...prev, [activeType]: '' }));
    } finally {
      setDeleting(false);
    }
  }, [draft, onDelete, activeType, typeLabel]);

  const handleSaveAndClose = useCallback(async () => {
    if (!draft) {
      onClose();
      return;
    }
    setSaving(true);
    try {
      await onSave({ ...draft, menuItems: [] });
      onClose();
    } finally {
      setSaving(false);
    }
  }, [draft, onSave, onClose]);

  // dirty 仅比较当前激活类型的 draft 与原始 layout（含 html/css/scripts/name）
  const dirty = useMemo(() => {
    const original = existingLayouts.find(l => l.type === activeType);
    if (!original || !draft) return false;
    return original.html !== draft.html ||
           original.css !== draft.css ||
           original.scripts !== draft.scripts ||
           original.name !== draft.name;
  }, [existingLayouts, draft, activeType]);

  return (
    <div className="designer-dialog-overlay designer-master-dialog-overlay">
      <div
        className="designer-dialog designer-master-dialog designer-master-dialog--draggable"
        style={dialogPos ? { left: dialogPos.x, top: dialogPos.y } : undefined}
      >
        <div className="designer-dialog-header designer-master-dialog-header" onMouseDown={handleHeaderMouseDown}>
          <span className="designer-dialog-title">
            <Crown size={14} style={{ verticalAlign: 'middle', marginRight: 6, color: '#d97706' }} />
            共享组件管理
          </span>
          <button className="designer-dialog-close" onClick={onClose} disabled={saving || deleting}>
            <X size={14} />
          </button>
        </div>

        {/* 顶部类型 tab：menu / header / footer / sidebar */}
        <div className="designer-master-type-tabs">
          {TYPE_ORDER.map(t => {
            const has = !!drafts[t];
            const isActive = t === activeType;
            return (
              <button
                key={t}
                className={`designer-master-type-tab ${isActive ? 'active' : ''} ${has ? 'has-layout' : ''}`}
                onClick={() => setActiveType(t)}
                title={has ? `管理共享${masterLayoutTypeLabel(t)}` : `尚无共享${masterLayoutTypeLabel(t)}`}
              >
                {masterLayoutTypeLabel(t)}
                {has && <span className="designer-master-type-tab-dot" />}
              </button>
            );
          })}
        </div>

        <div className="designer-master-dialog-body">
          {!hasLayout ? (
            <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-secondary)', fontSize: 12, flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 8 }}>
              <Crown size={32} color="#d97706" />
              <div>当前项目还没有共享{typeLabel}</div>
              <div style={{ fontSize: 11 }}>
                在画布中选中{' '}
                {activeType === 'menu' ? <code>&lt;nav&gt;</code>
                  : activeType === 'header' ? <code>&lt;header&gt;</code>
                  : activeType === 'footer' ? <code>&lt;footer&gt;</code>
                  : <code>&lt;aside&gt;</code>}{' '}
                元素，点击属性面板上的"提升为共享{typeLabel}"按钮即可创建。
              </div>
            </div>
          ) : (
            <>
              {/* 顶部信息条：名称 / slot / 删除 */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 12px', borderBottom: '1px solid var(--border)', background: 'var(--bg-sidebar)', flexShrink: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <label style={{ fontSize: 11, color: 'var(--text-secondary)' }}>名称:</label>
                  <input
                    type="text"
                    value={draft!.name}
                    onChange={e => handleNameChange(e.target.value)}
                    className="designer-prop-input"
                    style={{ width: 160, fontSize: 11, padding: '3px 6px' }}
                  />
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                  slot: <code style={{ background: 'var(--bg-input)', padding: '1px 4px', borderRadius: 3 }}>{draft!.slotName}</code>
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                  类型: <strong>{typeLabel}</strong>
                </div>
                <div style={{ flex: 1 }} />
                {dirty && (
                  <span style={{ fontSize: 10, color: '#d97706', display: 'flex', alignItems: 'center', gap: 3 }}>
                    <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#d97706' }} />
                    未保存
                  </span>
                )}
                {tab === 'visual' && (
                  <button
                    className={`designer-toolbar-btn ${selectMode ? 'active' : ''}`}
                    onClick={() => setSelectMode(prev => !prev)}
                    title={selectMode ? '退出选择模式（可点击控件交互预览）' : '选择元素模式'}
                  >
                    <MousePointer2 size={12} />
                    {selectMode ? '选择中' : '选择'}
                  </button>
                )}
                <button
                  className="designer-dialog-btn"
                  onClick={handleDelete}
                  disabled={deleting}
                  style={{ fontSize: 11, padding: '3px 8px', color: '#dc2626', borderColor: 'rgba(220, 38, 38, 0.3)' }}
                  title={`删除共享${typeLabel}（已注入页面保留快照）`}
                >
                  <Trash2 size={11} /> 删除
                </button>
              </div>

              {/* Tabs: 可视化 / 源码 */}
              <div className="designer-master-tabs">
                <button
                  className={`designer-master-tab ${tab === 'visual' ? 'active' : ''}`}
                  onClick={() => setTab('visual')}
                >
                  <Crown size={12} /> 可视化编辑
                </button>
                <button
                  className={`designer-master-tab ${tab === 'source' ? 'active' : ''}`}
                  onClick={() => setTab('source')}
                >
                  <Code2 size={12} /> 源码编辑
                </button>
              </div>

              {/* Tab Content */}
              <div className="designer-master-tab-content">
                {tab === 'visual' ? (
                  <MasterLayoutEditor
                    layout={draft!}
                    screens={project.screens}
                    projectType={project.type}
                    themePrompt={project.themePrompt}
                    onChange={handleCanvasChange}
                    selectMode={selectMode}
                  />
                ) : (
                  <div className="designer-master-source-tab">
                    {/* 源码子 tab：HTML / CSS / 脚本。
                     * 此前源码 tab 只能编 HTML，CSS/scripts 无文本编辑入口，导致用户
                     * 无法修改 .sidebar .nav-link.active 等样式规则。补齐三段编辑。 */}
                    <div className="designer-master-source-subtabs">
                      {([
                        { key: 'html', label: 'HTML' },
                        { key: 'css', label: 'CSS' },
                        { key: 'scripts', label: '脚本' },
                      ] as const).map(s => (
                        <button
                          key={s.key}
                          className={`designer-master-source-subtab ${sourceSubTab === s.key ? 'active' : ''}`}
                          onClick={() => setSourceSubTab(s.key)}
                        >
                          {s.label}
                        </button>
                      ))}
                    </div>
                    <SourceMonacoEditor
                      language={sourceSubTab === 'html' ? 'html' : sourceSubTab === 'css' ? 'css' : 'javascript'}
                      value={sourceSubTab === 'html' ? sourceText
                        : sourceSubTab === 'css' ? sourceCssText
                        : sourceScriptsText}
                      onChange={
                        sourceSubTab === 'html' ? handleSourceChange
                        : sourceSubTab === 'css' ? handleSourceCssChange
                        : handleSourceScriptsChange
                      }
                    />
                    <div style={{ fontSize: 11, color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: 4 }}>
                      <Eye size={11} /> 实时预览（HTML + CSS + 脚本 合并渲染；保存后菜单项列表会按此 HTML 重新解析）
                    </div>
                    <div className="designer-master-source-preview">
                      <iframe
                        title="master-layout-source-preview"
                        srcDoc={sourcePreviewHtml}
                        sandbox="allow-same-origin allow-scripts"
                        onLoad={e => {
                          // 阻止 <a href="#"> 触发顶层导航（同 MasterLayoutEditor）
                          const doc = (e.currentTarget as HTMLIFrameElement).contentDocument;
                          if (!doc) return;
                          doc.addEventListener('click', (ev: MouseEvent) => {
                            const t = ev.target as HTMLElement;
                            if (t.closest('a')) ev.preventDefault();
                          }, true);
                        }}
                      />
                    </div>
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        <div className="designer-dialog-footer">
          <button className="designer-dialog-btn cancel" onClick={onClose} disabled={saving || deleting}>关闭</button>
          {hasLayout && (
            <button
              className="designer-dialog-btn primary"
              onClick={handleSaveAndClose}
              disabled={saving || deleting || !dirty}
            >
              {saving ? <RefreshCw size={12} className="spin" /> : <Check size={12} />}
              {saving ? '保存中...' : '保存并应用'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// buildPreviewDocument / extractBodyContent 已收敛到
// ../../utils/masterLayoutPreview.ts（与 MasterLayoutEditor 共用，Bug E 修复）。
