import { useState, useEffect, useCallback, useRef } from 'react';
import { ChevronDown, ChevronRight, File, Folder, FolderOpen, Search, List, X, Trash2, Pencil, Copy, ExternalLink, Replace, FilePlus, FolderPlus, MessageSquare, GitBranch, Database, CaseSensitive } from 'lucide-react';
import { getFileIcon } from './file-icons';
import GitPanel from './GitPanel';
import DbPanel from './DbPanel';
import '../styles/file-explorer.css';

interface FileNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  children?: FileNode[];
}

interface SearchResult {
  file: string;
  line: number;
  text: string;
}

interface ContextMenuState {
  visible: boolean;
  x: number;
  y: number;
  node: FileNode | null;
  targetPath: string | null;
}

interface FileExplorerProps {
  workspace: string;
  onFileOpen: (path: string, line?: number) => void;
  onWorkspaceChanged: (path: string) => void;
  onAddToChat?: (tag: { type: 'file' | 'code' | 'table'; filePath: string; startLine?: number; endLine?: number; content?: string; tableName?: string; dbType?: string }) => void;
  onGitDiffOpen?: (filePath: string, staged: boolean) => void;
  onCommitDiffOpen?: (hash: string, filePath: string) => void;
  onDbTableClick?: (params: {
    connId: string;
    connName: string;
    dbType: string;
    jdbcUrl: string;
    username: string;
    password: string;
    schema: string;
    tableName: string;
  }) => void;
  onShowTableStructure?: (params: {
    connId: string;
    connName: string;
    dbType: string;
    jdbcUrl: string;
    username: string;
    password: string;
    schema: string;
    tableName: string;
  }) => void;
  onNewSqlEditor?: (params: {
    connId: string;
    connName: string;
    dbType: string;
    jdbcUrl: string;
    username: string;
    password: string;
    schema: string;
  }) => void;
  refreshKey?: number;
}

type TabType = 'files' | 'search' | 'git' | 'db';

const MAX_DISPLAY_RESULTS = 500;

const filterEntries = (entries: Array<{ name: string; isDirectory: boolean; path: string }>): FileNode[] =>
  entries
    .filter((e) => !e.name.startsWith('.') && e.name !== 'node_modules')
    .map((e) => ({
      name: e.name,
      path: e.path,
      type: e.isDirectory ? 'directory' : 'file',
    }));


const sortNodes = (a: FileNode, b: FileNode) => {
  if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
  return a.name.localeCompare(b.name);
};

const filterTree = (nodes: FileNode[], query: string): FileNode[] => {
  if (!query) return nodes;
  const q = query.toLowerCase();
  return nodes.reduce<FileNode[]>((acc, node) => {
    if (node.type === 'directory') {
      const filteredChildren = node.children ? filterTree(node.children, query) : [];
      if (filteredChildren.length > 0 || node.name.toLowerCase().includes(q)) {
        acc.push({ ...node, children: filteredChildren.length > 0 ? filteredChildren : node.children });
      }
    } else {
      if (node.name.toLowerCase().includes(q)) {
        acc.push(node);
      }
    }
    return acc;
  }, []);
};

export default function FileExplorer({ workspace, onFileOpen, onWorkspaceChanged, onAddToChat, onGitDiffOpen, onCommitDiffOpen, onDbTableClick, onShowTableStructure, onNewSqlEditor, refreshKey }: FileExplorerProps) {
  const [tree, setTree] = useState<FileNode[]>([]);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const expandedPathsRef = useRef<Set<string>>(new Set());
  const [currentPath, setCurrentPath] = useState('');
  const [activeTab, setActiveTab] = useState<TabType>('files');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [resultTruncated, setResultTruncated] = useState(false);
  const [contextMenu, setContextMenu] = useState<ContextMenuState>({ visible: false, x: 0, y: 0, node: null, targetPath: null });
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [replaceQuery, setReplaceQuery] = useState('');
  const [showReplace, setShowReplace] = useState(false);
  const [searchIgnoreCase, setSearchIgnoreCase] = useState(true);
  const [isReplacing, setIsReplacing] = useState(false);
  const replaceInputRef = useRef<HTMLInputElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const createInputRef = useRef<HTMLInputElement>(null);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortControllerRef = useRef(0);
  const [creating, setCreating] = useState<{ type: 'file' | 'directory'; dirPath: string } | null>(null);
  const [createValue, setCreateValue] = useState('');
  const [fileFilter, setFileFilter] = useState('');
  const [showFileFilter, setShowFileFilter] = useState(false);
  const fileFilterRef = useRef<HTMLInputElement>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);

  const prevWorkspaceRef = useRef('');

  useEffect(() => {
    if (workspace) {
      setCurrentPath(workspace);
      // Full reload only on workspace change, not on refreshKey change
      // (refreshKey changes are handled by the smart refresh effect below)
      if (workspace !== prevWorkspaceRef.current) {
        prevWorkspaceRef.current = workspace;
        loadDirectory(workspace);
      }
    } else {
      setCurrentPath('');
      setTree([]);
      setExpandedPaths(new Set());
      prevWorkspaceRef.current = '';
    }
  }, [workspace, refreshKey]);

  useEffect(() => {
    if (activeTab === 'search' && searchInputRef.current) {
      searchInputRef.current.focus();
    }
  }, [activeTab]);

  useEffect(() => {
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    const handleFileChanged = (_data: unknown) => {
      if (!currentPath) return;

      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(async () => {
        const expandedList = Array.from(expandedPathsRef.current);
        const pathsToFetch = [currentPath, ...expandedList];
        const fetched = new Map<string, FileNode[]>();

        await Promise.all(
          pathsToFetch.map(async (p) => {
            try {
              const result = await window.electronAPI.invoke('file:list', p) as { success: boolean; entries?: Array<{ name: string; isDirectory: boolean; path: string }> };
              if (result.success && result.entries) {
                fetched.set(p, filterEntries(result.entries));
              }
            } catch {}
          }),
        );

        setTree((prev) => {
          const rootEntries = fetched.get(currentPath);
          if (!rootEntries) return prev;

          // Check if root structure actually changed (files added/removed/renamed)
          const oldRootNames = prev.map((n) => n.name + ':' + n.type).sort().join(',');
          const newRootNames = rootEntries.map((n) => n.name + ':' + n.type).sort().join(',');
          if (oldRootNames === newRootNames) {
            // Root structure unchanged — check if any subtree structure changed
            let anySubtreeChanged = false;
            for (const p of expandedList) {
              const newEntries = fetched.get(p);
              if (!newEntries) continue;
              const findInTree = (nodes: FileNode[]): FileNode | undefined => {
                for (const n of nodes) {
                  if (n.path === p) return n;
                  if (n.children) { const found = findInTree(n.children); if (found) return found; }
                }
                return undefined;
              };
              const node = findInTree(prev);
              if (!node?.children) continue;
              const oldNames = node.children.map((c) => c.name + ':' + c.type).sort().join(',');
              const newNames = newEntries.map((c) => c.name + ':' + c.type).sort().join(',');
              if (oldNames !== newNames) {
                anySubtreeChanged = true;
                break;
              }
            }
            if (!anySubtreeChanged) return prev;
          }

          // Start with root, preserving existing children
          let newTree: FileNode[] = rootEntries.map((node) => {
            const existing = prev.find((n) => n.path === node.path);
            if (existing?.children) return { ...node, children: existing.children };
            return node;
          });

          // Apply subtree refreshes, preserving grandchildren
          for (const p of expandedList) {
            const newEntries = fetched.get(p);
            if (!newEntries) continue;
            const mergeSubtree = (nodes: FileNode[], target: string): FileNode[] =>
              nodes.map((n) => {
                if (n.path === target) {
                  // Check if this subtree actually changed
                  const oldNames = (n.children || []).map((c) => c.name + ':' + c.type).sort().join(',');
                  const newNames = newEntries.map((c) => c.name + ':' + c.type).sort().join(',');
                  if (oldNames === newNames) return n; // No change, keep as-is
                  const merged = newEntries.map((child) => {
                    const existing = n.children?.find((c) => c.path === child.path);
                    return existing?.children ? { ...child, children: existing.children } : child;
                  });
                  return { ...n, children: merged };
                }
                if (n.children) return { ...n, children: mergeSubtree(n.children, target) };
                return n;
              });
            newTree = mergeSubtree(newTree, p);
          }

          return newTree;
        });
      }, 500);
    };

    window.electronAPI?.on('file:changed', handleFileChanged);
    return () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      window.electronAPI?.removeListener?.('file:changed', handleFileChanged);
    };
  }, [currentPath]);

  useEffect(() => {
    if (refreshKey === undefined || !currentPath) return;
    // Smart refresh: reload root + all expanded dirs, preserving expanded children
    (async () => {
      const expandedList = Array.from(expandedPathsRef.current);
      const pathsToFetch = [currentPath, ...expandedList];
      const fetched = new Map<string, FileNode[]>();

      await Promise.all(
        pathsToFetch.map(async (p) => {
          try {
            const result = await window.electronAPI.invoke('file:list', p) as { success: boolean; entries?: Array<{ name: string; isDirectory: boolean; path: string }> };
            if (result.success && result.entries) {
              fetched.set(p, filterEntries(result.entries));
            }
          } catch {}
        }),
      );

      setTree((prev) => {
        const rootEntries = fetched.get(currentPath);
        if (!rootEntries) return prev;

        let newTree: FileNode[] = rootEntries.map((node) => {
          const existing = prev.find((n) => n.path === node.path);
          if (existing?.children) return { ...node, children: existing.children };
          return node;
        });

        for (const p of expandedList) {
          const newEntries = fetched.get(p);
          if (!newEntries) continue;
          const mergeSubtree = (nodes: FileNode[], target: string): FileNode[] =>
            nodes.map((n) => {
              if (n.path === target) {
                const merged = newEntries.map((child) => {
                  const existing = n.children?.find((c) => c.path === child.path);
                  return existing?.children ? { ...child, children: existing.children } : child;
                });
                return { ...n, children: merged };
              }
              if (n.children) return { ...n, children: mergeSubtree(n.children, target) };
              return n;
            });
          newTree = mergeSubtree(newTree, p);
        }

        return newTree;
      });
    })();
  }, [refreshKey]);

  useEffect(() => {
  const handleClick = () => setContextMenu({ visible: false, x: 0, y: 0, node: null, targetPath: null });
  document.addEventListener('click', handleClick);
  return () => document.removeEventListener('click', handleClick);
  }, []);

  // After the menu renders, clamp its position so it never overflows the window
  useEffect(() => {
  if (!contextMenu.visible || !contextMenuRef.current) return;
  const menu = contextMenuRef.current;
  const rect = menu.getBoundingClientRect();
  const margin = 8;
  let { x, y } = contextMenu;
  if (rect.right > window.innerWidth - margin) {
  x = Math.max(margin, window.innerWidth - rect.width - margin);
  }
  if (rect.bottom > window.innerHeight - margin) {
  y = Math.max(margin, window.innerHeight - rect.height - margin);
  }
  if (x !== contextMenu.x || y !== contextMenu.y) {
  setContextMenu((prev) => ({ ...prev, x, y }));
  }
  }, [contextMenu.visible, contextMenu.x, contextMenu.y]);

  useEffect(() => {
    if (renaming && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [renaming]);

  useEffect(() => {
    if (creating && createInputRef.current) {
      createInputRef.current.focus();
    }
  }, [creating]);


  const initWorkspace = async () => {
    try {
      const config = await window.electronAPI.invoke('config:get') as { workspace?: string };
      const ws = config?.workspace;
      if (ws) {
        setCurrentPath(ws);
        await loadDirectory(ws);
      }
    } catch {}
  };

  const loadDirectory = async (dirPath: string) => {
    try {
      const result = await window.electronAPI.invoke('file:list', dirPath) as { success: boolean; entries?: Array<{ name: string; isDirectory: boolean; path: string }>; error?: string };
      if (result.success && result.entries) {
        setTree(filterEntries(result.entries));
      } else {
        setTree([]);
      }
    } catch {
      setTree([]);
    }
  };

  const fillChildren = (nodes: FileNode[], targetPath: string, children: FileNode[]): FileNode[] => {
    return nodes.map((n) => {
      if (n.path === targetPath) return { ...n, children };
      if (n.children) return { ...n, children: fillChildren(n.children, targetPath, children) };
      return n;
    });
  };

  // 收集树中所有未加载子节点的目录路径
  const collectUnloadedDirs = (nodes: FileNode[]): string[] => {
    const dirs: string[] = [];
    for (const n of nodes) {
      if (n.type === 'directory') {
        if (!n.children) {
          dirs.push(n.path);
        } else {
          dirs.push(...collectUnloadedDirs(n.children));
        }
      }
    }
    return dirs;
  };

  const deepLoadGenRef = useRef(0);

  // 过滤器激活时，递归加载所有子目录以实现全局搜索
  useEffect(() => {
    if (!fileFilter.trim() || !currentPath) return;

    const gen = ++deepLoadGenRef.current;
    let cancelled = false;

    // 防抖：等待用户停止输入后再开始深度加载
    const timer = setTimeout(() => {
      if (cancelled) return;
      deepLoad();
    }, 300);

    const deepLoad = async () => {
      let currentTree = tree; // 跟踪最新树状态，避免闭包陈旧
      // 分批加载，每批加载所有当前未加载的目录，直到全部加载完
      for (let round = 0; round < 20 && !cancelled; round++) {
        const unloadedDirs = collectUnloadedDirs(currentTree);
        if (unloadedDirs.length === 0) break;

        const results = await Promise.all(
          unloadedDirs.map(async (dirPath) => {
            try {
              const result = await window.electronAPI.invoke('file:list', dirPath) as {
                success: boolean;
                entries?: Array<{ name: string; isDirectory: boolean; path: string }>;
              };
              if (result.success && result.entries) {
                return { dirPath, children: filterEntries(result.entries) };
              }
            } catch {}
            return null;
          }),
        );

        if (cancelled || gen !== deepLoadGenRef.current) return;

        // 更新本地跟踪的树状态
        for (const r of results) {
          if (r) currentTree = fillChildren(currentTree, r.dirPath, r.children);
        }
        setTree(currentTree);
      }
    };

    return () => { cancelled = true; clearTimeout(timer); };
  }, [fileFilter, currentPath]);

  const toggleExpand = useCallback(async (node: FileNode) => {
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(node.path)) next.delete(node.path);
      else next.add(node.path);
      expandedPathsRef.current = next;
      return next;
    });

    if (node.type === 'directory' && !node.children) {
      try {
        const result = await window.electronAPI.invoke('file:list', node.path) as { success: boolean; entries?: Array<{ name: string; isDirectory: boolean; path: string }> };
        if (result.success && result.entries) {
          setTree((prev) => fillChildren(prev, node.path, filterEntries(result.entries!)));
        }
      } catch {}
    }
  }, []);

  const refreshSubtree = async (dirPath: string) => {
    try {
      const result = await window.electronAPI.invoke('file:list', dirPath) as { success: boolean; entries?: Array<{ name: string; isDirectory: boolean; path: string }> };
      if (result.success && result.entries) {
        const newEntries = filterEntries(result.entries);
        setTree((prev) => {
          const mergeChildren = (nodes: FileNode[], targetPath: string): FileNode[] => {
            return nodes.map((n) => {
              if (n.path === targetPath) {
                // Replace children but preserve grandchildren of expanded child nodes
                const merged = newEntries.map((child) => {
                  const existing = n.children?.find((c) => c.path === child.path);
                  if (existing?.children) return { ...child, children: existing.children };
                  return child;
                });
                return { ...n, children: merged };
              }
              if (n.children) return { ...n, children: mergeChildren(n.children, targetPath) };
              return n;
            });
          };
          return mergeChildren(prev, dirPath);
        });
      }
    } catch {}
  };

  const refreshAll = useCallback(() => {
    if (currentPath) refreshSubtree(currentPath);
    for (const p of expandedPaths) refreshSubtree(p);
  }, [currentPath, expandedPaths]);
  const handleContextMenu = useCallback((e: React.MouseEvent, node: FileNode) => {
  e.preventDefault();
  e.stopPropagation();
  const targetPath = node.type === 'directory' ? node.path : node.path.substring(0, Math.max(node.path.lastIndexOf('\\'), node.path.lastIndexOf('/')));
  // Estimate menu size and clamp within viewport so it never overflows the window
  const menuWidth = 200;
  const menuHeight = 260;
  const x = Math.min(e.clientX, window.innerWidth - menuWidth - 8);
  const y = Math.min(e.clientY, window.innerHeight - menuHeight - 8);
  setContextMenu({ visible: true, x: Math.max(8, x), y: Math.max(8, y), node, targetPath: targetPath || currentPath });
  }, [currentPath]);


  const handleDelete = useCallback(async () => {
    if (!contextMenu.node) return;
    const node = contextMenu.node;
    const confirmed = window.confirm(`确定要删除 "${node.name}" 吗？`);
    if (!confirmed) return;
    const result = await window.electronAPI.invoke('file:delete', node.path) as { success: boolean };
    if (result.success) refreshAll();
    setContextMenu({ visible: false, x: 0, y: 0, node: null, targetPath: null });
  }, [contextMenu.node, refreshAll]);

  const handleRenameStart = useCallback(() => {
    if (!contextMenu.node) return;
    setRenameValue(contextMenu.node.name);
    setRenaming(contextMenu.node.path);
    setContextMenu({ visible: false, x: 0, y: 0, node: null, targetPath: null });
  }, [contextMenu.node]);

  const handleRenameSubmit = useCallback(async () => {
    if (!renaming || !renameValue.trim()) {
      setRenaming(null);
      return;
    }
    const result = await window.electronAPI.invoke('file:rename', renaming, renameValue.trim()) as { success: boolean; newPath?: string };
    if (result.success) refreshAll();
    setRenaming(null);
  }, [renaming, renameValue, refreshAll]);

  const handleCopyPath = useCallback(async () => {
    if (!contextMenu.node) return;
    await window.electronAPI.invoke('file:copy-path', contextMenu.node.path);
    setContextMenu({ visible: false, x: 0, y: 0, node: null, targetPath: null });
  }, [contextMenu.node]);

  const handleShowInExplorer = useCallback(async () => {
    if (!contextMenu.node) return;
    await window.electronAPI.invoke('file:show-in-explorer', contextMenu.node.path);
    setContextMenu({ visible: false, x: 0, y: 0, node: null, targetPath: null });
  }, [contextMenu.node]);

  const handleAddFileToChat = useCallback(() => {
    if (!contextMenu.node || contextMenu.node.type !== 'file' || !onAddToChat) return;
    onAddToChat({ type: 'file', filePath: contextMenu.node.path });
    setContextMenu({ visible: false, x: 0, y: 0, node: null, targetPath: null });
  }, [contextMenu.node, onAddToChat]);

  const handleCreateStart = useCallback((type: 'file' | 'directory') => {
    const dirPath = contextMenu.targetPath || currentPath;
    setCreateValue('');
    setCreating({ type, dirPath });
    setContextMenu({ visible: false, x: 0, y: 0, node: null, targetPath: null });
    // Auto-expand the target directory if not already expanded
    if (dirPath && !expandedPaths.has(dirPath) && dirPath !== currentPath) {
      toggleExpand({ name: '', path: dirPath, type: 'directory' } as FileNode);
    }
  }, [contextMenu.targetPath, currentPath, expandedPaths, toggleExpand]);

  const handleCreateSubmit = useCallback(async () => {
    if (!creating || !createValue.trim()) {
      setCreating(null);
      return;
    }
    const name = createValue.trim();
    const channel = creating.type === 'file' ? 'file:create-file' : 'file:create-directory';
    const result = await window.electronAPI.invoke(channel, creating.dirPath, name) as { success: boolean; error?: string };
    if (result.success) {
      await refreshAll();
    } else if (result.error) {
      console.error(`Create ${creating.type} failed:`, result.error);
    }
    setCreating(null);
  }, [creating, createValue, refreshAll]);

  const handleBlankAreaContextMenu = useCallback((e: React.MouseEvent) => {
  if (!currentPath) return;
  e.preventDefault();
  e.stopPropagation();
  const menuWidth = 200;
  const menuHeight = 120;
  const x = Math.min(e.clientX, window.innerWidth - menuWidth - 8);
  const y = Math.min(e.clientY, window.innerHeight - menuHeight - 8);
  setContextMenu({ visible: true, x: Math.max(8, x), y: Math.max(8, y), node: null, targetPath: currentPath });
  }, [currentPath]);

  const handleOpenWorkspace = async () => {
    try {
      const ws = await window.electronAPI.invoke('workspace:open') as string | null;
      if (ws) {
        setCurrentPath(ws);
        onWorkspaceChanged(ws);
        await loadDirectory(ws);
      }
    } catch {}
  };

  const performSearch = useCallback(async (query: string) => {
    if (!query.trim() || !currentPath) {
      setSearchResults([]);
      setSearchError('');
      setResultTruncated(false);
      return;
    }

    const searchId = ++abortControllerRef.current;
    setIsSearching(true);
    setSearchError('');

    try {
      const result = await window.electronAPI.invoke('file:search', currentPath, query.trim(), searchIgnoreCase) as {
        success: boolean;
        results?: SearchResult[];
        error?: string;
      };

      if (searchId !== abortControllerRef.current) return;

      if (result.success && result.results) {
        setResultTruncated(result.results.length >= MAX_DISPLAY_RESULTS);
        setSearchResults(result.results);
      } else {
        setSearchError(result.error || 'Search failed');
        setSearchResults([]);
      }
    } catch (err) {
      if (searchId !== abortControllerRef.current) return;
      setSearchError(String(err));
      setSearchResults([]);
    } finally {
      if (searchId === abortControllerRef.current) {
        setIsSearching(false);
      }
    }
  }, [currentPath, searchIgnoreCase]);

  useEffect(() => {
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);

    const query = searchQuery.trim();
    if (!query) {
      setSearchResults([]);
      setSearchError('');
      setResultTruncated(false);
      setIsSearching(false);
      return;
    }

    setIsSearching(true);
    debounceTimerRef.current = setTimeout(() => performSearch(searchQuery), 300);

    return () => {
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    };
  }, [searchQuery, performSearch]);

  const handleSearchKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      setSearchQuery('');
      setSearchResults([]);
      setActiveTab('files');
    }
  };

  const handleReplaceAll = useCallback(async () => {
    if (!searchQuery.trim() || !replaceQuery.trim() || !currentPath || searchResults.length === 0) return;

    const confirmed = window.confirm(`确定要将所有 "${searchQuery}" 替换为 "${replaceQuery}" 吗？\n将影响 ${searchResults.length} 处匹配。`);
    if (!confirmed) return;

    setIsReplacing(true);
    try {
      const fileMap = new Map<string, SearchResult[]>();
      for (const r of searchResults) {
        if (!fileMap.has(r.file)) fileMap.set(r.file, []);
        fileMap.get(r.file)!.push(r);
      }

      let totalReplaced = 0;
      for (const [filePath] of fileMap) {
        const result = await window.electronAPI.invoke('file:replace-in-file', filePath, searchQuery, replaceQuery) as { success: boolean; matchCount?: number; error?: string };
        if (result.success && result.matchCount) totalReplaced += result.matchCount;
      }

      await performSearch(searchQuery);
      alert(`替换完成，共替换 ${totalReplaced} 处`);
    } catch (err) {
      alert(`替换失败: ${String(err)}`);
    } finally {
      setIsReplacing(false);
    }
  }, [searchQuery, replaceQuery, currentPath, searchResults, performSearch]);

  const getRelativePath = (filePath: string) => {
    if (currentPath && filePath.startsWith(currentPath)) {
      return filePath.slice(currentPath.length).replace(/^\\?\//, '');
    }
    return filePath;
  };

  const highlightMatch = (text: string, query: string) => {
    if (!query) return text;
    const idx = text.toLowerCase().indexOf(query.toLowerCase());
    if (idx === -1) return text;
    return (
      <>
        {text.slice(0, idx)}
        <mark className="search-highlight">{text.slice(idx, idx + query.length)}</mark>
        {text.slice(idx + query.length)}
      </>
    );
  };

  const renderNode = (node: FileNode, depth: number) => {
    const isDir = node.type === 'directory';
    const isExpanded = fileFilter ? (isDir && !!node.children && node.children.length > 0) : expandedPaths.has(node.path);
    const isRenaming = renaming === node.path;
    const fileIcon = isDir ? null : getFileIcon(node.name);
    const IconComponent = fileIcon?.icon || File;
    const iconColor = fileIcon?.color || 'var(--text-muted)';

    return (
      <div key={node.path}>
        <div
          className={`file-node${isDir ? ' file-node-dir' : ''}`}
          style={{ paddingLeft: depth * 16 + 8 }}
          onClick={() => (isDir ? toggleExpand(node) : onFileOpen(node.path))}
          onContextMenu={(e) => handleContextMenu(e, node)}
        >
          {isDir ? (
            <>
              <span style={{ flexShrink: 0, display: 'flex' }}>{isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</span>
              {isExpanded ? <FolderOpen size={14} className="icon-folder" /> : <Folder size={14} className="icon-folder" />}
            </>
          ) : (
            <>
              <span style={{ width: 14, flexShrink: 0 }} />
              <IconComponent size={14} className="icon-file" style={{ color: iconColor }} />
            </>
          )}
          {isRenaming ? (
            <input
              ref={renameInputRef}
              className="rename-input"
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onBlur={handleRenameSubmit}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleRenameSubmit();
                if (e.key === 'Escape') setRenaming(null);
              }}
              onClick={(e) => e.stopPropagation()}
            />
          ) : (
            <span className="file-node-name">{node.name}</span>
          )}
        </div>
        {isDir && isExpanded && node.children && (
          <div>
            {node.children.sort(sortNodes).map((child) => renderNode(child, depth + 1))}
            {creating && creating.dirPath === node.path && (
              <div className="file-node" style={{ paddingLeft: (depth + 1) * 16 + 8 }}>
                {creating.type === 'file' ? <FilePlus size={14} /> : <FolderPlus size={14} className="icon-folder" />}
                <input
                  ref={createInputRef}
                  className="rename-input"
                  placeholder={creating.type === 'file' ? '文件名...' : '文件夹名...'}
                  value={createValue}
                  onChange={(e) => setCreateValue(e.target.value)}
                  onBlur={handleCreateSubmit}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleCreateSubmit();
                    if (e.key === 'Escape') setCreating(null);
                  }}
                  onClick={(e) => e.stopPropagation()}
                />
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="file-explorer">
      <div className="explorer-tabs">
        <button className={`explorer-tab ${activeTab === 'files' ? 'active' : ''}`} onClick={() => setActiveTab('files')}>
          <List size={13} />
          <span>文件</span>
        </button>
        <button className={`explorer-tab ${activeTab === 'search' ? 'active' : ''}`} onClick={() => setActiveTab('search')}>
          <Search size={13} />
          <span>搜索</span>
        </button>
        <button className={`explorer-tab ${activeTab === 'git' ? 'active' : ''}`} onClick={() => setActiveTab('git')}>
          <GitBranch size={13} />
          <span>Git</span>
        </button>
        <button className={`explorer-tab ${activeTab === 'db' ? 'active' : ''}`} onClick={() => setActiveTab('db')}>
          <Database size={13} />
          <span>DB</span>
        </button>
      </div>

      {currentPath && (
        <div className="workspace-path" title={currentPath}>
          {currentPath.split(/[\\/]/).pop() || currentPath}
        </div>
      )}

      {activeTab === 'files' && (
        <>
          <div className="panel-header">
            <span>Explorer</span>
            <div style={{ display: 'flex', gap: 2 }}>
              <button className={`icon-button${showFileFilter ? ' active' : ''}`} onClick={() => { if (showFileFilter) { setShowFileFilter(false); setFileFilter(''); } else { setShowFileFilter(true); setTimeout(() => fileFilterRef.current?.focus(), 0); } }} title="过滤文件">
                <Search size={14} />
              </button>
              <button className="icon-button" onClick={handleOpenWorkspace} title="Open Workspace">
                <FolderOpen size={14} />
              </button>
            </div>
          </div>
          {showFileFilter && (
            <div className="search-input-wrapper" style={{ padding: '4px 8px' }}>
              <Search size={13} className="search-input-icon" />
              <input
                ref={fileFilterRef}
                type="text"
                placeholder="过滤文件名..."
                value={fileFilter}
                onChange={(e) => setFileFilter(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Escape') { setShowFileFilter(false); setFileFilter(''); } }}
                className="search-field-input"
              />
              {fileFilter && (
                <button className="search-clear-btn" onClick={() => setFileFilter('')}>
                  <X size={14} />
                </button>
              )}
            </div>
          )}
          <div className="file-tree" onContextMenu={handleBlankAreaContextMenu}>
            {!currentPath ? (
              <div className="file-empty">
                <span>No workspace opened</span>
                <button className="open-ws-btn" onClick={handleOpenWorkspace}>Open Folder</button>
              </div>
            ) : (
              filterTree(tree, fileFilter).sort(sortNodes).map((node) => renderNode(node, 0))
            )}
            {creating && creating.dirPath === currentPath && (
              <div className="file-node" style={{ paddingLeft: 8 }}>
                {creating.type === 'file' ? <FilePlus size={14} /> : <FolderPlus size={14} className="icon-folder" />}
                <input
                  ref={createInputRef}
                  className="rename-input"
                  placeholder={creating.type === 'file' ? '文件名...' : '文件夹名...'}
                  value={createValue}
                  onChange={(e) => setCreateValue(e.target.value)}
                  onBlur={handleCreateSubmit}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleCreateSubmit();
                    if (e.key === 'Escape') setCreating(null);
                  }}
                  onClick={(e) => e.stopPropagation()}
                />
              </div>
            )}
          </div>
        </>
      )}

      {activeTab === 'search' && (
        <div className="search-panel">
          <div className="search-input-wrapper">
            <Search size={14} className="search-input-icon" />
            <input
              ref={searchInputRef}
              type="text"
              placeholder="搜索文件内容..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={handleSearchKeyDown}
              className="search-field-input"
            />
            <button
              className={`search-toggle-replace${!searchIgnoreCase ? ' active' : ''}`}
              onClick={() => setSearchIgnoreCase(!searchIgnoreCase)}
              title={searchIgnoreCase ? '忽略大小写 (当前开启)' : '忽略大小写 (当前关闭)'}
            >
              <CaseSensitive size={14} />
            </button>
            <button
              className={`search-toggle-replace${showReplace ? ' active' : ''}`}
              onClick={() => setShowReplace(!showReplace)}
              title="切换替换"
            >
              <Replace size={14} />
            </button>
            {searchQuery && (
              <button
                className="search-clear-btn"
                onClick={() => {
                  setSearchQuery('');
                  setSearchResults([]);
                  searchInputRef.current?.focus();
                }}
              >
                <X size={14} />
              </button>
            )}
          </div>
          {showReplace && (
            <div className="search-input-wrapper replace-input-wrapper">
              <span className="replace-arrow">→</span>
              <input
                ref={replaceInputRef}
                type="text"
                placeholder="替换为..."
                value={replaceQuery}
                onChange={(e) => setReplaceQuery(e.target.value)}
                className="search-field-input"
              />
              <button
                className="replace-all-btn"
                onClick={handleReplaceAll}
                disabled={isReplacing || !searchQuery.trim() || searchResults.length === 0}
                title="全部替换"
              >
                {isReplacing ? '...' : '全部替换'}
              </button>
            </div>
          )}
          <div className="search-hint">
            {isSearching ? (
              <span className="search-status">搜索中...</span>
            ) : searchError ? (
              <span className="search-error">{searchError}</span>
            ) : searchResults.length > 0 ? (
              <span className="search-status">
                找到 {searchResults.length} 个结果{resultTruncated && ' (已达上限)'}
              </span>
            ) : searchQuery.trim() ? (
              <span className="search-status">无结果</span>
            ) : (
              <span className="search-status">输入关键词自动搜索 (Ctrl+F)</span>
            )}
          </div>
          <div className="search-results">
            {searchResults.map((result, index) => {
              const fileName = result.file.split(/[/\\]/).pop() || result.file;
              const { icon: SearchIcon, color: searchIconColor } = getFileIcon(fileName);
              return (
                <div
                  key={`${result.file}-${result.line}-${index}`}
                  className="search-result-item"
                  onClick={() => onFileOpen(result.file, result.line)}
                >
                  <div className="search-result-file">
                    <SearchIcon size={12} className="search-result-file-icon" style={{ color: searchIconColor }} />
                    <span className="search-result-path">{getRelativePath(result.file)}</span>
                    <span className="search-result-line">:{result.line}</span>
                  </div>
                  <div className="search-result-text">
                    {highlightMatch(result.text, searchQuery.trim())}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {activeTab === 'git' && (
        <GitPanel workspace={currentPath} onFileOpen={onFileOpen} onGitDiffOpen={onGitDiffOpen} onCommitDiffOpen={onCommitDiffOpen} />
      )}

      {activeTab === 'db' && (
        <DbPanel onTableClick={onDbTableClick} onAddToChat={onAddToChat} onShowTableStructure={onShowTableStructure} onNewSqlEditor={onNewSqlEditor} />
      )}

      {contextMenu.visible && (
      <div
      ref={contextMenuRef}
      className="context-menu"
      style={{ top: contextMenu.y, left: contextMenu.x }}
      onClick={(e) => e.stopPropagation()}
      >
          <div className="context-menu-item" onClick={() => handleCreateStart('file')}>
            <FilePlus size={13} />
            <span>新建文件</span>
          </div>
          <div className="context-menu-item" onClick={() => handleCreateStart('directory')}>
            <FolderPlus size={13} />
            <span>新建文件夹</span>
          </div>
          {contextMenu.node && (
            <>
              <div className="context-menu-separator" />
              <div className="context-menu-item" onClick={handleDelete}>
                <Trash2 size={13} />
                <span>删除</span>
              </div>
              <div className="context-menu-item" onClick={handleRenameStart}>
                <Pencil size={13} />
                <span>重命名</span>
              </div>
              <div className="context-menu-separator" />
              <div className="context-menu-item" onClick={handleCopyPath}>
                <Copy size={13} />
                <span>复制路径</span>
              </div>
              <div className="context-menu-item" onClick={handleShowInExplorer}>
                <ExternalLink size={13} />
                <span>在资源管理器中显示</span>
              </div>
              {contextMenu.node?.type === 'file' && onAddToChat && (
                <div className="context-menu-item" onClick={handleAddFileToChat}>
                  <MessageSquare size={13} />
                  <span>添加到对话</span>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
