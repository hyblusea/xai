import { useState, useCallback, useEffect } from 'react';
import { Globe, X, Copy, Check, RefreshCw, Trash2, ExternalLink, Lock } from 'lucide-react';
import type { Publication, CreatePublicationRequest, PublicationScope, DesignerProject } from '@xai/shared';

interface PublishDialogProps {
  project: DesignerProject;
  currentScreenId: string | null;
  onClose: () => void;
  onCreatePublication: (projectId: string, req: CreatePublicationRequest) => Promise<Publication | null>;
  onListPublications: (projectId: string) => Promise<Publication[]>;
  onDeletePublication: (projectId: string, publicationId: number) => Promise<boolean>;
  onRefreshPublication: (projectId: string, publicationId: number) => Promise<Publication | null>;
}

/** 获取当前屏幕的 folderPath */
function getCurrentFolder(project: DesignerProject, screenId: string | null): string {
  if (!screenId) return '';
  const screen = project.screens.find(s => s.id === screenId);
  return screen?.folderPath ?? '';
}

/** 获取当前屏幕的 folderId（从 folderPath 映射） */
function getCurrentFolderId(project: DesignerProject, screenId: string | null): number | null {
  if (!screenId) return null;
  const screen = project.screens.find(s => s.id === screenId);
  return screen?.folderId ?? null;
}

export default function PublishDialog({
  project,
  currentScreenId,
  onClose,
  onCreatePublication,
  onListPublications,
  onDeletePublication,
  onRefreshPublication,
}: PublishDialogProps) {
  const [scope, setScope] = useState<PublicationScope>('PROJECT');
  const [title, setTitle] = useState('');
  const [password, setPassword] = useState('');
  const [publishing, setPublishing] = useState(false);
  const [publications, setPublications] = useState<Publication[]>([]);
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const [refreshingId, setRefreshingId] = useState<number | null>(null);

  const loadPublications = useCallback(async () => {
    const list = await onListPublications(project.id);
    setPublications(list);
  }, [project.id, onListPublications]);

  useEffect(() => {
    loadPublications();
  }, [loadPublications]);

  const currentFolder = getCurrentFolder(project, currentScreenId);
  const currentFolderId = getCurrentFolderId(project, currentScreenId);
  const currentScreen = currentScreenId ? project.screens.find(s => s.id === currentScreenId) : null;

  const handlePublish = useCallback(async () => {
    setPublishing(true);
    const req: CreatePublicationRequest = {
      scope,
      title: title.trim() || undefined,
      password: password.trim() || undefined,
    };
    if (scope === 'FOLDER') {
      req.folderId = currentFolderId;
    } else if (scope === 'SCREEN') {
      req.screenId = currentScreenId;
    }
    const pub = await onCreatePublication(project.id, req);
    setPublishing(false);
    if (pub) {
      setTitle('');
      setPassword('');
      await loadPublications();
    }
  }, [scope, title, password, currentFolderId, currentScreenId, project.id, onCreatePublication, loadPublications]);

  const handleCopyUrl = useCallback(async (url: string, pubId: number) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopiedId(pubId);
      setTimeout(() => setCopiedId(null), 2000);
    } catch {
      // fallback
    }
  }, []);

  const handleOpenUrl = useCallback((url: string) => {
    window.open(url, '_blank', 'noopener,noreferrer');
  }, []);

  const handleDelete = useCallback(async (pubId: number) => {
    const ok = await onDeletePublication(project.id, pubId);
    if (ok) await loadPublications();
  }, [project.id, onDeletePublication, loadPublications]);

  const handleRefresh = useCallback(async (pubId: number) => {
    setRefreshingId(pubId);
    await onRefreshPublication(project.id, pubId);
    setRefreshingId(null);
    await loadPublications();
  }, [project.id, onRefreshPublication, loadPublications]);

  const scopeLabel = (s: PublicationScope): string => {
    if (s === 'PROJECT') return '整个项目';
    if (s === 'FOLDER') return `目录: ${currentFolder || '(根目录)'}`;
    if (s === 'SCREEN') return `页面: ${currentScreen?.name ?? ''}`;
    return s;
  };

  return (
    <div className="designer-dialog-overlay" onClick={onClose}>
      <div className="designer-dialog" style={{ width: 560, maxHeight: '80vh', display: 'flex', flexDirection: 'column' }} onClick={e => e.stopPropagation()}>
        <div className="designer-dialog-header">
          <span className="designer-dialog-title">
            <Globe size={14} style={{ verticalAlign: 'middle', marginRight: 6 }} />
            发布设计稿
          </span>
          <button className="designer-dialog-close" onClick={onClose}>
            <X size={14} />
          </button>
        </div>

        <div className="designer-dialog-body" style={{ flex: 1, overflow: 'auto' }}>
          {/* 发布范围 */}
          <div style={{ marginBottom: 16 }}>
            <label className="designer-prop-label">发布范围</label>
            <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
              <button
                className={`designer-dialog-btn ${scope === 'PROJECT' ? 'primary' : 'cancel'}`}
                onClick={() => setScope('PROJECT')}
                style={{ flex: 1 }}
              >
                整个项目
              </button>
              <button
                className={`designer-dialog-btn ${scope === 'FOLDER' ? 'primary' : 'cancel'}`}
                onClick={() => setScope('FOLDER')}
                disabled={!currentFolderId}
                style={{ flex: 1 }}
                title={currentFolderId ? `当前目录: ${currentFolder}` : '请先选择一个目录中的页面'}
              >
                当前目录
              </button>
              <button
                className={`designer-dialog-btn ${scope === 'SCREEN' ? 'primary' : 'cancel'}`}
                onClick={() => setScope('SCREEN')}
                disabled={!currentScreenId}
                style={{ flex: 1 }}
                title={currentScreen ? `当前页面: ${currentScreen.name}` : '请先选择一个页面'}
              >
                当前页面
              </button>
            </div>
          </div>

          {/* 标题 */}
          <div style={{ marginBottom: 16 }}>
            <label className="designer-prop-label">发布标题（可选）</label>
            <input
              className="designer-prop-input"
              value={title}
              onChange={e => setTitle(e.target.value)}
              placeholder={`默认: ${project.name} - ${scopeLabel(scope)}`}
              style={{ width: '100%', marginTop: 6 }}
            />
          </div>

          {/* 密码 */}
          <div style={{ marginBottom: 16 }}>
            <label className="designer-prop-label">访问密码（可选）</label>
            <input
              className="designer-prop-input"
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="留空则无需密码"
              style={{ width: '100%', marginTop: 6 }}
            />
          </div>

          {/* 已发布列表 */}
          {publications.length > 0 && (
            <div style={{ marginTop: 20, borderTop: '1px solid var(--border-color, #333)', paddingTop: 16 }}>
              <label className="designer-prop-label" style={{ marginBottom: 8, display: 'block' }}>
                已发布链接 ({publications.length})
              </label>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {publications.map(pub => (
                  <div
                    key={pub.id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      padding: '8px 10px',
                      background: 'var(--surface-color, #2a2a2a)',
                      borderRadius: 6,
                      border: '1px solid var(--border-color, #333)',
                    }}
                  >
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 12, fontWeight: 500, display: 'flex', alignItems: 'center', gap: 6 }}>
                        {pub.title}
                        {pub.hasPassword && <Lock size={10} style={{ opacity: 0.6 }} />}
                        <span style={{ fontSize: 10, opacity: 0.5, fontWeight: 400 }}>
                          {pub.scope === 'PROJECT' ? '项目' : pub.scope === 'FOLDER' ? '目录' : '页面'} · {pub.viewCount} 次访问
                        </span>
                      </div>
                      <div style={{ fontSize: 10, opacity: 0.5, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {pub.url}
                      </div>
                    </div>
                    <button
                      className="designer-dialog-btn"
                      onClick={() => handleCopyUrl(pub.url, pub.id)}
                      title="复制链接"
                      style={{ padding: '4px 6px' }}
                    >
                      {copiedId === pub.id ? <Check size={12} color="#10b981" /> : <Copy size={12} />}
                    </button>
                    <button
                      className="designer-dialog-btn"
                      onClick={() => handleOpenUrl(pub.url)}
                      title="打开预览"
                      style={{ padding: '4px 6px' }}
                    >
                      <ExternalLink size={12} />
                    </button>
                    <button
                      className="designer-dialog-btn"
                      onClick={() => handleRefresh(pub.id)}
                      title="更新内容"
                      disabled={refreshingId === pub.id}
                      style={{ padding: '4px 6px' }}
                    >
                      <RefreshCw size={12} className={refreshingId === pub.id ? 'spin' : ''} />
                    </button>
                    <button
                      className="designer-dialog-btn"
                      onClick={() => handleDelete(pub.id)}
                      title="取消发布"
                      style={{ padding: '4px 6px', color: '#ef4444' }}
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="designer-dialog-footer">
          <button className="designer-dialog-btn cancel" onClick={onClose}>关闭</button>
          <button
            className="designer-dialog-btn primary"
            onClick={handlePublish}
            disabled={publishing || (scope === 'FOLDER' && !currentFolderId) || (scope === 'SCREEN' && !currentScreenId)}
          >
            {publishing ? <RefreshCw size={12} className="spin" /> : <Globe size={12} />}
            {publishing ? '发布中...' : '发布'}
          </button>
        </div>
      </div>
    </div>
  );
}
