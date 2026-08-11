/**
 * PostHog telemetry stub — tracking fully removed.
 * This no-op module replaces posthog-js so no telemetry data is
 * collected, transmitted, or stored. All event captures are dropped.
 */
const noop = () => undefined;

export interface PostHog {
  capture: (...args: unknown[]) => void;
  identify: (...args: unknown[]) => void;
  captureException: (...args: unknown[]) => void;
  people: { set: (...args: unknown[]) => void };
  init: (...args: unknown[]) => PostHog;
}

const posthog: PostHog = {
  capture: noop,
  identify: noop,
  captureException: noop,
  people: { set: noop },
  init: () => posthog,
};

export default posthog;
export { posthog };
