/**
 * Turning the short, readable keys snippets write into tldraw record ids.
 *
 * Every helper takes a plain string (`'agent'`, `'query'`) rather than a
 * `TLShapeId`, because that is what makes a snippet re-runnable: the same key
 * resolves to the same record, so a second run updates instead of piling up
 * duplicates (HELPERS.md, `box`). A caller that already holds a real id can
 * pass it straight back in and it is left alone.
 */

import { createShapeId, type TLShapeId } from "tldraw";

import { stripShapePrefix } from "./keys.js";

/**
 * A shape key or a real shape id. Helpers accept either.
 *
 * @example
 * const id = helpers.box('agent', 'agent cli', { x: 0, y: 0 })
 * helpers.connect(id, 'page')   // by id, or by key, both work
 */
export type ShapeKey = string | TLShapeId;

/**
 * Resolve a key to a shape id. `'agent'` becomes `shape:agent`; an id that is
 * already prefixed is returned unchanged.
 *
 * @example
 * toShapeId('agent')        // 'shape:agent'
 * toShapeId('shape:agent')  // 'shape:agent'
 */
export function toShapeId(key: ShapeKey): TLShapeId {
  return createShapeId(stripShapePrefix(key));
}

/**
 * What a record's `meta` may hold.
 *
 * tldraw validates `meta` as JSON, so the type is spelled out here rather than
 * as `Record<string, unknown>`: `unknown` compiles and then fails at runtime on
 * the first value that cannot be serialised. Written locally rather than
 * imported from `@tldraw/utils`, which is a transitive dependency this package
 * does not declare.
 */
export type MetaValue =
  | string
  | number
  | boolean
  | null
  | MetaValue[]
  | { [key: string]: MetaValue | undefined };

/** Arbitrary JSON-safe record metadata. `lintIgnore` lives here. */
export type ShapeMeta = Record<string, MetaValue | undefined>;
