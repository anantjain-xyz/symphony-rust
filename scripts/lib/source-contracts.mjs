export function rustTokens(source) {
  const tokens = [];
  let index = 0;

  while (index < source.length) {
    const char = source[index];
    if (/\s/u.test(char)) {
      index += 1;
      continue;
    }
    if (source.startsWith("//", index)) {
      const end = source.indexOf("\n", index + 2);
      index = end === -1 ? source.length : end + 1;
      continue;
    }
    if (source.startsWith("/*", index)) {
      let depth = 1;
      index += 2;
      while (index < source.length && depth > 0) {
        if (source.startsWith("/*", index)) {
          depth += 1;
          index += 2;
        } else if (source.startsWith("*/", index)) {
          depth -= 1;
          index += 2;
        } else {
          index += 1;
        }
      }
      continue;
    }
    if (char === "r" && (source[index + 1] === '"' || source[index + 1] === "#")) {
      let hashes = 0;
      let cursor = index + 1;
      while (source[cursor] === "#") {
        hashes += 1;
        cursor += 1;
      }
      if (source[cursor] === '"') {
        const terminator = `"${"#".repeat(hashes)}`;
        const end = source.indexOf(terminator, cursor + 1);
        const valueEnd = end === -1 ? source.length : end;
        tokens.push({ kind: "string", value: source.slice(cursor + 1, valueEnd) });
        index = end === -1 ? source.length : end + terminator.length;
        continue;
      }
    }
    if (char === '"') {
      let value = "";
      index += 1;
      while (index < source.length && source[index] !== '"') {
        if (source[index] === "\\") {
          const escaped = source[index + 1];
          const decoded = { n: "\n", r: "\r", t: "\t", "\\": "\\", '"': '"' }[escaped];
          value += decoded ?? escaped ?? "";
          index += 2;
        } else {
          value += source[index];
          index += 1;
        }
      }
      index += source[index] === '"' ? 1 : 0;
      tokens.push({ kind: "string", value });
      continue;
    }
    if (/[A-Za-z_]/u.test(char)) {
      let end = index + 1;
      while (/[A-Za-z0-9_]/u.test(source[end] ?? "")) end += 1;
      tokens.push({ kind: "ident", value: source.slice(index, end) });
      index = end;
      continue;
    }
    if (source.startsWith("::", index)) {
      tokens.push({ kind: "punct", value: "::" });
      index += 2;
      continue;
    }
    tokens.push({ kind: "punct", value: char });
    index += 1;
  }
  return tokens;
}

export function compareSets(label, expectedValues, actualValues) {
  const expected = new Set(expectedValues);
  const actual = new Set(actualValues);
  const missing = [...expected].filter((value) => !actual.has(value)).sort();
  const extra = [...actual].filter((value) => !expected.has(value)).sort();
  if (missing.length === 0 && extra.length === 0) return [];
  return [
    `${label}: ${[
      missing.length > 0 ? `missing [${missing.join(", ")}]` : null,
      extra.length > 0 ? `extra [${extra.join(", ")}]` : null,
    ]
      .filter(Boolean)
      .join("; ")}`,
  ];
}
