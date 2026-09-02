import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Plus, Trash2, Pencil, ChevronDown, ChevronRight, Check, X,
  AlertCircle, Loader2, FolderOpen, Folder, Database,
  Table as TableIcon, MessageSquare, Columns3, Code, Search,
} from 'lucide-react';

// Database connection config types
interface DbConnection {
  id: string;
  name: string;
  type: 'mysql' | 'oracle' | 'dm' | 'sqlserver' | 'postgresql' | 'mongodb' | 'sqlite' | 'redis';
  host: string;
  port: number;
  username: string;
  passwordEncrypted: string;
  database?: string;
  createdAt: number;
}

interface TableInfo {
  name: string;
  type: string;
  comment: string;
}

interface DbPanelProps {
  onDatabaseSelect?: (connection: DbConnection) => void;
  onTableClick?: (params: {
    connId: string;
    connName: string;
    dbType: DbConnection['type'];
    jdbcUrl: string;
    username: string;
    password: string;
    schema: string;
    tableName: string;
  }) => void;
  onAddToChat?: (tag: { type: 'table'; filePath: string; content: string; tableName: string; dbType?: string }) => void;
  onShowTableStructure?: (params: {
    connId: string;
    connName: string;
    dbType: DbConnection['type'];
    jdbcUrl: string;
    username: string;
    password: string;
    schema: string;
    tableName: string;
  }) => void;
  onNewSqlEditor?: (params: {
    connId: string;
    connName: string;
    dbType: DbConnection['type'];
    jdbcUrl: string;
    username: string;
    password: string;
    schema: string;
  }) => void;
}

const CONFIG_FILE_NAME = 'xai-db-connections.json';

const encryptPassword = (password: string): string => {
  return btoa(unescape(encodeURIComponent(password)));
};

const decryptPassword = (encrypted: string): string => {
  return decodeURIComponent(escape(atob(encrypted)));
};

const defaultPorts: Record<DbConnection['type'], number> = {
  mysql: 3306,
  oracle: 1521,
  dm: 5236,
  sqlserver: 1433,
  postgresql: 5432,
  mongodb: 27017,
  sqlite: 0,
  redis: 6379,
};

const jdbcUrlBuilders: Record<DbConnection['type'], (host: string, port: number, database?: string) => string> = {
  mysql: (host, port) => `jdbc:mysql://${host}:${port}`,
  oracle: (host, port, database) => `jdbc:oracle:thin:@//${host}:${port}/${database || 'ORCL'}`,
  dm: (host, port) => `jdbc:dm://${host}:${port}`,
  sqlserver: (host, port) => `jdbc:sqlserver://${host}:${port};encrypt=false`,
  postgresql: (host, port) => `jdbc:postgresql://${host}:${port}`,
  mongodb: (host, port) => `jdbc:mongodb://${host}:${port}`,
  sqlite: (_host, _port, database) => `jdbc:sqlite:${database || 'data.db'}`,
  redis: (host, port) => `jdbc:redis://${host}:${port}`,
};

// 每种数据库类型对应不同 emoji 图标
const dbTypeEmoji: Record<DbConnection['type'], string> = {
  mysql: '🐬',
  postgresql: '🐘',
  oracle: '🔴',
  sqlserver: '🪟',
  dm: '🐼',
  mongodb: '🌿',
  sqlite: '🛢️',
  redis: '💎',
};

const dbTypeName: Record<DbConnection['type'], string> = {
  mysql: 'MySQL',
  postgresql: 'PostgreSQL',
  oracle: 'Oracle',
  sqlserver: 'SQL Server',
  dm: '达梦',
  mongodb: 'MongoDB',
  sqlite: 'SQLite',
  redis: 'Redis',
};

export default function DbPanel({ onDatabaseSelect, onTableClick, onAddToChat, onShowTableStructure, onNewSqlEditor }: DbPanelProps) {
  const [connections, setConnections] = useState<DbConnection[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [showDialog, setShowDialog] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [expandedSchemas, setExpandedSchemas] = useState<Set<string>>(new Set());
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  // Schema/table data and loading states
  const [schemaData, setSchemaData] = useState<Record<string, string[]>>({});
  const [tableData, setTableData] = useState<Record<string, TableInfo[]>>({});
  const [loadingSchemas, setLoadingSchemas] = useState<Set<string>>(new Set());
  const [loadingTables, setLoadingTables] = useState<Set<string>>(new Set());
  const [schemaErrors, setSchemaErrors] = useState<Record<string, string>>({});
  const [tableErrors, setTableErrors] = useState<Record<string, string>>({});
  const [loadingTableClick, setLoadingTableClick] = useState<Set<string>>(new Set());

  // Multi-select state for table/view nodes (key → table details for batch operations)
  const [selectedTables, setSelectedTables] = useState<Map<string, { conn: DbConnection; schemaName: string; table: TableInfo }>>(new Map());

  // Context menu (connection level)
  const [contextMenu, setContextMenu] = useState<{ visible: boolean; x: number; y: number; conn: DbConnection | null }>({ visible: false, x: 0, y: 0, conn: null });
  // Context menu (schema level)
  const [schemaCtxMenu, setSchemaCtxMenu] = useState<{ visible: boolean; x: number; y: number; conn: DbConnection | null; schemaName: string }>({ visible: false, x: 0, y: 0, conn: null, schemaName: '' });

  // Table context menu
  const [tableContextMenu, setTableContextMenu] = useState<{
    visible: boolean; x: number; y: number;
    conn: DbConnection | null; schemaName: string; table: TableInfo | null;
  }>({ visible: false, x: 0, y: 0, conn: null, schemaName: '', table: null });

  // Form state
  const [form, setForm] = useState({
    name: '',
    type: 'mysql' as DbConnection['type'],
    host: 'localhost',
    port: 3306,
    username: '',
    password: '',
    database: '',
  });

  const loadConnections = useCallback(async () => {
    try {
      const result = await window.electronAPI.invoke('db:load-config');
      if (result && Array.isArray(result)) {
        setConnections(result);
      }
    } catch (error) {
      console.error('Failed to load connections:', error);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadConnections();
  }, [loadConnections]);

  useEffect(() => {
    const handleClick = () => {
      setContextMenu({ visible: false, x: 0, y: 0, conn: null });
      setTableContextMenu(prev => ({ ...prev, visible: false }));
      setSchemaCtxMenu({ visible: false, x: 0, y: 0, conn: null, schemaName: '' });
    };
    document.addEventListener('click', handleClick);
    return () => document.removeEventListener('click', handleClick);
  }, []);

  // Add-to-chat loading state
  const [addChatLoading, setAddChatLoading] = useState(false);
  const [dbFilter, setDbFilter] = useState('');
  const [showDbFilter, setShowDbFilter] = useState(false);
  const dbFilterRef = useRef<HTMLInputElement>(null);

  // Fetch table structure(s) and add to chat (supports multi-select)
  const handleAddTableToChat = useCallback(async () => {
    const { conn: ctxConn, schemaName: ctxSchema, table: ctxTable } = tableContextMenu;
    if (!onAddToChat) return;

    // Determine which tables to add
    let tablesToAdd: Array<{ conn: DbConnection; schemaName: string; table: TableInfo }>;

    if (selectedTables.size > 1 && ctxConn && ctxTable && selectedTables.has(`${ctxConn.id}:${ctxSchema}:${ctxTable.name}`)) {
      // Multi-select: add all selected tables
      tablesToAdd = Array.from(selectedTables.values());
    } else if (ctxConn && ctxTable) {
      // Single table
      tablesToAdd = [{ conn: ctxConn, schemaName: ctxSchema, table: ctxTable }];
    } else {
      return;
    }

    setTableContextMenu(prev => ({ ...prev, visible: false }));
    setAddChatLoading(true);

    try {
      // Fetch all table structures in parallel
      const results = await Promise.all(
        tablesToAdd.map(async ({ conn, schemaName, table }) => {
          const jdbcUrl = jdbcUrlBuilders[conn.type](conn.host, conn.port, conn.database);
          const result = await window.electronAPI.invoke('db:table-structure', {
            jdbcUrl,
            username: conn.username,
            password: decryptPassword(conn.passwordEncrypted),
            dbType: conn.type,
            schema: schemaName,
            tableName: table.name,
          }) as { success?: boolean; columns?: { name: string; type: string; primaryKey?: boolean; nullable?: string; defaultValue?: string | null; comment?: string }[]; tableComment?: string; dbType?: string };
          return { conn, schemaName, table, result };
        })
      );

      let successCount = 0;
      let failCount = 0;

      for (const { conn, schemaName, table, result } of results) {
        if (result && result.success && result.columns) {
          const isView = table.type?.toUpperCase().includes('VIEW');
          const tableType = isView ? 'VIEW' : 'TABLE';
          const dbType = (result as any).dbType || conn.type;
          let content = `${tableType} (${dbType}): ${schemaName}.${table.name}`;
          if (result.tableComment) {
            content += `  -- ${result.tableComment}`;
          }
          content += '\n';
          content += 'Columns:\n';
          for (const col of result.columns) {
            let line = `  ${col.name} ${col.type}`;
            if (col.primaryKey) line += ' [PK]';
            if (col.nullable === 'NO') line += ' NOT NULL';
            if (col.defaultValue != null) line += ` DEFAULT ${col.defaultValue}`;
            if (col.comment) line += `  -- ${col.comment}`;
            content += line + '\n';
          }

          onAddToChat({
            type: 'table',
            filePath: schemaName,
            content,
            tableName: table.name,
            dbType,
          });
          successCount++;
        } else {
          failCount++;
          console.error(`[DbPanel] 获取表 ${schemaName}.${table.name} 结构失败:`, result);
        }
      }

      if (failCount > 0 && successCount === 0) {
        showToast('获取所有表结构失败', 'error');
      } else if (failCount > 0) {
        showToast(`成功 ${successCount} 个，失败 ${failCount} 个`, 'error');
      } else if (successCount > 1) {
        showToast(`已添加 ${successCount} 个表结构到对话`, 'success');
      }
    } catch (err) {
      console.error('[DbPanel] 获取表结构异常:', err);
      showToast(`获取表结构失败: ${err instanceof Error ? err.message : String(err)}`, 'error');
    } finally {
      setAddChatLoading(false);
    }
  }, [tableContextMenu, selectedTables, onAddToChat]);

  const saveConnections = async (newConnections: DbConnection[]) => {
    try {
      await window.electronAPI.invoke('db:save-config', newConnections);
      setConnections(newConnections);
      return true;
    } catch (error) {
      console.error('Failed to save connections:', error);
      return false;
    }
  };

  const showToast = (message: string, type: 'success' | 'error') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 3000);
  };

  const handleAdd = () => {
    setEditingId(null);
    setForm({ name: '', type: 'mysql', host: 'localhost', port: 3306, username: '', password: '', database: '' });
    setShowDialog(true);
  };

  const handleEdit = (conn: DbConnection) => {
    setEditingId(conn.id);
    setForm({
      name: conn.name, type: conn.type, host: conn.host, port: conn.port,
      username: conn.username, password: decryptPassword(conn.passwordEncrypted), database: conn.database || '',
    });
    setShowDialog(true);
  };

  const handleDelete = async (id: string) => {
    const conn = connections.find(c => c.id === id);
    if (!conn) return;
    if (!confirm(`确定要删除连接 "${conn.name}" 吗？`)) return;
    const newConnections = connections.filter(c => c.id !== id);
    const success = await saveConnections(newConnections);
    if (success) showToast('连接已删除', 'success');
    else showToast('删除失败', 'error');
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim() || !form.host.trim() || !form.username.trim()) {
      showToast('请填写必填字段', 'error');
      return;
    }
    let newConnections;
    if (editingId) {
      newConnections = connections.map(c => c.id === editingId ? { ...c, ...form, passwordEncrypted: encryptPassword(form.password) } : c);
    } else {
      const newConn: DbConnection = {
        id: Date.now().toString(36) + Math.random().toString(36).substr(2),
        ...form, passwordEncrypted: encryptPassword(form.password), createdAt: Date.now(),
      };
      newConnections = [...connections, newConn];
    }
    const success = await saveConnections(newConnections);
    if (success) {
      setShowDialog(false);
      showToast(editingId ? '连接已更新' : '连接已添加', 'success');
    } else {
      showToast('保存失败', 'error');
    }
  };

  // Toggle connection expand - fetch schemas on first expand
  const toggleExpand = async (id: string) => {
    const next = new Set(expandedIds);
    if (next.has(id)) { next.delete(id); setExpandedIds(next); return; }
    next.add(id);
    setExpandedIds(next);
    if (!schemaData[id] && !loadingSchemas.has(id)) {
      await fetchSchemas(id);
    }
  };

  const fetchSchemas = async (connId: string) => {
    const conn = connections.find(c => c.id === connId);
    if (!conn) return;
    setLoadingSchemas(prev => new Set(prev).add(connId));
    setSchemaErrors(prev => { const n = { ...prev }; delete n[connId]; return n; });
    try {
      const jdbcUrl = jdbcUrlBuilders[conn.type](conn.host, conn.port, conn.database);
      const result = await window.electronAPI.invoke('db:list-schemas', {
        jdbcUrl, username: conn.username, password: decryptPassword(conn.passwordEncrypted), dbType: conn.type,
      }) as { success: boolean; schemas?: string[]; error?: string; message?: string };
      if (result.success && result.schemas) {
        setSchemaData(prev => ({ ...prev, [connId]: result.schemas! }));
      } else {
        setSchemaErrors(prev => ({ ...prev, [connId]: result.error || result.message || '获取失败' }));
      }
    } catch (err) {
      setSchemaErrors(prev => ({ ...prev, [connId]: String(err) }));
    } finally {
      setLoadingSchemas(prev => { const n = new Set(prev); n.delete(connId); return n; });
    }
  };

  const toggleSchemaExpand = async (connId: string, schemaName: string) => {
    const key = `${connId}:${schemaName}`;
    const next = new Set(expandedSchemas);
    if (next.has(key)) { next.delete(key); setExpandedSchemas(next); return; }
    next.add(key);
    setExpandedSchemas(next);
    if (!tableData[key] && !loadingTables.has(key)) {
      await fetchTables(connId, schemaName);
    }
  };

  const fetchTables = async (connId: string, schemaName: string) => {
    const conn = connections.find(c => c.id === connId);
    if (!conn) return;
    const key = `${connId}:${schemaName}`;
    setLoadingTables(prev => new Set(prev).add(key));
    setTableErrors(prev => { const n = { ...prev }; delete n[key]; return n; });
    try {
      const jdbcUrl = jdbcUrlBuilders[conn.type](conn.host, conn.port, conn.database);
      const result = await window.electronAPI.invoke('db:list-tables', {
        jdbcUrl, username: conn.username, password: decryptPassword(conn.passwordEncrypted), dbType: conn.type, schema: schemaName,
      }) as { success: boolean; tables?: TableInfo[]; error?: string; message?: string };
      if (result.success && result.tables) {
        setTableData(prev => ({ ...prev, [key]: result.tables! }));
      } else {
        setTableErrors(prev => ({ ...prev, [key]: result.error || result.message || '获取失败' }));
      }
    } catch (err) {
      setTableErrors(prev => ({ ...prev, [key]: String(err) }));
    } finally {
      setLoadingTables(prev => { const n = new Set(prev); n.delete(key); return n; });
    }
  };

  const handleContextMenu = (e: React.MouseEvent, conn: DbConnection) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ visible: true, x: e.clientX, y: e.clientY, conn });
  };

  // ---- Render tree node ----

  // 过滤时，在已加载的连接中搜索匹配的 schema/table
  const connHasMatchingData = useCallback((connId: string): boolean => {
    const q = dbFilter.toLowerCase();
    const schemas = schemaData[connId];
    if (!schemas) return false;
    return schemas.some(schemaName => {
      if (schemaName.toLowerCase().includes(q)) return true;
      const key = `${connId}:${schemaName}`;
      const tables = tableData[key];
      if (!tables) return false;
      return tables.some(t =>
        t.name.toLowerCase().includes(q) ||
        (t.comment && t.comment.toLowerCase().includes(q))
      );
    });
  }, [schemaData, tableData, dbFilter]);

  const renderConnection = (conn: DbConnection) => {
    const isFiltering = !!dbFilter.trim();
    const matchesFilter = !isFiltering ||
      conn.name.toLowerCase().includes(dbFilter.toLowerCase()) ||
      dbTypeName[conn.type].toLowerCase().includes(dbFilter.toLowerCase()) ||
      connHasMatchingData(conn.id);
    if (!matchesFilter) return null;

    // 过滤时自动展开
    const isExpanded = isFiltering ? true : expandedIds.has(conn.id);
    const schemas = schemaData[conn.id];
    const isLoadingSch = loadingSchemas.has(conn.id);
    const schemaError = schemaErrors[conn.id];
    const emoji = dbTypeEmoji[conn.type] || '🗄️';

    return (
      <div key={conn.id}>
        {/* Connection row - like a root folder */}
        <div
          className="db-tree-node db-tree-conn"
          onClick={() => toggleExpand(conn.id)}
          onContextMenu={(e) => handleContextMenu(e, conn)}
        >
          <span className="db-tree-chevron">
            {isLoadingSch ? <Loader2 size={14} className="db-spinner" /> : isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </span>
          <span className="db-tree-emoji">{emoji}</span>
          <span className="db-tree-label" title={`${conn.name} (${dbTypeName[conn.type]} ${conn.host}:${conn.port})`}>
            <span className="db-tree-label-text">{conn.name}<span className="db-tree-label-host"> ({conn.host}:{conn.port})</span></span>
            {schemaData[conn.id] && (
              <span className="db-status-dot db-status-expanded" title="已展开" />
            )}
          </span>
        </div>

        {/* Expanded: schemas/databases */}
        {isExpanded && (
          <div className="db-tree-children">
            {isLoadingSch && (
              <div className="db-tree-node db-tree-loading">
                <span style={{ width: 14, flexShrink: 0 }} />
                <Loader2 size={13} className="db-spinner" />
                <span className="db-tree-hint">加载中...</span>
              </div>
            )}
            {schemaError && (
              <div className="db-tree-node db-tree-error" style={{ paddingLeft: 30 }}>
                <AlertCircle size={13} />
                <span className="db-tree-hint" style={{ color: 'var(--error)' }}>{schemaError}</span>
              </div>
            )}
            {schemas && schemas.length === 0 && !isLoadingSch && (
              <div className="db-tree-node db-tree-empty" style={{ paddingLeft: 30 }}>
                <span className="db-tree-hint">空</span>
              </div>
            )}
            {schemas && schemas.map(schemaName => renderSchema(conn, schemaName))}
          </div>
        )}
      </div>
    );
  };

  // 过滤时判断 schema 是否包含匹配内容（仅已加载数据）
  const schemaHasMatchingData = useCallback((connId: string, schemaName: string): boolean => {
    const q = dbFilter.toLowerCase();
    if (schemaName.toLowerCase().includes(q)) return true;
    const key = `${connId}:${schemaName}`;
    const tables = tableData[key];
    if (!tables) return false;
    return tables.some(t =>
      t.name.toLowerCase().includes(q) ||
      (t.comment && t.comment.toLowerCase().includes(q))
    );
  }, [tableData, dbFilter]);

  const renderSchema = (conn: DbConnection, schemaName: string) => {
    const schemaKey = `${conn.id}:${schemaName}`;
    const isFiltering = !!dbFilter.trim();

    // 过滤时：schema 名匹配或表名/注释匹配（仅已加载数据）
    if (isFiltering && !schemaHasMatchingData(conn.id, schemaName)) return null;

    // 过滤时自动展开
    const isExpanded = isFiltering ? true : expandedSchemas.has(schemaKey);
    const tables = tableData[schemaKey];
    const isLoadingTbl = loadingTables.has(schemaKey);
    const tableError = tableErrors[schemaKey];

    return (
      <div key={schemaKey}>
        {/* Schema row - like a folder */}
        <div
          className="db-tree-node db-tree-schema"
          onClick={() => toggleSchemaExpand(conn.id, schemaName)}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setSchemaCtxMenu({ visible: true, x: e.clientX, y: e.clientY, conn, schemaName });
          }}
        >
          <span className="db-tree-chevron">
            {isLoadingTbl ? <Loader2 size={14} className="db-spinner" /> : isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </span>
          {isExpanded ? <FolderOpen size={14} className="db-icon-folder" /> : <Folder size={14} className="db-icon-folder" />}
          <span className="db-tree-label">{schemaName}</span>
        </div>

        {/* Expanded: tables */}
        {isExpanded && (
          <div className="db-tree-children">
            {isLoadingTbl && (
              <div className="db-tree-node db-tree-loading">
                <span style={{ width: 14, flexShrink: 0 }} />
                <Loader2 size={13} className="db-spinner" />
                <span className="db-tree-hint">加载中...</span>
              </div>
            )}
            {tableError && (
              <div className="db-tree-node db-tree-error">
                <AlertCircle size={13} />
                <span className="db-tree-hint" style={{ color: 'var(--error)' }}>{tableError}</span>
              </div>
            )}
            {tables && tables.length === 0 && !isLoadingTbl && (
              <div className="db-tree-node db-tree-empty">
                <span className="db-tree-hint">空</span>
              </div>
            )}
            {tables && tables
              .filter(table => {
                if (!dbFilter.trim()) return true;
                const q = dbFilter.toLowerCase();
                return table.name.toLowerCase().includes(q) ||
                  (table.comment && table.comment.toLowerCase().includes(q));
              })
              .map(table => renderTable(conn, schemaName, table))}
          </div>
        )}
      </div>
    );
  };

  const handleTableClick = useCallback((e: React.MouseEvent, conn: DbConnection, schemaName: string, table: TableInfo) => {
    const tableKey = `${conn.id}:${schemaName}:${table.name}`;

    if (e.ctrlKey || e.metaKey) {
      // Ctrl+click: toggle multi-select, do NOT trigger query
      e.preventDefault();
      e.stopPropagation();
      setSelectedTables(prev => {
        const next = new Map(prev);
        if (next.has(tableKey)) {
          next.delete(tableKey);
        } else {
          next.set(tableKey, { conn, schemaName, table });
        }
        return next;
      });
      return;
    }

    // Normal click: clear selection and trigger query
    setSelectedTables(new Map());
    if (!onTableClick || loadingTableClick.has(tableKey)) return;

    setLoadingTableClick(prev => new Set(prev).add(tableKey));
    try {
      const jdbcUrl = jdbcUrlBuilders[conn.type](conn.host, conn.port, conn.database);
      onTableClick({
        connId: conn.id,
        connName: conn.name,
        dbType: conn.type,
        jdbcUrl,
        username: conn.username,
        password: decryptPassword(conn.passwordEncrypted),
        schema: schemaName,
        tableName: table.name,
      });
    } finally {
      setTimeout(() => {
        setLoadingTableClick(prev => { const n = new Set(prev); n.delete(tableKey); return n; });
      }, 500);
    }
  }, [onTableClick]);

  const handleTableContextMenu = useCallback((e: React.MouseEvent, conn: DbConnection, schemaName: string, table: TableInfo) => {
    e.preventDefault();
    e.stopPropagation();
    const tableKey = `${conn.id}:${schemaName}:${table.name}`;
    // Right-click also selects if not already
    if (!selectedTables.has(tableKey)) {
      setSelectedTables(new Map([[tableKey, { conn, schemaName, table }]]));
    }
    setTableContextMenu({ visible: true, x: e.clientX, y: e.clientY, conn, schemaName, table });
  }, [selectedTables]);

  const renderTable = (conn: DbConnection, schemaName: string, table: TableInfo) => {
    const isView = table.type?.toUpperCase().includes('VIEW');
    const tableKey = `${conn.id}:${schemaName}:${table.name}`;
    const isClickLoading = loadingTableClick.has(tableKey);
    const isSelected = selectedTables.has(tableKey);

    return (
      <div
        key={table.name}
        className={`db-tree-node db-tree-table ${onTableClick ? 'db-tree-clickable' : ''} ${isSelected ? 'db-tree-selected' : ''}`}
        title={table.comment || table.name}
        onClick={(e) => handleTableClick(e, conn, schemaName, table)}
        onContextMenu={(e) => handleTableContextMenu(e, conn, schemaName, table)}
      >
        <span style={{ width: 14, flexShrink: 0 }}>
          {isClickLoading && <Loader2 size={13} className="db-spinner" />}
        </span>
        <TableIcon size={13} style={{ color: isView ? '#A07BDB' : '#6CB4EE', flexShrink: 0 }} />
        <span className="db-tree-label db-tree-label-mono" style={{ color: isView ? '#A07BDB' : undefined }}>{table.name}</span>
      </div>
    );
  };

  return (
    <div className="db-panel">
      {/* Header */}
      <div className="panel-header">
        <span>数据库</span>
        <div style={{ display: 'flex', gap: 2 }}>
          <button className={`icon-button${showDbFilter ? ' active' : ''}`} onClick={() => { if (showDbFilter) { setShowDbFilter(false); setDbFilter(''); } else { setShowDbFilter(true); setTimeout(() => dbFilterRef.current?.focus(), 0); } }} title="过滤">
            <Search size={14} />
          </button>
          <button className="icon-button" onClick={handleAdd} title="添加数据库连接">
            <Plus size={14} />
          </button>
        </div>
      </div>

      {/* Filter input */}
      {showDbFilter && (
        <div className="db-filter-bar">
          <Search size={13} className="db-filter-icon" />
          <input
            ref={dbFilterRef}
            type="text"
            placeholder="过滤连接/表名..."
            value={dbFilter}
            onChange={(e) => setDbFilter(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') { setShowDbFilter(false); setDbFilter(''); } }}
            className="db-filter-input"
          />
          {dbFilter && (
            <button className="db-filter-clear" onClick={() => setDbFilter('')}>
              <X size={13} />
            </button>
          )}
        </div>
      )}

      {/* Tree */}
      <div className="db-tree">
        {isLoading ? (
          <div className="db-tree-empty-state">
            <Loader2 size={16} className="db-spinner" />
            <span>加载中...</span>
          </div>
        ) : connections.length === 0 ? (
          <div className="db-tree-empty-state">
            <Database size={32} style={{ opacity: 0.3 }} />
            <span>暂无数据库连接</span>
            <button className="db-add-btn" onClick={handleAdd}>
              <Plus size={14} />
              添加连接
            </button>
          </div>
        ) : (
          connections
            .map(conn => renderConnection(conn))
            .filter(Boolean)
        )}
      </div>

      {/* Context menu */}
      {contextMenu.visible && contextMenu.conn && (
        <div className="db-ctx-menu" style={{ top: contextMenu.y, left: contextMenu.x }} onClick={(e) => e.stopPropagation()}>
          {onNewSqlEditor && (() => {
            const conn = contextMenu.conn!;
            const schemas = schemaData[conn.id];
            const firstSchema = schemas && schemas.length > 0 ? schemas[0] : '';
            return (
              <div className="db-ctx-item" onClick={() => {
                const jdbcUrl = jdbcUrlBuilders[conn.type](conn.host, conn.port, conn.database);
                onNewSqlEditor({
                  connId: conn.id,
                  connName: conn.name,
                  dbType: conn.type,
                  jdbcUrl,
                  username: conn.username,
                  password: decryptPassword(conn.passwordEncrypted),
                  schema: firstSchema,
                });
                setContextMenu({ visible: false, x: 0, y: 0, conn: null });
              }}>
                <Code size={13} />
                <span>新建SQL编辑器</span>
              </div>
            );
          })()}
          <div className="db-ctx-item" onClick={() => { handleEdit(contextMenu.conn!); setContextMenu({ visible: false, x: 0, y: 0, conn: null }); }}>
            <Pencil size={13} />
            <span>编辑连接</span>
          </div>
          <div className="db-ctx-item" onClick={() => { fetchSchemas(contextMenu.conn!.id); setContextMenu({ visible: false, x: 0, y: 0, conn: null }); }}>
            <Loader2 size={13} />
            <span>刷新</span>
          </div>
          <div className="db-ctx-sep" />
          <div className="db-ctx-item db-ctx-danger" onClick={() => { handleDelete(contextMenu.conn!.id); setContextMenu({ visible: false, x: 0, y: 0, conn: null }); }}>
            <Trash2 size={13} />
            <span>删除连接</span>
          </div>
        </div>
      )}

      {/* Schema context menu */}
      {schemaCtxMenu.visible && schemaCtxMenu.conn && onNewSqlEditor && (
        <div className="db-ctx-menu" style={{ top: schemaCtxMenu.y, left: schemaCtxMenu.x }} onClick={(e) => e.stopPropagation()}>
          <div className="db-ctx-item" onClick={() => {
            const conn = schemaCtxMenu.conn!;
            const jdbcUrl = jdbcUrlBuilders[conn.type](conn.host, conn.port, conn.database);
            onNewSqlEditor({
              connId: conn.id,
              connName: conn.name,
              dbType: conn.type,
              jdbcUrl,
              username: conn.username,
              password: decryptPassword(conn.passwordEncrypted),
              schema: schemaCtxMenu.schemaName,
            });
            setSchemaCtxMenu({ visible: false, x: 0, y: 0, conn: null, schemaName: '' });
          }}>
            <Code size={13} />
            <span>新建SQL编辑器</span>
          </div>
        </div>
      )}

      {/* Table context menu */}
      {tableContextMenu.visible && tableContextMenu.table && (
        <div className="db-ctx-menu" style={{ top: tableContextMenu.y, left: tableContextMenu.x }} onClick={(e) => e.stopPropagation()}>
          <div className="db-ctx-item" onClick={handleAddTableToChat}>
            <MessageSquare size={13} />
            <span>{selectedTables.size > 1 ? `添加 ${selectedTables.size} 个表结构到对话` : '添加表结构到对话'}</span>
          </div>
          {onShowTableStructure && (
            <div className="db-ctx-item" onClick={() => {
              const { conn, schemaName, table } = tableContextMenu;
              if (conn && table) {
                const jdbcUrl = jdbcUrlBuilders[conn.type](conn.host, conn.port, conn.database);
                onShowTableStructure({
                  connId: conn.id,
                  connName: conn.name,
                  dbType: conn.type,
                  jdbcUrl,
                  username: conn.username,
                  password: decryptPassword(conn.passwordEncrypted),
                  schema: schemaName,
                  tableName: table.name,
                });
              }
              setTableContextMenu(prev => ({ ...prev, visible: false }));
            }}>
              <Columns3 size={13} />
              <span>显示表结构</span>
            </div>
          )}
        </div>
      )}

      {/* Add-to-chat loading overlay */}
      {addChatLoading && (
        <div className="db-loading-overlay">
          <Loader2 size={20} className="db-spinner" />
          <span>获取表结构中...</span>
        </div>
      )}

      {/* Add/Edit Dialog */}
      {showDialog && (
        <div className="db-dialog-overlay" onClick={() => setShowDialog(false)}>
          <div className="db-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="db-dialog-header">
              <span className="db-dialog-title">{editingId ? '编辑数据库连接' : '添加数据库连接'}</span>
              <button className="db-dialog-close" onClick={() => setShowDialog(false)}>
                <X size={16} />
              </button>
            </div>
            <form ref={formRef} onSubmit={handleSubmit} className="db-dialog-body">
              <div className="db-form-group">
                <label className="db-form-label">连接名称</label>
                <input type="text" className="db-form-input" value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="例如：本地测试库" required />
              </div>
              <div className="db-form-group">
                <label className="db-form-label">数据库类型</label>
                <select className="db-form-input" value={form.type}
                  onChange={(e) => setForm({ ...form, type: e.target.value as DbConnection['type'], port: defaultPorts[e.target.value as DbConnection['type']] })} required>
                  <option value="mysql">🐬 MySQL</option>
                  <option value="postgresql">🐘 PostgreSQL</option>
                  <option value="oracle">🔴 Oracle</option>
                  <option value="sqlserver">🪟 SQL Server</option>
                  <option value="dm">🐼 达梦</option>
                  <option value="mongodb">🌿 MongoDB</option>
                  <option value="sqlite">🛢️ SQLite</option>
                  <option value="redis">💎 Redis</option>
                </select>
              </div>
              <div className="db-form-row">
                <div className="db-form-group" style={{ flex: 2 }}>
                  <label className="db-form-label">主机地址</label>
                  <input type="text" className="db-form-input" value={form.host}
                    onChange={(e) => setForm({ ...form, host: e.target.value })} placeholder="localhost" required />
                </div>
                <div className="db-form-group" style={{ flex: 1 }}>
                  <label className="db-form-label">端口</label>
                  <input type="number" className="db-form-input" value={form.port}
                    onChange={(e) => setForm({ ...form, port: parseInt(e.target.value) || 0 })} required />
                </div>
              </div>
              <div className="db-form-group">
                <label className="db-form-label">数据库名 (可选)</label>
                <input type="text" className="db-form-input" value={form.database}
                  onChange={(e) => setForm({ ...form, database: e.target.value })} placeholder="例如：test_db" />
              </div>
              <div className="db-form-group">
                <label className="db-form-label">用户名</label>
                <input type="text" className="db-form-input" value={form.username}
                  onChange={(e) => setForm({ ...form, username: e.target.value })} placeholder="例如：root" required />
              </div>
              <div className="db-form-group">
                <label className="db-form-label">密码</label>
                <input type="password" className="db-form-input" value={form.password}
                  onChange={(e) => setForm({ ...form, password: e.target.value })} placeholder="密码" />
              </div>
              <div className="db-dialog-footer">
                <button type="button" className="db-btn db-btn-secondary" onClick={() => setShowDialog(false)}>取消</button>
                <button type="submit" className="db-btn db-btn-primary">
                  <Check size={14} />
                  {editingId ? '保存' : '添加'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Toast */}
      {toast && (
        <div className={`db-toast ${toast.type}`}>
          {toast.type === 'error' ? <AlertCircle size={14} /> : <Check size={14} />}
          <span>{toast.message}</span>
        </div>
      )}

      <style>{`
        .db-panel {
          display: flex;
          flex-direction: column;
          height: 100%;
          background: var(--bg-secondary);
          position: relative;
        }

        /* ---- Tree ---- */
        .db-tree {
          flex: 1;
          overflow-y: auto;
          overflow-x: hidden;
          padding: 4px 0;
        }

        .db-tree-node {
          display: flex;
          align-items: center;
          gap: 4px;
          padding: 1px 8px;
          height: 22px;
          line-height: 22px;
          cursor: pointer;
          user-select: none;
          white-space: nowrap;
          overflow: hidden;
          box-sizing: border-box;
        }

        .db-tree-node:hover {
          background: var(--bg-hover);
        }

        .db-tree-clickable {
          cursor: pointer;
        }

        .db-tree-clickable:hover {
          background: rgba(99, 102, 241, 0.1);
        }

        .db-tree-chevron {
          width: 14px;
          height: 14px;
          display: flex;
          align-items: center;
          justify-content: center;
          flex-shrink: 0;
        }

        .db-tree-label {
          font-size: 13px;
          color: var(--text-primary);
          display: flex;
          align-items: center;
          flex: 1;
          min-width: 0;
          gap: 0;
        }
        .db-tree-label-text {
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          min-width: 0;
        }
        .db-tree-label-host {
          color: var(--text-muted);
          font-size: 11px;
          font-weight: normal;
        }

        .db-tree-label-mono {
          font-family: var(--font-mono);
          font-size: 12px;
          color: var(--text-secondary);
        }

        .db-icon-folder {
          color: var(--folder-color);
          flex-shrink: 0;
        }

        .db-tree-emoji {
          font-size: 14px;
          line-height: 1;
          flex-shrink: 0;
          width: 16px;
          text-align: center;
        }

        .db-tree-emoji-sm {
          font-size: 12px;
          line-height: 1;
          flex-shrink: 0;
          width: 14px;
          text-align: center;
        }

        /* Indent levels */
        .db-tree-conn {
          padding-left: 8px;
        }
        .db-tree-children .db-tree-node {
          padding-left: 24px;
        }
        .db-tree-children .db-tree-children .db-tree-node {
          padding-left: 40px;
        }

        /* Loading / error / empty hints */
        .db-tree-hint {
          font-size: 12px;
          color: var(--text-muted);
        }

        .db-tree-loading,
        .db-tree-error,
        .db-tree-empty {
          cursor: default;
        }
        .db-tree-loading:hover,
        .db-tree-empty:hover {
          background: transparent;
        }

        /* Empty state */
        .db-tree-empty-state {
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 10px;
          padding: 40px 16px;
          color: var(--text-muted);
          font-size: 13px;
        }

        .db-add-btn {
          display: flex;
          align-items: center;
          gap: 6px;
          padding: 6px 12px;
          border-radius: var(--radius-sm);
          background: var(--accent);
          color: white;
          border: none;
          cursor: pointer;
          font-size: 12px;
          margin-top: 4px;
        }
        .db-add-btn:hover { filter: brightness(1.1); }

        /* Spinner */
        @keyframes db-spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
        .db-spinner {
          animation: db-spin 1s linear infinite;
          flex-shrink: 0;
        }

        /* ---- Context menu ---- */
        .db-ctx-menu {
          position: fixed;
          z-index: 10000;
          background: var(--bg-secondary);
          border: 1px solid var(--border);
          border-radius: var(--radius-md);
          box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
          padding: 4px 0;
          min-width: 150px;
        }
        .db-ctx-item {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 6px 12px;
          font-size: 12px;
          color: var(--text-primary);
          cursor: pointer;
        }
        .db-ctx-item:hover { background: var(--bg-hover); }
        .db-ctx-danger { color: var(--error); }
        .db-ctx-danger:hover { background: rgba(232, 93, 93, 0.1); }
        .db-ctx-sep { height: 1px; background: var(--border); margin: 4px 8px; }

        /* ---- Dialog ---- */
        .db-dialog-overlay {
          position: absolute;
          inset: 0;
          background: rgba(0, 0, 0, 0.55);
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 1000;
          backdrop-filter: blur(2px);
        }
        .db-dialog {
          background: var(--bg-secondary);
          border: 1px solid var(--border);
          border-radius: var(--radius-md);
          width: 400px;
          max-width: 90vw;
          box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
          overflow: hidden;
        }
        .db-dialog-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 12px 16px;
          border-bottom: 1px solid var(--border);
        }
        .db-dialog-title { font-size: 14px; font-weight: 600; color: var(--text-primary); }
        .db-dialog-close {
          display: flex; align-items: center; justify-content: center;
          width: 24px; height: 24px; border-radius: 4px;
          background: transparent; border: none; color: var(--text-muted); cursor: pointer;
        }
        .db-dialog-close:hover { background: var(--bg-hover); color: var(--text-primary); }
        .db-dialog-body { padding: 16px; }
        .db-form-group { margin-bottom: 12px; }
        .db-form-row { display: flex; gap: 12px; }
        .db-form-label { display: block; font-size: 12px; font-weight: 500; color: var(--text-secondary); margin-bottom: 4px; }
        .db-form-input {
          width: 100%; padding: 6px 8px; font-size: 13px;
          border-radius: var(--radius-sm); border: 1px solid var(--border);
          background: var(--bg-primary); color: var(--text-primary); outline: none;
          transition: border-color 0.15s, box-shadow 0.15s;
        }
        .db-form-input:focus { border-color: var(--accent); box-shadow: 0 0 0 2px rgba(78, 155, 255, 0.15); }
        .db-dialog-footer { display: flex; align-items: center; justify-content: flex-end; gap: 8px; padding-top: 8px; }
        .db-btn {
          display: inline-flex; align-items: center; gap: 6px;
          padding: 6px 14px; border-radius: var(--radius-sm);
          font-size: 12px; font-weight: 500; cursor: pointer; border: none;
          transition: background 0.15s, filter 0.15s;
        }
        .db-btn-secondary { background: transparent; color: var(--text-secondary); border: 1px solid var(--border); }
        .db-btn-secondary:hover { background: var(--bg-hover); color: var(--text-primary); }
        .db-btn-primary { background: var(--accent); color: white; }
        .db-btn-primary:hover { filter: brightness(1.1); }

        /* Toast */
        .db-toast {
          position: absolute; bottom: 16px; left: 50%; transform: translateX(-50%);
          display: flex; align-items: center; gap: 8px; padding: 8px 14px;
          border-radius: var(--radius-md); font-size: 12px;
          box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3); z-index: 1001;
        }
        .db-toast.success { background: var(--success); color: white; }
        .db-toast.error { background: var(--error); color: white; }

        /* Selected table/view highlight */
        .db-tree-selected {
          background: rgba(78, 155, 255, 0.15) !important;
        }
        .db-tree-selected:hover {
          background: rgba(78, 155, 255, 0.25) !important;
        }

        /* Status dot indicator */
        .db-status-dot {
          display: inline-block;
          width: 7px;
          height: 7px;
          border-radius: 50%;
          flex-shrink: 0;
          margin-left: 6px;
          vertical-align: middle;
        }
        .db-status-expanded {
          background: #d4a843;
          box-shadow: 0 0 4px rgba(212, 168, 67, 0.5);
        }

        /* Add-to-chat loading overlay */
        .db-loading-overlay {
          position: absolute;
          inset: 0;
          background: rgba(0, 0, 0, 0.55);
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 8px;
          z-index: 1000;
          color: var(--text-primary);
          font-size: 13px;
          backdrop-filter: blur(2px);
        }

        /* Filter bar */
        .db-filter-bar {
          display: flex;
          align-items: center;
          padding: 4px 8px;
          border-bottom: 1px solid var(--border);
          gap: 6px;
          background: var(--bg-secondary);
          flex-shrink: 0;
        }
        .db-filter-icon {
          color: var(--text-muted);
          flex-shrink: 0;
        }
        .db-filter-input {
          flex: 1;
          background: var(--bg-input);
          border: 1px solid var(--border);
          border-radius: var(--radius-sm);
          padding: 4px 8px;
          color: var(--text-primary);
          font-size: 12px;
          outline: none;
          min-width: 0;
        }
        .db-filter-input:focus {
          border-color: var(--border-focus);
        }
        .db-filter-input::placeholder {
          color: var(--text-muted);
        }
        .db-filter-clear {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 20px;
          height: 20px;
          border-radius: var(--radius-sm);
          color: var(--text-muted);
          flex-shrink: 0;
          transition: background 0.1s, color 0.1s;
        }
        .db-filter-clear:hover {
          background: var(--bg-active);
          color: var(--text-primary);
        }
      `}</style>
    </div>
  );
}
