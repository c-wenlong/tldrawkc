/**
 * The end-to-end suite: real Chromium, real page, real files.
 *
 * Empty in phase 0. The suite exists now so CI has the job wired up and
 * phase 1 only has to add test files. `passWithNoTests` is what keeps that
 * honest instead of green-by-accident: it is explicit, and it goes away with
 * the first real test.
 */

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/e2e/**/*.test.ts"],
    environment: "node",
    passWithNoTests: true,
    // A command launches Chromium, so an e2e test is seconds, not milliseconds.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
