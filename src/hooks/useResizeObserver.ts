/**
 * Track element dimensions via ResizeObserver.
 * Replaces manual window.addEventListener("resize") for targeted element sizing.
 *
 * @example
 * const { width, height } = useResizeObserver({ ref: containerRef });
 */

import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";

type Size = { width: number | undefined; height: number | undefined };

type UseResizeObserverOptions<T extends HTMLElement = HTMLElement> = {
  ref: RefObject<T>;
  onResize?: (size: Size) => void;
  box?: "border-box" | "content-box" | "device-pixel-content-box";
};

export function useResizeObserver<T extends HTMLElement = HTMLElement>(
  options: UseResizeObserverOptions<T>,
): Size {
  const { ref, box = "content-box" } = options;
  const [size, setSize] = useState<Size>({
    width: undefined,
    height: undefined,
  });
  const previousSize = useRef<Size>({ width: undefined, height: undefined });
  const onResizeRef = useRef(options.onResize);
  onResizeRef.current = options.onResize;

  useEffect(() => {
    if (!ref.current) return;
    if (typeof window === "undefined" || !("ResizeObserver" in window)) return;

    const observer = new ResizeObserver(([entry]) => {
      const boxProp =
        box === "border-box"
          ? "borderBoxSize"
          : box === "device-pixel-content-box"
            ? "devicePixelContentBoxSize"
            : "contentBoxSize";

      const boxSize = entry[boxProp];
      const newWidth = !boxSize
        ? entry.contentRect.width
        : Array.isArray(boxSize)
          ? boxSize[0].inlineSize
          : (boxSize as any).inlineSize;
      const newHeight = !boxSize
        ? entry.contentRect.height
        : Array.isArray(boxSize)
          ? boxSize[0].blockSize
          : (boxSize as any).blockSize;

      if (
        previousSize.current.width !== newWidth ||
        previousSize.current.height !== newHeight
      ) {
        const newSize = { width: newWidth, height: newHeight };
        previousSize.current = newSize;
        if (onResizeRef.current) {
          onResizeRef.current(newSize);
        } else {
          setSize(newSize);
        }
      }
    });

    observer.observe(ref.current, { box });
    return () => observer.disconnect();
  }, [box, ref]);

  return size;
}
