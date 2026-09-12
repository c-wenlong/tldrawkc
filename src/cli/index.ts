#!/usr/bin/env node
/**
 * `tldrawkc`: draw a diagram on a real tldraw canvas, look at it, fix it.
 *
 *   tldrawkc doctor                is this machine able to run the tool
 *   tldrawkc help                  usage for every command
 *
 * Layering rule 3: this is the only module that prints. Everything under
 * `src/lib/` returns data, which is why `--json` and the human summary can
 * come from the same call.
 *
 * The commands in CLI.md that are not here yet are refused by name with the
 * phase that brings them, rather than falling through to "unknown command".
 */

import process from "node:process";

import { doctor, type DoctorReport } from "../lib/doctor.js";
import {
  EXIT,
  IMPLEMENTED_COMMANDS,
  PLANNED_COMMANDS,
  parseCommand,
  type GlobalOptions,
} from "./args.js";

const USAGE = `tldrawkc <command> [file] [options]

Commands
  doctor                         check node, the page bundle and Chromium
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

/**
 * A message for stderr and an exit code, thrown rather than exited.
 *
 * `process.exit` truncates: when stdout or stderr is a pipe, Node's writes are
 * asynchronous, and exiting mid-flush drops whatever is still buffered. So
 * nothing here calls it. Every path sets `process.exitCode` and returns, and
 * the process ends when the event loop drains, by which point the output has
 * been written.
 */
class CliError extends Error {
  readonly code: number;
  constructor(message: string, code: number = EXIT.usage) {
    super(message);
    this.name = "CliError";
    this.code = code;
  }
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

async function main(): Promise<number> {
  const result = parseCommand(process.argv.slice(2));
  if (!result.ok) throw new CliError(`${result.error}\nRun "tldrawkc help" for usage.`);

  const { command, globals } = result.parsed;
  switch (command) {
    case "doctor":
      return await runDoctor(globals);
    case "help":
      return runHelp(globals);
    default:
      // parseCommand has already rejected everything else; this arm exists so
      // adding a command to IMPLEMENTED_COMMANDS without wiring it here is
      // loud rather than silent.
      throw new CliError(`command "${command}" is known but not wired up.`);
  }
}

try {
  process.exitCode = await main();
} catch (error: unknown) {
  const message = error instanceof CliError
    ? error.message
    : error instanceof Error
      ? (error.stack ?? error.message)
      : String(error);
  process.stderr.write(`tldrawkc: ${message}\n`);
  process.exitCode = error instanceof CliError ? error.code : EXIT.usage;
}
