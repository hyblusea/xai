import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { Download, X, FolderOpen, Check, RefreshCw, ChevronRight, Folder, FolderOpen as FolderOpenIcon, FileCode, Box, FolderPlus, HardDrive, AlertTriangle, Crown } from 'lucide-react';
import type { DesignerProject } from '@xai/shared';
import { useIpc } from '../../hooks/useIpc';
import { buildFolderTree, type FolderNode } from './FolderTree';
import { processHtmlForExport, buildScreenFileMap } from '../../utils/masterLayoutExport';

interface ExportHtmlDialogProps {
  project: DesignerProject;
  currentScreenId: string | null;
  onClose: () => void;
  /** Called after a successful export, with the set of exported screen IDs. */
  onExported?: (exportedIds: Set<string>) => void;
}

/** Collect all screen IDs under a folder node (recursive). */
function collectScreenIds(node: FolderNode, out: string[] = []): string[] {
  for (const s of node.screens) out.push(s.id);
  for (const c of node.children) collectScreenIds(c, out);
  return out;
}

type CheckState = 'checked' | 'unchecked' | 'indeterminate';

/** Compute the check state of a group (folder/project) from selectedIds. */
function groupCheckState(ids: string[], selected: Set<string>): CheckState {
  if (ids.length === 0) return 'unchecked';
  let selectedCount = 0;
  for (const id of ids) if (selected.has(id)) selectedCount++;
  if (selectedCount === 0) return 'unchecked';
  if (selectedCount === ids.length) return 'checked';
  return 'indeterminate';
}

export default function ExportHtmlDialog({ project, currentScreenId, onClose, onExported }: ExportHtmlDialogProps) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(
    () => new Set(currentScreenId ? [currentScreenId] : []),
  );
  const [outputDir, setOutputDir] = useState('');
  const [exporting, setExporting] = useState(false);
  const [progress, setProgress] = useState(0);
  const [progressLabel, setProgressLabel] = useState('');
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState('');
  const { invoke, on, removeListener } = useIpc();
  const successTimerRef = useRef<number | null>(null);

  const tree = useMemo(() => buildFolderTree(project.screens, project.folders), [project.screens, project.folders]);
  const rootScreens = useMemo(() => project.screens.filter(s => !s.folderPath), [project.screens]);

  const allScreenIds = useMemo(() => project.screens.map(s => s.id), [project.screens]);
  const rootState = groupCheckState(allScreenIds, selectedIds);

  // MasterLayout 提示文案用：仅在项目启用了共享菜单时显示导出说明横幅
  const masterLayoutsCount = project.masterLayouts?.length ?? 0;
  const hasMasterLayouts = masterLayoutsCount > 0;

  // Clean up any pending auto-close timer on unmount
  useEffect(() => {
    return () => {
      if (successTimerRef.current !== null) {
        clearTimeout(successTimerRef.current);
      }
    };
  }, []);

  const toggleScreen = useCallback((id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleGroup = useCallback((ids: string[]) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      const state = groupCheckState(ids, prev);
      if (state === 'checked') {
        for (const id of ids) next.delete(id);
      } else {
        for (const id of ids) next.add(id);
      }
      return next;
    });
  }, []);

  const handleSelectDir = useCallback((dirPath: string) => {
    setOutputDir(dirPath);
    setError('');
  }, []);

  const handleExport = useCallback(async () => {
    if (selectedIds.size === 0 || !outputDir || exporting) return;
    setExporting(true);
    setError('');
    setProgress(0);
    setProgressLabel('准备导出...');

    const progressHandler = (...args: unknown[]) => {
      const data = args[1] as { current: number; total: number; name: string };
      const pct = data.total > 0 ? Math.round((data.current / data.total) * 100) : 0;
      setProgress(pct);
      setProgressLabel(`${data.current} / ${data.total} · ${data.name}`);
    };
    on('designer:export-progress', progressHandler);

    try {
      // MasterLayout 导出后处理（§6.7）：data-nav-target → href 转换 + 清理设计期标记。
      // 仅在项目启用了共享菜单时执行；老项目（masterLayouts 为空）走原路径，行为不变。
      const layouts = project.masterLayouts || [];
      const screenFileMap = layouts.length ? buildScreenFileMap(project.screens) : undefined;
      const items = project.screens
        .filter(s => selectedIds.has(s.id))
        .map(s => {
          let html = s.html;
          if (layouts.length && screenFileMap) {
            html = processHtmlForExport(html, s.id, project, { mode: 'multi-file', screenFileMap });
          }
          return { name: s.name, html, folderPath: s.folderPath };
        });
      const result = await invoke('designer:export-multi-html', { items, outputDir }) as {
        success: boolean; count?: number; error?: string;
      };
      if (result.success) {
        setSuccess(true);
        onExported?.(new Set(selectedIds));
        // Persist the export directory so the next export restores it
        saveLastExportDir(outputDir);
        // Auto-close after showing success briefly
        successTimerRef.current = window.setTimeout(() => {
          onClose();
        }, 1200);
      } else {
        setError(result.error || '导出失败');
      }
    } catch (err) {
      setError(String(err));
    } finally {
      removeListener('designer:export-progress', progressHandler);
      setExporting(false);
    }
  }, [selectedIds, outputDir, exporting, project, invoke, on, removeListener, onExported, onClose]);

  const canExport = selectedIds.size > 0 && !!outputDir && !exporting && !success;

  return (
    <div className="designer-dialog-overlay" onClick={(exporting || success) ? undefined : onClose}>
      <div className="designer-dialog designer-export-html-dialog" onClick={e => e.stopPropagation()}>
        <div className="designer-dialog-header">
          <span className="designer-dialog-title">
            <Download size={14} style={{ verticalAlign: 'middle', marginRight: 6 }} />
            导出 HTML
          </span>
          {!success && (
            <button className="designer-dialog-close" onClick={onClose} disabled={exporting}>
              <X size={14} />
            </button>
          )}
        </div>

        <div className="designer-dialog-body designer-export-html-body">
          {success ? (
            <div className="designer-export-success">
              <Check size={36} color="#10b981" />
              <p>成功导出 {selectedIds.size} 个页面到：</p>
              <code>{outputDir}</code>
            </div>
          ) : (
            <>
              {hasMasterLayouts && (
                <div className="designer-export-master-hint">
                  <div className="designer-export-master-hint-title">
                    <Crown size={11} />
                    项目已启用共享组件（{masterLayoutsCount} 个），导出说明：
                  </div>
                  <ul>
                    <li>组件已"烤"进每个 HTML 文件，离线打开即可见</li>
                    <li>导出后菜单不再联动，源 MasterLayout 修改不会同步到已导出文件</li>
                    <li>菜单跳转链接已转为实际 href，可直接点击</li>
                  </ul>
                </div>
              )}
              <div className="designer-export-html-columns">
                {/* Left: tree with checkboxes */}
                <div className="designer-export-tree-panel">
                  <div className="designer-export-tree-header">
                    <span className="designer-prop-label">选择页面</span>
                    <span className="designer-export-tree-count">
                      已选 {selectedIds.size} / {allScreenIds.length}
                    </span>
                  </div>
                  <div className="designer-export-tree-list">
                    {/* Project root — selects all */}
                    <div
                      className="designer-export-tree-row designer-export-tree-root"
                      onClick={() => toggleGroup(allScreenIds)}
                    >
                      <TriCheckbox state={rootState} />
                      <Box size={12} />
                      <span className="designer-export-tree-name">{project.name}</span>
                      <span className="designer-export-tree-badge">{allScreenIds.length}</span>
                    </div>
                    {/* Root-level screens */}
                    {rootScreens.map(screen => (
                      <div
                        key={screen.id}
                        className="designer-export-tree-row designer-export-tree-leaf"
                        style={{ paddingLeft: 28 }}
                        onClick={() => toggleScreen(screen.id)}
                      >
                        <TriCheckbox state={selectedIds.has(screen.id) ? 'checked' : 'unchecked'} />
                        <FileCode size={11} />
                        <span className="designer-export-tree-name">{screen.name}</span>
                      </div>
                    ))}
                    {/* Folders */}
                    {tree.map(node => (
                      <FolderTreeNode
                        key={node.path}
                        node={node}
                        depth={1}
                        selectedIds={selectedIds}
                        onToggleScreen={toggleScreen}
                        onToggleGroup={toggleGroup}
                      />
                    ))}
                  </div>
                </div>

                {/* Right: embedded directory browser */}
                <div className="designer-export-path-panel">
                  <DirectoryBrowser
                    selectedPath={outputDir}
                    onSelect={handleSelectDir}
                    disabled={exporting}
                  />
                  {error && <div className="designer-export-error">{error}</div>}
                </div>
              </div>
            </>
          )}
        </div>

        <div className="designer-dialog-footer designer-export-html-footer">
          {exporting ? (
            <div className="designer-export-progress">
              <div className="designer-export-progress-bar">
                <div className="designer-export-progress-fill" style={{ width: `${progress}%` }} />
              </div>
              <span className="designer-export-progress-text">{progressLabel} ({progress}%)</span>
            </div>
          ) : success ? (
            <span className="designer-export-done-label">
              <Check size={12} color="#10b981" /> 导出完成
            </span>
          ) : (
            <span className="designer-export-selected-path" title={outputDir}>
              {outputDir ? `导出到: ${outputDir}` : ''}
            </span>
          )}
          {success ? (
            <button className="designer-dialog-btn primary" onClick={onClose}>关闭</button>
          ) : (
            <>
              <button className="designer-dialog-btn cancel" onClick={onClose} disabled={exporting}>取消</button>
              <button
                className="designer-dialog-btn primary"
                onClick={handleExport}
                disabled={!canExport}
              >
                {exporting ? <RefreshCw size={12} className="spin" /> : <Download size={12} />}
                {exporting ? '导出中...' : `导出${selectedIds.size > 0 ? ` (${selectedIds.size})` : ''}`}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** Tri-state checkbox indicator (visual only — click handled by parent row). */
function TriCheckbox({ state }: { state: CheckState }) {
  return (
    <span
      className={`designer-tri-check ${state}`}
      role="checkbox"
      aria-checked={state === 'checked' ? 'true' : state === 'indeterminate' ? 'mixed' : 'false'}
    >
      {state === 'checked' && <Check size={10} />}
      {state === 'indeterminate' && <span className="designer-tri-check-dash" />}
    </span>
  );
}

/** Recursive folder tree node with checkboxes. */
function FolderTreeNode({
  node,
  depth,
  selectedIds,
  onToggleScreen,
  onToggleGroup,
}: {
  node: FolderNode;
  depth: number;
  selectedIds: Set<string>;
  onToggleScreen: (id: string) => void;
  onToggleGroup: (ids: string[]) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const descendantIds = useMemo(() => collectScreenIds(node), [node]);
  const state = groupCheckState(descendantIds, selectedIds);

  return (
    <div>
      <div
        className="designer-export-tree-row designer-export-tree-folder"
        style={{ paddingLeft: depth * 16 + 12 }}
      >
        <ChevronRight
          size={10}
          style={{
            transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)',
            transition: 'transform 0.15s',
            flexShrink: 0,
            cursor: 'pointer',
          }}
          onClick={(e) => {
            e.stopPropagation();
            setExpanded(!expanded);
          }}
        />
        <span
          className="designer-export-tree-check-area"
          onClick={(e) => {
            e.stopPropagation();
            onToggleGroup(descendantIds);
          }}
        >
          <TriCheckbox state={state} />
        </span>
        {expanded ? <FolderOpenIcon size={11} /> : <Folder size={11} />}
        <span
          className="designer-export-tree-name"
          onClick={(e) => {
            e.stopPropagation();
            setExpanded(!expanded);
          }}
        >
          {node.name}
        </span>
        <span className="designer-export-tree-badge">{descendantIds.length}</span>
      </div>
      {expanded && (
        <>
          {node.children.map(child => (
            <FolderTreeNode
              key={child.path}
              node={child}
              depth={depth + 1}
              selectedIds={selectedIds}
              onToggleScreen={onToggleScreen}
              onToggleGroup={onToggleGroup}
            />
          ))}
          {node.screens.map(screen => (
            <div
              key={screen.id}
              className="designer-export-tree-row designer-export-tree-leaf"
              style={{ paddingLeft: (depth + 1) * 16 + 12 }}
              onClick={() => onToggleScreen(screen.id)}
            >
              <TriCheckbox state={selectedIds.has(screen.id) ? 'checked' : 'unchecked'} />
              <FileCode size={11} />
              <span className="designer-export-tree-name">{screen.name}</span>
            </div>
          ))}
        </>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════
// Local filesystem directory browser
// ═══════════════════════════════════════════════════════════════════════

interface DirEntry {
  name: string;
  path: string;
}

interface DirectoryBrowserProps {
  selectedPath: string;
  onSelect: (path: string) => void;
  disabled?: boolean;
}

/** localStorage key for persisting the last export directory. */
const LAST_EXPORT_DIR_KEY = 'designer.exportHtml.lastOutputDir';

/** Read the persisted last export directory (or empty string if none). */
function getLastExportDir(): string {
  try {
    return localStorage.getItem(LAST_EXPORT_DIR_KEY) || '';
  } catch {
    return '';
  }
}

/** Persist the export directory to localStorage. */
function saveLastExportDir(dirPath: string): void {
  try {
    localStorage.setItem(LAST_EXPORT_DIR_KEY, dirPath);
  } catch { /* ignore quota / privacy mode errors */ }
}

/** Recursively expand the directory tree to reveal `targetPath`.
 *  Loads each ancestor's children along the way. Returns the deepest path
 *  that was actually reachable (may be shorter than targetPath if a segment
 *  no longer exists). */
async function expandToPath(
  targetPath: string,
  roots: DirEntry[],
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>,
): Promise<{ expanded: Set<string>; cache: Map<string, DirEntry[]>; reachedPath: string } | null> {
  // Find the root that contains targetPath (case-insensitive on Windows)
  const lowerTarget = targetPath.toLowerCase();
  const root = roots.find(r => lowerTarget.startsWith(r.path.toLowerCase().replace(/\/$/, '') ));
  if (!root) return null;

  const rootPath = root.path;
  // Compute remaining segments after the root
  const remaining = targetPath.slice(rootPath.length).split(/[\\/]/).filter(Boolean);

  const expanded = new Set<string>([rootPath]);
  const cache = new Map<string, DirEntry[]>();

  // Load root's children
  let currentPath = rootPath;
  let children: DirEntry[] = [];
  try {
    const res = await invoke('designer:list-dirs', currentPath) as {
      success: boolean; entries?: DirEntry[];
    };
    children = (res.success && res.entries) ? res.entries : [];
  } catch { return null; }
  cache.set(currentPath, children);

  // Walk down the remaining segments
  for (const seg of remaining) {
    const match = children.find(c => c.name.toLowerCase() === seg.toLowerCase());
    if (!match) break; // segment no longer exists — stop here
    currentPath = match.path;
    expanded.add(currentPath);
    try {
      const res = await invoke('designer:list-dirs', currentPath) as {
        success: boolean; entries?: DirEntry[];
      };
      children = (res.success && res.entries) ? res.entries : [];
      cache.set(currentPath, children);
    } catch { break; }
  }

  return { expanded, cache, reachedPath: currentPath };
}

/** Lazy-loading directory tree browser. Root nodes (drives on Windows) are
 *  loaded on mount. Each node fetches its children on first expand. */
function DirectoryBrowser({ selectedPath, onSelect, disabled }: DirectoryBrowserProps) {
  const { invoke } = useIpc();
  // Roots: drive letters (Windows) or `/` (Unix)
  const [roots, setRoots] = useState<DirEntry[]>([]);
  const [rootsLoading, setRootsLoading] = useState(true);
  // Expanded path → children cache. Re-fetched only when first expanded.
  const [childrenCache, setChildrenCache] = useState<Map<string, DirEntry[]>>(new Map());
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(new Set());
  // New-folder inline input state: { parentPath } | null
  const [creatingIn, setCreatingIn] = useState<string | null>(null);
  const [newFolderName, setNewFolderName] = useState('');
  const [createError, setCreateError] = useState('');
  const newFolderInputRef = useRef<HTMLInputElement | null>(null);

  // Load roots on mount, then restore the last-used export directory by
  // expanding the tree down to it. Runs once on mount only.
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setRootsLoading(true);
      try {
        const result = await invoke('designer:list-dirs') as {
          success: boolean; entries?: DirEntry[]; error?: string;
        };
        if (cancelled || !result.success || !result.entries) return;
        setRoots(result.entries);

        // Restore last export directory: expand tree to reveal it
        const lastDir = getLastExportDir();
        if (!lastDir) return;
        const expandResult = await expandToPath(lastDir, result.entries, invoke);
        if (cancelled || !expandResult) return;
        setExpandedPaths(expandResult.expanded);
        setChildrenCache(expandResult.cache);
        // Select the deepest reachable path (may equal lastDir, or be a
        // parent if the directory was deleted/moved)
        onSelectRef.current(expandResult.reachedPath);
      } catch { /* ignore */ } finally {
        if (!cancelled) setRootsLoading(false);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [invoke]);

  // Focus the new-folder input when it appears
  useEffect(() => {
    if (creatingIn && newFolderInputRef.current) {
      newFolderInputRef.current.focus();
      newFolderInputRef.current.select();
    }
  }, [creatingIn]);

  const loadChildren = useCallback(async (dirPath: string) => {
    if (childrenCache.has(dirPath)) return;
    setLoadingPaths(prev => new Set(prev).add(dirPath));
    try {
      const result = await invoke('designer:list-dirs', dirPath) as {
        success: boolean; entries?: DirEntry[]; error?: string;
      };
      if (result.success && result.entries) {
        setChildrenCache(prev => {
          const next = new Map(prev);
          next.set(dirPath, result.entries!);
          return next;
        });
      }
    } catch { /* ignore */ } finally {
      setLoadingPaths(prev => {
        const next = new Set(prev);
        next.delete(dirPath);
        return next;
      });
    }
  }, [invoke, childrenCache]);

  const toggleExpand = useCallback((dirPath: string) => {
    setExpandedPaths(prev => {
      const next = new Set(prev);
      if (next.has(dirPath)) {
        next.delete(dirPath);
      } else {
        next.add(dirPath);
        void loadChildren(dirPath);
      }
      return next;
    });
  }, [loadChildren]);

  const handleCreateFolder = useCallback(async (parentPath: string) => {
    const name = newFolderName.trim();
    if (!name) {
      setCreatingIn(null);
      setNewFolderName('');
      return;
    }
    setCreateError('');
    try {
      const result = await invoke('designer:create-dir', parentPath, name) as {
        success: boolean; path?: string; error?: string;
      };
      if (result.success && result.path) {
        // Invalidate cache so the new folder shows up on next expand
        setChildrenCache(prev => {
          const next = new Map(prev);
          next.delete(parentPath);
          return next;
        });
        // Ensure parent is expanded and select the new folder
        setExpandedPaths(prev => {
          const next = new Set(prev);
          next.add(parentPath);
          return next;
        });
        await loadChildren(parentPath);
        onSelect(result.path);
        setCreatingIn(null);
        setNewFolderName('');
      } else {
        setCreateError(result.error || '创建失败');
      }
    } catch (err) {
      setCreateError(String(err));
    }
  }, [newFolderName, invoke, loadChildren, onSelect]);

  const startCreateInRoot = useCallback(() => {
    // Use the first root as the default parent for new folders at top level.
    // If a directory is selected, use that instead.
    const parent = selectedPath || (roots.length > 0 ? roots[0].path : '');
    if (parent) {
      setCreateError('');
      setCreatingIn(parent);
      setNewFolderName('');
      // Ensure parent is expanded so the input is visible
      setExpandedPaths(prev => {
        const next = new Set(prev);
        next.add(parent);
        return next;
      });
      void loadChildren(parent);
    }
  }, [selectedPath, roots, loadChildren]);

  return (
    <div className="designer-dir-browser">
      <div className="designer-dir-browser-header">
        <span className="designer-prop-label">导出路径</span>
        <button
          className="designer-dir-newfolder-btn"
          onClick={startCreateInRoot}
          disabled={disabled || rootsLoading || roots.length === 0}
          title="新建文件夹"
        >
          <FolderPlus size={12} />
          新建文件夹
        </button>
      </div>
      <div className="designer-dir-browser-list">
        {rootsLoading ? (
          <div className="designer-dir-browser-empty">
            <RefreshCw size={16} className="spin" style={{ opacity: 0.5 }} />
            <span>加载中...</span>
          </div>
        ) : roots.length === 0 ? (
          <div className="designer-dir-browser-empty">
            <span>无法读取文件系统</span>
          </div>
        ) : (
          roots.map(root => (
            <DirNode
              key={root.path}
              entry={root}
              depth={0}
              isRoot
              expandedPaths={expandedPaths}
              loadingPaths={loadingPaths}
              childrenCache={childrenCache}
              selectedPath={selectedPath}
              creatingIn={creatingIn}
              newFolderName={newFolderName}
              createError={createError}
              newFolderInputRef={newFolderInputRef}
              onToggleExpand={toggleExpand}
              onSelect={onSelect}
              onSetNewFolderName={setNewFolderName}
              onCreateFolder={handleCreateFolder}
              onCancelCreate={() => { setCreatingIn(null); setNewFolderName(''); setCreateError(''); }}
              disabled={disabled}
            />
          ))
        )}
      </div>
      {selectedPath && (
        <div className="designer-dir-browser-selected" title={selectedPath}>
          <FolderOpen size={12} style={{ flexShrink: 0 }} />
          <span className="designer-dir-browser-selected-path">{selectedPath}</span>
        </div>
      )}
    </div>
  );
}

/** Recursive directory node. */
function DirNode({
  entry,
  depth,
  isRoot,
  expandedPaths,
  loadingPaths,
  childrenCache,
  selectedPath,
  creatingIn,
  newFolderName,
  createError,
  newFolderInputRef,
  onToggleExpand,
  onSelect,
  onSetNewFolderName,
  onCreateFolder,
  onCancelCreate,
  disabled,
}: {
  entry: DirEntry;
  depth: number;
  isRoot?: boolean;
  expandedPaths: Set<string>;
  loadingPaths: Set<string>;
  childrenCache: Map<string, DirEntry[]>;
  selectedPath: string;
  creatingIn: string | null;
  newFolderName: string;
  createError: string;
  newFolderInputRef: React.RefObject<HTMLInputElement | null>;
  onToggleExpand: (path: string) => void;
  onSelect: (path: string) => void;
  onSetNewFolderName: (v: string) => void;
  onCreateFolder: (parentPath: string) => void;
  onCancelCreate: () => void;
  disabled?: boolean;
}) {
  const expanded = expandedPaths.has(entry.path);
  const loading = loadingPaths.has(entry.path);
  const children = childrenCache.get(entry.path);
  const isSelected = selectedPath === entry.path;
  const showCreateInput = creatingIn === entry.path;

  return (
    <div>
      <div
        className={`designer-dir-row ${isSelected ? 'selected' : ''} ${isRoot ? 'root' : ''}`}
        style={{ paddingLeft: depth * 14 + 6 }}
      >
        <ChevronRight
          size={10}
          className="designer-dir-chevron"
          style={{
            transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)',
            opacity: loading ? 0.4 : 1,
          }}
          onClick={(e) => {
            if (disabled) return;
            e.stopPropagation();
            onToggleExpand(entry.path);
          }}
        />
        {loading ? (
          <RefreshCw size={11} className="spin" style={{ opacity: 0.5, flexShrink: 0 }} />
        ) : isRoot ? (
          <HardDrive size={11} style={{ flexShrink: 0 }} />
        ) : expanded ? (
          <FolderOpenIcon size={11} style={{ flexShrink: 0 }} />
        ) : (
          <Folder size={11} style={{ flexShrink: 0 }} />
        )}
        <span
          className="designer-dir-name"
          title={entry.path}
          onClick={() => { if (!disabled) onSelect(entry.path); }}
        >
          {entry.name}
        </span>
      </div>
      {expanded && (
        <>
          {showCreateInput && (
            <div
              className="designer-dir-newfolder-row"
              style={{ paddingLeft: (depth + 1) * 14 + 6 }}
            >
              <FolderPlus size={11} style={{ flexShrink: 0, opacity: 0.6 }} />
              <input
                ref={newFolderInputRef}
                className="designer-rename-input designer-dir-newfolder-input"
                value={newFolderName}
                onChange={e => onSetNewFolderName(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') onCreateFolder(entry.path);
                  if (e.key === 'Escape') onCancelCreate();
                }}
                onBlur={() => {
                  if (newFolderName.trim()) onCreateFolder(entry.path);
                  else onCancelCreate();
                }}
                placeholder="文件夹名称"
                style={{ flex: 1, minWidth: 0 }}
              />
            </div>
          )}
          {createError && showCreateInput && (
            <div className="designer-dir-newfolder-error">{createError}</div>
          )}
          {children && children.length === 0 && !showCreateInput && (
            <div className="designer-dir-empty-hint" style={{ paddingLeft: (depth + 1) * 14 + 6 }}>
              （空目录）
            </div>
          )}
          {children?.map(child => (
            <DirNode
              key={child.path}
              entry={child}
              depth={depth + 1}
              expandedPaths={expandedPaths}
              loadingPaths={loadingPaths}
              childrenCache={childrenCache}
              selectedPath={selectedPath}
              creatingIn={creatingIn}
              newFolderName={newFolderName}
              createError={createError}
              newFolderInputRef={newFolderInputRef}
              onToggleExpand={onToggleExpand}
              onSelect={onSelect}
              onSetNewFolderName={onSetNewFolderName}
              onCreateFolder={onCreateFolder}
              onCancelCreate={onCancelCreate}
              disabled={disabled}
            />
          ))}
        </>
      )}
    </div>
  );
}
