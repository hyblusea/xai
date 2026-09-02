import { useCallback, Fragment } from 'react';
import { X, MessageSquarePlus, RotateCcw, Crown, Star, StarOff } from 'lucide-react';
import type { SelectedElement, ElementStyle, DesignerScreen } from '@xai/shared';
import type { EditorOps, EditorDomState, EditorContext } from './properties/types';
import { BASIC_SECTIONS, ADVANCED_SECTION, matchEditors } from './properties/editorRegistry';
import { detectMasterLayoutType, masterLayoutTypeLabel } from '../../utils/masterLayoutDom';

interface ElementPropertiesPanelProps {
  element: SelectedElement | null;
  onStyleChange: (style: Partial<ElementStyle>) => void;
  onAddToChat: () => void;
  onClose: () => void;
  screens?: DesignerScreen[];
  selectOptions?: Array<{ label: string; value: string; selected: boolean }>;
  tableColumnWidth?: string;
  hasTableContext?: boolean;
  tableStickyLeft?: boolean;
  tableStickyRight?: boolean;
  tableStriped?: boolean;
  tabItems?: Array<{ id: string; label: string; active: boolean }>;
  onAddTableRow?: () => void;
  onAddTableColumn?: () => void;
  onRemoveTableRow?: () => void;
  onRemoveTableColumn?: () => void;
  onCopyTableRow?: () => void;
  onCopyTableColumn?: () => void;
  onTableColumnWidthChange?: (width: string) => void;
  onSelectOptionsChange?: (options: Array<{ label: string; value: string; selected: boolean }>) => void;
  onAddTab?: () => void;
  onRemoveTab?: (index: number) => void;
  onRenameTab?: (index: number, label: string) => void;
  // Tabs 扩展
  onSetActiveTab?: (index: number) => void;
  // 表格扩展
  onToggleTableStriped?: (enabled: boolean) => void;
  onMergeTableCell?: (direction: 'right' | 'down') => void;
  onToggleTableStickyColumn?: (side: 'left' | 'right', enabled: boolean) => void;
  // Accordion
  accordionItems?: Array<{ id: string; header: string; active: boolean }>;
  onAddAccordion?: () => void;
  onRemoveAccordion?: (index: number) => void;
  onRenameAccordion?: (index: number, header: string) => void;
  onToggleAccordion?: (index: number) => void;
  // Carousel
  carouselSlides?: Array<{ id: string; caption: string; active: boolean }>;
  carouselHasIndicators?: boolean;
  carouselHasControls?: boolean;
  onAddCarouselSlide?: () => void;
  onRemoveCarouselSlide?: (index: number) => void;
  onSetActiveCarouselSlide?: (index: number) => void;
  onRenameCarouselSlide?: (index: number, caption: string) => void;
  // Progress
  progressData?: { value: number; label: string; striped: boolean; animated: boolean; variant: string } | null;
  onUpdateProgress?: (updates: { value?: number; label?: string; striped?: boolean; animated?: boolean; variant?: string }) => void;
  // Badge
  badgeData?: { text: string; variant: string; pill: boolean } | null;
  onUpdateBadge?: (updates: { text?: string; variant?: string; pill?: boolean }) => void;
  // Dialog
  dialogData?: { title: string; sizeClass: string } | null;
  onUpdateDialog?: (updates: { title?: string; sizeClass?: string }) => void;
  // Button
  buttonData?: { variant: string; size: string; pill: boolean; block: boolean; disabled: boolean } | null;
  onUpdateButton?: (updates: { variant?: string; size?: string; pill?: boolean; block?: boolean; disabled?: boolean }) => void;
  // 共享母版：选中 <nav> 时显示"提升为共享主菜单"按钮（D7 入口点）
  // 可选回调，未传入时不渲染按钮（向后兼容：现有调用方零影响）
  onPromoteToMasterLayout?: () => void;
  /**
   * 菜单项一键高亮：选中 .nav-link / .nav-item 时显示"设为当前项"按钮。
   * isMenuItem 由 useSelectedDomState 依据实时 DOM 判定（排除 nav-tabs/面包屑/分页/dropdown-item）。
   * 未传回调时不渲染按钮（向后兼容）。
   */
  isMenuItem?: boolean;
  /** 该菜单项当前是否已 active（由 useSelectedDomState 解析）。用于按钮 toggle 文案。 */
  menuItemIsActive?: boolean;
  onSetAsCurrentMenuItem?: () => void;
  /**
   * 隐藏底部"添加到对话"按钮。
   * 母版编辑器等非对话场景传入 true；主设计器不传（默认 false，按钮正常显示）。
   */
  hideAddToChat?: boolean;
}

/**
 * Floating properties panel for the selected element.
 *
 * This component keeps its original flat Props signature (so DesignerCanvas
 * and other callers are unaffected). It now delegates rendering of property
 * sections to the editor registry (`./properties/editorRegistry`): it
 * aggregates the flat callbacks into domain `ops`/`domState` objects, builds
 * an `EditorContext`, and iterates the registered sections.
 *
 *   - BASIC_SECTIONS    → universal property sections (尺寸/位置/颜色/...)
 *   - matchEditors(ctx) → element-specific structural editors
 *   - ADVANCED_SECTION  → trailing 高级 section
 */
export default function ElementPropertiesPanel({
  element,
  onStyleChange,
  onAddToChat,
  onClose,
  screens = [],
  selectOptions = [],
  tableColumnWidth = '',
  hasTableContext = false,
  tableStickyLeft = false,
  tableStickyRight = false,
  tableStriped = false,
  tabItems = [],
  onAddTableRow,
  onAddTableColumn,
  onRemoveTableRow,
  onRemoveTableColumn,
  onCopyTableRow,
  onCopyTableColumn,
  onTableColumnWidthChange,
  onSelectOptionsChange,
  onAddTab,
  onRemoveTab,
  onRenameTab,
  onSetActiveTab,
  onToggleTableStriped,
  onMergeTableCell,
  onToggleTableStickyColumn,
  accordionItems,
  onAddAccordion,
  onRemoveAccordion,
  onRenameAccordion,
  onToggleAccordion,
  carouselSlides,
  carouselHasIndicators,
  carouselHasControls,
  onAddCarouselSlide,
  onRemoveCarouselSlide,
  onSetActiveCarouselSlide,
  onRenameCarouselSlide,
  progressData,
  onUpdateProgress,
  badgeData,
  onUpdateBadge,
  dialogData,
  onUpdateDialog,
  buttonData,
  onUpdateButton,
  onPromoteToMasterLayout,
  isMenuItem = false,
  menuItemIsActive = false,
  onSetAsCurrentMenuItem,
  hideAddToChat = false,
}: ElementPropertiesPanelProps) {
  const handleReset = useCallback(() => {
    if (!element) return;
    // 仅重置样式属性，保留内容属性（text/placeholder/value/href/src）
    onStyleChange({
      width: '',
      height: '',
      backgroundColor: '',
      backgroundImage: '',
      color: '',
      fontSize: '',
      padding: '',
      margin: '',
      borderRadius: '',
      border: '',
      textAlign: '',
      left: '',
      top: '',
      rotation: '',
      zIndex: '',
      opacity: '',
      boxShadow: '',
      filter: '',
      backdropFilter: '',
      linkType: '',
      linkTarget: '',
      overflowX: 'visible',
      overflowY: 'visible',
      tableMaxHeight: '',
      fontFamily: '',
      fontWeight: '',
      lineHeight: '',
      letterSpacing: '',
      textDecoration: '',
      textTransform: '',
      paddingTop: '',
      paddingRight: '',
      paddingBottom: '',
      paddingLeft: '',
      marginTop: '',
      marginRight: '',
      marginBottom: '',
      marginLeft: '',
      display: '',
      flexDirection: '',
      justifyContent: '',
      alignItems: '',
      flexWrap: '',
      gap: '',
      navbarOrientation: '',
    });
  }, [element, onStyleChange]);

  // Aggregate the flat callbacks into domain ops objects. Table/Tabs/
  // Accordion/Carousel fields stay optional (their sections render based on
  // domState, not ops presence); Select/Progress/Badge/Dialog/Button ops are
  // only constructed when their callback exists, so the registry's
  // `ops.X != null` match accurately reflects availability.
  const ops: EditorOps = {
    style: { onStyleChange },
    table: {
      onAddTableRow,
      onAddTableColumn,
      onRemoveTableRow,
      onRemoveTableColumn,
      onCopyTableRow,
      onCopyTableColumn,
      onTableColumnWidthChange,
      onToggleTableStriped,
      onMergeTableCell,
      onToggleTableStickyColumn,
    },
    tabs: {
      onAddTab,
      onRemoveTab,
      onRenameTab,
      onSetActiveTab,
    },
    accordion: {
      onAddAccordion,
      onRemoveAccordion,
      onRenameAccordion,
      onToggleAccordion,
    },
    carousel: {
      onAddCarouselSlide,
      onRemoveCarouselSlide,
      onSetActiveCarouselSlide,
      onRenameCarouselSlide,
    },
    selectOptions: onSelectOptionsChange ? { onChange: onSelectOptionsChange } : undefined,
    progress: onUpdateProgress ? { onUpdate: onUpdateProgress } : undefined,
    badge: onUpdateBadge ? { onUpdate: onUpdateBadge } : undefined,
    dialog: onUpdateDialog ? { onUpdate: onUpdateDialog } : undefined,
    button: onUpdateButton ? { onUpdate: onUpdateButton } : undefined,
  };

  const domState: EditorDomState = {
    selectOptions,
    tableColumnWidth,
    hasTableContext,
    tableStickyLeft,
    tableStickyRight,
    tableStriped,
    tabItems,
    accordionItems,
    carouselSlides,
    carouselHasIndicators,
    carouselHasControls,
    progressData,
    badgeData,
    dialogData,
    buttonData,
  };

  const ctx: EditorContext | null = element
    ? { element, ops, domState, screens }
    : null;

  return (
    <div className="designer-properties-panel">
      <div className="designer-properties-header">
        <div className="designer-properties-title">
          <span className="designer-properties-tag-name">{element?.tagName || '请选择元素'}</span>
          {element?.id && <span className="designer-properties-id">#{element.id}</span>}
          {element?.className && (
            <span className="designer-properties-class" title={element.className}>
              .{element.className.split(/\s+/)[0]}
            </span>
          )}
        </div>
        <button className="designer-properties-close" onClick={onClose} title="关闭">
          <X size={14} />
        </button>
      </div>

      {/* 共享母版入口（D7）：选中 nav/header/footer/aside 且外部传入了回调时显示。
       *  仅按 tagName 识别可提升的元素类型，避免影响其他元素的面板布局。
       *  未传 onPromoteToMasterLayout 的调用方不会渲染此按钮。 */}
      {element && onPromoteToMasterLayout && (() => {
        const promoteType = detectMasterLayoutType(element.tagName);
        if (!promoteType) return null;
        return (
          <button
            type="button"
            className="designer-prop-btn designer-promote-master-btn"
            onClick={onPromoteToMasterLayout}
            title={`把当前${masterLayoutTypeLabel(promoteType)}提升为项目级共享组件，所有页面自动同步`}
          >
            <Crown size={12} />
            提升为共享{masterLayoutTypeLabel(promoteType)}
          </button>
        );
      })()}

      {/* 菜单项一键设为当前页高亮项（toggle）：选中 .nav-link / .nav-item 时显示。
       * 便于观察测试/正式使用时人工指定当前菜单项（清除兄弟 active、展开其父级子菜单）。
       * toggle 语义：未高亮 → 点亮（设为当前项）；已高亮 → 再次点击取消。
       * 未传 onSetAsCurrentMenuItem 的调用方不渲染（向后兼容）。 */}
      {element && isMenuItem && onSetAsCurrentMenuItem && (() => {
        const active = menuItemIsActive;
        return (
          <button
            type="button"
            className={`designer-prop-btn designer-set-current-menu-btn${active ? ' is-active' : ''}`}
            onClick={onSetAsCurrentMenuItem}
            title={active
              ? '此项已是当前高亮项，再次点击取消高亮（保留父级子菜单展开态）'
              : '把此项设为当前页高亮菜单项：清除同级其它项的 active、展开其父级子菜单'}
          >
            {active ? <StarOff size={12} /> : <Star size={12} />}
            {active ? '取消当前项' : '设为当前项'}
          </button>
        );
      })()}

      <div className="designer-properties-body">
        {!element && (
          <div className="designer-properties-empty">
            选择画布中的元素后，这里可以直接编辑尺寸、间距、文本、颜色、链接、表格、下拉框和 Tabs。
          </div>
        )}

        {ctx && (
          <>
            {BASIC_SECTIONS.filter(s => s.match(ctx)).map(s => (
              <Fragment key={s.id}>{s.render(ctx)}</Fragment>
            ))}
            {matchEditors(ctx).map(e => (
              <Fragment key={e.id}>{e.render(ctx)}</Fragment>
            ))}
            {ADVANCED_SECTION.match(ctx) && ADVANCED_SECTION.render(ctx)}
          </>
        )}
      </div>

      <div className="designer-properties-footer">
        <button className="designer-prop-btn" onClick={handleReset} title="重置样式">
          <RotateCcw size={12} />
          重置
        </button>
        {!hideAddToChat && (
          <button
            className="designer-prop-btn primary"
            onClick={onAddToChat}
            title="添加到对话让 AI 修改"
            disabled={!element}
          >
            <MessageSquarePlus size={12} />
            添加到对话
          </button>
        )}
      </div>
    </div>
  );
}
