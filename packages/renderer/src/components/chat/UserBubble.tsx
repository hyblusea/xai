import type { Message } from '@xai/shared';

interface UserBubbleProps {
  message: Message;
}

export default function UserBubble({ message }: UserBubbleProps) {
  return (
    <div className="msg-bubble msg-bubble-user">
      <span className="msg-role">You</span>
      <div className="msg-content">{message.content}</div>
    </div>
  );
}
