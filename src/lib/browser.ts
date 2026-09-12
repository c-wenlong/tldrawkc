/**
 * Finding a browser.
 *
 * Phase 0 needs only the resolution half of this module: launching the page
 * and waiting for the bridge arrives in phase 1. The tool depends on
 * `playwright-core`, which ships no browser of its own, so the executable has
 * to come from somewhere on the machine. DECISIONS.md D9 fixes the order.
 */

import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { chromium } from "playwright-core";

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

export class ChromiumNotFoundError extends Error implements ChromiumResolutionFailure {
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
