/**
 * Track the previous value of a prop or state.
 */

import { useRef, useEffect } from "react";

/**
 * Returns the value from the previous render.
 *
 * @example
 * const prevCount = usePrevious(count);
 */
export function usePrevious<T>(value: T): T | undefined {
  const ref = useRef<T | undefined>(undefined);

  useEffect(() => {
    ref.current = value;
  });

  return ref.current;
}
