#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadAppConfig } from "./config/env.js";
import { createDatabaseContext } from "./db/connection.js";
import { CatalogCache } from "./db/catalog-cache.js";
import { registerCoreTools } from "./tools/core.js";
import { registerIntelligenceTools } from "./tools/intelligence.js";

function formatDbEndpoint(config) {
  const instanceName = config.db.options?.instanceName;
  if (instanceName) return `${config.db.server}\\${instanceName}`;
  return `${config.db.server}:${config.db.port ?? 1433}`;
}

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
    `[mcp-sqlserver] Connected to "${appConfig.db.database}" on ${formatDbEndpoint(appConfig)}\n`
  );
} catch (error) {
  process.stderr.write(`[mcp-sqlserver] Connection failed: ${error.message}\n`);
  process.exit(1);
}

const catalogCache = new CatalogCache(db, appConfig.metadata.ttlMs);
await catalogCache.getCatalog();

const server = new McpServer({ name: "mcp-sqlserver", version: "2.0.0" });
const context = { appConfig, db, catalogCache };

function normalizeConnectionDetails(dbConfig) {
  return {
    server: dbConfig.server,
    port: dbConfig.port ?? 1433,
    database: dbConfig.database,
    user: dbConfig.user || "(windows auth)",
  };
}

context.switchConnection = async (updates = {}) => {
  if (
    typeof updates.port !== "undefined" &&
    context.appConfig.db.options?.instanceName
  ) {
    throw new Error("Port switching is not available when DB_SERVER uses a named instance.");
  }

  if (typeof updates.database !== "undefined") {
    const allowedDatabases = context.appConfig.databaseSwitch.allowedDatabases;
    if (
      allowedDatabases.length > 0 &&
      !allowedDatabases.includes(updates.database.toLowerCase())
    ) {
      throw new Error(
        `Database "${updates.database}" is not allowed by DB_ALLOW_DATABASE_SWITCH`
      );
    }
  }

  const nextDbConfig = {
    ...context.appConfig.db,
  };

  if (typeof updates.port !== "undefined") {
    nextDbConfig.port = updates.port;
  }

  if (typeof updates.database !== "undefined") {
    nextDbConfig.database = updates.database;
  }

  if (typeof updates.user !== "undefined") {
    nextDbConfig.user = updates.user || undefined;
    if (!updates.user && typeof updates.password === "undefined") {
      nextDbConfig.password = undefined;
    }
  }

  if (typeof updates.password !== "undefined") {
    nextDbConfig.password = updates.password || undefined;
  }

  const nextAppConfig = {
    ...context.appConfig,
    db: nextDbConfig,
  };

  const nextDb = await createDatabaseContext(nextAppConfig);

  try {
    await nextDb.validate();
    const nextCatalogCache = new CatalogCache(nextDb, nextAppConfig.metadata.ttlMs);
    await nextCatalogCache.getCatalog();

    const previousConnection = normalizeConnectionDetails(context.appConfig.db);
    await context.db.close();

    context.appConfig = nextAppConfig;
    context.db = nextDb;
    context.catalogCache = nextCatalogCache;

    const currentConnection = normalizeConnectionDetails(nextAppConfig.db);
    process.stderr.write(
      `[mcp-sqlserver] Switched connection from ${previousConnection.server}:${previousConnection.port}/${previousConnection.database} (${previousConnection.user}) to ${currentConnection.server}:${currentConnection.port}/${currentConnection.database} (${currentConnection.user})\n`
    );

    return {
      previousConnection,
      connection: currentConnection,
    };
  } catch (error) {
    await nextDb.close().catch(() => {});
    throw error;
  }
};

context.switchDatabase = async (database) => {
  const result = await context.switchConnection({ database });
  return {
    previousDatabase: result.previousConnection.database,
    database: result.connection.database,
    server: result.connection.server,
  };
};

context.switchCredentials = async (user, password) => {
  const result = await context.switchConnection({ user, password });
  return {
    previousUser: result.previousConnection.user,
    user: result.connection.user,
    database: result.connection.database,
    server: result.connection.server,
  };
};

context.switchPort = async (port) => {
  const result = await context.switchConnection({ port });
  return {
    previousPort: result.previousConnection.port,
    port: result.connection.port,
    database: result.connection.database,
    server: result.connection.server,
  };
};

registerCoreTools(server, context);
registerIntelligenceTools(server, context);

const transport = new StdioServerTransport();
await server.connect(transport);
