/**
 * The one end-to-end test phase 0 can honestly make: a real browser starts.
 *
 * It is here so the CI job that runs `npx playwright install chromium
 * --with-deps` is exercising something, and so phase 1 only has to add test
 * files rather than build the suite. The drawing tests in ARCHITECTURE.md's
 * testing table arrive with the verbs they cover.
 */

import { describe, expect, it } from "vitest";
import { chromium } from "playwright-core";

import { resolveChromium } from "../../src/lib/browser.js";

describe("chromium", () => {
  it("resolves an executable that reports a version", async () => {
    const resolved = await resolveChromium();
    expect(resolved.executablePath).not.toBe("");
    expect(resolved.version).toMatch(/\d+\.\d+/);
  });

  it("launches and closes", async () => {
    const resolved = await resolveChromium();
    const browser = await chromium.launch({ executablePath: resolved.executablePath });
    try {
      expect(browser.version()).toMatch(/\d+\.\d+/);
    } finally {
      // Layering rule 7: a command never leaves a browser running.
      await browser.close();
    }
  });
});
