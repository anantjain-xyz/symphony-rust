import assert from "node:assert/strict";
import test from "node:test";
import {
  FORBIDDEN_EAGER_ENTRIES,
  LAZY_ENTRIES,
  inspectBundle,
} from "./check-bundle-budget.mjs";

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
