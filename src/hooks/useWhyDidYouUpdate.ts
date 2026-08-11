/**
 * Development-only hook to track which props caused a re-render.
 * Log output shows exactly which props changed and their old/new values.
 *
 * @example
 * useWhyDidYouUpdate("ChatMessage", { id, content, timestamp });
 *
 * Output: [ChatMessage] { content: { from: "old", to: "new" } }
 */

import { useEffect, useRef } from "react";

export function useWhyDidYouUpdate(
  name: string,
  props: Record<string, any>,
): void {
  if (process.env.NODE_ENV !== "development") return;

  const previousProps = useRef<Record<string, any>>({});

  useEffect(() => {
    if (Object.keys(previousProps.current).length === 0) {
      previousProps.current = props;
      return;
    }

    const allKeys = new Set([
      ...Object.keys(previousProps.current),
      ...Object.keys(props),
    ]);
    const changes: Record<string, { from: any; to: any }> = {};

    for (const key of allKeys) {
      if (previousProps.current[key] !== props[key]) {
        changes[key] = {
          from: previousProps.current[key],
          to: props[key],
        };
      }
    }

    if (Object.keys(changes).length > 0) {
      console.log(`[${name}]`, changes);
    }

    previousProps.current = props;
  });
}
