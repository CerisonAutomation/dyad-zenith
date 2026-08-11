/**
 * Shared date/time formatting utilities.
 * Import these instead of reimplementing formatTimestamp, formatTimeAgo, etc.
 */

import { formatDistanceToNow, format } from "date-fns";
import { MS_PER_HOUR, MS_PER_DAY } from "./timeConstants";

/**
 * Format a timestamp as relative time ("5 minutes ago") for recent messages,
 * or as a formatted date for older ones.
 */
export function formatTimestamp(input: string | number | Date): string {
  const date = typeof input === "string" ? new Date(input) : typeof input === "number" ? new Date(input) : input;
  const diffInHours = (Date.now() - date.getTime()) / MS_PER_HOUR;

  if (diffInHours < 24) {
    return formatDistanceToNow(date, { addSuffix: true });
  }
  return format(date, "MMM d, yyyy h:mm a");
}

/**
 * Format a timestamp as relative time ("5 minutes ago").
 */
export function formatTimeAgo(input: string | number | Date): string {
  const date = typeof input === "string" ? new Date(input) : input;
  return formatDistanceToNow(date, { addSuffix: true });
}

/**
 * Format a timestamp as HH:MM:SS for console/log entries.
 */
export function formatTimeShort(ts: number): string {
  return new Date(ts).toLocaleTimeString("en-US", { hour12: false });
}

/**
 * Format a date string as a human-readable long date.
 */
export function formatDateLong(dateString: string): string {
  return new Date(dateString).toLocaleString();
}

/**
 * Return an ISO timestamp safe for filenames (: and . replaced with -).
 */
export function toFileSafeTimestamp(date?: Date): string {
  return (date ?? new Date())
    .toISOString()
    .replace(/[:.]/g, "-");
}

/**
 * Collapse whitespace runs to single spaces and trim.
 */
export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
