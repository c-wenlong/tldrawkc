import { describe, expect, it } from "vitest";

import { DEFAULTS, EXIT, PLANNED_COMMANDS, parseCommand } from "../../src/cli/args.js";

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

  it("has a place to name a command that is specified but not built", () => {
    // Nothing is planned-but-unbuilt since phase 4 shipped `serve`, so this
    // asserts the mechanism rather than a particular verb: the moment a name
    // goes back into PLANNED_COMMANDS, a caller should hear which phase brings
    // it instead of "unknown command".
    expect(Object.keys(PLANNED_COMMANDS)).toEqual([]);
  });

  it("takes serve with a file, a port and --no-open", () => {
    const result = parse(["serve", "a.tldr", "--port", "7300", "--no-open"]);
    expect(result.ok).toBe(true);
    expect(result.ok && result.parsed.options.port).toBe(7300);
    expect(result.ok && result.parsed.options.open).toBe(false);
  });

  it("defaults serve to opening a browser on the default port", () => {
    const result = parse(["serve", "a.tldr"]);
    expect(result.ok && result.parsed.options.port).toBeUndefined();
    expect(result.ok && result.parsed.options.open).toBe(true);
  });

  it("refuses a port that is not a whole number in range", () => {
    for (const raw of ["-1", "70000", "8.5", "eighty"]) {
      const result = parse(["serve", "a.tldr", "--port", raw]);
      expect(result.ok, raw).toBe(false);
      expect(!result.ok && result.error).toContain("--port");
    }
  });

  it("keeps --port off every other command", () => {
    const result = parse(["run", "a.tldr", "--eval", "1", "--port", "7240"]);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain('--port is not an option of "run"');
  });

  it("dispatches every phase 2 verb", () => {
    expect(parse(["inspect", "a.tldr"]).ok).toBe(true);
    expect(parse(["export", "a.tldr", "--svg", "out.svg"]).ok).toBe(true);
    expect(parse(["from-mermaid", "a.tldr", "--source", "d.mmd"]).ok).toBe(true);
    expect(parse(["api"]).ok).toBe(true);
  });

  it("refuses a file for api, and demands one for the other three", () => {
    expect(!parse(["api", "a.tldr"]).ok).toBe(true);
    for (const command of ["inspect", "export", "from-mermaid"]) {
      const result = parse([command]);
      expect(result.ok, command).toBe(false);
      expect(!result.ok && result.error).toContain("<file.tldr>");
    }
  });

  it("takes verify with a file, an output and a width", () => {
    const result = parse(["verify", "a.svg", "-o", "out.png", "--width", "900"]);
    expect(result.ok).toBe(true);
    expect(result.ok && result.parsed.options.output).toBe("out.png");
    expect(result.ok && result.parsed.options.width).toBe(900);
  });

  it("defaults verify to the reader-sized width", () => {
    const result = parse(["verify", "a.svg"]);
    expect(result.ok && result.parsed.options.width).toBe(DEFAULTS.verifyWidth);
  });

  it("names the file verify wants when it is given none", () => {
    const result = parse(["verify"]);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain("<file.svg>");
  });

  it("refuses a width that is not a usable number of pixels", () => {
    for (const raw of ["0", "-4", "wide"]) {
      const result = parse(["verify", "a.svg", "--width", raw]);
      expect(result.ok, raw).toBe(false);
      expect(!result.ok && result.error).toContain("--width");
    }
  });

  it("keeps --width off every other command", () => {
    const result = parse(["shot", "a.tldr", "--width", "900"]);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain('--width is not an option of "shot"');
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
      subsetFonts: true,
      output: undefined,
      ids: undefined,
      from: undefined,
      png: undefined,
      source: undefined,
      append: false,
      open: true,
      // The one command option with a value rather than a default of nothing:
      // `verify` always renders at some width, so there is a number here even
      // when the command being parsed is not `verify`.
      width: 1500,
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

  it("reads --svg, --png and --ids for export", () => {
    const result = parse([
      "export",
      "a.tldr",
      "--svg",
      "out.svg",
      "--png",
      "out.png",
      "--ids",
      "shape:a,shape:b",
    ]);
    expect(result.ok && result.parsed.options.svg).toBe("out.svg");
    expect(result.ok && result.parsed.options.png).toBe("out.png");
    expect(result.ok && result.parsed.options.ids).toEqual(["shape:a", "shape:b"]);
  });

  it("reads --source, --append and --shot for from-mermaid", () => {
    const result = parse([
      "from-mermaid",
      "a.tldr",
      "--source",
      "map.mmd",
      "--append",
      "--shot",
      "out.png",
    ]);
    expect(result.ok && result.parsed.options.source).toBe("map.mmd");
    expect(result.ok && result.parsed.options.append).toBe(true);
    expect(result.ok && result.parsed.options.shot).toBe("out.png");
  });

  it("takes - as the --source value, for stdin", () => {
    const result = parse(["from-mermaid", "a.tldr", "--source", "-"]);
    expect(result.ok && result.parsed.options.source).toBe("-");
  });

  it("keeps the phase 2 flags on their own commands", () => {
    for (const argv of [
      ["inspect", "a.tldr", "--png", "out.png"],
      ["export", "a.tldr", "--append"],
      ["from-mermaid", "a.tldr", "--png", "out.png"],
      ["api", "--svg", "out.svg"],
    ]) {
      const result = parse(argv);
      expect(result.ok, argv.join(" ")).toBe(false);
      expect(!result.ok && result.error).toContain("is not an option of");
    }
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
    expect(parse(["inspect", "a.tldr", "--allow-lints", "--json"]).ok).toBe(true);
    expect(parse(["export", "a.tldr", "--png", "o.png", "--pixel-ratio", "3"]).ok).toBe(true);
    expect(parse(["from-mermaid", "a.tldr", "--source", "-", "--timeout", "9000"]).ok).toBe(true);
    expect(parse(["api", "--json", "--quiet"]).ok).toBe(true);
  });
});

describe("list", () => {
  it("takes no positional", () => {
    const result = parse(["list"]);
    expect(result.ok && result.parsed.args).toEqual([]);
  });

  it("takes one directory", () => {
    const result = parse(["list", "learn/assets", "--json"]);
    expect(result.ok && result.parsed.args).toEqual(["learn/assets"]);
    expect(result.ok && result.parsed.globals.json).toBe(true);
  });

  it("refuses two", () => {
    const result = parse(["list", "a", "b"]);
    expect(result.ok).toBe(false);
  });

  it("refuses a flag that belongs to another command", () => {
    expect(parse(["list", "--topic", "a"]).ok).toBe(false);
  });
});

describe("meta", () => {
  it("takes a subcommand and a file", () => {
    const result = parse(["meta", "set", "a.tldr", "--topic", "dot-product"]);
    expect(result.ok && result.parsed.args).toEqual(["set", "a.tldr"]);
    expect(result.ok && result.parsed.options.topic).toBe("dot-product");
  });

  it("refuses a subcommand it does not have", () => {
    const result = parse(["meta", "get", "a.tldr"]);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain("is not a subcommand");
  });

  it("refuses a missing file", () => {
    const result = parse(["meta", "set"]);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain("set <file.tldr>");
  });

  it("collects a repeated --concept", () => {
    const result = parse(["meta", "set", "a.tldr", "--concept", "one", "--concept", "two"]);
    expect(result.ok && result.parsed.options.concepts).toEqual(["one", "two"]);
  });

  it("splits a comma list inside one --concept, so both spellings agree", () => {
    const repeated = parse(["meta", "set", "a.tldr", "--concept", "one", "--concept", "two"]);
    const commas = parse(["meta", "set", "a.tldr", "--concept", "one, two"]);
    expect(commas.ok && commas.parsed.options.concepts).toEqual(
      repeated.ok ? repeated.parsed.options.concepts : null,
    );
  });

  it("leaves concepts undefined when the flag never appeared", () => {
    const result = parse(["meta", "set", "a.tldr", "--topic", "a"]);
    expect(result.ok && result.parsed.options.concepts).toBeUndefined();
  });
});

describe("new with metadata", () => {
  it("takes every metadata flag", () => {
    const result = parse([
      "new",
      "a.tldr",
      "--title",
      "Dot product",
      "--topic",
      "dot-product",
      "--concept",
      "vectors",
      "--source",
      "session-42",
    ]);
    expect(result.ok && result.parsed.options.title).toBe("Dot product");
    expect(result.ok && result.parsed.options.topic).toBe("dot-product");
    expect(result.ok && result.parsed.options.concepts).toEqual(["vectors"]);
    expect(result.ok && result.parsed.options.source).toBe("session-42");
  });

  it("still refuses them on a command that has no metadata", () => {
    expect(parse(["shot", "a.tldr", "--topic", "a"]).ok).toBe(false);
    expect(parse(["run", "a.tldr", "--eval", "1", "--title", "x"]).ok).toBe(false);
  });
});
