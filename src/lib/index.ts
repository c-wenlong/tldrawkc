/**
 * The public library API.
 *
 * `package.json`'s `exports["."]` points here, so anything re-exported from
 * this file is the tool's programmatic surface. It takes data and returns
 * data: no printing, no `process.exit`. That is what keeps a future MCP entry
 * (DECISIONS.md D6) a thin wrapper rather than a rewrite.
 *
 * Phase 2 adds `inspect`, `exportCanvas` and `fromMermaid`, plus the helper
 * reference generator behind the `api` command. Phase 4 adds `serve`, which is
 * the one verb that returns while its server is still running: its handle
 * carries the `close` the caller owes it.
 */

export {
  hasBlockingLints,
  severityOf,
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
  type LintSeverity,
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
  type ExportedSvg,
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
  collectSvgCharacters,
  decodeEntities,
  findFontFaces,
  spliceFontFaces,
  subsetSvgFonts,
  SAFETY_CHARACTERS,
  type FontFaceOutcome,
  type InlinedFontFace,
  type SubsetFontsOptions,
  type SubsetFontsResult,
} from "./fonts.js";

export {
  list,
  type DiagramEntry,
  type DiagramError,
  type ListOptions,
  type ListResult,
  type SiblingFile,
} from "./list.js";

export {
  applyMeta,
  isEmptyPatch,
  mergeDocumentMeta,
  readDocumentMeta,
  readMeta,
  readTldrFacts,
  setMeta,
  stampSvg,
  validatePatch,
  META_KEY,
  META_VERSION,
  SLUG_PATTERN,
  SVG_TOPIC_ATTRIBUTE,
  type DiagramMeta,
  type MetaPatch,
  type SetMetaOptions,
  type SetMetaResult,
  type TldrFacts,
} from "./meta.js";

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
  DEFAULT_LIST_DIR,
  DIST_DIR,
  HELPERS_SRC_DIR,
  doctorProbePath,
  PACKAGE_ROOT,
  PAGE_DIST_DIR,
  PAGE_INDEX_HTML,
  PAGE_SRC_DIR,
  relativeToDir,
  resolveListDir,
  resolveOutputPath,
  resolveTldrPath,
  siblingPath,
  tempShotPath,
  tempSiblingPath,
} from "./paths.js";

export {
  contentTypeFor,
  CONTENT_TYPES,
  DEFAULT_SERVE_PORT,
  FALLBACK_CONTENT_TYPE,
  MAX_DOCUMENT_BYTES,
  MIRROR_QUERY,
  mirrorUrl,
  resolveStaticPath,
  startPageServer,
  startServeServer,
  type PageServer,
  type ServeApiOptions,
  type ServeServer,
  type StartPageServerOptions,
  type StartServeServerOptions,
} from "./server.js";

export {
  openCommandFor,
  openInBrowser,
  serve,
  type OpenCommand,
  type ServeHandle,
  type ServeOptions,
} from "./serve.js";
