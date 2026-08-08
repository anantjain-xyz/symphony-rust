import type { AppSettings, ValidationResult } from "./bindings";

export type SettingsRevision = {
  id: number;
  settings: AppSettings;
};

export type SettingsValidationState =
  | { status: "idle"; result: null; stale: false }
  | { status: "pending"; result: ValidationResult | null; stale: true }
  | { status: "valid"; result: ValidationResult; stale: false }
  | { status: "invalid"; result: ValidationResult; stale: false }
  | { status: "unavailable"; result: null; stale: false; reason?: string };

/** Outcome of an authoritative validateNow (Save) call. */
export type SettingsValidateNowOutcome =
  | { status: "ok"; result: ValidationResult }
  | {
      status: "unavailable";
      reason: string;
      cause: "disposed" | "preview" | "error" | "superseded";
    };

export type SettingsValidateFailureCause = Extract<
  SettingsValidateNowOutcome,
  { status: "unavailable" }
>["cause"];

type TimerHandle = ReturnType<typeof setTimeout>;
type Validate = (settings: AppSettings) => Promise<ValidationResult>;
type StateListener = (state: SettingsValidationState) => void;
type WaiterResult =
  | { kind: "result"; result: ValidationResult }
  | { kind: "unavailable"; reason: string; cause: SettingsValidateFailureCause };

export const SETTINGS_VALIDATION_DEBOUNCE_MS = 350;

function formatValidateError(err: unknown): string {
  if (err instanceof Error) return err.message.trim() || err.name;
  if (typeof err === "string") return err.trim();
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

export class SettingsValidationController {
  private timer: TimerHandle | null = null;
  private active: SettingsRevision | null = null;
  private queued: SettingsRevision | null = null;
  private latestRevision = 0;
  private disposed = false;
  private state: SettingsValidationState;
  private waiters = new Map<number, Array<(result: WaiterResult) => void>>();

  constructor(
    readonly runtimeAvailable: boolean,
    private readonly validate: Validate,
    private readonly onState: StateListener,
  ) {
    this.state = runtimeAvailable
      ? { status: "idle", result: null, stale: false }
      : { status: "unavailable", result: null, stale: false };
  }

  schedule(revision: SettingsRevision) {
    if (this.disposed) return;
    this.latestRevision = Math.max(this.latestRevision, revision.id);
    if (!this.runtimeAvailable) {
      this.publish({ status: "unavailable", result: null, stale: false });
      return;
    }
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.enqueueOrRun(revision);
    }, SETTINGS_VALIDATION_DEBOUNCE_MS);
  }

  validateNow(revision: SettingsRevision): Promise<SettingsValidateNowOutcome> {
    if (this.disposed) {
      return Promise.resolve({
        status: "unavailable",
        cause: "disposed",
        reason:
          "Settings validation was interrupted because the Settings view remounted. Try saving again.",
      });
    }
    this.latestRevision = Math.max(this.latestRevision, revision.id);
    if (!this.runtimeAvailable) {
      this.publish({ status: "unavailable", result: null, stale: false });
      return Promise.resolve({
        status: "unavailable",
        cause: "preview",
        reason: "Desktop validation is not available in browser preview.",
      });
    }
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const promise = new Promise<SettingsValidateNowOutcome>((resolve) => {
      const current = this.waiters.get(revision.id) ?? [];
      current.push((waiter) => {
        if (waiter.kind === "result") {
          resolve({ status: "ok", result: waiter.result });
          return;
        }
        resolve({
          status: "unavailable",
          cause: waiter.cause,
          reason: waiter.reason,
        });
      });
      this.waiters.set(revision.id, current);
    });
    if (this.active?.id !== revision.id) this.enqueueOrRun(revision);
    return promise;
  }

  /** Cancel a pending debounce without poisoning validateNow (Strict Mode safe). */
  clearScheduled() {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  dispose() {
    this.disposed = true;
    this.clearScheduled();
    if (this.queued && !this.waiters.has(this.queued.id)) {
      this.queued = null;
    }
  }

  /** True after dispose(); Save should not call validateNow on this instance. */
  get isDisposed() {
    return this.disposed;
  }

  private enqueueOrRun(revision: SettingsRevision) {
    if (this.active) {
      if (this.queued && this.queued.id !== revision.id) {
        this.resolveWaiters(this.queued.id, {
          kind: "unavailable",
          cause: "superseded",
          reason: "Settings changed again while validation was queued, so this Save was skipped.",
        });
      }
      this.queued = revision;
      return;
    }
    void this.run(revision);
  }

  private resolveWaiters(revisionId: number, result: WaiterResult) {
    const resolvers = this.waiters.get(revisionId) ?? [];
    this.waiters.delete(revisionId);
    for (const resolve of resolvers) resolve(result);
  }

  private async run(revision: SettingsRevision) {
    this.active = revision;
    this.publish({
      status: "pending",
      result: this.state.result,
      stale: true,
    });
    let waiter: WaiterResult | null = null;
    try {
      const result = await this.validate(revision.settings);
      waiter = { kind: "result", result };
      if (revision.id === this.latestRevision) {
        this.publish({
          status: result.workflow_ok ? "valid" : "invalid",
          result,
          stale: false,
        });
      }
    } catch (err) {
      const reason = formatValidateError(err) || "validate_settings failed.";
      waiter = { kind: "unavailable", cause: "error", reason };
      if (revision.id === this.latestRevision) {
        this.publish({
          status: "unavailable",
          result: null,
          stale: false,
          reason,
        });
      }
    } finally {
      this.active = null;
      if (waiter) this.resolveWaiters(revision.id, waiter);
      const queued = this.queued;
      this.queued = null;
      if (queued && (!this.disposed || this.waiters.has(queued.id))) {
        void this.run(queued);
      }
    }
  }

  private publish(state: SettingsValidationState) {
    if (this.disposed) return;
    this.state = state;
    this.onState(state);
  }
}
