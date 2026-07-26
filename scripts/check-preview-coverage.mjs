import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import {
  dirname,
  extname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function resolveInside(root, path, errors, label) {
  if (typeof path !== "string" || path.trim() === "") {
    errors.push(`${label} must be a non-empty repository-relative path`);
    return null;
  }
  const absolute = resolve(root, path);
  const fromRoot = relative(root, absolute);
  if (
    isAbsolute(fromRoot) ||
    fromRoot === ".." ||
    fromRoot.startsWith(`..${sep}`)
  ) {
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
  return [...match[1].matchAll(/["']([^"']+)["']/g)].map(
    (item) => item[1],
  );
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

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function e2eCoversLabel(content, label) {
  return new RegExp(
    `getByRole\\([\\s\\S]{0,180}?name:\\s*["']${escapeRegex(label)}["']`,
  ).test(content);
}

function fixtureHasPath(content, path) {
  const parts = path.split(".");
  if (parts.length === 1) {
    return new RegExp(
      `export\\s+const\\s+previewRuntime\\s*=\\s*\\{[\\s\\S]*?\\b${escapeRegex(
        parts[0],
      )}\\s*:`,
    ).test(content);
  }
  if (parts.length === 2 && parts[0] === "dashboard") {
    return new RegExp(
      `\\bdashboard\\s*:\\s*\\{[\\s\\S]*?\\b${escapeRegex(parts[1])}\\s*:`,
    ).test(content);
  }
  return false;
}

export function validatePreviewCoverage(
  root = DEFAULT_ROOT,
  contractRelativePath = "validation/preview-coverage.json",
) {
  const errors = [];
  const contract = readJson(
    root,
    contractRelativePath,
    errors,
    "preview coverage contract",
  );
  if (!contract) return errors;
  if (contract.version !== 1) {
    errors.push(
      `preview coverage contract version must be 1, received ${JSON.stringify(
        contract.version,
      )}`,
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
      errors.push(
        `preview route ${route.id} references missing parent ${route.parent}`,
      );
    }
    if (route.module) {
      const module = resolveInside(
        root,
        route.module,
        errors,
        `preview route ${route.id} module`,
      );
      if (module && !existsSync(module)) {
        errors.push(`preview route ${route.id} module is missing at ${route.module}`);
      }
    }
  }

  const appContent = readFile(
    root,
    contract.appSource,
    errors,
    "preview app source",
  );
  if (appContent !== null) {
    const viewType = appContent.match(/\btype\s+View\s*=\s*([\s\S]*?);/);
    if (!viewType) {
      errors.push(`${contract.appSource} must define the primary View union`);
    } else {
      const sourceViews = new Set(
        [...viewType[1].matchAll(/["']([^"']+)["']/g)].map(
          (match) => match[1],
        ),
      );
      const projectedViews = new Set(
        routes.filter((route) => !route.parent).map((route) => route.id),
      );
      compareSets(
        "primary preview route projections",
        sourceViews,
        projectedViews,
        errors,
      );
    }
  }

  const expectedLazyEntries = new Set(
    routes
      .map((route) => route.module)
      .filter((module) => typeof module === "string"),
  );
  const infrastructureEntries = new Set(contract.infrastructureEntries ?? []);
  const expectedDynamicEntries = new Set([
    ...expectedLazyEntries,
    ...infrastructureEntries,
  ]);
  const actualDynamicEntries = new Set();
  const actualDynamicOwners = new Set();
  const sourceRoot = resolveInside(
    root,
    contract.sourceRoot,
    errors,
    "preview source root",
  );
  const sourceFiles =
    sourceRoot && existsSync(sourceRoot)
      ? walkSource(sourceRoot).filter(
          (path) => !relative(root, path).includes(".test."),
        )
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

  const bundleContent = readFile(
    root,
    contract.bundleOwner,
    errors,
    "bundle budget owner",
  );
  if (bundleContent !== null) {
    const lazyEntries = parseExportedStringArray(
      bundleContent,
      "LAZY_ENTRIES",
      contract.bundleOwner,
      errors,
    );
    compareSets(
      "bundle lazy view entries",
      expectedLazyEntries,
      new Set(lazyEntries),
      errors,
    );
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

  const fixtureContent = readFile(
    root,
    contract.previewFixture,
    errors,
    "preview runtime fixture",
  );
  if (fixtureContent !== null) {
    for (const route of routes) {
      if (!fixtureHasPath(fixtureContent, route.fixture)) {
        errors.push(
          `${contract.previewFixture} is missing fixture projection ${route.fixture} for route ${route.id}`,
        );
      }
    }
  }

  const routeE2e = readFile(
    root,
    contract.routeE2eOwner,
    errors,
    "preview route E2E owner",
  );
  if (routeE2e !== null) {
    for (const route of routes) {
      if (!e2eCoversLabel(routeE2e, route.label)) {
        errors.push(
          `${contract.routeE2eOwner} is missing preview interaction coverage for ${route.id} (${route.label})`,
        );
      }
    }
  }

  const updater = contract.updaterGeometry;
  if (!updater) {
    errors.push("preview coverage contract is missing updaterGeometry");
  } else {
    const moduleContent = readFile(
      root,
      updater.module,
      errors,
      "updater preview module",
    );
    if (
      moduleContent !== null &&
      !moduleContent.includes(`export function ${updater.component}`)
    ) {
      errors.push(
        `${updater.module} must export updater preview component ${updater.component}`,
      );
    }
    const previewEntry = readFile(
      root,
      contract.previewEntry,
      errors,
      "preview entry",
    );
    const query = String(updater.query ?? "");
    if (
      previewEntry !== null &&
      (!previewEntry.includes(`location.search === "${query}"`) ||
        !previewEntry.includes(`module.${updater.component}`))
    ) {
      errors.push(
        `${contract.previewEntry} must route ${updater.query} to ${updater.component}`,
      );
    }
    const updaterE2e = readFile(
      root,
      updater.e2eOwner,
      errors,
      "updater geometry E2E owner",
    );
    if (updaterE2e !== null) {
      for (const marker of [updater.query, updater.fixtureSelector]) {
        if (!updaterE2e.includes(marker)) {
          errors.push(
            `${updater.e2eOwner} must reference updater geometry marker ${marker}`,
          );
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

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  runCli();
}
