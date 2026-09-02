/**
 * MQTT IPC handlers.
 */
import { ipcMain } from 'electron';
import type { IpcDeps } from './types.js';

export function registerMQTTHandlers(deps: IpcDeps): void {
  ipcMain.handle('mqtt:get-status', async () => {
    if (!deps.mqttBridge) return { isConnected: false, pairCode: '', pairedCount: 0, deviceId: '', enabled: false, brokerUrl: '' };
    return {
      isConnected: deps.mqttBridge.isConnected(),
      pairCode: deps.mqttBridge.getPairCode(),
      pairedCount: deps.mqttBridge.getPairedCount(),
      deviceId: deps.mqttBridge.getDeviceId(),
      enabled: deps.mqttBridge.isEnabled(),
      brokerUrl: deps.mqttBridge.getBrokerUrl(),
    };
  });

  ipcMain.handle('mqtt:generate-pair-code', async () => {
    if (!deps.mqttBridge) return '';
    return deps.mqttBridge.generatePairCode();
  });

  ipcMain.handle('mqtt:invalidate-pair-code', async () => {
    if (!deps.mqttBridge) return;
    deps.mqttBridge.invalidatePairCode();
  });

  ipcMain.handle('mqtt:update-config', async (_event, config: { brokerUrl: string; enabled: boolean }) => {
    if (!deps.mqttBridge) return;
    try {
      await deps.mqttBridge.updateConfig(config);
      return { success: true };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('mqtt:connect', async () => {
    if (!deps.mqttBridge) return { success: false, error: 'MQTT bridge not initialized' };
    try {
      if (!deps.mqttBridge.isEnabled()) {
        await deps.mqttBridge.updateConfig({ brokerUrl: deps.mqttBridge.getBrokerUrl(), enabled: true });
      }
      if (!deps.mqttBridge.isConnected()) {
        await deps.mqttBridge.start();
        deps.mqttBridge.generatePairCode();
      }
      return { success: true };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('mqtt:disconnect', async () => {
    if (!deps.mqttBridge) return { success: false, error: 'MQTT bridge not initialized' };
    try {
      await deps.mqttBridge.stop();
      return { success: true };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });
}
