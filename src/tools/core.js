import { z } from "zod";
import { findCatalogTable } from "../db/catalog-loader.js";
import {
  textResponse,
  section,
  markdownTable,
  keyValueTable,
  formatList,
} from "../utils/formatting.js";
import { quoteIdentifier } from "../utils/text.js";
import { validateQueryText } from "../security/sql-validator.js";

function paginateRows(rows, page, pageSize) {
  const safePage = Math.max(1, page || 1);
  const safePageSize = Math.max(1, Math.min(1000, pageSize || 100));
  const offset = (safePage - 1) * safePageSize;
  const items = rows.slice(offset, offset + safePageSize);

  return {
    rows: items,
    page: safePage,
    pageSize: safePageSize,
    totalRows: rows.length,
    totalPages: Math.max(1, Math.ceil(rows.length / safePageSize)),
    hasNextPage: offset + safePageSize < rows.length,
  };
}

function renderQueryResult(result, page, pageSize) {
  if (!result.recordset || result.recordset.length === 0) {
    return textResponse("## Query Result\nNo rows returned.");
  }

  const pagination = paginateRows(result.recordset, page, pageSize);
  const columns = Object.keys(pagination.rows[0] || result.recordset[0]);
  const rows = pagination.rows.map((row) =>
    columns.map((column) => {
      const value = row[column];
      if (value === null) return "NULL";
      if (value instanceof Date) return value.toISOString();
      return String(value);
    })
  );

  const summary = [
    `Rows returned: ${pagination.totalRows}`,
    `Page: ${pagination.page}/${pagination.totalPages}`,
    `Page size: ${pagination.pageSize}`,
    pagination.hasNextPage
      ? `Next page available: ${pagination.page + 1}`
      : "Next page available: no",
  ];

  return textResponse(
    [section("Query Result", summary), "", markdownTable(columns, rows)].join("\n")
  );
}

function summarizeResultRows(rows) {
  if (rows.length === 0) {
    return ["No data returned."];
  }

  const columns = Object.keys(rows[0]);
  const numericColumns = columns.filter((column) =>
    rows.some((row) => typeof row[column] === "number")
  );

  const lines = [
    `Returned ${rows.length} row(s) with ${columns.length} column(s).`,
    `Columns: ${columns.join(", ")}`,
  ];

  for (const column of numericColumns.slice(0, 3)) {
    const values = rows
      .map((row) => row[column])
      .filter((value) => typeof value === "number");
    lines.push(`${column}: min ${Math.min(...values)}, max ${Math.max(...values)}`);
  }

  return lines;
}

export function registerCoreTools(server, context) {
  server.tool("list_schemas", "List all schemas in the database", {}, async () => {
    const catalog = await context.catalogCache.getCatalog();
    return textResponse(
      [
        section("Schemas", [
          `Database: ${catalog.database}`,
          `Total schemas: ${catalog.schemas.length}`,
        ]),
        "",
        formatList(catalog.schemas),
      ].join("\n")
    );
  });

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
      const catalog = await context.catalogCache.getCatalog();
      const tables = catalog.tables.filter((table) => !schema || table.schema === schema);
      const grouped = new Map();

      for (const table of tables) {
        if (!grouped.has(table.schema)) grouped.set(table.schema, []);
        grouped.get(table.schema).push(table);
      }

      const blocks = [];
      for (const [schemaName, items] of grouped.entries()) {
        blocks.push(
          section(schemaName, [
            `Tables: ${items.filter((item) => item.type === "BASE TABLE").length}`,
            `Views: ${items.filter((item) => item.type === "VIEW").length}`,
            "",
            ...items.map((item) => `${item.type === "VIEW" ? "[view]" : "[table]"} ${item.name}`),
          ])
        );
      }

      return textResponse(blocks.join("\n\n"));
    }
  );

  server.tool(
    "find_tables",
    "Search for tables and views by name (partial match)",
    {
      name: z.string().describe("Table name or partial name to search for"),
      schema: z.string().optional().describe("Restrict search to a specific schema"),
    },
    async ({ name, schema }) => {
      const catalog = await context.catalogCache.getCatalog();
      const normalized = name.toLowerCase();
      const rows = catalog.tables
        .filter(
          (table) =>
            (!schema || table.schema === schema) &&
            table.name.toLowerCase().includes(normalized)
        )
        .map((table) => [table.schema, table.name, table.type, table.description || ""]);

      return textResponse(
        rows.length === 0
          ? "## Table Search\nNo tables found."
          : [
              section("Table Search", [`Matches: ${rows.length}`]),
              "",
              markdownTable(["Schema", "Name", "Type", "Description"], rows),
            ].join("\n")
      );
    }
  );

  server.tool(
    "describe_table",
    "Show columns, data types, primary keys, foreign keys, check constraints, and identity/computed info of a table",
    {
      table: z.string().describe("Table name (e.g. 'Produto' or 'dbo.Produto')"),
    },
    async ({ table }) => {
      const catalog = await context.catalogCache.getCatalog();
      const item = findCatalogTable(catalog, table);

      if (!item) return textResponse(`Table "${table}" not found.`, true);

      const columnRows = item.columns.map((column) => [
        column.name,
        column.maxLength
          ? `${column.dataType}(${column.maxLength === -1 ? "max" : column.maxLength})`
          : column.dataType,
        column.isNullable ? "YES" : "NO",
        [
          column.isPrimaryKey ? "PK" : "",
          column.isIdentity ? "IDENTITY" : "",
          column.isComputed ? "COMPUTED" : "",
        ]
          .filter(Boolean)
          .join(" "),
        column.description || "",
        column.defaultValue || "",
      ]);

      const sections = [
        section(item.fullName, [
          `Type: ${item.type}`,
          `Columns: ${item.columns.length}`,
          `Description: ${item.description || "n/a"}`,
          `Centrality: ${item.centrality || 0}`,
        ]),
        "",
        markdownTable(
          ["Column", "Type", "Nullable", "Flags", "Description", "Default"],
          columnRows
        ),
      ];

      if (item.foreignKeys.length > 0) {
        sections.push(
          "",
          section("Foreign Keys", [
            markdownTable(
              ["Column", "References", "Constraint"],
              item.foreignKeys.map((fk) => [
                fk.fromColumn,
                `${fk.toFullName}.${fk.toColumn}`,
                fk.constraintName,
              ])
            ),
          ])
        );
      }

      if (item.checks.length > 0) {
        sections.push(
          "",
          section("Check Constraints", [
            markdownTable(
              ["Name", "Definition"],
              item.checks.map((check) => [check.name, check.definition])
            ),
          ])
        );
      }

      return textResponse(sections.join("\n"));
    }
  );

  server.tool(
    "list_indexes",
    "List all indexes of a table, including key columns and included columns",
    {
      table: z.string().describe("Table name (e.g. 'Produto' or 'dbo.Produto')"),
    },
    async ({ table }) => {
      const catalog = await context.catalogCache.getCatalog();
      const item = findCatalogTable(catalog, table);

      if (!item) return textResponse(`Table "${table}" not found.`, true);
      if (item.indexes.length === 0) return textResponse(`## ${item.fullName}\nNo indexes found.`);

      return textResponse(
        [
          section(item.fullName, [`Indexes: ${item.indexes.length}`]),
          "",
          markdownTable(
            ["Name", "Type", "Unique", "PK", "Key Columns", "Included Columns"],
            item.indexes.map((index) => [
              index.name,
              index.type,
              index.isUnique ? "YES" : "NO",
              index.isPrimaryKey ? "YES" : "NO",
              index.keyColumns.join(", "),
              index.includedColumns.join(", "),
            ])
          ),
        ].join("\n")
      );
    }
  );

  server.tool(
    "table_stats",
    "Show row count, disk size, and dates for a table",
    {
      table: z.string().describe("Table name (e.g. 'Produto' or 'dbo.Produto')"),
    },
    async ({ table }) => {
      const catalog = await context.catalogCache.getCatalog();
      const item = findCatalogTable(catalog, table);

      if (!item) return textResponse(`Table "${table}" not found.`, true);

      const [schema, name] = item.fullName.split(".");
      const result = await context.db.query(
        `
        SELECT
          SUM(p.rows) AS row_count,
          CAST(SUM(a.total_pages) * 8 / 1024.0 AS DECIMAL(10, 2)) AS total_mb,
          CAST(SUM(a.used_pages) * 8 / 1024.0 AS DECIMAL(10, 2)) AS used_mb,
          CONVERT(VARCHAR(19), t.create_date, 120) AS created_at,
          CONVERT(VARCHAR(19), t.modify_date, 120) AS modified_at
        FROM sys.tables t
        JOIN sys.schemas s ON t.schema_id = s.schema_id
        JOIN sys.indexes i ON t.object_id = i.object_id AND i.index_id IN (0, 1)
        JOIN sys.partitions p ON i.object_id = p.object_id AND i.index_id = p.index_id
        JOIN sys.allocation_units a ON p.partition_id = a.container_id
        WHERE t.name = @table AND s.name = @schema
        GROUP BY t.create_date, t.modify_date
      `,
        [
          { name: "schema", type: context.db.sql.NVarChar, value: schema },
          { name: "table", type: context.db.sql.NVarChar, value: name },
        ]
      );

      const row = result.recordset[0];
      if (!row) return textResponse(`Table "${item.fullName}" not found.`, true);

      return textResponse(
        section(
          item.fullName,
          keyValueTable([
            ["Rows", Number(row.row_count || 0).toLocaleString()],
            ["Total size", `${row.total_mb} MB`],
            ["Used size", `${row.used_mb} MB`],
            ["Created", row.created_at],
            ["Modified", row.modified_at],
          ]).split("\n")
        )
      );
    }
  );

  server.tool(
    "find_columns",
    "Search for columns by name across all tables (useful to find where a field is used)",
    {
      column_name: z.string().describe("Column name or partial name to search for"),
    },
    async ({ column_name }) => {
      const catalog = await context.catalogCache.getCatalog();
      const normalized = column_name.toLowerCase();
      const rows = [];

      for (const table of catalog.tables) {
        for (const column of table.columns) {
          if (column.name.toLowerCase().includes(normalized)) {
            rows.push([table.fullName, column.name, column.dataType, column.description || ""]);
          }
        }
      }

      return textResponse(
        rows.length === 0
          ? "## Column Search\nNo columns found."
          : [
              section("Column Search", [`Matches: ${rows.length}`]),
              "",
              markdownTable(["Table", "Column", "Type", "Description"], rows),
            ].join("\n")
      );
    }
  );

  server.tool(
    "relationship_map",
    "Show all foreign key relationships in a schema - useful to understand the full data model",
    {
      schema: z.string().optional().default("dbo").describe("Schema to map (default: dbo)"),
    },
    async ({ schema }) => {
      const catalog = await context.catalogCache.getCatalog();
      const rows = catalog.tables
        .filter(
          (table) =>
            table.schema === schema ||
            table.foreignKeys.some((fk) => fk.toSchema === schema)
        )
        .flatMap((table) =>
          table.foreignKeys.map((fk) => [
            `${table.fullName}.${fk.fromColumn}`,
            `${fk.toFullName}.${fk.toColumn}`,
            fk.constraintName,
          ])
        );

      return textResponse(
        rows.length === 0
          ? `## Relationship Map\nNo foreign keys found for schema "${schema}".`
          : [
              section(`Relationship Map: ${schema}`, [`Relationships: ${rows.length}`]),
              "",
              markdownTable(["From", "To", "Constraint"], rows),
            ].join("\n")
      );
    }
  );

  server.tool(
    "list_procedures",
    "List stored procedures and functions in the database",
    {
      schema: z.string().optional().describe("Filter by schema (default: all schemas)"),
      type: z.enum(["PROCEDURE", "FUNCTION", "ALL"]).optional().default("ALL").describe("Filter by routine type"),
      name: z.string().optional().describe("Filter by name (partial match)"),
    },
    async ({ schema, type, name }) => {
      const catalog = await context.catalogCache.getCatalog();
      const rows = catalog.routines
        .filter((routine) => (!schema || routine.schema === schema))
        .filter((routine) => type === "ALL" || routine.type === type)
        .filter((routine) => !name || routine.name.toLowerCase().includes(name.toLowerCase()))
        .map((routine) => [
          routine.schema,
          routine.name,
          routine.type,
          routine.createdAt,
          routine.modifiedAt,
        ]);

      return textResponse(
        rows.length === 0
          ? "## Procedures & Functions\nNo routines found."
          : [
              section("Procedures & Functions", [`Found: ${rows.length}`]),
              "",
              markdownTable(["Schema", "Name", "Type", "Created", "Modified"], rows),
            ].join("\n")
      );
    }
  );

  server.tool(
    "query",
    context.appConfig.permissions.isReadOnly
      ? "Execute a read-only SQL query (SELECT only). Write operations are blocked."
      : `Execute a SQL query. Allowed write operations: ${context.appConfig.permissions.allowedWriteOps.join(", ")}.`,
    {
      sql: z.string().describe("The SQL query to execute"),
      max_rows: z.number().optional().default(context.appConfig.runtime.defaultMaxRows).describe("Maximum rows to consider before pagination (default 100, max 1000)"),
      page: z.number().optional().default(1).describe("Result page number (default 1)"),
      page_size: z.number().optional().default(50).describe("Rows per page in the rendered response (default 50, max 1000)"),
    },
    async ({ sql, max_rows, page, page_size }) => {
      const validation = validateQueryText(sql, context.appConfig.permissions);
      if (!validation.ok) {
        return textResponse(
          [
            section("Query Blocked", [
              `Reason: ${validation.reason}`,
              `Operation: ${validation.operation}`,
              `Risk: ${validation.risk}`,
              `Tables: ${validation.tables.join(", ") || "n/a"}`,
            ]),
            "",
            ...(validation.warnings.length
              ? [section("Warnings", validation.warnings)]
              : []),
          ].join("\n"),
          true
        );
      }

      const limit = Math.min(
        max_rows || context.appConfig.runtime.defaultMaxRows,
        context.appConfig.runtime.maxRowsCap
      );

      try {
        if (validation.isWrite) {
          const pool = await context.db.getPool();
          const transaction = new context.db.sql.Transaction(pool);
          await transaction.begin();

          try {
            const request = new context.db.sql.Request(transaction);
            request.timeout = context.appConfig.runtime.queryTimeoutMs;
            const result = await request.query(sql);
            await transaction.commit();

            return textResponse(
              [
                section("Query OK", [
                  `Operation: ${validation.operation}`,
                  `Rows affected: ${result.rowsAffected?.[0] || 0}`,
                  `Tables: ${validation.tables.join(", ") || "unknown"}`,
                ]),
                "",
                ...(validation.warnings.length
                  ? [section("Warnings", validation.warnings)]
                  : []),
              ].join("\n")
            );
          } catch (error) {
            await transaction.rollback();
            throw error;
          }
        }

        const result = await context.db.query(sql);
        if (result.recordset.length > limit) {
          result.recordset = result.recordset.slice(0, limit);
        }

        const rendered = renderQueryResult(result, page, page_size);
        if (!validation.warnings.length) return rendered;

        return textResponse(
          [rendered.content[0].text, "", section("Warnings", validation.warnings)].join("\n")
        );
      } catch (error) {
        return textResponse(`SQL Error: ${error.message}`, true);
      }
    }
  );

  server.tool(
    "permissions",
    "Show the current permission mode: allowed/blocked operations, table and schema restrictions",
    {},
    async () => {
      const permissions = context.appConfig.permissions;
      const rows = [
        ...["SELECT", ...permissions.allowedWriteOps].map((item) => [item, "allowed"]),
        ...permissions.writeKeywords
          .filter((item) => !permissions.allowedWriteOps.includes(item))
          .map((item) => [item, "blocked"]),
        ...permissions.alwaysBlocked.map((item) => [
          item.endsWith("_") ? `${item}*` : item,
          "permanently blocked",
        ]),
      ];

      const extra = [];
      if (permissions.allowedSchemas.length > 0) extra.push(`Allowed schemas: ${permissions.allowedSchemas.join(", ")}`);
      if (permissions.allowedTables.length > 0) extra.push(`Allowed tables: ${permissions.allowedTables.join(", ")}`);

      return textResponse(
        [
          section("Permissions", [`Mode: ${permissions.mode}`, ...extra]),
          "",
          markdownTable(["Operation", "Status"], rows),
        ].join("\n")
      );
    }
  );

  server.tool(
    "sample_values",
    "Return sample distinct values for one or more columns of a table",
    {
      table: z.string().describe("Table name (e.g. 'Produto' or 'dbo.Produto')"),
      columns: z.array(z.string()).optional().describe("Specific columns to sample"),
      limit: z.number().optional().default(context.appConfig.runtime.defaultSampleSize).describe("Maximum values per column"),
    },
    async ({ table, columns, limit }) => {
      const catalog = await context.catalogCache.getCatalog();
      const item = findCatalogTable(catalog, table);

      if (!item) return textResponse(`Table "${table}" not found.`, true);

      const chosenColumns = (
        columns?.length ? columns : item.columns.slice(0, 5).map((column) => column.name)
      ).filter((column) => item.columns.some((candidate) => candidate.name === column));

      if (chosenColumns.length === 0) return textResponse("No valid columns selected.", true);

      const statements = chosenColumns.map(
        (column) => `
          SELECT DISTINCT TOP ${Math.max(1, Math.min(limit, 20))}
            '${column}' AS sampled_column,
            CONVERT(NVARCHAR(4000), ${quoteIdentifier(column)}) AS sampled_value
          FROM ${quoteIdentifier(item.schema)}.${quoteIdentifier(item.name)}
          WHERE ${quoteIdentifier(column)} IS NOT NULL
        `
      );

      try {
        const result = await context.db.query(statements.join(" UNION ALL "));
        const grouped = new Map();
        for (const row of result.recordset) {
          if (!grouped.has(row.sampled_column)) grouped.set(row.sampled_column, []);
          grouped.get(row.sampled_column).push(row.sampled_value);
        }

        const sections = [];
        for (const [column, values] of grouped.entries()) {
          sections.push(section(column, values.map((value) => `- ${value}`)));
        }

        return textResponse(
          [
            section(item.fullName, [`Sampled columns: ${chosenColumns.join(", ")}`]),
            "",
            sections.join("\n\n"),
          ].join("\n")
        );
      } catch (error) {
        return textResponse(`SQL Error: ${error.message}`, true);
      }
    }
  );

  server.tool(
    "query_with_explanation",
    "Execute a read query and return both rows and a short interpretation",
    {
      sql: z.string().describe("The SQL query to execute"),
      max_rows: z.number().optional().default(50).describe("Maximum rows to analyze"),
    },
    async ({ sql, max_rows }) => {
      const validation = validateQueryText(sql, context.appConfig.permissions);
      if (!validation.ok) return textResponse(`Query blocked: ${validation.reason}`, true);
      if (validation.isWrite) return textResponse("query_with_explanation only supports read queries.", true);

      try {
        const result = await context.db.query(sql);
        const rows = result.recordset.slice(0, Math.min(max_rows, 200));
        const explanation = summarizeResultRows(rows);
        const rendered = renderQueryResult({ recordset: rows }, 1, Math.min(25, max_rows));
        return textResponse(
          [section("Explanation", explanation), "", rendered.content[0].text].join("\n")
        );
      } catch (error) {
        return textResponse(`SQL Error: ${error.message}`, true);
      }
    }
  );
}
