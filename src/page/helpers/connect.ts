/**
 * `connect`, the only sanctioned way to draw a meaningful arrow.
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
  facingSides,
  anchorForSide,
  resolveAnchor,
  type NormalizedAnchor,
  type Rect,
  type Side,
} from "./geometry.js";
import { toShapeId, type ShapeKey, type ShapeMeta } from "./ids.js";
import { connectionKey } from "./keys.js";

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
   * Force precise anchoring on or off for both ends. By default an end the
   * caller named is precise and an auto end is not, which is what lets
   * tldraw's own router pick the prettiest entry point.
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
 * Both ends get a real `arrow` binding, so the arrow tracks its shapes. Anchors
 * the caller named are bound with `isPrecise: true` so the line lands exactly
 * there; an end left to `auto` gets the facing side as its anchor but stays
 * imprecise, which lets tldraw's router slide the entry point along that side
 * instead of nailing it to the midpoint.
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
  const auto = facingSides(fromRect, toRect);
  const startAnchor = namedStart ?? anchorForSide(auto.start);
  const endAnchor = namedEnd ?? anchorForSide(auto.end);
  const startPrecise = opts.precise ?? namedStart !== undefined;
  const endPrecise = opts.precise ?? namedEnd !== undefined;

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
