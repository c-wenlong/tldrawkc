/**
 * The shape helpers: `box`, `text`, `note`, `remove` and `clear`.
 *
 * The first three are idempotent on their key, take placement relative to
 * another shape, and put their words in a label rather than a floating text
 * shape where they can.
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
  type TLNoteShape,
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
 * Turn a page-space point into the coordinate space of the shape it parents to.
 *
 * `x` and `y` in the helpers' vocabulary are page coordinates (HELPERS.md), but
 * tldraw reads a shape's `x` and `y` in its parent's space. They are the same
 * numbers while the parent is the page, and they stop being the same the moment
 * a frame or group is anywhere but the origin, which would land the child at an
 * offset nobody asked for.
 */
function toParentSpace(
  editor: Editor,
  parent: ShapeKey,
  point: { x: number; y: number },
): { x: number; y: number } {
  const transform = editor.getShapePageTransform(toShapeId(parent));
  if (!transform) return point;
  const local = transform.clone().invert().applyToPoint(point);
  return { x: local.x, y: local.y };
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

  const placed = position !== undefined && opts.parent !== undefined
    ? toParentSpace(editor, opts.parent, position)
    : position;

  const partial = {
    id,
    type: "geo" as const,
    ...(placed ?? {}),
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

  const placed = position !== undefined && opts.parent !== undefined
    ? toParentSpace(editor, opts.parent, position)
    : position;

  const partial = {
    id,
    type: "text" as const,
    ...(placed ?? {}),
    ...(opts.parent !== undefined ? { parentId: toShapeId(opts.parent) } : {}),
    ...(opts.meta !== undefined ? { meta: opts.meta } : {}),
    props,
  };

  if (existing) editor.updateShape(partial);
  else editor.createShape(partial);
  return id;
}

/** Options for {@link makeNote}. A note sizes itself, so there is no `w` or `h`. */
export type NoteOptions = Omit<BoxOptions, "geo" | "fill" | "dash" | "w" | "h">;

/**
 * Create or update a sticky note and return its id.
 *
 * For asides and "why" callouts beside a diagram, not for the diagram itself.
 * A note has no width or height of its own: tldraw sizes it from `size` and
 * grows it downwards to fit the text, so `w` and `h` are not options.
 */
export function makeNote(
  editor: Editor,
  key: ShapeKey,
  str: string,
  opts: NoteOptions = {},
): TLShapeId {
  const id = toShapeId(key);
  const existing = editor.getShape(id);
  const resolved = resolvePosition(editor, opts, existing !== undefined, `note "${String(key)}"`);
  // Page coordinates in, parent space out, the same as `box` and `text`. A
  // note inside a frame at (400, 300) was landing 400 across and 300 down from
  // where the caller asked for it.
  const position =
    resolved !== undefined && opts.parent !== undefined
      ? toParentSpace(editor, opts.parent, resolved)
      : resolved;

  const props = {
    color: opts.color ?? "yellow",
    labelColor: opts.labelColor ?? "black",
    font: opts.font ?? "draw",
    size: opts.size ?? "m",
    align: opts.align ?? "middle",
    verticalAlign: opts.verticalAlign ?? "middle",
    richText: toRichText(str),
  } satisfies Partial<TLNoteShape["props"]>;

  const partial = {
    id,
    type: "note" as const,
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
 * Delete shapes by key or id and return how many actually went.
 *
 * An id that is not on the canvas is skipped rather than thrown on, because
 * "make sure this is gone" is the usual reason to call it and a missing shape
 * already satisfies that.
 */
export function removeShapes(editor: Editor, keys: ShapeKey | readonly ShapeKey[]): number {
  const list: readonly ShapeKey[] = typeof keys === "string" ? [keys] : keys;
  // Deduplicated, because `'a'` and `'shape:a'` are the same shape and the
  // return value promises how many shapes actually went.
  const ids = [...new Set(list.map((key) => toShapeId(key)))].filter(
    (id) => editor.getShape(id) !== undefined,
  );
  if (ids.length > 0) editor.deleteShapes(ids);
  return ids.length;
}

/** Options for {@link clearPage}. */
export interface ClearOptions {
  /** Wipe a page this snippet did not create. Say so on purpose. */
  force?: boolean;
}

/**
 * Delete every shape on the current page and return how many went.
 *
 * Refused unless this snippet created the document, or `force` is set. Created
 * means the current page held zero shapes when `exec` started: a snippet that
 * drew the whole picture may wipe it and start again, a snippet handed someone
 * else's diagram may not. This mirrors the tldraw offline app's rule about
 * never clearing a page you did not create.
 */
export function clearPage(
  editor: Editor,
  opts: ClearOptions,
  startedEmpty: boolean,
): number {
  const shapes = editor.getCurrentPageShapes();
  if (!startedEmpty && opts.force !== true) {
    throw new Error(
      `tldrawkc: clear() refused, this page already held ${shapes.length} shape(s) when the snippet started. Pass { force: true } to wipe a document you did not create.`,
    );
  }
  if (shapes.length === 0) return 0;
  editor.deleteShapes(shapes.map((shape) => shape.id));
  return shapes.length;
}
