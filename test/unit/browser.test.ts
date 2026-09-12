import { describe, expect, it } from "vitest";

import {
  ChromiumNotFoundError,
  installedBrowserPaths,
  resolveChromium,
} from "../../src/lib/browser.js";

describe("installedBrowserPaths", () => {
  it("knows where macOS keeps browsers", () => {
    const paths = installedBrowserPaths("darwin");
    expect(paths[0]).toContain("Google Chrome.app");
    expect(paths.every((entry) => entry.startsWith("/Applications/"))).toBe(true);
  });

  it("knows where Linux keeps browsers", () => {
    const paths = installedBrowserPaths("linux");
    expect(paths).toContain("/usr/bin/google-chrome");
    expect(paths.every((entry) => entry.startsWith("/"))).toBe(true);
  });

  it("has nothing to suggest elsewhere, leaving --chromium as the answer", () => {
    expect(installedBrowserPaths("win32")).toEqual([]);
  });
});

describe("resolveChromium", () => {
  it("refuses rather than silently using a different browser when --chromium is wrong", async () => {
    // Falling through here would draw the diagram with an engine the caller
    // did not ask for, which is worse than failing.
    await expect(resolveChromium({ flag: "/definitely/not/a/browser" })).rejects.toThrow(
      ChromiumNotFoundError,
    );
  });

  it("says which knob was wrong", async () => {
    await expect(resolveChromium({ flag: "/definitely/not/a/browser" })).rejects.toThrow(
      /--chromium points at/,
    );
    await expect(
      resolveChromium({ env: { TLDRAWKC_CHROMIUM: "/definitely/not/a/browser" } }),
    ).rejects.toThrow(/TLDRAWKC_CHROMIUM points at/);
  });
});
