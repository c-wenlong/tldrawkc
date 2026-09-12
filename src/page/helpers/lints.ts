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
 * All six rules from HELPERS.md live here: `friendless-arrow`,
 * `overlapping-text`, `overlapping-shapes`, `off-page`, `empty-label` and
 * `unreadable-label`.
 */

import type { Rect } from "./geometry.js";

/** A single finding. The bridge's `lints()` returns an array of these. */
export interface Lint {
  /** The rule that fired, e.g. `friendless-arrow`. */
  rule: string;
  /** Every shape the reader should look at. */
  shapeIds: string[];
  /** One sentence, addressed to whoever has to fix the diagram. */
  message: string;
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
  "overlapping-text",
  "overlapping-shapes",
  "off-page",
  "empty-label",
  "unreadable-label",
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

/**
 * Run every rule and concatenate the findings.
 *
 * Order is rule by rule, in {@link LINT_RULES} order, and within a rule it
 * follows the order the shapes were given, so a caller that iterates the
 * current page gets findings in drawing order rather than a random one.
 */
export function runLints(
  shapes: readonly LintShape[],
  bindings: readonly LintBinding[],
): Lint[] {
  return [
    ...friendlessArrows(shapes, bindings),
    ...overlappingText(shapes),
    ...overlappingShapes(shapes),
    ...offPage(shapes),
    ...emptyLabels(shapes),
    ...unreadableLabels(shapes),
  ];
}
