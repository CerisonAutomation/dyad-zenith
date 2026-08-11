/**
 * Track element visibility via IntersectionObserver.
 * Useful for lazy loading, infinite scroll, and visibility-triggered animations.
 *
 * @example
 * const { ref, isIntersecting } = useIntersectionObserver({ threshold: 0.5 });
 * <div ref={ref}>Lazy content</div>
 */

import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";

type UseIntersectionObserverOptions = {
  threshold?: number | number[];
  rootMargin?: string;
  root?: RefObject<Element>;
  triggerOnce?: boolean;
};

type UseIntersectionObserverReturn = {
  ref: (node: Element | null) => void;
  isIntersecting: boolean;
  entry: IntersectionObserverEntry | null;
};

export function useIntersectionObserver(
  options: UseIntersectionObserverOptions = {},
): UseIntersectionObserverReturn {
  const { threshold = 0, rootMargin = "0px", root, triggerOnce = false } = options;
  const [entry, setEntry] = useState<IntersectionObserverEntry | null>(null);
  const [isIntersecting, setIsIntersecting] = useState(false);
  const elementRef = useRef<Element | null>(null);
  const hasTriggered = useRef(false);

  const ref = useRef<((node: Element | null) => void) | null>(null);

  ref.current = (node: Element | null) => {
    if (elementRef.current) {
      // Cleanup previous observer
    }
    elementRef.current = node;
    if (!node) return;

    const observer = new IntersectionObserver(
      ([observerEntry]) => {
        setEntry(observerEntry);
        setIsIntersecting(observerEntry.isIntersecting);
        if (triggerOnce && observerEntry.isIntersecting) {
          hasTriggered.current = true;
          observer.disconnect();
        }
      },
      { threshold, rootMargin, root: root?.current },
    );

    observer.observe(node);

    // Store observer for cleanup
    (node as any).__intersectionObserver = observer;
  };

  useEffect(() => {
    const node = elementRef.current;
    if (!node) return;

    const observer = new IntersectionObserver(
      ([observerEntry]) => {
        if (hasTriggered.current) return;
        setEntry(observerEntry);
        setIsIntersecting(observerEntry.isIntersecting);
        if (triggerOnce && observerEntry.isIntersecting) {
          hasTriggered.current = true;
          observer.disconnect();
        }
      },
      { threshold, rootMargin, root: root?.current },
    );

    observer.observe(node);
    return () => observer.disconnect();
  }, [threshold, rootMargin, root, triggerOnce]);

  return {
    ref: ref.current,
    isIntersecting,
    entry,
  };
}
