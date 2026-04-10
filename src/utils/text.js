export function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

export function compactWhitespace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

export function tokenize(value) {
  return normalizeText(value)
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

export function singularize(token) {
  if (token.endsWith("oes")) {
    return `${token.slice(0, -3)}ao`;
  }
  if (token.endsWith("aes")) {
    return `${token.slice(0, -3)}ao`;
  }
  if (token.endsWith("s") && token.length > 3) {
    return token.slice(0, -1);
  }
  return token;
}

export function expandTokens(tokens, aliasesMap = {}) {
  const expanded = new Set();

  for (const token of tokens) {
    expanded.add(token);
    expanded.add(singularize(token));

    for (const [canonical, aliases] of Object.entries(aliasesMap)) {
      const normalizedCanonical = normalizeText(canonical);
      const normalizedAliases = aliases.map((alias) => normalizeText(alias));

      if (token === normalizedCanonical || normalizedAliases.includes(token)) {
        expanded.add(normalizedCanonical);
        for (const alias of normalizedAliases) {
          expanded.add(alias);
        }
      }
    }
  }

  return [...expanded];
}

export function quoteIdentifier(value) {
  return `[${String(value).replace(/]/g, "]]")}]`;
}
