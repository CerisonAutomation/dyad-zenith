/**
 * Immutable Set state with add/remove/toggle/clear operations.
 * The toggle operation is particularly useful for multi-select UIs.
 *
 * @example
 * const [selected, { toggle, has, size }] = useSet<string>();
 * toggle("file1.ts"); // adds
 * toggle("file1.ts"); // removes
 * has("file1.ts");     // false
 */

import { useCallback, useState } from "react";

type UseSetActions<T> = {
  add: (item: T) => void;
  remove: (item: T) => void;
  toggle: (item: T) => void;
  clear: () => void;
  has: (item: T) => boolean;
};

export function useSet<T>(
  initialSet?: Set<T>,
): [Set<T>, UseSetActions<T>] {
  const [set, setSet] = useState(() => new Set(initialSet));

  const actions: UseSetActions<T> = {
    add: useCallback((item) => {
      setSet((prev) => {
        if (prev.has(item)) return prev;
        const next = new Set(prev);
        next.add(item);
        return next;
      });
    }, []),
    remove: useCallback((item) => {
      setSet((prev) => {
        if (!prev.has(item)) return prev;
        const next = new Set(prev);
        next.delete(item);
        return next;
      });
    }, []),
    toggle: useCallback((item) => {
      setSet((prev) => {
        const next = new Set(prev);
        if (next.has(item)) next.delete(item);
        else next.add(item);
        return next;
      });
    }, []),
    clear: useCallback(() => setSet(new Set()), []),
    has: useCallback((item) => set.has(item), [set]),
  };

  return [set, actions];
}
