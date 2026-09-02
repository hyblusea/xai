/**
 * MQTT Bridge initialization.
 */
import { IPCChannel, MQTT_CONFIG } from '@xai/shared';
import { MqttBridge, convertToMobileMessage } from './mqtt-bridge.js';
import type { PairingStatusInfo } from './mqtt-bridge.js';
import type { AppState } from './app-state.js';

export async function initializeMqttBridge(state: AppState): Promise<void> {
  const mqttConfig = state.sessionConfig.mqtt || { brokerUrl: 'ws://broker.emqx.io:8083/mqtt', enabled: true };
  state.mqttBridge = new MqttBridge(mqttConfig.deviceId, mqttConfig.encryptionKey);

  if (!mqttConfig.deviceId) {
    mqttConfig.deviceId = state.mqttBridge.getDeviceId();
    state.sessionConfig.mqtt = mqttConfig;
    const { configManager } = await import('./config.js');
    await configManager.saveConfig(state.sessionConfig);
  }

  state.mqttBridge.setPairingStatusHandler(async () => {
    const key = state.mqttBridge!.getEncryptionKey();
    if (key && state.sessionConfig.mqtt && state.sessionConfig.mqtt.encryptionKey !== key) {
      state.sessionConfig.mqtt.encryptionKey = key;
      const { configManager } = await import('./config.js');
      await configManager.saveConfig(state.sessionConfig);
    }
  });

  state.mqttBridge.setCommandHandler(async (command: import('@xai/shared').MQTTCommandType, data: unknown): Promise<unknown> => {
    switch (command) {
      case 'get_status': {
        return {
          agentState: state.reactLoop?.currentState ?? 'idle',
          workspace: state.sessionConfig.workspace,
          isAgentRunning: state.isAgentRunning,
          sessionTitle: state.currentSessionTitle,
          hasConfirmation: !!state.currentConfirmationRequest,
          messageCount: state.currentMessages.length,
        } as import('@xai/shared').GetStatusData;
      }
      case 'get_messages': {
        const req = data as import('@xai/shared').GetMessagesRequest;
        const limit = req?.limit ?? MQTT_CONFIG.DEFAULT_PAGE_SIZE;
        const allMessages = state.currentMessages;
        let filtered: import('@xai/shared').Message[];

        if (req?.afterTimestamp) {
          filtered = allMessages.filter(m => m.timestamp > req.afterTimestamp!);
        } else if (req?.beforeTimestamp) {
          filtered = allMessages.filter(m => m.timestamp < req.beforeTimestamp!);
        } else {
          filtered = [...allMessages];
        }

        filtered.sort((a, b) => b.timestamp - a.timestamp);
        const sliced = filtered.slice(0, limit);
        const mobileMessages = sliced.map((m, i) => convertToMobileMessage(m, i));

        return {
          messages: mobileMessages,
          hasMore: filtered.length > limit,
        } as import('@xai/shared').GetMessagesData;
      }
      case 'get_confirmation': {
        return {
          confirmation: state.currentConfirmationRequest || null,
        } as import('@xai/shared').GetConfirmationData;
      }
      case 'get_workspace': {
        return {
          workspace: state.sessionConfig.workspace,
        } as import('@xai/shared').GetWorkspaceData;
      }
      case 'send_message': {
        const req = data as import('@xai/shared').SendMessageData;
        if (state.isAgentRunning) {
          return { success: false, isAgentRunning: true } as import('@xai/shared').SendMessageResponse;
        }
        if (!state.reactLoop) {
          const { initializeAgent } = await import('./agent/initialize.js');
          await initializeAgent(state);
        }
        if (!state.reactLoop) {
          return { success: false, isAgentRunning: false } as import('@xai/shared').SendMessageResponse;
        }
        state.isAgentRunning = true;
        const isFirst = state.isFirstMessageOfSession;
        if (isFirst) {
          state.firstAssistantMessage = '';
          await state.adapterManager.saveConversation(state.sessionConfig);
          state.isFirstMessageOfSession = false;
        }
        state.reactLoop.run(req.content, { isFirstMessageOfSession: isFirst }).catch(err => {
          console.error('[MqttBridge] Agent run error:', err);
        }).finally(() => {
          state.isAgentRunning = false;
        });
        return { success: true, isAgentRunning: true } as import('@xai/shared').SendMessageResponse;
      }
      case 'new_session': {
        state.adapterManager.resetCurrent(state.sessionConfig);
        state.isFirstMessageOfSession = true;
        state.titleGenerated = false;
        state.firstAssistantMessage = '';
        state.reactLoop = null;
        const { initializeAgent } = await import('./agent/initialize.js');
        await initializeAgent(state);
        return { success: true };
      }
      case 'abort': {
        state.reactLoop?.abort();
        return { success: true };
      }
      case 'confirm_response': {
        const req = data as import('@xai/shared').ConfirmResponseData;
        if (state.confirmationManager) {
          state.confirmationManager.respondConfirmation(req.response);
        }
        return { success: true };
      }
      case 'load_history': {
        const req = data as import('@xai/shared').LoadHistoryRequest;
        const result = await state.adapterManager.getConversationList(state.sessionConfig, req?.page ?? 1, req?.pageSize ?? 20);
        if (!result) throw new Error('Failed to load history');
        return { list: result.list } as import('@xai/shared').LoadHistoryData;
      }
      case 'load_conversation': {
        const req = data as import('@xai/shared').LoadConversationRequest;
        const dialogs = await state.adapterManager.getDialogList(state.sessionConfig, req.conversationId);
        if (!dialogs) throw new Error('Failed to load conversation');
        state.adapterManager.loadSession(state.sessionConfig, req.conversationId);
        state.isFirstMessageOfSession = false;
        state.titleGenerated = true; // Existing conversation, title already generated
        const msgs: import('@xai/shared').Message[] = [];
        for (const d of dialogs) {
          if (d.role === 'user') {
            msgs.push({ role: 'user', content: (d as any).query || d.content, timestamp: Date.now() });
          } else if (d.role === 'assistant') {
            msgs.push({ role: 'assistant', content: (d as any).answer || d.content, timestamp: Date.now() });
          }
        }
        const mobileMessages = msgs.map((m, i) => convertToMobileMessage(m, i));
        return { messages: mobileMessages } as import('@xai/shared').LoadConversationData;
      }
      case 'delete_conversation': {
        const req = data as import('@xai/shared').DeleteConversationRequest;
        const success = await state.adapterManager.deleteConversationById(state.sessionConfig, req.conversationId);
        return { success };
      }
      case 'open_workspace': {
        const { dialog } = await import('electron');
        const result = await dialog.showOpenDialog(state.mainWindow!, {
          properties: ['openDirectory'],
          title: '选择工作区目录'
        });
        if (!result.canceled && result.filePaths.length > 0) {
          state.sessionConfig.workspace = result.filePaths[0];
          const { configManager } = await import('./config.js');
          await configManager.saveConfig(state.sessionConfig);
          state.reactLoop = null;
          const { initTerminalSessionManager } = await import('./terminal-manager.js');
          initTerminalSessionManager(state);
          const { initializeAgent } = await import('./agent/initialize.js');
          await initializeAgent(state);
          state.sendToRenderer('workspace:changed', state.sessionConfig.workspace);
          return { success: true, workspace: state.sessionConfig.workspace };
        }
        return { success: false, workspace: state.sessionConfig.workspace };
      }
      default:
        throw new Error(`Unknown command: ${command}`);
    }
  });

  state.mqttBridge.setPairingStatusHandler((info: PairingStatusInfo) => {
    state.sendToRenderer('mqtt:pairing-status', info);
  });

  try {
    await state.mqttBridge.updateConfig(mqttConfig);
    if (mqttConfig.enabled) {
      state.mqttBridge.generatePairCode();
      state.logToRenderer('info', `MQTT Bridge started. Pair code: ${state.mqttBridge.getPairCode()}`);
    } else {
      state.logToRenderer('info', 'MQTT Bridge disabled in settings');
    }
  } catch (err) {
    state.logToRenderer('error', `MQTT Bridge start failed: ${String(err)}`);
  }
}
