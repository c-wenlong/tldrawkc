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
import { resolveOutputPath, resolveTldrPath, tempShotPath } from "./paths.js";
import { EnvironmentError, ExportError, SnippetError, UsageError } from "./errors.js";
import {
  withCanvas,
  type Bounds,
  type BridgeMethod,
  type CanvasHandle,
  type Lint,
  type ShotOptions,
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
          "--svg needs the page's svg() bridge function, which arrives in phase 2.",
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
