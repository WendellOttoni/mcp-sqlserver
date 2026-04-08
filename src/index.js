#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import sql from "mssql";
import { z } from "zod";

// --- Connection config from environment variables ---
// Supports named instances: "LAPTOP\SQLEXPRESS" or "LAPTOP/SQLEXPRESS"
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
  pool: {
    max: 5,
    min: 0,
    idleTimeoutMillis: 30000,
  },
};

// Only set port if no named instance (named instances use SQL Browser for port)
if (!instanceName) {
  config.port = parseInt(process.env.DB_PORT || "1433");
}

// Use Windows Auth if no user/password provided
if (!config.user) {
  delete config.user;
  delete config.password;
  config.authentication = { type: "ntlm", options: { domain: "" } };
}

// --- Blocked keywords for safety ---
const BLOCKED_KEYWORDS = [
  "INSERT",
  "UPDATE",
  "DELETE",
  "DROP",
  "ALTER",
  "CREATE",
  "TRUNCATE",
  "EXEC",
  "EXECUTE",
  "MERGE",
  "GRANT",
  "REVOKE",
  "DENY",
  "BACKUP",
  "RESTORE",
  "SHUTDOWN",
  "DBCC",
  "BULK",
  "OPENROWSET",
  "OPENDATASOURCE",
  "xp_",
  "sp_",
];

function isSafeQuery(query) {
  const upper = query.toUpperCase().replace(/\s+/g, " ").trim();
  for (const keyword of BLOCKED_KEYWORDS) {
    const regex = new RegExp(`(^|\\s|;)${keyword}(\\s|;|$)`, "i");
    if (regex.test(upper)) {
      return { safe: false, keyword };
    }
  }
  return { safe: true };
}

// --- Pool management ---
let pool = null;

async function getPool() {
  if (!pool) {
    pool = await sql.connect(config);
  }
  return pool;
}

// --- MCP Server ---
const server = new McpServer({
  name: "mcp-sqlserver",
  version: "1.0.0",
});

// Tool: list_tables
server.tool(
  "list_tables",
  "List all tables and views in the database, grouped by schema",
  {
    schema: z
      .string()
      .optional()
      .describe("Filter by schema name (e.g. 'dbo'). Leave empty for all."),
  },
  async ({ schema }) => {
    const db = await getPool();
    let query = `
      SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE
      FROM INFORMATION_SCHEMA.TABLES
    `;
    if (schema) {
      query += ` WHERE TABLE_SCHEMA = @schema`;
    }
    query += ` ORDER BY TABLE_SCHEMA, TABLE_NAME`;

    const request = db.request();
    if (schema) request.input("schema", sql.NVarChar, schema);
    const result = await request.query(query);

    const grouped = {};
    for (const row of result.recordset) {
      const s = row.TABLE_SCHEMA;
      if (!grouped[s]) grouped[s] = [];
      grouped[s].push(`${row.TABLE_NAME} (${row.TABLE_TYPE})`);
    }

    let text = `Database: ${config.database}\n\n`;
    for (const [s, tables] of Object.entries(grouped)) {
      text += `[${s}]\n`;
      for (const t of tables) text += `  ${t}\n`;
      text += "\n";
    }
    text += `Total: ${result.recordset.length} tables/views`;

    return { content: [{ type: "text", text }] };
  }
);

// Tool: describe_table
server.tool(
  "describe_table",
  "Show columns, data types, primary keys, and foreign keys of a table",
  {
    table: z.string().describe("Table name (e.g. 'Produto' or 'dbo.Produto')"),
  },
  async ({ table }) => {
    const db = await getPool();

    // Parse schema.table
    let schema = "dbo";
    let tableName = table;
    if (table.includes(".")) {
      [schema, tableName] = table.split(".", 2);
    }

    // Columns
    const colResult = await db
      .request()
      .input("schema", sql.NVarChar, schema)
      .input("table", sql.NVarChar, tableName).query(`
        SELECT
          c.COLUMN_NAME,
          c.DATA_TYPE,
          c.CHARACTER_MAXIMUM_LENGTH,
          c.IS_NULLABLE,
          c.COLUMN_DEFAULT,
          CASE WHEN pk.COLUMN_NAME IS NOT NULL THEN 'YES' ELSE 'NO' END AS IS_PK
        FROM INFORMATION_SCHEMA.COLUMNS c
        LEFT JOIN (
          SELECT ku.COLUMN_NAME
          FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
          JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE ku
            ON tc.CONSTRAINT_NAME = ku.CONSTRAINT_NAME
          WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY'
            AND tc.TABLE_SCHEMA = @schema
            AND tc.TABLE_NAME = @table
        ) pk ON pk.COLUMN_NAME = c.COLUMN_NAME
        WHERE c.TABLE_SCHEMA = @schema AND c.TABLE_NAME = @table
        ORDER BY c.ORDINAL_POSITION
      `);

    // Foreign keys
    const fkResult = await db
      .request()
      .input("schema", sql.NVarChar, schema)
      .input("table", sql.NVarChar, tableName).query(`
        SELECT
          COL_NAME(fc.parent_object_id, fc.parent_column_id) AS Column_Name,
          OBJECT_SCHEMA_NAME(fc.referenced_object_id) + '.' + OBJECT_NAME(fc.referenced_object_id) AS Referenced_Table,
          COL_NAME(fc.referenced_object_id, fc.referenced_column_id) AS Referenced_Column
        FROM sys.foreign_key_columns fc
        JOIN sys.objects o ON o.object_id = fc.parent_object_id
        WHERE OBJECT_SCHEMA_NAME(o.object_id) = @schema
          AND o.name = @table
      `);

    let text = `Table: ${schema}.${tableName}\n\n`;
    text += "COLUMNS:\n";
    text += "Name | Type | Nullable | PK | Default\n";
    text += "-----|------|----------|----|--------\n";
    for (const col of colResult.recordset) {
      const type = col.CHARACTER_MAXIMUM_LENGTH
        ? `${col.DATA_TYPE}(${col.CHARACTER_MAXIMUM_LENGTH})`
        : col.DATA_TYPE;
      text += `${col.COLUMN_NAME} | ${type} | ${col.IS_NULLABLE} | ${col.IS_PK} | ${col.COLUMN_DEFAULT || ""}\n`;
    }

    if (fkResult.recordset.length > 0) {
      text += "\nFOREIGN KEYS:\n";
      text += "Column | References\n";
      text += "-------|----------\n";
      for (const fk of fkResult.recordset) {
        text += `${fk.Column_Name} | ${fk.Referenced_Table}.${fk.Referenced_Column}\n`;
      }
    }

    return { content: [{ type: "text", text }] };
  }
);

// Tool: query
server.tool(
  "query",
  "Execute a read-only SQL query (SELECT only). INSERT/UPDATE/DELETE/DROP are blocked.",
  {
    sql: z.string().describe("The SQL SELECT query to execute"),
    max_rows: z
      .number()
      .optional()
      .default(100)
      .describe("Maximum rows to return (default 100, max 1000)"),
  },
  async ({ sql: userSql, max_rows }) => {
    const check = isSafeQuery(userSql);
    if (!check.safe) {
      return {
        content: [
          {
            type: "text",
            text: `BLOCKED: Query contains forbidden keyword "${check.keyword}". Only SELECT queries are allowed.`,
          },
        ],
        isError: true,
      };
    }

    const limit = Math.min(max_rows || 100, 1000);
    const db = await getPool();

    try {
      const result = await db.request().query(userSql);
      const rows = result.recordset.slice(0, limit);

      let text = "";
      if (rows.length === 0) {
        text = "Query returned 0 rows.";
      } else {
        const columns = Object.keys(rows[0]);
        text += columns.join(" | ") + "\n";
        text += columns.map(() => "---").join(" | ") + "\n";
        for (const row of rows) {
          text +=
            columns
              .map((c) => {
                const val = row[c];
                if (val === null) return "NULL";
                if (val instanceof Date) return val.toISOString();
                return String(val);
              })
              .join(" | ") + "\n";
        }
        text += `\n${rows.length} row(s)`;
        if (result.recordset.length > limit) {
          text += ` (limited from ${result.recordset.length})`;
        }
      }

      return { content: [{ type: "text", text }] };
    } catch (err) {
      return {
        content: [{ type: "text", text: `SQL Error: ${err.message}` }],
        isError: true,
      };
    }
  }
);

// Tool: list_schemas
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
    return {
      content: [
        {
          type: "text",
          text: `Schemas in ${config.database}:\n${schemas.map((s) => `  - ${s}`).join("\n")}`,
        },
      ],
    };
  }
);

// Tool: find_columns
server.tool(
  "find_columns",
  "Search for columns by name across all tables (useful to find where a field is used)",
  {
    column_name: z
      .string()
      .describe("Column name or partial name to search for"),
  },
  async ({ column_name }) => {
    const db = await getPool();
    const result = await db
      .request()
      .input("col", sql.NVarChar, `%${column_name}%`).query(`
        SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, DATA_TYPE
        FROM INFORMATION_SCHEMA.COLUMNS
        WHERE COLUMN_NAME LIKE @col
        ORDER BY TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME
      `);

    let text = `Columns matching "${column_name}":\n\n`;
    for (const row of result.recordset) {
      text += `${row.TABLE_SCHEMA}.${row.TABLE_NAME}.${row.COLUMN_NAME} (${row.DATA_TYPE})\n`;
    }
    text += `\n${result.recordset.length} match(es)`;

    return { content: [{ type: "text", text }] };
  }
);

// --- Start server ---
const transport = new StdioServerTransport();
await server.connect(transport);
