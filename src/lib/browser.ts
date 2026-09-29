/**
 * Finding a browser, opening the page, and talking to the bridge.
 *
 * Two halves. `resolveChromium` picks an executable: the tool depends on
 * `playwright-core`, which ships no browser of its own, so it has to come from
 * somewhere on the machine and DECISIONS.md D9 fixes the order.
 * `openCanvasPage` launches that executable, navigates to the served bundle,
 * waits for `window.__tldrawkc` to answer, and hands back a typed wrapper
 * around every bridge function in ARCHITECTURE.md.
 *
 * Layering rule 1: nothing here imports `tldraw`, `react` or `src/page/`. The
 * bridge is described by local interfaces, and the page's global is declared
 * locally too, because this side of the tool is compiled without the DOM lib
 * on purpose.
 *
 * Layering rule 7: a command never leaves a browser running. `withCanvas` is
 * the shape every verb should use, because its `finally` is the only place
 * that has to remember.
 */

import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";

import { EXIT_CODES, EnvironmentError, TldrawkcError } from "./errors.js";
import type { DiagramMeta } from "./meta.js";
import { PAGE_DIST_DIR } from "./paths.js";
import { startPageServer, type PageServer } from "./server.js";

const run = promisify(execFile);

/** How a Chromium executable was found, in the order the resolver tries them. */
export type ChromiumSource =
  | "flag"
  | "env"
  | "playwright"
  | "installed";

/** A Chromium that exists and answered `--version`. */
export interface ResolvedChromium {
  executablePath: string;
  source: ChromiumSource;
  /** The `--version` line, e.g. "Google Chrome 141.0.7390.55". */
  version: string;
}

/** Why no Chromium could be used, with every path that was tried. */
export interface ChromiumResolutionFailure {
  tried: Array<{ path: string; source: ChromiumSource; reason: string }>;
}

export class ChromiumNotFoundError extends TldrawkcError implements ChromiumResolutionFailure {
  /** An environment failure: nothing was written and nothing was launched. */
  readonly exitCode = EXIT_CODES.usage;
  readonly tried: ChromiumResolutionFailure["tried"];
  constructor(tried: ChromiumResolutionFailure["tried"]) {
    super(messageFor(tried));
    this.name = "ChromiumNotFoundError";
    this.tried = tried;
  }
}

/**
 * Say what actually went wrong.
 *
 * Telling someone who passed `--chromium` to try passing `--chromium` is the
 * kind of message that costs a minute every time it is read.
 */
function messageFor(tried: ChromiumResolutionFailure["tried"]): string {
  const named = tried.find((entry) => entry.source === "flag" || entry.source === "env");
  if (named) {
    const how = named.source === "flag" ? "--chromium" : "TLDRAWKC_CHROMIUM";
    return `${how} points at "${named.path}", which is unusable (${named.reason}).`;
  }
  return (
    "no usable Chromium found. Pass --chromium <path>, set TLDRAWKC_CHROMIUM, " +
    "run `npx playwright install chromium`, or install Google Chrome."
  );
}

/**
 * Well-known Chrome and Chromium locations, tried last.
 *
 * macOS and Linux only, which is where this is used. A machine elsewhere can
 * still point the tool at a binary with `--chromium` or `TLDRAWKC_CHROMIUM`.
 */
export function installedBrowserPaths(platform: NodeJS.Platform = process.platform): string[] {
  if (platform === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    ];
  }
  if (platform === "linux") {
    return [
      "/usr/bin/google-chrome-stable",
      "/usr/bin/google-chrome",
      "/usr/bin/chromium-browser",
      "/usr/bin/chromium",
      "/snap/bin/chromium",
      "/usr/bin/microsoft-edge",
    ];
  }
  return [];
}

/** What `resolveChromium` should consider, in order. */
export interface ResolveChromiumOptions {
  /** The `--chromium` flag. */
  flag?: string | undefined;
  /** Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Defaults to `process.platform`. */
  platform?: NodeJS.Platform;
}

/**
 * Resolve a Chromium executable per D9.
 *
 * Order: `--chromium`, then `TLDRAWKC_CHROMIUM`, then the browser
 * `playwright-core` would use if `npx playwright install chromium` has been
 * run, then the Chrome and Chromium apps installed on the machine. Every
 * candidate must both exist and answer `--version`, because a stale
 * Playwright registry entry points at a path that was deleted and an
 * executable that cannot start is not worth reporting as found.
 *
 * A browser the caller **named** is not a suggestion. If `--chromium` or
 * `TLDRAWKC_CHROMIUM` points at something that does not work, that is an
 * error, not a reason to quietly launch a different browser: the whole point
 * of naming one is to control which engine drew the picture. Only the two
 * discovery steps fall through.
 */
export async function resolveChromium(
  options: ResolveChromiumOptions = {},
): Promise<ResolvedChromium> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;

  const named: Array<{ path: string; source: ChromiumSource }> = [];
  if (options.flag) named.push({ path: options.flag, source: "flag" });
  const fromEnv = env["TLDRAWKC_CHROMIUM"];
  if (fromEnv) named.push({ path: fromEnv, source: "env" });

  const tried: ChromiumResolutionFailure["tried"] = [];
  for (const candidate of named) {
    const probed = await probe(candidate.path);
    if (probed.ok) {
      return { executablePath: candidate.path, source: candidate.source, version: probed.version };
    }
    tried.push({ ...candidate, reason: probed.reason });
    // Named and unusable: stop here rather than falling through to a browser
    // the caller did not ask for.
    throw new ChromiumNotFoundError(tried);
  }

  const discovered: Array<{ path: string; source: ChromiumSource }> = [];
  const fromPlaywright = playwrightExecutablePath();
  if (fromPlaywright) discovered.push({ path: fromPlaywright, source: "playwright" });
  for (const path of installedBrowserPaths(platform)) {
    discovered.push({ path, source: "installed" });
  }

  for (const candidate of discovered) {
    const probed = await probe(candidate.path);
    if (probed.ok) {
      return { executablePath: candidate.path, source: candidate.source, version: probed.version };
    }
    tried.push({ ...candidate, reason: probed.reason });
  }
  throw new ChromiumNotFoundError(tried);
}

/**
 * The path `playwright-core` would launch, or `null`.
 *
 * `executablePath()` throws rather than returning nothing when no browser has
 * been downloaded, which is the normal state on a machine that never ran
 * `npx playwright install`.
 */
function playwrightExecutablePath(): string | null {
  try {
    return chromium.executablePath() || null;
  } catch {
    return null;
  }
}

type ProbeResult = { ok: true; version: string } | { ok: false; reason: string };

/** Confirm a candidate exists and can start, by asking it for its version. */
async function probe(executablePath: string): Promise<ProbeResult> {
  try {
    await fs.access(executablePath);
  } catch {
    return { ok: false, reason: "not found" };
  }
  try {
    const { stdout } = await run(executablePath, ["--version"], { timeout: 10_000 });
    return { ok: true, version: stdout.trim() };
  } catch (error) {
    return { ok: false, reason: (error as Error).message.split("\n")[0] ?? "could not run" };
  }
}

// ---------------------------------------------------------------------------
// The bridge, as Node sees it
// ---------------------------------------------------------------------------

/**
 * How long the page gets to mount tldraw and install the bridge.
 *
 * `BRIDGE_TIMEOUT_MS` in the numbers table of ARCHITECTURE.md. Generous,
 * because a cold Chromium parsing a five megabyte bundle on a loaded CI runner
 * is slow in a way that has nothing to do with anything being wrong.
 */
export const BRIDGE_TIMEOUT_MS = 15_000;

/** Default cap on the `exec` step, matching `--timeout`'s default in CLI.md. */
export const EXEC_TIMEOUT_MS = 30_000;

/** The headless viewport. Big enough that a normal diagram fits on screen. */
export const VIEWPORT = { width: 1600, height: 1000 } as const;

/** A rectangle in page coordinates. */
export interface Bounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * How much a finding costs. Absent means `error`, which is exit code 3.
 * `warn` is printed and ignored by the exit code: `missing-topic` is the one
 * rule that uses it, because a diagram written before metadata existed is
 * still a good diagram.
 */
export type LintSeverity = "error" | "warn";

/** One complaint from the lint pass. See the rule table in HELPERS.md. */
export interface Lint {
  rule: string;
  /** Empty for a document-level rule, which has no shape to point at. */
  shapeIds: string[];
  message: string;
  severity?: LintSeverity;
}

/** A finding's severity, with the default applied. */
export function severityOf(lint: Lint): LintSeverity {
  return lint.severity ?? "error";
}

/**
 * Does this list hold anything worth exit code 3?
 *
 * The one place that decides, so `run`, `inspect` and `from-mermaid` cannot
 * disagree about whether a warning counts.
 */
export function hasBlockingLints(lints: readonly Lint[]): boolean {
  return lints.some((lint) => severityOf(lint) === "error");
}

export interface PingResult {
  ok: boolean;
  version: string;
}

export interface LoadResult {
  pages: string[];
  shapeCount: number;
}

export interface SetPageResult {
  page: string;
}

export interface ExecResult {
  /** Whatever the snippet returned, already JSON-safe. */
  result: unknown;
  lints: Lint[];
  shapeCount: number;
}

export interface ShotOptions {
  ids?: string[];
  padding?: number;
  pixelRatio?: number;
  background?: boolean;
}

export interface ShotResult {
  pngBase64: string;
  width: number;
  height: number;
  bounds: Bounds;
}

export interface SvgOptions {
  ids?: string[];
  padding?: number;
  background?: boolean;
}

export interface SvgResult {
  svg: string;
  width: number;
  height: number;
}

/** One shape as `inspect` reports it. `geo` is present only on geo shapes. */
export interface InspectShape {
  id: string;
  type: string;
  geo?: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** The label's plain text, or `null` when the shape has none. */
  text: string | null;
  parentId: string;
}

/** One arrow's two binding ends, as `inspect` reports them. */
export interface InspectBinding {
  arrow: string;
  from: string | null;
  to: string | null;
  fromAnchor: { x: number; y: number } | null;
  toAnchor: { x: number; y: number } | null;
}

/**
 * The "read the canvas" structure.
 *
 * The bridge table in ARCHITECTURE.md is the single definition of this shape,
 * and `inspect --json` prints it unchanged, so nothing here reorders, renames
 * or enriches it. `bounds` is `null` on an empty page.
 */
export interface InspectData {
  pages: string[];
  page: string;
  bounds: Bounds | null;
  shapes: InspectShape[];
  bindings: InspectBinding[];
  lints: Lint[];
  /**
   * The document metadata, or `null` when the file carries none.
   *
   * From the live store, not from the file text Node already holds, so it is
   * what tldraw actually loaded. A page bundle older than this field answers
   * `undefined`, which reads as `null` here.
   */
  meta?: DiagramMeta | null;
}

/**
 * `window.__tldrawkc`, exactly as the bridge table in ARCHITECTURE.md defines
 * it. Every method is declared as returning a promise because that is all
 * `page.evaluate` needs to know; the page is free to implement a synchronous
 * one.
 */
interface BridgeApi {
  ping(): Promise<PingResult>;
  load(tldrJson: string | null): Promise<LoadResult>;
  setPage(name: string | null): Promise<SetPageResult>;
  exec(source: string): Promise<ExecResult>;
  save(): Promise<string>;
  shot(options: ShotOptions): Promise<ShotResult>;
  svg(options: SvgOptions): Promise<SvgResult>;
  inspect(): Promise<InspectData>;
  lints(): Promise<Lint[]>;
  zoomToFit(): Promise<Bounds>;
}

/**
 * The page's global.
 *
 * Declared here rather than imported, because `tsconfig.json` compiles this
 * side without the DOM lib (that is what keeps the node build honest about not
 * being a browser), and because importing the page's own types would break
 * layering rule 1. The declaration exists only so the function bodies handed
 * to `page.evaluate` typecheck; nothing in this process ever reads it.
 */
declare const window: { __tldrawkc: BridgeApi };

/** Bridge functions a page may or may not implement yet. */
export type BridgeMethod = keyof BridgeApi;

/** A request that failed outright, or came back 400 or worse. */
export interface FailedRequest {
  url: string;
  /** The network failure text, or `HTTP 404` for a response-level failure. */
  reason: string;
}

// ---------------------------------------------------------------------------
// Opening the page
// ---------------------------------------------------------------------------

export interface OpenCanvasOptions {
  /** Where the page is served from. `withCanvas` fills this in. */
  url: string;
  /** The `--chromium` flag. */
  chromium?: string | undefined;
  /** Show the window. Debugging only. */
  headed?: boolean | undefined;
  /** How long the bridge gets to answer `ping`. */
  timeoutMs?: number | undefined;
}

/**
 * A live page with the bridge answering, plus what the network did.
 *
 * Every method is a thin typed wrapper over one `page.evaluate`. They are
 * separate methods rather than one `call(name, args)` so that a change to the
 * bridge contract is a type error here rather than a runtime surprise.
 */
export interface CanvasHandle {
  /** The origin the page was served from. */
  readonly url: string;
  /** The version `ping` reported, which is the version the bundle was built at. */
  readonly version: string;

  ping(): Promise<PingResult>;
  load(tldrJson: string | null): Promise<LoadResult>;
  setPage(name: string | null): Promise<SetPageResult>;
  exec(source: string): Promise<ExecResult>;
  save(): Promise<string>;
  shot(options?: ShotOptions): Promise<ShotResult>;
  svg(options?: SvgOptions): Promise<SvgResult>;
  inspect(): Promise<InspectData>;
  lints(): Promise<Lint[]>;
  zoomToFit(): Promise<Bounds>;

  /** Whether the loaded page implements a bridge function. */
  has(method: BridgeMethod): Promise<boolean>;

  /**
   * Wait for the page's font loading to settle, then name the families that
   * came back loaded.
   *
   * `ping` answering means the editor mounted, which is earlier than the fonts
   * finishing: tldraw kicks its woff2 fetches off and carries on. Reading the
   * failed-request list at mount time can therefore miss the 404 that the
   * fonts check exists to catch, so anything asking about fonts awaits this
   * first.
   */
  fontsReady(): Promise<string[]>;

  /** Every request that failed or answered 400 or worse, in order. */
  failedRequests(): FailedRequest[];
  /**
   * Every request whose URL left this server's origin.
   *
   * Layering rule 8: the page bundle is self-contained, so this list being
   * anything but empty means an asset is being fetched from the internet and
   * the tool would break on a plane. `doctor` fails on it.
   */
  offHostRequests(): string[];

  close(): Promise<void>;
}

/**
 * Launch Chromium, open the served page, and wait for the bridge.
 *
 * Returns only once `ping()` has answered `ok`, so a caller never has to
 * wonder whether the editor has mounted. On failure the browser is closed
 * before the error is thrown, because a half-open browser is the one thing
 * layering rule 7 exists to prevent.
 */
export async function openCanvasPage(options: OpenCanvasOptions): Promise<CanvasHandle> {
  const timeoutMs = options.timeoutMs ?? BRIDGE_TIMEOUT_MS;
  const resolved = await resolveChromium({ flag: options.chromium });

  const browser = await launchIsolated(resolved.executablePath, options.headed, options.url);

  let page: Page;
  const failed: FailedRequest[] = [];
  const offHost: string[] = [];
  try {
    const context = await newIsolatedContext(browser, options.url);
    page = await context.newPage();

    page.on("requestfailed", (request) => {
      const failure = request.failure();
      failed.push({ url: request.url(), reason: failure?.errorText ?? "request failed" });
    });
    // A 404 is not a "request failure" in Chromium's sense: the request
    // succeeded and the answer was "no". That is exactly how a missing font
    // shows up (see the fonts section in ARCHITECTURE.md), so it has to count.
    page.on("response", (response) => {
      if (response.status() >= 400) {
        failed.push({ url: response.url(), reason: `HTTP ${String(response.status())}` });
      }
    });
    // Once per URL: a request CSP refused can be reported twice, by its
    // console line and then by the `request` event Chromium still raises for
    // an image or a font.
    const noteOffHost = (url: string): void => {
      if (isOffHost(url, options.url) && !offHost.includes(url)) offHost.push(url);
    };
    page.on("request", (request) => {
      noteOffHost(request.url());
    });
    // A `fetch`, beacon or WebSocket the page's CSP refused never happens, so
    // it raises no `request` event and the line above cannot see it.
    // Chromium's console line for the refusal is the only trace, and without
    // it `doctor`'s audit of layering rule 8 would go blind to exactly what
    // D46 blocks.
    page.on("console", (message) => {
      const refused = cspRefusedUrl(message.text());
      if (refused !== null) noteOffHost(refused);
    });

    await page.goto(options.url, { waitUntil: "load", timeout: timeoutMs });
    await page.waitForFunction(BRIDGE_READY_EXPRESSION, undefined, { timeout: timeoutMs });
  } catch (error) {
    await browser.close().catch(() => undefined);
    throw new EnvironmentError(bridgeFailureMessage(options.url, error, failed), { cause: error });
  }

  let ping: PingResult;
  try {
    ping = await page.evaluate(() => window.__tldrawkc.ping());
  } catch (error) {
    await browser.close().catch(() => undefined);
    throw new EnvironmentError(`the page bridge failed to answer ping: ${(error as Error).message}`, {
      cause: error,
    });
  }

  return {
    url: options.url,
    version: ping.version,
    ping: () => page.evaluate(() => window.__tldrawkc.ping()),
    load: (tldrJson) => page.evaluate((json) => window.__tldrawkc.load(json), tldrJson),
    setPage: (name) => page.evaluate((value) => window.__tldrawkc.setPage(value), name),
    exec: (source) => page.evaluate((src) => window.__tldrawkc.exec(src), source),
    save: () => page.evaluate(() => window.__tldrawkc.save()),
    shot: (shotOptions = {}) =>
      page.evaluate((opts) => window.__tldrawkc.shot(opts), shotOptions),
    svg: (svgOptions = {}) => page.evaluate((opts) => window.__tldrawkc.svg(opts), svgOptions),
    inspect: () => page.evaluate(() => window.__tldrawkc.inspect()),
    lints: () => page.evaluate(() => window.__tldrawkc.lints()),
    zoomToFit: () => page.evaluate(() => window.__tldrawkc.zoomToFit()),
    has: (method) =>
      page.evaluate((name) => {
        const bridge = window.__tldrawkc as unknown as Record<string, unknown>;
        return typeof bridge[name] === "function";
      }, method),
    fontsReady: () => page.evaluate<string[]>(FONTS_READY_EXPRESSION),
    failedRequests: () => [...failed],
    offHostRequests: () => [...offHost],
    close: async () => {
      await browser.close();
    },
  };
}

// ---------------------------------------------------------------------------
// A page with no bridge
// ---------------------------------------------------------------------------

/**
 * A page that is not the tldraw bundle.
 *
 * `verify` renders a finished SVG, which has no editor, no bridge and no
 * helpers: what it needs is a browser that will lay the file out, a way to ask
 * the DOM what happened, and a picture. So this is the same launch, the same
 * request bookkeeping and the same `finally`, stopping short of waiting for a
 * bridge that will never exist.
 *
 * `evaluate` takes source as a string for the reason
 * {@link FONTS_READY_EXPRESSION} does: this side of the tool is compiled
 * without the DOM lib on purpose, so a function body full of `document` would
 * not typecheck here.
 */
export interface RasterPage {
  /** The URL the page was opened at. */
  readonly url: string;
  /** Evaluate an expression in the page and bring the value back. */
  evaluate<T>(expression: string): Promise<T>;
  /** Wait for font loading to settle. Same reason as `CanvasHandle.fontsReady`. */
  fontsReady(): Promise<string[]>;
  /** Screenshot one element, as base64 PNG for `files.ts` to write. */
  screenshot(selector: string): Promise<string>;
  /** Every request the page made, in order, the document itself included. */
  requests(): string[];
  /** Every request that failed or answered 400 or worse. */
  failedRequests(): FailedRequest[];
  close(): Promise<void>;
}

export interface OpenRasterPageOptions {
  /** Where the harness page is served from. `withRasterPage` fills this in. */
  url: string;
  chromium?: string | undefined;
  headed?: boolean | undefined;
  /** How long the page gets to load. */
  timeoutMs?: number | undefined;
}

/** Launch Chromium and open `url`, with no bridge to wait for. */
export async function openRasterPage(options: OpenRasterPageOptions): Promise<RasterPage> {
  const timeoutMs = options.timeoutMs ?? BRIDGE_TIMEOUT_MS;
  const resolved = await resolveChromium({ flag: options.chromium });

  const browser = await launchIsolated(resolved.executablePath, options.headed, options.url);

  const failed: FailedRequest[] = [];
  const requested: string[] = [];
  let page: Page;
  try {
    const context = await newIsolatedContext(browser, options.url);
    page = await context.newPage();

    page.on("request", (request) => requested.push(request.url()));
    page.on("requestfailed", (request) => {
      const failure = request.failure();
      failed.push({ url: request.url(), reason: failure?.errorText ?? "request failed" });
    });
    page.on("response", (response) => {
      if (response.status() >= 400) {
        failed.push({ url: response.url(), reason: `HTTP ${String(response.status())}` });
      }
    });

    await page.goto(options.url, { waitUntil: "load", timeout: timeoutMs });
  } catch (error) {
    await browser.close().catch(() => undefined);
    throw new EnvironmentError(bridgeFailureMessage(options.url, error, failed), { cause: error });
  }

  return {
    url: options.url,
    evaluate: <T,>(expression: string) => page.evaluate<T>(expression),
    fontsReady: () => page.evaluate<string[]>(FONTS_READY_EXPRESSION),
    screenshot: async (selector: string) => {
      const shot = await page.locator(selector).screenshot({ type: "png" });
      return shot.toString("base64");
    },
    requests: () => [...requested],
    failedRequests: () => [...failed],
    close: async () => {
      await browser.close();
    },
  };
}

export interface WithRasterPageOptions {
  /** Directory to serve. The throwaway one holding the harness page. */
  root: string;
  /** Path under that directory to open. Defaults to `/`. */
  path?: string | undefined;
  chromium?: string | undefined;
  headed?: boolean | undefined;
  timeoutMs?: number | undefined;
}

/**
 * Serve a directory, open a page in it, run `fn`, close both whatever happens.
 *
 * {@link withCanvas} for a page that is not the canvas. Layering rule 6 says a
 * command never leaves a browser running, and this is the second place that
 * promise is kept: one `finally`, and no verb of its own to forget.
 */
export async function withRasterPage<T>(
  options: WithRasterPageOptions,
  fn: (page: RasterPage) => Promise<T>,
): Promise<T> {
  let server: PageServer;
  try {
    // No CSP on the harness: see `contentSecurityPolicy` in server.ts. The
    // request interception in `newIsolatedContext` still keeps it offline.
    server = await startPageServer({ root: options.root, contentSecurityPolicy: null });
  } catch (error) {
    throw new EnvironmentError(`could not serve ${options.root}: ${(error as Error).message}`, {
      cause: error,
    });
  }

  let page: RasterPage;
  try {
    page = await openRasterPage({
      url: `${server.url}${options.path ?? "/"}`,
      chromium: options.chromium,
      headed: options.headed,
      timeoutMs: options.timeoutMs,
    });
  } catch (error) {
    await server.close();
    throw error;
  }

  try {
    return await fn(page);
  } finally {
    await page.close().catch(() => undefined);
    await server.close();
  }
}

/**
 * The expression `waitForFunction` polls until the bridge is up.
 *
 * A string rather than a function because it has to survive being sent to a
 * page that may not have `__tldrawkc` at all yet; calling `ping()` (not merely
 * checking that it exists) is what makes this a readiness signal, since the
 * bridge is installed from `onMount` and so cannot answer before the editor
 * exists.
 */
const BRIDGE_READY_EXPRESSION = `(() => {
  const bridge = window.__tldrawkc;
  if (!bridge || typeof bridge.ping !== "function") return false;
  const answer = bridge.ping();
  return Boolean(answer && answer.ok);
})()`;

/**
 * The expression `fontsReady` evaluates, as a string.
 *
 * A string for the same reason as {@link BRIDGE_READY_EXPRESSION}: `src/lib`
 * is node code and its tsconfig has no DOM library, so `document` is not a
 * name it can see. Sending the source keeps the DOM out of the node build
 * rather than widening the compiler options for one call.
 */
const FONTS_READY_EXPRESSION = `(async () => {
  await document.fonts.ready;
  const families = new Set();
  document.fonts.forEach((face) => {
    if (face.status === "loaded") families.add(face.family.replace(/^["']|["']$/g, ""));
  });
  return [...families].sort();
})()`;

/** Everything a failed page load can usefully say, in one message. */
function bridgeFailureMessage(url: string, error: unknown, failed: FailedRequest[]): string {
  const base = `the page at ${url} did not come up: ${(error as Error).message.split("\n")[0] ?? ""}`;
  if (failed.length === 0) return base;
  const listed = failed
    .slice(0, 5)
    .map((entry) => `${entry.url} (${entry.reason})`)
    .join(", ");
  const more = failed.length > 5 ? `, and ${String(failed.length - 5)} more` : "";
  return `${base}. Failed requests: ${listed}${more}`;
}

/**
 * Whether a request left the page server's origin.
 *
 * `data:`, `blob:` and `about:` are inline, not network, so they do not count.
 * Everything else is compared against the origin the page was served from.
 */
export function isOffHost(requestUrl: string, origin: string): boolean {
  if (/^(data|blob|about|chrome-extension):/i.test(requestUrl)) return false;
  try {
    return new URL(requestUrl).origin !== new URL(origin).origin;
  } catch {
    return true;
  }
}

// ---------------------------------------------------------------------------
// Keeping the page off the network
// ---------------------------------------------------------------------------

/**
 * The proxy every off-origin request is pointed at, which nothing answers.
 *
 * Port 1 is on Chromium's restricted-port list and has no listener on any
 * machine this runs on, so a request routed here fails at connect time. It is
 * a dead end on purpose: the proxy exists to make "no route out" the default
 * for anything the request interception below does not see, not to carry
 * traffic anywhere.
 */
export const DEAD_PROXY = "http://127.0.0.1:1";

/**
 * Chromium switches that take the network away from everything but the page's
 * own origin (D46).
 *
 * The page runs a snippet with the page's full power, and a snippet is written
 * by an agent that may be reading untrusted text, so what the page can reach is
 * what that agent can reach. These switches are the floor under
 * {@link newIsolatedContext}'s request interception, for whatever interception
 * does not see:
 *
 * - `--proxy-server` sends every request to {@link DEAD_PROXY}, and
 *   `<-loopback>` takes away Chromium's implicit loopback bypass, so another
 *   port on 127.0.0.1 (a dev server, a database's HTTP port) goes to the dead
 *   proxy too. The page's own `host:port` is the one bypass.
 * - `--host-resolver-rules` makes every name lookup fail, so a
 *   `<link rel=dns-prefetch>` cannot carry data out in a DNS query. The rule
 *   matches IP literals too (measured: without the `EXCLUDE` the page itself
 *   failed with `ERR_NAME_NOT_RESOLVED`), so the page's own host is excluded.
 * - `--webrtc-ip-handling-policy=disable_non_proxied_udp` stops WebRTC
 *   sending UDP around the proxy, which is the one path neither the proxy nor
 *   the interception covers: without it a STUN request to a loopback port
 *   arrived four times per peer connection. Measured on Chrome for Testing
 *   153: the similar-looking `--force-webrtc-ip-handling-policy` changed
 *   nothing, so do not "correct" the name.
 */
export function isolationArgs(origin: string): string[] {
  const { host, hostname } = new URL(origin);
  return [
    `--proxy-server=${DEAD_PROXY}`,
    `--proxy-bypass-list=<-loopback>;${host}`,
    `--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE ${hostname}`,
    "--webrtc-ip-handling-policy=disable_non_proxied_udp",
  ];
}

/** Launch Chromium with {@link isolationArgs} for a page served at `origin`. */
async function launchIsolated(
  executablePath: string,
  headed: boolean | undefined,
  origin: string,
): Promise<Browser> {
  try {
    return await chromium.launch({
      executablePath,
      headless: !headed,
      args: isolationArgs(origin),
    });
  } catch (error) {
    throw new EnvironmentError(`could not launch ${executablePath}: ${(error as Error).message}`, {
      cause: error,
    });
  }
}

/**
 * The reason a blocked WebSocket is closed with, as the page sees it.
 *
 * 1008 is "policy violation", which is what this is.
 */
const WEBSOCKET_BLOCKED = { code: 1008, reason: "tldrawkc: the page has no network" } as const;

/**
 * A browser context whose pages can reach their own origin and nothing else
 * (D46).
 *
 * Every request is intercepted at the context, so a popup or an iframe is
 * covered as well as the page, and one whose URL is off the page's origin
 * (by {@link isOffHost}) is aborted before it is sent. It still raises the
 * page's `request` event first, which is what keeps `offHostRequests()` and
 * `verify`'s `self-contained` check honest: a blocked request is still a
 * request the page tried to make. WebSockets are refused outright, since
 * nothing the page does needs one. Service workers are blocked because their
 * fetches are not routed through the context at all.
 */
export async function newIsolatedContext(
  browser: Browser,
  origin: string,
): Promise<BrowserContext> {
  const context = await browser.newContext({
    viewport: { ...VIEWPORT },
    serviceWorkers: "block",
  });
  await context.route(
    (url) => isOffHost(url.href, origin),
    (route) => route.abort("blockedbyclient"),
  );
  await context.routeWebSocket(
    () => true,
    (socket) => socket.close(WEBSOCKET_BLOCKED),
  );
  return context;
}

/**
 * The URL in a Chromium console line reporting a CSP refusal, or `null`.
 *
 * Chrome 153 writes `Connecting to 'https://...' violates the following
 * Content Security Policy directive: ...`, with `Loading the image`,
 * `Loading the font` and so on in place of `Connecting to`; older builds wrote
 * `Refused to connect to 'https://...' because it violates ...`. Both put the
 * URL first in single quotes, so the rule is the first quoted string that
 * starts with a scheme. The same refusal's second line (`Fetch API cannot load
 * ... document's Content Security Policy`) quotes nothing and is `null`, as is
 * any line that is not about CSP.
 */
export function cspRefusedUrl(text: string): string | null {
  if (!text.includes("Content Security Policy")) return null;
  const match = /'([a-z][a-z0-9+.-]*:[^']*)'/i.exec(text);
  return match?.[1] ?? null;
}

// ---------------------------------------------------------------------------
// The shape every verb uses
// ---------------------------------------------------------------------------

export interface WithCanvasOptions {
  /** Directory to serve. Defaults to the built page bundle. */
  pageRoot?: string | undefined;
  chromium?: string | undefined;
  headed?: boolean | undefined;
  timeoutMs?: number | undefined;
}

/**
 * Serve the page, open it, run `fn`, and close both whatever happens.
 *
 * Layering rule 7 in one function. Every verb in `canvas.ts` goes through it,
 * so no verb has its own `finally` to get wrong, and a snippet that hangs
 * still leaves a clean process behind.
 */
export async function withCanvas<T>(
  options: WithCanvasOptions,
  fn: (canvas: CanvasHandle) => Promise<T>,
): Promise<T> {
  const root = options.pageRoot ?? PAGE_DIST_DIR;
  let server: PageServer;
  try {
    server = await startPageServer({ root });
  } catch (error) {
    throw new EnvironmentError(`could not serve ${root}: ${(error as Error).message}`, {
      cause: error,
    });
  }

  let canvas: CanvasHandle;
  try {
    canvas = await openCanvasPage({
      url: server.url,
      chromium: options.chromium,
      headed: options.headed,
      timeoutMs: options.timeoutMs,
    });
  } catch (error) {
    await server.close();
    throw error;
  }

  try {
    return await fn(canvas);
  } finally {
    await canvas.close().catch(() => undefined);
    await server.close();
  }
}
