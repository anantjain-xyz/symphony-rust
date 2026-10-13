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
    commands.saveSettings.mockResolvedValue({ settings: saved, runtime_update_error: null });
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

it("clears an incomplete-workflow reason after a later healthy reconfiguration", async () => {
  const saved = { ...previewRuntime.settings, tracker_assigned_to_me: false, repos: [] };
  const healthy: WorkerStatus = { state: "running", started_at: null, last_error: null };
  commands.saveSettings.mockResolvedValue({ settings: saved, runtime_update_error: null });
  const skipped: WorkerStatus = {
    ...healthy,
    last_error: "Settings saved, but incomplete configuration prevented worker update.",
  };
  commands.getWorkerStatus.mockResolvedValue(skipped);
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
  rerender({ worker: skipped });
  expect(result.current.savedLiveConfigKeptReason).toBe("workflow");
  rerender({ worker: { ...skipped } });
  expect(result.current.savedLiveConfigKeptReason).toBe("workflow");
  rerender({ worker: { ...healthy } });
  expect(result.current.savedLiveConfigKeptReason).toBeNull();
});

it.each([null, "Settings were saved, but runtime update failed."])(
  "acknowledges the durable save with runtime error %s and no worker snapshot",
  async (runtimeError) => {
    const initial = {
      ...previewRuntime.settings,
      tracker_assigned_to_me: false,
      settings_revision: 0,
    };
    const submitted = { ...initial, prompt_template: "Submitted prompt" };
    const saved = { ...submitted, settings_revision: 1 };
    let complete!: (value: { settings: typeof saved; runtime_update_error: string | null }) => void;
    commands.saveSettings.mockReturnValue(
      new Promise((resolve) => {
        complete = resolve;
      }),
    );
    commands.getWorkerStatus.mockRejectedValue(new Error("Status unavailable"));
    let worker: WorkerStatus = { state: "running", started_at: null, last_error: null };
    const { result, rerender } = renderHook(() =>
      useSettingsController({
        runtimeAvailable: true,
        run: async (operation) => operation(),
        acceptWorker: vi.fn(),
        readWorkerStatus: () => worker,
        refreshRepositories: vi.fn(),
      }),
    );
    act(() => {
      result.current.acceptSaved(initial);
      result.current.session.replaceDraft(submitted);
      result.current.session.setDirty(true);
    });
    let pending!: ReturnType<typeof result.current.save>;
    act(() => {
      pending = result.current.save(submitted, "", {
        workflow_ok: true,
        workflow_blocking: false,
      } as ValidationResult);
      result.current.session.replaceDraft({ ...submitted, prompt_template: "Descendant edit" });
    });
    await act(async () => {
      complete({ settings: saved, runtime_update_error: runtimeError });
      await pending;
    });
    expect(result.current.saved).toBe(saved);
    expect(result.current.session.readDraft()).toMatchObject({
      settings_revision: 1,
      prompt_template: "Descendant edit",
    });
    expect(result.current.dirty).toBe(true);
    expect(result.current.runtimeUpdateError).toBe(runtimeError);
    expect(result.current.savedLiveConfigKeptReason).toBeNull();
    rerender();
    expect(result.current.runtimeUpdateError).toBe(runtimeError);
    worker = { ...worker };
    rerender();
    expect(result.current.runtimeUpdateError).toBeNull();
  },
);
