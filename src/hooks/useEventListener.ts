/**
 * Type-safe event listener hook with automatic cleanup.
 * Replaces manual addEventListener/removeEventListener pairs.
 *
 * @example
 * useEventListener("keydown", handleKeydown);
 * useEventListener("resize", handleResize, ref);
 */

import { useEffect, useRef } from "react";
import type { RefObject } from "react";

function useEventListener<KW extends keyof WindowEventMap>(
  eventName: KW,
  handler: (event: WindowEventMap[KW]) => void,
  element?: undefined,
  options?: boolean | AddEventListenerOptions,
): void;

function useEventListener<
  K extends keyof HTMLElementEventMap,
  T extends HTMLElement = HTMLDivElement,
>(
  eventName: K,
  handler: (event: HTMLElementEventMap[K]) => void,
  element: RefObject<T>,
  options?: boolean | AddEventListenerOptions,
): void;

function useEventListener<
  KW extends keyof WindowEventMap,
  KH extends keyof HTMLElementEventMap,
  T extends HTMLElement = HTMLElement,
>(
  eventName: KW | KH,
  handler: (
    event: WindowEventMap[KW] | HTMLElementEventMap[KH] | Event,
  ) => void,
  element?: RefObject<T>,
  options?: boolean | AddEventListenerOptions,
) {
  const savedHandler = useRef(handler);

  useEffect(() => {
    savedHandler.current = handler;
  }, [handler]);

  useEffect(() => {
    const target: T | Window = element?.current ?? window;
    if (!target?.addEventListener) return;

    const listener: typeof handler = (event) => savedHandler.current(event);

    target.addEventListener(eventName, listener, options);
    return () => target.removeEventListener(eventName, listener, options);
  }, [eventName, element, options]);
}

export { useEventListener };
