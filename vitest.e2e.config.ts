/**
 * The end-to-end suite: real Chromium, real page, real files.
 *
 * Two files, and the split is deliberate. `node-side.test.ts` drives the
 * library against a stand-in bridge, so a failure there is a failure in
 * `src/lib`. `cli.test.ts` spawns the built binary against the real page
 * bundle, so a failure there is the page or the wiring. Between them, a red
 * run says which half to open.
 *
 * `passWithNoTests` is gone on purpose: an empty e2e run is now a broken
 * checkout, not a green one.
 */

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The unit config takes test/unit/**, this one takes test/e2e/**, and
    // neither can pick up the other's files.
    include: ["test/e2e/**/*.test.ts"],
    environment: "node",
    // A command launches Chromium, so an e2e test is seconds, not milliseconds.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
