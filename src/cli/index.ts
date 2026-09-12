#!/usr/bin/env node
/**
 * `tldrawkc`: draw a diagram on a real tldraw canvas, look at it, fix it.
 *
 *   tldrawkc new <file.tldr>       an empty document
 *   tldrawkc run <file.tldr> ...   load, run a snippet, save, export
 *   tldrawkc shot <file.tldr>      a PNG of what is there
 *   tldrawkc doctor                is this machine able to run the tool
 *   tldrawkc help                  usage for every command
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

import { run, shot, newDocument, type RunResult } from "../lib/canvas.js";
import { doctor, type DoctorReport } from "../lib/doctor.js";
import { isTldrawkcError, SnippetError, UsageError } from "../lib/errors.js";
import type { Lint } from "../lib/browser.js";
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
      --svg <out.svg>            write an SVG after the snippet (phase 2)
      --create                   start from an empty document if the file is missing
      --no-save                  run and export, leave the document untouched
  shot <file.tldr>               screenshot without running anything
      -o, --output <out.png>     where the PNG goes (default: a temp file)
      --ids a,b,c                frame only these shapes
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
    default:
      // parseCommand has already rejected everything else; this arm exists so
      // adding a command to IMPLEMENTED_COMMANDS without wiring it here is
      // loud rather than silent.
      throw new UsageError(`command "${command}" is known but not wired up.`);
  }
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
