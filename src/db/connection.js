import sql from "mssql";

export function buildSqlConfig(appConfig) {
  const config = {
    ...appConfig.db,
  };

  if (!config.user) {
    delete config.user;
    delete config.password;
    config.authentication = { type: "ntlm", options: { domain: "" } };
  }

  return config;
}

export async function createDatabaseContext(appConfig) {
  const sqlConfig = buildSqlConfig(appConfig);
  let pool = null;

  async function connect() {
    if (!pool || !pool.connected) {
      pool = await sql.connect(sqlConfig);
    }
    return pool;
  }

  async function validate() {
    const activePool = await connect();
    await activePool.request().query("SELECT 1");
    return activePool;
  }

  async function close() {
    if (pool) {
      const activePool = pool;
      pool = null;
      await activePool.close();
    }
  }

  async function query(text, bindInputs = []) {
    const activePool = await connect();
    const request = activePool.request();

    for (const input of bindInputs) {
      request.input(input.name, input.type, input.value);
    }

    request.timeout = appConfig.runtime.queryTimeoutMs;
    return request.query(text);
  }

  return {
    sql,
    appConfig,
    connect,
    validate,
    query,
    close,
    getPool: connect,
    get connected() {
      return Boolean(pool?.connected);
    },
  };
}
