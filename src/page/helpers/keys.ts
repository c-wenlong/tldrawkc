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

/** The separator between the two halves of a derived arrow key. */
const JOIN = "->";

/**
 * The key for the arrow joining two shapes: `arrow:<from>-><to>`, and so the
 * shape id `shape:arrow:agent->page`.
 *
 * Deriving it from the pair is what makes `connect` idempotent. `->` is the
 * separator because it cannot be mistaken for part of a shape key the way a
 * dash can: `a-b` to `c` and `a` to `b-c` would collide under a dash. A second
 * arrow between the same pair needs an explicit `opts.id`.
 *
 * A key that contains `->` itself is refused rather than encoded. `a->b` to
 * `c` and `a` to `b->c` would both derive `arrow:a->b->c`, and since `connect`
 * rebinds an arrow it finds by id, the second call would silently steal the
 * first one's arrow. Escaping would hide that in a derived id nobody can read,
 * so say so instead: the caller wants a different key, or an explicit
 * `opts.id`.
 *
 * @example
 * connectionKey('agent', 'page')   // 'arrow:agent->page'
 */
export function connectionKey(fromKey: string, toKey: string): string {
  const from = stripShapePrefix(fromKey);
  const to = stripShapePrefix(toKey);
  for (const [key, role] of [[from, "from"], [to, "to"]] as const) {
    if (key.includes(JOIN)) {
      throw new Error(
        `tldrawkc: connect's ${role} key "${key}" contains "${JOIN}", which is the separator in a derived arrow id. Rename the shape, or pass an explicit opts.id for the arrow.`,
      );
    }
  }
  return `arrow:${from}${JOIN}${to}`;
}
