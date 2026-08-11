/**
 * Shared type guard utilities.
 * Import these instead of reimplementing isObject, isNumberArray, etc.
 */

/** Type guard: value is a non-null object with string keys */
export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Type guard: value is an array of numbers */
export function isNumberArray(value: unknown): value is number[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "number")
  );
}

/** Type guard: value is an array of strings */
export function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

/** Type guard: value is a non-empty string */
export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** Type guard: value is defined (not null, not undefined) */
export function isDefined<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}

/** Assert never: compile-time exhaustiveness check */
export function assertNever(value: never): never {
  throw new Error(`Unexpected value: ${value}`);
}
