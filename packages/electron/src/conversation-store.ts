/**
 * Local conversation store for OpenAI / DevEco / Cline providers.
 *
 * These three providers are stateless (the API server keeps no conversation
 * history), so we persist conversations to local JSON files under
 * {userData}/conversations/. All three providers share the same store —
 * conversations are NOT partitioned by provider. The `provider` and `model`
 * fields in the metadata are recorded for display and for cross-adapter
 * context migration on load (via importSnapshot).
 *
 * Storage layout:
 *   {userData}/conversations/
 *     index.json                 — array of ConversationMeta
 *     {conversationId}.json      — full SavedConversation
 */
import { app } from 'electron';
import fs from 'fs/promises';
import path from 'path';
import type { Message } from '@xai/shared';

export interface ConversationMeta {
  conversationId: string;
  title: string;
  provider: string;
  model: string;
  createTime: number;
  updateTime: number;
  messageCount: number;
  isCompressed: boolean;
}

export interface AdapterState {
  conversationHistory: unknown[];
  pendingToolCallIds: string[];
}

export interface CompressionInfo {
  isCompressed: boolean;
  originalMessageCount: number | null;
  summary: string | null;
  compressedAt: number | null;
}

export interface SavedConversation {
  conversationId: string;
  title: string;
  provider: string;
  model: string;
  createTime: number;
  updateTime: number;
  version: number;
  displayMessages: Message[];
  adapterState: AdapterState;
  compressionInfo: CompressionInfo;
}

const STORE_VERSION = 1;

export class ConversationStore {
  private storeDir: string;
  private indexPath: string;
  private index: ConversationMeta[] | null = null;
  /** Serialize writes to avoid concurrent file corruption. */
  private writeQueue: Promise<void> = Promise.resolve();

  constructor() {
    this.storeDir = path.join(app.getPath('userData'), 'conversations');
    this.indexPath = path.join(this.storeDir, 'index.json');
  }

  /** Initialize the store directory and load the index. */
  async init(): Promise<void> {
    try {
      await fs.mkdir(this.storeDir, { recursive: true });
    } catch {
      // Directory may already exist — ignore.
    }
    await this.loadIndex();
  }

  /** Load index.json into memory (tolerant of missing / corrupt file). */
  private async loadIndex(): Promise<void> {
    try {
      const data = await fs.readFile(this.indexPath, 'utf-8');
      const parsed = JSON.parse(data);
      if (Array.isArray(parsed)) {
        this.index = parsed as ConversationMeta[];
      } else {
        this.index = [];
      }
    } catch {
      this.index = [];
    }
  }

  /** Persist the in-memory index to disk (serialized). */
  private async saveIndex(): Promise<void> {
    if (!this.index) return;
    const tmpPath = this.indexPath + '.tmp';
    await fs.writeFile(tmpPath, JSON.stringify(this.index, null, 2), 'utf-8');
    // Atomic-ish rename on the same volume.
    await fs.rename(tmpPath, this.indexPath);
  }

  /**
   * Save or update a conversation.
   * All writes are serialized through writeQueue to avoid corruption.
   */
  async save(
    meta: ConversationMeta,
    displayMessages: Message[],
    adapterState: AdapterState,
    compressionInfo: CompressionInfo,
  ): Promise<void> {
    const run = async (): Promise<void> => {
      // Ensure directory exists
      await fs.mkdir(this.storeDir, { recursive: true });

      // Load index lazily if not yet loaded
      if (this.index === null) {
        await this.loadIndex();
      }

      // Check if this conversation already exists (to preserve createTime)
      const existing = this.index!.find(c => c.conversationId === meta.conversationId);
      const createTime = existing?.createTime ?? meta.createTime;

      const full: SavedConversation = {
        conversationId: meta.conversationId,
        title: meta.title,
        provider: meta.provider,
        model: meta.model,
        createTime,
        updateTime: meta.updateTime,
        version: STORE_VERSION,
        displayMessages,
        adapterState,
        compressionInfo,
      };

      // Write the conversation file (atomic via temp + rename)
      const convPath = path.join(this.storeDir, `${meta.conversationId}.json`);
      const tmpPath = convPath + '.tmp';
      await fs.writeFile(tmpPath, JSON.stringify(full), 'utf-8');
      await fs.rename(tmpPath, convPath);

      // Update index
      const idx = this.index!;
      const pos = idx.findIndex(c => c.conversationId === meta.conversationId);
      const newMeta: ConversationMeta = {
        conversationId: meta.conversationId,
        title: meta.title,
        provider: meta.provider,
        model: meta.model,
        createTime,
        updateTime: meta.updateTime,
        messageCount: meta.messageCount,
        isCompressed: meta.isCompressed,
      };
      if (pos >= 0) {
        idx[pos] = newMeta;
      } else {
        idx.unshift(newMeta);
      }

      await this.saveIndex();
    };

    // Chain onto the write queue
    this.writeQueue = this.writeQueue.then(run, run);
    await this.writeQueue;
  }

  /**
   * List all conversations (metadata only), sorted by updateTime descending.
   * All providers are mixed together — no filtering by provider.
   */
  async listConversations(): Promise<ConversationMeta[]> {
    if (this.index === null) {
      await this.loadIndex();
    }
    return [...(this.index ?? [])].sort((a, b) => b.updateTime - a.updateTime);
  }

  /**
   * Load a full conversation by ID.
   * Returns null if the file is missing or corrupt.
   */
  async loadConversation(conversationId: string): Promise<SavedConversation | null> {
    const convPath = path.join(this.storeDir, `${conversationId}.json`);
    try {
      const data = await fs.readFile(convPath, 'utf-8');
      const parsed = JSON.parse(data) as SavedConversation;
      return parsed;
    } catch {
      return null;
    }
  }

  /**
   * Delete a conversation (both the JSON file and its index entry).
   */
  async deleteConversation(conversationId: string): Promise<boolean> {
    const run = async (): Promise<boolean> => {
      if (this.index === null) {
        await this.loadIndex();
      }
      // Remove from index
      const before = this.index!.length;
      this.index! = this.index!.filter(c => c.conversationId !== conversationId);
      const removed = this.index!.length < before;
      if (removed) {
        await this.saveIndex();
      }
      // Remove the file (ignore errors if it doesn't exist)
      const convPath = path.join(this.storeDir, `${conversationId}.json`);
      try {
        await fs.unlink(convPath);
      } catch {
        // File may not exist — that's fine.
      }
      return removed;
    };

    this.writeQueue = this.writeQueue.then(run, run);
    return this.writeQueue.then(() => true, () => false);
  }

  /** Update the title of a conversation in the index (and file if present). */
  async updateTitle(conversationId: string, title: string): Promise<void> {
    const run = async (): Promise<void> => {
      if (this.index === null) {
        await this.loadIndex();
      }
      const entry = this.index!.find(c => c.conversationId === conversationId);
      if (entry) {
        entry.title = title;
        entry.updateTime = Date.now();
        await this.saveIndex();
      }
      // Also update the full conversation file if it exists
      const convPath = path.join(this.storeDir, `${conversationId}.json`);
      try {
        const data = await fs.readFile(convPath, 'utf-8');
        const parsed = JSON.parse(data) as SavedConversation;
        parsed.title = title;
        parsed.updateTime = Date.now();
        await fs.writeFile(convPath, JSON.stringify(parsed), 'utf-8');
      } catch {
        // File may not exist yet — title is saved in index only.
      }
    };

    this.writeQueue = this.writeQueue.then(run, run);
    await this.writeQueue;
  }
}
