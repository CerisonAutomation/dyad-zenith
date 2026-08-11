/**
 * Debounced callback hook with cancel/flush/isPending controls.
 * Unlike useDebounce (which debounces a VALUE), this debounces a FUNCTION CALL.
 *
 * @example
 * const debouncedSearch = useDebounceCallback(search, 300);
 * debouncedSearch("query");  // debounced
 * debouncedSearch.cancel();  // cancel pending
 * debouncedSearch.flush();   // execute immediately
 */

import { useEffect, useMemo, useRef } from "react";

type DebounceOptions = {
  leading?: boolean;
  trailing?: boolean;
  maxWait?: number;
};

type ControlFunctions = {
  cancel: () => void;
  flush: () => void;
  isPending: () => boolean;
};

export type DebouncedState<T extends (...args: any[]) => any> = ((
  ...args: Parameters<T>
) => ReturnType<T> | undefined) &
  ControlFunctions;

export function useDebounceCallback<T extends (...args: any[]) => any>(
  func: T,
  delay = 500,
  options?: DebounceOptions,
): DebouncedState<T> {
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const lastArgsRef = useRef<Parameters<T> | null>(null);
  const funcRef = useRef(func);
  funcRef.current = func;

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const debounced = useMemo(() => {
    const debouncedFn = (...args: Parameters<T>) => {
      lastArgsRef.current = args;
      if (timerRef.current) clearTimeout(timerRef.current);

      timerRef.current = setTimeout(() => {
        timerRef.current = undefined;
        if (options?.trailing !== false && lastArgsRef.current) {
          funcRef.current(...lastArgsRef.current);
        }
      }, delay);
    };

    const controlFns: ControlFunctions = {
      cancel: () => {
        if (timerRef.current) {
          clearTimeout(timerRef.current);
          timerRef.current = undefined;
        }
      },
      flush: () => {
        if (timerRef.current && lastArgsRef.current) {
          clearTimeout(timerRef.current);
          timerRef.current = undefined;
          funcRef.current(...lastArgsRef.current);
        }
      },
      isPending: () => timerRef.current !== undefined,
    };

    return Object.assign(debouncedFn, controlFns) as DebouncedState<T>;
  }, [delay, options?.trailing]);

  return debounced;
}
