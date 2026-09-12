/**
 * `window.__tldrawkc`, the surface Node calls through `page.evaluate`.
 *
 * Every function takes and returns JSON-safe values, so the same surface can
 * back a future MCP entry without a translation layer (DECISIONS.md D6).
 *
 * Layering rule 2: nothing here touches the filesystem or the network. The
 * page receives strings and returns strings; Node does the IO.
 *
 * Phase 0 installs `ping` only. `load`, `exec`, `save`, `shot`, `svg`,
 * `inspect`, `lints`, `setPage` and `zoomToFit` are specified in
 * ARCHITECTURE.md and arrive with phases 1 and 2.
 */

import type { Editor } from "tldraw";

/** What `ping` answers once the editor has mounted. */
export interface PingResult {
  ok: true;
  /** The tldrawkc version the bundle was built from. */
  version: string;
}

export interface Bridge {
  /**
   * Answers only after the editor has mounted, which is what makes it a
   * readiness signal rather than a liveness one. `doctor` and
   * `lib/browser.ts` poll for it.
   */
  ping(): PingResult;
}

/**
 * Install the bridge. Called from the `<Tldraw onMount>` callback, so by the
 * time `window.__tldrawkc` exists there is a live `Editor` behind it.
 */
export function installBridge(editor: Editor): Bridge {
  const bridge: Bridge = {
    ping: () => ({ ok: true, version: __TLDRAWKC_VERSION__ }),
  };
  // Held for the verbs that land in phase 1; naming it here keeps the
  // signature of installBridge stable when they do.
  void editor;
  window.__tldrawkc = bridge;
  return bridge;
}
