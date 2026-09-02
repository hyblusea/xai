import { describe, it, expect, beforeAll } from 'vitest';
import { SqlExecuteTool } from './sql-execute-tool.js';

/**
 * 集成测试：验证 SqlExecuteTool 能通过 db-gateway 执行 SQL 并拿到原始结果。
 *
 * 依赖两个外部服务（不可达时自动 skip，不会破坏 CI）：
 *   1. db-gateway 运行在 http://localhost:8088（`mvn spring-boot:run` in db-gateway/）
 *   2. admin-server 的 MySQL 运行在 localhost:3306，库 xaidb（root/tradingx）
 *
 * 连接信息取自 admin-server/src/main/resources/application.properties。
 * 查询 ide_user 表（com.xai.admin.entity.IdeUser），避开 password_hash 敏感字段。
 */
describe('SqlExecuteTool (integration)', () => {
  const GATEWAY_URL = 'http://localhost:8088';
  const JDBC_URL =
    'jdbc:mysql://localhost:3306/xaidb?useUnicode=true&characterEncoding=utf8&serverTimezone=Asia/Shanghai&allowPublicKeyRetrieval=true&useSSL=false';
  const USERNAME = 'root';
  const PASSWORD = 'tradingx';

  let gatewayAvailable = false;

  beforeAll(async () => {
    // 探测 db-gateway 健康端点；不可达则跳过整个套件
    try {
      const res = await fetch(`${GATEWAY_URL}/api/db/health`, {
        signal: AbortSignal.timeout(3000),
      });
      gatewayAvailable = res.ok;
    } catch {
      gatewayAvailable = false;
    }
  });

  it('查询 ide_user 表并返回原始结果集', async ({ skip }) => {
    if (!gatewayAvailable) skip('db-gateway 未运行，跳过集成测试');

    const tool = new SqlExecuteTool(GATEWAY_URL);
    const result = await tool.execute({
      jdbcUrl: JDBC_URL,
      username: USERNAME,
      password: PASSWORD,
      sql: 'SELECT id, email, display_name, status, created_at FROM ide_user LIMIT 10',
    });

    // 工具层：success=true（db-gateway 返回 success:true 时）
    expect(result.toolName).toBe('sql_execute');
    expect(result.success).toBe(true);

    // output 是 db-gateway 的原始 JSON 响应
    const parsed = JSON.parse(result.output);
    expect(parsed.success).toBe(true);
    expect(parsed.message).toBe('查询成功');

    // 结果集校验：resultSet=true（Jackson 把 isXxx getter 序列化为 xxx），
    // columns 含期望字段
    const data = parsed.data;
    expect(data.resultSet).toBe(true);
    expect(data.columns).toEqual(
      expect.arrayContaining(['id', 'email', 'display_name', 'status', 'created_at']),
    );
    expect(Array.isArray(data.rows)).toBe(true);
    expect(data.rowCount).toBe(data.rows.length);

    // 不应返回 password_hash（SQL 里没查）
    expect(data.columns).not.toContain('password_hash');
  });

  it('错误 SQL 应返回失败结果（原始 error 信息）', async ({ skip }) => {
    if (!gatewayAvailable) skip('db-gateway 未运行，跳过集成测试');

    const tool = new SqlExecuteTool(GATEWAY_URL);
    const result = await tool.execute({
      jdbcUrl: JDBC_URL,
      username: USERNAME,
      password: PASSWORD,
      sql: 'SELECT * FROM this_table_does_not_exist_xyz',
    });

    // 工具层：SQL 执行失败 → fail（但仍把原始 JSON 放进 output）
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();

    const parsed = JSON.parse(result.output);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toBeTruthy(); // 例如 "Table 'xaidb.this_table_does_not_exist_xyz' doesn't exist"
  });

  /**
   * 非 SELECT SQL（DDL/DML）生命周期测试。
   * 用独立临时表走完 CREATE→INSERT→UPDATE→DELETE→DROP 全流程，完全不碰现有数据，
   * finally 兜底清理。验证每一步 AI 都能拿到原始的 success/message/resultSet/affectedRows。
   */
  it('非 SELECT SQL（DDL/DML）执行后返回原始 affectedRows', async ({ skip }) => {
    if (!gatewayAvailable) skip('db-gateway 未运行，跳过集成测试');

    const tool = new SqlExecuteTool(GATEWAY_URL);
    const TABLE = '_sql_exec_test_tmp';

    // 辅助：执行 SQL 并断言成功，返回解析后的原始 JSON
    const exec = async (sql: string) => {
      const r = await tool.execute({ jdbcUrl: JDBC_URL, username: USERNAME, password: PASSWORD, sql });
      expect(r.success, `SQL 应执行成功: ${sql}`).toBe(true);
      return JSON.parse(r.output);
    };

    try {
      // DDL: CREATE TABLE → 非结果集，affectedRows=0
      const created = await exec(`CREATE TABLE ${TABLE} (id INT, name VARCHAR(50))`);
      expect(created.success).toBe(true);
      expect(created.message).toBe('执行成功');
      expect(created.data.resultSet).toBe(false);
      expect(created.data.affectedRows).toBe(0);

      // DML: INSERT → affectedRows=1
      const inserted = await exec(`INSERT INTO ${TABLE} (id, name) VALUES (1, 'test')`);
      expect(inserted.data.resultSet).toBe(false);
      expect(inserted.data.affectedRows).toBe(1);

      // DML: UPDATE → affectedRows=1
      const updated = await exec(`UPDATE ${TABLE} SET name='updated' WHERE id=1`);
      expect(updated.data.resultSet).toBe(false);
      expect(updated.data.affectedRows).toBe(1);

      // DML: DELETE → affectedRows=1
      const deleted = await exec(`DELETE FROM ${TABLE} WHERE id=1`);
      expect(deleted.data.resultSet).toBe(false);
      expect(deleted.data.affectedRows).toBe(1);

      // DDL: DROP TABLE → 非结果集
      const dropped = await exec(`DROP TABLE ${TABLE}`);
      expect(dropped.data.resultSet).toBe(false);
    } finally {
      // 兜底清理：即使中途断言失败也尝试删除临时表，不留痕迹
      try {
        await tool.execute({ jdbcUrl: JDBC_URL, username: USERNAME, password: PASSWORD, sql: `DROP TABLE IF EXISTS ${TABLE}` });
      } catch { /* ignore */ }
    }
  });
});
