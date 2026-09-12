/**
 * The built binary against the real page bundle.
 *
 * Every test here spawns `node dist/cli/index.js` the way an agent or a skill
 * would, in a temp directory, and reads the exit code and the output. That is
 * the contract in CLI.md, and it is the only level at which the exit-code
 * table means anything: a library that returns 3 in a field nobody reads has
 * not stopped anyone from calling a diagram finished.
 *
 * These need the page bundle to implement the whole bridge. Until it does,
 * every test except `doctor` fails with "the page bundle does not implement
 * load()", which is the capability check doing its job rather than a mystery.
 */

import { describe, expect, it, beforeAll, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import { CLI_ENTRY, PAGE_INDEX_HTML } from "../../src/lib/paths.js";
import { resolveChromium } from "../../src/lib/browser.js";

/** The snippet from the example at the end of HELPERS.md, three boxes of it. */
const THREE_BOXES = `
helpers.box('agent', 'agent cli', { x: 60, y: 60, w: 170, h: 64 })
helpers.box('page', 'headless page', { after: 'agent', gap: 80, w: 190, h: 64 })
helpers.box('png', 'screenshot png', { below: 'page', gap: 90, w: 190, h: 64 })
helpers.connect('agent', 'page', { label: 'exec' })
helpers.connect('page', 'png', { label: 'toImage' })
return { boxes: 3, arrows: 2 }
`;

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** The browser every child should use, resolved once so the tests agree. */
let chromiumPath: string;
let dir: string;
let file: string;

beforeAll(async () => {
  const built = await fs.stat(CLI_ENTRY).catch(() => null);
  if (!built) throw new Error(`${CLI_ENTRY} is missing. Run \`npm run build\` first.`);
  const page = await fs.stat(PAGE_INDEX_HTML).catch(() => null);
  if (!page) throw new Error(`${PAGE_INDEX_HTML} is missing. Run \`npm run build\` first.`);
  chromiumPath = (await resolveChromium()).executablePath;
});

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "tldrawkc-cli-"));
  file = path.join(dir, "diagram.tldr");
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

/** Run the CLI and collect everything, including a non-zero exit. */
function cli(args: string[], stdin?: string): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_ENTRY, ...args], {
      cwd: dir,
      env: { ...process.env, TLDRAWKC_CHROMIUM: chromiumPath },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code: code ?? -1, stdout, stderr });
    });
    if (stdin !== undefined) child.stdin.end(stdin);
    else child.stdin.end();
  });
}

async function writeSnippet(name: string, source: string): Promise<string> {
  const target = path.join(dir, name);
  await fs.writeFile(target, source);
  return target;
}

interface RunJson {
  file: string;
  result: unknown;
  shapeCount: number;
  lints: Array<{ rule: string; shapeIds: string[]; message: string }>;
  shot: string | null;
  svg: string | null;
  ms: number;
}

describe("run", () => {
  it("draws three boxes and two bound arrows, saves, and shoots", async () => {
    await writeSnippet("draw.js", THREE_BOXES);
    const result = await cli([
      "run",
      "diagram.tldr",
      "--code",
      "draw.js",
      "--create",
      "--shot",
      "out.png",
      "--json",
    ]);

    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);

    const json = JSON.parse(result.stdout) as RunJson;
    expect(Object.keys(json)).toEqual([
      "file",
      "result",
      "shapeCount",
      "lints",
      "shot",
      "svg",
      "ms",
    ]);
    expect(json.shapeCount).toBe(5);
    expect(json.lints).toEqual([]);
    expect(json.result).toEqual({ boxes: 3, arrows: 2 });
    expect(json.svg).toBeNull();

    const document = JSON.parse(await fs.readFile(file, "utf8")) as { records: unknown[] };
    expect(Array.isArray(document.records)).toBe(true);

    // Larger than 10 kB is the check ARCHITECTURE.md's testing table asks
    // for: a blank or font-less canvas compresses to far less than that.
    const png = await fs.stat(path.join(dir, "out.png"));
    expect(png.size).toBeGreaterThan(10_000);
  });

  it("takes a snippet on stdin with --code -", async () => {
    const result = await cli(["run", "diagram.tldr", "--code", "-", "--create", "--json"], THREE_BOXES);
    expect(result.code).toBe(0);
    expect((JSON.parse(result.stdout) as RunJson).shapeCount).toBe(5);
  });

  it("exits 2 and changes nothing when the snippet throws", async () => {
    await writeSnippet("draw.js", THREE_BOXES);
    expect((await cli(["run", "diagram.tldr", "--code", "draw.js", "--create"])).code).toBe(0);
    const before = await fs.readFile(file);

    await writeSnippet("boom.js", "helpers.box('x', 'x', { x: 0, y: 0 })\nthrow new Error('deliberate')");
    const result = await cli(["run", "diagram.tldr", "--code", "boom.js"]);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("deliberate");
    expect(await fs.readFile(file)).toEqual(before);
  });

  it("exits 3 on a friendless arrow, saves anyway, and 0 with --allow-lints", async () => {
    await writeSnippet(
      "loose.js",
      `helpers.box('a', 'alpha', { x: 0, y: 0 })
       editor.createShape({ id: tldraw.createShapeId('loose'), type: 'arrow', x: 300, y: 300 })`,
    );

    const strict = await cli(["run", "diagram.tldr", "--code", "loose.js", "--create", "--json"]);
    expect(strict.code).toBe(3);
    const json = JSON.parse(strict.stdout) as RunJson;
    expect(json.lints.map((lint) => lint.rule)).toContain("friendless-arrow");
    // Saved despite the non-zero code: the work is real, the exit code is a
    // prompt to look again.
    expect(JSON.parse(await fs.readFile(file, "utf8"))).toHaveProperty("records");

    const allowed = await cli([
      "run",
      "diagram.tldr",
      "--code",
      "loose.js",
      "--allow-lints",
      "--json",
    ]);
    expect(allowed.code).toBe(0);
    expect((JSON.parse(allowed.stdout) as RunJson).lints.length).toBeGreaterThan(0);
  });

  it("exits 1 on a missing file without --create, and writes nothing", async () => {
    await writeSnippet("draw.js", THREE_BOXES);
    const result = await cli(["run", "diagram.tldr", "--code", "draw.js"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("--create");
    await expect(fs.readFile(file)).rejects.toThrow();
  });

  it("prints a human summary with one line per lint when --json is off", async () => {
    await writeSnippet("draw.js", THREE_BOXES);
    const result = await cli(["run", "diagram.tldr", "--code", "draw.js", "--create"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("5 shapes");
    expect(result.stdout).toContain(`saved ${file}`);
  });
});

describe("shot", () => {
  it("writes a PNG to the temp directory and prints the path", async () => {
    await writeSnippet("draw.js", THREE_BOXES);
    await cli(["run", "diagram.tldr", "--code", "draw.js", "--create"]);

    const result = await cli(["shot", "diagram.tldr"]);
    expect(result.code).toBe(0);

    const printed = result.stdout.split("\n")[0] ?? "";
    expect(path.dirname(printed)).toBe(path.resolve(os.tmpdir()));
    expect(path.basename(printed)).toMatch(/^tldrawkc-diagram-.*\.png$/);
    try {
      expect((await fs.stat(printed)).size).toBeGreaterThan(10_000);
    } finally {
      await fs.rm(printed, { force: true });
    }
  });
});

describe("new", () => {
  it("creates a document and then refuses to overwrite it", async () => {
    const first = await cli(["new", "fresh.tldr"]);
    expect(first.code).toBe(0);
    expect(first.stdout.trim()).toBe(path.join(dir, "fresh.tldr"));

    const document = JSON.parse(
      await fs.readFile(path.join(dir, "fresh.tldr"), "utf8"),
    ) as Record<string, unknown>;
    expect(document).toHaveProperty("records");

    const again = await cli(["new", "fresh.tldr"]);
    expect(again.code).toBe(1);
    expect(again.stderr).toContain("already exists");
  });
});

describe("doctor", () => {
  it("passes, and says so in a shape a script can read", async () => {
    const result = await cli(["doctor", "--json"]);
    expect(result.code).toBe(0);

    const report = JSON.parse(result.stdout) as {
      ok: boolean;
      checks: Array<{ name: string; status: string; detail: string }>;
    };
    expect(report.ok).toBe(true);
    expect(report.checks.map((check) => check.name)).toEqual([
      "node",
      "page bundle",
      "chromium",
      "page load",
      "fonts",
      "write access",
    ]);
    expect(report.checks.every((check) => check.status !== "fail")).toBe(true);
    // Layering rule 8, as a test: nothing the page loaded came from outside.
    expect(report.checks.find((check) => check.name === "page load")?.detail).toContain(
      "no failed or off-host requests",
    );
  });
});

describe("usage", () => {
  it("refuses --code together with --eval", async () => {
    const result = await cli(["run", "diagram.tldr", "--code", "a.js", "--eval", "1"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("mutually exclusive");
  });

  it("refuses a flag that belongs to another command", async () => {
    const result = await cli(["shot", "diagram.tldr", "--create"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('not an option of "shot"');
  });

  it("lists the built verbs in help", async () => {
    const result = await cli(["help"]);
    expect(result.code).toBe(0);
    for (const verb of ["new", "run", "shot", "doctor"]) {
      expect(result.stdout).toContain(verb);
    }
  });
});
