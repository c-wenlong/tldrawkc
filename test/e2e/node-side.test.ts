/**
 * The Node half of every verb, against a stand-in bridge.
 *
 * A real browser, a real server, real files, and a page that answers the
 * bridge contract without tldraw (`fixtures/stand-in-page/`). What is under
 * test here is everything Node decides: the order of load, exec, save and
 * export; the exit code each failure carries; that a snippet which throws
 * leaves the document byte for byte as it was; and that a screenshot with no
 * `-o` lands in the system temp directory rather than next to the source.
 *
 * None of that needs the editor, and pinning it separately means a failure in
 * `cli.test.ts` next door points at the page rather than at both halves.
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  exportCanvas,
  fromMermaid,
  inspect,
  newDocument,
  run,
  shot,
} from "../../src/lib/canvas.js";
import { EnvironmentError, ExportError, SnippetError, UsageError } from "../../src/lib/errors.js";

/** The page served to every test in this file. */
const STAND_IN_PAGE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "stand-in-page",
);

/** The snippet from the example at the end of HELPERS.md, trimmed to three boxes. */
const THREE_BOXES = `
helpers.box('agent', 'agent cli', { x: 60, y: 60, w: 170, h: 64 })
helpers.box('page', 'headless page', { after: 'agent', gap: 80, w: 190, h: 64 })
helpers.box('png', 'screenshot png', { below: 'page', gap: 90, w: 190, h: 64 })
helpers.connect('agent', 'page', { label: 'exec' })
helpers.connect('page', 'png', { label: 'toImage' })
return { boxes: 3, arrows: 2 }
`;

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "tldrawkc-e2e-"));
  file = path.join(dir, "diagram.tldr");
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

function options(overrides: Partial<Parameters<typeof run>[0]> = {}) {
  return {
    file,
    create: true,
    save: true,
    subsetFonts: true,
    allowLints: false,
    padding: 32,
    pixelRatio: 2,
    timeoutMs: 30_000,
    cwd: dir,
    pageRoot: STAND_IN_PAGE,
    ...overrides,
  };
}

/**
 * The saved document's records.
 *
 * A `.tldr` holds more than shapes: the document record (which is where the
 * metadata lives), pages, bindings. The stand-in writes one too, so a test
 * that means "how many shapes" has to say so rather than counting the array.
 */
async function records(target: string): Promise<Record<string, unknown>[]> {
  const parsed = JSON.parse(await fs.readFile(target, "utf8")) as {
    records: Record<string, unknown>[];
  };
  return parsed.records;
}

async function shapeRecords(target: string): Promise<Record<string, unknown>[]> {
  return (await records(target)).filter((record) => record["typeName"] === "shape");
}

describe("run", () => {
  it("draws, saves and reports what it drew", async () => {
    const result = await run(options({ evalSource: THREE_BOXES }));

    expect(result.exitCode).toBe(0);
    expect(result.shapeCount).toBe(5);
    expect(result.lints).toEqual([]);
    expect(result.result).toEqual({ boxes: 3, arrows: 2 });
    expect(result.saved).toBe(true);
    expect(result.ms).toBeGreaterThan(0);

    expect(Array.isArray(await records(file))).toBe(true);
    expect(await shapeRecords(file)).toHaveLength(5);
  });

  it("loads what a previous run saved, so two snippets compose", async () => {
    await run(options({ evalSource: THREE_BOXES }));
    const second = await run(
      options({ evalSource: "helpers.box('extra', 'one more', { x: 400, y: 400 })" }),
    );
    expect(second.shapeCount).toBe(6);
  });

  it("starts from empty only when --create says so", async () => {
    await expect(run(options({ create: false, evalSource: "1" }))).rejects.toBeInstanceOf(
      UsageError,
    );
  });

  it("writes a PNG with --shot and leaves it where asked", async () => {
    const out = path.join(dir, "out.png");
    const result = await run(options({ evalSource: THREE_BOXES, shot: "out.png" }));
    expect(result.shot).toBe(out);
    const bytes = await fs.readFile(out);
    // A PNG, not a base64 string that was written verbatim.
    expect(bytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(bytes.byteLength).toBeGreaterThan(1000);
  });

  it("exports but does not write the document with --no-save", async () => {
    const result = await run(options({ evalSource: THREE_BOXES, save: false, shot: "out.png" }));
    expect(result.saved).toBe(false);
    expect(result.shot).not.toBeNull();
    await expect(fs.readFile(file)).rejects.toThrow();
  });

  it("leaves the document untouched when the snippet throws", async () => {
    await run(options({ evalSource: THREE_BOXES }));
    const before = await fs.readFile(file);

    const error = await run(
      options({ evalSource: "helpers.box('x', 'x', { x: 0, y: 0 }); throw new Error('boom')" }),
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SnippetError);
    expect((error as SnippetError).exitCode).toBe(2);
    expect((error as SnippetError).message).toContain("boom");
    // Byte for byte, not "still parses": a partial write is the failure mode
    // the atomic write exists to prevent.
    expect(await fs.readFile(file)).toEqual(before);
  });

  it("saves and reports exit 3 when lints remain", async () => {
    const loose = `
      helpers.box('a', 'alpha', { x: 0, y: 0 })
      editor.createShape({ id: tldraw.createShapeId('loose'), type: 'arrow', x: 300, y: 300 })
    `;
    const result = await run(options({ evalSource: loose }));

    expect(result.exitCode).toBe(3);
    expect(result.lints.map((lint) => lint.rule)).toContain("friendless-arrow");
    // The work is real, so it is saved. The non-zero code is what stops an
    // agent calling the diagram finished.
    expect(result.saved).toBe(true);
    expect(JSON.parse(await fs.readFile(file, "utf8"))).toHaveProperty("records");
  });

  it("turns exit 3 into 0 with --allow-lints, without changing the lint list", async () => {
    const loose = "editor.createShape({ id: tldraw.createShapeId('loose'), type: 'arrow', x: 0, y: 0 })";
    const result = await run(options({ evalSource: loose, allowLints: true }));
    expect(result.exitCode).toBe(0);
    expect(result.lints.length).toBeGreaterThan(0);
  });

  it("refuses --svg against a page with no svg()", async () => {
    // The stand-in deliberately has no `svg`, which is what makes this the
    // capability check and not a test of the exporter.
    const error = await run(
      options({ evalSource: THREE_BOXES, svg: "out.svg" }),
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UsageError);
    expect((error as UsageError).message).toContain("svg()");
    // Refused before the snippet ran, so nothing was written.
    await expect(fs.readFile(file)).rejects.toThrow();
  });

  it("gives up on a snippet that never finishes", async () => {
    const error = await run(
      options({ evalSource: "while (true) { /* spin */ }", timeoutMs: 750 }),
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EnvironmentError);
    expect((error as EnvironmentError).exitCode).toBe(1);
    expect((error as EnvironmentError).message).toContain("750");
    await expect(fs.readFile(file)).rejects.toThrow();
  });

  it("refuses an unknown --page by name", async () => {
    const error = await run(
      options({ evalSource: "1", page: "Nowhere" }),
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UsageError);
    expect((error as UsageError).message).toContain("Nowhere");
  });

  it("reports an export failure as its own code, after the save", async () => {
    // A directory where the PNG should go: the save succeeds, the export
    // cannot. That is exactly the split exit 4 exists to describe.
    await fs.mkdir(path.join(dir, "blocked.png"));
    const error = await run(
      options({ evalSource: THREE_BOXES, shot: "blocked.png" }),
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ExportError);
    expect((error as ExportError).exitCode).toBe(4);
    // The document is safe, which is the whole point of the separate code.
    expect(JSON.parse(await fs.readFile(file, "utf8"))).toHaveProperty("records");
  });
});

describe("shot", () => {
  it("writes to the system temp directory when nothing was asked for", async () => {
    await run(options({ evalSource: THREE_BOXES }));
    const result = await shot({
      file,
      padding: 32,
      pixelRatio: 2,
      cwd: dir,
      pageRoot: STAND_IN_PAGE,
    });

    expect(path.dirname(result.shot)).toBe(path.resolve(os.tmpdir()));
    expect(path.basename(result.shot)).toMatch(/^tldrawkc-diagram-.*\.png$/);
    expect(result.width).toBeGreaterThan(0);
    try {
      expect((await fs.stat(result.shot)).size).toBeGreaterThan(1000);
    } finally {
      await fs.rm(result.shot, { force: true });
    }
  });

  it("writes where -o says", async () => {
    await run(options({ evalSource: THREE_BOXES }));
    const result = await shot({
      file,
      output: "here.png",
      padding: 32,
      pixelRatio: 2,
      cwd: dir,
      pageRoot: STAND_IN_PAGE,
    });
    expect(result.shot).toBe(path.join(dir, "here.png"));
  });
});

describe("new", () => {
  it("writes a document the next run can load", async () => {
    const created = await newDocument({ file, cwd: dir, pageRoot: STAND_IN_PAGE });
    expect(created.file).toBe(file);

    expect(await shapeRecords(file)).toEqual([]);

    const after = await run(options({ create: false, evalSource: THREE_BOXES }));
    expect(after.shapeCount).toBe(5);
  });

  it("copies a starting point with --from", async () => {
    await run(options({ evalSource: THREE_BOXES }));
    const copy = path.join(dir, "copy.tldr");
    await newDocument({ file: copy, from: file, cwd: dir, pageRoot: STAND_IN_PAGE });

    expect(await shapeRecords(copy)).toHaveLength(5);
  });
});

describe("inspect", () => {
  it("reports the shapes, the bindings and the lints without saving", async () => {
    await run(options({ evalSource: THREE_BOXES }));
    const before = await fs.readFile(file);

    const result = await inspect({
      file,
      allowLints: false,
      cwd: dir,
      pageRoot: STAND_IN_PAGE,
    });

    expect(result.exitCode).toBe(0);
    expect(result.canvas.shapes).toHaveLength(5);
    expect(result.canvas.bindings).toHaveLength(2);
    expect(result.canvas.lints).toEqual([]);
    expect(result.canvas.shapes.map((shape) => shape.text)).toContain("agent cli");
    // Reading is not writing: the file is untouched, byte for byte.
    expect(await fs.readFile(file)).toEqual(before);
  });

  it("exits 3 on a lint, and 0 with --allow-lints", async () => {
    const loose =
      "editor.createShape({ id: tldraw.createShapeId('loose'), type: 'arrow', x: 0, y: 0 })";
    await run(options({ evalSource: loose, allowLints: true }));

    const strict = await inspect({ file, allowLints: false, cwd: dir, pageRoot: STAND_IN_PAGE });
    expect(strict.exitCode).toBe(3);
    expect(strict.canvas.lints.map((lint) => lint.rule)).toContain("friendless-arrow");

    const allowed = await inspect({ file, allowLints: true, cwd: dir, pageRoot: STAND_IN_PAGE });
    expect(allowed.exitCode).toBe(0);
    expect(allowed.canvas.lints.length).toBeGreaterThan(0);
  });
});

describe("export", () => {
  it("writes a PNG where asked and reports its size", async () => {
    await run(options({ evalSource: THREE_BOXES }));
    const result = await exportCanvas({
      file,
      png: "out.png",
      padding: 32,
      pixelRatio: 2,
      subsetFonts: true,
      cwd: dir,
      pageRoot: STAND_IN_PAGE,
    });

    expect(result.svg).toBeNull();
    expect(result.png?.path).toBe(path.join(dir, "out.png"));
    const bytes = await fs.readFile(path.join(dir, "out.png"));
    expect(bytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  });

  it("reports a failed export as exit 4, with the document untouched", async () => {
    await run(options({ evalSource: THREE_BOXES }));
    const before = await fs.readFile(file);
    // A directory where the PNG should go.
    await fs.mkdir(path.join(dir, "blocked.png"));

    const error = await exportCanvas({
      file,
      png: "blocked.png",
      padding: 32,
      pixelRatio: 2,
      subsetFonts: true,
      cwd: dir,
      pageRoot: STAND_IN_PAGE,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ExportError);
    expect((error as ExportError).exitCode).toBe(4);
    expect(await fs.readFile(file)).toEqual(before);
  });
});

describe("from-mermaid", () => {
  /** Two edges and one subgraph, in the subset the stand-in understands. */
  const FLOWCHART = `flowchart TD
  a[Agent] --> b[Page]
  subgraph render [rendering]
  b --> c[Png]
  end
  this line is not mermaid at all`;

  function mermaidOptions(overrides: Partial<Parameters<typeof fromMermaid>[0]> = {}) {
    return {
      file,
      source: FLOWCHART,
      append: false,
      allowLints: false,
      padding: 32,
      pixelRatio: 2,
      timeoutMs: 30_000,
      cwd: dir,
      pageRoot: STAND_IN_PAGE,
      ...overrides,
    };
  }

  it("creates the document, reports what it made, and keeps the bad line", async () => {
    const result = await fromMermaid(mermaidOptions());

    expect(result.exitCode).toBe(0);
    expect(Object.keys(result.nodes)).toEqual(["a", "b", "c"]);
    expect(result.edges).toHaveLength(2);
    expect(result.containers).toHaveLength(1);
    // Reported, never dropped: a diagram that silently lost a statement looks
    // finished and is not.
    expect(result.unsupported).toEqual(["this line is not mermaid at all"]);
    expect(result.lints).toEqual([]);

    expect(await shapeRecords(file)).toHaveLength(result.shapeCount);
  });

  it("refuses an existing document without --append and adds to it with one", async () => {
    await fromMermaid(mermaidOptions());
    const first = await shapeRecords(file);

    const error = await fromMermaid(mermaidOptions()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UsageError);
    expect((error as UsageError).exitCode).toBe(1);

    const appended = await fromMermaid(
      mermaidOptions({ append: true, source: "flowchart TD\n  x[Extra] --> y[More]" }),
    );
    expect(appended.shapeCount).toBeGreaterThan(first.length);
  });

  it("writes a PNG with --shot", async () => {
    const result = await fromMermaid(mermaidOptions({ shot: "map.png" }));
    expect(result.shot).toBe(path.join(dir, "map.png"));
    expect((await fs.stat(path.join(dir, "map.png"))).size).toBeGreaterThan(1000);
  });

  it("embeds a source with quotes and backslashes without breaking the snippet", async () => {
    // The source is JSON-encoded into the snippet rather than concatenated,
    // so a label full of punctuation is data and never code.
    const nasty = 'flowchart TD\n  a["he said \\"hi\\" \\\\ then left"] --> b[End]';
    const result = await fromMermaid(mermaidOptions({ source: nasty }));
    expect(result.exitCode).toBe(0);
    expect(Object.keys(result.nodes).length + result.unsupported.length).toBeGreaterThan(0);
  });
});
