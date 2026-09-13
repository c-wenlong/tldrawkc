/**
 * `--page`, `--allow-lints` and `meta.lintIgnore` on a real two-page document.
 *
 * Every document the tool had drawn until this file existed had one page, so
 * the page-scoped half of CLI.md was specified and never run: `--page` reaches
 * `run`, `shot`, `inspect`, `export` and `from-mermaid`, lints are collected
 * from the current page only, and `--allow-lints` and `meta.lintIgnore` are
 * supposed to mean the same thing whichever page the finding is on.
 *
 * The second page is made from a snippet with `helpers.page`, so the fixture is
 * the snippet rather than a committed `.tldr`: a binary fixture here would pin
 * one tldraw schema version and say nothing about how a page gets created.
 */

import { describe, expect, it, beforeAll, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import { CLI_ENTRY, PAGE_INDEX_HTML } from "../../src/lib/paths.js";
import { resolveChromium } from "../../src/lib/browser.js";

/**
 * One clean page and one with two boxes lying on each other.
 *
 * The overlap is deliberate: `overlapping-shapes` and `overlapping-text` are
 * error-level, so page two is the exit-3 side and page one is the exit-0 side,
 * which is the whole point of the leak tests below.
 */
const TWO_PAGES = `
helpers.box('one', 'page one box', { x: 100, y: 100, w: 200, h: 80 })
helpers.page('notes')
helpers.box('n1', 'note one', { x: 100, y: 100, w: 200, h: 80 })
helpers.box('n2', 'note two', { x: 140, y: 120, w: 200, h: 80 })
return { pages: editor.getPages().map((p) => p.name) }
`;

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface InspectJson {
  pages: string[];
  page: string;
  bounds: { x: number; y: number; w: number; h: number } | null;
  shapes: Array<{ id: string; type: string; text: string | null }>;
  lints: Array<{ rule: string; shapeIds: string[]; message: string; severity?: string }>;
}

interface ShotJson {
  shot: string;
  width: number;
  height: number;
  bounds: { x: number; y: number; w: number; h: number };
}

interface ExportJson {
  svg: { path: string; width: number; height: number; bytes: number } | null;
}

let chromiumPath: string;
let dir: string;

beforeAll(async () => {
  for (const built of [CLI_ENTRY, PAGE_INDEX_HTML]) {
    const found = await fs.stat(built).catch(() => null);
    if (!found) throw new Error(`${built} is missing. Run \`npm run build\` first.`);
  }
  chromiumPath = (await resolveChromium()).executablePath;
});

beforeEach(async () => {
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "tldrawkc-pages-")));
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

/** Write a snippet and run it against `two.tldr`. */
async function run(source: string, extra: string[] = []): Promise<CliResult> {
  const snippet = path.join(dir, `snippet-${String(Math.random()).slice(2)}.js`);
  await fs.writeFile(snippet, source);
  return cli(["run", "two.tldr", "--code", snippet, "--json", ...extra]);
}

/** Draw the two-page fixture. Page two's overlap makes this exit 3. */
async function drawTwoPages(): Promise<void> {
  const drawn = await run(TWO_PAGES, ["--create", "--allow-lints"]);
  expect(drawn.code).toBe(0);
  expect((JSON.parse(drawn.stdout) as { result: { pages: string[] } }).result.pages).toEqual([
    "Page 1",
    "notes",
  ]);
}

async function inspect(extra: string[] = []): Promise<{ code: number; json: InspectJson }> {
  const read = await cli(["inspect", "two.tldr", "--json", ...extra]);
  return { code: read.code, json: JSON.parse(read.stdout) as InspectJson };
}

/** The rules a lint list names, warnings included. */
function rules(json: InspectJson): string[] {
  return json.lints.map((lint) => lint.rule);
}

describe("a two-page document", () => {
  it("helpers.page adds a page, and a second call selects the one it made", async () => {
    await drawTwoPages();

    // Re-running the same snippet must not stack a `notes (1)` beside it:
    // `editor.createPage` uniquifies a name, which is why `page()` looks first.
    const again = await run(TWO_PAGES, ["--allow-lints"]);
    expect(again.code).toBe(0);
    const { json } = await inspect();
    expect(json.pages).toEqual(["Page 1", "notes"]);
  });

  it("keeps the page order across a save and load, and comes back on the first page", async () => {
    await drawTwoPages();
    // The snippet left the editor on `notes`. A `.tldr` is loaded document-scope
    // only, so the current page is not carried over: CLI.md's "first page"
    // default is what a reader gets, and `--page` is how to say otherwise.
    const { json } = await inspect();
    expect(json.pages).toEqual(["Page 1", "notes"]);
    expect(json.page).toBe("Page 1");
  });

  it("inspect --page reports only that page's shapes", async () => {
    await drawTwoPages();

    const first = await inspect();
    expect(first.json.page).toBe("Page 1");
    expect(first.json.shapes.map((shape) => shape.id)).toEqual(["shape:one"]);

    const second = await inspect(["--page", "notes"]);
    expect(second.json.page).toBe("notes");
    expect(second.json.shapes.map((shape) => shape.id)).toEqual(["shape:n1", "shape:n2"]);
  });

  it("keeps page two's lints off page one, and exits accordingly", async () => {
    await drawTwoPages();

    const first = await inspect();
    // `missing-topic` is a warning and does not drive the exit code.
    expect(rules(first.json)).toEqual(["missing-topic"]);
    expect(first.code).toBe(0);

    const second = await inspect(["--page", "notes"]);
    expect(rules(second.json)).toContain("overlapping-shapes");
    expect(second.code).toBe(3);
  });

  it("--allow-lints turns the non-current page's exit 3 into 0", async () => {
    await drawTwoPages();
    const allowed = await cli(["inspect", "two.tldr", "--page", "notes", "--allow-lints", "--json"]);
    expect(allowed.code).toBe(0);
    // The findings are still reported. `--allow-lints` moves the exit code, not
    // the list, which is the difference between it and `meta.lintIgnore`.
    expect(rules(JSON.parse(allowed.stdout) as InspectJson)).toContain("overlapping-shapes");
  });

  it("meta.lintIgnore on a shape on page two suppresses its rule there", async () => {
    await drawTwoPages();

    const muted = await run(
      `
      const id = helpers.box('n2', 'note two')
      editor.updateShape({ id, type: 'geo', meta: { lintIgnore: ['overlapping-shapes', 'overlapping-text'] } })
      return { lints: helpers.getLints().map((l) => l.rule) }
      `,
      ["--page", "notes"],
    );
    expect(muted.code).toBe(0);

    const second = await inspect(["--page", "notes"]);
    expect(second.code).toBe(0);
    expect(rules(second.json)).toEqual(["missing-topic"]);
  });

  it("run --page draws on the named page and leaves the other one alone", async () => {
    await drawTwoPages();

    const drew = await run(
      `helpers.box('n3', 'added later', { x: 400, y: 100, w: 200, h: 80 })
       return { current: editor.getCurrentPage().name }`,
      ["--page", "notes", "--allow-lints"],
    );
    expect(drew.code).toBe(0);
    expect((JSON.parse(drew.stdout) as { result: { current: string } }).result.current).toBe(
      "notes",
    );

    const first = await inspect();
    expect(first.json.shapes.map((shape) => shape.id)).toEqual(["shape:one"]);
    const second = await inspect(["--page", "notes"]);
    expect(second.json.shapes.map((shape) => shape.id)).toContain("shape:n3");
  });

  it("shot --page frames only that page", async () => {
    await drawTwoPages();

    const one = await cli(["shot", "two.tldr", "-o", "one.png", "--json"]);
    expect(one.code).toBe(0);
    const two = await cli(["shot", "two.tldr", "-o", "two.png", "--page", "notes", "--json"]);
    expect(two.code).toBe(0);

    const oneJson = JSON.parse(one.stdout) as ShotJson;
    const twoJson = JSON.parse(two.stdout) as ShotJson;
    // Page one is a single box; page two is two boxes offset by 20 units, so
    // its framed bounds are taller. Equal bounds would mean `--page` was
    // ignored and both shots framed the same page.
    expect(twoJson.bounds.h).toBeGreaterThan(oneJson.bounds.h);
    expect(twoJson.height).toBeGreaterThan(oneJson.height);
  });

  it("export --svg --page writes only that page's labels", async () => {
    await drawTwoPages();

    const one = await cli(["export", "two.tldr", "--svg", "one.svg", "--json"]);
    expect(one.code).toBe(0);
    const two = await cli(["export", "two.tldr", "--svg", "two.svg", "--page", "notes", "--json"]);
    expect(two.code).toBe(0);

    expect((JSON.parse(one.stdout) as ExportJson).svg).not.toBeNull();
    expect((JSON.parse(two.stdout) as ExportJson).svg).not.toBeNull();

    const oneSvg = await fs.readFile(path.join(dir, "one.svg"), "utf8");
    const twoSvg = await fs.readFile(path.join(dir, "two.svg"), "utf8");
    expect(oneSvg).toContain("page one box");
    expect(oneSvg).not.toContain("note one");
    expect(twoSvg).toContain("note one");
    expect(twoSvg).toContain("note two");
    expect(twoSvg).not.toContain("page one box");
  });

  it("an unknown --page is exit 1 and names the pages there are", async () => {
    await drawTwoPages();
    const missed = await cli(["inspect", "two.tldr", "--page", "nope", "--json"]);
    expect(missed.code).toBe(1);
    expect(missed.stderr).toContain('--page nope: no page named "nope"');
    expect(missed.stderr).toContain("Page 1, notes");
    // Playwright's own wrapping does not belong in a usage error.
    expect(missed.stderr).not.toContain("page.evaluate");
  });

  it("from-mermaid --append honours --page", async () => {
    await drawTwoPages();
    await fs.writeFile(path.join(dir, "flow.mmd"), "flowchart LR\n  a[Alpha] --> b[Beta]\n");

    const imported = await cli([
      "from-mermaid",
      "two.tldr",
      "--source",
      "flow.mmd",
      "--append",
      "--page",
      "notes",
      "--allow-lints",
      "--json",
    ]);
    expect(imported.code).toBe(0);

    const first = await inspect();
    expect(first.json.shapes.map((shape) => shape.id)).toEqual(["shape:one"]);
    const second = await inspect(["--page", "notes"]);
    expect(second.json.shapes.map((shape) => shape.id)).toContain("shape:a");
    expect(second.json.shapes.map((shape) => shape.id)).toContain("shape:b");
  });

  it("clear() is allowed on a page this snippet added, and refused on one it did not", async () => {
    await drawTwoPages();

    // A page that did not exist when `exec` started is as owned as a page gets.
    const own = await run(
      `helpers.page('scratch')
       helpers.box('s1', 'first try', { x: 0, y: 0, w: 120, h: 60 })
       const cleared = helpers.clear()
       helpers.box('s2', 'second try', { x: 0, y: 0, w: 120, h: 60 })
       return { cleared }`,
    );
    expect(own.code).toBe(0);
    expect((JSON.parse(own.stdout) as { result: { cleared: number } }).result.cleared).toBe(1);

    // And a page the snippet was handed still needs `force`, with the refusal
    // quoting what the page held at the start rather than what it holds now.
    const refused = await run(
      `helpers.box('n9', 'one more', { x: 900, y: 900, w: 100, h: 60 })
       helpers.clear()`,
      ["--page", "notes"],
    );
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain("already held 2 shape(s) when the snippet started");
  });

  it("counts a frame's contents in what the page held at the start", async () => {
    await drawTwoPages();

    // A frame is one direct child of the page and its members are more shapes
    // on the same page. Counting direct children would quote 1 here, which is
    // the same wrong number in a different place.
    const framed = await run(
      `helpers.page('framed')
       editor.createShape({ type: 'frame', x: 40, y: 40, props: { w: 400, h: 300 } })
       const frame = editor.getCurrentPageShapes().find((s) => s.type === 'frame')
       helpers.box('f1', 'inside one', { x: 80, y: 80, w: 120, h: 60, parent: frame.id })
       helpers.box('f2', 'inside two', { x: 80, y: 200, w: 120, h: 60, parent: frame.id })`,
      ["--allow-lints"],
    );
    expect(framed.code).toBe(0);

    const refused = await run(`helpers.clear()`, ["--page", "framed"]);
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain("already held 3 shape(s) when the snippet started");
  });
});
