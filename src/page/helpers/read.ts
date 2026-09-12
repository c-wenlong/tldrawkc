/**
 * Reading what is already on the canvas.
 *
 * Two jobs. `describeEditor` builds the `inspect()` structure, which is the
 * one definition of "what is on this page" and what both the bridge and
 * `helpers.describe()` hand back. `collectLintRecords` reduces the same page
 * to the plain records the lint rules take, and is the one place the browser's
 * text measurement happens, because a rule that needed an `Editor` could not
 * run in the node unit suite.
 */

import {
  getFontFamily,
  renderPlaintextFromRichText,
  type Editor,
  type Geometry2d,
  type Group2d,
  type TLDefaultFontStyle,
  type TLDefaultSizeStyle,
  type TLRichText,
  type TLShape,
} from "tldraw";

import type { Lint, LintBinding, LintShape } from "./lints.js";
import { runLints } from "./lints.js";
import type { Rect } from "./geometry.js";
import { toShapeId, type ShapeKey } from "./ids.js";

/** One shape as `inspect` reports it. */
export interface InspectShape {
  id: string;
  type: string;
  /** Present only on geo shapes. */
  geo?: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** The label's plain text, or `null` when the shape has none. */
  text: string | null;
  parentId: string;
}

/** One arrow binding pair as `inspect` reports it. */
export interface InspectBinding {
  arrow: string;
  from: string | null;
  to: string | null;
  fromAnchor: { x: number; y: number } | null;
  toAnchor: { x: number; y: number } | null;
}

/** The "read the canvas" structure, defined by the table in ARCHITECTURE.md. */
export interface InspectResult {
  pages: string[];
  page: string;
  bounds: Rect | null;
  shapes: InspectShape[];
  bindings: InspectBinding[];
  lints: Lint[];
}

/**
 * Label metrics tldraw keeps `@internal`, copied here rather than imported.
 *
 * They are not on the public `tldraw` entry point, and the alternative is
 * guessing at a label's size, which is exactly what running in a browser was
 * meant to stop. Source:
 * `node_modules/tldraw/src/lib/shapes/shared/default-shape-constants.ts`,
 * checked against tldraw 5.4.2. `getFontFamily` is public and is imported.
 */
const LABEL_FONT_SIZES: Record<TLDefaultSizeStyle, number> = {
  s: 1.125,
  m: 1.375,
  l: 1.625,
  xl: 2,
};

/** The same table for arrow labels, which tldraw sizes slightly differently. */
const ARROW_LABEL_FONT_SIZES: Record<TLDefaultSizeStyle, number> = {
  s: 1.125,
  m: 1.25,
  l: 1.5,
  xl: 1.75,
};

/** Padding inside a geo or note label box, per side. */
const LABEL_PADDING = 16;
/** Padding inside an arrow label box, per side. */
const ARROW_LABEL_PADDING = 4.25;

/** The style block tldraw measures its own labels with. */
const TEXT_PROPS = {
  fontWeight: "normal",
  fontStyle: "normal",
  padding: "0px",
} as const;

function richTextOf(shape: TLShape): TLRichText | undefined {
  const props: unknown = shape.props;
  if (typeof props !== "object" || props === null) return undefined;
  const richText = (props as { richText?: unknown }).richText;
  return richText === undefined ? undefined : (richText as TLRichText);
}

function propOf<T>(shape: TLShape, key: string): T | undefined {
  const props: unknown = shape.props;
  if (typeof props !== "object" || props === null) return undefined;
  return (props as Record<string, unknown>)[key] as T | undefined;
}

/**
 * The visible text of a shape, read from its rich text.
 *
 * Use this rather than reaching into `props.richText`, which is a ProseMirror
 * document and not a string. A shape with no text at all answers `''`.
 */
export function plainTextOf(editor: Editor, shape: ShapeKey | TLShape): string {
  const record = typeof shape === "string" ? editor.getShape(toShapeId(shape)) : shape;
  if (!record) return "";
  const richText = richTextOf(record);
  if (!richText) return "";
  return renderPlaintextFromRichText(editor, richText);
}

function isGroup(geometry: Geometry2d): geometry is Group2d {
  return Array.isArray((geometry as { children?: unknown }).children);
}

/**
 * The label rectangle inside a shape, in page coordinates.
 *
 * Both `GeoShapeUtil` and `ArrowShapeUtil` put a `Rectangle2d` with
 * `isLabel: true` in the group they return from `getGeometry`, which is where
 * the label actually lands after alignment and wrapping. Reading it beats
 * re-deriving it: `overlapping-text` is about what a reader sees.
 */
function labelBoundsOf(editor: Editor, shape: TLShape): Rect | undefined {
  const geometry = editor.getShapeGeometry(shape);
  if (!isGroup(geometry)) return undefined;
  const label = geometry.children.find((child) => child.isLabel);
  if (!label) return undefined;
  const transform = editor.getShapePageTransform(shape.id);
  // All four, not the two on one diagonal: under rotation those two do not
  // bound the rectangle, and at 45 degrees a square label's pair even shares
  // an x, which collapses the box to zero width and hides every overlap.
  const corners = [
    transform.applyToPoint({ x: label.bounds.minX, y: label.bounds.minY }),
    transform.applyToPoint({ x: label.bounds.maxX, y: label.bounds.minY }),
    transform.applyToPoint({ x: label.bounds.maxX, y: label.bounds.maxY }),
    transform.applyToPoint({ x: label.bounds.minX, y: label.bounds.maxY }),
  ];
  const xs = corners.map((point) => point.x);
  const ys = corners.map((point) => point.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return { x: minX, y: minY, w: Math.max(...xs) - minX, h: Math.max(...ys) - minY };
}

/**
 * How wide this shape's label actually wants to be, in page units.
 *
 * Not "how wide on one line", which every wrapped label would fail, but "how
 * wide is the widest thing that cannot be broken": the browser measures the
 * text at the shape's own inner width with word-break turned off and
 * `measureScrollWidth` on, so a label that wraps politely at its spaces
 * reports the shape's width and a single word longer than the box reports that
 * word. tldraw does break such a word, mid-word and without a hyphen, which is
 * the unreadable case worth a finding. Padding is added back so the result
 * compares directly against the shape's width.
 */
function labelWidthOf(editor: Editor, shape: TLShape, boundsWidth: number): number | undefined {
  const text = plainTextOf(editor, shape);
  if (text.trim().length === 0) return undefined;
  const size = propOf<TLDefaultSizeStyle>(shape, "size");
  const font = propOf<TLDefaultFontStyle>(shape, "font");
  if (size === undefined || font === undefined) return undefined;

  const theme = editor.getCurrentTheme();
  const isArrow = shape.type === "arrow";
  const padding = isArrow ? ARROW_LABEL_PADDING : LABEL_PADDING;
  const fontSize =
    theme.fontSize * (isArrow ? ARROW_LABEL_FONT_SIZES[size] : LABEL_FONT_SIZES[size]);

  const measured = editor.textMeasure.measureText(text, {
    ...TEXT_PROPS,
    fontFamily: getFontFamily(theme, font),
    fontSize,
    lineHeight: theme.lineHeight,
    maxWidth: Math.max(1, boundsWidth - padding * 2),
    measureScrollWidth: true,
    disableOverflowWrapBreaking: true,
  });
  return Math.max(measured.w, measured.scrollWidth) + padding * 2;
}

/**
 * An arrow's rendered path, in page coordinates.
 *
 * `ArrowShapeUtil.getGeometry` returns a `Group2d` whose one non-label child
 * is the body: an `Edge2d` for a straight arrow, a `Polyline2d` of the route
 * for an elbow, or an `Arc2d` for a bend. `Geometry2d`'s `vertices` getter
 * asks for them with labels excluded, so this is the line itself and not the
 * box the label sits in, and an arc arrives already sampled into a polyline.
 * The transform is what puts it in page space, which is the vocabulary the
 * lint rules work in.
 */
function arrowPathOf(editor: Editor, shape: TLShape): { x: number; y: number }[] {
  const transform = editor.getShapePageTransform(shape.id);
  return editor.getShapeGeometry(shape).vertices.map((vertex) => {
    const point = transform.applyToPoint(vertex);
    return { x: point.x, y: point.y };
  });
}

/**
 * Does this shape resize itself to whatever its text needs?
 *
 * An auto-sized `text` shape does, and a `note` shrinks its font instead of
 * overflowing. Neither can ever produce an unreadable label, so neither should
 * be measured against its own width.
 */
function growsToFit(shape: TLShape): boolean {
  if (shape.type === "note") return true;
  if (shape.type === "text") return propOf<boolean>(shape, "autoSize") !== false;
  return false;
}

/**
 * Everything on the current page, reduced to the plain records the lint rules
 * take. This is the one place the live editor is turned into lintable data,
 * which is what keeps `lints.ts` free of any tldraw import.
 */
export function collectLintRecords(editor: Editor): {
  shapes: LintShape[];
  bindings: LintBinding[];
} {
  const pageShapes = editor.getCurrentPageShapes();
  const shapes: LintShape[] = pageShapes.map((shape) => {
    const box = editor.getShapePageBounds(shape.id);
    const bounds: Rect | undefined = box
      ? { x: box.x, y: box.y, w: box.w, h: box.h }
      : undefined;
    const text = plainTextOf(editor, shape);
    const record: LintShape = {
      id: shape.id,
      type: shape.type,
      meta: shape.meta,
      text,
      parentId: shape.parentId,
    };
    if (bounds) record.bounds = bounds;
    if (shape.type === "arrow") {
      const path = arrowPathOf(editor, shape);
      if (path.length >= 2) record.points = path;
    }
    const label = labelBoundsOf(editor, shape);
    if (label) record.labelBounds = label;
    const geo = propOf<string>(shape, "geo");
    if (geo !== undefined) record.geo = geo;
    const fill = propOf<string>(shape, "fill");
    if (fill !== undefined) record.fill = fill;
    // The shape's own width, unrotated, which is the room its label has.
    // `bounds` is the axis-aligned page box and says something else as soon as
    // anything is turned.
    const own = editor.getShapeGeometry(shape).bounds.width;
    if (Number.isFinite(own)) record.shapeWidth = own;
    if (growsToFit(shape)) record.growsToFit = true;
    else if (Number.isFinite(own)) {
      const width = labelWidthOf(editor, shape, own);
      if (width !== undefined) record.labelWidth = width;
    }
    return record;
  });

  const bindings: LintBinding[] = [];
  for (const shape of pageShapes) {
    if (shape.type !== "arrow") continue;
    for (const binding of editor.getBindingsFromShape(shape.id, "arrow")) {
      bindings.push({
        type: binding.type,
        fromId: binding.fromId,
        toId: binding.toId,
        props: { terminal: binding.props.terminal },
      });
    }
  }
  return { shapes, bindings };
}

/** Run the whole lint pass over the current page. */
export function lintPage(editor: Editor): Lint[] {
  const { shapes, bindings } = collectLintRecords(editor);
  return runLints(shapes, bindings);
}

/**
 * The `inspect()` structure: every page name, the current page, the union
 * bounds, every shape with its page bounds and plain text, every arrow binding
 * pair, and the lint findings.
 *
 * One implementation, two callers: the bridge's `inspect()` and
 * `helpers.describe()`. A snippet calls the second to decide what to do next
 * without a round trip back to Node.
 */
export function describeEditor(editor: Editor): InspectResult {
  const shapes = editor.getCurrentPageShapes();

  const bindings: InspectBinding[] = [];
  for (const shape of shapes) {
    if (shape.type !== "arrow") continue;
    const arrowBindings = editor.getBindingsFromShape(shape.id, "arrow");
    const start = arrowBindings.find((b) => b.props.terminal === "start");
    const end = arrowBindings.find((b) => b.props.terminal === "end");
    bindings.push({
      arrow: shape.id,
      from: start?.toId ?? null,
      to: end?.toId ?? null,
      fromAnchor: start ? { ...start.props.normalizedAnchor } : null,
      toAnchor: end ? { ...end.props.normalizedAnchor } : null,
    });
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const described: InspectShape[] = shapes.map((shape) => {
    const box = editor.getShapePageBounds(shape.id);
    if (box) {
      minX = Math.min(minX, box.x);
      minY = Math.min(minY, box.y);
      maxX = Math.max(maxX, box.x + box.w);
      maxY = Math.max(maxY, box.y + box.h);
    }
    const geo = propOf<string>(shape, "geo");
    const text = plainTextOf(editor, shape);
    return {
      id: shape.id,
      type: shape.type,
      ...(geo !== undefined ? { geo } : {}),
      x: box?.x ?? shape.x,
      y: box?.y ?? shape.y,
      w: box?.w ?? 0,
      h: box?.h ?? 0,
      text: text === "" ? null : text,
      parentId: shape.parentId,
    };
  });

  return {
    pages: editor.getPages().map((page) => page.name),
    page: editor.getCurrentPage().name,
    bounds: Number.isFinite(minX)
      ? { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
      : null,
    shapes: described,
    bindings,
    lints: lintPage(editor),
  };
}
