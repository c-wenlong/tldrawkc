/**
 * Argument parsing, kept pure so it can be unit tested without a process.
 *
 * One `parseArgs` options object, the first positional dispatches, every
 * command takes `--json`. That is the shape `scripts/learn/cli.mjs` uses in
 * the self-learn repo, and matching it means one set of habits covers both
 * tools.
 *
 * `parseCommand` never prints, never exits and never throws: it returns
 * either a parsed command or an error string for `index.ts` to print.
 */

import { parseArgs } from "node:util";

/** Exit codes. The table in CLI.md is the contract; this is that table. */
export const EXIT = {
  /** Done, no lints. */
  ok: 0,
  /** Bad arguments, missing file, environment failure. */
  usage: 1,
  /** The snippet threw. Nothing was written. */
  snippet: 2,
  /** Done and saved, but lints remain. */
  lints: 3,
  /** Export failed after a successful save. */
  export: 4,
} as const;

/**
 * The global option table from CLI.md.
 *
 * Command-specific flags (`--code`, `--shot`, `--source`, `--port` and the
 * rest) are deliberately absent until the commands that own them exist: a
 * strict parser that accepts a flag nothing reads would be lying about what
 * the tool does.
 */
export const GLOBAL_OPTIONS = {
  json: { type: "boolean" },
  headed: { type: "boolean" },
  quiet: { type: "boolean" },
  "allow-lints": { type: "boolean" },
  chromium: { type: "string" },
  timeout: { type: "string" },
  page: { type: "string" },
  padding: { type: "string" },
  "pixel-ratio": { type: "string" },
} as const;

/** Defaults for the numeric globals, from the "numbers" table in ARCHITECTURE.md. */
export const DEFAULTS = {
  timeoutMs: 30_000,
  padding: 32,
  pixelRatio: 2,
} as const;

export interface GlobalOptions {
  json: boolean;
  headed: boolean;
  quiet: boolean;
  allowLints: boolean;
  chromium: string | undefined;
  timeoutMs: number;
  page: string | undefined;
  padding: number;
  pixelRatio: number;
}

export interface ParsedCommand {
  /** The first positional, or `help` when there is none. */
  command: string;
  /** Every positional after the command, in order. */
  args: string[];
  globals: GlobalOptions;
}

export type ParseResult =
  | { ok: true; parsed: ParsedCommand }
  | { ok: false; error: string };

/** Commands `doctor`, `help` and friends: what this build actually runs. */
export const IMPLEMENTED_COMMANDS = ["doctor", "help"] as const;

/**
 * Commands CLI.md specifies but this phase does not build yet, with the
 * roadmap phase that brings each one. Naming them gives a caller a real
 * answer instead of "unknown command".
 */
export const PLANNED_COMMANDS: Record<string, string> = {
  new: "phase 1",
  run: "phase 1",
  shot: "phase 1",
  inspect: "phase 2",
  export: "phase 2",
  "from-mermaid": "phase 2",
  api: "phase 2",
  serve: "phase 4",
};

/**
 * Parse a raw argv tail (everything after `node script`).
 *
 * `env` is a parameter rather than a global read so the environment defaults
 * in CLI.md (`TLDRAWKC_TIMEOUT_MS`, `TLDRAWKC_HEADED`) can be tested.
 */
export function parseCommand(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): ParseResult {
  let values: Record<string, unknown>;
  let positionals: string[];
  try {
    const parsed = parseArgs({
      args: [...argv],
      options: GLOBAL_OPTIONS,
      allowPositionals: true,
      strict: true,
    });
    values = parsed.values;
    positionals = parsed.positionals;
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }

  const timeout = numberOption(
    values["timeout"] as string | undefined,
    "--timeout",
    numberFromEnv(env["TLDRAWKC_TIMEOUT_MS"]) ?? DEFAULTS.timeoutMs,
  );
  if (!timeout.ok) return timeout;

  const padding = numberOption(values["padding"] as string | undefined, "--padding", DEFAULTS.padding);
  if (!padding.ok) return padding;

  const pixelRatio = numberOption(
    values["pixel-ratio"] as string | undefined,
    "--pixel-ratio",
    DEFAULTS.pixelRatio,
  );
  if (!pixelRatio.ok) return pixelRatio;

  const command = positionals[0] ?? "help";
  if (!isKnownCommand(command)) {
    return { ok: false, error: `unknown command "${command}".` };
  }
  const planned = PLANNED_COMMANDS[command];
  if (planned) {
    return { ok: false, error: `"${command}" is specified but not built yet (${planned}).` };
  }

  return {
    ok: true,
    parsed: {
      command,
      args: positionals.slice(1),
      globals: {
        json: values["json"] === true,
        headed: values["headed"] === true || truthyEnv(env["TLDRAWKC_HEADED"]),
        quiet: values["quiet"] === true,
        allowLints: values["allow-lints"] === true,
        chromium: (values["chromium"] as string | undefined) ?? undefined,
        timeoutMs: timeout.value,
        page: (values["page"] as string | undefined) ?? undefined,
        padding: padding.value,
        pixelRatio: pixelRatio.value,
      },
    },
  };
}

function isKnownCommand(command: string): boolean {
  return (
    (IMPLEMENTED_COMMANDS as readonly string[]).includes(command) ||
    Object.hasOwn(PLANNED_COMMANDS, command)
  );
}

type NumberResult = { ok: true; value: number } | { ok: false; error: string };

/** A numeric flag has to be a finite, non-negative number or it is a usage error. */
function numberOption(raw: string | undefined, flag: string, fallback: number): NumberResult {
  if (raw === undefined) return { ok: true, value: fallback };
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    return { ok: false, error: `${flag} expects a non-negative number, got "${raw}".` };
  }
  return { ok: true, value };
}

function numberFromEnv(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function truthyEnv(raw: string | undefined): boolean {
  if (!raw) return false;
  return ["1", "true", "yes", "y", "on"].includes(raw.toLowerCase());
}
