import mqtt from 'mqtt';
import type { MqttClient } from 'mqtt';
import { createDecipheriv, randomBytes } from 'crypto';
import {
  MQTT_CONFIG,
  MQTTPairRequest,
  MQTTPairResponse,
  MQTTRequest,
  MQTTResponse,
  MQTTCommandType,
  MobileMessage,
  getMQTTTopics,
  MQTTConfig,
  Message,
  AgentState,
  ConfirmationRequest,
  ConfirmationResponse,
  ConversationItem,
  EncryptedPayload,
} from '@xai/shared';

interface PairedMobile {
  mobileId: string;
  deviceName: string;
  connectedAt: number;
}

type CommandHandler = (command: MQTTCommandType, data: unknown) => Promise<unknown>;

export class MqttBridge {
  private client: MqttClient | null = null;
  private deviceId: string;
  private encryptionKey: string = '';
  private pairCode: string = '';
  private pairCodeTimer: ReturnType<typeof setTimeout> | null = null;
  private pairedMobiles: Map<string, PairedMobile> = new Map();
  private isRunning: boolean = false;
  private currentBrokerUrl: string = MQTT_CONFIG.BROKER_URL;
  private enabled: boolean = true;
  private commandHandler: CommandHandler | null = null;
  private onPairingStatusChange: ((info: PairingStatusInfo) => void) | null = null;

  constructor(deviceId?: string, encryptionKey?: string) {
    this.deviceId = deviceId || this.generateDeviceId();
    this.encryptionKey = encryptionKey || '';
  }

  setCommandHandler(handler: CommandHandler) {
    this.commandHandler = handler;
  }

  setPairingStatusHandler(handler: (info: PairingStatusInfo) => void) {
    this.onPairingStatusChange = handler;
  }

  getDeviceId(): string { return this.deviceId; }
  getEncryptionKey(): string { return this.encryptionKey; }
  getPairCode(): string { return this.pairCode; }
  getPairedCount(): number { return this.pairedMobiles.size; }
  isConnected(): boolean { return this.isRunning && this.client?.connected === true; }
  isEnabled(): boolean { return this.enabled; }
  getBrokerUrl(): string { return this.currentBrokerUrl; }

  async updateConfig(config: MQTTConfig): Promise<void> {
    const brokerChanged = config.brokerUrl !== this.currentBrokerUrl;
    const enabledChanged = config.enabled !== this.enabled;
    this.currentBrokerUrl = config.brokerUrl;
    this.enabled = config.enabled;

    if (!this.enabled) {
      if (this.isRunning) await this.stop();
      this.notifyPairingStatus();
      return;
    }
    if (brokerChanged && this.isRunning) {
      await this.stop();
      await this.start();
      return;
    }
    if (this.enabled && !this.isRunning) {
      await this.start();
      return;
    }
    this.notifyPairingStatus();
  }

  async start(): Promise<void> {
    if (this.isRunning || !this.enabled) return;
    return new Promise((resolve, reject) => {
      try {
        this.client = mqtt.connect(this.currentBrokerUrl, {
          clientId: `xai_pc_${this.deviceId}`,
          clean: true,
          connectTimeout: 10000,
          reconnectPeriod: MQTT_CONFIG.RECONNECT_INTERVAL_MS,
          keepalive: 60,
        });

        this.client.on('connect', () => {
          this.isRunning = true;
          this.resubscribe();
          this.notifyPairingStatus();
          resolve();
        });

        this.client.on('error', (err) => {
          if (!this.isRunning) reject(err);
        });

        this.client.on('close', () => {
          this.isRunning = false;
          this.notifyPairingStatus();
        });

        this.client.on('message', (topic: string, payload: Buffer) => {
          this.handleMessage(topic, payload);
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  async stop(): Promise<void> {
    if (this.pairCodeTimer) {
      clearTimeout(this.pairCodeTimer);
      this.pairCodeTimer = null;
    }
    if (this.client) {
      try {
        const topics = getMQTTTopics(this.deviceId);
        if (this.pairCode) this.client.unsubscribe(topics.pairRequestForCode(this.pairCode));
        this.client.unsubscribe(topics.pcRequest);
        this.client.unsubscribe(topics.pcResponse);
        this.client.end(true);
      } catch {}
      this.client = null;
    }
    this.isRunning = false;
    this.pairedMobiles.clear();
    this.pairCode = '';
    this.notifyPairingStatus();
  }

  generatePairCode(): string {
    if (this.pairCodeTimer) clearTimeout(this.pairCodeTimer);
    if (this.pairCode && this.client) {
      const topics = getMQTTTopics(this.deviceId);
      this.client.unsubscribe(topics.pairRequestForCode(this.pairCode));
    }
    const code = Math.floor(Math.random() * Math.pow(10, MQTT_CONFIG.PAIR_CODE_LENGTH))
      .toString().padStart(MQTT_CONFIG.PAIR_CODE_LENGTH, '0');
    this.pairCode = code;
    if (this.client && this.isRunning) {
      const topics = getMQTTTopics(this.deviceId);
      this.client.subscribe(topics.pairRequestForCode(code), { qos: MQTT_CONFIG.QOS });
    }
    this.pairCodeTimer = setTimeout(() => this.invalidatePairCode(), MQTT_CONFIG.PAIR_CODE_TTL_MS);
    this.notifyPairingStatus();
    return code;
  }

  invalidatePairCode() {
    if (this.pairCode && this.client) {
      const topics = getMQTTTopics(this.deviceId);
      this.client.unsubscribe(topics.pairRequestForCode(this.pairCode));
    }
    this.pairCode = '';
    if (this.pairCodeTimer) { clearTimeout(this.pairCodeTimer); this.pairCodeTimer = null; }
    this.notifyPairingStatus();
  }

  private resubscribe(): void {
    if (!this.client || !this.isRunning) return;
    const topics = getMQTTTopics(this.deviceId);
    if (this.pairCode) this.client.subscribe(topics.pairRequestForCode(this.pairCode), { qos: MQTT_CONFIG.QOS });
    if (this.pairedMobiles.size > 0) this.client.subscribe(topics.pcRequest, { qos: MQTT_CONFIG.QOS });
  }

  private sendResponse(response: MQTTResponse): void {
    if (!this.client || !this.isRunning) return;
    const topics = getMQTTTopics(this.deviceId);
    this.client.publish(topics.pcResponse, JSON.stringify(response), { qos: MQTT_CONFIG.QOS });
  }

  private decryptPayload(encrypted: EncryptedPayload): string | null {
    try {
      if (!this.encryptionKey) return null;
      const key = Buffer.from(this.encryptionKey, 'hex');
      const iv = Buffer.from(encrypted.iv, 'base64');
      const data = Buffer.from(encrypted.e, 'base64');
      const decipher = createDecipheriv('aes-256-cbc', key, iv);
      const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
      return decrypted.toString('utf8');
    } catch (err) {
      console.error('[MqttBridge] Decryption failed:', err);
      return null;
    }
  }

  private handleMessage(topic: string, payload: Buffer): void {
    try {
      const data = JSON.parse(payload.toString());

      if (topic.match(new RegExp(`^${MQTT_CONFIG.TOPIC_PREFIX}/pair/\\d{${MQTT_CONFIG.PAIR_CODE_LENGTH}}/request$`))) {
        this.handlePairRequest(topic, data as MQTTPairRequest);
        return;
      }

      const topics = getMQTTTopics(this.deviceId);
      if (topic === topics.pcRequest) {
        let request: MQTTRequest & { ts?: number };

        if (data.e && data.iv) {
          const decrypted = this.decryptPayload(data as EncryptedPayload);
          if (!decrypted) {
            console.error('[MqttBridge] Failed to decrypt command');
            return;
          }
          request = JSON.parse(decrypted);
        } else {
          request = data as MQTTRequest & { ts?: number };
        }

        if (request.ts) {
          const age = Date.now() - request.ts;
          if (age > MQTT_CONFIG.TIMESTAMP_TOLERANCE_MS || age < -MQTT_CONFIG.TIMESTAMP_TOLERANCE_MS) {
            this.sendResponse({
              requestId: request.requestId || '',
              command: request.command || 'get_status',
              success: false,
              error: `Request expired (age=${age}ms, tolerance=${MQTT_CONFIG.TIMESTAMP_TOLERANCE_MS}ms)`,
            });
            return;
          }
        }

        this.handleCommand(request);
        return;
      }
    } catch (err) {
      console.error('[MqttBridge] Failed to handle message:', err);
    }
  }

  private handlePairRequest(topic: string, request: MQTTPairRequest): void {
    const match = topic.match(new RegExp(`^${MQTT_CONFIG.TOPIC_PREFIX}/pair/(\\d{${MQTT_CONFIG.PAIR_CODE_LENGTH}})/request$`));
    if (!match) return;
    const code = match[1];
    if (code !== this.pairCode) {
      const response: MQTTPairResponse = { success: false, deviceId: '', errorMessage: 'Invalid pair code', timestamp: Date.now() };
      if (this.client) {
        const topics = getMQTTTopics(this.deviceId);
        this.client.publish(topics.pairResponseForCode(code), JSON.stringify(response), { qos: MQTT_CONFIG.QOS });
      }
      return;
    }
    this.pairedMobiles.set(request.mobileId, { mobileId: request.mobileId, deviceName: request.deviceName, connectedAt: Date.now() });

    if (!this.encryptionKey) {
      this.encryptionKey = randomBytes(MQTT_CONFIG.ENCRYPTION_KEY_LENGTH).toString('hex');
    }

    const response: MQTTPairResponse = {
      success: true,
      deviceId: this.deviceId,
      encryptionKey: this.encryptionKey,
      timestamp: Date.now(),
    };
    if (this.client) {
      const topics = getMQTTTopics(this.deviceId);
      this.client.publish(topics.pairResponseForCode(code), JSON.stringify(response), { qos: MQTT_CONFIG.QOS });
      this.client.subscribe(topics.pcRequest, { qos: MQTT_CONFIG.QOS });
    }
    this.notifyPairingStatus();
  }

  private async handleCommand(request: MQTTRequest): Promise<void> {
    if (!this.commandHandler) {
      this.sendResponse({ requestId: request.requestId, command: request.command, success: false, error: 'No command handler' });
      return;
    }
    try {
      const result = await this.commandHandler(request.command, request.data);
      this.sendResponse({ requestId: request.requestId, command: request.command, success: true, data: result });
    } catch (err) {
      this.sendResponse({ requestId: request.requestId, command: request.command, success: false, error: String(err) });
    }
  }

  private notifyPairingStatus(): void {
    if (!this.onPairingStatusChange) return;
    this.onPairingStatusChange({
      isConnected: this.isConnected(),
      pairCode: this.pairCode,
      pairedCount: this.pairedMobiles.size,
      deviceId: this.deviceId,
      enabled: this.enabled,
      brokerUrl: this.currentBrokerUrl,
    });
  }

  private generateDeviceId(): string {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substring(2, 8);
    return `pc_${timestamp}_${random}`;
  }
}

export interface PairingStatusInfo {
  isConnected: boolean;
  pairCode: string;
  pairedCount: number;
  deviceId: string;
  enabled: boolean;
  brokerUrl: string;
}

export function truncateContent(content: string, maxLength: number = MQTT_CONFIG.CONTENT_MAX_LENGTH): string {
  if (!content || content.length <= maxLength) return content;
  return content.substring(0, maxLength) + `...[已省略，共${content.length}字符]`;
}

export function truncateCodeBlock(content: string, previewLines: number = MQTT_CONFIG.CODE_PREVIEW_LINES): string {
  const codeBlockRegex = /```[\s\S]*?```/g;
  return content.replace(codeBlockRegex, (match) => {
    const lines = match.split('\n');
    if (lines.length <= previewLines + 2) return match;
    const header = lines[0];
    const preview = lines.slice(1, previewLines + 1).join('\n');
    return `${header}\n${preview}\n...[代码已省略，共${lines.length - 2}行]\n\`\`\``;
  });
}

export function truncateToolOutput(output: string, maxLength: number = MQTT_CONFIG.TOOL_OUTPUT_MAX_LENGTH): string {
  if (!output || output.length <= maxLength) return output;
  return output.substring(0, maxLength) + `...[输出已省略，共${output.length}字符]`;
}

export function truncateCommandOutput(output: string, tailLines: number = MQTT_CONFIG.COMMAND_OUTPUT_TAIL_LINES): string {
  if (!output) return output;
  const lines = output.split('\n').filter((l: string) => l.trim());
  if (lines.length <= tailLines) return output;
  const tail = lines.slice(-tailLines).join('\n');
  return `...[已省略前${lines.length - tailLines}行]\n${tail}`;
}

export function convertToMobileMessage(msg: Message, index: number): MobileMessage {
  const id = `msg_${msg.timestamp}_${index}`;

  if (msg.role === 'user') {
    return {
      id,
      role: 'user',
      content: truncateContent(truncateCodeBlock(msg.content)),
      timestamp: msg.timestamp,
    };
  }

  if (msg.role === 'assistant') {
    let content = msg.content || '';
    const hasConfirmation = content.startsWith('[Confirmation Required]');

    if (msg.toolName) {
      content = truncateContent(content, MQTT_CONFIG.TOOL_OUTPUT_MAX_LENGTH);
      const confirmationInfo = hasConfirmation ? {
        toolName: msg.toolName,
        description: content.replace('[Confirmation Required]', '').trim(),
        riskLevel: 'medium' as const,
      } : undefined;

      return {
        id,
        role: 'assistant',
        content,
        timestamp: msg.timestamp,
        toolName: msg.toolName,
        confirmationInfo,
      };
    }

    content = truncateContent(truncateCodeBlock(content));

    return {
      id,
      role: 'assistant',
      content,
      timestamp: msg.timestamp,
    };
  }

  if (msg.role === 'tool') {
    const isCommand = msg.toolName === 'execute_command';
    const toolStatus = msg.toolResult?.success ? 'success' as const : 'failed' as const;
    let toolSummary: string;

    if (isCommand) {
      toolSummary = truncateCommandOutput(msg.content);
    } else {
      toolSummary = truncateToolOutput(msg.content);
    }

    return {
      id,
      role: 'tool',
      content: toolSummary,
      timestamp: msg.timestamp,
      toolName: msg.toolName,
      toolStatus,
      toolSummary,
    };
  }

  return { id, role: 'assistant', content: truncateContent(msg.content), timestamp: msg.timestamp };
}
