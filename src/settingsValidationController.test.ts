import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppSettings, ValidationResult } from "./bindings";
import {
  SETTINGS_VALIDATION_DEBOUNCE_MS,
  SettingsValidationController,
} from "./settingsValidationController";

const settings = (prompt_template: string) =>
  ({ prompt_template } as AppSettings);
const valid = (workflow_error: string | null = null): ValidationResult =>
  ({ workflow_blocking: workflow_error !== null, workflow_error } as ValidationResult);
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => (resolve = next));
  return { promise, resolve };
};

afterEach(() => vi.useRealTimers());

describe("SettingsValidationController", () => {
  it("debounces ten edits into one complete-draft validation", async () => {
    vi.useFakeTimers();
    const validate = vi.fn().mockResolvedValue(valid());
    const controller = new SettingsValidationController(true, validate, vi.fn());
    for (let id = 1; id <= 10; id += 1) {
      controller.schedule({ id, settings: settings(String(id)) });
      await vi.advanceTimersByTimeAsync(30);
    }
    await vi.advanceTimersByTimeAsync(SETTINGS_VALIDATION_DEBOUNCE_MS - 31);
    expect(validate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(validate).toHaveBeenCalledTimes(1);
    expect(validate).toHaveBeenCalledWith(settings("10"));
  });

  it("allows one active request and collapses queued edits to the latest revision", async () => {
    vi.useFakeTimers();
    const first = deferred<ValidationResult>();
    const validate = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(valid());
    const controller = new SettingsValidationController(true, validate, vi.fn());
    controller.schedule({ id: 1, settings: settings("one") });
    await vi.advanceTimersByTimeAsync(350);
    controller.schedule({ id: 2, settings: settings("two") });
    controller.schedule({ id: 3, settings: settings("three") });
    await vi.advanceTimersByTimeAsync(350);
    expect(validate).toHaveBeenCalledTimes(1);
    first.resolve(valid());
    await Promise.resolve();
    await Promise.resolve();
    expect(validate).toHaveBeenCalledTimes(2);
    expect(validate).toHaveBeenLastCalledWith(settings("three"));
  });

  it("resolves an authoritative waiter when its queued revision is superseded", async () => {
    vi.useFakeTimers();
    const first = deferred<ValidationResult>();
    const validate = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(valid());
    const controller = new SettingsValidationController(true, validate, vi.fn());
    controller.schedule({ id: 1, settings: settings("active") });
    await vi.advanceTimersByTimeAsync(SETTINGS_VALIDATION_DEBOUNCE_MS);

    const saveResult = controller.validateNow({ id: 2, settings: settings("save") });
    controller.schedule({ id: 3, settings: settings("newer edit") });
    await vi.advanceTimersByTimeAsync(SETTINGS_VALIDATION_DEBOUNCE_MS);

    await expect(saveResult).resolves.toBeNull();
    first.resolve(valid());
    await Promise.resolve();
    await Promise.resolve();
    expect(validate).toHaveBeenCalledTimes(2);
    expect(validate).toHaveBeenLastCalledWith(settings("newer edit"));
  });

  it("never publishes an older result for a newer draft", async () => {
    vi.useFakeTimers();
    const first = deferred<ValidationResult>();
    const states: string[] = [];
    const validate = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(valid());
    const controller = new SettingsValidationController(true, validate, (state) =>
      states.push(state.status),
    );
    controller.schedule({ id: 1, settings: settings("one") });
    await vi.advanceTimersByTimeAsync(350);
    controller.schedule({ id: 2, settings: settings("two") });
    first.resolve(valid("old error"));
    await Promise.resolve();
    expect(states).not.toContain("invalid");
  });

  it("bypasses debounce for Save and waits for its exact revision", async () => {
    vi.useFakeTimers();
    const validate = vi.fn().mockResolvedValue(valid());
    const controller = new SettingsValidationController(true, validate, vi.fn());
    const revision = { id: 4, settings: settings("save me") };
    controller.schedule(revision);
    const result = await controller.validateNow(revision);
    expect(result).toEqual(valid());
    expect(validate).toHaveBeenCalledTimes(1);
    await vi.runAllTimersAsync();
    expect(validate).toHaveBeenCalledTimes(1);
  });

  it("lets an authoritative validation settle after its feature unmounts", async () => {
    const validation = deferred<ValidationResult>();
    const controller = new SettingsValidationController(
      true,
      vi.fn().mockReturnValue(validation.promise),
      vi.fn(),
    );
    const result = controller.validateNow({ id: 1, settings: settings("save me") });

    controller.dispose();
    validation.resolve(valid());

    await expect(result).resolves.toEqual(valid());
  });

  it("never invokes validation when the runtime is unavailable", async () => {
    const validate = vi.fn();
    const states: string[] = [];
    const controller = new SettingsValidationController(false, validate, (state) =>
      states.push(state.status),
    );
    controller.schedule({ id: 1, settings: settings("preview") });
    expect(await controller.validateNow({ id: 1, settings: settings("preview") })).toBeNull();
    expect(validate).not.toHaveBeenCalled();
    expect(states).toEqual(["unavailable", "unavailable"]);
  });

  it("renders non-blocking incomplete validation as invalid rather than valid", async () => {
    const states: string[] = [];
    const incomplete = {
      ...valid(),
      workflow_ok: false,
      workflow_blocking: false,
      workflow_error: "Add a repository",
    };
    const controller = new SettingsValidationController(
      true,
      vi.fn().mockResolvedValue(incomplete),
      (state) => states.push(state.status),
    );
    await controller.validateNow({ id: 1, settings: settings("draft") });
    expect(states).toEqual(["pending", "invalid"]);
  });
});
