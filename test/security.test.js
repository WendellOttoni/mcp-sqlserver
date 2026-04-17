import test from "node:test";
import assert from "node:assert/strict";
import { loadAppConfig } from "../src/config/env.js";
import { validateQueryText } from "../src/security/sql-validator.js";
import { isTableAllowed } from "../src/security/permissions.js";

test("blocks permanently forbidden commands", () => {
  const appConfig = loadAppConfig({ DB_DATABASE: "db" });
  const result = validateQueryText("EXEC xp_cmdshell 'dir'", appConfig.permissions);
  assert.equal(result.ok, false);
  assert.match(result.reason, /permanently blocked/i);
});

test("allows configured writes only on allowed tables", () => {
  const appConfig = loadAppConfig({
    DB_DATABASE: "db",
    DB_ALLOW_WRITE: "UPDATE",
    DB_ALLOW_TABLES: "dbo.cliente",
  });

  assert.deepEqual(isTableAllowed("dbo.cliente", appConfig.permissions), {
    allowed: true,
  });
  assert.equal(
    isTableAllowed("dbo.pedido", appConfig.permissions).allowed,
    false
  );
});

test("warns on broad select", () => {
  const appConfig = loadAppConfig({ DB_DATABASE: "db" });
  const result = validateQueryText("SELECT * FROM dbo.Cliente", appConfig.permissions);
  assert.equal(result.ok, true);
  assert.ok(result.warnings.some((warning) => warning.includes("SELECT *")));
});

test("blocks multiple statements in one request", () => {
  const appConfig = loadAppConfig({
    DB_DATABASE: "db",
    DB_ALLOW_WRITE: "UPDATE",
    DB_ALLOW_TABLES: "dbo.cliente",
  });

  const result = validateQueryText(
    "SELECT 1; UPDATE dbo.cliente SET nome = 'x'",
    appConfig.permissions
  );

  assert.equal(result.ok, false);
  assert.match(result.reason, /multiple sql statements/i);
});

test("requires DB_DATABASE", () => {
  assert.throws(() => loadAppConfig({}), /DB_DATABASE is required/);
});

test("reads TLS settings from environment", () => {
  const appConfig = loadAppConfig({
    DB_DATABASE: "db",
    DB_ENCRYPT: "true",
    DB_TRUST_SERVER_CERTIFICATE: "false",
  });

  assert.equal(appConfig.db.options.encrypt, true);
  assert.equal(appConfig.db.options.trustServerCertificate, false);
});
