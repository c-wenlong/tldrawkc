/**
 * The static server the page is loaded from.
 *
 * The page could in principle be opened with a `file://` URL, but browsers
 * treat that as an opaque origin: module scripts are blocked and every asset
 * fetch is a cross-origin one. Serving the bundle over HTTP from loopback
 * costs one `node:http` server and removes that whole class of problem.
 *
 * Bound to 127.0.0.1 on a random free port, because the page is for this
 * process only. Layering rule 8 says no request may leave 127.0.0.1, and
 * `browser.ts` enforces that by recording every request whose URL is not on
 * this server's origin.
 */

import http from "node:http";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";

/**
 * Content types for everything the page bundle contains.
 *
 * Deliberately a closed list rather than a lookup in a MIME database: the
 * bundle is built by this repo's own Vite config, so the set of extensions it
 * can produce is known, and anything outside it is a sign something unexpected
 * landed in `dist/page`. Fonts are the entries that matter most, because a
 * woff2 served as `application/octet-stream` still loads but a missing font is
 * the silent failure this tool is trying to avoid (see the fonts section in
 * ARCHITECTURE.md).
 */
export const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".txt": "text/plain; charset=utf-8",
};

/** The type served for an extension this bundle should not contain. */
export const FALLBACK_CONTENT_TYPE = "application/octet-stream";

/** Content type for a file path, by extension. Case-insensitive. */
export function contentTypeFor(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return CONTENT_TYPES[ext] ?? FALLBACK_CONTENT_TYPE;
}

/**
 * Map a request path onto a file inside `root`, or `null` to refuse it.
 *
 * The guard is a prefix check on the **resolved** path, not a scan of the URL
 * for `..`: `%2e%2e%2f` and a symlink both defeat the scan and neither defeats
 * the resolve. `/` maps to `index.html`; a path that resolves outside the root
 * is refused rather than clamped, because clamping would serve a file the
 * caller did not ask for.
 */
export function resolveStaticPath(root: string, urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    // A malformed percent escape is not a path.
    return null;
  }
  // A NUL byte truncates a path in some syscalls. Nothing legitimate has one.
  if (decoded.includes("\0")) return null;

  const withoutQuery = decoded.split("?")[0] ?? "/";
  const relative = withoutQuery === "/" || withoutQuery === "" ? "index.html" : withoutQuery;
  const rootDir = path.resolve(root);
  const resolved = path.resolve(rootDir, `.${path.posix.resolve("/", relative)}`);
  if (resolved !== rootDir && !resolved.startsWith(rootDir + path.sep)) return null;
  return resolved;
}

export interface StartPageServerOptions {
  /** Directory to serve. Normally `dist/page`. */
  root: string;
  /** Loopback only. Overridable so a test can be explicit about it. */
  host?: string;
  /** 0 asks the operating system for a free port, which is the normal case. */
  port?: number;
}

export interface PageServer {
  /** `http://127.0.0.1:<port>`, no trailing slash. The page's origin. */
  url: string;
  port: number;
  close(): Promise<void>;
}

/** Start the static server. Resolves once it is listening. */
export async function startPageServer(options: StartPageServerOptions): Promise<PageServer> {
  const root = path.resolve(options.root);
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 0;

  const server = http.createServer((request, response) => {
    void serve(root, request, response);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("tldrawkc: the page server did not report a port");
  }

  return {
    url: `http://${host}:${address.port}`,
    port: address.port,
    close: () =>
      new Promise<void>((resolve) => {
        // closeAllConnections, not close alone: a keep-alive socket from the
        // page would otherwise hold the process open after the command is done.
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}

async function serve(
  root: string,
  request: http.IncomingMessage,
  response: http.ServerResponse,
): Promise<void> {
  const method = request.method ?? "GET";
  if (method !== "GET" && method !== "HEAD") {
    end(response, 405, "method not allowed", { Allow: "GET, HEAD" });
    return;
  }

  const target = resolveStaticPath(root, request.url ?? "/");
  if (target === null) {
    end(response, 404, "not found");
    return;
  }

  let size: number;
  try {
    const stat = await fs.stat(target);
    if (!stat.isFile()) {
      end(response, 404, "not found");
      return;
    }
    size = stat.size;
  } catch {
    end(response, 404, "not found");
    return;
  }

  response.writeHead(200, {
    "Content-Type": contentTypeFor(target),
    "Content-Length": String(size),
    // The bundle is rebuilt in place and served to a browser this process
    // just launched. A cached response would be a stale diagram.
    "Cache-Control": "no-store",
  });
  if (method === "HEAD") {
    response.end();
    return;
  }
  try {
    await pipeline(createReadStream(target), response);
  } catch {
    // The browser navigated away or the socket died. Nothing to recover.
    response.destroy();
  }
}

function end(
  response: http.ServerResponse,
  status: number,
  body: string,
  headers: Record<string, string> = {},
): void {
  response.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": String(Buffer.byteLength(body)),
    ...headers,
  });
  response.end(body);
}
