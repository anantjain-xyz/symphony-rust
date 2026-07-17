export type DashboardRefreshContext<Key extends string> = {
  generation: number;
  keys: readonly Key[];
  isAuthoritative: (key: Key) => boolean;
};

type DashboardRefreshInstrumentation = {
  enabled: boolean;
  log?: (event: string, details: Record<string, unknown>) => void;
  now?: () => number;
};

type DashboardRefreshCoordinatorOptions<Key extends string> = {
  execute: (context: DashboardRefreshContext<Key>) => Promise<void>;
  onFailure?: (error: unknown, keys: readonly Key[]) => void;
  instrumentation?: DashboardRefreshInstrumentation;
};

export type DashboardRefreshCoordinator<Key extends string> = {
  activate: () => void;
  dispose: () => void;
  request: (keys: Iterable<Key>) => Promise<void>;
};

export function createDashboardRefreshCoordinator<Key extends string>({
  execute,
  onFailure,
  instrumentation,
}: DashboardRefreshCoordinatorOptions<Key>): DashboardRefreshCoordinator<Key> {
  let active = false;
  let activeGeneration: number | null = null;
  let disposed = false;
  let nextGeneration = 0;
  const authoritativeGenerations = new Map<Key, number>();
  const queuedKeys = new Set<Key>();
  let drainWaiters: Array<() => void> = [];
  const now = instrumentation?.now ?? (() => performance.now());
  const log = (event: string, details: Record<string, unknown>) => {
    if (!instrumentation?.enabled) return;
    (instrumentation.log ?? console.debug)(`[dashboard-refresh] ${event}`, details);
  };

  const resolveDrainWaiters = () => {
    const waiters = drainWaiters;
    drainWaiters = [];
    waiters.forEach((resolve) => resolve());
  };

  const start = (keys: Key[], generation: number) => {
    active = true;
    activeGeneration = generation;
    const startedAt = now();
    log("start", {
      activeGeneration: generation,
      queuedKeys: [...queuedKeys],
    });

    const isAuthoritative = (key: Key) =>
      !disposed && authoritativeGenerations.get(key) === generation;

    let execution: Promise<void>;
    try {
      execution = execute({ generation, keys, isAuthoritative });
    } catch (error) {
      execution = Promise.reject(error);
    }

    void execution
      .catch((error: unknown) => {
        const failedKeys = keys.filter(isAuthoritative);
        log("failure", {
          activeGeneration: generation,
          queuedKeys: [...queuedKeys],
          durationMs: now() - startedAt,
          failure: true,
        });
        if (failedKeys.length > 0) onFailure?.(error, failedKeys);
      })
      .finally(() => {
        log("settle", {
          activeGeneration: generation,
          queuedKeys: [...queuedKeys],
          durationMs: now() - startedAt,
        });
        active = false;
        activeGeneration = null;
        if (disposed) {
          queuedKeys.clear();
          resolveDrainWaiters();
          return;
        }
        if (queuedKeys.size > 0) {
          const nextKeys = [...queuedKeys];
          queuedKeys.clear();
          const nextBatchGeneration = ++nextGeneration;
          nextKeys.forEach((key) =>
            authoritativeGenerations.set(key, nextBatchGeneration),
          );
          start(nextKeys, nextBatchGeneration);
          return;
        }
        resolveDrainWaiters();
      });
  };

  return {
    activate() {
      disposed = false;
    },
    dispose() {
      disposed = true;
      queuedKeys.clear();
      authoritativeGenerations.clear();
      if (!active) resolveDrainWaiters();
      log("dispose", { activeGeneration, queuedKeys: [] });
    },
    request(keys) {
      const requestedKeys = [...new Set(keys)];
      if (disposed || requestedKeys.length === 0) return Promise.resolve();

      const requestedGeneration = ++nextGeneration;
      requestedKeys.forEach((key) =>
        authoritativeGenerations.set(key, requestedGeneration),
      );
      const drained = new Promise<void>((resolve) => drainWaiters.push(resolve));

      if (active) {
        requestedKeys.forEach((key) => queuedKeys.add(key));
        log("queue", {
          activeGeneration,
          queuedKeys: [...queuedKeys],
        });
      } else {
        start(requestedKeys, requestedGeneration);
      }
      return drained;
    },
  };
}
