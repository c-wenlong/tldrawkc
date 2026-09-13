/// <reference types="vite/client" />

import type { Bridge } from "./bridge.js";
import type { MirrorHandle } from "./mirror.js";

declare global {
  /**
   * The tldrawkc version, injected by `vite.config.ts` from package.json.
   *
   * The page has no filesystem access (layering rule 2), so the version it
   * reports through `ping` has to be baked in at build time.
   */
  const __TLDRAWKC_VERSION__: string;

  interface Window {
    /** The bridge Node calls through `page.evaluate`. */
    __tldrawkc?: Bridge;
    /**
     * The mirror tab's read-only observation window, present only under
     * `?mirror=1`. See `MirrorHandle` in `mirror.tsx`.
     */
    __tldrawkcMirror?: MirrorHandle;
  }
}

export {};
