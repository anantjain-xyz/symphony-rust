import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

import { compareSets, rustTokens } from "./lib/source-contracts.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function tokenSequenceAt(tokens, index, values) {
  return values.every((value, offset) => tokens[index + offset]?.value === value);
}

export function rustIpcCommands(source) {
  const tokens = rustTokens(source);
  const definitions = [];
  const registrations = [];

  for (let index = 0; index < tokens.length; index += 1) {
    if (tokenSequenceAt(tokens, index, ["#", "[", "tauri", "::", "command", "]"])) {
      let cursor = index + 6;
      while (cursor < tokens.length && tokens[cursor].value !== "fn") cursor += 1;
      if (tokens[cursor + 1]?.kind === "ident") definitions.push(tokens[cursor + 1].value);
    }
    if (tokenSequenceAt(tokens, index, ["tauri", "::", "generate_handler", "!", "["])) {
      let depth = 1;
      for (let cursor = index + 5; cursor < tokens.length && depth > 0; cursor += 1) {
        if (tokens[cursor].value === "[") depth += 1;
        if (tokens[cursor].value === "]") depth -= 1;
        if (depth === 1 && tokens[cursor].kind === "ident") {
          registrations.push(tokens[cursor].value);
        }
      }
    }
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

function variableInitializer(file, variableName) {
  let initializer;
  const visit = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === variableName
    ) {
      initializer = node.initializer;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  if (!initializer) throw new Error(`${file.fileName}: missing ${variableName}`);
  while (ts.isAsExpression(initializer) || ts.isSatisfiesExpression(initializer)) {
    initializer = initializer.expression;
  }
  return initializer;
}

function propertyName(property) {
  if (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) {
    return property.name.text;
  }
  throw new Error("contract objects must use static identifier or string keys");
}

export function frontendRegistry(source, path = "src/ipcContract.ts") {
  const file = sourceFile(path, source);
  const commandsNode = variableInitializer(file, "IPC_COMMANDS");
  if (!ts.isObjectLiteralExpression(commandsNode)) {
    throw new Error(`${path}: IPC_COMMANDS must be an object literal`);
  }
  const commands = new Map();
  for (const property of commandsNode.properties) {
    if (!ts.isPropertyAssignment(property)) {
      throw new Error(`${path}: IPC_COMMANDS entries must be property assignments`);
    }
    let value = property.initializer;
    while (ts.isAsExpression(value) || ts.isSatisfiesExpression(value)) value = value.expression;
    if (!ts.isObjectLiteralExpression(value)) {
      throw new Error(`${path}: ${propertyName(property)} metadata must be an object`);
    }
    const previewProperty = value.properties.find(
      (entry) => ts.isPropertyAssignment(entry) && propertyName(entry) === "preview",
    );
    if (!previewProperty || !ts.isPropertyAssignment(previewProperty)) {
      throw new Error(`${path}: ${propertyName(property)} is missing preview metadata`);
    }
    const preview =
      previewProperty.initializer.kind === ts.SyntaxKind.TrueKeyword
        ? true
        : previewProperty.initializer.kind === ts.SyntaxKind.FalseKeyword
          ? false
          : null;
    if (preview === null) {
      throw new Error(`${path}: ${propertyName(property)}.preview must be a boolean literal`);
    }
    commands.set(propertyName(property), preview);
  }

  const backendNode = variableInitializer(file, "BACKEND_ONLY_COMMANDS");
  if (!ts.isArrayLiteralExpression(backendNode)) {
    throw new Error(`${path}: BACKEND_ONLY_COMMANDS must be an array literal`);
  }
  const backendOnly = backendNode.elements.map((element) => {
    if (!ts.isStringLiteral(element)) {
      throw new Error(`${path}: backend-only commands must be string literals`);
    }
    return element.text;
  });
  return { commands, backendOnly };
}

export function frontendInvokeLiterals(sources) {
  const commands = [];
  const dynamic = [];
  for (const { path, source } of sources) {
    const file = sourceFile(path, source);
    const visit = (node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        const direct = node.expression.text === "invoke";
        const wrapped = node.expression.text === "invokeDashboardResource";
        if (direct || wrapped) {
          const argument = node.arguments[wrapped ? 1 : 0];
          if (argument && ts.isStringLiteral(argument)) {
            commands.push(argument.text);
          } else {
            let owner = node.parent;
            while (owner && !ts.isFunctionLike(owner)) owner = owner.parent;
            const isDashboardWrapper =
              direct &&
              argument &&
              ts.isIdentifier(argument) &&
              argument.text === "command" &&
              owner &&
              "name" in owner &&
              owner.name &&
              ts.isIdentifier(owner.name) &&
              owner.name.text === "invokeDashboardResource";
            if (isDashboardWrapper) {
              ts.forEachChild(node, visit);
              return;
            }
            const { line, character } = file.getLineAndCharacterOfPosition(node.getStart(file));
            dynamic.push(`${path}:${line + 1}:${character + 1}`);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  return { commands, dynamic };
}

export function previewMockCommands(source, path = "src/preview/runtime.ts") {
  const file = sourceFile(path, source);
  const node = variableInitializer(file, "previewCommandMocks");
  if (!ts.isObjectLiteralExpression(node)) {
    throw new Error(`${path}: previewCommandMocks must be an object literal`);
  }
  return node.properties.map((property) => propertyName(property));
}

export function checkIpcContract({ rustSource, frontendSources, contractSource, previewSource }) {
  const diagnostics = [];
  const rust = rustIpcCommands(rustSource);
  const registry = frontendRegistry(contractSource);
  const frontend = frontendInvokeLiterals(frontendSources);
  const preview = previewMockCommands(previewSource);

  diagnostics.push(
    ...compareSets("Rust command definitions vs generate_handler!", rust.definitions, rust.registrations),
  );
  diagnostics.push(
    ...compareSets(
      "registered Rust commands vs frontend registry + backend-only allowlist",
      rust.registrations,
      [...registry.commands.keys(), ...registry.backendOnly],
    ),
  );
  diagnostics.push(
    ...compareSets("frontend invoke literals vs frontend registry", registry.commands.keys(), frontend.commands),
  );
  diagnostics.push(
    ...compareSets(
      "preview mocks vs registry preview ownership",
      [...registry.commands].filter(([, mocked]) => mocked).map(([command]) => command),
      preview,
    ),
  );
  if (frontend.dynamic.length > 0) {
    diagnostics.push(`non-literal frontend invokes: ${frontend.dynamic.join(", ")}`);
  }
  if (registry.backendOnly.length > 5) {
    diagnostics.push(
      `backend-only allowlist must stay small (found ${registry.backendOnly.length}, maximum 5)`,
    );
  }
  diagnostics.push(
    ...compareSets(
      "backend-only allowlist must not overlap the frontend registry",
      [],
      registry.backendOnly.filter((command) => registry.commands.has(command)),
    ),
  );
  return diagnostics;
}

function frontendFiles(root) {
  const result = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "preview") visit(path);
      } else if (
        /\.(?:ts|tsx)$/u.test(entry.name) &&
        !entry.name.includes(".test.") &&
        entry.name !== "ipcContract.ts"
      ) {
        result.push({
          path: relative(root, path),
          source: readFileSync(path, "utf8"),
        });
      }
    }
  };
  visit(join(root, "src"));
  return result;
}

export function checkIpc(root = ROOT) {
  const diagnostics = checkIpcContract({
    rustSource: readFileSync(join(root, "src-tauri/src/lib.rs"), "utf8"),
    frontendSources: frontendFiles(root),
    contractSource: readFileSync(join(root, "src/ipcContract.ts"), "utf8"),
    previewSource: readFileSync(join(root, "src/preview/runtime.ts"), "utf8"),
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
