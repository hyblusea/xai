import { useState, useCallback, useRef } from 'react';
import { Copy, Check } from 'lucide-react';

interface CodeBlockProps {
  language: string;
  code: string;
}

export default function CodeBlock({ language, code }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), 2000);
    });
  }, [code]);

  const displayLang = language || 'text';

  return (
    <div className="chat-code-block">
      <div className="chat-code-block-header">
        <span className="chat-code-block-lang">{displayLang}</span>
        <button
          className="chat-code-block-copy-btn"
          onClick={handleCopy}
          title={copied ? '已复制' : '复制代码'}
        >
          {copied ? <Check size={13} /> : <Copy size={13} />}
          <span>{copied ? '已复制' : '复制'}</span>
        </button>
      </div>
      <pre className="chat-code-block-pre">
        <code className="chat-code-block-code">{code}</code>
      </pre>
    </div>
  );
}
