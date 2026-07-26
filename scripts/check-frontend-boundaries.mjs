import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function relativePath(root, path) {
  return relative(root, path).split(sep).join("/");
}

function lineNumber(content, index) {
  return content.slice(0, index).split("\n").length;
}

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

function readJson(root, path, errors, label) {
  const absolute = resolveInside(root, path, errors, label);
  if (!absolute || !existsSync(absolute)) {
    if (absolute) errors.push(`${label} is missing at ${path}`);
    return null;
  }
  try {
    return JSON.parse(readFileSync(absolute, "utf8"));
  } catch (error) {
    errors.push(`${label} at ${path} is not valid JSON: ${error.message}`);
    return null;
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

function moduleImports(content) {
  const imports = [];
  const patterns = [
    /\bfrom\s+["'](@tauri-apps\/[^"']+)["']/g,
    /\bimport\s*\(\s*["'](@tauri-apps\/[^"']+)["']\s*\)/g,
    /^\s*import\s+["'](@tauri-apps\/[^"']+)["']/gm,
  ];
  const seen = new Set();
  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      const key = `${match.index}:${match[1]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      imports.push({ module: match[1], index: match.index });
    }
  }
  return imports;
}

function literalCalls(content, functionName) {
  const pattern = new RegExp(
    `\\b${functionName}(?:<[^;()]+>)?\\s*\\(\\s*["']([^"']+)["']`,
    "g",
  );
  return [...content.matchAll(pattern)].map((match) => ({
    value: match[1],
    index: match.index,
  }));
}

function functionCalls(content, functionName) {
  const pattern = new RegExp(
    `\\b${functionName}(?:<[^;()]+>)?\\s*\\(`,
    "g",
  );
  return [...content.matchAll(pattern)]
    .filter((match) => {
      const prefix = content.slice(0, match.index);
      return !/\bfunction\s*$/.test(prefix);
    })
    .map((match) => ({ index: match.index }));
}

function rejectNonLiteralCalls(
  content,
  path,
  functionName,
  literalCallsFound,
  kind,
  errors,
) {
  const literalIndexes = new Set(literalCallsFound.map(({ index }) => index));
  for (const call of functionCalls(content, functionName)) {
    if (literalIndexes.has(call.index)) continue;
    errors.push(
      `${path}:${lineNumber(
        content,
        call.index,
      )} uses a non-literal desktop ${kind}; declare it in the typed boundary`,
    );
  }
}

function assertSortedUnique(label, values, errors) {
  if (!Array.isArray(values)) {
    errors.push(`${label} must be an array`);
    return [];
  }
  for (const duplicate of duplicates(values)) {
    errors.push(`${label} repeats ${duplicate}`);
  }
  const sorted = [...values].sort();
  if (JSON.stringify(values) !== JSON.stringify(sorted)) {
    errors.push(`${label} must be sorted`);
  }
  return values;
}

export function validateFrontendBoundaries(
  root = DEFAULT_ROOT,
  contractRelativePath = "validation/frontend-boundaries.json",
) {
  const errors = [];
  const contract = readJson(
    root,
    contractRelativePath,
    errors,
    "frontend boundary contract",
  );
  if (!contract) return errors;
  if (contract.version !== 1) {
    errors.push(
      `frontend boundary contract version must be 1, received ${JSON.stringify(
        contract.version,
      )}`,
    );
  }

  const sourceRoot = resolveInside(
    root,
    contract.sourceRoot,
    errors,
    "frontend source root",
  );
  if (!sourceRoot || !existsSync(sourceRoot)) {
    if (sourceRoot) {
      errors.push(`frontend source root is missing at ${contract.sourceRoot}`);
    }
    return errors;
  }
  const sourceFiles = walkSource(sourceRoot);
  const sourceByPath = new Map(
    sourceFiles.map((path) => [relativePath(root, path), readFileSync(path, "utf8")]),
  );
  const productionFiles = [...sourceByPath].filter(
    ([path]) => !path.includes(".test."),
  );

  const commands = assertSortedUnique(
    "frontend command allowlist",
    contract.commands,
    errors,
  );
  const events = assertSortedUnique(
    "frontend event allowlist",
    contract.events,
    errors,
  );
  const commandSet = new Set(commands);
  const eventSet = new Set(events);
  const commandOwner = contract.commandOwner;
  const eventOwner = contract.eventOwner;
  const literalOwners = new Set([
    commandOwner,
    eventOwner,
    ...(contract.generatedOwners ?? []),
    ...(contract.previewOwners ?? []),
  ]);
  for (const [label, owners] of [
    ["generated owner", contract.generatedOwners ?? []],
    ["preview owner", contract.previewOwners ?? []],
  ]) {
    for (const owner of owners) {
      if (!sourceByPath.has(owner)) {
        errors.push(`${label} is missing at ${owner}`);
      }
    }
  }

  const configuredImportOwners = contract.tauriImportOwners ?? {};
  const actualImportOwners = new Map(
    Object.keys(configuredImportOwners).map((module) => [module, new Set()]),
  );
  for (const [path, content] of sourceByPath) {
    for (const imported of moduleImports(content)) {
      const owners = configuredImportOwners[imported.module];
      if (!Array.isArray(owners)) {
        errors.push(
          `${path}:${lineNumber(
            content,
            imported.index,
          )} imports undeclared Tauri module ${imported.module}`,
        );
        continue;
      }
      actualImportOwners.get(imported.module)?.add(path);
      if (!owners.includes(path)) {
        errors.push(
          `${path}:${lineNumber(
            content,
            imported.index,
          )} imports ${imported.module}; approved owners: ${owners.join(", ")}`,
        );
      }
    }
  }
  for (const [module, owners] of Object.entries(configuredImportOwners)) {
    compareSets(
      `Tauri import owners for ${module}`,
      new Set(owners),
      actualImportOwners.get(module) ?? new Set(),
      errors,
    );
  }

  const directPatterns = [
    {
      name: "invoke",
      owner: commandOwner,
      pattern: /\binvoke(?:<[^;()]+>)?\s*\(/g,
    },
    {
      name: "listen",
      owner: eventOwner,
      pattern: /\blisten(?:<[^;()]+>)?\s*\(/g,
    },
  ];
  for (const [path, content] of productionFiles) {
    for (const direct of directPatterns) {
      if (path === direct.owner) continue;
      for (const match of content.matchAll(direct.pattern)) {
        errors.push(
          `${path}:${lineNumber(
            content,
            match.index,
          )} calls Tauri ${direct.name} directly; use ${direct.owner}`,
        );
      }
    }
    if (path !== eventOwner) {
      for (const pattern of [/\bUnlistenFn\b/g, /\bunlisten\s*\(/g]) {
        for (const match of content.matchAll(pattern)) {
          errors.push(
            `${path}:${lineNumber(
              content,
              match.index,
            )} owns listener cleanup outside ${eventOwner}`,
          );
        }
      }
    }
    if (!literalOwners.has(path)) {
      for (const match of content.matchAll(/(["'])([a-z][a-z0-9_]+)\1/g)) {
        const value = match[2];
        if (!commandSet.has(value) && !eventSet.has(value)) continue;
        errors.push(
          `${path}:${lineNumber(
            content,
            match.index,
          )} uses raw desktop ${commandSet.has(value) ? "command" : "event"} literal ${JSON.stringify(
            value,
          )}; call the typed desktop boundary`,
        );
      }
    }

    for (const call of literalCalls(content, "invoke")) {
      if (!commandSet.has(call.value)) {
        errors.push(
          `${path}:${lineNumber(
            content,
            call.index,
          )} invokes unknown desktop command ${JSON.stringify(call.value)}`,
        );
      }
    }
    for (const call of literalCalls(content, "listen")) {
      if (!eventSet.has(call.value)) {
        errors.push(
          `${path}:${lineNumber(
            content,
            call.index,
          )} listens for unknown desktop event ${JSON.stringify(call.value)}`,
        );
      }
    }
  }

  const ownerContent = sourceByPath.get(commandOwner);
  if (!ownerContent) {
    errors.push(`desktop command owner is missing at ${commandOwner}`);
  } else {
    const ownedCommands = literalCalls(ownerContent, "invokeCommand");
    rejectNonLiteralCalls(
      ownerContent,
      commandOwner,
      "invokeCommand",
      ownedCommands,
      "command",
      errors,
    );
    for (const duplicate of duplicates(ownedCommands.map(({ value }) => value))) {
      errors.push(`${commandOwner} maps desktop command ${duplicate} more than once`);
    }
    for (const command of ownedCommands) {
      if (!commandSet.has(command.value)) {
        errors.push(
          `${commandOwner}:${lineNumber(
            ownerContent,
            command.index,
          )} declares unknown desktop command ${JSON.stringify(command.value)}`,
        );
      }
    }
    compareSets(
      "typed desktop command methods",
      commandSet,
      new Set(ownedCommands.map(({ value }) => value)),
      errors,
    );
  }

  const eventContent = sourceByPath.get(eventOwner);
  if (!eventContent) {
    errors.push(`desktop event owner is missing at ${eventOwner}`);
  } else {
    const ownedEvents = literalCalls(eventContent, "listen");
    rejectNonLiteralCalls(
      eventContent,
      eventOwner,
      "listen",
      ownedEvents,
      "event subscription",
      errors,
    );
    for (const duplicate of duplicates(ownedEvents.map(({ value }) => value))) {
      errors.push(`${eventOwner} subscribes to desktop event ${duplicate} more than once`);
    }
    for (const event of ownedEvents) {
      if (!eventSet.has(event.value)) {
        errors.push(
          `${eventOwner}:${lineNumber(
            eventContent,
            event.index,
          )} declares unknown desktop event ${JSON.stringify(event.value)}`,
        );
      }
    }
    compareSets(
      "owned desktop event subscriptions",
      eventSet,
      new Set(ownedEvents.map(({ value }) => value)),
      errors,
    );
  }

  const selectionOwner = contract.runtimeSelectionOwner;
  const selectionContent = sourceByPath.get(selectionOwner);
  if (!selectionContent) {
    errors.push(`runtime selection owner is missing at ${selectionOwner}`);
  } else {
    for (const marker of ["isDesktopRuntime()", "loadPreviewRuntime"]) {
      if (!selectionContent.includes(marker)) {
        errors.push(
          `${selectionOwner} must preserve native/preview selection marker ${marker}`,
        );
      }
    }
  }

  for (const invariant of contract.asyncInvariantTests ?? []) {
    const path = resolveInside(
      root,
      invariant.path,
      errors,
      `async invariant ${invariant.id}`,
    );
    if (!path || !existsSync(path)) {
      if (path) {
        errors.push(
          `async invariant ${invariant.id} test is missing at ${invariant.path}`,
        );
      }
      continue;
    }
    const content = readFileSync(path, "utf8");
    const count =
      typeof invariant.marker === "string"
        ? content.split(invariant.marker).length - 1
        : 0;
    if (count !== 1) {
      errors.push(
        `${invariant.path} must encode async invariant ${invariant.id} with marker ${JSON.stringify(
          invariant.marker,
        )} exactly once; found ${count}`,
      );
    }
  }

  return errors;
}

function runCli() {
  const errors = validateFrontendBoundaries();
  if (errors.length > 0) {
    console.error("Frontend boundary check failed:");
    for (const error of errors) console.error(`- ${error}`);
    process.exit(1);
  }
  console.log("Frontend boundary contract passed.");
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  runCli();
}
