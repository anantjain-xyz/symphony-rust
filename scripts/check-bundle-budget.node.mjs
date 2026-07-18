import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  FORBIDDEN_EAGER_ENTRIES,
  LAZY_ENTRIES,
  collectJavaScriptFiles,
  collectStaticGraph,
  inspectBundle,
} from "./check-bundle-budget.mjs";

test("lazy payload accounting includes transitive static chunks but excludes eager files", () => {
  const manifest = {
    entry: { file: "assets/entry.js", imports: ["eager-shared"] },
    "eager-shared": { file: "assets/eager-shared.js" },
    lazy: { file: "assets/lazy.js", imports: ["eager-shared", "lazy-shared"] },
    "lazy-shared": { file: "assets/lazy-shared.js" },
  };
  const eagerGraph = collectStaticGraph(manifest, "entry");
  const lazyGraph = collectStaticGraph(manifest, "lazy");
  assert.deepEqual(
    [...collectJavaScriptFiles(manifest, lazyGraph, eagerGraph)].sort(),
    ["assets/lazy-shared.js", "assets/lazy.js"],
  );
});

test("Vite manifest isolates hidden views, preview, and updater modules", async () => {
  const { manifest, entryKey, eagerGraph } = await inspectBundle();
  for (const entry of LAZY_ENTRIES) {
    assert.equal(manifest[entry]?.isDynamicEntry, true, `${entry} must be lazy`);
    assert.equal(eagerGraph.has(entry), false, `${entry} must not be eager`);
  }
  for (const entry of FORBIDDEN_EAGER_ENTRIES) {
    assert.equal(manifest[entry]?.isDynamicEntry, true, `${entry} must be lazy`);
    assert.equal(eagerGraph.has(entry), false, `${entry} must not be eager`);
  }
  assert.deepEqual(
    manifest["src/views/IssuesView.tsx"].dynamicImports,
    ["src/views/DependencyGraphPanel.tsx"],
  );

  const graphCss = manifest["src/views/DependencyGraphPanel.tsx"].css ?? [];
  assert.equal(graphCss.length, 1, "the graph owns a dedicated stylesheet");
  assert.match(graphCss[0], /DependencyGraphPanel-.+\.css$/);

  const eagerCss = new Set(
    [...eagerGraph].flatMap((key) => manifest[key]?.css ?? []),
  );
  const issuesGraph = collectStaticGraph(manifest, "src/views/IssuesView.tsx");
  const issuesCss = new Set(
    [...issuesGraph].flatMap((key) => manifest[key]?.css ?? []),
  );
  for (const file of graphCss) {
    assert.equal(eagerCss.has(file), false, `${file} must not load eagerly from ${entryKey}`);
    assert.equal(issuesCss.has(file), false, `${file} must not load with Issues List`);
  }
});

test("shared table primitives stay in the eager stylesheet", async () => {
  const eagerCss = await readFile(new URL("../src/App.css", import.meta.url), "utf8");
  const retroCss = await readFile(
    new URL("../src/views/RetroView.css", import.meta.url),
    "utf8",
  );
  for (const selector of ["table", "th", "thead", "tr", "td", "tbody tr:hover"]) {
    const rule = new RegExp(`^${selector} \\{`, "m");
    assert.match(eagerCss, rule, `${selector} must load eagerly`);
    assert.doesNotMatch(retroCss, rule, `${selector} must not wait for Retro`);
  }
});

test("shared shell and form primitives stay in the eager stylesheet", async () => {
  const eagerCss = await readFile(new URL("../src/App.css", import.meta.url), "utf8");
  const updaterCss = await readFile(
    new URL("../src/AppUpdate.css", import.meta.url),
    "utf8",
  );
  const settingsCss = await readFile(
    new URL("../src/views/SettingsView.css", import.meta.url),
    "utf8",
  );

  assert.match(eagerCss, /^small \{/m, "small text must load before the updater");
  assert.doesNotMatch(updaterCss, /^small \{/m, "small text must not wait for updater");

  for (const selector of [
    "input,\\nselect,\\ntextarea",
    "input::placeholder,\\ntextarea::placeholder",
    "input:disabled,\\nselect:disabled,\\ntextarea:disabled",
  ]) {
    const rule = new RegExp(`^${selector} \\{`, "m");
    assert.match(eagerCss, rule, `${selector} must load before Settings`);
    assert.doesNotMatch(settingsCss, rule, `${selector} must not wait for Settings`);
  }

  for (const selector of [
    "\\.worker-toggle\\.confirm,\\n\\.worker-toggle\\.confirm:hover:not\\(:disabled\\)",
    "\\.worker-toggle\\.confirm \\.status-dot",
  ]) {
    const rule = new RegExp(`^${selector} \\{`, "m");
    assert.match(eagerCss, rule, `${selector} must load with the shell`);
    assert.doesNotMatch(settingsCss, rule, `${selector} must not wait for Settings`);
  }
});
