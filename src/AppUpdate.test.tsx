// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppUpdate, UPDATE_CHECK_INTERVAL_MS } from "./AppUpdate";
import type { UpdateSafety } from "./appUpdateTypes";

const tauriMocks = vi.hoisted(() => ({
  check: vi.fn(),
  relaunch: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-updater", () => ({
  check: tauriMocks.check,
}));

vi.mock("@tauri-apps/plugin-process", () => ({
  relaunch: tauriMocks.relaunch,
}));

const safe: UpdateSafety = {
  activeRunCount: 0,
  activeRunIds: [],
  backgroundWork: [],
  hasUnsavedSettings: false,
  settingsFingerprint: null,
  transientBusy: false,
};

function updateCandidate(overrides: Record<string, unknown> = {}) {
  return {
    version: "0.1.12",
    currentVersion: "0.1.11",
    body: null,
    date: null,
    rawJson: {},
    close: vi.fn().mockResolvedValue(undefined),
    download: vi.fn().mockImplementation(async (onEvent) => {
      onEvent?.({ event: "Started", data: { contentLength: 100 } });
      onEvent?.({ event: "Progress", data: { chunkLength: 40 } });
      onEvent?.({ event: "Finished" });
    }),
    install: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function renderUpdate({
  safety = safe,
  verifyInstallSafety = vi.fn().mockImplementation(async () => safety),
  prepareForInstall = vi.fn().mockResolvedValue(vi.fn().mockResolvedValue(undefined)),
  onInstallLockChange = vi.fn(),
  onActionError = vi.fn(),
  onActionErrorClear = vi.fn(),
}: {
  safety?: UpdateSafety;
  verifyInstallSafety?: ReturnType<typeof vi.fn>;
  prepareForInstall?: ReturnType<typeof vi.fn>;
  onInstallLockChange?: ReturnType<typeof vi.fn>;
  onActionError?: ReturnType<typeof vi.fn>;
  onActionErrorClear?: ReturnType<typeof vi.fn>;
} = {}) {
  const update = (manualCheckRequest: number) => (
    <AppUpdate
      enabled
      manualCheckRequest={manualCheckRequest}
      safety={safety}
      verifyInstallSafety={verifyInstallSafety}
      prepareForInstall={prepareForInstall}
      onInstallLockChange={onInstallLockChange}
      onActionError={onActionError}
      onActionErrorClear={onActionErrorClear}
    />
  );
  const rendered = render(update(0));
  let manualCheckRequest = 0;
  return {
    prepareForInstall,
    verifyInstallSafety,
    onInstallLockChange,
    onActionError,
    onActionErrorClear,
    requestManualCheck: () => rendered.rerender(update(++manualCheckRequest)),
    ...rendered,
  };
}

describe("AppUpdate", () => {
  beforeEach(() => {
    tauriMocks.check.mockReset();
    tauriMocks.relaunch.mockReset();
    tauriMocks.relaunch.mockResolvedValue(undefined);
  });

  afterEach(() => cleanup());

  it("stays hidden when the current version is latest", async () => {
    tauriMocks.check.mockResolvedValue(null);
    renderUpdate();

    await waitFor(() => expect(tauriMocks.check).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("button", { name: /Update Symphony/ })).toBeNull();
  });

  it("checks for updates every 15 minutes", async () => {
    vi.useFakeTimers();
    try {
      tauriMocks.check.mockResolvedValue(null);
      renderUpdate();

      expect(tauriMocks.check).toHaveBeenCalledTimes(1);
      expect(UPDATE_CHECK_INTERVAL_MS).toBe(15 * 60 * 1000);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS);
      });

      expect(tauriMocks.check).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("joins a manual request to the active check and reports when Symphony is current", async () => {
    const check = deferred<null>();
    tauriMocks.check.mockReturnValue(check.promise);
    const { requestManualCheck } = renderUpdate();

    act(requestManualCheck);
    expect(screen.getByRole("status").textContent).toContain("Checking for updates");
    expect(tauriMocks.check).toHaveBeenCalledTimes(1);

    check.resolve(null);
    expect(await screen.findByText("Symphony is up to date")).toBeTruthy();
    expect(tauriMocks.check).toHaveBeenCalledTimes(1);
  });

  it("shows a manual failure and clears it before a successful retry", async () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    tauriMocks.check
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error("release feed unavailable"));
    const { onActionError, onActionErrorClear, requestManualCheck } = renderUpdate();
    await waitFor(() => expect(tauriMocks.check).toHaveBeenCalledTimes(1));

    act(requestManualCheck);

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Update check failed: release feed unavailable",
    );
    expect(onActionError).toHaveBeenCalledWith("Update check failed: release feed unavailable");
    expect(onActionErrorClear).not.toHaveBeenCalled();

    tauriMocks.check.mockResolvedValueOnce(null);
    act(requestManualCheck);

    expect(await screen.findByText("Symphony is up to date")).toBeTruthy();
    expect(onActionErrorClear).toHaveBeenCalledOnce();
    expect(onActionErrorClear).toHaveBeenCalledWith(
      "Update check failed: release feed unavailable",
    );
    consoleWarn.mockRestore();
  });

  it("shows the update action when a manual check finds a release", async () => {
    const candidate = updateCandidate();
    tauriMocks.check.mockResolvedValueOnce(null).mockResolvedValueOnce(candidate);
    const { requestManualCheck } = renderUpdate();
    await waitFor(() => expect(tauriMocks.check).toHaveBeenCalledTimes(1));

    act(requestManualCheck);

    expect(await screen.findByRole("button", { name: "Update Symphony to v0.1.12" })).toBeTruthy();
    expect(tauriMocks.check).toHaveBeenCalledTimes(2);
  });

  it("downloads, installs, and relaunches a safe update", async () => {
    const candidate = updateCandidate();
    tauriMocks.check.mockResolvedValue(candidate);
    const { prepareForInstall, onInstallLockChange } = renderUpdate();

    fireEvent.click(await screen.findByRole("button", { name: "Update Symphony to v0.1.12" }));

    await waitFor(() => expect(candidate.download).toHaveBeenCalledTimes(1));
    expect(prepareForInstall).toHaveBeenCalledTimes(1);
    expect(onInstallLockChange).toHaveBeenCalledWith(true);
    expect(candidate.install).toHaveBeenCalledTimes(1);
    expect(tauriMocks.relaunch).toHaveBeenCalledTimes(1);
  });

  it("confirms interrupted work and unsaved settings before downloading", async () => {
    const candidate = updateCandidate();
    tauriMocks.check.mockResolvedValue(candidate);
    renderUpdate({
      safety: {
        activeRunCount: 2,
        activeRunIds: ["run-a", "run-b"],
        backgroundWork: ["the active Retro"],
        hasUnsavedSettings: true,
        settingsFingerprint: "dirty-settings",
        transientBusy: false,
      },
    });

    fireEvent.click(await screen.findByRole("button", { name: "Update Symphony to v0.1.12" }));

    expect(screen.getByRole("alertdialog")).toBeTruthy();
    expect(screen.getByText(/2 active runs will be interrupted/)).toBeTruthy();
    expect(screen.getByText(/unsaved Settings changes will be lost/)).toBeTruthy();
    expect(candidate.download).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(candidate.download).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Update Symphony to v0.1.12" }));
    fireEvent.click(screen.getByRole("button", { name: "Update & Restart" }));
    await waitFor(() => expect(candidate.download).toHaveBeenCalledTimes(1));
  });

  it("rechecks safety when work starts during the download", async () => {
    let finishDownload!: () => void;
    const candidate = updateCandidate({
      download: vi.fn().mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            finishDownload = resolve;
          }),
      ),
    });
    tauriMocks.check.mockResolvedValue(candidate);
    const prepareForInstall = vi.fn().mockResolvedValue(vi.fn());
    const verifyInstallSafety = vi.fn().mockResolvedValue(safe);
    const onActionError = vi.fn();
    const { rerender } = render(
      <AppUpdate
        enabled
        safety={safe}
        verifyInstallSafety={verifyInstallSafety}
        prepareForInstall={prepareForInstall}
        onActionError={onActionError}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Update Symphony to v0.1.12" }));
    await waitFor(() => expect(candidate.download).toHaveBeenCalledTimes(1));

    rerender(
      <AppUpdate
        enabled
        safety={{ ...safe, activeRunCount: 1 }}
        prepareForInstall={prepareForInstall}
        onActionError={onActionError}
      />,
    );
    finishDownload();

    expect(await screen.findByRole("alertdialog")).toBeTruthy();
    expect(candidate.install).not.toHaveBeenCalled();
  });

  it("uses fresh backend safety before installation", async () => {
    const candidate = updateCandidate();
    tauriMocks.check.mockResolvedValue(candidate);
    const verifyInstallSafety = vi.fn().mockResolvedValue({
      ...safe,
      activeRunCount: 1,
      activeRunIds: ["newly-reserved-run"],
    });
    renderUpdate({ verifyInstallSafety });

    fireEvent.click(await screen.findByRole("button", { name: "Update Symphony to v0.1.12" }));

    expect(await screen.findByRole("alertdialog")).toBeTruthy();
    expect(screen.getByText(/1 active run will be interrupted/)).toBeTruthy();
    expect(candidate.install).not.toHaveBeenCalled();
  });

  it("reconfirms when unsafe work changes after initial approval", async () => {
    let finishDownload!: () => void;
    const candidate = updateCandidate({
      download: vi.fn().mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            finishDownload = resolve;
          }),
      ),
    });
    tauriMocks.check.mockResolvedValue(candidate);
    const prepareForInstall = vi.fn().mockResolvedValue(vi.fn());
    const onActionError = vi.fn();
    const initialSafety = {
      ...safe,
      activeRunCount: 1,
      activeRunIds: ["run-a"],
      hasUnsavedSettings: true,
      settingsFingerprint: "settings-a",
    };
    const { rerender } = render(
      <AppUpdate
        enabled
        safety={initialSafety}
        prepareForInstall={prepareForInstall}
        onActionError={onActionError}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Update Symphony to v0.1.12" }));
    fireEvent.click(screen.getByRole("button", { name: "Update & Restart" }));
    await waitFor(() => expect(candidate.download).toHaveBeenCalledTimes(1));

    rerender(
      <AppUpdate
        enabled
        safety={{
          ...initialSafety,
          activeRunIds: ["run-b"],
          settingsFingerprint: "settings-b",
        }}
        prepareForInstall={prepareForInstall}
        onActionError={onActionError}
      />,
    );
    finishDownload();

    expect(await screen.findByRole("alertdialog")).toBeTruthy();
    expect(candidate.install).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Update & Restart" }));
    await waitFor(() => expect(candidate.install).toHaveBeenCalledTimes(1));
  });

  it("leaves a downloaded update ready while another action is busy", async () => {
    let finishDownload!: () => void;
    const candidate = updateCandidate({
      download: vi.fn().mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            finishDownload = resolve;
          }),
      ),
    });
    tauriMocks.check.mockResolvedValue(candidate);
    const prepareForInstall = vi.fn().mockResolvedValue(vi.fn());
    const verifyInstallSafety = vi.fn().mockResolvedValue(safe);
    const onActionError = vi.fn();
    const { rerender } = render(
      <AppUpdate
        enabled
        safety={safe}
        verifyInstallSafety={verifyInstallSafety}
        prepareForInstall={prepareForInstall}
        onActionError={onActionError}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Update Symphony to v0.1.12" }));
    await waitFor(() => expect(candidate.download).toHaveBeenCalledTimes(1));
    rerender(
      <AppUpdate
        enabled
        safety={{ ...safe, transientBusy: true }}
        verifyInstallSafety={verifyInstallSafety}
        prepareForInstall={prepareForInstall}
        onActionError={onActionError}
      />,
    );
    finishDownload();

    const busyButton = await screen.findByRole("button", {
      name: "Finish the current action before updating Symphony",
    });
    expect((busyButton as HTMLButtonElement).disabled).toBe(true);
    expect(candidate.install).not.toHaveBeenCalled();

    rerender(
      <AppUpdate
        enabled
        safety={safe}
        verifyInstallSafety={verifyInstallSafety}
        prepareForInstall={prepareForInstall}
        onActionError={onActionError}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Update Symphony to v0.1.12" }));
    await waitFor(() => expect(verifyInstallSafety).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(candidate.install).toHaveBeenCalledTimes(1));
  });

  it("restores the worker and keeps a downloaded update ready after install failure", async () => {
    const candidate = updateCandidate({
      install: vi.fn().mockRejectedValue(new Error("signature mismatch")),
    });
    tauriMocks.check.mockResolvedValue(candidate);
    const restoreWorker = vi.fn().mockResolvedValue(undefined);
    const prepareForInstall = vi.fn().mockResolvedValue(restoreWorker);
    const onActionError = vi.fn();
    const { onInstallLockChange } = renderUpdate({
      prepareForInstall,
      onActionError,
    });

    fireEvent.click(await screen.findByRole("button", { name: "Update Symphony to v0.1.12" }));

    await waitFor(() =>
      expect(onActionError).toHaveBeenCalledWith("Update installation failed: signature mismatch"),
    );
    expect(restoreWorker).toHaveBeenCalledTimes(1);
    expect(onInstallLockChange).toHaveBeenLastCalledWith(false);
    expect(tauriMocks.relaunch).not.toHaveBeenCalled();
  });

  it("offers a restart-only retry when relaunch fails after installation", async () => {
    const candidate = updateCandidate();
    tauriMocks.check.mockResolvedValue(candidate);
    tauriMocks.relaunch.mockRejectedValueOnce(new Error("restart denied"));
    const onActionError = vi.fn();
    const { rerender, prepareForInstall } = renderUpdate({ onActionError });

    fireEvent.click(await screen.findByRole("button", { name: "Update Symphony to v0.1.12" }));

    const restart = await screen.findByRole("button", {
      name: "Restart to finish updating Symphony to v0.1.12",
    });
    expect(onActionError).toHaveBeenCalledWith(
      "The update was installed, but Symphony could not restart: restart denied",
    );

    rerender(
      <AppUpdate
        enabled
        safety={{ ...safe, activeRunCount: 1 }}
        prepareForInstall={prepareForInstall}
        onActionError={onActionError}
      />,
    );
    fireEvent.click(restart);
    expect(await screen.findByRole("alertdialog")).toBeTruthy();
    expect(tauriMocks.relaunch).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Restart Symphony" }));
    await waitFor(() => expect(tauriMocks.relaunch).toHaveBeenCalledTimes(2));
    expect(candidate.install).toHaveBeenCalledTimes(1);
  });
});
