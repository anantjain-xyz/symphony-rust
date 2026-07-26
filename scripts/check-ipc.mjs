import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, posix, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

import { compareSets, rustTokens } from "./lib/source-contracts.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const BACKEND_ONLY_COMMANDS = ["get_issue_detail"];

function tokenSequenceAt(tokens, index, values) {
  return values.every((value, offset) => tokens[index + offset]?.value === value);
}

function duplicates(values) {
  const seen = new Set();
  const repeated = new Set();
  for (const value of values) {
    if (seen.has(value)) repeated.add(value);
    seen.add(value);
  }
  return [...repeated].sort();
}

function pushHandlerSegment(registrations, segment) {
  const identifiers = segment.filter((token) => token.kind === "ident");
  const command = identifiers.at(-1);
  if (command) registrations.push(command.value);
}

const RUST_INJECTED_ARGUMENT_TYPES = new Set([
  "AppHandle",
  "State",
  "WebviewWindow",
  "Window",
]);

function matchingTokenDelimiter(tokens, opening) {
  const pairs = new Map([
    ["(", ")"],
    ["[", "]"],
    ["{", "}"],
    ["<", ">"],
  ]);
  const expected = pairs.get(tokens[opening]?.value);
  if (!expected) return -1;
  const stack = [];
  for (let index = opening; index < tokens.length; index += 1) {
    const value = tokens[index].value;
    if (pairs.has(value)) {
      stack.push(pairs.get(value));
    } else if ([")", "]", "}", ">"].includes(value)) {
      if (stack.at(-1) !== value) return -1;
      stack.pop();
      if (stack.length === 0) return index;
    }
  }
  return -1;
}

function splitTopLevelTokens(tokens) {
  const groups = [];
  const stack = [];
  let start = 0;
  for (let index = 0; index < tokens.length; index += 1) {
    const value = tokens[index].value;
    if (["(", "[", "{", "<"].includes(value)) {
      stack.push({ "(": ")", "[": "]", "{": "}", "<": ">" }[value]);
    } else if ([")", "]", "}", ">"].includes(value)) {
      if (stack.at(-1) !== value) return [];
      stack.pop();
    } else if (value === "," && stack.length === 0) {
      groups.push(tokens.slice(start, index));
      start = index + 1;
    }
  }
  groups.push(tokens.slice(start));
  return groups;
}

function rustArgumentName(name, renameAll) {
  const words = name.split("_").filter(Boolean);
  switch (renameAll ?? "camelCase") {
    case "snake_case":
      return words.join("_");
    case "kebab-case":
      return words.join("-");
    case "PascalCase":
      return words.map((word) => word[0]?.toUpperCase() + word.slice(1)).join("");
    case "SCREAMING_SNAKE_CASE":
      return words.join("_").toUpperCase();
    case "lowercase":
      return words.join("");
    case "UPPERCASE":
      return words.join("").toUpperCase();
    case "camelCase":
    default:
      return (
        (words[0] ?? "") +
        words
          .slice(1)
          .map((word) => word[0]?.toUpperCase() + word.slice(1))
          .join("")
      );
  }
}

function commandRenameAll(attributeTokens) {
  for (let index = 0; index + 2 < attributeTokens.length; index += 1) {
    if (
      attributeTokens[index].value === "rename_all" &&
      attributeTokens[index + 1]?.value === "=" &&
      attributeTokens[index + 2]?.kind === "string"
    ) {
      return attributeTokens[index + 2].value;
    }
  }
  return null;
}

function commandArguments(tokens, opening, closing, renameAll) {
  const arguments_ = [];
  for (const parameter of splitTopLevelTokens(tokens.slice(opening + 1, closing))) {
    if (parameter.length === 0) continue;
    const colon = parameter.findIndex((token) => token.value === ":");
    if (colon < 0) continue;
    const name = parameter
      .slice(0, colon)
      .filter((token) => token.kind === "ident")
      .at(-1)?.value;
    const typeTokens = parameter.slice(colon + 1);
    const generic = typeTokens.findIndex((token) => token.value === "<");
    const outerType = typeTokens
      .slice(0, generic < 0 ? typeTokens.length : generic)
      .filter((token) => token.kind === "ident")
      .at(-1)?.value;
    if (
      !name ||
      name === "self" ||
      RUST_INJECTED_ARGUMENT_TYPES.has(outerType)
    ) {
      continue;
    }
    arguments_.push(rustArgumentName(name, renameAll));
  }
  return arguments_;
}

function commandsFromRustSource(source) {
  const tokens = rustTokens(source);
  const definitions = [];
  const registrations = [];

  for (let index = 0; index < tokens.length; index += 1) {
    if (tokenSequenceAt(tokens, index, ["#", "[", "tauri", "::", "command"])) {
      let cursor = index + 5;
      let depth = 1;
      const attributeStart = cursor;
      while (cursor < tokens.length && depth > 0) {
        if (tokens[cursor].value === "[") depth += 1;
        if (tokens[cursor].value === "]") depth -= 1;
        cursor += 1;
      }
      const attributeTokens = tokens.slice(attributeStart, cursor - 1);
      while (
        cursor < tokens.length &&
        !(tokens[cursor].kind === "ident" && tokens[cursor].value === "fn")
      ) {
        cursor += 1;
      }
      if (tokens[cursor + 1]?.kind === "ident") {
        let opening = cursor + 2;
        while (opening < tokens.length && tokens[opening].value !== "(") {
          opening += 1;
        }
        const closing = matchingTokenDelimiter(tokens, opening);
        definitions.push({
          name: tokens[cursor + 1].value,
          arguments:
            closing < 0
              ? []
              : commandArguments(
                  tokens,
                  opening,
                  closing,
                  commandRenameAll(attributeTokens),
                ),
        });
      }
    }

    if (
      tokens[index].kind === "ident" &&
      tokens[index].value === "generate_handler" &&
      tokens[index + 1]?.value === "!" &&
      tokens[index + 2]?.value === "["
    ) {
      let cursor = index + 3;
      let depth = 1;
      let segment = [];
      while (cursor < tokens.length && depth > 0) {
        const token = tokens[cursor];
        if (token.value === "[") {
          depth += 1;
          if (depth > 1) segment.push(token);
        } else if (token.value === "]") {
          depth -= 1;
          if (depth === 0) {
            pushHandlerSegment(registrations, segment);
            break;
          }
          segment.push(token);
        } else if (token.value === "," && depth === 1) {
          pushHandlerSegment(registrations, segment);
          segment = [];
        } else {
          segment.push(token);
        }
        cursor += 1;
      }
    }
  }
  return { definitions, registrations };
}

export function rustIpcCommands(sources) {
  const entries =
    typeof sources === "string" ? [{ path: "<rust>", source: sources }] : sources;
  const definitions = [];
  const registrations = [];
  for (const { source } of entries) {
    const commands = commandsFromRustSource(source);
    definitions.push(...commands.definitions);
    registrations.push(...commands.registrations);
  }
  return { definitions, registrations };
}

function sourceFile(path, source) {
  return ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

function tauriInvokeBindings(file) {
  const direct = new Set();
  const namespaces = new Set();
  for (const statement of file.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== "@tauri-apps/api/core"
    ) {
      continue;
    }
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        if ((element.propertyName?.text ?? element.name.text) === "invoke") {
          direct.add(element.name.text);
        }
      }
    } else if (bindings && ts.isNamespaceImport(bindings)) {
      namespaces.add(bindings.name.text);
    }
  }
  return { direct, namespaces };
}

function isTauriInvokeCall(node, bindings) {
  if (!ts.isCallExpression(node)) return false;
  if (ts.isIdentifier(node.expression)) {
    return bindings.direct.has(node.expression.text);
  }
  return (
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    bindings.namespaces.has(node.expression.expression.text) &&
    node.expression.name.text === "invoke"
  );
}

function namedFunction(node) {
  if (ts.isFunctionDeclaration(node) && node.name) {
    return { name: node.name.text, node };
  }
  if (
    ts.isVariableDeclaration(node) &&
    ts.isIdentifier(node.name) &&
    node.initializer &&
    (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
  ) {
    return { name: node.name.text, node: node.initializer };
  }
  return null;
}

function functionsIn(file) {
  const functions = [];
  const visit = (node) => {
    const entry = namedFunction(node);
    if (entry) functions.push(entry);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return functions;
}

function parameterIndex(fn, argument) {
  if (!argument || !ts.isIdentifier(argument)) return null;
  const index = fn.parameters.findIndex(
    (parameter) => ts.isIdentifier(parameter.name) && parameter.name.text === argument.text,
  );
  return index < 0 ? null : index;
}

function wrapperForCall(node, bindings, wrappers) {
  if (!ts.isCallExpression(node)) return null;
  if (isTauriInvokeCall(node, bindings)) {
    return { commandIndex: 0, argumentsIndex: 1 };
  }
  if (ts.isIdentifier(node.expression)) {
    return wrappers.get(node.expression.text) ?? null;
  }
  if (
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression)
  ) {
    return (
      wrappers.get(
        `${node.expression.expression.text}.${node.expression.name.text}`,
      ) ?? null
    );
  }
  return null;
}

function forwardingSignature(fn, bindings, wrappers) {
  const commandIndexes = new Set();
  const argumentsIndexes = new Set();
  const visit = (node) => {
    if (node !== fn && ts.isFunctionLike(node)) return;
    if (ts.isCallExpression(node)) {
      const called = wrapperForCall(node, bindings, wrappers);
      const commandArgument = called
        ? node.arguments[called.commandIndex]
        : undefined;
      const index = parameterIndex(fn, commandArgument);
      if (index !== null) {
        const argumentsIndex = parameterIndex(
          fn,
          called?.argumentsIndex === null
            ? undefined
            : node.arguments[called?.argumentsIndex],
        );
        commandIndexes.add(index);
        if (argumentsIndex !== null) argumentsIndexes.add(argumentsIndex);
      }
    }
    ts.forEachChild(node, visit);
  };
  if (fn.body) visit(fn.body);
  if (commandIndexes.size !== 1 || argumentsIndexes.size > 1) return null;
  return {
    commandIndex: [...commandIndexes][0],
    argumentsIndex:
      argumentsIndexes.size === 1 ? [...argumentsIndexes][0] : null,
  };
}

function wrapperFunctions(file, bindings, imported = new Map()) {
  const functions = functionsIn(file);
  const wrappers = new Map(imported);
  let changed = true;
  while (changed) {
    changed = false;
    for (const fn of functions) {
      if (wrappers.has(fn.name)) continue;
      const signature = forwardingSignature(fn.node, bindings, wrappers);
      if (signature) {
        wrappers.set(fn.name, signature);
        changed = true;
      }
    }
  }
  const byNode = new Map();
  for (const fn of functions) {
    if (wrappers.has(fn.name)) byNode.set(fn.node, wrappers.get(fn.name));
  }
  return { byName: wrappers, byNode };
}

function sourceImportPath(importer, specifier, sourcePaths) {
  if (!specifier.startsWith(".")) return null;
  const base = posix.normalize(posix.join(posix.dirname(importer), specifier));
  const withoutJavaScriptExtension = base.replace(/\.(?:m?js|jsx)$/u, "");
  for (const candidate of [
    base,
    withoutJavaScriptExtension,
    `${withoutJavaScriptExtension}.ts`,
    `${withoutJavaScriptExtension}.tsx`,
    `${withoutJavaScriptExtension}/index.ts`,
    `${withoutJavaScriptExtension}/index.tsx`,
  ]) {
    if (sourcePaths.has(candidate)) return candidate;
  }
  return null;
}

function importedWrapperBindings(record, records) {
  const imported = new Map();
  const sourcePaths = new Set(records.keys());
  for (const statement of record.file.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      continue;
    }
    const targetPath = sourceImportPath(
      record.path,
      statement.moduleSpecifier.text,
      sourcePaths,
    );
    const target = targetPath ? records.get(targetPath) : null;
    if (!target) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        const importedName = element.propertyName?.text ?? element.name.text;
        const signature = target.wrappers?.byName.get(importedName);
        if (signature) imported.set(element.name.text, signature);
      }
    } else if (bindings && ts.isNamespaceImport(bindings)) {
      for (const [name, signature] of target.wrappers?.byName ?? []) {
        imported.set(`${bindings.name.text}.${name}`, signature);
      }
    }
  }
  return imported;
}

function sameWrappers(left, right) {
  if (left.size !== right.size) return false;
  for (const [name, signature] of left) {
    const candidate = right.get(name);
    if (
      !candidate ||
      signature.commandIndex !== candidate.commandIndex ||
      signature.argumentsIndex !== candidate.argumentsIndex
    ) {
      return false;
    }
  }
  return true;
}

function frontendSourceRecords(sources) {
  const records = new Map(
    sources.map(({ path, source }) => {
      const file = sourceFile(path, source);
      const bindings = tauriInvokeBindings(file);
      return [
        path,
        {
          path,
          file,
          bindings,
          wrappers: wrapperFunctions(file, bindings),
        },
      ];
    }),
  );
  let changed = true;
  while (changed) {
    changed = false;
    for (const record of records.values()) {
      const wrappers = wrapperFunctions(
        record.file,
        record.bindings,
        importedWrapperBindings(record, records),
      );
      if (!sameWrappers(record.wrappers.byName, wrappers.byName)) {
        record.wrappers = wrappers;
        changed = true;
      }
    }
  }
  return records;
}

function enclosingFunction(node) {
  let owner = node.parent;
  while (owner && !ts.isFunctionLike(owner)) owner = owner.parent;
  return owner;
}

function staticCommand(argument) {
  if (argument && ts.isStringLiteralLike(argument)) return argument.text;
  return null;
}

function unwrapExpression(expression) {
  while (
    expression &&
    (ts.isAsExpression(expression) ||
      ts.isSatisfiesExpression(expression) ||
      ts.isParenthesizedExpression(expression) ||
      ts.isNonNullExpression(expression))
  ) {
    expression = expression.expression;
  }
  return expression;
}

function argumentPropertyName(property) {
  if (ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name)) {
    return property.name.text;
  }
  return null;
}

function staticArgumentKeys(argument) {
  if (
    !argument ||
    (ts.isIdentifier(argument) && argument.text === "undefined")
  ) {
    return [];
  }
  const expression = unwrapExpression(argument);
  if (!expression || !ts.isObjectLiteralExpression(expression)) return null;
  const keys = [];
  for (const property of expression.properties) {
    if (ts.isShorthandPropertyAssignment(property)) {
      keys.push(property.name.text);
      continue;
    }
    if (ts.isPropertyAssignment(property)) {
      const name = argumentPropertyName(property);
      if (name !== null) {
        keys.push(name);
        continue;
      }
    }
    return null;
  }
  return keys;
}

export function frontendInvokeCommands(sources) {
  const commands = [];
  const dynamic = [];
  const dynamicArguments = [];
  const usages = [];

  for (const record of frontendSourceRecords(sources).values()) {
    const { path, file, bindings, wrappers } = record;
    const visit = (node) => {
      if (ts.isCallExpression(node)) {
        const called = wrapperForCall(node, bindings, wrappers.byName);
        const argument = called
          ? node.arguments[called.commandIndex]
          : undefined;
        if (argument) {
          const { line, character } = file.getLineAndCharacterOfPosition(
            node.getStart(file),
          );
          const location = `${path}:${line + 1}:${character + 1}`;
          const command = staticCommand(argument);
          if (command !== null) {
            commands.push(command);
            const keys = staticArgumentKeys(
              called?.argumentsIndex === null
                ? undefined
                : node.arguments[called?.argumentsIndex],
            );
            if (keys === null) {
              dynamicArguments.push(`${command} at ${location}`);
            } else {
              usages.push({ command, arguments: keys, location });
            }
          } else {
            const owner = enclosingFunction(node);
            const wrapperParameter = owner ? wrappers.byNode.get(owner) : undefined;
            const forwarded =
              wrapperParameter !== undefined &&
              parameterIndex(owner, argument) ===
                wrapperParameter.commandIndex;
            if (!forwarded) {
              dynamic.push(location);
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  return { commands, dynamic, dynamicArguments, usages };
}

export function checkIpcContract({ rustSources, frontendSources, backendOnly = [] }) {
  const diagnostics = [];
  const rust = rustIpcCommands(rustSources);
  const frontend = frontendInvokeCommands(frontendSources);
  const definitionNames = rust.definitions.map((definition) => definition.name);

  for (const [label, values] of [
    ["Rust command definitions", definitionNames],
    ["Rust generate_handler! registrations", rust.registrations],
    ["backend-only command allowlist", backendOnly],
  ]) {
    const repeated = duplicates(values);
    if (repeated.length > 0) {
      diagnostics.push(`${label}: duplicates [${repeated.join(", ")}]`);
    }
  }
  diagnostics.push(
    ...compareSets(
      "Rust command definitions vs generate_handler!",
      definitionNames,
      rust.registrations,
    ),
    ...compareSets(
      "registered Rust commands vs frontend use + backend-only allowlist",
      rust.registrations,
      [...frontend.commands, ...backendOnly],
    ),
    ...compareSets(
      "backend-only allowlist must not overlap frontend use",
      [],
      backendOnly.filter((command) => frontend.commands.includes(command)),
    ),
  );
  if (frontend.dynamic.length > 0) {
    diagnostics.push(`non-literal frontend invokes: ${frontend.dynamic.join(", ")}`);
  }
  if (frontend.dynamicArguments.length > 0) {
    diagnostics.push(
      `non-literal frontend invoke argument objects: ${frontend.dynamicArguments.join(
        ", ",
      )}`,
    );
  }
  const definitions = new Map(
    rust.definitions.map((definition) => [definition.name, definition]),
  );
  for (const usage of frontend.usages) {
    const definition = definitions.get(usage.command);
    if (!definition) continue;
    diagnostics.push(
      ...compareSets(
        `IPC arguments for ${usage.command} at ${usage.location}`,
        definition.arguments,
        usage.arguments,
      ),
    );
    const repeated = duplicates(usage.arguments);
    if (repeated.length > 0) {
      diagnostics.push(
        `IPC arguments for ${usage.command} at ${usage.location}: duplicates [${repeated.join(
          ", ",
        )}]`,
      );
    }
  }
  return diagnostics;
}

function sourceFiles(root, directory, extensionPattern, include) {
  const result = [];
  const visit = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        visit(path);
      } else if (extensionPattern.test(entry.name) && include(entry.name)) {
        result.push({
          path: relative(root, path),
          source: readFileSync(path, "utf8"),
        });
      }
    }
  };
  visit(directory);
  return result.sort((left, right) => left.path.localeCompare(right.path));
}

function rustFiles(root) {
  return sourceFiles(root, join(root, "src-tauri", "src"), /\.rs$/u, () => true);
}

function frontendFiles(root) {
  return sourceFiles(
    root,
    join(root, "src"),
    /\.(?:ts|tsx)$/u,
    (name) => !name.includes(".test."),
  );
}

export function checkIpc(root = ROOT) {
  const diagnostics = checkIpcContract({
    rustSources: rustFiles(root),
    frontendSources: frontendFiles(root),
    backendOnly: BACKEND_ONLY_COMMANDS,
  });
  if (diagnostics.length > 0) throw new Error(diagnostics.join("\n"));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    checkIpc();
    console.log("IPC contract is consistent");
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
