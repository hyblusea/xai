import { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import { ChevronRight, Folder, FolderOpen, FileCode, Plus, Home } from 'lucide-react';
import type { DesignerScreen, FolderPermission } from '@xai/shared';

export interface FolderNode {
  name: string;
  path: string;
  children: FolderNode[];
  screens: DesignerScreen[];
}

/** Build a folder tree from flat screen list with folderPath, plus explicit empty folders. */
export function buildFolderTree(screens: DesignerScreen[], folders?: string[]): FolderNode[] {
  const root: FolderNode = { name: '', path: '', children: [], screens: [] };

  for (const screen of screens) {
    const folderPath = screen.folderPath || '';
    if (!folderPath) {
      root.screens.push(screen);
      continue;
    }

    const parts = folderPath.split('/').filter(Boolean);
    let current = root;
    let currentPath = '';

    for (const part of parts) {
      currentPath = currentPath ? currentPath + '/' + part : part;
      let child = current.children.find(c => c.name === part);
      if (!child) {
        child = { name: part, path: currentPath, children: [], screens: [] };
        current.children.push(child);
      }
      current = child;
    }
    current.screens.push(screen);
  }

  // Merge explicit empty folders
  if (folders && folders.length > 0) {
    for (const folderPath of folders) {
      const parts = folderPath.split('/').filter(Boolean);
      let current = root;
      let currentPath = '';

      for (const part of parts) {
        currentPath = currentPath ? currentPath + '/' + part : part;
        let child = current.children.find(c => c.name === part);
        if (!child) {
          child = { name: part, path: currentPath, children: [], screens: [] };
          current.children.push(child);
        }
        current = child;
      }
    }
  }

  return root.children;
}

interface FolderTreeProps {
  screens: DesignerScreen[];
  folders?: string[];
  currentScreenId: string | null;
  onSelectScreen: (projectId: string, screenId: string) => void;
  onDeselectScreen: () => void;
  projectId: string;
  onMoveScreen?: (projectId: string, screenId: string, folderPath: string) => void;
  onReorderScreen?: (screenId: string, targetScreenId: string, insertBefore: boolean) => void;
  onScreenContextMenu?: (e: React.MouseEvent, projectId: string, screenId: string) => void;
  onFolderContextMenu?: (e: React.MouseEvent, projectId: string, folderPath: string, folderName: string) => void;
  onCreateFolder?: (projectId: string, folderPath: string) => void;
  onRenameFolder?: (projectId: string, folderPath: string, newName: string) => Promise<void>;
  onRenameScreen?: (projectId: string, screenId: string, newName: string) => Promise<void>;
  renamingFolderPath?: string | null;
  renamingScreenId?: string | null;
  onRenameDone?: () => void;
  dirtyScreenIds?: Set<string>;
  /** Home screen ID — displays a badge next to the screen name. */
  homeScreenId?: string | null;
  /** 目录路径 -> 授权用户列表（用于在文件夹名后显示徽章）。 */
  folderPermissions?: Record<string, { userId: number; displayName: string; permission: FolderPermission }[]>;
}

/** Drop indicator state: which screen is being hovered and whether to insert before or after. */
interface DropIndicator {
  targetScreenId: string;
  insertBefore: boolean;
}

function FolderItem({
  node,
  depth,
  currentScreenId,
  onSelectScreen,
  onDeselectScreen,
  projectId,
  onMoveScreen,
  onReorderScreen,
  onScreenContextMenu,
  onFolderContextMenu,
  onCreateFolder,
  onRenameFolder,
  onRenameScreen,
  renamingFolderPath,
  renamingScreenId,
  onRenameDone,
  dirtyScreenIds,
  dropIndicator,
  onDropIndicatorChange,
  homeScreenId,
  folderPermissions,
}: {
  node: FolderNode;
  depth: number;
  currentScreenId: string | null;
  onSelectScreen: (projectId: string, screenId: string) => void;
  onDeselectScreen: () => void;
  projectId: string;
  onMoveScreen?: (projectId: string, screenId: string, folderPath: string) => void;
  onReorderScreen?: (screenId: string, targetScreenId: string, insertBefore: boolean) => void;
  onScreenContextMenu?: (e: React.MouseEvent, projectId: string, screenId: string) => void;
  onFolderContextMenu?: (e: React.MouseEvent, projectId: string, folderPath: string, folderName: string) => void;
  onCreateFolder?: (projectId: string, folderPath: string) => void;
  onRenameFolder?: (projectId: string, folderPath: string, newName: string) => Promise<void>;
  onRenameScreen?: (projectId: string, screenId: string, newName: string) => Promise<void>;
  renamingFolderPath?: string | null;
  renamingScreenId?: string | null;
  onRenameDone?: () => void;
  dirtyScreenIds?: Set<string>;
  dropIndicator?: DropIndicator | null;
  onDropIndicatorChange?: (indicator: DropIndicator | null) => void;
  homeScreenId?: string | null;
  folderPermissions?: Record<string, { userId: number; displayName: string; permission: FolderPermission }[]>;
}) {
  const [expanded, setExpanded] = useState(true);
  const [addingSubFolder, setAddingSubFolder] = useState(false);
  const [subFolderName, setSubFolderName] = useState('');
  const [folderRenameValue, setFolderRenameValue] = useState(node.name);
  const [screenRenameValue, setScreenRenameValue] = useState('');
  const [isDragOver, setIsDragOver] = useState(false);
  const folderRenameInputRef = useRef<HTMLInputElement>(null);
  const screenRenameInputRefs = useRef<Map<string, HTMLInputElement>>(new Map());
  const dragCounter = useRef(0);

  const isRenamingFolder = renamingFolderPath === node.path;

  useEffect(() => {
    if (isRenamingFolder) {
      setFolderRenameValue(node.name);
      folderRenameInputRef.current?.focus();
      folderRenameInputRef.current?.select();
    }
  }, [isRenamingFolder, node.name]);

  useEffect(() => {
    if (renamingScreenId) {
      const screen = node.screens.find(s => s.id === renamingScreenId);
      if (screen) {
        setScreenRenameValue(screen.name);
      }
      // Defer focus to next frame so the input is rendered first
      requestAnimationFrame(() => {
        const input = screenRenameInputRefs.current.get(renamingScreenId);
        if (input) {
          input.focus();
          input.select();
        }
      });
    }
  }, [renamingScreenId, node.screens]);

  const handleAddSubFolder = useCallback(() => {
    if (subFolderName.trim() && onCreateFolder) {
      const newPath = node.path ? node.path + '/' + subFolderName.trim() : subFolderName.trim();
      onCreateFolder(projectId, newPath);
      setSubFolderName('');
      setAddingSubFolder(false);
    }
  }, [subFolderName, node.path, onCreateFolder, projectId]);

  const handleConfirmFolderRename = useCallback(() => {
    if (isRenamingFolder && folderRenameValue.trim() && folderRenameValue.trim() !== node.name && onRenameFolder) {
      onRenameFolder(projectId, node.path, folderRenameValue.trim());
    }
    onRenameDone?.();
  }, [isRenamingFolder, folderRenameValue, node.path, node.name, onRenameFolder, projectId, onRenameDone]);

  const handleCancelFolderRename = useCallback(() => {
    setFolderRenameValue(node.name);
    onRenameDone?.();
  }, [node.name, onRenameDone]);

  const handleConfirmScreenRename = useCallback((screenId: string, currentName: string) => {
    if (screenRenameValue.trim() && screenRenameValue.trim() !== currentName && onRenameScreen) {
      onRenameScreen(projectId, screenId, screenRenameValue.trim());
    }
    onRenameDone?.();
  }, [screenRenameValue, onRenameScreen, projectId, onRenameDone]);

  return (
    <div>
      <div
        className={`designer-folder-item ${isDragOver ? 'drag-over' : ''}`}
        style={{ paddingLeft: depth * 12 + 8 }}
        onClick={() => setExpanded(!expanded)}
        onContextMenu={e => onFolderContextMenu?.(e, projectId, node.path, node.name)}
        onDragEnter={(e) => {
          if (!onMoveScreen) return;
          dragCounter.current++;
          setIsDragOver(true);
        }}
        onDragOver={(e) => {
          if (!onMoveScreen) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
        }}
        onDragLeave={() => {
          if (!onMoveScreen) return;
          dragCounter.current--;
          if (dragCounter.current <= 0) {
            dragCounter.current = 0;
            setIsDragOver(false);
          }
        }}
        onDrop={(e) => {
          if (!onMoveScreen) return;
          e.preventDefault();
          e.stopPropagation();
          const screenId = e.dataTransfer.getData('text/screen-id');
          if (screenId) {
            onMoveScreen(projectId, screenId, node.path);
          }
          dragCounter.current = 0;
          setIsDragOver(false);
          onDropIndicatorChange?.(null);
        }}
      >
        <ChevronRight
          size={10}
          style={{
            transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)',
            transition: 'transform 0.15s',
            flexShrink: 0,
          }}
        />
        {expanded ? <FolderOpen size={11} /> : <Folder size={11} />}
        {isRenamingFolder ? (
          <input
            ref={folderRenameInputRef}
            className="designer-rename-input"
            value={folderRenameValue}
            onChange={e => setFolderRenameValue(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') handleConfirmFolderRename();
              if (e.key === 'Escape') handleCancelFolderRename();
            }}
            onBlur={handleConfirmFolderRename}
            onClick={e => e.stopPropagation()}
            style={{ flex: 1, minWidth: 0 }}
          />
        ) : (
          <span className="designer-folder-name">{node.name}</span>
        )}
        {!isRenamingFolder && folderPermissions?.[node.path]?.map(p => (
          <span
            key={p.userId}
            className={`designer-folder-perm-badge ${p.permission === 'WRITE' ? 'write' : 'read'}`}
            title={`${p.displayName} (${p.permission === 'WRITE' ? '可编辑' : '只读'})`}
          >
            {p.displayName}
          </span>
        ))}
        {!isRenamingFolder && (
          <span className="designer-folder-count">{node.screens.length + node.children.length}</span>
        )}
        {onCreateFolder && !isRenamingFolder && (
          <button
            className="designer-folder-add-btn"
            onClick={e => {
              e.stopPropagation();
              setAddingSubFolder(true);
            }}
            title="新建子文件夹"
          >
            <Plus size={9} />
          </button>
        )}
      </div>
      {expanded && (
        <>
          {addingSubFolder && (
            <div style={{ paddingLeft: (depth + 1) * 12 + 8, padding: '2px 4px' }}>
              <input
                className="designer-rename-input"
                value={subFolderName}
                onChange={e => setSubFolderName(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') handleAddSubFolder();
                  if (e.key === 'Escape') setAddingSubFolder(false);
                }}
                onBlur={() => setAddingSubFolder(false)}
                placeholder="子文件夹名称"
                autoFocus
                style={{ width: '100%' }}
              />
            </div>
          )}
          {node.children.map(child => (
            <FolderItem
              key={child.path}
              node={child}
              depth={depth + 1}
              currentScreenId={currentScreenId}
              onSelectScreen={onSelectScreen}
              onDeselectScreen={onDeselectScreen}
              projectId={projectId}
              onMoveScreen={onMoveScreen}
              onReorderScreen={onReorderScreen}
              onScreenContextMenu={onScreenContextMenu}
              onFolderContextMenu={onFolderContextMenu}
              onCreateFolder={onCreateFolder}
              onRenameFolder={onRenameFolder}
              onRenameScreen={onRenameScreen}
              renamingFolderPath={renamingFolderPath}
              renamingScreenId={renamingScreenId}
              onRenameDone={onRenameDone}
              dirtyScreenIds={dirtyScreenIds}
              dropIndicator={dropIndicator}
              onDropIndicatorChange={onDropIndicatorChange}
              homeScreenId={homeScreenId}
              folderPermissions={folderPermissions}
            />
          ))}
          {node.screens.map(screen => {
            const isRenamingScreen = renamingScreenId === screen.id;
            const isDropBefore = dropIndicator?.targetScreenId === screen.id && dropIndicator?.insertBefore;
            const isDropAfter = dropIndicator?.targetScreenId === screen.id && !dropIndicator?.insertBefore;
            return (
              <div
                key={screen.id}
                style={{ position: 'relative' }}
              >
                {isDropBefore && (
                  <div className="designer-screen-drop-line" style={{ top: 0 }} />
                )}
                <div
                  className={`designer-screen-item ${currentScreenId === screen.id ? 'active' : ''}`}
                  style={{ paddingLeft: (depth + 1) * 12 + 8 }}
                  onClick={() => {
                    if (isRenamingScreen) return;
                    if (currentScreenId === screen.id) {
                      onDeselectScreen();
                    } else {
                      onSelectScreen(projectId, screen.id);
                    }
                  }}
                  onContextMenu={e => onScreenContextMenu?.(e, projectId, screen.id)}
                  draggable={!!onMoveScreen && !isRenamingScreen}
                  onDragStart={(e) => {
                    e.dataTransfer.setData('text/screen-id', screen.id);
                    e.dataTransfer.setData('text/folder-path', node.path);
                    e.dataTransfer.effectAllowed = 'move';
                  }}
                  onDragOver={(e) => {
                    if (!onReorderScreen) return;
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'move';
                    const rect = e.currentTarget.getBoundingClientRect();
                    const midY = rect.top + rect.height / 2;
                    onDropIndicatorChange?.({ targetScreenId: screen.id, insertBefore: e.clientY < midY });
                  }}
                  onDrop={(e) => {
                    if (!onReorderScreen) return;
                    e.preventDefault();
                    const draggedId = e.dataTransfer.getData('text/screen-id');
                    const draggedFolder = e.dataTransfer.getData('text/folder-path');
                    // Only reorder within the same folder
                    if (draggedId && draggedId !== screen.id && draggedFolder === node.path) {
                      const rect = e.currentTarget.getBoundingClientRect();
                      const midY = rect.top + rect.height / 2;
                      onReorderScreen(draggedId, screen.id, e.clientY < midY);
                    }
                    onDropIndicatorChange?.(null);
                  }}
                  onDragLeave={() => {
                    if (dropIndicator?.targetScreenId === screen.id) {
                      onDropIndicatorChange?.(null);
                    }
                  }}
                >
                  {homeScreenId === screen.id ? <Home size={11} style={{ color: 'var(--accent)', flexShrink: 0 }} /> : <FileCode size={11} />}
                  {isRenamingScreen ? (
                    <input
                      ref={el => {
                        if (el) screenRenameInputRefs.current.set(screen.id, el);
                        else screenRenameInputRefs.current.delete(screen.id);
                      }}
                      className="designer-rename-input"
                      value={screenRenameValue}
                      onChange={e => setScreenRenameValue(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter') handleConfirmScreenRename(screen.id, screen.name);
                        if (e.key === 'Escape') onRenameDone?.();
                      }}
                      onBlur={() => handleConfirmScreenRename(screen.id, screen.name)}
                      onClick={e => e.stopPropagation()}
                      style={{ flex: 1, minWidth: 0 }}
                    />
                  ) : (
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {screen.name}
                      {dirtyScreenIds?.has(screen.id) && <span className="designer-dirty-mark">*</span>}
                    </span>
                  )}
                </div>
                {isDropAfter && (
                  <div className="designer-screen-drop-line" style={{ bottom: 0 }} />
                )}
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}

/**
 * Folder tree view for organizing screens into a hierarchy.
 */
export default function FolderTree({
  screens,
  folders,
  currentScreenId,
  onSelectScreen,
  onDeselectScreen,
  projectId,
  onMoveScreen,
  onReorderScreen,
  onScreenContextMenu,
  onFolderContextMenu,
  onCreateFolder,
  onRenameFolder,
  onRenameScreen,
  renamingFolderPath,
  renamingScreenId,
  onRenameDone,
  dirtyScreenIds,
  homeScreenId,
  folderPermissions,
}: FolderTreeProps) {
  const tree = useMemo(() => buildFolderTree(screens, folders), [screens, folders]);
  const [rootExpanded, setRootExpanded] = useState(true);
  const [newFolderName, setNewFolderName] = useState('');
  const [isAddingFolder, setIsAddingFolder] = useState(false);
  const [dropIndicator, setDropIndicator] = useState<DropIndicator | null>(null);

  const rootScreens = screens.filter(s => !s.folderPath);

  const handleDrop = useCallback((e: React.DragEvent, targetPath: string) => {
    e.preventDefault();
    const screenId = e.dataTransfer.getData('text/screen-id');
    if (screenId && onMoveScreen) {
      onMoveScreen(projectId, screenId, targetPath);
    }
    setDropIndicator(null);
  }, [projectId, onMoveScreen]);

  const handleAddFolder = useCallback(() => {
    if (newFolderName.trim() && onCreateFolder) {
      onCreateFolder(projectId, newFolderName.trim());
      setNewFolderName('');
      setIsAddingFolder(false);
    }
  }, [newFolderName, onCreateFolder, projectId]);

  return (
    <div className="designer-folder-tree">
      {/* Root screens */}
      <div
        className="designer-folder-drop-zone"
        onDrop={(e) => handleDrop(e, '')}
        onDragOver={(e) => e.preventDefault()}
      >
        {rootScreens.map(screen => {
          const isRenamingScreen = renamingScreenId === screen.id;
          const isDropBefore = dropIndicator?.targetScreenId === screen.id && dropIndicator?.insertBefore;
          const isDropAfter = dropIndicator?.targetScreenId === screen.id && !dropIndicator?.insertBefore;
          return (
            <div
              key={screen.id}
              style={{ position: 'relative' }}
            >
              {isDropBefore && (
                <div className="designer-screen-drop-line" style={{ top: 0 }} />
              )}
              <div
                className={`designer-screen-item ${currentScreenId === screen.id ? 'active' : ''}`}
                style={{ paddingLeft: 8 }}
                onClick={() => {
                  if (isRenamingScreen) return;
                  if (currentScreenId === screen.id) {
                    onDeselectScreen();
                  } else {
                    onSelectScreen(projectId, screen.id);
                  }
                }}
                onContextMenu={e => onScreenContextMenu?.(e, projectId, screen.id)}
                draggable={!!onMoveScreen && !isRenamingScreen}
                onDragStart={(e) => {
                  e.dataTransfer.setData('text/screen-id', screen.id);
                  e.dataTransfer.setData('text/folder-path', '');
                  e.dataTransfer.effectAllowed = 'move';
                }}
                onDragOver={(e) => {
                  if (!onReorderScreen) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = 'move';
                  const rect = e.currentTarget.getBoundingClientRect();
                  const midY = rect.top + rect.height / 2;
                  setDropIndicator({ targetScreenId: screen.id, insertBefore: e.clientY < midY });
                }}
                onDrop={(e) => {
                  if (!onReorderScreen) return;
                  e.preventDefault();
                  e.stopPropagation();
                  const draggedId = e.dataTransfer.getData('text/screen-id');
                  const draggedFolder = e.dataTransfer.getData('text/folder-path');
                  // Only reorder within the same folder (root)
                  if (draggedId && draggedId !== screen.id && draggedFolder === '') {
                    const rect = e.currentTarget.getBoundingClientRect();
                    const midY = rect.top + rect.height / 2;
                    onReorderScreen(draggedId, screen.id, e.clientY < midY);
                  }
                  setDropIndicator(null);
                }}
                onDragLeave={() => {
                  if (dropIndicator?.targetScreenId === screen.id) {
                    setDropIndicator(null);
                  }
                }}
              >
                {homeScreenId === screen.id ? <Home size={11} style={{ color: 'var(--accent)', flexShrink: 0 }} /> : <FileCode size={11} />}
                {isRenamingScreen ? (
                  <input
                    className="designer-rename-input"
                    defaultValue={screen.name}
                    autoFocus
                    onKeyDown={e => {
                      if (e.key === 'Enter') {
                        const val = (e.target as HTMLInputElement).value.trim();
                        if (val && val !== screen.name && onRenameScreen) {
                          onRenameScreen(projectId, screen.id, val);
                        }
                        onRenameDone?.();
                      }
                      if (e.key === 'Escape') {
                        onRenameDone?.();
                      }
                    }}
                    onBlur={e => {
                      const val = e.target.value.trim();
                      if (val && val !== screen.name && onRenameScreen) {
                        onRenameScreen(projectId, screen.id, val);
                      }
                      onRenameDone?.();
                    }}
                    onClick={e => e.stopPropagation()}
                    style={{ flex: 1, minWidth: 0 }}
                  />
                ) : (
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {screen.name}
                    {dirtyScreenIds?.has(screen.id) && <span className="designer-dirty-mark">*</span>}
                  </span>
                )}
              </div>
              {isDropAfter && (
                <div className="designer-screen-drop-line" style={{ bottom: 0 }} />
              )}
            </div>
          );
        })}
      </div>

      {/* Folders */}
      {tree.map(node => (
        <div
          key={node.path}
          onDrop={(e) => handleDrop(e, node.path)}
          onDragOver={(e) => e.preventDefault()}
        >
          <FolderItem
            node={node}
            depth={0}
            currentScreenId={currentScreenId}
            onSelectScreen={onSelectScreen}
            onDeselectScreen={onDeselectScreen}
            projectId={projectId}
            onMoveScreen={onMoveScreen}
            onReorderScreen={onReorderScreen}
            onScreenContextMenu={onScreenContextMenu}
            onFolderContextMenu={onFolderContextMenu}
            onCreateFolder={onCreateFolder}
            onRenameFolder={onRenameFolder}
            onRenameScreen={onRenameScreen}
            renamingFolderPath={renamingFolderPath}
            renamingScreenId={renamingScreenId}
            onRenameDone={onRenameDone}
            dirtyScreenIds={dirtyScreenIds}
            dropIndicator={dropIndicator}
            onDropIndicatorChange={setDropIndicator}
            homeScreenId={homeScreenId}
            folderPermissions={folderPermissions}
          />
        </div>
      ))}

      {/* Add folder button + input */}
      {onCreateFolder && !isAddingFolder && (
        <button
          className="designer-folder-create-btn"
          onClick={() => setIsAddingFolder(true)}
        >
          <Plus size={10} />
          <span>新建文件夹</span>
        </button>
      )}
      {isAddingFolder && (
        <div style={{ padding: '4px 8px' }}>
          <input
            className="designer-rename-input"
            value={newFolderName}
            onChange={e => setNewFolderName(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') handleAddFolder();
              if (e.key === 'Escape') setIsAddingFolder(false);
            }}
            onBlur={() => setIsAddingFolder(false)}
            placeholder="文件夹名称"
            style={{ width: '100%' }}
          />
        </div>
      )}
    </div>
  );
}
