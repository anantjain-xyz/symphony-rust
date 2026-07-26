import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function tomlSectionValue(source, section, key, path) {
  let current = "";
  for (const [index, line] of source.split(/\r?\n/u).entries()) {
    const trimmed = line.replace(/#.*$/u, "").trim();
    const sectionMatch = /^\[([^\]]+)\]$/u.exec(trimmed);
    if (sectionMatch) {
      current = sectionMatch[1];
      continue;
    }
    if (current !== section) continue;
    const valueMatch = new RegExp(`^${key}\\s*=\\s*"([^"]+)"$`, "u").exec(trimmed);
    if (valueMatch) return valueMatch[1];
    if (trimmed.startsWith(`${key} =`)) {
      throw new Error(`${path}:${index + 1}: ${section}.${key} must be a literal string`);
    }
  }
  throw new Error(`${path}: missing ${section}.${key}`);
}

export function cargoLockPackages(source) {
  const packages = [];
  let current = null;
  for (const line of source.split(/\r?\n/u)) {
    if (line.trim() === "[[package]]") {
      if (current?.name && current?.version) packages.push(current);
      current = {};
      continue;
    }
    if (!current) continue;
    const match = /^(name|version)\s*=\s*"([^"]+)"$/u.exec(line.trim());
    if (match) current[match[1]] = match[2];
  }
  if (current?.name && current?.version) packages.push(current);
  return packages;
}

function shellStatements(source) {
  const statements = [];
  let current = "";
  let startLine = 0;
  for (const [index, rawLine] of source.split(/\r?\n/u).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (!current) startLine = index + 1;
    const continued = line.endsWith("\\");
    const fragment = continued ? line.slice(0, -1).trimEnd() : line;
    current = current ? `${current} ${fragment}` : fragment;
    if (!continued) {
      statements.push({ text: current, line: startLine });
      current = "";
    }
  }
  if (current) statements.push({ text: current, line: startLine });
  return statements;
}

function shellWords(command) {
  const words = [];
  let word = "";
  let quote = null;
  let escaped = false;
  let started = false;
  for (const character of command) {
    if (escaped) {
      word += character;
      escaped = false;
      started = true;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      started = true;
      continue;
    }
    if (quote) {
      if (character === quote) {
        quote = null;
      } else {
        word += character;
      }
      started = true;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      started = true;
    } else if (/\s/u.test(character)) {
      if (started) {
        words.push(word);
        word = "";
        started = false;
      }
    } else {
      word += character;
      started = true;
    }
  }
  if (escaped) word += "\\";
  if (started) words.push(word);
  return words;
}

function cleanShellWords(statement) {
  return shellWords(statement.text).map((word) => word.replace(/;$/u, ""));
}

function wordsStartWith(words, prefix) {
  return prefix.every((word, index) => words[index] === word);
}

function directCommands(statements, prefix) {
  return statements
    .map((statement, index) => ({
      ...statement,
      index,
      words: cleanShellWords(statement),
    }))
    .filter((entry) => wordsStartWith(entry.words, prefix));
}

function requireExactStatement(statements, expected, path, label, diagnostics) {
  const matches = statements
    .map((statement, index) => ({ ...statement, index }))
    .filter((statement) => statement.text === expected);
  if (matches.length !== 1) {
    diagnostics.push(
      `${path}: expected exactly one ${label} statement ${JSON.stringify(expected)}, found ${matches.length}`,
    );
    return null;
  }
  return matches[0];
}

function requireExactCommand(statements, expectedWords, path, label, diagnostics) {
  const matches = statements
    .map((statement, index) => ({
      ...statement,
      index,
      words: cleanShellWords(statement),
    }))
    .filter(
      (entry) =>
        entry.words.length === expectedWords.length &&
        entry.words.every((word, index) => word === expectedWords[index]),
    );
  if (matches.length !== 1) {
    diagnostics.push(
      `${path}: expected exactly one ${label} command ${JSON.stringify(expectedWords)}, found ${matches.length}`,
    );
    return null;
  }
  return matches[0];
}

function requireFailingGuard(statements, header, path, label, diagnostics) {
  const guard = requireExactStatement(statements, header, path, label, diagnostics);
  if (!guard) return null;
  const endOffset = statements.slice(guard.index + 1).findIndex(({ text }) => text === "fi");
  if (endOffset < 0) {
    diagnostics.push(`${path}:${guard.line}: ${label} is missing its closing fi`);
    return guard;
  }
  const end = guard.index + 1 + endOffset;
  if (!statements.slice(guard.index + 1, end).some(({ text }) => text === "exit 1")) {
    diagnostics.push(`${path}:${guard.line}: ${label} must exit unsuccessfully`);
  }
  return guard;
}

function optionValue(words, option) {
  const indexes = words
    .map((word, index) => (word === option ? index : -1))
    .filter((index) => index >= 0);
  if (indexes.length !== 1) return null;
  return words[indexes[0] + 1] ?? null;
}

function compareExactWords(label, expected, actual, diagnostics) {
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  const missing = expected.filter((value) => !actualSet.has(value));
  const extra = actual.filter((value) => !expectedSet.has(value));
  const duplicates = actual.filter((value, index) => actual.indexOf(value) !== index);
  if (missing.length === 0 && extra.length === 0 && duplicates.length === 0) return;
  diagnostics.push(
    `${label}: ${[
      missing.length > 0 ? `missing [${missing.join(", ")}]` : null,
      extra.length > 0 ? `extra [${extra.join(", ")}]` : null,
      duplicates.length > 0 ? `duplicates [${[...new Set(duplicates)].join(", ")}]` : null,
    ]
      .filter(Boolean)
      .join("; ")}`,
  );
}

function staticPropertyName(property) {
  if (
    ts.isIdentifier(property.name) ||
    ts.isStringLiteral(property.name) ||
    ts.isNoSubstitutionTemplateLiteral(property.name)
  ) {
    return property.name.text;
  }
  return null;
}

function objectProperty(object, name) {
  const matches = object.properties.filter(
    (property) =>
      ts.isPropertyAssignment(property) && staticPropertyName(property) === name,
  );
  return matches.length === 1 ? matches[0].initializer : null;
}

function isProcessEnv(expression, name) {
  return (
    ts.isPropertyAccessExpression(expression) &&
    expression.name.text === name &&
    ts.isPropertyAccessExpression(expression.expression) &&
    ts.isIdentifier(expression.expression.expression) &&
    expression.expression.expression.text === "process" &&
    expression.expression.name.text === "env"
  );
}

function containsFeedJsonWrite(file) {
  let found = false;
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "stringify" &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "JSON" &&
      ts.isIdentifier(node.arguments[0]) &&
      node.arguments[0].text === "feed"
    ) {
      let owner = node.parent;
      while (owner && !ts.isCallExpression(owner)) owner = owner.parent;
      if (
        owner &&
        ts.isPropertyAccessExpression(owner.expression) &&
        owner.expression.name.text === "write" &&
        ts.isPropertyAccessExpression(owner.expression.expression) &&
        ts.isIdentifier(owner.expression.expression.expression) &&
        owner.expression.expression.expression.text === "process" &&
        owner.expression.expression.name.text === "stdout"
      ) {
        found = true;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

function checkFeedGenerator(source, contract, createLine, diagnostics) {
  const escapedFeed = contract.updaterFeed.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const pattern = new RegExp(
    String.raw`VERSION="\$VERSION"\s+UPDATER_URL="\$UPDATER_URL"\s+SIGNATURE="\$SIGNATURE"\s+\\\r?\n\s*node -e '\r?\n([\s\S]*?)\r?\n\s*'\s*>\s*"\$STAGE/${escapedFeed}"`,
    "gu",
  );
  const matches = [...source.matchAll(pattern)];
  if (matches.length !== 1) {
    diagnostics.push(
      `scripts/publish-macos.sh: expected exactly one updater-feed generator writing $STAGE/${contract.updaterFeed}, found ${matches.length}`,
    );
    return;
  }

  const line = source.slice(0, matches[0].index).split(/\r?\n/u).length;
  if (line >= createLine) {
    diagnostics.push(
      `scripts/publish-macos.sh:${line}: updater feed must be generated before gh release create`,
    );
  }

  const file = ts.createSourceFile(
    "scripts/publish-macos.sh#updater-feed",
    matches[0][1],
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  if (file.parseDiagnostics.length > 0) {
    diagnostics.push("scripts/publish-macos.sh: updater-feed generator is not valid JavaScript");
    return;
  }

  const declarations = [];
  const visit = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "feed" &&
      node.initializer &&
      ts.isObjectLiteralExpression(node.initializer)
    ) {
      declarations.push(node.initializer);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  if (declarations.length !== 1) {
    diagnostics.push(
      `scripts/publish-macos.sh: updater-feed generator must define exactly one literal feed object, found ${declarations.length}`,
    );
    return;
  }

  const feed = declarations[0];
  const version = objectProperty(feed, "version");
  const platforms = objectProperty(feed, "platforms");
  const platform =
    platforms && ts.isObjectLiteralExpression(platforms)
      ? objectProperty(platforms, contract.updaterTarget)
      : null;
  const url =
    platform && ts.isObjectLiteralExpression(platform)
      ? objectProperty(platform, "url")
      : null;
  const signature =
    platform && ts.isObjectLiteralExpression(platform)
      ? objectProperty(platform, "signature")
      : null;
  if (!version || !isProcessEnv(version, "VERSION")) {
    diagnostics.push(
      "scripts/publish-macos.sh: updater feed version must come from process.env.VERSION",
    );
  }
  if (!platform || !ts.isObjectLiteralExpression(platform)) {
    diagnostics.push(
      `scripts/publish-macos.sh: updater feed must define platform ${JSON.stringify(contract.updaterTarget)}`,
    );
  } else {
    if (!url || !isProcessEnv(url, "UPDATER_URL")) {
      diagnostics.push(
        `scripts/publish-macos.sh: updater feed ${contract.updaterTarget}.url must come from process.env.UPDATER_URL`,
      );
    }
    if (!signature || !isProcessEnv(signature, "SIGNATURE")) {
      diagnostics.push(
        `scripts/publish-macos.sh: updater feed ${contract.updaterTarget}.signature must come from process.env.SIGNATURE`,
      );
    }
  }
  if (!containsFeedJsonWrite(file)) {
    diagnostics.push(
      "scripts/publish-macos.sh: updater-feed generator must write JSON.stringify(feed) to stdout",
    );
  }
}

function checkReleaseBuildScript(source, contract, diagnostics) {
  const path = "scripts/release-macos.sh";
  const statements = shellStatements(source);
  const failClosed = requireExactStatement(
    statements,
    "set -euo pipefail",
    path,
    "fail-closed shell mode",
    diagnostics,
  );
  const build = requireExactCommand(
    statements,
    ["pnpm", "tauri", "build", "--config", "src-tauri/tauri.updater.conf.json"],
    path,
    "updater-enabled Tauri build",
    diagnostics,
  );
  const app = requireExactStatement(
    statements,
    `APP="$ROOT/target/release/bundle/macos/${contract.productName}.app"`,
    path,
    "signed application owner",
    diagnostics,
  );
  const bundle = requireExactStatement(
    statements,
    `UPDATER_BUNDLE="$ROOT/target/release/bundle/macos/${contract.updaterBundle}"`,
    path,
    "updater bundle owner",
    diagnostics,
  );
  const signature = requireExactStatement(
    statements,
    'UPDATER_SIGNATURE="$UPDATER_BUNDLE.sig"',
    path,
    "updater signature owner",
    diagnostics,
  );
  const gatekeeper = requireExactCommand(
    statements,
    ["spctl", "-a", "-vv", "-t", "exec", "$APP"],
    path,
    "Gatekeeper application verification",
    diagnostics,
  );
  const notarization = requireExactCommand(
    statements,
    ["xcrun", "stapler", "validate", "$APP"],
    path,
    "stapled notarization verification",
    diagnostics,
  );
  const verify = requireExactCommand(
    statements,
    [
      "cargo",
      "run",
      "--quiet",
      "--manifest-path",
      "$ROOT/src-tauri/Cargo.toml",
      "--example",
      "verify-updater-signature",
      "--",
      "$UPDATER_BUNDLE",
      "$UPDATER_SIGNATURE",
      "$ROOT/src-tauri/tauri.conf.json",
    ],
    path,
    "updater signature verification",
    diagnostics,
  );
  if (failClosed && failClosed.index !== 0) {
    diagnostics.push(`${path}:${failClosed.line}: fail-closed shell mode must be first`);
  }
  if (
    build &&
    app &&
    bundle &&
    signature &&
    gatekeeper &&
    notarization &&
    verify &&
    !(
      build.index < app.index &&
      app.index < bundle.index &&
      bundle.index < signature.index &&
      signature.index < gatekeeper.index &&
      gatekeeper.index < notarization.index &&
      notarization.index < verify.index
    )
  ) {
    diagnostics.push(
      `${path}: build, artifact ownership, Gatekeeper, notarization, and updater signature verification are out of order`,
    );
  }
}

function checkPublishScript(source, contract, diagnostics) {
  const path = "scripts/publish-macos.sh";
  const statements = shellStatements(source);
  const releaseCreates = directCommands(statements, ["gh", "release", "create"]);
  if (releaseCreates.length !== 1) {
    diagnostics.push(
      `${path}: expected exactly one gh release create command, found ${releaseCreates.length}`,
    );
    return;
  }
  const create = releaseCreates[0];
  if (create.words[3] !== "$TAG") {
    diagnostics.push(`${path}:${create.line}: gh release create must create $TAG`);
  }
  if (optionValue(create.words, "--target") !== "$COMMIT") {
    diagnostics.push(`${path}:${create.line}: gh release create must use --target $COMMIT`);
  }
  if (
    create.words.filter((word) => word === "--draft").length !== 1 ||
    create.words.some((word) => word === "--draft=false")
  ) {
    diagnostics.push(`${path}:${create.line}: gh release create must create a draft release`);
  }

  const uploadOperands = [
    "$DMG",
    `$STAGE/${contract.stableDmg}`,
    "$UPDATER_BUNDLE",
    "$UPDATER_SIGNATURE",
    `$STAGE/${contract.updaterFeed}`,
  ];
  for (const operand of uploadOperands) {
    const count = create.words.filter((word) => word === operand).length;
    if (count !== 1) {
      diagnostics.push(
        `${path}:${create.line}: gh release create must upload ${JSON.stringify(operand)} exactly once (found ${count})`,
      );
    }
  }

  const requiredBeforeCreate = [
    [
      `VERSION="$(node -p "require('./src-tauri/tauri.conf.json').version")"`,
      "release version owner",
    ],
    ['TAG="v$VERSION"', "release tag owner"],
    [
      `RELEASE_REPOSITORY="$(node -p "require('./scripts/contracts/release.json').repository")"`,
      "release contract repository owner",
    ],
    [
      'REPO_SLUG="$(gh repo view --json nameWithOwner -q .nameWithOwner)"',
      "release repository owner",
    ],
    ['COMMIT="$(git rev-parse HEAD)"', "release commit owner"],
    ['bash "$ROOT/scripts/release-macos.sh"', "signed release build"],
    [
      `DMGS=("$ROOT"/target/release/bundle/dmg/${contract.productName}_"$VERSION"_*.dmg)`,
      "versioned DMG discovery",
    ],
    ['DMG="${DMGS[0]}"', "versioned DMG owner"],
    [
      `UPDATER_BUNDLE="$ROOT/target/release/bundle/macos/${contract.updaterBundle}"`,
      "updater bundle owner",
    ],
    ['UPDATER_SIGNATURE="$UPDATER_BUNDLE.sig"', "updater signature owner"],
    [`cp "$DMG" "$STAGE/${contract.stableDmg}"`, "stable DMG staging"],
    [
      `UPDATER_URL="https://github.com/$REPO_SLUG/releases/download/$TAG/${contract.updaterBundle}"`,
      "updater bundle URL",
    ],
    ['SIGNATURE="$(<"$UPDATER_SIGNATURE")"', "updater signature contents"],
  ];
  const owners = new Map();
  for (const [expected, label] of requiredBeforeCreate) {
    const statement = requireExactStatement(
      statements,
      expected,
      path,
      label,
      diagnostics,
    );
    if (statement && statement.index >= create.index) {
      diagnostics.push(`${path}:${statement.line}: ${label} must precede gh release create`);
    }
    if (statement) owners.set(label, statement);
  }
  const failClosed = requireExactStatement(
    statements,
    "set -euo pipefail",
    path,
    "fail-closed shell mode",
    diagnostics,
  );
  if (failClosed && failClosed.index !== 0) {
    diagnostics.push(`${path}:${failClosed.line}: fail-closed shell mode must be first`);
  }
  const repositoryGuard = requireFailingGuard(
    statements,
    'if [[ "$REPO_SLUG" != "$RELEASE_REPOSITORY" ]]; then',
    path,
    "release repository contract guard",
    diagnostics,
  );
  const contractRepository = owners.get("release contract repository owner");
  const repository = owners.get("release repository owner");
  const updaterUrl = owners.get("updater bundle URL");
  if (repositoryGuard && repositoryGuard.index >= create.index) {
    diagnostics.push(
      `${path}:${repositoryGuard.line}: release repository contract guard must precede gh release create`,
    );
  }
  if (
    contractRepository &&
    repository &&
    repositoryGuard &&
    updaterUrl &&
    !(
      contractRepository.index < repository.index &&
      repository.index < repositoryGuard.index &&
      repositoryGuard.index < updaterUrl.index
    )
  ) {
    diagnostics.push(
      `${path}: release contract repository, resolved repository, equality guard, and updater URL are out of order`,
    );
  }
  const signedBuild = owners.get("signed release build");
  const dmgDiscovery = owners.get("versioned DMG discovery");
  if (signedBuild && dmgDiscovery && signedBuild.index >= dmgDiscovery.index) {
    diagnostics.push(
      `${path}:${signedBuild.line}: signed release build must precede artifact discovery`,
    );
  }

  const cardinalityGuard = requireFailingGuard(
    statements,
    "if (( ${#DMGS[@]} != 1 )); then",
    path,
    "versioned DMG cardinality guard",
    diagnostics,
  );
  const versionedDmg = contract.versionedDmg.replace("<version>", "${VERSION}");
  const filenameGuard = requireFailingGuard(
    statements,
    `if [[ "$(basename "$DMG")" != "${versionedDmg}" ]]; then`,
    path,
    "versioned DMG filename guard",
    diagnostics,
  );
  for (const [guard, label] of [
    [cardinalityGuard, "versioned DMG cardinality guard"],
    [filenameGuard, "versioned DMG filename guard"],
  ]) {
    if (guard && guard.index >= create.index) {
      diagnostics.push(`${path}:${guard.line}: ${label} must precede gh release create`);
    }
  }
  checkFeedGenerator(source, contract, create.line, diagnostics);

  const loops = statements
    .map((statement, index) => ({
      ...statement,
      index,
      words: cleanShellWords(statement),
    }))
    .filter((entry) => wordsStartWith(entry.words, ["for", "asset", "in"]));
  if (loops.length !== 1) {
    diagnostics.push(
      `${path}: expected exactly one post-upload asset verification loop, found ${loops.length}`,
    );
    return;
  }
  const loop = loops[0];
  const doIndex = loop.words.lastIndexOf("do");
  if (doIndex < 0) {
    diagnostics.push(`${path}:${loop.line}: asset verification loop is missing do`);
    return;
  }
  compareExactWords(
    `${path}:${loop.line}: assets verified after upload`,
    [
      "$(basename $DMG)",
      contract.stableDmg,
      contract.updaterBundle,
      contract.updaterSignature,
      contract.updaterFeed,
    ],
    loop.words.slice(3, doIndex),
    diagnostics,
  );
  if (loop.index <= create.index) {
    diagnostics.push(`${path}:${loop.line}: asset verification must follow gh release create`);
  }

  const closeOffset = statements
    .slice(loop.index + 1)
    .findIndex(({ text }) => text === "done");
  if (closeOffset < 0) {
    diagnostics.push(`${path}:${loop.line}: asset verification loop is missing done`);
    return;
  }
  const closeIndex = loop.index + 1 + closeOffset;
  const loopBody = statements.slice(loop.index + 1, closeIndex);
  const verifierWords = [
    "if",
    "!",
    "gh",
    "release",
    "view",
    "$TAG",
    "--json",
    "assets",
    "--jq",
    ".assets[].name",
    "|",
    "grep",
    "-qxF",
    "$asset",
    "then",
  ];
  const verifierIndexes = loopBody
    .map((statement, index) => ({ statement, index, words: cleanShellWords(statement) }))
    .filter(
      ({ words }) =>
        words.length === verifierWords.length &&
        words.every((word, index) => word === verifierWords[index]),
    )
    .map(({ index }) => index);
  if (verifierIndexes.length !== 1) {
    diagnostics.push(
      `${path}:${loop.line}: asset loop must perform exactly one exact-name gh release view verification`,
    );
  }
  const verifierIndex = verifierIndexes.length === 1 ? verifierIndexes[0] : -1;
  const verifierEndOffset =
    verifierIndex >= 0
      ? loopBody.slice(verifierIndex + 1).findIndex(({ text }) => text === "fi")
      : -1;
  const verifierEnd =
    verifierEndOffset >= 0 ? verifierIndex + 1 + verifierEndOffset : -1;
  const exitIndexes =
    verifierEnd >= 0
      ? loopBody
          .slice(verifierIndex + 1, verifierEnd)
          .map(({ text }, index) => (text === "exit 1" ? verifierIndex + 1 + index : -1))
          .filter((index) => index >= 0)
      : [];
  if (
    exitIndexes.length !== 1 ||
    verifierIndexes.length !== 1 ||
    exitIndexes[0] <= verifierIndexes[0]
  ) {
    diagnostics.push(
      `${path}:${loop.line}: a missing uploaded asset must exit unsuccessfully`,
    );
  }

  const releaseEdits = directCommands(statements, ["gh", "release", "edit"]);
  if (releaseEdits.length !== 1) {
    diagnostics.push(
      `${path}: expected exactly one gh release edit publication command, found ${releaseEdits.length}`,
    );
    return;
  }
  const publish = releaseEdits[0];
  const expectedPublish = ["gh", "release", "edit", "$TAG", "--draft=false"];
  if (
    publish.words.length !== expectedPublish.length ||
    !publish.words.every((word, index) => word === expectedPublish[index])
  ) {
    diagnostics.push(
      `${path}:${publish.line}: release publication must be exactly gh release edit $TAG --draft=false`,
    );
  }
  if (publish.index <= closeIndex) {
    diagnostics.push(
      `${path}:${publish.line}: release publication must follow successful post-upload verification`,
    );
  }
}

export function checkReleaseContract({
  rootCargo,
  desktopCargo,
  packageJson,
  tauriConfig,
  updaterConfig,
  cargoLock,
  cargoMetadata,
  releaseScript,
  publishScript,
  contract,
}) {
  const diagnostics = [];
  const rootVersion = tomlSectionValue(rootCargo, "workspace.package", "version", "Cargo.toml");
  const desktopVersion = tomlSectionValue(
    desktopCargo,
    "package",
    "version",
    "src-tauri/Cargo.toml",
  );
  const versions = new Map([
    ["Cargo.toml workspace.package", rootVersion],
    ["src-tauri/Cargo.toml package", desktopVersion],
    ["package.json", packageJson.version],
    ["src-tauri/tauri.conf.json", tauriConfig.version],
  ]);
  for (const [owner, version] of versions) {
    if (version !== rootVersion) {
      diagnostics.push(`${owner}: version ${JSON.stringify(version)} != ${rootVersion}`);
    }
  }

  const workspacePackages = cargoMetadata.packages.filter((entry) =>
    cargoMetadata.workspace_members.includes(entry.id),
  );
  const lockPackages = cargoLockPackages(cargoLock);
  for (const entry of workspacePackages) {
    if (entry.version !== rootVersion) {
      diagnostics.push(
        `${entry.manifest_path}: workspace package ${entry.name} is ${entry.version}, expected ${rootVersion}`,
      );
    }
    const locked = lockPackages.filter((candidate) => candidate.name === entry.name);
    if (locked.length !== 1) {
      diagnostics.push(
        `Cargo.lock: expected exactly one local ${entry.name} package, found ${locked.length}`,
      );
    } else if (locked[0].version !== rootVersion) {
      diagnostics.push(
        `Cargo.lock: ${entry.name} is ${locked[0].version}, expected ${rootVersion}`,
      );
    }
  }

  if (tauriConfig.productName !== contract.productName) {
    diagnostics.push(
      `src-tauri/tauri.conf.json: productName ${JSON.stringify(tauriConfig.productName)} != ${JSON.stringify(contract.productName)}`,
    );
  }
  const expectedEndpoint = `https://github.com/${contract.repository}/releases/latest/download/${contract.updaterFeed}`;
  const endpoints = tauriConfig.plugins?.updater?.endpoints;
  if (JSON.stringify(endpoints) !== JSON.stringify([expectedEndpoint])) {
    diagnostics.push(
      `src-tauri/tauri.conf.json: updater endpoints ${JSON.stringify(endpoints)} != ${JSON.stringify([expectedEndpoint])}`,
    );
  }
  if (updaterConfig.bundle?.createUpdaterArtifacts !== true) {
    diagnostics.push(
      "src-tauri/tauri.updater.conf.json: bundle.createUpdaterArtifacts must be true",
    );
  }
  if (contract.updaterSignature !== `${contract.updaterBundle}.sig`) {
    diagnostics.push(
      `scripts/contracts/release.json: updaterSignature ${JSON.stringify(contract.updaterSignature)} must be ${JSON.stringify(`${contract.updaterBundle}.sig`)}`,
    );
  }
  if (!contract.versionedDmg.includes("<version>")) {
    diagnostics.push(
      "scripts/contracts/release.json: versionedDmg must contain the <version> placeholder",
    );
  }

  checkReleaseBuildScript(releaseScript, contract, diagnostics);
  checkPublishScript(publishScript, contract, diagnostics);
  return diagnostics;
}

function cargoMetadata(root) {
  const result = spawnSync(
    "cargo",
    ["metadata", "--locked", "--no-deps", "--format-version", "1"],
    { cwd: root, encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(
      ["cargo metadata failed", result.stdout.trim(), result.stderr.trim()]
        .filter(Boolean)
        .join("\n"),
    );
  }
  return JSON.parse(result.stdout);
}

export function checkRelease(root = ROOT) {
  const json = (path) => JSON.parse(readFileSync(join(root, path), "utf8"));
  const diagnostics = checkReleaseContract({
    rootCargo: readFileSync(join(root, "Cargo.toml"), "utf8"),
    desktopCargo: readFileSync(join(root, "src-tauri/Cargo.toml"), "utf8"),
    packageJson: json("package.json"),
    tauriConfig: json("src-tauri/tauri.conf.json"),
    updaterConfig: json("src-tauri/tauri.updater.conf.json"),
    cargoLock: readFileSync(join(root, "Cargo.lock"), "utf8"),
    cargoMetadata: cargoMetadata(root),
    releaseScript: readFileSync(join(root, "scripts/release-macos.sh"), "utf8"),
    publishScript: readFileSync(join(root, "scripts/publish-macos.sh"), "utf8"),
    contract: json("scripts/contracts/release.json"),
  });
  if (diagnostics.length > 0) throw new Error(diagnostics.join("\n"));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    checkRelease();
    console.log("release contract is consistent");
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
