import { useRef, useEffect, useState, useCallback } from 'react';
import type { Message, AgentState, ConfirmationRequest, ToolBatchItem } from '@xai/shared';
import { Loader2 } from 'lucide-react';
import { processMessages } from './chatUtils';
import UserBubble from './UserBubble';
import AssistantBubble from './AssistantBubble';
import ToolCallBubble from './ToolCallBubble';


/** Distance threshold (px) to consider "at bottom" */
const SCROLL_THRESHOLD = 80;

interface MessageListProps {
  messages: Message[];
  agentState: AgentState;
  confirmationRequest?: ConfirmationRequest | null;
  onConfirm?: (approved: boolean, approveAll?: boolean) => void;
  isLoadingHistory?: boolean;
}

export default function MessageList({ messages, agentState, confirmationRequest, onConfirm, isLoadingHistory = false }: MessageListProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const userScrolledUpRef = useRef(false);

  // Check if user is near the bottom of the scroll container
  const checkIfAtBottom = useCallback(() => {
    const el = containerRef.current;
    if (!el) return true;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    return distanceFromBottom <= SCROLL_THRESHOLD;
  }, []);

  // Handle scroll events to track user position
  const handleScroll = useCallback(() => {
    const atBottom = checkIfAtBottom();
    setIsAtBottom(atBottom);
    userScrolledUpRef.current = !atBottom;
  }, [checkIfAtBottom]);

  // Auto-scroll only when user hasn't scrolled up
  useEffect(() => {
    if (!userScrolledUpRef.current && messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages]);

  // When a new session starts (messages reset), scroll to bottom
  useEffect(() => {
    if (messages.length <= 1) {
      userScrolledUpRef.current = false;
      setIsAtBottom(true);
      messagesEndRef.current?.scrollIntoView({ behavior: 'instant' });
    }
  }, [messages.length]);

  // Scroll to bottom when user clicks the button
  const scrollToBottom = useCallback(() => {
    userScrolledUpRef.current = false;
    setIsAtBottom(true);
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  const items = processMessages(messages, agentState);

  const confirmToolName = confirmationRequest?.toolName;

  return (
    <div className="chat-messages-wrapper">
      {isLoadingHistory && (
        <div className="chat-loading-overlay">
          <div className="chat-loading-content">
            <Loader2 size={24} className="spinning" />
            <span>加载会话中...</span>
          </div>
        </div>
      )}
      <div className="chat-messages" ref={containerRef} onScroll={handleScroll}>
        {items.map((item) => {
          switch (item.type) {
            case 'user':
              return <UserBubble key={item.key} message={item.message} />;
            case 'assistant':
              return <AssistantBubble key={item.key} message={item.message} isStreaming={item.isStreaming} isPendingConfirmation={item.isPendingConfirmation} />;
            case 'toolCall':
              return (
                <ToolCallBubble
                  key={item.key}
                  item={item.item}
                  isWaitingConfirmation={item.isWaitingConfirmation}
                  confirmationRequest={item.isWaitingConfirmation && confirmToolName === item.item.toolName ? confirmationRequest : null}
                  onConfirm={onConfirm}
                />
              );
            default:
              return null;
          }
        })}
        <div ref={messagesEndRef} />
      </div>
      {!isAtBottom && (
        <button className="chat-scroll-to-bottom-btn" onClick={scrollToBottom} title="滚动到底部">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14"/><path d="m19 12-7 7-7-7"/></svg>
        </button>
      )}
    </div>
  );
}
