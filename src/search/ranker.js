import { DEFAULT_ALIASES } from "./aliases.js";
import { expandTokens, normalizeText, tokenize } from "../utils/text.js";

function buildSearchBlob(table) {
  if (table.normalizedSearchText) {
    return table.normalizedSearchText;
  }

  return normalizeText([
    table.fullName,
    table.description,
    ...table.columns.map((column) => column.name),
    ...table.columns.map((column) => column.description || ""),
    ...table.foreignKeys.map((fk) => fk.toFullName),
  ].join(" "));
}

function scoreTable(table, tokens) {
  const tableName = table.normalizedName || normalizeText(table.name);
  const fullName = table.normalizedFullName || normalizeText(table.fullName);
  const description = normalizeText(table.description);
  const columnNames = table.columns.map((column) => normalizeText(column.name));
  const columnDescriptions = table.columns.map((column) =>
    normalizeText(column.description || "")
  );
  const relatedTables = table.foreignKeys.map((fk) => normalizeText(fk.toFullName));

  let score = 0;
  const reasons = [];

  for (const token of tokens) {
    if (tableName === token || fullName === token) {
      score += 100;
      reasons.push(`exact table match: ${token}`);
      continue;
    }

    if (tableName.startsWith(token) || fullName.includes(token)) {
      score += 60;
      reasons.push(`table name match: ${token}`);
    }

    if (columnNames.some((name) => name === token)) {
      score += 40;
      reasons.push(`column exact match: ${token}`);
    } else if (columnNames.some((name) => name.includes(token))) {
      score += 25;
      reasons.push(`column partial match: ${token}`);
    }

    if (description.includes(token)) {
      score += 35;
      reasons.push(`table description match: ${token}`);
    }

    if (columnDescriptions.some((text) => text.includes(token))) {
      score += 20;
      reasons.push(`column description match: ${token}`);
    }

    if (relatedTables.some((text) => text.includes(token))) {
      score += 15;
      reasons.push(`related table match: ${token}`);
    }
  }

  score += Math.min(20, table.centrality || 0);
  return { score, reasons };
}

export function findEntities(catalog, query, limit = 10) {
  const baseTokens = tokenize(query);
  const tokens = expandTokens(baseTokens, DEFAULT_ALIASES);
  const ranked = catalog.tables
    .map((table) => {
      const searchBlob = buildSearchBlob(table);
      const { score, reasons } = scoreTable(table, tokens);
      const matchedTokens = tokens.filter((token) => searchBlob.includes(token));
      return {
        table,
        score: score + matchedTokens.length * 5,
        reasons,
        matchedTokens,
      };
    })
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.table.fullName.localeCompare(right.table.fullName))
    .slice(0, limit);

  return {
    query,
    tokens,
    results: ranked,
  };
}
