import { useState, useRef, useEffect, useCallback } from 'react';
import { Plus, Trash2, Settings, History, X, Smartphone, Loader2 } from 'lucide-react';
import type { AgentState, SessionConfig, ChatTag } from '@xai/shared';
import { IPCChannel } from '@xai/shared';

const STATE_LABELS: Record<AgentState, string> = {
  idle: 'Ready',
  thinking: 'Thinking...',
  acting: 'Executing...',
  observing: 'Observing...',
  waiting_confirmation: 'Awaiting Confirmation',
  error: 'Error',
  completed: 'Completed',
};

const STATE_COLORS: Record<AgentState, string> = {
  idle: 'var(--success)',
  thinking: 'var(--accent)',
  acting: 'var(--warning)',
  observing: 'var(--accent)',
  waiting_confirmation: 'var(--warning)',
  error: 'var(--error)',
  completed: 'var(--success)',
};

interface ConversationItem {
  conversationId: string;
  title: string;
  createTime: string;
  updateTime: string;
}

interface ChatHeaderProps {
  agentState: AgentState;
  sessionTitle?: string;
  onOpenSettings?: () => void;
  onNewSession: () => void;
  onDeleteConversation: () => void;
  onLoadHistory: (conversationId: string) => void;
  onSessionTitleChange?: (title: string) => void;
  isLoadingHistory?: boolean;
}

export default function ChatHeader({
  agentState,
  sessionTitle,
  onOpenSettings,
  onNewSession,
  onDeleteConversation,
  onLoadHistory,
  onSessionTitleChange,
  isLoadingHistory = false,
}: ChatHeaderProps) {
  const [showHistory, setShowHistory] = useState(false);
  const [historyList, setHistoryList] = useState<ConversationItem[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [mqttStatus, setMqttStatus] = useState<{ isConnected: boolean; pairCode: string; pairedCount: number }>({
    isConnected: false,
    pairCode: '',
    pairedCount: 0,
  });
  const [showPairCode, setShowPairCode] = useState(false);
  const historyPanelRef = useRef<HTMLDivElement>(null);
  const historyBtnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const loadMqttStatus = async () => {
      try {
        const status = (await window.electronAPI.invoke('mqtt:get-status')) as {
          isConnected: boolean;
          pairCode: string;
          pairedCount: number;
        };
        setMqttStatus(status);
      } catch {}
    };
    loadMqttStatus();

    const handler = (info: unknown) => {
      setMqttStatus(info as { isConnected: boolean; pairCode: string; pairedCount: number });
    };
    window.electronAPI?.on('mqtt:pairing-status', handler);
    return () => {
      window.electronAPI?.removeListener?.('mqtt:pairing-status', handler);
    };
  }, []);

  useEffect(() => {
    if (!showHistory) return;
    const handleMouseDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        historyPanelRef.current &&
        !historyPanelRef.current.contains(target) &&
        historyBtnRef.current &&
        !historyBtnRef.current.contains(target)
      ) {
        setShowHistory(false);
      }
    };
    document.addEventListener('mousedown', handleMouseDown);
    return () => document.removeEventListener('mousedown', handleMouseDown);
  }, [showHistory]);

  const loadHistoryList = useCallback(async () => {
    setHistoryLoading(true);
    try {
      const result = (await window.electronAPI.invoke('conversation:list', 1, 9999)) as {
        success: boolean;
        data?: { list: ConversationItem[]; total: number };
        error?: string;
      };
      if (result.success && result.data) {
        setHistoryList(result.data.list);
      }
    } catch (err) {
      console.error('[ChatHeader] Failed to load history:', err);
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  const toggleHistory = useCallback(() => {
    if (!showHistory) {
      loadHistoryList();
    }
    setShowHistory(!showHistory);
  }, [showHistory, loadHistoryList]);

  const handleLoadConversation = useCallback(
    async (conversationId: string) => {
      setShowHistory(false);
      const item = historyList.find((c) => c.conversationId === conversationId);
      if (item?.title && onSessionTitleChange) {
        onSessionTitleChange(item.title);
      }
      await onLoadHistory(conversationId);
    },
    [onLoadHistory, historyList, onSessionTitleChange],
  );

  const handleDeleteHistoryItem = useCallback(async (e: React.MouseEvent, conversationId: string) => {
    e.stopPropagation();
    if (deletingId) return;
    setDeletingId(conversationId);
    try {
      const result = (await window.electronAPI.invoke('conversation:delete', conversationId)) as {
        success: boolean;
      };
      if (result.success) {
        setHistoryList((prev) => prev.filter((item) => item.conversationId !== conversationId));
      }
    } catch {} finally {
      setDeletingId(null);
    }
  }, [deletingId]);

  const formatTime = (ts: string) => {
    if (!ts) return '';
    const d = new Date(ts);
    if (isNaN(d.getTime())) return ts;
    const now = new Date();
    const isToday = d.toDateString() === now.toDateString();
    if (isToday) {
      return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    }
    return d.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  };

  const isActive = ['thinking', 'acting', 'observing'].includes(agentState);

  return (
    <div className="panel-header">
      <div className="chat-header-left">
        <span className="status-dot" style={{ background: STATE_COLORS[agentState] }} />
        <span className="status-label" style={{ color: STATE_COLORS[agentState] }}>
          {STATE_LABELS[agentState]}
        </span>
      </div>
      <div className="chat-header-center">
        <span>AI Chat</span>
        {sessionTitle && <span className="session-title">{sessionTitle}</span>}
      </div>
      <div className="chat-header-right">
        <button
          className={`icon-button${showPairCode ? ' active' : ''}`}
          onClick={() => setShowPairCode(!showPairCode)}
          title="手机配对"
          style={{ position: 'relative' }}
        >
          <Smartphone size={14} />
          {mqttStatus.pairedCount > 0 && <span className="mqtt-paired-dot" />}
        </button>
        <button className="icon-button" onClick={onOpenSettings} title="Settings">
          <Settings size={14} />
        </button>
        <button
          ref={historyBtnRef}
          className={`icon-button${showHistory ? ' active' : ''}`}
          onClick={toggleHistory}
          title="History"
        >
          <History size={14} />
        </button>
        <button className="icon-button" onClick={onNewSession} title="New Session">
          <Plus size={14} />
        </button>
        <button className="icon-button" onClick={onDeleteConversation} title="Delete Conversation" disabled={isActive}>
          <Trash2 size={14} />
        </button>
      </div>

      {showHistory && (
        <div className="history-panel" ref={historyPanelRef}>
          <div className="history-panel-header">
            <span>历史会话</span>
            <button className="icon-button" onClick={() => setShowHistory(false)}>
              <X size={14} />
            </button>
          </div>
          {historyLoading ? (
            <div className="history-loading">Loading...</div>
          ) : historyList.length === 0 ? (
            <div className="history-empty">No history</div>
          ) : (
            <div className="history-list">
              {historyList.map((item) => {
                const isDeleting = deletingId === item.conversationId;
                return (
                <div key={item.conversationId} className={`history-item${isDeleting ? ' deleting' : ''}${isLoadingHistory ? ' disabled' : ''}`} onClick={() => !isDeleting && !isLoadingHistory && handleLoadConversation(item.conversationId)}>
                  <div className="history-item-content">
                    <div className="history-item-title">{item.title || 'Untitled'}</div>
                    <div className="history-item-time">{formatTime(item.updateTime)}</div>
                  </div>
                  <button className={`history-item-delete${isDeleting ? ' loading' : ''}`} onClick={(e) => handleDeleteHistoryItem(e, item.conversationId)} title="Delete" disabled={isDeleting || !!deletingId}>
                    {isDeleting ? <Loader2 size={12} className="spinning" /> : <X size={12} />}
                  </button>
                </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {showPairCode && (
        <div className="pair-code-panel">
          <div className="pair-code-panel-header">
            <span>📱 手机配对</span>
            <button className="icon-button" onClick={() => setShowPairCode(false)}>
              <X size={14} />
            </button>
          </div>
          <div className="pair-code-body">
            {mqttStatus.isConnected ? (
              <>
                <div className="pair-code-label">配对码</div>
                <div className="pair-code-value">
                  {mqttStatus.pairCode ? mqttStatus.pairCode.replace(/(.{3})/g, '$1 ').trim() : '------'}
                </div>
                <div className="pair-code-hint">在手机APP中输入此配对码</div>
                <button
                  className="pair-code-refresh"
                  onClick={async () => {
                    try {
                      await window.electronAPI.invoke('mqtt:generate-pair-code');
                    } catch {}
                  }}
                >
                  {mqttStatus.pairCode ? '刷新配对码' : '生成配对码'}
                </button>
                <div className="pair-code-status">
                  <span className={`mqtt-status-dot ${mqttStatus.isConnected ? 'connected' : ''}`} />
                  <span>{mqttStatus.isConnected ? 'MQTT 已连接' : 'MQTT 未连接'}</span>
                </div>
                {mqttStatus.pairedCount > 0 && <div className="pair-code-paired">已配对 {mqttStatus.pairedCount} 台设备</div>}
              </>
            ) : (
              <div className="pair-code-disconnected">MQTT 服务未连接，请检查网络</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
