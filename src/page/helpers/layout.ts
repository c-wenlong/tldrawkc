/**
 * Moving shapes that already exist: `row`, `column`, `grid`, `boxShapes`,
 * `translate` and `fitCamera`.
 *
 * Every one of these reads `getShapePageBounds` rather than `props.w` and
 * `props.h`, because tldraw grows a geo shape past its `h` when the label
 * wraps, and laying out against the declared height leaves overlaps that only
 * show up in the picture.
 */

import { type Editor, type TLShapeId } from "tldraw";

import { unionRects, type Rect } from "./geometry.js";
import { toShapeId, type ShapeKey, type ShapeMeta } from "./ids.js";
import { makeBox, type BoxOptions } from "./shapes.js";

/** Default gap between shapes laid out in a line or a grid, in page units. */
export const DEFAULT_LAYOUT_GAP = 40;
/** Default margin between a container's edge and the shapes it holds. */
export const DEFAULT_CONTAINER_MARGIN = 40;
/** Extra headroom at the top of a container, so its label clears its members. */
export const CONTAINER_LABEL_HEADROOM = 24;

/** Which edge, or the middle, the shapes in a row or column line up on. */
export type Align = "start" | "center" | "end";

/** Options for {@link layoutRow} and {@link layoutColumn}. */
export interface LineOptions {
  /** Gap between neighbours, default 40. */
  gap?: number;
  /** Alignment on the cross axis, default `start`. */
  align?: Align;
  /** Where the line begins. Defaults to the first shape's current position. */
  x?: number;
  y?: number;
}

/** Options for {@link layoutGrid}. */
export interface GridOptions {
  /** Horizontal gap, default 40. */
  gapX?: number;
  /** Vertical gap, default 40. */
  gapY?: number;
  /** Top-left of the grid. Defaults to the first shape's current position. */
  x?: number;
  y?: number;
}

/** Options for {@link boxShapes}. */
export interface BoxShapesOptions {
  /** Container label. An unlabelled container is a plain grouping mark. */
  label?: string;
  /** Distance from the container's edge to the outermost shape, default 40. */
  margin?: number;
  /** Outline colour, default `grey`. */
  color?: BoxOptions["color"];
  /** Outline style, default `draw`. */
  dash?: BoxOptions["dash"];
  /** Label size, default `s`. */
  size?: BoxOptions["size"];
  /** The container's own key. Derived from the label when omitted. */
  shapeId?: string;
  /** Extra metadata. `container: true` is always set on top of it. */
  meta?: ShapeMeta;
}

/** Options for {@link fitCamera}. */
export interface FitCameraOptions {
  /** Room to leave around the shapes. Without it this is a plain `zoomToFit`. */
  padding?: number;
}

function boundsOf(editor: Editor, key: ShapeKey, what: string): Rect {
  const id = toShapeId(key);
  const box = editor.getShapePageBounds(id);
  if (!box) {
    throw new Error(`tldrawkc: ${what} cannot include "${String(key)}" because no such shape exists`);
  }
  return { x: box.x, y: box.y, w: box.w, h: box.h };
}

/**
 * Move a shape so its page bounds land at `(x, y)`.
 *
 * The difference matters: a shape's `x` is its own origin, and its page bounds
 * can start somewhere else once tldraw has grown it or a parent has offset it.
 * Every layout helper here places bounds, not origins.
 */
function moveBoundsTo(editor: Editor, id: TLShapeId, box: Rect, x: number, y: number): void {
  const shape = editor.getShape(id);
  if (!shape) return;
  editor.updateShape({
    id,
    type: shape.type,
    x: shape.x + (x - box.x),
    y: shape.y + (y - box.y),
  });
}

function crossOffset(align: Align, extent: number, own: number): number {
  if (align === "center") return (extent - own) / 2;
  if (align === "end") return extent - own;
  return 0;
}

/**
 * Lay shapes out left to right and return their ids in order.
 *
 * The line starts at the first shape's current top-left unless `x` and `y` say
 * otherwise, so "line these up" does not also move them across the page.
 */
export function layoutRow(
  editor: Editor,
  keys: readonly ShapeKey[],
  opts: LineOptions = {},
): TLShapeId[] {
  const gap = opts.gap ?? DEFAULT_LAYOUT_GAP;
  const align = opts.align ?? "start";
  const boxes = keys.map((key) => ({ id: toShapeId(key), box: boundsOf(editor, key, "row") }));
  const first = boxes[0];
  if (!first) return [];

  const tallest = boxes.reduce((most, entry) => Math.max(most, entry.box.h), 0);
  let x = opts.x ?? first.box.x;
  const top = opts.y ?? first.box.y;
  for (const { id, box } of boxes) {
    moveBoundsTo(editor, id, box, x, top + crossOffset(align, tallest, box.h));
    x += box.w + gap;
  }
  return boxes.map((entry) => entry.id);
}

/** Lay shapes out top to bottom and return their ids in order. */
export function layoutColumn(
  editor: Editor,
  keys: readonly ShapeKey[],
  opts: LineOptions = {},
): TLShapeId[] {
  const gap = opts.gap ?? DEFAULT_LAYOUT_GAP;
  const align = opts.align ?? "start";
  const boxes = keys.map((key) => ({ id: toShapeId(key), box: boundsOf(editor, key, "column") }));
  const first = boxes[0];
  if (!first) return [];

  const widest = boxes.reduce((most, entry) => Math.max(most, entry.box.w), 0);
  const left = opts.x ?? first.box.x;
  let y = opts.y ?? first.box.y;
  for (const { id, box } of boxes) {
    moveBoundsTo(editor, id, box, left + crossOffset(align, widest, box.w), y);
    y += box.h + gap;
  }
  return boxes.map((entry) => entry.id);
}

/**
 * Lay shapes out in rows of `cols` and return their ids in order.
 *
 * Columns are as wide as their widest member and rows as tall as their tallest,
 * so a ragged set still lines up on both axes.
 */
export function layoutGrid(
  editor: Editor,
  keys: readonly ShapeKey[],
  cols: number,
  opts: GridOptions = {},
): TLShapeId[] {
  if (!Number.isFinite(cols) || cols < 1) {
    throw new Error("tldrawkc: grid needs at least one column");
  }
  const gapX = opts.gapX ?? DEFAULT_LAYOUT_GAP;
  const gapY = opts.gapY ?? DEFAULT_LAYOUT_GAP;
  const boxes = keys.map((key) => ({ id: toShapeId(key), box: boundsOf(editor, key, "grid") }));
  const first = boxes[0];
  if (!first) return [];

  const columns = Math.floor(cols);
  const colWidth: number[] = [];
  const rowHeight: number[] = [];
  boxes.forEach((entry, index) => {
    const c = index % columns;
    const r = Math.floor(index / columns);
    colWidth[c] = Math.max(colWidth[c] ?? 0, entry.box.w);
    rowHeight[r] = Math.max(rowHeight[r] ?? 0, entry.box.h);
  });

  const left = opts.x ?? first.box.x;
  const top = opts.y ?? first.box.y;
  boxes.forEach((entry, index) => {
    const c = index % columns;
    const r = Math.floor(index / columns);
    let x = left;
    for (let i = 0; i < c; i++) x += (colWidth[i] ?? 0) + gapX;
    let y = top;
    for (let i = 0; i < r; i++) y += (rowHeight[i] ?? 0) + gapY;
    moveBoundsTo(editor, entry.id, entry.box, x, y);
  });
  return boxes.map((entry) => entry.id);
}

/**
 * Draw a labelled container behind a set of shapes and return its id.
 *
 * A geo rectangle sent to the back, not a frame, so the shapes inside keep
 * their page coordinates and nothing has to be reparented. It carries
 * `meta.container = true`, which is how the lint pass knows to exempt it from
 * `overlapping-shapes` and `empty-label`. The label sits in the top-left
 * corner with a little headroom above the members, so it never lands on one.
 */
export function boxShapes(
  editor: Editor,
  keys: readonly ShapeKey[],
  opts: BoxShapesOptions = {},
): TLShapeId {
  if (keys.length === 0) {
    throw new Error("tldrawkc: boxShapes needs at least one shape to draw around");
  }
  const margin = opts.margin ?? DEFAULT_CONTAINER_MARGIN;
  const label = opts.label ?? "";
  const headroom = label.length > 0 ? CONTAINER_LABEL_HEADROOM : 0;

  const inner = unionRects(keys.map((key) => boundsOf(editor, key, "boxShapes")));
  if (!inner) throw new Error("tldrawkc: boxShapes found no bounds to draw around");

  const key =
    opts.shapeId ??
    `container:${label.length > 0 ? label.replace(/\s+/gu, "-").toLowerCase() : String(keys[0])}`;

  const id = makeBox(editor, key, label, {
    x: inner.x - margin,
    y: inner.y - margin - headroom,
    w: inner.w + margin * 2,
    h: inner.h + margin * 2 + headroom,
    geo: "rectangle",
    color: opts.color ?? "grey",
    dash: opts.dash ?? "draw",
    size: opts.size ?? "s",
    fill: "none",
    align: "start",
    verticalAlign: "start",
    meta: { ...opts.meta, container: true },
  });
  editor.sendToBack([id]);
  return id;
}

/**
 * Move shapes by `(dx, dy)` and return their ids.
 *
 * Arrows drawn with `connect` follow on their own, because they are bound to
 * the shapes rather than parked at remembered coordinates. Moving an arrow
 * itself does nothing for the same reason, so bound arrows are dropped from
 * the list rather than nudged into an inconsistent state.
 */
export function translate(
  editor: Editor,
  keys: readonly ShapeKey[],
  dx: number,
  dy: number,
): TLShapeId[] {
  const moved: TLShapeId[] = [];
  for (const key of keys) {
    const id = toShapeId(key);
    const shape = editor.getShape(id);
    if (!shape) {
      throw new Error(`tldrawkc: translate cannot move "${String(key)}" because no such shape exists`);
    }
    if (shape.type === "arrow" && editor.getBindingsFromShape(id, "arrow").length > 0) continue;
    editor.updateShape({ id, type: shape.type, x: shape.x + dx, y: shape.y + dy });
    moved.push(id);
  }
  return moved;
}

/**
 * Fit the camera to every shape on the page and return the bounds it framed.
 *
 * With no options this is `editor.zoomToFit()`. With `padding` it computes the
 * page bounds and calls `zoomToBounds(bounds, { inset })`, because `zoomToFit`
 * itself takes no padding. Exports frame to shape bounds on their own, so this
 * matters only for a `--headed` run and for serve mode.
 */
export function fitCamera(editor: Editor, opts: FitCameraOptions = {}): Rect | null {
  if (opts.padding === undefined) {
    editor.zoomToFit();
  } else {
    const bounds = editor.getCurrentPageBounds();
    if (!bounds) return null;
    editor.zoomToBounds(bounds, { inset: opts.padding });
  }
  const framed = editor.getCurrentPageBounds();
  return framed ? { x: framed.x, y: framed.y, w: framed.w, h: framed.h } : null;
}
