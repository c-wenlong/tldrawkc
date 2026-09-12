/**
 * The static server.
 *
 * Two things are worth testing without a browser: that the content type map
 * covers everything the page bundle contains (a woff2 served as octet-stream
 * still loads, but the map is the one place the list is written down), and
 * that a request cannot walk out of the served directory. The traversal guard
 * is a prefix check on the resolved path, so the tests feed it the shapes a
 * scan for ".." would miss.
 */

import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  contentTypeFor,
  CONTENT_TYPES,
  FALLBACK_CONTENT_TYPE,
  resolveStaticPath,
  startPageServer,
} from "../../src/lib/server.js";

describe("content types", () => {
  it("covers every extension the page bundle emits", () => {
    for (const ext of [".html", ".js", ".css", ".json", ".map", ".svg", ".png", ".woff2", ".woff", ".ttf"]) {
      expect(CONTENT_TYPES[ext], ext).toBeDefined();
    }
  });

  it("serves fonts with a font type, not octet-stream", () => {
    expect(contentTypeFor("/assets/Shantell_Sans-Informal_Regular-abc.woff2")).toBe("font/woff2");
    expect(contentTypeFor("/assets/x.woff")).toBe("font/woff");
    expect(contentTypeFor("/assets/x.ttf")).toBe("font/ttf");
  });

  it("marks text types as utf-8", () => {
    expect(contentTypeFor("index.html")).toContain("charset=utf-8");
    expect(contentTypeFor("index.js")).toContain("charset=utf-8");
  });

  it("ignores case", () => {
    expect(contentTypeFor("LOGO.PNG")).toBe("image/png");
  });

  it("falls back for anything unexpected", () => {
    expect(contentTypeFor("weird.bin")).toBe(FALLBACK_CONTENT_TYPE);
    expect(contentTypeFor("noextension")).toBe(FALLBACK_CONTENT_TYPE);
  });
});

describe("path resolution", () => {
  const root = path.resolve("/srv/page");

  it("maps / to index.html", () => {
    expect(resolveStaticPath(root, "/")).toBe(path.join(root, "index.html"));
  });

  it("maps a normal asset path", () => {
    expect(resolveStaticPath(root, "/assets/index.js")).toBe(
      path.join(root, "assets", "index.js"),
    );
  });

  it("drops a query string", () => {
    expect(resolveStaticPath(root, "/assets/index.js?v=2")).toBe(
      path.join(root, "assets", "index.js"),
    );
  });

  it("refuses a climb out of the root", () => {
    expect(resolveStaticPath(root, "/../../etc/passwd")).toBe(path.join(root, "etc", "passwd"));
    expect(resolveStaticPath(root, "/assets/../../etc/passwd")).toBe(
      path.join(root, "etc", "passwd"),
    );
  });

  it("refuses a percent-encoded climb", () => {
    // %2e%2e%2f is "../". A scan of the raw URL for ".." would not see it; the
    // resolve does, because decoding happens first.
    expect(resolveStaticPath(root, "/%2e%2e%2f%2e%2e%2fetc/passwd")).toBe(
      path.join(root, "etc", "passwd"),
    );
  });

  it("refuses a malformed escape and a NUL byte", () => {
    expect(resolveStaticPath(root, "/%")).toBeNull();
    expect(resolveStaticPath(root, "/index.html%00.png")).toBeNull();
  });

  it("never returns a path outside the root", () => {
    const attempts = [
      "/../secret",
      "/../../secret",
      "/a/../../secret",
      "/%2e%2e/secret",
      "//../secret",
      "/./../secret",
    ];
    for (const attempt of attempts) {
      const resolved = resolveStaticPath(root, attempt);
      if (resolved === null) continue;
      expect(resolved.startsWith(root + path.sep), `${attempt} -> ${resolved}`).toBe(true);
    }
  });

  it("does not treat a sibling directory with the same prefix as inside", () => {
    // /srv/page-other must not pass a naive startsWith(root) check.
    expect(resolveStaticPath(root, "/../page-other/x.js")).toBe(path.join(root, "page-other", "x.js"));
  });
});

describe("startPageServer", () => {
  it("serves files from the root on loopback and 404s everything else", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tldrawkc-server-"));
    await fs.writeFile(path.join(dir, "index.html"), "<!doctype html><title>page</title>");
    await fs.mkdir(path.join(dir, "assets"));
    await fs.writeFile(path.join(dir, "assets", "app.js"), "export const a = 1;\n");
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "tldrawkc-outside-"));
    await fs.writeFile(path.join(outside, "secret.txt"), "do not serve me");

    const server = await startPageServer({ root: dir });
    try {
      expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

      const index = await fetch(`${server.url}/`);
      expect(index.status).toBe(200);
      expect(index.headers.get("content-type")).toContain("text/html");
      expect(await index.text()).toContain("<title>page</title>");

      const script = await fetch(`${server.url}/assets/app.js`);
      expect(script.status).toBe(200);
      expect(script.headers.get("content-type")).toContain("text/javascript");

      expect((await fetch(`${server.url}/nope.js`)).status).toBe(404);
      // A directory is not a file.
      expect((await fetch(`${server.url}/assets`)).status).toBe(404);
      // The traversal guard, over a real socket.
      const climb = await fetch(`${server.url}/../${path.basename(outside)}/secret.txt`);
      expect(climb.status).toBe(404);
      expect((await fetch(`${server.url}/`, { method: "POST" })).status).toBe(405);
    } finally {
      await server.close();
      await fs.rm(dir, { recursive: true, force: true });
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it("picks a free port each time, so two commands can overlap", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tldrawkc-server-"));
    await fs.writeFile(path.join(dir, "index.html"), "<!doctype html>");
    const first = await startPageServer({ root: dir });
    const second = await startPageServer({ root: dir });
    try {
      expect(first.port).not.toBe(second.port);
    } finally {
      await first.close();
      await second.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
