/**
 * Escape special regex characters in a string so it can be used in a regex literal.
 */
export function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
