/**
 * State with full undo/redo history.
 * Useful for text editing, settings changes, and parameter adjustments.
 *
 * @example
 * const [value, setValue, { undo, redo, canUndo, canRedo }] = useHistoryState("");
 * setValue("hello");
 * undo(); // back to ""
 */

import { useCallback, useState } from "react";

type UseHistoryStateReturn<T> = [
  T,
  (newState: T) => void,
  {
    undo: () => void;
    redo: () => void;
    history: T[];
    pointer: number;
    canUndo: boolean;
    canRedo: boolean;
  },
];

export function useHistoryState<T>(initialState: T): UseHistoryStateReturn<T> {
  const [state, setState] = useState(initialState);
  const [history, setHistory] = useState<T[]>([initialState]);
  const [pointer, setPointer] = useState(0);

  const set = useCallback(
    (newState: T) => {
      setHistory((prev) => {
        const truncated = prev.slice(0, pointer + 1);
        truncated.push(newState);
        return truncated;
      });
      setPointer((prev) => prev + 1);
      setState(newState);
    },
    [pointer],
  );

  const undo = useCallback(() => {
    if (pointer > 0) {
      const newPointer = pointer - 1;
      setPointer(newPointer);
      setState(history[newPointer]);
    }
  }, [history, pointer]);

  const redo = useCallback(() => {
    if (pointer < history.length - 1) {
      const newPointer = pointer + 1;
      setPointer(newPointer);
      setState(history[newPointer]);
    }
  }, [history, pointer]);

  return [
    state,
    set,
    {
      undo,
      redo,
      history,
      pointer,
      canUndo: pointer > 0,
      canRedo: pointer < history.length - 1,
    },
  ];
}
