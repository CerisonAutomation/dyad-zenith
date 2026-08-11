/**
 * Track how many times a component has rendered.
 * Drop into any component during development to verify memoization.
 *
 * @example
 * const renderCount = useRenderCount();
 * console.log(`ChatMessage rendered ${renderCount} times`);
 */

import { useEffect, useRef } from "react";

export function useRenderCount(): number {
  const count = useRef(0);

  useEffect(() => {
    count.current += 1;
  });

  return count.current;
}
