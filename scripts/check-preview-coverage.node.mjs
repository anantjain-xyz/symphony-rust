import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { validatePreviewCoverage } from "./check-preview-coverage.mjs";

function write(root, path, content) {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

function writeJson(root, path, value) {
  write(root, path, `${JSON.stringify(value, null, 2)}\n`);
}

function previewFixture(t) {
  const root = mkdtempSync(join(tmpdir(), "symphony-preview-coverage-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  write(
    root,
    "src/App.tsx",
    `type View = "overview" | "runs";
const runs = () => import("./views/RunsView");
const preview = () => import("./preview/runtime");
const updater = () => import("./AppUpdate");
export { preview, runs, updater };
`,
  );
  write(
    root,
    "src/main.tsx",
    `const preview = location.search === "?preview=updater";
const updater = () => import("./AppUpdate").then((module) => module.AppUpdateGeometryPreview);
export { preview, updater };
`,
  );
  write(root, "src/views/RunsView.tsx", "export default function Runs() {}\n");
  write(
    root,
    "src/preview/runtime.ts",
    `const previewOverview = {};
const previewRuns = [];
export const previewRuntime = {
  dashboard: {
    overview: previewOverview,
    runs: previewRuns,
  },
};
`,
  );
  write(
    root,
    "src/AppUpdate.tsx",
    "export function AppUpdateGeometryPreview() {}\n",
  );
  write(
    root,
    "scripts/check-bundle-budget.mjs",
    `export const LAZY_ENTRIES = [
  "src/views/RunsView.tsx",
];
export const FORBIDDEN_EAGER_ENTRIES = [
  "src/AppUpdate.tsx",
  "src/preview/runtime.ts",
];
`,
  );
  write(
    root,
    "e2e/lazy-chunks.e2e.ts",
    `page.getByRole("heading", { name: "Overview" });
page.getByRole("button", { name: "Runs" });
`,
  );
  write(
    root,
    "e2e/updater-geometry.e2e.ts",
    `page.goto("/?preview=updater");
page.locator('[data-preview-fixture="updater-geometry"]');
`,
  );
  writeJson(root, "validation/preview-coverage.json", {
    version: 1,
    sourceRoot: "src",
    appSource: "src/App.tsx",
    previewEntry: "src/main.tsx",
    previewFixture: "src/preview/runtime.ts",
    bundleOwner: "scripts/check-bundle-budget.mjs",
    routeE2eOwner: "e2e/lazy-chunks.e2e.ts",
    dynamicImportOwners: ["src/App.tsx", "src/main.tsx"],
    routes: [
      {
        id: "overview",
        label: "Overview",
        module: null,
        fixture: "dashboard.overview",
      },
      {
        id: "runs",
        label: "Runs",
        module: "src/views/RunsView.tsx",
        fixture: "dashboard.runs",
      },
    ],
    infrastructureEntries: [
      "src/AppUpdate.tsx",
      "src/preview/runtime.ts",
    ],
    updaterGeometry: {
      component: "AppUpdateGeometryPreview",
      module: "src/AppUpdate.tsx",
      query: "?preview=updater",
      fixtureSelector: "updater-geometry",
      e2eOwner: "e2e/updater-geometry.e2e.ts",
    },
  });
  return root;
}

test("accepts matching routes, fixtures, dynamic entries, budgets, and E2E", (t) => {
  const root = previewFixture(t);
  assert.deepEqual(validatePreviewCoverage(root), []);
});

test("reports missing bundle and E2E route projections", (t) => {
  const root = previewFixture(t);
  write(
    root,
    "scripts/check-bundle-budget.mjs",
    `export const LAZY_ENTRIES = [];
export const FORBIDDEN_EAGER_ENTRIES = [
  "src/AppUpdate.tsx",
  "src/preview/runtime.ts",
];
`,
  );
  write(
    root,
    "e2e/lazy-chunks.e2e.ts",
    'page.getByRole("heading", { name: "Overview" });\n',
  );

  const errors = validatePreviewCoverage(root).join("\n");
  assert.match(errors, /bundle lazy view entries is missing src\/views\/RunsView\.tsx/);
  assert.match(
    errors,
    /lazy-chunks\.e2e\.ts is missing preview interaction coverage for runs/,
  );
});

test("rejects undeclared dynamic entries and stale preview fixtures", (t) => {
  const root = previewFixture(t);
  write(root, "src/Extra.tsx", "export const extra = true;\n");
  write(
    root,
    "src/main.tsx",
    `const preview = location.search === "?preview=updater";
const updater = () => import("./AppUpdate").then((module) => module.AppUpdateGeometryPreview);
const extra = () => import("./Extra");
export { extra, preview, updater };
`,
  );
  write(
    root,
    "src/preview/runtime.ts",
    `export const previewRuntime = {
  dashboard: {
    overview: {},
  },
};
`,
  );

  const errors = validatePreviewCoverage(root).join("\n");
  assert.match(errors, /declared frontend dynamic imports has undeclared extra src\/Extra\.tsx/);
  assert.match(
    errors,
    /preview\/runtime\.ts is missing fixture projection dashboard\.runs for route runs/,
  );
});
