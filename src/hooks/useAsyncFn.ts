/**
 * Async function wrapper with loading/error state and stale-result discarding.
 * Prevents race conditions when callers invoke async functions rapidly.
 *
 * @example
 * const [state, fetchUser] = useAsyncFn(fetchUserApi);
 * // state: { loading, error, value }
 * await fetchUser(id);
 */

import { useCallback, useRef, useState } from "react";

export type AsyncState<T> =
  | { loading: boolean; error?: undefined; value?: undefined }
  | { loading: false; error: Error | undefined; value: T | undefined }
  | { loading: true; error: Error | undefined; value: T | undefined };

type StateFromFnReturn<T extends (...args: any[]) => any> = AsyncState<
  Awaited<ReturnType<T>>
>;

export function useAsyncFn<T extends (...args: any[]) => Promise<any>>(
  fn: T,
  dependencies: React.DependencyList = [],
  initialState: StateFromFnReturn<T> = { loading: false } as any,
): [StateFromFnReturn<T>, T] {
  const lastCallId = useRef(0);
  const [state, set] = useState<StateFromFnReturn<T>>(initialState);

  const callback = useCallback(
    (...args: Parameters<T>): ReturnType<T> => {
      const callId = ++lastCallId.current;

      set((prev) => ({ ...prev, loading: true }) as any);

      return fn(...args).then(
        (value: any) => {
          if (callId === lastCallId.current) {
            set({ value, loading: false, error: undefined } as any);
          }
          return value;
        },
        (error: any) => {
          if (callId === lastCallId.current) {
            set({
              error: error instanceof Error ? error : new Error(String(error)),
              loading: false,
              value: undefined,
            } as any);
          }
          return error;
        },
      ) as ReturnType<T>;
    },
    dependencies,
  );

  return [state, callback as unknown as T];
}
