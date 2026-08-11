/**
 * Automatic retry with linear backoff.
 * Wraps async operations that may fail transiently (network, IPC, external APIs).
 *
 * @example
 * const { isRetrying, error, start, stop } = useContinuousRetry(
 *   () => fetchModelCatalog(),
 *   { interval: 1000, retries: 5 }
 * );
 * start(); // attempts with 1s, 2s, 3s... delays
 */

import { useCallback, useEffect, useRef, useState } from "react";

type UseContinuousRetryOptions = {
  interval?: number;
  retries?: number;
};

export function useContinuousRetry(
  callback: () => Promise<any>,
  options: UseContinuousRetryOptions = {},
) {
  const { interval = 1000, retries = 5 } = options;
  const [isRetrying, setIsRetrying] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const callbackRef = useRef(callback);
  callbackRef.current = callback;
  const retryCount = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const stop = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setIsRetrying(false);
    retryCount.current = 0;
  }, []);

  const start = useCallback(() => {
    setIsRetrying(true);
    setError(null);
    retryCount.current = 0;

    const attempt = async () => {
      try {
        await callbackRef.current();
        stop();
      } catch (err) {
        retryCount.current++;
        if (retryCount.current < retries) {
          timerRef.current = setTimeout(
            attempt,
            interval * retryCount.current,
          );
        } else {
          setError(
            err instanceof Error ? err : new Error(String(err)),
          );
          setIsRetrying(false);
        }
      }
    };
    attempt();
  }, [interval, retries, stop]);

  useEffect(() => () => stop(), [stop]);

  return { isRetrying, error, start, stop };
}
