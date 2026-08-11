/**
 * Immutable Map state with copy-on-write semantics.
 * React detects changes correctly (unlike mutating Map.set directly).
 *
 * @example
 * const [map, { set, remove, has }] = useMap<string, number>();
 * set("key", 42);
 * has("key"); // true
 */

import { useCallback, useState } from "react";

type MapOrEntries<K, V> = Map<K, V> | [K, V][];

type UseMapActions<K, V> = {
  set: (key: K, value: V) => void;
  setAll: (entries: MapOrEntries<K, V>) => void;
  remove: (key: K) => void;
  reset: () => void;
};

export function useMap<K, V>(
  initialState: MapOrEntries<K, V> = new Map(),
): [Map<K, V>, UseMapActions<K, V>] {
  const [map, setMap] = useState(() => new Map(initialState));

  const actions: UseMapActions<K, V> = {
    set: useCallback((key, value) => {
      setMap((prev) => {
        const copy = new Map(prev);
        copy.set(key, value);
        return copy;
      });
    }, []),
    setAll: useCallback((entries) => {
      setMap(() => new Map(entries));
    }, []),
    remove: useCallback((key) => {
      setMap((prev) => {
        const copy = new Map(prev);
        copy.delete(key);
        return copy;
      });
    }, []),
    reset: useCallback(() => {
      setMap(() => new Map());
    }, []),
  };

  return [map, actions];
}
