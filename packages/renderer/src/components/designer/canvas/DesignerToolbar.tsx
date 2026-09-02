import {
  Monitor, Tablet, Smartphone, Download, RefreshCw, Palette, Copy, Check,
  ZoomIn, ZoomOut, Maximize2, MousePointer2, ChevronLeft,
  ChevronRight, Undo2, Redo2, Code2, Globe, Save, SaveAll, Layers, Play,
  FilePlus2, Component, FileCode2, Crown, Image as ImageIcon,
} from 'lucide-react';
import { ZOOM_MIN, ZOOM_MAX, type DeviceMode } from './types';

interface DesignerToolbarProps {
  deviceMode: DeviceMode;
  onDeviceModeChange: (mode: DeviceMode) => void;
  zoom: number;
  zoomPercent: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onZoomReset: () => void;
  onZoomFit: () => void;
  hasMultipleScreens: boolean;
  currentScreenIndex: number;
  screensLength: number;
  /** Whether a screen is currently selected (edit/run/theme need this). */
  hasCurrentScreen: boolean;
  onPrevPage: () => void;
  onNextPage: () => void;
  isGenerating: boolean;
  selectMode: boolean;
  onSelectToggle: () => void;
  /** Whether the layer panel is currently visible (toggled in select mode). */
  layerPanelVisible: boolean;
  /** Toggle the layer panel visibility. */
  onToggleLayerPanel: () => void;
  onApplyTheme: () => void;
  onRunToggle: () => void;
  onRefresh: () => void;
  exportHtml?: string;
  copied: boolean;
  onCopy: () => void;
  /** Copy the current screen as a full-page PNG image to clipboard. */
  onCopyPng: () => void;
  /** Whether the PNG has been successfully copied (for feedback animation). */
  pngCopied: boolean;
  onExport: () => void;
  onExportVue: () => void;
  onPublish: () => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  /** Manually save the current screen (Ctrl+S / toolbar button). */
  onSave: () => void;
  /** Whether the current screen has unsaved manual edits. */
  isCurrentDirty: boolean;
  /** Save all dirty screens at once. */
  onSaveAll: () => void;
  /** Whether there are ANY dirty screens in the project. */
  hasDirtyScreens: boolean;
  /** Whether a project is currently loaded (enables "new blank screen"). */
  hasCurrentProject: boolean;
  /** Create a new blank screen and load it onto the canvas. */
  onCreateBlankScreen: () => void;
  /** Toggle the component library popup visibility. */
  onToggleComponentLibrary: () => void;
  /** Whether the component library popup is currently visible. */
  componentLibraryVisible: boolean;
  /** Toggle the page style editor popup. */
  onTogglePageStyle: () => void;
  /** Whether the page style editor is currently visible. */
  pageStyleVisible: boolean;
  /** 共享菜单：打开管理对话框（D7 入口点之一）。可选，未传入不渲染按钮。 */
  onOpenMasterLayout?: () => void;
  /** 共享菜单：当前项目是否已启用（用于按钮高亮提示）。 */
  hasMasterLayout?: boolean;
  /** Whether this is a DIAGRAM project (hides HTML-prototype-specific buttons). */
  isDiagramProject?: boolean;
}

/** Top toolbar of the designer canvas: device, zoom, page nav, mode toggles, export. */
export default function DesignerToolbar({
  deviceMode,
  onDeviceModeChange,
  zoom,
  zoomPercent,
  onZoomIn,
  onZoomOut,
  onZoomReset,
  onZoomFit,
  hasMultipleScreens,
  currentScreenIndex,
  screensLength,
  hasCurrentScreen,
  onPrevPage,
  onNextPage,
  isGenerating,
  selectMode,
  onSelectToggle,
  layerPanelVisible,
  onToggleLayerPanel,
  onApplyTheme,
  onRunToggle,
  onRefresh,
  exportHtml,
  copied,
  onCopy,
  onCopyPng,
  pngCopied,
  onExport,
  onExportVue,
  onPublish,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  onSave,
  isCurrentDirty,
  onSaveAll,
  hasDirtyScreens,
  hasCurrentProject,
  onCreateBlankScreen,
  onToggleComponentLibrary,
  componentLibraryVisible,
  onTogglePageStyle,
  pageStyleVisible,
  onOpenMasterLayout,
  hasMasterLayout,
  isDiagramProject,
}: DesignerToolbarProps) {
  return (
    <div className="designer-toolbar">
      <div className="designer-toolbar-left">
        <span style={{ fontSize: 11, color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: 4 }}>
          <Palette size={12} />
          Designer
        </span>
        {/* Undo / Redo */}
        <button
          className="designer-device-btn"
          onClick={onUndo}
          disabled={!canUndo || isGenerating}
          title="撤销 (Ctrl+Z)"
        >
          <Undo2 size={14} />
        </button>
        <button
          className="designer-device-btn"
          onClick={onRedo}
          disabled={!canRedo || isGenerating}
          title="重做 (Ctrl+Shift+Z)"
        >
          <Redo2 size={14} />
        </button>
        <button
          className="designer-device-btn"
          onClick={onSave}
          disabled={!isCurrentDirty || isGenerating}
          title="保存 (Ctrl+S)"
        >
          <Save size={14} />
        </button>
        <button
          className="designer-device-btn"
          onClick={onSaveAll}
          disabled={!hasDirtyScreens || isGenerating}
          title="保存全部"
        >
          <SaveAll size={14} />
          <span style={{ fontSize: 10, lineHeight: 1, marginLeft: -2 }}></span>
        </button>
        {/* New blank screen — manual design entry point (hidden for diagram projects) */}
        {!isDiagramProject && (
          <button
            className="designer-device-btn"
            onClick={onCreateBlankScreen}
            disabled={!hasCurrentProject || isGenerating}
            title="新建空白页（手动设计）"
          >
            <FilePlus2 size={14} />
          </button>
        )}
        {selectMode && (
          <span className="designer-mode-badge">编辑模式</span>
        )}
      </div>

      <div className="designer-toolbar-center">
        {!isDiagramProject && (
          <>
            <button
              className={`designer-device-btn ${deviceMode === 'desktop' ? 'active' : ''}`}
              onClick={() => onDeviceModeChange('desktop')}
              title="Desktop"
            >
              <Monitor size={14} />
            </button>
            <button
              className={`designer-device-btn ${deviceMode === 'tablet' ? 'active' : ''}`}
              onClick={() => onDeviceModeChange('tablet')}
              title="Tablet"
            >
              <Tablet size={14} />
            </button>
            <button
              className={`designer-device-btn ${deviceMode === 'mobile' ? 'active' : ''}`}
              onClick={() => onDeviceModeChange('mobile')}
              title="Mobile"
            >
              <Smartphone size={14} />
            </button>
          </>
        )}

        <div className="designer-toolbar-separator" />

        {/* Zoom controls */}
        <button className="designer-device-btn" onClick={onZoomOut} title="缩小" disabled={zoom <= ZOOM_MIN}>
          <ZoomOut size={14} />
        </button>
        <button className="designer-zoom-display" onClick={onZoomReset} title="重置缩放">
          {zoomPercent}%
        </button>
        <button className="designer-device-btn" onClick={onZoomIn} title="放大" disabled={zoom >= ZOOM_MAX}>
          <ZoomIn size={14} />
        </button>
        <button className="designer-device-btn" onClick={onZoomFit} title="适应窗口">
          <Maximize2 size={14} />
        </button>

        {/* Page navigation */}
        {hasMultipleScreens && !isGenerating && (
          <>
            <div className="designer-toolbar-separator" />
            <button
              className="designer-device-btn"
              onClick={onPrevPage}
              disabled={currentScreenIndex <= 0}
              title="上一页"
            >
              <ChevronLeft size={14} />
            </button>
            <span className="designer-page-indicator">
              {currentScreenIndex >= 0 ? currentScreenIndex + 1 : 1} / {screensLength}
            </span>
            <button
              className="designer-device-btn"
              onClick={onNextPage}
              disabled={currentScreenIndex >= screensLength - 1}
              title="下一页"
            >
              <ChevronRight size={14} />
            </button>
          </>
        )}
      </div>

      <div className="designer-toolbar-right">
        {/* Component library popup toggle — hidden for DIAGRAM projects */}
        {!isDiagramProject && !isGenerating && hasCurrentScreen && (
          <button
            className={`designer-toolbar-btn ${componentLibraryVisible ? 'active' : ''}`}
            onClick={onToggleComponentLibrary}
            title={componentLibraryVisible ? '隐藏组件库' : '组件库'}
          >
            <Component size={12} />
            组件库
          </button>
        )}

        {/* Page style editor — hidden for DIAGRAM projects */}
        {!isDiagramProject && !isGenerating && hasCurrentScreen && (
          <button
            className={`designer-toolbar-btn ${pageStyleVisible ? 'active' : ''}`}
            onClick={onTogglePageStyle}
            title={pageStyleVisible ? '隐藏页面样式' : '页面样式'}
          >
            <FileCode2 size={12} />
            样式
          </button>
        )}

        {/* Select mode toggle — hidden for DIAGRAM projects */}
        {!isDiagramProject && !isGenerating && screensLength > 0 && (
          <button
            className={`designer-toolbar-btn ${selectMode ? 'active' : ''}`}
            onClick={onSelectToggle}
            disabled={!hasCurrentScreen}
            title={selectMode ? '退出选择模式' : '选择元素模式'}
          >
            <MousePointer2 size={12} />
            {selectMode ? '选择中' : '选择'}
          </button>
        )}

        {/* Layer panel toggle — only visible in select mode */}
        {!isDiagramProject && selectMode && !isGenerating && (
          <button
            className={`designer-toolbar-btn ${layerPanelVisible ? 'active' : ''}`}
            onClick={onToggleLayerPanel}
            title={layerPanelVisible ? '隐藏图层面板' : '显示图层面板'}
          >
            <Layers size={12} />
            图层
          </button>
        )}

        {/* Theme / Style switcher */}
        {!isGenerating && screensLength > 0 && (
          <button
            className="designer-toolbar-btn"
            onClick={onApplyTheme}
            disabled={!hasCurrentScreen}
            title={isDiagramProject ? '换风格' : '换主题'}
          >
            <Palette size={12} />
            {isDiagramProject ? '风格' : '主题'}
          </button>
        )}

        {/* 共享菜单管理 — hidden for DIAGRAM projects */}
        {!isDiagramProject && onOpenMasterLayout && !isGenerating && hasCurrentProject && (
          <button
            className={`designer-toolbar-btn ${hasMasterLayout ? 'active' : ''}`}
            onClick={onOpenMasterLayout}
            title={hasMasterLayout ? '管理共享菜单' : '尚未启用共享菜单（点击查看）'}
          >
            <Crown size={12} />
            共享组件管理
            {hasMasterLayout && (
              <span style={{ marginLeft: 4, fontSize: 9, color: 'var(--accent)' }}>●</span>
            )}
          </button>
        )}

        {/* Run preview button — hidden for DIAGRAM projects */}
        {!isDiagramProject && !isGenerating && screensLength > 0 && (
          <button
            className="designer-toolbar-btn"
            onClick={onRunToggle}
            disabled={!hasCurrentScreen}
            title="运行预览 (全屏)"
          >
            <Play size={12} />
            运行
          </button>
        )}

        {/* Publish button */}
        {!isGenerating && screensLength > 0 && (
          <button
            className="designer-toolbar-btn"
            onClick={onPublish}
            disabled={!hasCurrentScreen}
            title="发布设计稿"
          >
            <Globe size={12} />
            发布
          </button>
        )}

        <button className="designer-toolbar-btn" onClick={onRefresh} title="刷新预览">
          <RefreshCw size={12} />
        </button>
        {exportHtml && (
          <>
            <button className="designer-toolbar-btn" onClick={onCopy} title="复制 HTML">
              {copied ? <Check size={12} /> : <Copy size={12} />}
              {copied ? '已复制' : '复制'}
            </button>
            <button
              className="designer-toolbar-btn"
              onClick={onCopyPng}
              title="复制为 PNG 图片（完整页面，含滚动内容）"
            >
              {pngCopied ? <Check size={12} /> : <ImageIcon size={12} />}
              {pngCopied ? '已复制' : 'PNG'}
            </button>
            <button className="designer-toolbar-btn primary" onClick={onExport} title="导出 HTML">
              <Download size={12} />
              导出
            </button>
            {/* Export Vue — not applicable for DIAGRAM projects */}
            {!isDiagramProject && (
              <button className="designer-toolbar-btn" onClick={onExportVue} title="导出 Vue 3 项目">
                <Code2 size={12} />
                Vue
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
