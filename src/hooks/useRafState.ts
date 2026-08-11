/**
 * State setter that batches updates via requestAnimationFrame.
 * Throttles high-frequency state changes (typing indicators, stream progress)
 * to animation frames, preventing layout thrashing.
 *
 * @example
 * const [scrollPos, setScrollPos] = useRafState(0);
 * // In a scroll handler — only updates at 60fps
 * onScroll={(e) => setScrollPos(e.target.scrollTop)}
 */

import { useCallback, useRef, useState } from "react";

export function useRafState<T>(
  initialState: T | (() => T),
): [T, (state: T | ((prevState: T) => T)) => void] {
  const [state, setState] = useState(initialState);
  const rafId = useRef(0);
  const latestState = useRef(state);

  const setRafState = useCallback(
    (value: T | ((prevState: T) => T)) => {
      const nextState =
        value instanceof Function ? value(latestState.current) : value;
      latestState.current = nextState;
      cancelAnimationFrame(rafId.current);
      rafId.current = requestAnimationFrame(() => {
        setState(nextState);
      });
    },
    [],
  );

  return [state, setRafState];
}
