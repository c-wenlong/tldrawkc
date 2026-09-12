/**
 * `list` over a real directory.
 *
 * A unit test rather than an end-to-end one because the command opens no
 * browser: it is `readdir`, `JSON.parse` and `stat`, and the point of building
 * it that way is that a catalog can run it thirty times without a Chromium.
 *
 * The fixture directory is the one that matters: a good file, a file with no
 * metadata, and a file that will not parse. The third is what pins the
 * promise that one corrupt `.tldr` is a line in `errors` and never an
 * exception the caller has to catch.
 */

import { describe, expect, it, beforeEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { list } from "../../src/lib/list.js";
import { applyMeta } from "../../src/lib/meta.js";
import { UsageError } from "../../src/lib/errors.js";

const NOW = "2026-09-13T10:00:00.000Z";

function tldr(shapes: number): string {
  const records: Record<string, unknown>[] = [];
  for (let i = 0; i < shapes; i += 1) {
    records.push({ id: `shape:s${String(i)}`, typeName: "shape", type: "geo" });
  }
  records.push({ gridSize: 10, name: "", meta: {}, id: "document:document", typeName: "document" });
  return JSON.stringify({ tldrawFileFormatVersion: 1, schema: {}, records });
}

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "tldrawkc-list-"));

  // A stamped diagram with its exported SVG beside it.
  await fs.writeFile(
    path.join(dir, "dot-product.tldr"),
    applyMeta(tldr(4), { topic: "dot-product", title: "Dot product", concepts: ["vectors"] }, NOW)
      .json,
  );
  await fs.writeFile(path.join(dir, "dot-product.svg"), "<svg/>");

  // A diagram nobody has stamped, and no export.
  await fs.writeFile(path.join(dir, "scratch.tldr"), tldr(2));

  // A file that will not parse.
  await fs.writeFile(path.join(dir, "broken.tldr"), "{ this is not json");

  // Neither of these is a diagram.
  await fs.writeFile(path.join(dir, "notes.md"), "# not a diagram");
  await fs.mkdir(path.join(dir, "node_modules"));
  await fs.writeFile(path.join(dir, "node_modules", "vendor.tldr"), tldr(1));
});

describe("list", () => {
  it("reports every .tldr with its metadata, siblings, shape count and mtime", async () => {
    const result = await list({ dir });

    expect(result.diagrams.map((entry) => entry.name)).toEqual(["dot-product", "scratch"]);

    const stamped = result.diagrams[0];
    expect(stamped?.meta?.topic).toBe("dot-product");
    expect(stamped?.meta?.concepts).toEqual(["vectors"]);
    expect(stamped?.shapes).toBe(4);
    expect(stamped?.svg).toEqual({ path: path.join(dir, "dot-product.svg"), exists: true });
    expect(stamped?.png).toEqual({ path: path.join(dir, "dot-product.png"), exists: false });
    expect(stamped?.relative).toBe("dot-product.tldr");
    expect(new Date(stamped?.modified ?? "").getTime()).toBeGreaterThan(0);
  });

  it("reports a file with no metadata as null rather than skipping it", async () => {
    const result = await list({ dir });
    const plain = result.diagrams.find((entry) => entry.name === "scratch");
    expect(plain?.meta).toBeNull();
    expect(plain?.shapes).toBe(2);
    expect(plain?.svg.exists).toBe(false);
  });

  it("puts a file it cannot parse in errors and never throws past", async () => {
    const result = await list({ dir });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.relative).toBe("broken.tldr");
    expect(result.errors[0]?.message).toContain("not valid JSON");
    // And the good files are still all there.
    expect(result.diagrams).toHaveLength(2);
  });

  it("ignores anything that is not a .tldr, and vendored directories", async () => {
    const result = await list({ dir });
    expect(result.diagrams.map((entry) => entry.relative)).not.toContain("notes.md");
    expect(result.diagrams.map((entry) => entry.name)).not.toContain("vendor");
  });

  it("walks subdirectories and sorts by path, so two runs agree", async () => {
    await fs.mkdir(path.join(dir, "algebra"));
    await fs.writeFile(path.join(dir, "algebra", "basis.tldr"), tldr(1));

    const first = await list({ dir });
    const second = await list({ dir });
    expect(first.diagrams.map((entry) => entry.relative)).toEqual([
      "algebra/basis.tldr",
      "dot-product.tldr",
      "scratch.tldr",
    ]);
    expect(second.diagrams.map((entry) => entry.path)).toEqual(
      first.diagrams.map((entry) => entry.path),
    );
  });

  it("defaults to learn/assets under the working directory", async () => {
    const assets = path.join(dir, "learn", "assets");
    await fs.mkdir(assets, { recursive: true });
    await fs.writeFile(path.join(assets, "only.tldr"), tldr(1));

    const result = await list({ cwd: dir });
    expect(result.dir).toBe(assets);
    expect(result.diagrams.map((entry) => entry.name)).toEqual(["only"]);
  });

  it("says the directory is missing rather than reporting no diagrams", async () => {
    await expect(list({ dir: path.join(dir, "nowhere") })).rejects.toBeInstanceOf(UsageError);
    await expect(list({ dir: path.join(dir, "notes.md") })).rejects.toBeInstanceOf(UsageError);
  });

  it("is empty, not an error, for a directory with no diagrams in it", async () => {
    const empty = await fs.mkdtemp(path.join(os.tmpdir(), "tldrawkc-empty-"));
    const result = await list({ dir: empty });
    expect(result.diagrams).toEqual([]);
    expect(result.errors).toEqual([]);
  });
});
