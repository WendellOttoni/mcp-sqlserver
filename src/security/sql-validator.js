import { hasBlockedKeyword, isTableAllowed } from "./permissions.js";
import { compactWhitespace } from "../utils/text.js";

function stripCommentsAndStrings(sqlText) {
  return String(sqlText || "")
    .replace(/--.*$/gm, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/'(?:''|[^'])*'/g, "''")
    .replace(/N''/g, "''");
}

function splitStatements(sqlText) {
  const text = String(sqlText || "");
  const statements = [];
  let current = "";
  let index = 0;
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;

  while (index < text.length) {
    const char = text[index];
    const next = text[index + 1];

    if (inLineComment) {
      current += char;
      if (char === "\n") inLineComment = false;
      index += 1;
      continue;
    }

    if (inBlockComment) {
      current += char;
      if (char === "*" && next === "/") {
        current += next;
        inBlockComment = false;
        index += 2;
        continue;
      }
      index += 1;
      continue;
    }

    if (inString) {
      current += char;
      if (char === "'" && next === "'") {
        current += next;
        index += 2;
        continue;
      }
      if (char === "'") inString = false;
      index += 1;
      continue;
    }

    if (char === "-" && next === "-") {
      current += char + next;
      inLineComment = true;
      index += 2;
      continue;
    }

    if (char === "/" && next === "*") {
      current += char + next;
      inBlockComment = true;
      index += 2;
      continue;
    }

    if (char === "'") {
      current += char;
      inString = true;
      index += 1;
      continue;
    }

    if (char === ";") {
      const statement = stripCommentsAndStrings(current).trim();
      if (statement) statements.push(current.trim());
      current = "";
      index += 1;
      continue;
    }

    current += char;
    index += 1;
  }

  const finalStatement = stripCommentsAndStrings(current).trim();
  if (finalStatement) statements.push(current.trim());
  return statements;
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

export function applySelectLimit(sqlText, limit) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 100, 1000));
  const sanitized = compactWhitespace(stripCommentsAndStrings(sqlText)).toUpperCase();

  if (/\bTOP\s*\(?\s*\d+/i.test(sanitized) || /\bOFFSET\s+\d+\s+ROWS\b/i.test(sanitized)) {
    return { ok: true, sql: sqlText, changed: false };
  }

  const match = String(sqlText || "").match(/^(\s*;?\s*SELECT\s+)(DISTINCT\s+)?/i);
  if (!match) {
    return {
      ok: false,
      reason:
        "max_rows cannot be safely applied to this SELECT. Add TOP or OFFSET/FETCH explicitly.",
    };
  }

  const prefix = match[0];
  const replacement = `${match[1]}${match[2] || ""}TOP ${safeLimit} `;
  return {
    ok: true,
    sql: `${replacement}${String(sqlText).slice(prefix.length)}`,
    changed: true,
  };
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
  const statements = splitStatements(sqlText);
  const operation = detectPrimaryOperation(sqlText);
  const blocked = hasBlockedKeyword(sqlText, permissions);
  const tables = extractObjectCandidates(sqlText);
  const warnings = buildQueryWarnings(sqlText, operation);
  const isWrite = isWriteOperation(operation);
  const tableChecks = isWrite
    ? tables.map((table) => ({ table, ...isTableAllowed(table, permissions) }))
    : [];
  const deniedTable = tableChecks.find((item) => !item.allowed);

  if (statements.length > 1) {
    return {
      ok: false,
      operation,
      tables,
      warnings,
      reason: "Multiple SQL statements in one request are blocked.",
      risk: "high",
      statementCount: statements.length,
    };
  }

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
    statementCount: statements.length,
  };
}
