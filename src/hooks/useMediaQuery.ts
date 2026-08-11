/**
 * Shared media query hook.
 * Replaces 4+ inline window.matchMedia() implementations.
 */

import { useSyncExternalStore } from "react";

function subscribe(callback: () => void): () => void {
  window.addEventListener("resize", callback);
  return () => window.removeEventListener("resize", callback);
}

/**
 * Track a CSS media query match state.
 *
 * @example
 * const isDark = useMediaQuery("(prefers-color-scheme: dark)");
 * const isMobile = useMediaQuery("(max-width: 480px)");
 */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false, // SSR fallback
  );
}
