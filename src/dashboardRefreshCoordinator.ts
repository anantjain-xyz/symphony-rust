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

type DashboardRefreshRequestOptions = {
  reportFailure?: boolean;
  rejectOnFailure?: boolean;
};

export type DashboardRefreshCoordinator<Key extends string> = {
  activate: () => void;
  dispose: () => void;
  request: (keys: Iterable<Key>, options?: DashboardRefreshRequestOptions) => Promise<void>;
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
  const settledGenerations = new Map<Key, number>();
  const queuedKeys = new Set<Key>();
  let requestWaiters: Array<{
    generations: Map<Key, number>;
    reportFailure: boolean;
    rejectOnFailure: boolean;
    resolve: () => void;
    reject: (error: unknown) => void;
  }> = [];
  const now = instrumentation?.now ?? (() => performance.now());
  const log = (event: string, details: Record<string, unknown>) => {
    if (!instrumentation?.enabled) return;
    (instrumentation.log ?? console.debug)(`[dashboard-refresh] ${event}`, details);
  };

  const resolveAllWaiters = () => {
    const waiters = requestWaiters;
    requestWaiters = [];
    waiters.forEach(({ resolve }) => {
      resolve();
    });
  };

  const settleWaiters = (
    keys: readonly Key[],
    generation: number,
    didFail: boolean,
    failure: unknown,
  ) => {
    keys.forEach((key) => {
      settledGenerations.set(key, Math.max(settledGenerations.get(key) ?? 0, generation));
    });

    const completed = requestWaiters.filter((waiter) =>
      [...waiter.generations].every(
        ([key, requestedGeneration]) => (settledGenerations.get(key) ?? 0) >= requestedGeneration,
      ),
    );
    requestWaiters = requestWaiters.filter((waiter) => !completed.includes(waiter));

    if (didFail) {
      const reportableKeys = new Set<Key>();
      completed.forEach((waiter) => {
        if (!waiter.reportFailure) return;
        keys.forEach((key) => {
          if (waiter.generations.has(key)) reportableKeys.add(key);
        });
      });
      if (reportableKeys.size > 0) {
        try {
          onFailure?.(failure, [...reportableKeys]);
        } catch {
          log("failure-observer-error", {
            activeGeneration: generation,
            queuedKeys: [...queuedKeys],
            failure: true,
            observerError: true,
          });
        }
      }
    }

    completed.forEach(({ reject, rejectOnFailure, resolve }) => {
      if (didFail && rejectOnFailure) {
        reject(failure);
      } else {
        resolve();
      }
    });
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

    let failure: unknown;
    let didFail = false;
    void execution
      .catch((error: unknown) => {
        failure = error;
        didFail = true;
        log("failure", {
          activeGeneration: generation,
          queuedKeys: [...queuedKeys],
          durationMs: now() - startedAt,
          failure: true,
        });
      })
      .finally(() => {
        log("settle", {
          activeGeneration: generation,
          queuedKeys: [...queuedKeys],
          durationMs: now() - startedAt,
        });
        active = false;
        activeGeneration = null;
        settleWaiters(keys, generation, didFail, failure);
        if (disposed) {
          queuedKeys.clear();
          resolveAllWaiters();
          return;
        }
        if (queuedKeys.size > 0) {
          const nextKeys = [...queuedKeys];
          queuedKeys.clear();
          const nextBatchGeneration = ++nextGeneration;
          nextKeys.forEach((key) => {
            authoritativeGenerations.set(key, nextBatchGeneration);
          });
          start(nextKeys, nextBatchGeneration);
          return;
        }
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
      settledGenerations.clear();
      resolveAllWaiters();
      log("dispose", { activeGeneration, queuedKeys: [] });
    },
    request(keys, options) {
      const requestedKeys = [...new Set(keys)];
      if (disposed || requestedKeys.length === 0) return Promise.resolve();

      const requestedGeneration = ++nextGeneration;
      const settled = new Promise<void>((resolve, reject) =>
        requestWaiters.push({
          generations: new Map(
            requestedKeys.map((key): [Key, number] => [key, requestedGeneration]),
          ),
          reportFailure: options?.reportFailure ?? true,
          rejectOnFailure: options?.rejectOnFailure ?? false,
          resolve,
          reject,
        }),
      );

      if (active) {
        requestedKeys.forEach((key) => {
          queuedKeys.add(key);
        });
        log("queue", {
          activeGeneration,
          queuedKeys: [...queuedKeys],
        });
      } else {
        requestedKeys.forEach((key) => {
          authoritativeGenerations.set(key, requestedGeneration);
        });
        start(requestedKeys, requestedGeneration);
      }
      return settled;
    },
  };
}
