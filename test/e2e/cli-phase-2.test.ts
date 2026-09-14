/**
 * Reading, exporting and importing, through the built binary.
 *
 * Same shape as `cli.test.ts` next door and for the same reason: these are the
 * commands an agent actually types, and the exit-code table only means
 * something at the level a shell sees. What is under test here is the phase 2
 * half of CLI.md: `inspect`, `export`, `from-mermaid` and `api`.
 *
 * The mermaid cases need the page's `helpers.mermaid`. Until that lands they
 * fail with "the page bundle's helpers bag has no mermaid()", which is the
 * capability probe doing its job rather than a mystery.
 */

import { describe, expect, it, beforeAll, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { CLI_ENTRY, PAGE_INDEX_HTML, API_JSON } from "../../src/lib/paths.js";
import { resolveChromium } from "../../src/lib/browser.js";

/** The four-box example from README.md: 4 boxes, 4 bound arrows, 8 shapes. */
const FOUR_BOXES = `
helpers.box('agent', 'agent cli', { x: 60, y: 60, w: 170, h: 64 })
helpers.box('page', 'headless page', { after: 'agent', gap: 120, w: 190, h: 64 })
helpers.box('png', 'screenshot png', { below: 'page', gap: 90, w: 190, h: 64 })
helpers.box('tab', 'browser tab', { after: 'page', gap: 140, w: 170, h: 64 })
helpers.connect('agent', 'page', { label: 'exec' })
helpers.connect('page', 'png', { label: 'toImage' })
helpers.connect('png', 'agent', { label: 'read', start: 'left', end: 'bottom' })
helpers.connect('page', 'tab', { label: 'mirror', dash: 'dashed' })
return helpers.getLints()
`;

/** Where the `.mmd` fixtures live. The tests read their labels, never retype them. */
const FIXTURES = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "mermaid",
);

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface InspectJson {
  pages: string[];
  page: string;
  bounds: { x: number; y: number; w: number; h: number } | null;
  shapes: Array<{
    id: string;
    type: string;
    geo?: string;
    w: number;
    h: number;
    text: string | null;
  }>;
  bindings: Array<{ arrow: string; from: string | null; to: string | null }>;
  lints: Array<{ rule: string; shapeIds: string[]; message: string; severity?: string }>;
}

interface MermaidJson {
  file: string;
  nodes: Record<string, string>;
  edges: string[];
  containers: string[];
  unsupported: string[];
  shapeCount: number;
  lints: Array<{ rule: string; shapeIds: string[]; message: string; severity?: string }>;
  shot: string | null;
  ms: number;
}

interface ExportJson {
  file: string;
  svg: {
    path: string;
    width: number;
    height: number;
    bytes: number;
    fontsSubset: boolean;
    fontWarnings: string[];
  } | null;
  png: { path: string; width: number; height: number } | null;
  ms: number;
}

interface ApiJson {
  name: string;
  kind: string;
  signature: string;
  summary: string;
  examples: string[];
  params: string[];
}

let chromiumPath: string;
let dir: string;
let file: string;

beforeAll(async () => {
  for (const built of [CLI_ENTRY, PAGE_INDEX_HTML, API_JSON]) {
    const found = await fs.stat(built).catch(() => null);
    if (!found) throw new Error(`${built} is missing. Run \`npm run build\` first.`);
  }
  chromiumPath = (await resolveChromium()).executablePath;
});

beforeEach(async () => {
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "tldrawkc-p2-")));
  file = path.join(dir, "diagram.tldr");
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

function cli(args: string[], stdin?: string): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_ENTRY, ...args], {
      cwd: dir,
      env: { ...process.env, TLDRAWKC_CHROMIUM: chromiumPath },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
    child.stdin.end(stdin ?? "");
  });
}

/** Run a shell line, so a pipeline can be tested the way a shell runs one. */
function sh(line: string): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("/bin/sh", ["-c", line], { cwd: dir, env: { ...process.env } });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

/**
 * The names on the page's `Helpers` interface, read from the source.
 *
 * This is the list `api` has to cover, and taking it from the interface rather
 * than retyping it here is what makes a new helper with a broken doc block
 * fail the test instead of quietly going unlisted.
 */
async function helpersInterfaceMembers(): Promise<string[]> {
  const source = await fs.readFile(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "../../src/page/helpers/index.ts"),
    "utf8",
  );
  const body = /export interface Helpers \{([\s\S]*?)\n\}/.exec(source)?.[1];
  if (body === undefined) throw new Error("could not find the Helpers interface");
  const names = [...body.matchAll(/^ {2}([A-Za-z_$][\w$]*)\(/gm)].map((match) => match[1] ?? "");
  if (names.length === 0) throw new Error("the Helpers interface parsed as empty");
  return names;
}

/** Draw the four-box example into `diagram.tldr`. */
async function drawFourBoxes(): Promise<void> {
  await fs.writeFile(path.join(dir, "draw.js"), FOUR_BOXES);
  const drawn = await cli(["run", "diagram.tldr", "--code", "draw.js", "--create", "--json"]);
  expect(drawn.code).toBe(0);
}

// ---------------------------------------------------------------------------
// Reading labels out of a fixture, so no test retypes one
// ---------------------------------------------------------------------------

/**
 * The first line of a mermaid label, with its markup gone.
 *
 * `learn-map.mmd` writes each label as `Title<br/><small>38%</small>`, so the
 * title is what an SVG can be grepped for and the rest is decoration that the
 * parser may or may not keep.
 */
function firstLineOf(raw: string): string {
  const unquoted = raw.trim().replace(/^"([\s\S]*)"$/, "$1");
  const head = unquoted.split(/<br\s*\/?>/i)[0] ?? "";
  return head.replace(/<[^>]*>/g, "").trim();
}

/** Every node label in a flowchart, deduplicated, in file order. */
function mermaidLabels(source: string): string[] {
  const labels: string[] = [];
  for (const raw of source.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("%%") || line.startsWith("subgraph")) continue;
    for (const match of line.matchAll(/\[([^\]]+)\]|\{([^}]+)\}/g)) {
      const text = firstLineOf(match[1] ?? match[2] ?? "");
      if (text !== "") labels.push(text);
    }
  }
  return [...new Set(labels)];
}

/**
 * The SVG's text, with XML entities turned back into characters.
 *
 * tldraw renders a label as HTML inside a `<foreignObject>`, so the label is
 * in the file verbatim apart from the five characters XML has to escape.
 */
function readableSvg(svg: string): string {
  return svg
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * The font families the SVG inlines, with the size of each payload.
 *
 * `getSvgString` writes one `@font-face` per family it needs, with the woff2
 * as a base64 `data:` URL. Reading the families back is how a test says "both
 * faces survived" without knowing anything about woff2.
 */
function inlinedFonts(svg: string): Array<{ family: string; payload: number }> {
  const faces: Array<{ family: string; payload: number }> = [];
  for (const block of svg.matchAll(/@font-face\s*\{([^}]*)\}/g)) {
    const body = block[1] ?? "";
    const family = /font-family:\s*"?([^";\n]+)/.exec(body)?.[1]?.trim() ?? "";
    const payload = /base64,([A-Za-z0-9+/=]+)/.exec(body)?.[1] ?? "";
    faces.push({ family, payload: payload.length });
  }
  return faces;
}

/**
 * A PNG's real pixel size, read from its IHDR chunk.
 *
 * The header starts at byte 16 with width then height as big-endian 32-bit
 * integers, which is fixed by the format, so this needs no decoder.
 */
async function pngSize(file: string): Promise<{ width: number; height: number }> {
  const bytes = await fs.readFile(file);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/**
 * The findings that would cost an exit code 3.
 *
 * `missing-topic` is a warning and fires on every document nobody has given a
 * topic to, which is every fixture in this file: they are about the drawing,
 * not about the catalog. Filtering it out here keeps each assertion saying
 * "nothing is wrong with the picture", which is what it always meant.
 */
function errorLints(lints: Array<{ rule: string; severity?: string; shapeIds?: string[] }>) {
  return lints.filter((lint) => (lint.severity ?? "error") === "error");
}

describe("inspect", () => {
  it("reports every shape and binding from a document a snippet drew", async () => {
    await drawFourBoxes();

    const result = await cli(["inspect", "diagram.tldr", "--json"]);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);

    const json = JSON.parse(result.stdout) as InspectJson;
    expect(Object.keys(json)).toEqual([
      "pages",
      "page",
      "bounds",
      "shapes",
      "bindings",
      "lints",
      "meta",
    ]);
    expect(json.shapes).toHaveLength(8);
    expect(json.bindings).toHaveLength(4);
    expect(errorLints(json.lints)).toEqual([]);
    expect(json.shapes.map((shape) => shape.text)).toContain("agent cli");
    // Every arrow is bound at both ends, which is the whole point of `connect`.
    expect(json.bindings.every((binding) => binding.from && binding.to)).toBe(true);
  });

  it("prints one line per shape in human mode", async () => {
    await drawFourBoxes();
    const result = await cli(["inspect", "diagram.tldr"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('"agent cli"');
    expect(result.stdout).toContain("rectangle");
    expect(result.stdout).toContain("bind  ");
  });

  it("exits 1 on a file that is not there", async () => {
    const result = await cli(["inspect", "missing.tldr"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("does not exist");
  });
});

describe("export", () => {
  it("writes a PNG larger than 10 kB", async () => {
    await drawFourBoxes();
    const result = await cli(["export", "diagram.tldr", "--png", "out.png", "--json"]);
    expect(result.code).toBe(0);

    const json = JSON.parse(result.stdout) as ExportJson;
    expect(json.svg).toBeNull();
    expect(json.png?.path).toBe(path.join(dir, "out.png"));
    // A blank or font-less canvas compresses to far less than this.
    expect((await fs.stat(path.join(dir, "out.png"))).size).toBeGreaterThan(10_000);

    // CLI.md promises pixels. tldraw's `toImage` reports the framed region in
    // page units, which at the default pixel ratio is half the file, so read
    // the answer back out of the PNG header rather than trusting it.
    const header = await pngSize(path.join(dir, "out.png"));
    expect(json.png?.width).toBe(header.width);
    expect(json.png?.height).toBe(header.height);
  });

  it("writes an SVG carrying every label, and both formats at once", async () => {
    await drawFourBoxes();
    const result = await cli([
      "export",
      "diagram.tldr",
      "--svg",
      "out.svg",
      "--png",
      "out.png",
      "--json",
    ]);
    expect(result.code).toBe(0);
    const json = JSON.parse(result.stdout) as ExportJson;
    expect(json.svg).not.toBeNull();
    expect(json.png).not.toBeNull();

    const svg = readableSvg(await fs.readFile(path.join(dir, "out.svg"), "utf8"));
    for (const label of ["agent cli", "headless page", "screenshot png", "browser tab"]) {
      expect(svg, `the SVG is missing "${label}"`).toContain(label);
    }
  });

  it("refuses to write over the document it is exporting", async () => {
    // `--svg ./diagram.tldr` would replace the only editable copy of the
    // drawing with a picture of it, and nothing gets that back.
    await drawFourBoxes();
    const before = await fs.readFile(file, "utf8");
    const result = await cli(["export", "diagram.tldr", "--svg", "./diagram.tldr"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("over the document itself");
    expect(await fs.readFile(file, "utf8")).toBe(before);
  });

  it("refuses to run with neither --svg nor --png", async () => {
    await drawFourBoxes();
    const result = await cli(["export", "diagram.tldr"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("--svg");
  });
});

describe("export --svg font subsetting", () => {
  it("cuts the eight-node map to a fraction of its weight, labels intact", async () => {
    const source = path.join(FIXTURES, "subgraph-8-9.mmd");
    const labels = mermaidLabels(await fs.readFile(source, "utf8"));
    // No `--allow-lints`: the import is clean, `Looks right?` included, since
    // the importer grows a pinched geo to the box its label needs.
    expect(await cli(["from-mermaid", "diagram.tldr", "--source", source])).toHaveProperty(
      "code",
      0,
    );

    const small = await cli(["export", "diagram.tldr", "--svg", "small.svg", "--json"]);
    expect(small.code).toBe(0);
    const json = JSON.parse(small.stdout) as ExportJson;
    expect(json.svg?.fontsSubset).toBe(true);
    expect(json.svg?.fontWarnings).toEqual([]);

    const svg = await fs.readFile(path.join(dir, "small.svg"), "utf8");
    // The reported size is the file's size, not an estimate.
    expect(json.svg?.bytes).toBe(Buffer.byteLength(svg, "utf8"));

    // Still self-contained, and still the hand-drawn face: an SVG rendered as
    // an image fetches nothing, so a face that is gone is a face the reader
    // never sees.
    const faces = inlinedFonts(svg);
    expect(faces.map((face) => face.family)).toContain("tldraw_draw");
    expect(faces.every((face) => face.payload > 0)).toBe(true);

    // The number this feature moves. Shantell Sans whole is about 205 kB of
    // base64; eight labels of it are a fraction of that. The file as a whole
    // is not asserted on, because the rest of it is the drawing: this fixture
    // is 83 kB of path data whatever the fonts do.
    const payload = faces.reduce((total, face) => total + face.payload, 0);
    expect(payload).toBeLessThan(60_000);

    const readable = readableSvg(svg);
    for (const label of labels) {
      expect(readable, `the SVG is missing "${label}"`).toContain(label);
    }
  });

  it("keeps the whole font for --no-subset-fonts, and says so", async () => {
    const source = path.join(FIXTURES, "subgraph-8-9.mmd");
    // No `--allow-lints`: the import is clean, `Looks right?` included, since
    // the importer grows a pinched geo to the box its label needs.
    expect(await cli(["from-mermaid", "diagram.tldr", "--source", source])).toHaveProperty(
      "code",
      0,
    );

    const small = await cli(["export", "diagram.tldr", "--svg", "small.svg", "--json"]);
    const whole = await cli([
      "export",
      "diagram.tldr",
      "--svg",
      "whole.svg",
      "--no-subset-fonts",
      "--json",
    ]);
    expect(small.code).toBe(0);
    expect(whole.code).toBe(0);

    const smallJson = JSON.parse(small.stdout) as ExportJson;
    const wholeJson = JSON.parse(whole.stdout) as ExportJson;
    expect(wholeJson.svg?.fontsSubset).toBe(false);
    // The flag is what a diagram destined for a hand edit asks for, so it has
    // to give back the file it would have got before any of this existed.
    expect(wholeJson.svg?.bytes ?? 0).toBeGreaterThan((smallJson.svg?.bytes ?? 0) * 2);

    const wholeFaces = inlinedFonts(await fs.readFile(path.join(dir, "whole.svg"), "utf8"));
    const smallFaces = inlinedFonts(await fs.readFile(path.join(dir, "small.svg"), "utf8"));
    expect(wholeFaces.map((face) => face.family)).toEqual(smallFaces.map((face) => face.family));
    for (const [index, face] of smallFaces.entries()) {
      expect(face.payload).toBeLessThan(wholeFaces[index]?.payload ?? 0);
    }
  });

  it("keeps both faces on a canvas that mixes draw and sans", async () => {
    // Two families in the drawing, so two have to survive: subsetting must
    // shrink a face, never decide a used one is spare.
    await fs.writeFile(
      path.join(dir, "mixed.js"),
      [
        "helpers.box('hand', 'drawn label', { x: 60, y: 60, w: 200, h: 64 })",
        "helpers.box('typed', 'typed label', { below: 'hand', gap: 120, w: 200, h: 64, font: 'sans' })",
        "return helpers.getLints()",
      ].join("\n"),
    );
    const drawn = await cli([
      "run",
      "diagram.tldr",
      "--code",
      "mixed.js",
      "--create",
      "--allow-lints",
    ]);
    expect(drawn.code).toBe(0);

    const exported = await cli(["export", "diagram.tldr", "--svg", "mixed.svg", "--json"]);
    expect(exported.code).toBe(0);
    expect((JSON.parse(exported.stdout) as ExportJson).svg?.fontsSubset).toBe(true);

    const faces = inlinedFonts(await fs.readFile(path.join(dir, "mixed.svg"), "utf8"));
    const families = faces.map((face) => face.family).sort();
    expect(families).toEqual(["tldraw_draw", "tldraw_sans"]);
    expect(faces.every((face) => face.payload > 0)).toBe(true);
    // The two families tldraw never inlined stay absent, which is what the
    // "drop what nothing uses" half of this exists to guarantee.
    expect(families).not.toContain("tldraw_mono");
    expect(families).not.toContain("tldraw_serif");
  });

  it("reports the size on the human line too", async () => {
    await drawFourBoxes();
    const result = await cli(["export", "diagram.tldr", "--svg", "out.svg"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/svg {3}.*\d+x\d+ {2}[\d.]+ kB, fonts subset/);
  });
});

describe("api", () => {
  it("lists the helpers a snippet can call, each with an example", async () => {
    const result = await cli(["api", "--json"]);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);

    const docs = JSON.parse(result.stdout) as ApiJson[];
    const byName = new Map(docs.map((doc) => [doc.name, doc]));

    // Every member of the `Helpers` interface, not a sample: a helper missing
    // from the reference is a malformed JSDoc block, and the only way that
    // shows up is by checking the bag the page actually hands a snippet.
    for (const name of await helpersInterfaceMembers()) {
      const doc = byName.get(name);
      expect(doc, `api does not document ${name}`).toBeDefined();
      expect(doc?.summary, `${name} has no summary`).not.toBe("");
      expect(doc?.examples.length ?? 0, `${name} has no @example`).toBeGreaterThan(0);
      expect(doc?.signature).toContain(name);
    }
  });

  it("stops quietly when the reader closes the pipe", async () => {
    // `tldrawkc api | head` is how an agent skims a long listing, and an
    // unhandled EPIPE turns that into a Node stack trace.
    const node = JSON.stringify(process.execPath);
    const entry = JSON.stringify(CLI_ENTRY);
    const result = await sh(`${node} ${entry} api | head -3`);
    expect(result.stderr).not.toContain("EPIPE");
    expect(result.stdout.split("\n").filter((line) => line !== "")).toHaveLength(3);
  });

  it("prints a readable block per helper in human mode", async () => {
    const result = await cli(["api"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("helpers.box(");
    expect(result.stdout).toContain("helpers.connect(");
  });
});

describe("from-mermaid", () => {
  it("builds a canvas with a bound arrow for every edge", async () => {
    const source = path.join(FIXTURES, "subgraph-8-9.mmd");
    const labels = mermaidLabels(await fs.readFile(source, "utf8"));
    // The fixture's own header says 8 nodes and 9 edges. Reading the labels
    // rather than retyping them is what keeps this test honest when the
    // fixture changes.
    expect(labels).toHaveLength(8);

    const built = await cli(["from-mermaid", "diagram.tldr", "--source", source, "--json"]);
    // Exit 0: every node holds its label, `Looks right?` included. The parser
    // sizes a node by counting characters, which describes a box, and the fit
    // pass then grows the diamond until its outline holds the text that box
    // would have let out through the slanted edges.
    expect(built.code).toBe(0);
    const json = JSON.parse(built.stdout) as MermaidJson;
    expect(Object.keys(json.nodes)).toHaveLength(8);
    expect(json.edges).toHaveLength(9);
    expect(json.containers).toHaveLength(1);
    expect(json.unsupported).toEqual([]);

    const read = await cli(["inspect", "diagram.tldr", "--json"]);
    expect(read.code).toBe(0);
    const canvas = JSON.parse(read.stdout) as InspectJson;
    expect(canvas.bindings).toHaveLength(9);
    expect(canvas.bindings.every((binding) => binding.from && binding.to)).toBe(true);
    // Nothing at all, listed rather than counted so that a finding which does
    // appear names itself in the failure.
    expect(errorLints(canvas.lints).map((lint) => [lint.rule, lint.shapeIds])).toEqual([]);

    const exported = await cli(["export", "diagram.tldr", "--svg", "out.svg"]);
    expect(exported.code).toBe(0);
    const svg = readableSvg(await fs.readFile(path.join(dir, "out.svg"), "utf8"));
    for (const label of labels) {
      expect(svg, `the SVG is missing "${label}"`).toContain(label);
    }
  });

  it("gives a pinched geo the box its outline needs, not the one a box would", async () => {
    // The same words in a rectangle and in a diamond. A diamond holds a
    // fraction of its width across the rows a label sits on, so the two cannot
    // come out the same size without the label crossing the slanted edges,
    // which is the whole of this gap. Both are clean, and the diamond is
    // bigger in both directions.
    await fs.writeFile(
      path.join(dir, "pinched.mmd"),
      ["flowchart TD", "  box[Ship it or think again]", "  box --> dia{Ship it or think again}"].join(
        "\n",
      ),
    );
    const built = await cli([
      "from-mermaid",
      "diagram.tldr",
      "--source",
      path.join(dir, "pinched.mmd"),
      "--json",
    ]);
    expect(built.code, built.stderr).toBe(0);

    const read = await cli(["inspect", "diagram.tldr", "--json"]);
    expect(read.code).toBe(0);
    const canvas = JSON.parse(read.stdout) as InspectJson;
    expect(errorLints(canvas.lints)).toEqual([]);

    const shapeOf = (id: string) => {
      const found = canvas.shapes.find((shape) => shape.id === `shape:${id}`);
      if (!found) throw new Error(`no shape for ${id}`);
      return found;
    };
    const box = shapeOf("box");
    const diamond = shapeOf("dia");
    expect(diamond.geo).toBe("diamond");
    expect(diamond.w).toBeGreaterThan(box.w);
    expect(diamond.h).toBeGreaterThan(box.h);
    // And not by an absurd amount: a node that grew four times as wide as the
    // rectangle beside it is the failure this fix must not trade up for.
    expect(diamond.w).toBeLessThan(box.w * 3);
  });

  it("sizes a rotated node against its own geometry, not its page box", async () => {
    // `--append` can reach a node somebody turned, and a rotated shape's page
    // box is neither of its own dimensions: at 45 degrees a wide, short diamond
    // reports a square. Growing `props.w` and `props.h` by the difference
    // against that box stretched this one sideways and left its height alone,
    // which is a distorted shape rather than a fitted one.
    await fs.writeFile(
      path.join(dir, "rotated.mmd"),
      ["flowchart TD", "  look{Looks right?} --> done[done]"].join("\n"),
    );
    const drawn = await cli([
      "run",
      "diagram.tldr",
      "--create",
      "--eval",
      "helpers.box('look', 'Looks right?', { x: 60, y: 60, w: 196, h: 64, geo: 'diamond', verticalAlign: 'middle' });" +
        " editor.updateShape({ id: 'shape:look', type: 'geo', rotation: Math.PI / 4 })",
      "--allow-lints",
    ]);
    expect(drawn.code, drawn.stderr).toBe(0);

    const appended = await cli([
      "from-mermaid",
      "diagram.tldr",
      "--source",
      path.join(dir, "rotated.mmd"),
      "--append",
      "--json",
    ]);
    expect(appended.code, appended.stderr).toBe(0);

    // The file rather than `inspect`, which reports the page box a rotation
    // inflates. What the fit pass wrote is the shape's own size.
    const document = JSON.parse(await fs.readFile(path.join(dir, "diagram.tldr"), "utf8")) as {
      records: Array<{ id: string; rotation?: number; props?: { w?: number; h?: number } }>;
    };
    const diamond = document.records.find((record) => record.id === "shape:look");
    expect(diamond?.rotation).toBeCloseTo(Math.PI / 4, 5);
    expect(diamond?.props?.w).toBeGreaterThan(196);
    expect(diamond?.props?.h).toBeGreaterThan(64);
  });

  it("refuses an existing document without --append, and adds to it with one", async () => {
    const source = path.join(FIXTURES, "simple-td.mmd");
    const first = await cli(["from-mermaid", "diagram.tldr", "--source", source, "--json"]);
    expect(first.code).toBe(0);
    const before = (JSON.parse(first.stdout) as MermaidJson).shapeCount;

    const refused = await cli(["from-mermaid", "diagram.tldr", "--source", source]);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("--append");

    const appended = await cli([
      "from-mermaid",
      "diagram.tldr",
      "--source",
      path.join(FIXTURES, "shapes.mmd"),
      "--append",
      "--json",
      "--allow-lints",
    ]);
    expect(appended.code).toBe(0);
    expect((JSON.parse(appended.stdout) as MermaidJson).shapeCount).toBeGreaterThan(before);
  });

  it("reports the lines it could not read instead of dropping them", async () => {
    const source = path.join(FIXTURES, "broken.mmd");
    const result = await cli(["from-mermaid", "diagram.tldr", "--source", source, "--json"]);

    // 0 or 3 depending on what the layout leaves behind, never 1: an
    // unreadable line is a report, not a failure.
    expect([0, 3]).toContain(result.code);
    const json = JSON.parse(result.stdout) as MermaidJson;
    expect(json.unsupported.length).toBeGreaterThan(0);
    expect(json.unsupported.join("\n")).toContain("this line is not mermaid at all");
    // The rest of the diagram survived it.
    expect(Object.keys(json.nodes).length).toBeGreaterThan(0);
  });

  it("reads the flowchart from stdin with --source -", async () => {
    const source = await fs.readFile(path.join(FIXTURES, "simple-td.mmd"), "utf8");
    const result = await cli(
      ["from-mermaid", "diagram.tldr", "--source", "-", "--json"],
      source,
    );
    expect(result.code).toBe(0);
    expect(Object.keys((JSON.parse(result.stdout) as MermaidJson).nodes).length).toBeGreaterThan(0);
    expect(JSON.parse(await fs.readFile(file, "utf8"))).toHaveProperty("records");
  });

  it(
    "lifts the learn map: no friendless arrows, every title in the SVG",
    async () => {
      // The definition of done for phase 2 in ROADMAP.md: the flowchart this
      // repo's knowledge base already has, on a canvas, readable.
      const source = path.join(FIXTURES, "learn-map.mmd");
      const labels = mermaidLabels(await fs.readFile(source, "utf8"));
      expect(labels).toHaveLength(32);

      const built = await cli([
        "from-mermaid",
        "diagram.tldr",
        "--source",
        source,
        "--json",
        "--allow-lints",
      ]);
      expect(built.code).toBe(0);
      const json = JSON.parse(built.stdout) as MermaidJson;
      expect(Object.keys(json.nodes)).toHaveLength(32);

      const read = await cli(["inspect", "diagram.tldr", "--json", "--allow-lints"]);
      expect(read.code).toBe(0);
      const canvas = JSON.parse(read.stdout) as InspectJson;
      // Only this rule. A big generated layout may still overlap somewhere,
      // and that is a nudge for the agent; an arrow pointing at nothing is a
      // broken diagram.
      expect(canvas.lints.filter((lint) => lint.rule === "friendless-arrow")).toEqual([]);
      // The one rule the map is expected to fail. Thirty-two nodes on a grid
      // and seventy edges between them cannot avoid it, which is exactly what
      // it was added to show; no count is pinned here because the layout is
      // free to improve.
      expect(
        canvas.lints.some((lint) => lint.rule === "arrow-crosses-shape"),
        "arrow-crosses-shape never fired, so the rule is not reaching the browser",
      ).toBe(true);

      const exported = await cli(["export", "diagram.tldr", "--svg", "map.svg"]);
      expect(exported.code).toBe(0);
      const svg = readableSvg(await fs.readFile(path.join(dir, "map.svg"), "utf8"));
      for (const label of labels) {
        expect(svg, `the SVG is missing "${label}"`).toContain(label);
      }
    },
    // Thirty-two boxes, forty arrows, four browser launches.
    90_000,
  );
});
