import { useState } from 'react';
import { ChevronDown, ChevronRight, Code } from 'lucide-react';
import { escapeHtml } from './chatUtils';

interface ToolInstructionBlockProps {
  content: string;
  label: string;
  instructionType: 'editorBlock';
  defaultExpanded?: boolean;
}

const TOOL_LABELS: Record<string, string> = {
  replace_in_file: '替换文件内容',
  write_to_file: '写入文件',
  remove_line: '删除行',
  execute_command: '命令脚本',
  read_file: '读取文件',
  list_files: '列出文件',
  grep_search: '内容搜索',
  tool_search: '工具搜索',
  terminal_open: '打开终端',
  terminal_send: '终端命令',
  terminal_close: '关闭终端',
  sql_execute: '执行SQL',
};

export default function ToolInstructionBlock({ content, label, instructionType, defaultExpanded = false }: ToolInstructionBlockProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  const typeLabel = '命令块';
  const displayLabel = TOOL_LABELS[label] ?? label.replace(/_/g, ' ');

  return (
    <div className="tool-instruction-block">
      <div className="tool-instruction-header" onClick={() => setExpanded(!expanded)}>
        {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <Code size={12} style={{ color: 'var(--text-muted)' }} />
        <span className={`tool-instruction-type tool-instruction-type-${instructionType}`}>{typeLabel}</span>
        <span className="tool-instruction-label">{displayLabel}</span>
      </div>
      {expanded && (
        <div className="tool-instruction-body">
          <pre dangerouslySetInnerHTML={{ __html: escapeHtml(content) }} />
        </div>
      )}
    </div>
  );
}
