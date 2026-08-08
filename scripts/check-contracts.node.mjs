import assert from "node:assert/strict";
import test from "node:test";

import { bindingsDifference } from "./check-bindings.mjs";
import { checkIpcContract } from "./check-ipc.mjs";
import { checkProjectionContract, storageMutationDiagnostics } from "./check-projections.mjs";

test("bindings byte comparison accepts equality and pinpoints drift", () => {
  assert.equal(bindingsDifference(Buffer.from("one\ntwo\n"), Buffer.from("one\ntwo\n")), null);
  const difference = bindingsDifference(Buffer.from("one\ntwo\n"), Buffer.from("one\nthree\n"));
  assert.match(difference, /line 2/u);
  assert.match(difference, /"two"/u);
  assert.match(difference, /"three"/u);
});

const ipcFixture = {
  rustSources: [
    {
      path: "src-tauri/src/commands.rs",
      source: `
        #[tauri::command(rename_all = "snake_case")]
        fn frontend() {}
        #[tauri::command]
        async fn diagnostic() {}
      `,
    },
    {
      path: "src-tauri/src/lib.rs",
      source: `
        fn run() {
          invoke_handler(tauri::generate_handler![
            commands::frontend,
            commands::diagnostic,
          ]);
        }
      `,
    },
  ],
  frontendSources: [
    {
      path: "src/app.ts",
      source: `
        import { invoke as tauriInvoke } from "@tauri-apps/api/core";
        function invokeCommand(command: string, args?: Record<string, unknown>) {
          return tauriInvoke(command, args);
        }
        invokeCommand<void>("frontend");
      `,
    },
  ],
  backendOnly: ["diagnostic"],
};

test("IPC checker accepts aliases, wrappers, command attributes, and qualified handlers", () => {
  assert.deepEqual(checkIpcContract(ipcFixture), []);
});

test("IPC checker reports exact missing and extra ownership", () => {
  const diagnostics = checkIpcContract({
    ...ipcFixture,
    frontendSources: [
      {
        path: "src/app.ts",
        source: `
          import { invoke as tauriInvoke } from "@tauri-apps/api/core";
          tauriInvoke("unexpected");
        `,
      },
    ],
  });
  assert.ok(
    diagnostics.some(
      (message) =>
        message.includes("frontend use + backend-only") &&
        message.includes("missing [frontend]") &&
        message.includes("extra [unexpected]"),
    ),
  );
});

test("IPC checker rejects dynamic calls through an invoke wrapper", () => {
  const diagnostics = checkIpcContract({
    ...ipcFixture,
    frontendSources: [
      {
        path: "src/app.ts",
        source: `
          import * as tauriCore from "@tauri-apps/api/core";
          function invokeCommand(command: string) {
            return tauriCore.invoke(command);
          }
          const command = "frontend";
          invokeCommand(command);
        `,
      },
    ],
  });
  assert.ok(diagnostics.some((message) => message.includes("non-literal frontend invokes")));
});

test("IPC checker ignores unrelated invoke functions without a Tauri import", () => {
  const diagnostics = checkIpcContract({
    ...ipcFixture,
    frontendSources: [
      {
        path: "src/app.ts",
        source: `function invoke(command: string) { return command; } invoke("frontend");`,
      },
    ],
  });
  assert.ok(
    diagnostics.some(
      (message) =>
        message.includes("frontend use + backend-only") && message.includes("missing [frontend]"),
    ),
  );
});

test("IPC checker rejects duplicate Rust and backend-only ownership", () => {
  const diagnostics = checkIpcContract({
    ...ipcFixture,
    rustSources: [
      {
        path: "src-tauri/src/lib.rs",
        source: `
          #[tauri::command]
          fn frontend() {}
          #[tauri::command]
          fn frontend() {}
          tauri::generate_handler![frontend, frontend, diagnostic];
        `,
      },
    ],
    backendOnly: ["diagnostic", "diagnostic"],
  });
  assert.ok(
    diagnostics.some(
      (message) =>
        message.includes("Rust command definitions") && message.includes("duplicates [frontend]"),
    ),
  );
  assert.ok(
    diagnostics.some(
      (message) =>
        message.includes("generate_handler! registrations") &&
        message.includes("duplicates [frontend]"),
    ),
  );
  assert.ok(
    diagnostics.some(
      (message) =>
        message.includes("backend-only command allowlist") &&
        message.includes("duplicates [diagnostic]"),
    ),
  );
});

const importedWrapperIpcFixture = {
  rustSources: [
    {
      path: "src-tauri/src/commands.rs",
      source: `
        #[tauri::command]
        fn frontend(
          state: State<'_, AppState>,
          issue_id: String,
          retry_count: u32,
        ) {}
      `,
    },
    {
      path: "src-tauri/src/lib.rs",
      source: `tauri::generate_handler![commands::frontend];`,
    },
  ],
  frontendSources: [
    {
      path: "src/desktop/bridge.ts",
      source: `
        import { invoke } from "@tauri-apps/api/core";
        export function invokeCommand(
          command: string,
          args?: Record<string, unknown>,
        ) {
          return invoke(command, args);
        }
      `,
    },
    {
      path: "src/feature/calls.ts",
      source: `
        import { invokeCommand as callDesktop } from "../desktop/bridge";
        callDesktop<void>("frontend", { issueId: "SYM-1", retryCount: 2 });
      `,
    },
  ],
  backendOnly: [],
};

test("IPC checker resolves imported wrappers and JavaScript-facing argument names", () => {
  assert.deepEqual(checkIpcContract(importedWrapperIpcFixture), []);
});

test("IPC checker rejects frontend argument-name drift", () => {
  const diagnostics = checkIpcContract({
    ...importedWrapperIpcFixture,
    frontendSources: importedWrapperIpcFixture.frontendSources.map((source) => ({
      ...source,
      source: source.source.replace("issueId:", "staleIssueId:"),
    })),
  });
  assert.ok(
    diagnostics.some(
      (message) =>
        message.includes("IPC arguments for frontend") &&
        message.includes("missing [issueId]") &&
        message.includes("extra [staleIssueId]"),
    ),
  );
});

test("IPC checker rejects serialized argument value-type drift", () => {
  const diagnostics = checkIpcContract({
    ...importedWrapperIpcFixture,
    rustSources: importedWrapperIpcFixture.rustSources.map((source) => ({
      ...source,
      source: source.source.replace("issue_id: String", "issue_id: u64"),
    })),
  });
  assert.ok(
    diagnostics.some(
      (message) =>
        message.includes("IPC argument value type for frontend.issueId") &&
        message.includes("Rust number") &&
        message.includes("frontend string"),
    ),
  );
});

test("IPC checker rejects serialized command return-type drift", () => {
  const diagnostics = checkIpcContract({
    ...importedWrapperIpcFixture,
    rustSources: importedWrapperIpcFixture.rustSources.map((source) => ({
      ...source,
      source: source.source.replace(
        "        ) {}",
        "        ) -> Result<Option<String>, String> { todo!() }",
      ),
    })),
    frontendSources: importedWrapperIpcFixture.frontendSources.map((source) => ({
      ...source,
      source: source.source.replace(
        'callDesktop<void>("frontend"',
        'callDesktop<string>("frontend"',
      ),
    })),
  });
  assert.ok(
    diagnostics.some(
      (message) =>
        message.includes("IPC return value type for frontend") &&
        message.includes("Rust string | null") &&
        message.includes("frontend string"),
    ),
  );
});

const compositeIpcFixture = {
  rustSources: [
    {
      path: "src-tauri/src/commands.rs",
      source: `
        type Label = String;
        struct Payload {
          enabled: bool,
        }

        #[tauri::command]
        fn serialized(
          maybe: Option<Label>,
          names: Vec<String>,
          env: BTreeMap<String, String>,
          pair: (String, u32),
          payload: Payload,
        ) {}
      `,
    },
    {
      path: "src-tauri/src/lib.rs",
      source: `tauri::generate_handler![commands::serialized];`,
    },
  ],
  frontendSources: [
    {
      path: "src/calls.ts",
      source: `
        import { invoke as callDesktop } from "@tauri-apps/api/core";

        type OptionalLabel = string | null;
        type Payload = { enabled: boolean };

        export function sendSerialized(
          maybe: OptionalLabel,
          names: string[],
          env: Record<string, string>,
          pair: [string, number],
          payload: Payload,
        ) {
          return callDesktop<void>("serialized", { maybe, names, env, pair, payload });
        }
      `,
    },
  ],
  backendOnly: [],
};

test("IPC checker normalizes aliases, options, arrays, maps, tuples, and named objects", () => {
  assert.deepEqual(checkIpcContract(compositeIpcFixture), []);
});

test("IPC checker rejects a nested serialized container type mismatch", () => {
  const diagnostics = checkIpcContract({
    ...compositeIpcFixture,
    frontendSources: compositeIpcFixture.frontendSources.map((source) => ({
      ...source,
      source: source.source.replace("env: Record<string, string>", "env: Record<string, number>"),
    })),
  });
  assert.ok(
    diagnostics.some(
      (message) =>
        message.includes("IPC argument value type for serialized.env") &&
        message.includes("Record<string, string>") &&
        message.includes("Record<string, number>"),
    ),
  );
});

test("IPC checker rejects opaque frontend argument objects", () => {
  const diagnostics = checkIpcContract({
    ...importedWrapperIpcFixture,
    frontendSources: importedWrapperIpcFixture.frontendSources.map((source) => ({
      ...source,
      source: source.source.replace(
        'callDesktop<void>("frontend", { issueId: "SYM-1", retryCount: 2 });',
        `const args = { issueId: "SYM-1", retryCount: 2 };
         callDesktop<void>("frontend", args);`,
      ),
    })),
  });
  assert.ok(
    diagnostics.some((message) => message.includes("non-literal frontend invoke argument objects")),
  );
});

const projectionFixture = {
  rustPromptSource: `pub const PROMPT_VARIABLES: [&str; 1] = ["issue.id"];`,
  settingsSource: `
    const PROMPT_VARIABLES = [
      { name: "issue.id", description: "id", example: "" },
    ];
  `,
  readmeSource: `
| Placeholder | Renders as |
|---|---|
| \`{{issue.id}}\` | ID |
`,
  storageSource: `
    impl Repository {
      fn save(&self) {
        sqlx::query("insert into issues (id) values (?1)");
        self.changed("issues", "upsert");
      }
    }
  `,
  dashboardSource: `
    const TABLE_INVALIDATIONS = {
      issues: ["overview"],
    };
  `,
  rustEventSource: `
    fn forward(handle: AppHandle) {
      handle.emit("db_changed", &event);
      handle.emit("agent_event", &event);
      handle.emit("rate_limit_changed", &event);
    }
  `,
  frontendEventSource: `
    import { listen as subscribe } from "@tauri-apps/api/event";
    subscribe("db_changed", handler);
    subscribe("agent_event", handler);
    subscribe("rate_limit_changed", handler);
  `,
};

test("projection checker accepts matching prompt and invalidation owners", () => {
  assert.deepEqual(checkProjectionContract(projectionFixture), []);
});

test("projection checker reports both missing and extra values", () => {
  const diagnostics = checkProjectionContract({
    ...projectionFixture,
    settingsSource: `
      const PROMPT_VARIABLES = [
        { name: "issue.title", description: "title", example: "" },
      ];
    `,
    dashboardSource: `const TABLE_INVALIDATIONS = { runs: ["overview"] };`,
  });
  assert.ok(
    diagnostics.some(
      (message) =>
        message.includes("Settings UI") &&
        message.includes("missing [issue.id]") &&
        message.includes("extra [issue.title]"),
    ),
  );
  assert.ok(
    diagnostics.some(
      (message) =>
        message.includes("frontend invalidations") &&
        message.includes("missing [issues]") &&
        message.includes("extra [runs]"),
    ),
  );
});

test("projection checker rejects backend and frontend event-name drift", () => {
  const diagnostics = checkProjectionContract({
    ...projectionFixture,
    rustEventSource: projectionFixture.rustEventSource.replace(
      '"agent_event"',
      '"agent_event_renamed"',
    ),
  });
  assert.ok(
    diagnostics.some(
      (message) =>
        message.includes("backend emitted events vs frontend subscriptions") &&
        message.includes("missing [agent_event_renamed]") &&
        message.includes("extra [agent_event]"),
    ),
  );
});

test("projection checker rejects a durable mutation without its table notification", () => {
  const diagnostics = checkProjectionContract({
    ...projectionFixture,
    storageSource: `
      impl Repository {
        fn save(&self) {
          sqlx::query("insert into issues (id) values (?1)");
          sqlx::query("delete from runs where issue_id = ?1");
          self.changed("issues", "upsert");
        }
      }
    `,
  });
  assert.ok(
    diagnostics.some(
      (message) =>
        message.includes("Repository::save") &&
        message.includes("mutates [runs]") &&
        message.includes("self.changed"),
    ),
  );
});

test("projection checker narrowly exempts internal retro batch bookkeeping", () => {
  assert.deepEqual(
    storageMutationDiagnostics(`
      impl Repository {
        fn reserve_retro_batch(&self) {
          sqlx::query("update retros set id = id where id = ?1");
          sqlx::query("insert into retro_batches (id) values (?1)");
          sqlx::query("insert into retro_batch_items (batch_id) values (?1)");
          self.changed("retro_batches", "insert");
        }
      }
    `),
    [],
  );
  assert.ok(
    storageMutationDiagnostics(`
      impl Repository {
        fn write_join_row_directly(&self) {
          sqlx::query("insert into retro_batch_items (batch_id) values (?1)");
        }
      }
    `).some(
      (message) =>
        message.includes("Repository::write_join_row_directly") &&
        message.includes("retro_batch_items"),
    ),
  );
});

test("projection checker rejects opaque sqlx::query ownership", () => {
  assert.ok(
    storageMutationDiagnostics(`
      impl Repository {
        fn save(&self, statement: &str) {
          sqlx::query(statement);
        }
      }
    `).some(
      (message) =>
        message.includes("Repository::save") && message.includes("non-literal sqlx::query"),
    ),
  );
});

test("projection checker rejects unclassified literal SQL forms", () => {
  assert.ok(
    storageMutationDiagnostics(`
      impl Repository {
        fn clear_due_retries(&self) {
          sqlx::query(
            "with candidates as (select issue_id from retry_queue)
             delete from retry_queue where issue_id in (select issue_id from candidates)"
          );
        }
      }
    `).some(
      (message) =>
        message.includes("Repository::clear_due_retries") &&
        message.includes("unclassified literal sqlx::query"),
    ),
  );
});
