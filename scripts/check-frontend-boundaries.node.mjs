import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { validateFrontendBoundaries } from "./check-frontend-boundaries.mjs";

function write(root, path, content) {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

function writeJson(root, path, value) {
  write(root, path, `${JSON.stringify(value, null, 2)}\n`);
}

function boundaryFixture(t) {
  const root = mkdtempSync(join(tmpdir(), "symphony-frontend-boundaries-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  write(
    root,
    "src/desktop/commands.ts",
    `import { invoke } from "@tauri-apps/api/core";
function invokeCommand(command: string) { return invoke(command); }
export const commands = {
  load: () => invokeCommand("load_settings"),
  save: () => invokeCommand("save_settings"),
};
`,
  );
  write(
    root,
    "src/desktop/events.ts",
    `import { listen, type UnlistenFn } from "@tauri-apps/api/event";
const clean = (_items: UnlistenFn[]) => undefined;
export function subscribe() {
  clean([]);
  return listen("db_changed", () => undefined);
}
`,
  );
  write(
    root,
    "src/desktop/runtime.ts",
    `import { isTauri } from "@tauri-apps/api/core";
export const isDesktopRuntime = () => isTauri();
`,
  );
  write(
    root,
    "src/App.tsx",
    `import { isDesktopRuntime } from "./desktop/runtime";
const loadPreviewRuntime = () => import("./preview/runtime");
export const app = isDesktopRuntime() ? "native" : loadPreviewRuntime;
`,
  );
  write(root, "src/bindings.ts", "export type Settings = {};\n");
  write(root, "src/main.tsx", "export const preview = true;\n");
  write(root, "src/preview/runtime.ts", "export const runtime = {};\n");
  for (const [path, marker] of [
    ["src/coordinator.test.ts", "caller settlement"],
    ["src/poll.test.ts", "hidden resume"],
  ]) {
    write(root, path, `test("${marker}", () => undefined);\n`);
  }
  writeJson(root, "validation/frontend-boundaries.json", {
    version: 1,
    sourceRoot: "src",
    generatedOwners: ["src/bindings.ts"],
    previewOwners: ["src/main.tsx", "src/preview/runtime.ts"],
    runtimeSelectionOwner: "src/App.tsx",
    tauriImportOwners: {
      "@tauri-apps/api/core": [
        "src/desktop/commands.ts",
        "src/desktop/runtime.ts",
      ],
      "@tauri-apps/api/event": ["src/desktop/events.ts"],
    },
    commandOwner: "src/desktop/commands.ts",
    commands: ["load_settings", "save_settings"],
    eventOwner: "src/desktop/events.ts",
    events: ["db_changed"],
    asyncInvariantTests: [
      {
        id: "per-caller",
        path: "src/coordinator.test.ts",
        marker: "caller settlement",
      },
      {
        id: "hidden",
        path: "src/poll.test.ts",
        marker: "hidden resume",
      },
    ],
  });
  return root;
}

test("accepts typed command, event, runtime, preview, and invariant owners", (t) => {
  const root = boundaryFixture(t);
  assert.deepEqual(validateFrontendBoundaries(root), []);
});

test("reports direct Tauri calls and unknown literals with file and line", (t) => {
  const root = boundaryFixture(t);
  write(
    root,
    "src/Feature.tsx",
    `import { invoke } from "@tauri-apps/api/core";
export const load = () => invoke("missing_command");
`,
  );

  const errors = validateFrontendBoundaries(root).join("\n");
  assert.match(
    errors,
    /src\/Feature\.tsx:1 imports @tauri-apps\/api\/core; approved owners:/,
  );
  assert.match(
    errors,
    /src\/Feature\.tsx:2 calls Tauri invoke directly/,
  );
  assert.match(
    errors,
    /src\/Feature\.tsx:2 invokes unknown desktop command "missing_command"/,
  );
});

test("rejects unknown adapter commands, cleanup drift, and missing invariants", (t) => {
  const root = boundaryFixture(t);
  const commandOwner = join(root, "src/desktop/commands.ts");
  writeFileSync(
    commandOwner,
    readFileSync(commandOwner, "utf8").replace(
      '"save_settings"',
      '"save_setting"',
    ) + "\nexport const dynamic = (command: string) => invokeCommand(command);\n",
  );
  write(
    root,
    "src/Feature.tsx",
    `type UnlistenFn = () => void;
export const cleanup = (unlisten: UnlistenFn) => unlisten();
`,
  );
  write(root, "src/poll.test.ts", 'test("different behavior", () => undefined);\n');

  const errors = validateFrontendBoundaries(root).join("\n");
  assert.match(errors, /declares unknown desktop command "save_setting"/);
  assert.match(errors, /typed desktop command methods is missing save_settings/);
  assert.match(errors, /uses a non-literal desktop command/);
  assert.match(
    errors,
    /src\/Feature\.tsx:1 owns listener cleanup outside src\/desktop\/events\.ts/,
  );
  assert.match(errors, /async invariant hidden .* exactly once; found 0/);
});
