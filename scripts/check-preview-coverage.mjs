import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function resolveInside(root, path, errors, label) {
  if (typeof path !== "string" || path.trim() === "") {
    errors.push(`${label} must be a non-empty repository-relative path`);
    return null;
  }
  const absolute = resolve(root, path);
  const fromRoot = relative(root, absolute);
  if (isAbsolute(fromRoot) || fromRoot === ".." || fromRoot.startsWith(`..${sep}`)) {
    errors.push(`${label} escapes the repository root: ${path}`);
    return null;
  }
  return absolute;
}

function readFile(root, path, errors, label) {
  const absolute = resolveInside(root, path, errors, label);
  if (!absolute || !existsSync(absolute)) {
    if (absolute) errors.push(`${label} is missing at ${path}`);
    return null;
  }
  return readFileSync(absolute, "utf8");
}

function readJson(root, path, errors, label) {
  const content = readFile(root, path, errors, label);
  if (content === null) return null;
  try {
    return JSON.parse(content);
  } catch (error) {
    errors.push(`${label} at ${path} is not valid JSON: ${error.message}`);
    return null;
  }
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

function compareSets(label, expected, actual, errors) {
  for (const missing of [...expected].filter((item) => !actual.has(item)).sort()) {
    errors.push(`${label} is missing ${missing}`);
  }
  for (const extra of [...actual].filter((item) => !expected.has(item)).sort()) {
    errors.push(`${label} has undeclared extra ${extra}`);
  }
}

function walkSource(path) {
  if (!existsSync(path)) return [];
  if (statSync(path).isFile()) return [path];
  const files = [];
  for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const child = resolve(path, entry.name);
    if (entry.isDirectory()) files.push(...walkSource(child));
    else if (entry.isFile() && [".ts", ".tsx"].includes(extname(entry.name))) {
      files.push(child);
    }
  }
  return files;
}

function parseExportedStringArray(content, exportName, path, errors) {
  const escaped = exportName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = content.match(
    new RegExp(`export\\s+const\\s+${escaped}\\s*=\\s*\\[([\\s\\S]*?)\\];`),
  );
  if (!match) {
    errors.push(`${path} must export ${exportName} as a literal string array`);
    return [];
  }
  return [...match[1].matchAll(/["']([^"']+)["']/g)].map((item) => item[1]);
}

function sourceModule(root, importer, specifier, errors) {
  const importerAbsolute = resolve(root, importer);
  const unresolved = resolve(dirname(importerAbsolute), specifier);
  const candidates = [
    unresolved,
    `${unresolved}.ts`,
    `${unresolved}.tsx`,
    resolve(unresolved, "index.ts"),
    resolve(unresolved, "index.tsx"),
  ];
  const target = candidates.find((candidate) => existsSync(candidate));
  if (!target) {
    errors.push(`${importer} dynamically imports missing module ${specifier}`);
    return null;
  }
  return relative(root, target).split(sep).join("/");
}

function dynamicImports(root, owner, content, errors) {
  const modules = [];
  for (const match of content.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)) {
    if (!match[1].startsWith(".")) continue;
    const module = sourceModule(root, owner, match[1], errors);
    if (module) modules.push(module);
  }
  return modules;
}

function parseTypeScript(content, path, errors) {
  const source = ts.createSourceFile(
    path,
    content,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  for (const diagnostic of source.parseDiagnostics) {
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
    errors.push(`${path} is not valid TypeScript: ${message}`);
  }
  return source;
}

function unwrapExpression(expression) {
  let current = expression;
  while (
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isParenthesizedExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function propertyName(property) {
  if (!property.name || ts.isComputedPropertyName(property.name)) return null;
  if (
    ts.isIdentifier(property.name) ||
    ts.isStringLiteral(property.name) ||
    ts.isNumericLiteral(property.name)
  ) {
    return property.name.text;
  }
  return null;
}

function objectProperty(object, name) {
  return object.properties.find(
    (property) =>
      (ts.isPropertyAssignment(property) ||
        ts.isShorthandPropertyAssignment(property) ||
        ts.isMethodDeclaration(property) ||
        ts.isGetAccessorDeclaration(property) ||
        ts.isSetAccessorDeclaration(property)) &&
      propertyName(property) === name,
  );
}

function previewRuntimeObject(content, path, errors) {
  const source = parseTypeScript(content, path, errors);
  for (const statement of source.statements) {
    if (
      !ts.isVariableStatement(statement) ||
      !statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      continue;
    }
    for (const declaration of statement.declarationList.declarations) {
      if (
        !ts.isIdentifier(declaration.name) ||
        declaration.name.text !== "previewRuntime" ||
        !declaration.initializer
      ) {
        continue;
      }
      const initializer = unwrapExpression(declaration.initializer);
      if (ts.isObjectLiteralExpression(initializer)) return initializer;
      errors.push(`${path} must export previewRuntime as an object literal`);
      return null;
    }
  }
  errors.push(`${path} must export previewRuntime as an object literal`);
  return null;
}

function fixtureHasPath(rootObject, path) {
  const parts = path.split(".");
  if (parts.some((part) => part === "")) return false;
  let object = rootObject;
  for (const [index, part] of parts.entries()) {
    const property = objectProperty(object, part);
    if (!property) return false;
    if (index === parts.length - 1) return true;
    if (!ts.isPropertyAssignment(property)) return false;
    const initializer = unwrapExpression(property.initializer);
    if (!ts.isObjectLiteralExpression(initializer)) return false;
    object = initializer;
  }
  return false;
}

function walkSyntax(node, visit) {
  visit(node);
  ts.forEachChild(node, (child) => walkSyntax(child, visit));
}

function walkStepSyntax(node, visit) {
  visit(node);
  ts.forEachChild(node, (child) => {
    if (
      ts.isArrowFunction(child) ||
      ts.isFunctionExpression(child) ||
      ts.isFunctionDeclaration(child) ||
      ts.isMethodDeclaration(child)
    ) {
      return;
    }
    walkStepSyntax(child, visit);
  });
}

function literalText(node) {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? node.text : null;
}

function namedObjectProperty(object, name) {
  if (!object || !ts.isObjectLiteralExpression(object)) return null;
  const property = objectProperty(object, name);
  return property && ts.isPropertyAssignment(property)
    ? unwrapExpression(property.initializer)
    : null;
}

function roleQuery(call, expected) {
  if (
    !ts.isCallExpression(call) ||
    !ts.isPropertyAccessExpression(call.expression) ||
    call.expression.name.text !== "getByRole" ||
    literalText(call.arguments[0]) !== expected.role
  ) {
    return false;
  }
  const name = namedObjectProperty(call.arguments[1], "name");
  if (!name) return false;
  if (typeof expected.name === "string") {
    return literalText(name) === expected.name;
  }
  if (typeof expected.namePattern === "string" && ts.isRegularExpressionLiteral(name)) {
    return name.text.includes(expected.namePattern);
  }
  return false;
}

function isPageMethodCall(call, method) {
  return (
    ts.isCallExpression(call) &&
    ts.isPropertyAccessExpression(call.expression) &&
    call.expression.name.text === method &&
    ts.isIdentifier(call.expression.expression) &&
    call.expression.expression.text === "page"
  );
}

function interactionPosition(stepBody, interaction) {
  let position = null;
  walkStepSyntax(stepBody, (node) => {
    if (position !== null || !ts.isCallExpression(node)) return;
    if (interaction.kind === "goto" && isPageMethodCall(node, "goto")) {
      position = node.getStart();
      return;
    }
    if (interaction.kind !== "click" || !ts.isPropertyAccessExpression(node.expression)) {
      return;
    }
    const action = node.expression.name.text;
    if (
      action !== "click" &&
      !(action === "dispatchEvent" && literalText(node.arguments[0]) === "click")
    ) {
      return;
    }
    if (roleQuery(node.expression.expression, interaction)) {
      position = node.getStart();
    }
  });
  return position;
}

function loadedAssertionPosition(stepBody, loaded) {
  let position = null;
  walkStepSyntax(stepBody, (node) => {
    if (
      position !== null ||
      !ts.isCallExpression(node) ||
      !ts.isPropertyAccessExpression(node.expression) ||
      node.expression.name.text !== "toBeVisible"
    ) {
      return;
    }
    const expectCall = node.expression.expression;
    if (
      !ts.isCallExpression(expectCall) ||
      !ts.isIdentifier(expectCall.expression) ||
      expectCall.expression.text !== "expect"
    ) {
      return;
    }
    if (roleQuery(expectCall.arguments[0], loaded)) {
      position = node.getStart();
    }
  });
  return position;
}

function routeStepBodies(content, path, errors) {
  const source = parseTypeScript(content, path, errors);
  const steps = new Map();
  walkSyntax(source, (node) => {
    if (
      !ts.isCallExpression(node) ||
      !ts.isPropertyAccessExpression(node.expression) ||
      !ts.isIdentifier(node.expression.expression) ||
      node.expression.expression.text !== "test" ||
      node.expression.name.text !== "step"
    ) {
      return;
    }
    const label = literalText(node.arguments[0]);
    const callback = node.arguments[1];
    if (!label || (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback))) {
      return;
    }
    if (!steps.has(label)) steps.set(label, []);
    steps.get(label).push(callback.body);
  });
  return steps;
}

export function validatePreviewCoverage(
  root = DEFAULT_ROOT,
  contractRelativePath = "validation/preview-coverage.json",
) {
  const errors = [];
  const contract = readJson(root, contractRelativePath, errors, "preview coverage contract");
  if (!contract) return errors;
  if (contract.version !== 1) {
    errors.push(
      `preview coverage contract version must be 1, received ${JSON.stringify(contract.version)}`,
    );
  }

  const routes = Array.isArray(contract.routes) ? contract.routes : [];
  if (!Array.isArray(contract.routes)) {
    errors.push("preview coverage routes must be an array");
  }
  const routeIds = routes.map((route) => route.id);
  for (const duplicate of duplicates(routeIds)) {
    errors.push(`preview coverage routes repeat ${duplicate}`);
  }
  const sortedRouteIds = [...routeIds].sort();
  if (JSON.stringify(routeIds) !== JSON.stringify(sortedRouteIds)) {
    errors.push("preview coverage routes must be sorted by id");
  }
  const routeIdSet = new Set(routeIds);
  for (const route of routes) {
    if (route.parent && !routeIdSet.has(route.parent)) {
      errors.push(`preview route ${route.id} references missing parent ${route.parent}`);
    }
    if (route.module) {
      const module = resolveInside(root, route.module, errors, `preview route ${route.id} module`);
      if (module && !existsSync(module)) {
        errors.push(`preview route ${route.id} module is missing at ${route.module}`);
      }
    }
  }

  const appContent = readFile(root, contract.appSource, errors, "preview app source");
  if (appContent !== null) {
    const viewType = appContent.match(/\btype\s+View\s*=\s*([\s\S]*?);/);
    if (!viewType) {
      errors.push(`${contract.appSource} must define the primary View union`);
    } else {
      const sourceViews = new Set(
        [...viewType[1].matchAll(/["']([^"']+)["']/g)].map((match) => match[1]),
      );
      const projectedViews = new Set(
        routes.filter((route) => !route.parent).map((route) => route.id),
      );
      compareSets("primary preview route projections", sourceViews, projectedViews, errors);
    }
  }

  const expectedLazyEntries = new Set(
    routes.map((route) => route.module).filter((module) => typeof module === "string"),
  );
  const infrastructureEntries = new Set(contract.infrastructureEntries ?? []);
  const expectedDynamicEntries = new Set([...expectedLazyEntries, ...infrastructureEntries]);
  const actualDynamicEntries = new Set();
  const actualDynamicOwners = new Set();
  const sourceRoot = resolveInside(root, contract.sourceRoot, errors, "preview source root");
  const sourceFiles =
    sourceRoot && existsSync(sourceRoot)
      ? walkSource(sourceRoot).filter((path) => !relative(root, path).includes(".test."))
      : [];
  if (sourceRoot && !existsSync(sourceRoot)) {
    errors.push(`preview source root is missing at ${contract.sourceRoot}`);
  }
  for (const absolute of sourceFiles) {
    const owner = relative(root, absolute).split(sep).join("/");
    const content = readFileSync(absolute, "utf8");
    const imports = dynamicImports(root, owner, content, errors);
    if (imports.length > 0) actualDynamicOwners.add(owner);
    for (const module of imports) {
      actualDynamicEntries.add(module);
    }
  }
  compareSets(
    "frontend dynamic import owners",
    new Set(contract.dynamicImportOwners ?? []),
    actualDynamicOwners,
    errors,
  );
  compareSets(
    "declared frontend dynamic imports",
    expectedDynamicEntries,
    actualDynamicEntries,
    errors,
  );

  const bundleContent = readFile(root, contract.bundleOwner, errors, "bundle budget owner");
  if (bundleContent !== null) {
    const lazyEntries = parseExportedStringArray(
      bundleContent,
      "LAZY_ENTRIES",
      contract.bundleOwner,
      errors,
    );
    compareSets("bundle lazy view entries", expectedLazyEntries, new Set(lazyEntries), errors);
    const forbiddenEager = parseExportedStringArray(
      bundleContent,
      "FORBIDDEN_EAGER_ENTRIES",
      contract.bundleOwner,
      errors,
    );
    compareSets(
      "bundle lazy infrastructure entries",
      infrastructureEntries,
      new Set(forbiddenEager),
      errors,
    );
  }

  const fixtureContent = readFile(root, contract.previewFixture, errors, "preview runtime fixture");
  if (fixtureContent !== null) {
    const runtimeObject = previewRuntimeObject(fixtureContent, contract.previewFixture, errors);
    if (runtimeObject) {
      for (const route of routes) {
        if (typeof route.fixture !== "string" || !fixtureHasPath(runtimeObject, route.fixture)) {
          errors.push(
            `${contract.previewFixture} is missing fixture projection ${route.fixture} for route ${route.id}`,
          );
        }
      }
    }
  }

  const routeE2e = readFile(root, contract.routeE2eOwner, errors, "preview route E2E owner");
  if (routeE2e !== null) {
    const steps = routeStepBodies(routeE2e, contract.routeE2eOwner, errors);
    for (const route of routes) {
      const stepLabel = `preview-route:${route.id}`;
      const bodies = steps.get(stepLabel) ?? [];
      if (bodies.length !== 1) {
        errors.push(`${contract.routeE2eOwner} must define exactly one ${stepLabel} step`);
        continue;
      }
      if (!route.e2e?.interaction || !route.e2e.loaded) {
        errors.push(`preview route ${route.id} must declare e2e interaction and loaded selectors`);
        continue;
      }
      const interaction = interactionPosition(bodies[0], route.e2e.interaction);
      const loaded = loadedAssertionPosition(bodies[0], route.e2e.loaded);
      if (interaction === null) {
        errors.push(`${stepLabel} is missing its declared preview interaction`);
      }
      if (loaded === null) {
        errors.push(`${stepLabel} is missing its declared loaded assertion`);
      } else if (interaction !== null && loaded <= interaction) {
        errors.push(`${stepLabel} loaded assertion must follow its preview interaction`);
      }
    }
  }

  const updater = contract.updaterGeometry;
  if (!updater) {
    errors.push("preview coverage contract is missing updaterGeometry");
  } else {
    const moduleContent = readFile(root, updater.module, errors, "updater preview module");
    if (moduleContent !== null && !moduleContent.includes(`export function ${updater.component}`)) {
      errors.push(`${updater.module} must export updater preview component ${updater.component}`);
    }
    const previewEntry = readFile(root, contract.previewEntry, errors, "preview entry");
    const query = String(updater.query ?? "");
    if (
      previewEntry !== null &&
      (!previewEntry.includes(`location.search === "${query}"`) ||
        !previewEntry.includes(`module.${updater.component}`))
    ) {
      errors.push(`${contract.previewEntry} must route ${updater.query} to ${updater.component}`);
    }
    const updaterE2e = readFile(root, updater.e2eOwner, errors, "updater geometry E2E owner");
    if (updaterE2e !== null) {
      for (const marker of [updater.query, updater.fixtureSelector]) {
        if (!updaterE2e.includes(marker)) {
          errors.push(`${updater.e2eOwner} must reference updater geometry marker ${marker}`);
        }
      }
    }
  }

  return errors;
}

function runCli() {
  const errors = validatePreviewCoverage();
  if (errors.length > 0) {
    console.error("Preview coverage check failed:");
    for (const error of errors) console.error(`- ${error}`);
    process.exit(1);
  }
  console.log("Preview coverage contract passed.");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli();
}
