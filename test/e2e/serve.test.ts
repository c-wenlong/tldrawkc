/**
 * `serve` as a process: the built binary, a real socket, a real document.
 *
 * The unit suite already drives the routes in-process. What only this level
 * can answer is whether the command behaves like a command: that it prints its
 * URL and then stays up, that a `run` in a second process is visible through
 * `/api/document` the way the mirror page's poll will see it, and that Ctrl+C
 * stops it with an exit code of 0 rather than the 130 a process with no
 * handler gets.
 *
 * The mirror page itself is tested in `mirror.test.ts`, which needs the page
 * half of phase 4. Everything here is the Node half and runs without it.
 */

import { describe, expect, it, beforeAll, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

import { CLI_ENTRY, PAGE_INDEX_HTML } from "../../src/lib/paths.js";
import { resolveChromium } from "../../src/lib/browser.js";

/** The browser the children should use, resolved once so they agree. */
let chromiumPath: string;
/** One empty document, made by the real `new`, copied per test. */
let emptyDocument: string;
let dir: string;
let file: string;
const children: ChildProcess[] = [];

beforeAll(async () => {
  const built = await fs.stat(CLI_ENTRY).catch(() => null);
  if (!built) throw new Error(`${CLI_ENTRY} is missing. Run \`npm run build\` first.`);
  const page = await fs.stat(PAGE_INDEX_HTML).catch(() => null);
  if (!page) throw new Error(`${PAGE_INDEX_HTML} is missing. Run \`npm run build\` first.`);
  chromiumPath = (await resolveChromium()).executablePath;

  // One browser launch for the whole file: `new` is the only thing here that
  // needs tldraw, and every test wants the same starting document.
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "tldrawkc-serve-seed-"));
  const seed = path.join(scratch, "seed.tldr");
  const made = await cli(["new", seed], scratch);
  if (made.code !== 0) throw new Error(`new failed: ${made.stderr}`);
  emptyDocument = await fs.readFile(seed, "utf8");
  await fs.rm(scratch, { recursive: true, force: true });
}, 120_000);

beforeEach(async () => {
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "tldrawkc-serve-e2e-")));
  file = path.join(dir, "diagram.tldr");
  await fs.writeFile(file, emptyDocument);
});

afterEach(async () => {
  while (children.length > 0) {
    const child = children.pop();
    if (child && child.exitCode === null) child.kill("SIGKILL");
  }
  await fs.rm(dir, { recursive: true, force: true });
});

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run the CLI to completion and collect everything, including a non-zero exit. */
function cli(args: string[], cwd: string): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_ENTRY, ...args], {
      cwd,
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

interface ServeChild {
  child: ChildProcess;
  /** The mirror URL the command printed. */
  url: string;
  /** The same origin with no path or query, for the API calls. */
  origin: string;
  port: number;
  /**
   * Resolves with how the process ended.
   *
   * Both halves, not a single number: a `code` of null with a `signal` set is
   * a process the operating system killed, which is a different failure from
   * one that exited with the wrong code, and a test that collapses them into
   * `-1` cannot say which happened.
   */
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

/**
 * Start `serve` and wait for the one JSON object it prints.
 *
 * `--port 0` rather than the default: a suite that grabbed 7240 would fail
 * against whatever the person running it already has open on it, and the
 * fallback is covered in the unit suite where it can be forced.
 */
async function startServe(extra: string[] = []): Promise<ServeChild> {
  const child = spawn(
    process.execPath,
    [CLI_ENTRY, "serve", file, "--no-open", "--json", "--port", "0", ...extra],
    { cwd: dir, env: { ...process.env, TLDRAWKC_CHROMIUM: chromiumPath } },
  );
  children.push(child);

  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on("close", (code, signal) => resolve({ code, signal }));
  });

  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => (stderr += chunk));

  const announced = await new Promise<{ url: string; port: number; file: string }>(
    (resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`serve printed nothing usable in 10s. stderr: ${stderr}`));
      }, 10_000);
      child.stdout?.on("data", (chunk: string) => {
        stdout += chunk;
        try {
          // One object, pretty-printed over several lines, so it only parses
          // once the whole thing has arrived.
          const parsed = JSON.parse(stdout) as { url: string; port: number; file: string };
          clearTimeout(timer);
          resolve(parsed);
        } catch {
          // Still arriving.
        }
      });
      child.on("close", () => {
        clearTimeout(timer);
        reject(new Error(`serve exited before it printed a URL. stderr: ${stderr}`));
      });
    },
  );

  return { child, url: announced.url, origin: new URL(announced.url).origin, port: announced.port, exit };
}

describe("serve", () => {
  it("prints one JSON object naming the mirror URL, the port and the file", async () => {
    const served = await startServe();
    expect(served.url).toBe(`http://127.0.0.1:${String(served.port)}/?mirror=1`);
    expect(served.port).toBeGreaterThan(0);
    const health = (await (await fetch(`${served.origin}/api/health`)).json()) as {
      ok: boolean;
      file: string;
    };
    expect(health).toEqual({ ok: true, file });
  });

  it("prints the URL and how to stop in human mode", async () => {
    const child = spawn(process.execPath, [CLI_ENTRY, "serve", file, "--no-open", "--port", "0"], {
      cwd: dir,
      env: { ...process.env, TLDRAWKC_CHROMIUM: chromiumPath },
    });
    children.push(child);
    child.stdout?.setEncoding("utf8");
    const line = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no line in 10s")), 10_000);
      child.stdout?.on("data", (chunk: string) => {
        clearTimeout(timer);
        resolve(chunk.trim());
      });
    });
    expect(line).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?mirror=1/);
    expect(line).toContain("Ctrl+C to stop");
  });

  it("serves the document with the mtime the page polls on", async () => {
    const served = await startServe();
    const body = (await (await fetch(`${served.origin}/api/document`)).json()) as {
      file: string;
      mtimeMs: number;
      tldr: string;
    };
    expect(body.file).toBe(file);
    expect(body.mtimeMs).toBeGreaterThan(0);
    const envelope = JSON.parse(body.tldr) as Record<string, unknown>;
    expect(envelope["tldrawFileFormatVersion"]).toBeDefined();
  });

  it("shows what a run in another process wrote", async () => {
    const served = await startServe();
    const before = (await (await fetch(`${served.origin}/api/document`)).json()) as {
      mtimeMs: number;
      tldr: string;
    };
    expect(before.tldr).not.toContain("second box");

    const drawn = await cli(
      ["run", file, "--eval", "helpers.box('b','second box',{x:300,y:0})", "--json"],
      dir,
    );
    expect(drawn.code, drawn.stderr).toBe(0);

    const after = (await (await fetch(`${served.origin}/api/document`)).json()) as {
      mtimeMs: number;
      tldr: string;
    };
    expect(after.mtimeMs).toBeGreaterThan(before.mtimeMs);
    expect(after.tldr).toContain("second box");
  });

  it("writes a PUT back to the file and reports the new mtime", async () => {
    const served = await startServe();
    const before = (await (await fetch(`${served.origin}/api/document`)).json()) as {
      mtimeMs: number;
      tldr: string;
    };
    const edited = JSON.parse(before.tldr) as Record<string, unknown>;
    const body = JSON.stringify(edited);

    await new Promise((resolve) => setTimeout(resolve, 20));
    const response = await fetch(`${served.origin}/api/document`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body,
    });
    expect(response.status).toBe(200);
    const saved = (await response.json()) as { ok: boolean; mtimeMs: number };
    expect(saved.ok).toBe(true);
    expect(saved.mtimeMs).toBeGreaterThan(before.mtimeMs);
    expect(await fs.readFile(file, "utf8")).toBe(body);
  });

  it("refuses a PUT that is not a .tldr, and leaves the file alone", async () => {
    const served = await startServe();
    const original = await fs.readFile(file, "utf8");
    const response = await fetch(`${served.origin}/api/document`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ records: [] }),
    });
    expect(response.status).toBe(400);
    expect(await fs.readFile(file, "utf8")).toBe(original);
  });

  it("refuses a PUT bigger than the cap before reading it", async () => {
    const served = await startServe();
    const original = await fs.readFile(file, "utf8");
    // A declared length over the cap, with only a few bytes actually sent: the
    // server answers from the header, which is the whole point of checking it
    // first. Transferring 50 MB to prove the same thing would be the slowest
    // test in the suite.
    const status = await putWithDeclaredLength(served.origin, 60 * 1024 * 1024);
    expect(status).toBe(413);
    expect(await fs.readFile(file, "utf8")).toBe(original);
  });

  it("404s a route it does not have", async () => {
    const served = await startServe();
    expect((await fetch(`${served.origin}/api/nope`)).status).toBe(404);
  });

  it("still serves the page bundle it is mirroring through", async () => {
    const served = await startServe();
    const response = await fetch(served.url);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("<div id=\"root\">");
  });

  it("stops on SIGINT with exit code 0", async () => {
    const served = await startServe();
    // The instant the URL is readable, which is the window the CLI used to
    // have no handler in: Node's own SIGINT handling would kill the process
    // with the server still open, and the test saw a signal death rather than
    // a slow one.
    served.child.kill("SIGINT");
    const ended = await Promise.race([
      served.exit,
      new Promise<"timed out">((resolve) => setTimeout(() => resolve("timed out"), 15_000)),
    ]);
    expect(ended).toEqual({ code: 0, signal: null });
  }, 30_000);

  it("refuses a file that does not exist", async () => {
    const result = await cli(["serve", path.join(dir, "missing.tldr"), "--no-open"], dir);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("tldrawkc new");
  });
});

/**
 * PUT a `Content-Length` the server should refuse, then stop.
 *
 * `fetch` computes the length from the body and will not declare one it is not
 * going to send, so this goes through `node:http`: the headers arrive, the
 * server answers 413 from the length alone, and the request is dropped without
 * the rest of the body ever being written.
 */
function putWithDeclaredLength(origin: string, length: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const url = new URL("/api/document", origin);
    const request = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "PUT",
        headers: { "Content-Type": "application/json", "Content-Length": String(length) },
      },
      (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
        request.destroy();
      },
    );
    request.on("error", () => undefined);
    request.write("{");
    setTimeout(() => reject(new Error("no response in 5s")), 5_000).unref();
  });
}
