/**
 * Deprecated: engine calls removed (2026-08-11).
 * All operations now use the locally-configured model provider.
 * Keeping the export for backward compatibility with any stale imports.
 */
export function getDyadEngineBaseUrl(): string {
  return "http://localhost:0/removed";
}
