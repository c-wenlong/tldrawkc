/**
 * The environment checks behind `tldrawkc doctor`.
 *
 * Returns data. Printing is `src/cli/index.ts`'s job (layering rule 3), which
 * is also what lets `--json` and the human summary come from one source.
 *
 * Six checks, the table in CLI.md. Three of them are cheap and local (node,
 * the page bundle, Chromium); `page load` and `fonts` share one browser
 * session, because launching twice to ask two questions about the same page
 * load would double the slowest thing `doctor` does.
 */

import fs from "node:fs/promises";
import path from "node:path";

import { modifiedAt, newestMtime, writeAtomic } from "./files.js";
import { doctorProbePath, PAGE_DIST_DIR, PAGE_INDEX_HTML, PAGE_SRC_DIR } from "./paths.js";
import { ChromiumNotFoundError, resolveChromium, withCanvas } from "./browser.js";

/** Minimum Node the package supports. Kept in step with `engines.node`. */
export const MINIMUM_NODE_MAJOR = 22;

export type CheckStatus = "pass" | "warn" | "fail";

export interface DoctorCheck {
  /** Stable identifier, safe to match on in a script. */
  name: string;
  status: CheckStatus;
  /** One line a human can act on. */
  detail: string;
}

export interface DoctorReport {
  /** False when any check failed. A warning does not sink the report. */
  ok: boolean;
  checks: DoctorCheck[];
}

export interface DoctorOptions {
  /** The `--chromium` flag, passed straight through to the resolver. */
  chromium?: string | undefined;
  /** Where the write-access check writes. Defaults to the process cwd. */
  cwd?: string | undefined;
}

/** Run every check and return the report. Never throws for a failed check. */
export async function doctor(options: DoctorOptions = {}): Promise<DoctorReport> {
  const node = checkNode();
  const bundle = await checkPageBundle();
  const chromium = await checkChromium(options.chromium);

  // Opening the page needs both a bundle and a browser. Without either, the
  // launch would fail for a reason already on the report, and the second
  // message would only bury the first.
  const canOpen = bundle.status !== "fail" && chromium.status !== "fail";
  const page = canOpen
    ? await checkPageLoad(options.chromium)
    : unavailable(
        bundle.status === "fail" ? "the page bundle is missing" : "no Chromium is available",
      );

  const checks: DoctorCheck[] = [
    node,
    bundle,
    chromium,
    page.load,
    page.fonts,
    await checkWriteAccess(options.cwd),
  ];
  return { ok: checks.every((check) => check.status !== "fail"), checks };
}

function checkNode(): DoctorCheck {
  const version = process.versions.node;
  const major = Number.parseInt(version.split(".")[0] ?? "0", 10);
  if (major >= MINIMUM_NODE_MAJOR) {
    return { name: "node", status: "pass", detail: `node ${version}` };
  }
  return {
    name: "node",
    status: "fail",
    detail: `node ${version} is older than the required ${MINIMUM_NODE_MAJOR}`,
  };
}

/**
 * The built page has to exist, and it should be newer than its sources.
 *
 * Stale is a warning rather than a failure: the bundle still works, it is
 * just not the one the source tree describes, and failing on it would make
 * `doctor` red for anyone who edited a file and has not rebuilt yet.
 */
async function checkPageBundle(): Promise<DoctorCheck> {
  const builtAt = await modifiedAt(PAGE_INDEX_HTML);
  if (builtAt === null) {
    return {
      name: "page bundle",
      status: "fail",
      detail: `${PAGE_INDEX_HTML} is missing. Run \`npm run build\`.`,
    };
  }
  const sourcesAt = await newestMtime(PAGE_SRC_DIR);
  if (sourcesAt !== null && sourcesAt > builtAt) {
    return {
      name: "page bundle",
      status: "warn",
      detail: `${PAGE_DIST_DIR} is older than src/page. Run \`npm run build\`.`,
    };
  }
  return { name: "page bundle", status: "pass", detail: PAGE_DIST_DIR };
}

async function checkChromium(flag: string | undefined): Promise<DoctorCheck> {
  try {
    const resolved = await resolveChromium({ flag });
    return {
      name: "chromium",
      status: "pass",
      detail: `${resolved.version} (${resolved.source}) at ${resolved.executablePath}`,
    };
  } catch (error) {
    if (error instanceof ChromiumNotFoundError) {
      // The message already names the one candidate when the caller named it,
      // so the full list is only worth printing when the resolver searched.
      const listWorthPrinting = error.tried.length > 1;
      const tried = error.tried.map((entry) => `${entry.path} (${entry.reason})`).join(", ");
      return {
        name: "chromium",
        status: "fail",
        detail: listWorthPrinting ? `${error.message} Tried: ${tried}` : error.message,
      };
    }
    throw error;
  }
}

/** Font file extensions the page bundle can legitimately ask for. */
const FONT_EXTENSIONS = [".woff2", ".woff", ".ttf", ".otf"];

/**
 * Whether a URL is a font request.
 *
 * Two shapes. A real font file, which the bundle serves out of
 * `dist/page/assets/`, and tldraw's fallback when nothing supplied a URL for a
 * font key, which is a bare relative request for the key itself
 * (`tldraw_draw`). The second one is the failure this check exists for: it
 * 404s and the export quietly falls back to a system font.
 */
export function isFontUrl(url: string): boolean {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    pathname = url;
  }
  const lower = pathname.toLowerCase();
  if (FONT_EXTENSIONS.some((ext) => lower.endsWith(ext))) return true;
  const last = lower.split("/").pop() ?? "";
  return last.startsWith("tldraw_");
}

interface PageChecks {
  load: DoctorCheck;
  fonts: DoctorCheck;
}

function unavailable(reason: string): PageChecks {
  return {
    load: { name: "page load", status: "fail", detail: `not attempted: ${reason}` },
    fonts: { name: "fonts", status: "fail", detail: `not attempted: ${reason}` },
  };
}

/**
 * Open the page once and answer two questions about it.
 *
 * `page load` is the broad one: the bundle mounts, the bridge answers, nothing
 * 404s, and nothing was fetched from outside 127.0.0.1 (layering rule 8).
 * `fonts` is narrower and is here because its failure is silent: a missing
 * font does not error, it renders in Helvetica and looks nearly right. A
 * rendered check, screenshotting a one-box fixture and confirming the label is
 * Shantell Sans, is the stronger test and belongs with the page.
 */
async function checkPageLoad(chromium: string | undefined): Promise<PageChecks> {
  try {
    return await withCanvas({ chromium }, async (canvas) => {
      const failed = canvas.failedRequests();
      const offHost = canvas.offHostRequests();
      const fontFailures = failed.filter((entry) => isFontUrl(entry.url));
      const bundled = await countFontFiles();

      const problems: string[] = [];
      if (failed.length > 0) {
        problems.push(
          `${String(failed.length)} failed request(s): ${describe(failed.map((entry) => `${entry.url} (${entry.reason})`))}`,
        );
      }
      if (offHost.length > 0) {
        problems.push(`${String(offHost.length)} request(s) left 127.0.0.1: ${describe(offHost)}`);
      }

      const load: DoctorCheck = problems.length === 0
        ? {
            name: "page load",
            status: "pass",
            detail: `bridge ${canvas.version} answered, no failed or off-host requests`,
          }
        : { name: "page load", status: "fail", detail: problems.join("; ") };

      const fonts: DoctorCheck = fontFailures.length > 0
        ? {
            name: "fonts",
            status: "fail",
            detail: `${String(fontFailures.length)} font request(s) failed: ${describe(fontFailures.map((entry) => `${entry.url} (${entry.reason})`))}`,
          }
        : bundled === 0
          ? {
              name: "fonts",
              status: "fail",
              detail: `no font files under ${PAGE_DIST_DIR}. Run \`npm run build\`.`,
            }
          : {
              name: "fonts",
              status: "pass",
              detail: `${String(bundled)} font files bundled, none failed to load`,
            };

      return { load, fonts };
    });
  } catch (error) {
    const message = (error as Error).message;
    return {
      load: { name: "page load", status: "fail", detail: message },
      fonts: { name: "fonts", status: "fail", detail: `not attempted: the page did not load` },
    };
  }
}

/** Count the font files the build emitted. Sixteen is what tldraw 5 ships. */
async function countFontFiles(dir: string = PAGE_DIST_DIR): Promise<number> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let total = 0;
  for (const entry of entries) {
    if (entry.isDirectory()) total += await countFontFiles(path.join(dir, entry.name));
    else if (FONT_EXTENSIONS.some((ext) => entry.name.toLowerCase().endsWith(ext))) total += 1;
  }
  return total;
}

/**
 * Can the tool write where the caller is standing.
 *
 * Writes through the same atomic path every real write uses, so it exercises
 * the rename too: a directory that allows `write` but not `rename` (some
 * network mounts) would pass a naive check and then lose a diagram.
 */
async function checkWriteAccess(cwd: string | undefined): Promise<DoctorCheck> {
  const directory = cwd ?? process.cwd();
  const probe = doctorProbePath(directory);
  try {
    await writeAtomic(probe, "tldrawkc write check\n");
    await fs.rm(probe, { force: true });
    return { name: "write access", status: "pass", detail: directory };
  } catch (error) {
    await fs.rm(probe, { force: true }).catch(() => undefined);
    return {
      name: "write access",
      status: "fail",
      detail: `cannot write in ${directory}: ${(error as Error).message}`,
    };
  }
}

/** At most three entries, then a count. A doctor line has to stay one line. */
function describe(items: string[]): string {
  const shown = items.slice(0, 3).join(", ");
  return items.length > 3 ? `${shown}, and ${String(items.length - 3)} more` : shown;
}
