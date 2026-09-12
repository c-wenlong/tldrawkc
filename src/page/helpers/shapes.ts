/**
 * The shape helpers: `box` and `text`.
 *
 * Both are idempotent on their key, both take placement relative to another
 * shape, and both put their words in a label rather than a floating text
 * shape where they can. Phase 2 adds `note`, `remove` and `clear` beside them.
 */

import {
  toRichText,
  type Editor,
  type TLDefaultColorStyle,
  type TLDefaultDashStyle,
  type TLDefaultFillStyle,
  type TLDefaultFontStyle,
  type TLDefaultHorizontalAlignStyle,
  type TLDefaultSizeStyle,
  type TLDefaultTextAlignStyle,
  type TLDefaultVerticalAlignStyle,
  type TLGeoShape,
  type TLShapeId,
} from "tldraw";

import { placeAfter, placeBelow, type Rect } from "./geometry.js";
import { toShapeId, type ShapeKey, type ShapeMeta } from "./ids.js";

/** Every geo shape tldraw knows: `rectangle`, `ellipse`, `oval`, `diamond`, ... */
export type GeoKind = TLGeoShape["props"]["geo"];

/** Default box size. Wide enough for two or three words at size `m`. */
export const DEFAULT_BOX_SIZE = { w: 180, h: 64 } as const;

/**
 * Default gap for `after` and `below` placement, in page units.
 *
 * Wide enough for a short labelled arrow to fit between two boxes. A tighter
 * gap is legal and sometimes right, but at 60 or less tldraw has to draw a
 * label on top of a line it has almost no room for, and the result reads as a
 * word floating between two boxes rather than an arrow.
 */
export const DEFAULT_GAP = 120;

/** Options for {@link makeBox}. Matches the table in HELPERS.md. */
export interface BoxOptions {
  /** Page x of the top-left corner. Required unless `after` or `below` is given. */
  x?: number;
  /** Page y of the top-left corner. Required unless `after` or `below` is given. */
  y?: number;
  /** Width, default 180. */
  w?: number;
  /** Height, default 64. */
  h?: number;
  /** Geo kind, default `rectangle`. `oval` is the capsule; there is no `pill`. */
  geo?: GeoKind;
  /** Outline colour, default `black`. */
  color?: TLDefaultColorStyle;
  /** Label colour, defaults to `color`. */
  labelColor?: TLDefaultColorStyle;
  /** Interior, default `none`. */
  fill?: TLDefaultFillStyle;
  /** Outline style, default `draw`. */
  dash?: TLDefaultDashStyle;
  /** Label font, default `draw` (the hand-drawn one). */
  font?: TLDefaultFontStyle;
  /** Outline and label size, default `m`. */
  size?: TLDefaultSizeStyle;
  /** Horizontal label alignment, default `middle`. */
  align?: TLDefaultHorizontalAlignStyle;
  /** Vertical label alignment, default `middle`. A long label wants `start` and a taller box. */
  verticalAlign?: TLDefaultVerticalAlignStyle;
  /** Place to the right of this shape, sharing its top edge. */
  after?: ShapeKey;
  /** Place under this shape, sharing its left edge. */
  below?: ShapeKey;
  /** Distance for `after` or `below`, default 120. */
  gap?: number;
  /** A frame or group to parent to. Defaults to the current page. */
  parent?: ShapeKey;
  /** Arbitrary record metadata, merged over what is there. `lintIgnore` lives here. */
  meta?: ShapeMeta;
}

/** Options for {@link makeText}. */
export interface TextOptions
  extends Omit<BoxOptions, "geo" | "fill" | "align" | "verticalAlign" | "h" | "dash"> {
  /** Horizontal alignment of the text itself, default `start`. */
  textAlign?: TLDefaultTextAlignStyle;
}

function pageRect(editor: Editor, key: ShapeKey): Rect {
  const id = toShapeId(key);
  const bounds = editor.getShapePageBounds(id);
  if (!bounds) {
    throw new Error(
      `tldrawkc: cannot place relative to "${String(key)}" because no such shape exists`,
    );
  }
  return { x: bounds.x, y: bounds.y, w: bounds.w, h: bounds.h };
}

/**
 * Work out the top-left corner, from `x`/`y` or from `after`/`below`.
 *
 * Returns `undefined` when the caller gave neither and the shape already
 * exists, which is the "update the label, leave it where it is" case. For a
 * shape that does not exist yet that is an error rather than a default,
 * because a box silently landing at the origin is worse than a message.
 */
function resolvePosition(
  editor: Editor,
  opts: BoxOptions,
  exists: boolean,
  what: string,
): { x: number; y: number } | undefined {
  const gap = opts.gap ?? DEFAULT_GAP;
  if (opts.after !== undefined) return placeAfter(pageRect(editor, opts.after), gap);
  if (opts.below !== undefined) return placeBelow(pageRect(editor, opts.below), gap);
  if (opts.x !== undefined || opts.y !== undefined) {
    return { x: opts.x ?? 0, y: opts.y ?? 0 };
  }
  if (exists) return undefined;
  throw new Error(
    `tldrawkc: ${what} needs x and y, or an "after" or "below" shape to sit against`,
  );
}

/**
 * Create or update a labelled geo shape and return its id.
 *
 * The id comes from the key, so re-running a snippet updates the same box
 * instead of throwing or duplicating it. Position may be absolute (`x`, `y`)
 * or relative (`after`, `below` with `gap`).
 *
 * @example
 * helpers.box('agent', 'agent cli', { x: 60, y: 60, w: 170, h: 64 })
 * helpers.box('page', 'headless page', { after: 'agent', gap: 140 })
 */
export function makeBox(
  editor: Editor,
  key: ShapeKey,
  label: string,
  opts: BoxOptions = {},
): TLShapeId {
  const id = toShapeId(key);
  const existing = editor.getShape(id);
  const position = resolvePosition(editor, opts, existing !== undefined, `box "${String(key)}"`);

  const props = {
    geo: opts.geo ?? "rectangle",
    w: opts.w ?? DEFAULT_BOX_SIZE.w,
    h: opts.h ?? DEFAULT_BOX_SIZE.h,
    color: opts.color ?? "black",
    labelColor: opts.labelColor ?? opts.color ?? "black",
    fill: opts.fill ?? "none",
    dash: opts.dash ?? "draw",
    font: opts.font ?? "draw",
    size: opts.size ?? "m",
    align: opts.align ?? "middle",
    verticalAlign: opts.verticalAlign ?? "middle",
    richText: toRichText(label),
  } satisfies Partial<TLGeoShape["props"]>;

  const partial = {
    id,
    type: "geo" as const,
    ...(position ?? {}),
    ...(opts.parent !== undefined ? { parentId: toShapeId(opts.parent) } : {}),
    ...(opts.meta !== undefined ? { meta: opts.meta } : {}),
    props,
  };

  if (existing) editor.updateShape(partial);
  else editor.createShape(partial);
  return id;
}

/**
 * Create or update a standalone text shape and return its id.
 *
 * For headings and free labels only. Words that belong to a shape go in that
 * shape's label, where they move with it.
 *
 * @example
 * helpers.text('title', 'the render loop', { x: 60, y: 0, size: 'l' })
 */
export function makeText(
  editor: Editor,
  key: ShapeKey,
  str: string,
  opts: TextOptions = {},
): TLShapeId {
  const id = toShapeId(key);
  const existing = editor.getShape(id);
  const position = resolvePosition(editor, opts, existing !== undefined, `text "${String(key)}"`);

  const props = {
    color: opts.color ?? "black",
    size: opts.size ?? "m",
    font: opts.font ?? "draw",
    textAlign: opts.textAlign ?? "start",
    // A width only means anything with autoSize off; without one, let tldraw
    // measure the text, which is the whole reason this runs in a browser.
    ...(opts.w !== undefined ? { w: opts.w, autoSize: false } : { autoSize: true }),
    richText: toRichText(str),
  };

  const partial = {
    id,
    type: "text" as const,
    ...(position ?? {}),
    ...(opts.parent !== undefined ? { parentId: toShapeId(opts.parent) } : {}),
    ...(opts.meta !== undefined ? { meta: opts.meta } : {}),
    props,
  };

  if (existing) editor.updateShape(partial);
  else editor.createShape(partial);
  return id;
}
