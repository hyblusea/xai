import { useState, useEffect } from 'react';
import { ChevronDown, ChevronRight, Wrench, CheckCircle, XCircle } from 'lucide-react';
import type { ToolBatchItem, ConfirmationRequest } from '@xai/shared';
import { isEditorBlockTool, isTextModeTool } from './toolNamesStore';

function formatParams(toolName: string, params: Record<string, unknown>): { title: string; content: string }[] {
  const sections: { title: string; content: string }[] = [];

  if (toolName === 'write_to_file' || toolName === 'NEW_FILE') {
    if (params.path) sections.push({ title: 'File', content: String(params.path) });
    if (params.start_line) sections.push({ title: 'Insert at Line', content: String(params.start_line) });
    if (params.content) sections.push({ title: params.start_line ? 'Insert Content' : 'Content', content: String(params.content) });
  } else if (toolName === 'replace_in_file' || toolName === 'SEARCH') {
    if (params.path) sections.push({ title: 'File', content: String(params.path) });
    if (params.search) sections.push({ title: 'Search', content: String(params.search) });
    if (params.replace) sections.push({ title: 'Replace', content: String(params.replace) });
  } else if (toolName === 'execute_command' || toolName === 'COMMAND') {
    if (params.command) sections.push({ title: 'Command', content: String(params.command) });
    if (params.cwd) sections.push({ title: 'CWD', content: String(params.cwd) });
  } else if (toolName === 'read_file' || toolName === 'READ_FILE') {
    if (params.path) sections.push({ title: 'File', content: String(params.path) });
    if (params.startLine) sections.push({ title: 'Start Line', content: String(params.startLine) });
    if (params.limit) sections.push({ title: 'Limit', content: String(params.limit) });
  } else if (toolName === 'list_files' || toolName === 'LIST_FILES') {
    if (params.path) sections.push({ title: 'Path', content: String(params.path) });
  } else if (toolName === 'search_files' || toolName === 'SEARCH_FILES') {
    if (params.pattern) sections.push({ title: 'Pattern', content: String(params.pattern) });
    if (params.path) sections.push({ title: 'Path', content: String(params.path) });
  } else if (toolName === 'remove_line') {
    if (params.path) sections.push({ title: 'File', content: String(params.path) });
    if (params.startLine) sections.push({ title: 'Start Line', content: String(params.startLine) });
    if (params.endLine) sections.push({ title: 'End Line', content: String(params.endLine) });
  } else if (toolName === 'grep_search') {
    if (params.pattern) sections.push({ title: 'Pattern', content: String(params.pattern) });
    if (params.path) sections.push({ title: 'Path', content: String(params.path) });
    if (params.context) sections.push({ title: 'Context', content: String(params.context) });
    if (params.filePattern) sections.push({ title: 'File Pattern', content: String(params.filePattern) });
  } else if (toolName === 'tool_search') {
    if (params.query) sections.push({ title: 'Query', content: String(params.query) });
  } else if (toolName === 'terminal_open') {
    if (params.shell) sections.push({ title: 'Shell', content: String(params.shell) });
    if (params.cwd) sections.push({ title: 'CWD', content: String(params.cwd) });
  } else if (toolName === 'terminal_send') {
    if (params.sessionId) sections.push({ title: 'Session', content: String(params.sessionId) });
    if (params.command) sections.push({ title: 'Command', content: String(params.command) });
    if (params.timeout) sections.push({ title: 'Timeout', content: String(params.timeout) + 'ms' });
    if (params.background) sections.push({ title: 'Background', content: 'Yes' });
  } else if (toolName === 'terminal_close') {
    if (params.sessionId) sections.push({ title: 'Session', content: String(params.sessionId) });
  } else if (toolName === 'terminal_poll') {
    if (params.sessionId) sections.push({ title: 'Session', content: String(params.sessionId) });
  } else if (toolName === 'web_search') {
    if (params.query) sections.push({ title: 'Query', content: String(params.query) });
    if (params.num) sections.push({ title: 'Results', content: String(params.num) });
  } else if (toolName === 'web_fetch') {
    if (params.url) sections.push({ title: 'URL', content: String(params.url) });
    if (params.maxLength) sections.push({ title: 'Max Length', content: String(params.maxLength) });
  } else if (toolName === 'browser_mouse_click') {
    if (params.selector) sections.push({ title: 'Selector', content: String(params.selector) });
    if (params.x !== undefined || params.y !== undefined) sections.push({ title: 'Position', content: `(${params.x ?? 0}, ${params.y ?? 0})` });
    if (params.button && params.button !== 'left') sections.push({ title: 'Button', content: String(params.button) });
    if (params.clickCount && params.clickCount !== 1) sections.push({ title: 'Click Count', content: String(params.clickCount) });
  } else if (toolName === 'browser_api_request') {
    if (params.url) sections.push({ title: 'URL', content: String(params.url) });
    if (params.method) sections.push({ title: 'Method', content: String(params.method) });
    if (params.headers) sections.push({ title: 'Headers', content: String(params.headers) });
    if (params.body) sections.push({ title: 'Body', content: String(params.body) });
  }

  if (sections.length === 0) {
    const keys = Object.keys(params);
    if (keys.length > 0) {
      sections.push({ title: 'Parameters', content: JSON.stringify(params, null, 2) });
    }
  }

  return sections;
}

interface ToolCallBubbleProps {
  item: ToolBatchItem;
  isWaitingConfirmation: boolean;
  confirmationRequest?: ConfirmationRequest | null;
  onConfirm?: (approved: boolean, approveAll?: boolean) => void;
}

export default function ToolCallBubble({ item, isWaitingConfirmation, confirmationRequest, onConfirm }: ToolCallBubbleProps) {
  const [expanded, setExpanded] = useState(!item.result);

  useEffect(() => {
    if (item.result) {
      setExpanded(false);
    }
  }, [item.result]);

  const statusClass = item.result
    ? item.result.success
      ? 'tool-call-bubble-success'
      : 'tool-call-bubble-error'
    : isWaitingConfirmation
      ? 'tool-call-bubble-confirm'
      : 'tool-call-bubble-pending';

  const statusIcon = item.result
    ? item.result.success
      ? <CheckCircle size={12} />
      : <XCircle size={12} />
    : <Wrench size={12} />;

  const statusText = item.result
    ? item.result.success ? 'Success' : 'Failed'
    : isWaitingConfirmation ? 'Confirm'
    : 'Running';

  const statusBadgeClass = item.result
    ? item.result.success
      ? 'tool-call-bubble-status-success'
      : 'tool-call-bubble-status-error'
    : isWaitingConfirmation
      ? 'tool-call-bubble-status-confirm'
      : 'tool-call-bubble-status-pending';

  const isEditorBlock = isTextModeTool(item.toolName);
  const paramSections = isEditorBlock
    ? []
    : item.parameters
      ? formatParams(item.toolName, item.parameters)
      : [];

  return (
    <div className={`tool-call-bubble ${statusClass}${expanded ? ' expanded' : ''}`}>
      <div className="tool-call-bubble-header" onClick={() => setExpanded(!expanded)}>
        <span className="tool-call-bubble-icon">{statusIcon}</span>
        <span className="tool-call-bubble-name">{item.toolName}</span>
        <span className={`tool-call-bubble-status ${statusBadgeClass}`}>{statusText}</span>
        {item.result?.executionTime && (
          <span className="tool-call-bubble-time">{item.result.executionTime}ms</span>
        )}
        {item.summary && (
          <span className="tool-call-bubble-summary">{item.summary}</span>
        )}
        <span className="tool-call-bubble-chevron">
          {expanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        </span>
      </div>
      {expanded && (
        <div className="tool-call-bubble-body">
          {paramSections.length > 0 && (
            <div className="tool-call-params-area">
              {paramSections.map((sec, i) => (
                <div key={i}>
                  <span className="tool-call-detail-label">{sec.title}</span>
                  {sec.title === 'Content' || sec.title === 'Search' || sec.title === 'Replace' ? (
                    <pre className="tool-call-code-content">{sec.content}</pre>
                  ) : sec.title === 'Parameters' ? (
                    <pre className="tool-call-params-content">{sec.content}</pre>
                  ) : (
                    <div className="tool-call-param-value">{sec.content}</div>
                  )}
                </div>
              ))}
            </div>
          )}
          {item.result && (
            <div>
              <span className="tool-call-detail-label">
                Result{item.result.executionTime ? ` (${item.result.executionTime}ms)` : ''}
              </span>
              {item.result.error && (
                <div className="tool-call-result-error">{item.result.error}</div>
              )}
              {item.result.output && (
                <pre className="tool-call-result-output">{item.result.output}</pre>
              )}
            </div>
          )}
          {!item.result && !isWaitingConfirmation && (
            <div className="tool-call-result-pending">Executing...</div>
          )}
          {isWaitingConfirmation && confirmationRequest && onConfirm && (
            <div className="tool-call-confirm-area">
              <span className={`tool-call-confirm-risk tool-call-confirm-risk-${confirmationRequest.riskLevel}`}>
                {confirmationRequest.riskLevel.charAt(0).toUpperCase() + confirmationRequest.riskLevel.slice(1)} Risk
              </span>
              <div className="tool-call-confirm-desc">{confirmationRequest.description}</div>
              <div className="tool-call-confirm-actions">
                <button className="tool-call-confirm-btn tool-call-confirm-deny" onClick={() => onConfirm(false)}>
                  Deny
                </button>
                <button className="tool-call-confirm-btn tool-call-confirm-approve" onClick={() => onConfirm(true)}>
                  Approve
                </button>
                <button className="tool-call-confirm-btn tool-call-confirm-approve-all" onClick={() => onConfirm(true, true)}>
                  Approve All
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
