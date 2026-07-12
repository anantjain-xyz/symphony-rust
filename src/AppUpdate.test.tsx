// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppUpdate } from "./AppUpdate";
import type { UpdateSafety } from "./AppUpdate";

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
  backgroundWork: [],
  hasUnsavedSettings: false,
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

function renderUpdate({
  safety = safe,
  prepareForInstall = vi.fn().mockResolvedValue(vi.fn().mockResolvedValue(undefined)),
  onActionError = vi.fn(),
}: {
  safety?: UpdateSafety;
  prepareForInstall?: ReturnType<typeof vi.fn>;
  onActionError?: ReturnType<typeof vi.fn>;
} = {}) {
  return {
    prepareForInstall,
    onActionError,
    ...render(
      <AppUpdate
        enabled
        safety={safety}
        prepareForInstall={prepareForInstall}
        onActionError={onActionError}
      />,
    ),
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

  it("downloads, installs, and relaunches a safe update", async () => {
    const candidate = updateCandidate();
    tauriMocks.check.mockResolvedValue(candidate);
    const { prepareForInstall } = renderUpdate();

    fireEvent.click(
      await screen.findByRole("button", { name: "Update Symphony to v0.1.12" }),
    );

    await waitFor(() => expect(candidate.download).toHaveBeenCalledTimes(1));
    expect(prepareForInstall).toHaveBeenCalledTimes(1);
    expect(candidate.install).toHaveBeenCalledTimes(1);
    expect(tauriMocks.relaunch).toHaveBeenCalledTimes(1);
  });

  it("confirms interrupted work and unsaved settings before downloading", async () => {
    const candidate = updateCandidate();
    tauriMocks.check.mockResolvedValue(candidate);
    renderUpdate({
      safety: {
        activeRunCount: 2,
        backgroundWork: ["the active Retro"],
        hasUnsavedSettings: true,
        transientBusy: false,
      },
    });

    fireEvent.click(
      await screen.findByRole("button", { name: "Update Symphony to v0.1.12" }),
    );

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
    const onActionError = vi.fn();
    const { rerender } = render(
      <AppUpdate
        enabled
        safety={safe}
        prepareForInstall={prepareForInstall}
        onActionError={onActionError}
      />,
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "Update Symphony to v0.1.12" }),
    );
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

  it("restores the worker and keeps a downloaded update ready after install failure", async () => {
    const candidate = updateCandidate({
      install: vi.fn().mockRejectedValue(new Error("signature mismatch")),
    });
    tauriMocks.check.mockResolvedValue(candidate);
    const restoreWorker = vi.fn().mockResolvedValue(undefined);
    const prepareForInstall = vi.fn().mockResolvedValue(restoreWorker);
    const onActionError = vi.fn();
    renderUpdate({ prepareForInstall, onActionError });

    fireEvent.click(
      await screen.findByRole("button", { name: "Update Symphony to v0.1.12" }),
    );

    await waitFor(() => expect(onActionError).toHaveBeenCalledWith(
      "Update installation failed: signature mismatch",
    ));
    expect(restoreWorker).toHaveBeenCalledTimes(1);
    expect(tauriMocks.relaunch).not.toHaveBeenCalled();
  });

  it("offers a restart-only retry when relaunch fails after installation", async () => {
    const candidate = updateCandidate();
    tauriMocks.check.mockResolvedValue(candidate);
    tauriMocks.relaunch.mockRejectedValueOnce(new Error("restart denied"));
    const onActionError = vi.fn();
    renderUpdate({ onActionError });

    fireEvent.click(
      await screen.findByRole("button", { name: "Update Symphony to v0.1.12" }),
    );

    const restart = await screen.findByRole("button", {
      name: "Restart to finish updating Symphony to v0.1.12",
    });
    expect(onActionError).toHaveBeenCalledWith(
      "The update was installed, but Symphony could not restart: restart denied",
    );

    fireEvent.click(restart);
    await waitFor(() => expect(tauriMocks.relaunch).toHaveBeenCalledTimes(2));
    expect(candidate.install).toHaveBeenCalledTimes(1);
  });
});
