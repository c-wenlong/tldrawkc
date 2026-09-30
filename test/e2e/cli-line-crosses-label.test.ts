/**
 * `line-crosses-label` through the built binary, on a real canvas.
 *
 * The case is the one self-learn#225 measured: a timeline whose milestone
 * label wrapped, whose box grew down with `growY`, and whose dashed leader,
 * drawn from where the box was declared to end, ran through the words. Every
 * rule passed it. The rule itself is pure and unit tested; what only a browser
 * can check is the text box `read.ts` measures, since it is the browser's own
 * layout of the label that decides where the words are.
 */

import { describe, expect, it, beforeAll, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { CLI_ENTRY, PAGE_INDEX_HTML } from "../../src/lib/paths.js";
import { resolveChromium } from "../../src/lib/browser.js";

const SNIPPETS = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "snippets");

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface Lint {
  rule: string;
  shapeIds: string[];
  message: string;
  severity?: string;
}

let chromiumPath: string;
let dir: string;

beforeAll(async () => {
  for (const built of [CLI_ENTRY, PAGE_INDEX_HTML]) {
    const found = await fs.stat(built).catch(() => null);
    if (!found) throw new Error(`${built} is missing. Run \`npm run build\` first.`);
  }
  chromiumPath = (await resolveChromium()).executablePath;
});

beforeEach(async () => {
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "tldrawkc-leader-")));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

function cli(args: string[]): Promise<CliResult> {
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
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
    child.stdin.end("");
  });
}

/** Draw one fixture into a fresh document and read the lints back twice. */
async function drawn(snippet: string): Promise<{ run: CliResult; runLints: Lint[]; inspect: CliResult; lints: Lint[] }> {
  expect((await cli(["new", "d.tldr", "--topic", "timeline"])).code).toBe(0);
  const run = await cli(["run", "d.tldr", "--code", path.join(SNIPPETS, snippet), "--json"]);
  const runLints = (JSON.parse(run.stdout) as { lints: Lint[] }).lints;
  // `inspect` is what the studio's gate runs, so the finding has to survive a
  // save and a fresh load, not only the page the snippet drew on.
  const inspect = await cli(["inspect", "d.tldr", "--json"]);
  const lints = (JSON.parse(inspect.stdout) as { lints: Lint[] }).lints;
  return { run, runLints, inspect, lints };
}

describe("line-crosses-label", () => {
  it("fails the leader drawn to where a wrapped label's box used to end", async () => {
    const { run, runLints, inspect, lints } = await drawn("leader-through-label.js");
    expect(run.code).toBe(3);
    expect(inspect.code).toBe(3);
    expect(runLints).toEqual(lints);
    // Only this rule, and only this pair: the axis and the tick sit clear.
    expect(lints.map((lint) => [lint.rule, lint.shapeIds])).toEqual([
      ["line-crosses-label", ["shape:lead", "shape:t2017"]],
    ]);
    expect(lints[0]?.severity).toBeUndefined();
    expect(lints[0]?.message).toContain('"2017: The Transformer"');
  }, 60_000);

  it("passes the same leader from the box's real edge, and lines through the padding", async () => {
    const { run, inspect, lints } = await drawn("leader-clear.js");
    expect(lints).toEqual([]);
    expect(run.code).toBe(0);
    expect(inspect.code).toBe(0);
  }, 60_000);

  it("fails tldraw's own line shape struck through a text caption", async () => {
    const { run, lints } = await drawn("native-line-through-text.js");
    expect(run.code).toBe(3);
    expect(lints.map((lint) => [lint.rule, lint.shapeIds])).toEqual([
      ["line-crosses-label", ["shape:rule", "shape:caption"]],
    ]);
  }, 60_000);
});
