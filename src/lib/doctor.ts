/**
 * The environment checks behind `tldrawkc doctor`.
 *
 * Returns data. Printing is `src/cli/index.ts`'s job (layering rule 3), which
 * is also what lets `--json` and the human summary come from one source.
 *
 * Phase 0 covers the three checks the roadmap asks for: node, the page
 * bundle, and Chromium. The page-load and failed-request checks in CLI.md
 * need the bridge, so they arrive with it in phase 1.
 */

import { modifiedAt, newestMtime } from "./files.js";
import { PAGE_DIST_DIR, PAGE_INDEX_HTML, PAGE_SRC_DIR } from "./paths.js";
import { ChromiumNotFoundError, resolveChromium } from "./browser.js";

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
}

/** Run every check and return the report. Never throws for a failed check. */
export async function doctor(options: DoctorOptions = {}): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [
    checkNode(),
    await checkPageBundle(),
    await checkChromium(options.chromium),
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
      const tried = error.tried.map((entry) => `${entry.path} (${entry.reason})`).join(", ");
      return {
        name: "chromium",
        status: "fail",
        detail: `${error.message} Tried: ${tried || "nothing"}`,
      };
    }
    throw error;
  }
}
