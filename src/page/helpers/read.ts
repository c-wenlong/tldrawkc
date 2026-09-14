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
  type TLDefaultHorizontalAlignStyle,
  type TLDefaultSizeStyle,
  type TLRichText,
  type TLShape,
} from "tldraw";

import type { Lint, LintBinding, LintShape } from "./lints.js";
import { heightForLabel, runLints, usableWidthAtBand } from "./lints.js";
import { readDocumentMeta, type DiagramMeta } from "./meta.js";
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
  /**
   * The document metadata, or `null` when the file carries none.
   *
   * Read from the live store rather than from the file Node already has, so
   * what `inspect` prints is what tldraw actually loaded. A bag a migration
   * dropped shows up here as `null`, which is the failure worth seeing.
   */
  meta: DiagramMeta | null;
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
 * The widest line the label renders as, with no padding, in the shape's own
 * coordinate space.
 *
 * `labelWidthOf` cannot answer this and is not trying to. Its measurement is a
 * `div` with a `max-width`, so CSS shrink-to-fit reports the smaller of the
 * text's one-line width and that maximum: a label that wraps at all comes back
 * as exactly the width it was allowed, never as the width it used. That is the
 * right number for "is a word about to be broken" and useless for "does the
 * text reach the outline".
 *
 * `measureTextSpans` lays the text out and hands back a box per run of
 * characters, which is how tldraw reproduces the browser's own line breaking in
 * an SVG export. Grouping those by their top edge gives the real lines, and the
 * widest of them is what a reader sees reaching furthest across the shape.
 * Whitespace spans are dropped, because a trailing space is not ink.
 *
 * The centre comes back with the width, because `align: 'start'` and
 * `align: 'end'` push a label to one side of the bounding box and a width alone
 * cannot see that. Spans are positioned against the measurement element's own
 * left edge, which sits one label padding inside the shape whichever alignment
 * is in play: the element is the shape's width less both paddings and carries
 * the shape's `text-align`, so it starts and ends exactly where tldraw's own
 * narrower label rectangle does.
 */
function labelInkOf(
  editor: Editor,
  shape: TLShape,
  boundsWidth: number,
): { width: number; centre: number } | undefined {
  const text = plainTextOf(editor, shape);
  if (text.trim().length === 0) return undefined;
  const size = propOf<TLDefaultSizeStyle>(shape, "size");
  const font = propOf<TLDefaultFontStyle>(shape, "font");
  if (size === undefined || font === undefined) return undefined;

  const theme = editor.getCurrentTheme();
  const spans = editor.textMeasure.measureTextSpans(text, {
    overflow: "wrap",
    width: boundsWidth,
    height: Math.max(1, boundsWidth),
    padding: LABEL_PADDING,
    fontSize: theme.fontSize * LABEL_FONT_SIZES[size],
    fontWeight: TEXT_PROPS.fontWeight,
    fontStyle: TEXT_PROPS.fontStyle,
    fontFamily: getFontFamily(theme, font),
    lineHeight: theme.lineHeight,
    textAlign: propOf<TLDefaultHorizontalAlignStyle>(shape, "align") ?? "middle",
  });

  // Keyed on the top edge, which is what puts two spans on the same line.
  const lines = new Map<number, { from: number; to: number }>();
  for (const span of spans) {
    if (span.text.trim().length === 0) continue;
    const key = Math.round(span.box.y);
    const line = lines.get(key);
    if (line) {
      line.from = Math.min(line.from, span.box.x);
      line.to = Math.max(line.to, span.box.x + span.box.w);
    } else {
      lines.set(key, { from: span.box.x, to: span.box.x + span.box.w });
    }
  }
  let widest: { from: number; to: number } | undefined;
  for (const line of lines.values()) {
    if (!widest || line.to - line.from > widest.to - widest.from) widest = line;
  }
  if (!widest) return undefined;
  const width = widest.to - widest.from;
  if (!(width > 0)) return undefined;
  return { width, centre: LABEL_PADDING + (widest.from + widest.to) / 2 };
}

/**
 * How much room the outline leaves the label and how much the label wants, in
 * the shape's own coordinate space, or `undefined` when the outline leaves the
 * label all of it.
 *
 * `unreadable-label` used to compare against the shape's width, which is the
 * bounding box, and a diamond only ever reaches its bounding box width along
 * one line through its middle. The label rectangle cannot answer this either,
 * because `GeoShapeUtil.getGeometry` clamps it to the shape and so can never
 * report a size the shape does not have. So the question is put to the rendered
 * outline instead: take the rows the text occupies and ask how wide the shape
 * is across them, around the point the text is actually centred on.
 *
 * The rows are the label rectangle less its own padding, because that padding
 * is whitespace: a diamond's corners eating into it is not something a reader
 * can see, and it is the ink crossing the outline that is the finding. The
 * rectangle's own position is what carries `verticalAlign`, so `start`,
 * `middle` and `end` need no case of their own on that axis.
 *
 * The chord is measured twice, cheaply first and then around the ink, so that a
 * shape whose outline gives the label its full width never pays for
 * {@link labelInkOf}, which is the most expensive measurement in the pass. That
 * shortcut is safe because a label always sits at least one padding inside the
 * bounding box, so where the outline is the box no alignment can push it out.
 * Such a shape answers `undefined`, the rule has nothing extra to check, and
 * that is every rectangle: the case this must not change.
 */
function outlineFitOf(
  editor: Editor,
  shape: TLShape,
  boundsWidth: number,
): { usableWidth: number; labelInkWidth: number } | undefined {
  if (shape.type !== "geo") return undefined;
  const geometry = editor.getShapeGeometry(shape);
  if (!isGroup(geometry)) return undefined;
  const label = geometry.children.find((child) => child.isLabel);
  const body = geometry.children.find((child) => !child.isLabel);
  // An open path has no inside to measure across, which is every arrow and is
  // why this is geo only in the first place.
  if (!label || !body?.isClosed) return undefined;
  const outline = body.vertices.map((vertex) => ({ x: vertex.x, y: vertex.y }));
  if (outline.length < 3) return undefined;

  const top = label.bounds.minY + LABEL_PADDING;
  const bottom = label.bounds.maxY - LABEL_PADDING;
  const widest = usableWidthAtBand(outline, top, bottom);
  if (!Number.isFinite(widest) || widest <= 0 || widest >= boundsWidth) return undefined;

  const ink = labelInkOf(editor, shape, boundsWidth);
  if (ink === undefined) return undefined;
  const usable = usableWidthAtBand(outline, top, bottom, ink.centre);
  if (!Number.isFinite(usable)) return undefined;
  return { usableWidth: usable, labelInkWidth: ink.width };
}

/**
 * How many widths wider than the one it has {@link boxForLabelOf} will try.
 *
 * The sweep only ever grows: the parser's width is already the room a reader
 * needs to read the words, and a narrower box would only wrap them harder.
 */
const FIT_WIDTH_STEPS = 12;

/** How much wider each step of that sweep is. Twelve of these is about 4x. */
const FIT_WIDTH_GROWTH = 1.12;

/** How tall this label's block of text is at a given width, with no padding. */
function textHeightOf(editor: Editor, shape: TLShape, width: number): number | undefined {
  const text = plainTextOf(editor, shape);
  if (text.trim().length === 0) return undefined;
  const size = propOf<TLDefaultSizeStyle>(shape, "size");
  const font = propOf<TLDefaultFontStyle>(shape, "font");
  if (size === undefined || font === undefined) return undefined;
  const theme = editor.getCurrentTheme();
  return editor.textMeasure.measureText(text, {
    ...TEXT_PROPS,
    fontFamily: getFontFamily(theme, font),
    fontSize: theme.fontSize * LABEL_FONT_SIZES[size],
    lineHeight: theme.lineHeight,
    maxWidth: Math.max(1, width - LABEL_PADDING * 2),
  }).h;
}

/**
 * The size this geo needs so its label's ink sits inside its outline, in the
 * shape's own coordinate space, or `undefined` when it cannot be measured.
 *
 * The same measurements {@link outlineFitOf} makes for `unreadable-label`, put
 * to {@link heightForLabel} the other way round: the rule asks how much room an
 * outline leaves the ink, and this asks how big the outline has to be to leave
 * enough. Sizing a shape and judging one therefore read the same geometry, and
 * the mermaid importer cannot hand a diamond a box the rule then refuses.
 *
 * It is a sweep over widths rather than one answer, because a label is not a
 * fixed thing: tldraw wraps it at the shape's width, so a wider shape holds the
 * same words on fewer, longer lines. Widening a diamond to fit the ink it has
 * therefore lets the ink spread, and chasing that from the inside grows a
 * flowchart node into a flat lozenge four times the width of anything around
 * it. Measured at a width instead, both numbers are honest, and the cheapest
 * box wins: the sweep takes the smallest `w + h`, which is what a rank of a
 * flowchart actually pays for a node.
 *
 * The height at each width comes from the outline, so a width no height can
 * rescue drops out of the sweep rather than having to be guarded against.
 * Nothing is ever narrowed, and a box already big enough answers itself.
 */
export function boxForLabelOf(
  editor: Editor,
  shape: TLShape,
): { w: number; h: number } | undefined {
  if (shape.type !== "geo") return undefined;
  const geometry = editor.getShapeGeometry(shape);
  if (!isGroup(geometry)) return undefined;
  const body = geometry.children.find((child) => !child.isLabel);
  if (!body?.isClosed) return undefined;
  const outline = body.vertices.map((vertex) => ({ x: vertex.x, y: vertex.y }));
  if (outline.length < 3) return undefined;

  const start = geometry.bounds.width;
  const tall = geometry.bounds.height;
  if (!Number.isFinite(start) || start <= 0 || !Number.isFinite(tall)) return undefined;

  const fits = (width: number): number | undefined => {
    // The label is measured at the width being considered, never at the one the
    // shape happens to have, which is the whole point of sweeping.
    const ink = labelInkOf(editor, shape, width);
    const height = textHeightOf(editor, shape, width);
    if (ink === undefined || height === undefined) return undefined;
    return heightForLabel(outline, { width: ink.width, height }, width, LABEL_PADDING);
  };

  // A shape that already holds its label answers with itself. Every rectangle
  // lands here, and so does a diamond somebody sized generously: the sweep is
  // for a box that is wrong, and resizing one that is right would be the
  // importer overruling the author over nothing.
  const here = fits(start);
  if (here !== undefined && here <= tall) return { w: start, h: tall };

  let best: { w: number; h: number } | undefined;
  for (let step = 0; step <= FIT_WIDTH_STEPS; step++) {
    const width = Math.ceil(start * FIT_WIDTH_GROWTH ** step);
    const needed = fits(width);
    if (needed === undefined) continue;
    const box = { w: width, h: Math.ceil(needed) };
    if (best === undefined || box.w + box.h < best.w + best.h) best = box;
  }
  return best;
}

/**
 * A shape's own geometry vertices, in page coordinates.
 *
 * On an arrow this is the rendered path: `ArrowShapeUtil.getGeometry` returns
 * a `Group2d` whose one non-label child is the body, an `Edge2d` for a
 * straight arrow, a `Polyline2d` of the route for an elbow, or an `Arc2d` for
 * a bend. On a geo or a note it is the outline: four corners for a rectangle
 * or a diamond, a polygon for an ellipse. Either way `Geometry2d`'s `vertices`
 * getter asks with labels excluded, so the label box never joins the path, and
 * an arc arrives already sampled into a polyline. The transform is what puts
 * it in page space, which is the vocabulary the lint rules work in.
 */
function pageVerticesOf(editor: Editor, shape: TLShape): { x: number; y: number }[] {
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
      const path = pageVerticesOf(editor, shape);
      if (path.length >= 2) record.points = path;
    } else if (shape.type === "geo" || shape.type === "note") {
      // For `arrow-crosses-shape`, which judges a diamond on its diamond
      // rather than on the page box whose corners it leaves empty.
      const outline = pageVerticesOf(editor, shape);
      if (outline.length >= 3) record.outline = outline;
    }
    const label = labelBoundsOf(editor, shape);
    if (label) record.labelBounds = label;
    const geo = propOf<string>(shape, "geo");
    if (geo !== undefined) record.geo = geo;
    // For `missing-glyph`, which asks whether this family has the characters
    // the label is made of. Every label-bearing shape carries it.
    const font = propOf<string>(shape, "font");
    if (font !== undefined) record.font = font;
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
      // The outline check, which says nothing at all on a plain box.
      const fit = outlineFitOf(editor, shape, own);
      if (fit !== undefined) {
        record.usableWidth = fit.usableWidth;
        record.labelInkWidth = fit.labelInkWidth;
      }
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

/** The document metadata tldraw currently holds, or `null` when there is none. */
export function documentMeta(editor: Editor): DiagramMeta | null {
  return readDocumentMeta(editor.getDocumentSettings().meta);
}

/**
 * Run the whole lint pass over the current page and the document.
 *
 * The document is passed in every time, which is what lets `missing-topic`
 * fire. Both it and `missing-glyph` are warnings, so neither changes an exit
 * code on its own.
 */
export function lintPage(editor: Editor): Lint[] {
  const { shapes, bindings } = collectLintRecords(editor);
  return runLints(shapes, bindings, { meta: documentMeta(editor) });
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
    meta: documentMeta(editor),
  };
}
