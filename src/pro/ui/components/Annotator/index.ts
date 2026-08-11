/**
 * Annotator barrel exports.
 *
 * Two versions are provided:
 *
 *   Annotator      – the raw component.  Safe to use directly in Vite /
 *                    Electron where SSR is not a concern.
 *
 *   AnnotatorCompat – an SSR-safe wrapper that dynamically imports the
 *                    real component only in the browser.  Use this when
 *                    the Annotator might be rendered during server-side
 *                    rendering (Next.js App Router, Remix, etc.).
 *
 *   Default export – AnnotatorCompat (the safe choice).
 */

// Raw component (for Vite / Electron – no SSR concerns)
export { Annotator } from "./Annotator";
export type { Annotator as AnnotatorRaw } from "./Annotator";

// SSR-safe wrapper (for Next.js / any SSR framework)
export {
  AnnotatorCompat,
  AnnotatorCompat as DynamicAnnotator,
} from "./AnnotatorCompat";
export type { AnnotatorCompatProps } from "./AnnotatorCompat";

// AnnotationCanvas is re-exported for consumers that build custom wrappers
export { AnnotationCanvas } from "./AnnotationCanvas";

// Default export is the SSR-safe version – the safest choice
export { AnnotatorCompat as default } from "./AnnotatorCompat";
