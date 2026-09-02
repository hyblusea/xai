import type { Message } from '@xai/shared';

export class ContextManager {
  private messages: Message[] = [];

  addMessage(message: Message): void {
    this.messages.push(message);
  }

  getMessages(): Message[] {
    return [...this.messages];
  }

  clear(): void {
    this.messages = [];
  }
}
