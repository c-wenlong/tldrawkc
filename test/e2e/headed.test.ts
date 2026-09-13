/**
 * `--headed` against a real browser.
 *
 * The unit suite proves the flag reaches `withCanvas` from every verb. This
 * proves the other end: that a window actually opens and the command still
 * finishes, because `headless: false` is a different Chromium launch and a
 * machine that cannot open a window fails there rather than in the plumbing.
 *
 * Gated, because a headed Chromium needs a display. macOS always has one; a
 * Linux CI runner has one only under `xvfb-run`, which sets DISPLAY. Anywhere
 * else the test skips rather than failing for a reason that is about the box
 * and not about the tool.
 */

import { describe, expect, it, beforeAll, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import { CLI_ENTRY, PAGE_INDEX_HTML } from "../../src/lib/paths.js";
import { resolveChromium } from "../../src/lib/browser.js";

const CAN_OPEN_A_WINDOW =
  process.platform === "darwin" || Boolean(process.env["DISPLAY"]);

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
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "tldrawkc-headed-e2e-")));
  file = path.join(dir, "diagram.tldr");
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

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
    child.stdin.end();
  });
}

describe.skipIf(!CAN_OPEN_A_WINDOW)("--headed", () => {
  it("draws and saves with the window open", async () => {
    const result = await cli([
      "run",
      file,
      "--create",
      "--allow-lints",
      "--json",
      "--headed",
      "--eval",
      "helpers.box('a', 'headed', { x: 0, y: 0, w: 160, h: 64 }); return 'drew'",
    ]);
    expect(result.code, result.stderr).toBe(0);
    const summary = JSON.parse(result.stdout) as { result: unknown; shapeCount: number };
    expect(summary.result).toBe("drew");
    expect(summary.shapeCount).toBe(1);
    expect(await fs.readFile(file, "utf8")).toContain("headed");
  });

  it("screenshots with the window open, and still exits", async () => {
    const drawn = await cli([
      "run",
      file,
      "--create",
      "--allow-lints",
      "--eval",
      "helpers.box('a', 'headed shot', { x: 0, y: 0, w: 160, h: 64 })",
    ]);
    expect(drawn.code, drawn.stderr).toBe(0);

    const out = path.join(dir, "headed.png");
    const shot = await cli(["shot", file, "-o", out, "--headed", "--json"]);
    expect(shot.code, shot.stderr).toBe(0);
    const stat = await fs.stat(out);
    expect(stat.size).toBeGreaterThan(1000);
    // The command returning at all is the other half: layering rule 7 has no
    // exemption for the debugging flag, and a browser left open would hold
    // this process's child until the suite's timeout.
  });
});
