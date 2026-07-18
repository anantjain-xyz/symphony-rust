import assert from "node:assert/strict";
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
  const { manifest, eagerGraph } = await inspectBundle();
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
    ["src/views/DependencyGraphView.tsx"],
  );
});
