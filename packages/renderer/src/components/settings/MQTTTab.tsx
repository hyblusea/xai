import { useState, useEffect } from 'react';
import { Power, PowerOff, Loader2, Plug } from 'lucide-react';
import type { SessionConfig } from '@xai/shared';

interface MQTTTabProps {
  config: SessionConfig;
  setConfig: React.Dispatch<React.SetStateAction<SessionConfig | null>>;
}

export default function MQTTTab({ config, setConfig }: MQTTTabProps) {
  const [mqttStatus, setMqttStatus] = useState<{ isConnected: boolean; pairCode: string; pairedCount: number; enabled: boolean; brokerUrl: string }>({
    isConnected: false, pairCode: '', pairedCount: 0, enabled: true, brokerUrl: '',
  });
  const [mqttConnecting, setMqttConnecting] = useState(false);

  const loadMqttStatus = async () => {
    try {
      const status = await window.electronAPI.invoke('mqtt:get-status') as { isConnected: boolean; pairCode: string; pairedCount: number; enabled: boolean; brokerUrl: string };
      setMqttStatus(status);
    } catch {}
  };

  useEffect(() => { loadMqttStatus(); }, []);

  return (
    <div className="settings-tab-content">
      <h3 className="settings-section-title">MQTT / Mobile Connection</h3>
      <span className="settings-hint">
        Configure MQTT broker for mobile app communication. Changes take effect immediately without restart.
      </span>

      <div className="settings-field">
        <label className="settings-label">Enable MQTT</label>
        <div className="settings-mqtt-toggle-row">
          <button
            className={`settings-mqtt-toggle ${config.mqtt?.enabled !== false ? 'toggle-on' : 'toggle-off'}`}
            onClick={async () => {
              const newEnabled = config.mqtt?.enabled === false ? true : false;
              const newMqtt = { ...(config.mqtt || { brokerUrl: 'ws://broker.emqx.io:8083/mqtt', enabled: true }), enabled: newEnabled };
              setConfig(prev => prev ? { ...prev, mqtt: newMqtt } : prev);
              try {
                await window.electronAPI.invoke('mqtt:update-config', newMqtt);
                await loadMqttStatus();
              } catch {}
            }}
          >
            {config.mqtt?.enabled !== false ? <Power size={14} /> : <PowerOff size={14} />}
            {config.mqtt?.enabled !== false ? 'Enabled' : 'Disabled'}
          </button>
          {config.mqtt?.enabled !== false && (
            <>
              {!mqttStatus.isConnected ? (
                <button
                  className="settings-mqtt-toggle toggle-connect"
                  disabled={mqttConnecting}
                  onClick={async () => {
                    setMqttConnecting(true);
                    try {
                      await window.electronAPI.invoke('mqtt:connect');
                      await loadMqttStatus();
                    } catch {} finally {
                      setMqttConnecting(false);
                    }
                  }}
                >
                  {mqttConnecting ? <Loader2 size={14} className="spin" /> : <Plug size={14} />}
                  {mqttConnecting ? 'Connecting...' : 'Connect'}
                </button>
              ) : (
                <button
                  className="settings-mqtt-toggle toggle-disconnect"
                  disabled={mqttConnecting}
                  onClick={async () => {
                    setMqttConnecting(true);
                    try {
                      await window.electronAPI.invoke('mqtt:disconnect');
                      await loadMqttStatus();
                    } catch {} finally {
                      setMqttConnecting(false);
                    }
                  }}
                >
                  {mqttConnecting ? <Loader2 size={14} className="spin" /> : <PowerOff size={14} />}
                  {mqttConnecting ? 'Disconnecting...' : 'Disconnect'}
                </button>
              )}
            </>
          )}
        </div>
      </div>

      <div className="settings-field">
        <label className="settings-label">Broker URL <span className="settings-label-hint">(WebSocket)</span></label>
        <input
          className="settings-input"
          type="text"
          value={config.mqtt?.brokerUrl || ''}
          onChange={e => {
            setConfig(prev => prev ? {
              ...prev,
              mqtt: { ...(prev.mqtt || { enabled: true }), brokerUrl: e.target.value }
            } : prev);
          }}
          placeholder="ws://broker.emqx.io:8083/mqtt"
        />
        <span className="settings-hint">
          Common free brokers:<br />
          • <code>ws://broker.emqx.io:8083/mqtt</code> — EMQX Public (recommended)<br />
          • <code>ws://broker.hivemq.com:8000/mqtt</code> — HiveMQ Public<br />
          • <code>ws://test.mosquitto.org:8080</code> — Mosquitto Test
        </span>
      </div>

      <div className="settings-mqtt-status-card">
        <div className="settings-mqtt-status-header">Connection Status</div>
        <div className="settings-mqtt-status-row">
          <span className="settings-mqtt-status-label">Status</span>
          <span className={`settings-mqtt-status-value ${config.mqtt?.enabled === false ? 'status-disconnected' : (mqttStatus.isConnected ? 'status-connected' : 'status-disconnected')}`}>
            <span className="settings-mqtt-dot" />
            {config.mqtt?.enabled === false ? 'Disabled' : (mqttStatus.isConnected ? 'Connected' : 'Disconnected')}
          </span>
        </div>
        <div className="settings-mqtt-status-row">
          <span className="settings-mqtt-status-label">Broker</span>
          <span className="settings-mqtt-status-value settings-mqtt-mono">{mqttStatus.brokerUrl || '-'}</span>
        </div>
        <div className="settings-mqtt-status-row">
          <span className="settings-mqtt-status-label">Pair Code</span>
          <span className="settings-mqtt-status-value settings-mqtt-pair-code">
            {mqttStatus.pairCode ? mqttStatus.pairCode.replace(/(.{3})/g, '$1 ').trim() : '------'}
          </span>
        </div>
        <div className="settings-mqtt-status-row">
          <span className="settings-mqtt-status-label">Paired Devices</span>
          <span className="settings-mqtt-status-value">{mqttStatus.pairedCount}</span>
        </div>
      </div>
    </div>
  );
}
