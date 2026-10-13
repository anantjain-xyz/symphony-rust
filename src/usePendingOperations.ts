import { useCallback, useState } from "react";

/** Each caller releases only its own operation, regardless of settlement order. */
export function usePendingOperations() {
  const [operations, setOperations] = useState<ReadonlySet<symbol>>(() => new Set());
  const beginOperation = useCallback(() => {
    const operation = Symbol("pending operation");
    setOperations((current) => new Set(current).add(operation));
    let released = false;
    return () => {
      if (released) return;
      released = true;
      setOperations((current) => {
        const next = new Set(current);
        next.delete(operation);
        return next;
      });
    };
  }, []);
  return { pending: operations.size > 0, beginOperation };
}
