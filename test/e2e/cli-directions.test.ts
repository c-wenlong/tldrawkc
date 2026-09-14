/**
 * The five mermaid directions, asserted on the rendered result.
 *
 * `test/unit/mermaid.test.ts` already pins the `Plan` the parser produces, and
 * a plan is not a picture: `applyPlan` throws the plan's coordinates away and
 * lays the ranks out again against the bounds tldraw actually produced
 * (`respaceRanks`), which is where a reversed axis could quietly invert. So
 * these cases go through the built binary, import one fixture five times with
 * its header rewritten, and read the geometry back out of `inspect --json`.
 *
 * The assertions are about direction, not about counts. For `TD` the first
 * rank's y is the smallest and the last rank's the largest; for `BT` the other
 * way round; `LR` and `RL` are the same statement on x. Each one also checks
 * that the rank axis is the only one that moved, so a layout that came out
 * transposed fails here rather than looking plausible in a shape count.
 */

import { describe, expect, it, beforeAll, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { CLI_ENTRY, PAGE_INDEX_HTML } from "../../src/lib/paths.js";
import { resolveChromium } from "../../src/lib/browser.js";

/** The roadmap fixture: 8 nodes, 9 edges, one subgraph, one back edge. */
const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "mermaid",
  "subgraph-8-9.mmd",
);

/** The fixture's own chain, first rank to last. `png`/`svg` share a rank. */
const FIRST = "agent";
const LAST = "look";

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface InspectJson {
  pages: string[];
  page: string;
  shapes: Array<{ id: string; type: string; x: number; y: number; w: number; h: number }>;
  lints: Array<{ rule: string; shapeIds: string[]; severity?: string }>;
}

let chromiumPath: string;
let dir: string;
let source: string;

beforeAll(async () => {
  for (const built of [CLI_ENTRY, PAGE_INDEX_HTML]) {
    const found = await fs.stat(built).catch(() => null);
    if (!found) throw new Error(`${built} is missing. Run \`npm run build\` first.`);
  }
  chromiumPath = (await resolveChromium()).executablePath;
  source = await fs.readFile(FIXTURE, "utf8");
});

beforeEach(async () => {
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "tldrawkc-dir-")));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

function cli(args: string[]): Promise<CliResult> {
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
    child.stdin.end("");
  });
}

/** Import the fixture under one direction and read the shapes back. */
async function importAs(direction: string): Promise<InspectJson["shapes"]> {
  const mmd = path.join(dir, `${direction}.mmd`);
  const tldr = path.join(dir, `${direction}.tldr`);
  await fs.writeFile(mmd, source.replace(/^flowchart\s+\S+$/m, `flowchart ${direction}`));

  const imported = await cli(["from-mermaid", tldr, "--source", mmd, "--json"]);
  expect(imported.stderr).toBe("");
  // Exit 0 under every direction. The `Looks right?` diamond used to be a
  // finding here, because the importer handed it the box a rectangle would get
  // and its label ran out through the slanted edges; the fit pass sizes it
  // against its own outline now, and the ranks still settle around the bigger
  // shape whichever way they run.
  expect(imported.code).toBe(0);

  const read = await cli(["inspect", tldr, "--json"]);
  expect(read.code).toBe(0);
  const parsed = JSON.parse(read.stdout) as InspectJson;
  expect(
    parsed.lints
      .filter((lint) => lint.severity !== "warn")
      .map((lint) => [lint.rule, lint.shapeIds]),
    `unexpected findings under ${direction}`,
  ).toEqual([]);
  return parsed.shapes;
}

/** One node's page box, by its mermaid id. */
function boxOf(shapes: InspectJson["shapes"], id: string) {
  const found = shapes.find((shape) => shape.id === `shape:${id}`);
  if (!found) throw new Error(`no shape for ${id}; got ${shapes.map((s) => s.id).join(", ")}`);
  return found;
}

describe("from-mermaid, the five directions, rendered", () => {
  it("TD and TB run the ranks down the page and agree with each other", async () => {
    const td = await importAs("TD");
    const tb = await importAs("TB");

    const first = boxOf(td, FIRST);
    const last = boxOf(td, LAST);
    expect(first.y).toBeLessThan(last.y);
    // The first rank clears the last one entirely, rather than merely starting
    // above it: overlapping bands would still satisfy a naive `<`.
    expect(first.y + first.h).toBeLessThan(last.y);
    // The slot axis stays put: a transposed layout would spread these on x.
    expect(Math.abs(first.x - last.x)).toBeLessThan(
      Math.abs(first.y - last.y),
    );

    // `TD` and `TB` are the same direction spelled two ways, so the same
    // fixture has to come back at the same coordinates.
    for (const id of [FIRST, "cli", "shapes", "png", "svg", LAST]) {
      expect(boxOf(tb, id)).toEqual(boxOf(td, id));
    }
  });

  it("BT runs the ranks up the page", async () => {
    const shapes = await importAs("BT");
    const first = boxOf(shapes, FIRST);
    const last = boxOf(shapes, LAST);
    expect(first.y).toBeGreaterThan(last.y);
    expect(last.y + last.h).toBeLessThan(first.y);
    expect(Math.abs(first.x - last.x)).toBeLessThan(Math.abs(first.y - last.y));

    // Every step of the chain moves up, not only its two ends.
    const chain = [FIRST, "cli", "browser", "page", "shapes"].map((id) =>
      boxOf(shapes, id),
    );
    for (let i = 1; i < chain.length; i++) {
      expect(chain[i]!.y).toBeLessThan(chain[i - 1]!.y);
    }
  });

  it("LR runs the ranks across the page, left to right", async () => {
    const shapes = await importAs("LR");
    const first = boxOf(shapes, FIRST);
    const last = boxOf(shapes, LAST);
    expect(first.x).toBeLessThan(last.x);
    expect(first.x + first.w).toBeLessThan(last.x);
    expect(Math.abs(first.y - last.y)).toBeLessThan(Math.abs(first.x - last.x));

    // The two nodes that share a rank stack on the slot axis, which for a
    // horizontal direction is y, and sit at the same x.
    const png = boxOf(shapes, "png");
    const svg = boxOf(shapes, "svg");
    expect(png.x).toBe(svg.x);
    expect(png.y).not.toBe(svg.y);
  });

  it("RL runs the ranks across the page, right to left", async () => {
    const shapes = await importAs("RL");
    const first = boxOf(shapes, FIRST);
    const last = boxOf(shapes, LAST);
    expect(first.x).toBeGreaterThan(last.x);
    expect(last.x + last.w).toBeLessThan(first.x);
    expect(Math.abs(first.y - last.y)).toBeLessThan(Math.abs(first.x - last.x));

    const chain = [FIRST, "cli", "browser", "page", "shapes"].map((id) =>
      boxOf(shapes, id),
    );
    for (let i = 1; i < chain.length; i++) {
      expect(chain[i]!.x).toBeLessThan(chain[i - 1]!.x);
    }

    const png = boxOf(shapes, "png");
    const svg = boxOf(shapes, "svg");
    expect(png.x).toBe(svg.x);
    expect(png.y).not.toBe(svg.y);
  });

  it("a reversed direction mirrors its forward twin on the rank axis", async () => {
    const lr = await importAs("LR");
    const rl = await importAs("RL");

    // Mirroring is the whole claim `RL` makes, so assert it as one: the gap
    // between two ranks is the same in both, with the sign flipped.
    const forward = boxOf(lr, "browser").x - boxOf(lr, FIRST).x;
    const reversed = boxOf(rl, "browser").x - boxOf(rl, FIRST).x;
    expect(reversed).toBe(-forward);

    // And the slot axis is untouched by the reversal.
    expect(boxOf(rl, FIRST).y).toBe(boxOf(lr, FIRST).y);
  });
});
