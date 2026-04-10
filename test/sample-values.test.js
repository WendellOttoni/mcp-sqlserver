import test from "node:test";
import assert from "node:assert/strict";
import { registerCoreTools } from "../src/tools/core.js";

function createCatalog() {
  const table = {
    schema: "dbo",
    name: "Empresa",
    fullName: "dbo.Empresa",
    normalizedFullName: "dbo.empresa",
    columns: [{ name: "Nome" }, { name: "Id" }],
  };

  return {
    database: "ReqPlay",
    schemas: ["dbo"],
    tables: [table],
    tableMap: new Map([[table.normalizedFullName, table]]),
  };
}

test("sample_values generates valid DISTINCT TOP syntax and returns grouped values", async () => {
  const tools = new Map();
  let capturedSql = "";

  const server = {
    tool(name, _description, _schema, handler) {
      tools.set(name, handler);
    },
  };

  const context = {
    appConfig: {
      runtime: { defaultSampleSize: 5, defaultMaxRows: 100 },
      permissions: { isReadOnly: true, allowedWriteOps: [] },
    },
    catalogCache: {
      async getCatalog() {
        return createCatalog();
      },
    },
    db: {
      async query(sql) {
        capturedSql = sql;
        return {
          recordset: [
            { sampled_column: "Nome", sampled_value: "Admin" },
            { sampled_column: "Nome", sampled_value: "DeFusion Ltda." },
          ],
        };
      },
    },
  };

  registerCoreTools(server, context);
  const sampleValues = tools.get("sample_values");

  const result = await sampleValues({ table: "dbo.Empresa", columns: ["Nome"], limit: 3 });

  assert.match(capturedSql, /SELECT DISTINCT TOP 3/i);
  assert.doesNotMatch(capturedSql, /SELECT TOP 3 DISTINCT/i);
  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /┌─ dbo\.Empresa /);
  assert.match(result.content[0].text, /┌─ Nome /);
  assert.match(result.content[0].text, /- Admin/);
});

test("switch_database delegates the change and reports the new active database", async () => {
  const tools = new Map();
  let switchedTo = "";

  const server = {
    tool(name, _description, _schema, handler) {
      tools.set(name, handler);
    },
  };

  const context = {
    appConfig: {
      db: { database: "ReqPlay", server: "localhost" },
      runtime: { defaultSampleSize: 5, defaultMaxRows: 100 },
      permissions: { isReadOnly: true, allowedWriteOps: [] },
    },
    catalogCache: {
      getStatus() {
        return { loaded: true };
      },
    },
    async switchDatabase(database) {
      switchedTo = database;
      this.appConfig.db.database = database;
      return {
        previousDatabase: "ReqPlay",
        database,
        server: "localhost",
      };
    },
  };

  registerCoreTools(server, context);
  const switchDatabase = tools.get("switch_database");

  const result = await switchDatabase({ database: "OutroBanco" });

  assert.equal(switchedTo, "OutroBanco");
  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /Database Switched/);
  assert.match(result.content[0].text, /Previous database: ReqPlay/);
  assert.match(result.content[0].text, /Current database: OutroBanco/);
});
