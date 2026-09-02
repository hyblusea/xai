import { useMemo } from 'react';
import { escapeHtml, stripThinkTags, parseContentSegments, parseTextWithCodeBlocks } from './chatUtils';
import ToolInstructionBlock from './ToolInstructionBlock';
import CodeBlock from './CodeBlock';

interface AssistantContentProps {
  content: string;
  isStreaming: boolean;
  isPendingConfirmation?: boolean;
}

export default function AssistantContent({ content, isStreaming, isPendingConfirmation }: AssistantContentProps) {
  const cleanContent = stripThinkTags(content);

  const showStreaming = isStreaming || isPendingConfirmation;

  const segments = useMemo(() => {
    if (!cleanContent.trim()) return [];
    if (showStreaming) return [{ type: 'text' as const, content: cleanContent }];
    return parseContentSegments(cleanContent);
  }, [cleanContent, showStreaming]);

  if (segments.length === 0) return null;

  return (
    <div className="msg-content assistant-content-bubble">
      {segments.map((seg, i) => {
        if (seg.type === 'toolInstruction') {
          return (
            <ToolInstructionBlock
              key={`instr-${i}`}
              content={seg.content}
              label={seg.label}
              instructionType={seg.instructionType}
            />
          );
        }
        if (!seg.content.trim()) return null;
        const parts = parseTextWithCodeBlocks(seg.content);
        const isLastSegment = showStreaming && i === segments.length - 1;
        // Find last text-type part index for cursor placement
        let lastTextPartIdx = -1;
        parts.forEach((p, idx) => { if (p.type === 'text' && p.content.trim()) lastTextPartIdx = idx; });
        return (
          <div
            key={`text-${i}`}
            className="assistant-content-segment"
          >
            {parts.map((part, j) => {
              if (part.type === 'codeBlock') {
                return <CodeBlock key={j} language={part.language} code={part.code} />;
              }
              if (!part.content.trim()) return null;
              const showCursor = isLastSegment && j === lastTextPartIdx;
              return (
                <div
                  key={j}
                  className={showCursor ? 'typewriter-cursor' : undefined}
                  dangerouslySetInnerHTML={{ __html: escapeHtml(part.content) }}
                />
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
