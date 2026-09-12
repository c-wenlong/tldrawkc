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
  shapes: Array<{ id: string; type: string; geo?: string; text: string | null }>;
  bindings: Array<{ arrow: string; from: string | null; to: string | null }>;
  lints: Array<{ rule: string; shapeIds: string[]; message: string }>;
}

interface MermaidJson {
  file: string;
  nodes: Record<string, string>;
  edges: string[];
  containers: string[];
  unsupported: string[];
  shapeCount: number;
  lints: Array<{ rule: string; shapeIds: string[]; message: string }>;
  shot: string | null;
  ms: number;
}

interface ExportJson {
  file: string;
  svg: { path: string; width: number; height: number } | null;
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
 * A PNG's real pixel size, read from its IHDR chunk.
 *
 * The header starts at byte 16 with width then height as big-endian 32-bit
 * integers, which is fixed by the format, so this needs no decoder.
 */
async function pngSize(file: string): Promise<{ width: number; height: number }> {
  const bytes = await fs.readFile(file);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
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
    ]);
    expect(json.shapes).toHaveLength(8);
    expect(json.bindings).toHaveLength(4);
    expect(json.lints).toEqual([]);
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
    expect(canvas.lints).toEqual([]);

    const exported = await cli(["export", "diagram.tldr", "--svg", "out.svg"]);
    expect(exported.code).toBe(0);
    const svg = readableSvg(await fs.readFile(path.join(dir, "out.svg"), "utf8"));
    for (const label of labels) {
      expect(svg, `the SVG is missing "${label}"`).toContain(label);
    }
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
