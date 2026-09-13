/**
 * `connect`, the only sanctioned way to draw a meaningful arrow, plus the two
 * shorthands built on it: `attribute` and `stub`.
 *
 * Layering rule 6: every arrow that means something is bound at both ends, so
 * it follows its shapes when they move and survives a relayout. A raw arrow
 * with a loose end is what the `friendless-arrow` lint exists to catch.
 */

import {
  toRichText,
  type Editor,
  type TLArrowBinding,
  type TLArrowShape,
  type TLDefaultColorStyle,
  type TLDefaultDashStyle,
  type TLDefaultFontStyle,
  type TLDefaultSizeStyle,
  type TLShapeId,
} from "tldraw";

import {
  autoAnchors,
  resolveAnchor,
  type NormalizedAnchor,
  type Rect,
  type Side,
} from "./geometry.js";
import { toShapeId, type ShapeKey, type ShapeMeta } from "./ids.js";
import { connectionKey, stripShapePrefix } from "./keys.js";
import { makeText, toParentSpace } from "./shapes.js";

/** How an end of the arrow is placed on its shape: a side name, or a 0..1 point. */
export type AnchorSpec = Side | NormalizedAnchor;

/** Which ends get an arrowhead. */
export type HeadSpec = "end" | "start" | "both" | "none";

/** Options for {@link makeConnection}. Matches the table in HELPERS.md. */
export interface ConnectOptions {
  /**
   * Override the derived arrow key. Needed only for a second arrow between the
   * same pair of shapes, since the derived id would collide.
   */
  id?: string;
  /** Arrow label. */
  label?: string;
  /** `elbow` for right-angled segments (default), `arc` for a straight or curved line. */
  kind?: TLArrowShape["props"]["kind"];
  /** Where the arrow leaves the source. A side name, `{ x, y }` in 0..1, or omitted for auto. */
  start?: AnchorSpec;
  /** Where the arrow meets the target. Same forms as `start`. */
  end?: AnchorSpec;
  /** Curvature, `arc` only, default 0. */
  bend?: number;
  /** Where the bend lands along an elbow path, 0..1, default 0.5. Use it to keep parallel arrows in separate lanes. */
  mid?: number;
  /** Which ends get a head, default `end`. */
  head?: HeadSpec;
  /** Label position along the arrow, 0..1, default 0.5. */
  labelPosition?: number;
  /** Line colour, default `black`. */
  color?: TLDefaultColorStyle;
  /** Label colour, defaults to `color`. */
  labelColor?: TLDefaultColorStyle;
  /** Line weight, default `s`. */
  size?: TLDefaultSizeStyle;
  /** Line style, default `draw`. */
  dash?: TLDefaultDashStyle;
  /** Label font, default `draw`. */
  font?: TLDefaultFontStyle;
  /**
   * Force precise anchoring on or off for both ends. Both ends are precise by
   * default, named or not, because an imprecise binding ignores the anchor and
   * aims at the shape's centre, which throws away the alignment `autoAnchors`
   * just worked out. Pass `false` to hand the entry point back to tldraw's
   * own router.
   */
  precise?: boolean;
  /** Arbitrary record metadata. `lintIgnore` lives here. */
  meta?: ShapeMeta;
}

const HEADS: Record<HeadSpec, { start: "arrow" | "none"; end: "arrow" | "none" }> = {
  end: { start: "none", end: "arrow" },
  start: { start: "arrow", end: "none" },
  both: { start: "arrow", end: "arrow" },
  none: { start: "none", end: "none" },
};

function requireRect(editor: Editor, id: TLShapeId, role: string): Rect {
  const bounds = editor.getShapePageBounds(id);
  if (!bounds) {
    throw new Error(`tldrawkc: connect's ${role} shape "${id}" does not exist`);
  }
  return { x: bounds.x, y: bounds.y, w: bounds.w, h: bounds.h };
}

function anchorPoint(rect: Rect, anchor: NormalizedAnchor): { x: number; y: number } {
  return { x: rect.x + rect.w * anchor.x, y: rect.y + rect.h * anchor.y };
}

/**
 * Draw a bound arrow between two shapes and return the arrow's id.
 *
 * Both ends get a real `arrow` binding, so the arrow tracks its shapes. Every
 * anchor is bound with `isPrecise: true`, named or auto, so the line lands
 * exactly where it was asked to: an imprecise binding ignores the anchor and
 * aims at the shape's centre, and two boxes whose centres differ (which is any
 * row where one label wrapped to a second line) then get a dog-leg the label
 * sits on top of. `autoAnchors` picks the anchors for an unnamed end.
 *
 * @example
 * helpers.connect('agent', 'page', { label: 'exec' })
 * helpers.connect('png', 'agent', { label: 'read', start: 'left', end: 'bottom' })
 */
export function makeConnection(
  editor: Editor,
  fromKey: ShapeKey,
  toKey: ShapeKey,
  opts: ConnectOptions = {},
): TLShapeId {
  const fromId = toShapeId(fromKey);
  const toId = toShapeId(toKey);
  if (fromId === toId) {
    throw new Error(`tldrawkc: connect cannot join "${fromId}" to itself`);
  }
  const fromRect = requireRect(editor, fromId, "from");
  const toRect = requireRect(editor, toId, "to");

  const arrowId = toShapeId(opts.id ?? connectionKey(String(fromKey), String(toKey)));

  const namedStart = resolveAnchor(opts.start);
  const namedEnd = resolveAnchor(opts.end);
  const auto = autoAnchors(fromRect, toRect);
  const startAnchor = namedStart ?? auto.start;
  const endAnchor = namedEnd ?? auto.end;
  const startPrecise = opts.precise ?? true;
  const endPrecise = opts.precise ?? true;

  const heads = HEADS[opts.head ?? "end"];
  const startPoint = anchorPoint(fromRect, startAnchor);
  const endPoint = anchorPoint(toRect, endAnchor);

  const props = {
    kind: opts.kind ?? "elbow",
    color: opts.color ?? "black",
    labelColor: opts.labelColor ?? opts.color ?? "black",
    fill: "none" as const,
    dash: opts.dash ?? "draw",
    size: opts.size ?? "s",
    font: opts.font ?? "draw",
    arrowheadStart: heads.start,
    arrowheadEnd: heads.end,
    bend: opts.bend ?? 0,
    elbowMidPoint: opts.mid ?? 0.5,
    labelPosition: opts.labelPosition ?? 0.5,
    richText: toRichText(opts.label ?? ""),
    // Only read when a binding is missing, which for a helper-made arrow means
    // someone deleted a shape. Seeding them from the anchor points leaves a
    // line in roughly the right place rather than one at the origin.
    start: { x: 0, y: 0 },
    end: { x: endPoint.x - startPoint.x, y: endPoint.y - startPoint.y },
  } satisfies Partial<TLArrowShape["props"]>;

  const partial = {
    id: arrowId,
    type: "arrow" as const,
    x: startPoint.x,
    y: startPoint.y,
    ...(opts.meta !== undefined ? { meta: opts.meta } : {}),
    props,
  };

  const existing = editor.getShape(arrowId);
  if (existing) {
    // Rebind rather than patch: the anchors may have moved to different sides,
    // and there is no update path that reliably turns one binding into another.
    editor.deleteBindings(editor.getBindingsFromShape(arrowId, "arrow"));
    editor.updateShape(partial);
  } else {
    editor.createShape(partial);
  }

  editor.createBindings<TLArrowBinding>([
    {
      type: "arrow",
      fromId: arrowId,
      toId: fromId,
      props: {
        terminal: "start",
        normalizedAnchor: startAnchor,
        isPrecise: startPrecise,
        isExact: false,
      },
    },
    {
      type: "arrow",
      fromId: arrowId,
      toId: toId,
      props: {
        terminal: "end",
        normalizedAnchor: endAnchor,
        isPrecise: endPrecise,
        isExact: false,
      },
    },
  ]);

  return arrowId;
}

/** Options for {@link makeAttribute}. */
export interface AttributeOptions {
  /** Where along the side the stub leaves, 0..1, default 0.5. Space several attributes with it. */
  at?: number;
  /** Stub length, in page units, default 60. */
  gap?: number;
  /** Text size, default `s`. */
  size?: TLDefaultSizeStyle;
  /** Colour of the text and the stub, default `black`. */
  color?: TLDefaultColorStyle;
  /** Text font, default `draw`. */
  font?: TLDefaultFontStyle;
  /** Override the derived keys. `<owner>.<label>` by default. */
  id?: string;
}

/** Default stub length for {@link makeAttribute}, in page units. */
export const DEFAULT_ATTRIBUTE_GAP = 60;
/** Size of the text shape an attribute writes, before tldraw measures it. */
const ATTRIBUTE_TEXT_WIDTH = 120;

/**
 * Write a short label off one side of a box and join it with a bound line.
 *
 * The ERD convenience from HELPERS.md. The joining line is an arrow shape with
 * no head at either end, because an arrow is the only tldraw shape that can
 * carry a binding: a real `line` shape would be a loose mark that moves out of
 * place the moment the box does.
 */
export function makeAttribute(
  editor: Editor,
  ownerKey: ShapeKey,
  label: string,
  side: Side,
  opts: AttributeOptions = {},
): { textId: TLShapeId; lineId: TLShapeId } {
  const ownerId = toShapeId(ownerKey);
  const owner = requireRect(editor, ownerId, "attribute owner");
  const at = Math.min(1, Math.max(0, opts.at ?? 0.5));
  const gap = opts.gap ?? DEFAULT_ATTRIBUTE_GAP;
  const key = opts.id ?? `attr:${stripShapePrefix(String(ownerKey))}.${label.replace(/\s+/gu, "-").toLowerCase()}`;

  const anchor: NormalizedAnchor =
    side === "left" || side === "right" ? { x: side === "right" ? 1 : 0, y: at } : { x: at, y: side === "bottom" ? 1 : 0 };
  const from = anchorPoint(owner, anchor);

  // The text sits a stub's length beyond the owner's edge, centred on the
  // anchor across the other axis, so a column of attributes reads as a column.
  const half = ATTRIBUTE_TEXT_WIDTH / 2;
  const place: Record<Side, { x: number; y: number }> = {
    right: { x: from.x + gap, y: from.y - 16 },
    left: { x: from.x - gap - ATTRIBUTE_TEXT_WIDTH, y: from.y - 16 },
    top: { x: from.x - half, y: from.y - gap - 32 },
    bottom: { x: from.x - half, y: from.y + gap },
  };
  const at2 = place[side];

  const textId = makeText(editor, `${key}.text`, label, {
    x: at2.x,
    y: at2.y,
    size: opts.size ?? "s",
    color: opts.color ?? "black",
    font: opts.font ?? "draw",
    textAlign: side === "left" ? "end" : "start",
  });

  const opposite: Record<Side, Side> = { right: "left", left: "right", top: "bottom", bottom: "top" };
  const lineId = makeConnection(editor, ownerId, textId, {
    id: `${key}.line`,
    kind: "arc",
    head: "none",
    start: anchor,
    end: opposite[side],
    size: opts.size ?? "s",
    color: opts.color ?? "black",
  });

  return { textId, lineId };
}

/**
 * The rules a decorative line is exempt from, and why both of them.
 *
 * `friendless-arrow` because it has no shape at either end by definition, and
 * `arrow-crosses-shape` because geometry that is not a connection is drawn
 * across things on purpose: an axis runs through the dot at its own origin, and
 * a tick mark sits inside the box it measures. Neither rule has anything to say
 * about a mark that was never claiming to join two shapes.
 */
export const LINE_LINT_IGNORE: readonly string[] = ["friendless-arrow", "arrow-crosses-shape"];

/** Options for {@link makeLine} and {@link makeStub}. */
export interface DrawLineOptions {
  /** Line colour, default `black`. */
  color?: TLDefaultColorStyle;
  /** Line weight, default `s`. */
  size?: TLDefaultSizeStyle;
  /** Line style, default `draw`. */
  dash?: TLDefaultDashStyle;
  /** Which ends get an arrowhead, default `none`. `end`, `start`, `both`. */
  head?: HeadSpec;
  /** `arc` (default) for a straight or curved line, `elbow` for right-angled segments. */
  kind?: TLArrowShape["props"]["kind"];
  /** Curvature, `arc` only, default 0. Positive bends a quarter turn anticlockwise from the direction of travel. */
  bend?: number;
  /** A label on the line. Empty by default, which is what a bare axis or rule wants. */
  label?: string;
  /** Label colour, defaults to `color`. */
  labelColor?: TLDefaultColorStyle;
  /** A frame or group to parent to. The points given stay page coordinates; the helper converts them. */
  parent?: ShapeKey;
  /**
   * Override the muted rules. An array of rule names, or `true` for all of
   * them. Defaults to {@link LINE_LINT_IGNORE}; pass `[]` to have the line
   * linted like any other arrow.
   */
  lintIgnore?: readonly string[] | true;
  /** Arbitrary record metadata. `lintIgnore` is merged over it. */
  meta?: ShapeMeta;
}

/**
 * Draw an unbound line between two page points and return its id.
 *
 * The mark for geometry that is not a connection: an axis, a vector arrow, a
 * tick, a rule under a heading. It is an arrow shape, because an arrow is the
 * only tldraw shape that can carry a head or a bend, but it binds to nothing,
 * so it stays exactly where it was put. Anything joining two shapes is
 * `makeConnection` instead, which binds and therefore survives a relayout.
 *
 * The id comes from the key the same way `box`'s does, so re-running a snippet
 * moves the line rather than stacking a second one on it.
 */
export function makeLine(
  editor: Editor,
  key: ShapeKey,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  opts: DrawLineOptions = {},
): TLShapeId {
  const id = toShapeId(key);
  const heads = HEADS[opts.head ?? "none"];

  // Page coordinates in, parent space out, the same as `box` and `text`. Both
  // ends go through the transform rather than only the origin, so the delta is
  // right even under a rotated or scaled parent.
  const from =
    opts.parent !== undefined ? toParentSpace(editor, opts.parent, { x: x1, y: y1 }) : { x: x1, y: y1 };
  const to =
    opts.parent !== undefined ? toParentSpace(editor, opts.parent, { x: x2, y: y2 }) : { x: x2, y: y2 };

  const props = {
    kind: opts.kind ?? "arc",
    color: opts.color ?? "black",
    labelColor: opts.labelColor ?? opts.color ?? "black",
    fill: "none" as const,
    dash: opts.dash ?? "draw",
    size: opts.size ?? "s",
    font: "draw" as const,
    arrowheadStart: heads.start,
    arrowheadEnd: heads.end,
    bend: opts.bend ?? 0,
    start: { x: 0, y: 0 },
    end: { x: to.x - from.x, y: to.y - from.y },
    richText: toRichText(opts.label ?? ""),
  } satisfies Partial<TLArrowShape["props"]>;

  const partial = {
    id,
    type: "arrow" as const,
    x: from.x,
    y: from.y,
    ...(opts.parent !== undefined ? { parentId: toShapeId(opts.parent) } : {}),
    meta: {
      ...opts.meta,
      lintIgnore: opts.lintIgnore === undefined ? [...LINE_LINT_IGNORE] : opts.lintIgnore === true ? true : [...opts.lintIgnore],
    },
    props,
  };

  if (editor.getShape(id)) {
    // Unbind before updating. `updateShape` does not touch binding records, so
    // a key that already belongs to a bound arrow would come back as a line
    // that is still attached to two shapes and still moves with them, which is
    // the one thing `line` promises not to be. `makeConnection` deletes them
    // for the mirror reason, that a rebind is the only reliable way to change
    // which sides an arrow leaves from.
    editor.deleteBindings(editor.getBindingsFromShape(id, "arrow"));
    editor.updateShape(partial);
  } else {
    editor.createShape(partial);
  }
  return id;
}

/**
 * {@link makeLine} with a delta instead of a second point.
 *
 * `(x, y)` is where the line starts and `(dx, dy)` is how far it runs, which is
 * the convenient form for the loose marks in a legend. Every option `makeLine`
 * takes is honoured here: they used to be accepted and dropped on the floor,
 * so a legend dash asked for in red came out black.
 */
export function makeStub(
  editor: Editor,
  key: ShapeKey,
  x: number,
  y: number,
  dx: number,
  dy: number,
  opts: DrawLineOptions = {},
): TLShapeId {
  return makeLine(editor, key, x, y, x + dx, y + dy, opts);
}
