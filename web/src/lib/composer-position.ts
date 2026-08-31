/** localStorage key for the docked thread composer's offset from its default seat. */
export const COMPOSER_POS_KEY = "gera.composer.pos.v1";

/**
 * Offset from the default dock: centered on the X axis, flush to the bottom.
 * x positive = right, y positive = up. `{0,0}` is the stock layout.
 */
export type ComposerOffset = {
  x: number;
  y: number;
};

export function isDefaultOffset(offset: ComposerOffset | null | undefined): boolean {
  return !offset || (offset.x === 0 && offset.y === 0);
}

/** Parse a stored offset. Garbage, `{0,0}`, and non-finite numbers become `null`. */
export function parseComposerOffset(raw: string | null | undefined): ComposerOffset | null {
  if (!raw) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    const rec = parsed as { x?: unknown; y?: unknown };
    if (typeof rec.x !== "number" || typeof rec.y !== "number") {
      return null;
    }
    if (!Number.isFinite(rec.x) || !Number.isFinite(rec.y)) {
      return null;
    }
    const offset = { x: Math.round(rec.x), y: Math.round(rec.y) };
    return isDefaultOffset(offset) ? null : offset;
  } catch {
    return null;
  }
}

/**
 * Keep the composer card fully inside the pane. `box` is the measured card;
 * X is clamped around the centered default, Y from the bottom up.
 */
export function clampComposerOffset(
  offset: ComposerOffset,
  pane: { width: number; height: number },
  box: { width: number; height: number },
): ComposerOffset {
  const width = Math.max(0, pane.width);
  const height = Math.max(0, pane.height);
  const boxW = Math.min(Math.max(0, box.width), width);
  const boxH = Math.min(Math.max(0, box.height), height);
  const defaultLeft = (width - boxW) / 2;
  const minX = -defaultLeft;
  const maxX = width - boxW - defaultLeft;
  const x = Number.isFinite(offset.x) ? offset.x : 0;
  const y = Number.isFinite(offset.y) ? offset.y : 0;
  return {
    x: Math.round(Math.min(maxX, Math.max(minX, x))),
    y: Math.round(Math.min(Math.max(0, height - boxH), Math.max(0, y))),
  };
}
