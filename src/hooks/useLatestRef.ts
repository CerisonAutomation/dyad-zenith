/**
 * Keep a ref updated with the latest value.
 * Replaces manual `ref.current = value` patterns.
 */

import { useRef, useEffect } from "react";

/**
 * Returns a ref that always holds the latest value of the argument.
 * Useful inside callbacks/effects that need the latest value without re-subscribing.
 *
 * @example
 * const refreshRef = useLatestRef(refreshSettings);
 * // In a callback:
 * refreshRef.current();
 */
export function useLatestRef<T>(value: T): React.MutableRefObject<T> {
  const ref = useRef<T>(value);

  useEffect(() => {
    ref.current = value;
  });

  return ref;
}
