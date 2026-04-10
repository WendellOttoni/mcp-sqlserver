import { z } from "zod";
import { findCatalogTable } from "../db/catalog-loader.js";
import { shortestJoinPath } from "../graph/relationship-graph.js";
import { findEntities } from "../search/ranker.js";
import {
  textResponse,
  section,
  markdownTable,
  formatList,
} from "../utils/formatting.js";
import { validateQueryText } from "../security/sql-validator.js";

function parsePathResult(path, catalog) {
  if (!path) return null;

  const lines = [];
  for (let index = 1; index < path.length; index += 1) {
    const step = path[index];
    const previous = path[index - 1];
    const previousTable = typeof previous === "string" ? previous : previous.table;
    lines.push(
      `${previousTable} -> ${step.table} on ${step.via.fromColumn} = ${step.via.toColumn}`
    );
  }

  return {
    lines,
    tables: path.map((item) => (typeof item === "string" ? item : item.table)),
    confidence: Math.max(0.2, 1 - (path.length - 2) * 0.2),
    centralTables: path.map((item) => {
      const name = typeof item === "string" ? item : item.table;
      const table = catalog.tableMap.get(name.toLowerCase());
      return table ? `${table.fullName} (centrality ${table.centrality})` : name;
    }),
  };
}

function suggestColumns(table) {
  const columns = table.columns.map((column) => column.name);
  const interesting = columns.filter((name) =>
    /(id|codigo|nome|descricao|data|valor|status|total)/i.test(name)
  );
  return (interesting.length ? interesting : columns).slice(0, 6);
}

function buildQuerySkeleton(pathInfo, catalog) {
  if (!pathInfo || pathInfo.tables.length === 0) return "-- No join path available";

  const aliases = new Map();
  const aliasFor = (tableName, index) => {
    if (!aliases.has(tableName)) aliases.set(tableName, `t${index + 1}`);
    return aliases.get(tableName);
  };

  const firstTableName = pathInfo.tables[0];
  const firstTable = catalog.tableMap.get(firstTableName.toLowerCase());
  const selectColumns = firstTable
    ? suggestColumns(firstTable).map((name) => `${aliasFor(firstTableName, 0)}.[${name}]`)
    : ["*"];

  const lines = [
    "SELECT TOP 100",
    `  ${selectColumns.join(",\n  ")}`,
    `FROM ${firstTableName} ${aliasFor(firstTableName, 0)}`,
  ];

  for (let index = 1; index < pathInfo.tables.length; index += 1) {
    const current = pathInfo.tables[index];
    const previous = pathInfo.tables[index - 1];
    const previousAlias = aliasFor(previous, index - 1);
    const currentAlias = aliasFor(current, index);
    const currentPath = shortestJoinPath(
      catalog.graph,
      previous.toLowerCase(),
      current.toLowerCase()
    );
    const joinStep = currentPath?.[1];
    if (joinStep?.via) {
      lines.push(
        `JOIN ${current} ${currentAlias} ON ${previousAlias}.[${joinStep.via.fromColumn}] = ${currentAlias}.[${joinStep.via.toColumn}]`
      );
    }
  }

  lines.push("ORDER BY 1;");
  return lines.join("\n");
}

export function registerIntelligenceTools(server, context) {
  server.tool(
    "refresh_metadata",
    "Reload metadata cache from the database",
    {},
    async () => {
      const catalog = await context.catalogCache.refresh();
      return textResponse(
        section("Metadata Refreshed", [
          `Database: ${catalog.database}`,
          `Loaded at: ${catalog.loadedAt.toISOString()}`,
          `Tables: ${catalog.tables.length}`,
          `Routines: ${catalog.routines.length}`,
        ])
      );
    }
  );

  server.tool("health", "Show connection state, cache status, and runtime metrics", {}, async () => {
    const status = context.catalogCache.getStatus();
    return textResponse(
      section("Health", [
        `Database connected: ${context.db.connected ? "yes" : "no"}`,
        `Cache loaded: ${status.loaded ? "yes" : "no"}`,
        `Cache last loaded at: ${status.lastLoadedAt?.toISOString() || "n/a"}`,
        `Cache ttl ms: ${status.ttlMs}`,
        `Cache hits: ${status.metrics.hits}`,
        `Cache misses: ${status.metrics.misses}`,
        `Cache refreshes: ${status.metrics.refreshes}`,
      ])
    );
  });

  server.tool(
    "find_entities",
    "Search tables by intent using names, columns, descriptions, aliases, and relationship signals",
    {
      query: z
        .string()
        .describe("Free-text search such as 'clientes com pedido e endereco'"),
      schema: z.string().optional().describe("Restrict results to a schema"),
      limit: z.number().optional().default(10).describe("Maximum results"),
    },
    async ({ query, schema, limit }) => {
      const catalog = await context.catalogCache.getCatalog();
      const searchBase = schema
        ? { ...catalog, tables: catalog.tables.filter((table) => table.schema === schema) }
        : catalog;
      const result = findEntities(searchBase, query, limit);

      if (result.results.length === 0) {
        return textResponse(`## Find Entities\nNo matches found for "${query}".`);
      }

      const rows = result.results.map((item) => [
        item.table.fullName,
        item.score,
        item.table.centrality || 0,
        item.matchedTokens.join(", "),
        item.reasons.slice(0, 3).join("; "),
      ]);

      return textResponse(
        [
          section("Find Entities", [
            `Query: ${query}`,
            `Expanded tokens: ${result.tokens.join(", ")}`,
            `Results: ${result.results.length}`,
          ]),
          "",
          markdownTable(["Table", "Score", "Centrality", "Tokens", "Reasons"], rows),
        ].join("\n")
      );
    }
  );

  server.tool(
    "schema_summary",
    "Summarize schemas, central tables, and probable hotspots in the catalog",
    {
      schema: z.string().optional().describe("Optional schema filter"),
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
        const top = [...items]
          .sort((left, right) => (right.centrality || 0) - (left.centrality || 0))
          .slice(0, 5)
          .map(
            (table) =>
              `${table.name} (centrality ${table.centrality}, columns ${table.columns.length})`
          );

        blocks.push(
          section(schemaName, [
            `Objects: ${items.length}`,
            `Views: ${items.filter((item) => item.type === "VIEW").length}`,
            "Most connected:",
            ...top.map((item) => `- ${item}`),
          ])
        );
      }

      return textResponse(blocks.join("\n\n"));
    }
  );

  server.tool(
    "explain_table",
    "Explain the likely role of a table based on names, columns, descriptions, and relationships",
    {
      table: z.string().describe("Table name (e.g. 'dbo.Cliente')"),
    },
    async ({ table }) => {
      const catalog = await context.catalogCache.getCatalog();
      const item = findCatalogTable(catalog, table);

      if (!item) return textResponse(`Table "${table}" not found.`, true);

      const inbound = catalog.tables.flatMap((candidate) =>
        candidate.foreignKeys.filter(
          (fk) => fk.toFullName.toLowerCase() === item.fullName.toLowerCase()
        )
      );
      const likelyRole = item.columns.some((column) => /nome|descricao/i.test(column.name))
        ? "Entity/master table"
        : item.columns.some((column) => /data|valor|total/i.test(column.name))
          ? "Transactional table"
          : "Supporting/reference table";

      return textResponse(
        [
          section(item.fullName, [
            `Likely role: ${likelyRole}`,
            `Description: ${item.description || "n/a"}`,
            `Columns: ${item.columns.length}`,
            `Primary key: ${item.primaryKey.join(", ") || "n/a"}`,
            `Outgoing FKs: ${item.foreignKeys.length}`,
            `Incoming FKs: ${inbound.length}`,
            `Centrality: ${item.centrality || 0}`,
          ]),
          "",
          section("Important Columns", suggestColumns(item).map((name) => `- ${name}`)),
          "",
          section(
            "Related Tables",
            [
              ...item.foreignKeys.slice(0, 8).map((fk) => `- ${fk.fromColumn} -> ${fk.toFullName}.${fk.toColumn}`),
              ...inbound.slice(0, 8).map((fk) => `- referenced by ${fk.fromFullName}.${fk.fromColumn}`),
            ].slice(0, 12)
          ),
        ].join("\n")
      );
    }
  );

  server.tool(
    "suggest_join_path",
    "Find a join path between two tables using the foreign-key graph",
    {
      from_table: z.string().describe("Origin table"),
      to_table: z.string().describe("Destination table"),
    },
    async ({ from_table, to_table }) => {
      const catalog = await context.catalogCache.getCatalog();
      const from = findCatalogTable(catalog, from_table);
      const to = findCatalogTable(catalog, to_table);

      if (!from || !to) return textResponse("One or both tables were not found.", true);

      const path = shortestJoinPath(
        catalog.graph,
        from.normalizedFullName,
        to.normalizedFullName
      );

      if (!path) {
        return textResponse(
          `No join path found between "${from.fullName}" and "${to.fullName}".`,
          true
        );
      }

      const info = parsePathResult(path, catalog);
      return textResponse(
        [
          section("Suggested Join Path", [
            `From: ${from.fullName}`,
            `To: ${to.fullName}`,
            `Confidence: ${info.confidence.toFixed(2)}`,
          ]),
          "",
          formatList(info.lines),
        ].join("\n")
      );
    }
  );

  server.tool(
    "plan_query",
    "Plan a query from a natural-language goal using entity ranking and join-path suggestions",
    {
      goal: z.string().describe("Business question, e.g. 'clientes com pedidos e faturamento'"),
    },
    async ({ goal }) => {
      const catalog = await context.catalogCache.getCatalog();
      const found = findEntities(catalog, goal, 5);

      if (found.results.length === 0) {
        return textResponse(`No candidate tables found for "${goal}".`, true);
      }

      const candidates = found.results.map((item) => item.table);
      let pathInfo = null;
      if (candidates.length >= 2) {
        const path = shortestJoinPath(
          catalog.graph,
          candidates[0].normalizedFullName,
          candidates[1].normalizedFullName
        );
        pathInfo = parsePathResult(path, catalog);
      }

      return textResponse(
        [
          section("Query Plan", [
            `Goal: ${goal}`,
            `Top candidates: ${candidates.map((table) => table.fullName).join(", ")}`,
          ]),
          "",
          section(
            "Candidate Tables",
            candidates.map((table) => `- ${table.fullName}: ${table.description || "no description"}`)
          ),
          "",
          section(
            "Join Path",
            pathInfo ? pathInfo.lines : ["No FK path found; manual join review required."]
          ),
          "",
          section("Suggested SQL", ["```sql", buildQuerySkeleton(pathInfo, catalog), "```"]),
        ].join("\n")
      );
    }
  );

  server.tool(
    "validate_query",
    "Analyze a SQL statement before execution and report operation, tables, risk, and warnings",
    {
      sql: z.string().describe("The SQL statement to inspect"),
    },
    async ({ sql }) => {
      const validation = validateQueryText(sql, context.appConfig.permissions);
      const lines = [
        `Operation: ${validation.operation}`,
        `OK: ${validation.ok ? "yes" : "no"}`,
        `Risk: ${validation.risk}`,
        `Tables: ${validation.tables?.join(", ") || "n/a"}`,
      ];

      if (validation.reason) lines.push(`Reason: ${validation.reason}`);
      if (validation.warnings?.length) {
        lines.push("Warnings:");
        for (const warning of validation.warnings) lines.push(`- ${warning}`);
      }

      return textResponse(section("Validate Query", lines), !validation.ok);
    }
  );
}
