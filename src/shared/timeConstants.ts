/**
 * Shared time duration constants.
 * Import these instead of computing `24 * 60 * 60 * 1000` inline.
 */

export const MS_PER_SECOND = 1_000;
export const MS_PER_MINUTE = 60 * MS_PER_SECOND;
export const MS_PER_HOUR = 60 * MS_PER_MINUTE;
export const MS_PER_DAY = 24 * MS_PER_HOUR;
export const MS_PER_WEEK = 7 * MS_PER_DAY;
export const MS_PER_MONTH = 30 * MS_PER_DAY;

export const SECONDS_PER_MINUTE = 60;
export const SECONDS_PER_HOUR = 60 * SECONDS_PER_MINUTE;
export const SECONDS_PER_DAY = 24 * SECONDS_PER_HOUR;

export const MEBIBYTE = 1_024 * 1_024;
export const KIBIBYTE = 1_024;
