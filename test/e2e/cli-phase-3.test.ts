/**
 * Document metadata and the catalog commands, through the built binary.
 *
 * Same shape as `cli-phase-2.test.ts` next door. What is under test here is
 * the round trip that only a real tldraw can prove: a topic written by `new`
 * has to survive being parsed into a store, loaded, amended by a snippet and
 * serialised back out. Everything either side of that (the JSON surgery, the
 * directory walk, the SVG stamp) is unit tested with no browser, so a failure
 * here means tldraw dropped the bag rather than that the rules are wrong.
 *
 * `list` and `meta set` open no browser at all, and the cases here say so: if
 * either ever starts launching Chromium, the run gets slower and nothing
 * fails, so the assertion is that they work with no browser resolvable.
 */

import { describe, expect, it, beforeAll, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import { CLI_ENTRY, PAGE_INDEX_HTML } from "../../src/lib/paths.js";
import { resolveChromium } from "../../src/lib/browser.js";

const TWO_BOXES = `
helpers.box('a', 'first', { x: 60, y: 60, w: 170, h: 64 })
helpers.box('b', 'second', { after: 'a', gap: 140, w: 170, h: 64 })
helpers.connect('a', 'b', { label: 'then' })
return helpers.meta()
`;

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface Meta {
  kc: number;
  title: string;
  topic: string;
  concepts: string[];
  source: string;
  created: string;
}

interface InspectJson {
  shapes: unknown[];
  lints: Array<{ rule: string; shapeIds: string[]; message: string; severity?: string }>;
  meta: Meta | null;
}

interface ListJson {
  dir: string;
  diagrams: Array<{
    path: string;
    relative: string;
    name: string;
    meta: Meta | null;
    shapes: number;
    svg: { path: string; exists: boolean };
    png: { path: string; exists: boolean };
    modified: string;
  }>;
  errors: Array<{ path: string; relative: string; message: string }>;
  ms: number;
}

let chromiumPath: string;
let dir: string;
let file: string;

beforeAll(async () => {
  for (const built of [CLI_ENTRY, PAGE_INDEX_HTML]) {
    const found = await fs.stat(built).catch(() => null);
    if (!found) throw new Error(`${built} is missing. Run \`npm run build\` first.`);
  }
  chromiumPath = (await resolveChromium()).executablePath;
});

beforeEach(async () => {
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "tldrawkc-p3-")));
  file = path.join(dir, "diagram.tldr");
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

function cli(args: string[], env: NodeJS.ProcessEnv = {}): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_ENTRY, ...args], {
      cwd: dir,
      env: { ...process.env, TLDRAWKC_CHROMIUM: chromiumPath, ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
    child.stdin.end("");
  });
}

/** The document record's metadata, straight out of the saved file. */
async function metaOf(target: string): Promise<Meta | null> {
  const parsed = JSON.parse(await fs.readFile(target, "utf8")) as {
    records: Record<string, unknown>[];
  };
  const document = parsed.records.find((record) => record["typeName"] === "document");
  const bag = document?.["meta"] as Record<string, unknown> | undefined;
  return (bag?.["tldrawkc"] as Meta | undefined) ?? null;
}

describe("new with metadata", () => {
  it("writes the topic onto the document record, and inspect reads it back", async () => {
    const created = await cli([
      "new",
      "diagram.tldr",
      "--title",
      "First then second",
      "--topic",
      "dot-product",
      "--concept",
      "vector-as-a-list-of-numbers",
      "--source",
      "session-42",
      "--json",
    ]);
    expect(created.code).toBe(0);

    // On disk, where a catalog reads it.
    const written = await metaOf(file);
    expect(written).toMatchObject({
      kc: 1,
      title: "First then second",
      topic: "dot-product",
      concepts: ["vector-as-a-list-of-numbers"],
      source: "session-42",
    });
    expect(Date.parse(written?.created ?? "")).toBeGreaterThan(0);

    // And through tldraw, which is the half only a real page can prove: the
    // bag survives parseTldrawJsonFile, loadSnapshot and serializeTldrawJson.
    const read = await cli(["inspect", "diagram.tldr", "--json"]);
    const canvas = JSON.parse(read.stdout) as InspectJson;
    expect(canvas.meta).toEqual(written);
  });

  it("refuses a topic that is not a slug, before it launches anything", async () => {
    const result = await cli(["new", "diagram.tldr", "--topic", "Dot Product"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("is not a slug");
    expect(await fs.stat(file).catch(() => null)).toBeNull();
  });

  it("writes no metadata at all when no flag was given", async () => {
    await cli(["new", "diagram.tldr"]);
    expect(await metaOf(file)).toBeNull();
  });
});

describe("helpers.meta", () => {
  it("amends the metadata from inside a snippet and the save keeps it", async () => {
    await cli(["new", "diagram.tldr", "--topic", "dot-product"]);
    const run = await cli([
      "run",
      "diagram.tldr",
      "--json",
      "--eval",
      "helpers.meta({ concepts: ['vectors', 'projection'] }); " + TWO_BOXES,
    ]);
    expect(run.code).toBe(0);

    const meta = await metaOf(file);
    expect(meta?.concepts).toEqual(["vectors", "projection"]);
    // Amending does not restate the topic, and must not lose it.
    expect(meta?.topic).toBe("dot-product");
  });

  it("reads the metadata back to the snippet", async () => {
    await cli(["new", "diagram.tldr", "--topic", "dot-product"]);
    const run = await cli([
      "run",
      "diagram.tldr",
      "--json",
      "--eval",
      "return helpers.meta()?.topic ?? null",
    ]);
    expect((JSON.parse(run.stdout) as { result: unknown }).result).toBe("dot-product");
  });

  it("refuses a slug that is not one, as a snippet error", async () => {
    await cli(["new", "diagram.tldr"]);
    const run = await cli([
      "run",
      "diagram.tldr",
      "--eval",
      "helpers.meta({ topic: 'Not A Slug' })",
    ]);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("is not a slug");
  });
});

describe("export carries the subject into the SVG", () => {
  it("writes a title element and a data-kc-topic attribute", async () => {
    await cli(["new", "diagram.tldr", "--topic", "dot-product", "--title", "Dot product"]);
    await cli(["run", "diagram.tldr", "--eval", TWO_BOXES, "--allow-lints"]);

    const exported = await cli(["export", "diagram.tldr", "--svg", "out.svg"]);
    expect(exported.code).toBe(0);

    const svg = await fs.readFile(path.join(dir, "out.svg"), "utf8");
    expect(svg).toContain('data-kc-topic="dot-product"');
    expect(svg).toContain("<title>Dot product</title>");
    // On the root element, before anything it contains.
    expect(svg.indexOf("<title>")).toBeLessThan(svg.indexOf("<g"));
  });

  it("leaves an unstamped document's SVG exactly as tldraw drew it", async () => {
    await cli(["new", "diagram.tldr"]);
    await cli(["run", "diagram.tldr", "--eval", TWO_BOXES, "--allow-lints"]);
    await cli(["export", "diagram.tldr", "--svg", "out.svg"]);

    const svg = await fs.readFile(path.join(dir, "out.svg"), "utf8");
    expect(svg).not.toContain("data-kc-topic");
  });
});

describe("the missing-topic lint", () => {
  it("warns on a document with no topic without changing the exit code", async () => {
    await cli(["new", "diagram.tldr"]);
    const run = await cli(["run", "diagram.tldr", "--eval", TWO_BOXES, "--json"]);
    expect(run.code).toBe(0);

    const lints = (JSON.parse(run.stdout) as InspectJson).lints;
    const warning = lints.find((lint) => lint.rule === "missing-topic");
    expect(warning?.severity).toBe("warn");
    expect(warning?.shapeIds).toEqual([]);
  });

  it("prints it as a warning rather than as a lint", async () => {
    await cli(["new", "diagram.tldr"]);
    const read = await cli(["inspect", "diagram.tldr"]);
    expect(read.code).toBe(0);
    expect(read.stdout).toContain("warn  missing-topic");
    expect(read.stdout).toContain("meta  (none)");
  });

  it("goes away once a topic is set", async () => {
    await cli(["new", "diagram.tldr"]);
    await cli(["meta", "set", "diagram.tldr", "--topic", "dot-product"]);
    const read = await cli(["inspect", "diagram.tldr", "--json"]);
    const canvas = JSON.parse(read.stdout) as InspectJson;
    expect(canvas.lints.map((lint) => lint.rule)).not.toContain("missing-topic");
    expect(canvas.meta?.topic).toBe("dot-product");
  });
});

describe("meta set", () => {
  it("stamps a document tldraw wrote, with no browser available", async () => {
    await cli(["new", "diagram.tldr"]);
    const stamped = await cli(
      ["meta", "set", "diagram.tldr", "--topic", "dot-product", "--json"],
      // A path that is not an executable: if this command ever launches a
      // browser, it fails here instead of quietly getting slower.
      { TLDRAWKC_CHROMIUM: path.join(dir, "no-such-browser") },
    );
    expect(stamped.code).toBe(0);
    expect((await metaOf(file))?.topic).toBe("dot-product");
  });

  it("is idempotent and says so", async () => {
    await cli(["new", "diagram.tldr"]);
    await cli(["meta", "set", "diagram.tldr", "--topic", "dot-product"]);
    const again = await cli(["meta", "set", "diagram.tldr", "--topic", "dot-product"]);
    expect(again.stdout).toContain("unchanged");
  });
});

describe("list", () => {
  it("reports every diagram, its siblings and what will not parse", async () => {
    await cli(["new", "good.tldr", "--topic", "dot-product", "--title", "Dot product"]);
    await cli(["run", "good.tldr", "--eval", TWO_BOXES, "--allow-lints"]);
    await cli(["export", "good.tldr", "--svg", "good.svg"]);
    await cli(["new", "plain.tldr"]);
    await fs.writeFile(path.join(dir, "broken.tldr"), "{ nope");

    const listed = await cli(["list", ".", "--json"], {
      TLDRAWKC_CHROMIUM: path.join(dir, "no-such-browser"),
    });
    expect(listed.code).toBe(0);

    const result = JSON.parse(listed.stdout) as ListJson;
    expect(result.dir).toBe(dir);
    expect(result.diagrams.map((entry) => entry.name)).toEqual(["good", "plain"]);

    const good = result.diagrams[0];
    expect(good?.meta?.topic).toBe("dot-product");
    expect(good?.svg.exists).toBe(true);
    expect(good?.png.exists).toBe(false);
    expect(good?.shapes).toBeGreaterThan(0);
    expect(good?.path).toBe(path.join(dir, "good.tldr"));

    expect(result.diagrams[1]?.meta).toBeNull();
    expect(result.errors.map((error) => error.relative)).toEqual(["broken.tldr"]);
  });

  it("prints a table with the topic first and a count underneath", async () => {
    await cli(["new", "good.tldr", "--topic", "dot-product"]);
    await cli(["new", "plain.tldr"]);

    const listed = await cli(["list", "."]);
    expect(listed.stdout).toContain("topic");
    expect(listed.stdout).toContain("dot-product");
    expect(listed.stdout).toContain("(none)");
    expect(listed.stdout).toContain("2 diagrams, 1 with a topic, 0 unreadable");
  });

  it("says the default directory is missing rather than printing nothing", async () => {
    const listed = await cli(["list"]);
    expect(listed.code).toBe(1);
    expect(listed.stderr).toContain("learn/assets");
  });
});
