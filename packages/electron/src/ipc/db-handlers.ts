/**
 * Database IPC handlers.
 */
import { ipcMain, app } from 'electron';
import path from 'path';
import fs from 'fs/promises';
import type { IpcDeps } from './types.js';

const DB_CONFIG_FILE_NAME = 'xai-db-connections.json';
const DB_GATEWAY_URL = 'http://localhost:8088';

let dbConfigPath: string;
let dbQueryAbortController: AbortController | null = null;

export function registerDBHandlers(deps: IpcDeps): void {
  ipcMain.handle('db:load-config', async () => {
    if (!dbConfigPath) {
      dbConfigPath = path.join(app.getPath('userData'), DB_CONFIG_FILE_NAME);
    }
    try {
      const data = await fs.readFile(dbConfigPath, 'utf-8');
      return JSON.parse(data);
    } catch {
      return [];
    }
  });

  ipcMain.handle('db:save-config', async (_event, connections: unknown) => {
    if (!dbConfigPath) {
      dbConfigPath = path.join(app.getPath('userData'), DB_CONFIG_FILE_NAME);
    }
    try {
      await fs.mkdir(path.dirname(dbConfigPath), { recursive: true });
      await fs.writeFile(dbConfigPath, JSON.stringify(connections, null, 2), 'utf-8');
      return { success: true };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('db:list-schemas', async (_event, params: { jdbcUrl: string; username: string; password: string; dbType: string }) => {
    try {
      const response = await fetch(`${DB_GATEWAY_URL}/api/db/metadata/schemas`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      });
      return await response.json();
    } catch (err) {
      return { success: false, message: '无法连接到数据库网关服务', error: String(err) };
    }
  });

  ipcMain.handle('db:list-tables', async (_event, params: { jdbcUrl: string; username: string; password: string; dbType: string; schema: string }) => {
    try {
      const response = await fetch(`${DB_GATEWAY_URL}/api/db/metadata/tables`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      });
      return await response.json();
    } catch (err) {
      return { success: false, message: '无法连接到数据库网关服务', error: String(err) };
    }
  });

  ipcMain.handle('db:generate-sql', async (_event, params: { dbType: string; tableName: string; schema?: string; limit?: number }) => {
    try {
      const response = await fetch(`${DB_GATEWAY_URL}/api/db/generate-sql`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      });
      return await response.json();
    } catch (err) {
      return { success: false, message: '无法连接到数据库网关服务', error: String(err) };
    }
  });

  ipcMain.handle('db:table-structure', async (_event, params: { jdbcUrl: string; username: string; password: string; dbType: string; schema: string; tableName: string }) => {
    try {
      const response = await fetch(`${DB_GATEWAY_URL}/api/db/metadata/table-structure`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      });
      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        console.error(`[db:table-structure] HTTP ${response.status}:`, errorText);
        return { success: false, message: `数据库网关返回错误 (HTTP ${response.status})`, error: errorText };
      }
      return await response.json();
    } catch (err) {
      console.error('[db:table-structure] 请求失败:', err);
      return { success: false, message: '无法连接到数据库网关服务', error: String(err) };
    }
  });

  ipcMain.handle('db:table-ddl', async (_event, params: { jdbcUrl: string; username: string; password: string; dbType: string; schema: string; tableName: string }) => {
    try {
      const response = await fetch(`${DB_GATEWAY_URL}/api/db/metadata/table-ddl`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      });
      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        console.error(`[db:table-ddl] HTTP ${response.status}:`, errorText);
        return { success: false, message: `数据库网关返回错误 (HTTP ${response.status})`, error: errorText };
      }
      return await response.json();
    } catch (err) {
      console.error('[db:table-ddl] 请求失败:', err);
      return { success: false, message: '无法连接到数据库网关服务', error: String(err) };
    }
  });

  ipcMain.handle('db:execute-sql', async (_event, params: { jdbcUrl: string; username: string; password: string; dbType: string; schema?: string; sql: string; readOnly?: boolean; timeout?: number; maxRows?: number }) => {
    if (dbQueryAbortController) {
      dbQueryAbortController.abort();
    }
    const abortController = new AbortController();
    dbQueryAbortController = abortController;

    try {
      const response = await fetch(`${DB_GATEWAY_URL}/api/db/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jdbcUrl: params.jdbcUrl,
          username: params.username,
          password: params.password,
          sql: params.sql,
          readOnly: params.readOnly ?? true,
          timeout: params.timeout,
          maxRows: params.maxRows,
          schema: params.schema,
          dbType: params.dbType,
        }),
        signal: abortController.signal,
      });
      const result = await response.json();
      if (dbQueryAbortController === abortController) {
        dbQueryAbortController = null;
      }
      return result;
    } catch (err: any) {
      if (dbQueryAbortController === abortController) {
        dbQueryAbortController = null;
      }
      if (err.name === 'AbortError') {
        return { success: false, message: '查询已取消', error: 'QUERY_CANCELLED' };
      }
      return { success: false, message: '无法连接到数据库网关服务', error: String(err) };
    }
  });

  ipcMain.handle('db:cancel-sql', async () => {
    if (dbQueryAbortController) {
      dbQueryAbortController.abort();
      dbQueryAbortController = null;
      return { success: true };
    }
    return { success: false, message: '没有正在执行的查询' };
  });

  ipcMain.handle('db:export', async (_event, params: { jdbcUrl: string; username: string; password: string; dbType: string; schema?: string; sql: string; format: string; tableName?: string; timeout?: number; maxRows?: number }) => {
    try {
      const response = await fetch(`${DB_GATEWAY_URL}/api/db/export`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      });
      return await response.json();
    } catch (err) {
      return { success: false, message: '无法连接到数据库网关服务', error: String(err) };
    }
  });

  ipcMain.handle('db:import', async (_event, params: { jdbcUrl: string; username: string; password: string; dbType: string; schema?: string; sqlScript: string; batchSize?: number; inTransaction?: boolean }) => {
    try {
      const response = await fetch(`${DB_GATEWAY_URL}/api/db/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      });
      return await response.json();
    } catch (err) {
      return { success: false, message: '无法连接到数据库网关服务', error: String(err) };
    }
  });
}
