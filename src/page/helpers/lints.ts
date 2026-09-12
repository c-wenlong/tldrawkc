/**
 * The lint pass, as pure functions over plain records.
 *
 * Nothing in this file imports `tldraw` or touches an `Editor`. A rule takes
 * arrays of shape-like and binding-like objects and returns findings, which is
 * what lets the unit suite run every rule in node with no browser
 * (ARCHITECTURE.md, "Testing"). The adapter that reads the live editor, and
 * which is where the browser's own text measurement happens, is
 * `collectLintRecords` in `helpers/read.ts`.
 *
 * All eight rules live here: the six from HELPERS.md (`friendless-arrow`,
 * `overlapping-text`, `overlapping-shapes`, `off-page`, `empty-label` and
 * `unreadable-label`), plus `arrow-crosses-shape` and `missing-topic`, which
 * phase 3 adds. `missing-topic` is the only one that is a warning rather than
 * an error, and the only one that reads the document instead of the page.
 */

import type { Rect } from "./geometry.js";

/**
 * How much a finding costs.
 *
 * Absent means `error`, which is every rule about the drawing itself: those
 * are what exit code 3 is for. `warn` is a finding worth printing that must
 * not change the exit code, because the document is fine as a drawing and
 * refusing it would break every file written before the rule existed.
 */
export type LintSeverity = "error" | "warn";

/** A single finding. The bridge's `lints()` returns an array of these. */
export interface Lint {
  /** The rule that fired, e.g. `friendless-arrow`. */
  rule: string;
  /** Every shape the reader should look at. Empty for a document-level rule. */
  shapeIds: string[];
  /** One sentence, addressed to whoever has to fix the diagram. */
  message: string;
  /** Absent means `error`. See {@link LintSeverity}. */
  severity?: LintSeverity;
}

/** A finding's severity, with the default applied. */
export function severityOf(lint: Lint): LintSeverity {
  return lint.severity ?? "error";
}

/** Does this list hold anything that should turn into exit code 3? */
export function hasBlockingLints(lints: readonly Lint[]): boolean {
  return lints.some((lint) => severityOf(lint) === "error");
}

/**
 * The slice of a shape record the rules read.
 *
 * Everything past `id` and `type` is optional because a caller that only wants
 * `friendless-arrow` should not have to measure anything, and because the unit
 * suite builds these by hand. A rule that needs a field it was not given skips
 * the shape rather than guessing.
 */
export interface LintShape {
  id: string;
  type: string;
  meta?: Record<string, unknown>;
  /** Page bounds, as `getShapePageBounds` reports them. */
  bounds?: Rect;
  /** Page bounds of the label box inside the shape, for `overlapping-text`. */
  labelBounds?: Rect;
  /** The label's plain text. `''` or absent when the shape has none. */
  text?: string;
  /** The geo kind (`rectangle`, `diamond`, ...). Geo shapes only. */
  geo?: string;
  /**
   * The shape this one hangs off: a page, a frame, or a container. Read by
   * `arrow-crosses-shape`, which exempts an arrow from the shape it lives in.
   */
  parentId?: string;
  /**
   * The arrow's rendered path in page coordinates, as the vertices tldraw's
   * own geometry reports: the two ends of a straight arrow, the corners of an
   * elbow route, or an arc sampled into a polyline. Arrows only, and absent
   * when the geometry could not be read.
   */
  points?: readonly { x: number; y: number }[];
  /**
   * The shape's own rendered outline in page coordinates, again from tldraw's
   * geometry: four corners for a rectangle, four for a diamond, an ellipse
   * sampled into a polygon. `arrow-crosses-shape` prefers this to `bounds`,
   * because a diamond's page box has four empty corners an arrow can pass
   * through without touching the shape. Absent means fall back to `bounds`,
   * which is right whenever the shape is a rectangle.
   */
  outline?: readonly { x: number; y: number }[];
  /** The fill style (`none`, `solid`, ...). Geo shapes only. */
  fill?: string;
  /**
   * How wide the label actually wants to be, measured by the browser at the
   * shape's own width with overflow allowed, plus the label padding. Larger
   * than `bounds.w` means something (usually one long unbreakable word) is
   * spilling out of the shape.
   */
  labelWidth?: number;
  /**
   * The shape's own width, in its own coordinate space, for
   * `unreadable-label`. Not `bounds.w`, which is the axis-aligned page box: a
   * wide, short rectangle rotated a quarter turn keeps the label width it
   * always had and reports a page box only as wide as its height. Absent means
   * fall back to `bounds.w`, which is right whenever nothing is rotated.
   */
  shapeWidth?: number;
  /**
   * True when the shape resizes itself to whatever its text needs, so a label
   * can never overflow it: an auto-sized `text` shape, or a note, which shrinks
   * its font instead. Those are exempt from `unreadable-label`.
   */
  growsToFit?: boolean;
}

/** The slice of a binding record the rules read. */
export interface LintBinding {
  type: string;
  fromId: string;
  toId: string;
  props?: { terminal?: string };
}

/** Every rule name, in the order {@link runLints} runs them. */
export const LINT_RULES = [
  "friendless-arrow",
  "arrow-crosses-shape",
  "overlapping-text",
  "overlapping-shapes",
  "off-page",
  "empty-label",
  "unreadable-label",
  "missing-topic",
] as const;

/**
 * How far from the origin a shape may sit before `off-page` fires, in page
 * units, on either axis and in either direction.
 *
 * Nothing in tldraw clips at any coordinate: measured in a real Chrome,
 * `toImage` and `getSvgString` both framed a box at x = 200000 correctly. The
 * threshold is about the frame, not about clipping. Every export is framed to
 * the union of the shapes, and the bridge caps the longest edge of a PNG at
 * `MAX_SHOT_EDGE` (4096 px), so one shape 10000 units from the rest forces a
 * frame 10000 units wide that renders at roughly 0.4 px per unit: a normal
 * 64-unit box comes out 26 px tall and its label is gone. Past about 100000
 * units the raster is wrong as well as unreadable, because tldraw quietly
 * downscales to stay inside the browser's canvas limits (a frame 128 units
 * tall came back as 126.96 at x = 100000 and 125.28 at x = 200000).
 *
 * 10000 is therefore the point where one stray shape costs the whole picture,
 * which is the thing worth a warning.
 */
export const OFF_PAGE_LIMIT = 10000;

/**
 * How much of the smaller shape has to be covered before `overlapping-shapes`
 * fires. Two boxes that graze each other by a pixel are a rounding artefact;
 * a tenth of the smaller one is a collision.
 */
export const OVERLAP_AREA_FRACTION = 0.1;

/**
 * How far inside a shape an arrow has to run before `arrow-crosses-shape`
 * fires, in page units.
 *
 * An arrow that touches a box is not the same thing as an arrow that runs
 * through it, and the difference is about the width of the ink. tldraw draws a
 * size `m` shape at a stroke width of 3.5 page units, so the arrow's own half
 * stroke plus the box outline's half stroke is 3.5 units of overlap before a
 * reader sees anything but two lines meeting. 4 is that, rounded up, and it
 * also absorbs the error in sampling an arc: the rule walks the arc as a
 * polyline, so a chord can cut a corner the curve itself clears.
 *
 * It is a threshold on depth, not on length: the shape's outline is eroded by
 * this much and the arrow has to cross what is left. Anything larger starts
 * hiding a real crossing of a small box, which is the finding this rule exists
 * for.
 */
export const ARROW_CROSSING_TOLERANCE = 4;

/** Slack on `unreadable-label`, in page units, to absorb sub-pixel measurement. */
const LABEL_WIDTH_TOLERANCE = 1;

/**
 * Is this rule muted on this shape?
 *
 * The opt-out is `meta.lintIgnore`, an array of rule names, which is what
 * `helpers.stub` sets on a decorative line (HELPERS.md). A bare `true` is
 * accepted as "mute everything" because it is the mistake an agent makes
 * first, and silently ignoring it would be worse than honouring it.
 */
export function isLintIgnored(shape: LintShape, rule: string): boolean {
  const ignore = shape.meta?.["lintIgnore"];
  if (ignore === true) return true;
  if (!Array.isArray(ignore)) return false;
  return ignore.includes(rule);
}

/** Is this the container `boxShapes` drew, rather than a shape of its own? */
export function isContainer(shape: LintShape): boolean {
  return shape.meta?.["container"] === true;
}

/** The area of the rectangle the two overlap on, zero when they miss. */
export function intersectionArea(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/**
 * `friendless-arrow`: an arrow with a loose end.
 *
 * An arrow is bound to a shape by an `arrow` binding whose `fromId` is the
 * arrow and whose `props.terminal` says which end. Two bindings, one `start`
 * and one `end`, is a fully attached arrow; anything less is a line pointing
 * at empty space, which is one of the two failure modes this tool exists to
 * catch (DECISIONS.md D10).
 */
export function friendlessArrows(
  shapes: readonly LintShape[],
  bindings: readonly LintBinding[],
): Lint[] {
  const terminalsByArrow = new Map<string, Set<string>>();
  for (const binding of bindings) {
    if (binding.type !== "arrow") continue;
    const terminal = binding.props?.terminal;
    if (terminal !== "start" && terminal !== "end") continue;
    let terminals = terminalsByArrow.get(binding.fromId);
    if (!terminals) {
      terminals = new Set<string>();
      terminalsByArrow.set(binding.fromId, terminals);
    }
    terminals.add(terminal);
  }

  const lints: Lint[] = [];
  for (const shape of shapes) {
    if (shape.type !== "arrow") continue;
    if (isLintIgnored(shape, "friendless-arrow")) continue;
    const terminals = terminalsByArrow.get(shape.id) ?? new Set<string>();
    const loose = (["start", "end"] as const).filter((t) => !terminals.has(t));
    if (loose.length === 0) continue;
    lints.push({
      rule: "friendless-arrow",
      shapeIds: [shape.id],
      message: `arrow ${shape.id} has no binding at its ${loose.join(" or ")}`,
    });
  }
  return lints;
}

/**
 * Shrink a rectangle by `inset` on every side, or `null` when nothing is left.
 *
 * A box thinner than twice the tolerance has no interior worth talking about,
 * and an arrow cannot meaningfully run "through" it, so it drops out rather
 * than becoming a rectangle with negative sides.
 */
export function insetRect(rect: Rect, inset: number): Rect | null {
  const w = rect.w - inset * 2;
  const h = rect.h - inset * 2;
  if (w <= 0 || h <= 0) return null;
  return { x: rect.x + inset, y: rect.y + inset, w, h };
}

/**
 * Does the segment `a`-`b` share any length with the rectangle?
 *
 * Liang and Barsky's clip, which is the cheap way to ask this without a case
 * per edge: each of the four half-planes narrows the parameter range the
 * segment is allowed to keep, and whatever survives all four is the part
 * inside. `t1 > t0` rather than `>=`, so a segment that only runs along an
 * edge, or touches a corner, is not inside anything.
 *
 * A segment wholly inside the rectangle keeps its whole range and so counts,
 * which is the case that matters for an elbow arrow whose corner lands in a
 * box it never leaves.
 */
export function clipSegmentToRect(
  a: { x: number; y: number },
  b: { x: number; y: number },
  rect: Rect,
): { t0: number; t1: number } | null {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  let t0 = 0;
  let t1 = 1;

  const clip = (p: number, q: number): boolean => {
    // Parallel to this pair of edges. `> 0` and not `>= 0`, so a segment lying
    // exactly along an edge has no depth inside and is not a crossing.
    if (p === 0) return q > 0;
    const r = q / p;
    if (p < 0) {
      if (r > t1) return false;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return false;
      if (r < t1) t1 = r;
    }
    return true;
  };

  if (!clip(-dx, a.x - rect.x)) return null;
  if (!clip(dx, rect.x + rect.w - a.x)) return null;
  if (!clip(-dy, a.y - rect.y)) return null;
  if (!clip(dy, rect.y + rect.h - a.y)) return null;
  return t1 > t0 ? { t0, t1 } : null;
}

/** {@link clipSegmentToRect}, when only the yes or no is wanted. */
export function segmentCrossesRect(
  a: { x: number; y: number },
  b: { x: number; y: number },
  rect: Rect,
): boolean {
  return clipSegmentToRect(a, b, rect) !== null;
}

/** A point, in page coordinates. */
interface Point {
  x: number;
  y: number;
}

/**
 * How far apart the samples are when walking a leg through a concave shape, in
 * page units.
 *
 * Half the tolerance, so the error only ever runs one way. A sample that
 * reports as deep really is a point on the arrow that is really that far inside
 * the shape, so sampling can never invent a crossing; all it can do is miss one
 * whose deepest point is barely past the threshold, because the deepest point
 * fell between two samples. Missing a crossing four units deep costs a nudge,
 * and inventing one costs a working diagram an exit code of 3, so that is the
 * direction to be wrong in.
 */
const CROSSING_SAMPLE_STEP = ARROW_CROSSING_TOLERANCE / 2;

/**
 * Last-resort ceiling on the samples one leg contributes.
 *
 * Not the thing that keeps the walk cheap: the leg is cut down to the part
 * inside the shape's own page box before it is ever sampled, and anything
 * outside that box cannot be inside the shape, so the span walked is at most
 * the box's diagonal however long the arrow is. At the spacing above that is
 * a few hundred samples for any shape a person would draw, and the ceiling
 * only bites on a shape thousands of units across, which `off-page` is already
 * complaining about.
 */
const MAX_CROSSING_SAMPLES = 4096;

/**
 * Is this polygon convex, taking its points in the order they are given?
 *
 * Decides which of the two crossing tests a shape gets. Every geo this tool
 * actually draws is convex, and the exact test below is only exact for those.
 * Collinear points count as convex, since a repeated or in-line vertex is not
 * a turn in either direction.
 */
export function isConvexPolygon(points: readonly Point[]): boolean {
  const n = points.length;
  if (n < 3) return false;
  let sign = 0;
  for (let i = 0; i < n; i++) {
    const a = points[i];
    const b = points[(i + 1) % n];
    const c = points[(i + 2) % n];
    if (!a || !b || !c) return false;
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (cross === 0) continue;
    const turn = cross > 0 ? 1 : -1;
    if (sign === 0) sign = turn;
    else if (turn !== sign) return false;
  }
  return sign !== 0;
}

/**
 * Does the segment `a`-`b` reach more than `inset` inside the convex polygon?
 *
 * The same parametric clip as {@link segmentCrossesRect}, generalised from
 * four axis-aligned half-planes to one per edge, each pushed `inset` inward.
 * For a convex polygon that intersection is exactly the polygon eroded by
 * `inset`, so "more than four units inside the shape" is the literal question
 * being asked rather than an approximation of it. With an axis-aligned
 * rectangle and the same inset it agrees with `segmentCrossesRect` exactly.
 *
 * Inward is decided against the polygon's own centroid rather than assumed
 * from the winding order, so a polygon that comes back clockwise is not read
 * inside out.
 */
export function segmentCrossesConvex(
  a: Point,
  b: Point,
  polygon: readonly Point[],
  inset: number,
): boolean {
  if (polygon.length < 3) return false;

  let cx = 0;
  let cy = 0;
  for (const point of polygon) {
    cx += point.x;
    cy += point.y;
  }
  const centre = { x: cx / polygon.length, y: cy / polygon.length };

  const dx = b.x - a.x;
  const dy = b.y - a.y;
  let t0 = 0;
  let t1 = 1;

  for (let i = 0; i < polygon.length; i++) {
    const from = polygon[i];
    const to = polygon[(i + 1) % polygon.length];
    if (!from || !to) return false;

    let nx = -(to.y - from.y);
    let ny = to.x - from.x;
    const length = Math.hypot(nx, ny);
    // A repeated vertex contributes no edge and no constraint.
    if (length === 0) continue;
    nx /= length;
    ny /= length;
    if (nx * (centre.x - from.x) + ny * (centre.y - from.y) < 0) {
      nx = -nx;
      ny = -ny;
    }

    // How far inside this edge the segment starts, and how fast that changes.
    const q = nx * (a.x - from.x) + ny * (a.y - from.y) - inset;
    const p = nx * dx + ny * dy;
    if (p === 0) {
      // Parallel to this edge. Strictly, so a segment lying exactly on the
      // eroded boundary has no depth inside and is not a crossing.
      if (q <= 0) return false;
      continue;
    }
    const r = -q / p;
    if (p > 0) {
      if (r > t1) return false;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return false;
      if (r < t1) t1 = r;
    }
  }
  return t1 > t0;
}

/** Is the point inside the polygon? A ray cast, so a concave one is fine. */
export function pointInPolygon(point: Point, polygon: readonly Point[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i];
    const b = polygon[j];
    if (!a || !b) continue;
    if (a.y > point.y !== b.y > point.y) {
      const x = ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x;
      if (point.x < x) inside = !inside;
    }
  }
  return inside;
}

/** Shortest distance from the point to any edge of the polygon. */
export function distanceToPolygon(point: Point, polygon: readonly Point[]): number {
  let best = Infinity;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i];
    const b = polygon[j];
    if (!a || !b) continue;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const squared = dx * dx + dy * dy;
    const t =
      squared === 0 ? 0 : Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / squared));
    best = Math.min(best, Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy)));
  }
  return best;
}

/**
 * Does the segment `a`-`b` reach more than `depth` inside the polygon, with no
 * assumption that the polygon is convex?
 *
 * For `star`, `cloud` and `heart`, the three geos tldraw draws with notches in
 * them, where eroding by half-planes would fill the notches in and report an
 * arrow that passed through empty space. Walks the segment and asks each sample
 * whether it is inside and far enough from the outline. See
 * {@link CROSSING_SAMPLE_STEP} for why the sampling error is safe, and
 * {@link MAX_CROSSING_SAMPLES} for why callers hand it the part of a leg that
 * is near the shape rather than the whole thing.
 */
export function segmentReachesInside(
  a: Point,
  b: Point,
  polygon: readonly Point[],
  depth: number,
): boolean {
  if (polygon.length < 3) return false;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const steps = Math.min(
    MAX_CROSSING_SAMPLES,
    Math.max(1, Math.ceil(Math.hypot(dx, dy) / CROSSING_SAMPLE_STEP)),
  );
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const point = { x: a.x + dx * t, y: a.y + dy * t };
    if (!pointInPolygon(point, polygon)) continue;
    if (distanceToPolygon(point, polygon) > depth) return true;
  }
  return false;
}

/** Does any leg of a path run through the rectangle? */
function pathCrossesRect(
  points: readonly { x: number; y: number }[],
  rect: Rect,
): boolean {
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (!a || !b) continue;
    if (segmentCrossesRect(a, b, rect)) return true;
  }
  return false;
}

/**
 * Does any leg of a path reach more than `inset` inside the outline?
 *
 * Two tests, picked per shape rather than per repo: the exact half-plane
 * erosion when the outline is convex, which is every geo this tool draws, and
 * the sampled walk when it is not, which is `star`, `cloud` and `heart`.
 */
function pathReachesInside(
  points: readonly Point[],
  outline: readonly Point[],
  convex: boolean,
  box: Rect,
  inset: number,
): boolean {
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (!a || !b) continue;
    if (convex) {
      if (segmentCrossesConvex(a, b, outline, inset)) return true;
      continue;
    }
    // Cut the leg down to the part that is inside the shape's eroded page box
    // before sampling it. The outline sits inside that box and erosion only
    // shrinks it further, so nothing more than `inset` inside the shape can lie
    // outside the clipped span: the walk loses nothing and its spacing stops
    // depending on how long the arrow is.
    const span = clipSegmentToRect(a, b, box);
    if (!span) continue;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const from = { x: a.x + dx * span.t0, y: a.y + dy * span.t0 };
    const to = { x: a.x + dx * span.t1, y: a.y + dy * span.t1 };
    if (segmentReachesInside(from, to, outline, inset)) return true;
  }
  return false;
}

/**
 * `arrow-crosses-shape`: an arrow drawn straight through something it has
 * nothing to do with.
 *
 * The failure this catches is the one a reader hits first and the other rules
 * all miss: a long arrow between two distant boxes routed over the top of the
 * six boxes in between, so the picture reads as seven connections instead of
 * one. `overlapping-shapes` skips arrows on purpose, because an arrow touching
 * a box is how arrows work; this rule is about the shapes an arrow touches
 * that are not its own.
 *
 * Exempt: the two shapes the arrow is bound to, since arriving at them is the
 * point; a container (`meta.container`), since arrows are expected to cross
 * into and out of a group; the arrow's own parent, for the same reason on a
 * frame; and either shape carrying this rule in `meta.lintIgnore`. Only geo
 * and note shapes count as something to run through, because a text shape has
 * no outline for a line to disappear behind.
 *
 * The test is against the shape's own outline and not against its page box: a
 * diamond's box has four empty corners, and an arrow routed through one of them
 * touches nothing. A convex outline, which is every geo this tool draws, is
 * eroded exactly; a concave one (`star`, `cloud`, `heart`) is walked by
 * sampling instead, so an arrow threaded through a star's notch stays silent
 * rather than costing a working diagram an exit code of 3. The page box is
 * still the first thing checked, because it rejects almost every pair in one
 * comparison and anything it rejects the outline would reject too.
 *
 * See {@link ARROW_CROSSING_TOLERANCE} for how far in is far enough.
 */
export function arrowCrossesShape(
  shapes: readonly LintShape[],
  bindings: readonly LintBinding[],
): Lint[] {
  const boundTo = new Map<string, Set<string>>();
  for (const binding of bindings) {
    if (binding.type !== "arrow") continue;
    let bound = boundTo.get(binding.fromId);
    if (!bound) {
      bound = new Set<string>();
      boundTo.set(binding.fromId, bound);
    }
    bound.add(binding.toId);
  }

  const crossable = shapes.filter(
    (shape) =>
      (shape.type === "geo" || shape.type === "note") &&
      shape.bounds !== undefined &&
      !isContainer(shape) &&
      !isLintIgnored(shape, "arrow-crosses-shape"),
  );

  // Convexity once per candidate, not once per arrow and candidate: a page with
  // seventy arrows would otherwise walk the same thirty outlines seventy times
  // over to ask the same question.
  const convex = new Map<string, boolean>();
  for (const shape of crossable) {
    const outline = shape.outline;
    if (!outline || outline.length < 3) continue;
    convex.set(shape.id, isConvexPolygon(outline));
  }

  const lints: Lint[] = [];
  for (const arrow of shapes) {
    if (arrow.type !== "arrow") continue;
    const points = arrow.points;
    if (!points || points.length < 2) continue;
    if (isLintIgnored(arrow, "arrow-crosses-shape")) continue;
    const bound = boundTo.get(arrow.id);
    for (const shape of crossable) {
      if (shape.id === arrow.id) continue;
      if (bound?.has(shape.id) === true) continue;
      if (arrow.parentId !== undefined && arrow.parentId === shape.id) continue;
      const bounds = shape.bounds;
      if (!bounds) continue;
      const inner = insetRect(bounds, ARROW_CROSSING_TOLERANCE);
      if (!inner) continue;
      if (!pathCrossesRect(points, inner)) continue;
      const outline = shape.outline;
      const isConvex = convex.get(shape.id);
      if (
        outline !== undefined &&
        isConvex !== undefined &&
        !pathReachesInside(points, outline, isConvex, inner, ARROW_CROSSING_TOLERANCE)
      ) {
        continue;
      }
      lints.push({
        rule: "arrow-crosses-shape",
        shapeIds: [arrow.id, shape.id],
        message: `arrow ${arrow.id} passes through ${shape.id}, which is neither shape it connects`,
      });
    }
  }
  return lints;
}

/**
 * `overlapping-text`: two labels sitting on top of each other.
 *
 * The label box, not the shape box: two boxes may legitimately touch, but the
 * moment their words share pixels the diagram has stopped being readable. An
 * arrow's label counts, which is how "the label landed on the box outline"
 * gets caught.
 */
export function overlappingText(shapes: readonly LintShape[]): Lint[] {
  const labelled = shapes.filter(
    (shape) =>
      shape.labelBounds !== undefined &&
      (shape.text ?? "").trim().length > 0 &&
      !isLintIgnored(shape, "overlapping-text"),
  );

  const lints: Lint[] = [];
  for (let i = 0; i < labelled.length; i++) {
    for (let j = i + 1; j < labelled.length; j++) {
      const a = labelled[i];
      const b = labelled[j];
      if (!a?.labelBounds || !b?.labelBounds) continue;
      if (intersectionArea(a.labelBounds, b.labelBounds) <= 0) continue;
      lints.push({
        rule: "overlapping-text",
        shapeIds: [a.id, b.id],
        message: `the labels of ${a.id} and ${b.id} overlap`,
      });
    }
  }
  return lints;
}

/**
 * `overlapping-shapes`: two shapes covering each other.
 *
 * Fires when the shared area is more than a tenth of the smaller shape's, so a
 * one-pixel graze is not a finding. Arrows are skipped, because an arrow
 * crossing a box is how arrows work; containers are skipped on both sides,
 * because covering their members is the entire point of a container.
 */
export function overlappingShapes(shapes: readonly LintShape[]): Lint[] {
  const solid = shapes.filter(
    (shape) =>
      shape.type !== "arrow" &&
      shape.bounds !== undefined &&
      !isContainer(shape) &&
      !isLintIgnored(shape, "overlapping-shapes"),
  );

  const lints: Lint[] = [];
  for (let i = 0; i < solid.length; i++) {
    for (let j = i + 1; j < solid.length; j++) {
      const a = solid[i];
      const b = solid[j];
      if (!a?.bounds || !b?.bounds) continue;
      const shared = intersectionArea(a.bounds, b.bounds);
      if (shared <= 0) continue;
      const smaller = Math.min(a.bounds.w * a.bounds.h, b.bounds.w * b.bounds.h);
      if (smaller <= 0) continue;
      const fraction = shared / smaller;
      if (fraction <= OVERLAP_AREA_FRACTION) continue;
      lints.push({
        rule: "overlapping-shapes",
        shapeIds: [a.id, b.id],
        message: `${a.id} and ${b.id} overlap by ${Math.round(fraction * 100)} percent of the smaller one`,
      });
    }
  }
  return lints;
}

/**
 * `off-page`: a shape far enough from the rest that the export is ruined.
 *
 * See {@link OFF_PAGE_LIMIT} for what the number means and how it was
 * measured. The check is on the page bounds, so a wide shape whose left edge
 * is inside the limit but whose right edge is not still counts.
 */
export function offPage(shapes: readonly LintShape[]): Lint[] {
  const lints: Lint[] = [];
  for (const shape of shapes) {
    const bounds = shape.bounds;
    if (!bounds) continue;
    if (isLintIgnored(shape, "off-page")) continue;
    const outside =
      Math.min(bounds.x, bounds.x + bounds.w) < -OFF_PAGE_LIMIT ||
      Math.min(bounds.y, bounds.y + bounds.h) < -OFF_PAGE_LIMIT ||
      Math.max(bounds.x, bounds.x + bounds.w) > OFF_PAGE_LIMIT ||
      Math.max(bounds.y, bounds.y + bounds.h) > OFF_PAGE_LIMIT;
    if (!outside) continue;
    lints.push({
      rule: "off-page",
      shapeIds: [shape.id],
      message: `${shape.id} sits at (${Math.round(bounds.x)}, ${Math.round(bounds.y)}), further than ${OFF_PAGE_LIMIT} from the origin, which shrinks every other shape in the export`,
    });
  }
  return lints;
}

/**
 * `empty-label`: an unexplained outline.
 *
 * A geo shape with no words and no fill draws a rectangle that means nothing
 * to a reader. Containers are exempt, because an unlabelled container is a
 * grouping mark rather than a missed label, and so is anything with a fill,
 * which reads as a deliberate block of colour.
 */
export function emptyLabels(shapes: readonly LintShape[]): Lint[] {
  const lints: Lint[] = [];
  for (const shape of shapes) {
    if (shape.type !== "geo") continue;
    if (isContainer(shape)) continue;
    if (isLintIgnored(shape, "empty-label")) continue;
    if ((shape.text ?? "").trim().length > 0) continue;
    if (shape.fill !== "none") continue;
    lints.push({
      rule: "empty-label",
      shapeIds: [shape.id],
      message: `${shape.id} is an empty unfilled outline, so it says nothing to a reader`,
    });
  }
  return lints;
}

/**
 * `unreadable-label`: a label wider than the shape holding it.
 *
 * tldraw wraps a geo label and grows the shape's height to suit, but it never
 * grows the width, so a word longer than the box spills over the outline or
 * gets clipped. `labelWidth` is the browser's own measurement of what the
 * label needs at that width with overflow allowed, which is why this rule
 * cannot be computed from the records alone. Shapes that resize themselves to
 * their text (`growsToFit`) are exempt.
 */
export function unreadableLabels(shapes: readonly LintShape[]): Lint[] {
  const lints: Lint[] = [];
  for (const shape of shapes) {
    const labelWidth = shape.labelWidth;
    // The shape's own width, so a rotated shape is judged on the room its
    // label actually has rather than on the page box a rotation inflates.
    const width = shape.shapeWidth ?? shape.bounds?.w;
    if (width === undefined || labelWidth === undefined) continue;
    if (shape.growsToFit === true) continue;
    if (isLintIgnored(shape, "unreadable-label")) continue;
    if ((shape.text ?? "").trim().length === 0) continue;
    if (labelWidth <= width + LABEL_WIDTH_TOLERANCE) continue;
    lints.push({
      rule: "unreadable-label",
      shapeIds: [shape.id],
      message: `${shape.id}'s label needs ${Math.round(labelWidth)} units but the shape is only ${Math.round(width)} wide, so the text spills out of it`,
    });
  }
  return lints;
}

/** What the document-level rules read. Absent means "nobody asked about it". */
export interface LintDocument {
  /** The document metadata, or `null` when the file carries none. */
  meta: { topic: string } | null;
}

/**
 * A diagram nobody can find: no topic on the document record.
 *
 * A warning and not an error, on purpose. The drawing is fine, and every
 * `.tldr` written before metadata existed has no topic, so failing here would
 * turn a whole directory of good diagrams red. What it costs is real though:
 * the catalog joins assets to courses and concepts through the topic, so an
 * untagged diagram is in the repo and out of the index.
 *
 * It only fires when the caller supplied a document at all. A rule that has
 * not been told anything about the document should say nothing rather than
 * assume the worst.
 */
export function missingTopic(document: LintDocument | undefined): Lint[] {
  if (document === undefined) return [];
  const topic = document.meta?.topic.trim() ?? "";
  if (topic !== "") return [];
  return [
    {
      rule: "missing-topic",
      shapeIds: [],
      message:
        "this document names no topic, so a catalog cannot file it. " +
        "Set one with `tldrawkc meta set <file> --topic <slug>`, or pass --topic to `new`",
      severity: "warn",
    },
  ];
}

/**
 * Run every rule and concatenate the findings.
 *
 * Order is rule by rule, in {@link LINT_RULES} order, and within a rule it
 * follows the order the shapes were given, so a caller that iterates the
 * current page gets findings in drawing order rather than a random one.
 *
 * `document` is optional because the rules that need it are about the file and
 * not the page: a caller checking a hand-built shape list has nothing to say
 * about a document, and should not be told its metadata is missing.
 */
export function runLints(
  shapes: readonly LintShape[],
  bindings: readonly LintBinding[],
  document?: LintDocument,
): Lint[] {
  return [
    ...friendlessArrows(shapes, bindings),
    ...arrowCrossesShape(shapes, bindings),
    ...overlappingText(shapes),
    ...overlappingShapes(shapes),
    ...offPage(shapes),
    ...emptyLabels(shapes),
    ...unreadableLabels(shapes),
    ...missingTopic(document),
  ];
}
