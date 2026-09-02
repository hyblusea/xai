import { useState, useCallback } from 'react';
import type { Message, AgentState, ConfirmationRequest, ChatTag, ContextUsage, CompactionResult } from '@xai/shared';
import './chat/chat.css';
import ChatHeader from './chat/ChatHeader';
import MessageList from './chat/MessageList';
import ChatInput from './chat/ChatInput';
import { refreshToolNames } from './chat/toolNamesStore';

interface ChatPanelProps {
  messages: Message[];
  agentState: AgentState;
  onSendMessage: (content: string) => void;
  onAbort: () => void;
  onConfirmationRequest: (request: ConfirmationRequest | null) => void;
  onClearMessages: () => void;
  onDeleteConversation: () => void;
  onLoadHistory: (conversationId: string) => void;
  onOpenSettings?: () => void;
  onSessionTitleChange?: (title: string) => void;
  sessionTitle?: string;
  chatTags?: ChatTag[];
  onRemoveChatTag?: (tagId: string) => void;
  confirmationRequest?: ConfirmationRequest | null;
  onConfirmationRespond?: (approved: boolean, approveAll?: boolean) => void;
  isLoadingHistory?: boolean;
  /** Current session context usage (only for compression-aware providers). */
  contextUsage?: ContextUsage | null;
  /** Auto-compaction toast (from agent loop). */
  autoCompressToast?: { kind: 'compressing' | 'compressed' | 'error'; message: string } | null;
  /** Manually compact the current session's conversation history. */
  onCompressSession?: () => Promise<{ success: boolean; result?: CompactionResult; error?: string }>;
}

export default function ChatPanel({
  messages,
  agentState,
  onSendMessage,
  onAbort,
  onClearMessages,
  onDeleteConversation,
  onLoadHistory,
  onOpenSettings,
  onSessionTitleChange,
  sessionTitle,
  chatTags = [],
  onRemoveChatTag,
  confirmationRequest,
  onConfirmationRespond,
  isLoadingHistory = false,
  contextUsage = null,
  autoCompressToast,
  onCompressSession,
}: ChatPanelProps) {
  const [sessionId, setSessionId] = useState<string>(Date.now().toString());

  const handleNewSession = useCallback(async () => {
    setSessionId(Date.now().toString());
    onClearMessages();
    if (onSessionTitleChange) {
      onSessionTitleChange('');
    }
    try {
      await window.electronAPI.invoke('session:new');
      await refreshToolNames(true);
    } catch {}
  }, [onClearMessages, onSessionTitleChange]);

  const handleDeleteConversation = useCallback(async () => {
    const isActive = ['thinking', 'acting', 'observing'].includes(agentState);
    if (isActive) return;
    await onDeleteConversation();
  }, [agentState, onDeleteConversation]);

  const handleRemoveChatTag = useCallback(
    (tagId: string) => {
      onRemoveChatTag?.(tagId);
    },
    [onRemoveChatTag],
  );

  return (
    <div className="chat-panel">
      <ChatHeader
        agentState={agentState}
        sessionTitle={sessionTitle}
        onOpenSettings={onOpenSettings}
        onNewSession={handleNewSession}
        onDeleteConversation={handleDeleteConversation}
        onLoadHistory={onLoadHistory}
        onSessionTitleChange={onSessionTitleChange}
        isLoadingHistory={isLoadingHistory}
      />
      <MessageList
        messages={messages}
        agentState={agentState}
        confirmationRequest={confirmationRequest}
        onConfirm={onConfirmationRespond}
        isLoadingHistory={isLoadingHistory}
      />
      <ChatInput
        agentState={agentState}
        onSend={onSendMessage}
        onAbort={onAbort}
        chatTags={chatTags}
        onRemoveChatTag={handleRemoveChatTag}
        contextUsage={contextUsage}
        autoCompressToast={autoCompressToast}
        onCompressSession={onCompressSession}
      />
    </div>
  );
}
