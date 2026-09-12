/**
 * The pieces of `doctor` that do not need a browser.
 *
 * `isFontUrl` is the one worth pinning down: the failure it exists to catch is
 * tldraw asking for a bare font key (`tldraw_draw`) because nothing supplied a
 * URL for it, which 404s and then silently renders in a system font. A check
 * that only matched `.woff2` would miss exactly that case.
 */

import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { doctor, isFontUrl, MINIMUM_NODE_MAJOR } from "../../src/lib/doctor.js";

describe("isFontUrl", () => {
  it("matches real font files", () => {
    expect(isFontUrl("http://127.0.0.1:1/assets/Shantell_Sans-Informal_Regular-DT813UET.woff2")).toBe(true);
    expect(isFontUrl("/assets/x.woff")).toBe(true);
    expect(isFontUrl("/assets/x.TTF")).toBe(true);
    expect(isFontUrl("/assets/x.otf")).toBe(true);
  });

  it("matches tldraw's bare font-key fallback", () => {
    expect(isFontUrl("http://127.0.0.1:1/tldraw_draw")).toBe(true);
    expect(isFontUrl("http://127.0.0.1:1/tldraw_mono_italic_bold")).toBe(true);
  });

  it("leaves everything else alone", () => {
    expect(isFontUrl("http://127.0.0.1:1/assets/index.js")).toBe(false);
    expect(isFontUrl("http://127.0.0.1:1/index.html")).toBe(false);
    expect(isFontUrl("http://127.0.0.1:1/assets/0_merged.svg")).toBe(false);
  });
});

describe("write access", () => {
  it("passes in a writable directory and fails in one that is not there", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tldrawkc-doctor-"));
    try {
      // The browser checks are skipped by pointing at a Chromium that does not
      // exist: this test is about the write probe, and launching a real
      // browser here would make a unit test a minute long.
      const good = await doctor({ cwd: dir, chromium: "/definitely/not/a/browser" });
      const write = good.checks.find((check) => check.name === "write access");
      expect(write?.status).toBe("pass");

      const bad = await doctor({
        cwd: path.join(dir, "does", "not", "exist", "\0"),
        chromium: "/definitely/not/a/browser",
      });
      expect(bad.checks.find((check) => check.name === "write access")?.status).toBe("fail");
      expect(bad.ok).toBe(false);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("reports every check by name", async () => {
    const report = await doctor({ chromium: "/definitely/not/a/browser" });
    expect(report.checks.map((check) => check.name)).toEqual([
      "node",
      "page bundle",
      "chromium",
      "page load",
      "fonts",
      "write access",
    ]);
    // No browser means the page cannot be opened, and doctor says so rather
    // than pretending the page is fine.
    expect(report.checks.find((check) => check.name === "page load")?.status).toBe("fail");
    expect(report.ok).toBe(false);
  });
});

describe("node floor", () => {
  it("matches engines.node", () => {
    expect(MINIMUM_NODE_MAJOR).toBe(22);
  });
});
