import { useState, useEffect, useRef } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { escapeHtml } from './chatUtils';

interface ThinkBlockProps {
  content: string;
  streaming?: boolean;
}

export default function ThinkBlock({ content, streaming }: ThinkBlockProps) {
  const [expanded, setExpanded] = useState(!!streaming);
  const bodyRef = useRef<HTMLDivElement>(null);
  const lines = content.split('\n');
  const previewLines = 3;
  const needsCollapse = lines.length > previewLines;
  const preview = needsCollapse ? lines.slice(0, previewLines).join('\n') : content;

  useEffect(() => {
    if (!streaming) {
      setExpanded(false);
    }
  }, [streaming]);

  useEffect(() => {
    if (streaming && expanded && bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
    }
  }, [content, streaming, expanded]);

  return (
    <div className="think-block">
      <div className="think-header" onClick={() => setExpanded(!expanded)}>
        {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <span className="think-label">Thinking</span>
        {!expanded && needsCollapse && <span className="think-preview" dangerouslySetInnerHTML={{ __html: escapeHtml(preview) }} />}
      </div>
      {expanded && (
        <div className="think-body" ref={bodyRef} dangerouslySetInnerHTML={{ __html: escapeHtml(content) }} />
      )}
    </div>
  );
}
