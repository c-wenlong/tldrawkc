/**
 * The public library API.
 *
 * `package.json`'s `exports["."]` points here, so anything re-exported from
 * this file is the tool's programmatic surface. It takes data and returns
 * data: no printing, no `process.exit`. That is what keeps a future MCP entry
 * (DECISIONS.md D6) a thin wrapper rather than a rewrite.
 *
 * Phase 0 exposes the environment half. The drawing verbs (`run`, `shot`,
 * `inspect`, `export`, `fromMermaid`, `serve`) land in `canvas.ts` in later
 * phases and are re-exported from here when they do.
 */

export {
  ChromiumNotFoundError,
  installedBrowserPaths,
  resolveChromium,
  type ChromiumSource,
  type ResolveChromiumOptions,
  type ResolvedChromium,
} from "./browser.js";

export {
  doctor,
  MINIMUM_NODE_MAJOR,
  type CheckStatus,
  type DoctorCheck,
  type DoctorOptions,
  type DoctorReport,
} from "./doctor.js";

export {
  modifiedAt,
  newestMtime,
  readText,
  writeAtomic,
  writePng,
  writeText,
} from "./files.js";

export {
  CLI_ENTRY,
  DIST_DIR,
  PACKAGE_ROOT,
  PAGE_DIST_DIR,
  PAGE_INDEX_HTML,
  PAGE_SRC_DIR,
  resolveTldrPath,
  tempShotPath,
  tempSiblingPath,
} from "./paths.js";
