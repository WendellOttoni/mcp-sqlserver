import { hasBlockedKeyword, isTableAllowed } from "./permissions.js";
import { compactWhitespace } from "../utils/text.js";

function stripCommentsAndStrings(sqlText) {
  return String(sqlText || "")
    .replace(/--.*$/gm, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/'(?:''|[^'])*'/g, "''")
    .replace(/N''/g, "''");
}

function normalizeObjectName(value) {
  return String(value || "")
    .replace(/[\[\]"`]/g, "")
    .trim()
    .replace(/\s+/g, "")
    .toLowerCase();
}

function parseObjectList(fragment) {
  return fragment
    .split(",")
    .map((item) => normalizeObjectName(item))
    .filter(Boolean);
}

function extractObjectCandidates(sqlText) {
  const sanitized = compactWhitespace(stripCommentsAndStrings(sqlText));
  const candidates = new Set();
  const patterns = [
    /\bFROM\s+([a-z0-9_\.\[\]]+(?:\s*,\s*[a-z0-9_\.\[\]]+)*)/gi,
    /\bJOIN\s+([a-z0-9_\.\[\]]+)/gi,
    /\bINTO\s+([a-z0-9_\.\[\]]+)/gi,
    /\bUPDATE\s+([a-z0-9_\.\[\]]+)/gi,
    /\bDELETE\s+FROM\s+([a-z0-9_\.\[\]]+)/gi,
    /\bMERGE\s+INTO\s+([a-z0-9_\.\[\]]+)/gi,
    /\bALTER\s+TABLE\s+([a-z0-9_\.\[\]]+)/gi,
    /\bDROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?([a-z0-9_\.\[\]]+)/gi,
    /\bTRUNCATE\s+TABLE\s+([a-z0-9_\.\[\]]+)/gi,
    /\bCREATE\s+TABLE\s+([a-z0-9_\.\[\]]+)/gi,
  ];

  for (const pattern of patterns) {
    for (const match of sanitized.matchAll(pattern)) {
      for (const item of parseObjectList(match[1])) {
        candidates.add(item);
      }
    }
  }

  return [...candidates];
}

export function detectPrimaryOperation(sqlText) {
  const sanitized = compactWhitespace(stripCommentsAndStrings(sqlText)).toUpperCase();
  const match = sanitized.match(
    /^(WITH\s+.+?\)\s*)?(SELECT|INSERT|UPDATE|DELETE|MERGE|ALTER|CREATE|DROP|TRUNCATE)\b/i
  );
  return match ? match[2].toUpperCase() : "UNKNOWN";
}

export function isWriteOperation(operation) {
  return [
    "INSERT",
    "UPDATE",
    "DELETE",
    "MERGE",
    "ALTER",
    "CREATE",
    "DROP",
    "TRUNCATE",
  ].includes(operation);
}

export function buildQueryWarnings(sqlText, operation) {
  const sanitized = compactWhitespace(stripCommentsAndStrings(sqlText)).toUpperCase();
  const warnings = [];

  if (operation === "SELECT" && /\bSELECT\s+\*/i.test(sanitized)) {
    warnings.push("Uses SELECT *; explicit columns are safer and cheaper.");
  }
  if (operation === "SELECT" && !/\bWHERE\b/i.test(sanitized) && !/\bTOP\s+\d+/i.test(sanitized)) {
    warnings.push("No WHERE/TOP clause detected; result set may be large.");
  }
  if (/\bJOIN\b/i.test(sanitized) && !/\bON\b/i.test(sanitized)) {
    warnings.push("JOIN detected without ON clause; review for accidental cartesian product.");
  }

  return warnings;
}

export function validateQueryText(sqlText, permissions) {
  const operation = detectPrimaryOperation(sqlText);
  const blocked = hasBlockedKeyword(sqlText, permissions);
  const tables = extractObjectCandidates(sqlText);
  const warnings = buildQueryWarnings(sqlText, operation);
  const isWrite = isWriteOperation(operation);
  const tableChecks = isWrite
    ? tables.map((table) => ({ table, ...isTableAllowed(table, permissions) }))
    : [];
  const deniedTable = tableChecks.find((item) => !item.allowed);

  if (blocked.blocked) {
    const permanentlyBlocked = permissions.alwaysBlocked.some(
      (item) =>
        item.toUpperCase() === blocked.keyword.toUpperCase() ||
        blocked.keyword.toUpperCase().startsWith(item.toUpperCase())
    );

    return {
      ok: false,
      operation,
      tables,
      warnings,
      blockedKeyword: blocked.keyword,
      reason: permanentlyBlocked
        ? `Operation "${blocked.keyword}" is permanently blocked.`
        : `Operation "${blocked.keyword}" is not enabled in DB_ALLOW_WRITE.`,
      risk: permanentlyBlocked ? "critical" : "high",
    };
  }

  if (deniedTable) {
    return {
      ok: false,
      operation,
      tables,
      warnings,
      reason: deniedTable.reason,
      risk: "high",
    };
  }

  return {
    ok: true,
    operation,
    tables,
    warnings,
    risk: isWrite ? "medium" : "low",
    isWrite,
  };
}
