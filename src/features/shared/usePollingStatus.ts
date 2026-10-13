import { useCallback, useState } from "react";
import type { PollResourceState } from "../../pollController";
export function usePollingStatus<Key extends string>() {
  const [pollingStates, setPollingStates] = useState<Partial<Record<Key, PollResourceState>>>({});
  const updatePollingState = useCallback((key: Key, status: PollResourceState) => {
    setPollingStates((current) => ({ ...current, [key]: status }));
  }, []);
  const clearPollingState = useCallback((key: Key) => {
    setPollingStates((current) => {
      if (!(key in current)) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
  }, []);
  return { pollingStates, updatePollingState, clearPollingState };
}
