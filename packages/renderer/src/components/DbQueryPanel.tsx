import { useState, useEffect, useCallback, useRef } from 'react';
import Editor, { OnMount, BeforeMount } from '@monaco-editor/react';
type MonacoEditor = Parameters<OnMount>[0];
type MonacoInstance = Parameters<OnMount>[1];
import { Play, Loader2, AlertCircle, Check, Columns3, RefreshCw, Download, Paintbrush, Upload, X } from 'lucide-react';
import { Parser, AST } from 'node-sql-parser';

interface DbQueryPanelProps {
  sql: string;
  connName: string;
  connId: string;
  dbType: string;
  jdbcUrl: string;
  username: string;
  password: string;
  schema: string;
  isModified?: boolean;
  isTableStructure?: boolean;
  tableName?: string;
  onSqlChange?: (sql: string) => void;
  initialResult?: DisplayResult | null;
  onResultChange?: (result: DisplayResult | null) => void;
}

// Matches db-gateway ExecuteSqlResponse format
interface ExecuteSqlResponse {
  success: boolean;
  message?: string;
  error?: string;
  executionTimeMs?: number;
  data?: {
    columns?: string[];
    rows?: Record<string, unknown>[];
    rowCount?: number;
    affectedRows?: number;
    isResultSet?: boolean;
  };
}

// Matches db-gateway TableStructureResponse format
interface TableStructureResponse {
  success: boolean;
  message?: string;
  error?: string;
  tableName?: string;
  tableComment?: string;
  columns?: Array<{
    name: string;
    type: string;
    nullable: string;
    primaryKey: boolean;
    defaultValue?: string;
    comment?: string;
  }>;
}

export interface DisplayResult {
  success: boolean;
  columns: string[];
  rows: string[][];
  rowCount: number;
  executionTime: number;
  error?: string;
  message?: string;
}

// SQL keywords for auto-completion
const SQL_KEYWORDS = [
  'SELECT', 'FROM', 'WHERE', 'INSERT', 'INTO', 'VALUES', 'UPDATE', 'SET',
  'DELETE', 'CREATE', 'TABLE', 'DROP', 'ALTER', 'ADD', 'COLUMN', 'INDEX',
  'VIEW', 'JOIN', 'INNER', 'LEFT', 'RIGHT', 'OUTER', 'CROSS', 'FULL',
  'ON', 'AND', 'OR', 'NOT', 'IN', 'BETWEEN', 'LIKE', 'IS', 'NULL',
  'AS', 'ORDER', 'BY', 'GROUP', 'HAVING', 'LIMIT', 'OFFSET',
  'UNION', 'ALL', 'DISTINCT', 'EXISTS', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END',
  'ASC', 'DESC', 'COUNT', 'SUM', 'AVG', 'MIN', 'MAX',
  'PRIMARY', 'KEY', 'FOREIGN', 'REFERENCES', 'CONSTRAINT',
  'DEFAULT', 'CHECK', 'UNIQUE', 'AUTO_INCREMENT', 'SERIAL',
  'BEGIN', 'COMMIT', 'ROLLBACK', 'TRANSACTION',
  'GRANT', 'REVOKE', 'IF', 'EXISTS', 'REPLACE',
  'TRUNCATE', 'EXPLAIN', 'ANALYZE', 'SHOW', 'DESCRIBE', 'USE',
  'WITH', 'RECURSIVE', 'OVER', 'PARTITION', 'ROW_NUMBER', 'RANK',
  'DENSE_RANK', 'LAG', 'LEAD', 'FIRST_VALUE', 'LAST_VALUE',
  'COALESCE', 'CAST', 'CONVERT', 'NULLIF', 'ISNULL', 'IFNULL',
  'TRUE', 'FALSE', 'BOOLEAN', 'INTEGER', 'BIGINT', 'SMALLINT',
  'FLOAT', 'DOUBLE', 'DECIMAL', 'NUMERIC', 'VARCHAR', 'CHAR',
  'TEXT', 'BLOB', 'DATE', 'TIME', 'DATETIME', 'TIMESTAMP',
  'INTERVAL', 'RETURN', 'RETURNS', 'FUNCTION', 'PROCEDURE',
  'TRIGGER', 'AFTER', 'BEFORE', 'INSTEAD', 'EXECUTE',
];

// 将 dbType 映射为 node-sql-parser 支持的数据库选项
function getParserDbType(dbType: string): string {
  switch (dbType?.toLowerCase()) {
    case 'mysql': return 'MySQL';
    case 'postgresql': return 'Postgresql';
    case 'sqlserver': return 'TransactSQL';
    case 'sqlite': return 'Sqlite';
    case 'oracle': return 'Oracle';
    case 'dm': return 'MySQL'; // 达梦暂用 MySQL 方言解析
    default: return 'MySQL';
  }
}

// 从 AST 中提取别名→真实表名的映射
// aliasMap: { alias: tableName }  例如 { u: 'app_user' }
// tableNames: 所有引用到的真实表名列表（去重）
function extractAliasFromAst(ast: AST | AST[]): { aliasMap: Record<string, string>; tableNames: string[] } {
  const aliasMap: Record<string, string> = {};
  const tableNames: string[] = [];
  const seen = new Set<string>();

  function walk(node: any) {
    if (!node || typeof node !== 'object') return;

    // 处理 FROM 子句中的表引用
    if (Array.isArray(node.from)) {
      for (const item of node.from) {
        if (item.table) {
          // 真实表名
          const tbl = String(item.table);
          // schema/db 前缀
          const db = item.db ? String(item.db) : null;
          const qualifiedName = db ? `${db}.${tbl}` : tbl;

          if (!seen.has(qualifiedName)) {
            seen.add(qualifiedName);
            tableNames.push(qualifiedName);
          }

          // 如果有别名，记录映射
          if (item.as) {
            aliasMap[String(item.as)] = qualifiedName;
          } else {
            // 没有别名时，表名本身也可作为前缀
            // 同时也把不带 schema 的表名映射到完整名
            aliasMap[tbl] = qualifiedName;
            if (db) {
              aliasMap[`${db}.${tbl}`] = qualifiedName;
            }
          }
        }
        // JOIN 的表也在 from 数组中，格式相同
        // 处理子查询 (type: 'subquery')
        if (item.expr) {
          walk(item.expr);
        }
      }
    }

    // 处理 UNION: ast 是数组
    if (Array.isArray(node)) {
      for (const item of node) {
        walk(item);
      }
    }

    // 递归处理子查询和其他嵌套结构
    for (const key of Object.keys(node)) {
      if (key === 'from') continue; // 已处理
      const val = node[key];
      if (val && typeof val === 'object') {
        if (Array.isArray(val)) {
          for (const item of val) {
            if (item && typeof item === 'object') walk(item);
          }
        } else {
          walk(val);
        }
      }
    }
  }

  const asts = Array.isArray(ast) ? ast : [ast];
  for (const a of asts) {
    walk(a);
  }

  return { aliasMap, tableNames };
}

// 列信息缓存（含类型和注释）
interface ColumnDetail {
  name: string;
  type: string;
  comment: string;
  primaryKey: boolean;
}

// 从完整 SQL 文本中提取光标所在的当前语句（按 ; 分割）
// 避免解析整个大文件，只解析当前正在编辑的语句
const MAX_STATEMENT_LENGTH = 50000; // 单条语句最大解析长度，防止超长语句卡顿
function extractCurrentStatement(fullSql: string, cursorOffset: number): string {
  // 按分号分割语句，找到光标所在的那条
  let start = 0;
  let end = fullSql.length;

  // 向前找语句起始位置（上一个 ; 之后）
  for (let i = cursorOffset - 1; i >= 0; i--) {
    if (fullSql[i] === ';') {
      start = i + 1;
      break;
    }
  }

  // 向后找语句结束位置（下一个 ; 之前）
  for (let i = cursorOffset; i < fullSql.length; i++) {
    if (fullSql[i] === ';') {
      end = i;
      break;
    }
  }

  let statement = fullSql.substring(start, end).trim();

  // 超长语句截断保护：只取光标前后一定范围
  if (statement.length > MAX_STATEMENT_LENGTH) {
    const relativeOffset = cursorOffset - start;
    const halfMax = MAX_STATEMENT_LENGTH / 2;
    const truncStart = Math.max(0, relativeOffset - halfMax);
    const truncEnd = Math.min(statement.length, relativeOffset + halfMax);
    statement = statement.substring(truncStart, truncEnd);
  }

  return statement;
}

// File download helper
const downloadFile = (content: string, fileName: string, isBase64 = false) => {
  const link = document.createElement('a');
  if (isBase64) {
    link.href = `data:application/octet-stream;base64,${content}`;
  } else {
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    link.href = URL.createObjectURL(blob);
  }
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
};

// Extract table name from SQL using node-sql-parser
const extractTableNameFromSql = (sqlStr: string): string => {
  try {
    const parser = new Parser();
    const ast = parser.astify(sqlStr);
    const asts = Array.isArray(ast) ? ast : [ast];
    for (const node of asts) {
      const n = node as any;
      if (n.from && Array.isArray(n.from) && n.from.length > 0) {
        const firstFrom = n.from[0];
        if (firstFrom.table) {
          return String(firstFrom.table);
        }
      }
    }
    return '';
  } catch {
    return '';
  }
};

// Simple SQL formatter
const formatSql = (input: string): string => {
  if (!input.trim()) return input;

  const newLineKeywords = [
    'SELECT', 'FROM', 'WHERE', 'INNER JOIN', 'LEFT JOIN', 'RIGHT JOIN',
    'CROSS JOIN', 'FULL JOIN', 'JOIN', 'ON', 'AND', 'OR',
    'ORDER BY', 'GROUP BY', 'HAVING', 'LIMIT', 'OFFSET',
    'UNION', 'UNION ALL', 'INSERT INTO', 'VALUES', 'UPDATE', 'SET',
    'DELETE FROM', 'CREATE TABLE', 'INTO'
  ];

  let formatted = input;

  // Normalize whitespace
  formatted = formatted.replace(/\s+/g, ' ');

  // Add newlines before major keywords (reverse order of length to avoid partial matches)
  const sortedKeywords = [...newLineKeywords].sort((a, b) => b.length - a.length);

  for (const keyword of sortedKeywords) {
    const regex = new RegExp(`\\b(${keyword})\\b`, 'gi');
    formatted = formatted.replace(regex, `\n${keyword.toUpperCase()}`);
  }

  // Clean up leading newline
  formatted = formatted.replace(/^\n/, '');

  // Indent sub-clauses
  const lines = formatted.split('\n');
  const indentedLines: string[] = [];
  let indentLevel = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const upperLine = trimmed.toUpperCase();

    // Decrease indent for closing keywords
    if (upperLine.startsWith('FROM') || upperLine.startsWith('WHERE') ||
        upperLine.startsWith('ORDER BY') || upperLine.startsWith('GROUP BY') ||
        upperLine.startsWith('HAVING') || upperLine.startsWith('LIMIT') ||
        upperLine.startsWith('UNION')) {
      indentLevel = Math.max(0, indentLevel - 1);
    }

    indentedLines.push('  '.repeat(indentLevel) + trimmed);

    // Increase indent after opening keywords
    if (upperLine.startsWith('SELECT') || upperLine.startsWith('FROM') ||
        upperLine.startsWith('WHERE') || upperLine.startsWith('JOIN') ||
        upperLine.startsWith('INNER JOIN') || upperLine.startsWith('LEFT JOIN') ||
        upperLine.startsWith('RIGHT JOIN')) {
      indentLevel++;
    }
  }

  return indentedLines.join('\n');
};

export default function DbQueryPanel({
  sql: initialSql,
  connName,
  connId,
  dbType,
  jdbcUrl,
  username,
  password,
  schema,
  isModified,
  isTableStructure,
  tableName,
  onSqlChange,
  initialResult,
  onResultChange,
}: DbQueryPanelProps) {
  const [sql, setSql] = useState(initialSql);
  const [result, setResult] = useState<DisplayResult | null>(initialResult ?? null);
  const [isExecuting, setIsExecuting] = useState(false);
  const [autoExecuted, setAutoExecuted] = useState(!!initialResult);
  const [showExportMenu, setShowExportMenu] = useState(false);
  const [showImportDialog, setShowImportDialog] = useState(false);
  const [importScript, setImportScript] = useState('');
  const [isImporting, setIsImporting] = useState(false);
  const editorRef = useRef<MonacoEditor | null>(null);
  const monacoRef = useRef<MonacoInstance | null>(null);
  const exportMenuRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const sqlAreaRef = useRef<HTMLDivElement | null>(null);
  const [sqlAreaHeight, setSqlAreaHeight] = useState<number | null>(null);
  const isDraggingRef = useRef(false);
  const startYRef = useRef(0);
  const startHeightRef = useRef(0);
  // Schema metadata for auto-completion
  const schemaTablesRef = useRef<string[]>([]);
  const tableColumnsRef = useRef<Record<string, ColumnDetail[]>>({});
  const schemaLoadedRef = useRef(false);
  // 解析缓存：避免每次补全都重新解析
  const parsedCacheRef = useRef<{ sql: string; aliasMap: Record<string, string>; tableNames: string[] } | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  // Cleanup abort controller on unmount
  useEffect(() => {
    return () => {
      abortControllerRef.current?.abort();
    };
  }, []);

  // Resize handle drag logic
  const handleResizeMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isDraggingRef.current = true;
    startYRef.current = e.clientY;
    startHeightRef.current = sqlAreaRef.current?.getBoundingClientRect().height ?? 0;
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';

    const handleMouseMove = (ev: MouseEvent) => {
      if (!isDraggingRef.current) return;
      const dy = ev.clientY - startYRef.current;
      const panelHeight = panelRef.current?.getBoundingClientRect().height ?? 0;
      const newHeight = Math.max(80, Math.min(panelHeight - 80, startHeightRef.current + dy));
      setSqlAreaHeight(newHeight);
    };

    const handleMouseUp = () => {
      isDraggingRef.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, []);

  // Fetch schema metadata (table names) for auto-completion
  const loadSchemaMetadata = useCallback(async () => {
    if (schemaLoadedRef.current) return;
    try {
      const result = await window.electronAPI.invoke('db:list-tables', {
        jdbcUrl, username, password, dbType, schema,
      }) as { success: boolean; tables?: Array<{ name: string; type: string; comment: string }>; error?: string };
      if (result.success && result.tables) {
        schemaTablesRef.current = [...new Set(result.tables.map(t => t.name))];
        schemaLoadedRef.current = true;
      }
    } catch {
      // Silently fail - auto-completion will still work with keywords
    }
  }, [jdbcUrl, username, password, dbType, schema]);

  // Fetch column details for a specific table (含类型、注释)
  const loadTableColumns = useCallback(async (tblName: string) => {
    if (tableColumnsRef.current[tblName]) return;
    try {
      const result = await window.electronAPI.invoke('db:table-structure', {
        jdbcUrl, username, password, dbType, schema, tableName: tblName,
      }) as TableStructureResponse;
      if (result.success && result.columns) {
        tableColumnsRef.current[tblName] = result.columns.map(c => ({
          name: c.name,
          type: c.type,
          comment: c.comment || '',
          primaryKey: c.primaryKey,
        }));
      }
    } catch {
      // Silently fail
    }
  }, [jdbcUrl, username, password, dbType, schema]);

  const executeSql = useCallback(async (sqlToRun?: string) => {
    const query = sqlToRun || sql;
    if (!query.trim()) return;

    // Abort any previous request
    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;

    setIsExecuting(true);
    setResult(null);

    try {
      const response = await window.electronAPI.invoke('db:execute-sql', {
        jdbcUrl,
        username,
        password,
        dbType,
        schema,
        sql: query,
      }) as ExecuteSqlResponse;

      // If this request was aborted, ignore the result
      if (controller.signal.aborted) return;

      if (response.success && response.data) {
        const columns = response.data.columns || [];
        const rawRows = response.data.rows || [];
        const rows = rawRows.map(row => columns.map(col => String(row[col] ?? '')));
        setResult({
          success: true,
          columns,
          rows,
          rowCount: response.data.rowCount ?? rows.length,
          executionTime: response.executionTimeMs ?? 0,
        });
      } else {
        // Check if cancelled
        if (response.error === 'QUERY_CANCELLED') {
          setResult({
            success: false,
            columns: [],
            rows: [],
            rowCount: 0,
            executionTime: 0,
            message: '查询已取消',
          });
        } else {
          setResult({
            success: false,
            columns: [],
            rows: [],
            rowCount: 0,
            executionTime: response.executionTimeMs ?? 0,
            error: response.error,
            message: response.message,
          });
        }
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        setResult({
          success: false,
          columns: [],
          rows: [],
          rowCount: 0,
          executionTime: 0,
          error: String(err),
        });
      }
    } finally {
      if (!controller.signal.aborted) {
        setIsExecuting(false);
      }
      if (abortControllerRef.current === controller) {
        abortControllerRef.current = null;
      }
    }
  }, [sql, jdbcUrl, username, password, dbType, schema]);

  // Cancel the current executing query
  const cancelExecution = useCallback(async () => {
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    try {
      await window.electronAPI.invoke('db:cancel-sql');
    } catch {
      // Ignore errors during cancel
    }
    setIsExecuting(false);
    setResult({
      success: false,
      columns: [],
      rows: [],
      rowCount: 0,
      executionTime: 0,
      message: '查询已取消',
    });
  }, []);

  // Fetch table structure for display in table format
  const fetchTableStructure = useCallback(async () => {
    setIsExecuting(true);
    setResult(null);

    try {
      // Fetch both DDL and structure data in parallel
      const [structResponse, ddlResponse] = await Promise.all([
        window.electronAPI.invoke('db:table-structure', {
          jdbcUrl,
          username,
          password,
          dbType,
          schema,
          tableName: tableName || '',
        }) as Promise<TableStructureResponse>,
        window.electronAPI.invoke('db:table-ddl', {
          jdbcUrl,
          username,
          password,
          dbType,
          schema,
          tableName: tableName || '',
        }) as Promise<{ success: boolean; ddl?: string; error?: string }>,
      ]);

      // Update DDL in the SQL area
      if (ddlResponse.success && ddlResponse.ddl) {
        setSql(ddlResponse.ddl);
        onSqlChange?.(ddlResponse.ddl);
      }

      if (structResponse.success && structResponse.columns) {
        const columns = ['字段名', '类型', '主键', '可空', '默认值', '注释'];
        const rows = structResponse.columns.map(col => [
          col.name,
          col.type,
          col.primaryKey ? 'PK' : '',
          col.nullable === 'NO' ? 'NOT NULL' : 'YES',
          col.defaultValue || '',
          col.comment || '',
        ]);
        setResult({
          success: true,
          columns,
          rows,
          rowCount: rows.length,
          executionTime: 0,
        });
      } else {
        setResult({
          success: false,
          columns: [],
          rows: [],
          rowCount: 0,
          executionTime: 0,
          error: structResponse.error,
          message: structResponse.message,
        });
      }
    } catch (err) {
      setResult({
        success: false,
        columns: [],
        rows: [],
        rowCount: 0,
        executionTime: 0,
        error: String(err),
      });
    } finally {
      setIsExecuting(false);
    }
  }, [jdbcUrl, username, password, dbType, schema, tableName, onSqlChange]);

  // Sync result changes to parent (for caching)
  useEffect(() => {
    onResultChange?.(result);
  }, [result]);

  // Auto-execute on first mount (skip if cached result exists)
  useEffect(() => {
    if (!autoExecuted) {
      setAutoExecuted(true);
      if (!isModified) {
        if (isTableStructure) {
          fetchTableStructure();
        } else {
          executeSql(initialSql);
        }
      }
    }
  }, [autoExecuted]);

  // Load schema metadata on mount for auto-completion
  useEffect(() => {
    if (!isTableStructure) {
      loadSchemaMetadata();
    }
  }, [isTableStructure, loadSchemaMetadata]);

  // Click-outside handler for export menu
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (exportMenuRef.current && !exportMenuRef.current.contains(e.target as Node)) {
        setShowExportMenu(false);
      }
    };
    if (showExportMenu) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [showExportMenu]);

  const handleSqlChange = (value: string | undefined) => {
    const v = value ?? '';
    setSql(v);
    onSqlChange?.(v);
  };

  const connectionParams = { jdbcUrl, username, password, dbType, schema };

  const handleExport = async (format: 'csv' | 'xlsx' | 'insert') => {
    setShowExportMenu(false);
    if (!sql.trim()) return;
    try {
      if (format === 'insert') {
        const tblName = extractTableNameFromSql(sql);
        const response = await window.electronAPI.invoke('db:export', {
          ...connectionParams,
          sql,
          format: 'insert',
          tableName: tblName,
        }) as { success: boolean; insertScript?: string; fileName?: string; error?: string };
        if (response.success && response.insertScript) {
          downloadFile(response.insertScript, response.fileName || `${tblName || 'export'}.sql`, false);
        } else {
          setResult({
            success: false,
            columns: [],
            rows: [],
            rowCount: 0,
            executionTime: 0,
            error: response.error || '导出失败',
          });
        }
      } else {
        const response = await window.electronAPI.invoke('db:export', {
          ...connectionParams,
          sql,
          format,
        }) as { success: boolean; fileContent?: string; fileName?: string; error?: string };
        if (response.success && response.fileContent) {
          downloadFile(response.fileContent, response.fileName || `export.${format}`, true);
        } else {
          setResult({
            success: false,
            columns: [],
            rows: [],
            rowCount: 0,
            executionTime: 0,
            error: response.error || '导出失败',
          });
        }
      }
    } catch (err) {
      setResult({
        success: false,
        columns: [],
        rows: [],
        rowCount: 0,
        executionTime: 0,
        error: String(err),
      });
    }
  };

  const handleImport = async () => {
    if (!importScript.trim()) return;
    setIsImporting(true);
    try {
      const response = await window.electronAPI.invoke('db:import', {
        jdbcUrl, username, password, dbType, schema,
        sqlScript: importScript,
        batchSize: 1000,
        inTransaction: true,
      }) as { success: boolean; message?: string; error?: string; totalStatements?: number; successCount?: number; failCount?: number; executionTimeMs?: number };

      if (response.success) {
        setResult({
          success: true,
          columns: ['总语句数', '成功', '失败', '耗时(ms)'],
          rows: [[
            String(response.totalStatements || 0),
            String(response.successCount || 0),
            String(response.failCount || 0),
            String(response.executionTimeMs || 0),
          ]],
          rowCount: 1,
          executionTime: response.executionTimeMs || 0,
        });
        setShowImportDialog(false);
        setImportScript('');
      } else {
        setResult({
          success: false,
          columns: [],
          rows: [],
          rowCount: 0,
          executionTime: 0,
          error: response.error || response.message || '导入失败',
        });
      }
    } catch (err) {
      setResult({
        success: false,
        columns: [],
        rows: [],
        rowCount: 0,
        executionTime: 0,
        error: String(err),
      });
    } finally {
      setIsImporting(false);
    }
  };

  const handleFormatSql = () => {
    if (!editorRef.current) return;
    const currentSql = editorRef.current.getValue();
    const formatted = formatSql(currentSql);
    editorRef.current.setValue(formatted);
    setSql(formatted);
    onSqlChange?.(formatted);
  };

  const handleEditorMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;
    monacoRef.current = monaco;

    // Register SQL auto-completion provider
    monaco.languages.registerCompletionItemProvider('sql', {
      triggerCharacters: ['.', ' ', '('],
      provideCompletionItems: async (model: any, position: any) => {
        const word = model.getWordUntilPosition(position);
        const range = {
          startLineNumber: position.lineNumber,
          endLineNumber: position.lineNumber,
          startColumn: word.startColumn,
          endColumn: word.endColumn,
        };

        const fullSql = model.getValue();
        const lineContent = model.getLineContent(position.lineNumber);
        const textBeforeCursor = lineContent.substring(0, position.column - 1);

        const suggestions: any[] = [];

        // 提取光标所在的当前 SQL 语句（按 ; 分割），避免解析整个大文件
        const cursorOffset = model.getOffsetAt(position);
        const currentStatement = extractCurrentStatement(fullSql, cursorOffset);

        // 使用缓存：当前语句未变化时直接复用
        let aliasMap: Record<string, string> = {};
        let parsedTableNames: string[] = [];
        if (parsedCacheRef.current && parsedCacheRef.current.sql === currentStatement) {
          aliasMap = parsedCacheRef.current.aliasMap;
          parsedTableNames = parsedCacheRef.current.tableNames;
        } else {
          // 用 node-sql-parser 解析当前语句，提取别名映射
          try {
            const parser = new Parser();
            const parserDb = getParserDbType(dbType);
            const ast = parser.astify(currentStatement, { database: parserDb });
            const extracted = extractAliasFromAst(ast as AST | AST[]);
            aliasMap = extracted.aliasMap;
            parsedTableNames = extracted.tableNames;
          } catch {
            // SQL 不完整或语法错误时，回退到正则解析
            const fromMatches = currentStatement.matchAll(/(?:FROM|JOIN)\s+(?:(\w+)\.)?(\w+)(?:\s+(?:AS\s+)?(\w+))?/gi);
            for (const m of fromMatches) {
              const schemaPrefix = m[1];
              const tbl = m[2];
              const alias = m[3];
              const qualifiedName = schemaPrefix ? `${schemaPrefix}.${tbl}` : tbl;
              if (alias) {
                aliasMap[alias] = qualifiedName;
              }
              aliasMap[tbl] = qualifiedName;
              if (schemaPrefix) {
                aliasMap[`${schemaPrefix}.${tbl}`] = qualifiedName;
              }
              if (!parsedTableNames.includes(qualifiedName)) {
                parsedTableNames.push(qualifiedName);
              }
            }
          }
          // 更新缓存
          parsedCacheRef.current = { sql: currentStatement, aliasMap, tableNames: parsedTableNames };
        }

        // 检测 schema.table. 格式（如 tradingx.app_user.）
        const schemaDotMatch = textBeforeCursor.match(/(\w+)\.(\w+)\.\s*$/);
        if (schemaDotMatch) {
          const schemaPrefix = schemaDotMatch[1];
          const tblOrAlias = schemaDotMatch[2];
          // 尝试通过别名映射解析
          const lookupKey = `${schemaPrefix}.${tblOrAlias}`;
          const resolvedTable = aliasMap[lookupKey] || lookupKey;
          // 取最后一段作为真实表名（去掉 schema 前缀用于查询）
          const realTableName = resolvedTable.includes('.') ? resolvedTable.split('.').pop()! : resolvedTable;

          await loadTableColumns(realTableName);
          const columns = tableColumnsRef.current[realTableName] || [];
          for (const col of columns) {
            const detailParts = [col.type];
            if (col.primaryKey) detailParts.push('PK');
            if (col.comment) detailParts.push(col.comment);
            suggestions.push({
              label: col.name,
              kind: monaco.languages.CompletionItemKind.Field,
              insertText: col.name,
              range,
              detail: detailParts.join(' · '),
              sortText: '0' + col.name,
            });
          }
          return { suggestions };
        }

        // 检测 alias. 或 table. 格式（如 u. 或 app_user.）
        const dotMatch = textBeforeCursor.match(/(\w+)\.\s*$/);
        if (dotMatch) {
          const prefix = dotMatch[1];
          // 通过别名映射解析真实表名
          const resolvedTable = aliasMap[prefix];

          if (resolvedTable) {
            // 取最后一段作为真实表名（去掉 schema 前缀用于查询）
            const realTableName = resolvedTable.includes('.') ? resolvedTable.split('.').pop()! : resolvedTable;
            await loadTableColumns(realTableName);
            const columns = tableColumnsRef.current[realTableName] || [];
            for (const col of columns) {
              const detailParts = [col.type];
              if (col.primaryKey) detailParts.push('PK');
              if (col.comment) detailParts.push(col.comment);
              suggestions.push({
                label: col.name,
                kind: monaco.languages.CompletionItemKind.Field,
                insertText: col.name,
                range,
                detail: detailParts.join(' · '),
                sortText: '0' + col.name,
              });
            }
          } else {
            // 别名映射中没有，尝试直接当表名查询
            await loadTableColumns(prefix);
            const columns = tableColumnsRef.current[prefix] || [];
            for (const col of columns) {
              const detailParts = [col.type];
              if (col.primaryKey) detailParts.push('PK');
              if (col.comment) detailParts.push(col.comment);
              suggestions.push({
                label: col.name,
                kind: monaco.languages.CompletionItemKind.Field,
                insertText: col.name,
                range,
                detail: detailParts.join(' · '),
                sortText: '0' + col.name,
              });
            }
          }
          return { suggestions };
        }

        // SQL keyword suggestions
        for (const kw of SQL_KEYWORDS) {
          suggestions.push({
            label: kw,
            kind: monaco.languages.CompletionItemKind.Keyword,
            insertText: kw,
            range,
            detail: 'SQL 关键字',
            sortText: '2' + kw,
          });
        }

        // Table name suggestions
        for (const tbl of schemaTablesRef.current) {
          suggestions.push({
            label: tbl,
            kind: monaco.languages.CompletionItemKind.Class,
            insertText: tbl,
            range,
            detail: '表',
            sortText: '1' + tbl,
          });
        }

        // Column suggestions for all tables in FROM/JOIN (from AST)
        for (const qualifiedName of parsedTableNames) {
          const realTableName = qualifiedName.includes('.') ? qualifiedName.split('.').pop()! : qualifiedName;
          await loadTableColumns(realTableName);
          const columns = tableColumnsRef.current[realTableName] || [];
          for (const col of columns) {
            const detailParts = [col.type];
            if (col.primaryKey) detailParts.push('PK');
            if (col.comment) detailParts.push(col.comment);
            suggestions.push({
              label: col.name,
              kind: monaco.languages.CompletionItemKind.Field,
              insertText: col.name,
              range,
              detail: `${realTableName} · ${detailParts.join(' · ')}`,
              sortText: '1' + col.name,
            });
          }
        }

        return { suggestions };
      },
    });

    // Ctrl+Enter to execute SQL (selected text only if any)
    editor.addAction({
      id: 'execute-sql',
      label: '执行SQL',
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter],
      run: (editor) => {
        if (isExecuting) {
          cancelExecution();
          return;
        }
        if (isTableStructure) {
          fetchTableStructure();
        } else {
          const selection = editor.getSelection();
          const selectedText = selection ? editor.getModel()?.getValueInRange(selection) : '';
          const currentSql = (selectedText && selectedText.trim()) || editor.getValue();
          executeSql(currentSql);
        }
      },
    });

    // Escape to cancel executing query
    editor.addAction({
      id: 'cancel-sql',
      label: '取消执行',
      keybindings: [monaco.KeyCode.Escape],
      run: () => {
        if (isExecuting) {
          cancelExecution();
        }
      },
    });
  };

  const handleBeforeMount: BeforeMount = (monaco) => {
    // Use the same theme as the main editor
    monaco.editor.defineTheme('xai-sql-dark', {
      base: 'vs-dark',
      inherit: true,
      rules: [
        { token: 'keyword', foreground: '#c792ea' },
        { token: 'keyword.sql', foreground: '#c792ea' },
        { token: 'string', foreground: '#c3e88d' },
        { token: 'string.sql', foreground: '#c3e88d' },
        { token: 'comment', foreground: '#58566a' },
        { token: 'comment.sql', foreground: '#58566a' },
        { token: 'number', foreground: '#f78c6c' },
        { token: 'number.sql', foreground: '#f78c6c' },
        { token: 'operator', foreground: '#89ddff' },
        { token: 'delimiter', foreground: '#89ddff' },
        { token: 'type', foreground: '#ffcb6b' },
        { token: 'identifier', foreground: '#e8e0d8' },
        { token: '', foreground: '#e8e0d8' },
      ],
      colors: {
        'editor.background': '#0e0f14',
        'editor.foreground': '#e8e0d8',
        'editor.lineHighlightBackground': '#ffffff06',
        'editor.selectionBackground': '#264f78',
        'editorLineNumber.foreground': '#58566a',
        'editorLineNumber.activeForeground': '#e8e0d8',
        'editorCursor.foreground': '#d4a76a',
        'editorIndentGuide.background': '#ffffff08',
        'editorIndentGuide.activeBackground': '#ffffff15',
        'editorBracketMatch.background': '#d4a76a1a',
        'editorBracketMatch.border': '#d4a76a66',
        'scrollbarSlider.background': 'rgba(212, 167, 106, 0.08)',
        'scrollbarSlider.hoverBackground': 'rgba(212, 167, 106, 0.18)',
        'scrollbarSlider.activeBackground': 'rgba(212, 167, 106, 0.28)',
      },
    });
  };

  // Build status text for toolbar
  const statusText = (() => {
    if (isExecuting) return null;
    if (!result) return null;
    if (!result.success) {
      // Show cancelled message gracefully
      if (result.message === '查询已取消') {
        return <span className="db-query-status db-query-status-cancelled">{result.message}</span>;
      }
      return <span className="db-query-status db-query-status-error">{result.error || result.message || '执行失败'}</span>;
    }
    if (isTableStructure) {
      return <span className="db-query-status db-query-status-ok"><Check size={12} />{result.rowCount} 个字段</span>;
    }
    return <span className="db-query-status db-query-status-ok"><Check size={12} />{result.rowCount} 行 · {result.executionTime}ms</span>;
  })();

  return (
    <div className="db-query-panel" ref={panelRef}>
      {/* SQL / DDL Area */}
      <div className="db-query-sql-area" ref={sqlAreaRef} style={sqlAreaHeight != null ? { flex: `0 0 ${sqlAreaHeight}px` } : isTableStructure ? { flex: '0 0 40%' } : undefined}>
        <div className="db-query-toolbar">
          <span className="db-query-conn-info">
            {isTableStructure ? (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                <Columns3 size={12} style={{ color: '#d4a76a' }} />
                {connName} / {schema} / {tableName}
              </span>
            ) : (
              `${connName} / ${schema}`
            )}
          </span>
          <div className="db-query-actions">
            {statusText}
            {!isTableStructure && (
              <>
                <button
                  className="icon-button"
                  onClick={handleFormatSql}
                  title="格式化SQL"
                >
                  <Paintbrush size={14} />
                </button>
                <div className="db-query-toolbar-separator" />
                {isExecuting ? (
                  <button
                    className="icon-button db-cancel-btn"
                    onClick={cancelExecution}
                    title="取消执行"
                  >
                    <X size={14} />
                  </button>
                ) : (
                  <button
                    className="icon-button"
                    onClick={() => {
                      const editor = editorRef.current;
                      if (editor) {
                        const selection = editor.getSelection();
                        const selectedText = selection ? editor.getModel()?.getValueInRange(selection) : '';
                        executeSql((selectedText && selectedText.trim()) || sql);
                      } else {
                        executeSql();
                      }
                    }}
                    title="执行 (Ctrl+Enter)"
                  >
                    <Play size={14} />
                  </button>
                )}
                <div className="db-query-export-wrapper" ref={exportMenuRef}>
                  <button
                    className="icon-button"
                    onClick={() => setShowExportMenu(!showExportMenu)}
                    title="导出"
                  >
                    <Download size={14} />
                  </button>
                  {showExportMenu && (
                    <div className="db-query-export-menu">
                      <button className="db-query-export-menu-item" onClick={() => handleExport('csv')}>
                        导出 CSV
                      </button>
                      <button className="db-query-export-menu-item" onClick={() => handleExport('xlsx')}>
                        导出 XLSX
                      </button>
                      <button className="db-query-export-menu-item" onClick={() => handleExport('insert')}>
                        导出 Insert Into
                      </button>
                    </div>
                  )}
                </div>
                <button
                  className="icon-button"
                  onClick={() => setShowImportDialog(true)}
                  title="导入"
                >
                  <Upload size={14} />
                </button>
              </>
            )}
            {isTableStructure && (
              <button
                className="icon-button"
                onClick={() => fetchTableStructure()}
                disabled={isExecuting}
                title="刷新表结构"
              >
                {isExecuting ? <Loader2 size={14} className="db-spinner" /> : <RefreshCw size={14} />}
              </button>
            )}
          </div>
        </div>
        <div className="db-query-monaco-wrapper">
          <Editor
            height="100%"
            language="sql"
            value={sql}
            onChange={isTableStructure ? undefined : handleSqlChange}
            onMount={handleEditorMount}
            beforeMount={handleBeforeMount}
            theme="xai-sql-dark"
            options={{
              fontSize: 13,
              fontFamily: "var(--font-mono)",
              minimap: { enabled: false },
              readOnly: isTableStructure ?? false,
              scrollBeyondLastLine: false,
              wordWrap: 'on',
              automaticLayout: true,
              padding: { top: 8 },
              lineNumbers: 'on',
              renderLineHighlight: 'line',
              cursorBlinking: 'smooth',
              smoothScrolling: true,
              scrollbar: {
                verticalScrollbarSize: 6,
                horizontalScrollbarSize: 6,
                useShadows: false,
                verticalHasArrows: false,
                horizontalHasArrows: false,
                alwaysConsumeMouseWheel: false,
              },
              overviewRulerBorder: false,
              hideCursorInOverviewRuler: true,
              suggest: {
                showKeywords: true,
                showSnippets: true,
                showWords: false,
              },
              wordBasedSuggestions: 'off',
              quickSuggestions: {
                other: true,
                comments: false,
                strings: false,
              },
              tabSize: 2,
            }}
          />
        </div>
      </div>

      {/* Resize handle */}
      <div className="db-query-resize-handle" onMouseDown={handleResizeMouseDown} />

      {/* Result Area */}
      <div className="db-query-result-area">
        {isExecuting && (
          <div className="db-query-loading">
            <Loader2 size={20} className="db-spinner" />
            <span>{isTableStructure ? '正在获取表结构...' : '正在执行查询...'}</span>
            {!isTableStructure && (
              <button className="db-loading-cancel-btn" onClick={cancelExecution} title="取消执行">
                <X size={14} />
                <span>取消</span>
              </button>
            )}
          </div>
        )}

        {!isExecuting && result && !result.success && result.message === '查询已取消' && (
          <div className="db-query-cancelled">
            <X size={16} />
            <span>查询已取消</span>
          </div>
        )}

        {!isExecuting && result && !result.success && result.message !== '查询已取消' && (
          <div className="db-query-error">
            <AlertCircle size={16} />
            <span>{result.error || result.message || '执行失败'}</span>
          </div>
        )}

        {!isExecuting && result && result.success && (
          <div className="db-query-table-wrapper">
            {result.columns.length > 0 ? (
              <table className="db-query-table">
                <thead>
                  <tr>
                    {result.columns.map((col, i) => (
                      <th key={i}>{col}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {result.rows.map((row, ri) => (
                    <tr key={ri} className={isTableStructure && row[2] === 'PK' ? 'db-struct-pk-row' : ''}>
                      {row.map((cell, ci) => (
                        <td key={ci} title={cell}>
                          {ci === 2 && cell === 'PK' ? <span className="db-pk-badge">PK</span> : cell}
                        </td>
                      ))}
                    </tr>
                  ))}
                  {result.rows.length === 0 && (
                    <tr>
                      <td colSpan={result.columns.length} className="db-query-no-data">无数据</td>
                    </tr>
                  )}
                </tbody>
              </table>
            ) : (
              <div className="db-query-no-data">无结果</div>
            )}
          </div>
        )}

        {!isExecuting && !result && (
          <div className="db-query-placeholder">
            {isTableStructure ? '正在加载表结构...' : '按 Ctrl+Enter 执行查询 · Esc 取消'}
          </div>
        )}
      </div>

      <style>{`
        .db-query-panel {
          display: flex;
          flex-direction: column;
          height: 100%;
          background: var(--bg-primary);
        }

        .db-query-sql-area {
          flex: 0 0 33%;
          display: flex;
          flex-direction: column;
          min-height: 80px;
          border-bottom: 1px solid var(--border);
        }

        .db-query-toolbar {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 4px 12px;
          background: var(--bg-secondary);
          border-bottom: 1px solid var(--border);
          flex-shrink: 0;
          min-height: 32px;
        }

        .db-query-conn-info {
          font-size: 11px;
          color: var(--text-muted);
          font-family: var(--font-mono);
        }

        .db-query-actions {
          display: flex;
          align-items: center;
          gap: 8px;
        }

        .db-query-status {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          font-size: 11px;
          font-family: var(--font-mono);
          white-space: nowrap;
        }

        .db-query-status-ok {
          color: var(--success);
        }

        .db-query-status-error {
          color: var(--error);
          max-width: 200px;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .db-query-monaco-wrapper {
          flex: 1;
          min-height: 0;
          overflow: hidden;
        }

        .db-query-resize-handle {
          height: 5px;
          background: var(--border);
          cursor: row-resize;
          flex-shrink: 0;
          transition: background 0.15s;
        }
        .db-query-resize-handle:hover {
          background: var(--accent);
        }

        .db-query-result-area {
          flex: 1;
          display: flex;
          flex-direction: column;
          min-height: 0;
          overflow: hidden;
        }

        .db-query-table-wrapper {
          flex: 1;
          overflow: auto;
          min-height: 0;
        }

        .db-query-table {
          width: 100%;
          border-collapse: collapse;
          font-size: 12px;
          font-family: var(--font-mono);
        }

        .db-query-table th {
          position: sticky;
          top: 0;
          background: var(--bg-tertiary);
          color: var(--text-primary);
          font-weight: 600;
          text-align: left;
          padding: 5px 10px;
          border-bottom: 2px solid var(--border);
          white-space: nowrap;
          z-index: 1;
          border-right: 1px solid var(--border);
        }

        .db-query-table th:last-child {
          border-right: none;
        }

        .db-query-table td {
          padding: 4px 10px;
          border-bottom: 1px solid var(--border);
          color: var(--text-secondary);
          white-space: nowrap;
          max-width: 300px;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .db-query-table tr:hover td {
          background: var(--bg-hover);
        }

        .db-struct-pk-row td:first-child {
          color: var(--accent) !important;
          font-weight: 600;
        }

        .db-pk-badge {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          padding: 1px 6px;
          border-radius: 3px;
          background: rgba(212, 167, 106, 0.15);
          color: var(--accent);
          font-size: 10px;
          font-weight: 700;
          letter-spacing: 0.03em;
        }

        .db-query-no-data {
          text-align: center;
          padding: 20px;
          color: var(--text-muted);
          font-size: 12px;
        }

        .db-query-loading {
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 10px;
          height: 100%;
          color: var(--text-muted);
          font-size: 13px;
        }

        .db-query-error {
          display: flex;
          align-items: flex-start;
          gap: 8px;
          padding: 12px 16px;
          color: var(--error);
          font-size: 12px;
          font-family: var(--font-mono);
          background: rgba(232, 93, 93, 0.06);
          margin: 8px;
          border-radius: var(--radius-sm);
          line-height: 1.5;
        }

        .db-query-placeholder {
          display: flex;
          align-items: center;
          justify-content: center;
          height: 100%;
          color: var(--text-muted);
          font-size: 13px;
        }

        @keyframes db-spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
        .db-spinner {
          animation: db-spin 1s linear infinite;
          flex-shrink: 0;
        }

        .db-query-export-wrapper {
          position: relative;
        }

        .db-query-export-menu {
          position: absolute;
          top: 100%;
          right: 0;
          background: var(--bg-secondary);
          border: 1px solid var(--border);
          border-radius: var(--radius-sm);
          box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
          z-index: 100;
          min-width: 160px;
          padding: 4px 0;
        }

        .db-query-export-menu-item {
          display: block;
          width: 100%;
          padding: 6px 12px;
          font-size: 12px;
          color: var(--text-primary);
          background: none;
          border: none;
          text-align: left;
          cursor: pointer;
          font-family: var(--font-mono);
        }

        .db-query-export-menu-item:hover {
          background: var(--bg-hover);
        }

        .db-query-import-overlay {
          position: fixed;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          background: rgba(0, 0, 0, 0.5);
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 1000;
        }

        .db-query-import-dialog {
          background: var(--bg-primary);
          border: 1px solid var(--border);
          border-radius: var(--radius-md);
          width: 600px;
          max-width: 90vw;
          max-height: 80vh;
          display: flex;
          flex-direction: column;
          box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
        }

        .db-query-import-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 12px 16px;
          border-bottom: 1px solid var(--border);
          font-size: 14px;
          font-weight: 600;
          color: var(--text-primary);
        }

        .db-query-import-body {
          flex: 1;
          padding: 12px 16px;
          overflow: auto;
        }

        .db-query-import-textarea {
          width: 100%;
          height: 300px;
          background: var(--bg-secondary);
          border: 1px solid var(--border);
          border-radius: var(--radius-sm);
          color: var(--text-primary);
          font-family: var(--font-mono);
          font-size: 12px;
          padding: 8px;
          resize: vertical;
          outline: none;
        }

        .db-query-import-textarea:focus {
          border-color: var(--accent);
        }

        .db-query-import-footer {
          display: flex;
          align-items: center;
          justify-content: flex-end;
          gap: 8px;
          padding: 12px 16px;
          border-top: 1px solid var(--border);
        }

        .db-query-import-btn {
          padding: 6px 16px;
          font-size: 12px;
          border-radius: var(--radius-sm);
          cursor: pointer;
          border: 1px solid var(--border);
          font-family: var(--font-mono);
        }

        .db-query-import-btn-primary {
          background: var(--accent);
          color: var(--bg-primary);
          border-color: var(--accent);
        }

        .db-query-import-btn-primary:hover {
          opacity: 0.9;
        }

        .db-query-import-btn-secondary {
          background: var(--bg-secondary);
          color: var(--text-primary);
        }

        .db-query-import-btn-secondary:hover {
          background: var(--bg-hover);
        }

        .db-query-toolbar-separator {
          width: 1px;
          height: 16px;
          background: var(--border);
          margin: 0 2px;
        }

        .db-cancel-btn {
          color: #e84057 !important;
          animation: db-cancel-pulse 1s ease-in-out infinite;
        }

        .db-cancel-btn:hover {
          background: rgba(232, 64, 87, 0.12) !important;
        }

        @keyframes db-cancel-pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.6; }
        }

        .db-query-status-cancelled {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          font-size: 11px;
          color: #e8a050;
          padding: 0 6px;
          white-space: nowrap;
        }

        .db-loading-cancel-btn {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          padding: 4px 12px;
          margin-left: 12px;
          border: 1px solid rgba(232, 64, 87, 0.35);
          border-radius: 4px;
          background: rgba(232, 64, 87, 0.08);
          color: #e84057;
          font-size: 12px;
          cursor: pointer;
          transition: background 0.15s ease, border-color 0.15s ease;
        }

        .db-loading-cancel-btn:hover {
          background: rgba(232, 64, 87, 0.16);
          border-color: rgba(232, 64, 87, 0.55);
        }

        .db-query-cancelled {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 16px 20px;
          color: #e8a050;
          font-size: 13px;
          opacity: 0.8;
        }
      `}</style>

      {/* Import Dialog */}
      {showImportDialog && (
        <div className="db-query-import-overlay" onClick={() => setShowImportDialog(false)}>
          <div className="db-query-import-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="db-query-import-header">
              <span>导入SQL脚本</span>
              <button className="icon-button" onClick={() => setShowImportDialog(false)} style={{ padding: 2 }}>
                <X size={14} />
              </button>
            </div>
            <div className="db-query-import-body">
              <textarea
                className="db-query-import-textarea"
                value={importScript}
                onChange={(e) => setImportScript(e.target.value)}
                placeholder="粘贴SQL脚本（支持 INSERT INTO 语句）..."
                disabled={isImporting}
              />
            </div>
            <div className="db-query-import-footer">
              <button
                className="db-query-import-btn db-query-import-btn-secondary"
                onClick={() => { setShowImportDialog(false); setImportScript(''); }}
                disabled={isImporting}
              >
                取消
              </button>
              <button
                className="db-query-import-btn db-query-import-btn-primary"
                onClick={handleImport}
                disabled={isImporting || !importScript.trim()}
              >
                {isImporting ? '导入中...' : '执行导入'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
