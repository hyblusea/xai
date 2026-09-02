import { ConfirmationRequest } from '@xai/shared';
import { classifyCommand } from './command-classifier.js';

export type ConfirmationResponse = 'approve' | 'deny' | 'approve_all';

const READ_ONLY_TOOLS = new Set([
  'read_file',
  'list_files',
  'grep_search',
]);

const WRITE_TOOLS = new Set([
  'write_to_file',
  'replace_in_file',
]);

export class ConfirmationManager {
  private autoApproveAll: boolean = false;
  private approvedCommands: Set<string> = new Set();
  private autoApprovePatterns: string[] = [];
  private pendingRequest?: ConfirmationRequest;
  private responseCallback?: (response: ConfirmationResponse) => void;

  setAutoApproveAll(value: boolean): void {
    this.autoApproveAll = value;
  }

  setAutoApproveCommands(patterns: string[]): void {
    this.autoApprovePatterns = patterns.map(p => p.trim().toLowerCase()).filter(Boolean);
  }

  private matchesAutoApprove(command: string): boolean {
    const lower = command.trim().toLowerCase();
    for (const pattern of this.autoApprovePatterns) {
      if (lower === pattern || lower.startsWith(pattern + ' ')) {
        return true;
      }
    }
    return false;
  }

  needsConfirmation(toolName: string, params: Record<string, unknown>): boolean {
    if (this.autoApproveAll) return false;

    if (READ_ONLY_TOOLS.has(toolName)) return false;

    if (WRITE_TOOLS.has(toolName)) return true;

    if (toolName === 'execute_command') {
      const command = String(params.command ?? '');
      if (!command) return false;

      const commandKey = `${toolName}:${command}`;
      if (this.approvedCommands.has(commandKey)) return false;

      // Check config-driven auto-approve whitelist first
      if (this.matchesAutoApprove(command)) return false;

      const classification = classifyCommand(command);
      if (classification === 'auto') return false;
      if (classification === 'deny') return true;
      return true;
    }

    return true;
  }

  requestConfirmation(request: ConfirmationRequest): Promise<ConfirmationResponse> {
    this.pendingRequest = request;
    return new Promise<ConfirmationResponse>((resolve) => {
      this.responseCallback = resolve;
    });
  }

  respondConfirmation(response: ConfirmationResponse): void {
    if (!this.pendingRequest && !this.responseCallback) return;

    if (response === 'approve_all') {
      this.autoApproveAll = true;
    }

    if (response === 'approve' && this.pendingRequest) {
      const toolName = this.pendingRequest.toolName;
      if (toolName === 'execute_command') {
        const command = String(this.pendingRequest.parameters?.command ?? '');
        if (command) {
          this.approvedCommands.add(`${toolName}:${command}`);
        }
      }
    }

    this.pendingRequest = undefined;
    this.responseCallback?.(response);
    this.responseCallback = undefined;
  }

  isApproved(command: string): boolean {
    return this.approvedCommands.has(`execute_command:${command}`);
  }

  clearApproved(): void {
    this.approvedCommands.clear();
  }
}