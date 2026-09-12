/**
 * One function per verb.
 *
 * Layering rule 3: everything here takes data and returns data. Nothing
 * prints, nothing exits, nothing reads `process.argv`. A failure is one of the
 * typed errors in `errors.ts`, which carry the exit code the CLI should use,
 * so the mapping from "what went wrong" to "what the shell sees" is a property
 * lookup rather than a string match.
 *
 * Every verb goes through `withCanvas`, which owns the server and the browser
 * and closes both in a `finally` (layering rule 7). No verb here has a
 * `finally` of its own, which is the point: there is one place to get it
 * wrong, and it is not this file.
 */

import { isAlreadyExists, readText, writePng, writeText } from "./files.js";
import { isSamePath, resolveOutputPath, resolveTldrPath, tempShotPath } from "./paths.js";
import { EnvironmentError, ExportError, SnippetError, UsageError } from "./errors.js";
import {
  withCanvas,
  type Bounds,
  type BridgeMethod,
  type CanvasHandle,
  type InspectData,
  type Lint,
  type ShotOptions,
  type SvgOptions,
} from "./browser.js";

/** Options every verb shares: how to get a browser and where to resolve paths. */
interface CommonOptions {
  /** Working directory relative paths resolve against. */
  cwd?: string | undefined;
  /** The `--chromium` flag. */
  chromium?: string | undefined;
  /** The `--headed` flag. */
  headed?: boolean | undefined;
  /**
   * The directory the page is served from. Defaults to `dist/page`.
   *
   * A test point, not a CLI flag: it is what lets the end-to-end suite drive
   * the Node side against a stand-in bridge, so a failure there is a failure
   * in this file rather than in the page.
   */
  pageRoot?: string | undefined;
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

export interface RunOptions extends CommonOptions {
  /** The `.tldr` to load, edit and save. */
  file: string;
  /** Path to a snippet file. Mutually exclusive with `evalSource`. */
  code?: string | undefined;
  /** Inline snippet source. Mutually exclusive with `code`. */
  evalSource?: string | undefined;
  /** Where to write a PNG after the snippet, or nothing. */
  shot?: string | undefined;
  /** Where to write an SVG after the snippet, or nothing. */
  svg?: string | undefined;
  /** Start from an empty document when the file does not exist. */
  create: boolean;
  /** False for `--no-save`: run and export, leave the file alone. */
  save: boolean;
  /** Turn a non-empty lint list from exit 3 into exit 0. */
  allowLints: boolean;
  /** The `--page` flag, or nothing for the first page. */
  page?: string | undefined;
  /** Export padding in page units. */
  padding: number;
  /** PNG resolution multiplier. */
  pixelRatio: number;
  /** Cap on the `exec` step. */
  timeoutMs: number;
}

export interface RunResult {
  /** The resolved absolute path of the document. */
  file: string;
  /** Whatever the snippet returned, already JSON-safe. */
  result: unknown;
  shapeCount: number;
  lints: Lint[];
  /** Where the PNG went, or `null` when none was asked for. */
  shot: string | null;
  /** Where the SVG went, or `null` when none was asked for. */
  svg: string | null;
  /** Wall clock for the whole command, in milliseconds. */
  ms: number;
  /** False when `--no-save` kept the document untouched. */
  saved: boolean;
  /** 0, or 3 when lints remain and `--allow-lints` was not passed. */
  exitCode: number;
}

/**
 * Load, run a snippet, save, export.
 *
 * The order matters and is the order in the sequence diagram in
 * ARCHITECTURE.md: the document is saved before anything is exported, so a
 * broken export costs a picture and never the work. That is the whole reason
 * exit 4 exists as a separate code.
 */
export async function run(options: RunOptions): Promise<RunResult> {
  const started = Date.now();
  const file = resolveTldrPath(options.file, options.cwd);
  const existing = await readText(file);
  if (existing === null && !options.create) {
    throw new UsageError(
      `${file} does not exist. Pass --create to start from an empty document.`,
    );
  }
  const source = await readSnippet(options);
  refuseSelfOverwrite(file, [
    options.shot === undefined || options.shot === ""
      ? undefined
      : resolveOutputPath(options.shot, options.cwd),
    options.svg === undefined ? undefined : resolveOutputPath(options.svg, options.cwd),
  ]);

  return await withCanvas(
    {
      pageRoot: options.pageRoot,
      chromium: options.chromium,
      headed: options.headed,
    },
    async (canvas) => {
      // Checked before anything runs, so an unsupported export is a usage
      // error with the document untouched rather than an exit 4 after a save.
      if (options.svg !== undefined && !(await canvas.has("svg"))) {
        throw new UsageError(
          "--svg needs the page's svg() bridge function, which this page bundle " +
            "does not implement. Rebuild it with `npm run build`.",
        );
      }
      const needed: BridgeMethod[] = ["load", "exec"];
      if (options.page !== undefined) needed.push("setPage");
      if (options.save) needed.push("save");
      if (options.shot !== undefined) needed.push("shot");
      await requireBridge(canvas, needed);

      await canvas.load(existing);
      if (options.page !== undefined) await setPage(canvas, options.page);

      const exec = await execWithTimeout(canvas, source, options.timeoutMs);

      let saved = false;
      if (options.save) {
        const json = await saveDocument(canvas);
        await writeText(file, json);
        saved = true;
      }

      const shot = await exportPng(canvas, options, file);
      const svg = await exportSvg(canvas, options);

      const lints = exec.lints;
      return {
        file,
        result: exec.result,
        shapeCount: exec.shapeCount,
        lints,
        shot,
        svg,
        ms: Date.now() - started,
        saved,
        exitCode: lints.length > 0 && !options.allowLints ? 3 : 0,
      };
    },
  );
}

// ---------------------------------------------------------------------------
// shot
// ---------------------------------------------------------------------------

export interface ShotCommandOptions extends CommonOptions {
  file: string;
  /** The `-o` flag. Without it the PNG lands in the system temp directory. */
  output?: string | undefined;
  /** The `--ids` list. Empty means every shape on the page. */
  ids?: string[] | undefined;
  page?: string | undefined;
  padding: number;
  pixelRatio: number;
}

export interface ShotCommandResult {
  file: string;
  /** Where the PNG went. Always absolute, because it is often in `/tmp`. */
  shot: string;
  width: number;
  height: number;
  bounds: Bounds;
  ms: number;
}

/** Screenshot an existing document without running anything. */
export async function shot(options: ShotCommandOptions): Promise<ShotCommandResult> {
  const started = Date.now();
  const file = resolveTldrPath(options.file, options.cwd);
  const existing = await readText(file);
  if (existing === null) throw new UsageError(`${file} does not exist.`);

  const output = options.output === undefined
    ? tempShotPath(file)
    : resolveOutputPath(options.output, options.cwd);
  refuseSelfOverwrite(file, [output]);

  return await withCanvas(
    {
      pageRoot: options.pageRoot,
      chromium: options.chromium,
      headed: options.headed,
    },
    async (canvas) => {
      const needed: BridgeMethod[] = ["load", "shot"];
      if (options.page !== undefined) needed.push("setPage");
      await requireBridge(canvas, needed);

      await canvas.load(existing);
      if (options.page !== undefined) await setPage(canvas, options.page);

      const shotOptions: ShotOptions = {
        padding: options.padding,
        pixelRatio: options.pixelRatio,
      };
      if (options.ids && options.ids.length > 0) shotOptions.ids = options.ids;

      let taken;
      try {
        taken = await canvas.shot(shotOptions);
      } catch (error) {
        throw new ExportError(`the screenshot failed: ${firstLine(error)}`, { cause: error });
      }
      await writePng(output, taken.pngBase64);

      return {
        file,
        shot: output,
        width: taken.width,
        height: taken.height,
        bounds: taken.bounds,
        ms: Date.now() - started,
      };
    },
  );
}

// ---------------------------------------------------------------------------
// inspect
// ---------------------------------------------------------------------------

export interface InspectOptions extends CommonOptions {
  file: string;
  page?: string | undefined;
  /** Turn a non-empty lint list from exit 3 into exit 0. */
  allowLints: boolean;
}

export interface InspectCommandResult {
  file: string;
  /**
   * The bridge's `inspect()` structure, untouched.
   *
   * Nested rather than spread across this object on purpose: ARCHITECTURE.md
   * defines that shape and `inspect --json` prints it unchanged, so there has
   * to be one field that is exactly it and nothing else.
   */
  canvas: InspectData;
  ms: number;
  /** 0, or 3 when lints remain and `--allow-lints` was not passed. */
  exitCode: number;
}

/**
 * Read the canvas without touching it.
 *
 * Nothing is saved, because nothing changed: the document is loaded, read and
 * dropped. The lint pass still runs and still decides the exit code, which is
 * what makes `inspect` usable as a check in its own right.
 */
export async function inspect(options: InspectOptions): Promise<InspectCommandResult> {
  const started = Date.now();
  const file = resolveTldrPath(options.file, options.cwd);
  const existing = await readText(file);
  if (existing === null) throw new UsageError(`${file} does not exist.`);

  return await withCanvas(
    {
      pageRoot: options.pageRoot,
      chromium: options.chromium,
      headed: options.headed,
    },
    async (canvas) => {
      const needed: BridgeMethod[] = ["load", "inspect"];
      if (options.page !== undefined) needed.push("setPage");
      await requireBridge(canvas, needed);

      await canvas.load(existing);
      if (options.page !== undefined) await setPage(canvas, options.page);

      const read = await canvas.inspect();
      return {
        file,
        canvas: read,
        ms: Date.now() - started,
        exitCode: read.lints.length > 0 && !options.allowLints ? 3 : 0,
      };
    },
  );
}

// ---------------------------------------------------------------------------
// export
// ---------------------------------------------------------------------------

export interface ExportOptions extends CommonOptions {
  file: string;
  /** Where to write the SVG. At least one of `svg` and `png` is required. */
  svg?: string | undefined;
  /** Where to write the PNG. */
  png?: string | undefined;
  /** Frame only these shapes. Empty or absent means every shape on the page. */
  ids?: string[] | undefined;
  page?: string | undefined;
  padding: number;
  pixelRatio: number;
}

/** One written export. `width` and `height` are that format's own units. */
export interface ExportedFile {
  path: string;
  width: number;
  height: number;
}

export interface ExportResult {
  file: string;
  svg: ExportedFile | null;
  png: ExportedFile | null;
  ms: number;
  exitCode: number;
}

/**
 * Refuse an export aimed at the document it came from.
 *
 * `export diagram.tldr --svg ./diagram.tldr` passes every other check and then
 * replaces the drawing with a picture of it. The `.tldr` is the only editable
 * copy, so that is unrecoverable, and one mistyped path is all it takes. Every
 * verb that writes an export calls this before it launches a browser, so the
 * answer arrives as a usage error rather than as a half-destroyed file.
 */
function refuseSelfOverwrite(file: string, targets: ReadonlyArray<string | undefined>): void {
  for (const target of targets) {
    if (target !== undefined && isSamePath(target, file)) {
      throw new UsageError(
        `refusing to write an export over the document itself (${file}). Pick another output path.`,
      );
    }
  }
}

/**
 * Write an SVG, a PNG, or both, from a document that is already finished.
 *
 * Nothing is executed and nothing is saved, so the only thing that can fail is
 * the export itself, which is exit 4 (`ExportError`). The `.tldr` is never at
 * risk here, and that is why this verb is separate from `run --svg`: an agent
 * that has drawn the diagram and only wants the file out of it should not have
 * to hand over a snippet to get one.
 */
export async function exportCanvas(options: ExportOptions): Promise<ExportResult> {
  const started = Date.now();
  const file = resolveTldrPath(options.file, options.cwd);
  if (options.svg === undefined && options.png === undefined) {
    throw new UsageError("export needs --svg <out.svg>, --png <out.png>, or both.");
  }
  const existing = await readText(file);
  if (existing === null) throw new UsageError(`${file} does not exist.`);

  const svgTarget = options.svg === undefined
    ? null
    : resolveOutputPath(options.svg, options.cwd);
  const pngTarget = options.png === undefined
    ? null
    : resolveOutputPath(options.png, options.cwd);
  refuseSelfOverwrite(file, [svgTarget ?? undefined, pngTarget ?? undefined]);

  return await withCanvas(
    {
      pageRoot: options.pageRoot,
      chromium: options.chromium,
      headed: options.headed,
    },
    async (canvas) => {
      const needed: BridgeMethod[] = ["load"];
      if (svgTarget) needed.push("svg");
      if (pngTarget) needed.push("shot");
      if (options.page !== undefined) needed.push("setPage");
      await requireBridge(canvas, needed);

      await canvas.load(existing);
      if (options.page !== undefined) await setPage(canvas, options.page);

      const ids = options.ids && options.ids.length > 0 ? options.ids : undefined;

      let svg: ExportedFile | null = null;
      if (svgTarget) {
        const svgOptions: SvgOptions = { padding: options.padding };
        if (ids) svgOptions.ids = ids;
        try {
          const exported = await canvas.svg(svgOptions);
          await writeText(svgTarget, exported.svg);
          svg = { path: svgTarget, width: exported.width, height: exported.height };
        } catch (error) {
          throw new ExportError(`the SVG export failed: ${firstLine(error)}`, { cause: error });
        }
      }

      let png: ExportedFile | null = null;
      if (pngTarget) {
        const shotOptions: ShotOptions = {
          padding: options.padding,
          pixelRatio: options.pixelRatio,
        };
        if (ids) shotOptions.ids = ids;
        try {
          const taken = await canvas.shot(shotOptions);
          await writePng(pngTarget, taken.pngBase64);
          png = { path: pngTarget, width: taken.width, height: taken.height };
        } catch (error) {
          throw new ExportError(`the PNG export failed: ${firstLine(error)}`, { cause: error });
        }
      }

      return { file, svg, png, ms: Date.now() - started, exitCode: 0 };
    },
  );
}

// ---------------------------------------------------------------------------
// from-mermaid
// ---------------------------------------------------------------------------

/** What `helpers.mermaid` takes beyond the source, all optional. */
export interface MermaidOptions {
  /** Overrides the direction in the flowchart header. */
  direction?: string;
  /** Top-left of the layout in page coordinates. */
  origin?: { x: number; y: number };
  /** Rank and node gaps. */
  spacing?: { rank?: number; node?: number };
}

export interface FromMermaidOptions extends CommonOptions {
  file: string;
  /** The mermaid text itself. The CLI reads `--source <path>` or stdin. */
  source: string;
  /** Add to an existing document instead of refusing to overwrite it. */
  append: boolean;
  /** Where to write a PNG afterwards, or nothing. */
  shot?: string | undefined;
  allowLints: boolean;
  page?: string | undefined;
  padding: number;
  pixelRatio: number;
  timeoutMs: number;
  /** Passed through to `helpers.mermaid`. */
  mermaid?: MermaidOptions | undefined;
}

export interface FromMermaidResult {
  file: string;
  /** Mermaid id to tldraw shape id, for every node that was created. */
  nodes: Record<string, string>;
  /** The arrow ids, one per edge. */
  edges: string[];
  /** The container ids, one per subgraph. */
  containers: string[];
  /**
   * Every source line the parser could not read.
   *
   * Reported rather than dropped, and printed on stderr in human mode: a
   * diagram that silently lost three statements looks finished and is not.
   */
  unsupported: string[];
  shapeCount: number;
  lints: Lint[];
  shot: string | null;
  ms: number;
  exitCode: number;
}

/**
 * Lift a mermaid flowchart onto the canvas.
 *
 * The parse and the layout happen in the page, in `helpers.mermaid`, so this
 * function is the same load, exec, save, export sequence every other writing
 * verb uses. What it adds is the file rule: without `--append` the document
 * must not already exist, because the command's whole job is migration and
 * overwriting a canvas someone has since fixed by hand is the one unrecoverable
 * mistake available here.
 */
export async function fromMermaid(options: FromMermaidOptions): Promise<FromMermaidResult> {
  const started = Date.now();
  const file = resolveTldrPath(options.file, options.cwd);
  const existing = await readText(file);

  if (!options.append && existing !== null) {
    throw new UsageError(
      `${file} already exists. Pass --append to add to it, or pick another name.`,
    );
  }
  if (options.append && existing === null) {
    throw new UsageError(`--append needs an existing document, and ${file} is not there.`);
  }
  if (options.source.trim() === "") {
    throw new UsageError("the mermaid source is empty.");
  }
  refuseSelfOverwrite(file, [
    options.shot === undefined ? undefined : resolveOutputPath(options.shot, options.cwd),
  ]);

  return await withCanvas(
    {
      pageRoot: options.pageRoot,
      chromium: options.chromium,
      headed: options.headed,
    },
    async (canvas) => {
      const needed: BridgeMethod[] = ["load", "exec", "save"];
      if (options.page !== undefined) needed.push("setPage");
      if (options.shot !== undefined) needed.push("shot");
      await requireBridge(canvas, needed);

      await canvas.load(existing);
      if (options.page !== undefined) await setPage(canvas, options.page);
      await requireMermaidHelper(canvas, options.timeoutMs);

      const exec = await execWithTimeout(
        canvas,
        mermaidSnippet(options.source, options.mermaid),
        options.timeoutMs,
      );
      const imported = readMermaidResult(exec.result);

      const json = await saveDocument(canvas);
      // Exclusive unless appending, for the same reason `new` is: the early
      // existence check answers fast, and only the write itself can refuse a
      // file that appeared while the page was busy. Two imports of the same
      // name would otherwise both pass the check and silently overwrite.
      try {
        await writeText(file, json, options.append ? {} : { exclusive: true });
      } catch (error) {
        if (isAlreadyExists(error)) {
          throw new UsageError(
            `${file} was created while the import was running. Pass --append to add to it, or pick another name.`,
          );
        }
        throw error;
      }

      let shot: string | null = null;
      if (options.shot !== undefined) {
        const target = resolveOutputPath(options.shot, options.cwd);
        try {
          const taken = await canvas.shot({
            padding: options.padding,
            pixelRatio: options.pixelRatio,
          });
          shot = await writePng(target, taken.pngBase64);
        } catch (error) {
          throw new ExportError(`the document was saved but the PNG failed: ${firstLine(error)}`, {
            cause: error,
          });
        }
      }

      return {
        file,
        nodes: imported.nodes,
        edges: imported.edges,
        containers: imported.containers,
        unsupported: imported.unsupported,
        shapeCount: exec.shapeCount,
        lints: exec.lints,
        shot,
        ms: Date.now() - started,
        exitCode: exec.lints.length > 0 && !options.allowLints ? 3 : 0,
      };
    },
  );
}

/**
 * Refuse a page bundle whose helpers bag has no `mermaid`.
 *
 * `canvas.has()` only sees the bridge, and `mermaid` lives one level down in
 * the helpers bag, so the probe is a one-line snippet. Without it the failure
 * arrives as `helpers.mermaid is not a function` with exit 2, which reads like
 * the diagram's fault rather than a stale build's.
 */
async function requireMermaidHelper(canvas: CanvasHandle, timeoutMs: number): Promise<void> {
  const probe = await execWithTimeout(
    canvas,
    "return typeof helpers.mermaid === 'function'",
    timeoutMs,
  );
  if (probe.result === true) return;
  throw new EnvironmentError(
    "the page bundle's helpers bag has no mermaid(). Rebuild it with `npm run build`, " +
      "or check that src/page/helpers is up to date.",
  );
}

/**
 * The snippet that runs the importer.
 *
 * The source is embedded as JSON and parsed at runtime rather than pasted into
 * the program text. A diagram is arbitrary text: one backtick, quote or
 * backslash in a node label would otherwise end the literal and the rest of the
 * file would be read as code.
 */
function mermaidSnippet(source: string, mermaid: MermaidOptions | undefined): string {
  const encodedSource = JSON.stringify(JSON.stringify(source));
  const encodedOptions = JSON.stringify(JSON.stringify(mermaid ?? {}));
  return [
    `const source = JSON.parse(${encodedSource})`,
    `const opts = JSON.parse(${encodedOptions})`,
    "return await helpers.mermaid(source, opts)",
  ].join("\n");
}

/** What the page is expected to hand back from `helpers.mermaid`. */
interface MermaidImport {
  nodes: Record<string, string>;
  edges: string[];
  containers: string[];
  unsupported: string[];
}

/**
 * Read the page's answer defensively.
 *
 * It arrives as `unknown` from the other side of a `page.evaluate`, and a
 * missing field should say which one rather than becoming `undefined` in the
 * printed JSON three steps later.
 */
function readMermaidResult(value: unknown): MermaidImport {
  if (typeof value !== "object" || value === null) {
    throw new EnvironmentError(
      `helpers.mermaid returned ${typeof value}, not the expected object.`,
    );
  }
  const record = value as Record<string, unknown>;
  // Null-prototype for the same reason the page uses one: `__proto__` is a
  // legal mermaid node id, and copying it onto an ordinary object would set
  // the prototype and lose the entry.
  const nodes: Record<string, string> = Object.create(null) as Record<string, string>;
  const rawNodes = record["nodes"];
  if (typeof rawNodes === "object" && rawNodes !== null) {
    for (const [key, id] of Object.entries(rawNodes as Record<string, unknown>)) {
      if (typeof id === "string") nodes[key] = id;
    }
  }
  return {
    nodes,
    edges: stringList(record["edges"]),
    containers: stringList(record["containers"]),
    unsupported: stringList(record["unsupported"]),
  };
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

// ---------------------------------------------------------------------------
// new
// ---------------------------------------------------------------------------

export interface NewDocumentOptions extends CommonOptions {
  file: string;
  /** `--from`: an existing `.tldr` to start from. */
  from?: string | undefined;
}

export interface NewDocumentResult {
  file: string;
  ms: number;
}

/**
 * Create an empty document, or a copy of another one.
 *
 * It goes through the browser rather than writing a hand-built envelope,
 * because the envelope carries a schema version and every record's migration
 * state. Letting the page serialise an empty editor means the file is exactly
 * what the installed tldraw writes, and it stays correct when tldraw bumps its
 * schema. The cost is a browser launch for a file that is mostly empty, which
 * is a second, once.
 */
export async function newDocument(options: NewDocumentOptions): Promise<NewDocumentResult> {
  const started = Date.now();
  const file = resolveTldrPath(options.file, options.cwd);
  // Checked here so the caller hears "that exists" in a millisecond rather
  // than after a browser launch. The claim is made by the exclusive write
  // below, which is what makes the refusal true even if something else creates
  // the file while the page is starting up.
  if ((await readText(file)) !== null) {
    throw new UsageError(`${file} already exists. Delete it or pick another name.`);
  }

  let from: string | null = null;
  if (options.from !== undefined) {
    const source = resolveTldrPath(options.from, options.cwd);
    from = await readText(source);
    if (from === null) throw new UsageError(`--from ${source} does not exist.`);
  }

  return await withCanvas(
    {
      pageRoot: options.pageRoot,
      chromium: options.chromium,
      headed: options.headed,
    },
    async (canvas) => {
      await requireBridge(canvas, ["load", "save"]);
      await canvas.load(from);
      const json = await saveDocument(canvas);
      try {
        await writeText(file, json, { exclusive: true });
      } catch (error) {
        if (isAlreadyExists(error)) {
          throw new UsageError(
            `${file} was created while this command was running. Nothing was overwritten.`,
          );
        }
        throw error;
      }
      return { file, ms: Date.now() - started };
    },
  );
}

// ---------------------------------------------------------------------------
// shared steps
// ---------------------------------------------------------------------------

/**
 * Refuse early when the loaded page does not implement what the verb needs.
 *
 * The alternative is a raw `window.__tldrawkc.load is not a function` from
 * inside `page.evaluate`, which reads like a bug in the tool rather than a
 * page bundle that is older than the command asking. It also keeps the failure
 * before the save step, so nothing is half done.
 */
async function requireBridge(canvas: CanvasHandle, methods: BridgeMethod[]): Promise<void> {
  const missing: string[] = [];
  for (const method of methods) {
    if (!(await canvas.has(method))) missing.push(`${method}()`);
  }
  if (missing.length === 0) return;
  throw new EnvironmentError(
    `the page bundle does not implement ${missing.join(", ")}. ` +
      "Rebuild it with `npm run build`, or check that src/page is up to date.",
  );
}

/** `--code` or `--eval`, exactly one of them, read into a string. */
async function readSnippet(options: RunOptions): Promise<string> {
  if (options.code !== undefined && options.evalSource !== undefined) {
    throw new UsageError("--code and --eval are mutually exclusive.");
  }
  if (options.evalSource !== undefined) return options.evalSource;
  if (options.code === undefined) {
    throw new UsageError('run needs a snippet: pass --code <path>, --code - for stdin, or --eval "<source>".');
  }
  const path = resolveOutputPath(options.code, options.cwd);
  const source = await readText(path);
  if (source === null) throw new UsageError(`--code ${path} does not exist.`);
  return source;
}

async function setPage(canvas: CanvasHandle, name: string): Promise<void> {
  try {
    await canvas.setPage(name);
  } catch (error) {
    throw new UsageError(`--page ${name}: ${firstLine(error)}`);
  }
}

/**
 * Run the snippet, but never for longer than the caller allowed.
 *
 * A snippet is arbitrary JavaScript with a live editor, so an infinite loop is
 * a thing an agent will write. `Promise.race` bounds it; the browser is closed
 * by `withCanvas` on the way out, which is what actually stops the runaway
 * page. The losing promise is swallowed, because it rejects with "target
 * closed" a moment later and an unhandled rejection would take the process
 * down before the error is printed.
 */
async function execWithTimeout(canvas: CanvasHandle, source: string, timeoutMs: number) {
  const running = canvas.exec(source);
  let timer: NodeJS.Timeout | undefined;
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(
        new EnvironmentError(
          `the snippet did not finish within ${String(timeoutMs)} ms. Raise --timeout or simplify it.`,
        ),
      );
    }, timeoutMs);
    timer.unref?.();
  });

  try {
    return await Promise.race([running, expiry]);
  } catch (error) {
    running.catch(() => undefined);
    if (error instanceof EnvironmentError) throw error;
    throw new SnippetError(`the snippet threw: ${firstLine(error)}`, stackOf(error));
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function saveDocument(canvas: CanvasHandle): Promise<string> {
  try {
    return await canvas.save();
  } catch (error) {
    throw new EnvironmentError(`the page could not serialise the document: ${firstLine(error)}`, {
      cause: error,
    });
  }
}

/** The PNG half of `run`'s export step. Exit 4 territory: the save already happened. */
async function exportPng(
  canvas: CanvasHandle,
  options: RunOptions,
  file: string,
): Promise<string | null> {
  if (options.shot === undefined) return null;
  const target = options.shot === "" ? tempShotPath(file) : resolveOutputPath(options.shot, options.cwd);
  try {
    const taken = await canvas.shot({
      padding: options.padding,
      pixelRatio: options.pixelRatio,
    });
    return await writePng(target, taken.pngBase64);
  } catch (error) {
    throw new ExportError(`the document was saved but the PNG failed: ${firstLine(error)}`, {
      cause: error,
    });
  }
}

/** The SVG half. Capability was checked before the snippet ran. */
async function exportSvg(canvas: CanvasHandle, options: RunOptions): Promise<string | null> {
  if (options.svg === undefined) return null;
  const target = resolveOutputPath(options.svg, options.cwd);
  try {
    const exported = await canvas.svg({ padding: options.padding });
    return await writeText(target, exported.svg);
  } catch (error) {
    throw new ExportError(`the document was saved but the SVG failed: ${firstLine(error)}`, {
      cause: error,
    });
  }
}

function firstLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split("\n")[0] ?? message;
}

function stackOf(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  return error.stack ?? error.message;
}
