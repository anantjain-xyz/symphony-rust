// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ValidationResult, WorkerStatus } from "../../bindings";
import { previewRuntime } from "../../preview/runtime";
import { useSettingsController } from "./useSettingsController";

const commands = vi.hoisted(() => ({ saveSettings: vi.fn(), getWorkerStatus: vi.fn() }));
vi.mock("../../desktop/commands", () => commands);

afterEach(() => vi.useRealTimers());

it.each(["healthy reconfiguration", "worker restart"])(
  "keeps skipped runtime status through unlock and reload until %s",
  async (completion) => {
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
    const oldHealthyWorker: WorkerStatus = {
      state: "running",
      started_at: "2026-01-01T00:00:00.000Z",
      last_error: null,
    };
    const skippedWorker: WorkerStatus = {
      ...oldHealthyWorker,
      last_error: "Settings saved, but credential access prevented worker update.",
    };
    commands.getWorkerStatus.mockResolvedValue(skippedWorker);
    const { result, rerender } = renderHook(
      ({ worker }: { worker: WorkerStatus }) =>
        useSettingsController({
          runtimeAvailable: true,
          run: async (operation) => operation(),
          acceptWorker: vi.fn(),
          readWorkerStatus: () => worker,
          refreshRepositories: vi.fn(),
        }),
      { initialProps: { worker: oldHealthyWorker } },
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
    // The dashboard has not accepted the returned status yet. Its old healthy
    // snapshot must not clear the reason during the Save response render.
    expect(result.current.savedLiveConfigKept).toBe(true);
    rerender({ worker: skippedWorker });
    expect(result.current.savedLiveConfigKept).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(result.current.savedFlash).toBe(false);
    act(() =>
      result.current.acceptSaved({
        ...saved,
        linear_api_key_set: true,
        linear_api_key_error: null,
      }),
    );
    expect(result.current.saved?.linear_api_key_error).toBeNull();
    expect(result.current.savedLiveConfigKept).toBe(true);
    expect(result.current.savedLiveConfigKeptReason).toBe("credential");
    rerender({ worker: { ...skippedWorker } });
    expect(result.current.savedLiveConfigKept).toBe(true);
    rerender({
      worker: {
        ...oldHealthyWorker,
        state: completion === "worker restart" ? "stopped" : "running",
      },
    });
    expect(result.current.savedLiveConfigKept).toBe(false);
    expect(result.current.savedLiveConfigKeptReason).toBeNull();
    rerender({ worker: { ...oldHealthyWorker } });
    expect(result.current.savedLiveConfigKept).toBe(false);
  },
);

it("keeps an incomplete-workflow reason when healthy polls cannot prove an update", async () => {
  const saved = { ...previewRuntime.settings, tracker_assigned_to_me: false, repos: [] };
  const healthy: WorkerStatus = { state: "running", started_at: null, last_error: null };
  commands.saveSettings.mockResolvedValue(saved);
  commands.getWorkerStatus.mockResolvedValue(healthy);
  const { result, rerender } = renderHook(
    ({ worker }: { worker: WorkerStatus }) =>
      useSettingsController({
        runtimeAvailable: true,
        run: async (operation) => operation(),
        acceptWorker: vi.fn(),
        readWorkerStatus: () => worker,
        refreshRepositories: vi.fn(),
      }),
    { initialProps: { worker: healthy } },
  );
  act(() => {
    result.current.acceptSaved(saved);
    result.current.session.replaceDraft(saved);
  });
  await act(async () => {
    await result.current.save(saved, "", {
      workflow_ok: false,
      workflow_blocking: false,
    } as ValidationResult);
  });
  expect(result.current.savedLiveConfigKeptReason).toBe("workflow");
  rerender({ worker: { ...healthy } });
  expect(result.current.savedLiveConfigKeptReason).toBe("workflow");
  rerender({ worker: { ...healthy, state: "stopped" } });
  expect(result.current.savedLiveConfigKeptReason).toBeNull();
});
