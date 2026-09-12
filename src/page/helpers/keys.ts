/**
 * The naming scheme for the records helpers create, kept free of any import.
 *
 * Ids are the mechanism behind "re-running a snippet updates instead of
 * duplicating" (HELPERS.md), so the derivation is worth checking in the unit
 * suite. Nothing here reaches for `tldraw`, which is what lets that suite run
 * in node.
 */

/** `shape:agent` becomes `agent`; `agent` is left alone. */
export function stripShapePrefix(key: string): string {
  return key.startsWith("shape:") ? key.slice("shape:".length) : key;
}

/**
 * The key for the arrow joining two shapes: `arrow:<from>-><to>`, and so the
 * shape id `shape:arrow:agent->page`.
 *
 * Deriving it from the pair is what makes `connect` idempotent. `->` is the
 * separator because it cannot be mistaken for part of a shape key the way a
 * dash can: `a-b` to `c` and `a` to `b-c` would collide under a dash. A second
 * arrow between the same pair needs an explicit `opts.id`.
 *
 * @example
 * connectionKey('agent', 'page')   // 'arrow:agent->page'
 */
export function connectionKey(fromKey: string, toKey: string): string {
  return `arrow:${stripShapePrefix(fromKey)}->${stripShapePrefix(toKey)}`;
}
