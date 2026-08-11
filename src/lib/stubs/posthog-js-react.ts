/**
 * PostHog React provider stub — tracking fully removed.
 * usePostHog() returns a safe no-op client so existing call sites like
 * `posthog.capture(...)` keep working without any telemetry being sent.
 */
import { createElement, Fragment, type ReactNode } from "react";

const noop = (..._args: unknown[]) => undefined;

const noopPostHog = {
  capture: noop,
  identify: noop,
  captureException: noop,
  people: { set: noop },
  init: noop,
};

export function PostHogProvider({ children }: { children?: ReactNode }) {
  return createElement(Fragment, null, children);
}

export function usePostHog() {
  return noopPostHog;
}
