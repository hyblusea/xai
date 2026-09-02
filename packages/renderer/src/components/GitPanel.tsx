import { useState, useEffect, useCallback, useRef } from 'react';
import {
  GitBranch, GitCommitHorizontal, RefreshCw, Upload, Download, Cloud,
  ChevronRight, ChevronDown, Minus, Plus, RotateCcw, Trash2, Check,
  FolderGit2, PlusCircle, CornerDownLeft, GitMerge, Archive, ArchiveRestore,
  X, ExternalLink
} from 'lucide-react';
import '../styles/git-panel.css';

interface GitFileStatus {
  path: string;
  status: string;
  staged: boolean;
  oldPath?: string;
}

interface GitStatusData {
  branch: string;
  upstream: string;
  ahead: number;
  behind: number;
  files: GitFileStatus[];
  isRepo: boolean;
}

interface GitLogEntry {
  hash: string;
  shortHash: string;
  author: string;
  email: string;
  date: string;
  subject: string;
  refs: string;
}

interface GitBranchInfo {
  name: string;
  current: boolean;
  remote?: string;
}

interface GitDiffInfo {
  filePath: string;
  hunks: string;
  additions: number;
  deletions: number;
}

interface GitStashEntry {
  index: number;
  message: string;
  branch: string;
}

interface GitCommitDetail {
  hash: string;
  shortHash: string;
  author: string;
  email: string;
  date: string;
  subject: string;
  body: string;
  files: Array<{ path: string; status: string }>;
}

interface GitRemoteInfo {
  name: string;
  url: string;
  type: string;
}

interface GitPanelProps {
  workspace: string;
  onFileOpen?: (path: string, line?: number) => void;
  onGitDiffOpen?: (filePath: string, staged: boolean) => void;
  onCommitDiffOpen?: (hash: string, filePath: string) => void;
}

type GitTab = 'changes' | 'history' | 'branches' | 'stash';

function splitPath(filePath: string): { dir: string; file: string } {
  const lastSlash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  if (lastSlash < 0) return { dir: '', file: filePath };
  return { dir: filePath.substring(0, lastSlash + 1), file: filePath.substring(lastSlash + 1) };
}

function statusLabel(s: string): string {
  switch (s) {
    case 'M': return 'M';
    case 'A': return 'A';
    case 'D': return 'D';
    case 'R': return 'R';
    case 'C': return 'C';
    case '?': return '?';
    case 'U': return 'U';
    case '!': return '!';
    default: return s;
  }
}

function statusClass(s: string, staged: boolean): string {
  if (s === '?') return 'untracked';
  return staged ? 'staged' : 'unstaged';
}

function relativeTime(dateStr: string): string {
  try {
    const d = new Date(dateStr);
    const now = Date.now();
    const diff = now - d.getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days}d ago`;
    return d.toLocaleDateString();
  } catch {
    return dateStr;
  }
}

export default function GitPanel({ workspace, onFileOpen, onGitDiffOpen, onCommitDiffOpen }: GitPanelProps) {
  const [activeTab, setActiveTab] = useState<GitTab>('changes');
  const [gitStatus, setGitStatus] = useState<GitStatusData | null>(null);
  const [log, setLog] = useState<GitLogEntry[]>([]);
  const [branches, setBranches] = useState<GitBranchInfo[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileDiff, setFileDiff] = useState<GitDiffInfo | null>(null);
  const [commitMessage, setCommitMessage] = useState('');
  const [newBranchName, setNewBranchName] = useState('');
  const [loading, setLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const [toastKey, setToastKey] = useState(0);
  const [showStaged, setShowStaged] = useState(true);
  const [showUnstaged, setShowUnstaged] = useState(true);
  const [remoteUrl, setRemoteUrl] = useState('');
  const [initExpanded, setInitExpanded] = useState(true);
  const [stashes, setStashes] = useState<GitStashEntry[]>([]);
  const [stashMessage, setStashMessage] = useState('');
  const [selectedCommit, setSelectedCommit] = useState<GitCommitDetail | null>(null);
  const [commitFileDiff, setCommitFileDiff] = useState<GitDiffInfo | null>(null);
  const [remotes, setRemotes] = useState<GitRemoteInfo[]>([]);
  const [newRemoteName, setNewRemoteName] = useState('');
  const [newRemoteUrl, setNewRemoteUrl] = useState('');
  const [showCommitDetail, setShowCommitDetail] = useState(false);
  const commitInputRef = useRef<HTMLTextAreaElement>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [discardConfirm, setDiscardConfirm] = useState<{ type: 'single'; filePath: string } | { type: 'all' } | null>(null);

  const showToast = useCallback((message: string, type: 'success' | 'error') => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToastKey(prev => prev + 1);
    setToast({ message, type });
    // success auto-dismisses quickly; error stays longer so user can read/copy
    const duration = type === 'error' ? 10000 : 2500;
    toastTimerRef.current = setTimeout(() => setToast(null), duration);
  }, []);

  const handleToastClick = useCallback(async () => {
    if (toast) {
      try {
        await navigator.clipboard.writeText(toast.message);
        if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
        setToastKey(prev => prev + 1);
        setToast({ message: 'Copied!', type: 'success' });
        toastTimerRef.current = setTimeout(() => setToast(null), 1500);
      } catch {
        if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
        setToast(null);
      }
    }
  }, [toast]);

  const refreshStatus = useCallback(async () => {
    try {
      const status = await window.electronAPI.invoke('git:status') as GitStatusData;
      setGitStatus(status);
    } catch {
      setGitStatus({ branch: '', upstream: '', ahead: 0, behind: 0, files: [], isRepo: false });
    }
  }, []);

  const refreshLog = useCallback(async () => {
    try {
      const entries = await window.electronAPI.invoke('git:log', 100) as GitLogEntry[];
      setLog(entries);
    } catch {
      setLog([]);
    }
  }, []);

  const refreshBranches = useCallback(async () => {
    try {
      const list = await window.electronAPI.invoke('git:branches') as GitBranchInfo[];
      setBranches(list);
    } catch {
      setBranches([]);
    }
  }, []);

  const refreshRemote = useCallback(async () => {
    try {
      const url = await window.electronAPI.invoke('git:remote-url') as string;
      setRemoteUrl(url);
    } catch {
      setRemoteUrl('');
    }
  }, []);

  const refreshStashes = useCallback(async () => {
    try {
      const list = await window.electronAPI.invoke('git:stash-list') as GitStashEntry[];
      setStashes(list);
    } catch {
      setStashes([]);
    }
  }, []);

  const refreshRemotes = useCallback(async () => {
    try {
      const list = await window.electronAPI.invoke('git:remotes') as GitRemoteInfo[];
      setRemotes(list);
    } catch {
      setRemotes([]);
    }
  }, []);

  const refreshAll = useCallback(async () => {
    setLoading(true);
    await Promise.all([refreshStatus(), refreshLog(), refreshBranches(), refreshRemote(), refreshStashes(), refreshRemotes()]);
    setLoading(false);
  }, [refreshStatus, refreshLog, refreshBranches, refreshRemote, refreshStashes, refreshRemotes]);

  useEffect(() => {
    if (workspace) {
      refreshAll();
    }
  }, [workspace, refreshAll]);

  // Auto-refresh on git operations
  const refreshAfterAction = useCallback(async () => {
    await refreshStatus();
    setSelectedFile(null);
    setFileDiff(null);
  }, [refreshStatus]);

  // File selection
  const handleFileSelect = useCallback(async (filePath: string, staged: boolean) => {
    setSelectedFile(filePath);
    if (onGitDiffOpen) {
      onGitDiffOpen(filePath, staged);
      return;
    }
    try {
      const diff = await window.electronAPI.invoke('git:file-diff', { filePath, staged }) as GitDiffInfo;
      setFileDiff(diff);
    } catch {
      setFileDiff(null);
    }
  }, [onGitDiffOpen]);

  // Stage / Unstage
  const handleStage = useCallback(async (filePath: string) => {
    await window.electronAPI.invoke('git:stage', filePath);
    await refreshAfterAction();
  }, [refreshAfterAction]);

  const handleUnstage = useCallback(async (filePath: string) => {
    await window.electronAPI.invoke('git:unstage', filePath);
    await refreshAfterAction();
  }, [refreshAfterAction]);

  const handleStageAll = useCallback(async () => {
    try {
      const result = await window.electronAPI.invoke('git:stage-all') as { success: boolean; error?: string };
      if (result.success) {
        showToast('All changes staged', 'success');
      } else {
        showToast(`Stage all failed: ${result.error || 'unknown'}`, 'error');
      }
    } catch (err: any) {
      showToast(`Stage all exception: ${err?.message || String(err)}`, 'error');
    }
    await refreshAfterAction();
  }, [refreshAfterAction, showToast]);

  const handleUnstageAll = useCallback(async () => {
    const result = await window.electronAPI.invoke('git:unstage-all') as { success: boolean };
    if (result.success) {
      showToast('All changes unstaged', 'success');
    } else {
      showToast('Unstage all failed', 'error');
    }
    await refreshAfterAction();
  }, [refreshAfterAction, showToast]);

  // Discard
  const handleDiscard = useCallback((filePath: string) => {
    setDiscardConfirm({ type: 'single', filePath });
  }, []);

  const handleConfirmDiscard = useCallback(async () => {
    if (!discardConfirm) return;
    if (discardConfirm.type === 'single') {
      const result = await window.electronAPI.invoke('git:discard', discardConfirm.filePath) as { success: boolean; output: string };
      if (result.success) {
        showToast('Changes discarded', 'success');
      } else {
        showToast('Failed to discard', 'error');
      }
    } else {
      setActionLoading(true);
      const result = await window.electronAPI.invoke('git:discard-all') as { success: boolean; output: string };
      if (result.success) {
        showToast('All changes discarded', 'success');
      } else {
        showToast(result.output?.trim() || 'Failed to discard all', 'error');
      }
      setActionLoading(false);
    }
    setDiscardConfirm(null);
    await refreshAfterAction();
  }, [discardConfirm, refreshAfterAction, showToast]);

  // Commit
  const handleCommit = useCallback(async () => {
    if (!commitMessage.trim()) return;
    setActionLoading(true);
    try {
      const result = await window.electronAPI.invoke('git:commit', commitMessage.trim()) as { success: boolean; output: string };
      if (result.success) {
        setCommitMessage('');
        showToast('Committed successfully', 'success');
        await Promise.all([refreshStatus(), refreshLog()]);
      } else {
        showToast(result.output || 'Commit failed', 'error');
      }
    } catch (err: any) {
      showToast(`Commit error: ${err?.message || String(err)}`, 'error');
    } finally {
      setActionLoading(false);
      setSelectedFile(null);
      setFileDiff(null);
    }
  }, [commitMessage, refreshStatus, refreshLog, showToast]);

  // Push / Pull / Fetch
  const handlePush = useCallback(async () => {
    setActionLoading(true);
    const result = await window.electronAPI.invoke('git:push') as { success: boolean; output: string };
    if (result.success) {
      showToast('Pushed successfully', 'success');
    } else {
      showToast(result.output?.trim() || 'Push failed', 'error');
    }
    await refreshStatus();
    setActionLoading(false);
  }, [refreshStatus, showToast]);

  const handlePull = useCallback(async () => {
    setActionLoading(true);
    const result = await window.electronAPI.invoke('git:pull') as { success: boolean; output: string };
    if (result.success) {
      showToast('Pulled successfully', 'success');
    } else {
      showToast(result.output?.trim() || 'Pull failed', 'error');
    }
    await Promise.all([refreshStatus(), refreshLog()]);
    setActionLoading(false);
  }, [refreshStatus, refreshLog, showToast]);

  const handleFetch = useCallback(async () => {
    setActionLoading(true);
    const result = await window.electronAPI.invoke('git:fetch') as { success: boolean; output: string };
    if (result.success) {
      showToast('Fetched', 'success');
    } else {
      showToast(result.output?.trim() || 'Fetch failed', 'error');
    }
    await refreshStatus();
    setActionLoading(false);
  }, [refreshStatus, showToast]);

  // Branch operations
  const handleCheckout = useCallback(async (branchName: string) => {
    setActionLoading(true);
    const result = await window.electronAPI.invoke('git:checkout', branchName) as { success: boolean; output: string };
    if (result.success) {
      showToast(`Switched to ${branchName}`, 'success');
    } else {
      showToast(result.output?.trim() || 'Checkout failed', 'error');
    }
    await Promise.all([refreshStatus(), refreshLog(), refreshBranches()]);
    setActionLoading(false);
  }, [refreshStatus, refreshLog, refreshBranches, showToast]);

  const handleCreateBranch = useCallback(async () => {
    if (!newBranchName.trim()) return;
    setActionLoading(true);
    const result = await window.electronAPI.invoke('git:create-branch', newBranchName.trim()) as { success: boolean; output: string };
    if (result.success) {
      setNewBranchName('');
      showToast(`Branch "${newBranchName.trim()}" created`, 'success');
    } else {
      showToast(result.output?.trim() || 'Failed to create branch', 'error');
    }
    await Promise.all([refreshStatus(), refreshBranches()]);
    setActionLoading(false);
  }, [newBranchName, refreshStatus, refreshBranches, showToast]);

  const handleDeleteBranch = useCallback(async (branchName: string, force: boolean = false) => {
    setActionLoading(true);
    const result = await window.electronAPI.invoke('git:delete-branch', branchName, force) as { success: boolean; output: string };
    if (result.success) {
      showToast(`Branch "${branchName}" deleted`, 'success');
    } else {
      showToast(result.output?.trim() || 'Failed to delete branch', 'error');
    }
    await Promise.all([refreshStatus(), refreshBranches()]);
    setActionLoading(false);
  }, [refreshStatus, refreshBranches, showToast]);

  const handleMergeBranch = useCallback(async (branchName: string) => {
    setActionLoading(true);
    const result = await window.electronAPI.invoke('git:merge-branch', branchName) as { success: boolean; output: string };
    if (result.success) {
      showToast(`Merged "${branchName}" into current branch`, 'success');
    } else {
      showToast(result.output?.trim() || 'Merge failed', 'error');
    }
    await Promise.all([refreshStatus(), refreshLog(), refreshBranches()]);
    setActionLoading(false);
  }, [refreshStatus, refreshLog, refreshBranches, showToast]);

  const handleStash = useCallback(async () => {
    setActionLoading(true);
    const result = await window.electronAPI.invoke('git:stash', stashMessage.trim() || undefined) as { success: boolean; output: string };
    if (result.success) {
      setStashMessage('');
      showToast('Changes stashed', 'success');
    } else {
      showToast(result.output?.trim() || 'Stash failed', 'error');
    }
    await Promise.all([refreshStatus(), refreshStashes()]);
    setActionLoading(false);
  }, [stashMessage, refreshStatus, refreshStashes, showToast]);

  const handleStashPop = useCallback(async (index?: number) => {
    setActionLoading(true);
    const result = await window.electronAPI.invoke('git:stash-pop', index) as { success: boolean; output: string };
    if (result.success) {
      showToast('Stash popped', 'success');
    } else {
      showToast(result.output?.trim() || 'Stash pop failed', 'error');
    }
    await Promise.all([refreshStatus(), refreshStashes()]);
    setActionLoading(false);
  }, [refreshStatus, refreshStashes, showToast]);

  const handleStashApply = useCallback(async (index?: number) => {
    setActionLoading(true);
    const result = await window.electronAPI.invoke('git:stash-apply', index) as { success: boolean; output: string };
    if (result.success) {
      showToast('Stash applied', 'success');
    } else {
      showToast(result.output?.trim() || 'Stash apply failed', 'error');
    }
    await refreshStatus();
    setActionLoading(false);
  }, [refreshStatus, showToast]);

  const handleStashDrop = useCallback(async (index?: number) => {
    setActionLoading(true);
    const result = await window.electronAPI.invoke('git:stash-drop', index) as { success: boolean; output: string };
    if (result.success) {
      showToast('Stash dropped', 'success');
    } else {
      showToast(result.output?.trim() || 'Stash drop failed', 'error');
    }
    await refreshStashes();
    setActionLoading(false);
  }, [refreshStashes, showToast]);

  const handleCommitFileClick = useCallback(async (hash: string, filePath: string) => {
    if (onCommitDiffOpen) {
      onCommitDiffOpen(hash, filePath);
      return;
    }
    setCommitFileDiff(null);
    try {
      const diff = await window.electronAPI.invoke('git:commit-file-diff', { hash, filePath }) as GitDiffInfo | null;
      if (diff) setCommitFileDiff(diff);
    } catch {
      setCommitFileDiff(null);
    }
  }, [onCommitDiffOpen]);

  const handleCommitClick = useCallback(async (hash: string) => {
    try {
      const detail = await window.electronAPI.invoke('git:commit-detail', hash) as GitCommitDetail;
      if (detail) {
        setSelectedCommit(detail);
        setCommitFileDiff(null);
        setShowCommitDetail(true);
      }
    } catch {}
  }, []);

  const handleDiscardAll = useCallback(() => {
    setDiscardConfirm({ type: 'all' });
  }, []);

  const handleAddRemote = useCallback(async () => {
    if (!newRemoteName.trim() || !newRemoteUrl.trim()) return;
    setActionLoading(true);
    const result = await window.electronAPI.invoke('git:add-remote', newRemoteName.trim(), newRemoteUrl.trim()) as { success: boolean; output: string };
    if (result.success) {
      setNewRemoteName('');
      setNewRemoteUrl('');
      showToast(`Remote "${newRemoteName.trim()}" added`, 'success');
    } else {
      showToast(result.output?.trim() || 'Failed to add remote', 'error');
    }
    await Promise.all([refreshRemote(), refreshRemotes()]);
    setActionLoading(false);
  }, [newRemoteName, newRemoteUrl, refreshRemote, refreshRemotes, showToast]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      handleCommit();
    }
  }, [handleCommit]);

  // Group files
  const stagedFiles = gitStatus?.files.filter(f => f.staged) ?? [];
  const unstagedFiles = gitStatus?.files.filter(f => !f.staged) ?? [];

  // ── Not a Git Repo ──
  if (gitStatus && !gitStatus.isRepo) {
    return (
      <div className="git-panel">
        <div className="git-branch-bar">
          <GitBranch size={14} className="git-branch-icon" />
          <span className="git-branch-name">No Repository</span>
          <button className="git-action-btn" onClick={refreshAll} title="Refresh">
            <RefreshCw size={12} className={loading ? 'spinning' : ''} />
          </button>
        </div>
        <div className="git-content">
          <div className="git-init-prompt">
            <FolderGit2 size={40} className="init-icon" />
            <div className="init-title">Not a Git repository</div>
            <div className="init-desc">
              This workspace is not tracked by Git yet.<br />
              Open a directory with a .git folder, or initialize a new repository.
            </div>
            <button
              className="git-init-btn"
              onClick={async () => {
                setActionLoading(true);
                try {
                  const result = await window.electronAPI.invoke('git:init') as { success: boolean; output: string };
                  if (result.success) {
                    showToast('Repository initialized', 'success');
                    await refreshAll();
                  } else {
                    showToast(result.output || 'Failed to init', 'error');
                  }
                } catch {
                  showToast('Failed to init', 'error');
                }
                setActionLoading(false);
              }}
              disabled={actionLoading}
            >
              <PlusCircle size={14} />
              Initialize Repository
            </button>
          </div>
        </div>
        {toast && (
          <div key={toastKey} className={`git-toast ${toast.type}`} onClick={handleToastClick} title="Click to copy" style={{ cursor: 'pointer', userSelect: 'text' }}>
            {toast.message}
          </div>
        )}
      </div>
    );
  }

  // ── Main Panel ──
  const parseDiffLines = (hunks: string) => {
    return hunks.split('\n').map((line) => {
      let cls = 'context';
      if (line.startsWith('@@')) cls = 'hunk';
      else if (line.startsWith('+') && !line.startsWith('+++')) cls = 'addition';
      else if (line.startsWith('-') && !line.startsWith('---')) cls = 'deletion';
      return { text: line, cls };
    });
  };

  return (
    <div className="git-panel">
      {/* ── Branch Bar ── */}
      <div className="git-branch-bar">
        <GitBranch size={14} className="git-branch-icon" />
        <span className="git-branch-name">{gitStatus?.branch || '(detached)'}</span>
        {gitStatus?.upstream && (
          <>
            <span className="git-remote-label">
              {gitStatus.upstream.split('/').slice(1).join('/')}
            </span>
            {(gitStatus.ahead > 0 || gitStatus.behind > 0) && (
              <span className="git-branch-sync">
                {gitStatus.ahead > 0 && <span className="ahead">↑{gitStatus.ahead}</span>}
                {gitStatus.behind > 0 && <span className="behind">↓{gitStatus.behind}</span>}
              </span>
            )}
          </>
        )}
        <button className="git-action-btn" onClick={refreshAll} title="Refresh" disabled={loading || actionLoading}>
          <RefreshCw size={12} className={loading ? 'spinning' : ''} />
        </button>
      </div>

      {/* ── Action Bar ── */}
      <div className="git-action-bar">
        <button className="git-action-btn" onClick={handlePush} disabled={actionLoading} title="Push">
          <Upload size={12} />
        </button>
        <button className="git-action-btn" onClick={handlePull} disabled={actionLoading} title="Pull">
          <Download size={12} />
        </button>
        <button className="git-action-btn" onClick={handleFetch} disabled={actionLoading} title="Fetch">
          <Cloud size={12} />
        </button>
        <div className="git-action-spacer" />
        <button className="git-action-btn" onClick={handleStash} disabled={actionLoading} title="Stash Changes">
          <Archive size={12} />
        </button>
        <button className="git-action-btn" onClick={handleDiscardAll} disabled={actionLoading} title="Discard All Changes">
          <RotateCcw size={12} />
        </button>
      </div>

      {/* ── Tab Bar ── */}
      <div className="git-tab-bar">
        <div className={`git-tab ${activeTab === 'changes' ? 'active' : ''}`} onClick={() => setActiveTab('changes')}>
          Changes
          {gitStatus && gitStatus.files.length > 0 && (
            <span className="badge">{gitStatus.files.length}</span>
          )}
        </div>
        <div className={`git-tab ${activeTab === 'history' ? 'active' : ''}`} onClick={() => { setActiveTab('history'); if (log.length === 0) refreshLog(); }}>
          History
        </div>
        <div className={`git-tab ${activeTab === 'branches' ? 'active' : ''}`} onClick={() => { setActiveTab('branches'); if (branches.length === 0) refreshBranches(); }}>
          Branches
        </div>
        <div className={`git-tab ${activeTab === 'stash' ? 'active' : ''}`} onClick={() => { setActiveTab('stash'); if (stashes.length === 0) refreshStashes(); }}>
          Stash
          {stashes.length > 0 && (
            <span className="badge">{stashes.length}</span>
          )}
        </div>
      </div>

      {/* ── Content ── */}
      <div className="git-content">
        {/* ── Changes Tab ── */}
        {activeTab === 'changes' && (
          <>
            {gitStatus && gitStatus.files.length === 0 && (
              <div className="git-empty">
                <Check size={28} className="git-empty-icon" />
                <div className="git-empty-text">No changes detected</div>
              </div>
            )}

            {/* Staged Section */}
            {stagedFiles.length > 0 && (
              <>
                <div className="git-section-header" onClick={() => setShowStaged(!showStaged)} style={{ cursor: 'pointer' }}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    {showStaged ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                    Staged Changes ({stagedFiles.length})
                  </span>
                  <div className="section-actions">
                    <button type="button" className="section-action-btn" onClick={(e) => { e.stopPropagation(); handleUnstageAll(); }} title="Unstage All">
                      <Minus size={12} />
                    </button>
                  </div>
                </div>
                {showStaged && (
                  <ul className="git-file-list">
                    {stagedFiles.map((f) => {
                      const { dir, file } = splitPath(f.path);
                      return (
                        <li
                          key={`s-${f.path}`}
                          className={`git-file-item ${selectedFile === f.path ? 'selected' : ''}`}
                          onClick={() => handleFileSelect(f.path, true)}
                        >
                          <span className={`status-badge ${statusClass(f.status, true)}`}>
                            {statusLabel(f.status)}
                          </span>
                          <span className="git-file-path" title={f.path}>
                            {dir && <span className="dir">{dir}</span>}
                            {file}
                          </span>
                          <div className="file-actions">
                            <button className="file-action-btn" onClick={(e) => { e.stopPropagation(); handleUnstage(f.path); }} title="Unstage">
                              <Minus size={10} />
                            </button>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </>
            )}

            {/* Unstaged Section */}
            {unstagedFiles.length > 0 && (
              <>
                <div className="git-section-header" onClick={() => setShowUnstaged(!showUnstaged)} style={{ cursor: 'pointer' }}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    {showUnstaged ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                    Changes ({unstagedFiles.length})
                  </span>
                  <div className="section-actions">
                    <button type="button" className="section-action-btn" onClick={(e) => { e.stopPropagation(); handleStageAll(); }} title="Stage All">
                      <Plus size={12} />
                    </button>
                  </div>
                </div>
                {showUnstaged && (
                  <ul className="git-file-list">
                    {unstagedFiles.map((f) => {
                      const { dir, file } = splitPath(f.path);
                      return (
                        <li
                          key={`u-${f.path}`}
                          className={`git-file-item ${selectedFile === f.path ? 'selected' : ''}`}
                          onClick={() => handleFileSelect(f.path, false)}
                        >
                          <span className={`status-badge ${statusClass(f.status, false)}`}>
                            {statusLabel(f.status)}
                          </span>
                          <span className="git-file-path" title={f.path}>
                            {dir && <span className="dir">{dir}</span>}
                            {file}
                          </span>
                          <div className="file-actions">
                            {f.status !== '?' && (
                              <button className="file-action-btn" onClick={(e) => { e.stopPropagation(); handleDiscard(f.path); }} title="Discard Changes">
                                <RotateCcw size={10} />
                              </button>
                            )}
                            <button className="file-action-btn" onClick={(e) => { e.stopPropagation(); handleStage(f.path); }} title="Stage">
                              <Plus size={10} />
                            </button>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </>
            )}

            {/* Diff View */}
            {selectedFile && fileDiff && (
              <div className="git-diff-view">
                <div className="git-diff-header">
                  <span className="file-name">{selectedFile}</span>
                  <span className="diff-stats">
                    <span className="add">+{fileDiff.additions}</span>
                    <span className="del">-{fileDiff.deletions}</span>
                  </span>
                </div>
                {parseDiffLines(fileDiff.hunks).map((line, i) => (
                  <div key={i} className={`git-diff-line ${line.cls}`}>
                    {line.text}
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {/* ── History Tab ── */}
        {activeTab === 'history' && (
          <>
            {showCommitDetail && selectedCommit ? (
              <div className="git-commit-detail">
                <div className="git-commit-detail-header">
                  <span className="git-commit-detail-title">{selectedCommit.subject}</span>
                  <button className="git-action-btn" onClick={() => { setShowCommitDetail(false); setSelectedCommit(null); }} title="Close">
                    <X size={12} />
                  </button>
                </div>
                <div className="git-commit-detail-meta">
                  <span className="git-commit-hash">{selectedCommit.shortHash}</span>
                  <span className="git-commit-author">{selectedCommit.author}</span>
                  <span>{relativeTime(selectedCommit.date)}</span>
                </div>
                {selectedCommit.body && (
                  <div className="git-commit-detail-body">{selectedCommit.body}</div>
                )}
                {selectedCommit.files.length > 0 && (
                  <div className="git-commit-detail-files">
                    <div className="git-section-header">
                      <span>Changed Files ({selectedCommit.files.length})</span>
                    </div>
                    <ul className="git-file-list">
                      {selectedCommit.files.map((f, i) => {
                        const { dir, file } = splitPath(f.path);
                        return (
                          <li key={i} className={`git-file-item ${commitFileDiff?.filePath === f.path ? 'selected' : ''}`} onClick={() => handleCommitFileClick(selectedCommit.hash, f.path)}>
                            <span className={`status-badge ${f.status === 'A' ? 'staged' : f.status === 'D' ? 'unstaged' : 'untracked'}`}>
                              {statusLabel(f.status)}
                            </span>
                            <span className="git-file-path" title={f.path}>
                              {dir && <span className="dir">{dir}</span>}
                              {file}
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                )}
                {commitFileDiff && (
                  <div className="git-diff-view">
                    <div className="git-diff-header">
                      <span className="file-name">{commitFileDiff.filePath}</span>
                      <span className="diff-stats">
                        <span className="add">+{commitFileDiff.additions}</span>
                        <span className="del">-{commitFileDiff.deletions}</span>
                      </span>
                    </div>
                    {parseDiffLines(commitFileDiff.hunks).map((line, idx) => (
                      <div key={idx} className={`git-diff-line ${line.cls}`}>
                        {line.text}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <>
                {log.length === 0 && (
                  <div className="git-empty">
                    <GitCommitHorizontal size={28} className="git-empty-icon" />
                    <div className="git-empty-text">No commits yet</div>
                  </div>
                )}
                <ul className="git-history-list">
                  {log.map((entry, i) => {
                    const refTags = entry.refs
                      ? entry.refs.split(',').map(r => r.trim()).filter(r => r.length > 0)
                      : [];
                    return (
                      <li key={entry.hash} className="git-commit-item" onClick={() => handleCommitClick(entry.hash)} style={{ cursor: 'pointer' }}>
                        <div className="git-commit-graph">
                          <div className="git-commit-dot" />
                          {i < log.length - 1 && <div className="git-commit-line" />}
                        </div>
                        <div className="git-commit-info">
                          <div className="git-commit-subject">
                            {entry.subject}
                            {refTags.length > 0 && (
                              <span className="git-ref-tags">
                                {refTags.map((tag, ti) => {
                                  const isHead = tag.startsWith('HEAD');
                                  const isRemote = tag.startsWith('origin/') || tag.startsWith('remotes/');
                                  return (
                                    <span key={ti} className={`git-ref-tag ${isHead ? 'head' : isRemote ? 'remote' : 'local'}`}>
                                      {tag}
                                    </span>
                                  );
                                })}
                              </span>
                            )}
                          </div>
                          <div className="git-commit-meta">
                            <span className="git-commit-hash">{entry.shortHash}</span>
                            <span className="git-commit-author">{entry.author}</span>
                            <span>{relativeTime(entry.date)}</span>
                          </div>
                        </div>
                        <div className="file-actions" style={{ opacity: 1 }} onClick={(e) => e.stopPropagation()}>
                          <button className="file-action-btn" onClick={async () => {
                            setActionLoading(true);
                            try {
                              const result = await window.electronAPI.invoke('git:revert', entry.hash) as { success: boolean; output: string };
                              if (result.success) {
                                showToast('Commit reverted', 'success');
                                await Promise.all([refreshLog(), refreshStatus()]);
                              } else {
                                showToast(result.output?.trim() || 'Revert failed', 'error');
                              }
                            } catch (err: any) {
                              showToast(`Revert error: ${err?.message || String(err)}`, 'error');
                            } finally {
                              setActionLoading(false);
                            }
                          }} title="Revert this commit">
                            <RotateCcw size={10} />
                          </button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </>
            )}
          </>
        )}

        {/* ── Branches Tab ── */}
        {activeTab === 'branches' && (
          <>
            {branches.length === 0 && (
              <div className="git-empty">
                <GitBranch size={28} className="git-empty-icon" />
                <div className="git-empty-text">No branches</div>
              </div>
            )}
            <ul className="git-branch-list">
              {branches.map((b) => (
                <li
                  key={b.name}
                  className={`git-branch-item ${b.current ? 'current' : ''}`}
                >
                  <GitBranch size={14} className="branch-icon" />
                  <span className="branch-name" onClick={() => !b.current && handleCheckout(b.name)} style={{ cursor: b.current ? 'default' : 'pointer', flex: 1 }}>
                    {b.name}
                  </span>
                  {b.current && <span className="branch-current-badge">current</span>}
                  {!b.current && (
                    <div className="file-actions" style={{ opacity: 1 }}>
                      <button className="file-action-btn" onClick={() => handleMergeBranch(b.name)} title="Merge into current">
                        <GitMerge size={10} />
                      </button>
                      <button className="file-action-btn danger" onClick={() => handleDeleteBranch(b.name)} title="Delete branch">
                        <Trash2 size={10} />
                      </button>
                    </div>
                  )}
                </li>
              ))}
            </ul>

            {remotes.length > 0 && (
              <>
                <div className="git-section-header">
                  <span>Remotes</span>
                </div>
                <ul className="git-branch-list">
                  {remotes.map((r, i) => (
                    <li key={`${r.name}-${r.type}-${i}`} className="git-branch-item">
                      <ExternalLink size={14} className="branch-icon" style={{ color: 'var(--text-muted)' }} />
                      <span className="branch-name" style={{ flex: 'none', width: 'auto' }}>{r.name}</span>
                      <span style={{ fontSize: 10, color: 'var(--text-muted)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.url}>
                        {r.url}
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            )}

            <div className="git-new-branch" style={{ flexDirection: 'column', gap: 6 }}>
              <div style={{ display: 'flex', gap: 6, width: '100%', minWidth: 0 }}>
                <input
                  type="text"
                  placeholder="New branch name..."
                  value={newBranchName}
                  onChange={(e) => setNewBranchName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleCreateBranch(); }}
                  style={{ flex: 1, minWidth: 0 }}
                />
                <button
                  className="git-action-btn primary"
                  onClick={handleCreateBranch}
                  disabled={!newBranchName.trim() || actionLoading}
                  style={{ flexShrink: 0 }}
                >
                  <PlusCircle size={12} />
                </button>
              </div>
              <div style={{ display: 'flex', gap: 6, width: '100%', minWidth: 0 }}>
                <input
                  type="text"
                  placeholder="Remote name"
                  value={newRemoteName}
                  onChange={(e) => setNewRemoteName(e.target.value)}
                  style={{ width: 70, flex: 'none' }}
                />
                <input
                  type="text"
                  placeholder="Remote URL"
                  value={newRemoteUrl}
                  onChange={(e) => setNewRemoteUrl(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleAddRemote(); }}
                  style={{ flex: 1, minWidth: 0 }}
                />
                <button
                  className="git-action-btn primary"
                  onClick={handleAddRemote}
                  disabled={!newRemoteName.trim() || !newRemoteUrl.trim() || actionLoading}
                  style={{ flexShrink: 0 }}
                  title="Add remote"
                >
                  <PlusCircle size={12} />
                </button>
              </div>
            </div>
          </>
          )}

        {/* ── Stash Tab ── */}
        {activeTab === 'stash' && (
          <>
            {stashes.length === 0 && (
              <div className="git-empty">
                <Archive size={28} className="git-empty-icon" />
                <div className="git-empty-text">No stashes</div>
                <div className="git-empty-text" style={{ fontSize: 10 }}>Use the stash button in the toolbar to save changes</div>
              </div>
            )}
            <ul className="git-history-list">
              {stashes.map((s) => (
                <li key={s.index} className="git-commit-item">
                  <div className="git-commit-graph">
                    <div className="git-commit-dot" style={{ background: 'var(--warning)' }} />
                  </div>
                  <div className="git-commit-info">
                    <div className="git-commit-subject">{s.message}</div>
                    <div className="git-commit-meta">
                      <span className="git-commit-hash">{"stash@{" + s.index + "}"}</span>
                    </div>
                  </div>
                  <div className="file-actions" style={{ opacity: 1, display: 'flex', gap: 2 }}>
                    <button className="file-action-btn" onClick={() => handleStashPop(s.index)} title="Pop stash">
                      <ArchiveRestore size={10} />
                    </button>
                    <button className="file-action-btn" onClick={() => handleStashApply(s.index)} title="Apply stash">
                      <Check size={10} />
                    </button>
                    <button className="file-action-btn danger" onClick={() => handleStashDrop(s.index)} title="Drop stash">
                      <Trash2 size={10} />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      {/* ── Commit Box (only on Changes tab) ── */}
      {activeTab === 'changes' && stagedFiles.length > 0 && (
        <div className="git-commit-box">
          <textarea
            ref={commitInputRef}
            className="git-commit-textarea"
            placeholder="Commit message..."
            value={commitMessage}
            onChange={(e) => setCommitMessage(e.target.value)}
            onKeyDown={handleKeyDown}
          />
          <div className="git-commit-actions">
            <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>
              Ctrl+Enter to commit
            </span>
            <button
              className={`git-commit-btn ${actionLoading ? 'loading' : ''}`}
              onClick={handleCommit}
              disabled={!commitMessage.trim() || actionLoading}
            >
              {actionLoading ? (
                <span className="btn-spinner" />
              ) : (
                <CornerDownLeft size={12} />
              )}
              {actionLoading ? 'Committing...' : 'Commit'}
            </button>
          </div>
        </div>
      )}

      {toast && <div key={toastKey} className={`git-toast ${toast.type}`} onClick={handleToastClick} title="Click to copy" style={{ cursor: 'pointer', userSelect: 'text' }}>{toast.message}</div>}

      {/* ── Discard Confirmation Dialog ── */}
      {discardConfirm && (
        <div className="git-discard-overlay" onClick={() => setDiscardConfirm(null)}>
          <div className="git-discard-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="git-discard-header">
              <RotateCcw size={16} style={{ color: 'var(--warning)' }} />
              <span className="git-discard-title">确认丢弃</span>
            </div>
            <div className="git-discard-body">
              {discardConfirm.type === 'single' ? (
                <>
                  <div className="git-discard-desc">你确定要丢弃此文件的更改吗？此操作不可撤销。</div>
                  <div className="git-discard-file">{discardConfirm.filePath}</div>
                </>
              ) : (
                <div className="git-discard-desc">你确定要丢弃所有更改吗？此操作不可撤销。</div>
              )}
            </div>
            <div className="git-discard-actions">
              <button className="git-discard-btn git-discard-cancel" onClick={() => setDiscardConfirm(null)}>
                取消
              </button>
              <button className="git-discard-btn git-discard-confirm" onClick={handleConfirmDiscard}>
                <RotateCcw size={12} />
                丢弃
              </button>
            </div>
          </div>
          <style>{`
            .git-discard-overlay {
              position: absolute;
              inset: 0;
              background: rgba(0, 0, 0, 0.55);
              display: flex;
              align-items: center;
              justify-content: center;
              z-index: 1000;
              backdrop-filter: blur(2px);
            }
            .git-discard-dialog {
              background: var(--bg-secondary);
              border: 1px solid var(--border);
              border-radius: var(--radius-md);
              width: 380px;
              max-width: 90vw;
              box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
              overflow: hidden;
            }
            .git-discard-header {
              display: flex;
              align-items: center;
              gap: 8px;
              padding: 12px 16px;
              border-bottom: 1px solid var(--border);
            }
            .git-discard-title {
              font-weight: 600;
              font-size: 13px;
              color: var(--text-primary);
            }
            .git-discard-body {
              padding: 14px 16px;
              display: flex;
              flex-direction: column;
              gap: 8px;
            }
            .git-discard-desc {
              font-size: 12px;
              color: var(--text-secondary);
              line-height: 1.5;
            }
            .git-discard-file {
              font-family: var(--font-mono);
              font-size: 11px;
              color: var(--warning);
              background: var(--bg-primary);
              border: 1px solid var(--border);
              border-radius: var(--radius-sm);
              padding: 6px 10px;
              word-break: break-all;
              max-height: 60px;
              overflow-y: auto;
            }
            .git-discard-actions {
              display: flex;
              justify-content: flex-end;
              gap: 8px;
              padding: 10px 16px;
              border-top: 1px solid var(--border);
            }
            .git-discard-btn {
              display: flex;
              align-items: center;
              gap: 4px;
              padding: 5px 14px;
              border-radius: var(--radius-sm);
              font-size: 12px;
              font-weight: 500;
              cursor: pointer;
              transition: background 0.15s, opacity 0.15s;
              border: none;
            }
            .git-discard-cancel {
              background: transparent;
              border: 1px solid var(--border);
              color: var(--text-secondary);
            }
            .git-discard-cancel:hover {
              background: var(--bg-hover);
              color: var(--text-primary);
            }
            .git-discard-confirm {
              background: rgba(232, 93, 93, 0.85);
              color: #fff;
            }
            .git-discard-confirm:hover {
              background: rgba(232, 93, 93, 1);
            }
          `}</style>
        </div>
      )}
    </div>
  );
}