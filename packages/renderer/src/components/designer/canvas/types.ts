import type { DesignerScreen, ProjectType, SelectedElement, ElementStyle, MasterLayoutType, MasterLayout } from '@xai/shared';
import type { DesignerNavApi } from './navContext';

export type DeviceMode = 'desktop' | 'tablet' | 'mobile';
export type CanvasMode = 'design' | 'run';

/** Delimiter used to separate multiple HTML pages in the LLM output. */
export const PAGE_BREAK_DELIMITER = '<!-- PAGE BREAK -->';

export const ZOOM_MIN = 0.25;
export const ZOOM_MAX = 3;
export const ZOOM_STEP = 0.1;

export interface DesignerCanvasProps {
  /** Streaming HTML buffer (raw LLM output, may contain page-break delimiters). */
  html: string;
  /** Whether the LLM is currently generating. */
  isGenerating: boolean;
  /** Live AI output text (thinking + content) for process display in the toolbar. */
  streamingText: string;
  /** Saved screens of the current project (shown when not generating). */
  screens: DesignerScreen[];
  /** Currently selected screen id (highlighted in the canvas). */
  currentScreenId: string | null;
  /** Project type, used to set default device mode. */
  projectType?: ProjectType;
  /** Current project id — used to reset auto-center state on project switch. */
  projectId?: string;
  /** Explicitly created folder paths for grouping. */
  folders?: string[];
  onSelectScreen?: (screenId: string) => void;
  onExport: () => void;
  onRefresh: () => void;
  /** Element selection */
  selectedElement: SelectedElement | null;
  onSelectElement: (el: SelectedElement | null) => void;
  onElementStyleChange: (selector: string, style: Partial<ElementStyle>) => void;
  onAddElementToChat: () => void;
  onDeleteElement: (selector: string) => void;
  onHtmlChange: (html: string) => void;
  /** 手动重试加载某个 screen 的 HTML（用于加载失败的页面）。 */
  onReloadScreen?: (screenId: string) => Promise<boolean>;
  /** 加载失败的 screen id 集合（html='' 且加载失败，显示重试按钮而非 loading）。 */
  failedScreenIds?: Set<string>;
  // Undo / Redo
  // The optional callback receives (screenId, html) so DesignerCanvas can
  // apply the new HTML directly to the iframe DOM (flicker-free) before
  // React re-renders, mirroring the direct-DOM-manipulation path used by
  // applyStyleChange.
  onUndo: (onApplied?: (screenId: string, html: string) => void) => void;
  onRedo: (onApplied?: (screenId: string, html: string) => void) => void;
  canUndo: boolean;
  canRedo: boolean;
  /** Screen ids with unsaved manual edits (drives the "*" marker on file names). */
  dirtyScreenIds: Set<string>;
  /** Manually save the current screen (toolbar Save button / Ctrl+S). */
  onSave: () => void;
  /** Save all dirty screens at once (toolbar "保存全部" button). */
  onSaveAll: () => void;
  /** Create a new blank screen and load it onto the canvas. */
  onCreateBlankScreen: () => void;
  /** Whether a project is currently loaded (enables "new blank screen"). */
  hasCurrentProject: boolean;
  /** Toggle the component library popup visibility. */
  onToggleComponentLibrary: () => void;
  /** Whether the component library popup is currently visible. */
  componentLibraryVisible: boolean;
  /** Toggle the page style editor popup. */
  onTogglePageStyle: () => void;
  /** Whether the page style editor is currently visible. */
  pageStyleVisible: boolean;
  // Theme
  onApplyTheme: () => void;
  // Export Vue
  onExportVue: () => void;
  // Publish
  onPublish: () => void;
  /** Project themePrompt for theme-aware previews. */
  themePrompt?: string;

  /* ── 共享母版（MasterLayout） ───────────────────────────────────────── */
  /** 共享菜单：打开管理对话框（D7 入口点之一）。可选，未传入不渲染按钮。 */
  onOpenMasterLayout?: () => void;
  /** 共享菜单：当前项目是否已启用（用于按钮高亮提示）。 */
  hasMasterLayout?: boolean;
  /** 共享母版：选中 nav/header/footer/aside 时"提升为共享母版"回调（D7 元素级入口点）。可选。
   *  type 由 DesignerCanvas 通过 detectMasterLayoutType 判定后传入。
   *  sourceDoc 为源 iframe 的 contentDocument（用于抽取相关 CSS 规则，可选）。 */
  onPromoteToMasterLayout?: (outerHtml: string, selector: string, type: MasterLayoutType, sourceDoc?: Document) => void;
  /** 共享母版列表：流式渲染期间实时注入到 slot 占位（菜单高亮跟随当前生成页）。
   *  无母版时传 undefined / 空数组，完全跳过注入逻辑（向后兼容）。 */
  masterLayouts?: MasterLayout[];
  /** Navigate Palette 注册回调：画布构建 navApi 后通知侧栏。 */
  onNavReady?: (api: DesignerNavApi) => void;
  /** Whether this is a DIAGRAM project (hides HTML-prototype-specific toolbar buttons). */
  isDiagramProject?: boolean;
}
