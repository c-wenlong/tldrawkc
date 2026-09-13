/**
 * `verify`, through the built binary and a real Chromium.
 *
 * This is the half of the command that cannot be faked. The rules themselves
 * are unit tested against a measurement (`test/unit/verify.test.ts`); what
 * matters here is that a real browser, handed a real export, produces a
 * measurement the rules then read correctly, and that a file with something
 * actually wrong with it comes back exit 3 rather than a clean bill.
 *
 * The broken cases are made from a good export by editing it, so each one
 * differs from a passing run in exactly one way. The external font points at
 * a `.invalid` host, which by RFC 2606 can never resolve: the check is that
 * the file reached outside itself, and reaching for something real would make
 * the test depend on the runner's network.
 */

import { describe, expect, it, beforeAll, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { CLI_ENTRY, PAGE_INDEX_HTML } from "../../src/lib/paths.js";
import { resolveChromium } from "../../src/lib/browser.js";

/** The 8-node roadmap fixture, the same one the font subsetting tests use. */
const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "mermaid",
  "subgraph-8-9.mmd",
);

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface VerifyJson {
  file: string;
  svg: string | null;
  png: string;
  width: number;
  height: number;
  checks: Array<{ rule: string; ok: boolean; detail: string }>;
  ms: number;
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
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "tldrawkc-verify-")));
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

/** Draw the fixture and export it, which is what a committed diagram is. */
async function exportFixture(name = "map.svg"): Promise<string> {
  // `--allow-lints`, because the fixture's `Looks right?` diamond is a real
  // finding: the importer sizes every node by counting characters and gives a
  // diamond the box a rectangle would get, so its label runs out through the
  // slanted edges. `verify` is about the finished SVG, not about that.
  const drawn = await cli(["from-mermaid", "map.tldr", "--source", FIXTURE, "--allow-lints"]);
  expect(drawn.code, drawn.stderr).toBe(0);
  const exported = await cli(["export", "map.tldr", "--svg", name]);
  expect(exported.code, exported.stderr).toBe(0);
  return path.join(dir, name);
}

/** One rule out of a `--json` run. */
function ruled(json: VerifyJson, rule: string) {
  const found = json.checks.find((check) => check.rule === rule);
  if (found === undefined) throw new Error(`no check named ${rule}`);
  return found;
}

async function edit(file: string, change: (svg: string) => string): Promise<void> {
  await fs.writeFile(file, change(await fs.readFile(file, "utf8")));
}

describe("verify", () => {
  it("renders a committed export clean, and writes a PNG worth looking at", async () => {
    const svg = await exportFixture();
    const result = await cli(["verify", svg, "-o", "look.png", "--json"]);
    expect(result.code, result.stderr).toBe(0);

    const json = JSON.parse(result.stdout) as VerifyJson;
    expect(json.checks).toHaveLength(4);
    expect(json.checks.every((check) => check.ok), JSON.stringify(json.checks)).toBe(true);
    expect(json.svg).toBe(svg);

    // The point of the command: a file the Read tool will actually take. The
    // SVG it came from is 80 kB on one line and this is a picture of it.
    const png = await fs.stat(path.join(dir, "look.png"));
    expect(png.size).toBeGreaterThan(10_000);
    // The fixture is a tall top-down flowchart, so the height cap is what
    // sets the width here rather than the default. Both hold either way.
    expect(json.width).toBeLessThanOrEqual(1500);
    expect(json.height).toBeLessThanOrEqual(2000);
    expect(json.height).toBeGreaterThan(100);
  });

  it("says in one line that the PNG is the thing to look at", async () => {
    const svg = await exportFixture();
    const result = await cli(["verify", svg]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("look at the PNG");
    // The path first, so it can be read off the top of the output.
    expect(result.stdout.split("\n")[0]).toMatch(/\.png$/);
  });

  it("puts the PNG in the temp directory when no -o is given", async () => {
    const svg = await exportFixture();
    const result = await cli(["verify", svg, "--json"]);
    expect(result.code, result.stderr).toBe(0);
    const json = JSON.parse(result.stdout) as VerifyJson;
    // `os.tmpdir()` is a symlink on macOS, so compare the directory rather
    // than the prefix: the command reports the path it built, not a resolved
    // one.
    expect(path.dirname(json.png)).toBe(os.tmpdir());
    expect(path.basename(json.png)).toMatch(/^tldrawkc-verify-/);
    expect((await fs.stat(json.png)).size).toBeGreaterThan(10_000);
    await fs.rm(json.png, { force: true });
  });

  it("honours --width, and the raster gets smaller", async () => {
    const svg = await exportFixture();
    const wide = await cli(["verify", svg, "-o", "wide.png", "--json"]);
    const narrow = await cli(["verify", svg, "-o", "narrow.png", "--width", "600", "--json"]);
    expect(wide.code, wide.stderr).toBe(0);
    expect(narrow.code, narrow.stderr).toBe(0);

    const wideJson = JSON.parse(wide.stdout) as VerifyJson;
    const narrowJson = JSON.parse(narrow.stdout) as VerifyJson;
    expect(narrowJson.width).toBeLessThanOrEqual(600);
    expect(narrowJson.width).toBeLessThan(wideJson.width);
    expect(narrowJson.height).toBeLessThan(wideJson.height);
    const wideSize = (await fs.stat(path.join(dir, "wide.png"))).size;
    const narrowSize = (await fs.stat(path.join(dir, "narrow.png"))).size;
    expect(narrowSize).toBeLessThan(wideSize);
  });

  it("takes a .tldr, exports it, and leaves no SVG behind", async () => {
    // See `exportFixture` for why the lint is allowed rather than absent.
    const drawn = await cli([
      "from-mermaid",
      "map.tldr",
      "--source",
      FIXTURE,
      "--allow-lints",
    ]);
    expect(drawn.code, drawn.stderr).toBe(0);

    const result = await cli(["verify", "map.tldr", "-o", "doc.png", "--json"]);
    expect(result.code, result.stderr).toBe(0);
    const json = JSON.parse(result.stdout) as VerifyJson;
    expect(json.file).toBe(path.join(dir, "map.tldr"));
    // The export was a throwaway, so there is no path to report and none of
    // it is left in the working directory either.
    expect(json.svg).toBeNull();
    expect(await fs.readdir(dir)).toEqual(expect.not.arrayContaining(["map.svg"]));
    expect(json.checks.every((check) => check.ok)).toBe(true);
  });

  it("exits 3 and names the family when the @font-face blocks are gone", async () => {
    const svg = await exportFixture();
    await edit(svg, (text) => text.replace(/@font-face\s*\{[^}]*\}/g, ""));

    const result = await cli(["verify", svg, "-o", "broken.png", "--json"]);
    expect(result.code).toBe(3);
    const json = JSON.parse(result.stdout) as VerifyJson;
    const fonts = ruled(json, "fonts-applied");
    expect(fonts.ok).toBe(false);
    expect(fonts.detail).toContain("tldraw_draw");
    // Still a picture, and it is the picture that shows the fallback font.
    expect((await fs.stat(path.join(dir, "broken.png"))).size).toBeGreaterThan(10_000);
    expect(ruled(json, "self-contained").ok).toBe(true);
  });

  it("exits 3 when a font points outside the file", async () => {
    const svg = await exportFixture();
    await edit(svg, (text) =>
      text.replace(
        /url\("data:font\/woff2;base64,[^"]*"\)/,
        'url("https://fonts.tldrawkc.invalid/shantell.woff2")',
      ),
    );

    const result = await cli(["verify", svg, "--json"]);
    expect(result.code).toBe(3);
    const json = JSON.parse(result.stdout) as VerifyJson;
    const contained = ruled(json, "self-contained");
    expect(contained.ok).toBe(false);
    expect(contained.detail).toContain("tldrawkc.invalid");
    await fs.rm(json.png, { force: true });
  });

  it("exits 3 when the root declares no size", async () => {
    const svg = await exportFixture();
    // A framed export's width is a float, so this is not `\d+`: the first
    // width/height pair in the file is the root element's.
    await edit(svg, (text) => text.replace(/\swidth="[^"]*"\s+height="[^"]*"/, ""));

    const result = await cli(["verify", svg, "--json"]);
    expect(result.code).toBe(3);
    const json = JSON.parse(result.stdout) as VerifyJson;
    expect(ruled(json, "declared-size").ok).toBe(false);
    await fs.rm(json.png, { force: true });
  });

  it("exits 1 on a file that is not well-formed XML", async () => {
    const svg = await exportFixture();
    await edit(svg, (text) => text.replace(/<\/svg>\s*$/, "</svg"));

    const result = await cli(["verify", svg]);
    // An `<img>` embed of this renders nothing at all, so it is a broken file
    // rather than a file with a finding against it.
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("could not be rendered");
  });

  it("refuses to write the PNG over the file it is verifying", async () => {
    const svg = await exportFixture();
    const onto = await cli(["verify", svg, "-o", svg]);
    expect(onto.code).toBe(1);
    expect(onto.stderr).toContain("refusing to write an export over the document itself");
    // Still the SVG it was, not PNG bytes under an .svg name.
    expect(await fs.readFile(svg, "utf8")).toContain("<svg");

    // And the `.tldr` form is refused before it exports anything, which is the
    // one that would cost the only editable copy of the drawing.
    const document = path.join(dir, "map.tldr");
    const before = await fs.readFile(document, "utf8");
    const overDocument = await cli(["verify", "map.tldr", "-o", "map.tldr"]);
    expect(overDocument.code).toBe(1);
    expect(await fs.readFile(document, "utf8")).toBe(before);
  });

  it("exits 1 on a missing file and on one that is not an SVG", async () => {
    const missing = await cli(["verify", "nope.svg"]);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("does not exist");

    await fs.writeFile(path.join(dir, "notes.svg"), "this is not a drawing\n");
    const wrong = await cli(["verify", "notes.svg"]);
    expect(wrong.code).toBe(1);
    expect(wrong.stderr).toContain("<svg>");
  });
});
