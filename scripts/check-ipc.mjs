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

const RUST_STRING_TYPES = new Set(["String", "str", "char"]);
const RUST_NUMBER_TYPES = new Set([
  "f32",
  "f64",
  "i8",
  "i16",
  "i32",
  "i64",
  "i128",
  "isize",
  "u8",
  "u16",
  "u32",
  "u64",
  "u128",
  "usize",
]);
const RUST_ARRAY_TYPES = new Set([
  "BinaryHeap",
  "BTreeSet",
  "HashSet",
  "LinkedList",
  "Vec",
  "VecDeque",
]);
const RUST_MAP_TYPES = new Set(["BTreeMap", "HashMap", "IndexMap"]);
const RUST_TRANSPARENT_TYPES = new Set(["Arc", "Box", "Cow", "Rc"]);

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

function splitTopLevelTokens(tokens, separator = ",") {
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
    } else if (value === separator && stack.length === 0) {
      groups.push(tokens.slice(start, index));
      start = index + 1;
    }
  }
  groups.push(tokens.slice(start));
  return groups;
}

function trimRustTypeTokens(tokens) {
  let start = 0;
  while (tokens[start]?.value === "&") {
    start += 1;
    if (tokens[start]?.value === "'") {
      start += 1;
      if (tokens[start]?.kind === "ident") start += 1;
    }
    if (tokens[start]?.value === "mut") start += 1;
  }
  return tokens.slice(start);
}

function rustTypeName(tokens) {
  const generic = tokens.findIndex((token) => token.value === "<");
  return tokens
    .slice(0, generic < 0 ? tokens.length : generic)
    .filter((token) => token.kind === "ident")
    .at(-1)?.value;
}

function rustGenericArguments(tokens) {
  const opening = tokens.findIndex((token) => token.value === "<");
  if (opening < 0) return [];
  const closing = matchingTokenDelimiter(tokens, opening);
  if (closing < 0) return [];
  return splitTopLevelTokens(tokens.slice(opening + 1, closing)).filter(
    (argument) =>
      argument.length > 0 &&
      !(argument[0].value === "'" && argument.length <= 2),
  );
}

function rustWireType(typeTokens, aliases = new Map(), resolving = new Set()) {
  const tokens = trimRustTypeTokens(typeTokens);
  if (tokens.length === 0) return { kind: "unknown", source: "empty Rust type" };

  if (tokens[0].value === "(") {
    const closing = matchingTokenDelimiter(tokens, 0);
    if (closing === tokens.length - 1) {
      const items = splitTopLevelTokens(tokens.slice(1, closing)).filter(
        (item) => item.length > 0,
      );
      if (items.length === 0) return { kind: "null" };
      return {
        kind: "tuple",
        items: items.map((item) => rustWireType(item, aliases, resolving)),
      };
    }
  }

  if (tokens[0].value === "[") {
    const closing = matchingTokenDelimiter(tokens, 0);
    if (closing === tokens.length - 1) {
      const [item] = splitTopLevelTokens(tokens.slice(1, closing), ";");
      return {
        kind: "array",
        item: rustWireType(item ?? [], aliases, resolving),
      };
    }
  }

  const name = rustTypeName(tokens);
  if (!name) return { kind: "unknown", source: "unparsed Rust type" };
  const genericArguments = rustGenericArguments(tokens);
  if (RUST_STRING_TYPES.has(name)) return { kind: "string" };
  if (RUST_NUMBER_TYPES.has(name)) return { kind: "number" };
  if (name === "bool") return { kind: "boolean" };
  if (name === "Option") {
    return {
      kind: "union",
      variants: [
        rustWireType(genericArguments.at(-1) ?? [], aliases, resolving),
        { kind: "null" },
      ],
    };
  }
  if (RUST_ARRAY_TYPES.has(name)) {
    return {
      kind: "array",
      item: rustWireType(genericArguments.at(-1) ?? [], aliases, resolving),
    };
  }
  if (RUST_MAP_TYPES.has(name)) {
    return {
      kind: "map",
      key: rustWireType(genericArguments[0] ?? [], aliases, resolving),
      value: rustWireType(genericArguments[1] ?? [], aliases, resolving),
    };
  }
  if (RUST_TRANSPARENT_TYPES.has(name)) {
    return rustWireType(genericArguments.at(-1) ?? [], aliases, resolving);
  }
  if (name === "Value" && tokens.some((token) => token.value === "serde_json")) {
    return { kind: "json" };
  }
  if (aliases.has(name) && !resolving.has(name)) {
    const nested = new Set(resolving);
    nested.add(name);
    return rustWireType(aliases.get(name), aliases, nested);
  }
  return {
    kind: "named",
    name,
    arguments: genericArguments.map((argument) =>
      rustWireType(argument, aliases, resolving),
    ),
  };
}

function commandReturnType(tokens, closing, aliases) {
  let cursor = closing + 1;
  if (tokens[cursor]?.value !== "-" || tokens[cursor + 1]?.value !== ">") {
    return { kind: "null" };
  }
  cursor += 2;
  const start = cursor;
  const stack = [];
  while (cursor < tokens.length) {
    const value = tokens[cursor].value;
    if (["(", "[", "<"].includes(value)) {
      stack.push({ "(": ")", "[": "]", "<": ">" }[value]);
    } else if ([")", "]", ">"].includes(value)) {
      if (stack.at(-1) === value) stack.pop();
    } else if (
      stack.length === 0 &&
      (value === "{" || value === ";" || value === "where")
    ) {
      break;
    }
    cursor += 1;
  }
  const returnTokens = tokens.slice(start, cursor);
  if (rustTypeName(trimRustTypeTokens(returnTokens)) === "Result") {
    const [success] = rustGenericArguments(returnTokens);
    return rustWireType(success ?? [], aliases);
  }
  return rustWireType(returnTokens, aliases);
}

function rustTypeAliases(entries) {
  const aliases = new Map();
  for (const { source } of entries) {
    const tokens = rustTokens(source);
    for (let index = 0; index + 3 < tokens.length; index += 1) {
      if (
        tokens[index].value !== "type" ||
        tokens[index + 1]?.kind !== "ident" ||
        tokens[index + 2]?.value !== "="
      ) {
        continue;
      }
      let end = index + 3;
      const stack = [];
      while (end < tokens.length) {
        const value = tokens[end].value;
        if (["(", "[", "{", "<"].includes(value)) {
          stack.push({ "(": ")", "[": "]", "{": "}", "<": ">" }[value]);
        } else if ([")", "]", "}", ">"].includes(value)) {
          if (stack.at(-1) === value) stack.pop();
        } else if (value === ";" && stack.length === 0) {
          break;
        }
        end += 1;
      }
      if (tokens[end]?.value === ";") {
        aliases.set(tokens[index + 1].value, tokens.slice(index + 3, end));
      }
    }
  }
  return aliases;
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

function commandArguments(tokens, opening, closing, renameAll, aliases) {
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
    const outerType = rustTypeName(trimRustTypeTokens(typeTokens));
    if (
      !name ||
      name === "self" ||
      RUST_INJECTED_ARGUMENT_TYPES.has(outerType)
    ) {
      continue;
    }
    arguments_.push({
      name: rustArgumentName(name, renameAll),
      type: rustWireType(typeTokens, aliases),
    });
  }
  return arguments_;
}

function commandsFromRustSource(source, aliases) {
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
                  aliases,
                ),
          returnType:
            closing < 0
              ? { kind: "unknown", source: "unparsed Rust command return type" }
              : commandReturnType(tokens, closing, aliases),
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
  const aliases = rustTypeAliases(entries);
  const definitions = [];
  const registrations = [];
  for (const { source } of entries) {
    const commands = commandsFromRustSource(source, aliases);
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

const FRONTEND_VIRTUAL_ROOT = "/__symphony_ipc__";

function frontendProgram(sources) {
  const options = {
    jsx: ts.JsxEmit.ReactJSX,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    skipLibCheck: true,
    strictNullChecks: true,
    target: ts.ScriptTarget.Latest,
  };
  const virtualPaths = new Map(
    sources.map(({ path }) => [
      path,
      posix.join(FRONTEND_VIRTUAL_ROOT, path),
    ]),
  );
  const virtualSources = new Map(
    sources.map(({ path, source }) => [virtualPaths.get(path), source]),
  );
  const host = ts.createCompilerHost(options, true);
  const defaultFileExists = host.fileExists.bind(host);
  const defaultReadFile = host.readFile.bind(host);
  const defaultGetSourceFile = host.getSourceFile.bind(host);
  host.getCurrentDirectory = () => FRONTEND_VIRTUAL_ROOT;
  host.fileExists = (path) =>
    virtualSources.has(posix.normalize(path)) || defaultFileExists(path);
  host.readFile = (path) =>
    virtualSources.get(posix.normalize(path)) ?? defaultReadFile(path);
  host.getSourceFile = (
    path,
    languageVersion,
    onError,
    shouldCreateNewSourceFile,
  ) => {
    const normalized = posix.normalize(path);
    const source = virtualSources.get(normalized);
    return source === undefined
      ? defaultGetSourceFile(
          path,
          languageVersion,
          onError,
          shouldCreateNewSourceFile,
        )
      : sourceFile(normalized, source);
  };
  const sourcePaths = new Set(virtualPaths.keys());
  host.resolveModuleNames = (moduleNames, containingFile) =>
    moduleNames.map((specifier) => {
      const importer = [...virtualPaths].find(
        ([, virtualPath]) => virtualPath === posix.normalize(containingFile),
      )?.[0];
      const target = importer
        ? sourceImportPath(importer, specifier, sourcePaths)
        : null;
      if (target) {
        const resolvedFileName = virtualPaths.get(target);
        return {
          extension: target.endsWith("x")
            ? ts.Extension.Tsx
            : ts.Extension.Ts,
          isExternalLibraryImport: false,
          resolvedFileName,
        };
      }
      return ts.resolveModuleName(
        specifier,
        containingFile,
        options,
        host,
      ).resolvedModule;
    });
  const program = ts.createProgram({
    rootNames: [...virtualPaths.values()],
    options,
    host,
  });
  return {
    checker: program.getTypeChecker(),
    files: new Map(
      [...virtualPaths].map(([path, virtualPath]) => [
        path,
        program.getSourceFile(virtualPath),
      ]),
    ),
  };
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
  const program = frontendProgram(sources);
  const records = new Map(
    sources.map(({ path, source }) => {
      const file = program.files.get(path) ?? sourceFile(path, source);
      const bindings = tauriInvokeBindings(file);
      return [
        path,
        {
          path,
          file,
          checker: program.checker,
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

function staticFrontendReturnType(call, checker) {
  if (call.typeArguments?.length !== 1) return null;
  return frontendWireType(
    checker,
    checker.getTypeFromTypeNode(call.typeArguments[0]),
  );
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

function wireTypeKey(type) {
  switch (type.kind) {
    case "alias":
      return `alias:${type.name}:${wireTypeKey(type.target)}`;
    case "array":
      return `array:${wireTypeKey(type.item)}`;
    case "map":
      return `map:${wireTypeKey(type.key)}:${wireTypeKey(type.value)}`;
    case "named":
      return `named:${type.name}<${type.arguments.map(wireTypeKey).join(",")}>`;
    case "object":
      return `object:{${type.fields
        .map((field) => `${field.name}:${wireTypeKey(field.type)}`)
        .join(",")}}`;
    case "tuple":
      return `tuple:[${type.items.map(wireTypeKey).join(",")}]`;
    case "union":
      return `union:${type.variants.map(wireTypeKey).sort().join("|")}`;
    case "unknown":
      return `unknown:${type.source}`;
    default:
      return type.kind;
  }
}

function unionWireType(variants) {
  const flattened = variants.flatMap((variant) =>
    variant.kind === "union" ? variant.variants : [variant],
  );
  const unique = new Map(
    flattened.map((variant) => [wireTypeKey(variant), variant]),
  );
  const sorted = [...unique].sort(([left], [right]) =>
    left.localeCompare(right),
  );
  if (sorted.length === 1) return sorted[0][1];
  return { kind: "union", variants: sorted.map(([, variant]) => variant) };
}

function frontendWireType(checker, type, resolving = new Set()) {
  if (!type) return { kind: "unknown", source: "missing TypeScript type" };
  if (type.flags & ts.TypeFlags.Any) {
    return { kind: "unknown", source: "any" };
  }
  if (type.flags & ts.TypeFlags.Unknown) {
    return { kind: "unknown", source: "unknown" };
  }
  if (type.flags & ts.TypeFlags.Never) {
    return { kind: "unknown", source: "never" };
  }
  if (type.flags & (ts.TypeFlags.StringLike | ts.TypeFlags.TemplateLiteral)) {
    return { kind: "string" };
  }
  if (type.flags & ts.TypeFlags.NumberLike) return { kind: "number" };
  if (type.flags & ts.TypeFlags.BooleanLike) return { kind: "boolean" };
  if (
    type.flags &
    (ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void)
  ) {
    return { kind: "null" };
  }
  if (type.flags & ts.TypeFlags.BigIntLike) return { kind: "bigint" };

  const typeId = type.id ?? checker.typeToString(type);
  if (resolving.has(typeId)) {
    const name = type.aliasSymbol?.getName() ?? type.symbol?.getName();
    return name && name !== "__type"
      ? { kind: "named", name, arguments: [] }
      : { kind: "unknown", source: "recursive TypeScript type" };
  }
  const nested = new Set(resolving);
  nested.add(typeId);

  if (type.isUnion()) {
    const target = unionWireType(
      type.types.map((variant) => frontendWireType(checker, variant, nested)),
    );
    const alias = type.aliasSymbol?.getName();
    return alias
      ? { kind: "alias", name: alias, target }
      : target;
  }
  if (checker.isTupleType(type)) {
    return {
      kind: "tuple",
      items: checker
        .getTypeArguments(type)
        .map((item) => frontendWireType(checker, item, nested)),
    };
  }
  if (checker.isArrayType(type)) {
    return {
      kind: "array",
      item: frontendWireType(
        checker,
        checker.getTypeArguments(type)[0],
        nested,
      ),
    };
  }

  const alias = type.aliasSymbol?.getName();
  const aliasArguments = type.aliasTypeArguments ?? [];
  if (alias === "Record" && aliasArguments.length === 2) {
    return {
      kind: "map",
      key: frontendWireType(checker, aliasArguments[0], nested),
      value: frontendWireType(checker, aliasArguments[1], nested),
    };
  }
  if (
    ["NonNullable", "Readonly", "Required"].includes(alias) &&
    aliasArguments.length === 1
  ) {
    return frontendWireType(checker, aliasArguments[0], nested);
  }
  if (alias) {
    return {
      kind: "named",
      name: alias,
      arguments: aliasArguments.map((argument) =>
        frontendWireType(checker, argument, nested),
      ),
    };
  }

  const stringIndex = checker.getIndexTypeOfType(type, ts.IndexKind.String);
  const properties = checker.getPropertiesOfType(type);
  if (stringIndex && properties.length === 0) {
    return {
      kind: "map",
      key: { kind: "string" },
      value: frontendWireType(checker, stringIndex, nested),
    };
  }

  const symbolName = type.symbol?.getName();
  if (symbolName && !["__object", "__type"].includes(symbolName)) {
    return { kind: "named", name: symbolName, arguments: [] };
  }
  if (type.flags & ts.TypeFlags.Object) {
    return {
      kind: "object",
      fields: properties
        .map((property) => {
          const declaration =
            property.valueDeclaration ?? property.declarations?.[0];
          return {
            name: property.getName(),
            type: declaration
              ? frontendWireType(
                  checker,
                  checker.getTypeOfSymbolAtLocation(property, declaration),
                  nested,
                )
              : { kind: "unknown", source: "undeclared object property" },
          };
        })
        .sort((left, right) => left.name.localeCompare(right.name)),
    };
  }
  return {
    kind: "unknown",
    source: checker.typeToString(type),
  };
}

function frontendExpressionWireType(expression, checker) {
  const value = unwrapExpression(expression);
  if (value && ts.isArrayLiteralExpression(value)) {
    return {
      kind: "tuple",
      items: value.elements.map((element) =>
        frontendExpressionWireType(element, checker),
      ),
    };
  }
  if (value && ts.isObjectLiteralExpression(value)) {
    const entries = staticArgumentEntries(value, checker);
    return entries === null
      ? { kind: "unknown", source: "non-literal object value" }
      : {
          kind: "object",
          fields: entries
            .map((entry) => ({ name: entry.name, type: entry.type }))
            .sort((left, right) => left.name.localeCompare(right.name)),
        };
  }
  return frontendWireType(
    checker,
    checker.getTypeAtLocation(value ?? expression),
  );
}

function staticArgumentEntries(argument, checker) {
  if (
    !argument ||
    (ts.isIdentifier(argument) && argument.text === "undefined")
  ) {
    return [];
  }
  const expression = unwrapExpression(argument);
  if (!expression || !ts.isObjectLiteralExpression(expression)) return null;
  const entries = [];
  for (const property of expression.properties) {
    if (ts.isShorthandPropertyAssignment(property)) {
      entries.push({
        name: property.name.text,
        type: frontendExpressionWireType(property.name, checker),
      });
      continue;
    }
    if (ts.isPropertyAssignment(property)) {
      const name = argumentPropertyName(property);
      if (name !== null) {
        entries.push({
          name,
          type: frontendExpressionWireType(property.initializer, checker),
        });
        continue;
      }
    }
    return null;
  }
  return entries;
}

export function frontendInvokeCommands(sources) {
  const commands = [];
  const dynamic = [];
  const dynamicArguments = [];
  const dynamicReturnTypes = [];
  const usages = [];

  for (const record of frontendSourceRecords(sources).values()) {
    const { path, file, checker, bindings, wrappers } = record;
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
            const arguments_ = staticArgumentEntries(
              called?.argumentsIndex === null
                ? undefined
                : node.arguments[called?.argumentsIndex],
              checker,
            );
            if (arguments_ === null) {
              dynamicArguments.push(`${command} at ${location}`);
            } else {
              const returnType = staticFrontendReturnType(node, checker);
              if (returnType === null) {
                dynamicReturnTypes.push(`${command} at ${location}`);
              } else {
                usages.push({
                  command,
                  arguments: arguments_,
                  returnType,
                  location,
                });
              }
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
  return {
    commands,
    dynamic,
    dynamicArguments,
    dynamicReturnTypes,
    usages,
  };
}

function namedWireType(type) {
  return type.kind === "named" || type.kind === "alias" ? type.name : null;
}

function wireTypesCompatible(expected, actual, comparing = new Set()) {
  const pair = `${wireTypeKey(expected)}=>${wireTypeKey(actual)}`;
  if (comparing.has(pair)) return true;
  const nested = new Set(comparing);
  nested.add(pair);

  const expectedName = namedWireType(expected);
  const actualName = namedWireType(actual);
  if (expectedName && expectedName === actualName) {
    const expectedArguments = expected.arguments ?? [];
    const actualArguments = actual.arguments ?? [];
    return (
      expectedArguments.length === actualArguments.length &&
      expectedArguments.every((argument, index) =>
        wireTypesCompatible(argument, actualArguments[index], nested),
      )
    );
  }
  if (expected.kind === "alias") {
    return wireTypesCompatible(expected.target, actual, nested);
  }
  if (actual.kind === "alias") {
    return wireTypesCompatible(expected, actual.target, nested);
  }
  if (expected.kind === "json") {
    return !["bigint", "unknown"].includes(actual.kind);
  }
  if (expected.kind === "union") {
    const actualVariants =
      actual.kind === "union" ? actual.variants : [actual];
    return actualVariants.every((variant) =>
      expected.variants.some((candidate) =>
        wireTypesCompatible(candidate, variant, nested),
      ),
    );
  }
  if (actual.kind === "union") {
    return actual.variants.every((variant) =>
      wireTypesCompatible(expected, variant, nested),
    );
  }
  if (expected.kind === "array" && actual.kind === "tuple") {
    return actual.items.every((item) =>
      wireTypesCompatible(expected.item, item, nested),
    );
  }
  if (expected.kind === "map" && actual.kind === "object") {
    return (
      expected.key.kind === "string" &&
      actual.fields.every((field) =>
        wireTypesCompatible(expected.value, field.type, nested),
      )
    );
  }
  if (expected.kind !== actual.kind) return false;

  switch (expected.kind) {
    case "array":
      return wireTypesCompatible(expected.item, actual.item, nested);
    case "map":
      return (
        wireTypesCompatible(expected.key, actual.key, nested) &&
        wireTypesCompatible(expected.value, actual.value, nested)
      );
    case "named":
      return (
        expected.name === actual.name &&
        expected.arguments.length === actual.arguments.length &&
        expected.arguments.every((argument, index) =>
          wireTypesCompatible(argument, actual.arguments[index], nested),
        )
      );
    case "object":
      return (
        expected.fields.length === actual.fields.length &&
        expected.fields.every((field, index) => {
          const candidate = actual.fields[index];
          return (
            field.name === candidate?.name &&
            wireTypesCompatible(field.type, candidate.type, nested)
          );
        })
      );
    case "tuple":
      return (
        expected.items.length === actual.items.length &&
        expected.items.every((item, index) =>
          wireTypesCompatible(item, actual.items[index], nested),
        )
      );
    case "unknown":
      return false;
    default:
      return true;
  }
}

function wireTypeText(type) {
  switch (type.kind) {
    case "alias":
      return `${type.name} (${wireTypeText(type.target)})`;
    case "array":
      return `${wireTypeText(type.item)}[]`;
    case "map":
      return `Record<${wireTypeText(type.key)}, ${wireTypeText(type.value)}>`;
    case "named":
      return type.arguments.length === 0
        ? type.name
        : `${type.name}<${type.arguments.map(wireTypeText).join(", ")}>`;
    case "object":
      return `{ ${type.fields
        .map((field) => `${field.name}: ${wireTypeText(field.type)}`)
        .join("; ")} }`;
    case "tuple":
      return `[${type.items.map(wireTypeText).join(", ")}]`;
    case "union":
      return type.variants.map(wireTypeText).join(" | ");
    case "unknown":
      return `unknown (${type.source})`;
    default:
      return type.kind;
  }
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
  if (frontend.dynamicReturnTypes.length > 0) {
    diagnostics.push(
      `frontend invokes without one explicit result type: ${frontend.dynamicReturnTypes.join(
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
    const expectedNames = definition.arguments.map((argument) => argument.name);
    const actualNames = usage.arguments.map((argument) => argument.name);
    diagnostics.push(
      ...compareSets(
        `IPC arguments for ${usage.command} at ${usage.location}`,
        expectedNames,
        actualNames,
      ),
    );
    const repeated = duplicates(actualNames);
    if (repeated.length > 0) {
      diagnostics.push(
        `IPC arguments for ${usage.command} at ${usage.location}: duplicates [${repeated.join(
          ", ",
        )}]`,
      );
    }
    const actualByName = new Map(
      usage.arguments.map((argument) => [argument.name, argument]),
    );
    for (const expected of definition.arguments) {
      const actual = actualByName.get(expected.name);
      if (
        actual &&
        !wireTypesCompatible(expected.type, actual.type)
      ) {
        diagnostics.push(
          `IPC argument value type for ${usage.command}.${expected.name} at ${usage.location}: Rust ${wireTypeText(
            expected.type,
          )} != frontend ${wireTypeText(actual.type)}`,
        );
      }
    }
    if (!wireTypesCompatible(usage.returnType, definition.returnType)) {
      diagnostics.push(
        `IPC return value type for ${usage.command} at ${usage.location}: Rust ${wireTypeText(
          definition.returnType,
        )} != frontend ${wireTypeText(usage.returnType)}`,
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
