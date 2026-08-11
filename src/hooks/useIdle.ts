/**
 * Detect user inactivity (no mouse/keyboard/touch events).
 * Useful for auto-locking, pausing background operations, and reducing polling.
 *
 * @example
 * const isIdle = useIdle(5 * 60 * 1000); // 5 minutes
 * if (isIdle) pausePreviewReload();
 */

import { useEffect, useState } from "react";

export function useIdle(ms: number = 1000 * 60): boolean {
  const [isIdle, setIsIdle] = useState(false);

  useEffect(() => {
    let timeoutId: ReturnType<typeof setTimeout>;

    const handleEvent = () => {
      setIsIdle(false);
      clearTimeout(timeoutId);
      timeoutId = setTimeout(() => setIsIdle(true), ms);
    };

    const events = [
      "mousedown",
      "mousemove",
      "keydown",
      "touchstart",
      "scroll",
    ] as const;

    for (const event of events) {
      document.addEventListener(event, handleEvent);
    }
    handleEvent();

    return () => {
      clearTimeout(timeoutId);
      for (const event of events) {
        document.removeEventListener(event, handleEvent);
      }
    };
  }, [ms]);

  return isIdle;
}
