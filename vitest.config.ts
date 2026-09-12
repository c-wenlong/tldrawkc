/** The unit suite: node only, no browser, fast enough to run on every save. */

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/unit/**/*.test.ts"],
    environment: "node",
  },
});
