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
 *
 * Command-specific flags are declared per command and merged into one table
 * for the parse, then checked against the command that was actually named.
 * `parseArgs` has to know every flag up front, but `tldrawkc doctor --shot x`
 * should still be an error rather than a silently ignored flag, so the
 * allowlist runs afterwards on the tokens the parse reports.
 */

import { parseArgs, type ParseArgsConfig } from "node:util";

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

type OptionsConfig = NonNullable<ParseArgsConfig["options"]>;

/** The global option table from CLI.md. Every command accepts these. */
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
} as const satisfies OptionsConfig;

/**
 * Flags each command owns, from the command table in CLI.md.
 *
 * A flag lives here rather than in the global table when passing it to
 * another command would be meaningless: `--create` says nothing about `shot`,
 * and accepting it there would be the tool pretending to understand.
 */
export const COMMAND_OPTIONS = {
  run: {
    code: { type: "string" },
    eval: { type: "string" },
    shot: { type: "string" },
    svg: { type: "string" },
    create: { type: "boolean" },
    "no-save": { type: "boolean" },
  },
  shot: {
    output: { type: "string", short: "o" },
    ids: { type: "string" },
  },
  new: {
    from: { type: "string" },
  },
} as const satisfies Record<string, OptionsConfig>;

/** Every flag the parser has to recognise, which is the union of the above. */
const ALL_OPTIONS: OptionsConfig = {
  ...GLOBAL_OPTIONS,
  ...COMMAND_OPTIONS.run,
  ...COMMAND_OPTIONS.shot,
  ...COMMAND_OPTIONS.new,
};

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

/**
 * Command-specific values, all in one object.
 *
 * A discriminated union per command would be tidier to read and worse to use:
 * `index.ts` would need a cast at every branch to convince TypeScript which
 * arm it is in. Optional fields plus a per-command allowlist at parse time
 * gets the same guarantee with less ceremony.
 */
export interface CommandOptions {
  /** `run --code <path>`, or `-` for stdin. */
  code: string | undefined;
  /** `run --eval <source>`. Mutually exclusive with `code`. */
  evalSource: string | undefined;
  /** `run --shot <out.png>`. */
  shot: string | undefined;
  /** `run --svg <out.svg>`. */
  svg: string | undefined;
  /** `run --create`. */
  create: boolean;
  /** False when `run --no-save` was passed. */
  save: boolean;
  /** `shot -o <out.png>`. */
  output: string | undefined;
  /** `shot --ids a,b,c`, split and trimmed. */
  ids: string[] | undefined;
  /** `new --from <other.tldr>`. */
  from: string | undefined;
}

export interface ParsedCommand {
  /** The first positional, or `help` when there is none. */
  command: string;
  /** Every positional after the command, in order. */
  args: string[];
  globals: GlobalOptions;
  options: CommandOptions;
}

export type ParseResult =
  | { ok: true; parsed: ParsedCommand }
  | { ok: false; error: string };

/** Commands this build actually runs. */
export const IMPLEMENTED_COMMANDS = ["doctor", "help", "new", "run", "shot"] as const;

/**
 * Commands CLI.md specifies but this phase does not build yet, with the
 * roadmap phase that brings each one. Naming them gives a caller a real
 * answer instead of "unknown command".
 */
export const PLANNED_COMMANDS: Record<string, string> = {
  inspect: "phase 2",
  export: "phase 2",
  "from-mermaid": "phase 2",
  api: "phase 2",
  serve: "phase 4",
};

/** Commands that take exactly one positional, the document. */
const NEEDS_FILE = new Set(["run", "shot", "new"]);

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
  let provided: string[];
  try {
    const parsed = parseArgs({
      args: [...argv],
      options: ALL_OPTIONS,
      allowPositionals: true,
      strict: true,
      tokens: true,
    });
    values = parsed.values;
    positionals = parsed.positionals;
    provided = parsed.tokens
      .filter((token) => token.kind === "option")
      .map((token) => token.name);
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }

  const command = positionals[0] ?? "help";
  if (!isKnownCommand(command)) {
    return { ok: false, error: `unknown command "${command}".` };
  }
  const planned = PLANNED_COMMANDS[command];
  if (planned) {
    return { ok: false, error: `"${command}" is specified but not built yet (${planned}).` };
  }

  const allowed = new Set([
    ...Object.keys(GLOBAL_OPTIONS),
    ...Object.keys(optionsFor(command)),
  ]);
  for (const name of provided) {
    if (!allowed.has(name)) {
      return { ok: false, error: `--${name} is not an option of "${command}".` };
    }
  }

  // Positional arity, per command. A stray positional is almost always a
  // quoting mistake (`--eval helpers.box(...)` without quotes, say), and
  // ignoring it would run something other than what was typed.
  const args = positionals.slice(1);
  if (NEEDS_FILE.has(command)) {
    if (args.length === 0) return { ok: false, error: `"${command}" needs a <file.tldr>.` };
    if (args.length > 1) {
      return {
        ok: false,
        error: `"${command}" takes one file, got ${String(args.length)}: ${args.join(" ")}`,
      };
    }
  } else if (args.length > 0) {
    return { ok: false, error: `"${command}" takes no file, got ${args.join(" ")}.` };
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

  const code = values["code"] as string | undefined;
  const evalSource = values["eval"] as string | undefined;
  if (code !== undefined && evalSource !== undefined) {
    return { ok: false, error: "--code and --eval are mutually exclusive." };
  }

  return {
    ok: true,
    parsed: {
      command,
      args,
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
      options: {
        code,
        evalSource,
        shot: values["shot"] as string | undefined,
        svg: values["svg"] as string | undefined,
        create: values["create"] === true,
        // `--no-save` is the flag CLI.md names, so it is parsed literally and
        // inverted here. `parseArgs` has no negation of its own.
        save: values["no-save"] !== true,
        output: values["output"] as string | undefined,
        ids: splitIds(values["ids"] as string | undefined),
        from: values["from"] as string | undefined,
      },
    },
  };
}

/** The flags a given command owns, or none for a command with no flags. */
export function optionsFor(command: string): OptionsConfig {
  const table = COMMAND_OPTIONS as Record<string, OptionsConfig | undefined>;
  return table[command] ?? {};
}

function isKnownCommand(command: string): boolean {
  return (
    (IMPLEMENTED_COMMANDS as readonly string[]).includes(command) ||
    Object.hasOwn(PLANNED_COMMANDS, command)
  );
}

/** `--ids a, b ,c` to `["a","b","c"]`. Empty entries are dropped, not kept as "". */
function splitIds(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  const ids = raw
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
  return ids;
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
