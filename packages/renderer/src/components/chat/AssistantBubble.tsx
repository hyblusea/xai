import type { Message } from '@xai/shared';
import ThinkBlock from './ThinkBlock';
import AssistantContent from './AssistantContent';
import { stripThinkTags, unescapeHtmlEntities } from './chatUtils';

interface AssistantBubbleProps {
  message: Message;
  isStreaming: boolean;
  isPendingConfirmation?: boolean;
}

export default function AssistantBubble({ message, isStreaming, isPendingConfirmation }: AssistantBubbleProps) {
  const hasText = message.content && message.content.trim();
  const hasThinking = message.thinkingContent && message.thinkingContent.trim();
  const needsFallbackThinkParse = !hasThinking && hasText && /<think/i.test(message.content);
  const isThinkingStreaming = !!(hasThinking && !hasText);

  return (
    <div className={`msg-bubble msg-bubble-assistant${isPendingConfirmation ? ' msg-bubble-pending-confirmation' : ''}`}>
      <span className="msg-role">Assistant</span>
      {hasThinking && <ThinkBlock content={message.thinkingContent!} streaming={isThinkingStreaming} />}
      {needsFallbackThinkParse ? (
        <FallbackThinkContent content={message.content} isStreaming={isStreaming} isPendingConfirmation={isPendingConfirmation} />
      ) : (
        hasText && <AssistantContent content={stripThinkTags(message.content)} isStreaming={isStreaming} isPendingConfirmation={isPendingConfirmation} />
      )}
      {isPendingConfirmation && (
        <div className="pending-confirmation-hint">
          <span className="pending-confirmation-icon">⏳</span>
          <span>操作待确认</span>
        </div>
      )}
    </div>
  );
}

function FallbackThinkContent({ content, isStreaming, isPendingConfirmation }: { content: string; isStreaming: boolean; isPendingConfirmation?: boolean }) {
  const normalized = unescapeHtmlEntities(content);
  const thinkRegex = /(<think[\s\S]*?(?:<\/think>|$))/gi;
  const parts = normalized.split(thinkRegex);

  return (
    <>
      {parts.map((part: string, i: number) => {
        if (/^<think/i.test(part.trimStart())) {
          const thinkContent = part.replace(/^<think\s*>/i, '').replace(/\s*<\/think>$/i, '').trim();
          if (!thinkContent) return null;
          return <ThinkBlock key={i} content={thinkContent} />;
        }
        if (!part.trim()) return null;
        return <AssistantContent key={i} content={part} isStreaming={isStreaming} isPendingConfirmation={isPendingConfirmation} />;
      })}
    </>
  );
}
