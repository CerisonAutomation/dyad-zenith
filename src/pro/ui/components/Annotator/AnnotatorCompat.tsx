/**
 * AnnotatorCompat.tsx
 *
 * SSR-safe wrapper for the Annotator component.
 *
 * The Annotator depends on react-konva, which imports Konva.js -- a library
 * that accesses `window` and `document` at module load time.  In a server
 * environment (Next.js SSR/SSG, Remix loader, etc.) this causes a crash.
 *
 * This wrapper solves the problem by:
 *   1. Detecting the browser via `typeof window !== 'undefined'`.
 *   2. Using a dynamic import (`React.lazy` + `import()`) so that
 *      react-konva is never evaluated on the server.
 *   3. Rendering a lightweight placeholder while the real component loads.
 *
 * In Vite / Electron the component loads synchronously on first render,
 * so the wrapper adds negligible overhead.  In Next.js App Router it
 * prevents the SSR crash entirely.
 *
 * Usage:
 *   import { AnnotatorCompat as Annotator } from "./Annotator";
 *   // or
 *   import DynamicAnnotator from "./Annotator";
 */

import React, { Suspense, useState, useEffect } from "react";

// ---- types (mirrors the raw Annotator props so callers see the same API) ----

export interface AnnotatorCompatProps {
  screenshotUrl: string;
  onSubmit?: (
    file: File[],
    type?: "chat-context" | "upload-to-codebase",
  ) => void;
  handleAnnotatorClick: () => void;
}

// ---- hooks ----------------------------------------------------------------

/**
 * Returns `true` once we are definitely running inside a browser.
 * Stays `false` during SSR and on the very first server-render pass.
 */
function useIsBrowser(): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    setReady(true);
  }, []);
  return ready;
}

// ---- lazy-loaded inner component -----------------------------------------

/**
 * This lazy component is only imported *after* the browser check passes,
 * so the `react-konva` module graph is never touched on the server.
 */
const LazyAnnotator = React.lazy(() =>
  import("./Annotator").then((mod) => ({ default: mod.Annotator })),
);

// ---- placeholder shown while the chunk loads -----------------------------

function AnnotatorPlaceholder() {
  return (
    <div className="w-full h-full flex items-center justify-center bg-gray-50 dark:bg-gray-900">
      <div className="flex flex-col items-center gap-3 text-gray-400 dark:text-gray-500">
        <svg
          className="animate-spin h-8 w-8"
          xmlns="http://www.w3.org/2000/svg"
          fill="none"
          viewBox="0 0 24 24"
        >
          <circle
            className="opacity-25"
            cx="12"
            cy="12"
            r="10"
            stroke="currentColor"
            strokeWidth="4"
          />
          <path
            className="opacity-75"
            fill="currentColor"
            d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
          />
        </svg>
        <span className="text-sm">Loading annotator...</span>
      </div>
    </div>
  );
}

// ---- public wrapper ------------------------------------------------------

/**
 * Drop-in replacement for `<Annotator />` that works in both Vite/Electron
 * and Next.js (or any other SSR framework).
 *
 * - In Vite the lazy chunk is fetched once and cached; the Suspense
 *   boundary is resolved almost immediately.
 * - In Next.js SSR the component renders only the placeholder on the
 *   server, then hydrates with the real canvas on the client.
 */
export const AnnotatorCompat: React.FC<AnnotatorCompatProps> = (props) => {
  const isBrowser = useIsBrowser();

  // During SSR / before hydration: render a non-interactive placeholder.
  if (!isBrowser) {
    return <AnnotatorPlaceholder />;
  }

  // Client-only: lazy-load the real Annotator.
  return (
    <Suspense fallback={<AnnotatorPlaceholder />}>
      <LazyAnnotator {...props} />
    </Suspense>
  );
};

export default AnnotatorCompat;
