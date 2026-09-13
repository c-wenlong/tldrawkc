/**
 * `--headed` reaching the browser, from every verb.
 *
 * The flag is parsed once and then has to survive being passed down a chain
 * per verb, and a verb that drops it fails in the quietest possible way:
 * nothing errors, a window simply never appears and whoever is debugging
 * concludes the tool ignores the flag. `doctor` was doing exactly that until
 * phase 4.
 *
 * So this mocks `browser.ts` and records the options object every verb hands
 * `withCanvas` or `withRasterPage`, which are the two places
 * `headless: !options.headed` is read. No Chromium is launched and no page is
 * served: what is under test is the plumbing, not the browser.
 *
 * Both of the environment's answers are stood in for, and both have to be.
 * `doctor` is the one verb that decides for itself whether to open a browser
 * at all: it skips the page-load check when Chromium is missing **or** when
 * `dist/page` has not been built. A unit suite runs before the build in CI, so
 * without a stand-in bundle `doctor` would never reach `withCanvas` there and
 * this file would pass on a laptop and fail on a runner, which is how it first
 * went red.
 */

import { describe, expect, it, beforeEach, afterEach, afterAll, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type * as PathsModule from "../../src/lib/paths.js";

/**
 * A `dist/page` that exists, wherever this runs.
 *
 * Built inside the mock factory because `vi.mock` is hoisted above every
 * import, so nothing declared at module scope is initialised yet when it runs.
 * The directory is a real one with a real `index.html`, which is all
 * `checkPageBundle` looks at.
 */
vi.mock("../../src/lib/paths.js", async (importOriginal) => {
  const actual = await importOriginal<typeof PathsModule>();
  const nodeFs = await import("node:fs");
  const nodeOs = await import("node:os");
  const nodePath = await import("node:path");
  const dist = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "tldrawkc-headed-page-"));
  const index = nodePath.join(dist, "index.html");
  nodeFs.writeFileSync(index, "<!doctype html><title>stand-in</title>");
  return { ...actual, PAGE_DIST_DIR: dist, PAGE_INDEX_HTML: index };
});

import type * as BrowserModule from "../../src/lib/browser.js";
import type {
  Bounds,
  CanvasHandle,
  RasterPage,
  WithCanvasOptions,
  WithRasterPageOptions,
} from "../../src/lib/browser.js";

/** Every options object a browser opener was called with, in order. */
const calls: Array<WithCanvasOptions | WithRasterPageOptions> = [];

vi.mock("../../src/lib/browser.js", async (importOriginal) => {
  const actual = await importOriginal<typeof BrowserModule>();
  return {
    ...actual,
    // Named so `doctor`'s chromium check passes without probing the machine:
    // the point here is the flag, and a laptop with no Chrome should still run
    // this test.
    resolveChromium: vi.fn(() =>
      Promise.resolve({
        executablePath: "/nowhere/chromium",
        source: "installed" as const,
        version: "Stand-in Chromium 1.0",
      }),
    ),
    withCanvas: vi.fn(<T,>(options: WithCanvasOptions, fn: (canvas: CanvasHandle) => Promise<T>) => {
      calls.push(options);
      return fn(standInCanvas());
    }),
    withRasterPage: vi.fn(
      <T,>(options: WithRasterPageOptions, fn: (page: RasterPage) => Promise<T>) => {
        calls.push(options);
        return fn(standInRasterPage());
      },
    ),
  };
});

const { exportCanvas, fromMermaid, inspect, newDocument, run, shot } = await import(
  "../../src/lib/canvas.js"
);
const { doctor } = await import("../../src/lib/doctor.js");
const { verify } = await import("../../src/lib/verify.js");
const { PAGE_DIST_DIR: STAND_IN_PAGE_DIR } = await import("../../src/lib/paths.js");

// Tidy up the stand-in bundle, and only ever that one: if the mock above ever
// stopped applying, this path would be the repo's real `dist/page` and the
// guard is what stops the suite deleting the build.
afterAll(async () => {
  if (STAND_IN_PAGE_DIR.startsWith(os.tmpdir())) {
    await fs.rm(STAND_IN_PAGE_DIR, { recursive: true, force: true });
  }
});

/** A 1x1 transparent PNG, so `writePng` has real bytes to write. */
const TINY_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const EMPTY_DOCUMENT = JSON.stringify({
  tldrawFileFormatVersion: 1,
  schema: { schemaVersion: 2 },
  records: [],
});

const BOUNDS: Bounds = { x: 0, y: 0, w: 100, h: 100 };

/** Everything the bridge promises, answered with the least that is valid. */
function standInCanvas(): CanvasHandle {
  return {
    url: "http://127.0.0.1:0",
    version: "stand-in",
    ping: () => Promise.resolve({ ok: true, version: "stand-in" }),
    load: () => Promise.resolve({ pages: ["Page 1"], shapeCount: 0 }),
    setPage: (name) => Promise.resolve({ page: name ?? "Page 1" }),
    // Source-aware in one place only: `from-mermaid` probes the helpers bag
    // before it draws, and an answer of `null` reads as a stale page bundle.
    exec: (source: string) =>
      Promise.resolve({
        result: source.includes("typeof helpers.mermaid")
          ? true
          : { nodes: {}, edges: [], containers: [], unsupported: [] },
        lints: [],
        shapeCount: 1,
      }),
    save: () => Promise.resolve(EMPTY_DOCUMENT),
    shot: () => Promise.resolve({ pngBase64: TINY_PNG, width: 1, height: 1, bounds: BOUNDS }),
    svg: () =>
      Promise.resolve({
        svg: "<svg xmlns='http://www.w3.org/2000/svg'></svg>",
        width: 1,
        height: 1,
      }),
    inspect: () =>
      Promise.resolve({
        pages: ["Page 1"],
        page: "Page 1",
        bounds: null,
        shapes: [],
        bindings: [],
        lints: [],
        meta: null,
      }),
    lints: () => Promise.resolve([]),
    zoomToFit: () => Promise.resolve(BOUNDS),
    has: () => Promise.resolve(true),
    fontsReady: () => Promise.resolve(["tldraw_draw"]),
    failedRequests: () => [],
    offHostRequests: () => [],
    close: () => Promise.resolve(undefined),
  };
}

/**
 * The page `verify` measures in, answering the least that is valid.
 *
 * The measurement it hands back is a clean render, because what is under test
 * here is the flag and not the rules: those are `test/unit/verify.test.ts`.
 */
function standInRasterPage(): RasterPage {
  return {
    url: "http://127.0.0.1:0/",
    evaluate: <T,>() =>
      Promise.resolve({
        ok: true,
        observation: {
          declared: { width: "100", height: "100", viewBox: "0 0 100 100" },
          intrinsic: { width: 100, height: 100 },
          viewBox: { width: 100, height: 100 },
          rendered: { width: 100, height: 100 },
          faces: [],
          runs: [],
        },
      } as T),
    fontsReady: () => Promise.resolve(["tldraw_draw"]),
    screenshot: () => Promise.resolve(TINY_PNG),
    requests: () => ["http://127.0.0.1:0/"],
    failedRequests: () => [],
    close: () => Promise.resolve(undefined),
  };
}

let dir: string;
let file: string;
let svg: string;

beforeEach(async () => {
  calls.length = 0;
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "tldrawkc-headed-")));
  file = path.join(dir, "diagram.tldr");
  svg = path.join(dir, "diagram.svg");
  await fs.writeFile(file, EMPTY_DOCUMENT);
  await fs.writeFile(svg, '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"></svg>');
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

/** Every verb that opens a browser, called with whatever `headed` is given. */
const VERBS: Record<string, (headed: boolean | undefined) => Promise<unknown>> = {
  run: (headed) =>
    run({
      file,
      evalSource: "return 1",
      create: true,
      save: true,
      allowLints: false,
      padding: 32,
      pixelRatio: 2,
      timeoutMs: 30_000,
      cwd: dir,
      headed,
    }),
  shot: (headed) =>
    shot({ file, output: path.join(dir, "out.png"), padding: 32, pixelRatio: 2, cwd: dir, headed }),
  new: (headed) => newDocument({ file: path.join(dir, "fresh.tldr"), cwd: dir, headed }),
  inspect: (headed) => inspect({ file, allowLints: true, cwd: dir, headed }),
  export: (headed) =>
    exportCanvas({
      file,
      png: path.join(dir, "export.png"),
      padding: 32,
      pixelRatio: 2,
      cwd: dir,
      headed,
    }),
  "from-mermaid": (headed) =>
    fromMermaid({
      file: path.join(dir, "mermaid.tldr"),
      source: "flowchart TD\n  a[one] --> b[two]",
      append: false,
      allowLints: true,
      padding: 32,
      pixelRatio: 2,
      timeoutMs: 30_000,
      cwd: dir,
      headed,
    }),
  doctor: (headed) => doctor({ cwd: dir, headed }),
  verify: (headed) =>
    verify({ file: svg, output: path.join(dir, "verify.png"), cwd: dir, headed }),
};

describe("--headed", () => {
  for (const [name, call] of Object.entries(VERBS)) {
    it(`reaches withCanvas from ${name}`, async () => {
      await call(true);
      expect(calls.length, `${name} opened no browser`).toBeGreaterThan(0);
      for (const options of calls) expect(options.headed, name).toBe(true);
    });

    it(`leaves ${name} headless when the flag is absent`, async () => {
      await call(undefined);
      expect(calls.length, `${name} opened no browser`).toBeGreaterThan(0);
      for (const options of calls) expect(options.headed ?? false, name).toBe(false);
    });
  }

  it("covers every verb that opens a browser", () => {
    // The list this file is asserting over. A new verb that opens a browser
    // and is not here would pass by not being tested at all.
    expect(Object.keys(VERBS).sort()).toEqual(
      ["doctor", "export", "from-mermaid", "inspect", "new", "run", "shot", "verify"].sort(),
    );
  });
});
