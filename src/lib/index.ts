/**
 * The public library API.
 *
 * `package.json`'s `exports["."]` points here, so anything re-exported from
 * this file is the tool's programmatic surface. It takes data and returns
 * data: no printing, no `process.exit`. That is what keeps a future MCP entry
 * (DECISIONS.md D6) a thin wrapper rather than a rewrite.
 *
 * Phase 2 adds `inspect`, `exportCanvas` and `fromMermaid`, plus the helper
 * reference generator behind the `api` command. `serve` lands in phase 4 and is
 * re-exported from here when it does.
 */

export {
  BRIDGE_TIMEOUT_MS,
  ChromiumNotFoundError,
  EXEC_TIMEOUT_MS,
  installedBrowserPaths,
  isOffHost,
  openCanvasPage,
  resolveChromium,
  VIEWPORT,
  withCanvas,
  type Bounds,
  type BridgeMethod,
  type CanvasHandle,
  type ChromiumSource,
  type ExecResult,
  type FailedRequest,
  type InspectBinding,
  type InspectData,
  type InspectShape,
  type Lint,
  type LoadResult,
  type OpenCanvasOptions,
  type PingResult,
  type ResolveChromiumOptions,
  type ResolvedChromium,
  type SetPageResult,
  type ShotOptions,
  type ShotResult,
  type SvgOptions,
  type SvgResult,
  type WithCanvasOptions,
} from "./browser.js";

export {
  exportCanvas,
  fromMermaid,
  inspect,
  newDocument,
  run,
  shot,
  type ExportOptions,
  type ExportResult,
  type ExportedFile,
  type FromMermaidOptions,
  type FromMermaidResult,
  type InspectCommandResult,
  type InspectOptions,
  type MermaidOptions,
  type NewDocumentOptions,
  type NewDocumentResult,
  type RunOptions,
  type RunResult,
  type ShotCommandOptions,
  type ShotCommandResult,
} from "./canvas.js";

export {
  buildApiReference,
  extractHelperDocs,
  readApiReference,
  readApiSources,
  selectHelperDocs,
  type BuildApiResult,
  type HelperDoc,
  type SourceFile,
} from "./api.js";

export {
  doctor,
  isFontUrl,
  MINIMUM_NODE_MAJOR,
  type CheckStatus,
  type DoctorCheck,
  type DoctorOptions,
  type DoctorReport,
} from "./doctor.js";

export {
  EXIT_CODES,
  EnvironmentError,
  ExportError,
  isTldrawkcError,
  SnippetError,
  TldrawkcError,
  UsageError,
} from "./errors.js";

export {
  modifiedAt,
  newestMtime,
  readText,
  writeAtomic,
  writePng,
  writeText,
} from "./files.js";

export {
  API_JSON,
  API_SOURCE_FILES,
  CLI_ENTRY,
  DIST_DIR,
  HELPERS_SRC_DIR,
  doctorProbePath,
  PACKAGE_ROOT,
  PAGE_DIST_DIR,
  PAGE_INDEX_HTML,
  PAGE_SRC_DIR,
  resolveOutputPath,
  resolveTldrPath,
  tempShotPath,
  tempSiblingPath,
} from "./paths.js";

export {
  contentTypeFor,
  CONTENT_TYPES,
  FALLBACK_CONTENT_TYPE,
  resolveStaticPath,
  startPageServer,
  type PageServer,
  type StartPageServerOptions,
} from "./server.js";
