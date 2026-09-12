import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  DEFAULT_LIST_DIR,
  PACKAGE_ROOT,
  PAGE_DIST_DIR,
  PAGE_INDEX_HTML,
  PAGE_SRC_DIR,
  relativeToDir,
  resolveListDir,
  resolveTldrPath,
  siblingPath,
  tempShotPath,
  tempSiblingPath,
} from "../../src/lib/paths.js";

describe("PACKAGE_ROOT", () => {
  it("points at this package, not a parent or a subdirectory", () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8"),
    ) as { name: string };
    expect(manifest.name).toBe("tldrawkc");
  });

  it("puts the page bundle under dist and the page sources under src", () => {
    expect(PAGE_DIST_DIR).toBe(path.join(PACKAGE_ROOT, "dist", "page"));
    expect(PAGE_INDEX_HTML).toBe(path.join(PAGE_DIST_DIR, "index.html"));
    expect(PAGE_SRC_DIR).toBe(path.join(PACKAGE_ROOT, "src", "page"));
  });
});

describe("resolveTldrPath", () => {
  it("resolves a relative path against the given working directory", () => {
    expect(resolveTldrPath("a/b.tldr", "/work")).toBe(path.resolve("/work", "a/b.tldr"));
  });

  it("leaves an absolute path alone", () => {
    const absolute = path.resolve("/work/a.tldr");
    expect(resolveTldrPath(absolute, "/elsewhere")).toBe(absolute);
  });
});

describe("tempShotPath", () => {
  const when = new Date("2026-09-13T04:05:06.789Z");

  it("names the file after the document and lands in the temp directory", () => {
    const shot = tempShotPath("/work/learn/assets/attention.tldr", when, "/tmp");
    expect(path.dirname(shot)).toBe("/tmp");
    expect(path.basename(shot)).toBe("tldrawkc-attention-2026-09-13T04-05-06-789Z.png");
  });

  it("never lands next to the source file", () => {
    const source = "/work/learn/assets/attention.tldr";
    expect(path.dirname(tempShotPath(source))).toBe(os.tmpdir());
  });

  it("gives two calls different names", () => {
    const first = tempShotPath("/a/x.tldr", new Date("2026-09-13T04:05:06.000Z"), "/tmp");
    const second = tempShotPath("/a/x.tldr", new Date("2026-09-13T04:05:07.000Z"), "/tmp");
    expect(first).not.toBe(second);
  });
});

describe("tempSiblingPath", () => {
  it("stays in the target's directory, so the rename is on one filesystem", () => {
    const temp = tempSiblingPath("/work/learn/assets/attention.tldr");
    expect(path.dirname(temp)).toBe("/work/learn/assets");
    expect(path.basename(temp).startsWith(".attention.tldr.")).toBe(true);
    expect(temp.endsWith(".tmp")).toBe(true);
  });

  it("does not collide with the file it is standing in for", () => {
    const target = "/work/a.tldr";
    expect(tempSiblingPath(target)).not.toBe(target);
  });

  it("gives two calls in the same millisecond different names", () => {
    // Two writes to one target from one process must not pick the same temp
    // file: they would overwrite each other and race to rename.
    const names = new Set(
      Array.from({ length: 100 }, () => tempSiblingPath("/work/a.tldr")),
    );
    expect(names.size).toBe(100);
  });
});

describe("resolveListDir", () => {
  it("defaults to learn/assets under the working directory", () => {
    expect(resolveListDir(undefined, "/repo")).toBe(path.join("/repo", DEFAULT_LIST_DIR));
  });

  it("resolves a relative argument against the working directory", () => {
    expect(resolveListDir("diagrams", "/repo")).toBe(path.join("/repo", "diagrams"));
  });

  it("takes an absolute argument as it is", () => {
    expect(resolveListDir("/elsewhere/x", "/repo")).toBe(path.join("/elsewhere", "x"));
  });
});

describe("siblingPath", () => {
  it("swaps the extension and keeps the directory", () => {
    expect(siblingPath("/a/b/dot-product.tldr", ".svg")).toBe("/a/b/dot-product.svg");
  });

  it("handles a name with dots in it", () => {
    expect(siblingPath("/a/v1.2.tldr", ".png")).toBe("/a/v1.2.png");
  });
});

describe("relativeToDir", () => {
  it("is forward-slashed, so a listing reads the same on every platform", () => {
    const file = path.join("/repo", "learn", "assets", "a", "b.tldr");
    expect(relativeToDir(path.join("/repo", "learn", "assets"), file)).toBe("a/b.tldr");
  });
});
