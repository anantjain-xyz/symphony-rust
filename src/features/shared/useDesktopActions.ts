import { useState } from "react";
import { usePendingOperations } from "../../usePendingOperations";
import { formatError } from "./errors";
export type RunDesktopAction = <T>(action: () => Promise<T>) => Promise<T>;
export function useDesktopActions(runtimeAvailable: boolean) {
  const [error, setError] = useState<string | null>(null);
  const { pending, beginOperation } = usePendingOperations();
  const [installLocked, setInstallLocked] = useState(false);
  async function call<T>(fn: () => Promise<T>) {
    if (!runtimeAvailable) {
      setError("Connect through the Symphony desktop app to run this action.");
      return undefined as T;
    }
    const finishOperation = beginOperation();
    setError(null);
    try {
      return await fn();
    } catch (err) {
      setError(formatError(err));
      throw err;
    } finally {
      finishOperation();
    }
  }

  return {
    run: call,
    busy: pending || installLocked,
    error,
    reportError: setError,
    setInstallLocked,
  };
}
