/**
 * The helpers bag, the second of the three names a snippet gets.
 *
 * `editor` is full power with no guard rails and `tldraw` is the module; this
 * is the vocabulary in between, and the one an agent should reach for first
 * because it is what keeps arrows bound and ids stable (HELPERS.md).
 *
 * Phase 1 ships `box`, `text`, `connect`, `plainText` and `getLints`. The
 * layout, import and container helpers arrive in phase 2 and are added here.
 *
 * Every exported function carries a one-line summary and an `@example`,
 * because phase 2's `api` command generates the printed reference from these
 * blocks and a missing one shows up as a hole in the docs.
 */

import type { Editor, TLShape, TLShapeId } from "tldraw";

import { makeBox, makeText, type BoxOptions, type TextOptions } from "./shapes.js";
import { makeConnection, type ConnectOptions } from "./connect.js";
import { collectLintRecords, plainTextOf } from "./read.js";
import { runLints, type Lint } from "./lints.js";
import type { ShapeKey } from "./ids.js";

export type { BoxOptions, TextOptions } from "./shapes.js";
export type { ConnectOptions, AnchorSpec, HeadSpec } from "./connect.js";
export { connectionKey } from "./keys.js";
export type { Lint, LintShape, LintBinding } from "./lints.js";
export type { ShapeKey, ShapeMeta, MetaValue } from "./ids.js";

/** What a snippet sees as `helpers`. */
export interface Helpers {
  /**
   * Create or update a labelled geo shape and return its id.
   *
   * @example
   * helpers.box('agent', 'agent cli', { x: 60, y: 60, w: 170, h: 64 })
   */
  box(key: ShapeKey, label: string, opts?: BoxOptions): TLShapeId;

  /**
   * Create or update a standalone text shape for a heading or a free label.
   *
   * @example
   * helpers.text('title', 'the render loop', { x: 60, y: 0, size: 'l' })
   */
  text(key: ShapeKey, str: string, opts?: TextOptions): TLShapeId;

  /**
   * Draw an arrow bound at both ends and return its id.
   *
   * @example
   * helpers.connect('agent', 'page', { label: 'exec', kind: 'elbow' })
   */
  connect(from: ShapeKey, to: ShapeKey, opts?: ConnectOptions): TLShapeId;

  /**
   * The visible text of a shape, read from its rich text.
   *
   * @example
   * helpers.plainText('agent')   // 'agent cli'
   */
  plainText(shape: ShapeKey | TLShape): string;

  /**
   * Run the lint pass over the current page and return the findings.
   *
   * @example
   * return helpers.getLints()
   */
  getLints(): Lint[];
}

/**
 * Build the bag for one editor. Called once when the bridge installs, so a
 * snippet's `helpers` is the same object every time and can be captured.
 */
export function createHelpers(editor: Editor): Helpers {
  return {
    box: (key, label, opts) => makeBox(editor, key, label, opts),
    text: (key, str, opts) => makeText(editor, key, str, opts),
    connect: (from, to, opts) => makeConnection(editor, from, to, opts),
    plainText: (shape) => plainTextOf(editor, shape),
    getLints: () => {
      const { shapes, bindings } = collectLintRecords(editor);
      return runLints(shapes, bindings);
    },
  };
}
