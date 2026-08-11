/**
 * Bounded numeric state with increment/decrement/reset.
 * Useful for zoom levels, pagination, retry tracking, and index navigation.
 *
 * @example
 * const { count, increment, decrement, min, max } = useCounter(2, { min: 0, max: 5 });
 * increment(); // 3
 * decrement(); // 2
 */

import { useCallback, useState } from "react";
import type { Dispatch, SetStateAction } from "react";

type UseCounterReturn = {
  count: number;
  increment: () => void;
  decrement: () => void;
  reset: () => void;
  setCount: Dispatch<SetStateAction<number>>;
};

type UseCounterOptions = {
  min?: number;
  max?: number;
};

export function useCounter(
  initialValue?: number,
  options?: UseCounterOptions,
): UseCounterReturn {
  const [count, setCount] = useState(initialValue ?? 0);
  const { min, max } = options ?? {};

  const increment = useCallback(() => {
    setCount((current) => {
      const next = current + 1;
      if (max !== undefined && next > max) return current;
      return next;
    });
  }, [max]);

  const decrement = useCallback(() => {
    setCount((current) => {
      const next = current - 1;
      if (min !== undefined && next < min) return current;
      return next;
    });
  }, [min]);

  const reset = useCallback(
    () => setCount(initialValue ?? 0),
    [initialValue],
  );

  return { count, increment, decrement, reset, setCount };
}
