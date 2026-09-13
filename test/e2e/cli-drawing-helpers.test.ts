/**
 * The three helpers a real redraw had to hand-roll, through the built binary.
 *
 * `line`, `matchSize` and `alignContainers`, and `text`'s `centerOn` family.
 * All three are here rather than in the unit suite because none of them can be
 * checked without a browser: the sizes are page bounds tldraw computed after
 * growing a shape to its label, and the centring is against a width only the
 * browser's own text measurement knows.
 *
 * The case is the one the evidence asked for. `learn/assets/dot-product.tldr`
 * drew two panels of different member counts and they came out 1303 x 418 and
 * 1299 x 489, which a reader takes for meaning; every title in both redraws was
 * placed by eye and none of them is centred on anything; and 27 arrows between
 * them are unbound marks carrying a hand-written `meta.lintIgnore`.
 */

import { describe, expect, it, beforeAll, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import { CLI_ENTRY, PAGE_INDEX_HTML } from "../../src/lib/paths.js";
import { resolveChromium } from "../../src/lib/browser.js";

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface DescribedShape {
  id: string;
  type: string;
  x: number;
  y: number;
  w: number;
  h: number;
  text: string | null;
}

interface Described {
  shapes: DescribedShape[];
  lints: Array<{ rule: string; shapeIds: string[]; message: string; severity?: string }>;
}

interface RunJson {
  result: Described;
  lints: unknown[];
}

/**
 * Two panels holding different numbers of boxes, matched, titled and ruled.
 *
 * The left panel holds three boxes and the right holds two, so before
 * `alignContainers` they are visibly different heights. The title is placed
 * with `above`, so nothing here computes a centre by hand, which is the whole
 * point: the numbers the assertions check are ones the snippet never knew.
 */
const TWO_PANELS = `
helpers.box('a1', 'first', { x: 60, y: 200, w: 170, h: 64 })
helpers.box('a2', 'second', { below: 'a1', gap: 40, w: 170, h: 64 })
helpers.box('a3', 'third', { below: 'a2', gap: 40, w: 170, h: 64 })
helpers.box('b1', 'alpha', { x: 640, y: 200, w: 170, h: 64 })
helpers.box('b2', 'beta', { below: 'b1', gap: 40, w: 170, h: 64 })

helpers.boxShapes(['a1', 'a2', 'a3'], { label: 'three of them', shapeId: 'panel-left' })
helpers.boxShapes(['b1', 'b2'], { label: 'two of them', shapeId: 'panel-right' })
helpers.alignContainers(['panel-left', 'panel-right'])

helpers.text('title', 'the same shape, two ways', {
  above: ['panel-left', 'panel-right'],
  gap: 60,
  size: 'l',
})

helpers.line('rule', 60, 900, 820, 900, {
  head: 'both',
  dash: 'dashed',
  color: 'red',
  size: 'm',
})
helpers.stub('legend', 60, 980, 120, 0, { dash: 'dotted', color: 'violet', size: 'l' })

return helpers.describe()
`;

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
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "tldrawkc-helpers-")));
  file = path.join(dir, "panels.tldr");
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

/** One shape's record straight out of the saved file, props and meta included. */
async function recordOf(target: string, id: string): Promise<Record<string, unknown>> {
  const parsed = JSON.parse(await fs.readFile(target, "utf8")) as {
    records: Record<string, unknown>[];
  };
  const record = parsed.records.find((entry) => entry["id"] === id);
  if (!record) throw new Error(`no record ${id} in ${target}`);
  return record;
}

function shapeNamed(described: Described, id: string): DescribedShape {
  const shape = described.shapes.find((entry) => entry.id === id);
  if (!shape) throw new Error(`no shape ${id} in the described page`);
  return shape;
}

describe("the drawing helpers, drawn for real", () => {
  it("matches two panels, centres the title on them, and styles the line", async () => {
    // A topic, so `missing-topic` does not put a warning in the list the
    // assertions below expect to be empty.
    const created = await cli(["new", "panels.tldr", "--topic", "dot-product"]);
    expect(created.code).toBe(0);

    const snippet = path.join(dir, "draw.js");
    await fs.writeFile(snippet, TWO_PANELS, "utf8");
    const run = await cli(["run", "panels.tldr", "--code", snippet, "--json"]);

    expect(run.stderr).toBe("");
    expect(run.code).toBe(0);

    const described = (JSON.parse(run.stdout) as RunJson).result;
    expect(described.lints).toEqual([]);

    // 1. The two containers end up identical, which is what the redraw had to
    //    do by hand and got wrong by 71 units of height.
    const left = shapeNamed(described, "shape:panel-left");
    const right = shapeNamed(described, "shape:panel-right");
    expect(right.w).toBeCloseTo(left.w, 6);
    expect(right.h).toBeCloseTo(left.h, 6);

    // Each kept its own top-left: matching sizes must not move a panel.
    expect(left.x).toBeCloseTo(20, 6);
    expect(right.x).toBeCloseTo(600, 6);
    expect(left.y).toBeCloseTo(right.y, 6);

    // The right panel held one box fewer, so it is the one that grew.
    expect(left.h).toBeGreaterThan(200);

    // 2. The title sits on the centre of the two panels together, measured
    //    rather than assumed: nothing in the snippet named an x at all.
    const title = shapeNamed(described, "shape:title");
    const unionCentre = (left.x + Math.max(left.x + left.w, right.x + right.w)) / 2;
    expect(title.x + title.w / 2).toBeCloseTo(unionCentre, 0);
    expect(Math.abs(title.x + title.w / 2 - unionCentre)).toBeLessThan(1);

    // And `gap: 60` clear of the panels, not overlapping them.
    expect(left.y - (title.y + title.h)).toBeCloseTo(60, 0);

    // 3. The line carries the style it was asked for and mutes both rules that
    //    are meaningless for geometry that is not a connection.
    const rule = await recordOf(file, "shape:rule");
    const props = rule["props"] as Record<string, unknown>;
    expect(props["dash"]).toBe("dashed");
    expect(props["color"]).toBe("red");
    expect(props["size"]).toBe("m");
    expect(props["arrowheadStart"]).toBe("arrow");
    expect(props["arrowheadEnd"]).toBe("arrow");
    expect(props["end"]).toEqual({ x: 760, y: 0 });
    expect((rule["meta"] as Record<string, unknown>)["lintIgnore"]).toEqual([
      "friendless-arrow",
      "arrow-crosses-shape",
    ]);

    // 4. `stub` used to accept these three and drop them on the floor, so a
    //    legend dash asked for in violet came out black.
    const legend = await recordOf(file, "shape:legend");
    const legendProps = legend["props"] as Record<string, unknown>;
    expect(legendProps["dash"]).toBe("dotted");
    expect(legendProps["color"]).toBe("violet");
    expect(legendProps["size"]).toBe("l");
    expect(legendProps["end"]).toEqual({ x: 120, y: 0 });
  });

  it("unbinds an arrow whose key a line takes over", async () => {
    // A line is supposed to stay where it was put. Taking over the key of an
    // arrow that `connect` had bound would otherwise leave the binding records
    // behind, since `updateShape` does not touch them, and the result would be
    // a line that still follows two shapes around.
    await cli(["new", "panels.tldr", "--topic", "dot-product"]);
    const bind = path.join(dir, "bind.js");
    await fs.writeFile(
      bind,
      `
      helpers.box('a', 'first', { x: 60, y: 60, w: 170, h: 64 })
      helpers.box('b', 'second', { after: 'a', gap: 140, w: 170, h: 64 })
      return helpers.connect('a', 'b', { label: 'then' })
      `,
      "utf8",
    );
    const bound = await cli(["run", "panels.tldr", "--code", bind, "--json"]);
    expect(bound.code).toBe(0);
    const arrowId = (JSON.parse(bound.stdout) as { result: string }).result;
    expect(arrowId).toMatch(/^shape:/u);

    const takeover = path.join(dir, "takeover.js");
    await fs.writeFile(
      takeover,
      `
      helpers.line(${JSON.stringify(arrowId)}, 60, 400, 460, 400, { color: 'red' })
      return helpers.describe().bindings
      `,
      "utf8",
    );
    const relined = await cli(["run", "panels.tldr", "--code", takeover, "--json"]);
    expect(relined.code).toBe(0);

    const bindings = (JSON.parse(relined.stdout) as { result: unknown[] }).result;
    expect(bindings).toEqual([{ arrow: arrowId, from: null, to: null, fromAnchor: null, toAnchor: null }]);

    // And it is where it was put, not wherever the two boxes dragged it.
    const line = await recordOf(file, arrowId);
    expect(line["x"]).toBe(60);
    expect(line["y"]).toBe(400);
    expect((line["props"] as Record<string, unknown>)["end"]).toEqual({ x: 400, y: 0 });
  });

  it("is idempotent, so a second run moves the line rather than stacking one", async () => {
    await cli(["new", "panels.tldr", "--topic", "dot-product"]);
    const snippet = path.join(dir, "draw.js");
    await fs.writeFile(snippet, TWO_PANELS, "utf8");

    const first = await cli(["run", "panels.tldr", "--code", snippet, "--json"]);
    expect(first.code).toBe(0);
    const before = (JSON.parse(first.stdout) as RunJson).result.shapes.length;

    const second = await cli(["run", "panels.tldr", "--code", snippet, "--json"]);
    expect(second.code).toBe(0);
    const after = (JSON.parse(second.stdout) as RunJson).result;
    expect(after.shapes.length).toBe(before);
    expect(after.lints).toEqual([]);

    // Re-running must not grow the panels a second time either.
    const left = shapeNamed(after, "shape:panel-left");
    const right = shapeNamed(after, "shape:panel-right");
    expect(right.w).toBeCloseTo(left.w, 6);
    expect(right.h).toBeCloseTo(left.h, 6);
  });
});
