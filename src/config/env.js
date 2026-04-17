const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;

const ALWAYS_BLOCKED = [
  "EXEC",
  "EXECUTE",
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

const WRITE_KEYWORDS = [
  "INSERT",
  "UPDATE",
  "DELETE",
  "MERGE",
  "DROP",
  "ALTER",
  "CREATE",
  "TRUNCATE",
];

function splitCsv(value) {
  return (value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseBoolean(value, defaultValue) {
  if (value === undefined || value === null || value === "") {
    return defaultValue;
  }

  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

export function loadAppConfig(env = process.env) {
  if (!env.DB_DATABASE || !String(env.DB_DATABASE).trim()) {
    throw new Error("DB_DATABASE is required.");
  }

  const serverRaw = (env.DB_SERVER || "localhost").replace(/\//g, "\\");
  let serverName = serverRaw;
  let instanceName;

  if (serverRaw.includes("\\")) {
    const [host, instance] = serverRaw.split("\\", 2);
    serverName = host;
    instanceName = instance;
  }

  const allowedWriteOps = splitCsv(env.DB_ALLOW_WRITE)
    .map((item) => item.toUpperCase())
    .filter((item) => WRITE_KEYWORDS.includes(item));

  return {
    db: {
      server: serverName,
      database: env.DB_DATABASE || "",
      user: env.DB_USER || undefined,
      password: env.DB_PASSWORD || undefined,
      port:
        !instanceName && env.DB_PORT ? Number.parseInt(env.DB_PORT, 10) : undefined,
      options: {
        trustServerCertificate: parseBoolean(env.DB_TRUST_SERVER_CERTIFICATE, true),
        encrypt: parseBoolean(env.DB_ENCRYPT, false),
        instanceName,
      },
      pool: {
        max: Number.parseInt(env.DB_POOL_MAX || "5", 10),
        min: 0,
        idleTimeoutMillis: 30000,
      },
    },
    permissions: {
      alwaysBlocked: ALWAYS_BLOCKED,
      writeKeywords: WRITE_KEYWORDS,
      allowedWriteOps,
      allowedTables: splitCsv(env.DB_ALLOW_TABLES).map((item) =>
        item.toLowerCase()
      ),
      allowedSchemas: splitCsv(env.DB_ALLOW_SCHEMAS).map((item) =>
        item.toLowerCase()
      ),
      isReadOnly: allowedWriteOps.length === 0,
      mode: allowedWriteOps.length === 0 ? "READ-ONLY" : "READ-WRITE",
    },
    metadata: {
      ttlMs: Number.parseInt(env.DB_METADATA_TTL_MS || `${DEFAULT_CACHE_TTL_MS}`, 10),
    },
    databaseSwitch: {
      allowedDatabases: splitCsv(env.DB_ALLOW_DATABASE_SWITCH).map((item) =>
        item.toLowerCase()
      ),
    },
    runtime: {
      queryTimeoutMs: Number.parseInt(env.DB_QUERY_TIMEOUT_MS || "30000", 10),
      defaultMaxRows: Number.parseInt(env.DB_DEFAULT_MAX_ROWS || "100", 10),
      maxRowsCap: 1000,
      defaultSampleSize: Number.parseInt(env.DB_SAMPLE_SIZE || "5", 10),
    },
  };
}

export { ALWAYS_BLOCKED, WRITE_KEYWORDS };
