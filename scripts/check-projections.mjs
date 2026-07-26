import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

import { compareSets, rustTokens } from "./lib/source-contracts.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function duplicates(values) {
  const seen = new Set();
  const repeated = new Set();
  for (const value of values) {
    if (seen.has(value)) repeated.add(value);
    seen.add(value);
  }
  return [...repeated].sort();
}

function sequenceAt(tokens, index, values) {
  return values.every((value, offset) => tokens[index + offset]?.value === value);
}

export function rustPromptVariables(source) {
  const tokens = rustTokens(source);
  const declaration = tokens.findIndex(
    (_, index) =>
      sequenceAt(tokens, index, ["pub", "const", "PROMPT_VARIABLES"]) ||
      sequenceAt(tokens, index, ["const", "PROMPT_VARIABLES"]),
  );
  if (declaration < 0) throw new Error("Rust owner is missing PROMPT_VARIABLES");
  let cursor = declaration;
  while (cursor < tokens.length && tokens[cursor].value !== "=") cursor += 1;
  while (cursor < tokens.length && tokens[cursor].value !== "[") cursor += 1;
  if (cursor === tokens.length) throw new Error("PROMPT_VARIABLES must use an array literal");
  const variables = [];
  let depth = 1;
  for (cursor += 1; cursor < tokens.length && depth > 0; cursor += 1) {
    if (tokens[cursor].value === "[") depth += 1;
    if (tokens[cursor].value === "]") depth -= 1;
    if (depth === 1 && tokens[cursor].kind === "string") variables.push(tokens[cursor].value);
  }
  return variables;
}

function sourceFile(path, source) {
  return ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

function unwrap(expression) {
  while (ts.isAsExpression(expression) || ts.isSatisfiesExpression(expression)) {
    expression = expression.expression;
  }
  return expression;
}

function variableInitializer(file, name) {
  let result;
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) {
      result = node.initializer;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  if (!result) throw new Error(`${file.fileName}: missing ${name}`);
  return unwrap(result);
}

function staticPropertyName(property) {
  if (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) {
    return property.name.text;
  }
  throw new Error("projection objects must use static property names");
}

export function settingsPromptVariables(source, path = "src/views/SettingsView.tsx") {
  const file = sourceFile(path, source);
  const array = variableInitializer(file, "PROMPT_VARIABLES");
  if (!ts.isArrayLiteralExpression(array)) {
    throw new Error(`${path}: PROMPT_VARIABLES must be an array literal`);
  }
  return array.elements.map((element) => {
    element = unwrap(element);
    if (!ts.isObjectLiteralExpression(element)) {
      throw new Error(`${path}: prompt variable entries must be objects`);
    }
    const name = element.properties.find(
      (property) => ts.isPropertyAssignment(property) && staticPropertyName(property) === "name",
    );
    if (!name || !ts.isPropertyAssignment(name) || !ts.isStringLiteral(name.initializer)) {
      throw new Error(`${path}: every prompt variable needs a literal name`);
    }
    return name.initializer.text;
  });
}

export function readmePromptVariables(source) {
  const lines = source.split(/\r?\n/u);
  const header = lines.findIndex((line) => line.trim() === "| Placeholder | Renders as |");
  if (header < 0) throw new Error("README.md: missing prompt variable table");
  const variables = [];
  for (let index = header + 2; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line.startsWith("|")) break;
    const firstCell = line.split("|")[1]?.trim() ?? "";
    const match = /^`\{\{([^{}]+)\}\}`$/u.exec(firstCell);
    if (!match) throw new Error(`README.md:${index + 1}: malformed prompt placeholder ${firstCell}`);
    variables.push(match[1].trim());
  }
  return variables;
}

export function storageChangedTables(source) {
  const tokens = rustTokens(source);
  const tables = [];
  const dynamic = [];
  for (let index = 0; index < tokens.length; index += 1) {
    if (sequenceAt(tokens, index, ["self", ".", "changed", "("])) {
      const table = tokens[index + 4];
      if (table?.kind === "string") tables.push(table.value);
      else dynamic.push(table?.value ?? "<missing>");
    }
  }
  return { tables, dynamic };
}

export function dashboardInvalidationTables(
  source,
  path = "src/dashboardResources.ts",
) {
  const file = sourceFile(path, source);
  const object = variableInitializer(file, "TABLE_INVALIDATIONS");
  if (!ts.isObjectLiteralExpression(object)) {
    throw new Error(`${path}: TABLE_INVALIDATIONS must be an object literal`);
  }
  return object.properties.map((property) => staticPropertyName(property));
}

export function checkProjectionContract({
  rustPromptSource,
  settingsSource,
  readmeSource,
  storageSource,
  dashboardSource,
}) {
  const diagnostics = [];
  const rustVariables = rustPromptVariables(rustPromptSource);
  const settingsVariables = settingsPromptVariables(settingsSource);
  const readmeVariables = readmePromptVariables(readmeSource);
  const changed = storageChangedTables(storageSource);
  const invalidations = dashboardInvalidationTables(dashboardSource);

  diagnostics.push(
    ...compareSets("Rust prompt variables vs Settings UI", rustVariables, settingsVariables),
    ...compareSets("Rust prompt variables vs README", rustVariables, readmeVariables),
    ...compareSets("storage changed(table, …) producers vs frontend invalidations", changed.tables, invalidations),
  );
  for (const [label, values] of [
    ["Rust prompt variables", rustVariables],
    ["Settings prompt variables", settingsVariables],
    ["README prompt variables", readmeVariables],
    ["frontend invalidation tables", invalidations],
  ]) {
    const repeated = duplicates(values);
    if (repeated.length > 0) diagnostics.push(`${label}: duplicates [${repeated.join(", ")}]`);
  }
  if (changed.dynamic.length > 0) {
    diagnostics.push(
      `storage changed(table, …) producers must use literal table names: [${changed.dynamic.join(", ")}]`,
    );
  }
  return diagnostics;
}

export function checkProjections(root = ROOT) {
  const diagnostics = checkProjectionContract({
    rustPromptSource: readFileSync(join(root, "crates/symphony-core/src/prompt.rs"), "utf8"),
    settingsSource: readFileSync(join(root, "src/views/SettingsView.tsx"), "utf8"),
    readmeSource: readFileSync(join(root, "README.md"), "utf8"),
    storageSource: readFileSync(join(root, "crates/symphony-storage/src/repo.rs"), "utf8"),
    dashboardSource: readFileSync(join(root, "src/dashboardResources.ts"), "utf8"),
  });
  if (diagnostics.length > 0) throw new Error(diagnostics.join("\n"));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    checkProjections();
    console.log("source projections are consistent");
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
