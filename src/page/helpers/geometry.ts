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
 * The smallest size that covers every one of these boxes, or `null` when there
 * are none.
 *
 * Not a union rectangle: the boxes are not being merged into one region, they
 * are being grown to a common size while each keeps its own corner. So it is
 * the largest width and the largest height, taken independently. That is what
 * `matchSize` and `alignContainers` mean by "the same size".
 */
export function unionSize(
  sizes: readonly { w: number; h: number }[],
): { w: number; h: number } | null {
  if (sizes.length === 0) return null;
  let w = -Infinity;
  let h = -Infinity;
  for (const size of sizes) {
    w = Math.max(w, size.w);
    h = Math.max(h, size.h);
  }
  return { w, h };
}

/**
 * How far to move `own` along x so its centre sits on the centre of `target`.
 *
 * Read after the shape exists rather than before, because tldraw measures the
 * text: a title that wrapped to two lines is narrower than the width it was
 * asked for, and centring it on the nominal width leaves it visibly off.
 */
export function centerXOffset(target: Rect, own: Rect): number {
  return target.x + target.w / 2 - (own.x + own.w / 2);
}

/**
 * The pixel ratio to actually export at.
 *
 * `MAX_SHOT_EDGE` is a ceiling on the longest edge of the PNG, because a
 * pixelRatio of 2 on a wide diagram produces an image an agent cannot read in
 * one look and a browser struggles to rasterise. Reduce the ratio rather than
 * cropping, and with no floor under the reduction: a floor would turn the
 * ceiling into a suggestion on a canvas wide enough to need it most, and an
 * image of a 20,000-unit diagram that a browser refuses to rasterise is worth
 * less than a small one of the same thing.
 */
export function clampPixelRatio(
  requested: number,
  longestEdge: number,
  maxEdge: number,
): number {
  if (!Number.isFinite(longestEdge) || longestEdge <= 0) return requested;
  const scaled = longestEdge * requested;
  if (scaled <= maxEdge) return requested;
  return maxEdge / longestEdge;
}

/**
 * Where along the shared axis two boxes overlap, or `null` when they do not.
 *
 * Half-open on purpose: two boxes that merely touch edges have no band a line
 * can run down, so they fall back to their own midpoints.
 */
function overlapCentre(aLow: number, aHigh: number, bLow: number, bHigh: number): number | null {
  const low = Math.max(aLow, bLow);
  const high = Math.min(aHigh, bHigh);
  return high > low ? (low + high) / 2 : null;
}

/** Turn a page coordinate into that rect's 0..1 space along one axis. */
function normalize(value: number, start: number, size: number): number {
  if (!(size > 0)) return 0.5;
  return clamp01((value - start) / size);
}

/**
 * The anchors an arrow should use when the caller named neither end.
 *
 * {@link facingSides} says which sides face each other; this says where on
 * those sides the arrow should land. Anchoring both ends at their side's
 * midpoint looks right only while the boxes are the same size, and they stop
 * being the same size as soon as tldraw grows one of them to fit a two-line
 * label. The arrow then draws a short dog-leg that the label sits on top of,
 * which reads as a broken arrow.
 *
 * So run one page-space line down the band where the two boxes overlap and put
 * both anchors on it. That is a straight arrow whenever a straight arrow is
 * possible, and the plain side midpoint when the boxes do not overlap at all
 * and a bend is unavoidable.
 */
export function autoAnchors(
  from: Rect,
  to: Rect,
): { start: NormalizedAnchor; end: NormalizedAnchor } {
  const sides = facingSides(from, to);
  const horizontal = sides.start === "left" || sides.start === "right";

  if (horizontal) {
    const y = overlapCentre(from.y, from.y + from.h, to.y, to.y + to.h);
    if (y === null) return { start: anchorForSide(sides.start), end: anchorForSide(sides.end) };
    return {
      start: { x: sides.start === "right" ? 1 : 0, y: normalize(y, from.y, from.h) },
      end: { x: sides.end === "right" ? 1 : 0, y: normalize(y, to.y, to.h) },
    };
  }

  const x = overlapCentre(from.x, from.x + from.w, to.x, to.x + to.w);
  if (x === null) return { start: anchorForSide(sides.start), end: anchorForSide(sides.end) };
  return {
    start: { x: normalize(x, from.x, from.w), y: sides.start === "bottom" ? 1 : 0 },
    end: { x: normalize(x, to.x, to.w), y: sides.end === "bottom" ? 1 : 0 },
  };
}
