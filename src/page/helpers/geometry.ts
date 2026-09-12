/**
 * Placement and anchor arithmetic, kept pure.
 *
 * Same reason as `lints.ts`: no `tldraw` import, no `Editor`, so the unit
 * suite can check "which sides face each other" and "where does `after` put
 * the box" in node. The helpers that call these do the editor work.
 */

/** A shape's page-space bounding box. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A point in a shape's own 0..1 coordinate space. `{ x: 0, y: 0 }` is its top-left. */
export interface NormalizedAnchor {
  x: number;
  y: number;
}

/** The four side names `connect`'s `start` and `end` accept. */
export const SIDES = ["top", "right", "bottom", "left"] as const;

/** One of {@link SIDES}. */
export type Side = (typeof SIDES)[number];

const SIDE_ANCHORS: Record<Side, NormalizedAnchor> = {
  top: { x: 0.5, y: 0 },
  right: { x: 1, y: 0.5 },
  bottom: { x: 0.5, y: 1 },
  left: { x: 0, y: 0.5 },
};

/** Is this string one of the four side names? */
export function isSide(value: unknown): value is Side {
  return typeof value === "string" && (SIDES as readonly string[]).includes(value);
}

/** The midpoint of a named side, as a normalised anchor. */
export function anchorForSide(side: Side): NormalizedAnchor {
  return { ...SIDE_ANCHORS[side] };
}

/**
 * Turn whatever the caller passed as `start` or `end` into a normalised anchor.
 *
 * Accepts a side name, an explicit `{ x, y }` in 0..1, or `undefined` for
 * "decide for me", which is the caller's cue to fall back to
 * {@link facingSides}. Out of range numbers are clamped rather than rejected,
 * because an anchor of 1.2 is a typo with an obvious intent.
 */
export function resolveAnchor(
  spec: Side | NormalizedAnchor | undefined,
): NormalizedAnchor | undefined {
  if (spec === undefined) return undefined;
  if (isSide(spec)) return anchorForSide(spec);
  return { x: clamp01(spec.x), y: clamp01(spec.y) };
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0.5;
  return Math.min(1, Math.max(0, n));
}

/**
 * Which sides of two boxes face each other.
 *
 * The rule is the gap, not the centre offset: two boxes stacked vertically
 * but nudged sideways should still connect bottom to top, and comparing
 * centres alone gets that wrong as soon as the horizontal nudge exceeds the
 * vertical one. So measure how far apart the boxes actually are on each axis
 * (negative when they overlap on it), pick the axis with the larger gap, and
 * take the direction from the centres. Ties go to the horizontal, which is the
 * reading direction most diagrams flow in.
 */
export function facingSides(from: Rect, to: Rect): { start: Side; end: Side } {
  const gapX = Math.max(to.x - (from.x + from.w), from.x - (to.x + to.w));
  const gapY = Math.max(to.y - (from.y + from.h), from.y - (to.y + to.h));
  const dx = to.x + to.w / 2 - (from.x + from.w / 2);
  const dy = to.y + to.h / 2 - (from.y + from.h / 2);

  if (gapX >= gapY) {
    return dx >= 0
      ? { start: "right", end: "left" }
      : { start: "left", end: "right" };
  }
  return dy >= 0
    ? { start: "bottom", end: "top" }
    : { start: "top", end: "bottom" };
}

/** Top-left corner for a shape placed to the right of `ref`, sharing its top edge. */
export function placeAfter(ref: Rect, gap: number): { x: number; y: number } {
  return { x: ref.x + ref.w + gap, y: ref.y };
}

/** Top-left corner for a shape placed under `ref`, sharing its left edge. */
export function placeBelow(ref: Rect, gap: number): { x: number; y: number } {
  return { x: ref.x, y: ref.y + ref.h + gap };
}

/** The union of a list of boxes, or `null` when the list is empty. */
export function unionRects(rects: readonly Rect[]): Rect | null {
  if (rects.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const rect of rects) {
    minX = Math.min(minX, rect.x);
    minY = Math.min(minY, rect.y);
    maxX = Math.max(maxX, rect.x + rect.w);
    maxY = Math.max(maxY, rect.y + rect.h);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/**
 * The pixel ratio to actually export at.
 *
 * `MAX_SHOT_EDGE` is a ceiling on the longest edge of the PNG, because a
 * pixelRatio of 2 on a wide diagram produces an image an agent cannot read in
 * one look and a browser struggles to rasterise. Reduce the ratio rather than
 * cropping, and never go below a quarter, which keeps a pathological canvas
 * producing something rather than nothing.
 */
export function clampPixelRatio(
  requested: number,
  longestEdge: number,
  maxEdge: number,
): number {
  if (!Number.isFinite(longestEdge) || longestEdge <= 0) return requested;
  const scaled = longestEdge * requested;
  if (scaled <= maxEdge) return requested;
  return Math.max(0.25, maxEdge / longestEdge);
}
