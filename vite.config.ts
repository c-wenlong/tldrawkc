/**
 * The browser bundle.
 *
 * `src/page` is its own little app: Vite is the only thing that builds it,
 * and it never shares a build with the node side (tsc does that, into the
 * same `dist/` but a different subdirectory).
 */

import { createRequire } from "node:module";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const require = createRequire(import.meta.url);
const pkg = require("./package.json") as { version: string };

export default defineConfig({
  root: "src/page",
  // Relative asset URLs. The page is served from a random port on 127.0.0.1
  // and, in serve mode, from a path that is not the origin root, so anything
  // absolute would break. It is also what makes the bundled fonts resolve
  // without a network round trip.
  base: "./",
  plugins: [react()],
  define: {
    // The page cannot read package.json at runtime, so the version `ping`
    // reports is baked in here.
    __TLDRAWKC_VERSION__: JSON.stringify(pkg.version),
  },
  build: {
    outDir: "../../dist/page",
    emptyOutDir: true,
    // The tldraw bundle is comfortably over Vite's 500 kB warning. Saying so
    // here keeps a normal build quiet enough that a real warning stands out.
    chunkSizeWarningLimit: 4096,
  },
});
