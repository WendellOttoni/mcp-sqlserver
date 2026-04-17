import { buildRelationshipGraph, computeCentrality } from "../graph/relationship-graph.js";
import { normalizeText } from "../utils/text.js";

function normalizeName(value) {
  return String(value || "").toLowerCase();
}

function tableKey(schema, name) {
  return `${normalizeName(schema)}.${normalizeName(name)}`;
}

function toArrayMap(rows, keySelector) {
  const map = new Map();
  for (const row of rows) {
    const key = keySelector(row);
    if (!map.has(key)) {
      map.set(key, []);
    }
    map.get(key).push(row);
  }
  return map;
}

export async function loadCatalog(dbContext) {
  const [tablesResult, columnsResult, fkResult, checkResult, indexesResult, routinesResult] =
    await Promise.all([
      dbContext.query(`
        SELECT
          t.TABLE_SCHEMA,
          t.TABLE_NAME,
          t.TABLE_TYPE,
          CAST(ep.value AS NVARCHAR(4000)) AS TABLE_DESCRIPTION
        FROM INFORMATION_SCHEMA.TABLES t
        LEFT JOIN sys.tables st
          ON st.name = t.TABLE_NAME
         AND SCHEMA_NAME(st.schema_id) = t.TABLE_SCHEMA
        LEFT JOIN sys.views sv
          ON sv.name = t.TABLE_NAME
         AND SCHEMA_NAME(sv.schema_id) = t.TABLE_SCHEMA
        LEFT JOIN sys.extended_properties ep
          ON ep.major_id = COALESCE(st.object_id, sv.object_id)
         AND ep.minor_id = 0
         AND ep.name = 'MS_Description'
        ORDER BY t.TABLE_SCHEMA, t.TABLE_NAME
      `),
      dbContext.query(`
        SELECT
          c.TABLE_SCHEMA,
          c.TABLE_NAME,
          c.COLUMN_NAME,
          c.ORDINAL_POSITION,
          c.DATA_TYPE,
          c.CHARACTER_MAXIMUM_LENGTH,
          c.NUMERIC_PRECISION,
          c.NUMERIC_SCALE,
          c.IS_NULLABLE,
          c.COLUMN_DEFAULT,
          CASE WHEN pk.COLUMN_NAME IS NOT NULL THEN 'YES' ELSE 'NO' END AS IS_PK,
          COLUMNPROPERTY(OBJECT_ID(QUOTENAME(c.TABLE_SCHEMA) + '.' + QUOTENAME(c.TABLE_NAME)), c.COLUMN_NAME, 'IsIdentity') AS IS_IDENTITY,
          COLUMNPROPERTY(OBJECT_ID(QUOTENAME(c.TABLE_SCHEMA) + '.' + QUOTENAME(c.TABLE_NAME)), c.COLUMN_NAME, 'IsComputed') AS IS_COMPUTED,
          CAST(ep.value AS NVARCHAR(4000)) AS COLUMN_DESCRIPTION
        FROM INFORMATION_SCHEMA.COLUMNS c
        LEFT JOIN (
          SELECT ku.TABLE_SCHEMA, ku.TABLE_NAME, ku.COLUMN_NAME
          FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
          JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE ku
            ON tc.CONSTRAINT_NAME = ku.CONSTRAINT_NAME
           AND tc.TABLE_SCHEMA = ku.TABLE_SCHEMA
           AND tc.TABLE_NAME = ku.TABLE_NAME
          WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY'
        ) pk
          ON pk.TABLE_SCHEMA = c.TABLE_SCHEMA
         AND pk.TABLE_NAME = c.TABLE_NAME
         AND pk.COLUMN_NAME = c.COLUMN_NAME
        LEFT JOIN sys.tables st
          ON st.name = c.TABLE_NAME
         AND SCHEMA_NAME(st.schema_id) = c.TABLE_SCHEMA
        LEFT JOIN sys.columns sc
          ON sc.object_id = st.object_id
         AND sc.name = c.COLUMN_NAME
        LEFT JOIN sys.extended_properties ep
          ON ep.major_id = st.object_id
         AND ep.minor_id = sc.column_id
         AND ep.name = 'MS_Description'
        ORDER BY c.TABLE_SCHEMA, c.TABLE_NAME, c.ORDINAL_POSITION
      `),
      dbContext.query(`
        SELECT
          OBJECT_SCHEMA_NAME(fk.parent_object_id) AS FROM_SCHEMA,
          OBJECT_NAME(fk.parent_object_id) AS FROM_TABLE,
          COL_NAME(fkc.parent_object_id, fkc.parent_column_id) AS FROM_COLUMN,
          OBJECT_SCHEMA_NAME(fk.referenced_object_id) AS TO_SCHEMA,
          OBJECT_NAME(fk.referenced_object_id) AS TO_TABLE,
          COL_NAME(fkc.referenced_object_id, fkc.referenced_column_id) AS TO_COLUMN,
          fk.name AS CONSTRAINT_NAME
        FROM sys.foreign_keys fk
        JOIN sys.foreign_key_columns fkc
          ON fk.object_id = fkc.constraint_object_id
        ORDER BY FROM_SCHEMA, FROM_TABLE, TO_SCHEMA, TO_TABLE
      `),
      dbContext.query(`
        SELECT
          OBJECT_SCHEMA_NAME(o.object_id) AS TABLE_SCHEMA,
          o.name AS TABLE_NAME,
          cc.name AS CONSTRAINT_NAME,
          cc.definition AS DEFINITION
        FROM sys.check_constraints cc
        JOIN sys.objects o
          ON o.object_id = cc.parent_object_id
        ORDER BY TABLE_SCHEMA, TABLE_NAME, CONSTRAINT_NAME
      `),
      dbContext.query(`
        SELECT
          OBJECT_SCHEMA_NAME(i.object_id) AS TABLE_SCHEMA,
          OBJECT_NAME(i.object_id) AS TABLE_NAME,
          i.name AS INDEX_NAME,
          i.type_desc AS INDEX_TYPE,
          CASE WHEN i.is_unique = 1 THEN 'YES' ELSE 'NO' END AS IS_UNIQUE,
          CASE WHEN i.is_primary_key = 1 THEN 'YES' ELSE 'NO' END AS IS_PK,
          STUFF((
            SELECT ', ' + c2.name
            FROM sys.index_columns ic2
            JOIN sys.columns c2
              ON ic2.object_id = c2.object_id
             AND ic2.column_id = c2.column_id
            WHERE ic2.object_id = i.object_id
              AND ic2.index_id = i.index_id
              AND ic2.is_included_column = 0
            ORDER BY ic2.key_ordinal
            FOR XML PATH(''), TYPE
          ).value('.', 'NVARCHAR(MAX)'), 1, 2, '') AS KEY_COLUMNS,
          STUFF((
            SELECT ', ' + c2.name
            FROM sys.index_columns ic2
            JOIN sys.columns c2
              ON ic2.object_id = c2.object_id
             AND ic2.column_id = c2.column_id
            WHERE ic2.object_id = i.object_id
              AND ic2.index_id = i.index_id
              AND ic2.is_included_column = 1
            ORDER BY ic2.column_id
            FOR XML PATH(''), TYPE
          ).value('.', 'NVARCHAR(MAX)'), 1, 2, '') AS INCLUDED_COLUMNS
        FROM sys.indexes i
        WHERE i.type > 0
        ORDER BY TABLE_SCHEMA, TABLE_NAME, i.is_primary_key DESC, i.is_unique DESC, i.name
      `),
      dbContext.query(`
        SELECT
          ROUTINE_SCHEMA,
          ROUTINE_NAME,
          ROUTINE_TYPE,
          CONVERT(VARCHAR(10), CREATED, 120) AS CREATED_AT,
          CONVERT(VARCHAR(10), LAST_ALTERED, 120) AS MODIFIED_AT
        FROM INFORMATION_SCHEMA.ROUTINES
        WHERE ROUTINE_TYPE IN ('PROCEDURE', 'FUNCTION')
        ORDER BY ROUTINE_SCHEMA, ROUTINE_TYPE, ROUTINE_NAME
      `),
    ]);

  const columnsByTable = toArrayMap(columnsResult.recordset, (row) =>
    tableKey(row.TABLE_SCHEMA, row.TABLE_NAME)
  );
  const fksByTable = toArrayMap(fkResult.recordset, (row) =>
    tableKey(row.FROM_SCHEMA, row.FROM_TABLE)
  );
  const checksByTable = toArrayMap(checkResult.recordset, (row) =>
    tableKey(row.TABLE_SCHEMA, row.TABLE_NAME)
  );
  const indexesByTable = toArrayMap(indexesResult.recordset, (row) =>
    tableKey(row.TABLE_SCHEMA, row.TABLE_NAME)
  );

  const tables = tablesResult.recordset.map((row) => {
    const key = tableKey(row.TABLE_SCHEMA, row.TABLE_NAME);
    const columns = (columnsByTable.get(key) || []).map((column) => ({
      name: column.COLUMN_NAME,
      ordinal: column.ORDINAL_POSITION,
      dataType: column.DATA_TYPE,
      maxLength: column.CHARACTER_MAXIMUM_LENGTH,
      numericPrecision: column.NUMERIC_PRECISION,
      numericScale: column.NUMERIC_SCALE,
      isNullable: column.IS_NULLABLE === "YES",
      defaultValue: column.COLUMN_DEFAULT,
      isPrimaryKey: column.IS_PK === "YES",
      isIdentity: column.IS_IDENTITY === 1,
      isComputed: column.IS_COMPUTED === 1,
      description: column.COLUMN_DESCRIPTION || "",
    }));

    return {
      schema: row.TABLE_SCHEMA,
      name: row.TABLE_NAME,
      type: row.TABLE_TYPE,
      fullName: `${row.TABLE_SCHEMA}.${row.TABLE_NAME}`,
      normalizedFullName: key,
      normalizedName: normalizeText(row.TABLE_NAME),
      normalizedSearchText: normalizeText([
        `${row.TABLE_SCHEMA}.${row.TABLE_NAME}`,
        row.TABLE_DESCRIPTION || "",
        ...columns.map((column) => column.name),
        ...columns.map((column) => column.description || ""),
        ...(fksByTable.get(key) || []).map((fk) => `${fk.TO_SCHEMA}.${fk.TO_TABLE}`),
      ].join(" ")),
      description: row.TABLE_DESCRIPTION || "",
      columns,
      primaryKey: columns
        .filter((column) => column.isPrimaryKey)
        .map((column) => column.name),
      foreignKeys: (fksByTable.get(key) || []).map((fk) => ({
        fromSchema: fk.FROM_SCHEMA,
        fromTable: fk.FROM_TABLE,
        fromColumn: fk.FROM_COLUMN,
        toSchema: fk.TO_SCHEMA,
        toTable: fk.TO_TABLE,
        toColumn: fk.TO_COLUMN,
        constraintName: fk.CONSTRAINT_NAME,
        fromFullName: `${fk.FROM_SCHEMA}.${fk.FROM_TABLE}`,
        toFullName: `${fk.TO_SCHEMA}.${fk.TO_TABLE}`,
      })),
      checks: (checksByTable.get(key) || []).map((check) => ({
        name: check.CONSTRAINT_NAME,
        definition: check.DEFINITION,
      })),
      indexes: (indexesByTable.get(key) || []).map((index) => ({
        name: index.INDEX_NAME,
        type: index.INDEX_TYPE,
        isUnique: index.IS_UNIQUE === "YES",
        isPrimaryKey: index.IS_PK === "YES",
        keyColumns: index.KEY_COLUMNS ? index.KEY_COLUMNS.split(", ").filter(Boolean) : [],
        includedColumns: index.INCLUDED_COLUMNS
          ? index.INCLUDED_COLUMNS.split(", ").filter(Boolean)
          : [],
      })),
    };
  });

  const tableMap = new Map(tables.map((table) => [table.normalizedFullName, table]));
  const graph = buildRelationshipGraph(tables);
  const centrality = computeCentrality(graph);

  for (const table of tables) {
    table.relationshipDegree = graph.adjacency.get(table.normalizedFullName)?.length || 0;
    table.centrality = centrality.get(table.normalizedFullName) || 0;
  }

  return {
    loadedAt: new Date(),
    database: dbContext.appConfig.db.database,
    schemas: [...new Set(tables.map((table) => table.schema))].sort(),
    tables,
    tableMap,
    routines: routinesResult.recordset.map((routine) => ({
      schema: routine.ROUTINE_SCHEMA,
      name: routine.ROUTINE_NAME,
      type: routine.ROUTINE_TYPE,
      createdAt: routine.CREATED_AT,
      modifiedAt: routine.MODIFIED_AT,
      fullName: `${routine.ROUTINE_SCHEMA}.${routine.ROUTINE_NAME}`,
    })),
    graph,
  };
}

export function findCatalogTable(catalog, tableName) {
  const normalized = normalizeName(tableName);
  if (normalized.includes(".")) {
    return catalog.tableMap.get(normalized) || null;
  }

  return (
    catalog.tables.find((table) => normalizeName(table.name) === normalized) || null
  );
}
