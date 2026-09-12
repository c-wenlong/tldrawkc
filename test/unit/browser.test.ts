import { describe, expect, it } from "vitest";

import {
  BRIDGE_TIMEOUT_MS,
  ChromiumNotFoundError,
  EXEC_TIMEOUT_MS,
  installedBrowserPaths,
  isOffHost,
  resolveChromium,
} from "../../src/lib/browser.js";
import { EXIT_CODES } from "../../src/lib/errors.js";

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

describe("isOffHost", () => {
  const origin = "http://127.0.0.1:51234";

  it("accepts anything on the page server's origin", () => {
    expect(isOffHost(`${origin}/index.html`, origin)).toBe(false);
    expect(isOffHost(`${origin}/assets/font.woff2`, origin)).toBe(false);
  });

  it("accepts inline schemes, which are not network requests", () => {
    expect(isOffHost("data:image/png;base64,AAAA", origin)).toBe(false);
    expect(isOffHost("blob:http://127.0.0.1:51234/abc", origin)).toBe(false);
    expect(isOffHost("about:blank", origin)).toBe(false);
  });

  it("catches a request that left 127.0.0.1", () => {
    // Layering rule 8. A font fetched from a CDN is the failure this guards.
    expect(isOffHost("https://fonts.googleapis.com/css", origin)).toBe(true);
    expect(isOffHost("http://127.0.0.1:9999/other", origin)).toBe(true);
    expect(isOffHost("http://localhost:51234/index.html", origin)).toBe(true);
  });

  it("treats an unparseable URL as off host", () => {
    expect(isOffHost("://nonsense", origin)).toBe(true);
  });
});

describe("timeouts", () => {
  it("matches the numbers table in ARCHITECTURE.md", () => {
    expect(BRIDGE_TIMEOUT_MS).toBe(15_000);
    expect(EXEC_TIMEOUT_MS).toBe(30_000);
  });
});

describe("ChromiumNotFoundError", () => {
  it("carries the exit code the CLI should use", () => {
    expect(new ChromiumNotFoundError([]).exitCode).toBe(EXIT_CODES.usage);
  });
});
