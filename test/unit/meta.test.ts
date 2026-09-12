/**
 * The document metadata: the shape, the file surgery and the SVG stamp.
 *
 * The last describe block is the one that earns its keep. `src/lib/meta.ts`
 * and `src/page/helpers/meta.ts` hold the same rules twice, because layering
 * rule 1 stops the node side from importing the page. This file imports both
 * and runs them over one table, so a change to either that the other does not
 * make is a red test rather than a bug that only shows up in a round trip.
 */

import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  applyMeta,
  isEmptyPatch,
  mergeDocumentMeta,
  readDocumentMeta,
  readMeta,
  readTldrFacts,
  setMeta,
  stampSvg,
  validatePatch,
  META_KEY,
  META_VERSION,
  type MetaPatch,
} from "../../src/lib/meta.js";
import { UsageError } from "../../src/lib/errors.js";
import * as page from "../../src/page/helpers/meta.js";

const NOW = "2026-09-13T10:00:00.000Z";

/** A minimal `.tldr` envelope: one shape, one document record, like the real thing. */
function tldr(meta: Record<string, unknown> = {}): string {
  return JSON.stringify({
    tldrawFileFormatVersion: 1,
    schema: { schemaVersion: 2 },
    records: [
      { id: "shape:a", typeName: "shape", type: "geo", x: 0, y: 0, props: {} },
      { gridSize: 10, name: "", meta, id: "document:document", typeName: "document" },
    ],
  });
}

describe("readDocumentMeta", () => {
  it("is null when the bag has no tldrawkc key", () => {
    expect(readDocumentMeta({})).toBeNull();
    expect(readDocumentMeta(null)).toBeNull();
    expect(readDocumentMeta("nonsense")).toBeNull();
  });

  it("is null when the key holds something that is not an object", () => {
    expect(readDocumentMeta({ [META_KEY]: "vectors" })).toBeNull();
    expect(readDocumentMeta({ [META_KEY]: ["vectors"] })).toBeNull();
  });

  it("fills in every field a partial bag is missing", () => {
    expect(readDocumentMeta({ [META_KEY]: { topic: "dot-product" } })).toEqual({
      kc: META_VERSION,
      title: "",
      topic: "dot-product",
      concepts: [],
      source: "",
      created: "",
    });
  });

  it("keeps a version it does not know, so an indexer can refuse it", () => {
    expect(readDocumentMeta({ [META_KEY]: { kc: 7 } })?.kc).toBe(7);
  });

  it("trims, drops blanks and de-duplicates the concept list", () => {
    const meta = readDocumentMeta({
      [META_KEY]: { concepts: [" a ", "", "b", "a", 4, null] },
    });
    expect(meta?.concepts).toEqual(["a", "b"]);
  });
});

describe("mergeDocumentMeta", () => {
  it("writes created once and then preserves it", () => {
    const first = mergeDocumentMeta(null, { topic: "dot-product" }, NOW);
    expect(first.created).toBe(NOW);
    const second = mergeDocumentMeta(first, { title: "Dot product" }, "2027-01-01T00:00:00.000Z");
    expect(second.created).toBe(NOW);
    expect(second.topic).toBe("dot-product");
    expect(second.title).toBe("Dot product");
  });

  it("leaves a field the patch does not mention alone", () => {
    const base = mergeDocumentMeta(null, { topic: "a", title: "A", source: "s" }, NOW);
    expect(mergeDocumentMeta(base, { topic: "b" }, NOW)).toEqual({ ...base, topic: "b" });
  });

  it("always stamps the version this build writes", () => {
    const old = { kc: 0, title: "", topic: "a", concepts: [], source: "", created: NOW };
    expect(mergeDocumentMeta(old, { title: "t" }, NOW).kc).toBe(META_VERSION);
  });

  it("refuses a topic that is a title rather than a slug", () => {
    expect(() => mergeDocumentMeta(null, { topic: "Vector spaces" }, NOW)).toThrow(UsageError);
    expect(() => mergeDocumentMeta(null, { concepts: ["Dot Product"] }, NOW)).toThrow(UsageError);
  });

  it("allows clearing a topic with an empty string", () => {
    expect(() => validatePatch({ topic: "" })).not.toThrow();
  });
});

describe("isEmptyPatch", () => {
  it("is true only when nothing was given", () => {
    expect(isEmptyPatch({})).toBe(true);
    expect(isEmptyPatch({ concepts: [] })).toBe(false);
    expect(isEmptyPatch({ title: "" })).toBe(false);
  });
});

describe("applyMeta", () => {
  it("puts the object on the document record and leaves everything else alone", () => {
    const { json, meta } = applyMeta(tldr(), { topic: "dot-product" }, NOW);
    const parsed = JSON.parse(json) as { records: Record<string, unknown>[] };
    const document = parsed.records.find((r) => r["typeName"] === "document");
    expect(document?.["meta"]).toEqual({ [META_KEY]: meta });
    expect(parsed.records.find((r) => r["typeName"] === "shape")).toEqual({
      id: "shape:a",
      typeName: "shape",
      type: "geo",
      x: 0,
      y: 0,
      props: {},
    });
  });

  it("keeps other keys already in the meta bag", () => {
    const { json } = applyMeta(tldr({ obsidian: "yes" }), { topic: "a" }, NOW);
    expect(readMeta(json)?.topic).toBe("a");
    const parsed = JSON.parse(json) as { records: Record<string, unknown>[] };
    const document = parsed.records.find((r) => r["typeName"] === "document");
    expect((document?.["meta"] as Record<string, unknown>)["obsidian"]).toBe("yes");
  });

  it("is idempotent: the same patch twice gives the same bytes", () => {
    const once = applyMeta(tldr(), { topic: "a", title: "A" }, NOW).json;
    const twice = applyMeta(once, { topic: "a", title: "A" }, "2030-01-01T00:00:00.000Z").json;
    expect(twice).toBe(once);
  });

  it("refuses a document with no document record", () => {
    const orphan = JSON.stringify({ records: [{ id: "shape:a", typeName: "shape" }] });
    expect(() => applyMeta(orphan, { topic: "a" }, NOW)).toThrow(UsageError);
  });

  it("refuses something that is not a .tldr", () => {
    expect(() => applyMeta("not json", { topic: "a" }, NOW)).toThrow(UsageError);
    expect(() => applyMeta("[]", { topic: "a" }, NOW)).toThrow(UsageError);
    expect(() => applyMeta("{}", { topic: "a" }, NOW)).toThrow(UsageError);
  });
});

describe("readTldrFacts", () => {
  it("counts shape records and reads the metadata in one parse", () => {
    const { json } = applyMeta(tldr(), { topic: "a" }, NOW);
    expect(readTldrFacts(json)).toEqual({ meta: readMeta(json), shapes: 1 });
  });

  it("reports no metadata rather than throwing on a plain document", () => {
    expect(readTldrFacts(tldr())).toEqual({ meta: null, shapes: 1 });
  });
});

describe("setMeta", () => {
  async function scratch(): Promise<string> {
    return await fs.mkdtemp(path.join(os.tmpdir(), "tldrawkc-meta-"));
  }

  it("stamps an existing file and reports what it wrote", async () => {
    const dir = await scratch();
    const file = path.join(dir, "x.tldr");
    await fs.writeFile(file, tldr());

    const result = await setMeta({
      file,
      patch: { topic: "dot-product", concepts: ["a", "b"] },
      now: new Date(NOW),
    });
    expect(result.changed).toBe(true);
    expect(result.meta.topic).toBe("dot-product");
    expect(result.meta.created).toBe(NOW);
    expect(readMeta(await fs.readFile(file, "utf8"))?.concepts).toEqual(["a", "b"]);
  });

  it("does not rewrite a file that already says exactly this", async () => {
    const dir = await scratch();
    const file = path.join(dir, "x.tldr");
    await fs.writeFile(file, tldr());
    await setMeta({ file, patch: { topic: "a" }, now: new Date(NOW) });
    const before = await fs.stat(file);

    const again = await setMeta({ file, patch: { topic: "a" }, now: new Date() });
    expect(again.changed).toBe(false);
    expect((await fs.stat(file)).mtimeMs).toBe(before.mtimeMs);
  });

  it("refuses a patch with no flags in it", async () => {
    const dir = await scratch();
    const file = path.join(dir, "x.tldr");
    await fs.writeFile(file, tldr());
    await expect(setMeta({ file, patch: {} })).rejects.toBeInstanceOf(UsageError);
  });

  it("refuses a missing file", async () => {
    const dir = await scratch();
    await expect(
      setMeta({ file: path.join(dir, "nope.tldr"), patch: { topic: "a" } }),
    ).rejects.toBeInstanceOf(UsageError);
  });

  it("refuses a bad slug before it touches the file", async () => {
    const dir = await scratch();
    const file = path.join(dir, "x.tldr");
    await fs.writeFile(file, tldr());
    await expect(setMeta({ file, patch: { topic: "Not A Slug" } })).rejects.toBeInstanceOf(
      UsageError,
    );
    expect(await fs.readFile(file, "utf8")).toBe(tldr());
  });
});

describe("stampSvg", () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><g/></svg>';
  const meta = mergeDocumentMeta(null, { topic: "dot-product", title: "Dot product" }, NOW);

  it("adds a title element and a topic attribute to the root", () => {
    const out = stampSvg(svg, meta);
    expect(out).toContain('data-kc-topic="dot-product"');
    expect(out).toContain("<title>Dot product</title>");
    expect(out.indexOf("<title>")).toBeLessThan(out.indexOf("<g/>"));
  });

  it("leaves a document with no metadata untouched", () => {
    expect(stampSvg(svg, null)).toBe(svg);
  });

  it("leaves an SVG untouched when there is neither a title nor a topic", () => {
    expect(stampSvg(svg, mergeDocumentMeta(null, { source: "s" }, NOW))).toBe(svg);
  });

  it("does not add a second title or a second attribute", () => {
    const once = stampSvg(svg, meta);
    expect(stampSvg(once, meta)).toBe(once);
  });

  it("escapes the title and the topic", () => {
    const risky = mergeDocumentMeta(null, { title: 'a < b & "c"' }, NOW);
    expect(stampSvg(svg, risky)).toContain("<title>a &lt; b &amp; &quot;c&quot;</title>");
  });

  it("leaves something that is not an SVG alone", () => {
    expect(stampSvg("not markup", meta)).toBe("not markup");
  });
});

/**
 * The two copies of the rules, run over one table.
 *
 * Every case that matters for a round trip: a snippet writes through the page
 * copy, `list` reads through the node copy, and the two have to agree about
 * what came out.
 */
describe("the node and page copies agree", () => {
  const bags: unknown[] = [
    {},
    null,
    { [META_KEY]: {} },
    { [META_KEY]: "not an object" },
    { [META_KEY]: { kc: 7, topic: " spaced ", concepts: ["b", "b", " a "] } },
    { [META_KEY]: { title: "T", topic: "t", concepts: [], source: "s", created: NOW } },
  ];
  const patches: MetaPatch[] = [
    {},
    { topic: "dot-product" },
    { title: "  Dot product  " },
    { concepts: ["a", "a", "b"] },
    { source: "session-42" },
    { topic: "", title: "", concepts: [], source: "" },
  ];

  it("reads every bag the same way", () => {
    for (const bag of bags) {
      expect(page.readDocumentMeta(bag)).toEqual(readDocumentMeta(bag));
    }
  });

  it("merges every patch the same way", () => {
    for (const bag of bags) {
      for (const patch of patches) {
        const current = readDocumentMeta(bag);
        expect(page.mergeDocumentMeta(page.readDocumentMeta(bag), patch, NOW)).toEqual(
          mergeDocumentMeta(current, patch, NOW),
        );
      }
    }
  });

  it("refuses the same slugs, even though the error types differ", () => {
    for (const patch of [{ topic: "Not A Slug" }, { concepts: ["Nope"] }]) {
      expect(() => validatePatch(patch)).toThrow();
      expect(() => page.validatePatch(patch)).toThrow();
    }
  });

  it("keeps the key, the version and the slug rule in step", () => {
    expect(page.META_KEY).toBe(META_KEY);
    expect(page.META_VERSION).toBe(META_VERSION);
    expect(page.SLUG_PATTERN.source).toBe(/^[a-z0-9]+(?:-[a-z0-9]+)*$/.source);
  });

  it("patchedBag puts the object under the key and keeps the rest of the bag", () => {
    const { bag, meta } = page.patchedBag({ other: 1 }, { topic: "a" }, NOW);
    expect(bag["other"]).toBe(1);
    expect(bag[META_KEY]).toEqual(meta);
    expect(readDocumentMeta(bag)).toEqual(meta);
  });
});
