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
  | { status: "unavailable"; result: null; stale: false };

type TimerHandle = ReturnType<typeof setTimeout>;
type Validate = (settings: AppSettings) => Promise<ValidationResult>;
type StateListener = (state: SettingsValidationState) => void;

export const SETTINGS_VALIDATION_DEBOUNCE_MS = 350;

export class SettingsValidationController {
  private timer: TimerHandle | null = null;
  private active: SettingsRevision | null = null;
  private queued: SettingsRevision | null = null;
  private latestRevision = 0;
  private disposed = false;
  private state: SettingsValidationState;
  private waiters = new Map<
    number,
    Array<(result: ValidationResult | null) => void>
  >();

  constructor(
    private readonly runtimeAvailable: boolean,
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

  validateNow(revision: SettingsRevision): Promise<ValidationResult | null> {
    if (this.disposed) return Promise.resolve(null);
    this.latestRevision = Math.max(this.latestRevision, revision.id);
    if (!this.runtimeAvailable) {
      this.publish({ status: "unavailable", result: null, stale: false });
      return Promise.resolve(null);
    }
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const promise = new Promise<ValidationResult | null>((resolve) => {
      const current = this.waiters.get(revision.id) ?? [];
      current.push(resolve);
      this.waiters.set(revision.id, current);
    });
    if (this.active?.id !== revision.id) this.enqueueOrRun(revision);
    return promise;
  }

  dispose() {
    this.disposed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    if (this.queued && !this.waiters.has(this.queued.id)) {
      this.queued = null;
    }
  }

  private enqueueOrRun(revision: SettingsRevision) {
    if (this.active) {
      this.queued = revision;
      return;
    }
    void this.run(revision);
  }

  private async run(revision: SettingsRevision) {
    this.active = revision;
    this.publish({
      status: "pending",
      result: this.state.result,
      stale: true,
    });
    let result: ValidationResult | null = null;
    try {
      result = await this.validate(revision.settings);
      if (revision.id === this.latestRevision) {
        this.publish({
          status: result.workflow_ok ? "valid" : "invalid",
          result,
          stale: false,
        });
      }
    } catch {
      if (revision.id === this.latestRevision) {
        this.publish({ status: "unavailable", result: null, stale: false });
      }
    } finally {
      this.active = null;
      const resolvers = this.waiters.get(revision.id) ?? [];
      this.waiters.delete(revision.id);
      for (const resolve of resolvers) resolve(result);
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
