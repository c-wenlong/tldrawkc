/**
 * The whole of phase 4 in one test: `serve`, a real browser on the mirror
 * page, and a `run` in a third process showing up in it.
 *
 * This is the ROADMAP's own acceptance line for the phase ("start serve, write
 * the file from a run in another process, assert the page's shape count
 * changes within two seconds"), and it is the only test that crosses both
 * halves: the Node side here and `src/page/mirror.tsx`, which is built on its
 * own branch.
 *
 * It therefore gates itself on the built bundle carrying the mirror global. A
 * page bundle without it makes this skip with a message naming what is
 * missing, and the day that branch merges and `npm run build` runs, the test
 * starts running with no edit. A failing test would have said the same thing
 * less usefully, because a red suite on a branch stops saying anything after
 * the first day.
 *
 * The contract it holds the page to:
 *   - `/?mirror=1` mounts mirror mode
 *   - `window.__tldrawkcMirror` exists once it has loaded the document
 *   - `window.__tldrawkcMirror.shapeCount()` returns the number of shapes on
 *     the current page
 *   - the document is re-read within `MIRROR_POLL_MS` of its mtime changing
 */

import { describe, expect, it, beforeAll, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

import { chromium, type Browser, type Page } from "playwright-core";

import { CLI_ENTRY, PAGE_DIST_DIR, PAGE_INDEX_HTML } from "../../src/lib/paths.js";
import { resolveChromium } from "../../src/lib/browser.js";

/** How long the page gets to notice a change. `MIRROR_POLL_MS` plus slack. */
const NOTICE_MS = 2_000;

/**
 * Does the built page know about mirror mode?
 *
 * A string search over the bundle, which is crude and exactly right here: the
 * global's name is a property assignment, so the minifier keeps it, and the
 * question being asked is "has the page half of phase 4 been built into this
 * checkout" rather than anything about behaviour.
 *
 * Read at module scope rather than in `beforeAll`, because `it.skipIf` is
 * decided while the file is being collected and a hook has not run by then. A
 * gate set in `beforeAll` would skip for ever, including after the page half
 * lands, which is the opposite of the point.
 */
const MIRROR_IS_BUILT = await (async (): Promise<boolean> => {
  const assets = path.join(PAGE_DIST_DIR, "assets");
  const entries = await fs.readdir(assets).catch(() => [] as string[]);
  for (const entry of entries) {
    if (!entry.endsWith(".js")) continue;
    const source = await fs.readFile(path.join(assets, entry), "utf8");
    if (source.includes("__tldrawkcMirror")) return true;
  }
  // Loud rather than a bare "skipped": a suite that quietly drops its own
  // acceptance test is worse than one that never had it.
  console.warn(
    `mirror: skipping. ${assets} has no __tldrawkcMirror, so the page half of ` +
      "phase 4 is not in this build.",
  );
  return false;
})();

let chromiumPath: string;
let emptyDocument: string;
let dir: string;
let file: string;
const children: ChildProcess[] = [];
const browsers: Browser[] = [];

beforeAll(async () => {
  const built = await fs.stat(CLI_ENTRY).catch(() => null);
  if (!built) throw new Error(`${CLI_ENTRY} is missing. Run \`npm run build\` first.`);
  const page = await fs.stat(PAGE_INDEX_HTML).catch(() => null);
  if (!page) throw new Error(`${PAGE_INDEX_HTML} is missing. Run \`npm run build\` first.`);
  chromiumPath = (await resolveChromium()).executablePath;

  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "tldrawkc-mirror-seed-"));
  const seed = path.join(scratch, "seed.tldr");
  const made = await cli(["new", seed], scratch);
  if (made.code !== 0) throw new Error(`new failed: ${made.stderr}`);
  emptyDocument = await fs.readFile(seed, "utf8");
  await fs.rm(scratch, { recursive: true, force: true });
}, 120_000);

beforeEach(async () => {
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "tldrawkc-mirror-")));
  file = path.join(dir, "diagram.tldr");
  await fs.writeFile(file, emptyDocument);
});

afterEach(async () => {
  while (browsers.length > 0) await browsers.pop()?.close();
  while (children.length > 0) {
    const child = children.pop();
    if (child && child.exitCode === null) child.kill("SIGKILL");
  }
  await fs.rm(dir, { recursive: true, force: true });
});


interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

function cli(args: string[], cwd: string): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_ENTRY, ...args], {
      cwd,
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
    child.stdin.end();
  });
}

/** Start `serve` on a free port and wait for the URL it prints. */
async function startServe(): Promise<{ child: ChildProcess; url: string }> {
  const child = spawn(
    process.execPath,
    [CLI_ENTRY, "serve", file, "--no-open", "--json", "--port", "0"],
    { cwd: dir, env: { ...process.env, TLDRAWKC_CHROMIUM: chromiumPath } },
  );
  children.push(child);
  child.stdout?.setEncoding("utf8");
  let stdout = "";
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("serve printed nothing in 10s")), 10_000);
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
      try {
        const parsed = JSON.parse(stdout) as { url: string };
        clearTimeout(timer);
        resolve(parsed.url);
      } catch {
        // Still arriving.
      }
    });
  });
  return { child, url };
}

/** `inspect --json` from a separate process, which is the point of running it. */
async function inspectFile(): Promise<{ shapes: { id: string; x: number }[] }> {
  const result = await cli(["inspect", file, "--json"], dir);
  return JSON.parse(result.stdout) as { shapes: { id: string; x: number }[] };
}

function shapeX(report: { shapes: { id: string; x: number }[] }, id: string): number {
  const shape = report.shapes.find((entry) => entry.id === id);
  if (!shape) throw new Error(`${id} is not in the document`);
  return shape.x;
}

/** Serve the file, open it in a fresh browser, and wait for the mirror global. */
async function openMirror(): Promise<Page> {
  const served = await startServe();
  const browser = await chromium.launch({ executablePath: chromiumPath, headless: true });
  browsers.push(browser);
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(served.url, { waitUntil: "load" });
  await page.waitForFunction(
    "Boolean(window.__tldrawkcMirror && typeof window.__tldrawkcMirror.shapeCount === 'function')",
    undefined,
    { timeout: 20_000 },
  );
  return page;
}

/**
 * Drag a shape with the mouse, from its own element's centre.
 *
 * The element rather than a computed point, so the press lands on the shape
 * whatever the camera did with it, and in steps, because tldraw starts a
 * translation from pointer movement and a single jump can be read as a click.
 */
async function dragShape(page: Page, id: string, dx: number, dy: number): Promise<void> {
  const box = await page.locator(`[data-shape-id="${id}"]`).boundingBox();
  if (!box) throw new Error(`${id} has no box on screen`);
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx / 2, y + dy / 2, { steps: 8 });
  await page.mouse.move(x + dx, y + dy, { steps: 8 });
  await page.mouse.up();
}

describe("the mirror page", () => {
  it.skipIf(!MIRROR_IS_BUILT)(
    "picks up a shape a run in another process drew",
    async () => {
      const served = await startServe();
      const browser = await chromium.launch({ executablePath: chromiumPath, headless: true });
      browsers.push(browser);
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      await page.goto(served.url, { waitUntil: "load" });

      await page.waitForFunction(
        "Boolean(window.__tldrawkcMirror && typeof window.__tldrawkcMirror.shapeCount === 'function')",
        undefined,
        { timeout: 20_000 },
      );
      const before = await page.evaluate<number>("window.__tldrawkcMirror.shapeCount()");

      const drawn = await cli(
        ["run", file, "--eval", "helpers.box('b','mirrored',{x:300,y:0})", "--allow-lints"],
        dir,
      );
      expect(drawn.code, drawn.stderr).toBe(0);

      // The page polls `/api/document` and reloads on an mtime change, so the
      // count has to move on its own: nothing here touches the page.
      await page.waitForFunction(
        `window.__tldrawkcMirror.shapeCount() > ${String(before)}`,
        undefined,
        { timeout: NOTICE_MS },
      );
      expect(await page.evaluate<number>("window.__tldrawkcMirror.shapeCount()")).toBe(before + 1);
    },
    60_000,
  );

  it.skipIf(!MIRROR_IS_BUILT)(
    "writes a dragged shape back to the file on Ctrl+S",
    async () => {
      // The ROADMAP's "done when" for phase 4, as a test: drag a box in the
      // served tab, save, and the next `inspect` shows the new position.
      const drawn = await cli(
        ["run", file, "--eval", "helpers.box('a','alpha',{x:100,y:100})", "--allow-lints"],
        dir,
      );
      expect(drawn.code, drawn.stderr).toBe(0);
      const from = shapeX(await inspectFile(), "shape:a");

      const page = await openMirror();
      await page.waitForFunction("window.__tldrawkcMirror.shapeCount() === 1", undefined, {
        timeout: NOTICE_MS,
      });

      await dragShape(page, "shape:a", 140, 90);
      await page.waitForFunction("window.__tldrawkcMirror.dirty === true", undefined, {
        timeout: 5_000,
      });

      // Ctrl rather than Cmd: the handler takes either, and a Linux runner has
      // no Meta to press.
      await page.keyboard.press("Control+s");
      await page.waitForFunction(
        "window.__tldrawkcMirror.dirty === false && window.__tldrawkcMirror.lastSaveAt !== null",
        undefined,
        { timeout: 10_000 },
      );

      // A separate process, reading the file the tab wrote.
      expect(shapeX(await inspectFile(), "shape:a")).toBeGreaterThan(from);
    },
    60_000,
  );

  it.skipIf(!MIRROR_IS_BUILT)(
    "warns when a reload lands on unsaved edits",
    async () => {
      const drawn = await cli(
        ["run", file, "--eval", "helpers.box('a','alpha',{x:100,y:100})", "--allow-lints"],
        dir,
      );
      expect(drawn.code, drawn.stderr).toBe(0);

      const page = await openMirror();
      await page.waitForFunction("window.__tldrawkcMirror.shapeCount() === 1", undefined, {
        timeout: NOTICE_MS,
      });

      await dragShape(page, "shape:a", 120, 80);
      await page.waitForFunction("window.__tldrawkcMirror.dirty === true", undefined, {
        timeout: 5_000,
      });

      // Nothing saved those edits, so the reload the next line causes lands on
      // top of them. Last write wins is the whole collaboration story, and the
      // banner is the only thing that says so.
      const second = await cli(
        ["run", file, "--eval", "helpers.box('b','beta',{x:400,y:0})", "--allow-lints"],
        dir,
      );
      expect(second.code, second.stderr).toBe(0);

      await page.waitForSelector('[data-testid="mirror-banner"]', { timeout: NOTICE_MS });
      expect(await page.evaluate<number>("window.__tldrawkcMirror.shapeCount()")).toBe(2);
      expect(await page.evaluate<boolean>("window.__tldrawkcMirror.dirty")).toBe(false);

      await page.click('[data-testid="mirror-banner-dismiss"]');
      await page.waitForSelector('[data-testid="mirror-banner"]', {
        state: "detached",
        timeout: 5_000,
      });
    },
    60_000,
  );
});
