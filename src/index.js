#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadAppConfig } from "./config/env.js";
import { createDatabaseContext } from "./db/connection.js";
import { CatalogCache } from "./db/catalog-cache.js";
import { registerCoreTools } from "./tools/core.js";
import { registerIntelligenceTools } from "./tools/intelligence.js";

let appConfig;
try {
  appConfig = loadAppConfig();
} catch (error) {
  process.stderr.write(`[mcp-sqlserver] Configuration failed: ${error.message}\n`);
  process.exit(1);
}

const db = await createDatabaseContext(appConfig);

try {
  await db.validate();
  process.stderr.write(
    `[mcp-sqlserver] Connected to "${appConfig.db.database}" on ${appConfig.db.server}\n`
  );
} catch (error) {
  process.stderr.write(`[mcp-sqlserver] Connection failed: ${error.message}\n`);
  process.exit(1);
}

const catalogCache = new CatalogCache(db, appConfig.metadata.ttlMs);
await catalogCache.getCatalog();

const server = new McpServer({ name: "mcp-sqlserver", version: "2.0.0" });
const context = { appConfig, db, catalogCache };

context.switchDatabase = async (database) => {
  const allowedDatabases = context.appConfig.databaseSwitch.allowedDatabases;
  if (
    allowedDatabases.length > 0 &&
    !allowedDatabases.includes(database.toLowerCase())
  ) {
    throw new Error(
      `Database "${database}" is not allowed by DB_ALLOW_DATABASE_SWITCH`
    );
  }

  const nextAppConfig = {
    ...context.appConfig,
    db: {
      ...context.appConfig.db,
      database,
    },
  };

  const nextDb = await createDatabaseContext(nextAppConfig);

  try {
    await nextDb.validate();
    const nextCatalogCache = new CatalogCache(nextDb, nextAppConfig.metadata.ttlMs);
    await nextCatalogCache.getCatalog();

    const previousDatabase = context.appConfig.db.database;
    await context.db.close();

    context.appConfig = nextAppConfig;
    context.db = nextDb;
    context.catalogCache = nextCatalogCache;

    process.stderr.write(
      `[mcp-sqlserver] Switched database from "${previousDatabase}" to "${database}" on ${nextAppConfig.db.server}\n`
    );

    return {
      previousDatabase,
      database,
      server: nextAppConfig.db.server,
    };
  } catch (error) {
    await nextDb.close().catch(() => {});
    throw error;
  }
};

registerCoreTools(server, context);
registerIntelligenceTools(server, context);

const transport = new StdioServerTransport();
await server.connect(transport);
