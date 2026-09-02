import { useState, useCallback, useEffect, useRef } from 'react';
import { History, X, RefreshCw, Eye, RotateCcw, Clock, User } from 'lucide-react';
import type { ScreenHistorySummary, ScreenHistoryContent, DesignerScreen } from '@xai/shared';

interface ScreenHistoryDialogProps {
  screenId: string;
  screenName: string;
  onClose: () => void;
  onListHistory: (screenId: string) => Promise<ScreenHistorySummary[]>;
  onGetContent: (screenId: string, historyId: number) => Promise<ScreenHistoryContent | null>;
  onRestore: (screenId: string, historyId: number) => Promise<DesignerScreen | null>;
}

function formatTime(ms: number): string {
  const d = new Date(ms);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const isYesterday = d.toDateString() === yesterday.toDateString();
  const pad = (n: number) => String(n).padStart(2, '0');
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (sameDay) return `今天 ${time}`;
  if (isYesterday) return `昨天 ${time}`;
  return `${d.getMonth() + 1}/${d.getDate()} ${time}`;
}

function sourceLabel(source: string, summary?: string | null): string {
  if (summary) return summary;
  if (source === 'ai_edit') return 'AI 修改';
  if (source === 'restore') return '从历史恢复';
  return '修改';
}

function sourceColor(source: string): string {
  if (source === 'ai_edit') return '#60a5fa';
  if (source === 'restore') return '#a78bfa';
  return '#9ca3af';
}

export default function ScreenHistoryDialog({
  screenId,
  screenName,
  onClose,
  onListHistory,
  onGetContent,
  onRestore,
}: ScreenHistoryDialogProps) {
  const [history, setHistory] = useState<ScreenHistorySummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [previewHtml, setPreviewHtml] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [confirmRestore, setConfirmRestore] = useState<number | null>(null);
  const previewRef = useRef<HTMLIFrameElement | null>(null);

  const loadHistory = useCallback(async () => {
    setLoading(true);
    const list = await onListHistory(screenId);
    setHistory(list);
    setLoading(false);
  }, [screenId, onListHistory]);

  useEffect(() => {
    loadHistory();
  }, [loadHistory]);

  // 加载预览内容
  useEffect(() => {
    if (selectedId == null) {
      setPreviewHtml(null);
      return;
    }
    let cancelled = false;
    setPreviewLoading(true);
    onGetContent(screenId, selectedId).then(content => {
      if (cancelled) return;
      setPreviewHtml(content?.content ?? null);
      setPreviewLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [selectedId, screenId, onGetContent]);

  // 写入预览 iframe（用 srcdoc 避免跨域问题，与画布渲染一致）
  useEffect(() => {
    if (previewRef.current && previewHtml != null) {
      previewRef.current.srcdoc = previewHtml;
    }
  }, [previewHtml]);

  const handleRestore = useCallback(async (historyId: number) => {
    setRestoring(true);
    const restored = await onRestore(screenId, historyId);
    setRestoring(false);
    setConfirmRestore(null);
    if (restored) {
      // 恢复后刷新历史列表（恢复动作本身会留底一条新历史）
      await loadHistory();
      setSelectedId(null);
      setPreviewHtml(null);
    }
  }, [screenId, onRestore, loadHistory]);

  return (
    <div className="designer-dialog-overlay" onClick={onClose}>
      <div
        className="designer-dialog designer-fullscreen-dialog"
        onClick={e => e.stopPropagation()}
      >
        <div className="designer-dialog-header">
          <span className="designer-dialog-title">
            <History size={14} style={{ verticalAlign: 'middle', marginRight: 6 }} />
            历史版本 — {screenName}
          </span>
          <button className="designer-dialog-close" onClick={onClose}>
            <X size={14} />
          </button>
        </div>

        <div className="designer-dialog-body" style={{ flex: 1, display: 'flex', flexDirection: 'row', gap: 12, overflow: 'hidden', padding: 12 }}>
          {/* 左侧：历史列表 */}
          <div style={{ width: 170, flexShrink: 0, display: 'flex', flexDirection: 'column', border: '1px solid var(--border-color, #333)', borderRadius: 6, overflow: 'hidden' }}>
            <div style={{ padding: '8px 10px', fontSize: 11, fontWeight: 600, color: 'var(--text-secondary, #888)', borderBottom: '1px solid var(--border-color, #333)', background: 'var(--surface-color, #2a2a2a)' }}>
              最近 {history.length || 0} 次修改
            </div>
            <div style={{ flex: 1, overflow: 'auto' }}>
              {loading ? (
                <div style={{ padding: 16, textAlign: 'center', color: 'var(--text-secondary, #aaa)', fontSize: 12 }}>
                  <RefreshCw size={14} className="spin" style={{ verticalAlign: 'middle' }} /> 加载中...
                </div>
              ) : history.length === 0 ? (
                <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted, #888)', fontSize: 12 }}>
                  暂无历史记录
                </div>
              ) : (
                history.map(h => (
                  <div
                    key={h.id}
                    onClick={() => setSelectedId(h.id)}
                    style={{
                      padding: '8px 10px',
                      cursor: 'pointer',
                      borderBottom: '1px solid var(--border-color, #333)',
                      background: selectedId === h.id ? 'var(--accent-bg, rgba(96,165,250,0.15))' : 'transparent',
                      transition: 'background 0.15s',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
                      <span
                        style={{
                          fontSize: 10,
                          padding: '1px 6px',
                          borderRadius: 3,
                          background: `${sourceColor(h.source)}22`,
                          color: sourceColor(h.source),
                          fontWeight: 500,
                        }}
                      >
                        {sourceLabel(h.source, h.summary)}
                      </span>
                      <span style={{ fontSize: 10, color: 'var(--text-secondary, #aaa)', fontWeight: 500 }}>v{h.version}</span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 10, color: 'var(--text-secondary, #aaa)' }}>
                      <Clock size={9} />
                      {formatTime(h.createdAt)}
                    </div>
                    {h.createdByName && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 10, color: 'var(--text-muted, #999)', marginTop: 2 }}>
                        <User size={9} />
                        {h.createdByName}
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>

          {/* 右侧：预览 */}
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', border: '1px solid var(--border-color, #333)', borderRadius: 6, overflow: 'hidden' }}>
            <div style={{ padding: '8px 10px', fontSize: 11, fontWeight: 600, color: 'var(--text-secondary, #888)', borderBottom: '1px solid var(--border-color, #333)', background: 'var(--surface-color, #2a2a2a)', display: 'flex', alignItems: 'center', gap: 6 }}>
              <Eye size={11} />
              {selectedId == null ? '选择左侧版本预览' : '版本预览（只读）'}
            </div>
            <div style={{ flex: 1, position: 'relative', background: '#fff' }}>
              {selectedId == null ? (
                <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted, #999)', fontSize: 13 }}>
                  点击左侧任意历史版本查看预览
                </div>
              ) : previewLoading ? (
                <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-secondary, #aaa)', fontSize: 12 }}>
                  <RefreshCw size={14} className="spin" style={{ verticalAlign: 'middle' }} /> 加载中...
                </div>
              ) : (
                <iframe
                  ref={previewRef}
                  title="history-preview"
                  style={{ width: '100%', height: '100%', border: 'none', background: '#fff' }}
                  sandbox="allow-same-origin"
                />
              )}
            </div>
          </div>
        </div>

        <div className="designer-dialog-footer">
          <button className="designer-dialog-btn cancel" onClick={onClose}>关闭</button>
          <button
            className="designer-dialog-btn primary"
            disabled={selectedId == null || restoring}
            onClick={() => {
              if (selectedId != null) setConfirmRestore(selectedId);
            }}
          >
            {restoring ? <RefreshCw size={12} className="spin" /> : <RotateCcw size={12} />}
            {restoring ? '恢复中...' : '恢复为当前版本'}
          </button>
        </div>

        {/* 确认恢复 */}
        {confirmRestore != null && (
          <div className="designer-dialog-overlay" style={{ position: 'absolute' }} onClick={() => setConfirmRestore(null)}>
            <div className="designer-dialog designer-dialog-sm" onClick={e => e.stopPropagation()}>
              <div className="designer-dialog-header">
                <span className="designer-dialog-title">确认恢复</span>
                <button className="designer-dialog-close" onClick={() => setConfirmRestore(null)}>
                  <X size={14} />
                </button>
              </div>
              <div className="designer-dialog-body">
                <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                  将该历史版本恢复为当前版本？<br />
                  当前版本会自动留底，可再次切换回来。
                </p>
              </div>
              <div className="designer-dialog-footer">
                <button className="designer-dialog-btn cancel" onClick={() => setConfirmRestore(null)}>取消</button>
                <button
                  className="designer-dialog-btn primary"
                  disabled={restoring}
                  onClick={() => handleRestore(confirmRestore)}
                >
                  确认恢复
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
