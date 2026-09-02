import { BaseTool } from '../base-tool.js';
import type { ToolDefinition, ToolResult } from '@xai/shared';

/**
 * Parameters sent to db-gateway's POST /api/db/execute. Only the four
 * required fields are mandated by this tool; timeout/maxRows are optional
 * pass-throughs. dbType/schema are intentionally not exposed — the user
 * spec is jdbcUrl + username + password + sql only.
 */
interface SqlExecuteParams {
  jdbcUrl: string;
  username: string;
  password: string;
  sql: string;
  timeout?: number;
  maxRows?: number;
}

/** Mirrors com.xai.dbgateway.dto.ExecuteSqlResponse.QueryResult.
 *  NOTE: Jackson serializes the boolean `isResultSet` getter as `resultSet`
 *  (strips the `is` prefix), so the wire field is `resultSet`, not `isResultSet`. */
interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  affectedRows: number;
  resultSet: boolean;
  warnings: string[] | null;
}

/** Mirrors com.xai.dbgateway.dto.ExecuteSqlResponse. */
interface ExecuteSqlResponse {
  success: boolean;
  message: string;
  data: QueryResult;
  executionTimeMs: number;
  error?: string;
}

/**
 * SQL execution tool. Calls db-gateway's existing `/api/db/execute`
 * endpoint with a JDBC connection string + credentials + SQL, and returns
 * the *raw* db-gateway JSON response to the AI.
 *
 * Returning the raw response (rather than a reformatted markdown table) is
 * deliberate: for non-SELECT statements such as CREATE USER, GRANT, or
 * CREATE INDEX there is no result set, and the AI must still see the full
 * execution outcome — success flag, message, affectedRows, executionTimeMs,
 * and any error — to decide the next step.
 *
 * Wire field names (Jackson-serialized, verified against the live service):
 *   success, message, data{columns,rows,rowCount,affectedRows,resultSet,warnings},
 *   executionTimeMs, error. Note `resultSet` (not `isResultSet`) and
 *   `warnings` is null on success.
 */
export class SqlExecuteTool extends BaseTool {
  private baseUrl: string;

  constructor(baseUrl: string = 'http://localhost:8088') {
    super();
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  get definition(): ToolDefinition {
    return {
      name: 'sql_execute',
      description:
        '通过 JDBC 连接数据库并执行 SQL 语句（支持达梦、MySQL、Oracle、SQL Server、PostgreSQL 等）。' +
        '可执行 SELECT、DDL、DML、DCL等任意 SQL。' +
        '返回结果，包含执行状态(success)、消息(message)、是否为结果集(isResultSet)、' +
        '影响行数(affectedRows)、结果集列(columns)与行(rows)、执行耗时(executionTimeMs)及错误信息(error)。',
      parameters: {
        jdbcUrl: {
          type: 'string',
          description: 'JDBC 连接串，例如：jdbc:dm://localhost:5236',
          required: true,
          location: 'header',
        },
        username: {
          type: 'string',
          description: '数据库用户名',
          required: true,
          location: 'header',
        },
        password: {
          type: 'string',
          description: '数据库密码',
          required: true,
          location: 'header',
        },
        sql: {
          type: 'string',
          description: '要执行的 SQL 语句',
          required: true,
          location: 'body',
        },
        timeout: {
          type: 'number',
          description: '超时时间毫秒,默认30000',
          required: false,
          location: 'header',
        },
        maxRows: {
          type: 'number',
          description: '最大返回行数(仅对 SELECT 有效),默认10000',
          required: false,
          location: 'header',
        },
      },
      confirmationRequired: true,
      contentMode: 'native',
      examples: [
        `++++ sql_execute jdbcUrl:jdbc:dm://localhost:5236 username:SYSDBA password:SYSDBA001
CREATE USER "test_user" IDENTIFIED BY "Pwd123456";
++++ end`
      ],
    };
  }

  async _execute(params: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
    const startTime = Date.now();

    // Required-param validation. The default parser already rejects missing
    // required params, but this tool can be invoked via native function
    // calling too, so guard explicitly.
    const jdbcUrl = params.jdbcUrl;
    const username = params.username;
    const password = params.password;
    const sql = params.sql;

    if (typeof jdbcUrl !== 'string' || !jdbcUrl ||
        typeof username !== 'string' || !username ||
        typeof password !== 'string' || !password ||
        typeof sql !== 'string' || !sql) {
      return this.fail(
        'Missing required parameter(s): jdbcUrl, username, password, sql are all required',
        Date.now() - startTime,
      );
    }

    const body: SqlExecuteParams = { jdbcUrl, username, password, sql };
    if (typeof params.timeout === 'number') body.timeout = params.timeout;
    if (typeof params.maxRows === 'number') body.maxRows = params.maxRows;

    try {
      const response = await fetch(`${this.baseUrl}/api/db/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      });

      const executionTime = Date.now() - startTime;

      if (!response.ok) {
        // HTTP-level failure (db-gateway down, 5xx, etc.). Surface status +
        // whatever body came back so the AI can diagnose.
        let errBody = '';
        try { errBody = await response.text(); } catch { /* ignore */ }
        const detail = errBody ? ` - ${errBody.slice(0, 1000)}` : '';
        return this.fail(
          `db-gateway HTTP ${response.status} ${response.statusText}${detail}`,
          executionTime,
        );
      }

      // Parse the JSON response. If parsing fails, return the raw text so
      // the AI isn't left with nothing.
      const rawText = await response.text();
      let result: ExecuteSqlResponse;
      try {
        result = JSON.parse(rawText) as ExecuteSqlResponse;
      } catch {
        return this.fail(
          `db-gateway returned non-JSON response: ${rawText.slice(0, 2000)}`,
          executionTime,
        );
      }

      // Return the raw execution result as JSON. This is the contract: the
      // AI gets the complete, unmodified db-gateway response. For
      // success:false (SQL failed, e.g. ORA-01031 insufficient privileges),
      // we still emit the JSON as output but mark the tool result as failed
      // so the AI knows the SQL did not succeed.
      const output = JSON.stringify(result, null, 2);
      if (result.success) {
        return this.success(output, executionTime);
      }
      return this.fail(output, executionTime);
    } catch (error) {
      const executionTime = Date.now() - startTime;
      const message = error instanceof Error ? error.message : String(error);
      // fetch throws a TypeError with "aborted" when the AbortSignal fires;
      // surface aborts cleanly.
      if (error instanceof Error && error.name === 'AbortError') {
        return this.fail('SQL execution aborted', executionTime);
      }
      return this.fail(`Failed to call db-gateway: ${message}`, executionTime);
    }
  }
}
