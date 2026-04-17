const MAX_COL_WIDTH = 48;

function truncate(value, maxWidth) {
  const text = String(value ?? "");
  return text.length > maxWidth ? `${text.slice(0, maxWidth - 1)}…` : text;
}

function normalizeLines(lines = []) {
  return lines.flatMap((line) => String(line ?? "").split(/\r?\n/));
}

export function textResponse(text, isError = false) {
  return {
    content: [{ type: "text", text }],
    ...(isError ? { isError: true } : {}),
  };
}

export function boxTable(headers, rows, maxWidth = MAX_COL_WIDTH) {
  const safeHeaders = headers.map((header) => truncate(header, maxWidth));
  const safeRows = rows.map((row) =>
    row.map((cell) => truncate(cell, maxWidth).replace(/\r?\n/g, " "))
  );

  const widths = safeHeaders.map((header, index) =>
    Math.min(
      maxWidth,
      Math.max(header.length, ...safeRows.map((row) => String(row[index] ?? "").length))
    )
  );

  const top = `┌${widths.map((width) => "─".repeat(width + 2)).join("┬")}┐`;
  const middle = `├${widths.map((width) => "─".repeat(width + 2)).join("┼")}┤`;
  const bottom = `└${widths.map((width) => "─".repeat(width + 2)).join("┴")}┘`;

  const renderRow = (cells) =>
    `│ ${cells
      .map((cell, index) => String(cell ?? "").padEnd(widths[index]))
      .join(" │ ")} │`;

  return [top, renderRow(safeHeaders), middle, ...safeRows.map(renderRow), bottom].join("\n");
}

export function boxHeader(title, subtitle = "") {
  const inner = subtitle ? `${title}  ·  ${subtitle}` : title;
  return `╔${"═".repeat(inner.length + 2)}╗\n║ ${inner} ║\n╚${"═".repeat(inner.length + 2)}╝`;
}

export function boxSection(title, lines = [], minWidth = 40) {
  const normalized = normalizeLines(lines);
  const innerWidth = Math.max(
    minWidth,
    title.length + 4,
    ...normalized.map((line) => line.length + 1)
  );

  const top = `┌─ ${title} ${"─".repeat(Math.max(1, innerWidth - title.length - 2))}┐`;
  const body = normalized.map((line) => `│ ${line.padEnd(innerWidth)}│`);
  const bottom = `└${"─".repeat(innerWidth + 1)}┘`;

  return [top, ...body, bottom].join("\n");
}

export function section(title, lines = []) {
  return boxSection(title, lines);
}

export function keyValueTable(rows) {
  return rows.map(([key, value]) => `${key.padEnd(18)} ${value}`).join("\n");
}

export function markdownTable(headers, rows, maxWidth = MAX_COL_WIDTH) {
  return boxTable(headers, rows, maxWidth);
}

function escapeMarkdownCell(value) {
  return String(value ?? "")
    .replace(/\r?\n/g, " ")
    .replace(/\|/g, "\\|");
}

export function plainMarkdownTable(headers, rows) {
  const safeHeaders = headers.map(escapeMarkdownCell);
  const safeRows = rows.map((row) => row.map(escapeMarkdownCell));
  return [
    `| ${safeHeaders.join(" | ")} |`,
    `| ${safeHeaders.map(() => "---").join(" | ")} |`,
    ...safeRows.map((row) => `| ${row.join(" | ")} |`),
  ].join("\n");
}

export function renderTable(headers, rows, format = "box", maxWidth = MAX_COL_WIDTH) {
  if (format === "json") {
    const objects = rows.map((row) =>
      Object.fromEntries(headers.map((header, index) => [header, row[index] ?? null]))
    );
    return JSON.stringify(objects, null, 2);
  }

  if (format === "markdown") {
    return plainMarkdownTable(headers, rows);
  }

  return boxTable(headers, rows, maxWidth);
}

export function formatList(items, prefix = "-") {
  const values = items.map((item) => String(item));
  if (prefix !== "-") {
    return values.map((item) => `${prefix} ${item}`).join("\n");
  }

  return values
    .map((item, index) => `${index === values.length - 1 ? "└─" : "├─"} ${item}`)
    .join("\n");
}
