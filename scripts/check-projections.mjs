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

// These are deliberately method/table scoped. Broad table allowlists would let
// a new domain mutation evade the checker merely because another method has a
// legitimate reason not to emit an independent invalidation.
const STORAGE_NOTIFICATION_EXCEPTIONS = new Set([
  // delete_retro's parent deletion is the observable domain change. The
  // remaining statements are compatibility cleanup for databases where
  // foreign-key cascades were not enabled; those child rows cannot be viewed
  // independently once the retro is gone.
  "delete_retro:retro_batch_items",
  "delete_retro:retro_batches",
  "delete_retro:retro_inputs",
  "delete_retro:retro_suggestions",
  // retro_batch_items is an internal join table. The retro_batches event owns
  // the frontend invalidation for a newly reserved batch.
  "reserve_retro_batch:retro_batch_items",
  // This self-assignment acquires SQLite's write lock before review-state
  // validation. It does not change observable retro state.
  "reserve_retro_batch:retros",
]);

function matchingDelimiter(tokens, start, open, close) {
  let depth = 0;
  for (let index = start; index < tokens.length; index += 1) {
    if (tokens[index].value === open) depth += 1;
    if (tokens[index].value === close) depth -= 1;
    if (depth === 0) return index;
  }
  return -1;
}

function repositoryMethods(tokens) {
  const methods = [];
  for (let index = 0; index < tokens.length - 1; index += 1) {
    if (!sequenceAt(tokens, index, ["impl", "Repository"])) continue;
    let implOpen = index + 2;
    while (implOpen < tokens.length && tokens[implOpen].value !== "{") implOpen += 1;
    if (implOpen === tokens.length) continue;
    const implClose = matchingDelimiter(tokens, implOpen, "{", "}");
    if (implClose < 0) throw new Error("Repository impl has an unclosed body");

    for (let cursor = implOpen + 1; cursor < implClose; cursor += 1) {
      if (tokens[cursor].value !== "fn") continue;
      const name = tokens[cursor + 1];
      if (name?.kind !== "ident") continue;
      let bodyOpen = cursor + 2;
      while (
        bodyOpen < implClose &&
        tokens[bodyOpen].value !== "{" &&
        tokens[bodyOpen].value !== ";"
      ) {
        bodyOpen += 1;
      }
      if (tokens[bodyOpen]?.value !== "{") continue;
      const bodyClose = matchingDelimiter(tokens, bodyOpen, "{", "}");
      if (bodyClose < 0 || bodyClose > implClose) {
        throw new Error(`Repository::${name.value} has an unclosed body`);
      }
      methods.push({
        name: name.value,
        tokens: tokens.slice(bodyOpen + 1, bodyClose),
      });
      cursor = bodyClose;
    }
    index = implClose;
  }
  return methods;
}

function callOpen(tokens, start) {
  for (let index = start; index < Math.min(tokens.length, start + 40); index += 1) {
    if (tokens[index].value === "(") return index;
    if (tokens[index].value === ";" || tokens[index].value === "{") return -1;
  }
  return -1;
}

function sqlMutationTable(sql) {
  const withoutLeadingComments = sql
    .replace(/^\s*(?:--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)/u, "")
    .trimStart();
  const match =
    /^(?:insert(?:\s+or\s+[a-z_]+)?\s+into|replace\s+into|update|delete\s+from)\s+["`[]?([a-z_][a-z0-9_]*)/iu.exec(
      withoutLeadingComments,
    );
  return match?.[1]?.toLowerCase() ?? null;
}

function methodSqlMutations(method) {
  const tables = [];
  const dynamicQueries = [];
  const tokens = method.tokens;
  for (let index = 0; index < tokens.length; index += 1) {
    const sqlxQuery =
      sequenceAt(tokens, index, ["sqlx", "::"]) &&
      /^query(?:_as|_scalar)?$/u.test(tokens[index + 2]?.value ?? "");
    const queryBuilder = tokens[index].value === "QueryBuilder";
    if (!sqlxQuery && !queryBuilder) continue;

    let open;
    if (sqlxQuery) {
      open = callOpen(tokens, index + 3);
    } else {
      let constructor = index + 1;
      while (
        constructor < Math.min(tokens.length, index + 40) &&
        tokens[constructor].value !== "new"
      ) {
        constructor += 1;
      }
      if (tokens[constructor]?.value !== "new") continue;
      open = callOpen(tokens, constructor + 1);
    }
    if (open < 0) continue;

    const firstArgument = tokens[open + 1];
    if (firstArgument?.kind !== "string") {
      // Repository writes conventionally use sqlx::query. Refuse an opaque
      // query here so moving a mutation into a runtime-built string cannot
      // silently bypass notification ownership. Dynamic query_as/query_scalar
      // and QueryBuilder calls are read paths in this repository.
      if (sqlxQuery && tokens[index + 2].value === "query") {
        dynamicQueries.push(firstArgument?.value ?? "<missing>");
      }
      continue;
    }
    const table = sqlMutationTable(firstArgument.value);
    if (table) tables.push(table);
  }
  return { tables, dynamicQueries };
}

function methodChangedTables(method) {
  const tables = [];
  for (let index = 0; index < method.tokens.length; index += 1) {
    if (!sequenceAt(method.tokens, index, ["self", ".", "changed", "("])) continue;
    const table = method.tokens[index + 4];
    if (table?.kind === "string") tables.push(table.value);
  }
  return tables;
}

export function storageMutationDiagnostics(source) {
  const diagnostics = [];
  const methods = repositoryMethods(rustTokens(source));
  for (const method of methods) {
    const mutations = methodSqlMutations(method);
    const changed = new Set(methodChangedTables(method));
    const missing = [
      ...new Set(
        mutations.tables.filter(
          (table) =>
            !changed.has(table) &&
            !STORAGE_NOTIFICATION_EXCEPTIONS.has(`${method.name}:${table}`),
        ),
      ),
    ].sort();
    if (missing.length > 0) {
      diagnostics.push(
        `storage mutation notifications: Repository::${method.name} mutates [${missing.join(
          ", ",
        )}] without matching self.changed(table, …) calls`,
      );
    }
    if (mutations.dynamicQueries.length > 0) {
      diagnostics.push(
        `storage mutation notifications: Repository::${method.name} uses non-literal sqlx::query arguments [${mutations.dynamicQueries.join(
          ", ",
        )}]`,
      );
    }
  }
  return diagnostics;
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
    ...storageMutationDiagnostics(storageSource),
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
