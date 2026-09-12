#!/usr/bin/env node
/**
 * `tldrawkc`: draw a diagram on a real tldraw canvas, look at it, fix it.
 *
 *   tldrawkc new <file.tldr>          an empty document
 *   tldrawkc run <file.tldr> ...      load, run a snippet, save, export
 *   tldrawkc shot <file.tldr>         a PNG of what is there
 *   tldrawkc inspect <file.tldr>      what is on the canvas, as text or JSON
 *   tldrawkc export <file.tldr> ...   the SVG or PNG that gets committed
 *   tldrawkc from-mermaid <file.tldr> lift a mermaid flowchart onto the canvas
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
import { doctor, type DoctorReport } from "../lib/doctor.js";
import { isTldrawkcError, SnippetError, UsageError } from "../lib/errors.js";
import { readText } from "../lib/files.js";
import { resolveOutputPath } from "../lib/paths.js";
import type { InspectData, Lint } from "../lib/browser.js";
import {
  EXIT,
  IMPLEMENTED_COMMANDS,
  PLANNED_COMMANDS,
  parseCommand,
  type CommandOptions,
  type GlobalOptions,
} from "./args.js";

const USAGE = `tldrawkc <command> [file] [options]

Commands
  new <file.tldr>                create an empty document, refuses to overwrite
      --from <other.tldr>        start from a copy of another document
  run <file.tldr>                load, run a snippet, save, export
      --code <path>              JavaScript file, or - to read stdin
      --eval <source>            inline source (mutually exclusive with --code)
      --shot <out.png>           write a PNG after the snippet
      --svg <out.svg>            write an SVG after the snippet
      --create                   start from an empty document if the file is missing
      --no-save                  run and export, leave the document untouched
  shot <file.tldr>               screenshot without running anything
      -o, --output <out.png>     where the PNG goes (default: a temp file)
      --ids a,b,c                frame only these shapes
  inspect <file.tldr>            print every shape, binding and lint. Exits 3 on lints
  export <file.tldr>             write the files that get committed
      --svg <out.svg>            self-contained SVG, fonts inlined
      --png <out.png>            PNG at --pixel-ratio
      --ids a,b,c                frame only these shapes
  from-mermaid <file.tldr>       build a document from a mermaid flowchart
      --source <path.mmd>        the flowchart, or - to read stdin
      --append                   add to an existing document instead of refusing
      --shot <out.png>           write a PNG afterwards
  api                            what a snippet can call, from the helpers' own JSDoc
  doctor                         check node, the page bundle, Chromium and the page
  help                           this text

Planned (specified in CLI.md, not built yet)
${Object.entries(PLANNED_COMMANDS)
  .map(([name, phase]) => `  ${name.padEnd(30)} ${phase}`)
  .join("\n")}

Global options
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

/** One line per lint, the format `run` and (from phase 2) `inspect` share. */
function printLints(lints: Lint[]): void {
  for (const lint of lints) {
    const ids = lint.shapeIds.length > 0 ? ` [${lint.shapeIds.join(", ")}]` : "";
    out(`lint  ${lint.rule}${ids}  ${lint.message}`);
  }
}

function printRun(result: RunResult, allowLints: boolean): void {
  const lints = result.lints.length;
  out(
    `${String(result.shapeCount)} shapes, ${String(lints)} lint${lints === 1 ? "" : "s"}, ${String(result.ms)} ms`,
  );
  out(result.saved ? `saved ${result.file}` : `not saved (--no-save) ${result.file}`);
  if (result.shot) out(`shot  ${result.shot}`);
  if (result.svg) out(`svg   ${result.svg}`);
  printLints(result.lints);
  if (lints > 0 && allowLints) out("lints allowed (--allow-lints), exiting 0");
}

async function runDoctor(globals: GlobalOptions): Promise<number> {
  const report = await doctor({ chromium: globals.chromium });
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
    // Exactly the object CLI.md specifies, in that order.
    printJson({
      file: result.file,
      result: result.result,
      shapeCount: result.shapeCount,
      lints: result.lints,
      shot: result.shot,
      svg: result.svg,
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
    chromium: globals.chromium,
    headed: globals.headed,
  });

  if (globals.json) printJson(result);
  else if (!globals.quiet) out(result.file);
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

function printExport(result: ExportResult): void {
  if (result.svg) {
    out(`svg   ${result.svg.path}  ${String(result.svg.width)}x${String(result.svg.height)}`);
  }
  if (result.png) {
    out(`png   ${result.png.path}  ${String(result.png.width)}x${String(result.png.height)}`);
  }
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
    case "export":
      return await runExport(file, globals, options);
    case "from-mermaid":
      return await runFromMermaid(file, globals, options);
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
