/**
 * The helpers bag, the second of the three names a snippet gets.
 *
 * `editor` is full power with no guard rails and `tldraw` is the module; this
 * is the vocabulary in between, and the one an agent should reach for first
 * because it is what keeps arrows bound and ids stable (HELPERS.md).
 *
 * **This file is the reference.** Every helper is declared here as a named
 * function with a one-line summary and an `@example` written the way a snippet
 * would call it, and the `api` command generates the printed reference from
 * exactly these blocks. The functions the bag delegates to live in the sibling
 * files and are not part of that surface, so a helper missing from here is a
 * hole in the docs even if the behaviour exists.
 */

import type { Editor, TLShape, TLShapeId } from "tldraw";

import {
  clearPage,
  makeBox,
  makeNote,
  makeText,
  removeShapes,
  type BoxOptions,
  type ClearOptions,
  type NoteOptions,
  type TextOptions,
} from "./shapes.js";
import {
  makeAttribute,
  makeConnection,
  makeLine,
  makeStub,
  type AttributeOptions,
  type ConnectOptions,
  type DrawLineOptions,
} from "./connect.js";
import {
  alignContainers as alignContainersTo,
  boxShapes as containerAround,
  fitCamera as fitCameraTo,
  layoutColumn,
  layoutGrid,
  layoutRow,
  translate as translateShapes,
  type AlignContainersOptions,
  type BoxShapesOptions,
  type FitCameraOptions,
  type GridOptions,
  type LineOptions,
} from "./layout.js";
import { describeEditor, documentMeta, lintPage, plainTextOf, type InspectResult } from "./read.js";
import { patchedBag, type DiagramMeta, type MetaPatch } from "./meta.js";
import { parseMermaid, type ParseMermaidOptions } from "./mermaid.js";
import { applyPlan, type ApplyPlanOptions, type ApplyPlanResult } from "./mermaid-apply.js";
import type { Lint } from "./lints.js";
import type { Rect, Side } from "./geometry.js";
import type { ShapeKey } from "./ids.js";

export type {
  BoxOptions,
  CenterOptions,
  ClearOptions,
  NoteOptions,
  TextOptions,
} from "./shapes.js";
export type {
  AttributeOptions,
  ConnectOptions,
  AnchorSpec,
  DrawLineOptions,
  HeadSpec,
} from "./connect.js";
export type {
  AlignContainersOptions,
  BoxShapesOptions,
  FitCameraOptions,
  GridOptions,
  LineOptions,
} from "./layout.js";
export type { InspectResult, InspectShape, InspectBinding } from "./read.js";
export type { ApplyPlanOptions, ApplyPlanResult } from "./mermaid-apply.js";
export { connectionKey } from "./keys.js";
export type { Lint, LintShape, LintBinding } from "./lints.js";
export type { ShapeKey, ShapeMeta, MetaValue } from "./ids.js";
export type { DiagramMeta, MetaPatch } from "./meta.js";
export { META_KEY, META_VERSION } from "./meta.js";

/** Options for `helpers.mermaid`: the parser's, plus the layout pass's. */
export interface MermaidOptions extends ParseMermaidOptions, ApplyPlanOptions {}

/** What a snippet sees as `helpers`. Built by {@link createHelpers}. */
export interface Helpers {
  box(key: ShapeKey, label: string, opts?: BoxOptions): TLShapeId;
  text(key: ShapeKey, str: string, opts?: TextOptions): TLShapeId;
  note(key: ShapeKey, str: string, opts?: NoteOptions): TLShapeId;
  remove(keys: ShapeKey | readonly ShapeKey[]): number;
  clear(opts?: ClearOptions): number;
  connect(from: ShapeKey, to: ShapeKey, opts?: ConnectOptions): TLShapeId;
  attribute(
    owner: ShapeKey,
    label: string,
    side: Side,
    opts?: AttributeOptions,
  ): { textId: TLShapeId; lineId: TLShapeId };
  line(
    key: ShapeKey,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    opts?: DrawLineOptions,
  ): TLShapeId;
  stub(
    key: ShapeKey,
    x: number,
    y: number,
    dx: number,
    dy: number,
    opts?: DrawLineOptions,
  ): TLShapeId;
  row(keys: readonly ShapeKey[], opts?: LineOptions): TLShapeId[];
  column(keys: readonly ShapeKey[], opts?: LineOptions): TLShapeId[];
  grid(keys: readonly ShapeKey[], cols: number, opts?: GridOptions): TLShapeId[];
  boxShapes(keys: readonly ShapeKey[], opts?: BoxShapesOptions): TLShapeId;
  alignContainers(keys: readonly ShapeKey[], opts?: AlignContainersOptions): TLShapeId[];
  translate(keys: readonly ShapeKey[], dx: number, dy: number): TLShapeId[];
  fitCamera(opts?: FitCameraOptions): Rect | null;
  plainText(shape: ShapeKey | TLShape): string;
  describe(): InspectResult;
  getLints(): Lint[];
  meta(patch?: MetaPatch): DiagramMeta | null;
  mermaid(source: string, opts?: MermaidOptions): ApplyPlanResult;
}

/** A bag plus the hook the bridge uses to tell it a new snippet has started. */
export interface HelpersHandle {
  helpers: Helpers;
  /**
   * Called by the bridge immediately before each `exec`. It records whether the
   * current page was empty, which is the whole definition of "this snippet
   * created the document" that `clear` checks.
   */
  beginExec(): void;
}

/**
 * Build the bag for one editor.
 *
 * Called once when the bridge installs, so a snippet's `helpers` is the same
 * object every time and can be captured. Each helper is a named function
 * closing over `editor`, which is what puts its doc block directly above a
 * `function name(` line for the `api` command to find.
 */
export function createHelpers(editor: Editor): HelpersHandle {
  // Which pages held nothing when the snippet started, by page id. One boolean
  // was not enough: a snippet that starts on an empty page can call
  // `editor.setCurrentPage` and then `clear()` on a page full of someone
  // else's work, and the single flag would have said yes.
  let emptyAtStart = new Set<string>();

  /**
   * Create or update a labelled geo shape and return its id.
   *
   * The id comes from the key, so re-running a snippet updates the same box
   * rather than duplicating it. Place it absolutely with `x` and `y`, or
   * relative to another shape with `after` or `below` and a `gap`.
   *
   * @example
   * helpers.box('q', 'query', { x: 60, y: 60 })
   * @example
   * helpers.box('k', 'key', { after: 'q', gap: 120, geo: 'diamond' })
   */
  function box(key: ShapeKey, label: string, opts?: BoxOptions): TLShapeId {
    return makeBox(editor, key, label, opts);
  }

  /**
   * Create or update a standalone text shape and return its id.
   *
   * For headings and free labels only. Words that belong to a shape go in that
   * shape's label, where they move with it.
   *
   * Three ways to place it against other shapes instead of at a coordinate:
   * `centerOn: ids` centres it horizontally on their union bounds at the `y`
   * given, `above: ids` puts it `gap` clear over them and centres it, and
   * `below: ids` puts it `gap` clear under them. All three are settled after
   * the shape exists, so a heading that wrapped is centred by the width tldraw
   * measured rather than the width it was asked for. A single key in `below`
   * still shares that shape's left edge, the way `box` does.
   *
   * @example
   * helpers.text('title', 'the render loop', { x: 60, y: 0, size: 'l' })
   * @example
   * helpers.text('title', 'two ways to read it', { above: ['left', 'right'], gap: 40, size: 'l' })
   */
  function text(key: ShapeKey, str: string, opts?: TextOptions): TLShapeId {
    return makeText(editor, key, str, opts);
  }

  /**
   * Create or update a sticky note and return its id.
   *
   * For asides and "why" callouts beside a teaching diagram. A note sizes
   * itself from `size` and grows to fit its text, so it takes no `w` or `h`.
   *
   * It takes `text`'s `centerOn`, `above` and `below` placement too, which is
   * worth more here: a note has no width of its own to compute with at all.
   *
   * @example
   * helpers.note('why', 'the cache is what makes this cheap', { after: 'page', gap: 80 })
   * @example
   * helpers.note('aside', 'both panels hold the same arrow', { below: ['left', 'right'], gap: 60 })
   */
  function note(key: ShapeKey, str: string, opts?: NoteOptions): TLShapeId {
    return makeNote(editor, key, str, opts);
  }

  /**
   * Delete shapes by key or id and return how many actually went.
   *
   * A key that is not on the canvas is skipped rather than thrown on.
   *
   * @example
   * helpers.remove(['draft', 'scratch'])
   */
  function remove(keys: ShapeKey | readonly ShapeKey[]): number {
    return removeShapes(editor, keys);
  }

  /**
   * Delete every shape on the current page and return how many went.
   *
   * Refused unless this snippet created the document, or `force` is passed.
   * Created means this page held zero shapes when `exec` started, recorded per
   * page rather than once: a snippet that drew the whole picture may wipe it
   * and start again, a snippet handed someone else's diagram may not, and
   * switching pages mid-snippet must not launder the difference.
   *
   * @example
   * helpers.clear({ force: true })
   */
  function clear(opts: ClearOptions = {}): number {
    return clearPage(editor, opts, emptyAtStart.has(editor.getCurrentPageId()));
  }

  /**
   * Draw an arrow bound at both ends and return its id.
   *
   * The only sanctioned way to draw a meaningful arrow: both terminals get a
   * real binding, so the arrow follows its shapes through any relayout.
   *
   * @example
   * helpers.connect('q', 'k', { label: 'scores', kind: 'elbow' })
   * @example
   * helpers.connect('png', 'agent', { start: 'left', end: 'bottom', dash: 'dashed' })
   */
  function connect(from: ShapeKey, to: ShapeKey, opts?: ConnectOptions): TLShapeId {
    return makeConnection(editor, from, to, opts);
  }

  /**
   * Write a short label off one side of a box, joined by a bound line with no
   * arrowhead, and return both ids.
   *
   * The ERD convenience. `at` (0..1) spaces several attributes along the same
   * side and `gap` is the stub length.
   *
   * @example
   * helpers.attribute('user', 'email', 'right', { at: 0.25, gap: 70 })
   */
  function attribute(
    owner: ShapeKey,
    label: string,
    side: Side,
    opts?: AttributeOptions,
  ): { textId: TLShapeId; lineId: TLShapeId } {
    return makeAttribute(editor, owner, label, side, opts);
  }

  /**
   * Draw an unbound line from one page point to another and return its id.
   *
   * The mark for geometry that is not a connection: an axis, a vector, a tick,
   * a rule under a heading. Anything that joins two shapes is `connect`
   * instead, which binds and so survives a relayout.
   *
   * `opts`: `color`, `size`, `dash`, `head` (`none` default, `end`, `start`,
   * `both`), `kind` (`arc` default, `elbow`), `bend` (arc only), `label`,
   * `labelColor`, `parent`, `meta`, and `lintIgnore`. It mutes
   * `friendless-arrow` and `arrow-crosses-shape` by default, because neither
   * means anything for a mark that was never claiming to join two shapes; pass
   * `lintIgnore: []` to have it linted like any other arrow. The id comes from
   * the key the same way `box`'s does, so re-running a snippet moves the line
   * rather than stacking a second one on it.
   *
   * @example
   * helpers.line('axis-x', 260, 700, 640, 700, { color: 'blue', head: 'end' })
   * @example
   * helpers.line('guide', 340, 460, 340, 700, { dash: 'dashed', size: 's' })
   */
  function line(
    key: ShapeKey,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    opts?: DrawLineOptions,
  ): TLShapeId {
    return makeLine(editor, key, x1, y1, x2, y2, opts);
  }

  /**
   * `line` with a delta instead of a second point, and the same options.
   *
   * `(x, y)` is where it starts and `(dx, dy)` is how far it runs, which is the
   * convenient form for the loose marks in a legend.
   *
   * @example
   * helpers.stub('legend-dash', 60, 400, 48, 0, { dash: 'dashed', color: 'red' })
   */
  function stub(
    key: ShapeKey,
    x: number,
    y: number,
    dx: number,
    dy: number,
    opts?: DrawLineOptions,
  ): TLShapeId {
    return makeStub(editor, key, x, y, dx, dy, opts);
  }

  /**
   * Lay existing shapes out left to right and return their ids in order.
   *
   * The line starts where the first shape already is, unless `x` and `y` say
   * otherwise, so lining shapes up does not also move them across the page.
   *
   * @example
   * helpers.row(['q', 'k', 'v'], { gap: 60, align: 'center' })
   */
  function row(keys: readonly ShapeKey[], opts?: LineOptions): TLShapeId[] {
    return layoutRow(editor, keys, opts);
  }

  /**
   * Lay existing shapes out top to bottom and return their ids in order.
   *
   * @example
   * helpers.column(['input', 'hidden', 'output'], { gap: 80, align: 'center' })
   */
  function column(keys: readonly ShapeKey[], opts?: LineOptions): TLShapeId[] {
    return layoutColumn(editor, keys, opts);
  }

  /**
   * Lay existing shapes out in rows of `cols` and return their ids in order.
   *
   * @example
   * helpers.grid(['a', 'b', 'c', 'd'], 2, { gapX: 60, gapY: 40 })
   */
  function grid(keys: readonly ShapeKey[], cols: number, opts?: GridOptions): TLShapeId[] {
    return layoutGrid(editor, keys, cols, opts);
  }

  /**
   * Draw a labelled container behind a set of shapes and return its id.
   *
   * A geo rectangle sent to the back, not a frame, so the shapes inside keep
   * their page coordinates. It carries `meta.container = true`, which is how
   * the lint pass knows to exempt it from `overlapping-shapes`, `empty-label`
   * and `arrow-crosses-shape`.
   *
   * `opts`: `label`, `margin` (default 40), `color`, `dash`, `size`,
   * `shapeId`, `meta`, `minW` and `minH` for a floor on the size, and
   * `matchSize: otherContainerId` to end up the same size as another
   * container. Both grow to the larger width and the larger height, each
   * keeping its own top-left, so two panels being compared read as two panels.
   *
   * @example
   * helpers.boxShapes(['png', 'svg'], { label: 'exports', margin: 40 })
   * @example
   * helpers.boxShapes(['b1', 'b2'], { label: 'after', matchSize: 'container:before' })
   */
  function boxShapes(keys: readonly ShapeKey[], opts?: BoxShapesOptions): TLShapeId {
    return containerAround(editor, keys, opts);
  }

  /**
   * Put every listed container on one size and return their ids.
   *
   * The size is the largest width and the largest height across the list,
   * taken independently, and each container keeps its own top-left, so nothing
   * that fitted before stops fitting. Two panels drawn round different numbers
   * of shapes otherwise come out visibly different sizes and a reader takes the
   * difference for meaning. `opts.axis` is `both` (default), `x` to match only
   * the widths, or `y` for only the heights. Every container is sent to the
   * back again afterwards, so it stays behind its members.
   *
   * @example
   * helpers.alignContainers(['container:before', 'container:after'])
   * @example
   * helpers.alignContainers(['left', 'middle', 'right'], { axis: 'y' })
   */
  function alignContainers(
    keys: readonly ShapeKey[],
    opts?: AlignContainersOptions,
  ): TLShapeId[] {
    return alignContainersTo(editor, keys, opts);
  }

  /**
   * Move shapes by `(dx, dy)` and return the ids that moved.
   *
   * Arrows drawn with `connect` follow on their own, because they are bound to
   * their shapes rather than parked at remembered coordinates.
   *
   * @example
   * helpers.translate(['png', 'svg'], 0, 120)
   */
  function translate(keys: readonly ShapeKey[], dx: number, dy: number): TLShapeId[] {
    return translateShapes(editor, keys, dx, dy);
  }

  /**
   * Fit the camera to every shape and return the bounds it framed.
   *
   * With no options this is `editor.zoomToFit()`; with `padding` it zooms to
   * the page bounds with that inset, because `zoomToFit` takes no padding.
   * Exports frame themselves, so this matters only for a headed run.
   *
   * @example
   * helpers.fitCamera({ padding: 48 })
   */
  function fitCamera(opts?: FitCameraOptions): Rect | null {
    return fitCameraTo(editor, opts);
  }

  /**
   * The visible text of a shape, read from its rich text.
   *
   * @example
   * helpers.plainText('q')   // 'query'
   */
  function plainText(shape: ShapeKey | TLShape): string {
    return plainTextOf(editor, shape);
  }

  /**
   * Everything on the current page: the same structure `inspect` prints.
   *
   * Pages, the current page, the union bounds, every shape with its page
   * bounds and text, every arrow binding, and the lint findings. Call it to
   * decide what to do next without a second CLI round trip.
   *
   * @example
   * const { shapes, lints } = helpers.describe()
   */
  function describe(): InspectResult {
    return describeEditor(editor);
  }

  /**
   * Run the lint pass over the current page and return the findings. Seven
   * rules: `friendless-arrow`, `arrow-crosses-shape`, `overlapping-text`,
   * `overlapping-shapes`, `off-page`, `empty-label` and `unreadable-label`.
   *
   * `meta.lintIgnore` on a shape mutes a rule for it: an array of rule names,
   * or `true` for all of them.
   *
   * @example
   * return helpers.getLints()
   */
  function getLints(): Lint[] {
    return lintPage(editor);
  }

  /**
   * Read or amend the document metadata: what this diagram is about.
   *
   * With no argument it reads. With a patch it merges, so a snippet can add a
   * concept without restating the title. `topic` and each `concept` must be a
   * slug from the shared vocabulary; `created` is written once and then left
   * alone. It lands on the document record, so `save` carries it into the
   * `.tldr` and `inspect --json` reads it back out.
   *
   * @example
   * helpers.meta({ topic: 'dot-product', concepts: ['vector-as-a-list-of-numbers'] })
   * @example
   * const topic = helpers.meta()?.topic ?? '(none)'
   */
  function meta(patch?: MetaPatch): DiagramMeta | null {
    if (patch === undefined) return documentMeta(editor);
    const next = patchedBag(
      editor.getDocumentSettings().meta,
      patch,
      new Date().toISOString(),
    );
    editor.updateDocumentSettings({ meta: next.bag });
    return next.meta;
  }

  /**
   * Parse a mermaid flowchart and draw it: boxes, bound arrows, and a
   * container behind each subgraph.
   *
   * `parseMermaid` then `applyPlan`. The layout is laid out a second time
   * against the bounds tldraw actually produced, because a wrapped label grows
   * its box and the parser could only guess. Anything the parser could not read
   * comes back in `unsupported` rather than being dropped.
   *
   * @example
   * const { nodes, edges, containers, unsupported } = helpers.mermaid(source, { direction: 'LR' })
   */
  function mermaid(source: string, opts: MermaidOptions = {}): ApplyPlanResult {
    // `spacing` is the parser's name for the same two numbers `applyPlan`
    // calls `rankGap` and `nodeGap`. The re-spacing pass runs after the plan,
    // so without this it would throw away the gaps the caller just asked for
    // and lay the diagram out at the defaults.
    const apply: MermaidOptions = {
      ...opts,
      ...(opts.rankGap === undefined && opts.spacing?.rank !== undefined
        ? { rankGap: opts.spacing.rank }
        : {}),
      ...(opts.nodeGap === undefined && opts.spacing?.node !== undefined
        ? { nodeGap: opts.spacing.node }
        : {}),
    };
    return applyPlan(editor, parseMermaid(source, opts), apply);
  }

  const helpers: Helpers = {
    box,
    text,
    note,
    remove,
    clear,
    connect,
    attribute,
    line,
    stub,
    row,
    column,
    grid,
    boxShapes,
    alignContainers,
    translate,
    fitCamera,
    plainText,
    describe,
    getLints,
    meta,
    mermaid,
  };

  return {
    helpers,
    beginExec: () => {
      emptyAtStart = new Set(
        editor
          .getPages()
          .filter((page) => editor.getSortedChildIdsForParent(page.id).length === 0)
          .map((page) => page.id),
      );
    },
  };
}
