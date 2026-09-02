import { Shield, ShieldAlert, ShieldX } from 'lucide-react';
import type { ConfirmationRequest } from '@xai/shared';

interface ConfirmationDialogProps {
  request: ConfirmationRequest;
  onRespond: (approved: boolean, approveAll?: boolean) => void;
}

const RISK_CONFIG = {
  low: {
    color: 'var(--risk-low)',
    icon: Shield,
    label: 'Low Risk',
  },
  medium: {
    color: 'var(--risk-medium)',
    icon: ShieldAlert,
    label: 'Medium Risk',
  },
  high: {
    color: 'var(--risk-high)',
    icon: ShieldX,
    label: 'High Risk',
  },
};

export default function ConfirmationDialog({ request, onRespond }: ConfirmationDialogProps) {
  const config = RISK_CONFIG[request.riskLevel];
  const RiskIcon = config.icon;

  return (
    <div className="overlay">
      <div className="confirm-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="confirm-header">
          <RiskIcon size={20} style={{ color: config.color }} />
          <span className="confirm-title">Confirmation Required</span>
          <span className="confirm-risk" style={{ color: config.color, borderColor: config.color }}>
            {config.label}
          </span>
        </div>

        <div className="confirm-body">
          <div className="confirm-tool-name">
            Tool: <strong>{request.toolName}</strong>
          </div>
          <div className="confirm-description">{request.description}</div>
          {Object.keys(request.parameters).length > 0 && (
            <div className="confirm-params">
              <div className="confirm-params-title">Parameters:</div>
              <pre className="confirm-params-content">
                {JSON.stringify(request.parameters, null, 2)}
              </pre>
            </div>
          )}
        </div>

        <div className="confirm-actions">
          <button className="confirm-btn confirm-deny" onClick={() => onRespond(false)}>
            Deny
          </button>
          <button className="confirm-btn confirm-approve" onClick={() => onRespond(true)}>
            Approve
          </button>
          <button className="confirm-btn confirm-approve-all" onClick={() => onRespond(true, true)}>
            Approve All
          </button>
        </div>
      </div>

      <style>{`
        .confirm-dialog {
          background: var(--bg-secondary);
          border: 1px solid var(--border);
          border-radius: var(--radius-md);
          width: 440px;
          max-width: 90vw;
          box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
          overflow: hidden;
        }
        .confirm-header {
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 14px 16px;
          border-bottom: 1px solid var(--border);
        }
        .confirm-title {
          font-weight: 600;
          font-size: 14px;
          flex: 1;
        }
        .confirm-risk {
          font-size: 10px;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.5px;
          padding: 2px 8px;
          border-radius: 10px;
          border: 1px solid;
        }
        .confirm-body {
          padding: 16px;
          display: flex;
          flex-direction: column;
          gap: 10px;
        }
        .confirm-tool-name {
          font-size: 13px;
          color: var(--text-secondary);
        }
        .confirm-tool-name strong {
          color: var(--warning);
          font-family: var(--font-mono);
        }
        .confirm-description {
          font-size: 13px;
          color: var(--text-primary);
          line-height: 1.5;
        }
        .confirm-params {
          display: flex;
          flex-direction: column;
          gap: 4px;
        }
        .confirm-params-title {
          font-size: 11px;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.3px;
          color: var(--text-muted);
        }
        .confirm-params-content {
          background: var(--bg-primary);
          border: 1px solid var(--border);
          border-radius: var(--radius-sm);
          padding: 8px 10px;
          font-family: var(--font-mono);
          font-size: 12px;
          color: var(--text-secondary);
          overflow-x: auto;
          white-space: pre-wrap;
          word-break: break-word;
          max-height: 150px;
          overflow-y: auto;
        }
        .confirm-actions {
          display: flex;
          justify-content: flex-end;
          gap: 8px;
          padding: 12px 16px;
          border-top: 1px solid var(--border);
        }
        .confirm-btn {
          padding: 6px 16px;
          border-radius: var(--radius-sm);
          font-size: 12px;
          font-weight: 500;
          transition: background 0.15s, opacity 0.15s;
        }
        .confirm-deny {
          background: transparent;
          border: 1px solid var(--border);
          color: var(--text-secondary);
        }
        .confirm-deny:hover {
          background: var(--bg-hover);
          color: var(--text-primary);
        }
        .confirm-approve {
          background: var(--accent);
          color: white;
        }
        .confirm-approve:hover {
          background: var(--accent-hover);
        }
        .confirm-approve-all {
          background: var(--success);
          color: var(--bg-primary);
        }
        .confirm-approve-all:hover {
          opacity: 0.9;
        }
      `}</style>
    </div>
  );
}
