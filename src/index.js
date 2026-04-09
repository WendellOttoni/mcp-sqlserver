#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import sql from "mssql";
import { z } from "zod";

// ─────────────────────────────────────────────
// CONNECTION CONFIG
// ─────────────────────────────────────────────
let serverRaw = (process.env.DB_SERVER || "localhost").replace(/\//g, "\\");
let serverName = serverRaw;
let instanceName = undefined;

if (serverRaw.includes("\\")) {
  const parts = serverRaw.split("\\", 2);
  serverName = parts[0];
  instanceName = parts[1];
}

const config = {
  server: serverName,
  database: process.env.DB_DATABASE || "",
  user: process.env.DB_USER || undefined,
  password: process.env.DB_PASSWORD || undefined,
  options: {
    trustServerCertificate: true,
    encrypt: false,
    instanceName: instanceName,
  },
  pool: { max: 5, min: 0, idleTimeoutMillis: 30000 },
};

if (!instanceName) {
  config.port = parseInt(process.env.DB_PORT || "1433");
}

if (!config.user) {
  delete config.user;
  delete config.password;
  config.authentication = { type: "ntlm", options: { domain: "" } };
}

// ─────────────────────────────────────────────
// PERMISSION CONFIG
// ─────────────────────────────────────────────
// DB_ALLOW_WRITE   — operations: INSERT,UPDATE,DELETE,MERGE,DROP,ALTER,CREATE,TRUNCATE
// DB_ALLOW_TABLES  — restrict writes to specific tables: dbo.Produto,dbo.Pedido
// DB_ALLOW_SCHEMAS — restrict writes to specific schemas: staging,temp
//
// Permanently blocked (never configurable):
//   EXEC, EXECUTE, GRANT, REVOKE, DENY, BACKUP, RESTORE, SHUTDOWN,
//   DBCC, BULK, OPENROWSET, OPENDATASOURCE, xp_*, sp_*

const ALWAYS_BLOCKED = [
  "EXEC", "EXECUTE", "GRANT", "REVOKE", "DENY",
  "BACKUP", "RESTORE", "SHUTDOWN", "DBCC", "BULK",
  "OPENROWSET", "OPENDATASOURCE", "xp_", "sp_",
];

const WRITE_KEYWORDS = [
  "INSERT", "UPDATE", "DELETE", "MERGE",
  "DROP", "ALTER", "CREATE", "TRUNCATE",
];

const allowedWriteOps = (process.env.DB_ALLOW_WRITE || "")
  .split(",")
  .map((k) => k.trim().toUpperCase())
  .filter((k) => WRITE_KEYWORDS.includes(k));

// DB_ALLOW_TABLES: "dbo.Produto,dbo.Pedido" — restricts write target tables
const allowedTables = (process.env.DB_ALLOW_TABLES || "")
  .split(",")
  .map((t) => t.trim().toLowerCase())
  .filter(Boolean);

// DB_ALLOW_SCHEMAS: "staging,temp" — restricts write target schemas
const allowedSchemas = (process.env.DB_ALLOW_SCHEMAS || "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

const BLOCKED_KEYWORDS = [
  ...ALWAYS_BLOCKED,
  ...WRITE_KEYWORDS.filter((k) => !allowedWriteOps.includes(k)),
];

const isReadOnly = allowedWriteOps.length === 0;

// ─────────────────────────────────────────────
// SAFETY FUNCTIONS
// ─────────────────────────────────────────────

function isSafeQuery(query) {
  const upper = query.toUpperCase().replace(/\s+/g, " ").trim();
  for (const keyword of BLOCKED_KEYWORDS) {
    const isPrefix = keyword.endsWith("_");
    const pattern = isPrefix
      ? `(^|\\s|;|\\()${keyword}`
      : `(^|\\s|;|\\()${keyword}(\\s|;|\\(|$)`;
    if (new RegExp(pattern, "i").test(upper)) {
      return { safe: false, keyword };
    }
  }
  return { safe: true };
}

// Best-effort extraction of the target table from a write query
function extractWriteTarget(query) {
  const patterns = [
    /^\s*INSERT\s+(?:INTO\s+)?(\[?[\w.]+\]?)/i,
    /^\s*UPDATE\s+(\[?[\w.]+\]?)\s+SET/i,
    /^\s*DELETE\s+(?:FROM\s+)?(\[?[\w.]+\]?)/i,
    /^\s*MERGE\s+(?:INTO\s+)?(\[?[\w.]+\]?)/i,
    /^\s*CREATE\s+TABLE\s+(\[?[\w.]+\]?)/i,
    /^\s*ALTER\s+TABLE\s+(\[?[\w.]+\]?)/i,
    /^\s*DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(\[?[\w.]+\]?)/i,
    /^\s*TRUNCATE\s+TABLE\s+(\[?[\w.]+\]?)/i,
  ];
  for (const pattern of patterns) {
    const match = query.trim().match(pattern);
    if (match) return match[1].replace(/[\[\]]/g, "").toLowerCase();
  }
  return null;
}

// Validates target table against DB_ALLOW_TABLES and DB_ALLOW_SCHEMAS
function isTableAllowed(targetTable) {
  if (allowedTables.length === 0 && allowedSchemas.length === 0) return { allowed: true };

  const parts = targetTable.includes(".")
    ? targetTable.split(".", 2)
    : ["dbo", targetTable];
  const [schema, table] = parts;

  if (allowedSchemas.length > 0 && !allowedSchemas.includes(schema)) {
    return {
      allowed: false,
      reason: `Schema "${schema}" is not in DB_ALLOW_SCHEMAS (${allowedSchemas.join(", ")})`,
    };
  }

  if (allowedTables.length > 0) {
    const fullName = `${schema}.${table}`;
    const match = allowedTables.some(
      (t) => t === fullName || t === table || t === `dbo.${table}`
    );
    if (!match) {
      return { allowed: false, reason: `Table "${fullName}" is not in DB_ALLOW_TABLES` };
    }
  }

  return { allowed: true };
}

function isWriteQuery(query) {
  const upper = query.toUpperCase();
  return allowedWriteOps.some((op) =>
    new RegExp(`(^|\\s|;|\\()${op}(\\s|;|\\(|$)`, "i").test(upper)
  );
}

// ─────────────────────────────────────────────
// POOL — startup validation
// ─────────────────────────────────────────────
let pool = null;

async function getPool() {
  if (!pool || !pool.connected) {
    pool = await sql.connect(config);
  }
  return pool;
}

try {
  pool = await sql.connect(config);
  await pool.request().query("SELECT 1");
  process.stderr.write(
    `[mcp-sqlserver] Connected to "${config.database}" on ${config.server}\n`
  );
} catch (err) {
  process.stderr.write(`[mcp-sqlserver] Connection failed: ${err.message}\n`);
  process.exit(1);
}

// ─────────────────────────────────────────────
// FORMATTING HELPERS
// ─────────────────────────────────────────────
const MAX_COL_WIDTH = 48;

function truncate(str, max) {
  return str.length > max ? str.slice(0, max - 1) + "…" : str;
}

function boxTable(headers, rows) {
  const widths = headers.map((h, i) =>
    Math.min(
      MAX_COL_WIDTH,
      Math.max(h.length, ...rows.map((r) => String(r[i] ?? "").length))
    )
  );
  const top    = "┌" + widths.map((w) => "─".repeat(w + 2)).join("┬") + "┐";
  const mid    = "├" + widths.map((w) => "─".repeat(w + 2)).join("┼") + "┤";
  const bottom = "└" + widths.map((w) => "─".repeat(w + 2)).join("┴") + "┘";
  const renderRow = (cells) =>
    "│ " +
    cells.map((c, i) => truncate(String(c ?? ""), widths[i]).padEnd(widths[i])).join(" │ ") +
    " │";
  return [top, renderRow(headers), mid, ...rows.map(renderRow), bottom].join("\n");
}

function boxHeader(title, subtitle = "") {
  const inner = subtitle ? `${title}  ·  ${subtitle}` : title;
  const w = inner.length + 2;
  return `╔${"═".repeat(w)}╗\n║ ${inner} ║\n╚${"═".repeat(w)}╝`;
}

function boxSection(title, lines, width = 40) {
  const innerW = Math.max(width, title.length + 4, ...lines.map((l) => l.length + 2));
  const top    = `┌─ ${title} ${"─".repeat(Math.max(1, innerW - title.length - 2))}┐`;
  const bottom = `└${"─".repeat(innerW + 2)}┘`;
  const body   = lines.map((l) => `│  ${l.padEnd(innerW - 1)}│`);
  return [top, ...body, bottom].join("\n");
}

// ─────────────────────────────────────────────
// MCP SERVER
// ─────────────────────────────────────────────
const server = new McpServer({ name: "mcp-sqlserver", version: "1.0.0" });

// ── list_schemas ──────────────────────────────
server.tool(
  "list_schemas",
  "List all schemas in the database",
  {},
  async () => {
    const db = await getPool();
    const result = await db.request().query(`
      SELECT DISTINCT TABLE_SCHEMA
      FROM INFORMATION_SCHEMA.TABLES
      ORDER BY TABLE_SCHEMA
    `);

    const schemas = result.recordset.map((r) => r.TABLE_SCHEMA);
    const tree = schemas.map((s, i) =>
      i === schemas.length - 1 ? `└─ ${s}` : `├─ ${s}`
    );

    return {
      content: [{
        type: "text",
        text: [boxHeader(`Database: ${config.database}`, `${schemas.length} schema(s)`), "", ...tree].join("\n"),
      }],
    };
  }
);

// ── list_tables ───────────────────────────────
server.tool(
  "list_tables",
  "List all tables and views in the database, grouped by schema",
  {
    schema: z.string().optional().describe("Filter by schema name (e.g. 'dbo'). Leave empty for all."),
  },
  async ({ schema }) => {
    const db = await getPool();
    let query = `SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE FROM INFORMATION_SCHEMA.TABLES`;
    if (schema) query += ` WHERE TABLE_SCHEMA = @schema`;
    query += ` ORDER BY TABLE_SCHEMA, TABLE_NAME`;

    const request = db.request();
    if (schema) request.input("schema", sql.NVarChar, schema);
    const result = await request.query(query);

    const grouped = {};
    for (const row of result.recordset) {
      if (!grouped[row.TABLE_SCHEMA]) grouped[row.TABLE_SCHEMA] = [];
      grouped[row.TABLE_SCHEMA].push({ name: row.TABLE_NAME, type: row.TABLE_TYPE });
    }

    const totalTables = result.recordset.filter((r) => r.TABLE_TYPE === "BASE TABLE").length;
    const totalViews  = result.recordset.filter((r) => r.TABLE_TYPE === "VIEW").length;
    const subtitle = [
      totalTables ? `${totalTables} table(s)` : null,
      totalViews  ? `${totalViews} view(s)`  : null,
    ].filter(Boolean).join(", ");

    const sections = Object.entries(grouped).map(([s, items]) =>
      boxSection(
        s,
        items.map((item) => `${item.type === "VIEW" ? "◌" : "●"} ${item.name.padEnd(30)} ${item.type}`)
      )
    );

    return {
      content: [{
        type: "text",
        text: [boxHeader(`Database: ${config.database}`, subtitle), "", sections.join("\n\n")].join("\n"),
      }],
    };
  }
);

// ── find_tables ───────────────────────────────
server.tool(
  "find_tables",
  "Search for tables and views by name (partial match)",
  {
    name: z.string().describe("Table name or partial name to search for"),
    schema: z.string().optional().describe("Restrict search to a specific schema"),
  },
  async ({ name, schema }) => {
    const db = await getPool();

    let query = `
      SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE
      FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_NAME LIKE @name
    `;
    if (schema) query += ` AND TABLE_SCHEMA = @schema`;
    query += ` ORDER BY TABLE_SCHEMA, TABLE_NAME`;

    const request = db.request().input("name", sql.NVarChar, `%${name}%`);
    if (schema) request.input("schema", sql.NVarChar, schema);
    const result = await request.query(query);

    const rows = result.recordset.map((r) => [
      r.TABLE_SCHEMA,
      r.TABLE_NAME,
      r.TABLE_TYPE === "VIEW" ? "VIEW" : "TABLE",
    ]);

    const text = [
      boxHeader(`Search: "${name}"`, `${result.recordset.length} match(es)`),
      "",
      rows.length === 0 ? "No tables found." : boxTable(["Schema", "Name", "Type"], rows),
    ].join("\n");

    return { content: [{ type: "text", text }] };
  }
);

// ── describe_table ────────────────────────────
server.tool(
  "describe_table",
  "Show columns, data types, primary keys, foreign keys, check constraints, and identity/computed info of a table",
  {
    table: z.string().describe("Table name (e.g. 'Produto' or 'dbo.Produto')"),
  },
  async ({ table }) => {
    const db = await getPool();

    let schema = "dbo";
    let tableName = table;
    if (table.includes(".")) [schema, tableName] = table.split(".", 2);

    const objectId = `${schema}.${tableName}`;

    // Columns — including identity and computed flags
    const colResult = await db
      .request()
      .input("schema", sql.NVarChar, schema)
      .input("table",  sql.NVarChar, tableName)
      .input("objid",  sql.NVarChar, objectId)
      .query(`
        SELECT
          c.COLUMN_NAME,
          c.DATA_TYPE,
          c.CHARACTER_MAXIMUM_LENGTH,
          c.IS_NULLABLE,
          c.COLUMN_DEFAULT,
          CASE WHEN pk.COLUMN_NAME IS NOT NULL THEN 'YES' ELSE 'NO' END AS IS_PK,
          COLUMNPROPERTY(OBJECT_ID(@objid), c.COLUMN_NAME, 'IsIdentity')  AS IS_IDENTITY,
          COLUMNPROPERTY(OBJECT_ID(@objid), c.COLUMN_NAME, 'IsComputed')  AS IS_COMPUTED
        FROM INFORMATION_SCHEMA.COLUMNS c
        LEFT JOIN (
          SELECT ku.COLUMN_NAME
          FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
          JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE ku ON tc.CONSTRAINT_NAME = ku.CONSTRAINT_NAME
          WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY'
            AND tc.TABLE_SCHEMA = @schema AND tc.TABLE_NAME = @table
        ) pk ON pk.COLUMN_NAME = c.COLUMN_NAME
        WHERE c.TABLE_SCHEMA = @schema AND c.TABLE_NAME = @table
        ORDER BY c.ORDINAL_POSITION
      `);

    // Foreign keys
    const fkResult = await db
      .request()
      .input("schema", sql.NVarChar, schema)
      .input("table",  sql.NVarChar, tableName)
      .query(`
        SELECT
          COL_NAME(fc.parent_object_id, fc.parent_column_id)                                     AS from_col,
          OBJECT_SCHEMA_NAME(fc.referenced_object_id) + '.' + OBJECT_NAME(fc.referenced_object_id) AS to_table,
          COL_NAME(fc.referenced_object_id, fc.referenced_column_id)                             AS to_col
        FROM sys.foreign_key_columns fc
        JOIN sys.objects o ON o.object_id = fc.parent_object_id
        WHERE OBJECT_SCHEMA_NAME(o.object_id) = @schema AND o.name = @table
      `);

    // Check constraints
    const ckResult = await db
      .request()
      .input("schema", sql.NVarChar, schema)
      .input("table",  sql.NVarChar, tableName)
      .query(`
        SELECT cc.name AS constraint_name, cc.definition
        FROM sys.check_constraints cc
        JOIN sys.objects o ON o.object_id = cc.parent_object_id
        WHERE OBJECT_SCHEMA_NAME(o.object_id) = @schema AND o.name = @table
        ORDER BY cc.name
      `);

    // Build column rows
    const colRows = colResult.recordset.map((col) => {
      const type = col.CHARACTER_MAXIMUM_LENGTH
        ? `${col.DATA_TYPE}(${col.CHARACTER_MAXIMUM_LENGTH === -1 ? "max" : col.CHARACTER_MAXIMUM_LENGTH})`
        : col.DATA_TYPE;

      const flags = [
        col.IS_PK       === 1 || col.IS_PK === "YES" ? "PK" : "",
        col.IS_IDENTITY === 1 ? "IDENTITY" : "",
        col.IS_COMPUTED === 1 ? "COMPUTED" : "",
      ].filter(Boolean).join(" ");

      return [col.COLUMN_NAME, type, col.IS_NULLABLE === "YES" ? "YES" : "NO", flags, col.COLUMN_DEFAULT ?? ""];
    });

    const parts = [
      boxHeader(objectId, `${colResult.recordset.length} column(s)`),
      "",
      "COLUMNS",
      boxTable(["Column", "Type", "Nullable", "Flags", "Default"], colRows),
    ];

    if (fkResult.recordset.length > 0) {
      parts.push(
        "",
        "FOREIGN KEYS",
        boxTable(
          ["Column", "References"],
          fkResult.recordset.map((fk) => [fk.from_col, `${fk.to_table}.${fk.to_col}`])
        )
      );
    }

    if (ckResult.recordset.length > 0) {
      parts.push(
        "",
        "CHECK CONSTRAINTS",
        boxTable(
          ["Constraint", "Definition"],
          ckResult.recordset.map((ck) => [ck.constraint_name, ck.definition])
        )
      );
    }

    return { content: [{ type: "text", text: parts.join("\n") }] };
  }
);

// ── list_indexes ──────────────────────────────
server.tool(
  "list_indexes",
  "List all indexes of a table, including key columns and included columns",
  {
    table: z.string().describe("Table name (e.g. 'Produto' or 'dbo.Produto')"),
  },
  async ({ table }) => {
    const db = await getPool();

    let schema = "dbo";
    let tableName = table;
    if (table.includes(".")) [schema, tableName] = table.split(".", 2);

    const result = await db
      .request()
      .input("schema", sql.NVarChar, schema)
      .input("table",  sql.NVarChar, tableName)
      .query(`
        SELECT
          i.name                                                   AS index_name,
          i.type_desc                                              AS index_type,
          CASE WHEN i.is_unique       = 1 THEN 'YES' ELSE 'NO' END AS is_unique,
          CASE WHEN i.is_primary_key  = 1 THEN 'YES' ELSE 'NO' END AS is_pk,
          STUFF((
            SELECT ', ' + c2.name
            FROM sys.index_columns ic2
            JOIN sys.columns c2 ON ic2.object_id = c2.object_id AND ic2.column_id = c2.column_id
            WHERE ic2.object_id = i.object_id AND ic2.index_id = i.index_id
              AND ic2.is_included_column = 0
            ORDER BY ic2.key_ordinal
            FOR XML PATH(''), TYPE
          ).value('.', 'NVARCHAR(MAX)'), 1, 2, '')                  AS key_columns,
          STUFF((
            SELECT ', ' + c2.name
            FROM sys.index_columns ic2
            JOIN sys.columns c2 ON ic2.object_id = c2.object_id AND ic2.column_id = c2.column_id
            WHERE ic2.object_id = i.object_id AND ic2.index_id = i.index_id
              AND ic2.is_included_column = 1
            ORDER BY ic2.column_id
            FOR XML PATH(''), TYPE
          ).value('.', 'NVARCHAR(MAX)'), 1, 2, '')                  AS included_columns
        FROM sys.indexes i
        WHERE OBJECT_NAME(i.object_id)        = @table
          AND OBJECT_SCHEMA_NAME(i.object_id) = @schema
          AND i.type > 0
        ORDER BY i.is_primary_key DESC, i.is_unique DESC, i.name
      `);

    if (result.recordset.length === 0) {
      return {
        content: [{
          type: "text",
          text: boxHeader(`${schema}.${tableName}`, "no indexes") + "\n\nNo indexes found.",
        }],
      };
    }

    const rows = result.recordset.map((r) => [
      r.index_name,
      r.index_type,
      r.is_unique,
      r.is_pk,
      r.key_columns ?? "",
      r.included_columns ?? "",
    ]);

    const text = [
      boxHeader(`${schema}.${tableName}`, `${result.recordset.length} index(es)`),
      "",
      boxTable(["Name", "Type", "Unique", "PK", "Key Columns", "Included"], rows),
    ].join("\n");

    return { content: [{ type: "text", text }] };
  }
);

// ── table_stats ───────────────────────────────
server.tool(
  "table_stats",
  "Show row count, disk size, and dates for a table",
  {
    table: z.string().describe("Table name (e.g. 'Produto' or 'dbo.Produto')"),
  },
  async ({ table }) => {
    const db = await getPool();

    let schema = "dbo";
    let tableName = table;
    if (table.includes(".")) [schema, tableName] = table.split(".", 2);

    const result = await db
      .request()
      .input("schema", sql.NVarChar, schema)
      .input("table",  sql.NVarChar, tableName)
      .query(`
        SELECT
          SUM(p.rows)                                                    AS row_count,
          CAST(SUM(a.total_pages) * 8 / 1024.0 AS DECIMAL(10, 2))       AS total_mb,
          CAST(SUM(a.used_pages)  * 8 / 1024.0 AS DECIMAL(10, 2))       AS used_mb,
          CONVERT(VARCHAR(19), t.create_date,  120)                      AS created_at,
          CONVERT(VARCHAR(19), t.modify_date,  120)                      AS modified_at
        FROM sys.tables t
        JOIN sys.schemas     s ON t.schema_id = s.schema_id
        JOIN sys.indexes     i ON t.object_id = i.object_id   AND i.index_id IN (0, 1)
        JOIN sys.partitions  p ON i.object_id = p.object_id   AND i.index_id = p.index_id
        JOIN sys.allocation_units a ON p.partition_id = a.container_id
        WHERE t.name = @table AND s.name = @schema
        GROUP BY t.create_date, t.modify_date
      `);

    if (result.recordset.length === 0) {
      return {
        content: [{ type: "text", text: `Table "${schema}.${tableName}" not found.` }],
        isError: true,
      };
    }

    const r = result.recordset[0];
    const rows = [
      ["Rows",         r.row_count.toLocaleString()],
      ["Total size",   `${r.total_mb} MB`],
      ["Used size",    `${r.used_mb} MB`],
      ["Created",      r.created_at],
      ["Last altered", r.modified_at],
    ];

    const text = [
      boxHeader(`${schema}.${tableName}`, "stats"),
      "",
      boxTable(["Metric", "Value"], rows),
    ].join("\n");

    return { content: [{ type: "text", text }] };
  }
);

// ── find_columns ──────────────────────────────
server.tool(
  "find_columns",
  "Search for columns by name across all tables (useful to find where a field is used)",
  {
    column_name: z.string().describe("Column name or partial name to search for"),
  },
  async ({ column_name }) => {
    const db = await getPool();
    const result = await db
      .request()
      .input("col", sql.NVarChar, `%${column_name}%`)
      .query(`
        SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, DATA_TYPE
        FROM INFORMATION_SCHEMA.COLUMNS
        WHERE COLUMN_NAME LIKE @col
        ORDER BY TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME
      `);

    const rows = result.recordset.map((r) => [
      `${r.TABLE_SCHEMA}.${r.TABLE_NAME}`,
      r.COLUMN_NAME,
      r.DATA_TYPE,
    ]);

    const text = [
      boxHeader(`Search: "${column_name}"`, `${result.recordset.length} match(es)`),
      "",
      rows.length === 0 ? "No columns found." : boxTable(["Table", "Column", "Type"], rows),
    ].join("\n");

    return { content: [{ type: "text", text }] };
  }
);

// ── relationship_map ──────────────────────────
server.tool(
  "relationship_map",
  "Show all foreign key relationships in a schema — useful to understand the full data model",
  {
    schema: z.string().optional().default("dbo").describe("Schema to map (default: dbo)"),
  },
  async ({ schema }) => {
    const db = await getPool();

    const result = await db
      .request()
      .input("schema", sql.NVarChar, schema)
      .query(`
        SELECT
          OBJECT_NAME(fk.parent_object_id)                                                         AS from_table,
          COL_NAME(fkc.parent_object_id, fkc.parent_column_id)                                     AS from_col,
          OBJECT_SCHEMA_NAME(fk.referenced_object_id)                                              AS to_schema,
          OBJECT_NAME(fk.referenced_object_id)                                                     AS to_table,
          COL_NAME(fkc.referenced_object_id, fkc.referenced_column_id)                            AS to_col,
          fk.name                                                                                  AS constraint_name
        FROM sys.foreign_keys fk
        JOIN sys.foreign_key_columns fkc ON fk.object_id = fkc.constraint_object_id
        WHERE OBJECT_SCHEMA_NAME(fk.parent_object_id)      = @schema
           OR OBJECT_SCHEMA_NAME(fk.referenced_object_id)  = @schema
        ORDER BY from_table, to_table
      `);

    if (result.recordset.length === 0) {
      return {
        content: [{
          type: "text",
          text: boxHeader(`Schema: ${schema}`, "no relationships") + "\n\nNo foreign keys found.",
        }],
      };
    }

    // Group by from_table for a visual map
    const grouped = {};
    for (const r of result.recordset) {
      if (!grouped[r.from_table]) grouped[r.from_table] = [];
      grouped[r.from_table].push(r);
    }

    const sections = Object.entries(grouped).map(([fromTable, rels]) => {
      const lines = rels.map((r) => {
        const to = r.to_schema !== schema ? `${r.to_schema}.${r.to_table}` : r.to_table;
        return `  ${fromTable}.${r.from_col}  ──→  ${to}.${r.to_col}`;
      });
      return lines.join("\n");
    });

    const text = [
      boxHeader(`Relationship Map  ·  ${schema}`, `${result.recordset.length} FK(s)`),
      "",
      sections.join("\n"),
    ].join("\n");

    return { content: [{ type: "text", text }] };
  }
);

// ── list_procedures ───────────────────────────
server.tool(
  "list_procedures",
  "List stored procedures and functions in the database",
  {
    schema: z.string().optional().describe("Filter by schema (default: all schemas)"),
    type:   z.enum(["PROCEDURE", "FUNCTION", "ALL"]).optional().default("ALL")
              .describe("Filter by routine type"),
    name:   z.string().optional().describe("Filter by name (partial match)"),
  },
  async ({ schema, type, name }) => {
    const db = await getPool();

    let query = `
      SELECT
        ROUTINE_SCHEMA,
        ROUTINE_NAME,
        ROUTINE_TYPE,
        CONVERT(VARCHAR(10), CREATED,      120) AS created,
        CONVERT(VARCHAR(10), LAST_ALTERED, 120) AS last_altered
      FROM INFORMATION_SCHEMA.ROUTINES
      WHERE ROUTINE_TYPE IN ('PROCEDURE', 'FUNCTION')
    `;
    const request = db.request();

    if (schema) {
      query += ` AND ROUTINE_SCHEMA = @schema`;
      request.input("schema", sql.NVarChar, schema);
    }
    if (type && type !== "ALL") {
      query += ` AND ROUTINE_TYPE = @type`;
      request.input("type", sql.NVarChar, type);
    }
    if (name) {
      query += ` AND ROUTINE_NAME LIKE @name`;
      request.input("name", sql.NVarChar, `%${name}%`);
    }

    query += ` ORDER BY ROUTINE_SCHEMA, ROUTINE_TYPE, ROUTINE_NAME`;

    const result = await request.query(query);

    const rows = result.recordset.map((r) => [
      r.ROUTINE_SCHEMA,
      r.ROUTINE_NAME,
      r.ROUTINE_TYPE,
      r.created,
      r.last_altered,
    ]);

    const text = [
      boxHeader(`Procedures & Functions`, `${result.recordset.length} found`),
      "",
      rows.length === 0
        ? "No procedures or functions found."
        : boxTable(["Schema", "Name", "Type", "Created", "Modified"], rows),
    ].join("\n");

    return { content: [{ type: "text", text }] };
  }
);

// ── query ─────────────────────────────────────
const queryToolDescription = isReadOnly
  ? "Execute a read-only SQL query (SELECT only). Write operations are blocked."
  : `Execute a SQL query. Allowed write operations: ${allowedWriteOps.join(", ")}. ` +
    `Always blocked: ${ALWAYS_BLOCKED.filter((k) => !k.endsWith("_")).join(", ")}, xp_*, sp_*.`;

server.tool(
  "query",
  queryToolDescription,
  {
    sql: z.string().describe("The SQL query to execute"),
    max_rows: z
      .number()
      .optional()
      .default(100)
      .describe("Maximum rows to return for SELECT queries (default 100, max 1000)"),
  },
  async ({ sql: userSql, max_rows }) => {
    // 1 — keyword safety check
    const check = isSafeQuery(userSql);
    if (!check.safe) {
      const permanent = ALWAYS_BLOCKED.some(
        (k) =>
          k.toUpperCase() === check.keyword.toUpperCase() ||
          check.keyword.toUpperCase().startsWith(k.toUpperCase())
      );
      const hint = permanent
        ? "This operation is permanently blocked for security reasons."
        : `To enable this operation, add "${check.keyword}" to DB_ALLOW_WRITE in the server config.`;

      return {
        content: [{ type: "text", text: `BLOCKED: "${check.keyword}" is not allowed.\n${hint}` }],
        isError: true,
      };
    }

    // 2 — table restriction check (only for write queries)
    if (isWriteQuery(userSql)) {
      const target = extractWriteTarget(userSql);
      if (target) {
        const check = isTableAllowed(target);
        if (!check.allowed) {
          return {
            content: [{ type: "text", text: `BLOCKED: ${check.reason}` }],
            isError: true,
          };
        }
      }
    }

    const limit = Math.min(max_rows || 100, 1000);
    const db    = await getPool();

    try {
      let result;

      if (isWriteQuery(userSql)) {
        // Write — execute inside a transaction for atomicity + log to stderr
        const transaction = new sql.Transaction(db);
        await transaction.begin();
        try {
          const req = new sql.Request(transaction);
          req.timeout = 30000;
          result = await req.query(userSql);
          await transaction.commit();

          const target   = extractWriteTarget(userSql) ?? "unknown";
          const affected = result.rowsAffected?.[0] ?? 0;
          const ts       = new Date().toISOString().replace("T", " ").slice(0, 19);
          process.stderr.write(
            `[${ts}] WRITE  ${userSql.trim().split(/\s/)[0].toUpperCase()} → ${target}  (${affected} row(s) affected)\n`
          );

          return {
            content: [{ type: "text", text: boxHeader("Query OK", `${affected} row(s) affected`) }],
          };
        } catch (err) {
          await transaction.rollback();
          throw err;
        }
      } else {
        // Read
        const req = db.request();
        req.timeout = 30000;
        result = await req.query(userSql);
      }

      if (!result.recordset || result.recordset.length === 0) {
        return {
          content: [{ type: "text", text: boxHeader("Query Result", "0 rows") + "\n\nNo rows returned." }],
        };
      }

      const rows    = result.recordset.slice(0, limit);
      const columns = Object.keys(rows[0]);
      const tableRows = rows.map((row) =>
        columns.map((c) => {
          const val = row[c];
          if (val === null)           return "NULL";
          if (val instanceof Date)    return val.toISOString();
          return String(val);
        })
      );

      const limited  = result.recordset.length > limit;
      const subtitle = limited
        ? `${rows.length} of ${result.recordset.length} row(s)  ·  limited to ${limit}`
        : `${rows.length} row(s)`;

      const text = [
        boxHeader("Query Result", subtitle),
        "",
        boxTable(columns, tableRows),
      ].join("\n");

      return { content: [{ type: "text", text }] };
    } catch (err) {
      return {
        content: [{ type: "text", text: `SQL Error: ${err.message}` }],
        isError: true,
      };
    }
  }
);

// ── permissions ───────────────────────────────
server.tool(
  "permissions",
  "Show the current permission mode: allowed/blocked operations, table and schema restrictions",
  {},
  async () => {
    const allowed       = ["SELECT", ...allowedWriteOps];
    const blockedWrite  = WRITE_KEYWORDS.filter((k) => !allowedWriteOps.includes(k));
    const alwaysDisplay = ALWAYS_BLOCKED.map((k) => (k.endsWith("_") ? `${k}*` : k));

    const modeLabel = isReadOnly ? "READ-ONLY" : "READ-WRITE";

    const opRows = [
      ...allowed.map((k)       => ["✓", k, "allowed"]),
      ...blockedWrite.map((k)  => ["✗", k, "blocked  (enable via DB_ALLOW_WRITE)"]),
      ...alwaysDisplay.map((k) => ["✗", k, "permanently blocked"]),
    ];

    const parts = [
      boxHeader(`Permissions  ·  ${modeLabel}`),
      "",
      "OPERATIONS",
      boxTable(["", "Operation", "Status"], opRows),
    ];

    if (allowedSchemas.length > 0 || allowedTables.length > 0) {
      parts.push("", "WRITE RESTRICTIONS");
      if (allowedSchemas.length > 0) {
        parts.push(
          boxTable(["Restriction", "Values"], [["Allowed schemas", allowedSchemas.join(", ")]])
        );
      }
      if (allowedTables.length > 0) {
        parts.push(
          boxTable(["Restriction", "Values"], [["Allowed tables", allowedTables.join(", ")]])
        );
      }
    }

    return { content: [{ type: "text", text: parts.join("\n") }] };
  }
);

// ─────────────────────────────────────────────
// START
// ─────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
