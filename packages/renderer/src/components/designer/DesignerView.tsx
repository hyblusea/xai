import { useCallback, useRef, useState, useEffect, useLayoutEffect, forwardRef, useImperativeHandle } from 'react';
import type { ProjectType, MasterLayoutType } from '@xai/shared';
import { useDesignerAgent } from '../../hooks/useDesignerAgent';
import DesignerProjectList from './DesignerProjectList';
import NavigatePalette from './canvas/NavigatePalette';
import DesignerCanvas from './DesignerCanvas';
import ThemeDialog from './ThemeDialog';
import ExportVueDialog from './ExportVueDialog';
import ExportHtmlDialog from './ExportHtmlDialog';
import CreateProjectDialog from './CreateProjectDialog';
import SystemDesignDialog from './SystemDesignDialog';
import PublishDialog from './PublishDialog';
import ScreenHistoryDialog from './ScreenHistoryDialog';
import FolderSelectDialog from './FolderSelectDialog';
import MasterLayoutDialog from './MasterLayoutDialog';
import MasterLayoutExtractDialog from './MasterLayoutExtractDialog';
import ChatInput from '../chat/ChatInput';
import type { AgentState } from '@xai/shared';
import { CheckCircle2, XCircle, Info, X, AlertTriangle } from 'lucide-react';
import { DesignerNavContext, type DesignerNavApi } from './canvas/navContext';
import './designer.css';

/** 父组件通过 ref 查询 designer 视图是否有未保存修改，并触发保存全部。
 *  用于切换到 code 视图或关闭窗口前的保存提示。 */
export interface DesignerViewHandle {
  /** 返回未保存的页面数量（dirtyScreenIds.size）。 */
  getUnsavedCount: () => number;
  /** 保存所有未保存页面。 */
  saveAll: () => Promise<void>;
}

const DesignerView = forwardRef<DesignerViewHandle>(function DesignerView(_props, ref) {
  const {
    projects,
    currentProject,
    currentScreenId,
    htmlBuffer,
    isGenerating,
    streamingText,
    toasts,
    selectedElement,
    chatTags,
    generateHtml,
    abortGeneration,
    saveCurrentHtml,
    dirtyScreenIds,
    saveCurrentScreen,
    saveAllDirtyScreens,
    createProject,
    deleteProject,
    renameProject,
    updateProjectTheme,
    loadProject,
    loadScreen,
    reloadCurrentProject,
    reloadScreen,
    failedScreenIds,
    deselectScreen,
    switchDesignerMode,
    canSwitchToEdit,
    deleteScreen,
    renameScreen,
    duplicateScreen,
    refreshProjects,
    dismissToast,
    selectElement,
    updateElementStyle,
    addElementToChat,
    addScreenToChat,
    deleteElement,
    updateHtml,
    removeChatTag,
    restoreChatTags,
    moveScreen,
    createFolder,
    deleteFolder,
    renameFolder,
    setHomeScreen,
    reorderScreen,
    applyTheme,
    exportVue,
    undo,
    redo,
    canUndo,
    canRedo,
    permissionWarning,
    dismissPermissionWarning,
    folderSelectDialog,
    onFolderSelect,
    onFolderSelectCancel,
    createPublication,
    listPublications,
    deletePublication,
    refreshPublication,
    listScreenHistory,
    getScreenHistoryContent,
    restoreScreenHistory,
    createBlankScreen,
    importHtmlScreen,
    extractMasterLayout,
    applyMasterLayoutEdit,
    deleteMasterLayout,
  } = useDesignerAgent();

  // 组件库浮层可见性（工具栏「组件库」按钮切换）
  const [componentLibraryVisible, setComponentLibraryVisible] = useState(false);

  // Navigate Palette: 画布注册的 navApi，通过 Context 传给侧栏 Palette
  const [navApi, setNavApi] = useState<DesignerNavApi | null>(null);

  // 页面样式编辑器可见性（工具栏「样式」按钮切换）
  const [pageStyleVisible, setPageStyleVisible] = useState(false);

  // 共享母版管理对话框
  const [showMasterLayoutDialog, setShowMasterLayoutDialog] = useState(false);
  // 共享母版提取对话框（选中 nav/header/footer/aside 后从属性面板触发）
  const [extractTarget, setExtractTarget] = useState<{
    outerHtml: string;
    selector: string;
    type: MasterLayoutType;
    sourceScreenId: string;
    sourceDoc?: Document;
  } | null>(null);

  const handleToggleComponentLibrary = useCallback(() => {
    setComponentLibraryVisible(prev => !prev);
  }, []);

  const handleTogglePageStyle = useCallback(() => {
    setPageStyleVisible(prev => !prev);
  }, []);

  const handleCreateBlankScreen = useCallback(() => {
    setComponentLibraryVisible(false);
    createBlankScreen();
  }, [createBlankScreen]);

  // Sidebar drag state
  const [sidebarPos, setSidebarPos] = useState({ x: 16, y: 0 });
  const [sidebarHeight, setSidebarHeight] = useState(0);
  const isDraggingSidebarRef = useRef(false);
  const dragStartRef = useRef({ x: 0, y: 0 });
  const dragOriginRef = useRef({ x: 0, y: 0 });
  const floatingSidebarRef = useRef<HTMLDivElement>(null);

  // Theme dialog state
  const [showThemeDialog, setShowThemeDialog] = useState(false);
  // Export Vue dialog state
  const [showExportVueDialog, setShowExportVueDialog] = useState(false);
  // Export HTML dialog state (multi-page export with tree selection)
  const [showExportHtmlDialog, setShowExportHtmlDialog] = useState(false);
  // Create project dialog state
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  // System design dialog state: edit project-level design tokens
  const [sysDesignTarget, setSysDesignTarget] = useState<{ projectId: string; projectName: string } | null>(null);
  // Publish dialog state
  const [showPublishDialog, setShowPublishDialog] = useState(false);
  // Screen history dialog state
  const [historyTarget, setHistoryTarget] = useState<{ screenId: string; screenName: string } | null>(null);

  // Center the sidebar vertically within the designer view on mount
  useLayoutEffect(() => {
    const sidebarEl = floatingSidebarRef.current;
    if (sidebarEl?.parentElement) {
      const h = sidebarEl.offsetHeight;
      const containerHeight = sidebarEl.parentElement.offsetHeight;
      setSidebarPos({
        x: 16,
        y: Math.round((containerHeight - h) / 2),
      });
      setSidebarHeight(h);
    }
  }, []);

  // Track sidebar height changes (e.g. window resize)
  useEffect(() => {
    const sidebarEl = floatingSidebarRef.current;
    if (!sidebarEl) return;
    const ro = new ResizeObserver(() => {
      setSidebarHeight(sidebarEl.offsetHeight);
    });
    ro.observe(sidebarEl);
    return () => ro.disconnect();
  }, []);

  const handleSidebarHeaderMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isDraggingSidebarRef.current = true;
    dragStartRef.current = { x: e.clientX, y: e.clientY };
    dragOriginRef.current = { ...sidebarPos };
  }, [sidebarPos]);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDraggingSidebarRef.current) return;
      const dx = e.clientX - dragStartRef.current.x;
      const dy = e.clientY - dragStartRef.current.y;
      setSidebarPos({
        x: dragOriginRef.current.x + dx,
        y: dragOriginRef.current.y + dy,
      });
    };
    const handleMouseUp = () => {
      isDraggingSidebarRef.current = false;
    };
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, []);

  // Map generating state to AgentState for ChatInput
  const agentState: AgentState = isGenerating ? 'thinking' : 'idle';

  const handleSend = useCallback((content: string) => {
    if (!content.trim()) return;
    generateHtml(content);
  }, [generateHtml]);

  const handleAbort = useCallback(() => {
    abortGeneration();
  }, [abortGeneration]);

  // 暴露未保存数量与"保存全部"给父组件（App.tsx），用于切换视图/关闭窗口前的保存提示
  useImperativeHandle(ref, () => ({
    getUnsavedCount: () => dirtyScreenIds.size,
    saveAll: async () => {
      await saveAllDirtyScreens();
    },
  }), [dirtyScreenIds, saveAllDirtyScreens]);

  const handleExport = useCallback(() => {
    if (!currentProject) return;
    setShowExportHtmlDialog(true);
  }, [currentProject]);

  // After a successful multi-page HTML export, persist the current screen's
  // HTML to the backend if it was among the exported pages (preserves the
  // previous single-file export behavior of saving after export).
  const handleExported = useCallback((exportedIds: Set<string>) => {
    if (currentScreenId && exportedIds.has(currentScreenId)) {
      saveCurrentHtml();
    }
  }, [currentScreenId, saveCurrentHtml]);

  const handleRefresh = useCallback(async () => {
    // Always refresh the project list (names, metadata, other projects)
    // AND reload the current project's full tree (screens, folders) so that
    // changes made by teammates become visible.
    await refreshProjects();
    if (currentProject) {
      await reloadCurrentProject();
    }
  }, [currentProject, reloadCurrentProject, refreshProjects]);

  const handleCreateProject = useCallback(async (name: string, type: ProjectType, themePrompt?: string) => {
    await createProject(name, type, undefined, themePrompt);
  }, [createProject]);

  const handleDeleteProject = useCallback(async (projectId: string) => {
    await deleteProject(projectId);
  }, [deleteProject]);

  const handleRenameProject = useCallback(async (projectId: string, newName: string) => {
    await renameProject(projectId, newName);
  }, [renameProject]);

  const handleSelectProject = useCallback((projectId: string) => {
    loadProject(projectId);
  }, [loadProject]);

  const handleSelectScreen = useCallback((projectId: string, screenId: string) => {
    loadScreen(projectId, screenId);
  }, [loadScreen]);

  const handleDeleteScreen = useCallback(async (projectId: string, screenId: string) => {
    await deleteScreen(projectId, screenId);
  }, [deleteScreen]);

  const handleRenameScreen = useCallback(async (projectId: string, screenId: string, newName: string) => {
    await renameScreen(projectId, screenId, newName);
  }, [renameScreen]);

  const handleDuplicateScreen = useCallback(async (projectId: string, screenId: string) => {
    await duplicateScreen(projectId, screenId);
  }, [duplicateScreen]);

  const handleSelectScreenInCanvas = useCallback((screenId: string) => {
    if (currentProject) {
      loadScreen(currentProject.id, screenId);
    }
  }, [currentProject, loadScreen]);

  return (
    <DesignerNavContext.Provider value={navApi}>
    <div className="designer-view">
      {/* Full-area Canvas */}
      <DesignerCanvas
        html={htmlBuffer}
        isGenerating={isGenerating}
        streamingText={streamingText}
        screens={currentProject?.screens ?? []}
        currentScreenId={currentScreenId}
        projectType={currentProject?.type}
        projectId={currentProject?.id}
        folders={currentProject?.folders}
        onSelectScreen={handleSelectScreenInCanvas}
        onExport={handleExport}
        onRefresh={handleRefresh}
        selectedElement={selectedElement}
        onSelectElement={selectElement}
        onElementStyleChange={updateElementStyle}
        onAddElementToChat={addElementToChat}
        onDeleteElement={deleteElement}
        onHtmlChange={updateHtml}
        onReloadScreen={reloadScreen}
        failedScreenIds={failedScreenIds}
        onUndo={undo}
        onRedo={redo}
        canUndo={canUndo}
        canRedo={canRedo}
        dirtyScreenIds={dirtyScreenIds}
        onSave={saveCurrentScreen}
        onSaveAll={saveAllDirtyScreens}
        onApplyTheme={() => setShowThemeDialog(true)}
        onExportVue={() => setShowExportVueDialog(true)}
        onPublish={() => setShowPublishDialog(true)}
        onCreateBlankScreen={handleCreateBlankScreen}
        hasCurrentProject={!!currentProject}
        onToggleComponentLibrary={handleToggleComponentLibrary}
        componentLibraryVisible={componentLibraryVisible}
        onTogglePageStyle={handleTogglePageStyle}
        pageStyleVisible={pageStyleVisible}
        onOpenMasterLayout={() => setShowMasterLayoutDialog(true)}
        hasMasterLayout={!!currentProject?.masterLayouts && currentProject.masterLayouts.length > 0}
        onPromoteToMasterLayout={(outerHtml, selector, type, sourceDoc) => {
          if (!currentScreenId) return;
          setExtractTarget({ outerHtml, selector, type, sourceScreenId: currentScreenId, sourceDoc });
        }}
        masterLayouts={currentProject?.masterLayouts}
        themePrompt={currentProject?.themePrompt}
        onNavReady={setNavApi}
      />

      {/* Theme Dialog */}
      {showThemeDialog && (
        <ThemeDialog
          onClose={() => setShowThemeDialog(false)}
          onApply={(prompt, scope) => {
            applyTheme(prompt, scope);
            setShowThemeDialog(false);
          }}
          isGenerating={isGenerating}
          isDiagramProject={currentProject?.type === 'DIAGRAM'}
        />
      )}

      {/* Export Vue Dialog */}
      {showExportVueDialog && currentProject && (
        <ExportVueDialog
          projectId={currentProject.id}
          onClose={() => setShowExportVueDialog(false)}
          onExport={exportVue}
        />
      )}

      {/* Export HTML Dialog — multi-page export with tree selection */}
      {showExportHtmlDialog && currentProject && (
        <ExportHtmlDialog
          project={currentProject}
          currentScreenId={currentScreenId}
          onClose={() => setShowExportHtmlDialog(false)}
          onExported={handleExported}
        />
      )}

      {/* Publish Dialog */}
      {showPublishDialog && currentProject && (
        <PublishDialog
          project={currentProject}
          currentScreenId={currentScreenId}
          onClose={() => setShowPublishDialog(false)}
          onCreatePublication={createPublication}
          onListPublications={listPublications}
          onDeletePublication={deletePublication}
          onRefreshPublication={refreshPublication}
        />
      )}

      {/* Screen History Dialog */}
      {historyTarget && (
        <ScreenHistoryDialog
          screenId={historyTarget.screenId}
          screenName={historyTarget.screenName}
          onClose={() => setHistoryTarget(null)}
          onListHistory={listScreenHistory}
          onGetContent={getScreenHistoryContent}
          onRestore={async (screenId, historyId) => {
            const restored = await restoreScreenHistory(screenId, historyId);
            if (restored) {
              // 恢复的是当前画布页面时，更新画布显示（不清空、不移位，仅 patch 内容）
              if (screenId === currentScreenId) {
                updateHtml(restored.html);
              }
            }
            return restored;
          }}
        />
      )}

      {/* MasterLayout 管理对话框（共享菜单） */}
      {showMasterLayoutDialog && currentProject && (
        <MasterLayoutDialog
          project={currentProject}
          onClose={() => setShowMasterLayoutDialog(false)}
          onSave={applyMasterLayoutEdit}
          onDelete={deleteMasterLayout}
        />
      )}

      {/* MasterLayout 提取对话框（从画布选中 nav 触发） */}
      {extractTarget && currentProject && (
        <MasterLayoutExtractDialog
          outerHtml={extractTarget.outerHtml}
          selector={extractTarget.selector}
          type={extractTarget.type}
          sourceScreenId={extractTarget.sourceScreenId}
          screens={currentProject.screens}
          existingLayoutsCount={currentProject.masterLayouts?.filter(l => l.type === extractTarget.type).length ?? 0}
          sourceDoc={extractTarget.sourceDoc}
          onConfirm={async (layout, sourceScreenId, selector) => {
            await extractMasterLayout(layout, sourceScreenId, selector);
            setExtractTarget(null);
          }}
          onClose={() => setExtractTarget(null)}
        />
      )}

      {/* Create Project Dialog */}
      {showCreateDialog && (
        <CreateProjectDialog
          onConfirm={async (name, type, themePrompt) => {
            const ok = await createProject(name, type, undefined, themePrompt);
            if (ok) setShowCreateDialog(false);
          }}
          onCancel={() => setShowCreateDialog(false)}
        />
      )}

      {/* System Design Dialog — edit project-level design tokens */}
      {sysDesignTarget && (
        <SystemDesignDialog
          projectName={sysDesignTarget.projectName}
          themePrompt={projects.find(p => p.id === sysDesignTarget.projectId)?.themePrompt}
          onSave={async (themePrompt) => {
            const ok = await updateProjectTheme(sysDesignTarget.projectId, themePrompt);
            if (ok) setSysDesignTarget(null);
            return ok;
          }}
          onClose={() => setSysDesignTarget(null)}
        />
      )}

      <div
        className="designer-floating-sidebar"
        ref={floatingSidebarRef}
        style={{ left: sidebarPos.x, top: sidebarPos.y }}
      >
        <DesignerProjectList
          projects={projects}
          currentProjectId={currentProject?.id ?? null}
          currentScreenId={currentScreenId}
          onSelectProject={handleSelectProject}
          onSelectScreen={handleSelectScreen}
          onCreateProject={handleCreateProject}
          onDeleteProject={handleDeleteProject}
          onRenameProject={handleRenameProject}
          onSystemDesign={(projectId, projectName) => setSysDesignTarget({ projectId, projectName })}
          onDeleteScreen={handleDeleteScreen}
          onRenameScreen={handleRenameScreen}
          onDuplicateScreen={handleDuplicateScreen}
          onAddScreenToChat={addScreenToChat}
          onShowScreenHistory={(_projectId, screenId, screenName) => setHistoryTarget({ screenId, screenName })}
          onDeselectScreen={deselectScreen}
          onMoveScreen={moveScreen}
          onCreateFolder={createFolder}
          onDeleteFolder={deleteFolder}
          onRenameFolder={renameFolder}
          onSetHomeScreen={setHomeScreen}
          onReorderScreen={reorderScreen}
          onRefresh={handleRefresh}
          onHeaderMouseDown={handleSidebarHeaderMouseDown}
          onCreateProjectClick={() => setShowCreateDialog(true)}
          isGenerating={isGenerating}
          dirtyScreenIds={dirtyScreenIds}
          onImportHtml={importHtmlScreen}
        />
      </div>

      {/* Navigate Palette: 独立面板，不占用项目列表高度 */}
      <div
        className="designer-floating-nav-palette"
        style={{ left: sidebarPos.x, top: sidebarPos.y + sidebarHeight }}
      >
        <NavigatePalette
          isGenerating={!!isGenerating}
          hasContent={projects.some(p => p.screens.length > 0)}
          screensCount={currentProject?.screens.length ?? 0}
          currentProjectId={currentProject?.id ?? null}
        />
      </div>

      <div className="designer-floating-chat">
        <ChatInput
          agentState={agentState}
          onSend={handleSend}
          onAbort={handleAbort}
          chatTags={chatTags}
          onRemoveChatTag={removeChatTag}
          onRestoreTags={restoreChatTags}
          currentScreenId={currentScreenId}
          showModeBadge
          onSwitchMode={switchDesignerMode}
          canSwitchToEdit={canSwitchToEdit}
          hasCurrentProject={!!currentProject}
        />
      </div>

      {/* Toast notifications */}
      {toasts.length > 0 && (
        <div className="designer-toast-container">
          {toasts.map(toast => (
            <div
              key={toast.id}
              className={`designer-toast designer-toast-${toast.type}`}
              onClick={() => dismissToast(toast.id)}
            >
              <span className="designer-toast-icon">
                {toast.type === 'success' && <CheckCircle2 size={14} />}
                {toast.type === 'error' && <XCircle size={14} />}
                {toast.type === 'info' && <Info size={14} />}
                {toast.type === 'warning' && <AlertTriangle size={14} />}
              </span>
              <span className="designer-toast-message">{toast.message}</span>
              <button
                className="designer-toast-close"
                onClick={(e) => {
                  e.stopPropagation();
                  dismissToast(toast.id);
                }}
              >
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* AI 操作权限提醒弹窗 */}
      {permissionWarning && (
        <div className="designer-perm-warning-overlay" onClick={dismissPermissionWarning}>
          <div className="designer-perm-warning" onClick={e => e.stopPropagation()}>
            <div className="designer-perm-warning-header">
              <AlertTriangle size={14} />
              无写权限
            </div>
            <div className="designer-perm-warning-body">{permissionWarning.message}</div>
            <div className="designer-perm-warning-footer">
              <button className="designer-dialog-btn primary" onClick={dismissPermissionWarning}>知道了</button>
            </div>
          </div>
        </div>
      )}

      {folderSelectDialog && (
        <FolderSelectDialog
          projectId={folderSelectDialog.projectId}
          onSelect={onFolderSelect}
          onCancel={onFolderSelectCancel}
        />
      )}
    </div>
    </DesignerNavContext.Provider>
  );
});

export default DesignerView;
