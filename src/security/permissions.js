import { compactWhitespace } from "../utils/text.js";

function normalizeTableName(value) {
  return String(value || "")
    .replace(/[\[\]"`]/g, "")
    .trim()
    .toLowerCase();
}

export function isTableAllowed(targetTable, permissions) {
  if (
    permissions.allowedTables.length === 0 &&
    permissions.allowedSchemas.length === 0
  ) {
    return { allowed: true };
  }

  const normalized = normalizeTableName(targetTable);
  const [schema = "dbo", table = normalized] = normalized.includes(".")
    ? normalized.split(".", 2)
    : ["dbo", normalized];

  if (
    permissions.allowedSchemas.length > 0 &&
    !permissions.allowedSchemas.includes(schema)
  ) {
    return {
      allowed: false,
      reason: `Schema "${schema}" is not in DB_ALLOW_SCHEMAS (${permissions.allowedSchemas.join(", ")})`,
    };
  }

  if (permissions.allowedTables.length > 0) {
    const fullName = `${schema}.${table}`;
    const allowed = permissions.allowedTables.some(
      (item) => item === fullName || item === table || item === `dbo.${table}`
    );

    if (!allowed) {
      return {
        allowed: false,
        reason: `Table "${fullName}" is not in DB_ALLOW_TABLES`,
      };
    }
  }

  return { allowed: true };
}

export function buildBlockedKeywords(permissions) {
  return [
    ...permissions.alwaysBlocked,
    ...permissions.writeKeywords.filter(
      (keyword) => !permissions.allowedWriteOps.includes(keyword)
    ),
  ];
}

export function hasBlockedKeyword(sqlText, permissions) {
  const upper = compactWhitespace(sqlText).toUpperCase();

  for (const keyword of buildBlockedKeywords(permissions)) {
    const isPrefix = keyword.endsWith("_");
    const pattern = isPrefix
      ? `(^|\\s|;|\\()${keyword}`
      : `(^|\\s|;|\\()${keyword}(\\s|;|\\(|$)`;

    if (new RegExp(pattern, "i").test(upper)) {
      return { blocked: true, keyword };
    }
  }

  return { blocked: false };
}
