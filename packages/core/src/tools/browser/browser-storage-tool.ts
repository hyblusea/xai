import { ToolDefinition } from '@xai/shared';
import { BrowserBaseTool } from './browser-base-tool.js';

export class BrowserStorageTool extends BrowserBaseTool {
  get definition(): ToolDefinition {
    return {
      name: 'browser_storage',
      description: 'Access localStorage, sessionStorage, cookies. Actions: get, set, remove, list.',
      parameters: {
        sessionId: { type: 'string', description: 'Browser session ID', required: true, location: 'header' },
        storageType: { type: 'string', description: 'Type: localStorage, sessionStorage, cookie', required: true, location: 'header' },
        action: { type: 'string', description: 'Action: list, get, set, remove', required: true, location: 'header' },
        key: { type: 'string', description: 'Key (required for get/set/remove)', required: false, location: 'header' },
        value: { type: 'string', description: 'Value (required for set)', required: false, location: 'header' },
      },
      confirmationRequired: false,
      examples: [
        `++++ browser_storage sessionId:br-abc123 storageType:localStorage action:set key:theme value:dark
++++ end`,
      ],
    };
  }

  async _execute(params: Record<string, unknown>, _signal?: AbortSignal) {
    const start = Date.now();
    try {
      const sessionId = params.sessionId as string;
      const storageType = params.storageType as string;
      const action = params.action as string;
      const key = params.key as string | undefined;
      const value = params.value as string | undefined;

      if (!sessionId || !storageType || !action) {
        return this.fail('sessionId, storageType, and action parameters are required', Date.now() - start);
      }
      if (!['localStorage', 'sessionStorage', 'cookie'].includes(storageType)) {
        return this.fail('storageType must be localStorage, sessionStorage, or cookie', Date.now() - start);
      }
      if (!['list', 'get', 'set', 'remove'].includes(action)) {
        return this.fail('action must be list, get, set, or remove', Date.now() - start);
      }
      if ((action === 'get' || action === 'set' || action === 'remove') && !key) {
        return this.fail(`key is required for action: ${action}`, Date.now() - start);
      }
      if (action === 'set' && value === undefined) {
        return this.fail('value is required for action: set', Date.now() - start);
      }

      const result = await this.invokeIPC<{ data?: unknown }>('browser:storage', {
        sessionId, storageType, action, key, value,
      });

      const output = typeof result.data === 'string'
        ? result.data
        : JSON.stringify(result.data, null, 2);

      return this.success(`${storageType} ${action}${key ? ` ${key}` : ''}:\n${output}`, Date.now() - start);
    } catch (error) {
      return this.fail(`browser_storage failed: ${error instanceof Error ? error.message : String(error)}`, Date.now() - start);
    }
  }
}
