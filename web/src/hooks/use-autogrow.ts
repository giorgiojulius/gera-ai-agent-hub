import { useCallback, useEffect, useLayoutEffect, useRef } from "react";

/**
 * Measures the textarea's content and writes an explicit pixel height, so a
 * CSS `transition-[height]` class on the element animates every change.
 *
 * Transitions are suspended while measuring: reading `scrollHeight` forces
 * layout, and an in-flight height transition would report the stale
 * mid-animation box instead of the collapsed content height (a textarea never
 * reports a scrollHeight below its current box), which would block shrinking.
 */
function syncHeight(node: HTMLTextAreaElement, maxHeight: number, animate: boolean): void {
  const previousHeight = node.style.height;
  const inlineTransition = node.style.transition;
  node.style.transition = "none";
  node.style.height = "0px";
  const measured = node.scrollHeight;
  const target = `${Math.min(measured, maxHeight)}px`;
  node.style.overflowY = measured > maxHeight ? "auto" : "hidden";
  const start = animate && previousHeight !== "" ? previousHeight : target;
  node.style.height = start;
  // Flush styles while transitions are off, so the start height applies
  // instantly and the restored transition has a concrete start point.
  node.getBoundingClientRect();
  node.style.transition = inlineTransition;
  if (start !== target) {
    node.style.height = target;
  }
}

/**
 * Auto-grows a textarea to fit its content up to `maxHeight`, after which it
 * scrolls internally. Returns a callback ref — attach it to the textarea that
 * renders `value`. Heights are explicit pixel values, so pairing the element
 * with a `transition-[height]` class yields a smooth grow/shrink animation.
 */
export function useAutoGrow(value: string, maxHeight: number): (node: HTMLTextAreaElement | null) => void {
  const nodeRef = useRef<HTMLTextAreaElement | null>(null);
  const maxRef = useRef<number>(maxHeight);
  maxRef.current = maxHeight;

  // Attach sizes instantly (no grow-in flash). Remounts with an unchanged
  // value (e.g. re-opening an edit box) still size correctly even though the
  // value-driven effect below sees identical deps.
  const ref = useCallback((node: HTMLTextAreaElement | null) => {
    nodeRef.current = node;
    if (node) {
      syncHeight(node, maxRef.current, false);
    }
  }, []);

  useLayoutEffect(() => {
    const node = nodeRef.current;
    if (node) {
      syncHeight(node, maxHeight, true);
    }
  }, [value, maxHeight]);

  // Width changes rewrap text — track them without animating.
  useEffect(() => {
    const onResize = () => {
      const node = nodeRef.current;
      if (node) {
        syncHeight(node, maxRef.current, false);
      }
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  return ref;
}
