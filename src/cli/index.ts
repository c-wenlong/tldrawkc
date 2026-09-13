#!/usr/bin/env node
/**
 * `tldrawkc`: draw a diagram on a real tldraw canvas, look at it, fix it.
 *
 *   tldrawkc new <file.tldr>          an empty document
 *   tldrawkc run <file.tldr> ...      load, run a snippet, save, export
 *   tldrawkc shot <file.tldr>         a PNG of what is there
 *   tldrawkc inspect <file.tldr>      what is on the canvas, as text or JSON
 *   tldrawkc list [dir]               every .tldr in a directory, with its metadata
 *   tldrawkc meta set <file.tldr>     stamp a topic on an existing document
 *   tldrawkc export <file.tldr> ...   the SVG or PNG that gets committed
 *   tldrawkc from-mermaid <file.tldr> lift a mermaid flowchart onto the canvas
 *   tldrawkc serve <file.tldr>        mirror a document in a real browser tab
 *   tldrawkc api                      what a snippet can call
 *   tldrawkc doctor                   is this machine able to run the tool
 *   tldrawkc help                     usage for every command
 *
 * Layering rule 3: this is the only module that prints. Everything under
 * `src/lib/` returns data, which is why `--json` and the human summary can
 * come from the same call, and why every failure arrives here as a typed error
 * carrying its own exit code rather than as a message to match on.
 *
 * Nothing here calls `process.exit`. When stdout is a pipe Node's writes are
 * asynchronous, and exiting mid-flush drops whatever is still buffered, so
 * every path sets `process.exitCode` and returns: the process ends when the
 * event loop drains, by which point the output is out.
 */

import process from "node:process";

import {
  exportCanvas,
  fromMermaid,
  inspect,
  newDocument,
  run,
  shot,
  type ExportResult,
  type FromMermaidResult,
  type RunResult,
} from "../lib/canvas.js";
import { readApiReference, type HelperDoc } from "../lib/api.js";
import { list, type ListResult } from "../lib/list.js";
import { setMeta, type DiagramMeta, type MetaPatch, type SetMetaResult } from "../lib/meta.js";
import { doctor, type DoctorReport } from "../lib/doctor.js";
import { serve, type ServeHandle } from "../lib/serve.js";
import { isTldrawkcError, SnippetError, UsageError } from "../lib/errors.js";
import { readText } from "../lib/files.js";
import { resolveOutputPath } from "../lib/paths.js";
import { severityOf, type InspectData, type Lint } from "../lib/browser.js";
import {
  EXIT,
  IMPLEMENTED_COMMANDS,
  PLANNED_COMMANDS,
  parseCommand,
  type CommandOptions,
  type GlobalOptions,
} from "./args.js";

/**
 * The "not built yet" block, or nothing when everything specified is built.
 *
 * An empty heading followed by no commands reads like a bug in the help text,
 * which is what it looked like the moment `serve` shipped and left
 * `PLANNED_COMMANDS` empty.
 */
function plannedSection(): string {
  const entries = Object.entries(PLANNED_COMMANDS);
  if (entries.length === 0) return "";
  const lines = entries.map(([name, phase]) => `  ${name.padEnd(30)} ${phase}`).join("\n");
  return `Planned (specified in CLI.md, not built yet)\n${lines}\n\n`;
}

const USAGE = `tldrawkc <command> [file] [options]

Commands
  new <file.tldr>                create an empty document, refuses to overwrite
      --from <other.tldr>        start from a copy of another document
      --title <text>             document metadata: a human title
      --topic <slug>             document metadata: one vocabulary slug
      --concept <slug>           document metadata: a concept slug, repeatable
      --source <text>            document metadata: what prompted this diagram
  run <file.tldr>                load, run a snippet, save, export
      --code <path>              JavaScript file, or - to read stdin
      --eval <source>            inline source (mutually exclusive with --code)
      --shot <out.png>           write a PNG after the snippet
      --svg <out.svg>            write an SVG after the snippet
      --create                   start from an empty document if the file is missing
      --no-save                  run and export, leave the document untouched
      --no-subset-fonts          inline whole fonts in the SVG, not just the glyphs used
  shot <file.tldr>               screenshot without running anything
      -o, --output <out.png>     where the PNG goes (default: a temp file)
      --ids a,b,c                frame only these shapes
  inspect <file.tldr>            print every shape, binding, lint and the metadata. Exits 3 on lints
  list [dir]                     every .tldr in a directory (default learn/assets), no browser
  meta set <file.tldr>           stamp metadata on an existing document, no browser
      --title <text>             a human title
      --topic <slug>             one vocabulary slug
      --concept <slug>           a concept slug, repeatable
      --source <text>            what prompted this diagram
  export <file.tldr>             write the files that get committed
      --svg <out.svg>            self-contained SVG, fonts inlined and subset to the glyphs used
      --png <out.png>            PNG at --pixel-ratio
      --ids a,b,c                frame only these shapes
      --no-subset-fonts          inline whole fonts instead, for an SVG to be hand edited
  from-mermaid <file.tldr>       build a document from a mermaid flowchart
      --source <path.mmd>        the flowchart, or - to read stdin
      --append                   add to an existing document instead of refusing
      --shot <out.png>           write a PNG afterwards
  serve <file.tldr>              mirror the document in a real browser tab until Ctrl+C
      --port <n>                 port to listen on (default 7240, a free one if taken)
      --no-open                  print the URL instead of opening a browser
  api                            what a snippet can call, from the helpers' own JSDoc
  doctor                         check node, the page bundle, Chromium and the page
  help                           this text

${plannedSection()}Global options
  --json                         print one JSON object and nothing else
  --headed                       show the Chromium window (debugging)
  --quiet                        suppress the human summary
  --allow-lints                  turn exit code 3 into 0
  --chromium <path>              Chromium or Chrome executable to use
  --timeout <ms>                 cap on the exec step (default 30000)
  --page <name>                  operate on a named page
  --padding <px>                 export padding (default 32)
  --pixel-ratio <n>              PNG resolution multiplier (default 2)

Environment
  TLDRAWKC_CHROMIUM              path to a Chromium or Chrome executable
  TLDRAWKC_TIMEOUT_MS            default for --timeout
  TLDRAWKC_HEADED                1 to default --headed on

Exit codes
  0 done   1 usage or environment   2 snippet threw   3 lints remain   4 export failed`;

/**
 * One line of untrusted text, safe to write to a terminal.
 *
 * A declined mermaid statement is echoed back so the author can see what was
 * dropped, and a `.mmd` is a file the tool did not write. A line carrying an
 * escape sequence would otherwise clear the screen or repaint what is already
 * there, so every C0 and C1 control character becomes its escaped form. The
 * `--json` output is untouched: a consumer parsing JSON wants the bytes that
 * were in the file.
 */
function printable(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, (character) => {
    const code = character.codePointAt(0) ?? 0;
    return `\\x${code.toString(16).padStart(2, "0")}`;
  });
}

function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function printDoctor(report: DoctorReport): void {
  const mark = { pass: "ok  ", warn: "warn", fail: "FAIL" } as const;
  for (const check of report.checks) {
    out(`${mark[check.status]}  ${check.name.padEnd(12)} ${check.detail}`);
  }
  out(report.ok ? "doctor: ready" : "doctor: not ready");
}

/**
 * One line per lint, the format `run` and `inspect` share.
 *
 * The first column is the severity, so a warning that does not change the
 * exit code does not read like one that does.
 */
function printLints(lints: Lint[]): void {
  for (const lint of lints) {
    const ids = lint.shapeIds.length > 0 ? ` [${lint.shapeIds.join(", ")}]` : "";
    const tag = severityOf(lint) === "warn" ? "warn" : "lint";
    out(`${tag}  ${lint.rule}${ids}  ${lint.message}`);
  }
}

/** `topic=x  concepts=a,b  "title"`, or nothing when there is no metadata. */
function metaLine(meta: DiagramMeta | null): string {
  if (meta === null) return "meta  (none)";
  const parts = [`topic=${meta.topic === "" ? "(none)" : meta.topic}`];
  if (meta.concepts.length > 0) parts.push(`concepts=${meta.concepts.join(",")}`);
  if (meta.source !== "") parts.push(`source=${meta.source}`);
  if (meta.created !== "") parts.push(meta.created);
  if (meta.title !== "") parts.push(JSON.stringify(meta.title));
  return `meta  ${parts.join("  ")}`;
}

function printRun(result: RunResult, allowLints: boolean): void {
  const lints = result.lints.length;
  out(
    `${String(result.shapeCount)} shapes, ${String(lints)} lint${lints === 1 ? "" : "s"}, ${String(result.ms)} ms`,
  );
  out(result.saved ? `saved ${result.file}` : `not saved (--no-save) ${result.file}`);
  if (result.shot) out(`shot  ${result.shot}`);
  if (result.svg) {
    out(`svg   ${result.svg}${sizeNote(result.svgBytes, result.svgFontsSubset)}`);
  }
  printFontWarnings(result.svgFontWarnings);
  printLints(result.lints);
  if (lints > 0 && allowLints) out("lints allowed (--allow-lints), exiting 0");
}

async function runDoctor(globals: GlobalOptions): Promise<number> {
  const report = await doctor({ chromium: globals.chromium, headed: globals.headed });
  if (globals.json) printJson(report);
  else if (!globals.quiet) printDoctor(report);
  return report.ok ? EXIT.ok : EXIT.usage;
}

function runHelp(globals: GlobalOptions): number {
  if (globals.json) {
    printJson({
      usage: "tldrawkc <command> [file] [options]",
      commands: [...IMPLEMENTED_COMMANDS],
      planned: PLANNED_COMMANDS,
    });
  } else {
    out(USAGE);
  }
  return EXIT.ok;
}

/**
 * Read the whole of stdin, for `run --code -`.
 *
 * The point of `-` is that an agent can heredoc a snippet straight into the
 * command without leaving a file behind.
 */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString("utf8");
}

async function runRun(
  file: string,
  globals: GlobalOptions,
  options: CommandOptions,
): Promise<number> {
  // `-` is a process-level convention, so it is resolved here rather than in
  // the library, which only ever sees a path or a source string.
  const fromStdin = options.code === "-";
  const result = await run({
    file,
    code: fromStdin ? undefined : options.code,
    evalSource: fromStdin ? await readStdin() : options.evalSource,
    shot: options.shot,
    svg: options.svg,
    subsetFonts: options.subsetFonts,
    create: options.create,
    save: options.save,
    allowLints: globals.allowLints,
    page: globals.page,
    padding: globals.padding,
    pixelRatio: globals.pixelRatio,
    timeoutMs: globals.timeoutMs,
    chromium: globals.chromium,
    headed: globals.headed,
  });

  if (globals.json) {
    // The object CLI.md specifies, in that order, plus two additive fields.
    // `svg` stays the path string it has always been, because a consumer
    // reading it should not have to change; the size and whether the fonts
    // were subset ride alongside it rather than turning it into an object.
    printJson({
      file: result.file,
      result: result.result,
      shapeCount: result.shapeCount,
      lints: result.lints,
      shot: result.shot,
      svg: result.svg,
      svgBytes: result.svgBytes,
      svgFontsSubset: result.svgFontsSubset,
      ms: result.ms,
    });
  } else if (!globals.quiet) {
    printRun(result, globals.allowLints);
  }
  return result.exitCode;
}

async function runShot(
  file: string,
  globals: GlobalOptions,
  options: CommandOptions,
): Promise<number> {
  const result = await shot({
    file,
    output: options.output,
    ids: options.ids,
    page: globals.page,
    padding: globals.padding,
    pixelRatio: globals.pixelRatio,
    chromium: globals.chromium,
    headed: globals.headed,
  });

  if (globals.json) printJson(result);
  else if (!globals.quiet) {
    out(result.shot);
    out(`${String(result.width)}x${String(result.height)} px, ${String(result.ms)} ms`);
  }
  return EXIT.ok;
}

async function runNew(
  file: string,
  globals: GlobalOptions,
  options: CommandOptions,
): Promise<number> {
  const result = await newDocument({
    file,
    from: options.from,
    meta: metaPatch(options),
    chromium: globals.chromium,
    headed: globals.headed,
  });

  if (globals.json) printJson(result);
  else if (!globals.quiet) {
    out(result.file);
    if (result.meta) out(metaLine(result.meta));
  }
  return EXIT.ok;
}

/** The flags `new` and `meta set` share, as the patch the library takes. */
function metaPatch(options: CommandOptions): MetaPatch {
  return {
    title: options.title,
    topic: options.topic,
    concepts: options.concepts,
    // `--source` is free text here. `from-mermaid` reads the same flag as a
    // path, and the two never reach the same command.
    source: options.source,
  };
}

/**
 * A fixed-width table of a directory of diagrams.
 *
 * Topic first, because that is the question the command exists to answer, and
 * `(none)` rather than a blank so a missing one is visible in a column of
 * present ones.
 */
function printList(result: ListResult): void {
  const rows = result.diagrams.map((entry) => ({
    topic: entry.meta?.topic === undefined || entry.meta.topic === ""
      ? "(none)"
      : entry.meta.topic,
    shapes: String(entry.shapes),
    svg: entry.svg.exists ? "yes" : "no",
    path: entry.relative,
  }));
  const width = (pick: (row: (typeof rows)[number]) => string, header: string): number =>
    Math.max(header.length, ...rows.map((row) => pick(row).length), 0);
  const topicWidth = width((row) => row.topic, "topic");
  const shapeWidth = width((row) => row.shapes, "shapes");

  out(`${"topic".padEnd(topicWidth)}  ${"shapes".padStart(shapeWidth)}  svg  path`);
  for (const row of rows) {
    out(
      `${row.topic.padEnd(topicWidth)}  ${row.shapes.padStart(shapeWidth)}  ` +
        `${row.svg.padEnd(3)}  ${row.path}`,
    );
  }
  for (const error of result.errors) {
    process.stderr.write(`error  ${error.relative}  ${printable(error.message)}\n`);
  }

  const tagged = result.diagrams.filter((entry) => (entry.meta?.topic ?? "") !== "").length;
  const total = result.diagrams.length;
  out(
    `${String(total)} diagram${total === 1 ? "" : "s"}, ${String(tagged)} with a topic, ` +
      `${String(result.errors.length)} unreadable`,
  );
}

async function runList(
  dir: string | undefined,
  globals: GlobalOptions,
): Promise<number> {
  const result = await list({ dir });
  if (globals.json) {
    printJson({
      dir: result.dir,
      diagrams: result.diagrams,
      errors: result.errors,
      ms: result.ms,
    });
  } else if (!globals.quiet) {
    printList(result);
  }
  // A file that will not parse is data, not a failure of the command: the
  // caller asked what is in the directory and got a complete answer.
  return EXIT.ok;
}

function printMetaSet(result: SetMetaResult): void {
  out(result.changed ? `wrote ${result.file}` : `unchanged ${result.file}`);
  out(metaLine(result.meta));
}

async function runMeta(
  args: string[],
  globals: GlobalOptions,
  options: CommandOptions,
): Promise<number> {
  // parseCommand has already refused any other subcommand.
  const file = args[1] ?? "";
  const result = await setMeta({ file, patch: metaPatch(options) });
  if (globals.json) printJson(result);
  else if (!globals.quiet) printMetaSet(result);
  return EXIT.ok;
}

/**
 * One line per shape, in the format CLI.md specifies:
 * `shape:id  geo  x,y  w x h  "text"`.
 *
 * Coordinates are rounded because a canvas position is a float and nobody is
 * reading the sixth decimal place of a box's y. The `.tldr` keeps the exact
 * value; this is the view.
 */
function printInspect(canvas: InspectData): void {
  const counts =
    `${String(canvas.shapes.length)} shapes, ` +
    `${String(canvas.bindings.length)} bindings, ` +
    `${String(canvas.lints.length)} lint${canvas.lints.length === 1 ? "" : "s"}`;
  out(`page  ${canvas.page}  (${String(canvas.pages.length)} in the document)  ${counts}`);

  for (const shape of canvas.shapes) {
    const kind = shape.geo ?? shape.type;
    const position = `${String(Math.round(shape.x))},${String(Math.round(shape.y))}`;
    const size = `${String(Math.round(shape.w))} x ${String(Math.round(shape.h))}`;
    const label = shape.text === null ? "" : `  ${JSON.stringify(shape.text)}`;
    out(`${shape.id}  ${kind}  ${position}  ${size}${label}`);
  }

  for (const binding of canvas.bindings) {
    out(`bind  ${binding.arrow}  ${binding.from ?? "?"} -> ${binding.to ?? "?"}`);
  }

  out(metaLine(canvas.meta ?? null));
  printLints(canvas.lints);
}

async function runInspect(file: string, globals: GlobalOptions): Promise<number> {
  const result = await inspect({
    file,
    page: globals.page,
    allowLints: globals.allowLints,
    chromium: globals.chromium,
    headed: globals.headed,
  });

  // The bridge structure, printed exactly as ARCHITECTURE.md defines it. A
  // wrapper object here would make every consumer unwrap one level to get at
  // the shape the design document already named.
  if (globals.json) printJson(result.canvas);
  else if (!globals.quiet) printInspect(result.canvas);
  return result.exitCode;
}

/**
 * `  12.4 kB, fonts subset`, or nothing when no SVG was written.
 *
 * The size is on the human line because it is the number a caller is about to
 * commit, and "fonts subset" is there so a surprisingly large file says why in
 * the same breath.
 */
function sizeNote(bytes: number | null, fontsSubset: boolean | null): string {
  if (bytes === null) return "";
  const kb = (bytes / 1000).toFixed(1);
  return `  ${kb} kB${fontsSubset === true ? ", fonts subset" : ""}`;
}

/** A face that kept its full payload. Never an error: the picture is fine. */
function printFontWarnings(warnings: readonly string[]): void {
  for (const warning of warnings) out(`warn  font  ${warning}`);
}

function printExport(result: ExportResult): void {
  if (result.svg) {
    out(
      `svg   ${result.svg.path}  ${String(result.svg.width)}x${String(result.svg.height)}` +
        sizeNote(result.svg.bytes, result.svg.fontsSubset),
    );
  }
  if (result.png) {
    out(`png   ${result.png.path}  ${String(result.png.width)}x${String(result.png.height)}`);
  }
  if (result.svg) printFontWarnings(result.svg.fontWarnings);
}

async function runExport(
  file: string,
  globals: GlobalOptions,
  options: CommandOptions,
): Promise<number> {
  const result = await exportCanvas({
    file,
    svg: options.svg,
    png: options.png,
    subsetFonts: options.subsetFonts,
    ids: options.ids,
    page: globals.page,
    padding: globals.padding,
    pixelRatio: globals.pixelRatio,
    chromium: globals.chromium,
    headed: globals.headed,
  });

  if (globals.json) {
    printJson({ file: result.file, svg: result.svg, png: result.png, ms: result.ms });
  } else if (!globals.quiet) {
    printExport(result);
  }
  return result.exitCode;
}

function printFromMermaid(result: FromMermaidResult, allowLints: boolean): void {
  const nodes = Object.keys(result.nodes).length;
  const containers = result.containers.length;
  out(
    `${String(nodes)} node${nodes === 1 ? "" : "s"}, ` +
      `${String(result.edges.length)} edge${result.edges.length === 1 ? "" : "s"}, ` +
      `${String(containers)} container${containers === 1 ? "" : "s"}, ` +
      `${String(result.shapeCount)} shapes, ${String(result.ms)} ms`,
  );
  out(`saved ${result.file}`);
  if (result.shot) out(`shot  ${result.shot}`);
  printLints(result.lints);
  if (result.lints.length > 0 && allowLints) out("lints allowed (--allow-lints), exiting 0");
}

async function runFromMermaid(
  file: string,
  globals: GlobalOptions,
  options: CommandOptions,
): Promise<number> {
  if (options.source === undefined) {
    throw new UsageError("from-mermaid needs --source <path.mmd>, or --source - for stdin.");
  }
  const source = options.source === "-" ? await readStdin() : await readSourceFile(options.source);

  const result = await fromMermaid({
    file,
    source,
    append: options.append,
    shot: options.shot,
    allowLints: globals.allowLints,
    page: globals.page,
    padding: globals.padding,
    pixelRatio: globals.pixelRatio,
    timeoutMs: globals.timeoutMs,
    chromium: globals.chromium,
    headed: globals.headed,
  });

  if (globals.json) {
    printJson({
      file: result.file,
      nodes: result.nodes,
      edges: result.edges,
      containers: result.containers,
      unsupported: result.unsupported,
      shapeCount: result.shapeCount,
      lints: result.lints,
      shot: result.shot,
      ms: result.ms,
    });
  } else if (!globals.quiet) {
    printFromMermaid(result, globals.allowLints);
    // On stderr, so a human sees it next to the summary and `--json` still
    // prints exactly one object on stdout. Never dropped: a diagram that
    // silently lost three statements looks finished and is not.
    for (const line of result.unsupported) {
      process.stderr.write(`unsupported: ${printable(line)}\n`);
    }
  }
  return result.exitCode;
}

/** Read a `--source` path, with a usage error rather than a stack on ENOENT. */
async function readSourceFile(input: string): Promise<string> {
  const target = resolveOutputPath(input);
  const text = await readText(target);
  if (text === null) throw new UsageError(`--source ${target} does not exist.`);
  return text;
}

/**
 * The one line a human sees while `serve` is running.
 *
 * The URL first, because it is the thing to click or paste. A port fallback is
 * on the same line and only when it happened: a tab bookmarked on 7240 that
 * opens on 51234 today should say why without a second line of output for
 * every normal run.
 */
function serveLine(handle: ServeHandle): string {
  const fallback = handle.fellBackFrom === null
    ? ""
    : `  (port ${String(handle.fellBackFrom)} was taken)`;
  return `${handle.url}${fallback}  Ctrl+C to stop`;
}

/**
 * Resolve on the first SIGINT or SIGTERM.
 *
 * Layering rule 7's other half: `serve` is the long-lived command, so
 * something has to hold the process open and then let go. Installing a
 * listener is also what stops Node's default SIGINT handling from killing the
 * process before the server is closed.
 */
function untilSignal(): Promise<NodeJS.Signals> {
  return new Promise((resolve) => {
    const onSignal = (signal: NodeJS.Signals): void => {
      process.removeListener("SIGINT", onSignal);
      process.removeListener("SIGTERM", onSignal);
      resolve(signal);
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
  });
}

async function runServe(
  file: string,
  globals: GlobalOptions,
  options: CommandOptions,
): Promise<number> {
  const handle = await serve({
    file,
    port: options.port,
    open: options.open,
    // Printed from the ready hook rather than after the await, so the URL is
    // on stdout before the browser window opens over the terminal.
    onReady: (ready) => {
      if (globals.json) printJson({ url: ready.url, port: ready.port, file: ready.file });
      else if (!globals.quiet) out(serveLine(ready));
    },
  });

  await untilSignal();
  await handle.close();
  return EXIT.ok;
}

/** One block per helper: the signature, the summary, then each example. */
function printApi(docs: HelperDoc[]): void {
  docs.forEach((doc, index) => {
    if (index > 0) out("");
    out(doc.signature);
    if (doc.summary) out(`  ${doc.summary}`);
    for (const param of doc.params) out(`  @param ${param}`);
    for (const example of doc.examples) {
      for (const line of example.split("\n")) out(`  ${line}`);
    }
  });
}

async function runApi(globals: GlobalOptions): Promise<number> {
  const docs = await readApiReference();
  if (globals.json) printJson(docs);
  else if (!globals.quiet) printApi(docs);
  return EXIT.ok;
}

async function main(): Promise<number> {
  const result = parseCommand(process.argv.slice(2));
  if (!result.ok) throw new UsageError(`${result.error}\nRun "tldrawkc help" for usage.`);

  const { command, args, globals, options } = result.parsed;
  // parseCommand has already refused a command with no file, so this is only
  // narrowing for the type checker.
  const file = args[0] ?? "";

  switch (command) {
    case "doctor":
      return await runDoctor(globals);
    case "help":
      return runHelp(globals);
    case "run":
      return await runRun(file, globals, options);
    case "shot":
      return await runShot(file, globals, options);
    case "new":
      return await runNew(file, globals, options);
    case "inspect":
      return await runInspect(file, globals);
    case "list":
      return await runList(args[0], globals);
    case "meta":
      return await runMeta(args, globals, options);
    case "export":
      return await runExport(file, globals, options);
    case "from-mermaid":
      return await runFromMermaid(file, globals, options);
    case "serve":
      return await runServe(file, globals, options);
    case "api":
      return await runApi(globals);
    default:
      // parseCommand has already rejected everything else; this arm exists so
      // adding a command to IMPLEMENTED_COMMANDS without wiring it here is
      // loud rather than silent.
      throw new UsageError(`command "${command}" is known but not wired up.`);
  }
}

// `tldrawkc api | head` closes the pipe while the reference is still being
// written, and an unhandled EPIPE on stdout crashes with a Node stack trace
// instead of stopping quietly. Piping into `head`, `grep -m` or `less` is
// exactly how an agent reads a long listing, so swallow it and let the shell's
// own convention (the reader went away, so stop) stand.
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code !== "EPIPE") throw error;
  });
}

try {
  process.exitCode = await main();
} catch (error: unknown) {
  if (isTldrawkcError(error)) {
    process.stderr.write(`tldrawkc: ${error.message}\n`);
    // The snippet's own stack points at the snippet's own lines, which is the
    // only way to find the offending one in source that never touched disk.
    if (error instanceof SnippetError && error.snippetStack) {
      process.stderr.write(`${error.snippetStack}\n`);
    }
    process.exitCode = error.exitCode;
  } else {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`tldrawkc: ${message}\n`);
    process.exitCode = EXIT.usage;
  }
}
