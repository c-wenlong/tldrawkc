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

import { chromium, type Browser } from "playwright-core";

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

});
