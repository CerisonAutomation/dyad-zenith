/**
 * Generic FIFO queue with add/remove/peek/clear operations.
 * Useful for message queuing, task scheduling, and buffered I/O.
 *
 * @example
 * const [queue, { add, remove, peek, size }] = useQueue<string>();
 * add("message1");
 * peek(); // "message1"
 * remove(); // "message1"
 */

import { useCallback, useMemo, useState } from "react";

type UseQueueActions<T> = {
  add: (item: T) => void;
  remove: () => T | undefined;
  clear: () => void;
  peek: () => T | undefined;
  size: number;
};

export function useQueue<T>(
  initialQueue: T[] = [],
): [T[], UseQueueActions<T>] {
  const [queue, setQueue] = useState<T[]>(initialQueue);

  const actions: UseQueueActions<T> = useMemo(
    () => ({
      add: (item: T) => setQueue((prev) => [...prev, item]),
      remove: () => {
        let removedItem: T | undefined;
        setQueue((prev) => {
          const [first, ...rest] = prev;
          removedItem = first;
          return rest;
        });
        return removedItem;
      },
      clear: () => setQueue([]),
      peek: () => queue[0],
      get size() {
        return queue.length;
      },
    }),
    [queue],
  );

  return [queue, actions];
}
