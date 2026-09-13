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

import { centerXOffset, placeAfter, placeBelow, unionRects, type Rect } from "./geometry.js";
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

/**
 * Placing a label against other shapes instead of at a coordinate.
 *
 * A title over two panels, a caption under a row of boxes: the number that
 * matters is the centre of what it is labelling, and it is a number the caller
 * cannot know, because tldraw measures the text and a heading that wrapped is
 * narrower than the width it asked for. So the shape is created first and moved
 * onto the centre afterwards, against the bounds it actually has.
 *
 * `above` always centres, since it is only ever asked for to put a title over
 * something. `below` centres when it is given a list, or alongside `centerOn`;
 * a bare single key keeps the left-edge placement `box` has always had.
 */
export interface CenterOptions {
  /**
   * Centre horizontally on the union bounds of these shapes, at the `y` given.
   * Overrides which shapes `above` and `below` centre on.
   */
  centerOn?: ShapeKey | readonly ShapeKey[];
  /** Sit `gap` clear above the union bounds of these shapes, centred on them. */
  above?: ShapeKey | readonly ShapeKey[];
}

/** Options for {@link makeText}. */
export interface TextOptions
  extends Omit<BoxOptions, "geo" | "fill" | "align" | "verticalAlign" | "h" | "dash" | "below">,
    CenterOptions {
  /** Horizontal alignment of the text itself, default `start`. */
  textAlign?: TLDefaultTextAlignStyle;
  /**
   * Sit `gap` clear under a shape. One key shares its left edge, the way
   * `box` does; a list uses the union bounds of all of them and centres on it.
   */
  below?: ShapeKey | readonly ShapeKey[];
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

/** One key, or a list of them, as a list. */
function keyList(spec: ShapeKey | readonly ShapeKey[]): readonly ShapeKey[] {
  return typeof spec === "string" ? [spec] : spec;
}

/** The union of the page bounds of every shape named. */
function unionOf(editor: Editor, spec: ShapeKey | readonly ShapeKey[], what: string): Rect {
  const keys = keyList(spec);
  if (keys.length === 0) {
    throw new Error(`tldrawkc: ${what} was given an empty list of shapes to sit against`);
  }
  const bounds = unionRects(keys.map((key) => pageRect(editor, key)));
  if (!bounds) throw new Error(`tldrawkc: ${what} found no bounds to sit against`);
  return bounds;
}

/**
 * Where a label wants to end up, in page coordinates, once it has been measured.
 *
 * Held as an intent rather than a position because none of it can be turned
 * into an `x` and a `y` until the shape exists: centring needs the shape's
 * measured width, and `above` needs its measured height.
 */
interface Anchoring {
  /** Bounds whose horizontal centre the shape's own centre should land on. */
  center?: Rect;
  /** Page y the shape's top edge should land on. */
  top?: number;
  /** Page y the shape's bottom edge should land on. */
  bottom?: number;
}

/**
 * Read `centerOn`, `above` and `below` into an {@link Anchoring}, or `null`
 * when the caller asked for none of it and the ordinary placement rules apply.
 *
 * A single-key `below` with no `centerOn` returns `null` on purpose: that is
 * `box`'s left-edge placement, which `resolvePosition` has always handled and
 * which existing snippets depend on.
 */
function labelAnchoring(
  editor: Editor,
  opts: TextOptions,
  what: string,
): Anchoring | null {
  const { centerOn, above, below } = opts;
  const belowCentres =
    below !== undefined && (Array.isArray(below) || centerOn !== undefined);
  if (above === undefined && centerOn === undefined && !belowCentres) return null;
  if (above !== undefined && below !== undefined) {
    throw new Error(`tldrawkc: ${what} cannot sit both above and below something`);
  }

  const gap = opts.gap ?? DEFAULT_GAP;
  const anchoring: Anchoring = {};
  if (above !== undefined) {
    anchoring.bottom = unionOf(editor, above, what).y - gap;
  } else if (belowCentres && below !== undefined) {
    const bounds = unionOf(editor, below, what);
    anchoring.top = bounds.y + bounds.h + gap;
  }

  // `centerOn` wins, then whichever of the two placed it vertically. A caller
  // that named neither is centring on `centerOn` alone, at its own `y`.
  const centreSpec = centerOn ?? above ?? (belowCentres ? below : undefined);
  if (centreSpec !== undefined) anchoring.center = unionOf(editor, centreSpec, what);
  return anchoring;
}

/** Somewhere to create the shape before it can be measured and moved properly. */
function provisionalPoint(anchoring: Anchoring, opts: TextOptions): { x: number; y: number } {
  const center = anchoring.center;
  return {
    x: center !== undefined ? center.x + center.w / 2 : (opts.x ?? 0),
    y: anchoring.top ?? opts.y ?? anchoring.bottom ?? 0,
  };
}

/**
 * Move a shape onto its anchoring, now that tldraw has measured it.
 *
 * The delta is worked out in page coordinates and then pushed back through the
 * parent's transform, because a shape's own `x` and `y` are in its parent's
 * space and the two stop agreeing as soon as a frame is rotated.
 */
function applyAnchoring(editor: Editor, id: TLShapeId, anchoring: Anchoring): void {
  const shape = editor.getShape(id);
  const bounds = editor.getShapePageBounds(id);
  if (!shape || !bounds) return;

  const dx = anchoring.center !== undefined ? centerXOffset(anchoring.center, bounds) : 0;
  let dy = 0;
  if (anchoring.top !== undefined) dy = anchoring.top - bounds.y;
  else if (anchoring.bottom !== undefined) dy = anchoring.bottom - bounds.h - bounds.y;
  if (dx === 0 && dy === 0) return;

  let local = { x: dx, y: dy };
  if (shape.parentId.startsWith("shape:")) {
    const transform = editor.getShapePageTransform(shape.parentId as TLShapeId);
    if (transform) {
      const inverse = transform.clone().invert();
      const origin = inverse.applyToPoint({ x: 0, y: 0 });
      const moved = inverse.applyToPoint({ x: dx, y: dy });
      local = { x: moved.x - origin.x, y: moved.y - origin.y };
    }
  }
  editor.updateShape({ id, type: shape.type, x: shape.x + local.x, y: shape.y + local.y });
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
export function toParentSpace(
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
 * `centerOn`, `above` and `below` place it against other shapes, and are
 * settled after the shape exists so the centring uses the width tldraw
 * measured rather than the width that was asked for.
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
  const what = `text "${String(key)}"`;
  const anchoring = labelAnchoring(editor, opts, what);
  const position =
    anchoring !== null
      ? provisionalPoint(anchoring, opts)
      : resolvePosition(editor, opts as BoxOptions, existing !== undefined, what);

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
  if (anchoring !== null) applyAnchoring(editor, id, anchoring);
  return id;
}

/**
 * Options for {@link makeNote}. A note sizes itself, so there is no `w` or `h`.
 *
 * It takes the same `centerOn`, `above` and `below` placement `text` does,
 * which is worth more here than there: a note has no width to compute with at
 * all, since tldraw picks one from `size` and then grows the note downwards.
 */
export interface NoteOptions
  extends Omit<BoxOptions, "geo" | "fill" | "dash" | "w" | "h" | "below">,
    CenterOptions {
  /**
   * Sit `gap` clear under a shape. One key shares its left edge, the way
   * `box` does; a list uses the union bounds of all of them and centres on it.
   */
  below?: ShapeKey | readonly ShapeKey[];
}

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
  const what = `note "${String(key)}"`;
  const anchoring = labelAnchoring(editor, opts, what);
  const resolved =
    anchoring !== null
      ? provisionalPoint(anchoring, opts)
      : resolvePosition(editor, opts as BoxOptions, existing !== undefined, what);
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
  if (anchoring !== null) applyAnchoring(editor, id, anchoring);
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
