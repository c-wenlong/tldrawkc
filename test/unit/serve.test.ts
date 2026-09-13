/**
 * The serve-mode routes, without a browser.
 *
 * A real `node:http` server over a real temp directory, driven with `fetch`.
 * What is under test is the contract the mirror page is written against: the
 * shapes of the three responses, the status code for every way a PUT can be
 * wrong, and the one that matters most, that a headless verb's server does not
 * answer `/api/document` at all. A snippet runs with the page's full power, so
 * "the routes are only mounted in serve mode" has to be a test rather than a
 * comment.
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import {
  DEFAULT_SERVE_PORT,
  MAX_DOCUMENT_BYTES,
  mirrorUrl,
  startPageServer,
  startServeServer,
  type PageServer,
  type ServeServer,
} from "../../src/lib/server.js";
import { openCommandFor, serve } from "../../src/lib/serve.js";
import { UsageError } from "../../src/lib/errors.js";

/** The smallest thing the PUT validator accepts as a `.tldr`. */
const DOCUMENT = JSON.stringify({
  tldrawFileFormatVersion: 1,
  schema: { schemaVersion: 2 },
  records: [],
});

let dir: string;
let file: string;
let root: string;
const running: Array<PageServer | ServeServer> = [];

beforeEach(async () => {
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "tldrawkc-serve-")));
  file = path.join(dir, "diagram.tldr");
  root = path.join(dir, "page");
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, "index.html"), "<!doctype html><title>page</title>");
  await fs.writeFile(file, DOCUMENT);
});

afterEach(async () => {
  while (running.length > 0) await running.pop()?.close();
  await fs.rm(dir, { recursive: true, force: true });
});

/** A serve-mode server on a free port, closed by the afterEach. */
async function start(options: { maxBodyBytes?: number } = {}): Promise<ServeServer> {
  const server = await startServeServer({
    root,
    file,
    port: 0,
    ...(options.maxBodyBytes === undefined ? {} : { maxBodyBytes: options.maxBodyBytes }),
  });
  running.push(server);
  return server;
}

describe("the mirror URL", () => {
  it("carries the query the page switches on", () => {
    expect(mirrorUrl("http://127.0.0.1:7240")).toBe("http://127.0.0.1:7240/?mirror=1");
  });

  it("is what startServeServer reports as its url", async () => {
    const server = await start();
    expect(server.url).toBe(`${server.origin}/?mirror=1`);
    expect(server.url).toContain("?mirror=1");
  });
});

describe("GET /api/health", () => {
  it("answers with the file it is mirroring", async () => {
    const server = await start();
    const response = await fetch(`${server.origin}/api/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, file });
  });

  it("refuses any other method", async () => {
    const server = await start();
    const response = await fetch(`${server.origin}/api/health`, { method: "POST" });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET");
  });
});

describe("GET /api/document", () => {
  it("returns the file, its mtime and its contents", async () => {
    const server = await start();
    const response = await fetch(`${server.origin}/api/document`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { file: string; mtimeMs: number; tldr: string };
    expect(body.file).toBe(file);
    expect(body.tldr).toBe(DOCUMENT);
    expect(body.mtimeMs).toBeGreaterThan(0);
  });

  it("reports a later mtime after the file changes", async () => {
    const server = await start();
    const before = (await (await fetch(`${server.origin}/api/document`)).json()) as {
      mtimeMs: number;
    };
    // A stat's resolution is coarse enough on some filesystems that two writes
    // in the same millisecond report the same mtime, which would make this
    // assert nothing.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await fs.writeFile(file, DOCUMENT.replace("[]", '[{"typeName":"shape"}]'));
    const after = (await (await fetch(`${server.origin}/api/document`)).json()) as {
      mtimeMs: number;
      tldr: string;
    };
    expect(after.mtimeMs).toBeGreaterThan(before.mtimeMs);
    expect(after.tldr).toContain("shape");
  });

  it("is a 404 once the file is gone", async () => {
    const server = await start();
    await fs.rm(file);
    expect((await fetch(`${server.origin}/api/document`)).status).toBe(404);
  });
});

describe("PUT /api/document", () => {
  it("writes the body and answers with the new mtime", async () => {
    const server = await start();
    const next = DOCUMENT.replace("[]", '[{"typeName":"shape","id":"shape:b"}]');
    const response = await fetch(`${server.origin}/api/document`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: next,
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; mtimeMs: number };
    expect(body.ok).toBe(true);
    expect(body.mtimeMs).toBeGreaterThan(0);
    expect(await fs.readFile(file, "utf8")).toBe(next);
  });

  it("refuses a body that is not JSON", async () => {
    const server = await start();
    const response = await fetch(`${server.origin}/api/document`, {
      method: "PUT",
      body: "not json at all",
    });
    expect(response.status).toBe(400);
    expect(await fs.readFile(file, "utf8")).toBe(DOCUMENT);
  });

  it("refuses JSON that is not a .tldr", async () => {
    const server = await start();
    const response = await fetch(`${server.origin}/api/document`, {
      method: "PUT",
      body: JSON.stringify({ records: [] }),
    });
    expect(response.status).toBe(400);
    const failure = (await response.json()) as { error: string };
    expect(failure.error).toContain("tldrawFileFormatVersion");
    expect(await fs.readFile(file, "utf8")).toBe(DOCUMENT);
  });

  it("refuses a body over the cap, by its length header", async () => {
    const server = await start({ maxBodyBytes: 64 });
    const response = await fetch(`${server.origin}/api/document`, {
      method: "PUT",
      body: DOCUMENT.padEnd(200, " "),
    });
    expect(response.status).toBe(413);
    expect(await fs.readFile(file, "utf8")).toBe(DOCUMENT);
  });

  it("refuses a chunked body over the cap, which declares no length", async () => {
    const server = await start({ maxBodyBytes: 64 });
    const status = await chunkedPut(server.origin, ["x".repeat(40), "y".repeat(40)]);
    expect(status).toBe(413);
    expect(await fs.readFile(file, "utf8")).toBe(DOCUMENT);
  });

  it("refuses every other method", async () => {
    const server = await start();
    for (const method of ["POST", "DELETE", "PATCH", "HEAD"]) {
      const response = await fetch(`${server.origin}/api/document`, { method });
      expect(response.status, method).toBe(405);
      expect(response.headers.get("allow")).toBe("GET, PUT");
    }
  });

  it("has a cap generous enough for a document with images in it", () => {
    expect(MAX_DOCUMENT_BYTES).toBe(50 * 1024 * 1024);
  });
});

describe("GET /favicon.ico", () => {
  it("answers 204 with no body, so a served tab logs no failed request", async () => {
    const server = await start();
    const response = await fetch(`${server.origin}/favicon.ico`);
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
  });

  it("answers a HEAD the same way", async () => {
    const server = await start();
    expect((await fetch(`${server.origin}/favicon.ico`, { method: "HEAD" })).status).toBe(204);
  });

  it("serves a real icon when the bundle has one", async () => {
    await fs.writeFile(path.join(root, "favicon.ico"), "icon-bytes");
    const server = await start();
    const response = await fetch(`${server.origin}/favicon.ico`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/x-icon");
    expect(await response.text()).toBe("icon-bytes");
  });

  it("refuses a write to it", async () => {
    const server = await start();
    expect((await fetch(`${server.origin}/favicon.ico`, { method: "PUT" })).status).toBe(405);
  });

  it("is a serve-mode route, not a static one", async () => {
    const server = await startPageServer({ root, port: 0 });
    running.push(server);
    expect((await fetch(`${server.url}/favicon.ico`)).status).toBe(404);
  });
});

describe("everything else", () => {
  it("404s an unknown route under /api", async () => {
    const server = await start();
    expect((await fetch(`${server.origin}/api/nope`)).status).toBe(404);
  });

  it("still serves the page bundle", async () => {
    const server = await start();
    const response = await fetch(`${server.origin}/`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("<title>page</title>");
  });

  it("does not mount the routes on a headless verb's server", async () => {
    const server = await startPageServer({ root, port: 0 });
    running.push(server);
    // The reason this matters: a snippet runs in the page with the page's own
    // power, so an /api/document that were always there would be a write to an
    // arbitrary file behind one fetch (layering rule 2).
    expect((await fetch(`${server.url}/api/document`)).status).toBe(404);
    expect((await fetch(`${server.url}/api/health`)).status).toBe(404);
    const put = await fetch(`${server.url}/api/document`, { method: "PUT", body: DOCUMENT });
    expect(put.status).toBe(405);
    expect(await fs.readFile(file, "utf8")).toBe(DOCUMENT);
  });
});

describe("the port", () => {
  it("defaults to the number in ARCHITECTURE.md", () => {
    expect(DEFAULT_SERVE_PORT).toBe(7240);
  });

  it("falls back to a free port and says which one was taken", async () => {
    const first = await startServeServer({ root, file, port: 0 });
    running.push(first);
    const second = await startServeServer({ root, file, port: first.port });
    running.push(second);
    expect(second.port).not.toBe(first.port);
    expect(second.fellBackFrom).toBe(first.port);
    expect(first.fellBackFrom).toBeNull();
    expect((await fetch(`${second.origin}/api/health`)).status).toBe(200);
  });

  it("does not fall back for a headless verb, which never asks for one", async () => {
    const first = await startPageServer({ root, port: 0 });
    running.push(first);
    await expect(startPageServer({ root, port: first.port })).rejects.toMatchObject({
      code: "EADDRINUSE",
    });
  });
});

describe("serve()", () => {
  it("refuses a file that does not exist, and names new", async () => {
    await expect(serve({ file: path.join(dir, "missing.tldr"), open: false, pageRoot: root }))
      .rejects.toBeInstanceOf(UsageError);
    await expect(serve({ file: path.join(dir, "missing.tldr"), open: false, pageRoot: root }))
      .rejects.toThrow(/tldrawkc new/);
  });

  it("returns a handle on the mirror URL and closes it", async () => {
    const handle = await serve({ file, port: 0, open: false, pageRoot: root });
    expect(handle.file).toBe(file);
    expect(handle.url).toBe(`http://127.0.0.1:${String(handle.port)}/?mirror=1`);
    expect((await fetch(`http://127.0.0.1:${String(handle.port)}/api/health`)).status).toBe(200);
    await handle.close();
    await expect(fetch(`http://127.0.0.1:${String(handle.port)}/api/health`)).rejects.toThrow();
  });

  it("calls onReady before it resolves", async () => {
    const seen: string[] = [];
    const handle = await serve({
      file,
      port: 0,
      open: false,
      pageRoot: root,
      onReady: (ready) => seen.push(ready.url),
    });
    expect(seen).toEqual([handle.url]);
    await handle.close();
  });

  it("opens the URL with the platform's own opener", () => {
    expect(openCommandFor("http://x/", "darwin")).toEqual({ command: "open", args: ["http://x/"] });
    expect(openCommandFor("http://x/", "linux")).toEqual({
      command: "xdg-open",
      args: ["http://x/"],
    });
    // The empty string is the window title `start` takes first; without it the
    // URL becomes the title and no browser opens.
    expect(openCommandFor("http://x/", "win32")).toEqual({
      command: "cmd",
      args: ["/c", "start", "", "http://x/"],
    });
  });
});

/**
 * PUT with `Transfer-Encoding: chunked`, which `fetch` will not do for a
 * string body. It is the one path where the server has no `Content-Length` to
 * check and has to count the bytes as they land.
 */
function chunkedPut(origin: string, chunks: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const url = new URL("/api/document", origin);
    const request = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "PUT",
        headers: { "Transfer-Encoding": "chunked", "Content-Type": "application/json" },
      },
      (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      },
    );
    // The 413 can arrive while the body is still being written, and the server
    // closes the connection once it has flushed. Either way the status is what
    // this is asking about.
    request.on("error", () => undefined);
    for (const chunk of chunks) request.write(chunk);
    request.end();
    setTimeout(() => reject(new Error("no response")), 5_000).unref();
  });
}
