import { describe, expect, it } from "vitest";

import { DEFAULTS, EXIT, parseCommand } from "../../src/cli/args.js";

/** No environment defaults unless a test asks for them. */
const NO_ENV: NodeJS.ProcessEnv = {};

function parse(argv: string[], env: NodeJS.ProcessEnv = NO_ENV) {
  return parseCommand(argv, env);
}

describe("dispatch", () => {
  it("takes the command from the first positional", () => {
    const result = parse(["doctor"]);
    expect(result.ok && result.parsed.command).toBe("doctor");
  });

  it("defaults to help with no arguments", () => {
    const result = parse([]);
    expect(result.ok && result.parsed.command).toBe("help");
  });

  it("keeps the file positional", () => {
    const result = parse(["shot", "diagram.tldr"]);
    expect(result.ok && result.parsed.args).toEqual(["diagram.tldr"]);
  });

  it("refuses a stray positional on a command that takes no file", () => {
    const result = parse(["doctor", "one"]);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain("takes no file");
  });

  it("refuses a second positional on a command that takes one file", () => {
    const result = parse(["run", "a.tldr", "b.tldr"]);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain("takes one file");
  });

  it("refuses a file-taking command with no file", () => {
    const result = parse(["run"]);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain("<file.tldr>");
  });

  it("rejects an unknown command", () => {
    const result = parse(["draw"]);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain('unknown command "draw"');
  });

  it("names the phase for a command that is specified but not built", () => {
    const result = parse(["inspect", "a.tldr"]);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain("phase 2");
  });

  it("rejects an unknown option", () => {
    const result = parse(["doctor", "--nope"]);
    expect(result.ok).toBe(false);
  });
});

describe("global options", () => {
  it("defaults every global", () => {
    const result = parse(["doctor"]);
    expect(result.ok && result.parsed.globals).toEqual({
      json: false,
      headed: false,
      quiet: false,
      allowLints: false,
      chromium: undefined,
      timeoutMs: DEFAULTS.timeoutMs,
      page: undefined,
      padding: DEFAULTS.padding,
      pixelRatio: DEFAULTS.pixelRatio,
    });
  });

  it("reads the boolean flags", () => {
    const result = parse(["doctor", "--json", "--headed", "--quiet", "--allow-lints"]);
    expect(result.ok && result.parsed.globals.json).toBe(true);
    expect(result.ok && result.parsed.globals.headed).toBe(true);
    expect(result.ok && result.parsed.globals.quiet).toBe(true);
    expect(result.ok && result.parsed.globals.allowLints).toBe(true);
  });

  it("reads the string and numeric flags", () => {
    const result = parse([
      "doctor",
      "--chromium",
      "/opt/chrome",
      "--page",
      "Page 2",
      "--timeout",
      "5000",
      "--padding",
      "8",
      "--pixel-ratio",
      "1",
    ]);
    expect(result.ok && result.parsed.globals.chromium).toBe("/opt/chrome");
    expect(result.ok && result.parsed.globals.page).toBe("Page 2");
    expect(result.ok && result.parsed.globals.timeoutMs).toBe(5000);
    expect(result.ok && result.parsed.globals.padding).toBe(8);
    expect(result.ok && result.parsed.globals.pixelRatio).toBe(1);
  });

  it("rejects a numeric flag that is not a number", () => {
    const result = parse(["doctor", "--timeout", "soon"]);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain("--timeout");
  });

  it("rejects a negative numeric flag", () => {
    expect(parse(["doctor", "--padding", "-1"]).ok).toBe(false);
  });
});

describe("environment defaults", () => {
  it("takes the timeout default from TLDRAWKC_TIMEOUT_MS", () => {
    const result = parse(["doctor"], { TLDRAWKC_TIMEOUT_MS: "1234" });
    expect(result.ok && result.parsed.globals.timeoutMs).toBe(1234);
  });

  it("lets --timeout win over the environment", () => {
    const result = parse(["doctor", "--timeout", "7"], { TLDRAWKC_TIMEOUT_MS: "1234" });
    expect(result.ok && result.parsed.globals.timeoutMs).toBe(7);
  });

  it("ignores an unusable TLDRAWKC_TIMEOUT_MS", () => {
    const result = parse(["doctor"], { TLDRAWKC_TIMEOUT_MS: "later" });
    expect(result.ok && result.parsed.globals.timeoutMs).toBe(DEFAULTS.timeoutMs);
  });

  it("turns --headed on from TLDRAWKC_HEADED", () => {
    expect(parse(["doctor"], { TLDRAWKC_HEADED: "1" }).ok).toBe(true);
    const result = parse(["doctor"], { TLDRAWKC_HEADED: "1" });
    expect(result.ok && result.parsed.globals.headed).toBe(true);
  });

  it("does not turn --headed on for an empty or falsey TLDRAWKC_HEADED", () => {
    const result = parse(["doctor"], { TLDRAWKC_HEADED: "0" });
    expect(result.ok && result.parsed.globals.headed).toBe(false);
  });
});

describe("exit codes", () => {
  it("matches the table in CLI.md", () => {
    expect(EXIT).toEqual({ ok: 0, usage: 1, snippet: 2, lints: 3, export: 4 });
  });
});

describe("command options", () => {
  it("defaults every command option", () => {
    const result = parse(["run", "a.tldr", "--eval", "1"]);
    expect(result.ok && result.parsed.options).toEqual({
      code: undefined,
      evalSource: "1",
      shot: undefined,
      svg: undefined,
      create: false,
      save: true,
      output: undefined,
      ids: undefined,
      from: undefined,
    });
  });

  it("reads every run flag", () => {
    const result = parse([
      "run",
      "a.tldr",
      "--code",
      "/tmp/snippet.js",
      "--shot",
      "out.png",
      "--svg",
      "out.svg",
      "--create",
      "--no-save",
    ]);
    expect(result.ok && result.parsed.options.code).toBe("/tmp/snippet.js");
    expect(result.ok && result.parsed.options.shot).toBe("out.png");
    expect(result.ok && result.parsed.options.svg).toBe("out.svg");
    expect(result.ok && result.parsed.options.create).toBe(true);
    expect(result.ok && result.parsed.options.save).toBe(false);
  });

  it("takes - as the --code value, for stdin", () => {
    const result = parse(["run", "a.tldr", "--code", "-"]);
    expect(result.ok && result.parsed.options.code).toBe("-");
  });

  it("refuses --code together with --eval", () => {
    const result = parse(["run", "a.tldr", "--code", "x.js", "--eval", "1"]);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain("mutually exclusive");
  });

  it("reads -o and --ids for shot", () => {
    const result = parse(["shot", "a.tldr", "-o", "out.png", "--ids", "shape:a, shape:b ,,"]);
    expect(result.ok && result.parsed.options.output).toBe("out.png");
    expect(result.ok && result.parsed.options.ids).toEqual(["shape:a", "shape:b"]);
  });

  it("reads --from for new", () => {
    const result = parse(["new", "a.tldr", "--from", "b.tldr"]);
    expect(result.ok && result.parsed.options.from).toBe("b.tldr");
  });

  it("refuses a flag that belongs to another command", () => {
    const result = parse(["shot", "a.tldr", "--create"]);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain('--create is not an option of "shot"');
  });

  it("refuses a run flag on doctor", () => {
    const result = parse(["doctor", "--shot", "out.png"]);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain('not an option of "doctor"');
  });

  it("accepts every global on every command", () => {
    expect(parse(["new", "a.tldr", "--json", "--quiet", "--headed"]).ok).toBe(true);
    expect(parse(["shot", "a.tldr", "--padding", "4", "--page", "Page 2"]).ok).toBe(true);
  });
});
