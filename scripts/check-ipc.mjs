import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
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

function commandsFromRustSource(source) {
  const tokens = rustTokens(source);
  const definitions = [];
  const registrations = [];

  for (let index = 0; index < tokens.length; index += 1) {
    if (tokenSequenceAt(tokens, index, ["#", "[", "tauri", "::", "command"])) {
      let cursor = index + 5;
      let depth = 1;
      while (cursor < tokens.length && depth > 0) {
        if (tokens[cursor].value === "[") depth += 1;
        if (tokens[cursor].value === "]") depth -= 1;
        cursor += 1;
      }
      while (
        cursor < tokens.length &&
        !(tokens[cursor].kind === "ident" && tokens[cursor].value === "fn")
      ) {
        cursor += 1;
      }
      if (tokens[cursor + 1]?.kind === "ident") {
        definitions.push(tokens[cursor + 1].value);
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

function forwardingParameters(fn, bindings, wrappers) {
  const indexes = new Set();
  const visit = (node) => {
    if (node !== fn && ts.isFunctionLike(node)) return;
    if (ts.isCallExpression(node)) {
      let commandArgument;
      if (isTauriInvokeCall(node, bindings)) {
        commandArgument = node.arguments[0];
      } else if (ts.isIdentifier(node.expression) && wrappers.has(node.expression.text)) {
        commandArgument = node.arguments[wrappers.get(node.expression.text)];
      }
      const index = parameterIndex(fn, commandArgument);
      if (index !== null) indexes.add(index);
    }
    ts.forEachChild(node, visit);
  };
  if (fn.body) visit(fn.body);
  return indexes;
}

function wrapperFunctions(file, bindings) {
  const functions = functionsIn(file);
  const wrappers = new Map();
  let changed = true;
  while (changed) {
    changed = false;
    for (const fn of functions) {
      if (wrappers.has(fn.name)) continue;
      const indexes = forwardingParameters(fn.node, bindings, wrappers);
      if (indexes.size === 1) {
        wrappers.set(fn.name, [...indexes][0]);
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

function enclosingFunction(node) {
  let owner = node.parent;
  while (owner && !ts.isFunctionLike(owner)) owner = owner.parent;
  return owner;
}

function staticCommand(argument) {
  if (argument && ts.isStringLiteralLike(argument)) return argument.text;
  return null;
}

export function frontendInvokeCommands(sources) {
  const commands = [];
  const dynamic = [];

  for (const { path, source } of sources) {
    const file = sourceFile(path, source);
    const bindings = tauriInvokeBindings(file);
    const wrappers = wrapperFunctions(file, bindings);
    const visit = (node) => {
      if (ts.isCallExpression(node)) {
        let argument;
        if (isTauriInvokeCall(node, bindings)) {
          argument = node.arguments[0];
        } else if (
          ts.isIdentifier(node.expression) &&
          wrappers.byName.has(node.expression.text)
        ) {
          argument = node.arguments[wrappers.byName.get(node.expression.text)];
        }
        if (argument) {
          const command = staticCommand(argument);
          if (command !== null) {
            commands.push(command);
          } else {
            const owner = enclosingFunction(node);
            const wrapperParameter = owner ? wrappers.byNode.get(owner) : undefined;
            const forwarded =
              wrapperParameter !== undefined &&
              parameterIndex(owner, argument) === wrapperParameter;
            if (!forwarded) {
              const { line, character } = file.getLineAndCharacterOfPosition(
                node.getStart(file),
              );
              dynamic.push(`${path}:${line + 1}:${character + 1}`);
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  return { commands, dynamic };
}

export function checkIpcContract({ rustSources, frontendSources, backendOnly = [] }) {
  const diagnostics = [];
  const rust = rustIpcCommands(rustSources);
  const frontend = frontendInvokeCommands(frontendSources);

  for (const [label, values] of [
    ["Rust command definitions", rust.definitions],
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
      rust.definitions,
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
