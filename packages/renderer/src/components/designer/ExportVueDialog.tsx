import { useState, useCallback } from 'react';
import { Code2, X, FolderOpen, Check, RefreshCw } from 'lucide-react';
import { useIpc } from '../../hooks/useIpc';

interface ExportVueDialogProps {
  projectId: string;
  onClose: () => void;
  onExport: (projectId: string, outputDir: string) => Promise<void>;
}

/**
 * Dialog for exporting the designer project as a Vue 3 project.
 */
export default function ExportVueDialog({ projectId, onClose, onExport }: ExportVueDialogProps) {
  const [outputDir, setOutputDir] = useState('');
  const [exporting, setExporting] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState('');
  const { invoke } = useIpc();

  const handleSelectDir = useCallback(async () => {
    const result = await invoke('designer:select-path') as { success: boolean; path?: string };
    if (result.success && result.path) {
      setOutputDir(result.path);
    }
  }, [invoke]);

  const handleExport = useCallback(async () => {
    if (!outputDir) return;
    setExporting(true);
    setError('');
    try {
      await onExport(projectId, outputDir);
      setSuccess(true);
    } catch (err) {
      setError(String(err));
    } finally {
      setExporting(false);
    }
  }, [projectId, outputDir, onExport]);

  return (
    <div className="designer-dialog-overlay" onClick={onClose}>
      <div className="designer-dialog" style={{ width: 420 }} onClick={e => e.stopPropagation()}>
        <div className="designer-dialog-header">
          <span className="designer-dialog-title">
            <Code2 size={14} style={{ verticalAlign: 'middle', marginRight: 6 }} />
            导出 Vue 3 项目
          </span>
          <button className="designer-dialog-close" onClick={onClose}>
            <X size={14} />
          </button>
        </div>
        <div className="designer-dialog-body">
          {success ? (
            <div className="designer-export-success">
              <Check size={32} color="#10b981" />
              <p>Vue 3 项目已成功导出到：</p>
              <code>{outputDir}</code>
            </div>
          ) : (
            <>
              <p className="designer-export-desc">
                将当前项目的所有页面转换为 Vue 3 + Vite + TypeScript 项目。
                每个页面将生成一个独立的 Vue SFC 组件。
              </p>
              <div className="designer-export-dir">
                <label className="designer-prop-label">输出目录</label>
                <div className="designer-export-dir-input">
                  <input
                    className="designer-prop-input"
                    value={outputDir}
                    onChange={e => setOutputDir(e.target.value)}
                    placeholder="选择或输入输出目录..."
                    style={{ flex: 1 }}
                  />
                  <button
                    className="designer-dialog-btn"
                    onClick={handleSelectDir}
                    title="选择目录"
                  >
                    <FolderOpen size={12} />
                    浏览
                  </button>
                </div>
              </div>
              {error && <div className="designer-export-error">{error}</div>}
            </>
          )}
        </div>
        <div className="designer-dialog-footer">
          {success ? (
            <button className="designer-dialog-btn primary" onClick={onClose}>完成</button>
          ) : (
            <>
              <button className="designer-dialog-btn cancel" onClick={onClose}>取消</button>
              <button
                className="designer-dialog-btn primary"
                onClick={handleExport}
                disabled={!outputDir || exporting}
              >
                {exporting ? <RefreshCw size={12} className="spin" /> : <Code2 size={12} />}
                {exporting ? '导出中...' : '导出'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
