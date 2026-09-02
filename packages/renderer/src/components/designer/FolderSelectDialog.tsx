import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X, Folder, AlertCircle } from 'lucide-react';
import { IPCChannel } from '@xai/shared';
import type { WritableFolder } from '@xai/shared';

interface FolderSelectDialogProps {
  projectId: string;
  onSelect: (folderPath: string) => void;
  onCancel: () => void;
}

export default function FolderSelectDialog({
  projectId,
  onSelect,
  onCancel,
}: FolderSelectDialogProps) {
  const [folders, setFolders] = useState<WritableFolder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedPath, setSelectedPath] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const result = await window.electronAPI.invoke(
          IPCChannel.DesignerListWritableFolders,
          { projectId },
        ) as { success: boolean; folders?: WritableFolder[]; error?: string };
        if (result.success && result.folders) {
          setFolders(result.folders);
          // 默认选中第一个
          if (result.folders.length > 0) {
            setSelectedPath(result.folders[0].path);
          }
        } else {
          setError(result.error || '获取可写目录失败');
        }
      } catch (err) {
        setError(String(err));
      } finally {
        setLoading(false);
      }
    })();
  }, [projectId]);

  const handleConfirm = () => {
    if (selectedPath) {
      onSelect(selectedPath);
    }
  };

  return createPortal(
    <div className="designer-dialog-overlay" onClick={onCancel}>
      <div className="designer-dialog designer-dialog-sm" onClick={e => e.stopPropagation()}>
        <div className="designer-dialog-header">
          <span className="designer-dialog-title">
            <Folder size={14} />
            选择保存目录
          </span>
          <button className="designer-dialog-close" onClick={onCancel}>
            <X size={14} />
          </button>
        </div>
        <div className="designer-dialog-body">
          {loading ? (
            <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-secondary)', fontSize: 13 }}>
              加载中…
            </div>
          ) : error ? (
            <div className="designer-team-error">{error}</div>
          ) : folders.length === 0 ? (
            <div style={{ padding: '16px', textAlign: 'center', color: 'var(--text-secondary)', fontSize: 13 }}>
              <AlertCircle size={20} style={{ marginBottom: 8, opacity: 0.5 }} />
              <p>您在该项目中没有可写目录。</p>
              <p style={{ fontSize: 11, marginTop: 4 }}>请联系项目管理员为您分配目录权限。</p>
            </div>
          ) : (
            <>
              <p style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 8 }}>
                请选择新页面的保存位置：
              </p>
              <div className="designer-folder-select-list">
                {folders.map(f => (
                  <label
                    key={f.folderId}
                    className={`designer-folder-select-item ${selectedPath === f.path ? 'active' : ''}`}
                  >
                    <input
                      type="radio"
                      name="folder-select"
                      checked={selectedPath === f.path}
                      onChange={() => setSelectedPath(f.path)}
                      style={{ flexShrink: 0 }}
                    />
                    <Folder size={12} style={{ flexShrink: 0, opacity: 0.6 }} />
                    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {f.path}
                    </span>
                    {f.grantedUserNames.length > 0 && (
                      <span style={{ fontSize: 9, color: 'var(--text-tertiary)', flexShrink: 0 }}>
                        {f.grantedUserNames.join(', ')}
                      </span>
                    )}
                  </label>
                ))}
              </div>
            </>
          )}
        </div>
        <div className="designer-dialog-footer">
          <button className="designer-dialog-btn cancel" onClick={onCancel}>取消</button>
          <button
            className="designer-dialog-btn primary"
            onClick={handleConfirm}
            disabled={!selectedPath || loading || folders.length === 0}
          >
            保存
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
