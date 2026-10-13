// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ValidationResult, WorkerStatus } from "../../bindings";
import { previewRuntime } from "../../preview/runtime";
import { useSettingsController } from "./useSettingsController";

const commands = vi.hoisted(() => ({ saveSettings: vi.fn(), getWorkerStatus: vi.fn() }));
vi.mock("../../desktop/commands", () => commands);

afterEach(() => vi.useRealTimers());

it("keeps skipped runtime status through unlock and reload until a worker restart", async () => {
  vi.useFakeTimers();
  const saved = {
    ...previewRuntime.settings,
    tracker_assigned_to_me: false,
    settings_revision: 1,
    linear_api_key_set: false,
    linear_api_key_error: "Credential store unavailable",
    prompt_template: "New saved prompt",
  };
  commands.saveSettings.mockResolvedValue(saved);
  commands.getWorkerStatus.mockResolvedValue({ state: "running", last_error: null });
  const { result, rerender } = renderHook(
    ({ workerState }: { workerState: WorkerStatus["state"] }) =>
      useSettingsController({
        runtimeAvailable: true,
        run: async (operation) => operation(),
        acceptWorker: vi.fn(),
        readWorkerState: () => workerState,
        refreshRepositories: vi.fn(),
      }),
    { initialProps: { workerState: "running" } },
  );
  act(() => {
    result.current.acceptSaved({ ...saved, settings_revision: 0 });
    result.current.session.replaceDraft({ ...saved, settings_revision: 0 });
    result.current.session.setDirty(true);
  });
  await act(async () => {
    await result.current.save(result.current.session.readDraft()!, "", {
      workflow_ok: true,
      workflow_blocking: false,
    } as ValidationResult);
  });
  expect(result.current.savedLiveConfigKept).toBe(true);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3000);
  });
  expect(result.current.savedFlash).toBe(false);
  act(() =>
    result.current.acceptSaved({ ...saved, linear_api_key_set: true, linear_api_key_error: null }),
  );
  expect(result.current.saved?.linear_api_key_error).toBeNull();
  expect(result.current.savedLiveConfigKept).toBe(true);
  rerender({ workerState: "stopped" });
  expect(result.current.savedLiveConfigKept).toBe(false);
  rerender({ workerState: "running" });
  expect(result.current.savedLiveConfigKept).toBe(false);
});
