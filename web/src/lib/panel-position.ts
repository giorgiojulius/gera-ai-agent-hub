/** localStorage key for the desk assistant panel's offset from its corner seat. */
export const ASSISTANT_PANEL_POS_KEY = "gera.desk.assistant.pos.v1";

/**
 * Offset in px from a floating panel's default seat. x positive = right,
 * y positive = down. `{0,0}` is the stock corner.
 */
export type PanelOffset = {
  x: number;
  y: number;
};

export function isDefaultPanelOffset(offset: PanelOffset | null | undefined): boolean {
  return !offset || (offset.x === 0 && offset.y === 0);
}

/** Parse a stored offset. Garbage, `{0,0}`, and non-finite numbers become `null`. */
export function parsePanelOffset(raw: string | null | undefined): PanelOffset | null {
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
    return isDefaultPanelOffset(offset) ? null : offset;
  } catch {
    return null;
  }
}

/**
 * Keep a floating panel fully on screen. `base` is the panel's viewport rect
 * at zero offset; the offset shifts it. When the panel is larger than the
 * viewport, the top/left edge wins so the header stays reachable.
 */
export function clampPanelOffset(
  offset: PanelOffset,
  base: { left: number; top: number; width: number; height: number },
  viewport: { width: number; height: number },
  margin = 8,
): PanelOffset {
  const x = Number.isFinite(offset.x) ? offset.x : 0;
  const y = Number.isFinite(offset.y) ? offset.y : 0;
  const minX = margin - base.left;
  const maxX = Math.max(minX, viewport.width - margin - base.width - base.left);
  const minY = margin - base.top;
  const maxY = Math.max(minY, viewport.height - margin - base.height - base.top);
  return {
    x: Math.round(Math.min(maxX, Math.max(minX, x))),
    y: Math.round(Math.min(maxY, Math.max(minY, y))),
  };
}
