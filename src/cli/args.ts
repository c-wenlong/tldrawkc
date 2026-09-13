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
 * The metadata flags, shared by `new` and `meta set`.
 *
 * One declaration spread into both, because a diagram stamped at creation and
 * a diagram stamped afterwards have to end up with the same fields, and two
 * hand-maintained lists would not stay that way.
 *
 * `--source` means different things to `from-mermaid` (a path to read from)
 * and to these two (free text: what prompted the diagram). They are different
 * commands and the allowlist below is per command, so nothing collides; the
 * help text says which is which.
 */
export const META_OPTIONS = {
  title: { type: "string" },
  topic: { type: "string" },
  concept: { type: "string", multiple: true },
  source: { type: "string" },
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
    "no-subset-fonts": { type: "boolean" },
  },
  shot: {
    output: { type: "string", short: "o" },
    ids: { type: "string" },
  },
  new: {
    from: { type: "string" },
    ...META_OPTIONS,
  },
  export: {
    svg: { type: "string" },
    png: { type: "string" },
    ids: { type: "string" },
    "no-subset-fonts": { type: "boolean" },
  },
  "from-mermaid": {
    source: { type: "string" },
    append: { type: "boolean" },
    shot: { type: "string" },
  },
  serve: {
    port: { type: "string" },
    "no-open": { type: "boolean" },
  },
  verify: {
    output: { type: "string", short: "o" },
    width: { type: "string" },
  },
  meta: META_OPTIONS,
} as const satisfies Record<string, OptionsConfig>;

/** Every flag the parser has to recognise, which is the union of the above. */
const ALL_OPTIONS: OptionsConfig = {
  ...GLOBAL_OPTIONS,
  ...COMMAND_OPTIONS.run,
  ...COMMAND_OPTIONS.shot,
  ...COMMAND_OPTIONS.new,
  ...COMMAND_OPTIONS.export,
  ...COMMAND_OPTIONS["from-mermaid"],
  ...COMMAND_OPTIONS.serve,
  ...COMMAND_OPTIONS.verify,
  ...COMMAND_OPTIONS.meta,
};

/** Defaults for the numeric globals, from the "numbers" table in ARCHITECTURE.md. */
export const DEFAULTS = {
  timeoutMs: 30_000,
  padding: 32,
  pixelRatio: 2,
  /**
   * `verify --width`, in pixels. See `DEFAULT_VERIFY_WIDTH` in
   * `src/lib/verify.ts` for why it is this number: it is sized against the
   * Read tool that looks at the PNG, not against the drawing.
   */
  verifyWidth: 1500,
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
  /**
   * False when `--no-subset-fonts` was passed to `run` or `export`.
   *
   * Default on: a committed SVG carries every glyph of every font it uses
   * otherwise, which is most of the file. Off is for a diagram somebody means
   * to edit by hand later, where a glyph the drawing does not already contain
   * has to still be there.
   */
  subsetFonts: boolean;
  /** `shot -o <out.png>`. */
  output: string | undefined;
  /** `shot --ids a,b,c`, split and trimmed. */
  ids: string[] | undefined;
  /** `new --from <other.tldr>`. */
  from: string | undefined;
  /** `export --png <out.png>`. */
  png: string | undefined;
  /** `from-mermaid --source <path.mmd>`, or `-` for stdin. */
  source: string | undefined;
  /** `from-mermaid --append`. */
  append: boolean;
  /** `--title` on `new` and `meta set`. */
  title: string | undefined;
  /** `--topic` on `new` and `meta set`. */
  topic: string | undefined;
  /** `verify --width <px>`, or the default. */
  width: number;
  /** `serve --port <n>`, or nothing for the default. */
  port: number | undefined;
  /** False when `serve --no-open` was passed. */
  open: boolean;
  /**
   * `--concept` on `new` and `meta set`, repeatable.
   *
   * Commas inside one occurrence are split too, so `--concept a,b` and
   * `--concept a --concept b` agree. A slug can never contain a comma, and the
   * rest of this CLI already takes comma lists (`--ids`).
   */
  concepts: string[] | undefined;
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
export const IMPLEMENTED_COMMANDS = [
  "api",
  "doctor",
  "export",
  "from-mermaid",
  "help",
  "inspect",
  "list",
  "meta",
  "new",
  "run",
  "serve",
  "shot",
  "verify",
] as const;

/**
 * Commands CLI.md specifies but this phase does not build yet, with the
 * roadmap phase that brings each one. Naming them gives a caller a real
 * answer instead of "unknown command".
 *
 * Empty since phase 4 built `serve`, and kept rather than deleted: the next
 * specified-but-unbuilt verb should be one line here and in the help, not a
 * new mechanism. `help` prints the section only when there is something in it.
 */
export const PLANNED_COMMANDS: Record<string, string> = {};

/**
 * How many positionals each command takes, and what to call them when it is
 * given the wrong number.
 *
 * A table rather than a set of special cases, because the arities are no
 * longer all "one file": `list` takes an optional directory and `meta` takes a
 * subcommand plus a file. A stray positional stays an error everywhere, for
 * the reason it always was: it is almost always a quoting mistake, and
 * ignoring it would run something other than what was typed.
 */
const ARITY: Record<string, { min: number; max: number; shape: string }> = {
  run: { min: 1, max: 1, shape: "<file.tldr>" },
  shot: { min: 1, max: 1, shape: "<file.tldr>" },
  new: { min: 1, max: 1, shape: "<file.tldr>" },
  inspect: { min: 1, max: 1, shape: "<file.tldr>" },
  export: { min: 1, max: 1, shape: "<file.tldr>" },
  "from-mermaid": { min: 1, max: 1, shape: "<file.tldr>" },
  serve: { min: 1, max: 1, shape: "<file.tldr>" },
  verify: { min: 1, max: 1, shape: "<file.svg>" },
  list: { min: 0, max: 1, shape: "[dir]" },
  meta: { min: 2, max: 2, shape: "set <file.tldr>" },
};

/** The subcommands `meta` understands. */
export const META_SUBCOMMANDS = ["set"] as const;

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
  const arity = ARITY[command];
  if (arity === undefined) {
    if (args.length > 0) {
      return { ok: false, error: `"${command}" takes no file, got ${args.join(" ")}.` };
    }
  } else if (args.length < arity.min) {
    return { ok: false, error: `"${command}" needs a ${arity.shape}.` };
  } else if (args.length > arity.max) {
    return {
      ok: false,
      error: arity.max === 1
        ? `"${command}" takes one file, got ${String(args.length)}: ${args.join(" ")}`
        : `"${command}" takes ${arity.shape}, got ${args.join(" ")}.`,
    };
  }
  if (command === "meta" && !(META_SUBCOMMANDS as readonly string[]).includes(args[0] ?? "")) {
    return {
      ok: false,
      error: `"meta ${args[0] ?? ""}" is not a subcommand. Try: ${META_SUBCOMMANDS.join(", ")}.`,
    };
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

  const port = portOption(values["port"] as string | undefined);
  if (!port.ok) return port;

  const width = numberOption(
    values["width"] as string | undefined,
    "--width",
    DEFAULTS.verifyWidth,
  );
  if (!width.ok) return width;
  if (width.value < 1) {
    return { ok: false, error: "--width expects at least 1 pixel." };
  }

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
        // Same inversion as `--no-save`, and for the same reason: `parseArgs`
        // has no negation, so the flag CLI.md names is parsed literally.
        subsetFonts: values["no-subset-fonts"] !== true,
        output: values["output"] as string | undefined,
        ids: splitIds(values["ids"] as string | undefined),
        from: values["from"] as string | undefined,
        png: values["png"] as string | undefined,
        source: values["source"] as string | undefined,
        append: values["append"] === true,
        title: values["title"] as string | undefined,
        topic: values["topic"] as string | undefined,
        port: port.value,
        width: width.value,
        // Same inversion as `--no-save`: `parseArgs` has no negation, so the
        // flag CLI.md names is parsed literally and flipped here.
        open: values["no-open"] !== true,
        concepts: splitRepeated(values["concept"] as string[] | undefined),
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

/**
 * A repeatable string flag to a flat list, splitting each occurrence on
 * commas. `undefined` when the flag never appeared, which is what tells a
 * patch "leave this field alone" apart from "set it to nothing".
 */
function splitRepeated(raw: string[] | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  const out: string[] = [];
  for (const entry of raw) {
    for (const part of entry.split(",")) {
      const value = part.trim();
      if (value.length > 0) out.push(value);
    }
  }
  return out;
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

type PortResult = { ok: true; value: number | undefined } | { ok: false; error: string };

/**
 * `--port`, which is stricter than the other numeric flags.
 *
 * A port is a whole number in 0 to 65535, and 0 means "any free one". A
 * fractional or out-of-range value would otherwise reach `listen`, which
 * reports it as a range error from deep inside Node rather than as the typo it
 * is. Absent stays `undefined` so the default in `server.ts` is the only place
 * that knows the number.
 */
function portOption(raw: string | undefined): PortResult {
  if (raw === undefined) return { ok: true, value: undefined };
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 65535) {
    return { ok: false, error: `--port expects a whole number from 0 to 65535, got "${raw}".` };
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
